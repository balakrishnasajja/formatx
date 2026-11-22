import type { Diagnostic, QuickFix } from '../../types/diagnostics';
import { diagAt, relatedAt } from '../../utils/diag';
import type { LineIndex } from '../../utils/lineIndex';
import { describeChar } from '../../utils/text';

export interface XmlAttr {
  name: string;
  /** Raw value between the quotes (entities not decoded). */
  value: string;
  quote: '"' | "'";
  start: number;
  end: number;
}

export interface XmlElement {
  type: 'element';
  name: string;
  attrs: XmlAttr[];
  children: XmlNode[];
  selfClosing: boolean;
  start: number;
  /** Offset just after the start tag's '>'. */
  openEnd: number;
  /** Offset just after the end tag (or start tag when self-closing). */
  end: number;
  closed: boolean;
}

export type XmlNode =
  | XmlElement
  | { type: 'text'; raw: string; start: number; end: number }
  | { type: 'cdata'; raw: string; start: number; end: number }
  | { type: 'comment'; raw: string; start: number; end: number }
  | { type: 'pi'; target: string; raw: string; start: number; end: number }
  | { type: 'decl'; raw: string; start: number; end: number }
  | { type: 'doctype'; raw: string; start: number; end: number };

export interface XmlDocument {
  children: XmlNode[];
  root: XmlElement | null;
  /** Entities declared in the internal DTD subset (name → literal value, if simple). */
  entities: Map<string, string | null>;
  hasExternalDtd: boolean;
}

export interface XmlParseResult {
  doc: XmlDocument;
  diagnostics: Diagnostic[];
  stats: { elements: number; attributes: number; maxDepth: number; comments: number; namespaces: number };
}

const PREDEFINED = new Set(['lt', 'gt', 'amp', 'quot', 'apos']);
const SOURCE = 'XML parser';
const MAX_DIAGS = 500;

export function isNameStartCode(c: number): boolean {
  return (
    (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122) ||
    c === 95 ||
    c === 58 ||
    (c >= 0xc0 && c <= 0xd6) ||
    (c >= 0xd8 && c <= 0xf6) ||
    (c >= 0xf8 && c <= 0x2ff) ||
    (c >= 0x370 && c <= 0x37d) ||
    (c >= 0x37f && c <= 0x1fff) ||
    (c >= 0x200c && c <= 0x200d) ||
    (c >= 0x2070 && c <= 0x218f) ||
    (c >= 0x2c00 && c <= 0x2fef) ||
    (c >= 0x3001 && c <= 0xd7ff) ||
    (c >= 0xf900 && c <= 0xfdcf) ||
    (c >= 0xfdf0 && c <= 0xfffd) ||
    (c >= 0xd800 && c <= 0xdbff) // astral planes (surrogate pair start)
  );
}

export function isNameCode(c: number): boolean {
  return (
    isNameStartCode(c) ||
    c === 45 ||
    c === 46 ||
    (c >= 48 && c <= 57) ||
    c === 0xb7 ||
    (c >= 0x300 && c <= 0x36f) ||
    (c >= 0x203f && c <= 0x2040) ||
    (c >= 0xdc00 && c <= 0xdfff)
  );
}

export function isValidXmlName(s: string): boolean {
  if (!s || !isNameStartCode(s.charCodeAt(0))) return false;
  for (let i = 1; i < s.length; i++) if (!isNameCode(s.charCodeAt(i))) return false;
  return true;
}

