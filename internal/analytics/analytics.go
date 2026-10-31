// Package analytics is the M3 computation core (plan §4): pure functions
// that derive the stored analytics rows — round classifications, KAST
// player-rounds, clutch v2 records, engagements, utility pairings, combat
// stats and the economy view — from extracted events/rounds plus the
// versioned rules config. Every function is unit-testable with synthetic
// event sets; Compute is the store orchestration (read → derive → replace
// → career rebuild).
//
// # Documented v1 limitations (plan §9 — heuristics need UI badges)
//
//   - Round label (round_classifications) is the buy class of the
//     LOWER-equip side of a non-pistol round (ties → CT); per-side classes
//     are filled into the economy view by EconomyRows/BuyClass.
//   - OT pistol rounds are not special-cased (none in the golden demo):
//     pistol = non-warmup sequence index % 12 == 0 (MR12 half starts).
//   - Per-player money_start/equip/spent stay 0: the item_equip payload
//     carries no price/cost, so per-player per-round spend is not
//     extractable (team-level equip/money live in the economy view).
//   - Engagement kinds are opening|trade|untraded; the entry kind is
//     deferred (player_stats.entry_kills from the extractor already covers
//     per-player entry attribution).
//   - TradeOppMissed = untraded deaths (inferred heuristic — no
//     position/line-of-fire opportunity scan in v1).
//   - Clutch HPLeft reconstructs from damage events after the clutch
//     start (100 - sum(dmg taken), clamped ≥ 1; 100 when no damage after
//     start) — a reconstruction, not a sampled HP value.
//   - Friendly fire uses each player's FINAL side (events carry no team).
package analytics

import (
	"fmt"
	"sort"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// Config is the versioned rules input for the analytics pass. TickRate is
// needed to convert the seconds-based windows (trade window, utility
// pairing) into ticks — Compute fills it from the match row; a value <= 0
// means 64 (CS2's fixed simulation rate). HalfSwitchRound is the round
// NUMBER of the first second-half round (0 = no side switch in this
// match): player sides are stored as final-half sides and flipped for
// rounds before it (single-switch parity — OT switching is not
// special-cased).
type Config struct {
	TradeWindowS    float64
	EcoFullBuy      int
	EcoForce        int
	RuleVersion     int
	TickRate        float64
	HalfSwitchRound int
}

// DefaultTickRate is the CS2 fixed simulation rate used when Config's is
// unset.
const DefaultTickRate = 64.0

// Type aliases: the row vocabulary lives in internal/models (store and
// analytics must both produce/consume it without an import cycle).
type (
	RoundInfo        = models.RoundInfo
	RoundEconomyView = models.RoundEconomyView
	PlayerRef        = models.PlayerRef
	Classification   = models.RoundClassification
	PlayerRound      = models.PlayerRoundStat
	Clutch           = models.Clutch
	Engagement       = models.Engagement
	UtilityEvent     = models.UtilityEvent
	CombatStat       = models.CombatStat
)

// tr returns the effective tick rate for cfg.
func (c Config) tr() float64 {
	if c.TickRate <= 0 {
		return DefaultTickRate
	}
	return c.TickRate
}

// ticks converts a seconds window into ticks (rounded, ≥ 0).
func (c Config) ticks(seconds float64) int {
	t := int(seconds*c.tr() + 0.5)
	if t < 0 {
		return 0
	}
	return t
}

// sortedEvents returns events ordered by seq (defensive copy — pure
// functions never mutate their input).
func sortedEvents(events []models.Event) []models.Event {
	out := make([]models.Event, len(events))
	copy(out, events)
	sort.SliceStable(out, func(i, j int) bool { return out[i].Seq < out[j].Seq })
	return out
}

// nonWarmupRounds filters warmup rounds, preserving number order.
func nonWarmupRounds(rounds []RoundInfo) []RoundInfo {
	out := make([]RoundInfo, 0, len(rounds))
	for _, r := range rounds {
		if !r.Warmup {
			out = append(out, r)
		}
	}
	return out
}

// teamOf builds a steamID → team map from the player refs.
func teamOf(players []PlayerRef) map[string]string {
	m := make(map[string]string, len(players))
	for _, p := range players {
		m[p.SteamID] = p.Side
	}
	return m
}

// nameOf builds a steamID → display-name map from the player refs.
func nameOf(players []PlayerRef) map[string]string {
	m := make(map[string]string, len(players))
	for _, p := range players {
		m[p.SteamID] = p.Name
	}
	return m
}

// otherTeam returns the opposing side of ct|t ("" for unknown).
func otherTeam(side string) string {
	switch side {
	case "ct":
		return "t"
	case "t":
		return "ct"
	}
	return ""
}

// pistolEvery is the non-warmup sequence stride between half-start pistol
// rounds under MR12 (indexes 0, 12, 24, …; OT not special-cased — see
// package doc).
const pistolEvery = 12

// buyClassAllSides classifies both sides of one round via BuyClass,
// returning (ctLabel, ctWhy, tLabel, tWhy).
func buyClassAllSides(equipCT, equipT int, prevWonCT, prevWonT bool, prevEquipCT, prevEquipT int, cfg Config, pistol bool) (string, string, string, string) {
	ct, ctWhy := BuyClass(equipCT, prevWonCT, prevEquipCT, cfg, pistol)
	t, tWhy := BuyClass(equipT, prevWonT, prevEquipT, cfg, pistol)
	return ct, ctWhy, t, tWhy
}

// fmtExplanation builds the stored round explanation from both sides.
func fmtExplanation(ctWhy, tWhy, label string) string {
	return fmt.Sprintf("CT: %s; T: %s; round label = %s (lower-equip side, ties → CT)", ctWhy, tWhy, label)
}
