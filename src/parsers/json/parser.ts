import type { Diagnostic, QuickFix } from '../../types/diagnostics';
import { diagAt, relatedAt } from '../../utils/diag';
import type { LineIndex } from '../../utils/lineIndex';
import { describeChar } from '../../utils/text';
import {
  JsonScanner,
  NF_HEX,
  NF_INFINITY,
  NF_LEADING_DOT,
  NF_LEADING_ZERO,
  NF_MALFORMED,
  NF_NAN,
  NF_PLUS,
  NF_TRAILING_DOT,
  type JsonMode,
  type Token,
} from './scanner';

export interface JsonVisitor {
  objectStart(start: number): void;
  objectEnd(end: number): void;
  arrayStart(start: number): void;
  arrayEnd(end: number): void;
  key(name: string, raw: string, start: number, end: number): void;
  literal(token: Token, raw: string): void;
  /** Called when a value is missing (error recovery) so builders stay balanced. */
  missingValue(): void;
}

export interface JsonParseStats {
  objects: number;
  arrays: number;
  keys: number;
  depth: number;
  comments: number;
  duplicateKeys: number;
  rootKind: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' | 'none';
}

export interface JsonParseResult {
  diagnostics: Diagnostic[];
  stats: JsonParseStats;
  /** Parsing stopped early (nesting limit or error budget); built values are incomplete. */
  incomplete: boolean;
}

const MODE_NAME: Record<JsonMode, string> = { json: 'JSON', jsonc: 'JSONC', json5: 'JSON5' };
export const MAX_DEPTH = 2000;
const MAX_ERRORS = 500;

/**
 * Error-recovering recursive-descent parser. Reports every problem it can find
 * (missing commas/colons/brackets, bad literals, trailing commas, comments in
 * strict JSON, duplicate keys...) with exact offsets and explicit quick fixes.
 */
export class JsonParser {
  private readonly sc: JsonScanner;
  private tok: Token;
  private prevEnd = 0;
  private readonly stack: { kind: 'object' | 'array'; start: number }[] = [];
  private readonly diags: Diagnostic[] = [];
  private readonly source: string;
  private aborted = false;
  readonly stats: JsonParseStats = {
    objects: 0,
    arrays: 0,
    keys: 0,
    depth: 0,
    comments: 0,
    duplicateKeys: 0,
    rootKind: 'none',
  };

  private readonly text: string;
  private readonly mode: JsonMode;
  private readonly lines: LineIndex;
  private readonly visitor?: JsonVisitor;

  constructor(text: string, mode: JsonMode, lines: LineIndex, visitor?: JsonVisitor) {
    this.text = text;
    this.mode = mode;
    this.lines = lines;
    this.visitor = visitor;
    this.sc = new JsonScanner(text);
    this.source = `${MODE_NAME[mode]} parser`;
    this.tok = { kind: 'eof', start: 0, end: 0, nlBefore: 0 };
    this.advance();
  }

  parse(): JsonParseResult {
    if (this.tok.kind === 'eof') {
      if (this.text.trim().length > 0) {
        this.error(this.text.length, 0, 'json/no-value', 'Missing value', 'The document contains only comments or whitespace — no JSON value was found.');
      }
      return this.result();
    }
    const t = this.tok;
    this.stats.rootKind =
      t.kind === '{' ? 'object' : t.kind === '[' ? 'array' : t.kind === 'string' ? 'string' : t.kind === 'number' ? 'number' : t.kind === 'ident' ? (/^(true|false)$/.test(this.raw(t)) ? 'boolean' : 'null') : 'none';
    this.parseValue(1);
    const extra = this.tok as Token;
    if (!this.aborted && extra.kind !== 'eof') {
      const isValueStart = ['{', '[', 'string', 'number', 'ident'].includes(extra.kind);
      this.error(extra.start, extra.end - extra.start, 'json/trailing-content', 'Unexpected content', isValueStart
        ? `Unexpected ${this.describe(extra)} after the end of the ${MODE_NAME[this.mode]} value. A document can contain only one root value.`
        : `Unexpected ${this.describe(extra)} after the end of the ${MODE_NAME[this.mode]} value.`, {
        suggestion: isValueStart
          ? 'Wrap multiple values in an array ([...]) and separate them with commas, or use JSON Lines (one value per line) in a separate document.'
          : 'Remove the extra characters.',
      });
    }
    this.checkOddWhitespace();
    return this.result();
  }

