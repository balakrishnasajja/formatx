import { parse, TomlDate, TomlError } from 'smol-toml';
import { DESCRIPTORS } from '../../engines/catalog';
import { jsToData, pathToString, type PathSegment } from '../../engines/converters/dataModel';
import { DataDate, type DataObject, type DataValue } from '../../types/data';
import type { Diagnostic } from '../../types/diagnostics';
import type { DetectContext, DetectScore, FormatModule } from '../../types/module';
import { indentUnit } from '../../types/options';
import { toBase64 } from '../../utils/bytes';
import { diagAtLineCol, notice } from '../../utils/diag';
import { lineRatio } from '../../engines/detection/context';
import { SAMPLES } from '../samples';
import { formatToml } from './tomlFormat';

const SOURCE = 'smol-toml';

function parseToml(input: string) {
  return parse(input, { integersAsBigInt: 'asNeeded' });
}

function tomlDateToData(d: TomlDate): DataDate {
  const kind = d.isDate() ? 'local-date' : d.isTime() ? 'local-time' : d.isLocal() ? 'local-datetime' : 'offset-datetime';
  return new DataDate(d.toISOString(), kind);
}

function convertTomlValue(v: unknown): unknown {
  if (v instanceof TomlDate) return tomlDateToData(v);
  if (Array.isArray(v)) return v.map(convertTomlValue);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v)) Object.defineProperty(out, k, { value: convertTomlValue((v as Record<string, unknown>)[k]), enumerable: true, writable: true, configurable: true });
    return out;
  }
  return v;
}

