<script>
  // FilterBar — composable advanced event filter for the Replay
  // landmark feed: event categories are the feed's filter model (there is
  // no kind select here) — see lib/replay/landmarks.js CATEGORIES.
  //
  // Props:
  //   filter   — {roundFrom, roundTo, steamId, weapon, distMin, distMax,
  //               headshotOnly, bbox:{minX,minY,maxX,maxY}}
  //              (the typed/scope subset — cats/gname live on the parent).
  //              The round and distance bounds are INCLUSIVE and PARTIAL:
  //              empty/0 = open on that side (min only = no max and vice
  //              versa; round 0 never exists, so 0 is the "unset" bound).
  //   onchange — called with a fresh normalized copy of the whole filter
  //              object on every control commit (parent replaces its state,
  //              which drives the refetch).
  //   id       — match id (> 0 loads the scoreboard's killsByWeapon union
  //              for the weapon select).
  //   showReset — false hides the local Reset (the parent owns a full
  //              reset that also clears the category selection).
  import { getScoreboard } from '../services.js';

  let { filter = {}, onchange = () => {}, id = 0, showReset = true } = $props();

  // Fallback weapon list — the canonical demoinfocs
  // EquipmentType.String() spellings, i.e. EXACTLY what events.weapon
  // stores (the same vocabulary internal/mappack/icons.go iconTable is
  // pinned to — TestIconTableCanonicalNames — and what
  // player_stats.kills_by_weapon keys use). The live union of the
  // scoreboard's killsByWeapon keys merges on top (weapons below); the
  // Set keeps every weapon listed ONCE under its display name. The old
  // list here spelled the CSGO-Go internal names (deagle, ak47, …),
  // which never match events.weapon — they only ever appeared as a
  // dead duplicate beside the display name from the scoreboard.
  const COMMON_WEAPONS = [
    // Pistols
    'P2000',
    'Glock-18',
    'P250',
    'Desert Eagle',
    'Five-SeveN',
    'Dual Berettas',
    'Tec-9',
    'CZ75 Auto',
    'USP-S',
    'R8 Revolver',
    // SMGs
    'MP7',
    'MP9',
    'PP-Bizon',
    'MAC-10',
    'UMP-45',
    'P90',
    'MP5-SD',
    // Heavy
    'Sawed-Off',
    'Nova',
    'MAG-7',
    'XM1014',
    'M249',
    'Negev',
    // Rifles
    'Galil AR',
    'FAMAS',
    'AK-47',
    'M4A4',
    'M4A1',
    'SSG 08',
    'SG 553',
    'AUG',
    'AWP',
    'SCAR-20',
    'G3SG1',
    // Equipment that lands in events.weapon (a C4 kill records "C4")
    'Zeus x27',
    'C4',
    'Knife',
    // Grenades
    'Decoy Grenade',
    'Molotov',
    'Incendiary Grenade',
    'Flashbang',
    'Smoke Grenade',
    'HE Grenade',
  ];

  const DEFAULTS = {
    roundFrom: 0, // 0 = open (round 0 never exists → 0 can only mean unset)
    roundTo: 0,
    steamId: '',
    weapon: '',
    distMin: 0, // 0/"" = unconstrained (either side of the range may be open)
    distMax: 0,
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
  let players = $state([]);

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  // Round bounds keep NEGATIVE values (knife/warmup rounds are real
  // rounds) and truncate to integers; empty/0/junk = unset.
  function roundNum(v) {
    const n = Math.trunc(Number(v));
    return Number.isFinite(n) && n !== 0 ? n : 0;
  }

  // Coerce anything the parent hands us (route query, saved preset JSON,
  // partial objects) into a complete filter.
  function normalize(src) {
    const s = src || {};
    return {
      roundFrom: roundNum(s.roundFrom),
      roundTo: roundNum(s.roundTo),
      steamId: s.steamId || s.player || '',
      weapon: s.weapon || '',
      distMin: num(s.distMin),
      distMax: num(s.distMax),
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

  // Weapon options: canonical list ∪ every killsByWeapon key seen in the
  // scoreboard for this match (∪ the current selection, so a pending
  // filter never renders an orphaned value) — deduped by the Set, so a
  // weapon appears ONCE under its display name no matter which source
  // supplied it.
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

  function onRound(key, e) {
    set(key, roundNum(e.currentTarget.value));
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
  <span class="filt-grp">
    Round
    <input
      class="input filt-num"
      id="filt-round-from"
      type="number"
      step="1"
      placeholder="from"
      aria-label="First round"
      value={f.roundFrom || ''}
      onchange={(e) => onRound('roundFrom', e)}
    />
    <span class="filt-sep">–</span>
    <input
      class="input filt-num"
      id="filt-round-to"
      type="number"
      step="1"
      placeholder="to"
      aria-label="Last round"
      value={f.roundTo || ''}
      onchange={(e) => onRound('roundTo', e)}
    />
  </span>

  <!-- Player and weapon each own a full row of the filter bar. -->
  <label class="filt-grp filt-line" for="filt-player">
    Player
    <select class="input" id="filt-player" value={f.steamId} onchange={(e) => set('steamId', e.currentTarget.value)}>
      <option value="">All</option>
      {#each players as p (p.steamId)}
        <option value={p.steamId}>{p.name}</option>
      {/each}
    </select>
  </label>

  <label class="filt-grp filt-line" for="filt-weapon">
    Weapon
    <select class="input" id="filt-weapon" value={f.weapon} onchange={(e) => set('weapon', e.currentTarget.value)}>
      <option value="">All</option>
      {#each weapons as w (w)}
        <option value={w}>{w}</option>
      {/each}
    </select>
  </label>

  <span class="filt-grp">
    Dist
    <input
      class="input filt-num"
      id="filt-dist-min"
      type="number"
      min="0"
      placeholder="min"
      aria-label="Minimum distance"
      value={f.distMin || ''}
      onchange={(e) => onNum('distMin', e)}
    />
    <span class="filt-sep">–</span>
    <input
      class="input filt-num"
      id="filt-dist-max"
      type="number"
      min="0"
      placeholder="max"
      aria-label="Maximum distance"
      value={f.distMax || ''}
      onchange={(e) => onNum('distMax', e)}
    />
  </span>

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

  {#if showReset}
    <button class="btn" onclick={reset}>Reset</button>
  {/if}
</div>
