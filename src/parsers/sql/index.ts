import { DESCRIPTORS } from '../../engines/catalog';
import { lineRatio } from '../../engines/detection/context';
import type { Diagnostic } from '../../types/diagnostics';
import type { DetectContext, DetectScore, FormatModule, ModuleContext } from '../../types/module';
import { indentSize, SQL_DIALECTS, type SqlDialect } from '../../types/options';
import { diagAtLineCol, notice } from '../../utils/diag';
import { SAMPLES } from '../samples';

interface SqlParser {
  astify(sql: string, opt?: { database?: string }): unknown;
}

type ParserCtor = new () => SqlParser;

// One grammar per dialect (~300 KB each), loaded on demand.
const GRAMMARS: Partial<Record<SqlDialect, { load: () => Promise<unknown>; database: string }>> = {
  postgresql: { load: () => import('node-sql-parser/build/postgresql.js'), database: 'PostgreSQL' },
  mysql: { load: () => import('node-sql-parser/build/mysql.js'), database: 'MySQL' },
  mariadb: { load: () => import('node-sql-parser/build/mariadb.js'), database: 'MariaDB' },
  sqlite: { load: () => import('node-sql-parser/build/sqlite.js'), database: 'Sqlite' },
  tsql: { load: () => import('node-sql-parser/build/transactsql.js'), database: 'TransactSQL' },
  bigquery: { load: () => import('node-sql-parser/build/bigquery.js'), database: 'BigQuery' },
  snowflake: { load: () => import('node-sql-parser/build/snowflake.js'), database: 'Snowflake' },
  redshift: { load: () => import('node-sql-parser/build/redshift.js'), database: 'Redshift' },
  db2: { load: () => import('node-sql-parser/build/db2.js'), database: 'DB2' },
  hive: { load: () => import('node-sql-parser/build/hive.js'), database: 'Hive' },
  trino: { load: () => import('node-sql-parser/build/trino.js'), database: 'Trino' },
};

const parserCache = new Map<SqlDialect, Promise<SqlParser>>();

function getParser(dialect: SqlDialect): Promise<SqlParser> | null {
  const g = GRAMMARS[dialect];
  if (!g) return null;
  let p = parserCache.get(dialect);
  if (!p) {
    p = g.load().then((mod) => {
      const m = mod as { Parser?: ParserCtor; default?: { Parser?: ParserCtor } };
      const Ctor = m.Parser ?? m.default?.Parser;
      if (!Ctor) throw new Error(`SQL grammar for ${dialect} did not load`);
      return new Ctor();
    });
    parserCache.set(dialect, p);
  }
  return p;
}

interface PegError {
  message: string;
  location?: { start: { line: number; column: number; offset: number }; end?: { line: number; column: number } };
  found?: string | null;
  expected?: { type: string; text?: string; description?: string }[];
}

