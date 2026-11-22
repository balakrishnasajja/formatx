import { DESCRIPTORS } from '../../engines/catalog';
import { lineRatio } from '../../engines/detection/context';
import type { Diagnostic } from '../../types/diagnostics';
import type { DetectContext, DetectScore, FormatModule, ModuleContext } from '../../types/module';
import { diagAt } from '../../utils/diag';
import { prettierErrorDiagnostic, prettierFormat } from '../common/prettier';
import { SAMPLES } from '../samples';

const SOURCE = 'Markdown lint';

/** Lint-style checks: Markdown has no invalid documents, only likely mistakes. */
function lintMarkdown(text: string, ctx: ModuleContext): { diagnostics: Diagnostic[]; facts: Record<string, number> } {
  const diags: Diagnostic[] = [];
  const facts = { Headings: 0, Links: 0, Images: 0, 'Code blocks': 0, Tables: 0, Words: 0 };
  const lines = text.split(/\r\n|\r|\n/);
  const offsets: number[] = [];
  {
    let o = 0;
    const re = /\r\n|\r|\n/g;
    offsets.push(0);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      o = m.index + m[0].length;
      offsets.push(o);
    }
  }
  const refDefs = new Set<string>();
  for (const l of lines) {
    const m = /^ {0,3}\[([^\]]+)\]:\s*\S/.exec(l);
    if (m) refDefs.add(m[1].trim().toLowerCase());
  }
  let fence: { marker: string; line: number } | null = null;
  let lastHeading = 0;
  let h1 = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const off = offsets[i];
    const fm = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fm) {
      if (!fence) {
        fence = { marker: fm[1], line: i };
        facts['Code blocks']++;
      } else if (fm[1][0] === fence.marker[0] && fm[1].length >= fence.marker.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = null;
      continue;
    }
    if (fence) continue;
    facts.Words += (line.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
    const h = /^ {0,3}(#{1,6})(\s+|$)(.*)$/.exec(line);
    if (h) {
      facts.Headings++;
      const level = h[1].length;
      if (level === 1) h1++;
      if (h1 > 1 && level === 1) diags.push(diagAt(ctx.lines, off, line.length, { severity: 'info', code: 'md/multiple-h1', type: 'Multiple top-level headings', message: 'The document has more than one H1 heading.', source: SOURCE }));
      if (lastHeading && level > lastHeading + 1) {
        diags.push(diagAt(ctx.lines, off, line.length, { severity: 'info', code: 'md/heading-increment', type: 'Skipped heading level', message: `Heading level jumps from H${lastHeading} to H${level}.`, suggestion: `Use ${'#'.repeat(lastHeading + 1)} for the next level.`, source: SOURCE }));
      }
      lastHeading = level;
      if (!h[3].trim()) diags.push(diagAt(ctx.lines, off, line.length, { severity: 'warning', code: 'md/empty-heading', type: 'Empty heading', message: 'Heading has no text.', source: SOURCE }));
    } else {
      const bad = /^ {0,3}(#{1,6})([^\s#].*)$/.exec(line);
      // "#hashtag" / "#fff" (a single word) is not meant as a heading; "#Title words" is
      if (bad && /\s/.test(bad[2].trim()) && bad[2].length > 1) {
        diags.push(
          diagAt(ctx.lines, off, line.length, {
            severity: 'warning',
            code: 'md/heading-space',
            type: 'Missing space after #',
            message: `"${line.trim().slice(0, 30)}" is not a heading: a space is required after the #.`,
            fix: { title: 'Insert space', edits: [{ offset: off + line.indexOf('#') + bad[1].length, length: 0, text: ' ' }] },
            source: SOURCE,
          }),
        );
      }
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? '')) facts.Tables++;
    for (const m of line.matchAll(/(!?)\[([^\]]*)\]\(([^)]*)\)/g)) {
      const at = off + (m.index ?? 0);
      if (m[1]) {
        facts.Images++;
        if (!m[2].trim()) diags.push(diagAt(ctx.lines, at, m[0].length, { severity: 'warning', code: 'md/image-alt', type: 'Missing alt text', message: 'Image has no alt text (needed for accessibility).', source: SOURCE }));
      } else {
        facts.Links++;
        if (!m[2].trim()) diags.push(diagAt(ctx.lines, at, m[0].length, { severity: 'warning', code: 'md/empty-link-text', type: 'Empty link text', message: 'Link has no text.', source: SOURCE }));
      }
      if (!m[3].trim()) diags.push(diagAt(ctx.lines, at, m[0].length, { severity: 'warning', code: 'md/empty-link-url', type: 'Empty link target', message: `${m[1] ? 'Image' : 'Link'} has an empty URL.`, source: SOURCE }));
    }
    for (const m of line.matchAll(/(?<!\\)\[([^\]]+)\]\[([^\]]*)\]/g)) {
      const ref = (m[2] || m[1]).trim().toLowerCase();
      if (!refDefs.has(ref)) {
        diags.push(diagAt(ctx.lines, off + (m.index ?? 0), m[0].length, { severity: 'warning', code: 'md/undefined-reference', type: 'Undefined reference', message: `Reference "[${m[2] || m[1]}]" is not defined anywhere in the document.`, suggestion: `Add a definition such as [${m[2] || m[1]}]: https://example.com`, source: SOURCE }));
      }
    }
  }
  if (fence) {
    const off = offsets[fence.line];
    diags.push(
      diagAt(ctx.lines, off, lines[fence.line].length, {
        severity: 'warning',
        code: 'md/unclosed-fence',
        type: 'Unclosed code block',
        message: `Code block opened with ${fence.marker} is never closed, so the rest of the document is rendered as code.`,
        fix: { title: `Close the code block at the end`, edits: [{ offset: text.length, length: 0, text: (text.endsWith('\n') ? '' : '\n') + fence.marker + '\n' }] },
        source: SOURCE,
      }),
    );
  }
  return { diagnostics: diags, facts };
}

