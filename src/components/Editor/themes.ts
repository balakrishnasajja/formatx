import type * as Monaco from 'monaco-editor';

const CSV_DARK = ['7dd3fc', 'c4b5fd', 'fda4af', 'fde68a', '86efac', 'f9a8d4'];
const CSV_LIGHT = ['0369a1', '6d28d9', 'be123c', 'a16207', '15803d', 'be185d'];

function csvRules(colors: string[]): Monaco.editor.ITokenThemeRule[] {
  return colors.map((c, i) => ({ token: `csv.c${i}`, foreground: c }));
}

export const EDITOR_THEMES: { id: string; label: string; dark: boolean }[] = [
  { id: 'formatx-dark', label: 'FormatX Dark', dark: true },
  { id: 'formatx-midnight', label: 'Midnight', dark: true },
  { id: 'formatx-light', label: 'FormatX Light', dark: false },
  { id: 'hc-black', label: 'High Contrast', dark: true },
];

export function defineThemes(monaco: typeof Monaco): void {
  const darkRules: Monaco.editor.ITokenThemeRule[] = [
    { token: 'comment', foreground: '6b7383', fontStyle: 'italic' },
    { token: 'string', foreground: '98c379' },
    { token: 'string.escape', foreground: 'f0abfc' },
    { token: 'string.key.json', foreground: '8ab4f8' },
    { token: 'string.value.json', foreground: '98c379' },
    { token: 'key', foreground: '8ab4f8' },
    { token: 'type', foreground: '8ab4f8' },
    { token: 'type.yaml', foreground: '8ab4f8' },
    { token: 'type.identifier', foreground: '61afef', fontStyle: 'bold' },
    { token: 'number', foreground: 'e5a56b' },
    { token: 'number.date', foreground: 'fbbf24' },
    { token: 'keyword', foreground: 'c792ea' },
    { token: 'keyword.json', foreground: 'c792ea' },
    { token: 'variable', foreground: 'fca5a5' },
    { token: 'delimiter', foreground: '8d98aa' },
    { token: 'tag', foreground: '67e8f9' },
    { token: 'metatag', foreground: 'c4a1ff' },
    { token: 'attribute.name', foreground: 'c4b5fd' },
    { token: 'attribute.value', foreground: '98c379' },
    ...csvRules(CSV_DARK),
  ];
  const darkColors = (bg: string, line: string, gutterFg: string): Monaco.editor.IColors => ({
    'editor.background': bg,
    'editor.foreground': '#ececec',
    'editorGutter.background': bg,
    'minimap.background': bg,
    'editor.lineHighlightBackground': line,
    'editor.lineHighlightBorder': '#00000000',
    'editorLineNumber.foreground': gutterFg,
    'editorLineNumber.activeForeground': '#b0b0b0',
    'editorCursor.foreground': '#5b9dff',
    'editor.selectionBackground': '#5b9dff38',
    'editor.inactiveSelectionBackground': '#5b9dff1c',
    'editor.findMatchBackground': '#fbbf2455',
    'editor.findMatchHighlightBackground': '#fbbf2426',
    'editorBracketMatch.background': '#5b9dff1f',
    'editorBracketMatch.border': '#5b9dff80',
    'editorIndentGuide.background1': '#1c1c1c',
    'editorIndentGuide.activeBackground1': '#363636',
    'editorWhitespace.foreground': '#2e2e2e',
    'editorWidget.background': '#121212',
    'editorWidget.border': '#2e2e2e',
    'editorHoverWidget.background': '#121212',
    'editorHoverWidget.border': '#2e2e2e',
    'editorSuggestWidget.background': '#121212',
    'editorSuggestWidget.border': '#2e2e2e',
    'input.background': '#050505',
    'input.border': '#2e2e2e',
    'scrollbarSlider.background': '#2e2e2e80',
    'scrollbarSlider.hoverBackground': '#3d3d3daa',
    'scrollbarSlider.activeBackground': '#5b9dff55',
    'editorError.foreground': '#f87171',
    'editorWarning.foreground': '#fbbf24',
    'editorInfo.foreground': '#60a5fa',
    'editorOverviewRuler.errorForeground': '#f87171',
    'editorOverviewRuler.warningForeground': '#fbbf24',
    'editorOverviewRuler.border': '#00000000',
    'editorStickyScroll.background': bg,
    'editorStickyScrollHover.background': line,
  });

  monaco.editor.defineTheme('formatx-dark', { base: 'vs-dark', inherit: true, rules: darkRules, colors: darkColors('#0a0a0a', '#141414', '#454545') });
  monaco.editor.defineTheme('formatx-midnight', {
    base: 'vs-dark',
    inherit: true,
    rules: darkRules.map((r) => (r.token === 'comment' ? { ...r, foreground: '6272a4' } : r)),
    colors: { ...darkColors('#0a1022', '#111a33', '#3b4a75'), 'editor.selectionBackground': '#8b5cf640', 'editorCursor.foreground': '#a78bfa' },
  });
  monaco.editor.defineTheme('formatx-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '8090a6', fontStyle: 'italic' },
      { token: 'string', foreground: '0f7b4f' },
      { token: 'string.key.json', foreground: '0369a1' },
      { token: 'string.value.json', foreground: '0f7b4f' },
      { token: 'key', foreground: '0369a1' },
      { token: 'type', foreground: '0369a1' },
      { token: 'type.identifier', foreground: '0e7490', fontStyle: 'bold' },
      { token: 'number', foreground: 'c2410c' },
      { token: 'number.date', foreground: 'a16207' },
      { token: 'keyword', foreground: '7c3aed' },
      { token: 'variable', foreground: 'be123c' },
      { token: 'tag', foreground: '0e7490' },
      { token: 'attribute.name', foreground: '6d28d9' },
      { token: 'attribute.value', foreground: '0f7b4f' },
      ...csvRules(CSV_LIGHT),
    ],
    colors: {
      'editor.background': '#ffffff',
      'editorGutter.background': '#ffffff',
      'minimap.background': '#ffffff',
      'editor.lineHighlightBackground': '#f3f6fa',
      'editorLineNumber.foreground': '#b3bdcb',
      'editorLineNumber.activeForeground': '#526075',
      'editorCursor.foreground': '#2f6fdf',
      'editor.selectionBackground': '#2f6fdf2e',
      'editorIndentGuide.background1': '#edf1f6',
      'editorIndentGuide.activeBackground1': '#cbd5e1',
      'editorWidget.background': '#ffffff',
      'editorWidget.border': '#dfe5ee',
      'editorStickyScroll.background': '#ffffff',
    },
  });
}

export function resolveEditorTheme(setting: string, appDark: boolean): string {
  if (setting === 'auto') return appDark ? 'formatx-dark' : 'formatx-light';
  return setting;
}
