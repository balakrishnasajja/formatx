import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { Severity } from '../types/diagnostics';
import type { ActionKind, ActionResult, AnalysisResult } from '../types/engine';
import type { FormatId } from '../types/formats';
import { DEFAULT_OPTIONS, type FormatOptions } from '../types/options';

export type AppTheme = 'dark' | 'light' | 'system';
export type EditorThemeId = 'auto' | 'formatx-dark' | 'formatx-light' | 'formatx-midnight' | 'hc-black';
export type BottomTab = 'problems' | 'summary' | 'processing';
export type OutputView = 'code' | 'preview' | 'table';

export interface Settings {
  appTheme: AppTheme;
  editorTheme: EditorThemeId;
  fontSize: number;
  wordWrap: boolean;
  minimap: boolean;
  inlineDiagnostics: boolean;
  stickyScroll: boolean;
  fontLigatures: boolean;
  renderWhitespace: boolean;
  /** Validate while typing. */
  liveValidation: boolean;
  /** Re-run the last action automatically when the input changes and is valid. */
  liveOutput: boolean;
  /** Opt-in: keep the current workspace and recent documents in IndexedDB. */
  persistWorkspace: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  appTheme: 'dark',
  editorTheme: 'auto',
  fontSize: 13,
  wordWrap: false,
  minimap: true,
  inlineDiagnostics: true,
  stickyScroll: true,
  fontLigatures: true,
  renderWhitespace: false,
  liveValidation: true,
  liveOutput: true,
  persistWorkspace: false,
};

export interface HistoryEntry {
  id: string;
  time: number;
  action: ActionKind | 'validate' | 'open';
  formatId: FormatId | null;
  targetFormatId?: FormatId;
  ok: boolean;
  summary: string;
  inputBytes: number;
  outputBytes?: number;
  durationMs?: number;
  /** IndexedDB key of the input snapshot (only when workspace persistence is enabled). */
  snapshotId?: string;
}

export type OutputState =
  | { status: 'idle' }
  | { status: 'running'; action: ActionKind; target?: FormatId }
  | { status: 'done'; result: ActionResult; stale: boolean };

export interface LogEntry {
  id: number;
  time: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  durationMs?: number;
}

export interface Toast {
  id: number;
  kind: 'success' | 'error' | 'info' | 'warning';
  message: string;
}

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
}

interface AppState {
  // document (the Monaco model is the source of truth for the text itself)
  docVersion: number;
  fileName: string | null;
  inputSource: 'typed' | 'paste' | 'file' | 'sample' | 'restored' | 'output';
  formatMode: FormatId | 'auto';
  analysis: AnalysisResult | null;
  analyzing: boolean;
  analysisError: string | null;

  action: { kind: ActionKind; target?: FormatId } | null;
  output: OutputState;
  outputView: OutputView;

  options: FormatOptions;
  settings: Settings;
  favorites: FormatId[];
  history: HistoryEntry[];

  sidebarOpen: boolean;
  bottomOpen: boolean;
  bottomTab: BottomTab;
  problemFilter: Record<Severity, boolean>;

  cursor: { line: number; column: number; selected: number };
  log: LogEntry[];
  toasts: Toast[];
  dialogs: { settings: boolean; docs: boolean; palette: boolean; convert: boolean };
  docsTab: string;
  confirm: ConfirmRequest | null;
  engineStatus: string;

  set: (patch: Partial<AppState>) => void;
  setOptions: (patch: Partial<FormatOptions>) => void;
  setSettings: (patch: Partial<Settings>) => void;
  toggleFavorite: (id: FormatId) => void;
  addHistory: (e: Omit<HistoryEntry, 'id' | 'time'>) => void;
  clearHistory: () => void;
  log_: (level: LogEntry['level'], message: string, durationMs?: number) => void;
  toast: (kind: Toast['kind'], message: string) => void;
  dismissToast: (id: number) => void;
  openDialog: (name: keyof AppState['dialogs'], open?: boolean) => void;
}

let toastSeq = 0;
let logSeq = 0;

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      docVersion: 0,
      fileName: null,
      inputSource: 'typed',
      formatMode: 'auto',
      analysis: null,
      analyzing: false,
      analysisError: null,
      action: { kind: 'beautify' },
      output: { status: 'idle' },
      outputView: 'code',
      options: DEFAULT_OPTIONS,
      settings: DEFAULT_SETTINGS,
      favorites: ['json', 'yaml', 'xml'],
      history: [],
      sidebarOpen: true,
      bottomOpen: false,
      bottomTab: 'problems',
      problemFilter: { error: true, warning: true, info: true },
      cursor: { line: 1, column: 1, selected: 0 },
      log: [],
      toasts: [],
      dialogs: { settings: false, docs: false, palette: false, convert: false },
      docsTab: 'overview',
      confirm: null,
      engineStatus: 'starting',

      set: (patch) => set(patch),
      setOptions: (patch) => set((s) => ({ options: { ...s.options, ...patch } })),
      setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
      toggleFavorite: (id) => set((s) => ({ favorites: s.favorites.includes(id) ? s.favorites.filter((f) => f !== id) : [...s.favorites, id] })),
      addHistory: (e) =>
        set((s) => ({
          history: [{ ...e, id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, time: Date.now() }, ...s.history].slice(0, 40),
        })),
      clearHistory: () => set({ history: [] }),
      log_: (level, message, durationMs) =>
        set((s) => ({ log: [{ id: ++logSeq, time: Date.now(), level, message, durationMs }, ...s.log].slice(0, 200) })),
      toast: (kind, message) => {
        const id = ++toastSeq;
        set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, message }] }));
        setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 6000 : 3200);
      },
      dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
      openDialog: (name, open = true) => set((s) => ({ dialogs: { ...s.dialogs, [name]: open } })),
    }),
    {
      name: 'formatx:prefs',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      // Only preferences are persisted. Document content is never written to
      // localStorage; workspace persistence (IndexedDB) is opt-in.
      partialize: (s) => ({
        options: s.options,
        settings: s.settings,
        favorites: s.favorites,
        history: s.history,
        sidebarOpen: s.sidebarOpen,
        bottomOpen: s.bottomOpen,
        formatMode: s.formatMode,
        action: s.action,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<AppState>;
        return {
          ...current,
          ...p,
          options: { ...DEFAULT_OPTIONS, ...(p.options ?? {}) },
          settings: { ...DEFAULT_SETTINGS, ...(p.settings ?? {}) },
        };
      },
    },
  ),
);
