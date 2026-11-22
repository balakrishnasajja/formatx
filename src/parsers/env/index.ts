import { DESCRIPTORS } from '../../engines/catalog';
import { flatten, inferScalar } from '../../engines/converters/dataModel';
import { lineRatio } from '../../engines/detection/context';
import { DataDate, type DataObject, type DataValue } from '../../types/data';
import type { Diagnostic } from '../../types/diagnostics';
import type { DetectContext, DetectScore, FormatModule, ModuleContext } from '../../types/module';
import { toBase64 } from '../../utils/bytes';
import { diagAt, notice, relatedAt } from '../../utils/diag';
import { SAMPLES } from '../samples';

type EnvStmt =
  | { k: 'blank' }
  | { k: 'comment'; text: string }
  | { k: 'var'; exported: boolean; key: string; raw: string; value: string; comment?: string; offset: number };

const SOURCE = 'dotenv parser';
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function decodeDouble(s: string): string {
  return s.replace(/\\([nrt"\\$])/g, (_, c: string) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c));
}

/** dotenv grammar (as implemented by the `dotenv` package and docker compose). */
export function parseEnv(text: string, ctx: ModuleContext | null): { stmts: EnvStmt[]; diagnostics: Diagnostic[] } {
  const stmts: EnvStmt[] = [];
  const diagnostics: Diagnostic[] = [];
  const lines = ctx?.lines;
  const report = (offset: number, length: number, severity: 'error' | 'warning' | 'info', code: string, type: string, message: string, extra: { suggestion?: string; fix?: { title: string; offset: number; length: number; text: string }; related?: { offset: number; message: string } } = {}) => {
    if (!lines || diagnostics.length > 300) return;
    diagnostics.push(diagAt(lines, offset, length, { severity, code, type, message, source: SOURCE, suggestion: extra.suggestion, fix: extra.fix ? { title: extra.fix.title, edits: [{ offset: extra.fix.offset, length: extra.fix.length, text: extra.fix.text }] } : undefined, related: extra.related ? [relatedAt(lines, extra.related.offset, extra.related.message)] : undefined }));
  };
  const seen = new Map<string, number>();
  const len = text.length;
  let i = 0;
  while (i < len) {
    let eol = text.indexOf('\n', i);
    if (eol === -1) eol = len;
    const lineEnd = eol > i && text[eol - 1] === '\r' ? eol - 1 : eol;
    const line = text.slice(i, lineEnd);
    const t = line.trim();
    const lead = line.length - line.trimStart().length;
    const start = i + lead;
    if (!t) {
      stmts.push({ k: 'blank' });
      i = eol + 1;
      continue;
    }
    if (t.startsWith('#')) {
      stmts.push({ k: 'comment', text: t });
      i = eol + 1;
      continue;
    }
    let p = start;
    let exported = false;
    const ex = /^export\s+/.exec(text.slice(p, lineEnd));
    if (ex) {
      exported = true;
      p += ex[0].length;
    }
    const eq = text.indexOf('=', p);
    if (eq === -1 || eq > lineEnd) {
      const word = text.slice(p, lineEnd).trim();
      report(start, t.length, 'error', 'env/missing-equals', 'Missing =', `"${word.length > 40 ? word.slice(0, 40) + '…' : word}" is not a KEY=value assignment.`, {
        suggestion: KEY_RE.test(word) ? `Write ${word}= for an empty value.` : 'Use KEY=value, or start the line with # to make it a comment.',
        fix: KEY_RE.test(word) ? { title: `Append '='`, offset: lineEnd, length: 0, text: '=' } : { title: 'Turn into a comment', offset: start, length: 0, text: '# ' },
      });
      stmts.push({ k: 'comment', text: '# ' + t });
      i = eol + 1;
      continue;
    }
    const rawKey = text.slice(p, eq);
    const key = rawKey.trim();
    if (rawKey !== rawKey.trimEnd() || /^\s/.test(text.slice(eq + 1, eq + 2)) && text.slice(eq + 1, lineEnd).trim()) {
      report(p, eq - p + 1, 'warning', 'env/space-around-equals', 'Spaces around =', 'Spaces around = are accepted by dotenv but break `source .env` in POSIX shells.', {
        fix: { title: 'Remove spaces around =', offset: p, length: eq + 1 - p + (text.slice(eq + 1, lineEnd).length - text.slice(eq + 1, lineEnd).trimStart().length), text: `${key}=` },
      });
    }
    if (!key) report(start, 1, 'error', 'env/missing-key', 'Missing key', 'Assignment has no variable name.');
    else if (!KEY_RE.test(key)) {
      report(p, key.length, 'error', 'env/invalid-key', 'Invalid variable name', `"${key}" is not a valid variable name. Use letters, digits and underscores, starting with a letter or underscore.`, {
        fix: { title: `Rename to ${key.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1')}`, offset: p, length: rawKey.trimEnd().length, text: key.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') },
      });
    } else if (/[.-]/.test(key)) {
      report(p, key.length, 'warning', 'env/key-not-portable', 'Non-portable name', `"${key}" contains '.' or '-': dotenv accepts it, but shells cannot use it as a variable name.`);
    }
    // value
    let v = eq + 1;
    while (v < lineEnd && (text[v] === ' ' || text[v] === '\t')) v++;
    const q = text[v];
    let value = '';
    let raw = '';
    let comment: string | undefined;
    let next = eol + 1;
    if (q === '"' || q === "'" || q === '`') {
      let e = v + 1;
      while (e < len) {
        if (text[e] === '\\' && q === '"') {
          e += 2;
          continue;
        }
        if (text[e] === q) break;
        e++;
      }
      if (e >= len) {
        report(v, 1, 'error', 'env/unterminated-quote', 'Unterminated quote', `Value of ${key} starts with ${q} but is never closed.`, { suggestion: `Add the closing ${q}.` });
        raw = text.slice(v, lineEnd);
        value = raw.slice(1);
      } else {
        raw = text.slice(v, e + 1);
        const inner = text.slice(v + 1, e);
        value = q === '"' ? decodeDouble(inner) : inner;
        // rest of the (last) line after the closing quote
        let restEnd = text.indexOf('\n', e);
        if (restEnd === -1) restEnd = len;
        const rest = text.slice(e + 1, restEnd).replace(/\r$/, '');
        if (rest.trim()) {
          if (/^\s+#/.test(rest)) comment = rest.trim();
          else report(e + 1, rest.length, 'error', 'env/text-after-quote', 'Unexpected text', `Unexpected text after the quoted value of ${key}.`);
        }
        next = restEnd + 1;
      }
    } else {
      const restText = text.slice(v, lineEnd);
      const m = /\s+#/.exec(restText);
      raw = (m ? restText.slice(0, m.index) : restText).trim();
      if (m) comment = restText.slice(m.index).trim();
      value = raw;
      if (/\s/.test(raw)) {
        report(v, raw.length, 'info', 'env/unquoted-spaces', 'Unquoted spaces', `Value of ${key} contains spaces; quote it for compatibility with shells and docker --env-file.`, {
          fix: { title: 'Wrap in double quotes', offset: v, length: raw.length, text: `"${raw.replace(/(["\\$`])/g, '\\$1')}"` },
        });
      }
    }
    if (key) {
      const prev = seen.get(key);
      if (prev !== undefined) report(p, key.length, 'warning', 'env/duplicate-key', 'Duplicate variable', `${key} is defined more than once; the later value overrides the earlier one.`, { related: { offset: prev, message: 'First definition' } });
      else seen.set(key, p);
    }
    stmts.push({ k: 'var', exported, key, raw, value, comment, offset: start });
    i = next;
  }
  // ${VAR} references to variables not defined in this file
  if (lines) {
    for (const s of stmts) {
      if (s.k !== 'var' || s.raw.startsWith("'")) continue;
      const refRe = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-[^}]*)?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
      let m: RegExpExecArray | null;
      while ((m = refRe.exec(s.raw))) {
        const name = m[1] ?? m[2];
        if (!seen.has(name) && !['HOME', 'PATH', 'USER', 'PWD', 'SHELL', 'HOSTNAME', 'TMPDIR'].includes(name)) {
          report(s.offset, s.key.length, 'info', 'env/undefined-reference', 'External reference', `${s.key} references $${name}, which is not defined in this file (it must come from the environment).`);
        }
      }
    }
  }
  return { stmts, diagnostics };
}

