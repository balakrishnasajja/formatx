import { Document, isAlias, isMap, isScalar, isSeq, parseAllDocuments, visit, type YAMLError } from 'yaml';
import { DESCRIPTORS } from '../../engines/catalog';
import { dataToJs, jsEquals, jsToData, pathToString } from '../../engines/converters/dataModel';
import type { DataValue } from '../../types/data';
import type { Diagnostic, QuickFix } from '../../types/diagnostics';
import type { DetectContext, DetectScore, FormatModule, ModuleContext } from '../../types/module';
import { diagAt, notice } from '../../utils/diag';
import { lineRatio } from '../../engines/detection/context';
import { SAMPLES } from '../samples';

const SOURCE = 'yaml';
const PARSE_OPTS = { prettyErrors: false, uniqueKeys: true, strict: true, intAsBigInt: true, customTags: ['binary' as const] };

const CODE_INFO: Record<string, { type: string; suggestion?: string }> = {
  TAB_AS_INDENT: { type: 'Tab indentation', suggestion: 'YAML does not allow tabs for indentation — use spaces.' },
  BAD_INDENT: { type: 'Invalid indentation', suggestion: 'Items at the same level must be aligned, and nested content must be indented further than its parent key.' },
  DUPLICATE_KEY: { type: 'Duplicate key', suggestion: 'Keys within a mapping must be unique.' },
  MULTILINE_IMPLICIT_KEY: { type: 'Invalid key', suggestion: 'A key must fit on one line. This usually means a missing ":" or wrong indentation on a previous line.' },
  BLOCK_AS_IMPLICIT_KEY: { type: 'Invalid nesting', suggestion: 'Nested mappings must start on their own, further-indented line.' },
  MISSING_CHAR: { type: 'Missing character', suggestion: 'A closing quote or bracket is probably missing.' },
  UNEXPECTED_TOKEN: { type: 'Unexpected token' },
  BAD_SCALAR_START: { type: 'Invalid value', suggestion: 'Quote values that begin with reserved characters such as @, `, %, | or >.' },
  BAD_DQ_ESCAPE: { type: 'Invalid escape', suggestion: 'Check the backslash escapes inside the double-quoted string.' },
  BAD_ALIAS: { type: 'Unknown alias', suggestion: 'Aliases (*name) must refer to an anchor (&name) defined earlier in the document.' },
  MULTIPLE_ANCHORS: { type: 'Multiple anchors' },
  MULTIPLE_TAGS: { type: 'Multiple tags' },
  BAD_DIRECTIVE: { type: 'Invalid directive' },
  BLOCK_IN_FLOW: { type: 'Block in flow collection', suggestion: 'Block collections cannot be nested inside { } or [ ].' },
  KEY_OVER_1024_CHARS: { type: 'Key too long' },
  NON_STRING_KEY: { type: 'Non-string key' },
  TAG_RESOLVE_FAILED: { type: 'Unresolved tag' },
  BAD_COLLECTION_TYPE: { type: 'Invalid collection' },
  ALIAS_PROPS: { type: 'Invalid alias' },
  BAD_PROP_ORDER: { type: 'Invalid property order' },
  MULTIPLE_DOCS: { type: 'Multiple documents' },
  IMPOSSIBLE: { type: 'Parser error' },
};

function toDiagnostic(e: YAMLError, severity: 'error' | 'warning', ctx: ModuleContext): Diagnostic {
  const info = CODE_INFO[e.code] ?? { type: 'YAML error' };
  let fix: QuickFix | undefined;
  const [start, end] = e.pos;
  if (e.code === 'TAB_AS_INDENT') {
    const line = ctx.lines.positionAt(start).line;
    const ls = ctx.lines.lineStart(line);
    const lt = ctx.lines.lineText(line);
    const lead = /^[\t ]*/.exec(lt)?.[0] ?? '';
    if (lead.includes('\t')) fix = { title: 'Replace tabs with spaces', edits: [{ offset: ls, length: lead.length, text: lead.replace(/\t/g, '  ') }] };
  }
  const message = e.message.replace(/\s+at line \d+, column \d+[\s\S]*$/, '');
  return diagAt(ctx.lines, start, Math.max(1, Math.min(end - start, 200)), {
    severity,
    code: `yaml/${e.code.toLowerCase().replace(/_/g, '-')}`,
    type: info.type,
    message,
    suggestion: info.suggestion,
    fix,
    source: SOURCE,
  });
}

function parse(input: string) {
  return parseAllDocuments(input, PARSE_OPTS);
}

