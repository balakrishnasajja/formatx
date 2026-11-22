/**
 * Identifiers for every format FormatX knows about. Adding a format means:
 *  1. adding its id here,
 *  2. implementing a `FormatModule` in `src/parsers/<format>/`,
 *  3. registering it in `src/engines/registry.ts`.
 */
export type FormatId =
  // data
  | 'json'
  | 'jsonc'
  | 'json5'
  | 'xml'
  | 'yaml'
  | 'toml'
  | 'csv'
  | 'tsv'
  | 'ini'
  | 'env'
  | 'properties'
  // web
  | 'html'
  | 'css'
  | 'scss'
  | 'javascript'
  | 'typescript'
  | 'markdown'
  // programming
  | 'php'
  | 'python'
  | 'java'
  | 'sql'
  // api & schema
  | 'graphql'
  | 'openapi'
  | 'jsonschema'
  // advanced / binary
  | 'bson'
  | 'msgpack'
  | 'protobuf';

export type FormatCategory = 'data' | 'web' | 'programming' | 'api' | 'advanced';

export const CATEGORY_LABELS: Record<FormatCategory, string> = {
  data: 'Data',
  web: 'Web',
  programming: 'Programming',
  api: 'API & Schema',
  advanced: 'Advanced & Binary',
};

/**
 * - `full`: real parser-backed validation plus formatting (and conversion where meaningful).
 * - `partial`: some capabilities are missing or validation is heuristic/syntax-only.
 * - `planned`: listed for discoverability; not functional yet.
 */
export type SupportLevel = 'full' | 'partial' | 'planned';

/**
 * How much the validator can be trusted:
 * - `authoritative`: a spec-compliant parser; errors block formatting.
 * - `advisory`: grammar coverage is incomplete (e.g. vendor SQL dialects) — errors are
 *   reported, but the user may explicitly choose "Format anyway".
 * - `lint`: the format has no notion of "invalid" (e.g. Markdown); only warnings are produced.
 */
export type ValidatorConfidence = 'authoritative' | 'advisory' | 'lint';

export interface FormatCapabilities {
  validate: boolean;
  beautify: boolean;
  minify: boolean;
  /** Can be parsed into the neutral data model (source of conversions). */
  toData: boolean;
  /** Can be produced from the neutral data model (target of conversions). */
  fromData: boolean;
}

export interface FormatDescriptor {
  id: FormatId;
  name: string;
  /** Short label for badges, e.g. "JSON", "TS". */
  short: string;
  category: FormatCategory;
  extensions: string[];
  mimeTypes: string[];
  /** Monaco language id used for syntax highlighting. */
  monacoLanguage: string;
  support: SupportLevel;
  validatorConfidence: ValidatorConfidence;
  capabilities: FormatCapabilities;
  /** Binary formats are entered as hex/base64 text or uploaded as files. */
  binary?: boolean;
  description: string;
  /** Library / parser names, shown in the UI for transparency. */
  engines: { validator?: string; formatter?: string; minifier?: string };
  /** Honest notes about limitations. */
  notes: string[];
  /** Whether the format supports comments (beautify preserves them). */
  comments: boolean;
}
