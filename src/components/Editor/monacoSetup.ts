import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';
import { registerCustomLanguages } from './languages';
import { defineThemes } from './themes';

let initialized = false;

/** One-time Monaco configuration. Monaco is bundled locally (no CDN). */
export function setupMonaco(): typeof monaco {
  if (initialized) return monaco;
  initialized = true;

  self.MonacoEnvironment = {
    getWorker(_moduleId: string, label: string) {
      switch (label) {
        case 'json':
          return new JsonWorker();
        case 'css':
        case 'scss':
        case 'less':
          return new CssWorker();
        case 'html':
        case 'handlebars':
        case 'razor':
          return new HtmlWorker();
        case 'typescript':
        case 'javascript':
          return new TsWorker();
        default:
          return new EditorWorker();
      }
    },
  };

  // FormatX's engine is the single source of truth for diagnostics: turn off
  // Monaco's built-in validators so users never see two conflicting opinions.
  monaco.json.jsonDefaults.setDiagnosticsOptions({ validate: false, allowComments: true, trailingCommas: 'ignore', schemaValidation: 'ignore' });
  for (const d of [monaco.css.cssDefaults, monaco.css.scssDefaults, monaco.css.lessDefaults]) d.setOptions({ validate: false });
  for (const d of [monaco.typescript.javascriptDefaults, monaco.typescript.typescriptDefaults]) {
    d.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true });
  }
  monaco.typescript.typescriptDefaults.setCompilerOptions({ jsx: monaco.typescript.JsxEmit.Preserve, allowNonTsExtensions: true, target: monaco.typescript.ScriptTarget.ESNext });

  registerCustomLanguages(monaco);
  defineThemes(monaco);

  // Web fonts load asynchronously; re-measure once they are ready so the cursor lines up.
  if (typeof document !== 'undefined' && document.fonts) {
    void document.fonts.ready.then(() => monaco.editor.remeasureFonts());
  }
  return monaco;
}

export type { monaco };