  private result(): JsonParseResult {
    return { diagnostics: this.diags, stats: this.stats, incomplete: this.aborted };
  }

  // ---------------------------------------------------------------- helpers

  private raw(t: Token): string {
    return this.text.slice(t.start, t.end);
  }

  private describe(t: Token): string {
    switch (t.kind) {
      case 'eof':
        return 'end of input';
      case 'string':
        return 'string';
      case 'number':
        return `number ${this.raw(t)}`;
      case 'ident':
        return `'${this.raw(t)}'`;
      case 'invalid':
        return `character ${describeChar(this.raw(t))}`;
      case 'lineComment':
      case 'blockComment':
        return 'comment';
      default:
        return `'${t.kind}'`;
    }
  }

  private error(
    offset: number,
    length: number,
    code: string,
    type: string,
    message: string,
    extra: { suggestion?: string; fix?: QuickFix; relatedOffset?: number; relatedMessage?: string; severity?: 'error' | 'warning' | 'info' } = {},
  ): void {
    if (this.diags.length >= MAX_ERRORS) {
      this.aborted = true;
      return;
    }
    this.diags.push(
      diagAt(this.lines, offset, length, {
        severity: extra.severity ?? 'error',
        code,
        type,
        message,
        source: this.source,
        suggestion: extra.suggestion,
        fix: extra.fix,
        related: extra.relatedOffset !== undefined ? [relatedAt(this.lines, extra.relatedOffset, extra.relatedMessage ?? 'Related location')] : undefined,
      }),
    );
  }

  /** Move to the next significant token, reporting comments as needed. */
  private advance(): void {
    if (this.tok.kind !== 'eof' || this.tok.end > 0) this.prevEnd = this.tok.end;
    for (;;) {
      const t = this.sc.next();
      if (t.kind === 'lineComment' || t.kind === 'blockComment') {
        this.stats.comments++;
        if (t.kind === 'blockComment' && !t.terminated) {
          this.error(t.start, 2, 'json/unterminated-comment', 'Unterminated comment', "Block comment is never closed with '*/'.", {
            fix: { title: "Insert '*/' at the end", edits: [{ offset: this.text.length, length: 0, text: ' */' }] },
          });
        } else if (this.mode === 'json') {
          this.error(t.start, t.end - t.start, 'json/comment-not-allowed', 'Comment not allowed', 'Comments are not allowed in JSON.', {
            suggestion: 'Remove the comment, or switch the format to JSONC / JSON5 if comments are intentional.',
            fix: { title: 'Remove comment', edits: [{ offset: t.start, length: t.end - t.start, text: '' }] },
          });
        }
        continue;
      }
      this.tok = t;
      return;
    }
  }

  private isValueStart(t: Token): boolean {
    return t.kind === '{' || t.kind === '[' || t.kind === 'string' || t.kind === 'number' || t.kind === 'ident';
  }

  // ----------------------------------------------------------------- values

