<script>
  // The one landmark row — the Replay feed's list row AND CompareRounds'
  // compact event-sequence row (the shared event presentation).
  // Rows arrive pre-categorized from lib/replay/
  // landmarks.js normalize*; this component owns only DISPLAY: the
  // source-aware primary text, the category chip, and the row actions
  // (seek ▶, select). Profile/payload detail lives in the caller's
  // detail pane, not here.
  //
  // Props:
  //   row          — a normalized landmark row (event/chat/generic source)
  //   compact      — CompareRounds' sequence style (tick + chip + names)
  //   selected     — row is the active selection (Replay)
  //   nav          — router fn for the in-text ProfileLinks
  //   resolveSteam — optional name → SteamId resolver for generic rows
  //                  (Replay resolves `who` against the sidecar slot
  //                  table; without it a generic name stays plain text)
  //   roundByNumber — optional round lookup (Replay's roundsByNumber):
  //                  with it the row shows the ROUND + TIME columns
  //                  (roundIndexLabel / the match clock); without it
  //                  (CompareRounds' compact sequence) the legacy tick
  //                  cell renders unchanged
  //   tickRate     — match tick rate for the time cell (0 → 64 via fmt)
  //   players, sideSwitches, rounds — optional side inputs for chat rows'
  //                  channel tag (fmt.chatTag + teams.playerSideAt): the
  //                  [ALL]/[T]/[CT] bracket after the speaker's name.
  //                  Without them (CompareRounds' compact sequence) team
  //                  chat shows NO bracket rather than a guessed side —
  //                  the row's generic contract stays intact.
  //   onselect     — click the row (Replay's detail pane)
  //   onseek       — click ▶ (seek to the row's tick)
  import { categoryById } from '../replay/landmarks.js';
  import { roundIndexLabel } from '../rounds.js';
  import { chatTag, fmtClock, tickSeconds } from '../fmt.js';
  import { playerSideAt } from '../teams.js';
  import ProfileLink from './ProfileLink.svelte';

  let {
    row,
    compact = false,
    selected = false,
    nav = () => {},
    resolveSteam = null,
    roundByNumber = null,
    tickRate = 0,
    players = null,
    sideSwitches = 0,
    rounds = null,
    onselect = () => {},
    onseek = () => {},
  } = $props();

  const cat = $derived(categoryById(row.category));

  // The round ROW behind this row's round number (null when the lookup
  // has no row — the ROUND column falls back to the raw round number
  // then; the time cell is match-relative for every row, so no clock
  // arithmetic depends on it).
  const roundRow = $derived(roundByNumber ? roundByNumber.get(row.round) ?? null : null);

  // Secondary text: the event's weapon / damage / distance bits, or a
  // generic row's label when its name already took the primary slot.
  const secondary = $derived.by(() => {
    if (row.source === 'event') {
      const bits = [];
      if (row.weapon) bits.push(row.weapon);
      if (row.kind === 'damage' && row.dmg) bits.push(`${row.dmg} dmg`);
      if (row.kind === 'kill' && row.distance) bits.push(`${Math.round(row.distance)}u`);
      return bits.join(' · ');
    }
    if (row.source === 'generic' && row.who && row.label) return row.label;
    return '';
  });

  // The chat row's channel tag — the bracket of THE chat display rule
  // (fmt.chatTag): '[ALL]' for all chat regardless of who spoke; for team
  // chat the SPEAKER'S SIDE at this round ('[T]'/'[CT]' — teams.playerSideAt,
  // the same side VALUE the name color would use, so color and tag can
  // never disagree). Unresolved side / no side inputs → '' (no bracket,
  // never a guess); system rows (channel '') never get one.
  const chatTagText = $derived(
    row.source === 'chat'
      ? chatTag(row.channel || '', playerSideAt(players, sideSwitches, rounds, row.round, row.steamId, row.who))
      : '',
  );

  // The row's main hit area is a role=button DIV, not a <button>: the
  // primary text carries ProfileLinks (real buttons), and interactive
  // elements may not nest inside a button. Clicks that land on one of
  // those links select the LINK, never the row (target guard, the same
  // pattern Match's scoreboard rows use).
  function onMainClick(e) {
    if (e.target instanceof Element && e.target.closest('button, a, input')) return;
    onselect(row);
  }

  function onMainKey(e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (e.target instanceof Element && e.target.closest('button, a, input')) return;
    e.preventDefault();
    onselect(row);
  }

  function seek(e) {
    e.stopPropagation();
    onseek(row);
  }
