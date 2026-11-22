import { isMap, isScalar, isSeq, parseDocument, type Node as YamlNode } from 'yaml';
import type { Diagnostic } from '../../types/diagnostics';
import type { ModuleContext } from '../../types/module';
import { diagAt, type DiagInit } from '../../utils/diag';
import { JsonParser, type JsonVisitor } from '../json/parser';
import type { Token } from '../json/scanner';
import { yamlModule } from '../yaml';
import { jsonModule } from '../json';

export type PathSeg = string | number;

interface PNodeBase {
  start: number;
  end: number;
}
type PNode =
  | (PNodeBase & { type: 'object'; entries: Map<string, { keyStart: number; keyEnd: number; value: PNode }> })
  | (PNodeBase & { type: 'array'; items: PNode[] })
  | (PNodeBase & { type: 'literal' });

/** Builds a position tree for a JSON document (offsets of every key and value). */
class PositionBuilder implements JsonVisitor {
  root: PNode | null = null;
  private stack: PNode[] = [];
  private keys: { name: string; start: number; end: number }[] = [];
  objectStart(start: number): void {
    this.stack.push({ type: 'object', start, end: start, entries: new Map() });
    this.keys.push({ name: '', start, end: start });
  }
  objectEnd(end: number): void {
    const n = this.stack.pop()!;
    n.end = end;
    this.keys.pop();
    this.add(n);
  }
  arrayStart(start: number): void {
    this.stack.push({ type: 'array', start, end: start, items: [] });
    this.keys.push({ name: '', start, end: start });
  }
  arrayEnd(end: number): void {
    const n = this.stack.pop()!;
    n.end = end;
    this.keys.pop();
    this.add(n);
  }
  key(name: string, _raw: string, start: number, end: number): void {
    this.keys[this.keys.length - 1] = { name, start, end };
  }
  literal(t: Token): void {
    this.add({ type: 'literal', start: t.start, end: t.end });
  }
  missingValue(): void {
    this.add({ type: 'literal', start: 0, end: 0 });
  }
  private add(n: PNode): void {
    const top = this.stack[this.stack.length - 1];
    if (!top) {
      this.root = n;
      return;
    }
    if (top.type === 'object') {
      const k = this.keys[this.keys.length - 1];
      top.entries.set(k.name, { keyStart: k.start, keyEnd: k.end, value: n });
    } else if (top.type === 'array') top.items.push(n);
  }
}

export interface StructuredDoc {
  syntax: 'json' | 'yaml';
  data: unknown;
  /** Diagnostics from the syntax layer (JSON/YAML errors). */
  syntaxDiagnostics: Diagnostic[];
  /** Offset range of the key (or value) at a data path; falls back to the closest ancestor. */
  locate(path: readonly PathSeg[], part?: 'key' | 'value'): { offset: number; length: number };
}

export function detectSyntax(input: string): 'json' | 'yaml' {
  const t = input.trimStart();
  return t.startsWith('{') || t.startsWith('[') ? 'json' : 'yaml';
}

export async function parseStructured(input: string, ctx: ModuleContext): Promise<StructuredDoc> {
  const syntax = detectSyntax(input);
  if (syntax === 'json') {
    const syntaxDiagnostics = (await jsonModule.validate(input, ctx)).diagnostics.filter((d) => d.severity === 'error');
    const builder = new PositionBuilder();
    new JsonParser(input, 'json', ctx.lines, builder).parse();
    let data: unknown = null;
    if (!syntaxDiagnostics.length) {
      try {
        data = JSON.parse(input);
      } catch {
        data = null;
      }
    }
    const root = builder.root;
    return {
      syntax,
      data,
      syntaxDiagnostics,
      locate(path, part = 'key') {
        let node: PNode | null = root;
        let best = { offset: node?.start ?? 0, length: 1 };
        for (let i = 0; i < path.length && node; i++) {
          const seg = path[i];
          const last = i === path.length - 1;
          if (node.type === 'object' && typeof seg === 'string') {
            const e = node.entries.get(seg);
            if (!e) break;
            best = last && part === 'key' ? { offset: e.keyStart, length: e.keyEnd - e.keyStart } : { offset: e.value.start, length: Math.max(1, Math.min(e.value.end - e.value.start, 200)) };
            node = e.value;
          } else if (node.type === 'array' && typeof seg === 'number') {
            const item = node.items[seg];
            if (!item) break;
            best = { offset: item.start, length: Math.max(1, Math.min(item.end - item.start, 200)) };
            node = item;
          } else break;
        }
        return best;
      },
    };
  }
  const syntaxDiagnostics = (await yamlModule.validate(input, ctx)).diagnostics.filter((d) => d.severity === 'error');
  const doc = parseDocument(input, { prettyErrors: false, uniqueKeys: true });
  let data: unknown = null;
  if (!syntaxDiagnostics.length) {
    try {
      data = doc.toJS({ maxAliasCount: 1000 });
    } catch {
      data = null;
    }
  }
  return {
    syntax,
    data,
    syntaxDiagnostics,
    locate(path, part = 'key') {
      let node: unknown = doc.contents;
      const range = (n: unknown) => {
        const r = (n as YamlNode | null)?.range;
        return r ? { offset: r[0], length: Math.max(1, Math.min(r[1] - r[0], 200)) } : null;
      };
      let best = range(node) ?? { offset: 0, length: 1 };
      for (let i = 0; i < path.length; i++) {
        const seg = path[i];
        const last = i === path.length - 1;
        if (isMap(node)) {
          const pair = node.items.find((p) => isScalar(p.key) && String(p.key.value) === String(seg));
          if (!pair) break;
          best = (last && part === 'key' ? range(pair.key) : range(pair.value) ?? range(pair.key)) ?? best;
          node = pair.value;
        } else if (isSeq(node) && typeof seg === 'number') {
          const item = node.items[seg];
          if (!item) break;
          best = range(item) ?? best;
          node = item;
        } else break;
      }
      return best;
    },
  };
}

/** Helper to emit a diagnostic at a data path. */
export function reporterFor(doc: StructuredDoc, ctx: ModuleContext, source: string, out: Diagnostic[]) {
  return (path: readonly PathSeg[], init: Omit<DiagInit, 'source'>, part: 'key' | 'value' = 'key') => {
    if (out.length > 400) return;
    const loc = doc.locate(path, part);
    out.push(diagAt(ctx.lines, loc.offset, loc.length, { ...init, source }));
  };
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Resolve a local JSON pointer ("#/components/schemas/Pet") inside a document. */
export function resolvePointer(root: unknown, ref: string): { found: boolean; value?: unknown } {
  if (ref === '#') return { found: true, value: root };
  if (!ref.startsWith('#/')) return { found: false };
  let cur: unknown = root;
  for (const raw of ref.slice(2).split('/')) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    } catch {
      return { found: false };
    }
    if (Array.isArray(cur)) {
      const i = Number(seg);
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) return { found: false };
      cur = cur[i];
    } else if (isObject(cur) && Object.prototype.hasOwnProperty.call(cur, seg)) cur = cur[seg];
    else return { found: false };
  }
  return { found: true, value: cur };
}

/** Walk every value with its path. */
export function walk(value: unknown, fn: (v: unknown, path: PathSeg[]) => void, path: PathSeg[] = [], depth = 0): void {
  if (depth > 200) return;
  fn(value, path);
  if (Array.isArray(value)) value.forEach((v, i) => walk(v, fn, [...path, i], depth + 1));
  else if (isObject(value)) for (const k of Object.keys(value)) walk(value[k], fn, [...path, k], depth + 1);
}