  /** Returns false when no value could be consumed. */
  private parseValue(depth: number): boolean {
    if (this.aborted) return false;
    if (depth > this.stats.depth) this.stats.depth = depth;
    if (depth > MAX_DEPTH) {
      this.error(this.tok.start, 1, 'json/too-deep', 'Nesting too deep', `Nesting depth exceeds ${MAX_DEPTH} levels: deeper content was not checked, and conversion is disabled for this document.`, {
        severity: 'warning',
      });
      this.aborted = true;
      return false;
    }
    const t = this.tok;
    switch (t.kind) {
      case '{':
        this.parseObject(depth);
        return true;
      case '[':
        this.parseArray(depth);
        return true;
      case 'string':
        this.checkString(t, false);
        this.visitor?.literal(t, this.raw(t));
        this.advance();
        return true;
      case 'number':
        this.checkNumber(t);
        this.visitor?.literal(t, this.raw(t));
        this.advance();
        return true;
      case 'ident':
        this.checkIdentValue(t);
        this.visitor?.literal(t, this.raw(t));
        this.advance();
        return true;
      case 'invalid': {
        const ch = this.raw(t);
        this.error(t.start, t.end - t.start, 'json/unexpected-character', 'Unexpected character', `Unexpected character ${describeChar(ch)} where a value was expected.`, {
          suggestion: ch === '#' ? 'JSON has no # comments. Remove the line or use JSONC with // comments.' : undefined,
        });
        this.visitor?.missingValue();
        this.advance();
        return true;
      }
      case 'eof': {
        const open = this.stack[this.stack.length - 1];
        this.error(this.text.length, 0, 'json/unexpected-end', 'Unexpected end of input', 'Unexpected end of input: a value was expected.', {
          relatedOffset: open?.start,
          relatedMessage: open ? `Inside ${open.kind} opened here` : undefined,
        });
        this.visitor?.missingValue();
        return false;
      }
      default: {
        const trailing = t.kind === '}' || t.kind === ']';
        this.error(t.start, 1, 'json/value-expected', 'Value expected', `Expected a value but found '${t.kind}'.`, {
          suggestion: trailing ? 'Add a value or remove the preceding comma/colon.' : 'Values are strings, numbers, objects, arrays, true, false or null.',
        });
        this.visitor?.missingValue();
        return false;
      }
    }
  }

