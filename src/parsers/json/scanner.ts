/**
 * Lenient tokenizer for the JSON family (JSON, JSONC, JSON5).
 *
 * It recognises every token any of the three dialects can contain (comments,
 * single quotes, identifiers, hex numbers, ...). The parser then decides what
 * is legal for the active mode, which lets FormatX produce precise messages
 * such as "Single-quoted strings are not allowed in JSON" instead of a generic
 * "unexpected token".
 */
export type JsonMode = 'json' | 'jsonc' | 'json5';

export type TokenKind =
  | '{'
  | '}'
  | '['
  | ']'
  | ':'
  | ','
  | 'string'
  | 'number'
  | 'ident'
  | 'lineComment'
  | 'blockComment'
  | 'invalid'
  | 'eof';

export type StringIssueKind =
  /** Escape that is invalid in every dialect (e.g. `\1`, bad `\u`). */
  | 'invalid-escape'
  /** Escape that only JSON5 accepts (`\'`, `\v`, `\0`, `\x41`, identity escapes, line continuations). */
  | 'json5-escape'
  /** Raw U+0000–U+001F inside a string. */
  | 'control-char';

export interface StringIssue {
  kind: StringIssueKind;
  offset: number;
  length: number;
}

export const NF_HEX = 1;
export const NF_PLUS = 2;
export const NF_LEADING_DOT = 4;
export const NF_TRAILING_DOT = 8;
export const NF_LEADING_ZERO = 16;
export const NF_INFINITY = 32;
export const NF_NAN = 64;
export const NF_MALFORMED = 128;
export const NF_FRACTION_OR_EXP = 256;

export interface Token {
  kind: TokenKind;
  start: number;
  end: number;
  /** Line breaks in the whitespace preceding the token. */
  nlBefore: number;
  quote?: '"' | "'";
  /** Strings and block comments. */
  terminated?: boolean;
  /** Decoded string value. */
  value?: string;
  issues?: StringIssue[];
  numFlags?: number;
}

const IDENT_RE = /(?:[\p{ID_Start}$_]|\\u[0-9a-fA-F]{4})(?:[\p{ID_Continue}$\u{200C}\u{200D}]|\\u[0-9a-fA-F]{4})*/uy;

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}
function isHex(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
}
function isIdentPartAscii(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
}

/** Whitespace accepted by JSON5 but not by JSON. */
export function isJson5OnlyWhitespace(c: number): boolean {
  return (
    c === 0x0b ||
    c === 0x0c ||
    c === 0xa0 ||
    c === 0xfeff ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000
  );
}

export class JsonScanner {
  readonly text: string;
  pos = 0;
  /** Offsets of JSON5-only whitespace characters encountered. */
  readonly oddWhitespace: number[] = [];
  private peeked: Token | null = null;

  constructor(text: string) {
    this.text = text;
  }

  peek(): Token {
    if (!this.peeked) this.peeked = this.scan();
    return this.peeked;
  }

  next(): Token {
    if (this.peeked) {
      const t = this.peeked;
      this.peeked = null;
      return t;
    }
    return this.scan();
  }

