import { DESCRIPTORS } from '../../engines/catalog';
import { dataToJs, jsToData } from '../../engines/converters/dataModel';
import { DataDate, type DataValue } from '../../types/data';
import type { Diagnostic } from '../../types/diagnostics';
import type { DetectContext, DetectScore, FormatModule, ModuleContext } from '../../types/module';
import { indentUnit } from '../../types/options';
import { decodeBinaryText, isDecodeError, looksLikeBase64, looksLikeHex, type DecodedBinary } from '../../utils/bytes';
import { diagAt, notice } from '../../utils/diag';
import { stringifyData } from '../json/printer';
import { SAMPLES } from '../samples';

function decodeInput(input: string, ctx: ModuleContext): { bin: DecodedBinary } | { diag: Diagnostic } {
  const d = decodeBinaryText(input);
  if (isDecodeError(d)) {
    return { diag: diagAt(ctx.lines, d.offset, 1, { code: 'binary/encoding', type: 'Invalid binary text', message: d.error, suggestion: 'Paste hexadecimal (e.g. "16 00 00 00 ...") or base64 text, or upload the binary file.', source: 'FormatX' }) };
  }
  return { bin: d };
}

function bytesFacts(bin: DecodedBinary): Record<string, string | number> {
  return { Bytes: bin.bytes.length, 'Text encoding': bin.encoding };
}

// ------------------------------------------------------------------ BSON

interface BsonDocs {
  docs: Record<string, unknown>[];
  error?: { message: string; byte: number };
}

async function readBson(bytes: Uint8Array): Promise<BsonDocs> {
  const { deserialize } = await import('bson');
  const docs: Record<string, unknown>[] = [];
  let pos = 0;
  while (pos < bytes.length) {
    if (bytes.length - pos < 5) return { docs, error: { message: `Truncated data: ${bytes.length - pos} trailing byte(s) cannot form a BSON document (minimum 5 bytes).`, byte: pos } };
    const size = bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16) | (bytes[pos + 3] << 24);
    if (size < 5) return { docs, error: { message: `Document at byte ${pos} declares an invalid size of ${size} bytes.`, byte: pos } };
    if (pos + size > bytes.length) return { docs, error: { message: `Document at byte ${pos} declares ${size} bytes, but only ${bytes.length - pos} remain (truncated or corrupt data).`, byte: pos } };
    try {
      docs.push(deserialize(bytes.subarray(pos, pos + size), { validation: { utf8: true }, useBigInt64: true }) as Record<string, unknown>);
    } catch (e) {
      return { docs, error: { message: `Invalid BSON in document ${docs.length + 1}: ${(e as Error).message}`, byte: pos } };
    }
    pos += size;
  }
  return { docs };
}

const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Relaxed Extended JSON derived from the canonical (lossless) form.
 * Unlike bson's own relaxed mode, int64 values that do not fit a double stay exact (BigInt).
 */
function relaxCanonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(relaxCanonical);
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length === 1) {
      const k = keys[0];
      const x = (v as Record<string, unknown>)[k];
      if (k === '$numberInt' && typeof x === 'string') return Number(x);
      if (k === '$numberDouble' && typeof x === 'string') {
        const n = Number(x);
        return Number.isFinite(n) ? n : v;
      }
      if (k === '$numberLong' && typeof x === 'string') {
        const b = BigInt(x);
        return b >= MIN_SAFE && b <= MAX_SAFE ? Number(b) : b;
      }
      if (k === '$date' && x && typeof x === 'object' && typeof (x as { $numberLong?: unknown }).$numberLong === 'string') {
        const ms = Number((x as { $numberLong: string }).$numberLong);
        // relaxed EJSON uses ISO-8601 strings for years 1970–9999
        return ms >= 0 && ms <= 253402300799999 ? { $date: new Date(ms).toISOString().replace('.000Z', 'Z') } : v;
      }
    }
    const out: Record<string, unknown> = {};
    for (const key of keys) Object.defineProperty(out, key, { value: relaxCanonical((v as Record<string, unknown>)[key]), enumerable: true, writable: true, configurable: true });
    return out;
  }
  return v;
}

async function bsonDocsToPlain(docs: Record<string, unknown>[], relaxed: boolean): Promise<unknown[]> {
  const { EJSON } = await import('bson');
  return docs.map((d) => {
    const canonical = EJSON.serialize(d, { relaxed: false });
    return relaxed ? relaxCanonical(canonical) : canonical;
  });
}

function detectBson(ctx: DetectContext): DetectScore | null {
  if (!looksLikeHex(ctx.trimmed) && !looksLikeBase64(ctx.trimmed)) return null;
  const d = decodeBinaryText(ctx.head);
  if (isDecodeError(d) || d.bytes.length < 5) return null;
  const b = d.bytes;
  const size = b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24);
  if (size === b.length || (size < b.length && size >= 5 && b[size - 1] === 0)) {
    if (b[size - 1] !== 0) return null;
    return { score: ctx.extension === 'bson' ? 0.95 : 0.85, reasons: [`${d.encoding} bytes start with a BSON length header (${size} bytes)`] };
  }
  return null;
}

