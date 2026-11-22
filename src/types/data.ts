/**
 * Neutral data model used for conversions between data formats.
 *
 * Plain JS objects are deliberately NOT used for mappings: they reorder
 * integer-like keys ("2" before "b") and treat `__proto__` specially.
 * `Map` preserves insertion order and accepts any string key.
 */
export type DataValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | DataDate
  | Uint8Array
  | DataValue[]
  | DataObject;

export type DataObject = Map<string, DataValue>;

export type DataDateKind = 'offset-datetime' | 'local-datetime' | 'local-date' | 'local-time';

/** A date/time value that remembers its textual (ISO 8601 / RFC 3339) form and precision. */
export class DataDate {
  readonly iso: string;
  readonly kind: DataDateKind;
  constructor(iso: string, kind: DataDateKind) {
    this.iso = iso;
    this.kind = kind;
  }
  toString(): string {
    return this.iso;
  }
}

export function isDataObject(v: DataValue): v is DataObject {
  return v instanceof Map;
}

export function isDataArray(v: DataValue): v is DataValue[] {
  return Array.isArray(v);
}

export function isScalar(v: DataValue): boolean {
  return !(v instanceof Map) && !Array.isArray(v);
}

export function dataTypeName(v: DataValue): string {
  if (v === null) return 'null';
  if (v instanceof Map) return 'object';
  if (Array.isArray(v)) return 'array';
  if (v instanceof DataDate) return 'date';
  if (v instanceof Uint8Array) return 'binary';
  if (typeof v === 'bigint') return 'integer';
  return typeof v;
}
