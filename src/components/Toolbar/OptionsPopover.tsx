import type { ReactNode } from 'react';
import { DESCRIPTORS } from '../../engines/catalog';
import { useAppStore } from '../../hooks/useAppStore';
import { SQL_DIALECTS, type CsvDelimiter, type IndentStyle, type KeywordCase, type LineEnding, type QuoteStyle, type SqlDialect } from '../../types/options';
import { Field, Popover, PopoverContent, PopoverTrigger, Segmented, Select, Switch } from '../common/ui';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-t border-border pt-2 first:border-t-0 first:pt-0">
      <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-faint">{title}</div>
      {children}
    </div>
  );
}

export function OptionsPopover({ children }: { children: ReactNode }) {
  const o = useAppStore((s) => s.options);
  const setOptions = useAppStore((s) => s.setOptions);
  const mode = useAppStore((s) => s.formatMode);
  const detected = useAppStore((s) => s.analysis?.formatId ?? null);
  const fmt = mode === 'auto' ? detected : mode;
  const name = fmt ? DESCRIPTORS[fmt].name : '';
  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-[340px] space-y-2">
        <Section title="Formatting">
          <Field label="Indentation">
            <Segmented<IndentStyle>
              label="Indentation"
              value={o.indent}
              onChange={(v) => setOptions({ indent: v })}
              options={[
                { value: 'spaces2', label: '2 spaces' },
                { value: 'spaces4', label: '4 spaces' },
                { value: 'tab', label: 'Tab' },
              ]}
            />
          </Field>
          <Field label="Line endings">
            <Segmented<LineEnding>
              label="Line endings"
              value={o.lineEnding}
              onChange={(v) => setOptions({ lineEnding: v })}
              options={[
                { value: 'auto', label: 'Auto', title: 'Keep the line endings of the input' },
                { value: 'lf', label: 'LF' },
                { value: 'crlf', label: 'CRLF' },
              ]}
            />
          </Field>
          <Field label="Quotes" hint="JS, TS, CSS, SCSS">
            <Segmented<QuoteStyle>
              label="Quote style"
              value={o.quoteStyle}
              onChange={(v) => setOptions({ quoteStyle: v })}
              options={[
                { value: 'double', label: '"Double"' },
                { value: 'single', label: "'Single'" },
              ]}
            />
          </Field>
          <Field label="Print width" hint="Line length target">
            <input
              type="number"
              min={40}
              max={240}
              step={4}
              value={o.printWidth}
              onChange={(e) => setOptions({ printWidth: Math.max(40, Math.min(240, Number(e.target.value) || 80)) })}
              className="h-7 w-20 rounded-md border border-border-strong bg-surface-2 px-2 text-right text-xs text-text outline-none focus:border-accent"
              aria-label="Print width"
            />
          </Field>
          <Switch id="opt-sort" checked={o.sortKeys} onCheckedChange={(v) => setOptions({ sortKeys: v })} label="Sort object keys" description="JSON, JSONC, JSON5 and YAML (comments are removed when sorting JSON)." />
        </Section>

        {(fmt === 'sql' || !fmt) && (
          <Section title="SQL">
            <Field label="Dialect">
              <Select<SqlDialect> label="SQL dialect" value={o.sqlDialect} onChange={(v) => setOptions({ sqlDialect: v })} options={SQL_DIALECTS.map((d) => ({ value: d.id, label: d.label }))} />
            </Field>
            <Field label="Keyword case">
              <Segmented<KeywordCase>
                label="Keyword case"
                value={o.sqlKeywordCase}
                onChange={(v) => setOptions({ sqlKeywordCase: v })}
                options={[
                  { value: 'upper', label: 'UPPER' },
                  { value: 'lower', label: 'lower' },
                  { value: 'preserve', label: 'Keep' },
                ]}
              />
            </Field>
          </Section>
        )}

        {(fmt === 'csv' || fmt === 'tsv') && (
          <Section title="Delimited text">
            {fmt === 'csv' && (
              <Field label="Input delimiter">
                <Select<CsvDelimiter>
                  label="Input delimiter"
                  value={o.csvDelimiter}
                  onChange={(v) => setOptions({ csvDelimiter: v })}
                  options={[
                    { value: 'auto', label: 'Auto-detect' },
                    { value: ',', label: 'Comma ,' },
                    { value: ';', label: 'Semicolon ;' },
                    { value: '\t', label: 'Tab' },
                    { value: '|', label: 'Pipe |' },
                  ]}
                />
              </Field>
            )}
            <Switch id="opt-header" checked={o.csvHasHeader} onCheckedChange={(v) => setOptions({ csvHasHeader: v })} label="First row is a header" />
          </Section>
        )}

        <Section title="Conversion">
          <Field label="CSV output delimiter">
            <Select<Exclude<CsvDelimiter, 'auto'>>
              label="CSV output delimiter"
              value={o.csvOutputDelimiter}
              onChange={(v) => setOptions({ csvOutputDelimiter: v })}
              options={[
                { value: ',', label: 'Comma ,' },
                { value: ';', label: 'Semicolon ;' },
                { value: '\t', label: 'Tab' },
                { value: '|', label: 'Pipe |' },
              ]}
            />
          </Field>
          <Switch id="opt-infer" checked={o.inferTypes} onCheckedChange={(v) => setOptions({ inferTypes: v })} label="Infer types from text" description='CSV, XML, INI, ENV, Properties. Only exact round-trips: "007" stays a string.' />
          <Switch id="opt-dotted" checked={o.expandDottedKeys} onCheckedChange={(v) => setOptions({ expandDottedKeys: v })} label="Expand dotted keys" description="a.b=1 becomes { a: { b: 1 } } (CSV headers, Properties)." />
          <Field label="XML attribute prefix">
            <input
              value={o.xmlAttributePrefix}
              maxLength={4}
              onChange={(e) => setOptions({ xmlAttributePrefix: e.target.value })}
              className="h-7 w-16 rounded-md border border-border-strong bg-surface-2 px-2 font-mono text-xs text-text outline-none focus:border-accent"
              aria-label="XML attribute prefix"
            />
          </Field>
        </Section>

        <Section title="Advanced">
          <Switch id="opt-mangle" checked={o.jsMangle} onCheckedChange={(v) => setOptions({ jsMangle: v })} label="Shorten variable names" description="Terser mangle when minifying JavaScript." />
          <Field label="Binary display">
            <Segmented<'hex' | 'base64'>
              label="Binary display"
              value={o.binaryEncoding}
              onChange={(v) => setOptions({ binaryEncoding: v })}
              options={[
                { value: 'hex', label: 'Hex' },
                { value: 'base64', label: 'Base64' },
              ]}
            />
          </Field>
          <Field label="BSON → JSON" hint="Extended JSON mode">
            <Segmented<'relaxed' | 'canonical'>
              label="Extended JSON mode"
              value={o.ejsonMode}
              onChange={(v) => setOptions({ ejsonMode: v })}
              options={[
                { value: 'relaxed', label: 'Relaxed' },
                { value: 'canonical', label: 'Canonical' },
              ]}
            />
          </Field>
        </Section>
        {name && <p className="text-[11px] text-faint">Options apply to {name} where relevant; unsupported options are ignored.</p>}
      </PopoverContent>
    </Popover>
  );
}
