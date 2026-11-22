import { parse, type ParseError, type ParserPlugin } from '@babel/parser';
import { DESCRIPTORS } from '../../engines/catalog';
import { lineRatio } from '../../engines/detection/context';
import type { Diagnostic } from '../../types/diagnostics';
import type { DetectContext, DetectScore, FormatModule, ModuleContext } from '../../types/module';
import { diagAtLineCol, notice } from '../../utils/diag';
import { prettierErrorDiagnostic, prettierFormat } from '../common/prettier';
import { SAMPLES } from '../samples';

type Variant = 'javascript' | 'typescript';

interface BabelOutcome {
  errors: ParseError[];
  fatal: ParseError | null;
  sourceType: string;
  statements: number;
  comments: number;
  hasJsx: boolean;
}

function babelParse(code: string, plugins: ParserPlugin[]): BabelOutcome {
  const opts = {
    sourceType: 'unambiguous' as const,
    errorRecovery: true,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    allowNewTargetOutsideFunction: true,
    allowUndeclaredExports: true,
    plugins,
    tokens: false,
  };
  try {
    const ast = parse(code, opts);
    return {
      errors: ast.errors ?? [],
      fatal: null,
      sourceType: ast.program.sourceType,
      statements: ast.program.body.length,
      comments: ast.comments?.length ?? 0,
      hasJsx: plugins.includes('jsx'),
    };
  } catch (e) {
    return { errors: [], fatal: e as ParseError, sourceType: 'unknown', statements: 0, comments: 0, hasJsx: plugins.includes('jsx') };
  }
}

function analyzeCode(variant: Variant, code: string): BabelOutcome {
  if (variant === 'javascript') return babelParse(code, ['jsx']);
  const ts = babelParse(code, [['typescript', {}]]);
  if (!ts.fatal && ts.errors.length === 0) return ts;
  const tsx = babelParse(code, [['typescript', {}], 'jsx']);
  const score = (o: BabelOutcome) => o.errors.length + (o.fatal ? 1000 - (o.fatal.loc?.index ?? 0) / 1e6 : 0);
  return score(tsx) < score(ts) ? tsx : ts;
}

const HINTS: Record<string, string> = {
  UnexpectedToken: 'Check for a missing comma, bracket, parenthesis or operator just before this position.',
  MissingSemicolon: 'Add a semicolon or line break between the statements.',
  UnterminatedString: 'Add the closing quote.',
  UnterminatedTemplate: 'Add the closing backtick (`).',
  UnterminatedComment: "Close the comment with '*/'.",
  UnterminatedRegexp: 'Close the regular expression with "/".',
  VarRedeclaration: 'Rename one of the declarations or remove the duplicate.',
  UnexpectedReservedWord: 'Reserved words cannot be used as identifiers.',
  InvalidOrUnexpectedToken: 'Remove or escape the unexpected character.',
};

function toDiag(e: ParseError, ctx: ModuleContext, source: string, prefix: string): Diagnostic {
  const loc = e.loc ?? { line: 1, column: 0 };
  const message = (e.message ?? 'Syntax error').replace(/\s*\(\d+:\d+\)\s*$/, '');
  const reason = (e as { reasonCode?: string }).reasonCode ?? 'SyntaxError';
  const missing = (e as { missingPlugin?: string | string[] }).missingPlugin;
  return diagAtLineCol(ctx.lines, loc.line, loc.column + 1, {
    code: `${prefix}/${reason.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}`,
    type: reason.replace(/([a-z])([A-Z])/g, '$1 $2'),
    message,
    suggestion: missing ? `This syntax is an experimental proposal (${[missing].flat().join(', ')}) and is not enabled.` : HINTS[reason],
    source,
  });
}