export const bsonModule: FormatModule = {
  descriptor: DESCRIPTORS.bson,
  sample: SAMPLES.bson,
  detect: detectBson,
  async validate(input, ctx) {
    const r = decodeInput(input, ctx);
    if ('diag' in r) return { diagnostics: [r.diag] };
    const { docs, error } = await readBson(r.bin.bytes);
    const facts = { ...bytesFacts(r.bin), Documents: docs.length };
    if (error) {
      return { diagnostics: [diagAt(ctx.lines, r.bin.byteOffset(error.byte), 2, { code: 'bson/invalid', type: 'Invalid BSON', message: error.message, source: 'bson' })], facts };
    }
    if (docs[0]) Object.assign(facts, { 'Top-level keys': Object.keys(docs[0]).length });
    return { diagnostics: [], facts };
  },
  async beautify(input, ctx) {
    const r = decodeInput(input, ctx);
    if ('diag' in r) throw new Error(r.diag.message);
    const { docs } = await readBson(r.bin.bytes);
    const relaxed = ctx.options.ejsonMode === 'relaxed';
    const plain = await bsonDocsToPlain(docs, relaxed);
    const warnings: Diagnostic[] = [];
    const text = stringifyData(jsToData(plain.length === 1 ? plain[0] : plain), { indent: indentUnit(ctx.options.indent) }, warnings);
    return { text, warnings, outputFormatId: 'json', language: 'json', notes: [`Decoded ${docs.length} document(s) as ${relaxed ? 'relaxed' : 'canonical'} Extended JSON v2.`] };
  },
  async toData(input, ctx) {
    const r = decodeInput(input, ctx);
    if ('diag' in r) throw new Error(r.diag.message);
    const { docs } = await readBson(r.bin.bytes);
    const relaxed = ctx.options.ejsonMode === 'relaxed';
    const plain = await bsonDocsToPlain(docs, relaxed);
    const warnings: Diagnostic[] = [notice({ severity: 'info', code: 'convert/ejson', type: 'Extended JSON', message: `BSON-specific types (ObjectId, Date, Decimal128, Binary...) are represented with Extended JSON wrappers such as {"$oid": ...}${relaxed ? ' (relaxed mode: numbers and dates are simplified)' : ''}.`, source: 'BSON' })];
    return { data: jsToData(plain.length === 1 ? plain[0] : plain), warnings };
  },
  async fromData(data) {
    const { EJSON, serialize } = await import('bson');
    let decimals = 0;
    const toDoc = (v: DataValue) => {
      const js = dataToJs(v, { bigint: 'keep', dates: 'keep', binary: 'keep' });
      // dates from other formats → BSON datetime when they carry a full timestamp;
      // integers beyond int64 → Decimal128 (exact) instead of failing
      const fixDates = (x: unknown): unknown => {
        if (x instanceof DataDate) return x.kind === 'offset-datetime' ? new Date(x.iso) : x.iso;
        if (typeof x === 'bigint') {
          if (x > 2n ** 63n - 1n || x < -(2n ** 63n)) {
            decimals++;
            return { $numberDecimal: x.toString() };
          }
          // EJSON.deserialize cannot take raw BigInts; the $numberLong wrapper is exact
          return { $numberLong: x.toString() };
        }
        if (Array.isArray(x)) return x.map(fixDates);
        if (x && typeof x === 'object' && !(x instanceof Uint8Array) && !(x instanceof Date)) {
          for (const k of Object.keys(x)) (x as Record<string, unknown>)[k] = fixDates((x as Record<string, unknown>)[k]);
        }
        return x;
      };
      // EJSON wrappers ({"$oid": ...}) become real BSON types
      return EJSON.deserialize(fixDates(js) as Record<string, unknown>, { relaxed: false }) as Record<string, unknown>;
    };
    const warnings: Diagnostic[] = [];
    const notes: string[] = [];
    let parts: Uint8Array[];
    if (data instanceof Map) parts = [serialize(toDoc(data))];
    else if (Array.isArray(data) && data.every((d) => d instanceof Map)) {
      parts = data.map((d) => serialize(toDoc(d)));
      notes.push(`Written as a sequence of ${parts.length} BSON documents (mongodump style).`);
    } else throw new Error('BSON requires an object (document) or an array of objects at the root.');
    if (decimals) warnings.push(notice({ severity: 'info', code: 'convert/decimal128', type: 'Large integers', message: `${decimals} integer(s) exceed 64 bits and were stored as Decimal128 to stay exact.`, source: 'BSON writer' }));
    const total = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return { binary: out, warnings, notes };
  },
};

// ------------------------------------------------------------------ MessagePack

async function readMsgpack(bytes: Uint8Array): Promise<{ values: unknown[]; nonStringKeys: number; error?: { message: string; byte: number } }> {
  const { Decoder } = await import('@msgpack/msgpack');
  let nonStringKeys = 0;
  const decoder = new Decoder({
    useBigInt64: true,
    mapKeyConverter: (k: unknown) => {
      if (typeof k === 'string') return k;
      nonStringKeys++;
      return String(k);
    },
  });
  const values: unknown[] = [];
  try {
    for (const v of decoder.decodeMulti(bytes)) values.push(v);
  } catch (e) {
    const pos = (decoder as unknown as { totalPos?: number; pos?: number }).pos ?? 0;
    return { values, nonStringKeys, error: { message: (e as Error).message, byte: Math.min(pos, Math.max(0, bytes.length - 1)) } };
  }
  return { values, nonStringKeys };
}

