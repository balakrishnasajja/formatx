import { DESCRIPTORS } from '../../engines/catalog';
import type { Diagnostic } from '../../types/diagnostics';
import type { DetectContext, DetectScore, FormatModule, ModuleContext } from '../../types/module';
import { indentUnit } from '../../types/options';
import { diagAt } from '../../utils/diag';
import { escapeRegExp } from '../../utils/text';
import { SAMPLES } from '../samples';

type Protobuf = typeof import('protobufjs');
let pbPromise: Promise<Protobuf> | null = null;
function loadProtobuf(): Promise<Protobuf> {
  pbPromise ??= import('protobufjs').then((m) => ((m as unknown as { default?: Protobuf }).default ?? m) as Protobuf);
  return pbPromise;
}

interface ProtoAnalysis {
  diagnostics: Diagnostic[];
  facts: Record<string, string | number>;
  root?: import('protobufjs').Root;
}

/** Find the first occurrence of a word on a line (or in the document) for positioning. */
function locateWord(ctx: ModuleContext, word: string, line?: number): { offset: number; length: number } {
  const text = ctx.lines.text;
  const re = new RegExp(`(?<![\\w.])${escapeRegExp(word)}(?![\\w])`);
  if (line) {
    const start = ctx.lines.lineStart(line);
    const m = re.exec(ctx.lines.lineText(line));
    if (m) return { offset: start + m.index, length: word.length };
    return { offset: start, length: Math.max(1, ctx.lines.lineText(line).length) };
  }
  const m = re.exec(text);
  return m ? { offset: m.index, length: word.length } : { offset: 0, length: 1 };
}

