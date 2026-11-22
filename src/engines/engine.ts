import { countDiagnostics, type Diagnostic } from '../types/diagnostics';
import type { ActionRequest, ActionResult, AnalysisResult, AnalyzeRequest, DetectionReport } from '../types/engine';
import type { FormatModule, ModuleContext } from '../types/module';
import { encodeBinaryText } from '../utils/bytes';
import { LineIndex } from '../utils/lineIndex';
import { ensureFinalNewline, normalizeEol, resolveEol, utf8Length } from '../utils/text';
import { DESCRIPTORS } from './catalog';
import { ConversionError, convertFormat } from './converters/convert';
import { detectFormat } from './detection/detect';
import { getModule } from './registry';
import { runValidation } from './validators/validate';

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

const EMPTY_DETECTION: DetectionReport = { best: null, candidates: [], ambiguous: false, empty: true, durationMs: 0 };

/** Detect + validate. Never throws for malformed input. */
export async function analyze(req: AnalyzeRequest): Promise<AnalysisResult> {
  const t0 = now();
  const input = req.input;
  const lines = new LineIndex(input);
  const base = { bytes: utf8Length(input), chars: input.length, lines: lines.lineCount, facts: {} as Record<string, string | number> };
  const manual = req.formatId !== 'auto';

  if (input.trim().length === 0) {
    return {
      formatId: manual ? (req.formatId as AnalysisResult['formatId']) : null,
      mode: manual ? 'manual' : 'auto',
      detection: EMPTY_DETECTION,
      validation: { status: 'empty', diagnostics: [], counts: { error: 0, warning: 0, info: 0 }, truncated: false, validator: '', confidence: 'authoritative' },
      stats: base,
      timings: { detectMs: 0, validateMs: 0, totalMs: now() - t0 },
    };
  }

  const detection = await detectFormat(input, { fileName: req.hint?.fileName, options: req.options, verify: !manual });
  const formatId = manual ? req.formatId : detection.best?.formatId ?? null;
  const tDetect = now();

  if (!formatId || formatId === 'auto') {
    return {
      formatId: null,
      mode: 'auto',
      detection,
      validation: { status: 'unknown', diagnostics: [], counts: { error: 0, warning: 0, info: 0 }, truncated: false, validator: '', confidence: 'authoritative' },
      stats: base,
      timings: { detectMs: tDetect - t0, validateMs: 0, totalMs: now() - t0 },
    };
  }
  const module = getModule(formatId);
  if (!module) {
    return {
      formatId,
      mode: manual ? 'manual' : 'auto',
      detection,
      validation: {
        status: 'unknown',
        diagnostics: [{ severity: 'info', code: 'engine/not-implemented', type: 'Not available', message: `${DESCRIPTORS[formatId].name} support is not available in this build.`, source: 'FormatX' }],
        counts: { error: 0, warning: 0, info: 1 },
        truncated: false,
        validator: '',
        confidence: 'authoritative',
      },
      stats: base,
      timings: { detectMs: tDetect - t0, validateMs: 0, totalMs: now() - t0 },
    };
  }
  const ctx: ModuleContext = { options: req.options, lines };
  const v = await runValidation(module, input, ctx);
  const tValidate = now();
  return {
    formatId,
    mode: manual ? 'manual' : 'auto',
    detection,
    validation: v.report,
    stats: { ...base, facts: v.facts },
    timings: { detectMs: tDetect - t0, validateMs: tValidate - tDetect, totalMs: tValidate - t0 },
  };
}

function failure(req: ActionRequest, error: string, t0: number, extra: Partial<ActionResult> = {}): ActionResult {
  return {
    ok: false,
    action: req.action,
    sourceFormatId: req.formatId,
    outputFormatId: req.targetFormatId ?? req.formatId,
    language: 'plaintext',
    warnings: [],
    notes: [],
    error,
    stats: { inputBytes: utf8Length(req.input), outputBytes: 0, durationMs: now() - t0 },
    engine: '',
    ...extra,
  };
}

