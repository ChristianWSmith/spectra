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
  pistolLabel: 'Pistol → next round',
  pistolSub: 'pistol wins held next round',
  pistolTitle: 'Formula: pistol rounds won by a side where that side also won the immediately following round ÷ pistol rounds won. Click: watch round {round} in the replay (the round\'s own span, start→end).',
  forceLabel: 'Force-buy win rate',
  noForceBuys: 'no force buys',
  forceTitle: 'Formula: force-buy rounds won ÷ force-buy rounds, pooled across both teams (headline); the sub-line is each team’s own won/rounds across the halftime switch. Click: watch round {round} in the replay.',
  gapLabel: 'Winner equipment value advantage',
  gapSub: 'avg winner − loser equip per round',
  gapTitle: 'Formula: average across decided rounds of (winner equipment value − loser equipment value) at freeze time end — never this round\'s spend. Click: watch round {round} (largest gap) in the replay.',
  lostLabel: 'Lost equipment',
  lostTitle: 'Formula: total across decided rounds of the losing team\'s freeze-end equipment value — inferred: assumes the losing side\'s gear was destroyed. Click: watch round {round} in the replay.',

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
};
