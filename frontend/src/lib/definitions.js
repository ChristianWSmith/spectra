// Canonical metric definitions (D5): ONE source for the Settings →
// Metric definitions glossary and for every hover tooltip the match views
// render. Views import from here instead of each keeping its own
// paraphrase — Combat even used to carry a "keep in sync with Settings"
// comment, which this file replaces with the actual sync.
//
// Wording rules (from Settings' original header): generic where the exact
// rule is configurable; every rule set is versioned via
// analysis_config/rule_version.
//
// Verified against the Go side before this consolidation:
//   - internal/analytics/combat.go  — the CombatStats definition table
//   - internal/store/analytics.go   — GetCombatStats / RebuildCareer SQL
//   - profileservice.go             — career opening/trade rates
//   - internal/extract/agg.go       — entry/opening/trade attribution
//   - internal/analytics/engagements.go — opening|trade|untraded kinds

// The glossary Settings renders (Settings → Metric definitions). Every
// entry is {term, inferred, text}; `inferred` drives the badge chip.
export const GLOSSARY = [
  {
    term: 'KAST%',
    inferred: false,
    text: 'Share of rounds where the player recorded a Kill, an Assist, was Traded after their death, or Survived the round. Stored per player-round (player_round_stats); the “traded” part follows the trade window from analysis_config / rule_version.',
  },
  {
    term: 'Trade window',
    inferred: false,
    text: 'Seconds after a death during which a teammate’s kill counts as a trade (default 5 s, configurable under Analysis rules). Trade rate, trade opportunities and untraded deaths all use this window. Changing it bumps rule_version.',
  },
  {
    term: 'Buy classes (full / force / eco / save / pistol / bonus)',
    inferred: false,
    text: 'Derived per side from the round-start equipment value against the configured thresholds (full buy ≥ ecoFullBuy, force ≥ ecoForce, below that = eco/save), plus pistol detection by round number and side-switch pattern, and bonus/save by spend behaviour. Each round stores its label, explanation and rule_version — hover a round chip for the exact rule text that produced it.',
  },
  {
    term: 'Loss bonus (reconstructed)',
    inferred: true,
    text: 'A team’s loss-bonus money is reconstructed from consecutive round losses rather than read from a raw net message, so it is labelled reconstructed/inferred (fact/inference badge). The base amounts follow the game rules, not a configurable threshold.',
  },
  {
    term: 'Trade opportunities missed (inferred)',
    inferred: true,
    text: 'Heuristic v1: a player died while a living teammate was near and alive within the trade window but did not kill the attacker in time. It is an inference from positions/timing, not a demo fact — treat counts as indicative.',
  },
  {
    term: 'Damage conversion',
    inferred: false,
    text: 'Share of a player’s dealt damage that contributed to a kill by that player (damage preceding a kill in the same engagement), derived from stored events rather than reported by the game.',
  },
  {
    term: 'ADR',
    inferred: false,
    text: 'Average damage per round = total damage ÷ rounds played, from the player aggregates (player_stats). Friendly-fire damage is reported separately in the Combat tab.',
  },
  {
    term: 'Consistency σ',
    inferred: false,
    text: 'Standard deviation of per-match ADR across a player’s match history, shown as “ADR ± σ” on profiles: a spread, not an error bar. Lower σ = steadier performance (PRD §5.13).',
  },
];

// glossaryText pulls an entry's body so a tooltip and the glossary entry
// it explains can never drift apart again. lowerFirst keeps the derived
// tooltip reading naturally after its "Term — " prefix (the glossary
// entries are complete sentences).
function glossaryText(term) {
  const entry = GLOSSARY.find((d) => d.term === term);
  return entry ? entry.text : '';
}

function lowerFirst(s) {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

// --- Tooltips whose concept has a glossary entry (derived, not copied) ------

export const KAST_DEF = `KAST% — ${lowerFirst(glossaryText('KAST%'))}`;

export const DMG_CONV_DEF = `Damage conversion — ${lowerFirst(glossaryText('Damage conversion'))}`;

export const TRADE_OPP_MISSED_DEF = `Trade opportunities missed — ${lowerFirst(glossaryText('Trade opportunities missed (inferred)'))}`;

// --- Tooltips with no glossary entry ----------------------------------------

// Entry% (Combat scoreboard column). Verified: EntryRate =
// player_stats.entry_kills / rounds_played — entry_kills is the extractor's
// first-blood attribution (internal/extract/agg.go), NOT the engagement
// detector (internal/analytics/analytics.go defers the entry kind).
export const ENTRY_DEF =
  'Entry rate — entry kills ÷ rounds played (player_stats.entry_kills: the extractor’s first-blood attribution for the round).';

// Trade% (Combat) and the profile's career trade rate — same formula on
// both sides: player_stats.trade_kills / deaths (a trade kill answers a
// teammate’s death inside the trade window; the denominator is the
// player’s own deaths, so the rate is not a share of teammate deaths).
export const TRADE_DEF =
  'Trade rate — trade kills ÷ deaths (player_stats: a trade kill answers a teammate’s death inside the trade window; the denominator is the player’s own deaths).';

// Untraded deaths (Combat): engagement rows of kind=untraded with the
// player as victim — no teammate of the victim killed the victim’s killer
// inside the trade window (internal/analytics/engagements.go).
export const UNTRADED_DEF =
  'Untraded deaths — deaths with no teammate kill inside the trade window afterwards (engagement detection).';

// Opening duel win rate (profile career). Verified: OpeningRate =
// 100 × career.OpenerWins / career.Openings where RebuildCareer sums
// player_stats.opening_kills and (opening_kills + opening_deaths) — the
// extractor’s first-blood columns, NOT the engagement detector.
export const OPENING_DEF =
  'Opening duel win rate — opening kills ÷ (opening kills + opening deaths) across matches (career rollup of the extractor’s player_stats first-blood columns).';

// ADR ± σ (profile header cell) — the Consistency σ glossary entry read as
// a one-line tooltip.
export const ADR_SIGMA_DEF =
  'ADR ± σ — average damage per round plus the standard deviation of per-match ADR across the player’s history: σ is the consistency measure (lower = steadier), not an error bar.';

// Engagement-kind chips (Combat's engagement deep-dive).
export const ENG_KIND_TITLES = {
  opening: 'opening duel — first kill of the round',
  entry: 'entry kill — first kill onto the site by the attacking side',
  trade: 'trade — kill inside the trade window after a teammate died',
  untraded: 'untraded death — neither side answered inside the trade window',
};
