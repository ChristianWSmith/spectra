package main

import (
	"math"
	"testing"
)

// TestWinPctCharacterization pins the profile Win% card's CURRENT
// behavior as a Phase 0 pre-image for M4 (the planned
// ratio(sum(won), count()) metric). profileservice.go computes
// WinPct = 100 * Wins / Matches as a RAW float64 — there is no
// rounding step anywhere in Go (the frontend formats the display) —
// guarded by `Matches > 0`, and a SteamID with no career row returns
// the empty profile with WinPct 0 (never NaN). The fixture's own
// fractions (1/2) are exact, so the bitwise equality against the
// formula expression below is the rounding pin: any future
// pre-rounding of the stored value breaks it.
func TestWinPctCharacterization(t *testing.T) {
	svc := newProfileFixture(t)

	// Exact fixture value: alice — 2 matches, 1 win → exactly 50.
	p, err := svc.GetProfile("100")
	if err != nil {
		t.Fatalf("GetProfile: %v", err)
	}
	if p.Matches != 2 || p.Wins != 1 {
		t.Fatalf("fixture matches/wins = %d/%d, want 2/1", p.Matches, p.Wins)
	}
	if p.WinPct != 50 {
		t.Errorf("winPct = %v, want exactly 50 (100*1/2, unrounded)", p.WinPct)
	}
	if want := 100 * float64(p.Wins) / float64(p.Matches); p.WinPct != want {
		t.Errorf("winPct = %v, want the raw formula value %v (no rounding after the division)", p.WinPct, want)
	}

	// Zero-match: a SteamID with no career row yields the empty
	// profile — WinPct stays the Go zero value 0, never NaN/Inf (the
	// Matches > 0 guard plus the ErrNotFound early return).
	empty, err := svc.GetProfile("76561198000000099")
	if err != nil {
		t.Fatalf("GetProfile (no career): %v", err)
	}
	if empty.SteamID != "76561198000000099" || empty.Name != "" || empty.Matches != 0 || empty.Wins != 0 {
		t.Errorf("empty profile = %+v, want SteamID-only zero profile", empty)
	}
	if empty.WinPct != 0 || math.IsNaN(empty.WinPct) || math.IsInf(empty.WinPct, 0) {
		t.Errorf("zero-match winPct = %v, want 0 (never NaN/Inf)", empty.WinPct)
	}
}
