<script>
  // SourceEditor is the one source box: Monaco (syntax highlighting, and the
  // completions the caller supplies) when it loads, and a plain textarea with the
  // same id and bound value when it cannot. The value is two-way bound; the
  // editor mirrors it, so a parent's change (a loaded statement, a reset) lands in
  // the editor and an edit lands in the parent.
  import { untrack, tick } from 'svelte';
  import * as S from '../strings/index.js';
  import { loadMonaco, modelUri, attachSource, detachSource } from '../editor/monaco.js';

  let {
    value = $bindable(''),
    language = 'sql',
    id = '',
    ariaLabel = '',
    readonly = false,
    // (linePrefix) => items | Promise<items>: the completion items at the cursor.
    completions = null,
    // Ctrl/Cmd+Enter: the caller's run action.
    onrun = null,
    rows = 6,
    placeholder = '',
    cls = '',
  } = $props();

  let host = $state(null);
  let area = $state(null);
  let failed = $state(false);
  // The big-screen view: the same editor (and its text and completions) fills the window.
  let expanded = $state(false);

  async function toggleExpanded() {
    expanded = !expanded;
    await tick();
    if (editor) editor.focus();
    else area?.focus();
  }

  // Escape collapses the big-screen view, and only it: outside it the key is the editor's.
  function onWrapKey(e) {
    if (expanded && e.key === S.common.keyEscape) {
      e.stopPropagation();
      expanded = false;
    }
  }

  // The latest callbacks, read when the editor asks, so a changed prop needs no re-create.
  let ask = null;
  let run = null;
  $effect(() => {
    ask = completions;
  });
  $effect(() => {
    run = onrun;
  });

  let editor = null;
  let model = null;

  $effect(() => {
    const el = host;
    if (!el) return;
    let live = true;
    let sub = null;
    let uri = null;
    let ed = null;
    let m = null;
    loadMonaco()
      .then((mon) => {
        if (!live) return;
        const stem = `${id || 'source'}-${Math.random().toString(36).slice(2, 8)}`;
        uri = modelUri(stem, language);
        m = mon.editor.createModel(untrack(() => value ?? ''), language, uri);
        ed = mon.editor.create(el, {
          model: m,
          readOnly: untrack(() => readonly),
          ariaLabel,
          placeholder,
          automaticLayout: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          tabSize: 2,
          insertSpaces: true,
          fontSize: 13,
          fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim(),
          lineNumbersMinChars: 3,
          folding: false,
          glyphMargin: false,
          renderWhitespace: 'none',
          overviewRulerLanes: 0,
          padding: { top: 6, bottom: 6 },
          fixedOverflowWidgets: true,
          suggestOnTriggerCharacters: true,
          quickSuggestions: { other: true, comments: false, strings: true },
        });
        editor = ed;
        model = m;
        attachSource(uri, (linePrefix) => (ask ? ask(linePrefix) : []));
        ed.addCommand(mon.KeyMod.CtrlCmd | mon.KeyCode.Enter, () => {
          if (run) run();
        });
        sub = m.onDidChangeContent(() => {
          if (value !== m.getValue()) value = m.getValue();
        });
      })
      .catch(() => {
        if (live) failed = true;
      });
    return () => {
      live = false;
      sub?.dispose();
      ed?.dispose();
      m?.dispose();
      if (uri) detachSource(uri);
      editor = null;
      model = null;
    };
  });

  // insert puts text in at the cursor (or over the selection) and takes focus: the
  // console's column chips use it. The textarea fallback keeps its own selection.
  export function insert(text) {
    if (editor) {
      editor.executeEdits('insert', [{ range: editor.getSelection(), text, forceMoveMarkers: true }]);
      editor.focus();
      return;
    }
    if (!area) {
      value = (value ?? '') + text;
      return;
    }
    const start = area.selectionStart ?? (value ?? '').length;
    const end = area.selectionEnd ?? start;
    value = (value ?? '').slice(0, start) + text + (value ?? '').slice(end);
    requestAnimationFrame(() => {
      area.focus();
      const pos = start + text.length;
      area.setSelectionRange(pos, pos);
    });
  }

  // A parent's value change lands in the editor; the editor's own edits already match it.
  $effect(() => {
    const v = value ?? '';
    if (model && model.getValue() !== v) model.setValue(v);
  });

  $effect(() => {
    const ro = readonly;
    editor?.updateOptions({ readOnly: ro });
  });
</script>

<div class="source-wrap" class:expanded onkeydown={onWrapKey}>
  <button
    type="button"
    class="btn small source-expand"
    aria-label={expanded ? S.common.collapseEditor : S.common.expandEditor}
    title={expanded ? S.common.collapseEditor : S.common.expandEditor}
    aria-expanded={expanded}
    onclick={toggleExpanded}
  >
    <span class="codicon codicon-{expanded ? 'screen-normal' : 'screen-full'}"></span>
  </button>
  {#if failed}
    <textarea
      {id}
      bind:this={area}
      class="input mono {cls}"
      rows={rows}
      spellcheck="false"
      {placeholder}
      aria-label={ariaLabel}
      readonly={readonly}
      bind:value
    ></textarea>
  {:else}
    <div
      {id}
      bind:this={host}
      class="source-editor {cls}"
      style="height: {rows * 1.6}em"
      role="group"
      aria-label={ariaLabel}
    ></div>
  {/if}
</div>
