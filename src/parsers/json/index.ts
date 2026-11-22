import JSON5 from 'json5';
import type { Diagnostic } from '../../types/diagnostics';
import { DESCRIPTORS } from '../../engines/catalog';
import type { DetectContext, DetectScore, FormatModule, ModuleContext, ValidateResult } from '../../types/module';
import { indentUnit } from '../../types/options';
import { diagAtLineCol, notice } from '../../utils/diag';
import { pathToString } from '../../engines/converters/dataModel';
import { AstBuilder, DataBuilder } from './builders';
import { JsonParser } from './parser';
import { beautifyTokens, minifyTokens, printAst, stringifyData } from './printer';
import { JsonScanner, NF_HEX, NF_INFINITY, NF_LEADING_DOT, NF_NAN, NF_PLUS, NF_TRAILING_DOT, type JsonMode } from './scanner';
import { SAMPLES } from '../samples';

const NAMES: Record<JsonMode, string> = { json: 'JSON', jsonc: 'JSONC', json5: 'JSON5' };

// ---------------------------------------------------------------- detection

interface JsonFeatures {
  start: 'object-string-key' | 'object-ident-key' | 'object-empty' | 'array' | 'primitive' | 'other' | 'none';
  comments: number;
  singleQuoted: number;
  identKeys: number;
  trailingCommas: number;
  json5Numbers: number;
  invalid: number;
  tokens: number;
  graphqlLike: boolean;
}

const featureCache = new WeakMap<DetectContext, JsonFeatures>();

export function jsonFeatures(ctx: DetectContext): JsonFeatures {
  const cached = featureCache.get(ctx);
  if (cached) return cached;
  const f: JsonFeatures = { start: 'none', comments: 0, singleQuoted: 0, identKeys: 0, trailingCommas: 0, json5Numbers: 0, invalid: 0, tokens: 0, graphqlLike: false };
  const text = ctx.head;
  const sc = new JsonScanner(text);
  const sig: { kind: string; raw: string }[] = [];
  let prev: { kind: string; raw: string } | null = null;
  let prevPrev: { kind: string; raw: string } | null = null;
  for (let i = 0; i < 20000; i++) {
    const t = sc.next();
    if (t.kind === 'eof') break;
    if (t.kind === 'lineComment' || t.kind === 'blockComment') {
      f.comments++;
      continue;
    }
    f.tokens++;
    const raw = text.slice(t.start, t.end);
    if (t.kind === 'invalid') f.invalid++;
    if (t.kind === 'string' && t.quote === "'") f.singleQuoted++;
    if (t.kind === 'number' && (t.numFlags ?? 0) & (NF_HEX | NF_INFINITY | NF_NAN | NF_LEADING_DOT | NF_TRAILING_DOT | NF_PLUS)) f.json5Numbers++;
    if (t.kind === 'ident' && (raw === 'Infinity' || raw === 'NaN')) f.json5Numbers++;
    if (t.kind === ':' && prev?.kind === 'ident' && (prevPrev?.kind === '{' || prevPrev?.kind === ',')) f.identKeys++;
    if ((t.kind === '}' || t.kind === ']') && prev?.kind === ',') f.trailingCommas++;
    const cur = { kind: t.kind, raw };
    if (sig.length < 4) sig.push(cur);
    prevPrev = prev;
    prev = cur;
  }
  const [a, b, c] = sig;
  if (!a) f.start = 'none';
  else if (a.kind === '{') {
    if (b?.kind === 'string' && c?.kind === ':') f.start = 'object-string-key';
    else if (b?.kind === 'ident' && c?.kind === ':') f.start = 'object-ident-key';
    else if (b?.kind === 'string' && c?.kind !== ':') f.start = 'other';
    else if (b?.kind === '}') f.start = 'object-empty';
    else f.start = 'other';
    // GraphQL selection sets: `{ user { id } }` — identifiers followed by '{' or identifiers.
    if (b?.kind === 'ident' && (c?.kind === '{' || c?.kind === 'ident' || c?.kind === '}' || c?.kind === '[')) f.graphqlLike = true;
  } else if (a.kind === '[') {
    if (!b) f.start = 'array';
    else if (b.kind === 'ident' && !/^(true|false|null|Infinity|NaN)$/.test(b.raw)) f.start = 'other';
    else if (['{', '[', ']', 'string', 'number', 'ident'].includes(b.kind)) f.start = 'array';
    else f.start = 'other';
  } else if (sig.length === 1 && (a.kind === 'string' || a.kind === 'number' || (a.kind === 'ident' && /^(true|false|null)$/.test(a.raw)))) {
    f.start = 'primitive';
  } else f.start = 'other';
  featureCache.set(ctx, f);
  return f;
}