  private parseObject(depth: number): void {
    const open = this.tok;
    this.stats.objects++;
    this.visitor?.objectStart(open.start);
    this.stack.push({ kind: 'object', start: open.start });
    this.advance();
    const keys = new Map<string, number>();
    let first = true;
    let lastComma: Token | null = null;
    let prevMemberEnd = open.end;

    for (;;) {
      if (this.aborted) break;
      const t = this.tok;
      if (t.kind === 'invalid') {
        this.error(t.start, t.end - t.start, 'json/unexpected-character', 'Unexpected character', `Unexpected character ${describeChar(this.raw(t))} in object.`);
        this.advance();
        continue;
      }
      if (t.kind === '}') {
        if (lastComma && !first) this.reportTrailingComma(lastComma);
        this.advance();
        break;
      }
      if (t.kind === 'eof') {
        this.error(open.start, 1, 'json/unclosed-object', "Missing '}'", `Object opened here is never closed: expected '}' before the end of input.`, {
          suggestion: "Add the missing '}'.",
          fix: { title: "Insert '}' at the end of the document", edits: [{ offset: this.insertionPointAtEnd(), length: 0, text: '}' }] },
          relatedOffset: this.text.length,
          relatedMessage: 'End of input reached here',
        });
        break;
      }
      if (t.kind === ']') {
        if (this.stack.some((s, i) => i < this.stack.length - 1 && s.kind === 'array')) {
          this.error(t.start, 1, 'json/mismatched-bracket', "Missing '}'", `Expected '}' to close the object opened at ${this.pos(open.start)}, but found ']'.`, {
            relatedOffset: open.start,
            relatedMessage: 'Object opened here',
            suggestion: "Insert '}' before ']'.",
            fix: { title: "Insert '}'", edits: [{ offset: t.start, length: 0, text: '}' }] },
          });
          break;
        }
        this.error(t.start, 1, 'json/unexpected-bracket', "Unexpected ']'", "Unexpected ']' inside an object.", {
          suggestion: "Use '}' to close an object.",
          fix: { title: "Replace with '}'", edits: [{ offset: t.start, length: 1, text: '}' }] },
        });
        this.advance();
        continue;
      }
      if (t.kind === ',') {
        if (first || lastComma) {
          this.error(t.start, 1, 'json/unexpected-comma', 'Unexpected comma', first ? "Unexpected ',' at the start of the object." : "Two commas in a row: a property is missing between them.", {
            fix: { title: 'Remove comma', edits: [{ offset: t.start, length: 1, text: '' }] },
          });
          lastComma = t;
          this.advance();
          continue;
        }
      }
      if (!first && !lastComma) {
        this.error(prevMemberEnd - 1, 1, 'json/missing-comma', 'Missing comma', `Missing ',' between object properties (before ${this.describe(t)} at ${this.pos(t.start)}).`, {
          suggestion: `Insert ',' after line ${this.lines.positionAt(prevMemberEnd).line}.`,
          fix: { title: "Insert ','", edits: [{ offset: prevMemberEnd, length: 0, text: ',' }] },
        });
      }
      // ---- key
      const keyTok = this.tok;
      const keyName = this.parseKey();
      if (keyName === null) {
        // Not a key: try to skip a stray value so we can continue.
        if (this.tok.kind === ':') {
          this.advance();
          this.parseValue(depth + 1);
        } else if (this.isValueStart(this.tok)) {
          this.parseValue(depth + 1);
        } else if (this.tok.kind !== '}' && this.tok.kind !== 'eof' && this.tok.kind !== ']' && this.tok.kind !== ',') {
          this.advance();
        }
        first = false;
        lastComma = null;
        prevMemberEnd = this.prevEnd;
        if (this.tok.kind === ',') {
          lastComma = this.tok;
          this.advance();
        }
        continue;
      }
      this.stats.keys++;
      const firstAt = keys.get(keyName);
      if (firstAt !== undefined) {
        this.stats.duplicateKeys++;
        this.error(keyTok.start, keyTok.end - keyTok.start, 'json/duplicate-key', 'Duplicate key', `Duplicate key ${JSON.stringify(keyName)}: it was already defined at ${this.pos(firstAt)}. Most parsers keep only the last value.`, {
          severity: 'warning',
          relatedOffset: firstAt,
          relatedMessage: 'First definition',
        });
      } else keys.set(keyName, keyTok.start);

      // ---- colon
      if (this.tok.kind === ':') {
        this.advance();
        this.parseValue(depth + 1);
      } else {
        this.error(keyTok.end - 1, 1, 'json/missing-colon', 'Missing colon', `Missing ':' after property name ${JSON.stringify(keyName)}.`, {
          suggestion: "Separate the property name and its value with ':'.",
          fix: { title: "Insert ':'", edits: [{ offset: keyTok.end, length: 0, text: ':' }] },
        });
        if (this.isValueStart(this.tok) && this.tok.nlBefore === 0) this.parseValue(depth + 1);
        else this.visitor?.missingValue();
      }
      first = false;
      prevMemberEnd = this.prevEnd;
      if (this.tok.kind === ',') {
        lastComma = this.tok;
        this.advance();
      } else lastComma = null;
    }
    this.stack.pop();
    this.visitor?.objectEnd(this.prevEnd);
  }

