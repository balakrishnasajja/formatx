import type * as Monaco from 'monaco-editor';
import type { TextEdit } from '../types/diagnostics';

type Editor = Monaco.editor.IStandaloneCodeEditor;

/**
 * Imperative access to the two Monaco editors. The input model is the single
 * source of truth for the document text (so large files are not copied into
 * React state on every keystroke).
 */
class EditorRegistry {
  input: Editor | null = null;
  output: Editor | null = null;
  monaco: typeof Monaco | null = null;
  private pendingInput: string | null = null;

  registerInput(editor: Editor, monaco: typeof Monaco) {
    this.input = editor;
    this.monaco = monaco;
    const model = editor.getModel();
    if (this.pendingInput !== null) {
      model?.setValue(this.pendingInput);
      this.pendingInput = null;
    }
    // Keep the text if this editor is disposed and re-created (React StrictMode, layout changes).
    model?.onWillDispose(() => {
      if (this.input === editor) {
        this.pendingInput = model.getValue();
        this.input = null;
      }
    });
  }

  registerOutput(editor: Editor) {
    this.output = editor;
  }

  getInput(): string {
    return this.input?.getModel()?.getValue() ?? this.pendingInput ?? '';
  }

  /** Replace the whole input as a single undoable edit (Ctrl+Z restores the previous text). */
  setInput(text: string, opts: { undoable?: boolean } = { undoable: true }) {
    const editor = this.input;
    const model = editor?.getModel();
    if (!editor || !model) {
      this.pendingInput = text;
      return;
    }
    if (opts.undoable === false) {
      model.setValue(text);
      return;
    }
    editor.pushUndoStop();
    editor.executeEdits('formatx', [{ range: model.getFullModelRange(), text, forceMoveMarkers: true }]);
    editor.pushUndoStop();
    editor.setPosition({ lineNumber: 1, column: 1 });
    editor.revealLine(1);
  }

  /** Apply quick-fix edits (offsets into the current input) as one undoable step. */
  applyEdits(edits: TextEdit[], label = 'formatx.fix') {
    const editor = this.input;
    const model = editor?.getModel();
    if (!editor || !model || !this.monaco) return false;
    const ops = edits.map((e) => {
      const start = model.getPositionAt(e.offset);
      const end = model.getPositionAt(e.offset + e.length);
      return { range: new this.monaco!.Range(start.lineNumber, start.column, end.lineNumber, end.column), text: e.text, forceMoveMarkers: true };
    });
    editor.pushUndoStop();
    const ok = editor.executeEdits(label, ops);
    editor.pushUndoStop();
    editor.focus();
    return ok;
  }

  reveal(line: number, column: number, endLine?: number, endColumn?: number) {
    const editor = this.input;
    if (!editor || !this.monaco) return;
    const range = new this.monaco.Range(line, column, endLine ?? line, endColumn ?? column);
    editor.setSelection(endLine ? range : new this.monaco.Range(line, column, line, column));
    editor.revealRangeInCenterIfOutsideViewport(range, this.monaco.editor.ScrollType.Smooth);
    editor.focus();
    const ids = editor.createDecorationsCollection([{ range: new this.monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: 'fx-line-flash' } }]);
    setTimeout(() => ids.clear(), 900);
  }

  trigger(command: 'undo' | 'redo' | 'actions.find' | 'editor.action.startFindReplaceAction') {
    const editor = this.input;
    if (!editor) return;
    editor.focus();
    editor.trigger('formatx', command, null);
  }
}

export const editors = new EditorRegistry();
