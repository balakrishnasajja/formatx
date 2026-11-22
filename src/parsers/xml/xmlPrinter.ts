import type { XmlDocument, XmlElement, XmlNode } from './xmlParser';

export interface XmlPrintOptions {
  indent: string;
  printWidth: number;
  minify: boolean;
}

function isWsText(n: XmlNode): boolean {
  return n.type === 'text' && /^\s*$/.test(n.raw);
}

/**
 * Element with both markup children (elements, comments, PIs) and significant character data:
 * whitespace is meaningful there, so it is never re-indented.
 */
export function isMixed(el: XmlElement): boolean {
  let hasMarkup = false;
  let hasText = false;
  for (const c of el.children) {
    if (c.type === 'element' || c.type === 'comment' || c.type === 'pi') hasMarkup = true;
    else if ((c.type === 'text' && !isWsText(c)) || c.type === 'cdata') hasText = true;
  }
  return hasMarkup && hasText;
}

function hasPreserve(el: XmlElement): 'preserve' | 'default' | null {
  const a = el.attrs.find((x) => x.name === 'xml:space');
  return a ? (a.value === 'preserve' ? 'preserve' : 'default') : null;
}

function attrText(el: XmlElement): string[] {
  return el.attrs.map((a) => `${a.name}=${a.quote}${a.value}${a.quote}`);
}

function openTag(el: XmlElement, pad: string, opts: XmlPrintOptions, selfClose: boolean): string {
  const attrs = attrText(el);
  const end = selfClose ? (opts.minify ? '/>' : ' />') : '>';
  const single = `<${el.name}${attrs.map((a) => ' ' + a).join('')}${selfClose && !attrs.length && !opts.minify ? ' />' : end}`;
  if (opts.minify || attrs.length < 2 || pad.length + single.length <= opts.printWidth) {
    return selfClose && !attrs.length ? `<${el.name}${opts.minify ? '/>' : ' />'}` : single;
  }
  const inner = pad + opts.indent;
  return `<${el.name}\n${attrs.map((a) => inner + a).join('\n')}${selfClose ? ' />' : '>'}`;
}

/** Serializes a node exactly as it appeared in the source. */
function verbatim(node: XmlNode, src: string): string {
  return src.slice(node.start, node.end);
}

/**
 * Structure-aware XML printer.
 * - element-only content is re-indented (whitespace-only text between elements is layout, not data);
 * - text-only content stays on one line, byte-for-byte;
 * - mixed content and xml:space="preserve" subtrees are emitted verbatim.
 */
export function printXml(doc: XmlDocument, src: string, opts: XmlPrintOptions): { text: string; removedComments: number } {
  const out: string[] = [];
  let removedComments = 0;
  const nl = opts.minify ? '' : '\n';

  const printChildrenInline = (el: XmlElement): string => el.children.map((c) => verbatim(c, src)).join('');

  const printNode = (node: XmlNode, level: number, preserve: boolean): string | null => {
    const pad = opts.minify ? '' : opts.indent.repeat(level);
    switch (node.type) {
      case 'text':
        return isWsText(node) ? null : pad + node.raw.trim();
      case 'comment':
        if (opts.minify) {
          removedComments++;
          return null;
        }
        return pad + `<!--${node.raw}-->`;
      case 'cdata':
        return pad + `<![CDATA[${node.raw}]]>`;
      case 'pi':
      case 'decl':
      case 'doctype':
        return pad + node.raw;
      case 'element':
        return printElement(node, level, preserve);
    }
  };

  const printElement = (el: XmlElement, level: number, inheritedPreserve: boolean): string => {
    const pad = opts.minify ? '' : opts.indent.repeat(level);
    const sp = hasPreserve(el);
    const preserve = sp === 'preserve' ? true : sp === 'default' ? false : inheritedPreserve;
    if (el.selfClosing) return pad + openTag(el, pad, opts, true);
    if (el.children.length === 0) return pad + openTag(el, pad, opts, false) + `</${el.name}>`;
    if (preserve || isMixed(el)) {
      return pad + openTag(el, pad, opts, false) + printChildrenInline(el) + `</${el.name}>`;
    }
    const hasElementChildren = el.children.some((c) => c.type === 'element' || c.type === 'comment' || c.type === 'pi');
    if (!hasElementChildren) {
      // text / CDATA only: keep exactly as written
      return pad + openTag(el, pad, opts, false) + printChildrenInline(el) + `</${el.name}>`;
    }
    const parts: string[] = [];
    for (const c of el.children) {
      const s = printNode(c, level + 1, preserve);
      if (s !== null) parts.push(s);
    }
    if (parts.length === 0) return pad + openTag(el, pad, opts, false) + `</${el.name}>`;
    return pad + openTag(el, pad, opts, false) + nl + parts.join(nl) + nl + pad + `</${el.name}>`;
  };

  for (const node of doc.children) {
    const s = printNode(node, 0, false);
    if (s !== null) out.push(s);
  }
  return { text: out.join(nl), removedComments };
}

/** Canonical form used to verify that formatting did not change document content. */
export function xmlSignature(doc: XmlDocument): string {
  const parts: string[] = [];
  const walk = (n: XmlNode, significantWs: boolean) => {
    switch (n.type) {
      case 'element': {
        parts.push(`<${n.name}`);
        for (const a of n.attrs) parts.push(` ${a.name}=${JSON.stringify(a.value)}`);
        parts.push('>');
        const sp = n.attrs.find((a) => a.name === 'xml:space');
        const keepWs = sp ? sp.value === 'preserve' : significantWs;
        const mixed = isMixed(n);
        const textOnly = !n.children.some((c) => c.type === 'element' || c.type === 'comment' || c.type === 'pi');
        for (const c of n.children) walk(c, keepWs || mixed || textOnly);
        parts.push(`</${n.name}>`);
        break;
      }
      case 'text':
        if (significantWs) parts.push(n.raw);
        else if (n.raw.trim()) parts.push(n.raw.trim());
        break;
      case 'cdata':
        parts.push(`[CDATA:${n.raw}]`);
        break;
      case 'pi':
      case 'decl':
      case 'doctype':
        parts.push(n.raw);
        break;
      case 'comment':
        break;
    }
  };
  for (const n of doc.children) walk(n, false);
  return parts.join('');
}
