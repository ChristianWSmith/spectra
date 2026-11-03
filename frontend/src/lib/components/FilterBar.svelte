<script>
  // FilterBar — composable advanced event filter for Timeline.
  //
  // Props:
  //   filter   — {kind, steamId, round, weapon, tickFrom, tickTo, dmgMin,
  //               dmgMax, distanceMax, headshotOnly, bbox:{minX,minY,maxX,maxY}}
  //   onchange — called with a fresh normalized copy of the whole filter
  //              object on every control commit (parent replaces its state,
  //              which drives the refetch).
  //   id       — match id (> 0 loads the round/player options and the
  //              scoreboard's killsByWeapon union for the weapon select).
  import { getRounds, getScoreboard } from '../services.js';
  import { isCounted } from '../rounds.js';
  import { LANDMARK_KINDS } from '../replay/landmarks.js';

  let { filter = {}, onchange = () => {}, id = 0 } = $props();

  // The kind list lives in lib/replay/landmarks.js — the one mirror of
  // models.EventKind (Go side), shared with the replay surfaces.
  const KINDS = LANDMARK_KINDS;

  // Fallback weapon list — the live union of scoreboard killsByWeapon keys
  // is merged on top (see weapons below).
  const COMMON_WEAPONS = [
    'ak47',
    'aug',
    'awp',
    'bizon',
    'cz75_a1',
    'deagle',
    'decoy',
    'famas',
    'fiveseven',
    'flashbang',
    'glock18',
    'hegrenade',
    'hkp2000',
    'incendiary',
    'knife',
    'm249',
    'm4a1',
    'm4a4',
    'mac10',
    'mag7',
    'molotov',
    'mp5sd',
    'mp9',
    'negev',
    'nova',
    'p250',
    'p90',
    'revolver',
    'sawedoff',
    'sg556',
    'smokegrenade',
    'tec9',
    'taser',
    'ump45',
    'usp_silencer',
    'xm1014',
  ];

  const DEFAULTS = {
    round: -1, // -1 = all rounds (0 would mean round zero!)
    kind: '',
    steamId: '',
    weapon: '',
    tickFrom: 0, // 0/"" = unconstrained (Go: <= 0 open-ended on tickTo)
    tickTo: 0,
    dmgMin: 0,
    dmgMax: 0,
    distanceMax: 0,
    headshotOnly: false,
    bbox: null,
  };

  // Seed from the prop once; the $effect below re-syncs on every parent
  // replacement (wrapped in a function so the init is not a "local read"
  // of the prop — Svelte would warn state_referenced_locally).
  function seedFilter() {
    return normalize(filter);
  }

  let f = $state(seedFilter());
  let rounds = $state([]);
  let players = $state([]);

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  // Coerce anything the parent hands us (pending-filter hand-off, saved
  // preset JSON, partial objects) into a complete filter.
  function normalize(src) {
    const s = src || {};
    return {
      round: typeof s.round === 'number' ? s.round : DEFAULTS.round,
      kind: s.kind || '',
      steamId: s.steamId || '',
      weapon: s.weapon || '',
      tickFrom: num(s.tickFrom),
      tickTo: num(s.tickTo),
      dmgMin: num(s.dmgMin),
      dmgMax: num(s.dmgMax),
      distanceMax: num(s.distanceMax),
      headshotOnly: !!s.headshotOnly,
      bbox: s.bbox || null,
    };
  }

  // Re-seed from the prop whenever the parent replaces the object (pending
  // filter, saved preset apply, Reset echo). We never mutate the prop —
  // every commit emits a fresh copy.
  $effect(() => {
    f = normalize(filter);
  });

  $effect(() => {
    if (!id) {
      rounds = [];
      return;
    }
    let live = true;
    getRounds(id)
      .then((r) => {
        if (live) rounds = r || [];
      })
      .catch(() => {});
    return () => (live = false);
  });

  $effect(() => {
    if (!id) {
      players = [];
      return;
    }
    let live = true;
    getScoreboard(id, 'kills', true)
      .then((sb) => {
        if (live) players = sb || [];
      })
      .catch(() => {});
    return () => (live = false);
  });

  function weaponKeys(json) {
    if (!json) return [];
    try {
      const o = JSON.parse(json);
      return o && typeof o === 'object' ? Object.keys(o) : [];
    } catch {
      return [];
    }
  }

  // Weapon options: common list ∪ every killsByWeapon key seen in the
  // scoreboard for this match (∪ the current selection, so a pending
  // filter never renders an orphaned value).
  const weapons = $derived.by(() => {
    const set = new Set(COMMON_WEAPONS);
    for (const p of players) {
      for (const w of weaponKeys(p.killsByWeapon)) set.add(w);
    }
    if (f.weapon) set.add(f.weapon);
    return [...set].sort((a, b) => a.localeCompare(b));
  });

  function commit() {
    onchange({ ...f });
  }

  function set(key, value) {
    f[key] = value;
    commit();
  }

  function onNum(key, e) {
    set(key, num(e.currentTarget.value));
  }

  function reset() {
    f = normalize(null);
    commit();
  }

  function clearBbox() {
    f.bbox = null;
    commit();
  }
