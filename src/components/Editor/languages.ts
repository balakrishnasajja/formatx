import type * as Monaco from 'monaco-editor';

/** Rainbow-column tokenizer for delimited text (state carries quoted fields across lines). */
function delimitedTokens(monaco: typeof Monaco, languageId: string, delimiter: string) {
  class State implements Monaco.languages.IState {
    col: number;
    inQuote: boolean;
    constructor(col: number, inQuote: boolean) {
      this.col = col;
      this.inQuote = inQuote;
    }
    clone() {
      return new State(this.col, this.inQuote);
    }
    equals(other: Monaco.languages.IState) {
      return other instanceof State && other.col === this.col && other.inQuote === this.inQuote;
    }
  }
  monaco.languages.setTokensProvider(languageId, {
    getInitialState: () => new State(0, false),
    tokenize(line: string, state: Monaco.languages.IState) {
      const s = state as State;
      let col = s.inQuote ? s.col : 0;
      let inQuote = s.inQuote;
      const tokens: Monaco.languages.IToken[] = [];
      const scope = () => `csv.c${col % 6}`;
      tokens.push({ startIndex: 0, scopes: scope() });
      let i = 0;
      while (i < line.length) {
        const ch = line[i];
        if (inQuote) {
          if (ch === '"') {
            if (line[i + 1] === '"') {
              i += 2;
              continue;
            }
            inQuote = false;
          }
          i++;
          continue;
        }
        if (ch === '"') {
          inQuote = true;
          i++;
          continue;
        }
        if (ch === delimiter) {
          tokens.push({ startIndex: i, scopes: `delimiter.${languageId}` });
          col++;
          if (i + 1 < line.length) tokens.push({ startIndex: i + 1, scopes: scope() });
        }
        i++;
      }
      return { tokens, endState: new State(inQuote ? col : 0, inQuote) };
    },
  });
}

export function registerCustomLanguages(monaco: typeof Monaco): void {
  const register = (id: string, extensions: string[], aliases: string[]) => {
    if (!monaco.languages.getLanguages().some((l) => l.id === id)) monaco.languages.register({ id, extensions, aliases });
  };

  register('toml', ['.toml'], ['TOML']);
  monaco.languages.setLanguageConfiguration('toml', {
    comments: { lineComment: '#' },
    brackets: [
      ['[', ']'],
      ['{', '}'],
    ],
    autoClosingPairs: [
      { open: '[', close: ']' },
      { open: '{', close: '}' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
  });
  monaco.languages.setMonarchTokensProvider('toml', {
    tokenizer: {
      root: [
        [/^\s*\[\[[^\]]*\]\]/, 'type.identifier'],
        [/^\s*\[[^\]]*\]/, 'type.identifier'],
        [/#.*$/, 'comment'],
        [/"""/, 'string', '@mlbasic'],
        [/'''/, 'string', '@mlliteral'],
        [/"([^"\\]|\\.)*"(?=\s*[.=])/, 'key'],
        [/[A-Za-z0-9_-]+(?=\s*[.=])/, 'key'],
        [/"([^"\\]|\\.)*"/, 'string'],
        [/'[^']*'/, 'string'],
        [/\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?/, 'number.date'],
        [/\d{2}:\d{2}:\d{2}(?:\.\d+)?/, 'number.date'],
        [/[+-]?0(?:x[0-9a-fA-F_]+|o[0-7_]+|b[01_]+)/, 'number.hex'],
        [/[+-]?(?:inf|nan)\b/, 'number'],
        [/[+-]?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?/, 'number'],
        [/\b(?:true|false)\b/, 'keyword'],
        [/=/, 'delimiter'],
        [/[[\]{},.]/, 'delimiter.bracket'],
      ],
      mlbasic: [
        [/"""/, 'string', '@pop'],
        [/\\./, 'string.escape'],
        [/[^"\\]+/, 'string'],
        [/./, 'string'],
      ],
      mlliteral: [
        [/'''/, 'string', '@pop'],
        [/[^']+/, 'string'],
        [/./, 'string'],
      ],
    },
  });

  for (const [id, delim, ext] of [
    ['csv', ',', '.csv'],
    ['csv-semicolon', ';', '.csv'],
    ['csv-pipe', '|', '.psv'],
    ['tsv', '\t', '.tsv'],
  ] as const) {
    register(id, [ext], [id.toUpperCase()]);
    delimitedTokens(monaco, id, delim);
  }

  register('dotenv', ['.env'], ['dotenv', 'ENV']);
  monaco.languages.setLanguageConfiguration('dotenv', { comments: { lineComment: '#' } });
  monaco.languages.setMonarchTokensProvider('dotenv', {
    tokenizer: {
      // single state: Monarch states persist across lines, and dotenv values are line-based
      root: [
        [/^\s*#.*$/, 'comment'],
        [/^(\s*)(export)(\s+)/, ['', 'keyword', '']],
        [/^(\s*)([A-Za-z_][\w.-]*)(\s*=)/, ['', 'key', 'delimiter']],
        [/\s+#.*$/, 'comment'],
        [/"([^"\\]|\\.)*"?/, 'string'],
        [/'[^']*'?/, 'string'],
        [/\$\{[^}]*\}|\$[A-Za-z_]\w*/, 'variable'],
        [/[^\s$"'#]+/, 'string'],
      ],
    },
  });

  register('properties', ['.properties'], ['Properties']);
  monaco.languages.setLanguageConfiguration('properties', { comments: { lineComment: '#' } });
  monaco.languages.setMonarchTokensProvider('properties', {
    tokenizer: {
      root: [
        [/^\s*[#!].*$/, 'comment'],
        [/^(\s*)((?:\\.|[^=:\s\\])+)(\s*[=:]\s*|\s+)/, ['', 'key', 'delimiter']],
        [/\\u[0-9a-fA-F]{4}|\\./, 'string.escape'],
        [/[^\\]+/, 'string'],
      ],
    },
  });
}
