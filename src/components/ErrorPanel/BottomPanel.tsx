import { Activity, ChevronDown, CircleCheck, CircleX, Info, Lightbulb, ListChecks, ScrollText, TriangleAlert, Wrench } from 'lucide-react';
import { DESCRIPTORS } from '../../engines/catalog';
import { useAppStore } from '../../hooks/useAppStore';
import { applyQuickFix, revealDiagnostic } from '../../services/controller';
import { editors } from '../../services/editorRegistry';
import type { Diagnostic, Severity } from '../../types/diagnostics';
import { formatBytes } from '../../utils/text';
import { FormatIcon } from '../common/brand';
import { Button, cx, IconButton, Tabs, TabsContent, TabsList, TabsTrigger } from '../common/ui';

const SEV_ICON: Record<Severity, typeof CircleX> = { error: CircleX, warning: TriangleAlert, info: Info };
const SEV_CLS: Record<Severity, string> = { error: 'text-error', warning: 'text-warning', info: 'text-info' };

function ProblemRow({ d }: { d: Diagnostic }) {
  const Icon = SEV_ICON[d.severity];
  return (
    <div className="group border-b border-border/60 px-3 py-1 hover:bg-surface-2">
      <div className="flex items-start gap-2">
        <Icon size={14} className={cx('mt-0.5 shrink-0', SEV_CLS[d.severity])} />
        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => revealDiagnostic(d)} disabled={!d.range}>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[12.5px] font-semibold text-text">{d.type}</span>
            <span className="text-[12.5px] text-text/90">{d.message}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-faint">
            {d.range ? (
              <span className="font-mono text-muted">
                Ln {d.range.line}, Col {d.range.column}
              </span>
            ) : d.path ? (
              <span className="font-mono text-muted">{d.path}</span>
            ) : null}
            <span>{d.source}</span>
            <span className="font-mono">{d.code}</span>
          </div>
          {d.suggestion && (
            <div className="mt-0.5 flex items-start gap-1 text-[11.5px] text-muted">
              <Lightbulb size={12} className="mt-0.5 shrink-0 text-warning" />
              {d.suggestion}
            </div>
          )}
          {d.related?.map((r, i) => (
            <span
              key={i}
              role="link"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                editors.reveal(r.line, r.column);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') editors.reveal(r.line, r.column);
              }}
              className="mt-0.5 block cursor-pointer text-[11px] text-accent hover:underline"
            >
              ↳ {r.message} (Ln {r.line}, Col {r.column})
            </span>
          ))}
        </button>
        {d.fix && (
          <Button size="xs" variant="secondary" icon={<Wrench size={11} />} onClick={() => applyQuickFix(d)} title="Apply this fix (undo with Ctrl+Z)">
            {d.fix.title}
          </Button>
        )}
      </div>
    </div>
  );
}