  private scan(): Token {
    const text = this.text;
    const len = text.length;
    let pos = this.pos;
    let nl = 0;
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 32 || c === 9) pos++;
      else if (c === 10) {
        nl++;
        pos++;
      } else if (c === 13) {
        nl++;
        pos++;
        if (text.charCodeAt(pos) === 10) pos++;
      } else if (isJson5OnlyWhitespace(c)) {
        if (this.oddWhitespace.length < 1000) this.oddWhitespace.push(pos);
        if (c === 0x2028 || c === 0x2029) nl++;
        pos++;
      } else break;
    }
    if (pos >= len) {
      this.pos = len;
      return { kind: 'eof', start: len, end: len, nlBefore: nl };
    }
    const start = pos;
    const c = text.charCodeAt(pos);
    switch (c) {
      case 123:
        this.pos = pos + 1;
        return { kind: '{', start, end: pos + 1, nlBefore: nl };
      case 125:
        this.pos = pos + 1;
        return { kind: '}', start, end: pos + 1, nlBefore: nl };
      case 91:
        this.pos = pos + 1;
        return { kind: '[', start, end: pos + 1, nlBefore: nl };
      case 93:
        this.pos = pos + 1;
        return { kind: ']', start, end: pos + 1, nlBefore: nl };
      case 58:
        this.pos = pos + 1;
        return { kind: ':', start, end: pos + 1, nlBefore: nl };
      case 44:
        this.pos = pos + 1;
        return { kind: ',', start, end: pos + 1, nlBefore: nl };
      case 34:
      case 39:
        return this.scanString(start, c === 34 ? '"' : "'", nl);
      case 47: {
        const n = text.charCodeAt(pos + 1);
        if (n === 47) {
          let p = pos + 2;
          while (p < len) {
            const ch = text.charCodeAt(p);
            if (ch === 10 || ch === 13) break;
            p++;
          }
          this.pos = p;
          return { kind: 'lineComment', start, end: p, nlBefore: nl };
        }
        if (n === 42) {
          const close = text.indexOf('*/', pos + 2);
          const end = close === -1 ? len : close + 2;
          this.pos = end;
          return { kind: 'blockComment', start, end, nlBefore: nl, terminated: close !== -1 };
        }
        this.pos = pos + 1;
        return { kind: 'invalid', start, end: pos + 1, nlBefore: nl };
      }
      default:
        break;
    }
    if (c === 45 || c === 43 || c === 46 || isDigit(c)) return this.scanNumber(start, nl);
    IDENT_RE.lastIndex = pos;
    const m = IDENT_RE.exec(text);
    if (m && m.index === pos) {
      this.pos = pos + m[0].length;
      return { kind: 'ident', start, end: this.pos, nlBefore: nl };
    }
    // Unknown character: consume one code point.
    const isHigh = c >= 0xd800 && c <= 0xdbff;
    this.pos = pos + (isHigh && pos + 1 < len ? 2 : 1);
    return { kind: 'invalid', start, end: this.pos, nlBefore: nl };
  }

  private scanNumber(start: number, nl: number): Token {
    const text = this.text;
    const len = text.length;
    let p = start;
    let flags = 0;
    const s0 = text.charCodeAt(p);
    if (s0 === 43) {
      flags |= NF_PLUS;
      p++;
    } else if (s0 === 45) p++;
    if (text.startsWith('Infinity', p)) {
      p += 8;
      flags |= NF_INFINITY;
    } else if (text.startsWith('NaN', p)) {
      p += 3;
      flags |= NF_NAN;
    } else if (text.charCodeAt(p) === 48 && (text.charCodeAt(p + 1) === 120 || text.charCodeAt(p + 1) === 88)) {
      p += 2;
      const hs = p;
      while (p < len && isHex(text.charCodeAt(p))) p++;
      flags |= NF_HEX;
      if (p === hs) flags |= NF_MALFORMED;
    } else {
      const intStart = p;
      while (p < len && isDigit(text.charCodeAt(p))) p++;
      const intLen = p - intStart;
      if (intLen > 1 && text.charCodeAt(intStart) === 48) flags |= NF_LEADING_ZERO;
      if (text.charCodeAt(p) === 46) {
        p++;
        flags |= NF_FRACTION_OR_EXP;
        const fs = p;
        while (p < len && isDigit(text.charCodeAt(p))) p++;
        const fracLen = p - fs;
        if (intLen === 0) flags |= NF_LEADING_DOT;
        if (fracLen === 0) flags |= NF_TRAILING_DOT;
        if (intLen === 0 && fracLen === 0) flags |= NF_MALFORMED;
      } else if (intLen === 0) {
        flags |= NF_MALFORMED;
      }
      const e = text.charCodeAt(p);
      if (e === 101 || e === 69) {
        p++;
        flags |= NF_FRACTION_OR_EXP;
        const sg = text.charCodeAt(p);
        if (sg === 43 || sg === 45) p++;
        const es = p;
        while (p < len && isDigit(text.charCodeAt(p))) p++;
        if (p === es) flags |= NF_MALFORMED;
      }
    }
    // Trailing identifier characters make the literal malformed (e.g. `12px`).
    while (p < len && isIdentPartAscii(text.charCodeAt(p))) {
      flags |= NF_MALFORMED;
      p++;
    }
    this.pos = p;
    return { kind: 'number', start, end: p, nlBefore: nl, numFlags: flags };
  }

  private scanString(start: number, quote: '"' | "'", nl: number): Token {
    const text = this.text;
    const len = text.length;
    const q = quote.charCodeAt(0);
    let p = start + 1;
    let value = '';
    let chunk = p;
    let terminated = false;
    let issues: StringIssue[] | undefined;
    const issue = (kind: StringIssueKind, offset: number, length: number) => {
      (issues ??= []).push({ kind, offset, length });
    };
    while (p < len) {
      const c = text.charCodeAt(p);
      if (c === q) {
        value += text.slice(chunk, p);
        p++;
        terminated = true;
        break;
      }
      if (c === 10 || c === 13) {
        // Strings cannot contain raw line breaks: stop here so recovery stays local.
        break;
      }
      if (c === 92) {
        value += text.slice(chunk, p);
        const e = text.charCodeAt(p + 1);
        switch (e) {
          case 34:
            value += '"';
            p += 2;
            break;
          case 92:
            value += '\\';
            p += 2;
            break;
          case 47:
            value += '/';
            p += 2;
            break;
          case 98:
            value += '\b';
            p += 2;
            break;
          case 102:
            value += '\f';
            p += 2;
            break;
          case 110:
            value += '\n';
            p += 2;
            break;
          case 114:
            value += '\r';
            p += 2;
            break;
          case 116:
            value += '\t';
            p += 2;
            break;
          case 117: {
            let k = 0;
            while (k < 4 && isHex(text.charCodeAt(p + 2 + k))) k++;
            if (k === 4) {
              value += String.fromCharCode(parseInt(text.substr(p + 2, 4), 16));
              p += 6;
            } else {
              issue('invalid-escape', p, 2 + k);
              p += 2 + k;
            }
            break;
          }
          case 120: {
            if (isHex(text.charCodeAt(p + 2)) && isHex(text.charCodeAt(p + 3))) {
              value += String.fromCharCode(parseInt(text.substr(p + 2, 2), 16));
              issue('json5-escape', p, 4);
              p += 4;
            } else {
              issue('invalid-escape', p, 2);
              p += 2;
            }
            break;
          }
          case 39:
            value += "'";
            issue('json5-escape', p, 2);
            p += 2;
            break;
          case 118:
            value += '\v';
            issue('json5-escape', p, 2);
            p += 2;
            break;
          case 48:
            if (isDigit(text.charCodeAt(p + 2))) {
              issue('invalid-escape', p, 3);
              p += 3;
            } else {
              value += '\0';
              issue('json5-escape', p, 2);
              p += 2;
            }
            break;
          case 10:
          case 0x2028:
          case 0x2029:
            issue('json5-escape', p, 2);
            p += 2;
            break;
          case 13:
            issue('json5-escape', p, 2);
            p += text.charCodeAt(p + 2) === 10 ? 3 : 2;
            break;
          default:
            if (Number.isNaN(e)) {
              // backslash at end of input
              p += 1;
              break;
            }
            if (e >= 49 && e <= 57) {
              issue('invalid-escape', p, 2);
              p += 2;
            } else {
              // JSON5 "identity" escape: \a means "a"
              const ch = String.fromCodePoint(text.codePointAt(p + 1) ?? e);
              value += ch;
              issue('json5-escape', p, 1 + ch.length);
              p += 1 + ch.length;
            }
        }
        chunk = p;
        continue;
      }
      if (c < 0x20) issue('control-char', p, 1);
      p++;
    }
    if (!terminated) value += text.slice(chunk, p);
    this.pos = p;
    return { kind: 'string', start, end: p, nlBefore: nl, quote, terminated, value, issues };
  }
}
