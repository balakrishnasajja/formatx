import { countDiagnostics, type Diagnostic } from '../../types/diagnostics';
import type { ValidationReport } from '../../types/engine';
import type { FormatModule, ModuleContext } from '../../types/module';
import { internalError } from '../../utils/diag';

const MAX_DIAGNOSTICS = 1000;

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

/** Sort by position, then severity; drop exact duplicates; clamp ranges. */
export function normalizeDiagnostics(list: Diagnostic[], lineCount: number): { diagnostics: Diagnostic[]; truncated: boolean } {
  const seen = new Set<string>();
  const out: Diagnostic[] = [];
  for (const d of list) {
    if (d.range) {
      const r = d.range;
      r.line = Math.max(1, Math.min(r.line, lineCount));
      r.endLine = Math.max(r.line, Math.min(r.endLine, lineCount));
      r.column = Math.max(1, r.column);
      r.endColumn = Math.max(1, r.endColumn);
      if (r.endLine === r.line && r.endColumn < r.column) r.endColumn = r.column;
    }
    const key = `${d.code}|${d.range?.line}:${d.range?.column}|${d.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  out.sort((a, b) => {
    const la = a.range?.line ?? Number.MAX_SAFE_INTEGER;
    const lb = b.range?.line ?? Number.MAX_SAFE_INTEGER;
    if (la !== lb) return la - lb;
    const ca = a.range?.column ?? 0;
    const cb = b.range?.column ?? 0;
    if (ca !== cb) return ca - cb;
    return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  });
  const truncated = out.length > MAX_DIAGNOSTICS;
  return { diagnostics: truncated ? out.slice(0, MAX_DIAGNOSTICS) : out, truncated };
}

export interface ValidationRun {
  report: ValidationReport;
  facts: Record<string, string | number>;
}

/** Runs a module validator with centralized error handling. Never throws. */
export async function runValidation(module: FormatModule, input: string, ctx: ModuleContext): Promise<ValidationRun> {
  const d = module.descriptor;
  let diagnostics: Diagnostic[] = [];
  let facts: Record<string, string | number> = {};
  let validator = d.engines.validator ?? d.name;
  try {
    const r = await module.validate(input, ctx);
    diagnostics = r.diagnostics;
    facts = r.facts ?? {};
    if (r.validator) validator = r.validator;
  } catch (err) {
    diagnostics = [internalError(ctx.lines, validator, err)];
  }
  if (d.validatorConfidence === 'lint') {
    // lint-only formats never produce hard errors
    diagnostics = diagnostics.map((x) => (x.severity === 'error' ? { ...x, severity: 'warning' as const } : x));
  }
  const norm = normalizeDiagnostics(diagnostics, ctx.lines.lineCount);
  const counts = countDiagnostics(norm.diagnostics);
  return {
    report: {
      status: counts.error > 0 ? 'invalid' : counts.warning > 0 ? 'warnings' : 'valid',
      diagnostics: norm.diagnostics,
      counts,
      truncated: norm.truncated,
      validator,
      confidence: d.validatorConfidence,
    },
    facts,
  };
}
