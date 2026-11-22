import { DESCRIPTORS } from '../../engines/catalog';
import { inferScalar, pathToString, type PathSegment } from '../../engines/converters/dataModel';
import { lineRatio } from '../../engines/detection/context';
import { DataDate, type DataObject, type DataValue } from '../../types/data';
import type { Diagnostic } from '../../types/diagnostics';
import type { DetectContext, DetectScore, FormatModule, ModuleContext } from '../../types/module';
import { toBase64 } from '../../utils/bytes';
import { diagAt, notice, relatedAt } from '../../utils/diag';
import { SAMPLES } from '../samples';

type IniStmt =
  | { k: 'blank' }
  | { k: 'comment'; text: string }
  | { k: 'section'; name: string; comment?: string; offset: number }
  | { k: 'kv'; key: string; sep: '=' | ':'; value: string; comment?: string; offset: number; continuation: string[]; flag: boolean };

const SOURCE = 'INI parser';

/** Split an unquoted value from an inline comment (`; c` or `# c` preceded by whitespace). */
function splitInlineComment(v: string): { value: string; comment?: string } {
  const t = v.trim();
  if (t.startsWith('"') || t.startsWith("'")) {
    const q = t[0];
    const end = t.indexOf(q, 1);
    if (end > 0) {
      const rest = t.slice(end + 1).trim();
      if (rest.startsWith(';') || rest.startsWith('#')) return { value: t.slice(0, end + 1), comment: rest };
    }
    return { value: t };
  }
  const m = /\s[;#]/.exec(v);
  if (m) return { value: v.slice(0, m.index).trim(), comment: v.slice(m.index + 1).trim() };
  return { value: t };
}

export function unquoteIni(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) return v.slice(1, -1);
  return v;
}

