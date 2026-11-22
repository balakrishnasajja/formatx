import type { Diagnostic } from '../../types/diagnostics';
import { diagAt, relatedAt } from '../../utils/diag';
import type { LineIndex } from '../../utils/lineIndex';

export interface CsvField {
  value: string;
  start: number;
  end: number;
  quoted: boolean;
}

export interface CsvRow {
  fields: CsvField[];
  start: number;
  end: number;
}

export interface CsvParseResult {
  rows: CsvRow[];
  diagnostics: Diagnostic[];
  emptyLines: number;
  bom: boolean;
}

const MAX_DIAGS = 300;

export function delimiterName(d: string): string {
  return d === '\t' ? 'tab' : d === ',' ? 'comma' : d === ';' ? 'semicolon' : d === '|' ? 'pipe' : `'${d}'`;
}

/**
 * RFC 4180 delimited-text parser that records the exact offsets of every field,
 * so problems (column counts, quotes) are reported precisely.
 */
export function parseDelimited(text: string, delimiter: string, lines: LineIndex | null, source = 'CSV parser'): CsvParseResult {
  const rows: CsvRow[] = [];
  const diagnostics: Diagnostic[] = [];
  const len = text.length;
  const d = delimiter.charCodeAt(0);
  let i = 0;
  const bom = text.charCodeAt(0) === 0xfeff;
  if (bom) i = 1;
  let emptyLines = 0;
  const report = (offset: number, length: number, code: string, type: string, message: string, extra: { severity?: 'error' | 'warning' | 'info'; suggestion?: string; relatedOffset?: number; relatedMessage?: string; fixText?: { offset: number; length: number; text: string; title: string } } = {}) => {
    if (!lines || diagnostics.length >= MAX_DIAGS) return;
    diagnostics.push(
      diagAt(lines, offset, length, {
        severity: extra.severity ?? 'error',
        code,
        type,
        message,
        source,
        suggestion: extra.suggestion,
        related: extra.relatedOffset !== undefined ? [relatedAt(lines, extra.relatedOffset, extra.relatedMessage ?? '')] : undefined,
        fix: extra.fixText ? { title: extra.fixText.title, edits: [{ offset: extra.fixText.offset, length: extra.fixText.length, text: extra.fixText.text }] } : undefined,
      }),
    );
  };

  while (i < len) {
    const rowStart = i;
    const c0 = text.charCodeAt(i);
    if (c0 === 10 || c0 === 13) {
      // empty line
      emptyLines++;
      i += c0 === 13 && text.charCodeAt(i + 1) === 10 ? 2 : 1;
      continue;
    }
    const fields: CsvField[] = [];
    for (;;) {
      const fStart = i;
      if (text.charCodeAt(i) === 34) {
        // quoted field
        let j = i + 1;
        let value = '';
        let closed = false;
        for (;;) {
          const k = text.indexOf('"', j);
          if (k === -1) {
            value += text.slice(j);
            j = len;
            break;
          }
          if (text.charCodeAt(k + 1) === 34) {
            value += text.slice(j, k) + '"';
            j = k + 2;
            continue;
          }
          value += text.slice(j, k);
          j = k + 1;
          closed = true;
          break;
        }
        if (!closed) {
          report(fStart, 1, 'csv/unclosed-quote', 'Unclosed quote', 'Quoted field is never closed: the closing " is missing, so the rest of the file is read as one value.', {
            suggestion: 'Add the closing quote. Quotes inside a quoted value must be doubled ("").',
          });
          fields.push({ value, start: fStart, end: len, quoted: true });
          i = len;
          break;
        }
        i = j;
        // after the closing quote only a delimiter or line break may follow
        const n = text.charCodeAt(i);
        if (i < len && n !== d && n !== 10 && n !== 13) {
          let e = i;
          while (e < len && text.charCodeAt(e) !== d && text.charCodeAt(e) !== 10 && text.charCodeAt(e) !== 13) e++;
          report(i, e - i, 'csv/text-after-quote', 'Invalid quoting', `Unexpected text after the closing quote of a field. Expected a ${delimiterName(delimiter)} or line break.`, {
            suggestion: 'Inside a quoted value, write quotes as "" (two double quotes).',
            relatedOffset: fStart,
            relatedMessage: 'Quoted field starts here',
          });
          value += text.slice(i, e);
          i = e;
        }
        fields.push({ value, start: fStart, end: i, quoted: true });
      } else {
        let e = i;
        while (e < len) {
          const ch = text.charCodeAt(e);
          if (ch === d || ch === 10 || ch === 13) break;
          e++;
        }
        const value = text.slice(i, e);
        const q = value.indexOf('"');
        if (q !== -1) {
          const lead = /^\s+"/.test(value);
          report(i + q, 1, 'csv/stray-quote', 'Stray quote', lead ? 'Quote preceded by whitespace: the field is not treated as quoted, so the quotes become part of the value.' : 'Quote character inside an unquoted field (not allowed by RFC 4180).', {
            severity: 'warning',
            suggestion: lead ? `Remove the space after the ${delimiterName(delimiter)}.` : 'Wrap the whole field in quotes and double the inner quote ("").',
            fixText: lead ? { offset: i, length: value.indexOf('"'), text: '', title: 'Remove leading whitespace' } : undefined,
          });
        }
        fields.push({ value, start: i, end: e, quoted: false });
        i = e;
      }
      const ch = text.charCodeAt(i);
      if (ch === d) {
        i++;
        if (i >= len || text.charCodeAt(i) === 10 || text.charCodeAt(i) === 13) {
          fields.push({ value: '', start: i, end: i, quoted: false });
          if (i < len) i += text.charCodeAt(i) === 13 && text.charCodeAt(i + 1) === 10 ? 2 : 1;
          break;
        }
        continue;
      }
      if (ch === 13 || ch === 10) i += ch === 13 && text.charCodeAt(i + 1) === 10 ? 2 : 1;
      break;
    }
    rows.push({ fields, start: rowStart, end: i });
  }
  return { rows, diagnostics, emptyLines, bom };
}

