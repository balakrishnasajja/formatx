import { DESCRIPTORS } from '../../engines/catalog';
import { flatten, inferScalar, unflatten } from '../../engines/converters/dataModel';
import { lineRatio } from '../../engines/detection/context';
import { DataDate, type DataObject, type DataValue } from '../../types/data';
import type { Diagnostic } from '../../types/diagnostics';
import type { DetectContext, DetectScore, FormatModule, ModuleContext } from '../../types/module';
import { toBase64 } from '../../utils/bytes';
import { diagAt, notice, relatedAt } from '../../utils/diag';
import { SAMPLES } from '../samples';

type PropStmt =
  | { k: 'blank' }
  | { k: 'comment'; text: string }
  | { k: 'prop'; rawKey: string; key: string; rawParts: string[]; value: string; offset: number };

const SOURCE = 'Properties parser';

/** Decode java.util.Properties escapes. Returns positions of malformed \u escapes. */
function unescapeProps(s: string): { value: string; bad: number[] } {
  let out = '';
  const bad: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = s[++i];
    if (n === undefined) break;
    switch (n) {
      case 't':
        out += '\t';
        break;
      case 'n':
        out += '\n';
        break;
      case 'r':
        out += '\r';
        break;
      case 'f':
        out += '\f';
        break;
      case 'u': {
        const hex = s.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else bad.push(i - 1);
        break;
      }
      default:
        out += n;
    }
  }
  return { value: out, bad };
}

function trailingBackslashes(s: string): number {
  let n = 0;
  for (let i = s.length - 1; i >= 0 && s[i] === '\\'; i--) n++;
  return n;
}

/** Implements java.util.Properties.load(): logical lines, continuations, separators, escapes. */
export function parseProperties(text: string, ctx: ModuleContext | null): { stmts: PropStmt[]; diagnostics: Diagnostic[] } {
  const stmts: PropStmt[] = [];
  const diagnostics: Diagnostic[] = [];
  const lines = ctx?.lines;
  const report = (offset: number, length: number, severity: 'error' | 'warning' | 'info', code: string, type: string, message: string, extra: { suggestion?: string; related?: { offset: number; message: string } } = {}) => {
    if (!lines || diagnostics.length > 300) return;
    diagnostics.push(diagAt(lines, offset, length, { severity, code, type, message, source: SOURCE, suggestion: extra.suggestion, related: extra.related ? [relatedAt(lines, extra.related.offset, extra.related.message)] : undefined }));
  };
  const physical: { text: string; offset: number }[] = [];
  {
    let off = 0;
    const parts = text.split(/(\r\n|\r|\n)/);
    for (let i = 0; i < parts.length; i += 2) {
      physical.push({ text: parts[i], offset: off });
      off += parts[i].length + (parts[i + 1]?.length ?? 0);
    }
  }
  const seen = new Map<string, number>();
  for (let i = 0; i < physical.length; i++) {
    const { text: line, offset } = physical[i];
    const lead = line.length - line.trimStart().length;
    const body = line.slice(lead);
    if (!body) {
      stmts.push({ k: 'blank' });
      continue;
    }
    if (body[0] === '#' || body[0] === '!') {
      stmts.push({ k: 'comment', text: body.trimEnd() });
      continue;
    }
    // gather logical line
    const rawParts = [body];
    let logical = body;
    let j = i;
    while (trailingBackslashes(logical) % 2 === 1) {
      logical = logical.slice(0, -1);
      j++;
      if (j >= physical.length) {
        report(offset + lead + body.length - 1, 1, 'warning', 'properties/dangling-continuation', 'Dangling continuation', 'The last line ends with a line-continuation backslash but there is no following line.');
        break;
      }
      const cont = physical[j].text.trimStart();
      rawParts.push(cont);
      logical += cont;
    }
    i = j;
    // key ends at first unescaped '=', ':' or whitespace
    let k = 0;
    while (k < logical.length) {
      const ch = logical[k];
      if (ch === '\\') {
        k += 2;
        continue;
      }
      if (ch === '=' || ch === ':' || ch === ' ' || ch === '\t' || ch === '\f') break;
      k++;
    }
    const rawKey = logical.slice(0, k);
    let v = k;
    while (v < logical.length && /[ \t\f]/.test(logical[v])) v++;
    if (logical[v] === '=' || logical[v] === ':') {
      v++;
      while (v < logical.length && /[ \t\f]/.test(logical[v])) v++;
    }
    const rawValue = logical.slice(v);
    const kd = unescapeProps(rawKey);
    const vd = unescapeProps(rawValue);
    for (const b of [...kd.bad, ...vd.bad.map((x) => x + v)]) {
      report(offset + lead + Math.min(b, body.length - 1), 2, 'error', 'properties/malformed-unicode', 'Malformed \\u escape', 'Malformed \\uXXXX escape: exactly four hexadecimal digits are required (java.util.Properties throws IllegalArgumentException).', {
        suggestion: 'Write a literal backslash as \\\\.',
      });
    }
    if (!rawValue && v === k) {
      report(offset + lead, rawKey.length, 'info', 'properties/no-value', 'Key without value', `"${kd.value}" has no separator or value; it is read as an empty string.`);
    }
    const prev = seen.get(kd.value);
    if (prev !== undefined) report(offset + lead, rawKey.length, 'warning', 'properties/duplicate-key', 'Duplicate key', `Key "${kd.value}" is defined more than once; the last value wins.`, { related: { offset: prev, message: 'First definition' } });
    else seen.set(kd.value, offset + lead);
    stmts.push({ k: 'prop', rawKey, key: kd.value, rawParts: rawParts.map((p, idx) => (idx === 0 ? p.slice(Math.min(p.length, v)) : p)), value: vd.value, offset: offset + lead });
  }
  return { stmts, diagnostics };
}

