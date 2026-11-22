export type IndentStyle = 'spaces2' | 'spaces4' | 'tab';
export type LineEnding = 'auto' | 'lf' | 'crlf';
export type QuoteStyle = 'double' | 'single';
export type KeywordCase = 'upper' | 'lower' | 'preserve';
export type CsvDelimiter = 'auto' | ',' | ';' | '\t' | '|';

export type SqlDialect =
  | 'sql'
  | 'postgresql'
  | 'mysql'
  | 'mariadb'
  | 'sqlite'
  | 'tsql'
  | 'plsql'
  | 'bigquery'
  | 'snowflake'
  | 'redshift'
  | 'db2'
  | 'hive'
  | 'trino';

export const SQL_DIALECTS: { id: SqlDialect; label: string }[] = [
  { id: 'sql', label: 'Standard SQL' },
  { id: 'postgresql', label: 'PostgreSQL' },
  { id: 'mysql', label: 'MySQL' },
  { id: 'mariadb', label: 'MariaDB' },
  { id: 'sqlite', label: 'SQLite' },
  { id: 'tsql', label: 'SQL Server (T-SQL)' },
  { id: 'plsql', label: 'Oracle PL/SQL' },
  { id: 'bigquery', label: 'BigQuery' },
  { id: 'snowflake', label: 'Snowflake' },
  { id: 'redshift', label: 'Redshift' },
  { id: 'db2', label: 'IBM Db2' },
  { id: 'hive', label: 'Hive' },
  { id: 'trino', label: 'Trino / Presto' },
];

export interface FormatOptions {
  indent: IndentStyle;
  lineEnding: LineEnding;
  /** Quote style for JS/TS/CSS/SCSS output (Prettier `singleQuote`). */
  quoteStyle: QuoteStyle;
  /** Sort object keys when beautifying JSON / JSONC / JSON5 / YAML. */
  sortKeys: boolean;
  printWidth: number;
  sqlDialect: SqlDialect;
  sqlKeywordCase: KeywordCase;
  /** Delimiter used when parsing CSV input ('auto' = detect). */
  csvDelimiter: CsvDelimiter;
  /** Delimiter used when producing CSV output. */
  csvOutputDelimiter: Exclude<CsvDelimiter, 'auto'>;
  csvHasHeader: boolean;
  /** Conversions: infer numbers/booleans from untyped sources (CSV, XML, INI, ENV, Properties). */
  inferTypes: boolean;
  /** Conversions: expand dotted keys (`a.b=1`) into nested objects (CSV headers, Properties). */
  expandDottedKeys: boolean;
  /** Attribute key prefix for XML <-> data conversion. */
  xmlAttributePrefix: string;
  /** Terser: rename local variables when minifying JavaScript. */
  jsMangle: boolean;
  /** Text encoding used to display binary output (BSON / MessagePack). */
  binaryEncoding: 'hex' | 'base64';
  /** BSON → JSON uses relaxed (readable) or canonical (type-exact) Extended JSON. */
  ejsonMode: 'relaxed' | 'canonical';
}

export const DEFAULT_OPTIONS: FormatOptions = {
  indent: 'spaces2',
  lineEnding: 'auto',
  quoteStyle: 'double',
  sortKeys: false,
  printWidth: 80,
  sqlDialect: 'sql',
  sqlKeywordCase: 'upper',
  csvDelimiter: 'auto',
  csvOutputDelimiter: ',',
  csvHasHeader: true,
  inferTypes: true,
  expandDottedKeys: true,
  xmlAttributePrefix: '@_',
  jsMangle: true,
  binaryEncoding: 'hex',
  ejsonMode: 'relaxed',
};

export function indentUnit(indent: IndentStyle): string {
  return indent === 'tab' ? '\t' : indent === 'spaces4' ? '    ' : '  ';
}

export function indentSize(indent: IndentStyle): number {
  return indent === 'spaces4' ? 4 : 2;
}
