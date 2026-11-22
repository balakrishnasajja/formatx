import postcss, { type Root, type Declaration } from 'postcss';
import postcssScss from 'postcss-scss';
import { DESCRIPTORS } from '../../engines/catalog';
import { lineRatio } from '../../engines/detection/context';
import type { Diagnostic } from '../../types/diagnostics';
import type { FormatId } from '../../types/formats';
import type { DetectContext, DetectScore, FormatModule, ModuleContext } from '../../types/module';
import { diagAtLineCol, notice } from '../../utils/diag';
import { prettierErrorDiagnostic, prettierFormat } from '../common/prettier';
import { SAMPLES } from '../samples';

type Variant = 'css' | 'scss';

function parseCss(variant: Variant, input: string): Root {
  return variant === 'scss' ? (postcssScss.parse(input) as Root) : postcss.parse(input);
}

const REASONS: Record<string, string> = {
  'Unclosed block': "Add the missing '}' for this block.",
  'Unclosed string': 'Add the missing closing quote.',
  'Unclosed bracket': "Add the missing ')' or ']'.",
  'Unclosed comment': "Close the comment with '*/'.",
  'Unknown word': "Check for a missing ':' between property and value, a missing ';', or a typo in a selector.",
  'Missed semicolon': "Add ';' between the declarations.",
  'Unexpected }': "Remove the extra '}' or add the missing '{'.",
  'Double colon': 'A declaration can only contain one ":" separator.',
};

function cssError(e: unknown, ctx: ModuleContext, variant: Variant): Diagnostic {
  const err = e as { reason?: string; message?: string; line?: number; column?: number; endLine?: number; endColumn?: number; name?: string };
  const reason = err.reason ?? (err.message ?? String(e)).replace(/^<css input>:\d+:\d+:\s*/, '');
  const base = reason.replace(/\s*\(.*\)$/, '');
  const suggestion = REASONS[base] ?? Object.entries(REASONS).find(([k]) => reason.startsWith(k))?.[1];
  let fix;
  if (base === 'Missed semicolon' && err.line && err.column) {
    const off = ctx.lines.offsetAt(err.line, err.column);
    // insert ';' after the previous value token (before the whitespace preceding the next property)
    let p = off;
    while (p > 0 && /\s/.test(ctx.lines.text[p - 1])) p--;
    fix = { title: "Insert ';'", edits: [{ offset: p, length: 0, text: ';' }] };
  }
  return diagAtLineCol(
    ctx.lines,
    err.line ?? 1,
    err.column ?? 1,
    { code: `${variant}/${base.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '')}`, type: base, message: reason.charAt(0).toUpperCase() + reason.slice(1) + '.', suggestion, fix, source: variant === 'scss' ? 'postcss-scss' : 'PostCSS' },
    err.endLine,
    err.endColumn,
  );
}

