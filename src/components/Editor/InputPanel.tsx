import type * as Monaco from 'monaco-editor';
import { ClipboardPaste, FileUp, FlaskConical, Search, WrapText, X } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { DESCRIPTORS, formatsByCategory } from '../../engines/catalog';
import { useAppStore } from '../../hooks/useAppStore';
import { useEditorTheme } from '../../hooks/useTheme';
import { analyzeNow, copyOutput, downloadOutput, languageFor, loadSample, openFile, pasteFromClipboard, runAction, scheduleWorkspaceSave, setFormatMode, validateNow } from '../../services/controller';
import { editors } from '../../services/editorRegistry';
import { CATEGORY_LABELS } from '../../types/formats';
import { formatBytes } from '../../utils/text';
import { FormatIcon } from '../common/brand';
import { cx, IconButton, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Tooltip } from '../common/ui';
import { DropOverlay } from '../FileUpload/DropOverlay';
import { CodeEditor } from './CodeEditor';

/** FormatX commands inside Monaco: keyboard shortcuts, context menu and the F1 palette. */
function registerEditorActions(editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco) {
  const { KeyMod, KeyCode } = monaco;
  const add = (id: string, label: string, keybindings: number[], run: () => void, order: number) =>
    editor.addAction({ id: `formatx.${id}`, label: `FormatX: ${label}`, keybindings, contextMenuGroupId: '0_formatx', contextMenuOrder: order, run });
  add('beautify', 'Beautify', [KeyMod.Shift | KeyMod.Alt | KeyCode.KeyF], () => void runAction('beautify'), 1);
  add('minify', 'Minify', [KeyMod.Shift | KeyMod.Alt | KeyCode.KeyM], () => void runAction('minify'), 2);
  add('validate', 'Validate', [KeyMod.Shift | KeyMod.Alt | KeyCode.KeyV], () => void validateNow(), 3);
  add('convert', 'Convert…', [KeyMod.Shift | KeyMod.Alt | KeyCode.KeyC], () => useAppStore.getState().openDialog('convert', true), 4);
  add('detect', 'Auto-detect format', [KeyMod.Shift | KeyMod.Alt | KeyCode.KeyD], () => setFormatMode('auto'), 5);
  add('copy-output', 'Copy output', [KeyMod.Shift | KeyMod.Alt | KeyCode.KeyY], () => void copyOutput(), 6);
  add('download', 'Download output', [KeyMod.CtrlCmd | KeyCode.KeyS], () => downloadOutput(), 7);
  add('palette', 'Command palette', [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyP], () => useAppStore.getState().openDialog('palette', true), 8);
  add('open', 'Open file…', [KeyMod.CtrlCmd | KeyCode.KeyO], () => document.getElementById('fx-file-input')?.click(), 9);
}

