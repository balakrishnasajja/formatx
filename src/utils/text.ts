export type Eol = '\n' | '\r\n';

/** Most frequent line ending in the text (defaults to LF). */
export function detectEol(text: string): Eol {
  let crlf = 0;
  let lf = 0;
  const limit = Math.min(text.length, 1_000_000);
  for (let i = 0; i < limit; i++) {
    if (text.charCodeAt(i) === 10) {
      if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++;
      else lf++;
    }
  }
  return crlf > lf ? '\r\n' : '\n';
}

export function normalizeEol(text: string, eol: Eol): string {
  const lf = text.replace(/\r\n?/g, '\n');
  return eol === '\n' ? lf : lf.replace(/\n/g, '\r\n');
}

export function resolveEol(setting: 'auto' | 'lf' | 'crlf', input: string): Eol {
  if (setting === 'lf') return '\n';
  if (setting === 'crlf') return '\r\n';
  return detectEol(input);
}

export function ensureFinalNewline(text: string, eol: Eol = '\n'): string {
  if (text.length === 0) return text;
  return text.replace(/(?:\r?\n)*$/, '') + eol;
}

/** UTF-8 byte length without allocating an encoded copy. */
export function utf8Length(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const n = s.charCodeAt(i + 1);
      if (n >= 0xdc00 && n <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 2 : 1)} MB`;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** Closest candidate by edit distance (case-insensitive), if within `maxDistance`. */
export function closestMatch(word: string, candidates: readonly string[], maxDistance = 2): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  const w = word.toLowerCase();
  for (const c of candidates) {
    const d = levenshtein(w, c.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best !== null && bestD <= maxDistance && bestD < word.length ? best : null;
}

const CONTROL_NAMES: Record<number, string> = {
  0: 'NUL',
  8: 'backspace',
  9: 'tab',
  10: 'line feed',
  11: 'vertical tab',
  12: 'form feed',
  13: 'carriage return',
  27: 'escape',
  0xa0: 'non-breaking space',
  0xfeff: 'byte order mark',
  0x200b: 'zero-width space',
  0x2028: 'line separator',
  0x2029: 'paragraph separator',
};

/** Human friendly description of a character, e.g. `'@'` or `U+0009 (tab)`. */
export function describeChar(ch: string): string {
  const code = ch.codePointAt(0) ?? 0;
  const hex = 'U+' + code.toString(16).toUpperCase().padStart(4, '0');
  if (CONTROL_NAMES[code]) return `${hex} (${CONTROL_NAMES[code]})`;
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return `control character ${hex}`;
  return `'${ch}'`;
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + '…';
}

export function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

export function pluralize(n: number, word: string, plural = word + 's'): string {
  return `${n} ${n === 1 ? word : plural}`;
}

/** Escape a string for use inside a RegExp. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isBlank(s: string): boolean {
  return /^\s*$/.test(s);
}
