package analytics

// Equivalence characterization for the STORED per-side buy classes
// (round_side_classes): analytics.Compute's derivation (classify.go) must
// reproduce, field for field, the RETIRED read-time fill kept below as a
// reference oracle — legacy read-time classification, retired 2026-11-12:
//
//   - legacyEconomyRows was analytics.EconomyRows, which store.GetEconomy
//     left the five class fields empty for (ClassCT/ClassT/ClassWhyCT/
//     ClassWhyT/PistolRound) and AnalyticsService.GetEconomy /
//     report.BuildMatchData re-derived from the CURRENT analysis_config
//     on every read — the accident this closes: after a rules save the
//     Economy tab's side chips showed the NEW thresholds while the round
//     chips (stored round_classifications labels) showed the OLD ones
//     until a re-run.
//
// This is the proof that moving the classification from read time to
// analyze time changed no value: every fixture row asserts
// stored == oracle byte for byte (reflect.DeepEqual over the WHOLE
// models.EconomyRow — every field, not just the classes) at two
// threshold sets, plus hand-computed spot pins so "both sides equally
// broken" cannot pass:
//
//   - pistol by non-warmup index (stored round label drives the oracle's
//     pistol flag — classify.go's index stride and the stored label are
//     the same computation, which is exactly why they cannot disagree);
//   - full at/above EcoFullBuy, force at/above EcoForce but below full,
//     eco below force, save after a lost FULL buy (prev-round dependency),
//     eco after a WIN and after a lost non-full round;
//   - exact-boundary values (equip == threshold on both the full and the
//     force line) and the save/force precedence when the current buy
//     itself clears the force line;
//   - a 0-equip round (no freeze-end samples at all);
//   - warmup and pregame (knife) rounds excluded from BOTH the stored
//     rows and the oracle's input (CountedRounds ⋈ store.GetEconomy's SQL
//     twin), so the MR12 pistol stride cannot shift;
//   - the equip fallback can never diverge: the extractor writes
//     rounds.equip_ct and round_economy.equip_value from the SAME
//     freeze-end value (extract/agg.go), so Classify's fallback and the
//     oracle's direct read always see one number.

