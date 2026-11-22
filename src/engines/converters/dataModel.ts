import { DataDate, type DataObject, type DataValue } from '../../types/data';

export type PathSegment = string | number;

const SIMPLE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** `$.users[0]["first name"]` */
export function pathToString(path: readonly PathSegment[]): string {
  let s = '$';
  for (const p of path) {
    if (typeof p === 'number') s += `[${p}]`;
    else if (SIMPLE_KEY.test(p)) s += `.${p}`;
    else s += `[${JSON.stringify(p)}]`;
  }
  return s;
}

/**
 * Detects numeric literals that cannot be represented exactly by an IEEE-754 double,
 * e.g. `0.1234567890123456789` or `1e400`. Integers are handled separately (BigInt).
 */
export function numberLosesPrecision(raw: string): boolean {
  const n = Number(raw);
  if (!Number.isFinite(n)) return true;
  const a = canonicalDecimal(raw);
  const b = canonicalDecimal(String(n));
  if (!a || !b) return false;
  return a.digits !== b.digits || a.exp !== b.exp || a.neg !== b.neg;
}

function canonicalDecimal(s: string): { neg: boolean; digits: string; exp: number } | null {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(s.trim());
  if (!m) return null;
  const neg = m[1] === '-';
  const intPart = m[2] ?? '';
  const frac = m[3] ?? '';
  let exp = (m[4] ? parseInt(m[4], 10) : 0) + intPart.length;
  let digits = intPart + frac;
  const lead = digits.match(/^0*/)?.[0].length ?? 0;
  digits = digits.slice(lead);
  exp -= lead;
  digits = digits.replace(/0+$/, '');
  if (!digits) return { neg: false, digits: '0', exp: 0 };
  return { neg, digits, exp };
}

const INT_RE = /^-?(?:0|[1-9]\d*)$/;
const FLOAT_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** Parse a JSON-style integer literal exactly (number when safe, BigInt otherwise). */
export function parseIntegerLiteral(raw: string): number | bigint {
  const n = Number(raw);
  if (Number.isSafeInteger(n)) return n;
  return BigInt(raw);
}

/**
 * Conservative type inference for untyped text sources (CSV, XML, INI, ENV, Properties):
 * a value is only converted when the conversion is exactly reversible.
 * "007" stays a string, "1.50" stays a string, "1.5" becomes 1.5.
 */
export function inferScalar(s: string): DataValue {
  if (s === 'true' || s === 'TRUE' || s === 'True') return true;
  if (s === 'false' || s === 'FALSE' || s === 'False') return false;
  if (s.length > 0 && s.length < 400) {
    if (INT_RE.test(s)) {
      if (s === '-0') return s;
      return parseIntegerLiteral(s);
    }
    if (FLOAT_RE.test(s)) {
      const n = Number(s);
      if (Number.isFinite(n) && String(n) === s) return n;
    }
  }
  return s;
}

export function dataEquals(a: DataValue, b: DataValue): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    if ((typeof a === 'bigint' || typeof a === 'number') && (typeof b === 'bigint' || typeof b === 'number')) {
      try {
        return BigInt(a) === BigInt(b);
      } catch {
        return false;
      }
    }
    return false;
  }
  if (a instanceof DataDate && b instanceof DataDate) return a.iso === b.iso && a.kind === b.kind;
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!dataEquals(a[i], b[i])) return false;
    return true;
  }
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) {
      if (!b.has(k)) return false;
      if (!dataEquals(v, b.get(k) as DataValue)) return false;
    }
    return true;
  }
  return false;
}

/** Deep equality for plain JS values (objects compared order-insensitively). */
export function jsEquals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) {
    if ((typeof a === 'bigint' && typeof b === 'number') || (typeof a === 'number' && typeof b === 'bigint')) {
      try {
        return BigInt(a as number) === BigInt(b as number);
      } catch {
        return false;
      }
    }
    return false;
  }
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime() || String(a) === String(b);
  if (typeof a !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => jsEquals(v, (b as unknown[])[i]));
  }
  if (a instanceof Map) {
    if (!(b instanceof Map) || a.size !== b.size) return false;
    for (const [k, v] of a) if (!b.has(k) || !jsEquals(v, b.get(k))) return false;
    return true;
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!jsEquals((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

export interface JsToDataOptions {
  /** Called for values that cannot be represented and were converted. */
  onLoss?: (path: PathSegment[], message: string) => void;
}

/** Convert plain JS values (from third-party parsers) into the data model. */
export function jsToData(value: unknown, opts: JsToDataOptions = {}, path: PathSegment[] = [], depth = 0): DataValue {
  if (depth > 5000) throw new Error('Data nesting too deep');
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case 'boolean':
    case 'number':
    case 'string':
      return value;
    case 'bigint':
      // parsers that read every integer as BigInt (for exactness): narrow the safe ones
      return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
    case 'object':
      break;
    default:
      opts.onLoss?.(path, `Unsupported value of type ${typeof value} converted to string`);
      return String(value);
  }
  if (value instanceof DataDate) return value;
  if (value instanceof Uint8Array) return value;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return String(value);
    return new DataDate(value.toISOString(), 'offset-datetime');
  }
  if (Array.isArray(value)) return value.map((v, i) => jsToData(v, opts, [...path, i], depth + 1));
  if (value instanceof Map) {
    const m: DataObject = new Map();
    for (const [k, v] of value) {
      const key = typeof k === 'string' ? k : String(k);
      if (typeof k !== 'string') opts.onLoss?.([...path, key], `Non-string key ${JSON.stringify(String(k))} converted to a string`);
      m.set(key, jsToData(v, opts, [...path, key], depth + 1));
    }
    return m;
  }
  const m: DataObject = new Map();
  for (const k of Object.keys(value as object)) {
    m.set(k, jsToData((value as Record<string, unknown>)[k], opts, [...path, k], depth + 1));
  }
  return m;
}

export interface DataToJsOptions {
  /** How to represent bigint values. */
  bigint?: 'keep' | 'string';
  /** Mappings as plain objects (default) or Maps. */
  maps?: 'object' | 'map';
  dates?: 'string' | 'keep';
  binary?: 'base64' | 'keep';
}

export function dataToJs(value: DataValue, opts: DataToJsOptions = {}): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'bigint' && opts.bigint === 'string') return value.toString();
    return value;
  }
  if (value instanceof DataDate) return opts.dates === 'keep' ? value : value.iso;
  if (value instanceof Uint8Array) {
    if (opts.binary === 'keep') return value;
    let bin = '';
    for (let i = 0; i < value.length; i++) bin += String.fromCharCode(value[i]);
    return btoa(bin);
  }
  if (Array.isArray(value)) return value.map((v) => dataToJs(v, opts));
  if (opts.maps === 'map') {
    const m = new Map<string, unknown>();
    for (const [k, v] of value) m.set(k, dataToJs(v, opts));
    return m;
  }
  const o: Record<string, unknown> = {};
  for (const [k, v] of value) {
    Object.defineProperty(o, k, { value: dataToJs(v, opts), enumerable: true, writable: true, configurable: true });
  }
  return o;
}

