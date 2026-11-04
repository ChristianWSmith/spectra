<script>
  // M4 voice density lanes: index-only per-player bucket bars on a slim
  // strip (they ride above the transport in Replay — the canonical event
  // browser's home) — no decode, one fetch per mount. Click anywhere on
  // the strip → map x to a tick → onSeek(tick), which Replay turns into
  // an in-place seek with voice enabled.
  import { getVoiceLanes, getScoreboard } from '../services.js';
  import ProfileLink from './ProfileLink.svelte';

  let { matchId = 0, fromTick = 0, toTick = 0, nav = () => {}, onSeek = () => {} } = $props();

  const BUCKETS = 180;

  let lanes = $state(null); // VoiceLanesResult
  let teams = $state(new Map()); // steamId → side ('ct' | 't' | '')
  let names = $state(new Map()); // steamId → scoreboard name
  let error = $state('');
  let loading = $state(true);
  let stripEl = $state(null);

  $effect(() => {
    const mid = matchId;
    let live = true; // reset per run — a matchId change re-arms it
    Promise.all([
      getVoiceLanes(mid, BUCKETS),
      // Team colors / names come from the scoreboard; a failure only costs
      // the colorizing — lanes still render with raw steamIds.
      getScoreboard(mid, 'kills', false).catch(() => []),
    ])
      .then(([l, sb]) => {
        if (!live) return;
        lanes = l;
        const t = new Map();
        const n = new Map();
        for (const p of sb || []) {
          t.set(p.steamId, p.side || '');
          n.set(p.steamId, p.name || '');
        }
        teams = t;
        names = n;
        loading = false;
      })
      .catch((e) => {
        if (!live) return;
        error = e == null ? 'unknown error' : typeof e === 'string' ? e : e.message || String(e);
        loading = false;
      });
    return () => (live = false);
  });

  // Per-row normalized bars: height = count / row-max (max1), empty
  // buckets render at 0 height (blank). Zero buckets use the class
  // `zero`, NOT `empty`: the global .empty empty-state rule
  // (style.css padding: 40px 20px) would force a 40px floor on each
  // zero bucket and blow the bars wide past the card.
  const rows = $derived.by(() => {
    if (!lanes || !lanes.players || !lanes.players.length) return [];
    return lanes.players.map((p) => {
      let max = 0;
      for (const c of p.counts) if (c > max) max = c;
      const full = names.get(p.steamId) || p.steamId;
      return {
        steamId: p.steamId,
        label: full.length > 12 ? full.slice(0, 11) + '…' : full,
        side: teams.get(p.steamId) || '',
        counts: p.counts,
        max: max || 1,
      };
    });
  });

  const t0 = $derived(lanes ? lanes.fromTick : fromTick);
  const t1 = $derived(lanes ? lanes.toTick : toTick);

  function seekFromX(e) {
    // A click on the lane's profile link belongs to the link, not to the
    // strip (the whole strip is click-to-seek — target guard, since a
    // delegated child stopPropagation is not reliable here).
    if (e.target instanceof Element && e.target.closest('button, a, input')) return;
    const el = stripEl;
    if (!el || t1 <= t0) return;
    // Map against the BARS column, not the whole strip — the left-hand
    // name labels would otherwise skew the tick math.
    const bars = el.querySelector('.voice-lane-bars');
    const rect = bars ? bars.getBoundingClientRect() : el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    onSeek(Math.round(t0 + frac * (t1 - t0)));
  }

  function onKeydown(e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    // Keyboard fallback: middle of the strip.
    const el = stripEl;
    if (!el || t1 <= t0) return;
    onSeek(Math.round((t0 + t1) / 2));
  }
</script>

{#if loading}
  <p class="muted voice-lanes-loading" role="status">Loading voice lanes…</p>
{:else if error}
  <p class="error" role="alert">Voice lanes unavailable: {error}</p>
{:else if rows.length === 0}
  <p class="muted voice-lanes-loading" role="status">No voice activity.</p>
{:else}
  <div class="voice-lanes" aria-label="Voice activity per player">
    <div class="voice-lanes-head">
      <span class="voice-lanes-title"><span class="codicon codicon-unmute"></span> Voice</span>
      <span class="muted num">{rows.length} players · click to play from there</span>
    </div>
    <div
      class="voice-lanes-strip"
      bind:this={stripEl}
      role="slider"
      tabindex="0"
      aria-label="Voice lanes — seek replay to click position"
      aria-valuemin={t0}
      aria-valuemax={t1}
      aria-valuenow={t0}
      onclick={seekFromX}
      onkeydown={onKeydown}
    >
      {#each rows as row (row.steamId)}
        <div class="voice-lane-row">
          <span class="voice-lane-label">
            <ProfileLink
              steam={row.steamId}
              name={row.label}
              {nav}
              cls={row.side ? `side-${row.side}` : ''}
              title="{row.steamId} — open profile"
            />
          </span>
          <span class="voice-lane-bars">
            {#each row.counts as c, i (i)}
              <span
                class="voice-lane-bar side-{row.side}"
                class:zero={c === 0}
                style="height:{row.max ? Math.max(c === 0 ? 0 : 12, (c / row.max) * 100) : 0}%"
                title={c ? `${c} chunks` : ''}
              ></span>
            {/each}
          </span>
        </div>
      {/each}
    </div>
  </div>
{/if}
