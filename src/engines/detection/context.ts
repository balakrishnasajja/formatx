import type { DetectContext } from '../../types/module';

const HEAD_SIZE = 64 * 1024;

export function buildDetectContext(text: string, fileName?: string): DetectContext {
  let head = text.length > HEAD_SIZE ? text.slice(0, HEAD_SIZE) : text;
  if (head.charCodeAt(0) === 0xfeff) head = head.slice(1);
  const trimmed = head.trim();
  const lines: string[] = [];
  let lineCount = 0;
  for (const raw of head.split(/\r\n|\r|\n/)) {
    lineCount++;
    const l = raw.trimEnd();
    if (l.trim().length > 0 && lines.length < 400) lines.push(l);
  }
  const ext = fileName && fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase() : undefined;
  return {
    text,
    head,
    trimmed,
    firstChar: trimmed.charAt(0),
    lastChar: trimmed.charAt(trimmed.length - 1),
    lines,
    lineCount,
    fileName,
    extension: ext,
  };
}

/** Fraction of lines matching a pattern (ignoring comment lines matched by `comment`). */
export function lineRatio(lines: readonly string[], re: RegExp, comment?: RegExp): { ratio: number; count: number; total: number } {
  let count = 0;
  let total = 0;
  for (const l of lines) {
    if (comment && comment.test(l)) continue;
    total++;
    if (re.test(l)) count++;
  }
  return { ratio: total ? count / total : 0, count, total };
}