export interface FlattenResult {
  entries: Map<string, DataValue>;
  flattenedPaths: number;
}

/** Flatten nested objects/arrays into dotted keys: { a: { b: [1] } } → { "a.b.0": 1 } */
export function flatten(
  value: DataValue,
  opts: { separator?: string; arrayStyle?: 'dot' | 'bracket' } = {},
): FlattenResult {
  const sep = opts.separator ?? '.';
  const entries = new Map<string, DataValue>();
  let flattenedPaths = 0;
  const walk = (v: DataValue, prefix: string) => {
    if (v instanceof Map) {
      if (v.size === 0 && prefix) {
        entries.set(prefix, '');
        return;
      }
      for (const [k, child] of v) {
        if (prefix) flattenedPaths++;
        walk(child, prefix ? `${prefix}${sep}${k}` : k);
      }
      return;
    }
    if (Array.isArray(v)) {
      if (v.length === 0 && prefix) {
        entries.set(prefix, '');
        return;
      }
      v.forEach((child, i) => {
        flattenedPaths++;
        const key = opts.arrayStyle === 'bracket' ? `${prefix}[${i}]` : prefix ? `${prefix}${sep}${i}` : String(i);
        walk(child, key);
      });
      return;
    }
    entries.set(prefix, v);
  };
  walk(value, '');
  return { entries, flattenedPaths };
}

/**
 * Expand dotted keys into nested objects. Keys whose expansion would collide
 * (`a=1` and `a.b=2`) are kept verbatim and reported as conflicts.
 * Numeric segments create arrays only when they form a dense 0..n-1 sequence.
 */
export function unflatten(entries: Map<string, DataValue>, separator = '.'): { value: DataObject; conflicts: string[] } {
  const root: DataObject = new Map();
  const conflicts: string[] = [];
  for (const [key, val] of entries) {
    const parts = key.split(separator);
    if (parts.length < 2 || parts.some((p) => p === '')) {
      if (root.has(key) && root.get(key) instanceof Map) conflicts.push(key);
      else root.set(key, val);
      continue;
    }
    let node: DataObject = root;
    let ok = true;
    for (let i = 0; i < parts.length - 1; i++) {
      const existing = node.get(parts[i]);
      if (existing === undefined) {
        const child: DataObject = new Map();
        node.set(parts[i], child);
        node = child;
      } else if (existing instanceof Map) {
        node = existing;
      } else {
        ok = false;
        break;
      }
    }
    const last = parts[parts.length - 1];
    if (!ok || node.get(last) instanceof Map) {
      conflicts.push(key);
      root.set(key, val);
      continue;
    }
    node.set(last, val);
  }
  return { value: arrayify(root) as DataObject, conflicts };
}

function arrayify(v: DataValue): DataValue {
  if (!(v instanceof Map)) return v;
  const keys = [...v.keys()];
  if (keys.length > 0 && keys.every((k, i) => k === String(i))) {
    return keys.map((k) => arrayify(v.get(k) as DataValue));
  }
  for (const [k, child] of v) v.set(k, arrayify(child));
  return v;
}

export interface DataStats {
  objects: number;
  arrays: number;
  keys: number;
  scalars: number;
  depth: number;
}

export function dataStats(v: DataValue): DataStats {
  const s: DataStats = { objects: 0, arrays: 0, keys: 0, scalars: 0, depth: 0 };
  const walk = (x: DataValue, d: number) => {
    s.depth = Math.max(s.depth, d);
    if (x instanceof Map) {
      s.objects++;
      s.keys += x.size;
      for (const c of x.values()) walk(c, d + 1);
    } else if (Array.isArray(x)) {
      s.arrays++;
      for (const c of x) walk(c, d + 1);
    } else s.scalars++;
  };
  walk(v, 0);
  return s;
}

/** True if the object has integer-like keys that a JS-object based parser would have reordered. */
export function hasIntegerLikeKeys(v: DataValue): boolean {
  if (v instanceof Map) {
    for (const [k, c] of v) {
      if (/^(?:0|[1-9]\d*)$/.test(k)) return true;
      if (hasIntegerLikeKeys(c)) return true;
    }
  } else if (Array.isArray(v)) return v.some(hasIntegerLikeKeys);
  return false;
}
