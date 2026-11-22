/**
 * Binary formats (BSON, MessagePack) travel through the editor as text:
 * hexadecimal (whitespace tolerant) or base64. These helpers convert between
 * bytes and text and remember where every byte came from so decoding errors
 * can be reported at an exact editor position.
 */
export type BinaryTextEncoding = 'hex' | 'base64';

export interface DecodedBinary {
  bytes: Uint8Array;
  encoding: BinaryTextEncoding;
  /** Text offset of the first character of each byte (hex only; base64 is approximated). */
  byteOffset(index: number): number;
}

export interface BinaryDecodeError {
  error: string;
  offset: number;
}

const HEX_RE = /^(?:\s|0x|[0-9a-fA-F]|,)*$/;
const B64_RE = /^[A-Za-z0-9+/_\-=\s]*$/;

export function looksLikeHex(text: string): boolean {
  const t = text.trim();
  if (t.length < 2) return false;
  return HEX_RE.test(t) && /[0-9a-fA-F]{2}/.test(t);
}

export function looksLikeBase64(text: string): boolean {
  const t = text.replace(/\s+/g, '');
  return t.length >= 4 && B64_RE.test(t) && /^[A-Za-z0-9+/_-]+={0,2}$/.test(t);
}

export function decodeBinaryText(text: string): DecodedBinary | BinaryDecodeError {
  const t = text.trim();
  if (!t) return { error: 'Input is empty', offset: 0 };
  if (looksLikeHex(t)) return decodeHex(text);
  if (looksLikeBase64(t)) return decodeBase64(text);
  // find first offending character for a helpful position
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!/[\s0-9a-fA-FxX,A-Za-z+/_=-]/.test(c)) {
      return { error: `Unexpected character '${c}'. Binary input must be hexadecimal or base64 text.`, offset: i };
    }
  }
  return { error: 'Input is neither valid hexadecimal nor base64.', offset: 0 };
}

export function decodeHex(text: string): DecodedBinary | BinaryDecodeError {
  const bytes: number[] = [];
  const offsets: number[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    // whitespace and commas separate bytes
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 44) {
      i++;
      continue;
    }
    // optional 0x prefix
    if (c === 48 && (text[i + 1] === 'x' || text[i + 1] === 'X') && isHexChar(text.charCodeAt(i + 2))) {
      i += 2;
      continue;
    }
    if (!isHexChar(c)) return { error: `Invalid hexadecimal character '${text[i]}'`, offset: i };
    if (!isHexChar(text.charCodeAt(i + 1))) {
      return { error: 'Odd number of hexadecimal digits (each byte needs two digits)', offset: i };
    }
    offsets.push(i);
    bytes.push(parseInt(text.substr(i, 2), 16));
    i += 2;
  }
  const arr = Uint8Array.from(bytes);
  return {
    bytes: arr,
    encoding: 'hex',
    byteOffset: (index) => (index < offsets.length ? offsets[index] : text.length),
  };
}

export function decodeBase64(text: string): DecodedBinary | BinaryDecodeError {
  const compact = text.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = compact + '='.repeat((4 - (compact.length % 4)) % 4);
  let bin: string;
  try {
    bin = atob(padded);
  } catch {
    return { error: 'Invalid base64 data', offset: 0 };
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // map byte index → approximate text offset (4 chars per 3 bytes), ignoring whitespace
  const charPositions: number[] = [];
  for (let i = 0; i < text.length; i++) if (!/\s/.test(text[i])) charPositions.push(i);
  return {
    bytes,
    encoding: 'base64',
    byteOffset: (index) => charPositions[Math.min(charPositions.length - 1, Math.floor((index * 4) / 3))] ?? 0,
  };
}

function isHexChar(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
}

export function isDecodeError(v: DecodedBinary | BinaryDecodeError): v is BinaryDecodeError {
  return 'error' in v;
}

/** Hex text, 16 space separated bytes per line. Re-parseable by `decodeHex`. */
export function toHex(bytes: Uint8Array, perLine = 16): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += perLine) {
    const parts: string[] = [];
    for (let j = i; j < Math.min(i + perLine, bytes.length); j++) parts.push(bytes[j].toString(16).padStart(2, '0'));
    lines.push(parts.join(' '));
  }
  return lines.join('\n');
}

export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(bin);
}

/** Wrap base64 at 76 characters (MIME style) for readability. */
export function toBase64Wrapped(bytes: Uint8Array, width = 76): string {
  const b64 = toBase64(bytes);
  const out: string[] = [];
  for (let i = 0; i < b64.length; i += width) out.push(b64.slice(i, i + width));
  return out.join('\n');
}

export function encodeBinaryText(bytes: Uint8Array, encoding: BinaryTextEncoding): string {
  return encoding === 'hex' ? toHex(bytes) : toBase64Wrapped(bytes);
}

/** Heuristic: does a file's content look binary (NUL bytes or many control characters)? */
export function isProbablyBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  if (n === 0) return false;
  let control = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i];
    if (b === 0) return true;
    if (b < 7 || (b > 13 && b < 32)) control++;
  }
  return control / n > 0.1;
}
