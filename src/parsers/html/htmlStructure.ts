import type { Diagnostic } from '../../types/diagnostics';
import { diagAt, relatedAt } from '../../utils/diag';
import type { LineIndex } from '../../utils/lineIndex';

export const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'keygen', 'command', 'basefont', 'bgsound', 'frame']);
export const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext']);
/** Elements whose end tag may legally be omitted (HTML §13.1.2.4). */
const OPTIONAL_END = new Set(['html', 'head', 'body', 'li', 'dt', 'dd', 'p', 'rt', 'rp', 'optgroup', 'option', 'colgroup', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th']);
const P_CLOSERS = new Set('address article aside blockquote details dialog div dl fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr main menu nav ol p pre search section table ul'.split(' '));
const HEAD_CONTENT = new Set(['meta', 'link', 'title', 'style', 'script', 'base', 'noscript', 'template']);
const DEPRECATED = new Set(['center', 'font', 'marquee', 'blink', 'big', 'strike', 'tt', 'frame', 'frameset', 'acronym', 'applet', 'basefont', 'dir', 'isindex', 'listing', 'nobr', 'spacer']);

export interface HtmlTag {
  name: string;
  start: number;
  end: number;
  closing: boolean;
  selfClosing: boolean;
  attrs: { name: string; value: string | null; start: number }[];
}

export type HtmlToken =
  | { t: 'tag'; tag: HtmlTag; raw: string }
  | { t: 'text'; value: string; start: number }
  | { t: 'comment'; raw: string; start: number }
  | { t: 'doctype'; raw: string; start: number }
  | { t: 'rawtext'; value: string; start: number };

/** Lenient HTML tokenizer (no tree building) used by the structure checker and the minifier. */
export function tokenizeHtml(src: string): HtmlToken[] {
  const out: HtmlToken[] = [];
  const len = src.length;
  let i = 0;
  let textStart = 0;
  const flushText = (end: number) => {
    if (end > textStart) out.push({ t: 'text', value: src.slice(textStart, end), start: textStart });
  };
  while (i < len) {
    const lt = src.indexOf('<', i);
    if (lt === -1) break;
    i = lt;
    if (src.startsWith('<!--', i)) {
      flushText(i);
      const close = src.indexOf('-->', i + 4);
      const end = close === -1 ? len : close + 3;
      out.push({ t: 'comment', raw: src.slice(i, end), start: i });
      i = textStart = end;
      continue;
    }
    if (src[i + 1] === '!' || src[i + 1] === '?') {
      flushText(i);
      const close = src.indexOf('>', i);
      const end = close === -1 ? len : close + 1;
      const raw = src.slice(i, end);
      out.push(/^<!doctype/i.test(raw) ? { t: 'doctype', raw, start: i } : { t: 'comment', raw, start: i });
      i = textStart = end;
      continue;
    }
    const closing = src[i + 1] === '/';
    const nameStart = i + (closing ? 2 : 1);
    if (!/[A-Za-z]/.test(src[nameStart] ?? '')) {
      i++;
      continue; // '<' as text
    }
    flushText(i);
    let p = nameStart;
    while (p < len && !/[\s/>]/.test(src[p])) p++;
    const name = src.slice(nameStart, p).toLowerCase();
    const attrs: HtmlTag['attrs'] = [];
    let selfClosing = false;
    while (p < len && src[p] !== '>') {
      if (/\s/.test(src[p])) {
        p++;
        continue;
      }
      if (src[p] === '/') {
        if (src[p + 1] === '>') selfClosing = true;
        p++;
        continue;
      }
      const aStart = p;
      while (p < len && !/[\s/>=]/.test(src[p])) p++;
      const aName = src.slice(aStart, p).toLowerCase();
      while (p < len && /\s/.test(src[p])) p++;
      let value: string | null = null;
      if (src[p] === '=') {
        p++;
        while (p < len && /\s/.test(src[p])) p++;
        const q = src[p];
        if (q === '"' || q === "'") {
          const close = src.indexOf(q, p + 1);
          value = src.slice(p + 1, close === -1 ? len : close);
          p = close === -1 ? len : close + 1;
        } else {
          const vs = p;
          while (p < len && !/[\s>]/.test(src[p])) p++;
          value = src.slice(vs, p);
        }
      }
      if (aName) attrs.push({ name: aName, value, start: aStart });
    }
    const end = Math.min(len, p + 1);
    const tag: HtmlTag = { name, start: i, end, closing, selfClosing, attrs };
    out.push({ t: 'tag', tag, raw: src.slice(i, end) });
    i = textStart = end;
    if (!closing && RAW_TEXT_ELEMENTS.has(name)) {
      const re = new RegExp(`</${name}\\s*>`, 'i');
      const m = re.exec(src.slice(i));
      const contentEnd = m ? i + m.index : len;
      if (contentEnd > i) out.push({ t: 'rawtext', value: src.slice(i, contentEnd), start: i });
      i = textStart = contentEnd;
    }
  }
  flushText(len);
  return out;
}

interface Open {
  name: string;
  start: number;
  foreign: boolean;
}

/**
 * Element-structure checker: reports unclosed, mismatched and stray elements while honouring
 * void elements, raw-text elements, optional end tags and implicit closes (e.g. <p> before <div>).
 */
export function checkHtmlStructure(src: string, lines: LineIndex, isDocument: boolean): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const stack: Open[] = [];
  const ids = new Map<string, number>();
  const report = (offset: number, length: number, severity: 'error' | 'warning' | 'info', code: string, type: string, message: string, extra: { suggestion?: string; fix?: { title: string; offset: number; length: number; text: string }; related?: { offset: number; message: string } } = {}) => {
    if (diags.length > 300) return;
    diags.push(diagAt(lines, offset, length, { severity, code, type, message, source: 'HTML structure checker', suggestion: extra.suggestion, fix: extra.fix ? { title: extra.fix.title, edits: [{ offset: extra.fix.offset, length: extra.fix.length, text: extra.fix.text }] } : undefined, related: extra.related ? [relatedAt(lines, extra.related.offset, extra.related.message)] : undefined }));
  };
  const top = () => stack[stack.length - 1];
  const where = (o: number) => {
    const p = lines.positionAt(o);
    return `line ${p.line}`;
  };
  const implicitClose = (name: string) => {
    for (let guard = 0; guard < 8; guard++) {
      const t = top();
      if (!t || t.foreign) return;
      const n = t.name;
      const close =
        (n === 'p' && P_CLOSERS.has(name)) ||
        (n === 'li' && name === 'li') ||
        ((n === 'dt' || n === 'dd') && (name === 'dt' || name === 'dd')) ||
        ((n === 'td' || n === 'th') && ['td', 'th', 'tr', 'tbody', 'thead', 'tfoot'].includes(name)) ||
        (n === 'tr' && ['tr', 'tbody', 'thead', 'tfoot'].includes(name)) ||
        (['thead', 'tbody', 'tfoot'].includes(n) && ['tbody', 'thead', 'tfoot'].includes(name)) ||
        (n === 'option' && (name === 'option' || name === 'optgroup')) ||
        (n === 'optgroup' && name === 'optgroup') ||
        ((n === 'rt' || n === 'rp') && (name === 'rt' || name === 'rp')) ||
        (n === 'head' && !HEAD_CONTENT.has(name)) ||
        (n === 'colgroup' && name !== 'col' && name !== 'template') ||
        (n === 'caption' && ['tr', 'tbody', 'thead', 'tfoot', 'colgroup', 'col', 'td', 'th'].includes(name));
      if (!close) return;
      stack.pop();
    }
  };

  let sawTitle = false;
  let htmlTag: HtmlTag | null = null;
  for (const tok of tokenizeHtml(src)) {
    if (tok.t !== 'tag') continue;
    const tag = tok.tag;
    const { name } = tag;
    const inForeign = stack.some((s) => s.name === 'svg' || s.name === 'math');
    if (!tag.closing) {
      if (name === 'html') htmlTag = tag;
      if (name === 'title') sawTitle = true;
      if (DEPRECATED.has(name)) report(tag.start, name.length + 1, 'warning', 'html/deprecated-element', 'Obsolete element', `<${name}> is obsolete in HTML5; use CSS instead.`);
      const id = tag.attrs.find((a) => a.name === 'id')?.value;
      if (id) {
        const prev = ids.get(id);
        if (prev !== undefined) report(tag.start, tag.end - tag.start, 'warning', 'html/duplicate-id', 'Duplicate id', `id="${id}" is used more than once; ids must be unique in a document.`, { related: { offset: prev, message: 'First use' } });
        else ids.set(id, tag.start);
      }
      if (name === 'img' && !tag.attrs.some((a) => a.name === 'alt')) {
        report(tag.start, tag.end - tag.start, 'info', 'html/img-alt', 'Missing alt text', '<img> has no alt attribute (required for accessibility; use alt="" for decorative images).', {
          fix: { title: 'Add alt=""', offset: tag.start + 4, length: 0, text: ' alt=""' },
        });
      }
      if (!inForeign) implicitClose(name);
      if (VOID_ELEMENTS.has(name)) continue;
      if (tag.selfClosing && (inForeign || name === 'svg' || name === 'math')) continue;
      // A "/>" on a non-void HTML element is ignored by browsers (parse5 reports it): the element stays open.
      stack.push({ name, start: tag.start, foreign: inForeign || name === 'svg' || name === 'math' });
      continue;
    }
    // closing tag
    if (VOID_ELEMENTS.has(name)) {
      report(tag.start, tag.end - tag.start, 'warning', 'html/void-end-tag', 'Invalid closing tag', `<${name}> is a void element and must not have a closing tag.`, {
        fix: { title: `Remove </${name}>`, offset: tag.start, length: tag.end - tag.start, text: '' },
      });
      continue;
    }
    let idx = -1;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].name === name) {
        idx = i;
        break;
      }
    }
    if (idx === -1) {
      if (name === 'p') {
        report(tag.start, tag.end - tag.start, 'warning', 'html/stray-p-end', 'Stray </p>', 'There is no open <p> to close here (a block element such as <div> may have closed it implicitly). Browsers insert an empty paragraph.', {
          fix: { title: 'Remove </p>', offset: tag.start, length: tag.end - tag.start, text: '' },
        });
      } else if (OPTIONAL_END.has(name)) {
        // e.g. </li> after an implicit close: harmless
      } else {
        const t = top();
        report(tag.start, tag.end - tag.start, 'error', 'html/unmatched-end-tag', 'Unmatched closing tag', t ? `Closing tag </${name}> has no matching open element (the current element is <${t.name}>, opened at ${where(t.start)}).` : `Closing tag </${name}> has no matching opening tag.`, {
          fix: { title: `Remove </${name}>`, offset: tag.start, length: tag.end - tag.start, text: '' },
          related: t ? { offset: t.start, message: `<${t.name}> opened here` } : undefined,
        });
      }
      continue;
    }
    for (let i = stack.length - 1; i > idx; i--) {
      const un = stack[i];
      if (OPTIONAL_END.has(un.name) && !un.foreign) continue;
      report(un.start, un.name.length + 1, 'error', 'html/unclosed-element', 'Unclosed element', `<${un.name}> is not closed before </${name}> at ${where(tag.start)}.`, {
        suggestion: `Add </${un.name}> before </${name}>.`,
        fix: { title: `Insert </${un.name}> before </${name}>`, offset: tag.start, length: 0, text: `</${un.name}>` },
        related: { offset: tag.start, message: `</${name}>` },
      });
    }
    stack.length = idx;
  }
  for (let i = stack.length - 1; i >= 0; i--) {
    const un = stack[i];
    if (OPTIONAL_END.has(un.name) && !un.foreign) continue;
    report(un.start, un.name.length + 1, 'error', 'html/unclosed-element', 'Unclosed element', `<${un.name}> is never closed.`, {
      suggestion: `Add </${un.name}>.`,
      fix: { title: `Insert </${un.name}> at the end`, offset: src.length, length: 0, text: `</${un.name}>` },
    });
  }
  if (isDocument) {
    if (!sawTitle) report(0, 1, 'info', 'html/missing-title', 'Missing <title>', 'The document has no <title> element.');
    if (htmlTag && !htmlTag.attrs.some((a) => a.name === 'lang')) report(htmlTag.start, htmlTag.end - htmlTag.start, 'info', 'html/missing-lang', 'Missing lang', '<html> has no lang attribute (helps screen readers and translation).');
  }
  return diags;
}