/** Beautify / minify / convert, gated by validation. Never throws. */
export async function runAction(req: ActionRequest): Promise<ActionResult> {
  const t0 = now();
  const module: FormatModule | undefined = getModule(req.formatId);
  const desc = DESCRIPTORS[req.formatId];
  if (!module) return failure(req, `${desc?.name ?? req.formatId} support is not available.`, t0);
  if (req.input.trim().length === 0) return failure(req, 'The input is empty.', t0);

  const lines = new LineIndex(req.input);
  const ctx: ModuleContext = { options: req.options, lines };

  // Validation gate: never format or convert invalid data silently.
  const v = await runValidation(module, req.input, ctx);
  if (v.report.counts.error > 0) {
    const forceable = desc.validatorConfidence === 'advisory';
    if (!(req.force && forceable)) {
      return failure(req, `The input has ${v.report.counts.error} error(s). Fix them before running ${req.action}.`, t0, {
        blockedBy: v.report.counts,
        canForce: forceable,
      });
    }
  }

  const eol = resolveEol(req.options.lineEnding, req.input);
  ctx.eol = eol;
  try {
    let text: string | undefined;
    let binary: Uint8Array | undefined;
    let warnings: Diagnostic[] = [];
    let notes: string[] = [];
    let outputFormatId = req.formatId;
    let language = desc.monacoLanguage;
    let engine = '';

    if (req.action === 'beautify' || req.action === 'minify') {
      const fn = req.action === 'beautify' ? module.beautify : module.minify;
      if (!fn) {
        return failure(req, `${req.action === 'beautify' ? 'Beautify' : 'Minify'} is not supported for ${desc.name}.${desc.notes.length ? ' ' + desc.notes[desc.notes.length - 1] : ''}`, t0);
      }
      const r = await fn.call(module, req.input, ctx);
      text = r.text;
      warnings = r.warnings ?? [];
      notes = r.notes ?? [];
      if (r.outputFormatId) outputFormatId = r.outputFormatId;
      if (r.language) language = r.language;
      engine = (req.action === 'beautify' ? desc.engines.formatter : desc.engines.minifier) ?? '';
      if (outputFormatId === req.formatId) {
        if (!module.ownsLineEndings) text = normalizeEol(text, eol);
        if (req.action === 'beautify') text = ensureFinalNewline(text, eol);
        if (module.verifyTransform) {
          const problem = await module.verifyTransform(req.input, text, ctx);
          if (problem) return failure(req, problem, t0, { engine });
        }
      } else if (req.action === 'beautify') text = ensureFinalNewline(normalizeEol(text, eol), eol);
    } else {
      const target = req.targetFormatId;
      if (!target) return failure(req, 'Choose a target format to convert to.', t0);
      const out = await convertFormat(req.input, req.formatId, target, ctx);
      outputFormatId = target;
      language = DESCRIPTORS[target].monacoLanguage;
      warnings = out.warnings;
      notes = out.notes;
      engine = `${desc.name} → ${DESCRIPTORS[target].name}`;
      if (out.binary) {
        binary = out.binary;
        text = encodeBinaryText(out.binary, req.options.binaryEncoding);
        language = 'plaintext';
      } else {
        const targetOwnsEol = getModule(target)?.ownsLineEndings;
        text = ensureFinalNewline(targetOwnsEol ? out.text ?? '' : normalizeEol(out.text ?? '', eol), eol);
      }
    }

    const counts = countDiagnostics(warnings);
    if (counts.warning > 0 && req.action === 'convert') notes.unshift(`${counts.warning} information-loss warning(s) — review them before using the output.`);
    if (v.report.counts.error > 0) notes.unshift('Formatted anyway: the validator reported errors that may be false positives for this dialect.');
    return {
      ok: true,
      action: req.action,
      sourceFormatId: req.formatId,
      outputFormatId,
      language,
      text,
      binary,
      warnings,
      notes,
      stats: { inputBytes: utf8Length(req.input), outputBytes: binary ? binary.length : utf8Length(text ?? ''), durationMs: now() - t0 },
      engine,
    };
  } catch (err) {
    const message = err instanceof ConversionError ? err.message : `${desc.name} ${req.action} failed: ${err instanceof Error ? err.message : String(err)}`;
    return failure(req, message, t0);
  }
}
