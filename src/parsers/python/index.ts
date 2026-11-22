import { DESCRIPTORS } from '../../engines/catalog';
import { lineRatio } from '../../engines/detection/context';
import type { Diagnostic } from '../../types/diagnostics';
import type { DetectContext, DetectScore, FormatModule, ModuleContext } from '../../types/module';
import { diagAt, diagAtLineCol } from '../../utils/diag';
import { SAMPLES } from '../samples';
import { pythonFallbackCheck } from './fallback';

interface RuffDiagnostic {
  code: string | null;
  message: string;
  start_location: { row: number; column: number };
  end_location: { row: number; column: number };
  fix: { message: string | null; edits: { content: string | null; location: { row: number; column: number }; end_location: { row: number; column: number } }[] } | null;
}
interface RuffWorkspace {
  check(contents: string): RuffDiagnostic[];
  format(contents: string): string;
}
type RuffModule = typeof import('@astral-sh/ruff-wasm-web');

/** Loader for the Ruff WebAssembly module; replaceable (tests load it from disk). */
let loader: () => Promise<RuffModule> = async () => {
  const [ruff, wasm] = await Promise.all([import('@astral-sh/ruff-wasm-web'), import('@astral-sh/ruff-wasm-web/ruff_wasm_bg.wasm?url')]);
  await ruff.default({ module_or_path: wasm.default });
  return ruff;
};
export function setRuffLoader(fn: () => Promise<RuffModule>): void {
  loader = fn;
  workspacePromise = null;
}

let workspacePromise: Promise<RuffWorkspace> | null = null;
let loadFailed: string | null = null;

function getWorkspace(): Promise<RuffWorkspace> {
  workspacePromise ??= loader().then((ruff) => {
    const settings = ruff.Workspace.defaultSettings();
    return new ruff.Workspace(settings, ruff.PositionEncoding.Utf16) as unknown as RuffWorkspace;
  });
  return workspacePromise;
}

function toDiag(d: RuffDiagnostic, ctx: ModuleContext): Diagnostic {
  // Ruff reports parser errors with code "invalid-syntax" (older releases: null / E999)
  const isSyntax = !d.code || d.code === 'invalid-syntax' || d.code === 'E999';
  const fix =
    d.fix && d.fix.edits.length
      ? {
          title: d.fix.message ?? 'Apply Ruff fix',
          edits: d.fix.edits.map((e) => {
            const start = ctx.lines.offsetAt(e.location.row, e.location.column);
            const end = ctx.lines.offsetAt(e.end_location.row, e.end_location.column);
            return { offset: start, length: Math.max(0, end - start), text: e.content ?? '' };
          }),
        }
      : undefined;
  return diagAtLineCol(
    ctx.lines,
    d.start_location.row,
    d.start_location.column,
    {
      // pyflakes findings (undefined names, unused imports...) are likely bugs; style findings are informational
      severity: isSyntax ? 'error' : /^F/.test(d.code ?? '') ? 'warning' : 'info',
      code: isSyntax ? 'python/syntax-error' : `python/${(d.code ?? '').toLowerCase()}`,
      type: isSyntax ? 'Syntax error' : `Ruff ${d.code}`,
      message: d.message.replace(/^SyntaxError:\s*/, ''),
      fix,
      source: 'Ruff',
    },
    d.end_location.row,
    d.end_location.column,
  );
}

async function validatePython(input: string, ctx: ModuleContext) {
  try {
    const ws = await getWorkspace();
    loadFailed = null;
    const diags = ws.check(input).map((d) => toDiag(d, ctx));
    const syntax = diags.filter((d) => d.severity === 'error').length;
    return { diagnostics: diags, facts: { 'Syntax errors': syntax, 'Lint findings': diags.length - syntax }, validator: 'Ruff (WebAssembly)' };
  } catch (e) {
    loadFailed = (e as Error).message ?? String(e);
    const diags = pythonFallbackCheck(input, ctx);
    diags.push(diagAt(ctx.lines, 0, 1, { severity: 'info', code: 'python/fallback', type: 'Basic checks only', message: `Ruff could not be loaded (${loadFailed}); only basic structural checks (brackets, strings, indentation, colons) were run.`, source: 'FormatX' }));
    return { diagnostics: diags, validator: 'FormatX basic Python checker (fallback)' };
  }
}

function detectPython(ctx: DetectContext): DetectScore | null {
  const comment = /^\s*#/;
  const pyLines = lineRatio(ctx.lines, /^\s*(def\s+\w+\s*\(.*\)\s*(->\s*[^:]+)?:|class\s+\w+(\(.*\))?\s*:|import\s+[\w.]+(\s+as\s+\w+)?\s*$|from\s+[\w.]+\s+import\s+|if\s+.+:\s*$|elif\s+.+:|else\s*:|for\s+\w+.*\s+in\s+.+:|while\s+.+:|try\s*:|except(\s+.+)?:|finally\s*:|with\s+.+:|return\b|print\(|@\w+|async\s+def|yield\b|raise\b|pass\s*$|self\.)/, comment);
  const braces = lineRatio(ctx.lines, /[{};]\s*$/).ratio;
  const yamlish = lineRatio(ctx.lines, /^\s*[\w-]+:\s+\S/).ratio;
  if (pyLines.count < 2 && !/^#!.*python/.test(ctx.trimmed)) return null;
  let score = 0.2 + pyLines.ratio * 0.7 - braces * 0.6 - yamlish * 0.3;
  if (/if\s+__name__\s*==\s*["']__main__["']\s*:/.test(ctx.head)) score += 0.2;
  if (/^#!.*python/.test(ctx.trimmed)) score += 0.3;
  if (/^\s*def\s+\w+\(.*\):/m.test(ctx.head)) score += 0.1;
  return score > 0.25 ? { score: Math.min(0.95, score), reasons: ['Python statements (def/class/import, colon-terminated blocks)'] } : null;
}

export const pythonModule: FormatModule = {
  descriptor: DESCRIPTORS.python,
  sample: SAMPLES.python,
  detect: detectPython,
  validate: validatePython,
  async beautify(input) {
    const ws = await getWorkspace();
    return { text: ws.format(input), notes: ['Formatted with the Ruff formatter (Black-compatible style).'] };
  },
};