function isWs(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

function isInvalidXmlChar(c: number): boolean {
  return (c < 0x20 && c !== 9 && c !== 10 && c !== 13) || c === 0xfffe || c === 0xffff;
}

interface OpenEl {
  el: XmlElement;
  prefixes: Set<string>;
  preserve: boolean;
}

/**
 * Well-formedness parser for XML 1.0 (+ Namespaces in XML, prefix checks as warnings).
 * Recovers from errors so that all problems in a document are reported at once.
 */
export function parseXml(text: string, lines: LineIndex): XmlParseResult {
  const diags: Diagnostic[] = [];
  const doc: XmlDocument = { children: [], root: null, entities: new Map(), hasExternalDtd: false };
  const stats = { elements: 0, attributes: 0, maxDepth: 0, comments: 0, namespaces: 0 };
  const stack: OpenEl[] = [];
  const len = text.length;
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const docStart = pos;
  let rootClosed = false;
  let sawDoctype = false;

  const err = (offset: number, length: number, code: string, type: string, message: string, extra: { suggestion?: string; fix?: QuickFix; related?: { offset: number; message: string }; severity?: 'error' | 'warning' | 'info' } = {}) => {
    if (diags.length >= MAX_DIAGS) return;
    diags.push(
      diagAt(lines, offset, length, {
        severity: extra.severity ?? 'error',
        code,
        type,
        message,
        source: SOURCE,
        suggestion: extra.suggestion,
        fix: extra.fix,
        related: extra.related ? [relatedAt(lines, extra.related.offset, extra.related.message)] : undefined,
      }),
    );
  };
  const where = (offset: number) => {
    const p = lines.positionAt(offset);
    return `line ${p.line}, column ${p.column}`;
  };
  const append = (node: XmlNode) => {
    const top = stack[stack.length - 1];
    if (top) top.el.children.push(node);
    else doc.children.push(node);
  };
  const scanName = (p: number): number => {
    if (p < len && isNameStartCode(text.charCodeAt(p))) {
      p++;
      while (p < len && isNameCode(text.charCodeAt(p))) p++;
    }
    return p;
  };
  const prefixDeclared = (prefix: string, own: Set<string>): boolean => {
    if (prefix === 'xml' || prefix === 'xmlns') return true;
    if (own.has(prefix)) return true;
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].prefixes.has(prefix)) return true;
    return false;
  };

  /** Validate '&' references in text or attribute values. */
  const checkReferences = (start: number, end: number, inAttr: boolean) => {
    let i = text.indexOf('&', start);
    while (i !== -1 && i < end) {
      const semi = text.indexOf(';', i + 1);
      const ref = semi !== -1 && semi < end ? text.slice(i + 1, semi) : null;
      if (ref === null || !/^(?:#[0-9]+|#x[0-9a-fA-F]+|[A-Za-z_:][A-Za-z0-9._:\-\u{B7}\u{C0}-\u{FFFD}]*)$/u.test(ref)) {
        err(i, 1, 'xml/unescaped-ampersand', 'Unescaped ampersand', `Unescaped '&' in ${inAttr ? 'attribute value' : 'text'}. A literal ampersand must be written as &amp;.`, {
          fix: { title: 'Replace with &amp;', edits: [{ offset: i, length: 1, text: '&amp;' }] },
        });
      } else if (ref.startsWith('#')) {
        const code = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
        const valid = code === 9 || code === 10 || code === 13 || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);
        if (!valid) err(i, semi - i + 1, 'xml/invalid-char-ref', 'Invalid character reference', `&${ref}; refers to a character that is not allowed in XML.`);
      } else if (!PREDEFINED.has(ref) && !doc.entities.has(ref)) {
        if (doc.hasExternalDtd) {
          err(i, semi - i + 1, 'xml/undeclared-entity', 'Unknown entity', `Entity &${ref}; is not declared in this document (it may be defined in the external DTD).`, { severity: 'warning' });
        } else {
          const html: Record<string, string> = { nbsp: '&#160;', copy: '&#169;', reg: '&#174;', hellip: '&#8230;', mdash: '&#8212;', ndash: '&#8211;', euro: '&#8364;' };
          err(i, semi - i + 1, 'xml/undeclared-entity', 'Undefined entity', `Entity &${ref}; is not defined. XML only predefines &lt; &gt; &amp; &quot; and &apos;.`, {
            suggestion: html[ref] ? `Use the numeric reference ${html[ref]} instead (HTML entities are not part of XML).` : 'Declare the entity in a DOCTYPE or use a numeric character reference.',
            fix: html[ref] ? { title: `Replace with ${html[ref]}`, edits: [{ offset: i, length: semi - i + 1, text: html[ref] }] } : undefined,
          });
        }
      }
      i = text.indexOf('&', i + 1);
    }
  };

  while (pos < len) {
    if (diags.length >= MAX_DIAGS) break;
    const c = text.charCodeAt(pos);
    if (c !== 60 /* < */) {
      // ---------------------------------------------------------------- text
      let end = text.indexOf('<', pos);
      if (end === -1) end = len;
      const raw = text.slice(pos, end);
      if (stack.length === 0) {
        const nonWs = raw.search(/\S/);
        if (nonWs !== -1) {
          err(pos + nonWs, Math.min(raw.trim().length, 40), 'xml/text-outside-root', 'Text outside root', rootClosed ? 'Text is not allowed after the root element.' : 'Text is not allowed before the root element.', {
            suggestion: 'All content must be inside a single root element.',
          });
        }
      } else {
        checkReferences(pos, end, false);
        const cdataEnd = raw.indexOf(']]>');
        if (cdataEnd !== -1) err(pos + cdataEnd, 3, 'xml/cdata-end-in-text', "Invalid ']]>'", "The sequence ']]>' is not allowed in text content.", { fix: { title: 'Escape as ]]&gt;', edits: [{ offset: pos + cdataEnd, length: 3, text: ']]&gt;' }] } });
      }
      for (let i = pos; i < end; i++) {
        if (isInvalidXmlChar(text.charCodeAt(i))) {
          err(i, 1, 'xml/invalid-character', 'Invalid character', `${describeChar(text[i])} is not allowed in XML documents.`);
          break;
        }
      }
      append({ type: 'text', raw, start: pos, end });
      pos = end;
      continue;
    }

    // ------------------------------------------------------------------ markup
    if (text.startsWith('<?', pos)) {
      const close = text.indexOf('?>', pos + 2);
      const nameEnd = scanName(pos + 2);
      const target = text.slice(pos + 2, nameEnd);
      if (close === -1) {
        err(pos, 2, 'xml/unterminated-pi', 'Unterminated processing instruction', `Processing instruction <?${target} is never closed with '?>'.`);
        pos = len;
        break;
      }
      const raw = text.slice(pos, close + 2);
      if (!target) {
        err(pos, 2, 'xml/pi-target', 'Invalid processing instruction', 'Processing instruction is missing its target name.');
      } else if (target.toLowerCase() === 'xml') {
        if (target !== 'xml') err(pos + 2, 3, 'xml/decl-case', 'Invalid XML declaration', `The XML declaration must be written in lowercase: <?xml, not <?${target}.`);
        if (pos !== docStart) {
          const onlyWs = /^\s*$/.test(text.slice(docStart, pos));
          err(pos, raw.length, 'xml/decl-position', 'Misplaced XML declaration', onlyWs ? 'The XML declaration must be the very first thing in the document (no whitespace before it).' : 'The XML declaration is only allowed at the very beginning of the document.', {
            fix: onlyWs ? { title: 'Remove leading whitespace', edits: [{ offset: docStart, length: pos - docStart, text: '' }] } : undefined,
          });
        }
        const body = text.slice(nameEnd, close);
        if (!/^\s+version\s*=\s*(["'])1\.[0-9]+\1/.test(body)) {
          err(pos, raw.length, 'xml/decl-version', 'Invalid XML declaration', 'The XML declaration must start with a version, e.g. <?xml version="1.0"?>.');
        }
        const enc = /\sencoding\s*=\s*(["'])([^"']*)\1/.exec(body);
        if (enc && !/^[A-Za-z][A-Za-z0-9._-]*$/.test(enc[2])) err(pos, raw.length, 'xml/decl-encoding', 'Invalid encoding name', `"${enc[2]}" is not a valid encoding name.`);
        const sa = /\sstandalone\s*=\s*(["'])([^"']*)\1/.exec(body);
        if (sa && sa[2] !== 'yes' && sa[2] !== 'no') err(pos, raw.length, 'xml/decl-standalone', 'Invalid standalone value', 'standalone must be "yes" or "no".');
        append({ type: 'decl', raw, start: pos, end: close + 2 });
        pos = close + 2;
        continue;
      }
      append({ type: 'pi', target, raw, start: pos, end: close + 2 });
      pos = close + 2;
      continue;
    }

    if (text.startsWith('<!--', pos)) {
      const close = text.indexOf('-->', pos + 4);
      stats.comments++;
      if (close === -1) {
        err(pos, 4, 'xml/unterminated-comment', 'Unterminated comment', "Comment is never closed with '-->'.", {
          fix: { title: "Insert '-->' at the end", edits: [{ offset: len, length: 0, text: ' -->' }] },
        });
        pos = len;
        break;
      }
      const content = text.slice(pos + 4, close);
      const dd = content.indexOf('--');
      if (dd !== -1) err(pos + 4 + dd, 2, 'xml/double-hyphen-in-comment', "Invalid '--' in comment", "The sequence '--' is not allowed inside XML comments.");
      else if (content.endsWith('-')) err(close - 1, 1, 'xml/comment-end', 'Invalid comment ending', "A comment cannot end with '--->'.");
      append({ type: 'comment', raw: content, start: pos, end: close + 3 });
      pos = close + 3;
      continue;
    }

    if (text.startsWith('<![CDATA[', pos)) {
      const close = text.indexOf(']]>', pos + 9);
      if (close === -1) {
        err(pos, 9, 'xml/unterminated-cdata', 'Unterminated CDATA section', "CDATA section is never closed with ']]>'.", {
          fix: { title: "Insert ']]>' at the end", edits: [{ offset: len, length: 0, text: ']]>' }] },
        });
        pos = len;
        break;
      }
      if (stack.length === 0) err(pos, 9, 'xml/cdata-outside-root', 'CDATA outside root', 'CDATA sections are only allowed inside elements.');
      append({ type: 'cdata', raw: text.slice(pos + 9, close), start: pos, end: close + 3 });
      pos = close + 3;
      continue;
    }

    if (text.startsWith('<!', pos)) {
      const upper = text.slice(pos, pos + 9).toUpperCase();
      if (upper === '<!DOCTYPE') {
        // find the end, honouring quotes and the internal subset
        let p = pos + 9;
        let depth = 0;
        let quote = 0;
        for (; p < len; p++) {
          const ch = text.charCodeAt(p);
          if (quote) {
            if (ch === quote) quote = 0;
          } else if (ch === 34 || ch === 39) quote = ch;
          else if (ch === 91) depth++;
          else if (ch === 93) depth--;
          else if (ch === 62 && depth <= 0) break;
        }
        if (p >= len) {
          err(pos, 9, 'xml/unterminated-doctype', 'Unterminated DOCTYPE', "DOCTYPE declaration is never closed with '>'.");
          pos = len;
          break;
        }
        const raw = text.slice(pos, p + 1);
        if (!text.startsWith('<!DOCTYPE', pos)) err(pos, 9, 'xml/doctype-case', 'Invalid DOCTYPE', 'DOCTYPE must be written in uppercase in XML (<!DOCTYPE ...>).');
        if (sawDoctype) err(pos, raw.length, 'xml/duplicate-doctype', 'Duplicate DOCTYPE', 'A document can only have one DOCTYPE declaration.');
        if (doc.root || stack.length) err(pos, raw.length, 'xml/doctype-position', 'Misplaced DOCTYPE', 'The DOCTYPE declaration must appear before the root element.');
        sawDoctype = true;
        const head = raw.split('[')[0];
        if (/\b(SYSTEM|PUBLIC)\b/.test(head)) doc.hasExternalDtd = true;
        const subset = raw.includes('[') ? raw.slice(raw.indexOf('[')) : '';
        const entRe = /<!ENTITY\s+(%\s+)?([^\s%>]+)\s+(?:(["'])([\s\S]*?)\3|(SYSTEM|PUBLIC))/g;
        let m: RegExpExecArray | null;
        while ((m = entRe.exec(subset))) {
          if (m[1]) continue; // parameter entity
          doc.entities.set(m[2], m[5] ? null : (m[4] ?? null));
        }
        append({ type: 'doctype', raw, start: pos, end: p + 1 });
        pos = p + 1;
        continue;
      }
      const close = text.indexOf('>', pos);
      err(pos, 2, 'xml/invalid-markup', 'Invalid markup', `Unrecognised markup '${text.slice(pos, Math.min(pos + 12, len))}…'. Expected a comment (<!-- -->), CDATA section or DOCTYPE.`);
      pos = close === -1 ? len : close + 1;
      continue;
    }

    if (text.startsWith('</', pos)) {
      // ---------------------------------------------------------- end tag
      const nameEnd = scanName(pos + 2);
      const name = text.slice(pos + 2, nameEnd);
      let p = nameEnd;
      while (p < len && isWs(text.charCodeAt(p))) p++;
      let tagEnd: number;
      if (text.charCodeAt(p) === 62) tagEnd = p + 1;
      else {
        const gt = text.indexOf('>', p);
        const lt = text.indexOf('<', p);
        const stop = gt !== -1 && (lt === -1 || gt < lt) ? gt + 1 : lt !== -1 ? lt : len;
        if (!name) err(pos, 2, 'xml/end-tag-name', 'Missing tag name', "Closing tag '</' is not followed by a valid element name.");
        else err(p, 1, 'xml/end-tag-syntax', 'Malformed closing tag', `Closing tag </${name}> may only contain the element name; expected '>'.`, { fix: gt !== -1 && gt < (lt === -1 ? Infinity : lt) ? { title: 'Remove extra content', edits: [{ offset: nameEnd, length: gt - nameEnd, text: '' }] } : undefined });
        tagEnd = stop;
      }
      if (name) {
        const idx = (() => {
          for (let i = stack.length - 1; i >= 0; i--) if (stack[i].el.name === name) return i;
          return -1;
        })();
        if (idx === stack.length - 1 && idx >= 0) {
          const open = stack.pop()!;
          open.el.closed = true;
          open.el.end = tagEnd;
          if (stack.length === 0) rootClosed = true;
        } else if (idx >= 0) {
          for (let i = stack.length - 1; i > idx; i--) {
            const un = stack[i].el;
            err(un.start, un.name.length + 1, 'xml/unclosed-element', 'Unclosed element', `Element <${un.name}> is not closed before </${name}> (${where(pos)}).`, {
              suggestion: `Add </${un.name}> before </${name}>, or make it self-closing (<${un.name}/>).`,
              fix: { title: `Insert </${un.name}> before </${name}>`, edits: [{ offset: pos, length: 0, text: `</${un.name}>` }] },
              related: { offset: pos, message: `Closing tag </${name}>` },
            });
            un.end = pos;
          }
          stack.length = idx + 1;
          const open = stack.pop()!;
          open.el.closed = true;
          open.el.end = tagEnd;
          if (stack.length === 0) rootClosed = true;
        } else {
          const top = stack[stack.length - 1];
          err(pos, tagEnd - pos, 'xml/unexpected-end-tag', 'Mismatched closing tag', top
            ? `Closing tag </${name}> does not match the open element <${top.el.name}> (opened at ${where(top.el.start)}).`
            : `Closing tag </${name}> has no matching opening tag.`, {
            suggestion: top ? `Did you mean </${top.el.name}>?` : 'Remove the closing tag or add the matching opening tag.',
            fix: top ? { title: `Replace with </${top.el.name}>`, edits: [{ offset: pos, length: tagEnd - pos, text: `</${top.el.name}>` }] } : { title: 'Remove closing tag', edits: [{ offset: pos, length: tagEnd - pos, text: '' }] },
            related: top ? { offset: top.el.start, message: `<${top.el.name}> opened here` } : undefined,
          });
        }
      }
      pos = tagEnd;
      continue;
    }

    // ------------------------------------------------------------ start tag
    const nameEnd = scanName(pos + 1);
    const name = text.slice(pos + 1, nameEnd);
    if (!name) {
      const next = text[pos + 1] ?? '';
      if (stack.length > 0 && (next === '' || /[\s=0-9<]/.test(next))) {
        err(pos, 1, 'xml/unescaped-lt', "Unescaped '<'", "Unescaped '<' in text content. A literal less-than sign must be written as &lt;.", {
          fix: { title: 'Replace with &lt;', edits: [{ offset: pos, length: 1, text: '&lt;' }] },
        });
      } else {
        err(pos, 2, 'xml/invalid-tag-name', 'Invalid tag name', next ? `Invalid element name starting with ${describeChar(next)}.` : "Unexpected '<' at end of input.", {
          suggestion: 'Element names must start with a letter, underscore or colon, directly after "<".',
        });
      }
      // treat '<' as text and continue
      append({ type: 'text', raw: '<', start: pos, end: pos + 1 });
      pos++;
      continue;
    }
    const el: XmlElement = { type: 'element', name, attrs: [], children: [], selfClosing: false, start: pos, openEnd: pos, end: pos, closed: false };
    stats.elements++;
    const ownPrefixes = new Set<string>();
    let preserve = stack.length ? stack[stack.length - 1].preserve : false;
    let p = nameEnd;
    let closedTag = false;
    let hadWs = true;
    const seenAttrs = new Map<string, number>();
    while (p < len) {
      const before = p;
      while (p < len && isWs(text.charCodeAt(p))) p++;
      hadWs = p > before;
      const ch = text.charCodeAt(p);
      if (ch === 62) {
        p++;
        closedTag = true;
        break;
      }
      if (ch === 47 && text.charCodeAt(p + 1) === 62) {
        el.selfClosing = true;
        p += 2;
        closedTag = true;
        break;
      }
      if (ch === 60 || Number.isNaN(ch)) break; // '<' or EOF: unclosed tag
      const aStart = p;
      const aNameEnd = scanName(p);
      if (aNameEnd === p) {
        err(p, 1, 'xml/invalid-attribute', 'Invalid character in tag', `Unexpected ${describeChar(text[p])} in start tag <${name}>.`, {
          suggestion: ch === 47 ? "Use '/>' to self-close the element." : 'Attributes must look like name="value".',
        });
        p++;
        continue;
      }
      const aName = text.slice(p, aNameEnd);
      if (!hadWs) {
        err(aStart, aName.length, 'xml/missing-attribute-whitespace', 'Missing whitespace', `Attributes must be separated by whitespace (before '${aName}').`, {
          fix: { title: 'Insert a space', edits: [{ offset: aStart, length: 0, text: ' ' }] },
        });
      }
      p = aNameEnd;
      while (p < len && isWs(text.charCodeAt(p))) p++;
      if (text.charCodeAt(p) !== 61 /* = */) {
        err(aStart, aName.length, 'xml/attribute-without-value', 'Attribute without value', `Attribute '${aName}' has no value. XML requires name="value" (boolean attributes are an HTML feature).`, {
          fix: { title: `Use ${aName}="${aName}"`, edits: [{ offset: aNameEnd, length: 0, text: `="${aName}"` }] },
        });
        continue;
      }
      p++;
      while (p < len && isWs(text.charCodeAt(p))) p++;
      const q = text.charCodeAt(p);
      let value = '';
      let quote: '"' | "'" = '"';
      if (q === 34 || q === 39) {
        quote = q === 34 ? '"' : "'";
        const close = text.indexOf(quote, p + 1);
        const gtOrLt = text.slice(p + 1, close === -1 ? len : close).search(/[<]/);
        if (close === -1) {
          err(p, 1, 'xml/unterminated-attribute', 'Unterminated attribute value', `Value of attribute '${aName}' is missing its closing ${quote}.`);
          p = len;
          break;
        }
        value = text.slice(p + 1, close);
        if (gtOrLt !== -1) {
          err(p + 1 + gtOrLt, 1, 'xml/lt-in-attribute', "Invalid '<' in attribute", `'<' is not allowed in attribute values ('${aName}'). Use &lt;.`, {
            fix: { title: 'Replace with &lt;', edits: [{ offset: p + 1 + gtOrLt, length: 1, text: '&lt;' }] },
          });
        }
        checkReferences(p + 1, close, true);
        p = close + 1;
      } else {
        // unquoted value: recover until whitespace or tag end
        let e = p;
        while (e < len && !isWs(text.charCodeAt(e)) && text.charCodeAt(e) !== 62 && !(text.charCodeAt(e) === 47 && text.charCodeAt(e + 1) === 62)) e++;
        value = text.slice(p, e);
        err(p, Math.max(1, e - p), 'xml/unquoted-attribute', 'Unquoted attribute value', `Value of attribute '${aName}' must be quoted.`, {
          fix: e > p ? { title: `Quote as "${value}"`, edits: [{ offset: p, length: e - p, text: `"${value.replace(/"/g, '&quot;')}"` }] } : undefined,
        });
        p = e;
      }
      const dup = seenAttrs.get(aName);
      if (dup !== undefined) {
        err(aStart, aName.length, 'xml/duplicate-attribute', 'Duplicate attribute', `Attribute '${aName}' appears more than once on <${name}>.`, {
          related: { offset: dup, message: 'First occurrence' },
        });
      } else seenAttrs.set(aName, aStart);
      if (aName === 'xmlns' || aName.startsWith('xmlns:')) {
        stats.namespaces++;
        if (aName.startsWith('xmlns:')) {
          ownPrefixes.add(aName.slice(6));
          if (value === '') err(aStart, aName.length, 'xml/empty-namespace', 'Empty namespace', `Namespace prefix '${aName.slice(6)}' cannot be bound to an empty URI.`);
        }
      }
      if (aName === 'xml:space') preserve = value === 'preserve';
      el.attrs.push({ name: aName, value, quote, start: aStart, end: p });
      stats.attributes++;
    }
    if (!closedTag) {
      err(pos, name.length + 1, 'xml/unclosed-start-tag', 'Unclosed start tag', `Start tag <${name}> is missing its closing '>'.`, {
        fix: { title: "Insert '>'", edits: [{ offset: p, length: 0, text: '>' }] },
      });
    }
    el.openEnd = p;
    el.end = p;
    // namespace prefix checks
    const elPrefix = name.includes(':') ? name.slice(0, name.indexOf(':')) : null;
    if (elPrefix && !prefixDeclared(elPrefix, ownPrefixes)) {
      err(pos + 1, name.length, 'xml/undeclared-prefix', 'Undeclared namespace prefix', `Namespace prefix '${elPrefix}' is not declared (missing xmlns:${elPrefix}="...").`, { severity: 'warning' });
    }
    for (const a of el.attrs) {
      const ap = a.name.includes(':') ? a.name.slice(0, a.name.indexOf(':')) : null;
      if (ap && ap !== 'xmlns' && !prefixDeclared(ap, ownPrefixes)) {
        err(a.start, a.name.length, 'xml/undeclared-prefix', 'Undeclared namespace prefix', `Namespace prefix '${ap}' is not declared.`, { severity: 'warning' });
      }
    }
    if (stack.length === 0) {
      if (doc.root) {
        err(pos, name.length + 1, 'xml/multiple-roots', 'Multiple root elements', `Second root element <${name}>: an XML document must have exactly one root element (<${doc.root.name}>).`, {
          suggestion: 'Wrap all top-level elements in a single parent element.',
          related: { offset: doc.root.start, message: `First root <${doc.root.name}>` },
        });
      } else doc.root = el;
    }
    append(el);
    if (el.selfClosing || !closedTag) {
      el.closed = el.selfClosing;
      if (stack.length === 0 && el.selfClosing) rootClosed = true;
    } else {
      stack.push({ el, prefixes: ownPrefixes, preserve });
      if (stack.length > stats.maxDepth) stats.maxDepth = stack.length;
    }
    pos = p;
  }

  for (let i = stack.length - 1; i >= 0; i--) {
    const un = stack[i].el;
    err(un.start, un.name.length + 1, 'xml/unclosed-element', 'Unclosed element', `Element <${un.name}> is never closed.`, {
      suggestion: `Add </${un.name}>.`,
      fix: { title: `Insert </${un.name}> at the end`, edits: [{ offset: len, length: 0, text: `</${un.name}>` }] },
    });
    un.end = len;
  }
  if (!doc.root && diags.length === 0) {
    err(docStart, 1, 'xml/no-root', 'No root element', 'The document does not contain a root element.');
  }
  return { doc, diagnostics: diags, stats };
}

/** Decode the five predefined entities, numeric references and simple internal entities. */
export function decodeXmlText(raw: string, entities?: Map<string, string | null>): { text: string; unresolved: number } {
  let unresolved = 0;
  const text = raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z_:][\w.:-]*);/g, (m, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    switch (ref) {
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'amp':
        return '&';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
    }
    const v = entities?.get(ref);
    if (typeof v === 'string' && !v.includes('&')) return v;
    unresolved++;
    return m;
  });
  return { text, unresolved };
}

/** Normalize attribute value whitespace (XML 3.3.3: tabs/newlines become spaces). */
export function normalizeAttrValue(v: string): string {
  return v.replace(/[\t\n\r]/g, ' ');
}