function printEnv(stmts: EnvStmt[], minify: boolean): string {
  const out: string[] = [];
  for (const s of stmts) {
    if (s.k === 'blank') {
      if (!minify && out.length && out[out.length - 1] !== '') out.push('');
    } else if (s.k === 'comment') {
      if (!minify) out.push(s.text);
    } else {
      out.push(`${s.exported ? 'export ' : ''}${s.key}=${s.raw}${s.comment && !minify ? ' ' + s.comment : ''}`);
    }
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  while (out.length && out[0] === '') out.shift();
  return out.join('\n');
}

function envKey(k: string): string {
  let s = k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
  if (/^\d/.test(s)) s = '_' + s;
  return s || '_';
}

function envValue(v: DataValue): string {
  let s: string;
  if (v === null) s = '';
  else if (v instanceof DataDate) s = v.iso;
  else if (v instanceof Uint8Array) s = toBase64(v);
  else s = String(v);
  if (s === '') return '';
  if (/^[A-Za-z0-9_./:@%+,-]+$/.test(s)) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
}

function detectEnv(ctx: DetectContext): DetectScore | null {
  const comment = /^\s*#/;
  const assigns = lineRatio(ctx.lines, /^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/, comment);
  const upper = lineRatio(ctx.lines, /^\s*(export\s+)?[A-Z_][A-Z0-9_]*=/, comment);
  const sections = lineRatio(ctx.lines, /^\s*\[.*\]\s*$/, comment).count;
  if (assigns.ratio < 0.7 || sections) return null;
  const reasons = ['KEY=value assignments'];
  let score = 0.35 + upper.ratio * 0.45;
  if (upper.ratio > 0.8) reasons.push('UPPER_SNAKE_CASE variable names');
  if (ctx.lines.some((l) => /^\s*export\s+/.test(l))) {
    score += 0.1;
    reasons.push('export statements');
  }
  if (/^\.env/.test(ctx.fileName ?? '')) score += 0.3;
  return { score: Math.min(0.92, score), reasons };
}

export const envModule: FormatModule = {
  descriptor: DESCRIPTORS.env,
  sample: SAMPLES.env,
  detect: detectEnv,
  detectBoost: 0.35,
  validate(input, ctx) {
    const { stmts, diagnostics } = parseEnv(input, ctx);
    return { diagnostics, facts: { Variables: stmts.filter((s) => s.k === 'var').length, Exported: stmts.filter((s) => s.k === 'var' && s.exported).length } };
  },
  beautify(input) {
    return { text: printEnv(parseEnv(input, null).stmts, false), notes: ['Spaces around = removed; quotes and values are kept exactly as written.'] };
  },
  minify(input) {
    return { text: printEnv(parseEnv(input, null).stmts, true) };
  },
  verifyTransform(original, output) {
    const pick = (t: string) => JSON.stringify(parseEnv(t, null).stmts.filter((s) => s.k === 'var').map((s) => s.k === 'var' && [s.key, s.value, s.exported]));
    return pick(original) === pick(output) ? null : 'Formatting would change variable values; the output was discarded.';
  },
  toData(input, ctx) {
    const { stmts } = parseEnv(input, null);
    const data: DataObject = new Map();
    let comments = 0;
    for (const s of stmts) {
      if (s.k === 'comment') comments++;
      if (s.k === 'var') data.set(s.key, ctx.options.inferTypes && !/^["'`]/.test(s.raw) ? inferScalar(s.value) : s.value);
    }
    const warnings: Diagnostic[] = [];
    if (comments) warnings.push(notice({ code: 'convert/comments-dropped', type: 'Comments not preserved', message: `${comments} comment(s) were dropped.`, source: 'ENV' }));
    return { data, warnings };
  },
  fromData(data) {
    const warnings: Diagnostic[] = [];
    const { entries, flattenedPaths } = flatten(data instanceof Map || Array.isArray(data) ? data : new Map([['VALUE', data]]), { separator: '_' });
    const lines: string[] = [];
    const used = new Set<string>();
    let renamed = 0;
    for (const [k, v] of entries) {
      const key = envKey(k);
      if (key !== k) renamed++;
      if (used.has(key)) warnings.push(notice({ code: 'convert/key-collision', type: 'Name collision', message: `Several keys map to ${key}; the last one wins.`, source: 'ENV writer' }));
      used.add(key);
      lines.push(`${key}=${envValue(v)}`);
    }
    if (flattenedPaths) warnings.push(notice({ code: 'convert/flattened', type: 'Nested data flattened', message: 'Nested objects and arrays were flattened into KEY_SUBKEY names.', source: 'ENV writer' }));
    if (renamed) warnings.push(notice({ severity: 'info', code: 'convert/renamed-keys', type: 'Keys renamed', message: `${renamed} key(s) were converted to UPPER_SNAKE_CASE environment variable names.`, source: 'ENV writer' }));
    warnings.push(notice({ severity: 'info', code: 'convert/types-to-text', type: 'Types become text', message: 'Environment variables are strings: numbers, booleans and null become text.', source: 'ENV writer' }));
    return { text: lines.join('\n'), warnings };
  },
};
