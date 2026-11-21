// strings/economy.js — Economy view chrome (EconCurve head, summary
// cards, per-round table)
// Extracted from views/Economy.svelte (Strings Stage 3, Sweep-B); values
// are plain strings with {arg} placeholders — compose at the call site
// with S.fill(S.economy.slot, { arg }).
// Audit: node --test src/lib/strings-audit.test.js   (from frontend/)

export const economy = {
  // head / alerts
  dismissError: 'Dismiss error',
  loadingDetail: 'Loading economy…',
  roundSuffix: ' round',
  headNote: 'buy classes follow saved rules — click a chip for the reason',

  // summary stat cards (label + sub + drill tooltip formula)
  pistolSub: 'pistol wins held next round',
  gapSub: 'avg winner − loser equip per round',
  // The card LABELS and TOOLTITS come from the metric definition now
  // (title = the catalog's label, doc = the card's Formula tooltip) —
  // the card-set migration (owner 2026-11-18) retired the hardcoded
  // label/title/no-force-buys strings with the composed cards.

  // provenance chips (the summary cards — the table's inferred
  // markers left with its footnote, 2026-11-18)
  badgeComputed: 'computed',
  badgeInferred: 'inferred',

  // per-round table
  roundsHeading: 'Rounds',
  noRounds: 'No rounds recorded yet.',
  thWinner: 'Winner',
  thCTBuy: 'CT buy',
  thTBuy: 'T buy',
  thDeathsCT: 'CT Deaths',
  thDeathsT: 'T Deaths',
  deathsTitle: "Deaths suffered by that side's players in this round",
  thLossCT: 'Loss CT',
  thLossT: 'Loss T',
  openRound: 'Open round {round}',
  chipTitle: '{why} (rules v{rule}) — click for full text',
  noExplanation: 'no explanation recorded',
  rulesV: 'rules v',
  closeExplanation: 'Close explanation',
  // Builtin panel copy: read by builtins/panels.
  equipDef: "Equipment value — freeze-time-end value of the gear a side actually holds — every weapon (picked up and carried over included), armor, grenades and the defuse kit. Never this round’s spend.",
  cardLostDoc: "Formula: sum(round_economy.equip_value) of the losing side over decided, team-known rounds — freeze-time money lost, addressed per match (no partition), over the joined sources — a total.",
  cardForceWonDoc: "Formula: count(round_side_classes rows joined to rounds WHERE class = force AND winner = side) — force rounds that team won, addressed per team (no partition), over the joined sources.",
  cardPistolDoc: "Formula: pistol rounds won where that side also won the following round ÷ pistol rounds won — the held-pistol rate, addressed per match (no partition), over the joined sources.",
  netWorthDef: "Net worth — equipment value plus the team’s unspent money at freeze time end — the total the team holds then. Never below equipment value: unspent money never goes negative.",
  cardTeamLostDoc: "Formula: sum(round_economy.equip_value) of that team's losing rounds — freeze-time money the team lost, addressed per team (no partition), over the joined sources — a total.",
  cardGapDoc: "Formula: average across decided rounds of (winner equipment value − loser equipment value) at freeze time — addressed per match (no partition).",
  cardForceDoc: "Formula: count(round_side_classes rows WHERE class = force) — that team's own force-buy rounds, addressed per team (no partition).",
  curveAriaSuffix: " per round, one line per team — click a column to open the round",
  stripNoVerdict: "no verdict · click a round to open it",
  cardGapSub: "avg winner − loser equip per round",
  stripFavorite: "favorite (higher buy type) held ·",
  cardGapLabel: "Winner equipment value advantage",
  verdictFavorite: "favorite (higher buy type) held",
  noRows: "No economy rows for this match.",
  watchRoundSuffix: " from its start in the replay",
  stripUpset: "upset (lower buy type won) ·",
  cardPistolSub: "pistol wins held next round",
  verdictUnknown: "unknown buy type — neutral",
  verdictUpset: "upset (lower buy type won)",
  curveHeadNetWorth: "Team net worth per round",
  curveHeadEquip: "Equip value per round",
  stripEven: "even buy (toss-up) ·",
  cardPistolLabel: "Pistol → next round",
  cardTeamLostLabel: "Team lost equipment",
  verdictNoWinner: "no winner recorded",
  verdictEven: "toss-up (even buy)",
  cardForceWonLabel: "Force rounds won",
  loading: "Loading economy…",
  cellWinsBuy: " wins · buy CT ",
  curveAriaEquip: "equipment value",
  cardLostLabel: "Lost equipment",
  panelRounds: "Economy rounds",
  stripPistol: "pistol round ·",
  panelCurve: "Economy curve",
  panelCards: "Economy cards",
  cardForceLabel: "Force rounds",
  curveMetricGroup: "Curve metric",
  watchRoundPrefix: "Watch round ",
  curveToggleEquip: "Equip value",
  openRoundAria: "Open round ",
  stripLabel: "Round strip",
  curveLegendLabel: "Team lines",
  cellPistol: " · pistol",
  curveToggleNetWorth: "Net worth",
  curveAriaNetWorth: "net worth",
  colCtDeaths: "CT Deaths",
  colTDeaths: "T Deaths",
  panelEconomy: "Economy",
  colCtLoss: "Loss CT",
  cellRound: "Round ",
  colRounds: "Rounds",
  colTLoss: "Loss T",
  colCtBuy: "CT buy",
  cellBuySep: " / T ",
  colTBuy: "T buy",

  // Builtin panel copy.
  chipPistol: "pistol",
  tipEquip: "equip",
  titleDeaths: "Deaths suffered by that side's players in this round",
  ruleOpen: " (rules v",
  ruleClose: ") — click for full text",
  rulesPrefix: "rules v",

};