import (
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// legacyEconomyRows is the RETIRED read-time classification (was
// analytics.EconomyRows — legacy read-time classification, retired
// 2026-11-12). Verbatim reference oracle: it consumes exactly the rows
// store.GetEconomy returned before round_side_classes existed (the five
// class fields blank) and re-derives them from the config passed in —
// the CURRENT analysis_config, which is what made a rules save disagree
// with the stored round chips. Unexported helpers (buyClassAllSides,
// the stored label's pistol flag) are the same ones Classify uses; the
// point under test is WHERE and WHEN they run, not a second rule copy.
func legacyEconomyRows(rows []models.EconomyRow, cfg Config) []models.EconomyRow {
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

// clearStoredClasses blanks exactly the five fields the retired fill
// owned — the shape store.GetEconomy returned before this table existed,
// i.e. the oracle's input.
func clearStoredClasses(rows []models.EconomyRow) []models.EconomyRow {
	out := make([]models.EconomyRow, len(rows))
	copy(out, rows)
	for i := range out {
		out[i].ClassCT, out[i].ClassT = "", ""
		out[i].ClassWhyCT, out[i].ClassWhyT = "", ""
		out[i].PistolRound = false
	}
	return out
}

// ecoFixture is a synthetic extract covering every branch of the retired
// read-time classification (see the file comment). Round 0 is warmup and
// round 1 a pregame (knife) round — neither may reach the stored rows;
// counted rounds 2..7 follow (round 2 is the index-0 pistol).
//
// Counted-round matrix at the seeded thresholds (20000 full / 10000
// force), winner chosen per round to exercise the prev-round rule:
//
//	round 2 (idx0, pistol): CT 4000 / T 3600, winner ct → pistol/pistol
//	round 3: CT 24000 / T 3000, winner t → CT full, T eco (lost the
//	         pistol with prev equip 3600 < full → eco, NOT save)
//	round 4: CT 10000 / T 20000, winner ct → CT force (EXACT force
//	         boundary; would be save (lost full) but the current buy
//	         clears the force line first), T full (EXACT full boundary)
//	round 5: CT 5000 / T 8000, winner ct → CT eco (won the previous
//	         round), T SAVE (lost round 4 with prev equip 20000 ≥ full)
//	round 6: CT 12000 / T 6000, winner t → CT force, T eco (lost a
//	         non-full round → eco, not save)
//	round 7: CT 0 / T 0, winner "" → eco/eco (no freeze-end samples;
//	         rounds.equip_ct and round_economy.equip_value both 0)
func ecoFixture() *models.ExtractedMatch {
	type rr struct {
		number, ct, t int
		winner        string
	}
	rounds := []rr{
		{2, 4000, 3600, "ct"},
		{3, 24000, 3000, "t"},
		{4, 10000, 20000, "ct"},
		{5, 5000, 8000, "ct"},
		{6, 12000, 6000, "t"},
		{7, 0, 0, ""},
	}
	em := &models.ExtractedMatch{
		Match: models.Match{
			Path: "/d/eco-equiv.dem", SHA256: "sha-eco-equiv", Size: 1,
			Map: "de_cache", TickRate: 64, RealRounds: 6,
			ScoreCT: 4, ScoreT: 2, ParserVersion: "v6", ExtractedAt: time.Now(),
		},
		Players: []models.Player{
			{SteamID: "100", Name: "alice", Side: "ct", FinalStatePresent: true},
			{SteamID: "200", Name: "bob", Side: "t", FinalStatePresent: true},
		},
		PlayerStats: []models.PlayerStats{
			{SteamID: "100", Side: "ct", Name: "alice", RoundsPlayed: 6},
			{SteamID: "200", Side: "t", Name: "bob", RoundsPlayed: 6},
		},
		Rounds: []models.Round{
			{Number: 0, Warmup: true, StartTick: 0, EndTick: 64},
			{Number: 1, Pregame: true, StartTick: 64, EndTick: 128},
		},
	}
	for _, r := range rounds {
		em.Rounds = append(em.Rounds, models.Round{
			Number: r.number, Winner: r.winner, StartTick: r.number * 1000,
			EndTick: r.number*1000 + 999, FreezeEndTick: r.number*1000 + 32,
			EquipCT: r.ct, EquipT: r.t,
		})
		em.RoundEconomy = append(em.RoundEconomy,
			models.RoundEconomy{Round: r.number, Side: "ct", EquipValue: r.ct, MoneySamples: 5},
			models.RoundEconomy{Round: r.number, Side: "t", EquipValue: r.t, MoneySamples: 5},
		)
	}
	return em
}

// seedEcoMatch stores ecoFixture, applies cfg (SetConfig — the production
// shape: the config row and the Compute cfg are the same rules) and runs
// Compute, returning the store + match id.
func seedEcoMatch(t *testing.T, cfg models.AnalysisConfig) (*store.Store, int64) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "eco-equiv.db")
	st, err := store.Open(path)
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if _, err := st.SetConfig(cfg); err != nil {
		t.Fatalf("SetConfig: %v", err)
	}
	id, err := st.CreateMatchRow("/d/eco-equiv.dem", "sha-eco-equiv", 1)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	if err := st.SaveExtracted(id, ecoFixture()); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	if err := Compute(st, id, ConfigFrom(cfg, 0)); err != nil {
		t.Fatalf("Compute: %v", err)
	}
	return st, id
}

// TestEcoStoredMatchesLegacyReadTimeClassification is the equivalence
// proof: for every fixture round the STORED per-side rows read back
// through store.GetEconomy are byte-identical to what the retired
// read-time fill produced from the same stored facts, at the seeded
// thresholds and at a narrowed pair (so the comparison cannot pass by
// both sides ignoring the config).
func TestEcoStoredMatchesLegacyReadTimeClassification(t *testing.T) {
	cfgs := []struct {
		name        string
		full, force int
	}{
		{name: "seeded 20000/10000", full: 20000, force: 10000},
		{name: "narrowed 12000/5000", full: 12000, force: 5000},
	}
	for _, tc := range cfgs {
		t.Run(tc.name, func(t *testing.T) {
			cfg := models.AnalysisConfig{
				TradeWindowS: 5, EcoFullBuy: tc.full, EcoForce: tc.force,
				TradeOppDistance: 1000, RuleVersion: 1,
			}
			st, id := seedEcoMatch(t, cfg)
			got, err := st.GetEconomy(id)
			if err != nil {
				t.Fatalf("GetEconomy: %v", err)
			}
			if len(got) != 6 {
				t.Fatalf("economy rows = %d, want 6 (warmup 0 + pregame 1 excluded)", len(got))
			}
			// Every stored class field must actually be filled — an
			// all-empty comparison would pass vacuously.
			for _, r := range got {
				if r.ClassCT == "" || r.ClassT == "" || r.ClassWhyCT == "" || r.ClassWhyT == "" {
					t.Fatalf("round %d stored classes = %q/%q (why %q/%q), want filled",
						r.Round, r.ClassCT, r.ClassT, r.ClassWhyCT, r.ClassWhyT)
				}
				if r.RuleVersion != 1 {
					t.Errorf("round %d ruleVersion = %d, want 1", r.Round, r.RuleVersion)
				}
			}
			// The oracle runs on the pre-table row shape (class fields
			// blank) — the exact input the retired fill consumed.
			want := legacyEconomyRows(clearStoredClasses(got), ConfigFrom(cfg, 0))
			if !reflect.DeepEqual(got, want) {
				for i := range got {
					if !reflect.DeepEqual(got[i], want[i]) {
						t.Errorf("round %d:\n stored = %+v\n legacy  = %+v", got[i].Round, got[i], want[i])
					}
				}
				t.Fatalf("stored GetEconomy rows differ from the legacy read-time classification (must be byte-identical)")
			}
		})
	}
}

