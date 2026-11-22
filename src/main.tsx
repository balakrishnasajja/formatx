import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles/index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

// The editor starts empty; samples are available from the flask icon in the input
// panel, the sidebar, or the command palette.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