async function analyzeProto(input: string, ctx: ModuleContext): Promise<ProtoAnalysis> {
  const pb = await loadProtobuf();
  const diagnostics: Diagnostic[] = [];
  let parsed: import('protobufjs').IParserResult;
  try {
    parsed = pb.parse(input, { keepCase: true, alternateCommentMode: true });
  } catch (e) {
    const msg = (e as Error).message;
    const lineM = /line (\d+)/.exec(msg);
    const tokenM = /'([^']+)'/.exec(msg);
    const line = lineM ? Number(lineM[1]) : 1;
    const loc = tokenM ? locateWord(ctx, tokenM[1], line) : { offset: ctx.lines.lineStart(line), length: 1 };
    const clean = msg.replace(/\s*\(line \d+\)/, '').replace(/^illegal/, 'Illegal');
    const suggestion = /illegal token/i.test(msg) ? "Check for a missing ';', '=' or brace near this token." : undefined;
    diagnostics.push(diagAt(ctx.lines, loc.offset, loc.length, { code: 'protobuf/syntax-error', type: 'Syntax error', message: clean, suggestion, source: 'protobufjs' }));
    return { diagnostics, facts: {} };
  }
  const root = parsed.root;
  // namespaces declared by this file (well-known imports added below are not counted)
  const ownNamespaces = new Set(root.nestedArray.map((n) => n.name));
  // protobufjs 8 no longer reports the syntax/edition, so read the declaration from the source
  const syntaxDecl = /^\s*(?:syntax\s*=\s*["'](proto[23])["']|edition\s*=\s*["'](\d+)["'])\s*;/m.exec(input.replace(/\/\/.*$/gm, ''));
  const syntax = syntaxDecl ? (syntaxDecl[1] ?? `edition ${syntaxDecl[2]}`) : undefined;
  // make well-known Google types available for imports such as google/protobuf/timestamp.proto
  for (const imp of [...(parsed.imports ?? []), ...(parsed.weakImports ?? [])]) {
    const common = pb.common.get(imp);
    if (common) {
      try {
        root.addJSON(common.nested ?? {});
      } catch {
        /* already present */
      }
    }
  }
  const unresolvedImports = (parsed.imports ?? []).filter((i) => !pb.common.get(i));
  if (!syntax) {
    diagnostics.push(diagAt(ctx.lines, 0, 1, { severity: 'warning', code: 'protobuf/no-syntax', type: 'Missing syntax', message: 'No syntax declaration: protoc assumes proto2.', suggestion: 'Add syntax = "proto3"; (or "proto2") as the first statement.', source: 'FormatX' }));
  }
  // resolve all types (reports unknown types); unresolved imports downgrade to info
  try {
    root.resolveAll();
  } catch (e) {
    const msg = (e as Error).message;
    const typeM = /no such type: ([\w.]+)/.exec(msg);
    const loc = typeM ? locateWord(ctx, typeM[1]) : { offset: 0, length: 1 };
    const fromImport = unresolvedImports.length > 0;
    diagnostics.push(
      diagAt(ctx.lines, loc.offset, loc.length, {
        severity: fromImport ? 'info' : 'error',
        code: 'protobuf/unresolved-type',
        type: 'Unknown type',
        message: fromImport ? `${msg.split(' in ')[0]} — it may be defined in an imported file (${unresolvedImports.join(', ')}), which is not loaded.` : msg,
        source: 'protobufjs',
      }),
    );
  }
  let messages = 0;
  let enums = 0;
  let services = 0;
  let rpcs = 0;
  let fields = 0;
  const proto3 = syntax === 'proto3';
  const walk = (list: readonly import('protobufjs').ReflectionObject[]) => {
    for (const obj of list) {
      if (obj instanceof pb.Type) {
        messages++;
        if (!/^[A-Z][A-Za-z0-9]*$/.test(obj.name)) {
          const l = locateWord(ctx, obj.name);
          diagnostics.push(diagAt(ctx.lines, l.offset, l.length, { severity: 'info', code: 'protobuf/message-name', type: 'Style', message: `Message "${obj.name}" should be PascalCase (Protocol Buffers style guide).`, source: 'FormatX' }));
        }
        for (const f of obj.fieldsArray) {
          fields++;
          const fl = () => locateWord(ctx, f.name);
          if (f.id >= 19000 && f.id <= 19999) {
            const l = fl();
            diagnostics.push(diagAt(ctx.lines, l.offset, l.length, { code: 'protobuf/reserved-number', type: 'Reserved field number', message: `Field number ${f.id} is in the range 19000–19999 reserved by the Protocol Buffers implementation.`, source: 'FormatX' }));
          }
          if (f.id < 1 || f.id > 536870911) {
            const l = fl();
            diagnostics.push(diagAt(ctx.lines, l.offset, l.length, { code: 'protobuf/field-number-range', type: 'Invalid field number', message: `Field number ${f.id} is outside the valid range 1–536,870,911.`, source: 'FormatX' }));
          }
          if (proto3 && f.required) {
            const l = fl();
            diagnostics.push(diagAt(ctx.lines, l.offset, l.length, { code: 'protobuf/proto3-required', type: 'Invalid label', message: `"required" is not allowed in proto3 (field "${f.name}").`, source: 'FormatX' }));
          }
          if (!/^[a-z][a-z0-9_]*$/.test(f.name)) {
            const l = fl();
            diagnostics.push(diagAt(ctx.lines, l.offset, l.length, { severity: 'info', code: 'protobuf/field-name', type: 'Style', message: `Field "${f.name}" should be lower_snake_case.`, source: 'FormatX' }));
          }
        }
        const ids = new Map<number, string>();
        for (const f of obj.fieldsArray) {
          const prev = ids.get(f.id);
          if (prev) {
            const l = locateWord(ctx, f.name);
            diagnostics.push(diagAt(ctx.lines, l.offset, l.length, { code: 'protobuf/duplicate-number', type: 'Duplicate field number', message: `Fields "${prev}" and "${f.name}" both use number ${f.id}.`, source: 'FormatX' }));
          } else ids.set(f.id, f.name);
        }
      } else if (obj instanceof pb.Enum) {
        enums++;
        const values = Object.entries(obj.values);
        if (proto3 && values.length && values[0][1] !== 0) {
          const l = locateWord(ctx, values[0][0]);
          diagnostics.push(diagAt(ctx.lines, l.offset, l.length, { code: 'protobuf/proto3-enum-zero', type: 'Invalid enum', message: `The first value of proto3 enum "${obj.name}" must be 0 (found ${values[0][0]} = ${values[0][1]}).`, source: 'FormatX' }));
        }
      } else if (obj instanceof pb.Service) {
        services++;
        rpcs += obj.methodsArray.length;
      }
      if (obj instanceof pb.Namespace) walk(obj.nestedArray);
    }
  };
  // skip namespaces that only came from well-known imports (e.g. google.protobuf.Timestamp)
  walk(root.nestedArray.filter((n) => ownNamespaces.has(n.name)));
  return {
    diagnostics,
    facts: { Syntax: syntax ?? 'proto2 (default)', Package: parsed.package ?? '—', Messages: messages, Enums: enums, Fields: fields, Services: services, RPCs: rpcs },
    root,
  };
}

// ---------------------------------------------------------------- formatter

type PTok = { t: 'word' | 'str' | 'punct' | 'line' | 'block'; v: string; nl: number };

function lexProto(src: string): PTok[] {
  const out: PTok[] = [];
  let i = 0;
  let nl = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') {
      nl++;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      let e = i;
      while (e < src.length && src[e] !== '\n') e++;
      out.push({ t: 'line', v: src.slice(i, e).trimEnd(), nl });
      nl = 0;
      i = e;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      const e = close === -1 ? src.length : close + 2;
      out.push({ t: 'block', v: src.slice(i, e), nl });
      nl = 0;
      i = e;
      continue;
    }
    if (c === '"' || c === "'") {
      let e = i + 1;
      while (e < src.length && src[e] !== c) e += src[e] === '\\' ? 2 : 1;
      out.push({ t: 'str', v: src.slice(i, e + 1), nl });
      nl = 0;
      i = e + 1;
      continue;
    }
    if ('{}[]()<>=;,:'.includes(c)) {
      out.push({ t: 'punct', v: c, nl });
      nl = 0;
      i++;
      continue;
    }
    let e = i;
    while (e < src.length && !/[\s{}[\]()<>=;,:"'/]/.test(src[e])) e++;
    if (e === i) e = i + 1;
    out.push({ t: 'word', v: src.slice(i, e), nl });
    nl = 0;
    i = e;
  }
  return out;
}

export function formatProto(src: string, indent: string): string {
  const toks = lexProto(src);
  const lines: string[] = [];
  let cur = '';
  let level = 0;
  let angle = 0;
  const flush = () => {
    if (cur.trim()) lines.push(indent.repeat(level) + cur.trim());
    cur = '';
  };
  const blank = (t: PTok) => {
    if (t.nl >= 2 && lines.length && lines[lines.length - 1] !== '' && !cur.trim()) lines.push('');
  };
  let prev: PTok | null = null;
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.t === 'line' || t.t === 'block') {
      if (t.nl === 0 && prev && (cur.trim() || lines.length)) {
        if (cur.trim()) cur += ' ' + t.v;
        else if (lines.length) lines[lines.length - 1] += ' ' + t.v;
        if (t.t === 'line' && cur.trim()) flush();
      } else {
        flush();
        blank(t);
        for (const l of t.v.split('\n')) lines.push(indent.repeat(level) + l.trim().replace(/^\*/, ' *'));
      }
      prev = t;
      continue;
    }
    if (!cur.trim()) blank(t);
    const v = t.v;
    if (t.t === 'punct') {
      switch (v) {
        case '{':
          cur = cur.trimEnd() + ' {';
          flush();
          level++;
          break;
        case '}':
          flush();
          level = Math.max(0, level - 1);
          cur = '}';
          if (toks[k + 1]?.v !== ';') flush();
          break;
        case ';':
          cur = cur.trimEnd() + ';';
          flush();
          break;
        case '=':
          cur = cur.trimEnd() + ' = ';
          break;
        case ',':
          cur = cur.trimEnd() + ', ';
          break;
        case ':':
          cur = cur.trimEnd() + ': ';
          break;
        case '<':
          angle++;
          cur = cur.trimEnd() + '<';
          break;
        case '>':
          angle = Math.max(0, angle - 1);
          cur = cur.trimEnd() + '>';
          break;
        case '(': {
          const p = prev?.v;
          const spaced = p === 'returns' || p === 'stream' || p === '=' || p === 'option' || p === ',' || p === '[';
          cur = spaced ? (cur.endsWith(' ') ? cur : cur + ' ') + '(' : cur.trimEnd() + '(';
          break;
        }
        case ')':
          cur = cur.trimEnd() + ')';
          break;
        case '[':
          cur = cur.trimEnd() + ' [';
          break;
        case ']':
          cur = cur.trimEnd() + ']';
          break;
      }
    } else {
      const glue = prev && prev.t === 'punct' && ['(', '[', '<'].includes(prev.v);
      if (cur && !cur.endsWith(' ') && !glue) cur += ' ';
      cur += v;
    }
    prev = t;
  }
  flush();
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

