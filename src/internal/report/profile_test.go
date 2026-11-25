package report

import (
	"testing"

	"github.com/ChristianWSmith/spectra/internal/store"
)

// TestBuildProfileDataUnknownPlayer: a player with no history gets an empty match list and a dash for
// every career value, never an error.
func TestBuildProfileDataUnknownPlayer(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	defer func() { _ = st.Close() }()
	seedMatch(t, st)

	const steam = "76561198000000001"
	rep, err := BuildProfileData(st, steam)
	if err != nil {
		t.Fatalf("BuildProfileData: %v", err)
	}
	if rep.SteamID != steam {
		t.Errorf("SteamID = %q, want %q", rep.SteamID, steam)
	}
	if len(rep.Matches) != 0 {
		t.Errorf("matches = %d, want none for a player with no rows", len(rep.Matches))
	}
	for _, name := range profileMetricNames {
		v, ok := rep.Metrics[name]
		if !ok {
			t.Errorf("metric %s missing from the profile", name)
			continue
		}
		if v != reportCellDash {
			t.Errorf("metric %s = %q, want the dash for an absent value", name, v)
		}
	}
}
