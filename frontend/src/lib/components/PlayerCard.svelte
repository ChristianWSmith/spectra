<script>
  // PlayerCard — ONE player's live card beside the replay render area:
  // name (+ the voice live dot), HP + bar with the armor/helmet chip at
  // the row's right edge, the equipped weapon with mag/reserve ammo on
  // its own line, unspent money, utility (+ the C4 when this player
  // carries the bomb) and the live K/D/A + ADR row — tinted by the
  // player's CURRENT side, ringed by the player's TEAMMATE COLOR, with a
  // per-player voice mute. TeamColumn stacks five of these under one team
  // name; the caller (Replay) owns all data and all fetching.
  //
  // Prop contract — everything is PRE-COMPUTED, this component never
  // fetches and never guesses a missing value:
  //   player      {steamId, name} roster identity; `name` is displayed
  //               (steamId is the title fallback for a nameless row)
  //   side        'ct' | 't' | '' — the side the player is on AT THE
  //               PLAYHEAD (halftime swaps change it) → card tint +
  //               accent; '' = unknown → neutral card, no guessed color
  //   playerColor hex or null — the player's CS2 teammate color
  //               (playercolor.colorHexOf of meta.players[].color). The
  //               color ring is drawn only when set; null means the
  //               sidecar never said (old sidecar / no color) → no ring,
  //               never a guessed one
  //   speaking    talking right now (voiceindex.speakingAt) → the red
  //               live dot beside the name (a recording indicator).
  //               Voice activity never draws a ring — the player-color
  //               box-shadow is the card's ONLY outline.
  //   muted       voice muted (replay/audio setMuted) → mute button state
  //   alive/dead  either may be passed; dead wins → dimmed card + DEAD
  //               marker. `alive: null` = the data never said (unknown):
  //               the card renders as a plain card, never DEAD.
  //               marker while the last-known values stay visible
  //   follow      camera follows this player → marker icon
  //   state       slotStateAt(...) object or null — null means this
  //               replay has NO state stream (pre-state import): every
  //               value renders "—", never a zero presented as a fact
  //   stats       {k, d, a, adr} from replay/livestats.js at the
  //               playhead, or null before the fold runs → the stats row
  //               renders "—", never a fabricated 0 (adr null = no
  //               counted round started yet → "—")
  //   icons       preloadIcons(...) Map<name, HTMLImageElement|null>
  //   iconURLs    manifest URLs ({name: url}, icons.js iconURL); either
  //               may be null — iconURLs wins, then icons' image src; a
  //               miss renders the mandatory text fallback
  //   onToggleMute()  mute button click (caller flips audio + `muted`)
  //
  // Per-frame values are $derived (the playhead re-renders ~60×/s); the
  // card itself does no work beyond reading props. Every row has a FIXED
  // height in the CSS below — nothing (DEAD chip, a wrapping grenade row,
  // the stats row) may resize the card while it plays.
  import {
    ammoText,
    armorChip,
    carriesC4,
    hpBand,
    hpPct,
    moneyText,
    STATS_TITLE,
    statsText,
    utilityOf,
    weaponName as weaponNameOf,
  } from '../replay/playercard.js';

  let {
    player = {},
    side = '',
    playerColor = null,
    speaking = false,
    muted = false,
    alive = true,
    dead = false,
    follow = false,
    state = null,
    stats = null,
    icons = null,
    iconURLs = null,
    onToggleMute = () => {},
  } = $props();

  // Display name: roster name, else the steam id (a nameless row still
  // identifies its player), else the honest placeholder.
  const name = $derived(player?.name || player?.steamId || '—');
  const hasState = $derived(state != null);
  const isDead = $derived(!!dead || alive === false);

  const hp = $derived(state ? state.hp : null);
  const pct = $derived(hpPct(hp));
  const band = $derived(hpBand(hp));
  const armor = $derived(state ? state.armor : null);
  const chip = $derived(armorChip(state));
  const weapon = $derived(weaponNameOf(state));
  const ammo = $derived(weapon ? ammoText(state) : '—');
  const money = $derived(moneyText(state));
  const util = $derived(utilityOf(state ? state.inventory : null));
  // The bomb is checked INDEPENDENTLY of utilityOf (which deliberately
  // drops 'C4'): carrying it is a fact of its own, shown beside the util.
  const hasC4 = $derived(carriesC4(state ? state.inventory : null));
  const statsLine = $derived(statsText(stats));

  // iconSrc resolves a canonical equipment name to an <img> source —
  // manifest URLs first, else the src of a preloaded image; null means
  // "no icon" and the text fallback renders instead (never a broken
  // image). Reads props, so the template stays reactive to a late icon
  // extraction.
  function iconSrc(n) {
    if (iconURLs && iconURLs[n]) return iconURLs[n];
    if (icons instanceof Map) {
      const img = icons.get(n);
      if (img && img.src) return img.src;
    }
    return null;
  }

  const armorIconSrc = $derived(chip.icon ? iconSrc(chip.icon) : null);
  const weaponIconSrc = $derived(weapon ? iconSrc(weapon) : null);

  // Tooltips carry the full semantics the compact cells truncate.
  const hpTitle = $derived(hp == null ? 'Health unknown' : `Health ${hp}`);
  const armorTitle = $derived.by(() => {
    const v = armor == null ? 'unknown' : armor;
    const h = state ? state.helmet : null;
    const hs = h === true ? 'helmet on' : h === false ? 'no helmet' : 'helmet unknown';
    return `Armor ${v} · ${hs}`;
  });
  const weaponTitle = $derived(
    weapon ? `${weapon} — ${ammo}` : 'Weapon unknown',
  );
  const utilTitle = $derived(
    util == null ? 'Utility unknown' : util.length ? 'Utility carried' : 'No utility',
  );