  private parseArray(depth: number): void {
    const open = this.tok;
    this.stats.arrays++;
    this.visitor?.arrayStart(open.start);
    this.stack.push({ kind: 'array', start: open.start });
    this.advance();
    let first = true;
    let lastComma: Token | null = null;
    let prevItemEnd = open.end;

    for (;;) {
      if (this.aborted) break;
      const t = this.tok;
      if (t.kind === ']') {
        if (lastComma && !first) this.reportTrailingComma(lastComma);
        this.advance();
        break;
      }
      if (t.kind === 'eof') {
        this.error(open.start, 1, 'json/unclosed-array', "Missing ']'", "Array opened here is never closed: expected ']' before the end of input.", {
          suggestion: "Add the missing ']'.",
          fix: { title: "Insert ']' at the end of the document", edits: [{ offset: this.insertionPointAtEnd(), length: 0, text: ']' }] },
          relatedOffset: this.text.length,
          relatedMessage: 'End of input reached here',
        });
        break;
      }
      if (t.kind === '}') {
        if (this.stack.some((s, i) => i < this.stack.length - 1 && s.kind === 'object')) {
          this.error(t.start, 1, 'json/mismatched-bracket', "Missing ']'", `Expected ']' to close the array opened at ${this.pos(open.start)}, but found '}'.`, {
            relatedOffset: open.start,
            relatedMessage: 'Array opened here',
            suggestion: "Insert ']' before '}'.",
            fix: { title: "Insert ']'", edits: [{ offset: t.start, length: 0, text: ']' }] },
          });
          break;
        }
        this.error(t.start, 1, 'json/unexpected-brace', "Unexpected '}'", "Unexpected '}' inside an array.", {
          suggestion: "Use ']' to close an array.",
          fix: { title: "Replace with ']'", edits: [{ offset: t.start, length: 1, text: ']' }] },
        });
        this.advance();
        continue;
      }
      if (t.kind === ',') {
        if (first || lastComma) {
          this.error(t.start, 1, 'json/unexpected-comma', 'Unexpected comma', first ? "Unexpected ',' at the start of the array." : 'Two commas in a row: a value is missing between them.', {
            fix: { title: 'Remove comma', edits: [{ offset: t.start, length: 1, text: '' }] },
          });
          lastComma = t;
          this.advance();
          continue;
        }
      }
      if (t.kind === ':') {
        this.error(t.start, 1, 'json/unexpected-colon', 'Unexpected colon', "Unexpected ':' inside an array. Arrays contain values, not key/value pairs.", {
          suggestion: 'Use an object ({ }) for key/value pairs.',
        });
        this.advance();
        continue;
      }
      if (!first && !lastComma) {
        this.error(prevItemEnd - 1, 1, 'json/missing-comma', 'Missing comma', `Missing ',' between array elements (before ${this.describe(t)} at ${this.pos(t.start)}).`, {
          suggestion: `Insert ',' after line ${this.lines.positionAt(prevItemEnd).line}.`,
          fix: { title: "Insert ','", edits: [{ offset: prevItemEnd, length: 0, text: ',' }] },
        });
      }
      this.parseValue(depth + 1);
      first = false;
      prevItemEnd = this.prevEnd;
      if (this.tok.kind === ',') {
        lastComma = this.tok;
        this.advance();
      } else lastComma = null;
    }
    this.stack.pop();
    this.visitor?.arrayEnd(this.prevEnd);
  }

  /** Parses a property name. Returns null if the token cannot be a key. */
  private parseKey(): string | null {
    const t = this.tok;
    if (t.kind === 'string') {
      this.checkString(t, true);
      this.visitor?.key(t.value ?? '', this.raw(t), t.start, t.end);
      this.advance();
      return t.value ?? '';
    }
    if (t.kind === 'ident') {
      const raw = this.raw(t);
      if (this.mode !== 'json5') {
        this.error(t.start, t.end - t.start, 'json/unquoted-key', 'Unquoted property name', `Property names must be double-quoted in ${MODE_NAME[this.mode]}: found ${raw}.`, {
          suggestion: `Use "${raw}" instead.`,
          fix: { title: `Quote property name "${raw}"`, edits: [{ offset: t.start, length: t.end - t.start, text: JSON.stringify(decodeIdent(raw)) }] },
        });
      }
      const name = decodeIdent(raw);
      this.visitor?.key(name, raw, t.start, t.end);
      this.advance();
      return name;
    }
    if (t.kind === 'number') {
      const raw = this.raw(t);
      this.error(t.start, t.end - t.start, 'json/numeric-key', 'Invalid property name', `Property names must be strings, found number ${raw}.`, {
        fix: { title: `Quote property name "${raw}"`, edits: [{ offset: t.start, length: t.end - t.start, text: JSON.stringify(raw) }] },
      });
      this.visitor?.key(raw, raw, t.start, t.end);
      this.advance();
      return raw;
    }
    if (t.kind === '{' || t.kind === '[') {
      this.error(t.start, 1, 'json/property-expected', 'Property name expected', `Expected a property name but found '${t.kind}'. Objects must contain "key": value pairs.`);
      return null;
    }
    this.error(t.start, Math.max(1, t.end - t.start), 'json/property-expected', 'Property name expected', `Expected a property name but found ${this.describe(t)}.`);
    return null;
  }

