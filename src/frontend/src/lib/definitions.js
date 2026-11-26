// Canonical metric definitions (D5): ONE source for every hover tooltip
// the match views render. Views import from here instead of each keeping
// its own paraphrase.
//
// The GLOSSARY array below is the tooltip source: glossaryText() pulls
// an entry's body into the *_DEF constants (Combat, Economy,
// EconCurve). It used to double as Settings' stat-definitions glossary
// too — the card is gone (the metrics migration owns that prose now);
// every remaining entry exists because a *_DEF looks it up, and an entry
// with no lookup would be dead weight.
//
// Wording rules: generic where the exact rule is configurable (no
// version numbers here — rule versions are internal and never surfaced).
//
// Verified against the Go side:
//   - internal/store/analytics.go   — RebuildCareer SQL,
//     plus the profile queries (GetPlayerSideSplits, GetPlayerHistory)
//   - internal/extract/agg.go       — entry/opening/trade attribution
//   - internal/analytics/kill tags.go — opening|trade|traded|untraded kinds
// (The profile's Trade rate and per-match averages are metric rows now —
// career_trade_rate / career_avg_* — and W3a finished the job: the
// profile's Opening-duels rate and Clutches count are metric rows too
// (career_opening_rate / career_clutches), so their tooltips live in
// each seed's doc, not here.)

// The entries the *_DEF tooltips derive from (see glossaryText below).
// Every entry is {term, text}.
export const GLOSSARY = [
  {
    term: 'KAST%',
    text: 'Share of rounds where the player recorded a Kill, an Assist, was Traded after death, or Survived the round. The “traded” part follows the configured trade window (Settings → Analysis rules).',
  },
  {
    term: 'Equipment value',
    text: 'Freeze-time-end value of the gear a side actually holds — every weapon (picked up and carried over included), armor, grenades and the defuse kit. Never this round’s spend.',
  },
  {
    term: 'Net worth',
    text: 'Equipment value plus the team’s unspent money at freeze time end — the total the team holds then. Never below equipment value: unspent money never goes negative.',
  },
  {
    term: 'Trade opportunities missed (inferred)',
    text: 'A death nobody answered: no teammate kill inside the trade window, and at the death tick a living teammate stood within the trade-opportunity distance of the killer.',
  },
  {
    term: 'Damage conversion',
    text: 'Share of a player’s dealt damage that contributed to a kill by that player (damage preceding a kill in the same kill tag), from the demo’s events.',
  },
];

// glossaryText pulls an entry's body so a tooltip and its source entry
// can never drift apart. lowerFirst keeps the derived tooltip reading
// naturally after its "Term — " prefix (the entries are complete
// sentences). Returns '' for a term with no entry — the *_DEF constants
// below are the only lookups, pinned by their own consumers.
function glossaryText(term) {
  const entry = GLOSSARY.find((d) => d.term === term);
  return entry ? entry.text : '';
}

function lowerFirst(s) {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

// --- Tooltips whose concept has a glossary entry (derived, not copied) ------

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

// Entry% (Combat scoreboard column) — the `entry_rate` metric's tooltip
// the stored entry_kills is the extractor's first-blood
// attribution (internal/extract/agg.go: at most one first blood exists
// per round, so the percent stays within 0..100), NOT the kill tag
// detector (internal/analytics/analytics.go defers the entry kind).
// Percent scale: 0..100 — the metric stores a 0..1 fraction and the
// column renders it ×100 (fmtPercent).
// Trade% (Combat scoreboard column) — the `trade_rate_deaths` metric's
// tooltip: 100 × player_stats.trade_kills / the player's
// OWN deaths (a trade kill answers a teammate's death inside the trade
// window; the denominator is the player's own deaths, so the rate is
// not a share of teammate deaths). It is a ratio rather than a share,
// so it may exceed 100 — rendered by fmtPercent like every other
// percent field. The player profile's Trade rate uses a DIFFERENT
// denominator (trade opportunities, not own deaths — see the
// career_trade_rate metric's doc); the two are deliberately no longer
// the same card.
// Untraded deaths (Combat): kill tag rows of kind=untraded with the
// player as victim — no teammate of the victim killed the victim’s killer
// inside the trade window (internal/analytics/kill tags.go).
// Kill tag distance (Combat's kill tag deep-dive "Dist (m)" column).
// The value is the game's own player_death `distance` field (demoinfocs
// events.Kill.Distance → stored events.distance → kill tags.distance),
// which measures the killer↔victim distance in METRES, not world units:
// on the golden demo |attackerPos − victimPos| ÷ distance averages 39.45
// and is exactly 39.37 at the median — the 39.37 world units per metre
// conversion (CS2.md "World units ↔ meters, and player movement speeds").
export const KILL_TAG_DIST_DEF =
  'Kill distance — how far the killer stood from the victim when the kill happened, in metres (the game’s own player_death distance field; 1 m ≈ 39.37 world units).';

// Kill-tag-kind chips (Combat's kill tag deep-dive). Only the kinds
// analytics/kill tags.go produces live here — "entry" is deferred
// (models.go), so it is deliberately absent. Wording is PERSPECTIVE-
// explicit (killer side / victim side): one kill can carry several of
// these facts at once (Combat merges a kill's rows into ONE row), so
// each title reads as a statement about the kill from its own side rather
// than as a row label — the chip text stays the short kind name, the
// title says whose fact it is. traded/untraded are the victim-side pair
// (answered / not answered within the trade window): every kill yields
// exactly one of them.
export const KILL_TAG_KIND_TITLES = {
  opening: 'opening kill tag — first kill of the round (killer side)',
  trade: 'This kill answered a teammate’s death within the trade window (killer side)',
  traded: 'This death was answered by a teammate within the trade window (victim side)',
  untraded: 'Nobody answered this death within the trade window (victim side)',
};
