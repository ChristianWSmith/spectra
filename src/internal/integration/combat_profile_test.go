package integration_test

// Golden-demo acceptance for the two profile/combat read models this
// package's fixtures do not cover end-to-end: the Combat tab's
// distance-gated "Missed trades" column (analysis_config default) and
// the profile's per-weapon headshots / K-D surfaces. Both assertions are
// regressions guards for "the value is silently 0 for everyone".

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"testing"

	"github.com/klauspost/compress/zstd"

	"github.com/ChristianWSmith/spectra/internal/analytics"
	"github.com/ChristianWSmith/spectra/internal/extract"
	"github.com/ChristianWSmith/spectra/internal/metrics"
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// parseGolden parses the zstd golden demo (skip-if-absent, like TestGolden).
func parseGolden(t *testing.T) *models.ExtractedMatch {
	t.Helper()
	f, err := os.Open(demoPath) //nolint:gosec // path is the fixed repo-root golden demo
	if err != nil {
		t.Fatalf("open golden demo: %v", err)
	}
	defer func() { _ = f.Close() }()
	head := make([]byte, len(zstdMagic))
	if _, err := io.ReadFull(f, head); err != nil {
		t.Fatalf("sniff demo magic: %v", err)
	}
	reader := io.MultiReader(bytes.NewReader(head), f)
	if bytes.Equal(head, zstdMagic[:]) {
		zr, zerr := zstd.NewReader(reader)
		if zerr != nil {
			t.Fatalf("zstd.NewReader: %v", zerr)
		}
		defer zr.Close()
		reader = zr
	}
	m, err := extract.Parse(context.Background(), reader, extract.ParseOptions{})
	if err != nil {
		t.Fatalf("extract.Parse: %v", err)
	}
	return m
}

// TestGoldenCombatProfileSurfaces runs the full extract → store →
// analytics pipeline on the golden demo and pins the read models the
// profile/combat views render:
//
//   - TradeOppMissed must be a strict, non-empty subset of UntradedDeaths
//     for EVERY player at the default trade-opportunity distance (the
//     metric degenerated to all-zero when the gate radius sat inside the
//     range where teammates trade automatically).
//   - The folded per-weapon headshots must equal player_stats.headshots
//     per player (same eligibility extract used to credit them).
//   - The profile trend series kd/hs must be non-zero — the values are
//     the STORED match-scope metric rows since dogfooding W3 (design
//     §3.5's D13 conversion), so the sweep runs above before the read.
func TestGoldenCombatProfileSurfaces(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping golden-demo parse in -short mode")
	}
	if skip, reason := shouldSkip(demoPath); skip {
		t.Skip(reason)
	}
	m := parseGolden(t)

	st, err := store.Open(t.TempDir() + "/combat-profile.db")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer func() { _ = st.Close() }()
	id, err := st.CreateMatchRow("golden-cp", "sha-golden-cp", 0)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	if err := st.SaveExtracted(id, m); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	// The seeded default is the calibration under test — do not SetConfig.
	// Production always passes the stored config row into Compute
	// (library.analyze, RecomputeAnalysis): mirror that here so the
	// analyze-time trade-opp gate runs under the seeded radius.
	seeded, err := st.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	if seeded.TradeOppDistance != store.DefaultConfig.TradeOppDistance {
		t.Fatalf("stored trade_opp_distance = %d, want the %du default",
			seeded.TradeOppDistance, store.DefaultConfig.TradeOppDistance)
	}
	cfg := analytics.ConfigFrom(seeded, 0)
	if err := analytics.Compute(st, id, cfg); err != nil {
		t.Fatalf("analytics.Compute: %v", err)
	}
	// The profile trend reads the STORED match-scope metric rows since
	// dogfooding W3 (design §3.5's D13 conversion), so the sweep
	// production runs in the import/analyze job body has to run here too
	// — without it the trend would honestly read an empty series and the
	// kd/hs assertions below could never see a value.
	if _, err := metrics.Sweep(context.Background(), st, nil); err != nil {
		t.Fatalf("metrics.Sweep: %v", err)
	}

	stats, err := st.GetCombatStats(id)
	if err != nil {
		t.Fatalf("GetCombatStats: %v", err)
	}
	if len(stats) == 0 {
		t.Fatal("no combat rows")
	}
	var oppTotal, untradedTotal int
	for _, r := range stats {
		oppTotal += r.TradeOppMissed
		untradedTotal += r.UntradedDeaths
		if r.TradeOppMissed <= 0 {
			t.Errorf("player %s: tradeOppMissed = 0 (untraded %d) — gated metric degenerated",
				r.Name, r.UntradedDeaths)
		}
		if r.TradeOppMissed > r.UntradedDeaths {
			t.Errorf("player %s: tradeOppMissed %d > untradedDeaths %d",
				r.Name, r.TradeOppMissed, r.UntradedDeaths)
		}
	}
	if oppTotal == 0 || oppTotal >= untradedTotal {
		t.Errorf("trade opp total = %d of %d untraded deaths, want a non-empty strict subset",
			oppTotal, untradedTotal)
	}
	if oppTotal < untradedTotal/4 {
		t.Errorf("trade opp total = %d of %d untraded deaths — gate admits under a quarter",
			oppTotal, untradedTotal)
	}
	t.Logf("trade opp missed: %d of %d untraded deaths across %d players", oppTotal, untradedTotal, len(stats))

	// Per-weapon headshots: the folded JSON must reproduce the headshots
	// extract credited to player_stats for every player.
	board, err := st.GetScoreboard(id, "name", false)
	if err != nil {
		t.Fatalf("GetScoreboard: %v", err)
	}
	anyWeaponHS := 0
	for _, p := range board {
		rows, err := st.GetPlayerWeaponJSONs(p.SteamID)
		if err != nil {
			t.Fatalf("GetPlayerWeaponJSONs(%s): %v", p.SteamID, err)
		}
		sum := 0
		for _, r := range rows {
			if r.HeadshotsByWeapon == "" {
				continue
			}
			var m map[string]int
			if err := json.Unmarshal([]byte(r.HeadshotsByWeapon), &m); err != nil {
				t.Fatalf("player %s: headshots JSON %q: %v", p.Name, r.HeadshotsByWeapon, err)
			}
			for _, n := range m {
				sum += n
			}
		}
		anyWeaponHS += sum
		if sum != p.Headshots {
			t.Errorf("player %s: folded per-weapon headshots = %d, player_stats.headshots = %d",
				p.Name, sum, p.Headshots)
		}
		if sum > p.Kills {
			t.Errorf("player %s: folded headshots %d > kills %d", p.Name, sum, p.Kills)
		}
	}
	if anyWeaponHS == 0 {
		t.Error("no per-weapon headshots derived for any player")
	}

	// Profile trend series: kd and hs must be non-zero for every player.
	for _, p := range board {
		for _, metric := range []string{"kd", "hs"} {
			pts, err := st.GetTrend(p.SteamID, metric)
			if err != nil {
				t.Fatalf("GetTrend(%s, %s): %v", p.Name, metric, err)
			}
			if len(pts) == 0 {
				t.Errorf("player %s: empty %s trend", p.Name, metric)
				continue
			}
			for _, pt := range pts {
				if pt.Value <= 0 {
					t.Errorf("player %s: %s trend value = %v, want > 0", p.Name, metric, pt.Value)
				}
			}
		}
	}
}