function detectYaml(ctx: DetectContext): DetectScore | null {
  const t = ctx.trimmed;
  if (!t || t[0] === '<') return null;
  if (t[0] === '{' || t[0] === '[') return { score: 0.15, reasons: ['Flow-style YAML (also valid JSON)'] };
  const comment = /^\s*#/;
  const keyValue = lineRatio(ctx.lines, /^\s*(?:-\s+)?(?:"[^"]*"|'[^']*'|[^\s#:{}[\],&*!|>'"%@`][^#:]*?)\s*:(?:\s|$)/, comment);
  const listItem = lineRatio(ctx.lines, /^\s*-(?:\s|$)/, comment);
  const marker = ctx.lines.some((l) => /^(---|\.\.\.)(\s|$)/.test(l));
  const equals = lineRatio(ctx.lines, /^\s*[\w.-]+\s*=/, comment);
  const sections = lineRatio(ctx.lines, /^\s*\[[^\]]+\]\s*$/, comment);
  const cssLike = lineRatio(ctx.lines, /[;{}]\s*$/, comment);
  const codeLike = lineRatio(ctx.lines, /^\s*(def |class |import |from |function |const |let |var |return |if |for |while |public |private )/, comment);
  const reasons: string[] = [];
  const structured = keyValue.ratio + listItem.ratio;
  let score = 0;
  if (structured >= 0.5) {
    score = 0.45 + Math.min(0.35, structured * 0.35);
    reasons.push(`${Math.round(structured * 100)}% of lines are "key: value" pairs or list items`);
  } else if (structured > 0.2) score = 0.3;
  if (marker || /^%YAML/m.test(ctx.head)) {
    score += 0.15;
    reasons.push('Document markers (---)');
  }
  if (ctx.lines.some((l) => /^\s+\S/.test(l)) && keyValue.count > 0) score += 0.05;
  if (/^(apiVersion|kind|openapi|swagger|version|services|name|on|jobs):/m.test(ctx.head)) score += 0.05;
  score -= equals.ratio * 0.6 + sections.ratio * 0.5 + cssLike.ratio * 0.7 + codeLike.ratio * 0.8;
  // prose lines (neither key: value, list item, marker nor indented continuation) are untypical for YAML
  const prose = lineRatio(ctx.lines, /^(?!\s*(?:-(?:\s|$)|---|\.\.\.|[^\s].*?:(?:\s|$))|\s)\S.*\s\S/, comment).ratio;
  score -= prose * 0.6;
  // Markdown markers: **bold**, [link](url), `code`, "# Heading" followed by prose
  const md = (ctx.head.match(/\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\n]+\)|`[^`\n]+`|^```/gm) ?? []).length;
  if (md) score -= Math.min(0.4, md * 0.12);
  if (keyValue.total === 1 && listItem.count === 0) score = Math.min(score, 0.4);
  return score > 0 ? { score: Math.min(0.95, score), reasons } : null;
}

function countYaml(docs: Document[]) {
  let keys = 0;
  let anchors = 0;
  let aliases = 0;
  let maxDepth = 0;
  for (const doc of docs) {
    visit(doc, {
      Pair(_, __, path) {
        keys++;
        if (path.length > maxDepth) maxDepth = path.length;
      },
      Node(_, node) {
        if (isAlias(node)) aliases++;
        else if ('anchor' in node && node.anchor) anchors++;
      },
    });
  }
  return { keys, anchors, aliases, depth: Math.ceil(maxDepth / 2) };
}

/** Clone a document with every mapping's entries sorted by key (code point order). */
function sortedClone(doc: Document): Document {
  const clone = doc.clone();
  const keyOf = (p: unknown): string => {
    const k = (p as { key?: unknown }).key;
    return isScalar(k) ? String(k.value) : String(k);
  };
  visit(clone, {
    Map(_, map) {
      map.items.sort((a, b) => {
        const x = keyOf(a);
        const y = keyOf(b);
        return x < y ? -1 : x > y ? 1 : 0;
      });
    },
  });
  return clone;
}

function docsToJs(docs: Document[]): unknown[] {
  return docs.map((d) => d.toJS({ maxAliasCount: 1000, mapAsMap: true }));
}

function hasComments(docs: Document[]): boolean {
  let found = false;
  for (const doc of docs) {
    if (doc.commentBefore || doc.comment) return true;
    visit(doc, {
      Node(_, node) {
        if (node.commentBefore || node.comment) {
          found = true;
          return visit.BREAK;
        }
      },
    });
    if (found) return true;
  }
  return false;
}

export const yamlModule: FormatModule = {
  descriptor: DESCRIPTORS.yaml,
  sample: SAMPLES.yaml,
  detect: detectYaml,
  detectBoost: 0.3,
  validate(input, ctx) {
    const docs = parse(input);
    const diagnostics: Diagnostic[] = [];
    if ('empty' in docs && docs.empty) {
      for (const e of docs.errors) diagnostics.push(toDiagnostic(e, 'error', ctx));
      return { diagnostics, facts: { Documents: 0 } };
    }
    for (const doc of docs) {
      for (const e of doc.errors) diagnostics.push(toDiagnostic(e, 'error', ctx));
      for (const w of doc.warnings) diagnostics.push(toDiagnostic(w, 'warning', ctx));
    }
    const facts: Record<string, string | number> = { Documents: docs.length };
    if (!diagnostics.some((d) => d.severity === 'error')) {
      const c = countYaml(docs);
      Object.assign(facts, { Keys: c.keys, 'Max depth': c.depth });
      if (c.anchors) facts.Anchors = c.anchors;
      if (c.aliases) facts.Aliases = c.aliases;
      const root = docs[0]?.contents;
      facts['Root type'] = isMap(root) ? 'mapping' : isSeq(root) ? 'sequence' : isScalar(root) ? 'scalar' : 'empty';
    }
    const weakMatch = docs.every((d) => !isMap(d.contents) && !isSeq(d.contents));
    return { diagnostics, facts, weakMatch };
  },
  beautify(input, ctx) {
    const docs = parse(input);
    const indent = ctx.options.indent === 'spaces4' ? 4 : 2;
    const notes: string[] = [];
    if (ctx.options.indent === 'tab') notes.push('YAML does not allow tab indentation, so 2 spaces were used.');
    const parts = docs.map((source, i) => {
      const doc = ctx.options.sortKeys ? sortedClone(source) : source;
      let s = doc.toString({ indent, indentSeq: true, lineWidth: 0, minContentWidth: 0 });
      if (i > 0 && !/^---/.test(s)) s = '---\n' + s;
      return s.replace(/\n+$/, '');
    });
    return { text: parts.join('\n'), notes };
  },
  minify(input) {
    const docs = parse(input);
    const parts = docs.map((doc) => {
      const clone = doc.clone();
      clone.commentBefore = null;
      clone.comment = null;
      visit(clone, {
        Node(_, node) {
          node.commentBefore = undefined;
          node.comment = undefined;
          if (isMap(node) || isSeq(node)) node.flow = true;
          if ('spaceBefore' in node) node.spaceBefore = false;
        },
      });
      return clone.toString({ lineWidth: 0, flowCollectionPadding: false }).trim();
    });
    const warnings: Diagnostic[] = [];
    if (hasComments(docs)) warnings.push(notice({ severity: 'info', code: 'yaml/minify-removed-comments', type: 'Comments removed', message: 'Comments were removed by minification.', source: 'YAML minifier' }));
    return { text: parts.join('\n---\n'), warnings };
  },
  verifyTransform(original, output) {
    try {
      const a = docsToJs(parse(original));
      const b = parse(output);
      if (b.some((d) => d.errors.length)) return 'The formatted YAML did not re-parse cleanly; the output was discarded.';
      return jsEquals(a, docsToJs(b)) ? null : 'Formatting would change the YAML data; the output was discarded to protect your data.';
    } catch {
      return null;
    }
  },
  toData(input) {
    const docs = parse(input);
    const warnings: Diagnostic[] = [];
    const losses: string[] = [];
    const values = docsToJs(docs).map((v) =>
      jsToData(v, {
        onLoss: (path, message) => {
          if (losses.length < 5) losses.push(`${pathToString(path)}: ${message}`);
        },
      }),
    );
    for (const l of losses) warnings.push(notice({ code: 'convert/non-string-key', type: 'Key converted', message: l, source: 'YAML' }));
    if (hasComments(docs)) warnings.push(notice({ code: 'convert/comments-dropped', type: 'Comments not preserved', message: 'YAML comments cannot be carried over to the converted data.', source: 'YAML' }));
    const c = countYaml(docs);
    if (c.aliases) warnings.push(notice({ severity: 'info', code: 'convert/aliases-expanded', type: 'Aliases expanded', message: `${c.aliases} alias(es) were expanded into copies of the anchored value.`, source: 'YAML' }));
    let data: DataValue;
    if (values.length === 1) data = values[0];
    else {
      data = values;
      if (values.length > 1) warnings.push(notice({ code: 'convert/multi-document', type: 'Multiple documents', message: `The stream contains ${values.length} documents; they were combined into a single array.`, source: 'YAML' }));
    }
    return { data, warnings };
  },
  fromData(data, ctx) {
    const js = dataToJs(data, { maps: 'map', dates: 'string', binary: 'keep' });
    const doc = new Document(js, { customTags: ['binary'] });
    const indent = ctx.options.indent === 'spaces4' ? 4 : 2;
    return { text: doc.toString({ indent, lineWidth: 0, minContentWidth: 0 }), warnings: [] };
  },
};
