<script>
  // PlayerCard — ONE player's live card beside the replay render area:
  // name (+ the voice live dot), HP + bar with the armor/helmet chip at
  // the row's right edge, the equipped weapon (icon + mag/reserve ammo —
  // no name text: the weapon's name rides the icon's title tooltip) on
  // its own line (or the held-item indicator: a knife/util/C4 in hand
  // shows its icon right AFTER the MAIN weapon's icon — see the three
  // modes in the weapon row below), unspent money, utility (+ the C4
  // when this player carries the bomb) and the live K/D/A + ADR row — tinted by the
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
  //   reloadProgress  0..1 reload-ring fill or null — precomputed by
  //               Replay through replay/playercard.js reloadProgress
  //               (the ONE formula); null = not reloading / unknown →
  //               the ring is not rendered at all (never a guessed arc)
  //   stats       {k, d, a, adr} from replay/livestats.js at the
  //               playhead, or null before the fold runs → the stats row
  //               renders "—", never a fabricated 0 (adr null = no
  //               counted round started yet → "—")
  //   icons       preloadIcons(...) Map<name, HTMLImageElement|null>
  //   iconURLs    manifest URLs ({name: url}, icons.js iconURL); either
  //               may be null — iconURLs wins, then icons' image src; a
  //               miss renders the mandatory text fallback
  //   kit         TRI-STATE defuse-kit possession at the playhead:
  //               true → the kit badge renders; false → the player is
  //               KNOWN not to hold one (no badge); null → unknown (no
  //               kit evidence loaded / not computed — never drawn as a
  //               fact, mirroring carriesC4's false-on-unknown doc in
  //               replay/playercard.js). Nothing passes it until the
  //               Replay wiring lands (stage 2) — the badge is inert
  //               until then, and it is NOT derived from `state`: the
  //               state stream carries no kit flag (it lives in the
  //               pawn's m_pItemServices, never in the inventory).
  //   onToggleMute()  mute button click (caller flips audio + `muted`)
  //   onFollow()      card click → the caller follows this player (the
  //                   follow/release toggle lives with the caller — the
  //                   component only reports the click). Guarded at the
  //                   ROOT: a click landing on an inner control (button /
  //                   a / input — today's mute button) never fires it
  //                   (the Match.svelte row idiom). No dead-gating: a
  //                   DEAD card stays clickable (follow-of-dead is
  //                   well-defined — the camera holds the last alive
  //                   position).
  //
  // Per-frame values are $derived (the playhead re-renders ~60×/s); the
  // card itself does no work beyond reading props. Every row has a FIXED
  // height in the CSS below — nothing (DEAD chip, a wrapping grenade row,
  // the stats row) may resize the card while it plays.
  import {
    ammoText,
    armorChip,
    carriesC4,
    heldItemOf,
    hpBand,
    hpPct,
    mainAmmoText,
    mainOf,
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
    reloadProgress = null,
    stats = null,
    icons = null,
    iconURLs = null,
    kit = null,
    onToggleMute = () => {},
    onFollow = () => {},
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
  // Defuse-kit possession is a TRI-STATE prop (never derived — the state
  // stream has no kit flag): only an explicit true draws the badge, and
  // false/null both render nothing (an unknown must never read as a
  // fact — the same rule carriesC4 applies to a missing inventory).
  const hasKit = $derived(kit === true);
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

  // The weapon row's three display modes (the markup below): a firearm
  // active (or no state) → the ordinary weapon block; a knife/util/C4 IN
  // HAND → the MAIN weapon's block (icon → reload ring → the held
  // item's icon right AFTER the gun's → ammo) with the MAIN weapon's
  // ammo (mainMag/mainReserve — never the held item's artifact ammo);
  // held with NO firearm carried (knife round / dropped sidearm) → the
  // bare held icon only. The row's height and position never change
  // between modes.
  const held = $derived(heldItemOf(state));
  const main = $derived(held ? mainOf(state) : null);
  const mainAmmo = $derived(held ? mainAmmoText(state) : '—');
  const heldIconSrc = $derived(held ? iconSrc(held) : null);
  const mainIconSrc = $derived(main ? iconSrc(main) : null);

  // The reload ring's geometry: r=5 in the 12×12 viewBox → the dash
  // length the fill's stroke-dasharray/dashoffset sweep through.
  const RELOAD_CIRC = 2 * Math.PI * 5;

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
  // The held row's tooltip carries what the icon-only prefix truncates:
  // the held item's name (it has NO text label) plus the main weapon and
  // ITS ammo; with no main, the honest reason — a bare held icon must
  // never assert an empty loadout the stream did not say.
  const heldTitle = $derived.by(() => {
    if (!held) return '';
    if (main) return `${held} + ${main} — ${mainAmmo}`;
    const inv = state ? state.inventory : null;
    return Array.isArray(inv)
      ? `${held} in hand — no firearm carried`
      : `${held} in hand — loadout unknown`;
  });
  const mainTitle = $derived(main ? `${main} — ${mainAmmo}` : '');
  const utilTitle = $derived(
    util == null ? 'Utility unknown' : util.length ? 'Utility carried' : 'No utility',
  );

  // The whole card follows the player (the caller's onFollow drives
  // engine.setFollow) — click AND keyboard, the LandmarkRow.svelte
  // role=button idiom (a real <button> can't wrap the nested mute
  // button). Svelte 5 delegated events: child stopPropagation does not
  // reliably stop this root handler — guard on target instead (the
  // Match.svelte row idiom): an event landing on an inner control
  // (button / a / input — today's mute button) returns without firing
  // follow, so nested and future controls stay independent of the card
  // activation. Enter/Space mirror the click; they are redundant with
  // the Replay view's own follow controls (F, 1-9/0, the follow
  // popover) — never a second source of follow state.
  function onCardClick(e) {
    if (e.target instanceof Element && e.target.closest('button, a, input')) return;
    onFollow();
  }

  function onCardKey(e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (e.target instanceof Element && e.target.closest('button, a, input')) return;
    e.preventDefault();
    onFollow();
  }
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
  role="button"
  tabindex="0"
  onclick={onCardClick}
  onkeydown={onCardKey}
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

  <!-- The equipped weapon on its OWN fixed-height line — three modes
       (row height/position identical in all three):
         1. a firearm active (or no state): the ordinary icon +
            mag/reserve block — the weapon name has NO text label, it
            rides the icon/chip's title tooltip (weaponTitle);
         2. knife/util/C4 IN HAND with a main firearm carried: the MAIN
            gun chip — the MAIN weapon's icon first, the held item's
            indicator right AFTER it (no separator between them — the
            chip's 4px gap is the spacing), then the MAIN weapon's ammo
            right-pinned at the row's edge (the stream's
            mainMag/mainReserve — not the held item's artifact ammo);
         3. held item and NO firearm (knife round / dropped sidearm):
            the bare held icon — no name, no ammo (the row's fixed
            height keeps the stack stable; a held icon missing from the
            manifest degrades to nothing, like a missing weapon icon,
            since the prefix has no text label by design).
       Both GUN chips (mode 1's active firearm, mode 2's main) carry the
       reload ring beside the icon when one is computing; it is pure
       paint inside the row's fixed height (see .pc-reload below). In
       mode 2 the held indicator rides INSIDE the gun chip, after the
       ring: gun icon → ring → held icon → (slack) → ammo.
       WIDTH PRESSURE: the killfeed silhouettes are wide (the M4A1-S
       art is 3:1, the knife 2.4:1), so a long weapon + knife pair can
       outgrow a narrow column — then the ICONS yield (they shrink:
       flex-shrink, see the .pc-weapon/.pc-held rules) and the ammo
       NEVER does (.pc-ammo: flex:none + nowrap) — the mag/reserve
       readout always renders in full, the art beside it gets smaller
       instead. -->
  {#snippet reloadRing()}
    {#if reloadProgress != null}
      <span class="pc-reload" aria-hidden="true" title="Reloading">
        <svg viewBox="0 0 12 12" width="12" height="12" focusable="false">
          <circle class="pc-reload-track" cx="6" cy="6" r="5" transform="rotate(-90 6 6)" />
          {#if reloadProgress > 0}
            <!-- Round cap + a zero-length dash would draw a dot, so the
                 fill exists only once it has something to sweep. -->
            <circle
              class="pc-reload-fill"
              cx="6"
              cy="6"
              r="5"
              transform="rotate(-90 6 6)"
              stroke-dasharray="{RELOAD_CIRC} {RELOAD_CIRC}"
              stroke-dashoffset="{RELOAD_CIRC * (1 - reloadProgress)}"
            />
          {/if}
        </svg>
      </span>
    {/if}
  {/snippet}
  <div class="pc-weapon-row">
    {#if held}
      {#if main}
        <!-- Mode 2: ONE gun chip owns the line — icon → ring → held
             indicator (right after the gun) → ammo. The held span drops
             the pc-chip class here (it rides the gun chip, not the row
             of its own); its own title tooltip still names the held
             item + main pair. -->
        <span class="pc-chip pc-weapon" title={mainTitle}>
          {#if mainIconSrc}
            <img class="pc-ico" src={mainIconSrc} alt="" />
          {/if}
          {@render reloadRing()}
          {#if heldIconSrc}
            <span class="pc-held" title={heldTitle}>
              <img class="pc-ico" src={heldIconSrc} alt="" />
            </span>
          {/if}
          <span class="pc-num pc-ammo">{mainAmmo}</span>
        </span>
      {:else if heldIconSrc}
        <!-- Mode 3: the bare held icon (no firearm carried). -->
        <span class="pc-chip pc-held" title={heldTitle}>
          <img class="pc-ico" src={heldIconSrc} alt="" />
        </span>
      {/if}
    {:else}
      <span class="pc-chip pc-weapon" title={weaponTitle}>
        {#if weaponIconSrc}
          <img class="pc-ico" src={weaponIconSrc} alt="" />
        {/if}
        {@render reloadRing()}
        <span class="pc-num pc-ammo">{ammo}</span>
      </span>
    {/if}
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
    <!-- The defuse kit rides beside the bomb badge — the SAME visual
         language as the C4 cell (icon, mandatory text fallback, fixed
         square cell so mounting it shifts nothing), but it is a PROP
         (tri-state `kit`), never derived from the inventory: the state
         stream carries no kit flag. null/false → no badge, same
         false-on-unknown rule as carriesC4. -->
    {#if hasKit}
      <span class="pc-kit" title="Defuse kit">
        {#if iconSrc('Defuse Kit')}
          <img class="pc-ico" src={iconSrc('Defuse Kit')} alt="Kit" />
        {:else}
          <span class="pc-fallback">Kit</span>
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
    /* The whole card is a click target (onFollow — follow/release the
       camera on this player); the pointer is the affordance. */
    cursor: pointer;
  }

  /* Modest hover: the border lifts toward the muted text colour — paint
     only, and the fixed row heights never move. Ordered BEFORE the
     .pc-follow rule below so a FOLLOWED card keeps its tint under the
     cursor (equal specificity → source order decides). */
  .pc-card:hover {
    border-color: var(--muted);
  }

  /* Follow is UI STATE (the camera's target), not side/identity — the
     same amber (--accent) the stage's follow ring wears, as a BORDER
     tint so the player-color box-shadow stays the card's ONLY ring:
     never outline on any .pc-card rule (player-card.dom.mjs's one-ring
     pin scans them all), and no second shadow that could fight the
     .pc-color ring it may sit beside. */
  .pc-card.pc-follow {
    border-color: var(--accent-55);
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

  /* Dead reads as dead without hiding the last-known values — the two
     remaining cues (the owner's ruling, 2026-11-11; border tint removed
     by the owner's follow-up ruling, 2026-11-12): a stronger dim (0.55,
     paint-only — clearly distinct from a live card at a glance) and the
     DEAD chip in the head (markup). The gray border
     tint (var(--muted)) that used to be the third signal was REMOVED by
     the owner's ruling (2026-11-12): a dead card's border now falls
     back to the card default (var(--border)), so under the cursor it
     lifts exactly like a live one. Border-color NEVER outline and never
     a second box-shadow: the .pc-color ring stays the card's ONLY ring
     (the one-ring pin scans every .pc-card rule). Precedence: .pc-follow
     (0,2,0) outranks this (0,1,0), so a FOLLOWED dead card keeps its
     amber (the follow icon in the head marks both). Live cards are
     untouched: opacity lives ONLY here, never on the base .pc-card
     rule. */
  .pc-dead {
    opacity: 0.55;
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

  /* The equipped weapon's OWN fixed-height line (icon + ammo). The
     firearm icon takes the line's height at its intrinsic aspect ratio
     (see .pc-weapon .pc-ico below) and the ammo keeps its 9ch floor,
     right-pinned by its auto margin, so neither can wrap a second line
     or resize the card.
     YIELD ORDER: the row's cells may not fit a narrow column (wide
     silhouette + knife + 9ch ammo), and this row clips overflow — so
     exactly one side yields: the ammo is flex:none + nowrap (always
     fully rendered), the icon cells carry flex-shrink with min-width:0
     (their art scales down via object-fit:contain — never distorted,
     never clipped). Before that split, EVERY cell was a non-yielder
     and this overflow:hidden cut the trailing ammo off the card's right
     edge whenever a long weapon + knife pair outgrew the column. */
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

  /* The FIREARM icons (both modes' main-gun blocks — mode 1's weapon,
     mode 2's main) keep their INTRINSIC aspect ratio and grow to the
     line's full height instead of letterboxing inside the shared 15px
     .pc-ico square (a wide rifle read as a sliver in that box). The
     height mirrors .pc-weapon-row's 1.5em exactly — keep the two in
     step — and the row's overflow:hidden is the hard stop: an icon can
     fill the line, never exceed it; width:auto + object-fit:contain
     mean the ratio is the image's own, never distorted. Armor, the
     grenade-inventory row and the C4 badge keep the square 15px cell
     (they are badges, not the line's subject); the held indicator gets
     the same treatment as the gun below (.pc-held .pc-ico). It is ALSO
     the row's YIELDER: flex 0 1 auto + min-width:0 let a wide
     silhouette (the 3:1 M4A1-S art, the 2.4:1 knife) shrink under
     width pressure instead of pushing the ammo past the row's clip —
     object-fit keeps the ratio, so the art only renders smaller, never
     distorted and never clipped. */
  .pc-weapon .pc-ico {
    height: 1.5em;
    width: auto;
    object-fit: contain;
    flex: 0 1 auto;
    min-width: 0;
  }

  /* The held indicator (knife/util/C4 in hand) takes the SAME
     aspect-ratio treatment as the firearm icon — it is the line's
     subject too, so it fills the line at its intrinsic ratio instead of
     letterboxing in the shared 15px square. This rule is what reaches
     MODE 3's bare held chip (outside any .pc-weapon); in mode 2 the
     indicator sits inside the gun chip and matches BOTH this rule and
     .pc-weapon .pc-ico — same declarations, no cascade conflict. The
     shared .pc-ico 15px default above is untouched: armor, grenades
     and C4 keep their square badge cell. Same height pin as the gun
     rule — keep both in step with .pc-weapon-row's 1.5em. The
     aspect-ratio rule doubles as the yielder, exactly like the gun's
     above (flex 0 1 auto + min-width:0 — see .pc-ammo for the side
     that never yields). */
  .pc-held .pc-ico {
    height: 1.5em;
    width: auto;
    object-fit: contain;
    flex: 0 1 auto;
    min-width: 0;
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

  /* 9ch reserves the widest real pair ("150 / 200") so a magazine drop
     never reflows the row; margin-left:auto pins the pair to the row's
     right edge (the weapon name that used to absorb the slack is gone —
     the icon + tooltip carry the weapon now). The readout is the row's
     NEVER-YIELDING cell: flex:none (it never shrinks — the icon cells
     beside it take every pixel of a tight row) + white-space:nowrap
     (the mag/reserve pair never breaks into a second line the fixed
     1.5em row would clip). */
  .pc-ammo {
    flex: none;
    white-space: nowrap;
    min-width: 9ch;
    margin-left: auto;
    text-align: right;
  }

  /* The reload ring beside the gun icon (reloadProgress — the ONE
     formula lives in replay/playercard.js; Replay computes it, this
     component only paints it): a grey track in --divider with the fill
     arc in --muted sweeping 0 → 100% over the run (the dasharray/
     dashoffset values ride inline per frame). It renders ONLY while
     reloading — null progress mounts nothing, never a guessed arc — and
     it is pure paint: a fixed 12px box, flex:none, well under the row's
     1.5em, so it can never change the row height, squeeze the icon or
     move the ammo's auto margin; the row's overflow:hidden is the hard
     stop. The 1.2 stroke and the 12-unit viewBox are 1:1, so the stroke
     is 1.2px at every font setting. */
  .pc-reload {
    flex: none;
    display: block;
    width: 12px;
    height: 12px;
    line-height: 0;
  }

  .pc-reload svg {
    display: block;
  }

  .pc-reload circle {
    fill: none;
    stroke-width: 1.2;
  }

  .pc-reload-track {
    stroke: var(--divider);
  }

  .pc-reload-fill {
    stroke: var(--muted);
    stroke-linecap: round;
  }

  /* The held-item indicator (knife/util/C4 in hand): a BARE icon — no
     text label (its name rides its own title tooltip, and in mode 2 the
     gun chip's tooltip names the gun). In mode 2 it rides INSIDE the
     gun chip right after the icon/ring; in mode 3 it is the row's only
     chip. Its icon takes the line height at intrinsic ratio (see
     .pc-held .pc-ico above). The old thin separator (.pc-hsep) is
     GONE — the chip's 4px gap is the spacing now.
     YIELDING: unlike its old flex:none, the indicator is now one of the
     row's YIELDERS (flex 0 1 auto + min-width:0) — under width
     pressure it lets its art shrink rather than squeeze the ammo; the
     ammo's own flex:none (.pc-ammo) is what guarantees the readout can
     never be squeezed instead. inline-flex makes the span a flex
     container so the img INSIDE it can shrink within the span (a plain
     inline span would just overflow it). */
  .pc-held {
    display: inline-flex;
    flex: 0 1 auto;
    min-width: 0;
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

  /* The defuse kit badge — the C4 cell's exact geometry (a fixed-size
     cell so mounting/unmounting it never reflows the econ row; the
     shared .pc-ico 15px square above already sizes the icon). */
  .pc-kit {
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