// TestEcoClassMatrixPins pins the stored classes by hand for the seeded
// thresholds (the equivalence above could pass if both sides shared a
// bug): every branch of buyClass, both exact boundaries, the
// save/force precedence and the counted-rounds filter.
func TestEcoClassMatrixPins(t *testing.T) {
	cfg := models.AnalysisConfig{
		TradeWindowS: 5, EcoFullBuy: 20000, EcoForce: 10000,
		TradeOppDistance: 1000, RuleVersion: 1,
	}
	st, id := seedEcoMatch(t, cfg)
	rows, err := st.GetEconomy(id)
	if err != nil {
		t.Fatalf("GetEconomy: %v", err)
	}
	byRound := map[int]models.EconomyRow{}
	for _, r := range rows {
		byRound[r.Round] = r
	}
	// (round, ct class, t class, round label, pistol?)
	want := []struct {
		round        int
		ct, t, label string
		pistol       bool
	}{
		{2, "pistol", "pistol", "pistol", true},
		{3, "full", "eco", "eco", false},
		{4, "force", "full", "force", false},
		{5, "eco", "save", "eco", false},
		{6, "force", "eco", "eco", false},
		{7, "eco", "eco", "eco", false},
	}
	for _, w := range want {
		r, ok := byRound[w.round]
		if !ok {
			t.Fatalf("round %d missing from the economy view", w.round)
		}
		if r.ClassCT != w.ct || r.ClassT != w.t {
			t.Errorf("round %d classes = %q/%q, want %q/%q", w.round, r.ClassCT, r.ClassT, w.ct, w.t)
		}
		if r.Label != w.label {
			t.Errorf("round %d label = %q, want %q (lower-equip side)", w.round, r.Label, w.label)
		}
		if r.PistolRound != w.pistol {
			t.Errorf("round %d pistolRound = %v, want %v (stored label)", w.round, r.PistolRound, w.pistol)
		}
		if r.ClassWhyCT == "" || r.ClassWhyT == "" {
			t.Errorf("round %d why strings empty (REQUIRED)", w.round)
		}
	}
	// Excluded rounds never reach the view (and never shift the stride).
	if _, ok := byRound[0]; ok {
		t.Error("warmup round 0 reached the economy view")
	}
	if _, ok := byRound[1]; ok {
		t.Error("pregame round 1 reached the economy view")
	}
	// Why strings name the thresholds (transparent rules) — spot pins on
	// the boundary rows and the save's prev-round dependency.
	if !strings.Contains(byRound[3].ClassWhyCT, "equip 24000 ≥ full-buy threshold 20000 → full buy") {
		t.Errorf("round 3 CT why = %q", byRound[3].ClassWhyCT)
	}
	if !strings.Contains(byRound[4].ClassWhyCT, "equip 10000 ≥ force threshold 10000 → force buy") {
		t.Errorf("round 4 CT why (exact force boundary) = %q", byRound[4].ClassWhyCT)
	}
	if !strings.Contains(byRound[4].ClassWhyT, "equip 20000 ≥ full-buy threshold 20000 → full buy") {
		t.Errorf("round 4 T why (exact full boundary) = %q", byRound[4].ClassWhyT)
	}
	if !strings.Contains(byRound[5].ClassWhyT, "after a lost full buy (prev equip 20000) → save") {
		t.Errorf("round 5 T why (prev-round save dependency) = %q", byRound[5].ClassWhyT)
	}
	if !strings.Contains(byRound[3].ClassWhyT, "< force threshold 10000 → eco") {
		t.Errorf("round 3 T why (eco after a lost pistol) = %q", byRound[3].ClassWhyT)
	}
	// Round 4 CT lost round 3 (a full-ish 24000 buy) but its OWN buy
	// clears the force line: force wins over save (precedence pin).
	if !strings.Contains(byRound[4].ClassWhyCT, "force buy") {
		t.Errorf("round 4 CT why must take the force branch over save: %q", byRound[4].ClassWhyCT)
	}
}
