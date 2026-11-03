<script>
  // M5 command palette: Ctrl/Cmd-K overlay with fuzzy search
  // across nav actions, matches, players, saved filters, metrics and saved
  // queries. Sources are async and debounced; each section caps at 15 rows.
  import {
    listMatches,
    listPlayers,
    listSavedFilters,
    listMetrics,
    listSavedQueries,
    setPendingTimelineFilter,
  } from '../services.js';
  import { toggleTheme } from '../theme.js';
  import { fmtDate } from '../fmt.js';
  import { NAV_ACTIONS } from '../nav.js';
  import Dialog from './Dialog.svelte';

  let { nav = () => {} } = $props();

  let open = $state(false);
  let query = $state('');
  let sections = $state([]);
  let active = $state(0);
  let loading = $state(false);
  let themeNow = $state('dark');
  let inputEl = $state(null);
  let gen = 0; // search generation — drops stale async results

  // The sidebar's action list (lib/nav.js) rendered for the palette:
  // same membership, order and labels as App.svelte's sidebar buttons.
  function navActions() {
    return NAV_ACTIONS.map((a) => ({ label: a.label, run: () => nav(a.hash) }));
  }

  // Subsequence fuzzy match: consecutive + word-start bonuses, shorter
  // haystacks win ties. Returns {score, indices} or null.
  function fuzzy(q, text) {
    const ql = q.toLowerCase();
    const tl = String(text || '').toLowerCase();
    let qi = 0;
    let score = 0;
    let last = -2;
    const indices = [];
    for (let ti = 0; ti < tl.length && qi < ql.length; ti++) {
      if (tl[ti] !== ql[qi]) continue;
      let s = 1;
      if (ti === last + 1) s += 4;
      if (ti === 0 || /[\s\-_/.(]/.test(tl[ti - 1])) s += 3;
      score += s;
      indices.push(ti);
      last = ti;
      qi++;
    }
    if (qi < ql.length) return null;
    return { score: score + Math.max(0, 8 - (tl.length - ql.length) * 0.1), indices };
  }

  function scoredItems(q, rows) {
    const out = [];
    for (const r of rows) {
      const m = fuzzy(q, r.label);
      if (!m) continue;
      out.push({ ...r, score: m.score, hl: m.indices });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, 15);
  }

  function segs(text, hl) {
    if (!hl || !hl.length) return [{ text, on: false }];
    const set = new Set(hl);
    const out = [];
    let buf = '';
    let on = set.has(0);
    for (let i = 0; i < text.length; i++) {
      const cur = set.has(i);
      if (cur !== on) {
        if (buf) out.push({ text: buf, on });
        buf = '';
        on = cur;
      }
      buf += text[i];
    }
    if (buf) out.push({ text: buf, on });
    return out;
  }

  function quickSections() {
    const items = navActions().map((a) => ({ ...a, sub: '', hl: [] }));
    items.push({
      label: `Toggle theme (now ${themeNow})`,
      sub: '',
      hl: [],
      run: () => {
        themeNow = toggleTheme();
      },
    });
    return [{ header: 'Actions', items }];
  }

  const flat = $derived(sections.flatMap((s) => s.items));

  // Keyboard nav helpers.
  function move(d) {
    const n = flat.length;
    if (!n) return;
    active = (active + d + n) % n;
  }

  function runActive() {
    const it = flat[active];
    if (!it) return;
    close();
    it.run();
  }

  function pick(i) {
    const it = flat[i];
    if (!it) return;
    close();
    it.run();
  }

  function openPalette() {
    themeNow = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    query = '';
    active = 0;
    sections = quickSections();
    open = true;
    requestAnimationFrame(() => inputEl && inputEl.focus());
  }

  function close() {
    open = false;
    gen++;
    loading = false;
  }

  function toggle() {
    if (open) close();
    else openPalette();
  }

  // Global hotkey — registered once; handlers read the live rune values.
  $effect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        toggle();
        return;
      }
      if (!open) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        move(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        move(-1);
      } else if (e.key === 'Enter' && e.target === inputEl) {
        // Enter only from the input — on a focused row the native button
        // click fires pick() and a second run would double-toggle actions.
        e.preventDefault();
        runActive();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Debounced multi-source search (150 ms, only for input of >= 1 char).
  $effect(() => {
    const q = query.trim();
    if (!open) return;
    if (q.length === 0) {
      gen++;
      loading = false;
      sections = quickSections();
      active = 0;
      return;
    }
    const my = ++gen;
    loading = true;
    const t = setTimeout(() => runSearch(q, my), 150);
    return () => clearTimeout(t);
  });

  // Keep the active row in view (DOM-only, no state loop).
  $effect(() => {
    active;
    sections;
    if (!open) return;
    requestAnimationFrame(() => {
      const el = document.getElementById('cp-item-' + active);
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    });
  });

  async function runSearch(q, my) {
    const results = await Promise.allSettled([
      fetchMatches(q),
      fetchPlayers(q),
      fetchFilters(q),
      fetchMetrics(q),
      fetchQueries(q),
    ]);
    if (my !== gen) return;
    loading = false;
    const secs = [navSection(q)];
    const names = ['Matches', 'Players', 'Saved filters', 'Metrics', 'Saved queries'];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value.length) {
        secs.push({ header: names[i], items: r.value });
      }
    });
    sections = secs;
    active = 0;
  }

  function navSection(q) {
    const rows = navActions().map((a) => ({ ...a, sub: '' }));
    rows.push({
      label: `Toggle theme (now ${themeNow})`,
      sub: '',
      run: () => {
        themeNow = toggleTheme();
      },
    });
    return { header: 'Actions', items: scoredItems(q, rows) };
  }

  async function fetchMatches(q) {
    const rows = (await listMatches(q, 'extracted_at', true)) || [];
    return scoredItems(
      q,
      rows.map((m) => ({
        label: `${m.map || 'unknown map'} · ${m.scoreCT}–${m.scoreT}`,
        sub: `#${m.id} · ${fmtDate(m.extractedAt)}`,
        run: () => nav(`/match/${m.id}`),
      })),
    );
  }

  async function fetchPlayers(q) {
    const rows = (await listPlayers(q)) || [];
    return scoredItems(
      q,
      rows.map((p) => ({
        label: p.name || p.steamId,
        sub: `${p.matches} matches · last seen ${p.lastSeen || '—'}`,
        run: () => nav(`/player/${p.steamId}`),
      })),
    );
  }

  async function fetchFilters(q) {
    const rows = (await listSavedFilters()) || [];
    return scoredItems(
      q,
      rows.map((s) => ({
        label: s.name,
        sub: `${s.scope} filter`,
        run: async () => {
          let f = {};
          try {
            f = JSON.parse(s.filterJson || '{}');
          } catch {
            f = {};
          }
          let mid = Number(f.matchId) || 0;
          if (!mid) {
            try {
              const ms = (await listMatches('', 'extracted_at', true)) || [];
              mid = (ms[0] && ms[0].id) || 0;
            } catch {
              mid = 0;
            }
          }
          if (!mid) {
            nav('/library');
            return;
          }
          setPendingTimelineFilter(f);
          nav(`/match/${mid}/timeline`);
        },
      })),
    );
  }

  async function fetchMetrics(q) {
    const rows = (await listMetrics()) || [];
    return scoredItems(
      q,
      rows.map((m) => ({
        label: m.title || m.name,
        sub: `${m.groupBy ? 'by ' + m.groupBy : 'ungrouped'} · ${m.origin || 'builtin'} · ${m.expr}`,
        run: () => nav('/builder'),
      })),
    );
  }

  async function fetchQueries(q) {
    const rows = (await listSavedQueries()) || [];
    return scoredItems(
      q,
      rows.map((s) => ({
        label: s.name,
        sub: 'saved SQL query',
        // SqlConsole has no cross-view loader contract yet — navigate only.
        run: () => nav('/sql'),
      })),
    );
  }
