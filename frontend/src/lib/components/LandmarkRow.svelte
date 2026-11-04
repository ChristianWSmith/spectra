<script>
  // The one landmark row — the Replay feed's list row AND CompareRounds'
  // compact event-sequence row (the consolidation's shared event
  // presentation). Rows arrive pre-categorized from lib/replay/
  // landmarks.js normalize*; this component owns only DISPLAY: the
  // source-aware primary text, the category chip, and the row actions
  // (seek ▶, select). Profile/payload detail lives in the caller's
  // detail pane, not here.
  //
  // Props:
  //   row      — a normalized landmark row (event/chat/generic source)
  //   compact  — CompareRounds' sequence style (tick + chip + names)
  //   selected — row is the active selection (Replay)
  //   nav      — router fn (unused directly; kept for parity)
  //   onselect — click the row (Replay's detail pane)
  //   onseek   — click ▶ (seek to the row's tick)
  import { categoryById } from '../replay/landmarks.js';

  let {
    row,
    compact = false,
    selected = false,
    onselect = () => {},
    onseek = () => {},
  } = $props();

  const cat = $derived(categoryById(row.category));

  // Primary text by source: typed events show the actor pair (or the
  // single actor / raw kind for non-player events), chat shows
  // "sender: message", generic rows show who/label with the event name
  // as the final fallback.
  const primary = $derived.by(() => {
    if (row.source === 'event') {
      if (row.kind === 'kill' || row.kind === 'damage') {
        return `${row.attackerName || row.attacker || '—'} → ${row.victimName || row.victim || '—'}`;
      }
      if (row.attackerName || row.attacker) return row.attackerName || row.attacker;
      if (row.victimName || row.victim) return row.victimName || row.victim;
      if (row.kind === 'round_end' || row.kind === 'round_start') return `Round ${row.round}`;
      if (row.site) return `${row.kind} · site ${row.site}`;
      return row.kind;
    }
    if (row.source === 'chat') return `${row.who || '—'}: ${row.label}`;
    return row.who || row.label || row.name;
  });

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

  function seek(e) {
    e.stopPropagation();
    onseek(row);
  }
</script>

<li class="lm-row" class:lm-compact={compact} class:active={selected}>
  <button
    class="btn small ghost lm-play"
    title="Seek replay to tick {row.tick}"
    aria-label="Seek to tick {row.tick}"
    onclick={seek}
  ><span class="codicon codicon-play"></span></button
  >
  <button class="lm-main" title="{cat?.label || row.category} — tick {row.tick}" onclick={() => onselect(row)}>
    <span class="mono lm-tick">{row.tick}</span>
    <span class="chip round-chip">R{row.round}</span>
    <span class="chip kind lm-cat" class:lm-cat-generic={row.source !== 'event'} title={cat?.label}>{cat?.short || cat?.label || row.category}</span>
    <span class="lm-text">{primary}</span>
    {#if secondary}<span class="muted lm-sec">{secondary}</span>{/if}
  </button>
</li>
