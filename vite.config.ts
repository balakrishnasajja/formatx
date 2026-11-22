import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// FormatX runs entirely in the browser. There is no backend: every parser,
// validator, formatter and converter executes client-side (mostly inside a
// dedicated Web Worker) so user data never leaves the machine.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  worker: {
    // ES module workers allow code-splitting heavy parsers (Prettier, Terser,
    // SQL grammars, ...) into lazily loaded chunks inside the engine worker.
    format: 'es',
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 8192,
    sourcemap: false,
  },
  server: {
    port: 5173,
  },
});