  // ------------------------------------------------------------ token checks

  private checkString(t: Token, isKey: boolean): void {
    const what = isKey ? 'Property name' : 'String';
    if (t.quote === "'" && this.mode !== 'json5') {
      const raw = this.raw(t);
      const fixed = t.terminated ? JSON.stringify(t.value ?? '') : null;
      this.error(t.start, t.end - t.start, 'json/single-quotes', 'Invalid quotes', `${what}s must use double quotes in ${MODE_NAME[this.mode]}; single quotes are only valid in JSON5.`, {
        suggestion: fixed ? `Use ${truncateFix(fixed)} instead of ${truncateFix(raw)}.` : 'Use double quotes.',
        fix: fixed ? { title: 'Convert to double quotes', edits: [{ offset: t.start, length: t.end - t.start, text: fixed }] } : undefined,
      });
    }
    if (!t.terminated) {
      const lineEnd = this.lines.lineEnd(this.lines.positionAt(t.start).line);
      this.error(t.start, 1, 'json/unterminated-string', 'Unterminated string', `${what} starting here is missing its closing ${t.quote === "'" ? "'" : '"'} quote.`, {
        suggestion: `Add a closing ${t.quote} at the end of the string.`,
        fix: { title: 'Insert closing quote at end of line', edits: [{ offset: lineEnd, length: 0, text: t.quote ?? '"' }] },
      });
    }
    if (!t.issues) return;
    for (const is of t.issues) {
      const seq = this.text.slice(is.offset, is.offset + is.length);
      if (is.kind === 'invalid-escape') {
        this.error(is.offset, is.length, 'json/invalid-escape', 'Invalid escape sequence', `Invalid escape sequence '${seq}'.`, {
          suggestion: 'Valid escapes are \\" \\\\ \\/ \\b \\f \\n \\r \\t and \\uXXXX (four hex digits). Write \\\\ for a literal backslash.',
          fix: { title: 'Escape the backslash', edits: [{ offset: is.offset, length: 1, text: '\\\\' }] },
        });
      } else if (is.kind === 'json5-escape' && this.mode !== 'json5') {
        const nl = /\\[\r\n\u{2028}\u{2029}]/u.test(seq);
        this.error(is.offset, is.length, 'json/invalid-escape', 'Invalid escape sequence', nl
          ? `Line continuations (backslash + newline) are not allowed in ${MODE_NAME[this.mode]} strings.`
          : `Escape sequence '${seq}' is not allowed in ${MODE_NAME[this.mode]} (it is valid in JSON5).`, {
          suggestion: 'Valid escapes are \\" \\\\ \\/ \\b \\f \\n \\r \\t and \\uXXXX.',
        });
      } else if (is.kind === 'control-char' && this.mode !== 'json5') {
        const ch = this.text[is.offset];
        const esc = ch === '\t' ? '\\t' : '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
        this.error(is.offset, 1, 'json/control-character', 'Unescaped control character', `Unescaped ${describeChar(ch)} inside a string.`, {
          suggestion: `Escape it as ${esc}.`,
          fix: { title: `Replace with ${esc}`, edits: [{ offset: is.offset, length: 1, text: esc }] },
        });
      }
    }
  }