function baseScore(f: JsonFeatures): number {
  switch (f.start) {
    case 'object-string-key':
      return 0.86;
    case 'array':
      return 0.78;
    case 'object-empty':
      return 0.6;
    case 'object-ident-key':
      return 0.5;
    case 'primitive':
      return 0.34;
    default:
      return 0;
  }
}

function detectFor(mode: JsonMode, ctx: DetectContext): DetectScore | null {
  const f = jsonFeatures(ctx);
  let base = baseScore(f);
  if (base === 0 || f.graphqlLike) return null;
  const reasons: string[] = [];
  if (f.start === 'object-string-key') reasons.push('Starts with an object whose first key is quoted');
  if (f.start === 'array') reasons.push('Starts with an array of values');
  if (f.invalid > 0) base -= Math.min(0.25, f.invalid * 0.03);
  const json5Only = f.singleQuoted + f.identKeys + f.json5Numbers;
  const ext = ctx.extension;
  if (mode === 'json') {
    if (f.comments === 0 && json5Only === 0 && f.trailingCommas === 0) {
      base += 0.1;
      reasons.push('No comments or JSON5 extensions');
    } else if (f.comments === 0 && json5Only === 0) {
      base -= 0.08; // a trailing comma is usually a JSON mistake, not a dialect choice
    } else base -= 0.3;
    if (ext === 'json') base += 0.05;
  } else if (mode === 'jsonc') {
    if (f.comments > 0 && json5Only === 0) {
      base += 0.13;
      reasons.push(`Contains ${f.comments} comment(s) in otherwise strict JSON`);
    } else if (f.comments === 0 && f.trailingCommas > 0 && json5Only === 0) {
      base -= 0.2;
      reasons.push('Contains trailing commas');
    } else base -= f.comments === 0 ? 0.36 : 0.25;
    if (ext === 'jsonc' || ext === 'code-workspace') base += 0.2;
  } else {
    if (json5Only > 0) {
      base += 0.14;
      if (f.identKeys) reasons.push('Unquoted property names');
      if (f.singleQuoted) reasons.push('Single-quoted strings');
      if (f.json5Numbers) reasons.push('JSON5 number syntax (hex, Infinity, NaN, leading/trailing dot)');
    } else base -= 0.42;
    if (ext === 'json5') base += 0.2;
  }
  return { score: Math.max(0, Math.min(1, base)), reasons };
}

// ---------------------------------------------------------------- validation

function nativeJsonError(input: string): { message: string; offset?: number; line?: number; column?: number } | null {
  try {
    JSON.parse(input);
    return null;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const lc = /line (\d+) column (\d+)/.exec(message);
    const pos = /position (\d+)/.exec(message);
    return {
      message,
      line: lc ? Number(lc[1]) : undefined,
      column: lc ? Number(lc[2]) : undefined,
      offset: pos ? Number(pos[1]) : undefined,
    };
  }
}

function validateJsonFamily(mode: JsonMode, input: string, ctx: ModuleContext): ValidateResult {
  const parser = new JsonParser(input, mode, ctx.lines);
  const { diagnostics, stats } = parser.parse();
  let diags = diagnostics;
  const myErrors = diags.filter((d) => d.severity === 'error').length;

  // Defense in depth: the platform parser is the reference implementation for JSON validity.
  if (mode === 'json') {
    const native = nativeJsonError(input);
    if (native && myErrors === 0) {
      const p = native.offset !== undefined ? ctx.lines.positionAt(native.offset) : { line: native.line ?? 1, column: native.column ?? 1 };
      diags = [
        ...diags,
        diagAtLineCol(ctx.lines, p.line, p.column, {
          code: 'json/native-parse-error',
          type: 'Syntax error',
          message: native.message,
          source: 'JSON.parse',
        }),
      ];
    } else if (!native && myErrors > 0) {
      diags = diags.filter((d) => d.severity !== 'error');
    }
  } else if (mode === 'json5' && input.length < 8_000_000) {
    let err: { message: string; lineNumber?: number; columnNumber?: number } | null = null;
    try {
      JSON5.parse(input);
    } catch (e) {
      err = e as { message: string; lineNumber?: number; columnNumber?: number };
    }
    if (err && myErrors === 0) {
      diags = [
        ...diags,
        diagAtLineCol(ctx.lines, err.lineNumber ?? 1, err.columnNumber ?? 1, {
          code: 'json5/parse-error',
          type: 'Syntax error',
          message: err.message.replace(/^JSON5: /, ''),
          source: 'json5',
        }),
      ];
    } else if (!err && myErrors > 0) {
      diags = diags.filter((d) => d.severity !== 'error');
    }
  }

  const facts: Record<string, string | number> = { 'Root type': stats.rootKind, Keys: stats.keys, Objects: stats.objects, Arrays: stats.arrays, 'Max depth': stats.depth };
  if (stats.comments) facts.Comments = stats.comments;
  if (stats.duplicateKeys) facts['Duplicate keys'] = stats.duplicateKeys;
  return { diagnostics: diags, facts, validator: mode === 'json' ? 'FormatX JSON parser + JSON.parse' : mode === 'json5' ? 'FormatX JSON5 parser + json5' : 'FormatX JSONC parser' };
}

