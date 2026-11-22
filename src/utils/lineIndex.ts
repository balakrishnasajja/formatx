import type { SourceRange } from '../types/diagnostics';

/**
 * Maps UTF-16 offsets to 1-based line/column positions (Monaco compatible) and back.
 * Treats `\r\n`, `\n` and a lone `\r` as line breaks, like Monaco does.
 */
export class LineIndex {
  readonly text: string;
  private readonly starts: number[];

  constructor(text: string) {
    this.text = text;
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 10) {
        starts.push(i + 1);
      } else if (c === 13) {
        if (text.charCodeAt(i + 1) === 10) i++;
        starts.push(i + 1);
      }
    }
    this.starts = starts;
  }

  get lineCount(): number {
    return this.starts.length;
  }

  positionAt(offset: number): { line: number; column: number } {
    const o = Math.max(0, Math.min(offset, this.text.length));
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= o) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: o - this.starts[lo] + 1 };
  }

  lineStart(line: number): number {
    const l = Math.max(1, Math.min(line, this.starts.length));
    return this.starts[l - 1];
  }

  /** Offset of the end of the line content (before the line break). */
  lineEnd(line: number): number {
    const l = Math.max(1, Math.min(line, this.starts.length));
    let end = l < this.starts.length ? this.starts[l] : this.text.length;
    if (l < this.starts.length) {
      // strip the line break
      if (this.text.charCodeAt(end - 1) === 10) end--;
      if (this.text.charCodeAt(end - 1) === 13) end--;
    }
    return end;
  }

  lineText(line: number): string {
    return this.text.slice(this.lineStart(line), this.lineEnd(line));
  }

  offsetAt(line: number, column: number): number {
    const start = this.lineStart(line);
    const end = this.lineEnd(line);
    return Math.max(start, Math.min(start + Math.max(1, column) - 1, end));
  }

  /** Range for [offset, offset+length). Zero-length ranges are widened to one character when possible. */
  rangeAt(offset: number, length = 1): SourceRange {
    let start = Math.max(0, Math.min(offset, this.text.length));
    let end = Math.max(start, Math.min(start + Math.max(0, length), this.text.length));
    if (end === start) {
      const c = this.text.charCodeAt(start);
      if (start < this.text.length && c !== 10 && c !== 13) end = start + 1;
      else if (start > 0) {
        const p = this.text.charCodeAt(start - 1);
        if (p !== 10 && p !== 13) start = start - 1;
      }
    }
    const a = this.positionAt(start);
    const b = this.positionAt(Math.max(end, start));
    return { line: a.line, column: a.column, endLine: b.line, endColumn: Math.max(b.column, a.line === b.line ? a.column : b.column) };
  }

  /** Range from 1-based line/column, widened to one character if no end is given. */
  rangeAtLineCol(line: number, column: number, endLine?: number, endColumn?: number): SourceRange {
    if (endLine !== undefined && endColumn !== undefined && (endLine > line || (endLine === line && endColumn > column))) {
      return { line, column, endLine, endColumn };
    }
    return this.rangeAt(this.offsetAt(line, column), 1);
  }
}