function detectProto(ctx: DetectContext): DetectScore | null {
  const h = ctx.head;
  let score = 0;
  const reasons: string[] = [];
  if (/^\s*syntax\s*=\s*["']proto[23]["']\s*;/m.test(h)) {
    score = 0.97;
    reasons.push('syntax = "proto3"; declaration');
  } else if (/^\s*(message|enum|service)\s+\w+\s*\{/m.test(h) && /^\s*(repeated\s+|optional\s+)?[\w.]+\s+\w+\s*=\s*\d+\s*[;[]/m.test(h)) {
    score = 0.85;
    reasons.push('message definitions with numbered fields');
  }
  return score ? { score, reasons } : null;
}

export const protobufModule: FormatModule = {
  descriptor: DESCRIPTORS.protobuf,
  sample: SAMPLES.protobuf,
  detect: detectProto,
  async validate(input, ctx) {
    const r = await analyzeProto(input, ctx);
    return { diagnostics: r.diagnostics, facts: r.facts };
  },
  async beautify(input, ctx) {
    return { text: formatProto(input, indentUnit(ctx.options.indent)) };
  },
  async verifyTransform(original, output) {
    const pb = await loadProtobuf();
    try {
      const a = JSON.stringify(pb.parse(original, { keepCase: true }).root.toJSON());
      const b = JSON.stringify(pb.parse(output, { keepCase: true }).root.toJSON());
      return a === b ? null : 'Formatting would change the schema; the output was discarded.';
    } catch {
      return 'The formatted schema did not re-parse; the output was discarded.';
    }
  },
  specialTargets: ['json'],
  async convertSpecial(input, target, ctx) {
    if (target !== 'json') throw new Error('Protocol Buffers schemas can only be converted to a JSON descriptor.');
    const pb = await loadProtobuf();
    const json = pb.parse(input, { keepCase: true }).root.toJSON({ keepComments: false });
    const indent = ctx.options.indent === 'tab' ? '\t' : indentUnit(ctx.options.indent);
    return { text: JSON.stringify(json, null, indent), warnings: [], notes: ['protobufjs JSON descriptor (usable with protobuf.Root.fromJSON).'] };
  },
};

