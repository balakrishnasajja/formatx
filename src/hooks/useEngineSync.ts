import { useEffect, useRef } from 'react';
import { engine } from '../engines/worker/client';
import { analyzeNow, restoreWorkspace } from '../services/controller';
import { editors } from '../services/editorRegistry';
import { useAppStore } from './useAppStore';

/** Debounce delay scaled by document size so huge files don't re-parse on every keystroke. */
function delayFor(chars: number, source: string): number {
  if (source === 'paste' || source === 'file' || source === 'sample' || source === 'restored' || source === 'output') return 30;
  if (chars < 20_000) return 250;
  if (chars < 500_000) return 450;
  if (chars < 3_000_000) return 900;
  return 1600;
}

/**
 * Keeps analysis (detection + validation) and live output in sync with the editor,
 * the selected format and the formatting options.
 */
export function useEngineSync(): void {
  const docVersion = useAppStore((s) => s.docVersion);
  const formatMode = useAppStore((s) => s.formatMode);
  const options = useAppStore((s) => s.options);
  const liveValidation = useAppStore((s) => s.settings.liveValidation);
  const firstRun = useRef(true);
  const optionsKey = JSON.stringify(options);

  useEffect(() => engine.onStatus((s) => useAppStore.getState().set({ engineStatus: s })), []);

  useEffect(() => {
    void (async () => {
      const restored = await restoreWorkspace();
      if (restored) useAppStore.getState().log_('info', 'Restored the saved workspace');
    })();
  }, []);

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    const s = useAppStore.getState();
    const manualTrigger = s.inputSource !== 'typed';
    if (!liveValidation && !manualTrigger) return;
    const chars = editors.getInput().length;
    const t = setTimeout(() => {
      void analyzeNow({ reason: 'Analyzed' });
      if (useAppStore.getState().inputSource !== 'typed') useAppStore.getState().set({ inputSource: 'typed' });
    }, delayFor(chars, s.inputSource));
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docVersion, formatMode, optionsKey, liveValidation]);
}
