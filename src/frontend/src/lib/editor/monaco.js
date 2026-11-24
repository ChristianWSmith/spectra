// Monaco, the source editor behind every builtin and user source box (SQL,
// metric and report bodies, component source). It loads on first use, so the
// app's start does not pay for it, and it is the only module that imports
// monaco-editor. A source editor registers a completion function for its model;
// one provider per language asks that function for items at the cursor.

let loading = null;
let mon = null; // the Monaco namespace, once loaded
const sources = new Map(); // model uri -> (linePrefix) => items | Promise<items>

// The completion kinds the item shape names, mapped to Monaco's.
const KIND = {
  keyword: 'Keyword',
  table: 'Class',
  field: 'Field',
  variable: 'Variable',
  reference: 'Reference',
  function: 'Function',
  helper: 'Module',
  property: 'Property',
  component: 'Struct',
  snippet: 'Snippet',
};

// The Go template language: {{ … }} actions over plain text. Monaco has no
// built-in one, so the actions and their keywords are tokenised here.
const GO_TEMPLATE_TOKENS = {
  defaultToken: '',
  tokenPostfix: '.gotmpl',
  tokenizer: {
    root: [
      [/\{\{-?/, { token: 'delimiter', next: '@action' }],
      [/[^{]+/, ''],
      [/\{/, ''],
    ],
    action: [
      [/-?\}\}/, { token: 'delimiter', next: '@pop' }],
      [/"(?:[^"\\]|\\.)*"/, 'string'],
      [/`[^`]*`/, 'string'],
      [/\b(?:if|else|end|range|with|define|template|block)\b/, 'keyword'],
      [/\b(?:and|or|not|eq|ne|lt|le|gt|ge|len|index|slice|printf|print|println|html|js|urlquery|call|nil|true|false)\b/, 'predicate'],
      [/\$?\.[A-Za-z_][\w.]*/, 'variable'],
      [/\$[A-Za-z_]\w*/, 'variable'],
      [/\d+(?:\.\d+)?/, 'number'],
      [/[|()=:,]/, 'delimiter'],
      [/\s+/, ''],
      [/./, ''],
    ],
  },
};

function themeName() {
  return document.documentElement.dataset.theme === 'light' ? 'vs' : 'vs-dark';
}

function toSuggestion(i, range) {
  const kinds = mon.languages.CompletionItemKind;
  return {
    label: i.label,
    kind: kinds[KIND[i.kind]] ?? kinds.Text,
    detail: i.detail || undefined,
    documentation: i.doc || undefined,
    insertText: i.insert ?? i.label,
    insertTextRules: i.snippet ? mon.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
    range,
  };
}

function completionProvider() {
  return {
    triggerCharacters: ['.', ':', "'"],
    async provideCompletionItems(model, position) {
      const ask = sources.get(model.uri.toString());
      if (!ask) return { suggestions: [] };
      const word = model.getWordUntilPosition(position);
      const range = new mon.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      const linePrefix = model.getValueInRange(new mon.Range(position.lineNumber, 1, position.lineNumber, position.column));
      const items = (await ask(linePrefix)) || [];
      return { suggestions: items.map((i) => toSuggestion(i, range)) };
    },
  };
}

// loadMonaco resolves the Monaco namespace, with its languages and providers
// registered, once. A rejection means the editor cannot load here, and the
// caller falls back to a plain textarea.
export function loadMonaco() {
  if (!loading) {
    loading = (async () => {
      // The editor's worker, bundled by Vite from its package path. Vite's worker
      // transform needs a relative URL literal, hence the path from this file.
      self.MonacoEnvironment = {
        getWorker: () => new Worker(new URL('../../../node_modules/monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url), { type: 'module' }),
      };
      const [ns] = await Promise.all([
        import('monaco-editor/editor/editor.api.js'),
        import('monaco-editor/languages/definitions/sql/register.js'),
        import('monaco-editor/languages/definitions/javascript/register.js'),
      ]);
      mon = ns;
      mon.languages.register({ id: 'gotemplate', extensions: ['.tmpl'], aliases: ['Go template'] });
      mon.languages.setMonarchTokensProvider('gotemplate', GO_TEMPLATE_TOKENS);
      for (const lang of ['sql', 'javascript', 'gotemplate']) {
        mon.languages.registerCompletionItemProvider(lang, completionProvider());
      }
      mon.editor.setTheme(themeName());
      new MutationObserver(() => mon.editor.setTheme(themeName())).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme'],
      });
      return mon;
    })();
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

// modelUri is a unique in-memory address for one editor's document, so each
// editor's completions stay its own.
export function modelUri(stem, language) {
  const ext = { sql: 'sql', javascript: 'js', gotemplate: 'tmpl' }[language] || 'txt';
  return mon.Uri.parse(`inmemory://spectra/${stem}.${ext}`);
}

// attachSource registers the completion function for a model; detachSource drops it.
export function attachSource(uri, ask) {
  sources.set(uri.toString(), ask);
}

export function detachSource(uri) {
  sources.delete(uri.toString());
}
