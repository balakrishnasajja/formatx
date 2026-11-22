export type Severity = 'error' | 'warning' | 'info';

/** 1-based line/column range, compatible with Monaco markers. */
export interface SourceRange {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

/** A text replacement expressed in UTF-16 offsets of the analyzed input. */
export interface TextEdit {
  offset: number;
  length: number;
  text: string;
}

/**
 * A fix the user can apply explicitly. FormatX never applies fixes automatically —
 * the UI shows them as buttons and applies them as undoable editor edits.
 */
export interface QuickFix {
  title: string;
  edits: TextEdit[];
}

export interface RelatedLocation {
  message: string;
  line: number;
  column: number;
}

export interface Diagnostic {
  severity: Severity;
  /** Stable machine code, e.g. `json/missing-comma`. */
  code: string;
  /** Short human readable error type, e.g. "Missing comma". */
  type: string;
  message: string;
  /** Absent for location-less notices (e.g. conversion information loss). */
  range?: SourceRange;
  /** Data path for conversion notices, e.g. `$.users[0].tags`. */
  path?: string;
  suggestion?: string;
  fix?: QuickFix;
  related?: RelatedLocation[];
  /** Which parser/validator produced the diagnostic. */
  source: string;
}

export interface DiagnosticCounts {
  error: number;
  warning: number;
  info: number;
}

export function countDiagnostics(list: readonly Diagnostic[]): DiagnosticCounts {
  const counts: DiagnosticCounts = { error: 0, warning: 0, info: 0 };
  for (const d of list) counts[d.severity]++;
  return counts;
}
