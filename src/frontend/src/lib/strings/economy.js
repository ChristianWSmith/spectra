// strings/economy.js — Economy view chrome (EconCurve head, summary
// cards, buy-types table)
// Extracted from views/Economy.svelte (Strings Stage 3, Sweep-B); values
// are plain strings with {arg} placeholders — compose at the call site
// with S.fill(S.economy.slot, { arg }).
// Audit: node --test src/lib/strings-audit.test.js   (from frontend/)

export const economy = {
  // head / alerts
  dismissError: 'Dismiss error',
  loadingDetail: 'Loading economy…',
  roundSuffix: ' round',
  headNote: 'buy types follow saved rules — click a chip for the reason',

  // summary stat cards (label + sub + drill tooltip formula)
  pistolLabel: 'Pistol → next round',
  pistolSub: 'pistol wins held next round',
  pistolTitle: 'Formula: pistol rounds won by a side where that side also won the immediately following round ÷ pistol rounds won. Click: watch round {round} in the replay (the round\'s own span, start→end).',
  forceLabel: 'Force-buy win rate',
  noForceBuys: 'no force buys',
  forceTitle: 'Formula: force-buy rounds won by the force-buying TEAM ÷ that team\'s own force-buy rounds, attributed per team across the halftime side switch (a round both teams force-bought counts once for each). Click: watch round {round} in the replay (the round\'s own span, start→end).',
  gapLabel: 'Winner equipment value advantage',
  gapSub: 'avg winner − loser equip per round',
  gapTitle: 'Formula: average across decided rounds of (winner equipment value − loser equipment value) at freeze time end — the value of the gear each side actually holds (weapons carried over from earlier rounds included), never this round\'s spend. Click: watch round {round} (largest gap) in the replay (the round\'s own span, start→end).',
  lostLabel: 'Lost equipment',
  lostTitle: 'Formula: total across decided rounds of the losing team\'s freeze-end equipment value, credited to the team that lost it rather than the side it played — inferred: assumes all losing-side equipment is destroyed. Click: watch round {round} (largest loss) in the replay (the round\'s own span, start→end).',

  // provenance chips
  badgeComputed: 'computed',
  badgeInferred: 'inferred',
  inferredTitle: 'calculated from the round results',

  // buy-types table
  buyTypesHeading: 'Buy types',
  noBuyTypes: 'No buy types recorded yet.',
  thWinner: 'Winner',
  thCTBuy: 'CT buy',
  thTBuy: 'T buy',
  thEquipCT: 'Equip CT',
  thEquipT: 'Equip T',
  thLossCT: 'Loss CT',
  thLossT: 'Loss T',
  openRound: 'Open round {round}',
  chipTitle: '{why} (rules v{rule}) — click for full text',
  noExplanation: 'no explanation recorded',
  rulesV: 'rules v',
  closeExplanation: 'Close explanation',
  tableNote: 'Equip CT/T = that side\'s equipment value at freeze time end — the\n          value of the gear its players actually hold (weapons picked up and\n          carried over from earlier rounds included), never this round\'s\n          spend; the chart\'s Net worth = that equipment value + the side\'s\n          unspent money at the same instant, so it is never below equipment\n          value (the Net worth tooltip has the full rule); Loss CT/T =\n          the round loss bonus that side would collect by losing\n          this round — CS2\'s ladder runs $1400 → $3400 in $500 steps: a loss\n          steps it up, a win steps it down (never a full reset), and every\n          half starts one level up (a pistol loss pays $1900);',
  tableNoteTail:
    'on the Loss headers\n          marks those values as calculated from the round results rather than\n          recorded.',
};
