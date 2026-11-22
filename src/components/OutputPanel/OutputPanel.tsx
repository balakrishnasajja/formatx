import { ArrowLeftToLine, ArrowRightLeft, ChevronDown, ChevronRight, CircleX, Code, Copy, Download, Eye, Info, LoaderCircle, Minimize2, Sparkles, Table, TriangleAlert, WrapText } from 'lucide-react';
import { useState } from 'react';
import { DESCRIPTORS } from '../../engines/catalog';
import { useAppStore, type OutputView } from '../../hooks/useAppStore';
import { useEditorTheme } from '../../hooks/useTheme';
import { copyOutput, downloadOutput, revealDiagnostic, runAction, useOutputAsInput } from '../../services/controller';
import type { ActionResult } from '../../types/engine';
import { formatBytes } from '../../utils/text';
import { Button, cx, IconButton, Kbd, Segmented } from '../common/ui';
import { CodeEditor } from '../Editor/CodeEditor';
import { PreviewFrame } from './PreviewFrame';
import { TableView } from './TableView';

function describe(r: ActionResult): string {
  const src = DESCRIPTORS[r.sourceFormatId].short;
  const out = DESCRIPTORS[r.outputFormatId].short;
  if (r.action === 'convert') return `Converted ${src} → ${out}`;
  if (r.outputFormatId !== r.sourceFormatId) return `${src} decoded as ${r.language === 'json' ? 'JSON' : out}`;
  return `${r.action === 'beautify' ? 'Beautified' : 'Minified'} ${src}`;
}

function sizeDelta(r: ActionResult): string {
  const a = r.stats.inputBytes;
  const b = r.stats.outputBytes;
  if (!a) return formatBytes(b);
  const pct = Math.round(((b - a) / a) * 100);
  return `${formatBytes(a)} → ${formatBytes(b)} (${pct > 0 ? '+' : ''}${pct}%)`;
}

