package store

// W3g GROUNDWORK — the profile's trend/history conversion (dogfooding
// design §3.5's gated sub-wave, owner ruling Q3 APPROVED): the ONE new
// store read GetPlayerMetricSeries serves the stored match-scope metric
// series that GetTrend and GetPlayerHistory switch to.
//
// The test below is the CHARACTERIZATION, run BEFORE the switch
// (2026-11-14): it pins the new read against legacyTrendPoints — the
// RETIRED GetTrend query kept verbatim as the reference oracle (the
// trade-opps / eco oracle precedent), spelled with the same expressions
// trendMetricWhitelist used — on data where both exist, plus the two gap
// shapes (no row at all; a present-but-unstamped row), the retired row
// order, and the unchanged unknown-metric contract. The conversion's own
// pins (GetTrend == that oracle, the percent display scale and Q1's
// zero-denominator divergences, the history cells) follow with the
// switch in the next commit.

import (
	"database/sql"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// seedFreshMetricValue inserts ONE fresh stored value for a SEED metric —
// the row a completed sweep would have written (both stamps at their
// live versions). This is the only way the trend/history reads ever see
// a value; nothing in the store package runs the sweep.
func seedFreshMetricValue(t *testing.T, s *Store, name, steamID string, matchID int64, value float64) {
	t.Helper()
	insertSeedMetricValue(t, s, name, steamID, matchID, value, true)
}

// insertSeedMetricValue is seedFreshMetricValue with the freshness knobs
// exposed: a "stale" row carries metric_version 0 (never stamped →
// behind) and must never be served by a fresh-only read.
func insertSeedMetricValue(t *testing.T, s *Store, name, steamID string, matchID int64, value float64, fresh bool) {
	t.Helper()
	def, err := s.GetMetricByName(name)
	if err != nil {
		t.Fatalf("GetMetricByName(%s): %v", name, err)
	}
	cfg, err := s.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	version := def.Version
	if !fresh {
		version = 0
	}
	if err := s.InsertMetricValues(def.ID, version, cfg.RuleVersion, []MetricValueRow{
		{MatchID: matchID, SteamID: steamID, Value: value, N: 1},
	}); err != nil {
		t.Fatalf("InsertMetricValues(%s): %v", name, err)
	}
}

// legacyTrendExpr is the RETIRED trendMetricWhitelist, verbatim: the
// per-match SQL expressions GetTrend used before it read stored metric
// rows (dogfooding W3). Identifiers only — no user input ever reaches
// the oracle's query text either. The kast/kd entries reuse the shared
// scope consts in queries.go, exactly as the production map did.
var legacyTrendExpr = map[string]string{
	"adr":  "ps.adr",
	"kast": kastPerMatchSQL,
	"kd":   kdPerMatchSQL,
	"hs":   "ps.hs_pct",
}

// legacyTrendPoints runs the RETIRED GetTrend query (reference oracle —
// see the file header). It returns every player_stats row's value in
// the old row order, with Seq computed from that order.
func legacyTrendPoints(t *testing.T, s *Store, steamID, metric string) []models.ProfileTrendPoint {
	t.Helper()
	expr, ok := legacyTrendExpr[metric]
	if !ok {
		t.Fatalf("legacyTrend: unknown metric %q", metric)
	}
	rows, err := s.db.Query(
		`SELECT m.id, `+expr+`, m.patch_version, m.extracted_at
		 FROM player_stats ps
		 JOIN matches m ON m.id = ps.match_id
		 WHERE ps.steam_id = ? AND m.extracted_at IS NOT NULL
		   AND `+HumanOnlyBySteamID("ps.steam_id", "ps.match_id")+`
		 ORDER BY (m.patch_version = 0) ASC, m.patch_version ASC,
		          m.extracted_at ASC, m.id ASC`, scrub(steamID),
	)
	if err != nil {
		t.Fatalf("legacyTrend: %v", err)
	}
	defer rows.Close()
	var out []models.ProfileTrendPoint
	for rows.Next() {
		var r models.ProfileTrendPoint
		var extracted sql.NullTime
		if err := rows.Scan(&r.MatchID, &r.Value, &r.Patch, &extracted); err != nil {
			t.Fatalf("legacyTrend scan: %v", err)
		}
		r.Seq = len(out)
		r.ExtractedAt = nullTime(extracted)
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("legacyTrend rows: %v", err)
	}
	return out
}

// trendFixture saves four matches for player "100" with distinct patch
// and import times (the trend's x axis) and a known ps.adr, then stores
// a FRESH `adr` row for matches a and c only — b has NO row and d has a
// STALE one, so both must read as gaps.
//
// The stored values are seeded to EQUAL the ps.adr column so both sides
// of the comparison agree by construction: this file pins the READ
// (ordering, freshness, gaps, display scale), never the engine's
// arithmetic — that is internal/metrics/fixtures_test.go's job.
//
// The old row order is a, b, c, d (patch 14089 ascending by import,
// then 14113, then the unknown patch trailing); the series therefore
// comes back a, c — with c's Seq compressed from 2 to 1 (b dropped out
// of the middle).
func trendFixture(t *testing.T) (s *Store, ids map[string]int64) {
	t.Helper()
	s = openMem(t)
	base := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	specs := []struct {
		name  string
		patch int
		at    time.Time
		adr   float64
	}{
		{"trend-a", 14089, base.Add(2 * time.Hour), 10},
		{"trend-b", 14089, base.Add(3 * time.Hour), 20},
		{"trend-c", 14113, base.Add(time.Hour), 30},
		{"trend-d", 0, base, 40},
	}
	ids = map[string]int64{}
	for _, sp := range specs {
		id, err := s.CreateMatchRow("/d/"+sp.name+".dem", "sha-"+sp.name, 42)
		if err != nil {
			t.Fatalf("CreateMatchRow(%s): %v", sp.name, err)
		}
		em := testExtracted("sha-"+sp.name, sp.at)
		em.Match.PatchVersion = sp.patch
		em.PlayerStats[0].ADR = sp.adr
		if err := s.SaveExtracted(id, em); err != nil {
			t.Fatalf("SaveExtracted(%s): %v", sp.name, err)
		}
		ids[sp.name] = id
	}
	seedFreshMetricValue(t, s, "adr", "100", ids["trend-a"], 10)
	seedFreshMetricValue(t, s, "adr", "100", ids["trend-c"], 30)
	// d's row is present but UNSTAMPED (metric_version 0 = behind): the
	// crash matrix's "present but invisible" case — never served.
	insertSeedMetricValue(t, s, "adr", "100", ids["trend-d"], 40, false)
	return s, ids
}

// seriesTrendPoints renders the series read the way GetTrend does —
// the value scaled by the definition's display scale, Seq = the index in
// the series row order.
func seriesTrendPoints(t *testing.T, s *Store, steamID, seedName string) []models.ProfileTrendPoint {
	t.Helper()
	m, found, err := s.seriesMetricFor(seedName)
	if err != nil {
		t.Fatalf("seriesMetricFor(%s): %v", seedName, err)
	}
	if !found {
		return nil
	}
	series, err := s.GetPlayerMetricSeries(steamID, []int64{m.id})
	if err != nil {
		t.Fatalf("GetPlayerMetricSeries: %v", err)
	}
	var out []models.ProfileTrendPoint
	for _, p := range series {
		out = append(out, models.ProfileTrendPoint{
			MatchID:     p.MatchID,
			Seq:         len(out),
			Value:       p.Value * m.scale,
			Patch:       p.Patch,
			ExtractedAt: p.ExtractedAt,
		})
	}
	return out
}

// sameTrendPoint compares the fields the sparkline and its tooltip read
// (Seq is deliberately NOT compared here: it is the index in each
// reading's own row order, and a gap compresses it — pinned separately).
func sameTrendPoint(got, want models.ProfileTrendPoint) bool {
	return got.MatchID == want.MatchID && got.Value == want.Value &&
		got.Patch == want.Patch && got.ExtractedAt.Equal(want.ExtractedAt)
}

// TestGetPlayerMetricSeriesMatchesLegacyTrend is the W3g
// CHARACTERIZATION: the new series read reproduces the retired GetTrend
// query's values, in the retired row order, for every match that carries
// a FRESH row — and skips the ones that do not, recomputing Seq over the
// survivors. Run against the OLD GetTrend before the switch
// (2026-11-14): the legacy oracle and the series read agreed on every
// covered point, which is what made the switch safe.
func TestGetPlayerMetricSeriesMatchesLegacyTrend(t *testing.T) {
	s, ids := trendFixture(t)

	legacy := legacyTrendPoints(t, s, "100", "adr")
	if len(legacy) != 4 {
		t.Fatalf("legacy trend = %d points, want 4 (every player_stats row): %+v", len(legacy), legacy)
	}

	// The characterization: the series read == the retired query on the
	// covered matches, same order, same values, same patch/import facts.
	series := seriesTrendPoints(t, s, "100", "adr")
	covered := []models.ProfileTrendPoint{}
	for _, p := range legacy {
		if p.MatchID == ids["trend-b"] || p.MatchID == ids["trend-d"] {
			continue
		}
		covered = append(covered, p)
	}
	if len(series) != len(covered) {
		t.Fatalf("series = %d points, want %d (the fresh-covered subset of the legacy series): %+v",
			len(series), len(covered), series)
	}
	for i := range series {
		if !sameTrendPoint(series[i], covered[i]) {
			t.Errorf("series[%d] = %+v, want the legacy point %+v", i, series[i], covered[i])
		}
		if series[i].Seq != i {
			t.Errorf("series[%d].Seq = %d, want %d (ordinal over the surviving points)", i, series[i].Seq, i)
		}
	}

	// The gaps: b (no row at all) and d (present but unstamped) never
	// reach the series, and the unknown patch still trails.
	seen := map[int64]bool{}
	for _, p := range series {
		seen[p.MatchID] = true
	}
	for _, name := range []string{"trend-b", "trend-d"} {
		if seen[ids[name]] {
			t.Errorf("series served %s — a match with no FRESH row must be a gap, not a value", name)
		}
	}
	if len(series) != 2 || !seen[ids["trend-a"]] || !seen[ids["trend-c"]] {
		t.Errorf("series = %+v, want exactly trend-a and trend-c", series)
	}
	if series[len(series)-1].Patch != 14113 {
		t.Errorf("last point patch = %d, want 14113 (unknown patches trail — the retired order)", series[len(series)-1].Patch)
	}

	// The unknown-metric API contract is unchanged.
	if _, err := s.GetTrend("100", "nope"); err == nil {
		t.Error("GetTrend(nope) err = nil, want unknown-metric error")
	}
	// The career grain never leaks into a match-grain series.
	if pts, err := s.GetPlayerMetricSeries("", nil); err != nil || len(pts) != 0 {
		t.Errorf("GetPlayerMetricSeries(\"\") = %v, %v — a series is always one subject", pts, err)
	}
}
