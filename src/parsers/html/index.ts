import { parse, parseFragment, type ParserError } from 'parse5';
import { DESCRIPTORS } from '../../engines/catalog';
import type { Diagnostic, Severity } from '../../types/diagnostics';
import type { DetectContext, DetectScore, FormatModule } from '../../types/module';
import { diagAtLineCol, notice } from '../../utils/diag';
import { prettierErrorDiagnostic, prettierFormat } from '../common/prettier';
import { SAMPLES } from '../samples';
import { HTML_TAGS } from '../xml';
import { checkHtmlStructure, tokenizeHtml, VOID_ELEMENTS } from './htmlStructure';

const P5: Record<string, [Severity, string, string, string?]> = {
  'eof-in-tag': ['error', 'Unclosed tag', "The document ends inside a tag: a '>' is missing."],
  'eof-in-comment': ['error', 'Unclosed comment', "A comment is never closed with '-->'."],
  'eof-before-tag-name': ['error', 'Unexpected end', "The document ends right after '<'."],
  'eof-in-doctype': ['error', 'Unclosed DOCTYPE', 'The DOCTYPE declaration is never closed.'],
  'eof-in-cdata': ['error', 'Unclosed CDATA', 'A CDATA section is never closed.'],
  'eof-in-script-html-comment-like-text': ['error', 'Unclosed script', 'The document ends inside a <script> element.'],
  'duplicate-attribute': ['error', 'Duplicate attribute', 'An attribute is repeated on the same element; browsers ignore the second one.'],
  'missing-attribute-value': ['error', 'Missing attribute value', "An '=' is not followed by a value."],
  'missing-whitespace-between-attributes': ['error', 'Missing whitespace', 'Attributes must be separated by whitespace.'],
  'unexpected-character-in-attribute-name': ['error', 'Invalid attribute name', 'Attribute names cannot contain quotes, "<" or "=".'],
  'unexpected-character-in-unquoted-attribute-value': ['error', 'Invalid unquoted value', 'Unquoted attribute values cannot contain quotes, "=", "<", ">" or "`". Quote the value.'],
  'unexpected-equals-sign-before-attribute-name': ['error', 'Unexpected =', "Unexpected '=' before an attribute name."],
  'invalid-first-character-of-tag-name': ['error', "Unescaped '<'", "'<' is not followed by a valid tag name. Use &lt; for a literal less-than sign."],
  'unexpected-question-mark-instead-of-tag-name': ['error', 'Invalid markup', "'<?' is not valid in HTML (processing instructions are an XML feature)."],
  'missing-end-tag-name': ['error', 'Empty closing tag', "'</>' is not a valid closing tag."],
  'unexpected-solidus-in-tag': ['warning', "Unexpected '/'", "A '/' inside a tag is ignored."],
  'non-void-html-element-start-tag-with-trailing-solidus': ['warning', 'Self-closing non-void element', "'/>' does not close non-void HTML elements: the element stays open until its closing tag."],
  'end-tag-with-attributes': ['warning', 'Attributes on closing tag', 'Closing tags cannot have attributes.'],
  'end-tag-with-trailing-solidus': ['warning', 'Invalid closing tag', "Closing tags cannot end with '/>'."],
  'unknown-named-character-reference': ['warning', 'Unknown entity', 'Unknown named character reference.'],
  'missing-semicolon-after-character-reference': ['warning', 'Missing semicolon', 'Character reference is missing its terminating semicolon.'],
  'abrupt-closing-of-empty-comment': ['warning', 'Malformed comment', "'<!-->' is not a valid comment."],
  'incorrectly-closed-comment': ['warning', 'Malformed comment', "Comments must end with '-->'."],
  'incorrectly-opened-comment': ['warning', 'Malformed comment', "'<!' is not followed by '--'."],
  'nested-comment': ['warning', 'Nested comment', "'<!--' inside a comment."],
  'cdata-in-html-content': ['warning', 'CDATA in HTML', 'CDATA sections are only valid inside SVG/MathML.'],
  'missing-doctype': ['info', 'Missing DOCTYPE', 'Without <!DOCTYPE html> browsers render the page in quirks mode.'],
  'misplaced-doctype': ['error', 'Misplaced DOCTYPE', 'The DOCTYPE must be the first thing in the document.'],
  'non-conforming-doctype': ['warning', 'Legacy DOCTYPE', 'Use the HTML5 doctype: <!DOCTYPE html>.'],
  'control-character-in-input-stream': ['warning', 'Control character', 'The document contains a control character.'],
  'unexpected-null-character': ['error', 'NUL character', 'The document contains a NUL character.'],
  'abandoned-head-element-child': ['warning', 'Misplaced head element', 'An element that belongs in <head> appears after </head>.'],
  'misplaced-start-tag-for-head-element': ['warning', 'Misplaced <head>', 'A <head> start tag appears in an invalid position.'],
  'disallowed-content-in-noscript-in-head': ['warning', 'Invalid <noscript> content', 'Only <link>, <style> and <meta> are allowed in <noscript> inside <head>.'],
};