export function parseIni(text: string, ctx: ModuleContext | null): { stmts: IniStmt[]; diagnostics: Diagnostic[] } {
  const stmts: IniStmt[] = [];
  const diagnostics: Diagnostic[] = [];
  const lines = ctx?.lines;
  const report = (offset: number, length: number, severity: 'error' | 'warning' | 'info', code: string, type: string, message: string, extra: { suggestion?: string; fix?: { title: string; offset: number; length: number; text: string }; related?: { offset: number; message: string } } = {}) => {
    if (!lines || diagnostics.length > 300) return;
    diagnostics.push(diagAt(lines, offset, length, { severity, code, type, message, source: SOURCE, suggestion: extra.suggestion, fix: extra.fix ? { title: extra.fix.title, edits: [{ offset: extra.fix.offset, length: extra.fix.length, text: extra.fix.text }] } : undefined, related: extra.related && lines ? [relatedAt(lines, extra.related.offset, extra.related.message)] : undefined }));
  };
  const sections = new Map<string, number>();
  let keys = new Map<string, number>();
  let offset = 0;
  const physical = text.split(/(\r\n|\r|\n)/);
  for (let i = 0; i < physical.length; i += 2) {
    const raw = physical[i];
    const lineOffset = offset;
    offset += raw.length + (physical[i + 1]?.length ?? 0);
    const t = raw.trim();
    const lead = raw.length - raw.trimStart().length;
    if (!t) {
      stmts.push({ k: 'blank' });
      continue;
    }
    if (t.startsWith(';') || t.startsWith('#')) {
      stmts.push({ k: 'comment', text: t });
      continue;
    }
    if (t.startsWith('[')) {
      const close = t.indexOf(']');
      if (close === -1) {
        report(lineOffset + lead, t.length, 'error', 'ini/unclosed-section', 'Unclosed section header', `Section header "${t}" is missing its closing ']'.`, {
          fix: { title: "Insert ']'", offset: lineOffset + raw.trimEnd().length, length: 0, text: ']' },
        });
        stmts.push({ k: 'section', name: t.slice(1).trim(), offset: lineOffset + lead });
        keys = new Map();
        continue;
      }
      const name = t.slice(1, close).trim();
      const rest = t.slice(close + 1).trim();
      let comment: string | undefined;
      if (rest) {
        if (rest.startsWith(';') || rest.startsWith('#')) comment = rest;
        else report(lineOffset + lead + close + 1, rest.length, 'error', 'ini/text-after-section', 'Unexpected text', `Unexpected text after section header [${name}].`);
      }
      if (!name) report(lineOffset + lead, close + 1, 'error', 'ini/empty-section', 'Empty section name', 'Section name is empty.');
      const prev = sections.get(name.toLowerCase());
      if (prev !== undefined) {
        report(lineOffset + lead, close + 1, 'warning', 'ini/duplicate-section', 'Duplicate section', `Section [${name}] appears more than once; most parsers merge the sections or keep only the last one.`, { related: { offset: prev, message: 'First definition' } });
      } else sections.set(name.toLowerCase(), lineOffset + lead);
      stmts.push({ k: 'section', name, comment, offset: lineOffset + lead });
      keys = new Map();
      continue;
    }
    const eq = t.indexOf('=');
    const colon = t.indexOf(':');
    const sepIdx = eq !== -1 && (colon === -1 || eq < colon) ? eq : colon;
    if (sepIdx === -1) {
      const prev = stmts[stmts.length - 1];
      if (lead > 0 && prev && prev.k === 'kv') {
        prev.continuation.push(t);
        continue;
      }
      if (/\s/.test(t)) {
        report(lineOffset + lead, t.length, 'error', 'ini/invalid-line', 'Invalid line', `"${t.length > 40 ? t.slice(0, 40) + '…' : t}" is not a section, key = value pair or comment.`, {
          suggestion: 'Use key = value, [section] or start the line with ; or # to make it a comment.',
          fix: { title: 'Turn into a comment', offset: lineOffset + lead, length: 0, text: '; ' },
        });
        stmts.push({ k: 'comment', text: '; ' + t });
        continue;
      }
      report(lineOffset + lead, t.length, 'info', 'ini/flag-key', 'Key without value', `Key "${t}" has no value (supported by some parsers, e.g. MySQL option files).`);
      stmts.push({ k: 'kv', key: t, sep: '=', value: '', offset: lineOffset + lead, continuation: [], flag: true });
      continue;
    }
    const key = t.slice(0, sepIdx).trim();
    const { value, comment } = splitInlineComment(t.slice(sepIdx + 1));
    if (!key) {
      report(lineOffset + lead, 1, 'error', 'ini/missing-key', 'Missing key', 'Line has a value but no key name.');
      continue;
    }
    if ((value.startsWith('"') && !value.endsWith('"')) || (value.startsWith("'") && !value.endsWith("'")) || value === '"' || value === "'") {
      report(lineOffset + lead + sepIdx + 1, Math.max(1, t.length - sepIdx - 1), 'error', 'ini/unterminated-quote', 'Unterminated quote', `Quoted value of "${key}" is missing its closing quote.`);
    }
    const prevKey = keys.get(key.toLowerCase());
    if (prevKey !== undefined && !key.endsWith('[]')) {
      report(lineOffset + lead, key.length, 'warning', 'ini/duplicate-key', 'Duplicate key', `Key "${key}" is defined more than once in this section; the last value usually wins.`, { related: { offset: prevKey, message: 'First definition' } });
    } else keys.set(key.toLowerCase(), lineOffset + lead);
    stmts.push({ k: 'kv', key, sep: t[sepIdx] as '=' | ':', value, comment, offset: lineOffset + lead, continuation: [], flag: false });
  }
  return { stmts, diagnostics };
}