function lint(root: Root, ctx: ModuleContext, variant: Variant): { diagnostics: Diagnostic[]; facts: Record<string, number> } {
  const diagnostics: Diagnostic[] = [];
  const facts = { Rules: 0, Declarations: 0, 'At-rules': 0, Comments: 0 };
  const src = variant === 'scss' ? 'SCSS lint' : 'CSS lint';
  root.walk((node) => {
    const start = node.source?.start;
    if (node.type === 'rule') {
      facts.Rules++;
      if (!node.nodes?.length && start) {
        diagnostics.push(diagAtLineCol(ctx.lines, start.line, start.column, { severity: 'warning', code: `${variant}/empty-rule`, type: 'Empty rule', message: `Rule "${node.selector.slice(0, 60)}" has no declarations.`, source: src }));
      }
      const seen = new Map<string, Declaration>();
      for (const child of node.nodes ?? []) {
        if (child.type !== 'decl' || child.prop.startsWith('--') || child.prop.startsWith('$')) continue;
        const prev = seen.get(child.prop.toLowerCase());
        const cs = child.source?.start;
        if (prev && cs) {
          const same = prev.value.trim() === child.value.trim();
          diagnostics.push(
            diagAtLineCol(ctx.lines, cs.line, cs.column, {
              severity: same ? 'warning' : 'info',
              code: `${variant}/duplicate-property`,
              type: 'Duplicate property',
              message: same ? `"${child.prop}" is declared twice with the same value.` : `"${child.prop}" is declared more than once in this rule (fine if it is an intentional fallback).`,
              source: src,
              related: prev.source?.start ? [{ message: 'Previous declaration', line: prev.source.start.line, column: prev.source.start.column }] : undefined,
            }),
          );
        }
        seen.set(child.prop.toLowerCase(), child);
      }
    } else if (node.type === 'decl') {
      facts.Declarations++;
      if (/(^|[\s,(])#(?![0-9a-fA-F]{3,4}(?![0-9a-fA-F])|[0-9a-fA-F]{6}(?![0-9a-fA-F])|[0-9a-fA-F]{8}(?![0-9a-fA-F])|\{)[0-9a-zA-Z]+/.test(node.value) && /color|background|border|fill|stroke|shadow|outline/i.test(node.prop) && start) {
        diagnostics.push(diagAtLineCol(ctx.lines, start.line, start.column, { severity: 'warning', code: `${variant}/invalid-hex-color`, type: 'Invalid color', message: `"${node.value}" contains an invalid hex color (use 3, 4, 6 or 8 hex digits).`, source: src }));
      }
      if (node.value.trim() === '' && start) {
        diagnostics.push(diagAtLineCol(ctx.lines, start.line, start.column, { severity: 'warning', code: `${variant}/empty-value`, type: 'Empty value', message: `Property "${node.prop}" has no value.`, source: src }));
      }
    } else if (node.type === 'atrule') facts['At-rules']++;
    else if (node.type === 'comment') facts.Comments++;
  });
  return { diagnostics, facts };
}

/** Collapse whitespace in a value outside strings and url(...), and drop spaces after commas. */
export function collapseValue(v: string): string {
  let out = '';
  let i = 0;
  while (i < v.length) {
    const ch = v[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < v.length && v[j] !== ch) j += v[j] === '\\' ? 2 : 1;
      out += v.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (/^url\(/i.test(v.slice(i, i + 4))) {
      // unquoted url(...) content is copied verbatim
      const close = v.indexOf(')', i);
      const end = close === -1 ? v.length : close + 1;
      out += v.slice(i, end);
      i = end;
      continue;
    }
    if (/\s/.test(ch)) {
      let j = i;
      while (j < v.length && /\s/.test(v[j])) j++;
      const prev = out[out.length - 1];
      const next = v[j];
      if (out.length && next !== undefined && prev !== ',' && next !== ',' && prev !== '(' && next !== ')' && next !== '!') out += ' ';
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out.trim();
}

/** Minify selectors: collapse whitespace and remove it around combinators/commas (outside strings and brackets). */
export function collapseSelector(sel: string): string {
  let out = '';
  let q = '';
  let bracket = 0;
  for (let i = 0; i < sel.length; i++) {
    const ch = sel[i];
    if (q) {
      out += ch;
      if (ch === q) q = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      out += ch;
      continue;
    }
    if (ch === '[') bracket++;
    if (ch === ']') bracket = Math.max(0, bracket - 1);
    if (/\s/.test(ch) && !bracket) {
      let j = i;
      while (j < sel.length && /\s/.test(sel[j])) j++;
      const prev = out[out.length - 1];
      const next = sel[j];
      if (out.length && next !== undefined && !'>+~,'.includes(prev) && !'>+~,'.includes(next)) out += ' ';
      i = j - 1;
      continue;
    }
    out += ch;
  }
  return out.trim();
}

/** Apply a transform only to the parts of `s` that are outside quoted strings. */
function outsideStrings(s: string, fn: (part: string) => string): string {
  return s
    .split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/)
    .map((part, i) => (i % 2 === 0 ? fn(part) : part))
    .join('');
}

export function minifyCss(variant: Variant, input: string): { text: string; removedComments: number } {
  const root = parseCss(variant, input);
  let removedComments = 0;
  root.walkComments((c) => {
    if (c.text.startsWith('!')) return;
    removedComments++;
    c.remove();
  });
  root.walk((node) => {
    node.raws.before = '';
    if ('after' in node.raws || node.type !== 'decl') node.raws.after = '';
    if (node.type === 'decl') {
      node.raws.between = ':';
      // raws.value holds the original text (trailing spaces, inline comments); minified output uses the clean value
      node.value = collapseValue(node.value);
      delete node.raws.value;
      if (node.important) node.raws.important = '!important';
    } else if (node.type === 'rule') {
      node.selector = collapseSelector(node.selector);
      node.raws.between = '';
      node.raws.semicolon = false;
    } else if (node.type === 'atrule') {
      node.params = outsideStrings(collapseValue(node.params), (s) => s.replace(/\s*([:,])\s*/g, '$1'));
      node.raws.afterName = node.params ? ' ' : '';
      node.raws.between = '';
      node.raws.semicolon = false;
      if (node.params.startsWith('(')) node.raws.afterName = '';
    }
  });
  root.raws.after = '';
  root.raws.semicolon = false;
  const text = root.toString();
  return { text, removedComments };
}

function detectFor(variant: Variant, ctx: DetectContext): DetectScore | null {
  const t = ctx.trimmed;
  if (!t || t[0] === '{' || t[0] === '[' || t[0] === '<') return null;
  const rules = lineRatio(ctx.lines, /[^{}]+\{\s*$|[^{}]*\{[^}]*\}\s*$|^\s*\}\s*$/);
  const decls = lineRatio(ctx.lines, /^\s*-{0,2}[a-z][a-z-]*\s*:\s*[^;]+;\s*$/i);
  const inline = (ctx.head.match(/[.#]?[\w-]+[^{};]*\{[^{}]*:[^{}]*\}/g) ?? []).length;
  const scssFeatures = (ctx.head.match(/^\s*\$[\w-]+\s*:|@(mixin|include|extend|use|forward|function|return|each|if|else)\b|&[:.\-_\w]|#\{|^\s*\/\/|%[\w-]+/gm) ?? []).length;
  const code = lineRatio(ctx.lines, /^\s*(function|const|let|var|import|export|class|def|public|private|if\s*\(|return\b)/).ratio;
  const atRules = (ctx.head.match(/@(media|import|font-face|keyframes|supports|charset|layer|container|page)\b/g) ?? []).length;
  if (rules.count + inline === 0) return null;
  let score = 0.3 + Math.min(0.4, (rules.ratio + decls.ratio) * 0.4) + Math.min(0.15, inline * 0.03) + Math.min(0.1, atRules * 0.03);
  score -= code * 0.8;
  const reasons = ['Selector { property: value } blocks'];
  if (variant === 'scss') {
    if (!scssFeatures) return { score: Math.max(0, score - 0.2), reasons };
    score += Math.min(0.25, scssFeatures * 0.06);
    reasons.push('SCSS features ($variables, @mixin/@include, nesting with &, // comments)');
  } else if (scssFeatures) score -= Math.min(0.3, scssFeatures * 0.08);
  return score > 0.15 ? { score: Math.min(0.95, score), reasons } : null;
}

function createCssModule(variant: Variant): FormatModule {
  const id: FormatId = variant;
  return {
    descriptor: DESCRIPTORS[id],
    sample: SAMPLES[id],
    detect: (ctx) => detectFor(variant, ctx),
    validate(input, ctx) {
      let root: Root;
      try {
        root = parseCss(variant, input);
      } catch (e) {
        return { diagnostics: [cssError(e, ctx, variant)] };
      }
      const r = lint(root, ctx, variant);
      return { diagnostics: r.diagnostics, facts: r.facts };
    },
    async beautify(input, ctx) {
      try {
        return { text: await prettierFormat(input, { parser: variant, plugins: ['postcss'], options: ctx.options }) };
      } catch (e) {
        throw new Error(prettierErrorDiagnostic(e, ctx.lines, 'Prettier', `${variant}/prettier`).message);
      }
    },
    minify(input) {
      const r = minifyCss(variant, input);
      try {
        parseCss(variant, r.text);
      } catch (e) {
        throw new Error(`minified output did not re-parse (${(e as Error).message}); output discarded`);
      }
      const warnings: Diagnostic[] = [];
      if (r.removedComments) warnings.push(notice({ severity: 'info', code: `${variant}/minify-removed-comments`, type: 'Comments removed', message: `${r.removedComments} comment(s) were removed (/*! … */ license comments are kept).`, source: 'CSS minifier' }));
      return { text: r.text, warnings };
    },
  };
}

export const cssModule = createCssModule('css');
export const scssModule = createCssModule('scss');
