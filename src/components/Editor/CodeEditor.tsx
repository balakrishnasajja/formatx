import type * as Monaco from 'monaco-editor';
import { useEffect, useRef } from 'react';
import { setupMonaco } from './monacoSetup';

export interface CodeEditorProps {
  language: string;
  theme: string;
  ariaLabel: string;
  /** Controlled value (output editor). When omitted, the editor owns its text. */
  value?: string;
  initialValue?: string;
  readOnly?: boolean;
  options?: Monaco.editor.IStandaloneEditorConstructionOptions;
  onMount?: (editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco) => void;
  onChange?: (editor: Monaco.editor.IStandaloneCodeEditor, e: Monaco.editor.IModelContentChangedEvent) => void;
  className?: string;
}

export const MONO_FONT = "'JetBrains Mono Variable', 'JetBrains Mono', 'Cascadia Code', Consolas, 'Courier New', monospace";

export function CodeEditor({ language, theme, ariaLabel, value, initialValue, readOnly, options, onMount, onChange, className }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onMountRef = useRef(onMount);
  onMountRef.current = onMount;

  useEffect(() => {
    const monaco = setupMonaco();
    monacoRef.current = monaco;
    const model = monaco.editor.createModel(value ?? initialValue ?? '', language);
    const editor = monaco.editor.create(host.current!, {
      model,
      theme,
      readOnly,
      ariaLabel,
      automaticLayout: true,
      fontFamily: MONO_FONT,
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
      padding: { top: 6, bottom: 6 },
      renderLineHighlight: 'all',
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: 'active', indentation: true, highlightActiveIndentation: true },
      showFoldingControls: 'mouseover',
      fixedOverflowWidgets: true,
      quickSuggestions: false,
      suggestOnTriggerCharacters: false,
      wordBasedSuggestions: 'off',
      parameterHints: { enabled: false },
      tabSize: 2,
      detectIndentation: true,
      largeFileOptimizations: true,
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
      overviewRulerBorder: false,
      ...options,
    });
    editorRef.current = editor;
    const sub = editor.onDidChangeModelContent((e) => onChangeRef.current?.(editor, e));
    onMountRef.current?.(editor, monaco);
    return () => {
      sub.dispose();
      editor.dispose();
      model.dispose();
      editorRef.current = null;
    };
    // mount once; later prop changes are applied by the effects below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const m = editorRef.current?.getModel();
    if (m && monacoRef.current && m.getLanguageId() !== language) monacoRef.current.editor.setModelLanguage(m, language);
  }, [language]);

  useEffect(() => {
    monacoRef.current?.editor.setTheme(theme);
  }, [theme]);

  const optionsKey = JSON.stringify(options ?? {});
  useEffect(() => {
    editorRef.current?.updateOptions({ ...(options ?? {}), readOnly });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionsKey, readOnly]);

  useEffect(() => {
    if (value === undefined) return;
    const editor = editorRef.current;
    const m = editor?.getModel();
    if (m && m.getValue() !== value) {
      m.setValue(value);
      editor?.setScrollPosition({ scrollTop: 0, scrollLeft: 0 });
    }
  }, [value]);

  return <div ref={host} className={className ?? 'h-full w-full'} data-testid={ariaLabel} />;
}