function detectFor(variant: Variant, ctx: DetectContext): DetectScore | null {
  const t = ctx.trimmed;
  if (!t || t[0] === '<' || t.startsWith('{"') || t.startsWith('[{')) return null;
  const comment = /^\s*(\/\/|\/\*|\*)/;
  const jsLines = lineRatio(ctx.lines, /^\s*(import\s.+from\s|export\s|const\s|let\s|var\s|function[\s*]|async\s+function|class\s+\w|return\b|if\s*\(|for\s*\(|while\s*\(|switch\s*\(|try\s*\{|throw\s|await\s|console\.|module\.exports|require\(|\}\s*else|\}\)?;?$|=>)/, comment);
  const arrow = /=>/.test(ctx.head);
  const tsMarkers =
    (ctx.head.match(/^\s*(export\s+)?(interface|type|enum|namespace|declare|abstract\s+class)\s+\w|:\s*(string|number|boolean|any|unknown|void|never|Record<|Array<|Promise<)\b|\bas\s+(const|string|number|any|unknown)\b|<[A-Z]\w*(,\s*[A-Z]\w*)*>\(|\b(private|public|protected|readonly)\s+\w+\s*[:;=(]|implements\s+\w/gm) ?? []).length;
  const pythonish = lineRatio(ctx.lines, /^\s*(def |elif |print\(|from \w+ import|import \w+$|.*:\s*$)/).ratio;
  const phpish = /^<\?php/.test(t);
  const javaish = /\bpublic\s+(static\s+)?(void|class)\b|System\.out\.|^\s*package\s+[\w.]+;/m.test(ctx.head);
  const sqlish = /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|WITH)\s/im.test(t) && !/\b(const|let|function)\b/.test(ctx.head);
  if (phpish || javaish || sqlish) return null;
  let score = 0.15 + jsLines.ratio * 0.6 + (arrow ? 0.05 : 0);
  score -= pythonish * 0.5;
  const reasons: string[] = [];
  if (jsLines.ratio > 0.3) reasons.push('JavaScript statements (const/let/function/import...)');
  if (variant === 'typescript') {
    if (!tsMarkers) return { score: Math.max(0, score - 0.25), reasons };
    score += Math.min(0.3, 0.12 + tsMarkers * 0.04);
    reasons.push('TypeScript syntax (type annotations, interfaces, generics)');
  } else if (tsMarkers) score -= Math.min(0.3, tsMarkers * 0.08);
  if (/^\s*(type\s+\w+\s*\{|query\s|mutation\s|fragment\s)/m.test(ctx.head) && !/[;=]/.test(ctx.head)) score -= 0.4;
  return score > 0.15 ? { score: Math.min(0.93, score), reasons } : null;
}

function createJsModule(variant: Variant): FormatModule {
  const prefix = variant === 'typescript' ? 'ts' : 'js';
  return {
    descriptor: DESCRIPTORS[variant],
    sample: SAMPLES[variant],
    detect: (ctx) => detectFor(variant, ctx),
    validate(input, ctx) {
      const r = analyzeCode(variant, input);
      const source = 'Babel parser';
      const diagnostics = r.errors.map((e) => toDiag(e, ctx, source, prefix));
      if (r.fatal) diagnostics.push(toDiag(r.fatal, ctx, source, prefix));
      const facts: Record<string, string | number> = r.fatal ? {} : { 'Source type': r.sourceType === 'module' ? 'ES module' : 'script', 'Top-level statements': r.statements, Comments: r.comments };
      return {
        diagnostics,
        facts,
        validator: variant === 'typescript' ? 'Babel parser (typescript plugin) — syntax only' : 'Babel parser',
      };
    },
    async beautify(input, ctx) {
      try {
        const text = await prettierFormat(input, {
          parser: variant === 'typescript' ? 'babel-ts' : 'babel',
          plugins: ['babel', 'estree'],
          options: ctx.options,
          overrides: { semi: true, trailingComma: 'all', arrowParens: 'always' },
        });
        return { text };
      } catch (e) {
        throw new Error(prettierErrorDiagnostic(e, ctx.lines, 'Prettier', `${prefix}/prettier`).message);
      }
    },
    minify:
      variant === 'javascript'
        ? async (input, ctx) => {
            const { minify } = await import('terser');
            const r = analyzeCode('javascript', input);
            let result;
            try {
              result = await minify(input, {
                module: r.sourceType === 'module',
                compress: { passes: 2 },
                mangle: ctx.options.jsMangle,
                format: { comments: /^!|@preserve|@license|@cc_on/i },
              });
            } catch (e) {
              const err = e as { message?: string; line?: number; col?: number };
              const jsx = /<\w/.test(input) && /Unexpected token/.test(err.message ?? '');
              throw new Error(`${err.message ?? String(e)}${err.line ? ` (line ${err.line}, column ${(err.col ?? 0) + 1})` : ''}${jsx ? ' — JSX must be compiled to JavaScript before minifying.' : ''}`);
            }
            const warnings: Diagnostic[] = [];
            if (r.comments) warnings.push(notice({ severity: 'info', code: 'js/minify-removed-comments', type: 'Comments removed', message: 'Comments were removed (license comments starting with /*! or containing @license are kept).', source: 'Terser' }));
            return { text: result.code ?? '', warnings, notes: [ctx.options.jsMangle ? 'Local variable names were shortened (mangle).' : 'Variable names were kept (mangle disabled).'] };
          }
        : undefined,
  };
}

export const javascriptModule = createJsModule('javascript');
export const typescriptModule = createJsModule('typescript');
