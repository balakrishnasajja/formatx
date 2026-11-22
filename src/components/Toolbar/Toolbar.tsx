import {
  ArrowRightLeft,
  ChevronDown,
  CircleCheck,
  CircleDashed,
  CircleX,
  Copy,
  Download,
  Ellipsis,
  Eraser,
  LoaderCircle,
  Minimize2,
  Redo2,
  RotateCcw,
  ScanSearch,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Star,
  TriangleAlert,
  Undo2,
} from 'lucide-react';
import { DESCRIPTORS, formatsByCategory } from '../../engines/catalog';
import { conversionTargets } from '../../engines/converters/targets';
import { useAppStore } from '../../hooks/useAppStore';
import { editors } from '../../services/editorRegistry';
import { clearInput, copyOutput, downloadOutput, resetWorkspace, runAction, setFormatMode, validateNow } from '../../services/controller';
import { CATEGORY_LABELS, type FormatId } from '../../types/formats';
import { FormatIcon } from '../common/brand';
import { Badge, Button, cx, IconButton, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Separator, SupportDot, Tooltip } from '../common/ui';
import { OptionsPopover } from './OptionsPopover';

function useEffectiveFormat(): FormatId | null {
  const mode = useAppStore((s) => s.formatMode);
  const detected = useAppStore((s) => s.analysis?.formatId ?? null);
  return mode === 'auto' ? detected : mode;
}

export function FormatSelect() {
  const mode = useAppStore((s) => s.formatMode);
  const detected = useAppStore((s) => s.analysis?.formatId ?? null);
  const favorites = useAppStore((s) => s.favorites);
  const shown = mode === 'auto' ? detected : mode;
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label="Input format"
          title={mode === 'auto' ? 'Format is detected automatically — click to force a parser' : 'Format chosen manually'}
          className="flex h-7 max-w-[200px] items-center gap-1.5 rounded-md border border-border-strong bg-surface px-2 text-left text-[12px] transition-colors hover:border-faint"
        >
          <FormatIcon id={shown} size={13} className="shrink-0 text-accent" />
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-faint">{mode === 'auto' ? 'Auto' : 'Manual'}</span>
          <span className="truncate font-medium text-text">{shown ? (DESCRIPTORS[shown].name.length > 12 ? DESCRIPTORS[shown].short : DESCRIPTORS[shown].name) : '—'}</span>
          <ChevronDown size={13} className="shrink-0 text-faint" />
        </button>
      </MenuTrigger>
      <MenuContent className="w-64">
        <MenuItem icon={<ScanSearch size={14} />} hint="Shift+Alt+D" onSelect={() => setFormatMode('auto')}>
          Auto-detect {mode === 'auto' && <span className="text-accent">✓</span>}
        </MenuItem>
        {favorites.length > 0 && (
          <>
            <MenuSeparator />
            <MenuLabel>Favorites</MenuLabel>
            {favorites.map((id) => (
              <MenuItem key={`fav-${id}`} icon={<FormatIcon id={id} />} hint={<Star size={11} className="fill-warning text-warning" />} onSelect={() => setFormatMode(id)}>
                {DESCRIPTORS[id].name}
              </MenuItem>
            ))}
          </>
        )}
        {formatsByCategory().map(({ category, formats }) => (
          <div key={category}>
            <MenuSeparator />
            <MenuLabel>{CATEGORY_LABELS[category]}</MenuLabel>
            {formats.map((d) => (
              <MenuItem key={d.id} icon={<FormatIcon id={d.id} />} hint={<SupportDot level={d.support} />} onSelect={() => setFormatMode(d.id)}>
                <span className={cx(mode === d.id && 'text-accent')}>{d.name}</span>
              </MenuItem>
            ))}
          </div>
        ))}
      </MenuContent>
    </Menu>
  );
}

