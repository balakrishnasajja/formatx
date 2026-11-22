import { CommandPalette } from './components/Dialogs/CommandPalette';
import { DocsDialog } from './components/Dialogs/DocsDialog';
import { ConfirmDialog, Toasts } from './components/Dialogs/Feedback';
import { SettingsDialog } from './components/Dialogs/SettingsDialog';
import { TooltipProvider } from './components/common/ui';
import { useEngineSync } from './hooks/useEngineSync';
import { useShortcuts } from './hooks/useShortcuts';
import { useApplyTheme } from './hooks/useTheme';
import { Workspace } from './pages/Workspace';

export default function App() {
  useApplyTheme();
  useEngineSync();
  useShortcuts();
  return (
    <TooltipProvider>
      <Workspace />
      <SettingsDialog />
      <DocsDialog />
      <CommandPalette />
      <ConfirmDialog />
      <Toasts />
    </TooltipProvider>
  );
}