  private checkNumber(t: Token): void {
    const f = t.numFlags ?? 0;
    const raw = this.raw(t);
    const len = t.end - t.start;
    if (f & NF_MALFORMED) {
      const unit = /^-?\d+(?:\.\d+)?[a-zA-Z%]+$/.test(raw);
      this.error(t.start, len, 'json/invalid-number', 'Invalid number', `Invalid number literal '${raw}'.`, {
        suggestion: unit ? `Numbers cannot have units. Use a string ("${raw}") or a plain number.` : 'Numbers look like 42, -3.14 or 6.02e23.',
        fix: unit ? { title: `Quote as "${raw}"`, edits: [{ offset: t.start, length: len, text: JSON.stringify(raw) }] } : undefined,
      });
      return;
    }
    if (this.mode === 'json5') {
      if (f & NF_LEADING_ZERO) {
        this.error(t.start, len, 'json/leading-zero', 'Leading zero', `Numbers cannot have leading zeros: '${raw}'.`, {
          suggestion: `Use ${String(Number(raw.replace(/^([+-]?)0+(?=\d)/, '$1')))} or a string.`,
        });
      }
      return;
    }
    const name = MODE_NAME[this.mode];
    if (f & (NF_INFINITY | NF_NAN)) {
      this.error(t.start, len, 'json/non-finite-number', 'Invalid number', `${raw} is not valid in ${name}. Only finite numbers are allowed (JSON5 supports Infinity and NaN).`, {
        suggestion: 'Use null or a string such as "Infinity".',
        fix: { title: 'Replace with null', edits: [{ offset: t.start, length: len, text: 'null' }] },
      });
      return;
    }
    if (f & NF_HEX) {
      const dec = (() => {
        try {
          const neg = raw.startsWith('-');
          const v = BigInt(raw.replace(/^[+-]/, ''));
          return (neg ? '-' : '') + v.toString();
        } catch {
          return null;
        }
      })();
      this.error(t.start, len, 'json/hex-number', 'Invalid number', `Hexadecimal numbers are not allowed in ${name}: '${raw}'.`, {
        suggestion: dec ? `Use the decimal value ${dec}.` : 'Use a decimal number.',
        fix: dec ? { title: `Replace with ${dec}`, edits: [{ offset: t.start, length: len, text: dec }] } : undefined,
      });
      return;
    }
    if (f & NF_PLUS) {
      this.error(t.start, 1, 'json/leading-plus', 'Invalid number', `A leading '+' is not allowed in ${name} numbers.`, {
        fix: { title: "Remove '+'", edits: [{ offset: t.start, length: 1, text: '' }] },
      });
    }
    if (f & NF_LEADING_ZERO) {
      const fixed = raw.replace(/^([+-]?)0+(?=\d)/, '$1');
      this.error(t.start, len, 'json/leading-zero', 'Leading zero', `Numbers cannot have leading zeros in ${name}: '${raw}'.`, {
        suggestion: `Use ${fixed}, or a string ("${raw}") if the zeros are significant (e.g. a ZIP code).`,
      });
    }
    if (f & NF_LEADING_DOT) {
      const fixed = raw.replace(/^([+-]?)\./, '$10.');
      this.error(t.start, len, 'json/leading-dot', 'Invalid number', `Numbers must have a digit before the decimal point in ${name}: '${raw}'.`, {
        fix: { title: `Replace with ${fixed}`, edits: [{ offset: t.start, length: len, text: fixed }] },
      });
    }
    if (f & NF_TRAILING_DOT) {
      const fixed = raw.replace(/\.(?=$|[eE])/, '.0');
      this.error(t.start, len, 'json/trailing-dot', 'Invalid number', `Numbers must have digits after the decimal point in ${name}: '${raw}'.`, {
        fix: { title: `Replace with ${fixed}`, edits: [{ offset: t.start, length: len, text: fixed }] },
      });
    }
  }

