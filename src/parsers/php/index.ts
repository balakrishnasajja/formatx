import { DESCRIPTORS } from '../../engines/catalog';
import type { Diagnostic } from '../../types/diagnostics';
import type { DetectContext, DetectScore, FormatModule, ModuleContext } from '../../types/module';
import { diagAtLineCol, notice } from '../../utils/diag';
import { prettierFormat } from '../common/prettier';
import { SAMPLES } from '../samples';

type PhpEngine = {
  parseCode(code: string, file: string): { errors?: { message: string; lineNumber?: number; columnNumber?: number }[]; children?: unknown[] };
  tokenGetAll(code: string): (string | [string, string, number])[];
};

let enginePromise: Promise<new (opts: unknown) => PhpEngine> | null = null;
async function newEngine(suppressErrors: boolean): Promise<PhpEngine> {
  enginePromise ??= import('php-parser').then((m) => {
    const mod = m as unknown as { Engine?: new (o: unknown) => PhpEngine; default?: { Engine?: new (o: unknown) => PhpEngine } };
    const E = mod.Engine ?? mod.default?.Engine;
    if (!E) throw new Error('php-parser failed to load');
    return E;
  });
  const Engine = await enginePromise;
  return new Engine({ parser: { extractDoc: true, suppressErrors, version: '8.3' }, ast: { withPositions: true }, lexer: { short_tags: true, asp_tags: false } });
}

function cleanMessage(m: string): string {
  return m.replace(/^Parse Error\s*:\s*/i, '').replace(/\s+on line \d+$/, '').replace(/^syntax error/, 'Syntax error');
}

async function validatePhp(input: string, ctx: ModuleContext) {
  const engine = await newEngine(true);
  const diagnostics: Diagnostic[] = [];
  let ast: ReturnType<PhpEngine['parseCode']> | null = null;
  try {
    ast = engine.parseCode(input, 'input.php');
  } catch (e) {
    const err = e as { message: string; lineNumber?: number; columnNumber?: number };
    diagnostics.push(diagAtLineCol(ctx.lines, err.lineNumber ?? 1, (err.columnNumber ?? 0) + 1, { code: 'php/syntax-error', type: 'Syntax error', message: cleanMessage(err.message), source: 'php-parser' }));
  }
  for (const err of ast?.errors ?? []) {
    // with error recovery enabled the position is in `loc` (0-based columns)
    const e = err as { message: string; lineNumber?: number; columnNumber?: number; loc?: { start: { line: number; column: number }; end?: { line: number; column: number } } };
    const line = e.loc?.start.line ?? e.lineNumber ?? 1;
    const column = (e.loc?.start.column ?? e.columnNumber ?? 0) + 1;
    diagnostics.push(
      diagAtLineCol(ctx.lines, line, column, { code: 'php/syntax-error', type: 'Syntax error', message: cleanMessage(e.message), source: 'php-parser' }, e.loc?.end?.line, e.loc?.end ? e.loc.end.column + 1 : undefined),
    );
  }
  if (!/<\?(php|=)?/.test(input)) {
    diagnostics.push(diagAtLineCol(ctx.lines, 1, 1, { severity: 'info', code: 'php/no-open-tag', type: 'No PHP tag', message: 'The file has no <?php opening tag, so everything is treated as inline HTML.', source: 'php-parser' }));
  }
  const facts: Record<string, string | number> = ast ? { 'Top-level statements': ast.children?.length ?? 0 } : {};
  return { diagnostics, facts };
}

/** php_strip_whitespace() equivalent built on php-parser's token stream. */
async function minifyPhp(input: string): Promise<{ text: string; comments: number }> {
  const engine = await newEngine(false);
  const tokens = engine.tokenGetAll(input);
  let out = '';
  let comments = 0;
  let pendingSpace = false;
  const isWord = (c: string) => /[\w$\\\u{80}-\u{FFFF}]/u.test(c);
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    const [type, text] = typeof tk === 'string' ? ['CHAR', tk] : [tk[0], tk[1]];
    if (type === 'T_WHITESPACE') {
      pendingSpace = true;
      continue;
    }
    if (type === 'T_COMMENT' || type === 'T_DOC_COMMENT') {
      comments++;
      // a "// comment" ends the line; keep a separator
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && out && text && isWord(out[out.length - 1]) && isWord(text[0])) out += ' ';
    else if (pendingSpace && out && /[+\-.]$/.test(out) && /^[+\-.]/.test(text)) out += ' ';
    pendingSpace = false;
    if (type === 'T_OPEN_TAG') out += text.trimEnd() + ' ';
    else if (type === 'T_END_HEREDOC') out += text + '\n';
    else out += text;
  }
  return { text: out.trimEnd(), comments };
}

function detectPhp(ctx: DetectContext): DetectScore | null {
  if (/^<\?php\b/.test(ctx.trimmed)) return { score: 0.98, reasons: ['<?php opening tag'] };
  if (/<\?php\b|<\?=/.test(ctx.head)) return { score: 0.8, reasons: ['Embedded <?php blocks'] };
  return null;
}

export const phpModule: FormatModule = {
  descriptor: DESCRIPTORS.php,
  sample: SAMPLES.php,
  detect: detectPhp,
  validate: validatePhp,
  async beautify(input, ctx) {
    const plugin = await import('@prettier/plugin-php');
    const p = (plugin as unknown as { default?: unknown }).default ?? plugin;
    return { text: await prettierFormat(input, { parser: 'php', plugins: [], extraPlugins: [p], options: ctx.options, overrides: { phpVersion: '8.3' } }) };
  },
  async minify(input) {
    const r = await minifyPhp(input);
    // safety check: apart from whitespace and comments, the token stream must be identical
    const engine = await newEngine(false);
    const sig = (s: string) =>
      engine
        .tokenGetAll(s)
        .filter((t) => typeof t === 'string' || !['T_WHITESPACE', 'T_COMMENT', 'T_DOC_COMMENT'].includes(t[0]))
        .map((t) => (typeof t === 'string' ? t : t[0] === 'T_OPEN_TAG' ? '<?php' : t[1]))
        .join('\u{1}');
    if (sig(input) !== sig(r.text)) throw new Error('minification would change the token stream; output discarded');
    const warnings: Diagnostic[] = r.comments ? [notice({ severity: 'info', code: 'php/minify-removed-comments', type: 'Comments removed', message: `${r.comments} comment(s) were removed (like php_strip_whitespace()).`, source: 'PHP minifier' })] : [];
    return { text: r.text, warnings };
  },
};