function Notices({ r }: { r: ActionResult }) {
  const [open, setOpen] = useState(true);
  const warn = r.warnings.filter((w) => w.severity !== 'info').length;
  if (!r.warnings.length && !r.notes.length) return null;
  return (
    <div className={cx('shrink-0 border-b px-3 py-1.5 text-[12px]', warn ? 'border-warning/30 bg-warning-soft' : 'border-border bg-surface-2')}>
      <button type="button" className="flex w-full items-center gap-1.5 text-left font-medium" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {warn ? <TriangleAlert size={13} className="text-warning" /> : <Info size={13} className="text-info" />}
        <span className={warn ? 'text-warning' : 'text-muted'}>
          {warn ? `${warn} information-loss warning${warn === 1 ? '' : 's'}` : r.warnings.length ? `${r.warnings.length} note(s)` : r.notes[0]}
        </span>
      </button>
      {open && (
        <ul className="mt-1 max-h-36 space-y-1 overflow-y-auto pl-5">
          {r.warnings.map((w, i) => (
            <li key={i} className="flex gap-1.5 text-[11.5px] leading-snug text-text">
              <span className={cx('mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full', w.severity === 'warning' ? 'bg-warning' : w.severity === 'error' ? 'bg-error' : 'bg-info')} />
              <span>
                <span className="font-semibold">{w.type}:</span> {w.message}
                {w.path && <span className="ml-1 font-mono text-[10.5px] text-faint">{w.path}</span>}
              </span>
            </li>
          ))}
          {(r.warnings.length ? r.notes : r.notes.slice(1)).map((n, i) => (
            <li key={`n${i}`} className="text-[11.5px] text-muted">
              {n}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="fx-grid-bg flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="fx-brand-gradient flex h-11 w-11 items-center justify-center rounded-2xl text-accent-contrast shadow-panel">
        <Sparkles size={20} />
      </div>
      <div className="text-[14px] font-semibold text-text">Output appears here</div>
      <p className="max-w-sm text-[12.5px] leading-relaxed text-muted">Paste or drop data into the input. FormatX detects the format, validates it and — when it is valid — beautifies it automatically.</p>
      <div className="flex flex-wrap justify-center gap-1.5 text-[11px] text-faint">
        <span>
          <Kbd>Shift Alt F</Kbd> beautify
        </span>
        <span>
          <Kbd>Shift Alt M</Kbd> minify
        </span>
        <span>
          <Kbd>Shift Alt C</Kbd> convert
        </span>
        <span>
          <Kbd>Ctrl K</Kbd> commands
        </span>
      </div>
    </div>
  );
}

function Blocked({ r }: { r: ActionResult }) {
  const analysis = useAppStore((s) => s.analysis);
  const set = useAppStore((s) => s.set);
  const errors = analysis?.validation.diagnostics.filter((d) => d.severity === 'error') ?? [];
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6">
      <div className="w-full max-w-md rounded-xl border border-error/30 bg-error-soft p-4">
        <div className="flex items-center gap-2 text-[13px] font-semibold text-error">
          <CircleX size={16} />
          {r.blockedBy ? `Fix ${r.blockedBy.error} error${r.blockedBy.error === 1 ? '' : 's'} to ${r.action}` : `${r.action[0].toUpperCase()}${r.action.slice(1)} failed`}
        </div>
        <p className="mt-1 text-[12px] leading-relaxed text-text">{r.blockedBy ? 'FormatX never changes or converts invalid input silently.' : r.error}</p>
        {r.blockedBy && errors.length > 0 && (
          <ul className="mt-2 space-y-1">
            {errors.slice(0, 4).map((d, i) => (
              <li key={i}>
                <button type="button" onClick={() => revealDiagnostic(d)} className="w-full truncate rounded-md px-1.5 py-1 text-left font-mono text-[11.5px] text-text hover:bg-error-soft">
                  <span className="text-error">Ln {d.range?.line}:{d.range?.column}</span> {d.message}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {r.blockedBy && (
            <Button size="sm" variant="secondary" onClick={() => set({ bottomOpen: true, bottomTab: 'problems' })}>
              Show problems
            </Button>
          )}
          {r.canForce && (
            <Button size="sm" variant="danger" onClick={() => void runAction(r.action, r.action === 'convert' ? r.outputFormatId : undefined, { force: true })}>
              Format anyway
            </Button>
          )}
        </div>
        {r.canForce && <p className="mt-2 text-[11px] text-muted">This validator&apos;s grammar may not cover every vendor extension, so you can format anyway (whitespace-only changes).</p>}
      </div>
    </div>
  );
}

export function OutputPanel() {
  const output = useAppStore((s) => s.output);
  const view = useAppStore((s) => s.outputView);
  const settings = useAppStore((s) => s.settings);
  const set = useAppStore((s) => s.set);
  const [wrap, setWrap] = useState(false);
  const theme = useEditorTheme();
  const result = output.status === 'done' ? output.result : null;
  const ok = !!result?.ok;
  const canPreview = ok && result!.outputFormatId === 'html';
  const canTable = ok && (result!.outputFormatId === 'csv' || result!.outputFormatId === 'tsv');
  const effectiveView: OutputView = view === 'preview' && canPreview ? 'preview' : view === 'table' && canTable ? 'table' : 'code';
  const views: { value: OutputView; label: React.ReactNode }[] = [{ value: 'code', label: <span className="flex items-center gap-1"><Code size={12} /> Code</span> }];
  if (canPreview) views.push({ value: 'preview', label: <span className="flex items-center gap-1"><Eye size={12} /> Preview</span> });
  if (canTable) views.push({ value: 'table', label: <span className="flex items-center gap-1"><Table size={12} /> Table</span> });
  const ActionIcon = result?.action === 'convert' ? ArrowRightLeft : result?.action === 'minify' ? Minimize2 : Sparkles;

  return (
    <section aria-label="Output" className="flex h-full min-w-0 flex-col bg-surface">
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border pl-3 pr-1.5">
        <span className="text-[10.5px] font-bold uppercase tracking-[0.12em] text-faint">Output</span>
        {result && ok && (
          <span className="flex min-w-0 items-center gap-1.5 truncate text-[11.5px] text-muted">
            <ActionIcon size={12} className="text-accent" />
            <span className="truncate">{describe(result)}</span>
            <span className="hidden truncate text-faint xl:inline">· {sizeDelta(result)} · {Math.round(result.stats.durationMs)} ms</span>
          </span>
        )}
        {output.status === 'running' && (
          <span className="flex items-center gap-1.5 text-[11.5px] text-muted">
            <LoaderCircle size={12} className="animate-spin text-accent" /> Working…
          </span>
        )}
        <div className="flex-1" />
        {views.length > 1 && <Segmented<OutputView> size="xs" label="Output view" value={effectiveView} onChange={(v) => set({ outputView: v })} options={views} />}
        <IconButton size="xs" label="Copy output (Shift+Alt+Y)" disabled={!ok} onClick={() => void copyOutput()}>
          <Copy size={13} />
        </IconButton>
        <IconButton size="xs" label={result?.binary ? 'Download binary file (Ctrl+S)' : 'Download (Ctrl+S)'} disabled={!ok} onClick={() => downloadOutput()}>
          <Download size={13} />
        </IconButton>
        <IconButton size="xs" label="Use output as input" disabled={!ok} onClick={() => useOutputAsInput()}>
          <ArrowLeftToLine size={13} />
        </IconButton>
        <IconButton size="xs" label="Toggle word wrap" active={wrap} onClick={() => setWrap(!wrap)}>
          <WrapText size={13} />
        </IconButton>
      </div>
      {output.status === 'done' && output.stale && ok && (
        <div className="shrink-0 border-b border-border bg-surface-2 px-3 py-1 text-[11.5px] text-muted">The input changed and currently has errors — this is the last valid result.</div>
      )}
      {result && ok && <Notices r={result} />}
      {result?.binary && ok && (
        <div className="shrink-0 border-b border-info/30 bg-info-soft px-3 py-1 text-[11.5px] text-info">
          Binary {DESCRIPTORS[result.outputFormatId].name} output ({formatBytes(result.binary.length)}) shown as {useAppStore.getState().options.binaryEncoding}. Use Download to save the real binary file.
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        {output.status === 'idle' && <EmptyState />}
        {output.status === 'running' && !result && (
          <div className="flex h-full items-center justify-center">
            <LoaderCircle size={22} className="animate-spin text-accent" />
          </div>
        )}
        {result && !ok && <Blocked r={result} />}
        {result && ok && effectiveView === 'code' && (
          <CodeEditor
            ariaLabel="Output editor"
            value={result.text ?? ''}
            language={result.language}
            theme={theme}
            readOnly
            options={{
              fontSize: settings.fontSize,
              fontLigatures: settings.fontLigatures,
              wordWrap: wrap ? 'on' : 'off',
              minimap: { enabled: settings.minimap && (result.text?.length ?? 0) < 3_000_000, renderCharacters: false },
              domReadOnly: true,
              renderLineHighlight: 'none',
              lineNumbersMinChars: 3,
              stickyScroll: { enabled: settings.stickyScroll },
            }}
          />
        )}
        {result && ok && effectiveView === 'preview' && <PreviewFrame html={result.text ?? ''} />}
        {result && ok && effectiveView === 'table' && <TableView text={result.text ?? ''} delimiter={result.outputFormatId === 'tsv' ? '\t' : undefined} />}
      </div>
    </section>
  );
}
