import { CircleCheck, CircleMinus } from 'lucide-react';
import { DESCRIPTORS, FORMAT_ORDER } from '../../engines/catalog';
import { conversionTargets } from '../../engines/converters/targets';
import { useAppStore } from '../../hooks/useAppStore';
import { CATEGORY_LABELS } from '../../types/formats';
import { FormatIcon } from '../common/brand';
import { Badge, Dialog, Kbd, Tabs, TabsContent, TabsList, TabsTrigger } from '../common/ui';

export const SHORTCUTS: [string, string][] = [
  ['Shift Alt F', 'Beautify'],
  ['Shift Alt M', 'Minify'],
  ['Shift Alt V', 'Validate and open Problems'],
  ['Shift Alt C', 'Convert (choose target)'],
  ['Shift Alt D', 'Switch back to automatic detection'],
  ['Shift Alt Y', 'Copy output'],
  ['Ctrl S', 'Download output'],
  ['Ctrl O', 'Open a file'],
  ['Ctrl K / Ctrl Shift P', 'Command palette'],
  ['Ctrl B', 'Toggle sidebar'],
  ['Ctrl J', 'Toggle problems panel'],
  ['Ctrl F / Ctrl H', 'Find / replace in the input'],
  ['Ctrl Z / Ctrl Y', 'Undo / redo (including fixes and loaded files)'],
  ['F1', 'Editor command palette'],
];

const Yes = () => <CircleCheck size={14} className="text-success" aria-label="yes" />;
const No = () => <CircleMinus size={14} className="text-faint" aria-label="no" />;

