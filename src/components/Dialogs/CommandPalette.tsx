import { Command } from 'lucide-react';
import { Dialog as RDialog } from 'radix-ui';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DESCRIPTORS, FORMAT_ORDER } from '../../engines/catalog';
import { conversionTargets } from '../../engines/converters/targets';
import { useAppStore } from '../../hooks/useAppStore';
import { clearInput, copyOutput, downloadOutput, loadSample, pasteFromClipboard, resetWorkspace, runAction, setFormatMode, useOutputAsInput, validateNow } from '../../services/controller';
import { FormatIcon } from '../common/brand';
import { cx, Kbd } from '../common/ui';

interface Cmd {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon?: ReactNode;
  run: () => void;
}

export function CommandPalette() {
  const open = useAppStore((s) => s.dialogs.palette);
  const openDialog = useAppStore((s) => s.openDialog);
  const set = useAppStore((s) => s.set);
  const settings = useAppStore((s) => s.settings);
  const setSettings = useAppStore((s) => s.setSettings);
  const formatId = useAppStore((s) => (s.formatMode === 'auto' ? s.analysis?.formatId ?? null : s.formatMode));
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const commands = useMemo<Cmd[]>(() => {
    const c: Cmd[] = [
      { id: 'beautify', group: 'Actions', label: 'Beautify', hint: 'Shift Alt F', run: () => void runAction('beautify') },
      { id: 'minify', group: 'Actions', label: 'Minify', hint: 'Shift Alt M', run: () => void runAction('minify') },
      { id: 'validate', group: 'Actions', label: 'Validate', hint: 'Shift Alt V', run: () => void validateNow() },
      { id: 'copy', group: 'Actions', label: 'Copy output', hint: 'Shift Alt Y', run: () => void copyOutput() },
      { id: 'download', group: 'Actions', label: 'Download output', hint: 'Ctrl S', run: () => downloadOutput() },
      { id: 'use', group: 'Actions', label: 'Use output as input', run: () => useOutputAsInput() },
      { id: 'paste', group: 'Actions', label: 'Paste from clipboard', run: () => void pasteFromClipboard() },
      { id: 'open', group: 'Actions', label: 'Open file…', hint: 'Ctrl O', run: () => document.getElementById('fx-file-input')?.click() },
      { id: 'clear', group: 'Actions', label: 'Clear input', run: () => clearInput() },
      { id: 'reset', group: 'Actions', label: 'Reset workspace', run: () => resetWorkspace() },
      { id: 'auto', group: 'Format', label: 'Use automatic detection', hint: 'Shift Alt D', run: () => setFormatMode('auto') },
      { id: 'sidebar', group: 'View', label: 'Toggle sidebar', hint: 'Ctrl B', run: () => set({ sidebarOpen: !useAppStore.getState().sidebarOpen }) },
      { id: 'panel', group: 'View', label: 'Toggle problems panel', hint: 'Ctrl J', run: () => set({ bottomOpen: !useAppStore.getState().bottomOpen }) },
      { id: 'theme', group: 'View', label: `Switch to ${settings.appTheme === 'dark' ? 'light' : 'dark'} theme`, run: () => setSettings({ appTheme: settings.appTheme === 'dark' ? 'light' : 'dark' }) },
      { id: 'wrap', group: 'View', label: `${settings.wordWrap ? 'Disable' : 'Enable'} word wrap`, run: () => setSettings({ wordWrap: !settings.wordWrap }) },
      { id: 'settings', group: 'View', label: 'Open settings', run: () => openDialog('settings', true) },
      { id: 'docs', group: 'View', label: 'Open documentation', run: () => openDialog('docs', true) },
    ];
    if (formatId) {
      for (const t of conversionTargets(formatId)) {
        c.push({ id: `conv-${t.formatId}`, group: 'Convert', label: `Convert ${DESCRIPTORS[formatId].short} → ${DESCRIPTORS[t.formatId].name}`, icon: <FormatIcon id={t.formatId} />, hint: t.lossy ? 'may lose information' : 'lossless', run: () => void runAction('convert', t.formatId) });
      }
    }
    for (const id of FORMAT_ORDER) {
      c.push({ id: `fmt-${id}`, group: 'Format', label: `Parse as ${DESCRIPTORS[id].name}`, icon: <FormatIcon id={id} />, run: () => setFormatMode(id) });
      c.push({ id: `sample-${id}`, group: 'Samples', label: `Load ${DESCRIPTORS[id].name} sample`, icon: <FormatIcon id={id} />, run: () => loadSample(id) });
    }
    return c;
  }, [formatId, settings.appTheme, settings.wordWrap, set, setSettings, openDialog]);

  const filtered = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return commands.filter((c) => c.group !== 'Samples' && !c.id.startsWith('fmt-')).concat(commands.filter((c) => c.id.startsWith('fmt-')).slice(0, 6));
    return commands.filter((c) => terms.every((t) => `${c.label} ${c.group}`.toLowerCase().includes(t))).slice(0, 60);
  }, [q, commands]);

  useEffect(() => {
    setSel(0);
  }, [q, open]);
  useEffect(() => {
    if (!open) setQ('');
  }, [open]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const exec = (c: Cmd | undefined) => {
    if (!c) return;
    openDialog('palette', false);
    setTimeout(c.run, 0);
  };

  let lastGroup = '';
  return (
    <RDialog.Root open={open} onOpenChange={(o) => openDialog('palette', o)}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <RDialog.Content className="fx-fade-in fixed left-1/2 top-[12vh] z-50 w-[min(620px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-xl border border-border-strong bg-elevated shadow-panel">
          <RDialog.Title className="sr-only">Command palette</RDialog.Title>
          <RDialog.Description className="sr-only">Search actions, formats, conversions and samples</RDialog.Description>
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Command size={15} className="text-accent" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setSel((s) => Math.min(filtered.length - 1, s + 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setSel((s) => Math.max(0, s - 1));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  exec(filtered[sel]);
                }
              }}
              placeholder="Type a command, format or conversion…"
              className="h-11 flex-1 bg-transparent text-[13.5px] text-text outline-none placeholder:text-faint"
              aria-label="Search commands"
            />
            <Kbd>Esc</Kbd>
          </div>
          <div ref={listRef} className="max-h-[52vh] overflow-y-auto p-1.5" role="listbox">
            {filtered.map((c, i) => {
              const header = c.group !== lastGroup ? c.group : null;
              lastGroup = c.group;
              return (
                <div key={c.id}>
                  {header && <div className="px-2 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wider text-faint">{header}</div>}
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === sel}
                    data-index={i}
                    onMouseMove={() => setSel(i)}
                    onClick={() => exec(c)}
                    className={cx('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px]', i === sel ? 'bg-accent-soft text-text' : 'text-muted')}
                  >
                    <span className="flex h-4 w-4 items-center justify-center text-faint">{c.icon}</span>
                    <span className="flex-1 truncate">{c.label}</span>
                    {c.hint && <span className="text-[11px] text-faint">{c.hint}</span>}
                  </button>
                </div>
              );
            })}
            {!filtered.length && <div className="px-3 py-4 text-center text-[12.5px] text-faint">No matching commands.</div>}
          </div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
