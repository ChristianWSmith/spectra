package integration_test

// Golden headline acceptance. F3 removed the
// golden playersHeadline / topPlayer check, because the headline values
// now come from the stored metric rows. This test restores the check
// against those rows: the golden demo runs through the real extract,
// store, analytics and sweep path, and each player's kills, deaths,
// assists, ADR and HS% must equal the STORED metric values.
//
// The expected rows are the golden headline the repo pinned before F3
// (donk.golden.json at a5a848f^). They were re-checked against the W0
// snapshot (spectra-verify/w0/snap, match 7 = de_cache): every kills,
// deaths, assists, ADR (1 dp) and HS% (1 dp) value agrees.

import (
	"context"
	"math"
	"path/filepath"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/analytics"
	"github.com/ChristianWSmith/spectra/internal/metrics"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// headlineRow is one player's golden headline line. ADR and HS% are
// rounded to 1 decimal in the golden; HS% is in 0..100.
type headlineRow struct {
	steamID string
	name    string
	kills   int
	deaths  int
	assists int
	adr     float64
	hsPct   float64
}

var goldenHeadline = []headlineRow{
	{"76561198296382419", "forever2kELO", 25, 14, 3, 116.9, 52.0},
	{"76561197968389863", "adamS", 20, 15, 3, 89.2, 55.0},
	{"76561198210730700", "Zuedsta", 18, 12, 6, 86.2, 66.7},
	{"76561198061660686", "llorente", 18, 17, 4, 72.5, 44.4},
	{"76561198386265483", "donk666", 18, 17, 3, 81.6, 61.1},
	{"76561198372023214", "Magnojezzz", 14, 16, 2, 62.9, 50.0},
	{"76561198050922008", "hades--", 14, 18, 2, 65.3, 42.9},
	{"76561198296417934", "kRaSnaL", 12, 17, 7, 69.4, 58.3},
	{"76561199063899602", "-meg2k", 10, 16, 3, 51.3, 60.0},
	{"76561198136696922", "FREELOOK", 10, 18, 3, 49.0, 40.0},
}

// headlineRound1 rounds to 1 decimal, the golden's stored precision.
func headlineRound1(v float64) float64 {
	return math.Round(v*10) / 10
}

// TestGoldenHeadlineMatchesStoredMetrics runs the golden demo through
// extract → store → analytics → sweep, then reads the stored kills,
// deaths, assists, adr and hs_pct rows for the match and asserts every
// golden headline value equals its stored metric value. Skipped under
// -short and when the demo is absent or an LFS pointer, like every other
// golden-demo test here.
func TestGoldenHeadlineMatchesStoredMetrics(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping golden-demo parse in -short mode")
	}
	if skip, reason := shouldSkip(demoPath); skip {
		t.Skip(reason)
	}
	m := parseGolden(t)

	st, err := store.Open(filepath.Join(t.TempDir(), "headline.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer func() { _ = st.CloseRO(); _ = st.Close() }()
	id, err := st.CreateMatchRow("golden-headline", "sha-golden-headline", 0)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	if err := st.SaveExtracted(id, m); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	seeded, err := st.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	if err := analytics.Compute(st, id, analytics.ConfigFrom(seeded, 0)); err != nil {
		t.Fatalf("analytics.Compute: %v", err)
	}
	if _, err := metrics.Sweep(context.Background(), st, nil, nil); err != nil {
		t.Fatalf("metrics.Sweep: %v", err)
	}

	// The stored headline metrics, by name → definition id.
	names := []string{"kills", "deaths", "assists", "adr", "hs_pct"}
	idByName := map[int64]string{}
	var ids []int64
	for _, n := range names {
		def, err := st.GetMetricByName(n)
		if err != nil {
			t.Fatalf("GetMetricByName(%s): %v", n, err)
		}
		idByName[def.ID] = n
		ids = append(ids, def.ID)
	}
	values, err := st.GetMetricValuesForMatch(id, ids)
	if err != nil {
		t.Fatalf("GetMetricValuesForMatch: %v", err)
	}
	stored := map[string]map[string]float64{} // steam id → metric name → value
	for _, v := range values {
		if v.Value == nil {
			continue
		}
		if stored[v.SubjectKey] == nil {
			stored[v.SubjectKey] = map[string]float64{}
		}
		stored[v.SubjectKey][idByName[v.MetricID]] = *v.Value
	}
	if len(stored) != len(goldenHeadline) {
		t.Fatalf("stored headline subjects = %d, want %d (one row per golden player)", len(stored), len(goldenHeadline))
	}

	for _, want := range goldenHeadline {
		got, ok := stored[want.steamID]
		if !ok {
			t.Errorf("%s (%s): no stored headline rows", want.name, want.steamID)
			continue
		}
		for _, n := range []string{"kills", "deaths", "assists"} {
			wantN := map[string]int{"kills": want.kills, "deaths": want.deaths, "assists": want.assists}[n]
			if v, ok := got[n]; !ok || v != float64(wantN) {
				t.Errorf("%s %s = %v (stored), want %d", want.name, n, v, wantN)
			}
		}
		if v, ok := got["adr"]; !ok || headlineRound1(v) != want.adr {
			t.Errorf("%s adr = %v (stored, 1 dp %v), want %v", want.name, v, headlineRound1(v), want.adr)
		}
		// hs_pct is a 0..1 fraction in the store (percent format); the
		// golden is 0..100.
		if v, ok := got["hs_pct"]; !ok || headlineRound1(v*100) != want.hsPct {
			t.Errorf("%s hs_pct = %v (stored, as %% 1 dp %v), want %v", want.name, v, headlineRound1(v*100), want.hsPct)
		}
	}
}
