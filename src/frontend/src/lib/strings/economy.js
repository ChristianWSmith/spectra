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
};