</script>

<div class="toolbar filt-bar" role="group" aria-label="Event filters">
  <label class="filt-grp" for="filt-round">
    Round
    <select class="input" id="filt-round" value={f.round} onchange={(e) => set('round', Number(e.currentTarget.value))}>
      <option value={-1}>All</option>
      <!-- Counted rounds only (lib/rounds.js): knife/warmup rounds are
           numbered negatively, and -1 is this filter's "all rounds"
           sentinel. -->
      {#each rounds.filter(isCounted) as r (r.number)}
        <option value={r.number}>R{r.number}</option>
      {/each}
    </select>
  </label>

  <label class="filt-grp" for="filt-kind">
    Kind
    <select class="input" id="filt-kind" value={f.kind} onchange={(e) => set('kind', e.currentTarget.value)}>
      <option value="">All</option>
      {#each KINDS as k (k)}
        <option value={k}>{k}</option>
      {/each}
    </select>
  </label>

  <label class="filt-grp" for="filt-player">
    Player
    <select class="input" id="filt-player" value={f.steamId} onchange={(e) => set('steamId', e.currentTarget.value)}>
      <option value="">All</option>
      {#each players as p (p.steamId)}
        <option value={p.steamId}>{p.name}</option>
      {/each}
    </select>
  </label>

  <label class="filt-grp" for="filt-weapon">
    Weapon
    <select class="input" id="filt-weapon" value={f.weapon} onchange={(e) => set('weapon', e.currentTarget.value)}>
      <option value="">All</option>
      {#each weapons as w (w)}
        <option value={w}>{w}</option>
      {/each}
    </select>
  </label>

  <span class="filt-grp">
    Tick
    <input
      class="input filt-num"
      type="number"
      min="0"
      placeholder="from"
      aria-label="From tick"
      value={f.tickFrom || ''}
      onchange={(e) => onNum('tickFrom', e)}
    />
    <span class="filt-sep">–</span>
    <input
      class="input filt-num"
      type="number"
      min="0"
      placeholder="to"
      aria-label="To tick"
      value={f.tickTo || ''}
      onchange={(e) => onNum('tickTo', e)}
    />
  </span>

  <span class="filt-grp">
    Dmg
    <input
      class="input filt-num"
      type="number"
      min="0"
      aria-label="Minimum damage"
      value={f.dmgMin || ''}
      onchange={(e) => onNum('dmgMin', e)}
    />
    <span class="filt-sep">–</span>
    <input
      class="input filt-num"
      type="number"
      min="0"
      aria-label="Maximum damage"
      value={f.dmgMax || ''}
      onchange={(e) => onNum('dmgMax', e)}
    />
  </span>

  <label class="filt-grp" for="filt-dist">
    Dist ≤
    <input
      class="input filt-num"
      id="filt-dist"
      type="number"
      min="0"
      aria-label="Maximum distance"
      value={f.distanceMax || ''}
      onchange={(e) => onNum('distanceMax', e)}
    />
  </label>

  <label class="filt-check">
    <input
      type="checkbox"
      checked={f.headshotOnly}
      onchange={(e) => set('headshotOnly', e.currentTarget.checked)}
    />
    Headshots only
  </label>

  {#if f.bbox}
    <span
      class="chip filt-bbox"
      title="Position filter: x {Math.round(f.bbox.minX)}…{Math.round(f.bbox.maxX)}, y {Math.round(f.bbox.minY)}…{Math.round(f.bbox.maxY)} (world units)"
    >
      bbox {Math.round(f.bbox.minX)},{Math.round(f.bbox.minY)}–{Math.round(f.bbox.maxX)},{Math.round(f.bbox.maxY)}
      <button
        class="filt-x"
        aria-label="Clear position filter"
        onclick={clearBbox}
      ><span class="codicon codicon-close"></span></button>
    </span>
  {/if}

  <button class="btn" onclick={reset}>Reset</button>
</div>