export function DocsDialog() {
  const open = useAppStore((s) => s.dialogs.docs);
  const tab = useAppStore((s) => s.docsTab);
  const set = useAppStore((s) => s.set);
  const openDialog = useAppStore((s) => s.openDialog);
  return (
    <Dialog open={open} onOpenChange={(o) => openDialog('docs', o)} title="FormatX documentation" description="What every format supports, how conversions behave, and how your data is handled." className="w-[min(980px,calc(100vw-32px))]">
      <Tabs value={tab} onValueChange={(v) => set({ docsTab: v })}>
        <TabsList className="sticky top-0 z-10 border-b border-border bg-surface px-4 py-2">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="formats">Formats</TabsTrigger>
          <TabsTrigger value="conversions">Conversions</TabsTrigger>
          <TabsTrigger value="shortcuts">Shortcuts</TabsTrigger>
          <TabsTrigger value="privacy">Privacy</TabsTrigger>
        </TabsList>
        <div className="px-5 py-4 text-[12.5px] leading-relaxed text-text">
          <TabsContent value="overview" className="space-y-3">
            <p>
              <strong>FormatX</strong> detects the format of whatever you paste or open, validates it with a real parser for that format, and only then beautifies, minifies or converts it. Invalid input is never
              modified or converted silently — problems are listed with their exact line and column, and fixes are offered but only applied when you click them (and can be undone).
            </p>
            <ol className="list-decimal space-y-1 pl-5">
              <li>Paste, type, drop a file or load a sample. Detection runs automatically; use the format selector to force a parser.</li>
              <li>The status pill shows whether the document is valid. Click it — or a problem — to jump to the exact position.</li>
              <li>Beautify (default live action), Minify or Convert. Conversions list what information can be lost before you run them.</li>
              <li>Copy or download the result, or move it back into the input to keep working.</li>
            </ol>
            <p className="text-muted">
              Formats are marked <Badge tone="success">full</Badge> when validation and formatting are parser-backed, and <Badge tone="warning">partial</Badge> when a capability is missing or validation is
              syntax-only. Each format&apos;s limitations are listed under Formats.
            </p>
          </TabsContent>
          <TabsContent value="formats">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] border-separate border-spacing-0 text-[12px]">
                <thead>
                  <tr className="text-left text-[10.5px] uppercase tracking-wider text-faint">
                    <th className="border-b border-border py-1.5 pr-2">Format</th>
                    <th className="border-b border-border px-2">Support</th>
                    <th className="border-b border-border px-2">Validate</th>
                    <th className="border-b border-border px-2">Beautify</th>
                    <th className="border-b border-border px-2">Minify</th>
                    <th className="border-b border-border px-2">Convert</th>
                    <th className="border-b border-border px-2">Engines &amp; notes</th>
                  </tr>
                </thead>
                <tbody>
                  {FORMAT_ORDER.map((id) => {
                    const d = DESCRIPTORS[id];
                    return (
                      <tr key={id} className="align-top">
                        <td className="border-b border-border/60 py-2 pr-2">
                          <div className="flex items-center gap-1.5 font-medium">
                            <FormatIcon id={id} /> {d.name}
                          </div>
                          <div className="text-[11px] text-faint">{CATEGORY_LABELS[d.category]}</div>
                        </td>
                        <td className="border-b border-border/60 px-2 py-2">
                          <Badge tone={d.support === 'full' ? 'success' : d.support === 'partial' ? 'warning' : 'neutral'}>{d.support}</Badge>
                        </td>
                        <td className="border-b border-border/60 px-2 py-2">{d.capabilities.validate ? <span className="flex items-center gap-1"><Yes />{d.validatorConfidence !== 'authoritative' && <span className="text-[10.5px] text-muted">{d.validatorConfidence}</span>}</span> : <No />}</td>
                        <td className="border-b border-border/60 px-2 py-2">{d.capabilities.beautify ? <Yes /> : <No />}</td>
                        <td className="border-b border-border/60 px-2 py-2">{d.capabilities.minify ? <Yes /> : <No />}</td>
                        <td className="border-b border-border/60 px-2 py-2">{conversionTargets(id).length ? <span className="text-[11px] text-muted">{conversionTargets(id).length} targets</span> : <No />}</td>
                        <td className="border-b border-border/60 px-2 py-2 text-[11.5px]">
                          <div className="text-muted">{[d.engines.validator, d.engines.formatter, d.engines.minifier].filter(Boolean).join(' · ')}</div>
                          <ul className="mt-0.5 list-disc pl-4 text-faint">
                            {d.notes.map((n) => (
                              <li key={n}>{n}</li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </TabsContent>
          <TabsContent value="conversions" className="space-y-3">
            <p>
              Data formats are converted through a neutral data model that preserves key order, exact large integers (e.g. 12345678901234567890) and date types. Every conversion reports what could not be carried
              over — for example comments, nulls in TOML, nesting in CSV, or types in XML — in the output panel and the Problems list.
            </p>
            <ul className="list-disc space-y-1 pl-5 text-muted">
              <li>
                <strong className="text-text">Type inference</strong> from text formats (CSV, XML, INI, ENV, Properties) only converts values that round-trip exactly: <code>007</code> and <code>1.50</code> stay strings.
              </li>
              <li>
                <strong className="text-text">XML</strong> uses the common convention: attributes become <code>@_name</code>, text becomes <code>#text</code>, repeated elements become arrays.
              </li>
              <li>
                <strong className="text-text">CSV</strong> output flattens nested data into dotted column names; CSV input can expand them back.
              </li>
              <li>
                <strong className="text-text">BSON</strong> uses Extended JSON v2 (<code>{'{"$oid": …}'}</code>) so ObjectIds, dates and decimals survive a JSON round trip.
              </li>
              <li>
                <strong className="text-text">Markdown → HTML</strong> and <strong className="text-text">.proto → JSON descriptor</strong> are special conversions.
              </li>
            </ul>
          </TabsContent>
          <TabsContent value="shortcuts">
            <table className="text-[12.5px]">
              <tbody>
                {SHORTCUTS.map(([k, v]) => (
                  <tr key={k}>
                    <td className="py-1 pr-6">
                      {k.split(' / ').map((combo, i) => (
                        <span key={combo}>
                          {i > 0 && <span className="px-1 text-faint">/</span>}
                          <Kbd>{combo}</Kbd>
                        </span>
                      ))}
                    </td>
                    <td className="py-1 text-muted">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TabsContent>
          <TabsContent value="privacy" className="space-y-2">
            <p>All parsing, validation, formatting and conversion happens inside your browser, in a dedicated Web Worker. FormatX has no backend and makes no network requests with your data.</p>
            <ul className="list-disc space-y-1 pl-5 text-muted">
              <li>Code is only ever parsed — never executed. JavaScript minification uses Terser, which analyzes but does not run code.</li>
              <li>HTML and Markdown previews are sanitized with DOMPurify and shown in a sandboxed iframe with scripts disabled and all external requests blocked.</li>
              <li>Preferences live in localStorage. Document content is stored only if you enable &quot;Remember workspace&quot; (IndexedDB), and can be deleted at any time in Settings → Privacy.</li>
              <li>Some parsers (Prettier plugins, SQL grammars, the Ruff WebAssembly module for Python) are downloaded from this site the first time you use them.</li>
            </ul>
          </TabsContent>
        </div>
      </Tabs>
    </Dialog>
  );
}