function Problems() {
  const analysis = useAppStore((s) => s.analysis);
  const output = useAppStore((s) => s.output);
  const filter = useAppStore((s) => s.problemFilter);
  const set = useAppStore((s) => s.set);
  const diags = analysis?.validation.diagnostics ?? [];
  const conv = output.status === 'done' ? output.result.warnings : [];
  const shown = diags.filter((d) => filter[d.severity]);
  const counts = analysis?.validation.counts ?? { error: 0, warning: 0, info: 0 };
  const toggle = (s: Severity) => set({ problemFilter: { ...filter, [s]: !filter[s] } });
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-1.5 py-0.5">
        {(['error', 'warning', 'info'] as Severity[]).map((s) => {
          const Icon = SEV_ICON[s];
          return (
            <button
              key={s}
              type="button"
              aria-pressed={filter[s]}
              onClick={() => toggle(s)}
              className={cx('flex h-6 items-center gap-1 rounded-md border px-2 text-[11.5px] font-medium', filter[s] ? 'border-border-strong bg-surface-3 text-text' : 'border-transparent text-faint line-through')}
            >
              <Icon size={12} className={SEV_CLS[s]} /> {counts[s]} {s === 'error' ? (counts[s] === 1 ? 'Error' : 'Errors') : s === 'warning' ? (counts[s] === 1 ? 'Warning' : 'Warnings') : 'Info'}
            </button>
          );
        })}
        {analysis?.validation.truncated && <span className="ml-2 text-[11px] text-warning">Showing the first 1,000 problems</span>}
        <span className="ml-auto truncate text-[11px] text-faint">{analysis?.validation.validator}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {analysis && analysis.validation.status === 'valid' && !conv.length && (
          <div className="flex items-center gap-2 px-3 py-3 text-[12.5px] text-success">
            <CircleCheck size={15} /> No problems found in this {analysis.formatId ? DESCRIPTORS[analysis.formatId].name : ''} document.
          </div>
        )}
        {(!analysis || analysis.validation.status === 'empty') && <div className="px-3 py-3 text-[12.5px] text-faint">Problems in the input appear here as you type.</div>}
        {analysis?.validation.status === 'unknown' && <div className="px-3 py-3 text-[12.5px] text-muted">The format could not be detected, so nothing was validated. Choose a format in the toolbar.</div>}
        {shown.map((d, i) => (
          <ProblemRow key={`${d.code}-${i}`} d={d} />
        ))}
        {conv.length > 0 && (
          <>
            <div className="sticky top-0 border-b border-border bg-surface-2 px-3 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-faint">Output notices ({conv.length})</div>
            {conv.map((d, i) => (
              <ProblemRow key={`c-${i}`} d={d} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function Summary() {
  const a = useAppStore((s) => s.analysis);
  if (!a || a.validation.status === 'empty') return <div className="px-3 py-3 text-[12.5px] text-faint">No document yet.</div>;
  const v = a.validation;
  const rows: [string, React.ReactNode][] = [
    ['Format', a.formatId ? <span className="flex items-center gap-1.5"><FormatIcon id={a.formatId} /> {DESCRIPTORS[a.formatId].name}</span> : 'Unknown'],
    ['Mode', a.mode === 'auto' ? 'Automatic detection' : 'Manually selected'],
    ['Status', <span className={cx(v.status === 'invalid' ? 'text-error' : v.status === 'warnings' ? 'text-warning' : v.status === 'valid' ? 'text-success' : 'text-muted')}>{v.status}</span>],
    ['Problems', `${v.counts.error} errors · ${v.counts.warning} warnings · ${v.counts.info} info`],
    ['Validator', `${v.validator}${v.confidence === 'advisory' ? ' (advisory)' : v.confidence === 'lint' ? ' (lint only)' : ''}`],
    ['Size', `${formatBytes(a.stats.bytes)} · ${a.stats.chars.toLocaleString()} chars · ${a.stats.lines.toLocaleString()} lines`],
    ['Timing', `detect ${Math.round(a.timings.detectMs)} ms · validate ${Math.round(a.timings.validateMs)} ms`],
  ];
  return (
    <div className="grid h-full grid-cols-1 gap-4 overflow-y-auto p-3 lg:grid-cols-3">
      <dl className="space-y-1 text-[12px]">
        {rows.map(([k, val]) => (
          <div key={k} className="flex gap-3">
            <dt className="w-20 shrink-0 text-faint">{k}</dt>
            <dd className="min-w-0 text-text">{val}</dd>
          </div>
        ))}
      </dl>
      <div>
        <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-faint">Document facts</div>
        <dl className="space-y-1 text-[12px]">
          {Object.entries(a.stats.facts).map(([k, val]) => (
            <div key={k} className="flex gap-3">
              <dt className="w-36 shrink-0 text-faint">{k}</dt>
              <dd className="min-w-0 font-mono text-text">{String(val)}</dd>
            </div>
          ))}
          {!Object.keys(a.stats.facts).length && <div className="text-faint">—</div>}
        </dl>
      </div>
      <div>
        <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-faint">Detection</div>
        <ul className="space-y-1.5 text-[12px]">
          {a.detection.candidates.slice(0, 5).map((c) => (
            <li key={c.formatId}>
              <div className="flex items-center gap-2">
                <span className="w-24 truncate font-medium text-text">{DESCRIPTORS[c.formatId].name}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
                  <div className="fx-brand-gradient h-full rounded-full" style={{ width: `${Math.round(c.confidence * 100)}%` }} />
                </div>
                <span className="w-9 text-right font-mono text-muted">{Math.round(c.confidence * 100)}%</span>
              </div>
              {c.reasons.length > 0 && <div className="pl-[104px] text-[11px] text-faint">{c.reasons.join(' · ')}</div>}
            </li>
          ))}
          {!a.detection.candidates.length && <li className="text-faint">{a.mode === 'manual' ? 'Format chosen manually.' : 'No candidates.'}</li>}
        </ul>
      </div>
    </div>
  );
}

function Processing() {
  const log = useAppStore((s) => s.log);
  const engineStatus = useAppStore((s) => s.engineStatus);
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-1 text-[11px] text-muted">
        <span>
          Engine: <span className="font-medium text-text">{engineStatus === 'main-thread' ? 'main thread (Web Workers unavailable)' : `Web Worker · ${engineStatus}`}</span>
        </span>
        <span>Network: none — data stays in this browser tab</span>
      </div>
      <ol className="min-h-0 flex-1 overflow-y-auto font-mono text-[11.5px]">
        {log.map((l) => (
          <li key={l.id} className="flex gap-3 border-b border-border/50 px-3 py-1">
            <span className="shrink-0 text-faint">{new Date(l.time).toLocaleTimeString()}</span>
            <span className={cx('min-w-0 flex-1', l.level === 'error' ? 'text-error' : l.level === 'warn' ? 'text-warning' : 'text-text')}>{l.message}</span>
            {l.durationMs !== undefined && <span className="shrink-0 text-faint">{l.durationMs < 10 ? l.durationMs.toFixed(1) : Math.round(l.durationMs)} ms</span>}
          </li>
        ))}
        {!log.length && <li className="px-3 py-2 text-faint">Processing events appear here.</li>}
      </ol>
    </div>
  );
}

export function BottomPanel({ onCollapse }: { onCollapse: () => void }) {
  const tab = useAppStore((s) => s.bottomTab);
  const set = useAppStore((s) => s.set);
  const counts = useAppStore((s) => s.analysis?.validation.counts);
  const total = (counts?.error ?? 0) + (counts?.warning ?? 0) + (counts?.info ?? 0);
  return (
    <Tabs value={tab} onValueChange={(v) => set({ bottomTab: v as typeof tab })} className="flex h-full flex-col bg-surface">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-1.5">
        <TabsList>
          <TabsTrigger value="problems">
            <ListChecks size={13} /> Problems
            {total > 0 && <span className={cx('rounded-full px-1.5 text-[10.5px] font-bold', counts?.error ? 'bg-error-soft text-error' : 'bg-warning-soft text-warning')}>{total}</span>}
          </TabsTrigger>
          <TabsTrigger value="summary">
            <ScrollText size={13} /> Summary
          </TabsTrigger>
          <TabsTrigger value="processing">
            <Activity size={13} /> Processing
          </TabsTrigger>
        </TabsList>
        <div className="flex-1" />
        <IconButton size="xs" label="Hide panel (Ctrl+J)" onClick={onCollapse}>
          <ChevronDown size={14} />
        </IconButton>
      </div>
      <TabsContent value="problems" className="min-h-0 flex-1 outline-none">
        <Problems />
      </TabsContent>
      <TabsContent value="summary" className="min-h-0 flex-1 outline-none">
        <Summary />
      </TabsContent>
      <TabsContent value="processing" className="min-h-0 flex-1 outline-none">
        <Processing />
      </TabsContent>
    </Tabs>
  );
}
