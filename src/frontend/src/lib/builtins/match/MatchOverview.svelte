<script>
  import * as S from '../../strings/index.js';
  import { SQL_ROSTER, SQL_SWITCHES, STATE_WORD, readUnit, cellText } from './panelhelpers.js';
  import { isSteam, openPlayer, followPlayer } from '../../builtinhelpers.js';

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
    const switches = Number((switchRows.rows[0] || [0])[0]) || 0;
    const who = new Map(roster.rows.map((r) => [r[0], { name: r[1], side: r[2] }]));
    const out = [];
    for (const card of CARDS) {
      const m = await spectra.metric(card.metric);
      if (m.state === 'no-data') continue;
      let steam = null;
      let value = '';
      if (m.state === 'fresh') {
        const row = m.rows[0];
        if (!row || !who.has(row.valueKey)) continue;
        steam = row.valueKey;
        if (card.metric === 'top_fragger') {
          value = [cellText(kills, steam, 'int'), cellText(deaths, steam, 'int'), cellText(assists, steam, 'int')].join('/');
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
      out.push({ key: card.metric, label: card.label, value, steam, name: person ? person.name : '', side: person ? person.side : '', state: m.state, title: m.error || '' });
    }
    return { cards: out, switches };
  }

  $effect(() => {
    const matchId = context.matchId;
    let live = true;
    load(matchId).then(
      (res) => {
        if (!live) return;
        cards = res.cards;
        ready = true;
      },
      () => {
        // A failed read is reported into this frame by the read API.
      },
    );
    return () => {
      live = false;
    };
  });

  const follow = (steam) => followPlayer(spectra, context.matchId, back, steam);
</script>

<section class="match-overview">
  {#if ready}
    <div class="stat-grid">
      {#each cards as c (c.key)}
        <div class="stat-cell" role="button" tabindex="0" title={c.title || undefined}
          onclick={(e) => { if (e.target instanceof Element && e.target.closest('button')) return; if (c.steam) follow(c.steam); }}
          onkeydown={(e) => { if (e.key === 'Enter' && c.steam) follow(c.steam); }}
        >
          <span class="field-label">{c.label}</span>
          <span class="stat-value">{c.value}</span>
          <span class="stat-sub">
            {#if c.steam && isSteam(c.steam)}
              <button class="btn ghost small name-link" onclick={(e) => { e.stopPropagation(); openPlayer(spectra, c.steam); }}>{c.name}</button>
            {:else}
              {c.name}
            {/if}
          </span>
        </div>
      {/each}
    </div>
  {/if}
</section>
