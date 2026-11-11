package rules

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// The cross-language fixture: the SAME JSON is asserted here and by
// frontend/src/lib/sideparity.test.js (node --test), so the Go formula
// and the frontend RoundStrip (frontend/src/lib/sideparity.js) can never
// drift apart again. Go's production consumer of side parity is
// rules.OtherSide (analytics.Clutches); FlipIndexes/SideAt are pinned here
// for the frontend twin.
type sideparityCase struct {
	Rounds   int   `json:"rounds"`
	Switches int   `json:"switches"`
	Flips    []int `json:"flips"`
	Era      []int `json:"era"`
}

type sideparityFixture struct {
	Cases []sideparityCase `json:"cases"`
}

func loadSideparity(t *testing.T) sideparityFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "sideparity.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var f sideparityFixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	if len(f.Cases) == 0 {
		t.Fatal("fixture has no cases")
	}
	return f
}

// sameInts compares int slices, treating nil and empty as equal (JSON "[]"
// unmarshals to an empty non-nil slice; FlipIndexes returns nil).
func sameInts(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestFlipIndexesFixture(t *testing.T) {
	for _, tc := range loadSideparity(t).Cases {
		got := FlipIndexes(tc.Rounds, tc.Switches)
		if !sameInts(got, tc.Flips) {
			t.Errorf("FlipIndexes(%d, %d) = %v, want %v", tc.Rounds, tc.Switches, got, tc.Flips)
			continue
		}
		// The era column of the fixture is derived from the flips: era[i]
		// = #{flip <= i}. RoundStrip renders exactly this array.
		era := make([]int, tc.Rounds)
		for i := range era {
			for _, fl := range got {
				if fl <= i {
					era[i]++
				}
			}
		}
		if !reflect.DeepEqual(era, tc.Era) {
			t.Errorf("era for (%d, %d) = %v, want %v", tc.Rounds, tc.Switches, era, tc.Era)
		}
	}
}

func TestFlipIndexesGuards(t *testing.T) {
	if got := FlipIndexes(24, 0); got != nil {
		t.Errorf("no switches → %v, want nil", got)
	}
	if got := FlipIndexes(0, 1); got != nil {
		t.Errorf("no rounds → %v, want nil", got)
	}
	if got := FlipIndexes(-3, 1); got != nil {
		t.Errorf("negative rounds → %v, want nil", got)
	}
	// A switch boundary at or past the end of the match is dropped: the
	// cadence's first boundary is counted index 12 (after round 12), so a
	// match that short contains none of the reported switches.
	if got := FlipIndexes(2, 2); len(got) != 0 {
		t.Errorf("(2,2) → %v, want no flips (boundary 12 is past the end)", got)
	}
	// Boundaries are ascending and strictly inside (0, n). Expectations
	// follow the CS2.md "MR12 regulation + MR3 overtime" cadence: after
	// counted round 12, no switch at OT start, then after 27 and every 3
	// rounds (12, 27, 30, 33, …). A 34-round match with 4 switches
	// contains all four boundaries; a shorter one drops whichever fall
	// at or past its end.
	n, sw := 34, 4
	got := FlipIndexes(n, sw)
	for i := 1; i < len(got); i++ {
		if got[i] <= got[i-1] {
			t.Errorf("flips not ascending: %v", got)
		}
	}
	for _, fl := range got {
		if fl <= 0 || fl >= n {
			t.Errorf("flip %d outside (0, %d): %v", fl, n, got)
		}
	}
	// k = switches must be present for a long-enough match.
	if !sameInts(got, []int{12, 27, 30, 33}) {
		t.Errorf("(34,4) → %v, want [12 27 30 33]", got)
	}
	if len(got) != sw {
		t.Errorf("(34,4) → %d flips, want %d (%v)", len(got), sw, got)
	}
}

func TestSideAt(t *testing.T) {
	cases := []struct {
		side  string
		half  int
		round int
		want  string
	}{
		{"ct", 13, 1, "t"},   // first half: final-side CT played T
		{"t", 13, 12, "ct"},  // first half: final-side T played CT
		{"ct", 13, 13, "ct"}, // second half: final side kept
		{"t", 13, 24, "t"},
		{"ct", 0, 1, "ct"}, // no side switch in this match
		{"", 13, 1, ""},    // unknown side is never guessed
		{"x", 13, 1, ""},   // anything but ct/t is unknown
		{"t", -1, 1, "t"},  // negative halfSwitchRound = no switch
	}
	for _, tc := range cases {
		if got := SideAt(tc.side, tc.half, tc.round); got != tc.want {
			t.Errorf("SideAt(%q, %d, %d) = %q, want %q", tc.side, tc.half, tc.round, got, tc.want)
		}
	}
}

func TestOtherSide(t *testing.T) {
	if OtherSide("ct") != "t" || OtherSide("t") != "ct" {
		t.Errorf("OtherSide did not swap ct/t: %q/%q", OtherSide("ct"), OtherSide("t"))
	}
	if OtherSide("") != "" || OtherSide("CT") != "" {
		t.Errorf("OtherSide must return \"\" for unknown input")
	}
}

// TestStartSide pins the start-side identity against the JS twin
// (sideparity.js startSideFor — the era-0 form of sideInEra): a team's
// opening side is its final side flipped ONCE PER SWITCH — odd counts
// flip, even counts (and zero) do not — and unknown sides stay unknown.
// store.queryEvents' Team key resolves through this, so the parity
// lives here rather than in any caller's SQL.
func TestStartSide(t *testing.T) {
	cases := []struct {
		final    string
		switches int
		want     string
	}{
		{"ct", 0, "ct"}, // no switch: final side IS the opening side
		{"t", 0, "t"},
		{"ct", 1, "t"}, // one switch (regulation): flipped
		{"t", 1, "ct"},
		{"ct", 2, "ct"}, // two swaps return them to their opening sides
		{"t", 2, "t"},
		{"ct", 3, "t"}, // odd again → flipped
		{"t", 5, "ct"},
		{"", 1, ""},      // unknown final side → never guessed
		{"CT", 1, ""},    // (only the exact ct/t spellings resolve)
		{"ct", -1, "ct"}, // a negative count normalizes to "no flip" (the JS twin)
	}
	for _, tc := range cases {
		if got := StartSide(tc.final, tc.switches); got != tc.want {
			t.Errorf("StartSide(%q, %d) = %q, want %q", tc.final, tc.switches, got, tc.want)
		}
	}
}
