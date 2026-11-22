import { BookOpen, Moon, PanelLeft, Search, Settings, Sun, SunMoon } from 'lucide-react';
import { useAppStore } from '../../hooks/useAppStore';
import { Logo } from '../common/brand';
import { IconButton, Kbd, Separator } from '../common/ui';
import { DetectionBadge, FormatSelect, StatusPill, ToolbarActions } from '../Toolbar/Toolbar';

/** Single command bar: brand, document state, actions and app controls in one 40px row. */
export function Header() {
  const appTheme = useAppStore((s) => s.settings.appTheme);
  const setSettings = useAppStore((s) => s.setSettings);
  const openDialog = useAppStore((s) => s.openDialog);
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const set = useAppStore((s) => s.set);
  const nextTheme = appTheme === 'dark' ? 'light' : appTheme === 'light' ? 'system' : 'dark';
  const ThemeIcon = appTheme === 'dark' ? Moon : appTheme === 'light' ? Sun : SunMoon;
  return (
    <header className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border bg-surface-2 px-1.5">
      <IconButton label="Toggle sidebar (Ctrl+B)" active={sidebarOpen} onClick={() => set({ sidebarOpen: !sidebarOpen })}>
        <PanelLeft size={15} />
      </IconButton>
      <div className="flex shrink-0 items-center gap-1.5 pr-1" title="FormatX — Universal Data Formatter & Validator">
        <Logo size={22} />
        <span className="hidden text-[13.5px] font-bold tracking-tight text-text md:inline">
          Format<span className="bg-linear-to-r from-accent to-accent-2 bg-clip-text text-transparent">X</span>
        </span>
      </div>
      <Separator />
      <FormatSelect />
      <div className="hidden min-w-0 shrink items-center gap-1 overflow-hidden sm:flex">
        <div className="hidden shrink-0 lg:block">
          <DetectionBadge />
        </div>
        <StatusPill />
      </div>
      <div className="min-w-2 flex-1" />
      <ToolbarActions />
      <Separator />
      <button
        type="button"
        onClick={() => openDialog('palette', true)}
        aria-label="Command palette (Ctrl+K)"
        className="hidden h-7 items-center gap-1.5 rounded-md border border-border bg-surface px-2 text-[11.5px] text-faint transition-colors hover:border-border-strong hover:text-muted 2xl:flex"
      >
        <Search size={13} />
        <span>Commands</span>
        <Kbd>Ctrl K</Kbd>
      </button>
      <IconButton label="Command palette (Ctrl+K)" className="2xl:hidden" onClick={() => openDialog('palette', true)}>
        <Search size={15} />
      </IconButton>
      <IconButton label="Documentation" onClick={() => openDialog('docs', true)}>
        <BookOpen size={15} />
      </IconButton>
      <IconButton label="Settings" onClick={() => openDialog('settings', true)}>
        <Settings size={15} />
      </IconButton>
      <IconButton label={`Theme: ${appTheme} (click for ${nextTheme})`} onClick={() => setSettings({ appTheme: nextTheme })}>
        <ThemeIcon size={15} />
      </IconButton>
    </header>
  );
}
