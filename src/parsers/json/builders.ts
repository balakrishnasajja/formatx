import type { DataObject, DataValue } from '../../types/data';
import { numberLosesPrecision, parseIntegerLiteral, type PathSegment } from '../../engines/converters/dataModel';
import type { JsonVisitor } from './parser';
import { NF_FRACTION_OR_EXP, NF_HEX, NF_INFINITY, NF_NAN, type Token } from './scanner';

/** Convert a number token to an exact JS value (BigInt for unsafe integers). */
export function numberTokenValue(t: Token, raw: string): { value: number | bigint; lossy: boolean } {
  const f = t.numFlags ?? 0;
  const neg = raw.startsWith('-');
  const body = raw.replace(/^[+-]/, '');
  if (f & NF_INFINITY) return { value: neg ? -Infinity : Infinity, lossy: false };
  if (f & NF_NAN) return { value: NaN, lossy: false };
  if (f & NF_HEX) {
    const v = BigInt(body);
    const signed = neg ? -v : v;
    const asNum = Number(signed);
    return { value: Number.isSafeInteger(asNum) ? asNum : signed, lossy: false };
  }
  if (!(f & NF_FRACTION_OR_EXP)) {
    const v = parseIntegerLiteral((neg ? '-' : '') + body.replace(/^0+(?=\d)/, ''));
    return { value: v, lossy: false };
  }
  const n = Number(raw);
  return { value: n, lossy: numberLosesPrecision(raw.replace(/^\+/, '')) };
}

/** Builds the neutral data model while parsing. Duplicate keys: last value wins (like JSON.parse). */
export class DataBuilder implements JsonVisitor {
  root: DataValue = null;
  readonly losses: { path: PathSegment[]; raw: string }[] = [];
  private readonly stack: (DataObject | DataValue[])[] = [];
  private readonly keyStack: string[] = [];

  objectStart(): void {
    this.stack.push(new Map());
    this.keyStack.push('');
  }
  objectEnd(): void {
    const v = this.stack.pop() as DataObject;
    this.keyStack.pop();
    this.add(v);
  }
  arrayStart(): void {
    this.stack.push([]);
    this.keyStack.push('');
  }
  arrayEnd(): void {
    const v = this.stack.pop() as DataValue[];
    this.keyStack.pop();
    this.add(v);
  }
  key(name: string): void {
    this.keyStack[this.keyStack.length - 1] = name;
  }
  literal(t: Token, raw: string): void {
    switch (t.kind) {
      case 'string':
        this.add(t.value ?? '');
        return;
      case 'number': {
        const { value, lossy } = numberTokenValue(t, raw);
        if (lossy && this.losses.length < 50) this.losses.push({ path: this.currentPath(), raw });
        this.add(value);
        return;
      }
      case 'ident':
        this.add(raw === 'true' ? true : raw === 'false' ? false : raw === 'Infinity' ? Infinity : raw === 'NaN' ? NaN : null);
        return;
      default:
        this.add(null);
    }
  }
  missingValue(): void {
    this.add(null);
  }

  private add(v: DataValue): void {
    const top = this.stack[this.stack.length - 1];
    if (!top) {
      this.root = v;
      return;
    }
    if (top instanceof Map) top.set(this.keyStack[this.keyStack.length - 1], v);
    else top.push(v);
  }

  private currentPath(): PathSegment[] {
    const path: PathSegment[] = [];
    for (let i = 0; i < this.stack.length; i++) {
      const s = this.stack[i];
      path.push(s instanceof Map ? this.keyStack[i] : s.length);
    }
    return path;
  }
}

export type JsonAst =
  | { t: 'o'; members: { rawKey: string; key: string; value: JsonAst }[] }
  | { t: 'a'; items: JsonAst[] }
  | { t: 'l'; raw: string };

/** Builds a raw-preserving AST (used for key sorting). */
export class AstBuilder implements JsonVisitor {
  root: JsonAst | null = null;
  private readonly stack: JsonAst[] = [];
  private readonly pending: { rawKey: string; key: string }[] = [];

  objectStart(): void {
    this.stack.push({ t: 'o', members: [] });
    this.pending.push({ rawKey: '', key: '' });
  }
  objectEnd(): void {
    this.pending.pop();
    this.add(this.stack.pop() as JsonAst);
  }
  arrayStart(): void {
    this.stack.push({ t: 'a', items: [] });
    this.pending.push({ rawKey: '', key: '' });
  }
  arrayEnd(): void {
    this.pending.pop();
    this.add(this.stack.pop() as JsonAst);
  }
  key(name: string, raw: string): void {
    this.pending[this.pending.length - 1] = { rawKey: raw, key: name };
  }
  literal(_t: Token, raw: string): void {
    this.add({ t: 'l', raw });
  }
  missingValue(): void {
    this.add({ t: 'l', raw: 'null' });
  }
  private add(node: JsonAst): void {
    const top = this.stack[this.stack.length - 1];
    if (!top) {
      this.root = node;
      return;
    }
    if (top.t === 'o') {
      const p = this.pending[this.pending.length - 1];
      top.members.push({ rawKey: p.rawKey, key: p.key, value: node });
    } else if (top.t === 'a') top.items.push(node);
  }
}