function detectMarkdown(ctx: DetectContext): DetectScore | null {
  const t = ctx.trimmed;
  if (!t || t[0] === '{' || t[0] === '<' || (t[0] === '[' && /^\[[^\]]*\]\s*$/m.test(ctx.lines[0] ?? ''))) return null;
  const headings = lineRatio(ctx.lines, /^ {0,3}#{1,6}\s+\S/).count;
  const lists = lineRatio(ctx.lines, /^\s*([-*+]|\d+[.)])\s+\S/).count;
  const fences = lineRatio(ctx.lines, /^ {0,3}(```|~~~)/).count;
  const links = (ctx.head.match(/!?\[[^\]]+\]\([^)]+\)/g) ?? []).length;
  const emphasis = (ctx.head.match(/(\*\*|__)[^*_\n]+\1|`[^`\n]+`/g) ?? []).length;
  const quotes = lineRatio(ctx.lines, /^\s*>\s/).count;
  const tables = lineRatio(ctx.lines, /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/).count;
  const yamlLike = lineRatio(ctx.lines, /^\s*[\w-]+:\s/).ratio;
  const features = headings * 2 + lists * 0.5 + fences + links + emphasis * 0.5 + quotes + tables * 2;
  if (features < 1.5) return null;
  const reasons: string[] = [];
  if (headings) reasons.push('# headings');
  if (links) reasons.push('[links](url)');
  if (fences) reasons.push('``` code fences');
  if (tables) reasons.push('pipe tables');
  let score = 0.25 + Math.min(0.55, features * 0.06) - yamlLike * 0.3;
  if (headings && /^#\s/.test(t)) score += 0.1;
  return score > 0.2 ? { score: Math.min(0.92, score), reasons } : null;
}

export const markdownModule: FormatModule = {
  descriptor: DESCRIPTORS.markdown,
  sample: SAMPLES.markdown,
  detect: detectMarkdown,
  validate(input, ctx) {
    const r = lintMarkdown(input, ctx);
    return { diagnostics: r.diagnostics, facts: r.facts };
  },
  async beautify(input, ctx) {
    try {
      return { text: await prettierFormat(input, { parser: 'markdown', plugins: ['markdown'], options: ctx.options, overrides: { proseWrap: 'preserve' } }) };
    } catch (e) {
      throw new Error(prettierErrorDiagnostic(e, ctx.lines, 'Prettier', 'md/prettier').message);
    }
  },
  specialTargets: ['html'],
  async convertSpecial(input, target) {
    if (target !== 'html') throw new Error('Markdown can only be converted to HTML.');
    const { marked } = await import('marked');
    const html = await marked.parse(input, { gfm: true, async: true });
    return { text: html, warnings: [], notes: ['Rendered with marked (GitHub Flavored Markdown). Raw HTML in the Markdown is passed through; the preview is sanitized.'] };
  },
};