const HANDLED_BY_STRUCTURE = new Set(['end-tag-without-matching-open-element', 'closing-of-element-with-open-child-elements', 'open-elements-left-after-eof']);

function isDocument(input: string): boolean {
  return /^\s*(?:<!--[\s\S]*?-->\s*)*(?:<!doctype|<html[\s>])/i.test(input);
}

function detectHtml(ctx: DetectContext): DetectScore | null {
  const t = ctx.trimmed;
  if (t[0] !== '<') {
    // fragments that start with text are rare; require strong markers
    if (!/<(div|span|p|a|br|img|ul|li|table|h[1-6])\b[^>]*>/i.test(ctx.head)) return null;
    return { score: 0.3, reasons: ['Contains HTML tags'] };
  }
  if (/^<!doctype\s+html/i.test(t)) return { score: 0.97, reasons: ['<!DOCTYPE html>'] };
  if (/^<html[\s>]/i.test(t)) return { score: 0.93, reasons: ['<html> root element'] };
  if (t.startsWith('<?xml')) return { score: 0.1, reasons: [] };
  const tags = [...ctx.head.slice(0, 32768).matchAll(/<([A-Za-z][\w-]*)/g)].map((m) => m[1].toLowerCase());
  if (!tags.length) return null;
  const html = tags.filter((x) => HTML_TAGS.has(x)).length / tags.length;
  const reasons: string[] = [];
  let score = 0.2 + html * 0.6;
  if (html > 0.5) reasons.push(`${Math.round(html * 100)}% of tags are HTML elements`);
  if (/<(br|img|input|meta|link|hr)\b[^>]*[^/]>/i.test(ctx.head)) {
    score += 0.1;
    reasons.push('Void elements without closing slash');
  }
  if (/\s(class|style|onclick|href)=/i.test(ctx.head)) score += 0.05;
  if (tags[0] === 'svg') score = Math.min(score, 0.45);
  return { score: Math.min(0.92, score), reasons };
}

const BLOCK = new Set(
  'html head body div p h1 h2 h3 h4 h5 h6 ul ol li dl dt dd table thead tbody tfoot tr td th caption colgroup col section article aside header footer nav main form fieldset legend figure figcaption blockquote pre hr address details summary dialog menu meta link title style script noscript template base option optgroup select search hgroup'.split(' '),
);
const PRESERVE_WS = new Set(['pre', 'textarea', 'script', 'style', 'xmp', 'plaintext']);

