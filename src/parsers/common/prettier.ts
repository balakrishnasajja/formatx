import type { Diagnostic } from '../../types/diagnostics';
import type { FormatOptions } from '../../types/options';
import { indentSize } from '../../types/options';
import { diagAtLineCol } from '../../utils/diag';
import type { LineIndex } from '../../utils/lineIndex';

type PluginName = 'babel' | 'estree' | 'postcss' | 'html' | 'markdown' | 'graphql' | 'yaml';

// Prettier and its plugins are large; they are only loaded when first needed.
const loaders: Record<PluginName, () => Promise<unknown>> = {
  babel: () => import('prettier/plugins/babel'),
  estree: () => import('prettier/plugins/estree'),
  postcss: () => import('prettier/plugins/postcss'),
  html: () => import('prettier/plugins/html'),
  markdown: () => import('prettier/plugins/markdown'),
  graphql: () => import('prettier/plugins/graphql'),
  yaml: () => import('prettier/plugins/yaml'),
};

const cache = new Map<string, Promise<unknown>>();
function load(name: string, loader: () => Promise<unknown>): Promise<unknown> {
  let p = cache.get(name);
  if (!p) {
    p = loader();
    cache.set(name, p);
  }
  return p;
}

export interface PrettierCall {
  parser: string;
  plugins: PluginName[];
  /** Extra already-loaded plugins (e.g. PHP / Java). */
  extraPlugins?: unknown[];
  options: FormatOptions;
  overrides?: Record<string, unknown>;
}

export async function prettierFormat(code: string, call: PrettierCall): Promise<string> {
  const prettier = (await load('standalone', () => import('prettier/standalone'))) as typeof import('prettier/standalone');
  const plugins = (await Promise.all(call.plugins.map((p) => load(p, loaders[p])))) as import('prettier').Plugin[];
  return prettier.format(code, {
    parser: call.parser,
    plugins: [...plugins, ...((call.extraPlugins ?? []) as import('prettier').Plugin[])],
    printWidth: call.options.printWidth,
    tabWidth: indentSize(call.options.indent),
    useTabs: call.options.indent === 'tab',
    singleQuote: call.options.quoteStyle === 'single',
    endOfLine: 'lf',
    ...call.overrides,
  });
}

/** Prettier syntax errors carry `loc.start` (1-based line, 1-based column). */
export function prettierErrorDiagnostic(err: unknown, lines: LineIndex, source: string, code: string): Diagnostic {
  const e = err as { message?: string; loc?: { start?: { line: number; column: number }; end?: { line: number; column: number } } };
  const message = (e.message ?? String(err)).split('\n')[0].replace(/\s*\(\d+:\d+\)\s*$/, '');
  const start = e.loc?.start;
  return diagAtLineCol(lines, start?.line ?? 1, start?.column ?? 1, { code, type: 'Syntax error', message, source }, e.loc?.end?.line, e.loc?.end?.column);
}
