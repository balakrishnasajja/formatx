import { DESCRIPTORS } from '../../engines/catalog';
import { lineRatio } from '../../engines/detection/context';
import type { DetectContext, DetectScore, FormatModule, ModuleContext } from '../../types/module';
import { diagAtLineCol } from '../../utils/diag';
import { prettierFormat } from '../common/prettier';
import { SAMPLES } from '../samples';

/** Turn java-parser's verbose Chevrotain message into a short, readable one. */
function summarizeJavaError(message: string): { line: number; column: number; text: string } {
  const pos = /line:\s*(\d+),\s*column:\s*(\d+)/.exec(message);
  const expected = [...message.matchAll(/^\s*\d+\.\s*\[(.+?)\]\s*$/gm)]
    .map((m) => m[1].replace(/'/g, '').split(/,\s*/)[0])
    .map((t) => (/^[A-Z][a-z]+[A-Z]?\w*$/.test(t) && !['Identifier'].includes(t) ? t.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase() : t))
    .filter((v, i, a) => a.indexOf(v) === i)
    .slice(0, 6);
  const found = /but found:\s*'([^']*)'/.exec(message)?.[1];
  let text = found !== undefined ? `Unexpected ${found === '' ? 'end of input' : `'${found}'`}.` : 'Syntax error.';
  if (expected.length) text += ` Expected ${expected.length > 1 ? 'one of: ' : ''}${expected.join(', ')}.`;
  return { line: pos ? Number(pos[1]) : 1, column: pos ? Number(pos[2]) : 1, text };
}

async function validateJava(input: string, ctx: ModuleContext) {
  const { parse } = (await import('java-parser')) as { parse: (text: string) => unknown };
  try {
    const cst = parse(input) as { children?: Record<string, unknown[]> };
    const children = cst.children ?? {};
    const facts: Record<string, string | number> = {};
    const ordinary = (children.ordinaryCompilationUnit ?? []) as { children?: Record<string, unknown[]> }[];
    const unit = ordinary[0]?.children ?? {};
    facts.Imports = (unit.importDeclaration ?? []).length;
    facts['Type declarations'] = (unit.typeDeclaration ?? []).length;
    if (unit.packageDeclaration) facts.Package = 'declared';
    return { diagnostics: [], facts };
  } catch (e) {
    const { line, column, text } = summarizeJavaError((e as Error).message ?? String(e));
    return {
      diagnostics: [diagAtLineCol(ctx.lines, line, column, { code: 'java/syntax-error', type: 'Syntax error', message: text, source: 'java-parser' })],
    };
  }
}

function detectJava(ctx: DetectContext): DetectScore | null {
  const h = ctx.head;
  let score = 0;
  const reasons: string[] = [];
  if (/^\s*package\s+[\w.]+\s*;/m.test(h)) {
    score += 0.45;
    reasons.push('package declaration');
  }
  if (/^\s*import\s+(static\s+)?(java|javax|jakarta|org|com)\.[\w.*]+\s*;/m.test(h)) {
    score += 0.3;
    reasons.push('Java imports');
  }
  if (/\b(public|private|protected)\s+(abstract\s+|final\s+|static\s+)*(class|interface|enum|record)\s+[A-Z]\w*/.test(h)) {
    score += 0.35;
    reasons.push('class declaration with access modifier');
  }
  if (/System\.out\.print|public\s+static\s+void\s+main\s*\(/.test(h)) score += 0.2;
  if (/@(Override|Autowired|Test|Entity|Service|RestController)\b/.test(h)) score += 0.1;
  const semis = lineRatio(ctx.lines, /;\s*$/).ratio;
  if (semis > 0.2) score += 0.05;
  if (/^\s*using\s+System|^\s*namespace\s+\w/m.test(h)) score -= 0.6; // C#
  if (/:\s*(string|number|boolean)\b|^\s*(const|let|import .* from)\b/m.test(h)) score -= 0.4; // TypeScript
  return score > 0.3 ? { score: Math.min(0.95, score), reasons } : null;
}

export const javaModule: FormatModule = {
  descriptor: DESCRIPTORS.java,
  sample: SAMPLES.java,
  detect: detectJava,
  validate: validateJava,
  async beautify(input, ctx) {
    const plugin = await import('prettier-plugin-java');
    const p = (plugin as unknown as { default?: unknown }).default ?? plugin;
    return { text: await prettierFormat(input, { parser: 'java', plugins: [], extraPlugins: [p], options: ctx.options }) };
  },
};
