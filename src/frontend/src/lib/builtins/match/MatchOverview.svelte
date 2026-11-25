<script>
  import ProfileLink from '../../components/ProfileLink.svelte';
  import { sideSwitchesOf } from '../../builtinhelpers.js';
  import { openRow } from '../../keys.js';
  import { loadForMatch } from '../../current.js';
  import * as S from '../../strings/index.js';
  import { SQL_ROSTER, SQL_SWITCHES, STATE_WORD, readUnit, cellText, kdaText } from './panelhelpers.js';
  import { isSteam } from '../../builtinhelpers.js';
  import LoadBox from '../../components/LoadBox.svelte';

  // Match overview cards: the five identity metrics of the match, one card
  // each, in their default order (top fragger, best ADR, most util, entry
  // opens, most MVPs). A card with no pool shows nothing (never a name).
  let { spectra, context, back = '' } = $props();

  const CARDS = [
    { metric: 'top_fragger', label: S.match.cardTopFragger },
    { metric: 'best_adr', label: S.match.cardBestAdr },
    { metric: 'most_util', label: S.match.cardMostUtil },
    { metric: 'entry_opens', label: S.match.cardEntryOpens },
    { metric: 'most_mvps', label: S.match.cardMostMvps },
  ];

  let cards = $state([]);
  let ready = $state(false);

  async function load(matchId) {
    if (matchId == null) return { cards: [], switches: 0 };
    const [roster, switchRows, kills, deaths, assists, adr, util, opens, mvps] = await Promise.all([
      spectra.query(SQL_ROSTER),
      spectra.query(SQL_SWITCHES),
      readUnit(spectra, 'kills'),
      readUnit(spectra, 'deaths'),
      readUnit(spectra, 'assists'),
      readUnit(spectra, 'adr'),
      readUnit(spectra, 'utility_damage'),
      readUnit(spectra, 'entry_kills'),
      readUnit(spectra, 'mvps'),
    ]);
    const switches = sideSwitchesOf(switchRows);
    const who = new Map(roster.rows.map((r) => [r[0], { name: r[1], side: r[2] }]));
    const out = [];
    const reads = await spectra.readMetrics(CARDS.map((c) => c.metric));
    for (const card of CARDS) {
      const m = reads.get(card.metric);
      if (m.state === 'no-data') continue;
      let steam = null;
      let value = '';
      if (m.state === 'fresh') {
        const row = m.rows[0];
        if (!row || !who.has(row.valueKey)) continue;
        steam = row.valueKey;
        if (card.metric === 'top_fragger') {
          value = kdaText(kills, deaths, assists, steam);
        } else if (card.metric === 'best_adr') {
          value = cellText(adr, steam, 'float1');
        } else if (card.metric === 'most_util') {
          value = cellText(util, steam, 'int');
        } else if (card.metric === 'entry_opens') {
          value = cellText(opens, steam, 'int');
        } else {
          value = cellText(mvps, steam, 'int');
        }
      } else {
        value = STATE_WORD[m.state] || m.state;
      }
      const person = steam ? who.get(steam) : null;
      out.push({
        key: card.metric,
        label: card.label,
        value,
        steam,
        name: person ? person.name : '',
        side: person ? person.side : '',
        state: m.state,
        title: m.error || '',
      });
    }
    return { cards: out, switches };
  }

  $effect(
    loadForMatch(
      () => context.matchId,
      load,
      (res) => {
        cards = res.cards;
        ready = true;
      },
      (e) => spectra.report(e),
    ),
  );

  const follow = (steam) => spectra.followPlayer(steam, back);
</script>

<section class="match-overview">
  <div class="stat-grid">
    {#if ready}
      {#each cards as c (c.key)}
        <LoadBox tag="div" class="stat-box" busy={spectra.busy} name="match-overview-card" key={c.key}>
          <div
            class="stat-cell"
            role="button"
            tabindex="0"
            title={c.title || undefined}
            {...openRow(() => c.steam && follow(c.steam), { ignore: 'button, a, input', enterOnly: true })}
          >
            <span class="field-label">{c.label}</span>
            <span class="stat-value">{c.value}</span>
            <span class="stat-sub">
              {#if c.steam && isSteam(c.steam)}
                <ProfileLink steam={c.steam} name={c.name} nav={spectra.navigate} variant="name-link" stopRow />
              {:else}
                {c.name}
              {/if}
            </span>
          </div>
        </LoadBox>
      {/each}
    {:else}
      <!-- Before the data: one held, spinning card per identity metric, so the grid already has its space. -->
      {#each CARDS as card (card.metric)}
        <LoadBox tag="div" class="stat-box" busy name="match-overview-card" key=""></LoadBox>
      {/each}
    {/if}
  </div>
</section>