</script>

<Dialog open={open} backClass="top" label="Command palette" onClose={close}>
  <input
    class="input cp-input"
    bind:this={inputEl}
    bind:value={query}
    placeholder="Type a command or search…"
    aria-label="Command palette search"
  />
  <div class="cp-body">
    {#each sections as s (s.header)}
      <div class="cp-section">{s.header}</div>
      {#each s.items as it, i (it)}
        {@const gi = flat.indexOf(it)}
        <button
          class="cp-item"
          class:active={gi === active}
          id={'cp-item-' + gi}
          type="button"
          onmouseenter={() => (active = gi)}
          onclick={() => pick(gi)}
        >
          <span class="cp-label">
            {#each segs(it.label, it.hl) as seg, j (j)}
              {#if seg.on}<strong class="cp-hl">{seg.text}</strong>{:else}{seg.text}{/if}
            {/each}
          </span>
          {#if it.sub}<span class="cp-sub muted">{it.sub}</span>{/if}
        </button>
      {/each}
    {/each}
    {#if loading}
      <div class="cp-empty muted" role="status">Searching…</div>
    {:else if query.trim() && flat.length === 0}
      <div class="cp-empty muted" role="status">No results for “{query.trim()}”.</div>
    {/if}
  </div>
  <div class="cp-foot muted">
    <span><span class="codicon codicon-arrow-up"></span><span class="codicon codicon-arrow-down"></span> move</span><span>Enter run</span><span>Esc close</span>
    <span class="spacer"></span>
    <span>Ctrl/⌘K toggle</span>
  </div>
</Dialog>
