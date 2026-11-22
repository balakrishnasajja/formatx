/**
 * Comment-preserving TOML formatter.
 *
 * A small context-aware lexer feeds a statement parser that understands the
 * TOML grammar (tables, array tables, dotted keys, arrays with comments,
 * inline tables, multi-line strings). Only layout changes; every literal is
 * copied verbatim and the engine re-parses the result to prove the data is
 * identical.
 */
type Tok =
  | { t: 'nl' }
  | { t: 'comment'; v: string }
  | { t: 'p'; v: '[' | ']' | '[[' | ']]' | '{' | '}' | '=' | ',' | '.' }
  | { t: 'str'; v: string }
  | { t: 'atom'; v: string };

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  const stack: ('array' | 'inline' | 'header')[] = [];
  let keyCtx = true;
  let headerDouble = false;
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c.charCodeAt(0) === 0xfeff) {
      i++;
      continue;
    }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      i++;
      out.push({ t: 'nl' });
      if (stack.length === 0) keyCtx = true;
      continue;
    }
    if (c === '#') {
      let e = i;
      while (e < n && src[e] !== '\n' && src[e] !== '\r') e++;
      out.push({ t: 'comment', v: src.slice(i, e).trimEnd() });
      i = e;
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = src.startsWith(c.repeat(3), i);
      let e: number;
      if (triple) {
        e = i + 3;
        for (;;) {
          if (e >= n) throw new Error('Unterminated multi-line string');
          if (c === '"' && src[e] === '\\') {
            e += 2;
            continue;
          }
          if (src.startsWith(c.repeat(3), e)) {
            let run = 3;
            while (src[e + run] === c && run < 5) run++;
            e += run;
            break;
          }
          e++;
        }
      } else {
        e = i + 1;
        for (;;) {
          if (e >= n || src[e] === '\n') throw new Error('Unterminated string');
          if (c === '"' && src[e] === '\\') {
            e += 2;
            continue;
          }
          if (src[e] === c) {
            e++;
            break;
          }
          e++;
        }
      }
      out.push({ t: 'str', v: src.slice(i, e) });
      i = e;
      continue;
    }
    if (c === '[') {
      if (keyCtx && stack.length === 0) {
        headerDouble = src[i + 1] === '[';
        if (headerDouble) {
          out.push({ t: 'p', v: '[[' });
          i += 2;
        } else {
          out.push({ t: 'p', v: '[' });
          i++;
        }
        stack.push('header');
      } else {
        out.push({ t: 'p', v: '[' });
        stack.push('array');
        keyCtx = false;
        i++;
      }
      continue;
    }
    if (c === ']') {
      const top = stack.pop();
      if (top === 'header') {
        if (headerDouble && src[i + 1] === ']') {
          out.push({ t: 'p', v: ']]' });
          i += 2;
        } else {
          out.push({ t: 'p', v: ']' });
          i++;
        }
        keyCtx = false;
        continue;
      }
      out.push({ t: 'p', v: ']' });
      i++;
      continue;
    }
    if (c === '{') {
      stack.push('inline');
      keyCtx = true;
      out.push({ t: 'p', v: '{' });
      i++;
      continue;
    }
    if (c === '}') {
      stack.pop();
      keyCtx = false;
      out.push({ t: 'p', v: '}' });
      i++;
      continue;
    }
    if (c === '=') {
      keyCtx = false;
      out.push({ t: 'p', v: '=' });
      i++;
      continue;
    }
    if (c === ',') {
      if (stack[stack.length - 1] === 'inline') keyCtx = true;
      out.push({ t: 'p', v: ',' });
      i++;
      continue;
    }
    if (c === '.' && keyCtx) {
      out.push({ t: 'p', v: '.' });
      i++;
      continue;
    }
    let e = i;
    while (e < n) {
      const ch = src[e];
      if (' \t\r\n#,[]{}="\''.includes(ch) || (keyCtx && ch === '.')) break;
      e++;
    }
    if (e === i) throw new Error(`Unexpected character '${c}'`);
    let atom = src.slice(i, e);
    // local date-time written with a space: 1979-05-27 07:32:00
    if (!keyCtx && DATE_ONLY.test(atom) && src[e] === ' ' && /\d/.test(src[e + 1] ?? '')) {
      let f = e + 1;
      while (f < n && !' \t\r\n#,[]{}="\''.includes(src[f])) f++;
      atom = src.slice(i, f);
      e = f;
    }
    out.push({ t: 'atom', v: atom });
    i = e;
  }
  return out;
}

