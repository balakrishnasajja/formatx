import type { Diagnostic, QuickFix, RelatedLocation, Severity } from '../types/diagnostics';
import type { LineIndex } from './lineIndex';

export interface DiagInit {
  severity?: Severity;
  code: string;
  type: string;
  message: string;
  source: string;
  suggestion?: string;
  fix?: QuickFix;
  related?: RelatedLocation[];
}

/** Diagnostic anchored at a UTF-16 offset range. */
export function diagAt(lines: LineIndex, offset: number, length: number, init: DiagInit): Diagnostic {
  return {
    severity: init.severity ?? 'error',
    code: init.code,
    type: init.type,
    message: init.message,
    source: init.source,
    suggestion: init.suggestion,
    fix: init.fix,
    related: init.related,
    range: lines.rangeAt(offset, length),
  };
}

/** Diagnostic anchored at a 1-based line/column (optionally with an end position). */
export function diagAtLineCol(
  lines: LineIndex,
  line: number,
  column: number,
  init: DiagInit,
  endLine?: number,
  endColumn?: number,
): Diagnostic {
  const l = Math.max(1, Math.min(line || 1, lines.lineCount));
  return {
    severity: init.severity ?? 'error',
    code: init.code,
    type: init.type,
    message: init.message,
    source: init.source,
    suggestion: init.suggestion,
    fix: init.fix,
    related: init.related,
    range: lines.rangeAtLineCol(l, Math.max(1, column || 1), endLine, endColumn),
  };
}

/** Location-less notice (used for conversion information loss). */
export function notice(init: DiagInit & { path?: string }): Diagnostic {
  return {
    severity: init.severity ?? 'warning',
    code: init.code,
    type: init.type,
    message: init.message,
    source: init.source,
    suggestion: init.suggestion,
    path: init.path,
  };
}

export function relatedAt(lines: LineIndex, offset: number, message: string): RelatedLocation {
  const p = lines.positionAt(offset);
  return { message, line: p.line, column: p.column };
}

/** Wrap an unexpected exception thrown by a third-party library into a diagnostic. */
export function internalError(lines: LineIndex, source: string, err: unknown, line = 1, column = 1): Diagnostic {
  const message = err instanceof Error ? err.message : String(err);
  return diagAtLineCol(lines, line, column, {
    code: 'internal/parser-exception',
    type: 'Parser error',
    message: firstLine(message),
    source,
  });
}

export function firstLine(s: string): string {
  const i = s.indexOf('\n');
  return (i === -1 ? s : s.slice(0, i)).trim();
}
