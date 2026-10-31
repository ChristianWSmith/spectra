package analytics

import (
	"fmt"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// BuyClass classifies one side's buy for one round against the configured
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
// Anti-eco and bonus classes from plan §2.1 are deferred: v1 keeps the rule
// set minimal and documented.
func BuyClass(equip int, prevWon bool, prevEquip int, cfg Config, pistol bool) (label, why string) {
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

// Classify derives one stored classification per non-warmup round (plan M3
// §2.1). Pistol rounds are detected by position in the non-warmup sequence
// (MR12: index % 12 == 0). Every other round's label is the buy class of
// the LOWER-equip side (ties → CT) — an "eco"/"force" round is defined by
// the weaker side; both sides' reasoning lands in the explanation.
// Confidence is always 1.0 in v1 (deterministic rules).
func Classify(eco []RoundEconomyView, rounds []RoundInfo, cfg Config) []Classification {
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

	real := nonWarmupRounds(rounds)
	out := make([]Classification, 0, len(real))
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
	}
	return out
}

// EconomyRows completes the per-side buy classes on a store.GetEconomy
// result (the store cannot import analytics — documented cycle deviation —
// so ClassCT/ClassT/ClassWhy* and PistolRound are filled here). Loss
// bonus / inferred flags are already reconstructed by the store.
func EconomyRows(rows []models.EconomyRow, cfg Config) []models.EconomyRow {
	out := make([]models.EconomyRow, len(rows))
	copy(out, rows)
	for i := range out {
		r := &out[i]
		pistol := r.Label == "pistol"
		r.PistolRound = pistol
		var prevWonCT, prevWonT bool
		var prevEquipCT, prevEquipT int
		if i > 0 {
			p := out[i-1]
			prevWonCT, prevWonT = p.WonCT, p.WonT
			prevEquipCT, prevEquipT = p.EquipCT, p.EquipT
		}
		r.ClassCT, r.ClassWhyCT, r.ClassT, r.ClassWhyT =
			buyClassAllSides(r.EquipCT, r.EquipT, prevWonCT, prevWonT, prevEquipCT, prevEquipT, cfg, pistol)
	}
	return out
}
