import { CircleCheck, CircleX, Cpu, PanelBottom, ShieldCheck, TriangleAlert } from 'lucide-react';
import { DESCRIPTORS } from '../../engines/catalog';
import { useAppStore } from '../../hooks/useAppStore';
import { formatBytes } from '../../utils/text';
import { cx, Tooltip } from '../common/ui';

export function StatusBar() {
  const cursor = useAppStore((s) => s.cursor);
  const analysis = useAppStore((s) => s.analysis);
  const options = useAppStore((s) => s.options);
  const engineStatus = useAppStore((s) => s.engineStatus);
  const bottomOpen = useAppStore((s) => s.bottomOpen);
  const set = useAppStore((s) => s.set);
  const v = analysis?.validation;
  const fmt = analysis?.formatId ? DESCRIPTORS[analysis.formatId].name : 'Plain text';
  const indent = options.indent === 'tab' ? 'Tabs' : `Spaces: ${options.indent === 'spaces4' ? 4 : 2}`;
  const eol = options.lineEnding === 'auto' ? 'EOL: auto' : options.lineEnding.toUpperCase();
  const item = 'flex items-center gap-1 px-2 hover:bg-surface-3 hover:text-text';
  return (
    <footer className="flex h-6 shrink-0 items-center border-t border-border bg-surface-2 text-[11px] text-muted" role="status">
      <button type="button" className={cx(item, 'h-full')} onClick={() => set({ bottomOpen: !bottomOpen })} aria-label="Toggle problems panel (Ctrl+J)">
        <PanelBottom size={12} />
        {v && v.counts.error > 0 ? <CircleX size={12} className="text-error" /> : v && v.counts.warning > 0 ? <TriangleAlert size={12} className="text-warning" /> : <CircleCheck size={12} className="text-success" />}
        <span>
          {v?.counts.error ?? 0} <span className="text-faint">errors</span> · {v?.counts.warning ?? 0} <span className="text-faint">warnings</span>
        </span>
      </button>
      <span className="px-2">
        Ln {cursor.line}, Col {cursor.column}
        {cursor.selected > 0 && ` (${cursor.selected} selected)`}
      </span>
      <div className="flex-1" />
      {analysis && <span className="hidden px-2 sm:inline">{formatBytes(analysis.stats.bytes)} · {analysis.stats.lines.toLocaleString()} lines</span>}
      <span className="hidden px-2 md:inline">{indent}</span>
      <span className="hidden px-2 md:inline">{eol}</span>
      <span className="hidden px-2 md:inline">UTF-8</span>
      <span className="px-2 font-medium text-text">{fmt}</span>
      {analysis && <span className="hidden px-2 lg:inline">{Math.round(analysis.timings.totalMs)} ms</span>}
      <Tooltip content={engineStatus === 'main-thread' ? 'Web Workers are unavailable: processing runs on the main thread.' : `Processing engine runs in a Web Worker (${engineStatus}).`} side="top">
        <span className="flex items-center gap-1 px-2">
          <Cpu size={12} className={cx(engineStatus === 'busy' ? 'fx-pulse text-accent' : engineStatus === 'ready' ? 'text-success' : 'text-warning')} />
          <span className="hidden sm:inline">{engineStatus === 'main-thread' ? 'main thread' : 'worker'}</span>
        </span>
      </Tooltip>
      <span className="flex items-center gap-1 px-2 text-success">
        <ShieldCheck size={12} /> <span className="hidden sm:inline">Local</span>
      </span>
    </footer>
  );
}