// ---------------------------------------------------------------- module factory

export function createJsonModule(mode: JsonMode): FormatModule {
  return {
    descriptor: DESCRIPTORS[mode],
    sample: SAMPLES[mode],
    detect: (ctx) => detectFor(mode, ctx),
    validate: (input, ctx) => validateJsonFamily(mode, input, ctx),
    beautify(input, ctx) {
      const unit = indentUnit(ctx.options.indent);
      if (ctx.options.sortKeys) {
        const ast = new AstBuilder();
        const parser = new JsonParser(input, mode, ctx.lines, ast);
        const { stats, incomplete } = parser.parse();
        if (incomplete || !ast.root) throw new Error('The document is too deeply nested to sort keys safely.');
        const warnings: Diagnostic[] = [];
        if (stats.comments > 0) {
          warnings.push(notice({ code: 'json/sort-drops-comments', type: 'Comments removed', message: `Sorting keys cannot preserve comment placement: ${stats.comments} comment(s) were removed. Turn off "Sort keys" to keep them.`, source: 'JSON formatter' }));
        }
        return { text: printAst(ast.root, unit, true), warnings, notes: ['Keys sorted in code point order.'] };
      }
      const r = beautifyTokens(input, unit, mode !== 'json');
      return { text: r.text, notes: r.comments ? [`${r.comments} comment(s) preserved.`] : [] };
    },
    minify(input) {
      const r = minifyTokens(input);
      const warnings: Diagnostic[] = [];
      if (r.comments) warnings.push(notice({ severity: 'info', code: 'json/minify-removed-comments', type: 'Comments removed', message: `${r.comments} comment(s) were removed by minification.`, source: 'JSON minifier' }));
      return { text: r.text, warnings };
    },
    toData(input, ctx) {
      const builder = new DataBuilder();
      const parser = new JsonParser(input, mode, ctx.lines, builder);
      const { stats, incomplete } = parser.parse();
      if (incomplete) throw new Error('The document is too deeply nested to convert safely (more than 2000 levels).');
      const warnings: Diagnostic[] = [];
      if (stats.comments) warnings.push(notice({ code: 'convert/comments-dropped', type: 'Comments not preserved', message: `${stats.comments} comment(s) cannot be carried over to the converted data.`, source: NAMES[mode] }));
      if (stats.duplicateKeys) warnings.push(notice({ code: 'convert/duplicate-keys', type: 'Duplicate keys', message: `${stats.duplicateKeys} duplicate key(s): only the last value of each was kept.`, source: NAMES[mode] }));
      for (const l of builder.losses.slice(0, 5)) {
        warnings.push(notice({ code: 'convert/number-precision', type: 'Precision loss', message: `Number ${l.raw} cannot be represented exactly as a 64-bit float and will be rounded to ${String(Number(l.raw))}.`, source: NAMES[mode], path: pathToString(l.path) }));
      }
      return { data: builder.root, warnings };
    },
    fromData(data, ctx) {
      const warnings: Diagnostic[] = [];
      const text = stringifyData(data, { indent: indentUnit(ctx.options.indent), json5: mode === 'json5' }, warnings);
      return { text, warnings };
    },
    verifyTransform(original, output, ctx) {
      if (ctx.options.sortKeys) return null;
      // Token sequence (minus comments/whitespace) must be identical.
      const a = minifyTokens(original).text;
      const b = minifyTokens(output).text;
      return a === b ? null : 'Formatting changed significant tokens; the output was discarded to protect your data.';
    },
  };
}

export const jsonModule = createJsonModule('json');
export const jsoncModule = createJsonModule('jsonc');
export const json5Module = createJsonModule('json5');
