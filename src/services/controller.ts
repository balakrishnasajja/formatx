import { DESCRIPTORS, fileExtensionFor, mimeTypeFor } from '../engines/catalog';
import { engine } from '../engines/worker/client';
import { SAMPLES } from '../parsers/samples';
import { useAppStore } from '../hooks/useAppStore';
import type { Diagnostic } from '../types/diagnostics';
import type { ActionKind, ActionResult, AnalysisResult } from '../types/engine';
import type { FormatId } from '../types/formats';
import { formatBytes, utf8Length } from '../utils/text';
import { editors } from './editorRegistry';
import { copyText, downloadBlob, importFile, readClipboard } from './files';
import { clearAllDocuments, loadDocument, saveDocument } from './workspaceStore';

const store = () => useAppStore.getState();
let analysisSeq = 0;
let actionSeq = 0;
let inlineDecorations: import('monaco-editor').editor.IEditorDecorationsCollection | null = null;
let inlineOwner: unknown = null;

const MAX_MARKERS = 1000;
const MAX_INLINE = 300;

/** Monaco language for the current analysis (CSV variants depend on the delimiter). */
export function languageFor(formatId: FormatId | null | undefined, analysis?: AnalysisResult | null): string {
  if (!formatId) return 'plaintext';
  if (formatId === 'csv') {
    const d = analysis?.stats.facts.Delimiter;
    return d === 'semicolon' ? 'csv-semicolon' : d === 'pipe' ? 'csv-pipe' : d === 'tab' ? 'tsv' : 'csv';
  }
  if ((formatId === 'openapi' || formatId === 'jsonschema') && editors.getInput().trimStart().match(/^[[{]/)) return 'json';
  return DESCRIPTORS[formatId].monacoLanguage;
}

// ------------------------------------------------------------------ markers

function applyDiagnostics(diags: Diagnostic[]) {
  const monaco = editors.monaco;
  const editor = editors.input;
  const model = editor?.getModel();
  if (!monaco || !editor || !model) return;
  const sev = { error: monaco.MarkerSeverity.Error, warning: monaco.MarkerSeverity.Warning, info: monaco.MarkerSeverity.Info };
  const located = diags.filter((d) => d.range).slice(0, MAX_MARKERS);
  monaco.editor.setModelMarkers(
    model,
    'formatx',
    located.map((d) => ({
      severity: sev[d.severity],
      message: d.suggestion ? `${d.message}\n💡 ${d.suggestion}` : d.message,
      code: d.code,
      source: d.source,
      startLineNumber: d.range!.line,
      startColumn: d.range!.column,
      endLineNumber: d.range!.endLine,
      endColumn: d.range!.endColumn,
      relatedInformation: d.related?.map((r) => ({ resource: model.uri, message: r.message, startLineNumber: r.line, startColumn: r.column, endLineNumber: r.line, endColumn: r.column + 1 })),
    })),
  );
  // "error lens": the first problem of each line shown at the end of the line
  // the collection belongs to one editor instance; recreate it if the editor was re-created
  if (!inlineDecorations || inlineOwner !== editor) {
    inlineDecorations = editor.createDecorationsCollection();
    inlineOwner = editor;
  }
  const collection = inlineDecorations;
  if (!store().settings.inlineDiagnostics) {
    collection.clear();
    return;
  }
  const perLine = new Map<number, Diagnostic>();
  for (const d of located) {
    if (d.severity === 'info') continue;
    const line = d.range!.line;
    const prev = perLine.get(line);
    if (!prev || (prev.severity === 'warning' && d.severity === 'error')) perLine.set(line, d);
  }
  const decos = [...perLine.values()].slice(0, MAX_INLINE).map((d) => {
    const line = Math.min(d.range!.line, model.getLineCount());
    const col = model.getLineMaxColumn(line);
    return {
      range: new monaco.Range(line, col, line, col),
      options: {
        description: 'formatx-inline-diagnostic',
        isWholeLine: false,
        showIfCollapsed: true,
        after: { content: `  ${d.severity === 'error' ? '✖' : '⚠'} ${d.message.length > 120 ? d.message.slice(0, 117) + '…' : d.message}`, inlineClassName: d.severity === 'error' ? 'fx-inline-error' : 'fx-inline-warning' },
        linesDecorationsClassName: d.severity === 'error' ? 'fx-gutter-error' : 'fx-gutter-warning',
      },
    };
  });
  collection.set(decos);
}

export function refreshInlineDiagnostics() {
  applyDiagnostics(store().analysis?.validation.diagnostics ?? []);
}

// ------------------------------------------------------------------ analysis

export async function analyzeNow(opts: { thenRunAction?: boolean; reason?: string } = {}): Promise<AnalysisResult | null> {
  const id = ++analysisSeq;
  const input = editors.getInput();
  const s = store();
  s.set({ analyzing: true });
  try {
    const result = await engine.analyze({ input, formatId: s.formatMode, options: s.options, hint: { fileName: s.fileName ?? undefined } });
    if (id !== analysisSeq) return null; // superseded by a newer edit
    store().set({ analysis: result, analyzing: false, analysisError: null });
    applyDiagnostics(result.validation.diagnostics);
    const det = result.detection.best;
    const fmt = result.formatId ? DESCRIPTORS[result.formatId].name : 'unknown format';
    store().log_(
      result.validation.status === 'invalid' ? 'warn' : 'info',
      `${opts.reason ?? 'Analyzed'} ${formatBytes(result.stats.bytes)} as ${fmt}${result.mode === 'auto' && det ? ` (${Math.round(det.confidence * 100)}% confidence)` : ' (manual)'} — ${result.validation.status} · ${result.validation.counts.error} error(s), ${result.validation.counts.warning} warning(s)`,
      result.timings.totalMs,
    );
    if (opts.thenRunAction !== false) await maybeRunLiveAction(result);
    return result;
  } catch (e) {
    if (id !== analysisSeq) return null;
    const message = e instanceof Error ? e.message : String(e);
    store().set({ analyzing: false, analysisError: message });
    store().log_('error', `Analysis failed: ${message}`);
    return null;
  }
}

async function maybeRunLiveAction(result: AnalysisResult) {
  const s = store();
  if (result.validation.status === 'empty') {
    s.set({ output: { status: 'idle' } });
    return;
  }
  if (!s.settings.liveOutput || !s.action || !result.formatId) {
    markOutputStale();
    return;
  }
  if (result.validation.counts.error > 0) {
    markOutputStale();
    return;
  }
  await runAction(s.action.kind, s.action.target, { silent: true, analysis: result });
}

function markOutputStale() {
  const o = store().output;
  if (o.status === 'done' && !o.stale) store().set({ output: { ...o, stale: true } });
}

// ------------------------------------------------------------------ actions

export async function runAction(kind: ActionKind, target?: FormatId, opts: { force?: boolean; silent?: boolean; analysis?: AnalysisResult } = {}): Promise<ActionResult | null> {
  const s = store();
  const analysis = opts.analysis ?? s.analysis;
  const formatId = (s.formatMode !== 'auto' ? s.formatMode : analysis?.formatId) ?? null;
  const input = editors.getInput();
  if (!input.trim()) {
    if (!opts.silent) s.toast('info', 'The input is empty — paste data, open a file or load a sample.');
    return null;
  }
  if (!formatId) {
    if (!opts.silent) s.toast('warning', 'The format could not be detected. Choose one from the format selector.');
    return null;
  }
  if (kind === 'convert' && !target) {
    s.openDialog('convert', true);
    return null;
  }
  s.set({ action: { kind, target }, output: { status: 'running', action: kind, target } });
  const id = ++actionSeq;
  try {
    const result = await engine.run({ input, action: kind, formatId, targetFormatId: target, options: s.options, force: opts.force });
    if (id !== actionSeq) return null;
    store().set({ output: { status: 'done', result, stale: false }, outputView: defaultView(result) });
    const label = kind === 'convert' ? `Converted ${DESCRIPTORS[formatId].short} → ${DESCRIPTORS[target!].short}` : `${kind === 'beautify' ? 'Beautified' : 'Minified'} ${DESCRIPTORS[formatId].short}`;
    if (result.ok) {
      store().log_('info', `${label}: ${formatBytes(result.stats.inputBytes)} → ${formatBytes(result.stats.outputBytes)}${result.warnings.length ? ` (${result.warnings.length} notice(s))` : ''}`, result.stats.durationMs);
    } else {
      store().log_(result.blockedBy ? 'warn' : 'error', `${label} failed: ${result.error}`, result.stats.durationMs);
      if (!opts.silent && result.blockedBy) store().set({ bottomOpen: true, bottomTab: 'problems' });
    }
    if (!opts.silent) {
      void recordHistory(kind, formatId, target, result, label, input);
      if (result.ok && result.warnings.some((w) => w.severity === 'warning')) store().toast('warning', `${label} with ${result.warnings.filter((w) => w.severity === 'warning').length} information-loss warning(s).`);
    }
    return result;
  } catch (e) {
    if (id !== actionSeq) return null;
    const message = e instanceof Error ? e.message : String(e);
    const failed: ActionResult = { ok: false, action: kind, sourceFormatId: formatId, outputFormatId: target ?? formatId, language: 'plaintext', warnings: [], notes: [], error: message, stats: { inputBytes: utf8Length(input), outputBytes: 0, durationMs: 0 }, engine: '' };
    store().set({ output: { status: 'done', result: failed, stale: false } });
    store().log_('error', message);
    if (!opts.silent) store().toast('error', message);
    return null;
  }
}

function defaultView(r: ActionResult): 'code' | 'preview' | 'table' {
  const current = store().outputView;
  if (current === 'preview' && (r.outputFormatId === 'html' || r.outputFormatId === 'markdown')) return 'preview';
  if (current === 'table' && (r.outputFormatId === 'csv' || r.outputFormatId === 'tsv')) return 'table';
  return 'code';
}

async function recordHistory(kind: ActionKind, formatId: FormatId, target: FormatId | undefined, r: ActionResult, label: string, input: string) {
  const s = store();
  let snapshotId: string | undefined;
  if (s.settings.persistWorkspace) {
    snapshotId = `snap-${Date.now().toString(36)}`;
    try {
      await saveDocument({ id: snapshotId, time: Date.now(), text: input, fileName: s.fileName, formatId });
    } catch {
      snapshotId = undefined;
    }
  }
  s.addHistory({ action: kind, formatId, targetFormatId: target, ok: r.ok, summary: r.ok ? label : `${label} — failed`, inputBytes: r.stats.inputBytes, outputBytes: r.stats.outputBytes, durationMs: r.stats.durationMs, snapshotId });
}

export async function validateNow() {
  store().set({ bottomOpen: true, bottomTab: 'problems' });
  const r = await analyzeNow({ reason: 'Validated', thenRunAction: true });
  if (!r) return;
  const s = store();
  const c = r.validation.counts;
  if (r.validation.status === 'empty') s.toast('info', 'Nothing to validate — the input is empty.');
  else if (!r.formatId) s.toast('warning', 'Format not recognized. Pick one in the format selector to validate.');
  else if (c.error) s.toast('error', `${DESCRIPTORS[r.formatId].name}: ${c.error} error(s), ${c.warning} warning(s).`);
  else s.toast('success', `Valid ${DESCRIPTORS[r.formatId].name}${c.warning ? ` with ${c.warning} warning(s)` : ''}.`);
  s.addHistory({ action: 'validate', formatId: r.formatId, ok: c.error === 0, summary: `Validated ${r.formatId ? DESCRIPTORS[r.formatId].short : '?'} — ${r.validation.status}`, inputBytes: r.stats.bytes, durationMs: r.timings.totalMs });
}

// ------------------------------------------------------------------ input management

export function setInputText(text: string, source: 'paste' | 'file' | 'sample' | 'restored' | 'output', fileName: string | null = null) {
  store().set({ inputSource: source, fileName });
  editors.setInput(text);
}

export function loadSample(id: FormatId) {
  const s = store();
  s.set({ formatMode: 'auto', options: { ...s.options, csvDelimiter: 'auto' } });
  setInputText(SAMPLES[id], 'sample', null);
  s.log_('info', `Loaded the ${DESCRIPTORS[id].name} sample`);
}

export async function openFile(file: File) {
  const s = store();
  try {
    const f = await importFile(file);
    if (f.formatHint && (f.binary || f.formatHint === 'env')) s.set({ formatMode: f.binary ? f.formatHint : 'auto' });
    else if (s.formatMode !== 'auto') s.set({ formatMode: 'auto' });
    setInputText(f.text, 'file', f.name);
    s.addHistory({ action: 'open', formatId: f.formatHint, ok: true, summary: `Opened ${f.name}`, inputBytes: f.size });
    s.toast(f.warning ? 'info' : 'success', f.warning ? `${f.name}: ${f.warning}` : `Opened ${f.name} (${formatBytes(f.size)})`);
  } catch (e) {
    s.toast('error', e instanceof Error ? e.message : String(e));
  }
}

export async function pasteFromClipboard() {
  try {
    const text = await readClipboard();
    if (!text) {
      store().toast('info', 'The clipboard is empty.');
      return;
    }
    setInputText(text, 'paste');
  } catch (e) {
    store().toast('error', e instanceof Error ? e.message : String(e));
  }
}

export function applyQuickFix(d: Diagnostic) {
  if (!d.fix) return;
  const ok = editors.applyEdits(d.fix.edits);
  if (ok) store().toast('success', `Applied: ${d.fix.title}. Press Ctrl+Z to undo.`);
}

export function revealDiagnostic(d: Diagnostic) {
  if (d.range) editors.reveal(d.range.line, d.range.column, d.range.endLine, d.range.endColumn);
}

export function clearInput() {
  editors.setInput('');
  store().set({ fileName: null, output: { status: 'idle' } });
}

export function resetWorkspace() {
  store().set({
    confirm: {
      title: 'Reset workspace?',
      message: 'This clears the input and output and sets the format back to Auto-detect. Formatting options and settings are kept. You can undo the input change with Ctrl+Z.',
      confirmLabel: 'Reset',
      danger: true,
      onConfirm: () => {
        editors.setInput('');
        store().set({ fileName: null, formatMode: 'auto', output: { status: 'idle' }, action: { kind: 'beautify' }, analysis: null, outputView: 'code' });
        applyDiagnostics([]);
        store().log_('info', 'Workspace reset');
      },
    },
  });
}

function currentOutput(): ActionResult | null {
  const o = store().output;
  return o.status === 'done' && o.result.ok ? o.result : null;
}

export async function copyOutput() {
  const r = currentOutput();
  if (!r?.text) {
    store().toast('info', 'There is no output to copy yet.');
    return;
  }
  try {
    await copyText(r.text);
    store().toast('success', `Copied ${formatBytes(utf8Length(r.text))} to the clipboard.`);
  } catch {
    store().toast('error', 'Copy failed: clipboard permission was denied.');
  }
}

export function downloadOutput() {
  const r = currentOutput();
  if (!r) {
    store().toast('info', 'There is no output to download yet.');
    return;
  }
  const base = (store().fileName ?? 'formatx-output').replace(/\.[^.]+$/, '');
  const ext = r.outputFormatId === 'json' && r.language === 'json' ? 'json' : fileExtensionFor(r.outputFormatId);
  const suffix = r.action === 'minify' ? '.min' : '';
  if (r.binary) downloadBlob(r.binary.slice().buffer as ArrayBuffer, `${base}${suffix}.${ext}`, mimeTypeFor(r.outputFormatId));
  else downloadBlob(r.text ?? '', `${base}${suffix}.${ext}`, `${mimeTypeFor(r.outputFormatId)};charset=utf-8`);
  store().log_('info', `Downloaded ${base}${suffix}.${ext}`);
}

export function useOutputAsInput() {
  const r = currentOutput();
  if (!r?.text) return;
  const s = store();
  s.set({ formatMode: r.binary ? r.outputFormatId : 'auto' });
  setInputText(r.text, 'output', null);
  s.toast('info', 'Output moved to the input editor (Ctrl+Z in the editor restores the previous input).');
}

export function setFormatMode(mode: FormatId | 'auto') {
  store().set({ formatMode: mode });
}

// ------------------------------------------------------------------ persistence (opt-in)

let saveTimer: ReturnType<typeof setTimeout> | null = null;
export function scheduleWorkspaceSave() {
  if (!store().settings.persistWorkspace) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const s = store();
    const text = editors.getInput();
    if (text.length > 5_000_000) return;
    void saveDocument({ id: 'current', time: Date.now(), text, fileName: s.fileName, formatId: s.analysis?.formatId ?? null }).catch(() => undefined);
  }, 800);
}

export async function restoreWorkspace(): Promise<boolean> {
  if (!store().settings.persistWorkspace) return false;
  try {
    const doc = await loadDocument('current');
    if (doc?.text) {
      setInputText(doc.text, 'restored', doc.fileName);
      return true;
    }
  } catch {
    /* storage unavailable */
  }
  return false;
}

export async function restoreSnapshot(snapshotId: string) {
  try {
    const doc = await loadDocument(snapshotId);
    if (!doc) {
      store().toast('info', 'That snapshot is no longer stored.');
      return;
    }
    setInputText(doc.text, 'restored', doc.fileName);
    store().toast('success', 'Restored the document from history.');
  } catch (e) {
    store().toast('error', `Could not restore: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function wipeStoredData() {
  await clearAllDocuments().catch(() => undefined);
  const s = store();
  s.clearHistory();
  s.toast('success', 'All locally stored documents and history were deleted.');
}