type Value =
  | { k: 'atom'; v: string }
  | { k: 'array'; items: ArrayItem[]; trailing: string[]; multiline: boolean }
  | { k: 'inline'; entries: { key: string; value: Value }[] };

interface ArrayItem {
  before: string[];
  value: Value;
  after?: string;
}

type Stmt =
  | { k: 'blank' }
  | { k: 'comment'; v: string }
  | { k: 'table'; header: string; comment?: string }
  | { k: 'kv'; key: string; value: Value; comment?: string };

class TomlStatementParser {
  private i = 0;
  private readonly toks: Tok[];
  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  private peek(): Tok | undefined {
    return this.toks[this.i];
  }
  private next(): Tok | undefined {
    return this.toks[this.i++];
  }
  private isP(t: Tok | undefined, v: string): boolean {
    return !!t && t.t === 'p' && t.v === v;
  }

  parse(): Stmt[] {
    const out: Stmt[] = [];
    let lineHasContent = false;
    while (this.i < this.toks.length) {
      const t = this.peek()!;
      if (t.t === 'nl') {
        this.next();
        if (!lineHasContent) out.push({ k: 'blank' });
        lineHasContent = false;
        continue;
      }
      lineHasContent = true;
      if (t.t === 'comment') {
        this.next();
        out.push({ k: 'comment', v: t.v });
        continue;
      }
      if (this.isP(t, '[') || this.isP(t, '[[')) {
        const open = (this.next() as { v: string }).v;
        const key = this.readKey(open === '[[' ? ']]' : ']');
        this.next(); // closer
        const header = open === '[[' ? `[[${key}]]` : `[${key}]`;
        const c = this.peek();
        let comment: string | undefined;
        if (c && c.t === 'comment') {
          comment = c.v;
          this.next();
        }
        out.push({ k: 'table', header, comment });
        continue;
      }
      const key = this.readKey('=');
      if (!this.isP(this.next(), '=')) throw new Error(`Expected '=' after key ${key}`);
      const value = this.readValue();
      const c = this.peek();
      let comment: string | undefined;
      if (c && c.t === 'comment') {
        comment = c.v;
        this.next();
      }
      out.push({ k: 'kv', key, value, comment });
    }
    return out;
  }

  /** Reads a (dotted) key up to the given terminator, normalising whitespace around dots. */
  private readKey(terminator: string): string {
    const parts: string[] = [];
    for (;;) {
      const t = this.peek();
      if (!t) throw new Error('Unexpected end of input in key');
      if (t.t === 'p' && t.v === terminator) break;
      if (t.t === 'p' && t.v === '.') {
        this.next();
        continue;
      }
      if (t.t === 'atom' || t.t === 'str') {
        parts.push(t.v);
        this.next();
        continue;
      }
      throw new Error(`Unexpected token in key`);
    }
    return parts.join('.');
  }

  private readValue(): Value {
    const t = this.next();
    if (!t) throw new Error('Missing value');
    if (t.t === 'str' || t.t === 'atom') return { k: 'atom', v: t.v };
    if (this.isP(t, '[')) return this.readArray();
    if (this.isP(t, '{')) return this.readInline();
    throw new Error('Unexpected token in value');
  }

  private readArray(): Value {
    const items: ArrayItem[] = [];
    let pending: string[] = [];
    let multiline = false;
    for (;;) {
      const t = this.peek();
      if (!t) throw new Error('Unterminated array');
      if (t.t === 'nl') {
        multiline = true;
        this.next();
        continue;
      }
      if (t.t === 'comment') {
        multiline = true;
        pending.push(t.v);
        this.next();
        continue;
      }
      if (this.isP(t, ']')) {
        this.next();
        break;
      }
      if (this.isP(t, ',')) {
        this.next();
        continue;
      }
      const value = this.readValue();
      const item: ArrayItem = { before: pending, value };
      pending = [];
      if (this.isP(this.peek(), ',')) this.next();
      const c = this.peek();
      if (c && c.t === 'comment') {
        item.after = c.v;
        multiline = true;
        this.next();
      }
      items.push(item);
    }
    return { k: 'array', items, trailing: pending, multiline };
  }

