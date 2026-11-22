import { useEffect } from 'react';
import { copyOutput, downloadOutput, runAction, setFormatMode, validateNow } from '../services/controller';
import { useAppStore } from './useAppStore';

/**
 * Global shortcuts (when focus is outside Monaco; inside the editor the same
 * commands are registered as Monaco actions so they win over editor defaults).
 */
export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inMonaco = !!target?.closest('.monaco-editor');
      const inField = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) && !inMonaco;
      const s = useAppStore.getState();
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      // shortcuts that work everywhere
      if (mod && !e.shiftKey && !e.altKey && key === 'k' && !inMonaco) {
        e.preventDefault();
        s.openDialog('palette', !s.dialogs.palette);
        return;
      }
      if (mod && e.shiftKey && key === 'p') {
        e.preventDefault();
        s.openDialog('palette', true);
        return;
      }
      if (mod && !e.shiftKey && key === 'b' && !inField) {
        e.preventDefault();
        s.set({ sidebarOpen: !s.sidebarOpen });
        return;
      }
      if (mod && !e.shiftKey && key === 'j') {
        e.preventDefault();
        s.set({ bottomOpen: !s.bottomOpen });
        return;
      }
      if (inMonaco || inField) return; // Monaco actions handle the rest while editing
      if (mod && key === 's') {
        e.preventDefault();
        downloadOutput();
      } else if (mod && key === 'o') {
        e.preventDefault();
        document.getElementById('fx-file-input')?.click();
      } else if (e.shiftKey && e.altKey && !mod) {
        const map: Record<string, () => void> = {
          f: () => void runAction('beautify'),
          m: () => void runAction('minify'),
          v: () => void validateNow(),
          c: () => s.openDialog('convert', true),
          d: () => setFormatMode('auto'),
          y: () => void copyOutput(),
        };
        const code = e.code.replace(/^Key/, '').toLowerCase();
        if (map[code]) {
          e.preventDefault();
          map[code]();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
