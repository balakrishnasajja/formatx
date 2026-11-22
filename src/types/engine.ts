import type { Diagnostic, DiagnosticCounts } from './diagnostics';
import type { FormatId } from './formats';
import type { FormatOptions } from './options';

export interface DetectionCandidate {
  formatId: FormatId;
  /** 0..1 */
  confidence: number;
  reasons: string[];
  /** Result of the verification parse, when one was run during detection. */
  parsed?: 'valid' | 'invalid';
}

export interface DetectionReport {
  best: DetectionCandidate | null;
  candidates: DetectionCandidate[];
  /** True when the top candidates are too close to call. */
  ambiguous: boolean;
  empty: boolean;
  durationMs: number;
}

export type ValidationStatus = 'valid' | 'warnings' | 'invalid' | 'empty' | 'unknown';

export interface ValidationReport {
  status: ValidationStatus;
  diagnostics: Diagnostic[];
  counts: DiagnosticCounts;
  /** More diagnostics existed than were returned. */
  truncated: boolean;
  validator: string;
  confidence: 'authoritative' | 'advisory' | 'lint';
}

export interface DocumentStats {
  bytes: number;
  chars: number;
  lines: number;
  /** Format-specific facts, e.g. { Keys: 12, Depth: 3 }. */
  facts: Record<string, string | number>;
}

export interface AnalyzeRequest {
  input: string;
  /** 'auto' runs detection; otherwise the given parser is forced. */
  formatId: FormatId | 'auto';
  options: FormatOptions;
  hint?: { fileName?: string };
}

export interface AnalysisResult {
  formatId: FormatId | null;
  mode: 'auto' | 'manual';
  detection: DetectionReport;
  validation: ValidationReport;
  stats: DocumentStats;
  timings: { detectMs: number; validateMs: number; totalMs: number };
}

export type ActionKind = 'beautify' | 'minify' | 'convert';

export interface ActionRequest {
  input: string;
  action: ActionKind;
  formatId: FormatId;
  targetFormatId?: FormatId;
  options: FormatOptions;
  /** Run even if an advisory validator reported errors (explicit user choice). */
  force?: boolean;
}

export interface ActionResult {
  ok: boolean;
  action: ActionKind;
  sourceFormatId: FormatId;
  outputFormatId: FormatId;
  /** Monaco language for the output editor. */
  language: string;
  text?: string;
  /** Binary output (BSON / MessagePack); `text` then holds a hex/base64 rendering. */
  binary?: Uint8Array;
  /** Conversion information-loss notices and formatter remarks. */
  warnings: Diagnostic[];
  notes: string[];
  error?: string;
  /** Validation errors that blocked the action. */
  blockedBy?: DiagnosticCounts;
  /** Errors came from an advisory validator, so "Format anyway" may be offered. */
  canForce?: boolean;
  stats: { inputBytes: number; outputBytes: number; durationMs: number };
  engine: string;
}

export interface ConversionTarget {
  formatId: FormatId;
  /** Static notes about expected information loss for this pair. */
  notes: string[];
  lossy: boolean;
}
