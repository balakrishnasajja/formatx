# FormatX — Universal Data Formatter & Validator

A browser-based developer utility that **detects, validates, beautifies, minifies and converts** structured data and source code. Everything runs locally in a Web Worker — no backend, no uploads.

## Features

- **Automatic format detection** with confidence scores and alternative candidates (heuristics verified by real parsers).
- **Precise diagnostics**: error type, message, line/column, severity, suggestions, related locations — shown as editor squiggles, inline "error lens" text and a Problems panel. Quick fixes are offered but only applied when clicked (and are undoable).
- **Never modifies invalid input silently**: formatting and conversion are blocked while errors exist (an explicit "Format anyway" exists only for advisory validators such as vendor SQL dialects). Formatting output is re-parsed and compared to the input to prove no data changed.
- **Lossless where possible**: large integers (`12345678901234567890`) and exact decimals are never rounded; key order is preserved; every conversion lists what information could be lost.
- Monaco editor (find/replace, folding, bracket matching, multiple themes), resizable split panes, drag-and-drop/file upload, binary file support, command palette, keyboard shortcuts.

## Supported formats

| Category | Formats |
| --- | --- |
| Data | JSON, JSONC, JSON5, XML, YAML, TOML, CSV, TSV, INI, ENV, Java Properties |
| Web | HTML, CSS, SCSS, JavaScript, TypeScript, Markdown |
| Programming | PHP, Python, Java, SQL (13 dialects) |
| API & schema | GraphQL, OpenAPI (3.x / Swagger 2.0), JSON Schema (draft-04 → 2020-12) |
| Advanced | BSON, MessagePack, Protocol Buffers (.proto) |

The in-app **Docs → Formats** tab lists the exact capabilities, engines and limitations of each format (full vs. partial support).

## Tech stack

React 19 · TypeScript · Vite · Tailwind CSS 4 · Monaco Editor · Radix UI · Zustand · Lucide icons.
Parsers/formatters: hand-written recovering parsers (JSON family, XML, CSV, INI, ENV, Properties, TOML printer), `yaml`, `smol-toml`, `parse5`, PostCSS, Babel parser, Prettier (+ PHP/Java plugins), Terser, `sql-formatter`, `node-sql-parser`, `graphql`, Ajv, `bson`, `@msgpack/msgpack`, `protobufjs`, Ruff (WebAssembly) for Python, `marked` + DOMPurify for previews.

## Getting started

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # Vitest suite (194 tests)
npm run build      # type-check + production build into dist/
npm run preview    # serve the production build
```

> On Windows, run the tests from a path with an uppercase drive letter (e.g. `D:\…`); a lowercase `d:\` working directory makes Vitest load itself twice.

## Architecture

```
src/
  types/            shared contracts (formats, diagnostics, engine, data model)
  parsers/<format>/ one FormatModule per format: detect · validate · beautify · minify · toData · fromData
  engines/
    catalog.ts      UI-safe format metadata (no parser code)
    registry.ts     module registry (worker side)
    detection/      two-stage detection (heuristics → parser verification)
    validators/     centralized validation & diagnostic normalization
    converters/     neutral data model, conversion routing, loss notes
    worker/         Web Worker + client with timeout/restart
  components/       Header/command bar, Sidebar, Editor, OutputPanel, ErrorPanel, Dialogs…
  services/         controller, editor registry, files, opt-in IndexedDB storage
  hooks/            store, engine sync, shortcuts, theme
tests/              per-format, detection and conversion tests
```

Adding a format = implement `FormatModule` in `src/parsers/<id>/`, add its descriptor to `engines/catalog.ts` and register it in `engines/registry.ts`.

## Privacy

All processing happens in the browser. Preferences are stored in `localStorage`; document content is only stored (IndexedDB) if you enable **Settings → Privacy → Remember workspace**. HTML/Markdown previews are sanitized and rendered in a sandboxed iframe with scripts and network requests blocked.
