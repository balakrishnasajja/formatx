import { DESCRIPTORS } from '../../engines/catalog';
import { flatten, inferScalar, unflatten } from '../../engines/converters/dataModel';
import { DataDate, type DataObject, type DataValue } from '../../types/data';
import type { Diagnostic } from '../../types/diagnostics';
import type { FormatId } from '../../types/formats';
import type { DetectContext, DetectScore, FormatModule, ModuleContext } from '../../types/module';
import { toBase64 } from '../../utils/bytes';
import { diagAt, notice } from '../../utils/diag';
import { lineRatio } from '../../engines/detection/context';
import { SAMPLES } from '../samples';
import { delimiterName, detectDelimiter, parseDelimited, quoteField, type CsvParseResult } from './csvParser';

type Variant = 'csv' | 'tsv';

function inputDelimiter(variant: Variant, input: string, ctx: ModuleContext): string {
  if (variant === 'tsv') return '\t';
  const opt = ctx.options.csvDelimiter;
  if (opt !== 'auto') return opt;
  return detectDelimiter(input).delimiter;
}

function analyzeRows(variant: Variant, input: string, ctx: ModuleContext): { parsed: CsvParseResult; delimiter: string; diagnostics: Diagnostic[] } {
  const delimiter = inputDelimiter(variant, input, ctx);
  const source = variant === 'tsv' ? 'TSV parser' : 'CSV parser';
  const parsed = parseDelimited(input, delimiter, ctx.lines, source);
  const diagnostics = [...parsed.diagnostics];
  const rows = parsed.rows;
  if (rows.length) {
    const expected = rows[0].fields.length;
    const header = ctx.options.csvHasHeader;
    let mismatches = 0;
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const n = row.fields.length;
      if (n === expected) continue;
      if (++mismatches > 200) break;
      const line = ctx.lines.positionAt(row.start).line;
      const basis = header ? 'the header row' : 'the first row';
      if (n > expected) {
        const extra = row.fields[expected];
        diagnostics.push(
          diagAt(ctx.lines, Math.max(row.start, extra.start - 1), Math.max(1, row.fields[n - 1].end - extra.start + 1), {
            code: 'csv/too-many-fields',
            type: 'Too many fields',
            message: `Row ${r + 1} (line ${line}) has ${n} fields, but ${basis} has ${expected}.`,
            suggestion: `Values that contain a ${delimiterName(delimiter)} must be wrapped in double quotes.`,
            source,
          }),
        );
      } else {
        const last = row.fields[n - 1];
        diagnostics.push(
          diagAt(ctx.lines, last.end, 0, {
            code: 'csv/too-few-fields',
            type: 'Too few fields',
            message: `Row ${r + 1} (line ${line}) has ${n} field${n === 1 ? '' : 's'}, but ${basis} has ${expected}.`,
            suggestion: `Add the ${expected - n} missing value(s) — empty values still need their ${delimiterName(delimiter)}.`,
            source,
            fix: { title: `Append ${expected - n} empty field(s)`, edits: [{ offset: last.end, length: 0, text: delimiter.repeat(expected - n) }] },
          }),
        );
      }
    }
    if (header) {
      const seen = new Map<string, number>();
      rows[0].fields.forEach((f, idx) => {
        const name = f.value.trim();
        if (!name) {
          diagnostics.push(diagAt(ctx.lines, f.start, Math.max(1, f.end - f.start), { severity: 'warning', code: 'csv/empty-header', type: 'Empty column name', message: `Column ${idx + 1} has an empty header.`, source }));
        } else if (seen.has(name)) {
          diagnostics.push(diagAt(ctx.lines, f.start, f.end - f.start, { severity: 'warning', code: 'csv/duplicate-header', type: 'Duplicate column name', message: `Column name "${name}" is used more than once (columns ${seen.get(name)! + 1} and ${idx + 1}).`, source }));
        } else seen.set(name, idx);
      });
    }
  }
  if (parsed.emptyLines > 0 && rows.length > 0) {
    diagnostics.push({
      severity: 'info',
      code: 'csv/empty-lines',
      type: 'Empty lines',
      message: `${parsed.emptyLines} empty line(s) were ignored.`,
      source,
    });
  }
  return { parsed, delimiter, diagnostics };
}

function serialize(rows: string[][], delimiter: string, eol: string): string {
  return rows.map((r) => r.map((v) => quoteField(v, delimiter)).join(delimiter)).join(eol);
}

function cellText(v: DataValue): string {
  if (v === null) return '';
  if (typeof v === 'string') return v;
  if (v instanceof DataDate) return v.iso;
  if (v instanceof Uint8Array) return toBase64(v);
  if (v instanceof Map || Array.isArray(v)) return JSON.stringify(v instanceof Map ? Object.fromEntries(v) : v);
  return String(v);
}