function describeExpected(e: PegError): string {
  const items = (e.expected ?? [])
    .filter((x) => x.type === 'literal' && x.text && !/^(--|\/\*|#|\s)/.test(x.text))
    .map((x) => x.text!.toUpperCase());
  const uniq = [...new Set(items)].slice(0, 8);
  return uniq.length ? ` Expected one of: ${uniq.join(', ')}.` : '';
}

async function tryParse(dialect: SqlDialect, sql: string): Promise<{ ok: true; ast: unknown } | { ok: false; error: PegError }> {
  const parser = await getParser(dialect);
  if (!parser) return { ok: true, ast: null };
  try {
    return { ok: true, ast: parser.astify(sql, { database: GRAMMARS[dialect]!.database }) };
  } catch (e) {
    return { ok: false, error: e as PegError };
  }
}

function statementSummary(ast: unknown): Record<string, string | number> {
  const list = Array.isArray(ast) ? ast : ast ? [ast] : [];
  const types = new Map<string, number>();
  for (const s of list) {
    const t = String((s as { type?: string }).type ?? 'statement').toUpperCase();
    types.set(t, (types.get(t) ?? 0) + 1);
  }
  const facts: Record<string, string | number> = { Statements: list.length };
  if (types.size) facts.Types = [...types.entries()].map(([t, n]) => (n > 1 ? `${t}×${n}` : t)).join(', ');
  return facts;
}

const DIALECT_LABEL = Object.fromEntries(SQL_DIALECTS.map((d) => [d.id, d.label])) as Record<SqlDialect, string>;

async function validateSql(input: string, ctx: ModuleContext) {
  const dialect = ctx.options.sqlDialect;
  if (dialect === 'plsql') {
    return {
      diagnostics: [{ severity: 'info' as const, code: 'sql/no-validator', type: 'Validation unavailable', message: 'Syntax validation is not available for Oracle PL/SQL; formatting is still supported.', source: 'FormatX' }],
      validator: 'none (PL/SQL)',
    };
  }
  // Standard SQL: accept the statement if either the PostgreSQL or the MySQL grammar parses it.
  const candidates: SqlDialect[] = dialect === 'sql' ? ['postgresql', 'mysql'] : [dialect];
  let firstError: PegError | null = null;
  for (const d of candidates) {
    const r = await tryParse(d, input);
    if (r.ok) return { diagnostics: [] as Diagnostic[], facts: statementSummary(r.ast), validator: `node-sql-parser (${DIALECT_LABEL[d]})` };
    firstError ??= r.error;
  }
  const e = firstError!;
  const start = e.location?.start;
  // PEG parsers report a single character; show the whole word at that position instead.
  const word = start ? /^[\w$@#]+|^\S/.exec(input.slice(start.offset))?.[0] : undefined;
  const found = e.found === null || e.found === undefined ? 'end of input' : `'${word ?? e.found}'`;
  const isPeg = !!e.location;
  const message = isPeg ? `Unexpected ${found}.${describeExpected(e)}` : e.message;
  return {
    diagnostics: [
      diagAtLineCol(ctx.lines, start?.line ?? 1, start?.column ?? 1, {
        code: 'sql/syntax-error',
        type: 'Syntax error',
        message,
        suggestion: `Checked with the ${DIALECT_LABEL[candidates[0]]} grammar. If your database accepts this statement, choose its dialect in Options or use "Format anyway".`,
        source: 'node-sql-parser',
      }),
    ],
    validator: `node-sql-parser (${candidates.map((c) => DIALECT_LABEL[c]).join(' / ')})`,
  };
}

/** Dialects where a backslash escapes the next character inside '...' strings. */
const BACKSLASH_ESCAPES = new Set<SqlDialect>(['mysql', 'mariadb', 'bigquery', 'hive']);

/**
 * Removes comments and redundant whitespace. Strings, quoted identifiers and
 * dollar-quoted bodies are copied verbatim; whitespace is only dropped next to
 * ( , ; ) where it can never change meaning.
 */
export function minifySql(sql: string, dialect: SqlDialect = 'sql'): { text: string; comments: number } {
  let out = '';
  let comments = 0;
  let pendingSpace = false;
  let i = 0;
  const n = sql.length;
  const backslash = BACKSLASH_ESCAPES.has(dialect);
  const push = (tok: string) => {
    if (pendingSpace && out) {
      const last = out[out.length - 1];
      const first = tok[0];
      if (!'(,;'.includes(last) && !'),;'.includes(first)) out += ' ';
    }
    pendingSpace = false;
    out += tok;
  };
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) {
      pendingSpace = true;
      i++;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
      comments++;
      pendingSpace = true;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      const end = close === -1 ? n : close + 2;
      // keep optimizer hints /*+ ... */
      if (sql[i + 2] === '+') push(sql.slice(i, end));
      else {
        comments++;
        pendingSpace = true;
      }
      i = end;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        if (sql[j] === '\\' && c === "'" && backslash) j++;
        j++;
      }
      push(sql.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (c === '[') {
      const close = sql.indexOf(']', i);
      const end = close === -1 ? n : close + 1;
      push(sql.slice(i, end));
      i = end;
      continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i));
      if (m) {
        const close = sql.indexOf(m[0], i + m[0].length);
        const end = close === -1 ? n : close + m[0].length;
        push(sql.slice(i, end));
        i = end;
        continue;
      }
    }
    let j = i + 1;
    if (/[\w$#@.]/.test(c)) while (j < n && /[\w$#@.]/.test(sql[j])) j++;
    push(sql.slice(i, j));
    i = j;
  }
  return { text: out.trim(), comments };
}

function detectSql(ctx: DetectContext): DetectScore | null {
  const t = ctx.trimmed;
  if (!t || t[0] === '{' || t[0] === '[' || t[0] === '<') return null;
  const starts = lineRatio(ctx.lines, /^\s*(SELECT|INSERT\s+INTO|UPDATE\s+[\w."`[\]]+\s+SET|DELETE\s+FROM|CREATE\s+(OR\s+REPLACE\s+)?(TABLE|VIEW|INDEX|UNIQUE|DATABASE|SCHEMA|FUNCTION|PROCEDURE|TRIGGER|SEQUENCE|TYPE)|ALTER\s+(TABLE|VIEW|INDEX)|DROP\s+(TABLE|VIEW|INDEX|DATABASE|SCHEMA)|WITH\s+(RECURSIVE\s+)?\w+\s+AS|MERGE\s+INTO|TRUNCATE|GRANT|REVOKE|BEGIN|COMMIT|EXPLAIN|SET\s+\w+\s*=|USE\s+\w+|DECLARE\s+@)\b/i, /^\s*--/);
  const clauses = (ctx.head.match(/\b(FROM|WHERE|JOIN|GROUP\s+BY|ORDER\s+BY|HAVING|VALUES|LIMIT|PRIMARY\s+KEY|REFERENCES|NOT\s+NULL|VARCHAR|INTEGER|UNION)\b/gi) ?? []).length;
  if (starts.count === 0 && clauses < 3) return null;
  const code = lineRatio(ctx.lines, /^\s*(const|let|var|function|import|def|class|public|private)\b|=>|\)\s*\{\s*$/).ratio;
  let score = (starts.count ? 0.55 : 0.25) + Math.min(0.3, clauses * 0.04) + (/;\s*$/m.test(t) ? 0.05 : 0) - code * 0.7;
  const reasons = ['SQL statements and clauses (SELECT, FROM, WHERE...)'];
  if (/^\s*--/m.test(ctx.head)) score += 0.03;
  return score > 0.2 ? { score: Math.min(0.95, score), reasons } : null;
}

export const sqlModule: FormatModule = {
  descriptor: DESCRIPTORS.sql,
  sample: SAMPLES.sql,
  detect: detectSql,
  validate: validateSql,
  async beautify(input, ctx) {
    const { format } = await import('sql-formatter');
    try {
      const text = format(input, {
        language: ctx.options.sqlDialect === 'tsql' ? 'tsql' : ctx.options.sqlDialect,
        tabWidth: indentSize(ctx.options.indent),
        useTabs: ctx.options.indent === 'tab',
        keywordCase: ctx.options.sqlKeywordCase,
        linesBetweenQueries: 1,
      });
      return { text, notes: [`Dialect: ${DIALECT_LABEL[ctx.options.sqlDialect]}. Keyword case: ${ctx.options.sqlKeywordCase}.`] };
    } catch (e) {
      const first = ((e as Error).message ?? String(e)).split('\n')[0];
      throw new Error(`sql-formatter could not format this statement: ${first}`);
    }
  },
  minify(input, ctx) {
    const r = minifySql(input, ctx.options.sqlDialect);
    const warnings: Diagnostic[] = r.comments ? [notice({ severity: 'info', code: 'sql/minify-removed-comments', type: 'Comments removed', message: `${r.comments} comment(s) were removed (optimizer hints /*+ */ are kept).`, source: 'SQL minifier' })] : [];
    return { text: r.text, warnings };
  },
};