</script>

{#snippet person(steam, name)}
  <!-- ProfileLink falls back to '—' itself; a non-steam id renders the
       same plain text it always did. -->
  <ProfileLink {steam} {name} {nav} />
{/snippet}

{#snippet primaryText()}
  {#if row.source === 'event'}
    {#if row.kind === 'kill' || row.kind === 'damage'}
      {@render person(row.attacker, row.attackerName || row.attacker)}{' → '}{@render person(
        row.victim,
        row.victimName || row.victim,
      )}
    {:else if row.attackerName || row.attacker}
      {@render person(row.attacker, row.attackerName || row.attacker)}
    {:else if row.victimName || row.victim}
      {@render person(row.victim, row.victimName || row.victim)}
    {:else if row.kind === 'round_end' || row.kind === 'round_start'}
      Round {roundIndexLabel(roundRow ?? row.round)}
    {:else if row.site}
      {row.kind} · site {row.site}
    {:else}
      {row.kind}
    {/if}
  {:else if row.source === 'chat'}
    <!-- THE chat display rule: linked name, channel/side tag, ': ' + text
         (fmt.chatTag — [ALL] always, [T]/[CT] only for team chat with a
         resolved side; no tag → the legacy `name: text` line). -->
    {@render person(row.steamId, row.who)}{#if chatTagText}{' '}{chatTagText}{/if}: {row.label}
  {:else if row.who}
    <!-- Generic rows carry no id — link only when the caller's resolver
         returns one, else ProfileLink renders the plain name. -->
    {@render person(resolveSteam ? resolveSteam(row.who) : '', row.who)}
  {:else}
    {row.label || row.name}
  {/if}
{/snippet}

<li class="lm-row" class:lm-compact={compact} class:active={selected}>
  <button
    class="btn small ghost lm-play"
    title="Seek replay to tick {row.tick}"
    aria-label="Seek to tick {row.tick}"
    onclick={seek}
  ><span class="codicon codicon-play"></span></button
  >
  <div
    class="lm-main"
    role="button"
    tabindex="0"
    title="{cat?.label || row.category} — tick {row.tick}"
    onclick={onMainClick}
    onkeydown={onMainKey}
  >
    {#if roundByNumber}
      <!-- Round + match clock (the feed's canonical readout): the round
           label via lib/rounds.js roundIndexLabel (12 / K / W) and the
           time cell as the MATCH-relative clock — fmtClock(tick /
           tickRate) via fmt.tickSeconds — for EVERY row kind, so a
           round_start row (tick === its round's startTick) never reads
           0:00 and no row silently changes shape by kind. The raw tick
           stays in the tooltip. -->
      <span class="chip round-chip lm-round" title="Round {roundIndexLabel(roundRow ?? row.round)}">{roundIndexLabel(roundRow ?? row.round)}</span>
      <span class="mono lm-time" title="tick {row.tick}">{fmtClock(tickSeconds(row.tick, tickRate))}</span>
    {:else}
      <!-- Legacy cell (CompareRounds' compact sequence — no round
           lookup passed): tick + raw round chip, unchanged. -->
      <span class="mono lm-tick">{row.tick}</span>
      <span class="chip round-chip">{row.round >= 1 ? `R${row.round}` : roundIndexLabel(row.round)}</span>
    {/if}
    <span class="chip kind lm-cat" class:lm-cat-generic={row.source !== 'event'} title={cat?.label}>{cat?.short || cat?.label || row.category}</span>
    <span class="lm-text">{@render primaryText()}</span>
    {#if secondary}<span class="muted lm-sec">{secondary}</span>{/if}
  </div>
</li>
