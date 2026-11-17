package report

import (
	"context"
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/metrics"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// TestKDAZeroDeathDisplay pins the KDA cell's full display chain as a
// Phase 0 characterization (metrics-expansion ME1): the seeded `kda`
// metric as the PRODUCTION sweep computes it over seedMatch's fixture,
// read back through MetricCells, rendered by player.md. seedMatch's
// player A00 is the zero-death corner (10 kills + 1 assist, 0 deaths),
// so this pins value 11 ((10+1)/MAX(0,1) — the floored seed) AND the
// byte-identical float2 display "KDA 11.00". ME1's greatest() rewrite
// of the seed expression must keep both pins unchanged.
func TestKDAZeroDeathDisplay(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	defer func() { _ = st.Close() }()
	id := seedMatch(t, st)

	// The production compute pass — the values a real sweep stores.
	if _, err := metrics.Sweep(context.Background(), st, nil); err != nil {
		t.Fatalf("Sweep: %v", err)
	}

	// Stored kda value for the zero-death subject, straight from the
	// canonical read the report itself uses.
	kdaDef, err := st.GetMetricByName("kda")
	if err != nil {
		t.Fatalf("GetMetricByName(kda): %v", err)
	}
	values, err := st.GetMetricValuesForMatch(id, []int64{kdaDef.ID})
	if err != nil {
		t.Fatalf("GetMetricValuesForMatch: %v", err)
	}
	byID := map[string]float64{}
	for _, v := range values {
		byID[v.SteamID] = v.Value
	}
	t.Logf("stored kda values: %v", byID)
	if got := byID["A00"]; got != 11 {
		t.Errorf("kda[A00] (zero deaths) = %v, want 11 ((10+1)/MAX(0,1))", got)
	}
	if got := byID["B00"]; got != 10 {
		t.Errorf("kda[B00] (1 death) = %v, want 10 ((9+1)/MAX(1,1))", got)
	}

	// The rendered player report for the zero-death subject.
	pdata, err := BuildPlayerData(st, id, "A00")
	if err != nil {
		t.Fatalf("BuildPlayerData: %v", err)
	}
	ptpl, err := Find(Builtins(), "player.md")
	if err != nil {
		t.Fatalf("Find player.md: %v", err)
	}
	pout, err := Render(ptpl.ID, ptpl.Body, pdata)
	if err != nil {
		t.Fatalf("Render player.md: %v", err)
	}
	// The whole KDA line, byte for byte: raw halves 10/0/1 (D6: raw
	// stays raw), the kd metric's zero-death edge rendering 0.00
	// (ratio's NULLIF — Q1's RULED divergence), and the floored kda
	// rendering 11.00 (MAX(deaths,1) — the floor closes the edge for
	// KDA). This is the display ME1's greatest() rewrite must not move.
	want := "K/D/A: **10/0/1** (KD 0.00, KDA 11.00)"
	if !strings.Contains(pout, want) {
		t.Errorf("player.md missing %q:\n%s", want, pout)
	}
}
