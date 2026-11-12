package analytics

// Write-path contract for the stored per-side buy classes
// (round_side_classes): Compute writes them on a FRESH pass, the
// ComputeForBatch twin writes them too (shared body — only the career
// rebuild differs), a zero-round match writes NO rows, and a re-run under
// different thresholds rewrites the rows (delete-then-insert leaves no
// stale class behind).

import (
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// ecoSideClasses reads the stored per-side classes of one round through
// store.GetEconomy (the only public surface for them).
func ecoSideClasses(t *testing.T, st *store.Store, matchID int64, round int) (ct, tCls string) {
	t.Helper()
	rows, err := st.GetEconomy(matchID)
	if err != nil {
		t.Fatalf("GetEconomy: %v", err)
	}
	for _, r := range rows {
		if r.Round == round {
			return r.ClassCT, r.ClassT
		}
	}
	t.Fatalf("round %d missing from the economy view", round)
	return "", ""
}

// ecoCfg is the fixture's rules input at the given thresholds.
func ecoCfg(full, force int) models.AnalysisConfig {
	return models.AnalysisConfig{
		TradeWindowS: 5, EcoFullBuy: full, EcoForce: force,
		TradeOppDistance: 1000, RuleVersion: 1,
	}
}

// TestComputeWritesSideClasses: a fresh Compute stores both sides of
// every counted round, the batch twin stores the same rows, and a
// zero-round match stores none.
func TestComputeWritesSideClasses(t *testing.T) {
	st, id := seedEcoMatch(t, ecoCfg(20000, 10000))

	// Fresh compute (seedEcoMatch ran it): round 3 CT is a full buy, T an
	// eco — the hand-computed pins from the fixture matrix.
	if ct, tc := ecoSideClasses(t, st, id, 3); ct != "full" || tc != "eco" {
		t.Errorf("round 3 classes after fresh Compute = %q/%q, want full/eco", ct, tc)
	}
	// The batch twin shares the body: re-running through ComputeForBatch
	// rewrites the same rows (idempotent — replace, never append).
	if err := ComputeForBatch(st, id, ConfigFrom(ecoCfg(20000, 10000), 0)); err != nil {
		t.Fatalf("ComputeForBatch: %v", err)
	}
	if ct, tc := ecoSideClasses(t, st, id, 3); ct != "full" || tc != "eco" {
		t.Errorf("round 3 classes after batch Compute = %q/%q, want full/eco (same write path)", ct, tc)
	}

	// A zero-round match (bare lifecycle row, no extract) writes NOTHING:
	// its economy view is empty, so no class can ever be fabricated.
	bare, err := st.CreateMatchRow("/d/bare-eco.dem", "sha-bare-eco", 1)
	if err != nil {
		t.Fatalf("CreateMatchRow(bare): %v", err)
	}
	if err := Compute(st, bare, ConfigFrom(ecoCfg(20000, 10000), 0)); err != nil {
		t.Fatalf("Compute(zero rounds): %v", err)
	}
	rows, err := st.GetEconomy(bare)
	if err != nil {
		t.Fatalf("GetEconomy(bare): %v", err)
	}
	if len(rows) != 0 {
		t.Errorf("bare match economy rows = %d, want 0", len(rows))
	}
}

// TestComputeSideClassesFollowThresholds: a re-run under other
// thresholds rewrites the stored classes to the new rules — growing back
// after a narrowed run proves delete-then-insert leaves no stale class
// (the read-side of this loop: analyticservice's
// TestEcoThresholdChangeRecomputesStoredClasses, which drives it through
// SetConfig's bump → behind → re-run).
func TestComputeSideClassesFollowThresholds(t *testing.T) {
	st, id := seedEcoMatch(t, ecoCfg(20000, 10000))

	for _, tc := range []struct {
		full, force   int
		wantCT, wantT string // round 3 classes at these thresholds
	}{
		// CT 24000 / T 3000 in round 3.
		{20000, 10000, "full", "eco"},
		{30000, 10000, "force", "eco"}, // full line above 24000 → CT drops to force
		{24000, 10000, "full", "eco"},  // CT exactly AT the full line again
		{20000, 3000, "full", "force"}, // T's 3000 sits exactly ON the narrowed force line
	} {
		if err := Compute(st, id, ConfigFrom(ecoCfg(tc.full, tc.force), 0)); err != nil {
			t.Fatalf("Compute(@%d/%d): %v", tc.full, tc.force, err)
		}
		if ct, tc2 := ecoSideClasses(t, st, id, 3); ct != tc.wantCT || tc2 != tc.wantT {
			t.Errorf("round 3 classes @%d/%d = %q/%q, want %q/%q (stored rows must follow the thresholds)",
				tc.full, tc.force, ct, tc2, tc.wantCT, tc.wantT)
		}
	}
}
