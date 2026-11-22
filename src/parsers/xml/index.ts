import { DESCRIPTORS } from '../../engines/catalog';
import type { Diagnostic } from '../../types/diagnostics';
import type { DetectContext, DetectScore, FormatModule } from '../../types/module';
import { indentUnit } from '../../types/options';
import { LineIndex } from '../../utils/lineIndex';
import { notice } from '../../utils/diag';
import { SAMPLES } from '../samples';
import { dataToXml, xmlToData } from './xmlConvert';
import { parseXml } from './xmlParser';
import { printXml, xmlSignature } from './xmlPrinter';

/** Tag names that strongly indicate HTML rather than generic XML. */
export const HTML_TAGS = new Set(
  'html head body div span p a ul ol li table thead tbody tfoot tr td th img br hr meta link script style title h1 h2 h3 h4 h5 h6 nav header footer main section article aside form input button select option textarea label strong em b i u small iframe video audio canvas pre code blockquote figure figcaption dl dt dd noscript template picture source'.split(' '),
);

function detectXml(ctx: DetectContext): DetectScore | null {
  const t = ctx.trimmed;
  if (t[0] !== '<') return null;
  const reasons: string[] = [];
  let score = 0.55;
  if (t.startsWith('<?xml')) {
    score = 0.97;
    reasons.push('XML declaration <?xml ...?>');
  }
  const tags = [...ctx.head.slice(0, 32768).matchAll(/<([A-Za-z_][\w:.-]*)/g)].map((m) => m[1]);
  if (!tags.length && !t.startsWith('<?xml') && !t.startsWith('<!--')) return null;
  const lower = tags.map((x) => x.toLowerCase());
  const htmlish = lower.filter((x) => HTML_TAGS.has(x)).length;
  const ratio = tags.length ? htmlish / tags.length : 0;
  if (/^<!doctype\s+html/i.test(t) || lower[0] === 'html') {
    score = Math.min(score, 0.25);
    reasons.push('Looks like an HTML document');
  } else if (ratio > 0.6 && lower[0] !== 'svg') {
    score = Math.min(score, 0.35);
    reasons.push('Mostly HTML element names');
  } else if (tags.length) {
    reasons.push('Markup with custom element names');
    score += 0.1;
  }
  if (/\sxmlns(:\w+)?=/.test(ctx.head)) {
    score += 0.12;
    reasons.push('Declares XML namespaces');
  }
  if (/<!\[CDATA\[/.test(ctx.head)) score += 0.05;
  if (/<\w[\w:.-]*:[\w.-]+[\s>/]/.test(ctx.head)) score += 0.05;
  if (lower[0] === 'svg') {
    score = Math.max(score, 0.7);
    reasons.push('SVG image');
  }
  return { score: Math.min(1, score), reasons };
}

export const xmlModule: FormatModule = {
  descriptor: DESCRIPTORS.xml,
  sample: SAMPLES.xml,
  detect: detectXml,
  validate(input, ctx) {
    const r = parseXml(input, ctx.lines);
    return {
      diagnostics: r.diagnostics,
      facts: {
        Root: r.doc.root ? `<${r.doc.root.name}>` : '—',
        Elements: r.stats.elements,
        Attributes: r.stats.attributes,
        'Max depth': r.stats.maxDepth,
        ...(r.stats.comments ? { Comments: r.stats.comments } : {}),
        ...(r.stats.namespaces ? { 'Namespace declarations': r.stats.namespaces } : {}),
      },
    };
  },
  beautify(input, ctx) {
    const { doc } = parseXml(input, ctx.lines);
    const r = printXml(doc, input, { indent: indentUnit(ctx.options.indent), printWidth: ctx.options.printWidth, minify: false });
    return { text: r.text };
  },
  minify(input, ctx) {
    const { doc } = parseXml(input, ctx.lines);
    const r = printXml(doc, input, { indent: '', printWidth: Infinity, minify: true });
    const warnings: Diagnostic[] = [];
    if (r.removedComments) warnings.push(notice({ severity: 'info', code: 'xml/minify-removed-comments', type: 'Comments removed', message: `${r.removedComments} comment(s) were removed.`, source: 'XML minifier' }));
    return { text: r.text, warnings };
  },
  verifyTransform(original, output) {
    const a = parseXml(original, new LineIndex(original));
    const b = parseXml(output, new LineIndex(output));
    if (b.diagnostics.some((d) => d.severity === 'error')) return 'The formatted XML did not re-parse cleanly; the output was discarded.';
    return xmlSignature(a.doc) === xmlSignature(b.doc) ? null : 'Formatting would change the XML content; the output was discarded to protect your data.';
  },
  toData(input, ctx) {
    const { doc } = parseXml(input, ctx.lines);
    return xmlToData(doc, { attributePrefix: ctx.options.xmlAttributePrefix || '@_', inferTypes: ctx.options.inferTypes });
  },
  fromData(data, ctx) {
    const r = dataToXml(data, { indent: indentUnit(ctx.options.indent), attributePrefix: ctx.options.xmlAttributePrefix || '@_' });
    return { text: r.text, warnings: r.warnings };
  },
};
