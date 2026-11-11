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
//   - internal/store/analytics.go   — GetCombatStats / RebuildCareer SQL,
//     plus the profile queries (CountPlayerTradeOpportunities,
//     GetPlayerSideSplits, GetPlayerMatchAverages)
//   - profileservice.go             — career opening rate, profile Trade
//     rate (trades ÷ trade opportunities) and the per-match averages
//   - internal/extract/agg.go       — entry/opening/trade attribution
//   - internal/analytics/engagements.go — opening|trade|untraded kinds

// The glossary Settings renders (Settings → Metric definitions). Every
// entry is {term, inferred, text}; `inferred` drives the badge chip.
export const GLOSSARY = [
  {
    term: 'KAST%',
    inferred: false,
    text: 'Share of rounds where the player recorded a Kill, an Assist, was Traded after their death, or Survived the round. Counted per round; the “traded” part follows the configured trade window (Settings → Analysis rules).',
  },
  {
    term: 'Trade window',
    inferred: false,
    text: 'Seconds after a death during which a teammate’s kill counts as a trade (default 5 s, configurable under Analysis rules; saving gives the rules a new version number — matches keep the numbers they were calculated with until you re-run them). Every trade surface follows the window of its re-run: KAST “traded”, the engagement trade and untraded rows, and the trade-kills total — recalculated by the analytics pass from the configured window — which feeds the scoreboard Trade column, career trades, profile Trade rate, the successful-trades stat and the Combat tab Trade rate.',
  },
  {
    term: 'Buy types (full / force / eco / save / pistol / bonus)',
    inferred: false,
    text: 'Derived per side from the round-start equipment value against the configured thresholds (full buy ≥ ecoFullBuy, force ≥ ecoForce, below that = eco/save), plus pistol detection by round number and side-switch pattern, and bonus/save by spend behaviour. Each round keeps its label and the exact rule that produced it — hover a round chip to see it.',
  },
  {
    term: 'Loss bonus (reconstructed)',
    inferred: true,
    text: 'A team’s loss-bonus money is worked out from the round results instead of read straight from the game, so it carries the inferred badge. The base amounts follow the game rules, not a configurable threshold.',
  },
  {
    term: 'Equipment value',
    inferred: false,
    text: 'Freeze-time-end value of the gear a side actually holds: every weapon — including ones picked up and carried over from earlier rounds — plus armor, grenades and the defuse kit, as recorded by the game’s own per-player equipment value. It is never this round’s spend, so a team that survives with a stolen rifle shows that rifle’s value next round.',
  },
  {
    term: 'Net worth',
    inferred: false,
    text: 'Equipment value plus that team’s unspent money at freeze time end: the total value the team holds at that instant — every weapon, armor, grenade and defuse kit its players carry (the free spawn-issued default sidearms included, since the game counts them at $200 each — see Equipment value) plus the cash it can still spend. It can never be below equipment value, because unspent money is never negative. The economy chart’s Net worth plots this per team per round — on a pistol round each side reads its starting money ($4000 = 5 × $800) plus the free default sidearms it still holds, so a side that dropped or upgraded some of them reads less than an opponent that kept all five.',
  },
  {
    term: 'Trade opportunities missed (inferred)',
    inferred: true,
    text: 'A death that went unanswered: no teammate of the dead player killed their killer within the trade window after the death, AND at the death tick a living teammate of the victim stood within the trade-opportunity distance of the killer — close enough to actually trade him. The distance is measured for each kill when the demo is imported (nearest living teammate to the killer’s position) and gated against the configurable threshold (Settings → Analysis rules, default 1000 units ≈ 25 m — the ground a player covers inside the default 5 s trade window, and the range trades actually happen at): a death with no living teammate nearby, or with no position data for the kill, does not count. The Combat tab’s Untraded deaths reads the same engagement rows without the distance gate.',
  },
  {
    term: 'Damage conversion',
    inferred: false,
    text: 'Share of a player’s dealt damage that contributed to a kill by that player (damage preceding a kill in the same engagement), counted from the demo’s events rather than reported by the game.',
  },
  {
    term: 'ADR',
    inferred: false,
    text: 'Average damage per round = total damage ÷ rounds played, across this player’s rounds. Friendly-fire damage is reported separately in the Combat tab.',
  },
  {
    term: 'Consistency σ',
    inferred: false,
    text: 'How much this player’s ADR moves from match to match — lower means steadier. Shown as “ADR ± σ” on profiles. It is not a margin of error.',
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
// (round_economy.money_sampled_sum → EconomyRow.Money*). The canonical
// formulas live in lib/econ.js and are pinned by lib/econ.test.js — net
// worth can never fall below equipment value. round_economy.free_pistol_value
// → EconomyRow.FreePistol* records the free spawn-issued default-pistol
// value held at that same freeze end (granted, not bought, see CS2.md
// "Free spawn-issued default pistol"); it is stored for reference and is
// deliberately NOT subtracted — subtracting it pushed net worth below
// equipment value on every side holding less cash than the granted
// pistols it still had.
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
  'Entry rate — entry kills ÷ rounds played, as a percent of rounds played (0–100): the share of rounds where this player drew first blood.';

// Trade% (Combat scoreboard column) — same formula AND scale as the
// store.GetCombatStats row it renders: 100 × player_stats.trade_kills /
// the player's OWN deaths (a trade kill answers a teammate's death inside
// the trade window; the denominator is the player's own deaths, so the
// rate is not a share of teammate deaths). It is a ratio rather than a
// share, so it may exceed 100 — rendered by fmtPercent like every other
// percent field. The player profile's Trade rate uses a DIFFERENT
// denominator (trade opportunities, not own deaths) — see
// PROFILE_TRADE_DEF; the two are deliberately no longer the same card.
export const TRADE_DEF =
  'Trade rate — trade kills ÷ deaths, as a percent: a trade kill answers a teammate’s death inside the trade window and the deaths counted are this player’s own, so it’s a ratio, not a share — it can top 100%.';

// Trade rate (profile card) — trades ÷ TRADE OPPORTUNITIES, career-wide.
// The denominator is store.CountPlayerTradeOpportunities: a teammate
// death the player was still alive for (no death event of his own in that
// round at or before the tick) whose kill event's nearDist — the nearest
// living teammate of the victim to the killer at the death tick, measured
// once at import by extract.nearTeammateDist (-1 = nobody measurable) —
// falls within the configured trade-opportunity distance. Both sides are
// career-wide (numerator: player_stats.trade_kills via the career
// rollup), and the rate is a ratio, not a share.
export const PROFILE_TRADE_DEF =
  'Trade rate — successful trades ÷ trade opportunities, as a percent: a trade kill answers a teammate’s death inside the trade window. A trade opportunity is a teammate’s death you could have answered — you were still alive in that round, and at the death tick a living teammate of the victim stood within the trade-opportunity distance of the killer (the distance is measured for each kill at import — nobody nearby = not counted — and the gate is team-level). Counted across every match in the library; it’s a ratio, so it can top 100%.';

// Per-match averages (profile cards) — player_stats counters averaged over
// the player's matches (one player_stats row per match), not career sums.
export const AVG_FLASHED_DEF =
  'Average enemies flashed per match — counted across this player’s matches: one credit per enemy player blinded by their flash (team and self blinds excluded).';

export const AVG_UTIL_DEF =
  'Average utility damage per match — counted across this player’s matches: damage credited to the player from CS2’s utility set (HE, flashbang, smoke, molotov/incendiary, decoy).';

// Untraded deaths (Combat): engagement rows of kind=untraded with the
// player as victim — no teammate of the victim killed the victim’s killer
// inside the trade window (internal/analytics/engagements.go).
export const UNTRADED_DEF =
  'Untraded deaths — deaths with no teammate kill inside the trade window afterwards.';

// Opening duel win rate (profile career). Verified: OpeningRate =
// 100 × career.OpenerWins / career.Openings where RebuildCareer sums
// player_stats.opening_kills and (opening_kills + opening_deaths) — the
// extractor’s first-blood columns, NOT the engagement detector.
export const OPENING_DEF =
  'Opening duel win rate — opening kills ÷ (opening kills + opening deaths), added up across all of this player’s matches.';

// ADR ± σ (profile header cell) — the Consistency σ glossary entry read as
// a one-line tooltip.
export const ADR_SIGMA_DEF =
  'ADR ± σ — average damage per round plus a second number showing how much ADR varies match to match — lower = more consistent.';

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
// (models.go), so it is deliberately absent. Wording is PERSPECTIVE-
// explicit (killer side / victim side): one kill can carry two of these
// facts at once (Combat merges a kill's rows into ONE row), so each
// title reads as a statement about the kill from its own side rather
// than as a row label — the chip text stays the short kind name, the
// title says whose fact it is.
export const ENG_KIND_TITLES = {
  opening: 'opening duel — first kill of the round (killer side)',
  trade: 'This kill answered a teammate’s death within the trade window (killer side)',
  untraded: 'Nobody answered this death within the trade window (victim side)',
};