function msgpackToData(values: unknown[]): DataValue {
  const conv = (v: unknown): unknown => {
    if (v && typeof v === 'object' && 'type' in v && 'data' in v && (v as { data: unknown }).data instanceof Uint8Array && Object.keys(v).length === 2) {
      return { $ext: (v as { type: number }).type, data: (v as { data: Uint8Array }).data };
    }
    if (Array.isArray(v)) return v.map(conv);
    if (v && typeof v === 'object' && !(v instanceof Uint8Array) && !(v instanceof Date)) {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(v)) Object.defineProperty(o, k, { value: conv((v as Record<string, unknown>)[k]), enumerable: true, writable: true, configurable: true });
      return o;
    }
    return v;
  };
  const data = values.map((v) => jsToData(conv(v)));
  return data.length === 1 ? data[0] : data;
}

function detectMsgpack(ctx: DetectContext): DetectScore | null {
  if (ctx.extension === 'msgpack' || ctx.extension === 'mpk') return { score: 0.9, reasons: ['File extension'] };
  return null;
}

export const msgpackModule: FormatModule = {
  descriptor: DESCRIPTORS.msgpack,
  sample: SAMPLES.msgpack,
  detect: detectMsgpack,
  async validate(input, ctx) {
    const r = decodeInput(input, ctx);
    if ('diag' in r) return { diagnostics: [r.diag] };
    const { values, error, nonStringKeys } = await readMsgpack(r.bin.bytes);
    const facts: Record<string, string | number> = { ...bytesFacts(r.bin), Values: values.length };
    const diagnostics: Diagnostic[] = [];
    if (error) diagnostics.push(diagAt(ctx.lines, r.bin.byteOffset(error.byte), 2, { code: 'msgpack/invalid', type: 'Invalid MessagePack', message: error.message, source: '@msgpack/msgpack' }));
    if (nonStringKeys) diagnostics.push({ severity: 'info', code: 'msgpack/non-string-keys', type: 'Non-string keys', message: `${nonStringKeys} map key(s) are not strings; they are shown as strings.`, source: '@msgpack/msgpack' });
    if (!error && values.length === 0) diagnostics.push(diagAt(ctx.lines, 0, 1, { code: 'msgpack/empty', type: 'No data', message: 'No MessagePack values found.', source: '@msgpack/msgpack' }));
    return { diagnostics, facts };
  },
  async beautify(input, ctx) {
    const r = decodeInput(input, ctx);
    if ('diag' in r) throw new Error(r.diag.message);
    const { values } = await readMsgpack(r.bin.bytes);
    const warnings: Diagnostic[] = [];
    const text = stringifyData(msgpackToData(values), { indent: indentUnit(ctx.options.indent) }, warnings);
    return { text, warnings, outputFormatId: 'json', language: 'json', notes: [`Decoded ${values.length} value(s).`] };
  },
  async toData(input, ctx) {
    const r = decodeInput(input, ctx);
    if ('diag' in r) throw new Error(r.diag.message);
    const { values, nonStringKeys } = await readMsgpack(r.bin.bytes);
    const warnings: Diagnostic[] = [];
    if (nonStringKeys) warnings.push(notice({ code: 'convert/non-string-key', type: 'Keys converted', message: `${nonStringKeys} non-string map key(s) were converted to strings.`, source: 'MessagePack' }));
    if (values.length > 1) warnings.push(notice({ code: 'convert/multi-value', type: 'Multiple values', message: `The stream contains ${values.length} values; they were combined into an array.`, source: 'MessagePack' }));
    return { data: msgpackToData(values), warnings };
  },
  async fromData(data) {
    const { encode } = await import('@msgpack/msgpack');
    const warnings: Diagnostic[] = [];
    let tooBig = 0;
    const fix = (v: DataValue): unknown => {
      if (v instanceof DataDate) return v.kind === 'offset-datetime' ? new Date(v.iso) : v.iso;
      if (Array.isArray(v)) return v.map(fix);
      if (typeof v === 'bigint' && (v > 2n ** 64n - 1n || v < -(2n ** 63n))) {
        tooBig++;
        return v.toString();
      }
      if (v instanceof Map) {
        // @msgpack/msgpack encodes plain objects as maps (Map instances are not supported)
        const o: Record<string, unknown> = {};
        for (const [k, x] of v) Object.defineProperty(o, k, { value: fix(x), enumerable: true, writable: true, configurable: true });
        return o;
      }
      return v;
    };
    const value = fix(data);
    if (tooBig) warnings.push(notice({ code: 'convert/int-out-of-range', type: 'Integer out of range', message: `${tooBig} integer(s) do not fit in 64 bits and were written as strings.`, source: 'MessagePack writer' }));
    return { binary: encode(value, { useBigInt64: true }), warnings };
  },
};