/** Conservative minifier: removes comments and collapses whitespace where it cannot affect rendering. */
export function minifyHtml(src: string): { text: string; comments: number } {
  const toks = tokenizeHtml(src);
  const out: string[] = [];
  let comments = 0;
  const preserveStack: string[] = [];
  const isBlockTag = (i: number) => {
    const tk = toks[i];
    return !tk || tk.t === 'doctype' || tk.t === 'comment' || (tk.t === 'tag' && BLOCK.has(tk.tag.name));
  };
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if (tk.t === 'comment') {
      if (/^<!--\[if|^<!--!/.test(tk.raw)) out.push(tk.raw);
      else comments++;
      continue;
    }
    if (tk.t === 'doctype' || tk.t === 'rawtext') {
      out.push(tk.t === 'doctype' ? tk.raw : tk.value);
      continue;
    }
    if (tk.t === 'tag') {
      const { tag } = tk;
      if (PRESERVE_WS.has(tag.name)) {
        if (tag.closing) preserveStack.pop();
        else if (!tag.selfClosing) preserveStack.push(tag.name);
      }
      // collapse whitespace inside the tag, keeping attribute values verbatim
      const raw = tk.raw;
      let s = '';
      let q = '';
      for (let k = 0; k < raw.length; k++) {
        const ch = raw[k];
        if (q) {
          s += ch;
          if (ch === q) q = '';
        } else if (ch === '"' || ch === "'") {
          q = ch;
          s += ch;
        } else if (/\s/.test(ch)) {
          let k2 = k;
          while (k2 < raw.length && /\s/.test(raw[k2])) k2++;
          const prev = s[s.length - 1];
          const next = raw[k2];
          if (prev !== '=' && next !== '=' && next !== '>' && !(next === '/' && raw[k2 + 1] === '>')) s += ' ';
          k = k2 - 1;
        } else s += ch;
      }
      if (VOID_ELEMENTS.has(tag.name)) s = s.replace(/\/>$/, '>');
      out.push(s);
      continue;
    }
    // text
    if (preserveStack.length) {
      out.push(tk.value);
      continue;
    }
    let v = tk.value.replace(/\s+/g, ' ');
    const prevBlock = isBlockTag(i - 1);
    const nextBlock = isBlockTag(i + 1);
    if (v === ' ' && prevBlock && nextBlock) continue;
    if (prevBlock) v = v.replace(/^ /, '');
    if (nextBlock) v = v.replace(/ $/, '');
    if (v) out.push(v);
  }
  return { text: out.join('').trim(), comments };
}

export const htmlModule: FormatModule = {
  descriptor: DESCRIPTORS.html,
  sample: SAMPLES.html,
  detect: detectHtml,
  validate(input, ctx) {
    const doc = isDocument(input);
    const errs: ParserError[] = [];
    (doc ? parse : parseFragment)(input, { sourceCodeLocationInfo: true, onParseError: (e) => errs.push(e) });
    const diagnostics: Diagnostic[] = [];
    for (const e of errs) {
      if (HANDLED_BY_STRUCTURE.has(e.code)) continue;
      if (e.code === 'missing-doctype' && !doc) continue;
      const info = P5[e.code] ?? (['warning', 'HTML parse error', e.code.replace(/-/g, ' ')] as [Severity, string, string]);
      diagnostics.push(
        diagAtLineCol(ctx.lines, e.startLine, e.startCol, { severity: info[0], code: `html/${e.code}`, type: info[1], message: info[2], source: 'parse5' }, e.endLine, e.endCol),
      );
    }
    diagnostics.push(...checkHtmlStructure(input, ctx.lines, doc));
    const tags = tokenizeHtml(input).filter((t) => t.t === 'tag' && !t.tag.closing).length;
    return { diagnostics, facts: { Kind: doc ? 'document' : 'fragment', Elements: tags } };
  },
  async beautify(input, ctx) {
    try {
      const text = await prettierFormat(input, { parser: 'html', plugins: ['html', 'postcss', 'babel', 'estree'], options: ctx.options, overrides: { htmlWhitespaceSensitivity: 'css' } });
      return { text };
    } catch (e) {
      throw new Error(prettierErrorDiagnostic(e, ctx.lines, 'Prettier', 'html/prettier').message);
    }
  },
  minify(input) {
    const r = minifyHtml(input);
    const warnings: Diagnostic[] = [];
    if (r.comments) warnings.push(notice({ severity: 'info', code: 'html/minify-removed-comments', type: 'Comments removed', message: `${r.comments} comment(s) were removed (conditional comments are kept).`, source: 'HTML minifier' }));
    return { text: r.text, warnings, notes: ['Whitespace is only removed where it cannot affect rendering; <pre>, <textarea>, <script> and <style> are untouched.'] };
  },
};
