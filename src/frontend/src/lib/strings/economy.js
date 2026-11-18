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
  pistolSub: 'pistol wins held next round',
  gapSub: 'avg winner − loser equip per round',
  // The card LABELS and TOOLTITS come from the metric definition now
  // (title = the catalog's label, doc = the card's Formula tooltip) —
  // the card-set migration (owner 2026-11-18) retired the hardcoded
  // label/title/no-force-buys strings with the composed cards.

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
  tableNote:
    "Equip CT/T = freeze-end gear held (never this round's spend); Loss CT/T shows that side's loss bonus as pips — five rungs from $1400 to $3400 in $500 steps.",
  tableNoteTail:
    'on the Loss cells marks those pips as calculated from the round results rather than recorded.',
};
