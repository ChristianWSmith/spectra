// Package rules holds canonical Counter-Strike 2 rule arithmetic that more
// than one layer needs. It is a leaf package (no imports beyond stdlib) so
// internal/analytics, internal/store and the root services can share it
// without an import cycle — the same reason internal/models exists.
//
// Today it owns side parity: the counted round at which each of the S
// recorded side switches happens (S=1 for a regulation MR12 match, more
// when overtime ties), following the canonical CS2 cadence — after counted
// round 12, none at OT start, then after 27 and every 3 rounds while OTs
// tie (see CS2.md "MR12 regulation + MR3 overtime"). The JavaScript twin
// lives in frontend/src/lib/sideparity.js; both are pinned to the same
// fixture (testdata/sideparity.json — see sideparity_test.go and
// frontend/src/lib/sideparity.test.js).
//
// Production callers today: rules.OtherSide (analytics.Clutches) and
// rules.StartSide (store.queryEvents' Team key — the replay filter's
// start-side identity). Every import stores round_player_sides, so data
// lacking exact per-round sides gets NO parity guess — there is no
// fallback pass. FlipIndexes/SideAt are fixture-pinned references the
// frontend twin is tested against; do not reintroduce a fallback that
// re-expresses them.
package rules

// FlipIndexes returns the 0-based indexes into a slice of n COUNTED rounds
// at which the match's side switches happen, in canonical CS2 cadence order
// (CS2.md, "MR12 regulation + MR3 overtime"): the first switch lands after
// counted round 12, there is NO switch at overtime start, and further
// switches follow after counted round 27 and every 3 rounds after that
// while the overtime blocks tie (side-switch rounds 12, 27, 30, 33, …).
// As a function of the 1-based switch index k, the boundary b(k) — the
// 0-based counted index of the FIRST round after switch k — is
//
//	b(1) = 12
//	b(k) = 27 + 3*(k-2)   for k >= 2      // 27, 30, 33, …
//
// Boundaries outside (0, n) are dropped — a match too short to reach the
// switch (or with no switch at all) yields no flip — and the result is
// ascending.
//
// Callers map an index back to a round NUMBER themselves (stored round
// numbers are dense 1..N since the knife/warmup discard — see
// extract.agg.renumber), e.g. halfSwitchRound = rounds[idx(1)].Number.
//
// Frontend twin: flipIndexes in frontend/src/lib/sideparity.js.
func FlipIndexes(n, switches int) []int {
	if n <= 0 || switches <= 0 {
		return nil
	}
	out := make([]int, 0, switches)
	for k := 1; k <= switches; k++ {
		idx := 12 // switch 1: after counted round 12 (index 12)
		if k >= 2 {
			idx = 27 + 3*(k-2) // no switch at OT start; every 3 rounds after 27
		}
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

// StartSide returns the side a player/team OPENED the match on: their
// final side flipped once per recorded side switch — i.e. flipped iff
// the SWITCH COUNT IS ODD (every switch swaps both teams, so an even
// count returns them to their opening sides; zero keeps the final side).
// This is the era-0 form of SideAt and the Go twin of frontend
// sideparity.js startSideFor/sideInEra (flips = |switches| % 2, with the
// negative-count guard normalized to zero exactly like the JS
// max(1, s+1) era math), so the team-identity colors and the replay's
// Team filter key resolve the SAME start side from the same rule — the
// parity lives HERE, never re-expressed in a caller's SQL. Unknown sides
// ("", "CT", anything but ct/t) stay "" — missing data never gets a
// guessed identity.
func StartSide(finalSide string, switches int) string {
	if finalSide != "ct" && finalSide != "t" {
		return ""
	}
	if switches < 0 {
		switches = 0 // the JS twin's max(1, s+1) normalizes negatives to "no flip"
	}
	if switches%2 == 1 {
		return OtherSide(finalSide)
	}
	return finalSide
}