export function InputPanel() {
  const analysis = useAppStore((s) => s.analysis);
  const mode = useAppStore((s) => s.formatMode);
  const fileName = useAppStore((s) => s.fileName);
  const settings = useAppStore((s) => s.settings);
  const setSettings = useAppStore((s) => s.setSettings);
  const theme = useEditorTheme();
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const formatId = mode === 'auto' ? analysis?.formatId : mode;
  const language = languageFor(formatId, analysis);
  const big = (analysis?.stats.bytes ?? 0) > 3_000_000;

  const onMount = useCallback((editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco) => {
    editors.registerInput(editor, monaco);
    registerEditorActions(editor, monaco);
    editor.onDidChangeCursorSelection((e) => {
      const sel = e.selection;
      const model = editor.getModel();
      const selected = model ? model.getValueLengthInRange(sel) : 0;
      useAppStore.getState().set({ cursor: { line: sel.positionLineNumber, column: sel.positionColumn, selected } });
    });
    editor.onDidPaste(() => {
      const s = useAppStore.getState();
      if (s.inputSource !== 'paste') s.set({ inputSource: 'paste' });
    });
    editor.focus();
    void analyzeNow({ reason: 'Analyzed' });
  }, []);

  const onChange = useCallback(() => {
    const s = useAppStore.getState();
    s.set({ docVersion: s.docVersion + 1 });
    scheduleWorkspaceSave();
  }, []);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void openFile(f);
  };

  const stats = analysis && analysis.validation.status !== 'empty' ? `${analysis.stats.lines.toLocaleString()} lines · ${formatBytes(analysis.stats.bytes)}` : '';

  return (
    <section
      aria-label="Input"
      className="relative flex h-full min-w-0 flex-col bg-surface"
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        dragDepth.current++;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border pl-3 pr-1.5">
        <span className="text-[10.5px] font-bold uppercase tracking-[0.12em] text-faint">Input</span>
        {fileName && (
          <span className="flex max-w-[220px] items-center gap-1 truncate rounded-md bg-surface-3 px-1.5 py-0.5 font-mono text-[11px] text-muted">
            <FormatIcon id={formatId} size={12} /> {fileName}
            <button type="button" aria-label="Forget file name" className="text-faint hover:text-text" onClick={() => useAppStore.getState().set({ fileName: null })}>
              <X size={11} />
            </button>
          </span>
        )}
        <span className="truncate text-[11px] text-faint">{stats}</span>
        <div className="flex-1" />
        <input
          id="fx-file-input"
          ref={fileRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void openFile(f);
            e.target.value = '';
          }}
        />
        <IconButton size="xs" label="Open file (Ctrl+O) — or drop a file here" onClick={() => fileRef.current?.click()}>
          <FileUp size={13} />
        </IconButton>
        <IconButton size="xs" label="Paste from clipboard" onClick={() => void pasteFromClipboard()}>
          <ClipboardPaste size={13} />
        </IconButton>
        <Menu>
          <Tooltip content="Load a sample document">
            <MenuTrigger asChild>
              <button type="button" aria-label="Load a sample" className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-surface-3 hover:text-text">
                <FlaskConical size={13} />
              </button>
            </MenuTrigger>
          </Tooltip>
          <MenuContent align="end" className="w-56">
            {formatId && (
              <>
                <MenuItem icon={<FormatIcon id={formatId} />} onSelect={() => loadSample(formatId)}>
                  {DESCRIPTORS[formatId].name} sample
                </MenuItem>
                <MenuSeparator />
              </>
            )}
            {formatsByCategory().map(({ category, formats }) => (
              <div key={category}>
                <MenuLabel>{CATEGORY_LABELS[category]}</MenuLabel>
                {formats.map((d) => (
                  <MenuItem key={d.id} icon={<FormatIcon id={d.id} />} onSelect={() => loadSample(d.id)}>
                    {d.name}
                  </MenuItem>
                ))}
              </div>
            ))}
          </MenuContent>
        </Menu>
        <IconButton size="xs" label="Find & replace (Ctrl+F / Ctrl+H)" onClick={() => editors.trigger('editor.action.startFindReplaceAction')}>
          <Search size={13} />
        </IconButton>
        <IconButton size="xs" label="Toggle word wrap" active={settings.wordWrap} onClick={() => setSettings({ wordWrap: !settings.wordWrap })}>
          <WrapText size={13} />
        </IconButton>
      </div>
      <div className={cx('relative min-h-0 flex-1')}>
        <CodeEditor
          ariaLabel="Input editor"
          language={language}
          theme={theme}
          onMount={onMount}
          onChange={onChange}
          options={{
            fontSize: settings.fontSize,
            fontLigatures: settings.fontLigatures,
            wordWrap: settings.wordWrap ? 'on' : 'off',
            minimap: { enabled: settings.minimap && !big, renderCharacters: false, scale: 1 },
            stickyScroll: { enabled: settings.stickyScroll && !big },
            renderWhitespace: settings.renderWhitespace ? 'all' : 'selection',
            folding: !big,
            lineNumbersMinChars: 3,
          }}
        />
        {dragging && <DropOverlay />}
      </div>
    </section>
  );
}
