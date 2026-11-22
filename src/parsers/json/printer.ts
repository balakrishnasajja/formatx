import { DataDate, type DataValue } from '../../types/data';
import type { Diagnostic } from '../../types/diagnostics';
import { pathToString, type PathSegment } from '../../engines/converters/dataModel';
import { notice } from '../../utils/diag';
import { toBase64 } from '../../utils/bytes';
import type { JsonAst } from './builders';
import { JsonScanner } from './scanner';

/**
 * Token-stream pretty printer. Only whitespace changes: every literal, string
 * escape and comment is copied verbatim, so numbers like 12345678901234567890
 * are never rounded (unlike JSON.parse + JSON.stringify).
 */
export function beautifyTokens(text: string, indent: string, keepBlankLines: boolean): { text: string; comments: number } {
  const sc = new JsonScanner(text);
  const out: string[] = [];
  let level = 0;
  let pendingNewline = false;
  let needSpace = false;
  let wroteAny = false;
  let comments = 0;

  const push = (s: string) => {
    out.push(s);
    wroteAny = true;
  };
  const breakLine = (nlBefore: number) => {
    out.push('\n');
    if (keepBlankLines && nlBefore >= 2) out.push('\n');
    out.push(indent.repeat(level));
    pendingNewline = false;
    needSpace = false;
  };
  const begin = (nlBefore: number) => {
    if (pendingNewline) breakLine(nlBefore);
    else if (needSpace) {
      out.push(' ');
      needSpace = false;
    }
  };
  const isPunct = (k: string) => k === ',' || k === ':' || k === '}' || k === ']';

  for (;;) {
    const t = sc.next();
    if (t.kind === 'eof') break;
    const raw = text.slice(t.start, t.end);
    switch (t.kind) {
      case '{':
      case '[': {
        begin(t.nlBefore);
        const closer = t.kind === '{' ? '}' : ']';
        if (sc.peek().kind === closer) {
          sc.next();
          push(t.kind + closer);
        } else {
          push(t.kind);
          level++;
          pendingNewline = true;
        }
        break;
      }
      case '}':
      case ']':
        level = Math.max(0, level - 1);
        out.push('\n', indent.repeat(level));
        push(t.kind);
        pendingNewline = false;
        needSpace = false;
        break;
      case ',':
        push(',');
        pendingNewline = true;
        needSpace = false;
        break;
      case ':':
        push(':');
        needSpace = true;
        break;
      case 'lineComment':
        comments++;
        if (wroteAny && t.nlBefore === 0) out.push(' ' + raw.trimEnd());
        else {
          if (wroteAny) breakLine(t.nlBefore);
          push(raw.trimEnd());
        }
        pendingNewline = true;
        needSpace = false;
        break;
      case 'blockComment': {
        comments++;
        const next = sc.peek();
        const nextSameLine = next.kind !== 'eof' && next.nlBefore === 0 && !isPunct(next.kind);
        // A comment on the same line as the following token "leads" that token.
        const leading = pendingNewline && nextSameLine;
        if (wroteAny && t.nlBefore === 0 && !leading) {
          out.push(' ' + raw.trimEnd());
          needSpace = true;
        } else {
          if (wroteAny) breakLine(t.nlBefore);
          push(raw.trimEnd());
          if (nextSameLine) needSpace = true;
          else pendingNewline = true;
        }
        break;
      }
      default:
        begin(t.nlBefore);
        push(raw);
    }
  }
  return { text: out.join(''), comments };
}

/** Removes all insignificant whitespace and comments. Literals are copied verbatim. */
export function minifyTokens(text: string): { text: string; comments: number } {
  const sc = new JsonScanner(text);
  const out: string[] = [];
  let comments = 0;
  for (;;) {
    const t = sc.next();
    if (t.kind === 'eof') break;
    if (t.kind === 'lineComment' || t.kind === 'blockComment') {
      comments++;
      continue;
    }
    out.push(text.slice(t.start, t.end));
  }
  return { text: out.join(''), comments };
}

/** Prints a raw-preserving AST, optionally sorting object keys (code point order). */
export function printAst(node: JsonAst, indent: string, sortKeys: boolean, level = 0): string {
  if (node.t === 'l') return node.raw;
  const pad = indent.repeat(level + 1);
  const end = indent.repeat(level);
  if (node.t === 'a') {
    if (node.items.length === 0) return '[]';
    return '[\n' + node.items.map((i) => pad + printAst(i, indent, sortKeys, level + 1)).join(',\n') + '\n' + end + ']';
  }
  if (node.members.length === 0) return '{}';
  const members = sortKeys ? [...node.members].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)) : node.members;
  return '{\n' + members.map((m) => `${pad}${m.rawKey}: ${printAst(m.value, indent, sortKeys, level + 1)}`).join(',\n') + '\n' + end + '}';
}

const JSON5_IDENT = /^[\p{ID_Start}$_][\p{ID_Continue}$\u{200C}\u{200D}]*$/u;

/** Serialize the neutral data model as JSON or JSON5. */
export function stringifyData(
  value: DataValue,
  opts: { indent: string; json5?: boolean; minify?: boolean },
  warnings: Diagnostic[],
): string {
  const seen = new Set<string>();
  const warnOnce = (code: string, type: string, message: string, path: PathSegment[]) => {
    if (seen.has(code)) return;
    seen.add(code);
    warnings.push(notice({ code, type, message, source: 'JSON writer', path: pathToString(path) }));
  };
  const nl = opts.minify ? '' : '\n';
  const colon = opts.minify ? ':' : ': ';
  const write = (v: DataValue, level: number, path: PathSegment[]): string => {
    if (v === null) return 'null';
    switch (typeof v) {
      case 'boolean':
        return String(v);
      case 'bigint':
        return v.toString();
      case 'number':
        if (Number.isFinite(v)) return Object.is(v, -0) ? '0' : String(v);
        if (opts.json5) return Number.isNaN(v) ? 'NaN' : v > 0 ? 'Infinity' : '-Infinity';
        warnOnce('convert/non-finite', 'Value not representable', `${String(v)} cannot be represented in JSON and was written as null.`, path);
        return 'null';
      case 'string':
        return JSON.stringify(v);
    }
    if (v instanceof DataDate) {
      warnOnce('convert/date-as-string', 'Type changed', 'Date/time values are written as ISO 8601 strings (JSON has no date type).', path);
      return JSON.stringify(v.iso);
    }
    if (v instanceof Uint8Array) {
      warnOnce('convert/binary-as-base64', 'Type changed', 'Binary data is written as a base64 string.', path);
      return JSON.stringify(toBase64(v));
    }
    const pad = opts.minify ? '' : opts.indent.repeat(level + 1);
    const end = opts.minify ? '' : opts.indent.repeat(level);
    if (Array.isArray(v)) {
      if (v.length === 0) return '[]';
      const items = v.map((item, i) => pad + write(item, level + 1, [...path, i]));
      return '[' + nl + items.join(',' + nl) + nl + end + ']';
    }
    if (v.size === 0) return '{}';
    const members: string[] = [];
    for (const [k, child] of v) {
      const key = opts.json5 && JSON5_IDENT.test(k) ? k : JSON.stringify(k);
      members.push(pad + key + colon + write(child, level + 1, [...path, k]));
    }
    return '{' + nl + members.join(',' + nl) + nl + end + '}';
  };
  return write(value, 0, []);
}
