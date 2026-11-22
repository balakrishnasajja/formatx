import type { Diagnostic } from './diagnostics';
import type { DataValue } from './data';
import type { FormatDescriptor, FormatId } from './formats';
import type { FormatOptions } from './options';
import type { LineIndex } from '../utils/lineIndex';

/** Cheap, precomputed features shared by every detector. */
export interface DetectContext {
  /** Full text (may be large). */
  text: string;
  /** First ~64 KB, used by heuristics. */
  head: string;
  /** `head` without leading/trailing whitespace (and without a BOM). */
  trimmed: string;
  firstChar: string;
  lastChar: string;
  /** Up to 400 non-empty lines from the head, right-trimmed. */
  lines: string[];
  lineCount: number;
  fileName?: string;
  /** Extension of fileName, lower-case, without dot. */
  extension?: string;
}

export interface DetectScore {
  /** 0..1 heuristic score. */
  score: number;
  reasons: string[];
}

export interface ModuleContext {
  options: FormatOptions;
  lines: LineIndex;
  /** Line ending the output should use (resolved from options + input). */
  eol?: '\n' | '\r\n';
}

export interface ValidateResult {
  diagnostics: Diagnostic[];
  facts?: Record<string, string | number>;
  /** Name of the parser actually used (e.g. dialect specific). */
  validator?: string;
  /**
   * Valid, but not characteristic of the format (e.g. text that YAML reads as a
   * single scalar). Detection then gives no confidence boost.
   */
  weakMatch?: boolean;
}

export interface TransformResult {
  text: string;
  warnings?: Diagnostic[];
  notes?: string[];
  /** Output format/language when it differs from the input (e.g. BSON → Extended JSON). */
  outputFormatId?: FormatId;
  language?: string;
}

export interface ToDataResult {
  data: DataValue;
  warnings: Diagnostic[];
}

export interface FromDataResult {
  text?: string;
  binary?: Uint8Array;
  warnings: Diagnostic[];
  notes?: string[];
}

type MaybePromise<T> = T | Promise<T>;

/**
 * The common contract every format implements. Only `descriptor` and `validate`
 * are mandatory; the engine derives available actions from the optional members.
 */
export interface FormatModule {
  descriptor: FormatDescriptor;
  sample: string;
  detect?(ctx: DetectContext): DetectScore | null;
  /**
   * How much a clean parse should raise detection confidence (0..1, default 0.6).
   * Permissive grammars (YAML, INI, CSV) that accept almost any text use a low value.
   */
  detectBoost?: number;
  validate(input: string, ctx: ModuleContext): MaybePromise<ValidateResult>;
  beautify?(input: string, ctx: ModuleContext): MaybePromise<TransformResult>;
  minify?(input: string, ctx: ModuleContext): MaybePromise<TransformResult>;
  toData?(input: string, ctx: ModuleContext): MaybePromise<ToDataResult>;
  fromData?(data: DataValue, ctx: ModuleContext): MaybePromise<FromDataResult>;
  /** Special (non data-model) conversions, e.g. Markdown → HTML. */
  specialTargets?: FormatId[];
  convertSpecial?(input: string, target: FormatId, ctx: ModuleContext): MaybePromise<FromDataResult>;
  /**
   * The module writes line endings itself (via ctx.eol) because line breaks inside
   * values are data (e.g. quoted CSV fields); the engine will not normalize them.
   */
  ownsLineEndings?: boolean;
  /**
   * Optional semantic check that a transform did not change the data
   * (e.g. parse(original) deep-equals parse(output)). Returning a string aborts the action.
   */
  verifyTransform?(original: string, output: string, ctx: ModuleContext): MaybePromise<string | null>;
}