function printIni(stmts: IniStmt[], minify: boolean): string {
  const out: string[] = [];
  for (const s of stmts) {
    switch (s.k) {
      case 'blank':
        if (!minify && out.length && out[out.length - 1] !== '') out.push('');
        break;
      case 'comment':
        if (!minify) out.push(s.text);
        break;
      case 'section': {
        if (!minify) {
          let k = out.length;
          while (k > 0 && /^[;#]/.test(out[k - 1])) k--;
          if (k > 0 && out[k - 1] !== '') out.splice(k, 0, '');
        }
        out.push(`[${s.name}]${s.comment && !minify ? ' ' + s.comment : ''}`);
        break;
      }
      case 'kv': {
        if (s.flag) out.push(s.key);
        else {
          const sep = minify ? s.sep : ` ${s.sep} `;
          const line = s.value === '' && !minify ? `${s.key} ${s.sep}` : `${s.key}${sep}${s.value}`;
          out.push(line + (s.comment && !minify ? ' ' + s.comment : ''));
        }
        for (const c of s.continuation) out.push('    ' + c);
        break;
      }
    }
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  while (out.length && out[0] === '') out.shift();
  return out.join('\n');
}

function iniToData(stmts: IniStmt[], infer: boolean): { data: DataObject; comments: number } {
  const root: DataObject = new Map();
  let cur: DataObject = root;
  let comments = 0;
  const conv = (v: string): DataValue => {
    const u = unquoteIni(v);
    return infer && u === v ? inferScalar(u) : u;
  };
  for (const s of stmts) {
    if (s.k === 'comment') comments++;
    if (s.k === 'section') {
      const existing = root.get(s.name);
      if (existing instanceof Map) cur = existing;
      else {
        cur = new Map();
        root.set(s.name, cur);
      }
      if (s.comment) comments++;
    }
    if (s.k === 'kv') {
      if (s.comment) comments++;
      const value = s.continuation.length ? [s.value, ...s.continuation].join('\n') : s.value;
      if (s.key.endsWith('[]')) {
        const k = s.key.slice(0, -2);
        const arr = cur.get(k);
        if (Array.isArray(arr)) arr.push(conv(value));
        else cur.set(k, [conv(value)]);
      } else cur.set(s.key, s.flag ? true : conv(value));
    }
  }
  return { data: root, comments };
}

function iniValue(v: DataValue): string {
  if (v === null) return '';
  if (v instanceof DataDate) return v.iso;
  if (v instanceof Uint8Array) return toBase64(v);
  const s = String(v);
  return /^\s|\s$|[;#"]|^$/.test(s) && s !== '' ? `"${s.replace(/"/g, '\\"')}"` : s;
}

function dataToIni(data: DataValue): { text: string; warnings: Diagnostic[] } {
  const warnings: Diagnostic[] = [];
  const seen = new Set<string>();
  const warn = (code: string, type: string, message: string, path: PathSegment[]) => {
    if (seen.has(code)) return;
    seen.add(code);
    warnings.push(notice({ code, type, message, source: 'INI writer', path: pathToString(path) }));
  };
  const root: DataObject = data instanceof Map ? data : new Map([['value', data]]);
  if (!(data instanceof Map)) warn('convert/root-wrapped', 'Root wrapped', 'INI files need key/value pairs at the root; the value was stored under "value".', []);
  const globals: string[] = [];
  const sections: string[][] = [];
  const writeEntries = (obj: DataObject, out: string[], path: string[]) => {
    const nested: [string, DataObject][] = [];
    for (const [k, v] of obj) {
      if (v instanceof Map) nested.push([k, v]);
      else if (Array.isArray(v)) {
        if (v.some((x) => x instanceof Map || Array.isArray(x))) {
          warn('convert/complex-array', 'Complex arrays', 'Arrays of objects have no INI equivalent and were written as JSON text.', [...path, k]);
          out.push(`${k} = ${iniValue(JSON.stringify(v.map((x) => (x instanceof Map ? Object.fromEntries(x) : x))))}`);
        } else {
          warn('convert/array-syntax', 'Arrays', 'Arrays are written with the key[] = value convention (PHP / Node "ini"), which not every parser supports.', [...path, k]);
          for (const x of v) out.push(`${k}[] = ${iniValue(x)}`);
        }
      } else {
        if (v === null) warn('convert/null-as-empty', 'null values', 'null values are written as empty values.', [...path, k]);
        out.push(`${k} = ${iniValue(v)}`);
      }
    }
    for (const [k, v] of nested) {
      if (path.length >= 1) warn('convert/deep-nesting', 'Deep nesting', 'INI supports one level of sections; deeper objects use dotted section names like [parent.child].', [...path, k]);
      const lines: string[] = [];
      sections.push([`[${[...path, k].join('.')}]`, ...lines]);
      const idx = sections.length - 1;
      writeEntries(v, sections[idx], [...path, k]);
    }
  };
  writeEntries(root, globals, []);
  const blocks = [globals.join('\n'), ...sections.map((s) => s.join('\n'))].filter(Boolean);
  warnings.push(notice({ severity: 'info', code: 'convert/types-to-text', type: 'Types become text', message: 'INI has no data types: numbers and booleans are written as text.', source: 'INI writer' }));
  return { text: blocks.join('\n\n'), warnings };
}

function detectIni(ctx: DetectContext): DetectScore | null {
  const comment = /^\s*[;#]/;
  const sections = lineRatio(ctx.lines, /^\s*\[[^\]]+\]\s*([;#].*)?$/, comment);
  const kv = lineRatio(ctx.lines, /^\s*[^=:\s[][^=:]*?\s*[=:]/, comment);
  const semi = lineRatio(ctx.lines, /^\s*;/).count;
  const quotedValues = lineRatio(ctx.lines, /=\s*(["'[{]|true\b|false\b|\d)/, comment).count;
  if (kv.count === 0 || sections.ratio + kv.ratio < 0.75) return null;
  const reasons: string[] = [];
  let score = 0.3;
  if (sections.count) {
    score += 0.3;
    reasons.push('[section] headers');
  }
  if (semi) {
    score += 0.15;
    reasons.push('; comments');
  }
  const bareValues = kv.count - quotedValues;
  if (bareValues > 0) {
    score += Math.min(0.15, (bareValues / kv.count) * 0.2);
    reasons.push('Unquoted values');
  }
  if (!sections.count) score -= 0.2;
  return { score: Math.min(0.9, score), reasons };
}

export const iniModule: FormatModule = {
  descriptor: DESCRIPTORS.ini,
  sample: SAMPLES.ini,
  detect: detectIni,
  detectBoost: 0.35,
  validate(input, ctx) {
    const { stmts, diagnostics } = parseIni(input, ctx);
    const sections = stmts.filter((s) => s.k === 'section').length;
    const keys = stmts.filter((s) => s.k === 'kv').length;
    return { diagnostics, facts: { Sections: sections, Keys: keys, Comments: stmts.filter((s) => s.k === 'comment').length } };
  },
  beautify(input) {
    return { text: printIni(parseIni(input, null).stmts, false) };
  },
  minify(input) {
    return { text: printIni(parseIni(input, null).stmts, true) };
  },
  verifyTransform(original, output) {
    const a = iniToData(parseIni(original, null).stmts, false).data;
    const b = iniToData(parseIni(output, null).stmts, false).data;
    return JSON.stringify([...flat(a)]) === JSON.stringify([...flat(b)]) ? null : 'Formatting would change the INI data; the output was discarded.';
  },
  toData(input, ctx) {
    const { data, comments } = iniToData(parseIni(input, null).stmts, ctx.options.inferTypes);
    const warnings: Diagnostic[] = [];
    if (comments) warnings.push(notice({ code: 'convert/comments-dropped', type: 'Comments not preserved', message: `${comments} comment(s) were dropped.`, source: 'INI' }));
    if (ctx.options.inferTypes) warnings.push(notice({ severity: 'info', code: 'convert/inferred-types', type: 'Types inferred', message: 'INI values are text: numbers and booleans were inferred where the text round-trips exactly.', source: 'INI' }));
    return { data, warnings };
  },
  fromData(data) {
    return dataToIni(data);
  },
};

function* flat(m: DataObject, prefix = ''): Generator<[string, string]> {
  for (const [k, v] of m) {
    if (v instanceof Map) yield* flat(v, `${prefix}${k}.`);
    else yield [`${prefix}${k}`, JSON.stringify(v instanceof Map ? null : v)];
  }
}
