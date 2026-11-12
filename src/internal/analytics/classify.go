package analytics

import (
	"fmt"
)

// buyClass classifies one side's buy for one round against the configured
// equipment thresholds (transparent-rules requirement: the why string is
// REQUIRED and is what the UI shows). Rules v1:
//
//	pistol (by half position) → "pistol"
//	equip ≥ EcoFullBuy        → "full"
//	equip ≥ EcoForce          → "force"
//	lost last round && last round was a full buy → "save"
//	else                      → "eco"
//
// prevWon/prevEquip describe this side's PREVIOUS non-warmup round (prevWon
// false + prevEquip 0 for the first round of a half/match → eco, not save).
// Anti-eco and bonus classes are deferred: v1 keeps the rule
// set minimal and documented.
//
// This is THE one implementation of the eco rule: it runs only inside the
// analyze-time pass (Classify → store.ReplaceRoundSideClasses /
// ReplaceRoundClassifications) and has NO read-time caller — the retired
// read-time fill (EconomyRows) survives as a test-only reference oracle.
func buyClass(equip int, prevWon bool, prevEquip int, cfg Config, pistol bool) (label, why string) {
	if pistol {
		return "pistol", fmt.Sprintf("half-start pistol round (equip %d)", equip)
	}
	if equip >= cfg.EcoFullBuy {
		return "full", fmt.Sprintf("equip %d ≥ full-buy threshold %d → full buy", equip, cfg.EcoFullBuy)
	}
	if equip >= cfg.EcoForce {
		return "force", fmt.Sprintf("equip %d ≥ force threshold %d → force buy", equip, cfg.EcoForce)
	}
	if !prevWon && prevEquip >= cfg.EcoFullBuy {
		return "save", fmt.Sprintf("equip %d < force threshold %d after a lost full buy (prev equip %d) → save", equip, cfg.EcoForce, prevEquip)
	}
	return "eco", fmt.Sprintf("equip %d < force threshold %d → eco", equip, cfg.EcoForce)
}

// Classify derives one stored classification per non-warmup round, plus
// the per-side classes (round_side_classes) of the SAME pass — both are
// analysis-rule outputs written by Compute under the run's config, never
// re-derived at read time (AGENTS.md "Analysis-rule derived values").
// Pistol rounds are detected by position in the non-warmup sequence
// (MR12: index % 12 == 0). Every other round's label is the buy class of
// the LOWER-equip side (ties → CT) — an "eco"/"force" round is defined by
// the weaker side; both sides' reasoning lands in the explanation.
// Confidence is always 1.0 in v1 (deterministic rules).
//
// The returned side rows are ordered round ASC, then ct before t, for a
// deterministic insert order.
func Classify(eco []RoundEconomyView, rounds []RoundInfo, cfg Config) ([]Classification, []RoundSideClass) {
	// Equip fallback: RoundInfo carries the sampled team equip; fall back
	// to the round_economy view when the round row has none.
	equipCT := map[int]int{}
	equipT := map[int]int{}
	for _, e := range eco {
		switch e.Side {
		case "ct":
			equipCT[e.Round] = e.EquipValue
		case "t":
			equipT[e.Round] = e.EquipValue
		}
	}

	real := CountedRounds(rounds)
	out := make([]Classification, 0, len(real))
	sides := make([]RoundSideClass, 0, 2*len(real))
	for idx, r := range real {
		ctEquip, tEquip := r.EquipCT, r.EquipT
		if ctEquip == 0 {
			ctEquip = equipCT[r.Number]
		}
		if tEquip == 0 {
			tEquip = equipT[r.Number]
		}
		pistol := idx%pistolEvery == 0

		var prevWonCT, prevWonT bool
		var prevEquipCT, prevEquipT int
		if idx > 0 {
			p := real[idx-1]
			prevWonCT, prevWonT = p.Winner == "ct", p.Winner == "t"
			prevEquipCT, prevEquipT = p.EquipCT, p.EquipT
			if prevEquipCT == 0 {
				prevEquipCT = equipCT[p.Number]
			}
			if prevEquipT == 0 {
				prevEquipT = equipT[p.Number]
			}
		}
		ct, ctWhy, t, tWhy := buyClassAllSides(ctEquip, tEquip, prevWonCT, prevWonT, prevEquipCT, prevEquipT, cfg, pistol)
		label := ct
		if tEquip < ctEquip {
			label = t
		}
		explanation := fmtExplanation(ctWhy, tWhy, label)
		if pistol {
			explanation = fmt.Sprintf("non-warmup round index %d (MR12 half start): %s; CT: %s; T: %s",
				idx, explanation, ctWhy, tWhy)
		}
		out = append(out, Classification{
			Round:       r.Number,
			Label:       label,
			Confidence:  1.0,
			RuleVersion: cfg.RuleVersion,
			Explanation: explanation,
		})
		sides = append(sides,
			RoundSideClass{Round: r.Number, Side: "ct", Class: ct, Why: ctWhy},
			RoundSideClass{Round: r.Number, Side: "t", Class: t, Why: tWhy},
		)
	}
	return out, sides
}
