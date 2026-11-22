import { ArrowRightLeft, ChevronDown, ChevronRight, CircleCheck, CircleX, FileUp, FlaskConical, History, Minimize2, Search, ShieldCheck, Sparkles, Star, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { DESCRIPTORS, formatsByCategory } from '../../engines/catalog';
import { useAppStore, type HistoryEntry } from '../../hooks/useAppStore';
import { loadSample, restoreSnapshot, setFormatMode } from '../../services/controller';
import { CATEGORY_LABELS, type FormatCategory, type FormatId } from '../../types/formats';
import { formatBytes } from '../../utils/text';
import { CATEGORY_ICONS, FormatIcon } from '../common/brand';
import { cx, IconButton, SupportDot, Tooltip } from '../common/ui';

function timeAgo(t: number): string {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const ACTION_ICONS = { beautify: Sparkles, minify: Minimize2, convert: ArrowRightLeft, validate: ShieldCheck, open: FileUp };

function FormatRow({ id, active, favorite }: { id: FormatId; active: boolean; favorite: boolean }) {
  const d = DESCRIPTORS[id];
  const toggleFavorite = useAppStore((s) => s.toggleFavorite);
  return (
    <div className={cx('group flex h-6 items-center gap-2 rounded-md pl-2 pr-0.5 text-[12px] transition-colors', active ? 'bg-accent-soft text-text' : 'text-muted hover:bg-surface-3 hover:text-text')}>
      <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setFormatMode(id)} title={`${d.description}\nClick to parse the input as ${d.name}.`}>
        <FormatIcon id={id} className={active ? 'text-accent' : 'text-faint group-hover:text-muted'} />
        <span className="truncate">{d.name}</span>
        <SupportDot level={d.support} />
      </button>
      <span className="flex items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <IconButton size="xs" label={`Load ${d.name} sample`} onClick={() => loadSample(id)}>
          <FlaskConical size={12} />
        </IconButton>
        <IconButton size="xs" label={favorite ? 'Remove from favorites' : 'Add to favorites'} onClick={() => toggleFavorite(id)}>
          <Star size={12} className={favorite ? 'fill-warning text-warning' : ''} />
        </IconButton>
      </span>
      {favorite && <Star size={11} className="fill-warning text-warning group-hover:hidden" aria-hidden />}
    </div>
  );
}

function HistoryRow({ e }: { e: HistoryEntry }) {
  const Icon = ACTION_ICONS[e.action];
  const persist = useAppStore((s) => s.settings.persistWorkspace);
  const restorable = !!e.snapshotId && persist;
  const content = (
    <button
      type="button"
      disabled={!restorable}
      onClick={() => restorable && void restoreSnapshot(e.snapshotId!)}
      className={cx('flex w-full items-start gap-2 rounded-md px-2 py-1 text-left text-[11.5px]', restorable ? 'hover:bg-surface-3' : 'cursor-default')}
    >
      <Icon size={13} className={cx('mt-0.5 shrink-0', e.ok ? 'text-faint' : 'text-error')} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-text">{e.summary}</span>
        <span className="block text-[10.5px] text-faint">
          {timeAgo(e.time)} · {formatBytes(e.inputBytes)}
          {e.durationMs !== undefined && ` · ${Math.round(e.durationMs)} ms`}
        </span>
      </span>
      {e.ok ? <CircleCheck size={12} className="mt-0.5 shrink-0 text-success/70" /> : <CircleX size={12} className="mt-0.5 shrink-0 text-error/70" />}
    </button>
  );
  return restorable ? <Tooltip content="Restore this input">{content}</Tooltip> : content;
}

export function Sidebar() {
  const favorites = useAppStore((s) => s.favorites);
  const history = useAppStore((s) => s.history);
  const clearHistory = useAppStore((s) => s.clearHistory);
  const mode = useAppStore((s) => s.formatMode);
  const detected = useAppStore((s) => s.analysis?.formatId ?? null);
  const active = mode === 'auto' ? detected : mode;
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Partial<Record<FormatCategory | 'recent' | 'favorites', boolean>>>({});
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return formatsByCategory()
      .map((g) => ({ ...g, formats: g.formats.filter((d) => !q || d.name.toLowerCase().includes(q) || d.short.toLowerCase().includes(q) || d.extensions.some((e) => e.includes(q))) }))
      .filter((g) => g.formats.length);
  }, [query]);
  const toggle = (k: FormatCategory | 'recent' | 'favorites') => setCollapsed((c) => ({ ...c, [k]: !c[k] }));
  const header = (k: FormatCategory | 'recent' | 'favorites', label: string, Icon: typeof Star, count?: number) => (
    <button type="button" onClick={() => toggle(k)} className="flex w-full items-center gap-1.5 px-2 pb-0.5 pt-2.5 text-[10px] font-semibold uppercase tracking-wider text-faint hover:text-muted">
      {collapsed[k] ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
      <Icon size={12} />
      <span className="flex-1 text-left">{label}</span>
      {count !== undefined && <span className="font-mono normal-case">{count}</span>}
    </button>
  );

  return (
    <nav aria-label="Formats" className="flex h-full w-full flex-col bg-surface-2">
      <div className="p-1.5 pb-0">
        <label className="flex h-7 items-center gap-2 rounded-md border border-border bg-surface px-2 text-faint focus-within:border-accent">
          <Search size={13} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter formats…" className="w-full bg-transparent text-[12.5px] text-text outline-none placeholder:text-faint" aria-label="Filter formats" />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {favorites.length > 0 && !query && (
          <section>
            {header('favorites', 'Favorites', Star, favorites.length)}
            {!collapsed.favorites && favorites.map((id) => <FormatRow key={`f-${id}`} id={id} active={active === id} favorite />)}
          </section>
        )}
        {groups.map(({ category, formats }) => (
          <section key={category}>
            {header(category, CATEGORY_LABELS[category], CATEGORY_ICONS[category], formats.length)}
            {!collapsed[category] && formats.map((d) => <FormatRow key={d.id} id={d.id} active={active === d.id} favorite={favorites.includes(d.id)} />)}
          </section>
        ))}
        {!query && (
          <section>
            <div className="flex items-center">
              <div className="flex-1">{header('recent', 'Recent operations', History, history.length)}</div>
              {history.length > 0 && (
                <IconButton size="xs" label="Clear history" className="mt-2" onClick={() => clearHistory()}>
                  <Trash2 size={12} />
                </IconButton>
              )}
            </div>
            {!collapsed.recent && (history.length ? history.slice(0, 15).map((e) => <HistoryRow key={e.id} e={e} />) : <p className="px-2 py-1 text-[11.5px] text-faint">Beautify, minify or convert something to see it here.</p>)}
          </section>
        )}
      </div>
      <div className="flex items-center gap-3 border-t border-border px-3 py-1 text-[10.5px] text-faint">
        <span className="flex items-center gap-1">
          <SupportDot level="full" /> Full
        </span>
        <span className="flex items-center gap-1">
          <SupportDot level="partial" /> Partial
        </span>
        <span className="ml-auto">{Object.keys(DESCRIPTORS).length} formats</span>
      </div>
    </nav>
  );
}