function detectFor(variant: Variant, ctx: DetectContext): DetectScore | null {
  if (ctx.lines.length < 2) return null;
  const t = ctx.trimmed;
  if (t[0] === '{' || t[0] === '[' || t[0] === '<') return null;
  const det = detectDelimiter(ctx.head);
  if (det.columns < 2 || det.consistency < 0.6) return null;
  if (variant === 'tsv' ? det.delimiter !== '\t' : det.delimiter === '\t') return null;
  const reasons = [`${det.columns} columns separated by ${delimiterName(det.delimiter)} on ${Math.round(det.consistency * 100)}% of rows`];
  let score = 0.3 + det.consistency * 0.45 + Math.min(det.rows, 10) * 0.015;
  const comment = /^\s*(#|\/\/|--)/;
  const kv = lineRatio(ctx.lines, /^\s*[\w.-]+\s*[=:]\s*\S/, comment).ratio;
  const md = lineRatio(ctx.lines, /^\s*\|.*\|\s*$/).ratio;
  const code = lineRatio(ctx.lines, /[{};]\s*$|^\s*(SELECT|INSERT|UPDATE|CREATE|import|const|function|def|class)\b/i).ratio;
  const prose = ctx.lines.filter((l) => l.split(/\s+/).length > 12).length / ctx.lines.length;
  score -= kv * 0.5 + md * 0.8 + code * 0.6 + prose * 0.3;
  if (det.delimiter === ';' && code > 0.2) score -= 0.3;
  if (ctx.extension === variant) score += 0.1;
  return score > 0.2 ? { score: Math.min(0.95, score), reasons } : null;
}

function createDelimitedModule(variant: Variant): FormatModule {
  const id: FormatId = variant;
  return {
    descriptor: DESCRIPTORS[id],
    sample: SAMPLES[id],
    ownsLineEndings: true,
    detect: (ctx) => detectFor(variant, ctx),
    detectBoost: 0.35,
    validate(input, ctx) {
      const { parsed, delimiter, diagnostics } = analyzeRows(variant, input, ctx);
      const rows = parsed.rows;
      const columns = rows[0]?.fields.length ?? 0;
      const facts: Record<string, string | number> = {
        Delimiter: delimiterName(delimiter),
        Rows: Math.max(0, rows.length - (ctx.options.csvHasHeader ? 1 : 0)),
        Columns: columns,
        Header: ctx.options.csvHasHeader ? 'yes' : 'no',
      };
      if (parsed.bom) facts.BOM = 'UTF-8 BOM';
      return { diagnostics, facts };
    },
    beautify(input, ctx) {
      const { parsed, delimiter } = analyzeRows(variant, input, ctx);
      const rows = parsed.rows.map((r) => r.fields.map((f) => f.value));
      const notes = ['Quoting normalized (only where required) — values are never trimmed or padded.'];
      if (parsed.emptyLines) notes.push(`${parsed.emptyLines} empty line(s) removed.`);
      return { text: serialize(rows, delimiter, ctx.eol ?? '\n'), notes };
    },
    minify(input, ctx) {
      const { parsed, delimiter } = analyzeRows(variant, input, ctx);
      const rows = parsed.rows.map((r) => r.fields.map((f) => f.value));
      return { text: serialize(rows, delimiter, ctx.eol ?? '\n'), notes: ['Delimited text has no insignificant whitespace; minify normalizes quoting and removes empty lines.'] };
    },
    verifyTransform(original, output, ctx) {
      const delimiter = inputDelimiter(variant, original, ctx);
      const a = parseDelimited(original, delimiter, null).rows.map((r) => r.fields.map((f) => f.value));
      const b = parseDelimited(output, delimiter, null).rows.map((r) => r.fields.map((f) => f.value));
      return JSON.stringify(a) === JSON.stringify(b) ? null : 'Normalizing would change cell values; the output was discarded to protect your data.';
    },
    toData(input, ctx) {
      const { parsed } = analyzeRows(variant, input, ctx);
      const warnings: Diagnostic[] = [];
      const infer = (s: string): DataValue => (ctx.options.inferTypes ? inferScalar(s) : s);
      const rows = parsed.rows.map((r) => r.fields.map((f) => f.value));
      if (!ctx.options.csvHasHeader) return { data: rows.map((r) => r.map(infer)), warnings };
      const [header = [], ...body] = rows;
      const keys: string[] = [];
      const used = new Map<string, number>();
      header.forEach((h, i) => {
        let k = h.trim() || `column_${i + 1}`;
        const n = used.get(k) ?? 0;
        used.set(k, n + 1);
        if (n > 0) k = `${k}_${n + 1}`;
        keys.push(k);
      });
      if ([...used.values()].some((n) => n > 1)) warnings.push(notice({ code: 'convert/duplicate-columns', type: 'Duplicate columns', message: 'Duplicate column names were made unique with a numeric suffix (name_2, name_3...).', source: 'CSV' }));
      let conflicts = 0;
      const data: DataValue[] = body.map((r) => {
        const m: DataObject = new Map();
        keys.forEach((k, i) => m.set(k, infer(r[i] ?? '')));
        if (ctx.options.expandDottedKeys && keys.some((k) => k.includes('.'))) {
          const u = unflatten(m);
          conflicts += u.conflicts.length;
          return u.value;
        }
        return m;
      });
      if (conflicts) warnings.push(notice({ code: 'convert/key-conflicts', type: 'Key conflicts', message: 'Some dotted column names conflict with other columns and were kept flat.', source: 'CSV' }));
      if (ctx.options.inferTypes) warnings.push(notice({ severity: 'info', code: 'convert/inferred-types', type: 'Types inferred', message: 'Numbers and booleans were inferred only where the text round-trips exactly ("007" and "1.50" stay strings).', source: 'CSV' }));
      return { data, warnings };
    },
    fromData(data, ctx) {
      const delimiter = variant === 'tsv' ? '\t' : ctx.options.csvOutputDelimiter;
      const warnings: Diagnostic[] = [];
      let records: DataValue[];
      if (Array.isArray(data)) records = data;
      else if (data instanceof Map) {
        const vals = [...data.values()];
        if (vals.length && vals.every((v) => Array.isArray(v)) && data.size === 1) {
          records = vals[0] as DataValue[];
          warnings.push(notice({ severity: 'info', code: 'convert/unwrapped', type: 'Array unwrapped', message: `The array under "${[...data.keys()][0]}" was used as the rows.`, source: 'CSV writer' }));
        } else records = [data];
      } else records = [data];

      const rows: string[][] = [];
      let nested = false;
      let nulls = 0;
      let formulas = 0;
      const countCell = (v: DataValue) => {
        if (v === null) nulls++;
        if (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) && !/^-?\d/.test(v)) formulas++;
      };
      if (records.every((r) => r instanceof Map)) {
        const columns: string[] = [];
        const colSet = new Set<string>();
        const flat = records.map((r) => {
          const f = flatten(r, { separator: '.' });
          if (f.flattenedPaths > 0) nested = true;
          for (const k of f.entries.keys()) if (!colSet.has(k)) {
            colSet.add(k);
            columns.push(k);
          }
          return f.entries;
        });
        let sparse = 0;
        rows.push(columns);
        for (const f of flat) {
          if (f.size < columns.length) sparse++;
          rows.push(columns.map((c) => {
            const v = f.has(c) ? (f.get(c) as DataValue) : null;
            countCell(v);
            return cellText(v);
          }));
        }
        if (sparse) warnings.push(notice({ code: 'convert/sparse-rows', type: 'Missing values', message: `${sparse} row(s) do not have every column; missing values were left empty.`, source: 'CSV writer' }));
      } else if (records.every((r) => Array.isArray(r))) {
        for (const r of records as DataValue[][]) {
          rows.push(r.map((v) => {
            if (v instanceof Map || Array.isArray(v)) nested = true;
            countCell(v);
            return cellText(v);
          }));
        }
      } else {
        rows.push(['value']);
        for (const r of records) {
          if (r instanceof Map || Array.isArray(r)) nested = true;
          countCell(r);
          rows.push([cellText(r)]);
        }
      }
      if (nested) warnings.push(notice({ code: 'convert/flattened', type: 'Nested data flattened', message: 'Nested objects and arrays were flattened into dotted column names (e.g. address.city, tags.0).', source: 'CSV writer' }));
      if (nulls) warnings.push(notice({ code: 'convert/null-as-empty', type: 'null values', message: `${nulls} null value(s) were written as empty cells (indistinguishable from empty strings).`, source: 'CSV writer' }));
      warnings.push(notice({ severity: 'info', code: 'convert/types-to-text', type: 'Types become text', message: 'CSV has no data types: numbers and booleans are written as text.', source: 'CSV writer' }));
      if (formulas) warnings.push(notice({ severity: 'info', code: 'convert/formula-injection', type: 'Possible spreadsheet formulas', message: `${formulas} value(s) start with =, +, - or @ and may be interpreted as formulas when opened in a spreadsheet application.`, source: 'CSV writer' }));
      return { text: serialize(rows, delimiter, ctx.eol ?? '\n'), warnings };
    },
  };
}

export const csvModule = createDelimitedModule('csv');
export const tsvModule = createDelimitedModule('tsv');

/** Parse rows for the UI table preview (main thread safe, no diagnostics). */
export function previewRows(text: string, delimiter?: string): string[][] {
  const d = delimiter ?? detectDelimiter(text).delimiter;
  return parseDelimited(text, d, null).rows.map((r) => r.fields.map((f) => f.value));
}