  private readInline(): Value {
    const entries: { key: string; value: Value }[] = [];
    for (;;) {
      const t = this.peek();
      if (!t) throw new Error('Unterminated inline table');
      if (this.isP(t, '}')) {
        this.next();
        break;
      }
      if (this.isP(t, ',') || t.t === 'nl') {
        this.next();
        continue;
      }
      const key = this.readKey('=');
      this.next();
      entries.push({ key, value: this.readValue() });
    }
    return { k: 'inline', entries };
  }
}

export interface TomlPrintOptions {
  indent: string;
  printWidth: number;
  minify: boolean;
}

function printValue(v: Value, level: number, o: TomlPrintOptions, startCol: number): string {
  if (v.k === 'atom') return v.v;
  if (v.k === 'inline') {
    if (v.entries.length === 0) return '{}';
    const sep = o.minify ? '=' : ' = ';
    const body = v.entries.map((e) => `${e.key}${sep}${printValue(e.value, level, { ...o, printWidth: Infinity }, 0)}`).join(o.minify ? ',' : ', ');
    return o.minify ? `{${body}}` : `{ ${body} }`;
  }
  if (v.items.length === 0 && v.trailing.length === 0) return '[]';
  const hasComments = v.trailing.length > 0 || v.items.some((i) => i.before.length || i.after);
  if (o.minify && !hasComments) {
    return '[' + v.items.map((i) => printValue(i.value, level, o, 0)).join(',') + ']';
  }
  const inline = '[' + v.items.map((i) => printValue(i.value, level, { ...o, printWidth: Infinity }, 0)).join(', ') + ']';
  const fits = !inline.includes('\n') && startCol + inline.length <= o.printWidth;
  if (!hasComments && !v.multiline && fits) return inline;
  if (o.minify) {
    // minify keeps arrays on one line; comments were already stripped by the caller
    return '[' + v.items.map((i) => printValue(i.value, level, o, 0)).join(',') + ']';
  }
  const pad = o.indent.repeat(level + 1);
  const lines: string[] = ['['];
  for (const item of v.items) {
    for (const c of item.before) lines.push(pad + c);
    lines.push(pad + printValue(item.value, level + 1, o, pad.length) + ',' + (item.after ? ' ' + item.after : ''));
  }
  for (const c of v.trailing) lines.push(pad + c);
  lines.push(o.indent.repeat(level) + ']');
  return lines.join('\n');
}

function stripComments(v: Value): Value {
  if (v.k === 'array') return { k: 'array', items: v.items.map((i) => ({ before: [], value: stripComments(i.value) })), trailing: [], multiline: false };
  if (v.k === 'inline') return { k: 'inline', entries: v.entries.map((e) => ({ key: e.key, value: stripComments(e.value) })) };
  return v;
}

export function formatToml(src: string, o: TomlPrintOptions): { text: string; comments: number } {
  const stmts = new TomlStatementParser(lex(src)).parse();
  const lines: string[] = [];
  let comments = 0;
  const countComments = (v: Value): number =>
    v.k === 'array' ? v.trailing.length + v.items.reduce((s, i) => s + i.before.length + (i.after ? 1 : 0) + countComments(i.value), 0) : v.k === 'inline' ? v.entries.reduce((s, e) => s + countComments(e.value), 0) : 0;

  for (const s of stmts) {
    switch (s.k) {
      case 'blank':
        if (!o.minify && lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
        break;
      case 'comment':
        comments++;
        if (!o.minify) lines.push(s.v);
        break;
      case 'table': {
        if (s.comment) comments++;
        if (!o.minify) {
          // blank line before a table header (and before the comment block attached to it)
          let k = lines.length;
          while (k > 0 && lines[k - 1].startsWith('#')) k--;
          if (k > 0 && lines[k - 1] !== '') lines.splice(k, 0, '');
        }
        lines.push(s.header + (s.comment && !o.minify ? ' ' + s.comment : ''));
        break;
      }
      case 'kv': {
        if (s.comment) comments++;
        comments += countComments(s.value);
        const sep = o.minify ? '=' : ' = ';
        const prefix = s.key + sep;
        const value = o.minify ? printValue(stripComments(s.value), 0, o, 0) : printValue(s.value, 0, o, prefix.length);
        lines.push(prefix + value + (s.comment && !o.minify ? ' ' + s.comment : ''));
        break;
      }
    }
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  while (lines.length && lines[0] === '') lines.shift();
  return { text: lines.join('\n'), comments };
}