/** Data equality used to verify formatting (dates compared by their TOML text). */
function sameToml(a: unknown, b: unknown): boolean {
  if (a instanceof TomlDate || b instanceof TomlDate) return a instanceof TomlDate && b instanceof TomlDate && a.toISOString() === b.toISOString();
  if (typeof a === 'number' && typeof b === 'number') return Object.is(a, b) || a === b;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameToml((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function countTables(v: unknown, s = { tables: 0, keys: 0, arrayTables: 0, depth: 0 }, depth = 0) {
  if (v && typeof v === 'object' && !(v instanceof TomlDate)) {
    s.depth = Math.max(s.depth, depth);
    if (Array.isArray(v)) {
      if (v.length && v.every((x) => x && typeof x === 'object' && !Array.isArray(x) && !(x instanceof TomlDate))) s.arrayTables++;
      v.forEach((x) => countTables(x, s, depth + 1));
    } else {
      if (depth > 0) s.tables++;
      for (const k of Object.keys(v)) {
        s.keys++;
        countTables((v as Record<string, unknown>)[k], s, depth + 1);
      }
    }
  }
  return s;
}

function detectToml(ctx: DetectContext): DetectScore | null {
  const comment = /^\s*#/;
  const kv = lineRatio(ctx.lines, /^\s*(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*'))*\s*=\s*\S/, comment);
  const typed = lineRatio(ctx.lines, /=\s*(?:"|'|\[|\{|true\b|false\b|[+-]?(?:\d|inf\b|nan\b)|\d{4}-\d{2}-\d{2})/, comment);
  const tables = lineRatio(ctx.lines, /^\s*\[[^[\]]+\]\s*(#.*)?$/, comment);
  const arrayTables = lineRatio(ctx.lines, /^\s*\[\[[^[\]]+\]\]\s*(#.*)?$/, comment);
  const semicolonComments = lineRatio(ctx.lines, /^\s*;/);
  const reasons: string[] = [];
  const structured = kv.ratio + tables.ratio + arrayTables.ratio;
  if (structured < 0.5 || kv.count === 0) return arrayTables.count ? { score: 0.4, reasons: ['[[array of tables]] headers'] } : null;
  let score = 0.35 + structured * 0.2;
  if (kv.count) {
    const typedShare = typed.count / kv.count;
    score += typedShare * 0.3;
    if (typedShare > 0.7) reasons.push('Values are typed (quoted strings, numbers, booleans, arrays)');
    else score -= 0.15;
  }
  if (arrayTables.count) {
    score += 0.15;
    reasons.push('[[array of tables]] headers');
  }
  if (tables.count) reasons.push('[table] headers');
  if (semicolonComments.count) score -= 0.25;
  return { score: Math.max(0, Math.min(0.95, score)), reasons };
}

// ------------------------------------------------------------------ writer

const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

function tomlKey(k: string): string {
  return BARE_KEY.test(k) ? k : tomlString(k);
}

function tomlString(s: string): string {
  return JSON.stringify(s).replace(/\u{7f}/gu, '\\u007f');
}

export function dataToToml(data: DataValue, indent: string): { text: string; warnings: Diagnostic[] } {
  const warnings: Diagnostic[] = [];
  const seen = new Set<string>();
  const nullPaths: string[] = [];
  const warn = (code: string, type: string, message: string, path: PathSegment[]) => {
    if (seen.has(code)) return;
    seen.add(code);
    warnings.push(notice({ code, type, message, source: 'TOML writer', path: pathToString(path) }));
  };
  void indent;

  let root: DataObject;
  if (data instanceof Map) root = data;
  else if (Array.isArray(data)) {
    root = new Map([['items', data]]);
    warnings.push(notice({ code: 'convert/root-wrapped', type: 'Root wrapped', message: 'A TOML document must be a table at the root, so the array was stored under the key "items".', source: 'TOML writer' }));
  } else {
    root = new Map([['value', data]]);
    warnings.push(notice({ code: 'convert/root-wrapped', type: 'Root wrapped', message: 'A TOML document must be a table at the root, so the value was stored under the key "value".', source: 'TOML writer' }));
  }

  const isTable = (v: DataValue): v is DataObject => v instanceof Map;
  const isArrayOfTables = (v: DataValue): v is DataObject[] => Array.isArray(v) && v.length > 0 && v.every((x) => x instanceof Map);

  const value = (v: DataValue, path: PathSegment[]): string | null => {
    if (v === null) {
      if (nullPaths.length < 5) nullPaths.push(pathToString(path));
      return null;
    }
    switch (typeof v) {
      case 'string':
        return tomlString(v);
      case 'boolean':
        return String(v);
      case 'bigint':
        if (v < INT64_MIN || v > INT64_MAX) {
          warn('convert/int-out-of-range', 'Integer out of range', 'TOML integers are 64-bit; larger values were written as strings.', path);
          return tomlString(v.toString());
        }
        return v.toString();
      case 'number':
        if (Number.isNaN(v)) return 'nan';
        if (!Number.isFinite(v)) return v > 0 ? 'inf' : '-inf';
        if (Number.isInteger(v)) {
          if (Math.abs(v) < 2 ** 63) return BigInt(v).toString();
          const s = String(v);
          return /[.eE]/.test(s) ? s : s + '.0';
        }
        return String(v);
    }
    if (v instanceof DataDate) return v.iso;
    if (v instanceof Uint8Array) {
      warn('convert/binary-as-base64', 'Type changed', 'TOML has no binary type: binary data was written as a base64 string.', path);
      return tomlString(toBase64(v));
    }
    if (Array.isArray(v)) {
      const items: string[] = [];
      v.forEach((x, i) => {
        const s = value(x, [...path, i]);
        if (s !== null) items.push(s);
      });
      return `[${items.join(', ')}]`;
    }
    const entries: string[] = [];
    for (const [k, x] of v) {
      const s = value(x, [...path, k]);
      if (s !== null) entries.push(`${tomlKey(k)} = ${s}`);
    }
    return entries.length ? `{ ${entries.join(', ')} }` : '{}';
  };

  const blocks: string[] = [];
  const emitTable = (path: string[], obj: DataObject, arrayTable: boolean) => {
    const simple: string[] = [];
    const subTables: [string, DataObject][] = [];
    const arrayTables: [string, DataObject[]][] = [];
    for (const [k, v] of obj) {
      if (isTable(v)) subTables.push([k, v]);
      else if (isArrayOfTables(v)) arrayTables.push([k, v]);
      else {
        const s = value(v, [...path, k]);
        if (s !== null) simple.push(`${tomlKey(k)} = ${s}`);
      }
    }
    const header = path.map(tomlKey).join('.');
    const needsHeader = path.length > 0 && (arrayTable || simple.length > 0 || (subTables.length === 0 && arrayTables.length === 0));
    if (needsHeader || simple.length) {
      const lines: string[] = [];
      if (needsHeader) lines.push(arrayTable ? `[[${header}]]` : `[${header}]`);
      lines.push(...simple);
      blocks.push(lines.join('\n'));
    }
    for (const [k, t] of subTables) emitTable([...path, k], t, false);
    for (const [k, arr] of arrayTables) for (const t of arr) emitTable([...path, k], t, true);
  };
  emitTable([], root, false);
  if (nullPaths.length) {
    warnings.push(notice({ code: 'convert/null-dropped', type: 'null values dropped', message: `TOML has no null value; null entries were omitted (e.g. ${nullPaths.join(', ')}).`, source: 'TOML writer' }));
  }
  return { text: blocks.join('\n\n'), warnings };
}

export const tomlModule: FormatModule = {
  descriptor: DESCRIPTORS.toml,
  sample: SAMPLES.toml,
  detect: detectToml,
  validate(input, ctx) {
    try {
      const data = parseToml(input);
      const s = countTables(data);
      return { diagnostics: [], facts: { Keys: s.keys, Tables: s.tables, 'Arrays of tables': s.arrayTables, 'Max depth': s.depth } };
    } catch (e) {
      if (e instanceof TomlError) {
        const msg = e.message.replace(/^Invalid TOML document:\s*/, '').split('\n')[0];
        const suggestion = /redefine/.test(msg)
          ? 'Each key and table may be defined only once.'
          : /invalid value|unexpected/i.test(msg)
            ? 'String values must be quoted ("..." or \'...\'); numbers, booleans, dates, arrays and inline tables are written bare.'
            : undefined;
        return {
          diagnostics: [diagAtLineCol(ctx.lines, e.line, e.column, { code: 'toml/parse-error', type: 'Syntax error', message: msg.charAt(0).toUpperCase() + msg.slice(1), suggestion, source: SOURCE })],
        };
      }
      throw e;
    }
  },
  beautify(input, ctx) {
    const r = formatToml(input, { indent: indentUnit(ctx.options.indent), printWidth: ctx.options.printWidth, minify: false });
    return { text: r.text, notes: r.comments ? [`${r.comments} comment(s) preserved.`] : [] };
  },
  minify(input, ctx) {
    const r = formatToml(input, { indent: '', printWidth: Infinity, minify: true });
    void ctx;
    const warnings: Diagnostic[] = r.comments ? [notice({ severity: 'info', code: 'toml/minify-removed-comments', type: 'Comments removed', message: `${r.comments} comment(s) were removed.`, source: 'TOML minifier' })] : [];
    return { text: r.text, warnings, notes: ['TOML requires a line break between key/value pairs, so minified TOML keeps one statement per line.'] };
  },
  verifyTransform(original, output) {
    try {
      return sameToml(parseToml(original), parseToml(output)) ? null : 'Formatting would change the TOML data; the output was discarded to protect your data.';
    } catch {
      return 'The formatted TOML did not re-parse; the output was discarded.';
    }
  },
  toData(input) {
    const parsed = convertTomlValue(parseToml(input));
    const warnings: Diagnostic[] = [];
    if (/(^|[^"'\\])#/m.test(input)) {
      warnings.push(notice({ code: 'convert/comments-dropped', type: 'Comments not preserved', message: 'TOML comments cannot be carried over to the converted data.', source: 'TOML' }));
    }
    const data = jsToData(parsed);
    let dates = 0;
    const walk = (v: DataValue) => {
      if (v instanceof DataDate) dates++;
      else if (v instanceof Map) v.forEach(walk);
      else if (Array.isArray(v)) v.forEach(walk);
    };
    walk(data);
    if (dates) warnings.push(notice({ severity: 'info', code: 'convert/dates', type: 'Date/time values', message: `${dates} date/time value(s): formats without a date type will store them as ISO 8601 strings.`, source: 'TOML' }));
    return { data, warnings };
  },
  fromData(data, ctx) {
    const r = dataToToml(data, indentUnit(ctx.options.indent));
    return { text: r.text, warnings: r.warnings };
  },
};