/** Choose the delimiter that yields the most consistent column count. */
export function detectDelimiter(text: string): { delimiter: string; consistency: number; columns: number; rows: number } {
  const sample = text.length > 65536 ? text.slice(0, text.lastIndexOf('\n', 65536) > 0 ? text.lastIndexOf('\n', 65536) : 65536) : text;
  let best = { delimiter: ',', consistency: 0, columns: 1, rows: 0, score: -1 };
  for (const cand of [',', '\t', ';', '|']) {
    const { rows } = parseDelimited(sample, cand, null);
    const counts = rows.slice(0, 200).map((r) => r.fields.length);
    if (!counts.length) continue;
    const freq = new Map<number, number>();
    for (const c of counts) freq.set(c, (freq.get(c) ?? 0) + 1);
    let mode = 1;
    let modeCount = 0;
    for (const [c, n] of freq) if (n > modeCount || (n === modeCount && c > mode)) [mode, modeCount] = [c, n];
    if (mode < 2) continue;
    const consistency = modeCount / counts.length;
    const score = consistency * 10 + Math.min(mode, 20) * 0.05;
    if (score > best.score) best = { delimiter: cand, consistency, columns: mode, rows: counts.length, score };
  }
  return { delimiter: best.delimiter, consistency: best.consistency, columns: best.columns, rows: best.rows };
}

export function needsQuoting(value: string, delimiter: string): boolean {
  return value.includes(delimiter) || value.includes('"') || value.includes('\n') || value.includes('\r');
}

export function quoteField(value: string, delimiter: string): string {
  return needsQuoting(value, delimiter) ? `"${value.replace(/"/g, '""')}"` : value;
}
