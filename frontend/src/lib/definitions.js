// Canonical metric definitions (D5): ONE source for the Settings →
// Metric definitions glossary and for every hover tooltip the match views
// render. Views import from here instead of each keeping its own
// paraphrase.
//
// Wording rules (Settings' glossary header): generic where the exact
// rule is configurable; every rule set is versioned via
// analysis_config/rule_version.
//
// Verified against the Go side:
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
    text: 'Share of rounds where the player recorded a Kill, an Assist, was Traded after their death, or Survived the round. Stored per player-round (player_round_stats); the “traded” part follows the configured trade window (Settings → Analysis rules).',
  },
  {
    term: 'Trade window',
    inferred: false,
    text: 'Seconds after a death during which a teammate’s kill counts as a trade (default 5 s, configurable under Analysis rules; saving bumps rule_version — stored rows keep the version they were computed with until you run a recompute). Every trade surface follows the window of its recompute: KAST “traded”, the engagement trade and untraded rows, and player_stats.trade_kills — recomputed by the analytics pass from the configured window — which feeds the scoreboard Trade column, career trades, profile Trade rate, the successful-trades metric and the Combat tab Trade rate.',
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
    term: 'Equipment value',
    inferred: false,
    text: 'Freeze-time-end value of the gear a side actually holds: every weapon — including ones picked up and carried over from earlier rounds — plus armor, grenades and the defuse kit, as recorded by the game’s own per-player equipment value. It is never this round’s spend, so a team that survives with a stolen rifle shows that rifle’s value next round.',
  },
  {
    term: 'Net worth',
    inferred: false,
    text: 'Team equipment value plus that team’s unspent money at freeze time end, minus the free spawn-issued default pistols its players still hold (issued free at spawn, never paid for, yet counted in equipment value at $200 each): what the team holds in gear it actually bought plus the cash it can still spend. The economy chart’s Net worth metric plots this per team per round — on a pistol round both sides read exactly their starting money ($4000 = 5 × $800).',
  },
  {
    term: 'Trade opportunities missed (inferred)',
    inferred: true,
    text: 'A death that went unanswered: no teammate of the dead player killed their killer within the trade window after the death, AND at the death tick a living teammate of the victim stood within the trade-opportunity distance of the killer — close enough to actually trade him. That distance is measured once per kill at import (nearest living teammate to the killer’s position) and gated against the configurable threshold (Settings → Analysis rules, default 1000 units ≈ 25 m — the ground a player covers inside the default 5 s trade window, and the range trades actually happen at): a death with no living teammate nearby, or with no position data for the kill, does not count. The Combat tab’s Untraded deaths metric reads the same engagement rows without the distance gate.',
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

// Economy tab (chart metric titles / table column headers). Verified:
// equipment value is the game's freeze-time-end per-player equipment
// summed per side (internal/extract/handlers.go →
// Team.FreezeTimeEndEquipmentValue, stored in rounds.equip_ct/equip_t and
// round_economy.equip_value); net worth is computed frontend-side as that
// equipment value plus the sampled freeze-end unspent money
// (round_economy.money_sampled_sum → EconomyRow.Money*) minus the side's
// free spawn-issued default-pistol value
// (round_economy.free_pistol_value → EconomyRow.FreePistol*) — granted,
// not bought, see CS2.md "Free spawn-issued default pistol".
export const EQUIP_DEF = `Equipment value — ${lowerFirst(glossaryText('Equipment value'))}`;

export const NETWORTH_DEF = `Net worth — ${lowerFirst(glossaryText('Net worth'))}`;

// --- Tooltips with no glossary entry ----------------------------------------

// Entry% (Combat scoreboard column). Verified: EntryRate =
// 100 × player_stats.entry_kills / rounds_played — entry_kills is the
// extractor's first-blood attribution (internal/extract/agg.go: at most
// one first blood exists per round, so the percent stays within 0..100),
// NOT the engagement detector (internal/analytics/analytics.go defers the
// entry kind). Percent scale: 0..100, like every other *Pct/*Rate field
// the views hand to fmtPercent (store.GetCombatStats).
export const ENTRY_DEF =
  'Entry rate — entry kills ÷ rounds played, as a percent of rounds played (0–100): the share of rounds in which the player drew first blood (player_stats.entry_kills: the extractor’s first-blood attribution for the round).';

// Trade% (Combat) and the profile's career trade rate — same formula AND
// scale on both sides: 100 × player_stats.trade_kills / deaths (a trade
// kill answers a teammate's death inside the trade window; the
// denominator is the player's own deaths, so the rate is not a share of
// teammate deaths). It is a ratio rather than a share, so it may exceed
// 100 — rendered by fmtPercent like every other percent field.
export const TRADE_DEF =
  'Trade rate — trade kills ÷ deaths, as a percent: a trade kill answers a teammate’s death inside the trade window and the denominator is the player’s own deaths (player_stats), so this is a ratio rather than a share and can exceed 100%.';

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

// Engagement distance (Combat's engagement deep-dive "Dist (m)" column).
// The value is the game's own player_death `distance` field (demoinfocs
// events.Kill.Distance → stored events.distance → engagements.distance),
// which measures the killer↔victim distance in METRES, not world units:
// on the golden demo |attackerPos − victimPos| ÷ distance averages 39.45
// and is exactly 39.37 at the median — the 39.37 world units per metre
// conversion (CS2.md "World units ↔ meters, and player movement speeds").
export const ENG_DIST_DEF =
  'Engagement distance — how far the killer stood from the victim when the kill happened, in metres (the game’s own player_death distance field; 1 m ≈ 39.37 world units).';

// Engagement-kind chips (Combat's engagement deep-dive). Only the kinds
// analytics/engagements.go produces live here — "entry" is deferred
// (models.go), so it is deliberately absent.
export const ENG_KIND_TITLES = {
  opening: 'opening duel — first kill of the round',
  trade: 'trade — kill inside the trade window after a teammate died',
  untraded: 'untraded death — neither side answered inside the trade window',
};
