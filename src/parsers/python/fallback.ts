import type { Diagnostic } from '../../types/diagnostics';
import type { ModuleContext } from '../../types/module';
import { diagAt } from '../../utils/diag';

const BLOCK_START = /^(async\s+)?(if|elif|else|for|while|def|class|try|except|finally|with)\b/;
const SOURCE = 'FormatX Python checker';

/**
 * Structural checks used when Ruff is unavailable: brackets, string literals,
 * indentation consistency and missing ':' after compound statements.
 */
export function pythonFallbackCheck(src: string, ctx: ModuleContext): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const report = (offset: number, length: number, code: string, type: string, message: string, severity: 'error' | 'warning' = 'error') => {
    if (diags.length < 200) diags.push(diagAt(ctx.lines, offset, length, { severity, code, type, message, source: SOURCE }));
  };
  const brackets: { ch: string; offset: number }[] = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const indents = [0];
  let expectIndent = false;
  let i = 0;
  const n = src.length;
  let lineStart = true;
  let logicalStart = 0;
  let logicalText = '';
  const endLogical = () => {
    // comments are skipped by the scanner, so logicalText is code only
    const t = logicalText.trim();
    const m = BLOCK_START.exec(t);
    // inline ternaries (`a if b else c`) never *start* a logical line, so a leading keyword is a statement
    if (m && !t.endsWith(':')) {
      report(logicalStart, Math.max(1, t.length), 'python/missing-colon', "Missing ':'", `Expected ':' at the end of this '${m[0].trim()}' statement.`);
    }
    expectIndent = t.endsWith(':');
    logicalText = '';
  };
  while (i < n) {
    const c = src[i];
    if (lineStart && brackets.length === 0) {
      // measure indentation of a new logical line
      let j = i;
      let width = 0;
      let tabs = false;
      let spaces = false;
      while (j < n && (src[j] === ' ' || src[j] === '\t')) {
        if (src[j] === '\t') {
          tabs = true;
          width += 8 - (width % 8);
        } else {
          spaces = true;
          width++;
        }
        j++;
      }
      const blank = j >= n || src[j] === '\n' || src[j] === '\r' || src[j] === '#';
      if (!blank) {
        if (tabs && spaces) report(i, j - i, 'python/mixed-indentation', 'Inconsistent indentation', 'Indentation mixes tabs and spaces (Python 3 raises TabError).', 'warning');
        const top = indents[indents.length - 1];
        if (expectIndent) {
          if (width <= top) report(j, 1, 'python/expected-indent', 'Expected an indented block', 'The previous line ends with ":" so this line must be indented.');
          else indents.push(width);
        } else if (width > top) {
          report(j, 1, 'python/unexpected-indent', 'Unexpected indent', 'This line is indented more than the previous block without a preceding ":".');
          indents.push(width);
        } else if (width < top) {
          while (indents.length > 1 && indents[indents.length - 1] > width) indents.pop();
          if (indents[indents.length - 1] !== width) report(j, 1, 'python/dedent-mismatch', 'Inconsistent dedent', 'Unindent does not match any outer indentation level.');
        }
        expectIndent = false;
        logicalStart = j;
      }
      lineStart = false;
      i = j;
      continue;
    }
    if (c === '#') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '\\' && (src[i + 1] === '\n' || src[i + 1] === '\r')) {
      i += src[i + 1] === '\r' && src[i + 2] === '\n' ? 3 : 2;
      logicalText += ' ';
      continue;
    }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      i++;
      if (brackets.length === 0) {
        endLogical();
        lineStart = true;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = src.startsWith(c.repeat(3), i);
      const start = i;
      i += triple ? 3 : 1;
      let closed = false;
      while (i < n) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (triple ? src.startsWith(c.repeat(3), i) : src[i] === c) {
          i += triple ? 3 : 1;
          closed = true;
          break;
        }
        if (!triple && (src[i] === '\n' || src[i] === '\r')) break;
        i++;
      }
      if (!closed) report(start, triple ? 3 : 1, 'python/unterminated-string', 'Unterminated string', triple ? 'Triple-quoted string is never closed.' : 'String literal is not closed before the end of the line.');
      logicalText += 's';
      continue;
    }
    if ('([{'.includes(c)) brackets.push({ ch: c, offset: i });
    else if (')]}'.includes(c)) {
      const top = brackets[brackets.length - 1];
      if (!top) report(i, 1, 'python/unmatched-bracket', 'Unmatched bracket', `Unmatched '${c}'.`);
      else if (top.ch !== pairs[c]) {
        report(i, 1, 'python/mismatched-bracket', 'Mismatched bracket', `'${c}' does not match '${top.ch}'.`);
        brackets.pop();
      } else brackets.pop();
    }
    logicalText += c;
    i++;
  }
  if (logicalText.trim()) endLogical();
  for (const b of brackets) report(b.offset, 1, 'python/unclosed-bracket', 'Unclosed bracket', `'${b.ch}' is never closed.`);
  return diags;
}
