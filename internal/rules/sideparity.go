// Package rules holds canonical Counter-Strike 2 rule arithmetic that more
// than one layer needs. It is a leaf package (no imports beyond stdlib) so
// internal/analytics, internal/store and the root services can share it
// without an import cycle — the same reason internal/models exists.
//
// Today it owns side parity: where the halves of a match split when the
// extractor reports N counted rounds and S side switches (MR12 regulation
// is S=1; overtime adds more). The JavaScript twin lives in
// frontend/src/lib/sideparity.js; both are pinned to the same fixture
// (testdata/sideparity.json — see sideparity_test.go and
// frontend/src/lib/sideparity.test.js).
//
// Production callers today: rules.OtherSide (analytics.Clutches). Every
// import stores round_player_sides, so data lacking exact per-round sides
// gets NO parity guess — there is no fallback pass. FlipIndexes/SideAt are
// fixture-pinned references the frontend twin is tested against; do not
// reintroduce a fallback that re-expresses them.
package rules

// FlipIndexes returns the 0-based indexes into a slice of n COUNTED rounds
// at which the match's side switches happen (k = 1..switches), from the
// canonical boundary formula
//
//	idx(k) = floor((n*k + switches) / (switches + 1))  ==  ceil(n*k / (switches + 1))
//
// i.e. the counted rounds are split into (switches + 1) as-equal-as-possible
// eras and the flips sit on the era boundaries. Boundaries outside (0, n)
// are dropped — a match too short to contain the switch (or with no switch
// at all) yields no flip — and the result is ascending.
//
// Callers map an index back to a round NUMBER themselves (round numbers are
// not dense: knife/warmup rounds take negative numbers, see
// extract.agg.renumber), e.g. halfSwitchRound = rounds[idx(1)].Number.
//
// Frontend twin: flipIndexes in frontend/src/lib/sideparity.js.
func FlipIndexes(n, switches int) []int {
	if n <= 0 || switches <= 0 {
		return nil
	}
	out := make([]int, 0, switches)
	for k := 1; k <= switches; k++ {
		idx := (n*k + switches) / (switches + 1)
		if idx > 0 && idx < n {
			out = append(out, idx)
		}
	}
	return out
}

// SideAt resolves the side a player plays in round, given their FINAL-half
// side and the round NUMBER of the first second-half round (halfSwitchRound,
// 0 = this match never switched): sides flip for every round before it and
// keep it from there on. Sides that are not "ct"/"t" are unknown and stay
// "" — an unknown side is never guessed here.
//
// Frontend twin: RoundStrip.svelte's aboveSide derivation (era-based).
func SideAt(finalSide string, halfSwitchRound, round int) string {
	if finalSide != "ct" && finalSide != "t" {
		return ""
	}
	if halfSwitchRound > 0 && round < halfSwitchRound {
		return OtherSide(finalSide)
	}
	return finalSide
}

// OtherSide returns the opposing side of "ct" | "t" ("" for anything else).
func OtherSide(side string) string {
	switch side {
	case "ct":
		return "t"
	case "t":
		return "ct"
	}
	return ""
}