function printProperties(stmts: PropStmt[], minify: boolean): string {
  const out: string[] = [];
  for (const s of stmts) {
    if (s.k === 'blank') {
      if (!minify && out.length && out[out.length - 1] !== '') out.push('');
    } else if (s.k === 'comment') {
      if (!minify) out.push(s.text);
    } else if (minify || s.rawParts.length === 1) {
      // join continuation lines into a single logical line (semantics are identical)
      const joined = s.rawParts.map((p, i) => (i < s.rawParts.length - 1 ? p.slice(0, -1) : p)).join('');
      out.push(`${s.rawKey}=${joined}`);
    } else {
      out.push(`${s.rawKey}=${s.rawParts[0]}`);
      for (let i = 1; i < s.rawParts.length; i++) out.push('    ' + s.rawParts[i]);
    }
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  while (out.length && out[0] === '') out.shift();
  return out.join('\n');
}

function escapeKey(k: string): string {
  return k.replace(/\\/g, '\\\\').replace(/([=: #!])/g, '\\$1').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}
function escapeValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/^ /, '\\ ').replace(/^([#!])/, '\\$1');
}

function detectProperties(ctx: DetectContext): DetectScore | null {
  const comment = /^\s*[#!]/;
  const pairs = lineRatio(ctx.lines, /^\s*[^\s=:#!][^=:\s]*\s*[=:]/, comment);
  const dotted = lineRatio(ctx.lines, /^\s*[a-z][\w-]*(\.[\w\-[\]]+)+\s*[=:]/, comment);
  const upper = lineRatio(ctx.lines, /^\s*[A-Z_][A-Z0-9_]*=/, comment);
  const sections = lineRatio(ctx.lines, /^\s*\[.*\]\s*$/).count;
  const yamlish = lineRatio(ctx.lines, /^\s*[\w-]+:\s*$|^\s*-\s/).count;
  if (pairs.ratio < 0.7 || sections) return null;
  const reasons = ['key=value pairs'];
  let score = 0.3;
  if (dotted.ratio > 0.4) {
    score += 0.35 * dotted.ratio + 0.1;
    reasons.push('Dotted keys (a.b.c)');
  }
  if (ctx.lines.some((l) => /^\s*!/.test(l))) score += 0.1;
  if (ctx.lines.some((l) => /\\u[0-9a-fA-F]{4}|\\$/.test(l))) score += 0.05;
  score -= upper.ratio * 0.4 + (yamlish ? 0.3 : 0);
  return score > 0.15 ? { score: Math.min(0.9, score), reasons } : null;
}

export const propertiesModule: FormatModule = {
  descriptor: DESCRIPTORS.properties,
  sample: SAMPLES.properties,
  detect: detectProperties,
  detectBoost: 0.3,
  validate(input, ctx) {
    const { stmts, diagnostics } = parseProperties(input, ctx);
    return { diagnostics, facts: { Properties: stmts.filter((s) => s.k === 'prop').length, Comments: stmts.filter((s) => s.k === 'comment').length } };
  },
  beautify(input) {
    return { text: printProperties(parseProperties(input, null).stmts, false), notes: ['Separators normalized to key=value; values (including trailing spaces) are kept exactly.'] };
  },
  minify(input) {
    return { text: printProperties(parseProperties(input, null).stmts, true) };
  },
  verifyTransform(original, output) {
    const pick = (t: string) => JSON.stringify(parseProperties(t, null).stmts.flatMap((s) => (s.k === 'prop' ? [[s.key, s.value]] : [])));
    return pick(original) === pick(output) ? null : 'Formatting would change property values; the output was discarded.';
  },
  toData(input, ctx) {
    const { stmts } = parseProperties(input, null);
    const flat = new Map<string, DataValue>();
    let comments = 0;
    for (const s of stmts) {
      if (s.k === 'comment') comments++;
      if (s.k === 'prop') {
        const key = ctx.options.expandDottedKeys ? s.key.replace(/\[(\d+)\]/g, '.$1') : s.key;
        flat.set(key, ctx.options.inferTypes ? inferScalar(s.value) : s.value);
      }
    }
    const warnings: Diagnostic[] = [];
    if (comments) warnings.push(notice({ code: 'convert/comments-dropped', type: 'Comments not preserved', message: `${comments} comment(s) were dropped.`, source: 'Properties' }));
    if (!ctx.options.expandDottedKeys) return { data: flat as DataObject, warnings };
    const u = unflatten(flat);
    if (u.conflicts.length) warnings.push(notice({ code: 'convert/key-conflicts', type: 'Key conflicts', message: `Keys ${u.conflicts.slice(0, 3).map((c) => JSON.stringify(c)).join(', ')} conflict with nested keys and were kept flat.`, source: 'Properties' }));
    return { data: u.value, warnings };
  },
  fromData(data) {
    const warnings: Diagnostic[] = [];
    const { entries, flattenedPaths } = flatten(data instanceof Map || Array.isArray(data) ? data : new Map([['value', data]]), { separator: '.', arrayStyle: 'bracket' });
    const lines: string[] = [];
    let nulls = 0;
    for (const [k, v] of entries) {
      if (v === null) nulls++;
      const s = v === null ? '' : v instanceof DataDate ? v.iso : v instanceof Uint8Array ? toBase64(v) : String(v);
      lines.push(`${escapeKey(k)}=${escapeValue(s)}`);
    }
    if (flattenedPaths) warnings.push(notice({ severity: 'info', code: 'convert/flattened', type: 'Nested data flattened', message: 'Nested objects use dotted keys and arrays use key[index] (Spring Boot convention).', source: 'Properties writer' }));
    if (nulls) warnings.push(notice({ code: 'convert/null-as-empty', type: 'null values', message: `${nulls} null value(s) were written as empty strings.`, source: 'Properties writer' }));
    warnings.push(notice({ severity: 'info', code: 'convert/types-to-text', type: 'Types become text', message: 'Properties values are strings: numbers and booleans become text.', source: 'Properties writer' }));
    return { text: lines.join('\n'), warnings };
  },
};
