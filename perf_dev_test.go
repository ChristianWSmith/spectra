package main

import (
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/store"
)

// TestPerfServiceDevDB measures M3 service-level targets (heatmap <2 s,
// profile load <200 ms) against the developer's real data. CI skips
// (SPECTRA_DEV_DB unset).
func TestPerfServiceDevDB(t *testing.T) {
	dbPath := os.Getenv("SPECTRA_DEV_DB")
	if dbPath == "" {
		t.Skip("set SPECTRA_DEV_DB to run service perf measurements")
	}
	matchID, _ := strconv.ParseInt(os.Getenv("SPECTRA_DEV_MATCH"), 10, 64)
	if matchID == 0 {
		matchID = 1
	}
	st, err := store.Open(dbPath)
	if err != nil {
		t.Fatalf("open dev db: %v", err)
	}
	defer func() { _ = st.Close() }()

	as := &AnalyticsService{st: st}

	var t0 time.Time
	for _, kind := range []string{"presence", "kills"} {
		t0 = time.Now()
		g, err := as.GetHeatmap(matchID, kind, HeatmapFilter{RoundFrom: -1, RoundTo: -1})
		if err != nil {
			t.Fatalf("GetHeatmap(%s): %v", kind, err)
		}
		t.Logf("GetHeatmap(%s): %dx%d, %d samples, max=%.2f in %s",
			kind, g.W, g.H, g.Samples, g.Max, time.Since(t0).Round(time.Millisecond))
	}

	t0 = time.Now()
	if _, err := as.GetEconomy(matchID); err != nil {
		t.Fatalf("GetEconomy: %v", err)
	}
	t.Logf("GetEconomy: %s", time.Since(t0).Round(time.Millisecond))

	ps := &ProfileService{st: st}
	steam := os.Getenv("SPECTRA_DEV_STEAM")
	if steam == "" {
		steam = "76561198296382419"
	}
	t0 = time.Now()
	pf, err := ps.GetProfile(steam)
	if err != nil {
		t.Fatalf("GetProfile: %v", err)
	}
	t.Logf("GetProfile(%s): matches=%d ADR=%.1f KAST=%.1f in %s",
		steam, pf.Matches, pf.ADRAvg, pf.KASTPct, time.Since(t0).Round(time.Millisecond))
}
