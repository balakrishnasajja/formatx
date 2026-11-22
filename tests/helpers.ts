import { analyze, runAction } from '../src/engines/engine';
import type { Diagnostic, QuickFix } from '../src/types/diagnostics';
import type { ActionResult, AnalysisResult } from '../src/types/engine';
import type { FormatId } from '../src/types/formats';
import { DEFAULT_OPTIONS, type FormatOptions } from '../src/types/options';

export function opts(over: Partial<FormatOptions> = {}): FormatOptions {
  return { ...DEFAULT_OPTIONS, lineEnding: 'lf', ...over };
}

export function check(formatId: FormatId | 'auto', input: string, over: Partial<FormatOptions> = {}): Promise<AnalysisResult> {
  return analyze({ input, formatId, options: opts(over) });
}

export async function errorsOf(formatId: FormatId, input: string, over: Partial<FormatOptions> = {}): Promise<Diagnostic[]> {
  const r = await check(formatId, input, over);
  return r.validation.diagnostics.filter((d) => d.severity === 'error');
}

export async function codesOf(formatId: FormatId, input: string, over: Partial<FormatOptions> = {}): Promise<string[]> {
  const r = await check(formatId, input, over);
  return r.validation.diagnostics.map((d) => d.code);
}

export function beautify(formatId: FormatId, input: string, over: Partial<FormatOptions> = {}): Promise<ActionResult> {
  return runAction({ input, action: 'beautify', formatId, options: opts(over) });
}

export function minify(formatId: FormatId, input: string, over: Partial<FormatOptions> = {}): Promise<ActionResult> {
  return runAction({ input, action: 'minify', formatId, options: opts(over) });
}

export function convert(formatId: FormatId, targetFormatId: FormatId, input: string, over: Partial<FormatOptions> = {}): Promise<ActionResult> {
  return runAction({ input, action: 'convert', formatId, targetFormatId, options: opts(over) });
}

export function applyFix(input: string, fix: QuickFix): string {
  const edits = [...fix.edits].sort((a, b) => b.offset - a.offset);
  let out = input;
  for (const e of edits) out = out.slice(0, e.offset) + e.text + out.slice(e.offset + e.length);
  return out;
}

/** Asserts the action succeeded and returns its text. */
export function ok(r: ActionResult): string {
  if (!r.ok) throw new Error(`Action failed: ${r.error}`);
  return r.text ?? '';
}