</script>

<div
  class="pc-card"
  class:pc-ct={side === 'ct'}
  class:pc-t={side === 't'}
  class:pc-dead={isDead}
  class:pc-follow={follow}
  class:pc-color={!!playerColor}
  style:--pc-color={playerColor || null}
  title={hasState ? undefined : 'No player state for this match'}
>
  <div class="pc-head">
    <span class="pc-name" title={name}>{name}</span>
    {#if speaking}
      <!-- Voice activity as a recording dot — pure paint, sized under
           the head's fixed height so it can never move the row. -->
      <span class="pc-live" aria-hidden="true"></span>
    {/if}
    {#if follow}
      <span class="pc-mark codicon codicon-person-follow" title="Camera follows this player" aria-hidden="true"></span>
    {/if}
    {#if isDead}
      <span class="chip bad pc-dead-mark" title="Dead — showing last-known state">DEAD</span>
    {:else if !hasState}
      <span class="pc-nostate" title="This replay has no player state stream">no state</span>
    {/if}
    <button
      type="button"
      class="btn small ghost pc-mute"
      class:warn={muted}
      aria-pressed={muted}
      aria-label="Mute {name}"
      title={muted ? `Unmute ${name}'s voice` : `Mute ${name}'s voice`}
      onclick={onToggleMute}
    ><span class="codicon {muted ? 'codicon-mute' : 'codicon-unmute'}" aria-hidden="true"></span></button>
  </div>

  <div class="pc-hp-row">
    <span class="pc-num pc-hp" class:pc-unknown={band === 'unknown'} title={hpTitle}>{hp ?? '—'}</span>
    <span class="pc-bar" class:pc-unknown={band === 'unknown'} aria-hidden="true">
      {#if pct != null}<span class="pc-bar-fill pc-fill-{band}" style="width: {pct}%"></span>{/if}
    </span>
    <!-- The armor/helmet chip rides the far RIGHT of the HP row: the bar
         keeps its flex and the chip's auto margin pins it to the row's
         right edge. -->
    <span class="pc-chip pc-armor" title={armorTitle}>
      {#if armorIconSrc}
        <img class="pc-ico" src={armorIconSrc} alt={chip.text} />
      {:else}
        <span class="pc-fallback">{chip.text}</span>
      {/if}
      <span class="pc-num pc-armor-val">{armor ?? '—'}</span>
    </span>
  </div>

  <!-- The equipped weapon on its OWN fixed-height line: icon, name
       (ellipsized inside the row) and mag/reserve ammo. -->
  <div class="pc-weapon-row">
    <span class="pc-chip pc-weapon" title={weaponTitle}>
      {#if weaponIconSrc}
        <img class="pc-ico" src={weaponIconSrc} alt="" />
      {/if}
      <span class="pc-wname">{weapon ?? '—'}</span>
      <span class="pc-num pc-ammo">{ammo}</span>
    </span>
  </div>

  <div class="pc-econ">
    <span class="pc-num pc-money" title="Unspent money">{money}</span>
    <span class="pc-util" title={utilTitle}>
      {#if util == null}
        <span class="pc-fallback">—</span>
      {:else if util.length === 0}
        <!-- pc-none marks KNOWN-empty (vs the unknown "—" above) — the
             shared title carries the same distinction for readers. -->
        <span class="pc-fallback pc-none">—</span>
      {:else}
        {#each util as u (u.name)}
          <span class="pc-nade" title={u.count > 1 ? `${u.name} ×${u.count}` : u.name}>
            {#if iconSrc(u.name)}
              <img class="pc-ico" src={iconSrc(u.name)} alt={u.name} />
            {:else}
              <span class="pc-fallback">{u.name}</span>
            {/if}
            {#if u.count > 1}<span class="pc-count">×{u.count}</span>{/if}
          </span>
        {/each}
      {/if}
    </span>
    <!-- The bomb rides beside the util (checked separately — utilityOf
         deliberately excludes 'C4', see carriesC4). -->
    {#if hasC4}
      <span class="pc-c4" title="C4 bomb">
        {#if iconSrc('C4')}
          <img class="pc-ico" src={iconSrc('C4')} alt="C4" />
        {:else}
          <span class="pc-fallback">C4</span>
        {/if}
      </span>
    {/if}
  </div>

  <!-- Live K/D/A + ADR at the playhead (replay/livestats.js) — a FIXED
       height row, so its values ticking never moves the stack. -->
  <div class="pc-stats" title={STATS_TITLE}>{statsLine}</div>
</div>

<style>
  /* pc- = PlayerCard's one prefix (AGENTS.md CSS rule). Side coding comes
     from the shared --ct/--t vars — never a hex literal — so the light
     theme's overrides follow automatically; the tint mixes that side
     over the panel at a low share so text keeps its contrast. */
  .pc-ct {
    --pc-side: var(--ct);
  }
  .pc-t {
    --pc-side: var(--t);
  }

  .pc-card {
    position: relative;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    padding: 4px 6px 5px;
    font-size: 0.86em;
    line-height: 1.3;
    background: color-mix(in srgb, var(--pc-side, var(--panel)) 14%, var(--panel));
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }

  /* --- Fixed-height rows (no card may ever resize) ----------------------
     Every row below carries an explicit height + overflow:hidden, sized
     for the TALLEST state it can show, so nothing that mounts, unmounts
     or wraps mid-playback can move the stack: the DEAD chip (taller than
     the mute button), the "no state"/follow markers, a wrapping
     grenade row, the ticking stats row. Heights are em-of-card (the card
     is 0.86em of the app font) so the font-size setting scales them;
     values are padded for the chip/button's px borders at every setting.
     Exception: .pc-econ's two-line wrap reserve is px, because its driver
     (the 15px util icons) is px — see the rule below.
     Rings (box-shadow) stay paint on .pc-card — never layout. */

  /* Spec 21/26 — the card's ONE ring: the teammate-color ring hugs the
     card (box-shadow 0–2px) behind a dark casing so pale colors
     (#ECDF41) still read on the light theme's near-white panel. Pure
     paint (box-shadow never enters layout), and it only appears for a
     KNOWN player color (playerColor) — an unknown color draws nothing
     rather than a guessed ring. The SIDE is read from the tinted
     background alone (pc-ct/pc-t) — never from a left-edge strip — and
     voice activity is the live dot in the head — never a second ring.
     There is deliberately NO speaking outline: the player's own color
     is the only outline a card wears. */
  .pc-card.pc-color {
    box-shadow: 0 0 0 2px var(--pc-color), 0 0 0 3px rgba(0, 0, 0, 0.55);
  }

  /* Voice activity — a recording-style dot right after the name. Sized
     (7px) well under the head's fixed height and flex:none, so it can
     never squeeze the name or move the row; the pulse animates opacity
     only (paint, never layout) and is dropped entirely for users who
     asked for reduced motion. */
  .pc-live {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--danger);
    animation: pc-live-pulse 1.6s ease-in-out infinite;
  }

  @keyframes pc-live-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.45;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .pc-live {
      animation: none;
    }
  }

  /* Dead reads as dead without hiding the last-known values. */
  .pc-dead {
    opacity: 0.72;
  }

  /* The head's STATUS SLOT is its height: reserved for the tallest state
     it can mount (the DEAD chip ≈ 1.55em + its 4px border/padding) so the
     DEAD badge, the "no state" text, the follow marker and the 7px live
     dot appearing or disappearing can never grow the row — the card must
     not jitter. */
  .pc-head {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    height: calc(1.6em + 4px);
    overflow: hidden;
  }

  .pc-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
  }

  .pc-mark {
    flex: none;
    font-size: 0.9em;
    color: var(--muted);
  }

  .pc-dead-mark {
    flex: none;
  }

  .pc-nostate {
    flex: none;
    font-size: 0.72em;
    color: var(--muted);
    font-style: italic;
  }

  .pc-mute {
    flex: none;
    padding: 0 4px;
    line-height: 1;
  }

  /* Tabular numerals everywhere a value ticks per frame, and fixed
     minimum widths, so a 3-digit → 2-digit change never shifts the
     rows beside it. */
  .pc-num {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }

  .pc-hp-row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    /* One line of value + the 5px bar + the armor chip (15px icon) —
       fixed so a 3-digit → 2-digit change (or the unknown hatched
       track) never moves the rows. */
    height: 1.5em;
    overflow: hidden;
  }

  .pc-hp {
    min-width: 3ch;
    text-align: right;
  }

  /* The armor/helmet chip rides the far RIGHT of the HP row: the bar
     keeps its flex (it fills the middle) and the chip's auto margin
     pins it to the row's right edge at any column width. */
  .pc-armor {
    flex: none;
    margin-left: auto;
  }

  .pc-bar {
    flex: 1 1 auto;
    min-width: 24px;
    height: 5px;
    border-radius: 3px;
    background: var(--inset);
    overflow: hidden;
  }

  /* Unknown HP: a hatched "no data" track — an empty track would read
     as 0 HP, which the stream never said. */
  .pc-bar.pc-unknown {
    background:
      repeating-linear-gradient(135deg, var(--divider) 0 3px, transparent 3px 6px),
      var(--inset);
  }

  .pc-unknown {
    color: var(--muted);
  }

  /* No transition: the playhead updates these every frame, a tween would
     only smear the readout. */
  .pc-bar-fill {
    display: block;
    height: 100%;
  }

  .pc-fill-high {
    background: var(--success);
  }

  .pc-fill-mid {
    background: var(--accent);
  }

  .pc-fill-low {
    background: var(--danger);
  }

  /* The equipped weapon's OWN fixed-height line (icon + name + ammo).
     The name ellipsizes inside the row and the ammo keeps its 9ch
     floor, so a longer weapon name can never wrap a second line or
     resize the card. */
  .pc-weapon-row {
    display: flex;
    align-items: center;
    min-width: 0;
    height: 1.5em;
    overflow: hidden;
  }

  .pc-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }

  .pc-ico {
    width: 15px;
    height: 15px;
    object-fit: contain;
    flex: none;
  }

  /* The mandatory text fallback: full canonical label, slightly smaller
     than the numbers, readable when no image exists. */
  .pc-fallback {
    font-size: 0.82em;
    white-space: nowrap;
  }

  .pc-armor-val {
    min-width: 3ch;
    text-align: right;
  }

  .pc-weapon {
    flex: 1 1 auto;
    min-width: 0;
  }

  .pc-wname {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* 9ch reserves the widest real pair ("150 / 200") so a magazine drop
     never reflows the row; the weapon name absorbs the slack. */
  .pc-ammo {
    min-width: 9ch;
    margin-left: auto;
    text-align: right;
  }

  .pc-econ {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    /* The util's TRUE maximum content height — the tightest reserve
       that still holds the never-resize / never-clip invariant: TWO
       wrapped icon lines = 2 × 15px (.pc-ico) + the 2px row-gap of
       .pc-util = 32px. It is px, not em, on purpose: the icons are
       fixed px so the max does not scale — and 32px still covers the
       taller one-line text at the 17px root setting (1.3 × 0.86 × 17
       ≈ 19px). The old `3em` was a loose estimate (33.5 / 38.7 /
       43.9px at the 13 / 15 / 17px root): with util on ONE line — the
       common case — that slack showed as fat margins above and below
       this row compared with its 1.5em neighbours. Now a wrapped
       two-line util fits with zero slack, a one-line util centres in
       the row, and the height never changes: grenades bought or thrown
       mid-playback can neither resize the card nor be clipped. A
       guaranteed single line would be tighter still but cannot be
       PROVEN to fit — money 7ch + C4 + five nade icons + count badges
       ≈ 184px > the card's ~165–180px content box — so the wrap stays
       reserved. */
    height: calc(2 * 15px + 2px);
    overflow: hidden;
  }

  /* 7ch reserves the account ceiling ("$16,000") — same no-reflow rule. */
  .pc-money {
    min-width: 7ch;
  }

  .pc-util {
    display: inline-flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 2px 5px;
    margin-left: auto;
    min-width: 0;
  }

  /* The carried bomb — a fixed-size cell beside the util so mounting it
     shifts nothing. */
  .pc-c4 {
    display: inline-flex;
    align-items: center;
    flex: none;
  }

  .pc-nade {
    display: inline-flex;
    align-items: center;
    gap: 1px;
  }

  .pc-count {
    font-size: 0.72em;
    font-variant-numeric: tabular-nums;
    color: var(--muted);
  }

  /* Live K/D/A + ADR at the playhead (replay/livestats.js, folded by
     Replay): ONE fixed line with tabular figures — the numbers tick at
     ~60×/s but the row's height never changes; a too-long line ellipsizes
     INSIDE the box instead of wrapping out of it. */
  .pc-stats {
    height: 1.4em;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 0.86em;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
</style>
