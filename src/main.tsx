import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles/index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { editors } from './services/editorRegistry';
import { SAMPLES } from './parsers/samples';
import { useAppStore } from './hooks/useAppStore';

// First visit: start with a small, deliberately unformatted JSON document so the
// app demonstrates detection → validation → beautify immediately.
if (!useAppStore.getState().settings.persistWorkspace) {
  editors.setInput(SAMPLES.json, { undoable: false });
  useAppStore.getState().set({ inputSource: 'sample' });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
