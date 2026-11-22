import type { FormatId } from '../../types/formats';
import type { DetectionCandidate, DetectionReport } from '../../types/engine';
import type { FormatOptions } from '../../types/options';
import type { FormatModule } from '../../types/module';
import { LineIndex } from '../../utils/lineIndex';
import { allModules } from '../registry';
import { buildDetectContext } from './context';

const MIN_SCORE = 0.12;
const MIN_CONFIDENCE = 0.3;
const VERIFY_LIMIT_BYTES = 1_500_000;
const VERIFY_BUDGET_MS = 400;
const VERIFY_TOP = 5;

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export interface DetectOptions {
  fileName?: string;
  options: FormatOptions;
  /** Run real parsers on the top candidates (disabled when the user forced a format). */
  verify: boolean;
  modules?: readonly FormatModule[];
}

/**
 * Two-stage detection:
 *  1. every module scores the input with cheap heuristics;
 *  2. the best candidates are verified with their real parser — a clean parse
 *     raises confidence, a failed parse lowers it (but strong heuristics keep an
 *     incomplete document classified correctly so it gets useful diagnostics).
 */
export async function detectFormat(text: string, opts: DetectOptions): Promise<DetectionReport> {
  const t0 = now();
  if (text.trim().length === 0) {
    return { best: null, candidates: [], ambiguous: false, empty: true, durationMs: 0 };
  }
  const ctx = buildDetectContext(text, opts.fileName);
  const modules = opts.modules ?? allModules();
  let candidates: DetectionCandidate[] = [];
  for (const m of modules) {
    if (!m.detect) continue;
    let r = null;
    try {
      r = m.detect(ctx);
    } catch {
      r = null;
    }
    let score = r?.score ?? 0;
    const reasons = r?.reasons ? [...r.reasons] : [];
    if (ctx.extension && m.descriptor.extensions.includes(ctx.extension)) {
      score = Math.max(score, 0.35) + 0.15;
      reasons.push(`File extension .${ctx.extension}`);
    }
    if (score >= MIN_SCORE) candidates.push({ formatId: m.descriptor.id, confidence: Math.min(1, score), reasons });
  }
  candidates.sort((a, b) => b.confidence - a.confidence);
  candidates = candidates.slice(0, 8);

  if (opts.verify && text.length <= VERIFY_LIMIT_BYTES) {
    const lines = new LineIndex(text);
    const start = now();
    const byId = new Map(modules.map((m) => [m.descriptor.id, m] as const));
    for (const c of candidates.slice(0, VERIFY_TOP)) {
      if (now() - start > VERIFY_BUDGET_MS) break;
      const m = byId.get(c.formatId);
      if (!m || m.descriptor.validatorConfidence === 'lint') continue;
      try {
        const r = await m.validate(text, { options: opts.options, lines });
        const errors = r.diagnostics.filter((d) => d.severity === 'error').length;
        if (errors === 0) {
          c.parsed = 'valid';
          const boost = r.weakMatch ? 0 : (m.detectBoost ?? 0.6);
          c.confidence = Math.min(0.99, c.confidence + (1 - c.confidence) * boost);
          c.reasons.push(`Parses cleanly with ${m.descriptor.engines.validator ?? m.descriptor.name}`);
        } else {
          c.parsed = 'invalid';
          c.confidence = c.confidence * 0.78;
          c.reasons.push(`${errors} parse error(s) with the ${m.descriptor.name} parser`);
        }
      } catch {
        c.parsed = 'invalid';
        c.confidence *= 0.7;
      }
    }
    candidates.sort((a, b) => b.confidence - a.confidence || rankValid(b) - rankValid(a));
  }

  const best = candidates[0] && candidates[0].confidence >= MIN_CONFIDENCE ? candidates[0] : null;
  const second = candidates[1];
  const ambiguous = !!best && !!second && second.confidence >= 0.4 && best.confidence - second.confidence < 0.1;
  for (const c of candidates) c.confidence = Math.round(c.confidence * 100) / 100;
  return { best, candidates, ambiguous, empty: false, durationMs: now() - t0 };
}

function rankValid(c: DetectionCandidate): number {
  return c.parsed === 'valid' ? 1 : 0;
}

export function isFormatId(id: string, modules: readonly FormatModule[] = allModules()): id is FormatId {
  return modules.some((m) => m.descriptor.id === id);
}