export function DetectionBadge() {
  const analysis = useAppStore((s) => s.analysis);
  const mode = useAppStore((s) => s.formatMode);
  const det = analysis?.detection;
  if (!det || det.empty) return null;
  const best = det.best;
  const pct = (c: number) => `${Math.round(c * 100)}%`;
  if (!best && det.candidates.length === 0) {
    return (
      <Tooltip content="No known format matched. Pick one from the format selector.">
        <span>
          <Badge tone="neutral">Unrecognized</Badge>
        </span>
      </Tooltip>
    );
  }
  const manualMismatch = mode !== 'auto' && best && best.formatId !== mode && best.confidence > 0.6;
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" aria-label="Detection details" className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1 py-0.5 hover:bg-surface-3">
          {best ? (
            <Badge tone={det.ambiguous ? 'warning' : manualMismatch ? 'info' : 'accent'}>
              {mode === 'auto' ? '' : '≈ '}{DESCRIPTORS[best.formatId].short} {pct(best.confidence)}
            </Badge>
          ) : (
            <Badge tone="neutral">Low confidence</Badge>
          )}
          {det.ambiguous && <span className="hidden text-[11px] font-medium text-warning xl:inline">ambiguous</span>}
          <ChevronDown size={12} className="text-faint" />
        </button>
      </MenuTrigger>
      <MenuContent className="w-80">
        <MenuLabel>Detection candidates ({Math.round(det.durationMs)} ms)</MenuLabel>
        {det.candidates.slice(0, 6).map((c) => (
          <MenuItem key={c.formatId} icon={<FormatIcon id={c.formatId} />} onSelect={() => setFormatMode(c.formatId)} hint={pct(c.confidence)}>
            <div className="flex flex-col">
              <span className="font-medium">
                {DESCRIPTORS[c.formatId].name}
                {c.parsed === 'valid' && <span className="ml-1.5 text-[10.5px] text-success">parses</span>}
                {c.parsed === 'invalid' && <span className="ml-1.5 text-[10.5px] text-error">parse errors</span>}
              </span>
              {c.reasons[0] && <span className="truncate text-[11px] text-faint">{c.reasons.join(' · ')}</span>}
            </div>
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem icon={<ScanSearch size={14} />} onSelect={() => setFormatMode('auto')}>
          Use automatic detection
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

export function StatusPill() {
  const analysis = useAppStore((s) => s.analysis);
  const analyzing = useAppStore((s) => s.analyzing);
  const set = useAppStore((s) => s.set);
  const open = () => set({ bottomOpen: true, bottomTab: 'problems' });
  const base = 'flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-[11.5px] font-medium transition-colors';
  if (analyzing && !analysis) {
    return (
      <span className={cx(base, 'border-border text-muted')}>
        <LoaderCircle size={13} className="animate-spin" /> Validating…
      </span>
    );
  }
  if (!analysis || analysis.validation.status === 'empty') {
    return (
      <span className={cx(base, 'border-border text-faint')}>
        <CircleDashed size={13} /> Empty
      </span>
    );
  }
  const v = analysis.validation;
  const name = analysis.formatId ? DESCRIPTORS[analysis.formatId].short : '';
  const spinner = analyzing ? <LoaderCircle size={12} className="animate-spin opacity-60" /> : null;
  if (v.status === 'unknown') {
    return (
      <span className={cx(base, 'border-border text-faint')}>
        <CircleDashed size={13} /> Unknown format
      </span>
    );
  }
  if (v.status === 'invalid') {
    return (
      <button type="button" onClick={open} className={cx(base, 'border-error/40 bg-error-soft text-error hover:border-error')}>
        <CircleX size={13} /> {v.counts.error} error{v.counts.error === 1 ? '' : 's'}
        {v.counts.warning > 0 && <span className="text-warning">· {v.counts.warning} warn</span>} {spinner}
      </button>
    );
  }
  if (v.status === 'warnings') {
    return (
      <button type="button" onClick={open} className={cx(base, 'border-warning/40 bg-warning-soft text-warning hover:border-warning')}>
        <TriangleAlert size={13} /> Valid {name} · {v.counts.warning} warning{v.counts.warning === 1 ? '' : 's'} {spinner}
      </button>
    );
  }
  return (
    <button type="button" onClick={open} className={cx(base, 'border-success/40 bg-success-soft text-success hover:border-success')}>
      <CircleCheck size={13} /> Valid {name} {v.counts.info > 0 && <span className="text-info">· {v.counts.info} info</span>} {spinner}
    </button>
  );
}

export function ConvertButton({ compact }: { compact?: boolean }) {
  const formatId = useEffectiveFormat();
  const lastTarget = useAppStore((s) => (s.action?.kind === 'convert' ? s.action.target : undefined));
  const open = useAppStore((s) => s.dialogs.convert);
  const openDialog = useAppStore((s) => s.openDialog);
  const targets = formatId ? conversionTargets(formatId) : [];
  const quick = lastTarget && targets.some((t) => t.formatId === lastTarget) ? lastTarget : undefined;
  return (
    <div className="flex">
      <Tooltip content={quick ? `Convert to ${DESCRIPTORS[quick].name} (Shift+Alt+C for other targets)` : 'Convert to another format (Shift+Alt+C)'}>
        <Button
          size="sm"
          variant="subtle"
          className="rounded-r-none border-r-0"
          disabled={!targets.length}
          icon={<ArrowRightLeft size={14} />}
          onClick={() => (quick ? void runAction('convert', quick) : openDialog('convert', true))}
        >
          {!compact && <span className="hidden xl:inline">{quick ? `→ ${DESCRIPTORS[quick].short}` : 'Convert'}</span>}
        </Button>
      </Tooltip>
      <Menu open={open} onOpenChange={(o) => openDialog('convert', o)}>
        <MenuTrigger asChild>
          <Button size="sm" variant="subtle" aria-label="Choose conversion target" className="rounded-l-none px-1.5" disabled={!targets.length}>
            <ChevronDown size={13} />
          </Button>
        </MenuTrigger>
        <MenuContent align="end" className="w-[340px]">
          <MenuLabel>Convert {formatId ? DESCRIPTORS[formatId].name : ''} to…</MenuLabel>
          {targets.map((t) => (
            <MenuItem key={t.formatId} icon={<FormatIcon id={t.formatId} />} onSelect={() => void runAction('convert', t.formatId)}>
              <div className="flex flex-col">
                <span className="font-medium">
                  {DESCRIPTORS[t.formatId].name}
                  {!t.lossy && <span className="ml-1.5 text-[10.5px] text-success">lossless</span>}
                  {DESCRIPTORS[t.formatId].binary && <span className="ml-1.5 text-[10.5px] text-info">binary</span>}
                </span>
                {t.notes.length > 0 && <span className="whitespace-normal text-[11px] leading-snug text-faint">{t.notes.join(' · ')}</span>}
              </div>
            </MenuItem>
          ))}
          {!targets.length && <div className="px-2 py-2 text-muted">No conversions are available for this format.</div>}
        </MenuContent>
      </Menu>
    </div>
  );
}

/** Action cluster of the unified command bar (lives in the header row). */
export function ToolbarActions() {
  const formatId = useEffectiveFormat();
  const caps = formatId ? DESCRIPTORS[formatId].capabilities : null;
  const running = useAppStore((s) => s.output.status === 'running');
  const hasOutput = useAppStore((s) => s.output.status === 'done' && s.output.result.ok);
  return (
    <>
      <div className="flex items-center gap-1">
        <Tooltip content="Beautify / pretty-print (Shift+Alt+F)">
          <Button variant="primary" icon={running ? <LoaderCircle size={13} className="animate-spin" /> : <Sparkles size={13} />} disabled={!caps?.beautify} onClick={() => void runAction('beautify')}>
            <span className="hidden sm:inline">Beautify</span>
          </Button>
        </Tooltip>
        <Tooltip content={caps && !caps.minify ? `Minify is not available for ${formatId ? DESCRIPTORS[formatId].name : 'this format'}` : 'Minify (Shift+Alt+M)'}>
          <span>
            <Button variant="subtle" icon={<Minimize2 size={13} />} disabled={!caps?.minify} onClick={() => void runAction('minify')}>
              <span className="hidden xl:inline">Minify</span>
            </Button>
          </span>
        </Tooltip>
        <Tooltip content="Validate now and open Problems (Shift+Alt+V)">
          <Button variant="subtle" icon={<ShieldCheck size={13} />} onClick={() => void validateNow()}>
            <span className="hidden xl:inline">Validate</span>
          </Button>
        </Tooltip>
        <ConvertButton />
        <OptionsPopover>
          <IconButton label="Formatting options" variant="subtle">
            <SlidersHorizontal size={13} />
          </IconButton>
        </OptionsPopover>
      </div>
      <Separator />
      <div className="hidden items-center lg:flex">
        <IconButton label="Undo (Ctrl+Z)" onClick={() => editors.trigger('undo')}>
          <Undo2 size={14} />
        </IconButton>
        <IconButton label="Redo (Ctrl+Y)" onClick={() => editors.trigger('redo')}>
          <Redo2 size={14} />
        </IconButton>
        <IconButton label="Copy output (Shift+Alt+Y)" disabled={!hasOutput} onClick={() => void copyOutput()}>
          <Copy size={14} />
        </IconButton>
        <IconButton label="Download output (Ctrl+S)" disabled={!hasOutput} onClick={() => downloadOutput()}>
          <Download size={14} />
        </IconButton>
        <IconButton label="Clear input" onClick={() => clearInput()}>
          <Eraser size={14} />
        </IconButton>
        <IconButton label="Reset workspace" onClick={() => resetWorkspace()}>
          <RotateCcw size={14} />
        </IconButton>
      </div>
      <div className="lg:hidden">
        <Menu>
          <MenuTrigger asChild>
            <IconButton label="More actions">
              <Ellipsis size={15} />
            </IconButton>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem icon={<Undo2 size={14} />} onSelect={() => editors.trigger('undo')}>
              Undo
            </MenuItem>
            <MenuItem icon={<Redo2 size={14} />} onSelect={() => editors.trigger('redo')}>
              Redo
            </MenuItem>
            <MenuItem icon={<Copy size={14} />} disabled={!hasOutput} onSelect={() => void copyOutput()}>
              Copy output
            </MenuItem>
            <MenuItem icon={<Download size={14} />} disabled={!hasOutput} onSelect={() => downloadOutput()}>
              Download output
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<Eraser size={14} />} onSelect={() => clearInput()}>
              Clear input
            </MenuItem>
            <MenuItem icon={<RotateCcw size={14} />} onSelect={() => resetWorkspace()}>
              Reset workspace
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
    </>
  );
}