  private checkIdentValue(t: Token): void {
    const raw = this.raw(t);
    if (raw === 'true' || raw === 'false' || raw === 'null') return;
    const len = t.end - t.start;
    const name = MODE_NAME[this.mode];
    if (raw === 'Infinity' || raw === 'NaN') {
      if (this.mode === 'json5') return;
      this.error(t.start, len, 'json/non-finite-number', 'Invalid number', `${raw} is not valid in ${name}. Only finite numbers are allowed (JSON5 supports Infinity and NaN).`, {
        fix: { title: 'Replace with null', edits: [{ offset: t.start, length: len, text: 'null' }] },
      });
      return;
    }
    const lower = raw.toLowerCase();
    const literalFix: Record<string, string> = { true: 'true', false: 'false', null: 'null', none: 'null', nil: 'null', undefined: 'null' };
    if (literalFix[lower]) {
      const target = literalFix[lower];
      const why = lower === 'undefined' ? `undefined is not a ${name} value.` : lower === 'none' ? `None is Python syntax; ${name} uses null.` : `${name} literals are lowercase.`;
      this.error(t.start, len, 'json/invalid-literal', 'Invalid literal', `Unexpected '${raw}'. ${why}`, {
        suggestion: `Use ${target}.`,
        fix: { title: `Replace with ${target}`, edits: [{ offset: t.start, length: len, text: target }] },
      });
      return;
    }
    this.error(t.start, len, 'json/unquoted-string', 'Unquoted string', `Unexpected identifier '${raw}'. String values must be wrapped in ${this.mode === 'json5' ? 'quotes' : 'double quotes'}.`, {
      suggestion: `Use "${raw}".`,
      fix: { title: `Quote as "${raw}"`, edits: [{ offset: t.start, length: len, text: JSON.stringify(raw) }] },
    });
  }

  private reportTrailingComma(comma: Token): void {
    if (this.mode === 'json5') return;
    this.error(comma.start, 1, 'json/trailing-comma', 'Trailing comma', this.mode === 'jsonc'
      ? 'Trailing comma. Accepted by many JSONC tools (VS Code, TypeScript) but rejected by strict JSON parsers.'
      : 'Trailing commas are not allowed in JSON.', {
      severity: this.mode === 'jsonc' ? 'warning' : 'error',
      fix: { title: 'Remove trailing comma', edits: [{ offset: comma.start, length: 1, text: '' }] },
    });
  }

  private checkOddWhitespace(): void {
    if (this.mode === 'json5') return;
    for (const off of this.sc.oddWhitespace.slice(0, 20)) {
      const ch = this.text[off];
      this.error(off, 1, 'json/invalid-whitespace', 'Invalid whitespace', `${describeChar(ch)} is not valid whitespace in ${MODE_NAME[this.mode]}.`, {
        severity: ch === '\u{FEFF}' && off === 0 ? 'warning' : 'error',
        fix: { title: 'Remove character', edits: [{ offset: off, length: 1, text: '' }] },
      });
    }
  }

  private insertionPointAtEnd(): number {
    let end = this.text.length;
    while (end > 0 && /\s/.test(this.text[end - 1])) end--;
    return end;
  }

  private pos(offset: number): string {
    const p = this.lines.positionAt(offset);
    return `line ${p.line}, column ${p.column}`;
  }
}

/** Decode `\uXXXX` escapes inside a JSON5 identifier. */
export function decodeIdent(raw: string): string {
  return raw.includes('\\') ? raw.replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))) : raw;
}

function truncateFix(s: string): string {
  return s.length > 40 ? s.slice(0, 37) + '…' : s;
}
