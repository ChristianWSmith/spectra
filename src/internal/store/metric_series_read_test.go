package store

// W3g — the profile's trend/history conversion (dogfooding design §3.5's
// gated sub-wave, owner ruling Q3 APPROVED): GetTrend and
// GetPlayerHistory stop running SQL arithmetic over player_stats and
// read the STORED match-scope metric rows instead, through the one new
// series read GetPlayerMetricSeries.
//
// These pins are the proof the swap changed no number on data where both
// sides exist, and that a row the store does not have is an honest GAP:
//
//  1. legacyTrendPoints — the RETIRED GetTrend query kept verbatim as
//     the reference oracle (the trade-opps / eco oracle precedent),
//     spelled with the same expressions trendMetricWhitelist used;
//  2. GetTrend == that oracle (the conversion's equivalence pin);
//  3. GetPlayerMetricSeries-derived points == that oracle on the matches
//     carrying a FRESH row (this half was run against the OLD GetTrend
//     before the switch — the characterization, 2026-11-14);
//  4. a match with NO row, or only a STALE-stamped one, is skipped —
//     the gap the sparkline's ≥2-point requirement renders, never a
//     fabricated 0 and never a fallback-to-Go recomputation;
//  5. percent-format metrics keep their 0..100 display scale (the store
//     keeps a 0..1 fraction) and Q1's deliberate divergences (zero
//     denominators) surface as the metric semantics, not the SQL ones.

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

// TestGetTrendConvertedEqualsLegacySeries is the CONVERSION pin: GetTrend
// (now a thin wrapper over the series read) still equals the retired
// query's output on every fresh-covered match — the equivalence the
// characterization above established, held after the switch.
func TestGetTrendConvertedEqualsLegacySeries(t *testing.T) {
	s, ids := trendFixture(t)

	legacy := legacyTrendPoints(t, s, "100", "adr")
	covered := []models.ProfileTrendPoint{}
	for _, p := range legacy {
		if p.MatchID == ids["trend-b"] || p.MatchID == ids["trend-d"] {
			continue
		}
		covered = append(covered, p)
	}
	trend, err := s.GetTrend("100", "adr")
	if err != nil {
		t.Fatalf("GetTrend: %v", err)
	}
	if len(trend) != len(covered) {
		t.Fatalf("GetTrend = %d points, want %d (the fresh-covered subset): %+v",
			len(trend), len(covered), trend)
	}
	for i := range trend {
		if !sameTrendPoint(trend[i], covered[i]) {
			t.Errorf("GetTrend[%d] = %+v, want the legacy point %+v", i, trend[i], covered[i])
		}
		if trend[i].Seq != i {
			t.Errorf("GetTrend[%d].Seq = %d, want %d (ordinal over the surviving points)", i, trend[i].Seq, i)
		}
	}
	seen := map[int64]bool{}
	for _, p := range trend {
		seen[p.MatchID] = true
	}
	if seen[ids["trend-b"]] || seen[ids["trend-d"]] {
		t.Errorf("GetTrend served a gap match: %+v", trend)
	}
}

// TestGetTrendPercentScaleAndQ1Divergences pins the two display-unit
// facts the conversion carries and the one divergence owner ruling Q1
// accepted:
//
//   - percent-format metrics store a 0..1 FRACTION while the trend has
//     always served 0..100 (fmtPercent / fmtProfileMetric) — kast and
//     hs must come back ×100, equal to the retired SQL;
//   - Q1: a zero denominator yields the metric's 0-beside-N where the
//     retired SQL floored it (alice is 10k/0d → kd 10.00 retired, 0
//     now), and a match with no analytics rows used to read KAST 0
//     while the metric has no rows at all → a gap.
func TestGetTrendPercentScaleAndQ1Divergences(t *testing.T) {
	s := openMem(t)
	base := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)

	// match q1-a: alice 10k/0d/4hs with one KAST round; match q1-b: no
	// player_round_stats rows at all (the KAST gap case). Both keep
	// testExtracted's player_stats (10k/0d/4hs, adr 60, hs_pct 40).
	save := func(name string, at time.Time, rounds []models.PlayerRoundStat) int64 {
		t.Helper()
		id, err := s.CreateMatchRow("/d/"+name+".dem", "sha-"+name, 42)
		if err != nil {
			t.Fatalf("CreateMatchRow(%s): %v", name, err)
		}
		em := testExtracted("sha-"+name, at)
		if err := s.SaveExtracted(id, em); err != nil {
			t.Fatalf("SaveExtracted(%s): %v", name, err)
		}
		if rounds != nil {
			if err := s.ReplacePlayerRounds(id, rounds); err != nil {
				t.Fatalf("ReplacePlayerRounds(%s): %v", name, err)
			}
		}
		return id
	}
	idA := save("q1-a", base.Add(time.Hour), []models.PlayerRoundStat{
		{Round: 1, SteamID: "100", KAST: true},
	})
	idB := save("q1-b", base, nil)

	// The rows the sweep would store: kast = AVG(flag) = 1.0, hs =
	// headshots/kills = 0.4, kd = kills/deaths → NULLIF → 0 (Q1).
	seedFreshMetricValue(t, s, "kast", "100", idA, 1.0)
	seedFreshMetricValue(t, s, "hs_pct", "100", idA, 0.4)
	seedFreshMetricValue(t, s, "kd", "100", idA, 0)

	byMatch := func(metric string) map[int64]float64 {
		t.Helper()
		out := map[int64]float64{}
		for _, p := range legacyTrendPoints(t, s, "100", metric) {
			out[p.MatchID] = p.Value
		}
		return out
	}
	trendByMatch := func(metric string) map[int64]float64 {
		t.Helper()
		pts, err := s.GetTrend("100", metric)
		if err != nil {
			t.Fatalf("GetTrend(%s): %v", metric, err)
		}
		out := map[int64]float64{}
		for _, p := range pts {
			out[p.MatchID] = p.Value
		}
		return out
	}

	// kast: 100 × 1 == the retired 100.0 × AVG(kast); the analytics-less
	// match is a GAP (Q1: 0-round KAST → "—"), where the retired
	// COALESCE(...) served a fabricated 0.
	legacyKast := byMatch("kast")
	if legacyKast[idA] != 100 || legacyKast[idB] != 0 {
		t.Fatalf("legacy kast = %v, want {a:100 b:0} (the retired COALESCE spelling)", legacyKast)
	}
	kast := trendByMatch("kast")
	if len(kast) != 1 || kast[idA] != 100 {
		t.Errorf("kast trend = %v, want exactly {a:100} (×100 of the stored 1.0; b has no rows)", kast)
	}

	// hs: 0.4 × 100 == the retired ps.hs_pct (40) — equal, no scaling
	// surprise on the side where both agree.
	legacyHS := byMatch("hs")
	hs := trendByMatch("hs")
	if legacyHS[idA] != 40 || legacyHS[idB] != 40 {
		t.Fatalf("legacy hs = %v, want 40 for both (testExtracted hs_pct)", legacyHS)
	}
	if len(hs) != 1 || hs[idA] != legacyHS[idA] {
		t.Errorf("hs trend = %v, want {a:%v} (the stored fraction ×100 == the legacy column)", hs, legacyHS[idA])
	}

	// kd: the DIVERGENCE Q1 accepted — alice is 10k/0d, so the retired
	// floor showed the kill count (10) while the metric's NULLIF shows
	// the honest 0-beside-N.
	legacyKD := byMatch("kd")
	if legacyKD[idA] != 10 {
		t.Fatalf("legacy kd = %v, want 10 (kills / MAX(deaths,1))", legacyKD)
	}
	kd := trendByMatch("kd")
	if len(kd) != 1 || kd[idA] != 0 {
		t.Errorf("kd trend = %v, want {a:0} (Q1: NULLIF, never the floored 10)", kd)
	}
}

// TestGetPlayerHistoryReadsStoredMetricRows pins the history table's two
// metric-backed cells (design §3.5's D13): ADR and KAST% come from the
// stored match-scope `adr`/`kast` rows — ADR in the metric's own units,
// KAST% scaled ×100 for the 0..100 cell — and a match with no fresh row
// leaves the cell NIL (the profile's honest "—"), never the retired
// query-time ps.adr / kastPerMatchSQL arithmetic and never a 0.
func TestGetPlayerHistoryReadsStoredMetricRows(t *testing.T) {
	s := openMem(t)
	base := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	save := func(name string, at time.Time) int64 {
		t.Helper()
		id, err := s.CreateMatchRow("/d/"+name+".dem", "sha-"+name, 42)
		if err != nil {
			t.Fatalf("CreateMatchRow(%s): %v", name, err)
		}
		if err := s.SaveExtracted(id, testExtracted("sha-"+name, at)); err != nil {
			t.Fatalf("SaveExtracted(%s): %v", name, err)
		}
		return id
	}
	older := save("hist-older", base)
	newer := save("hist-newer", base.Add(time.Hour))

	// Only the NEWER match carries fresh rows.
	seedFreshMetricValue(t, s, "adr", "100", newer, 63.5)
	seedFreshMetricValue(t, s, "kast", "100", newer, 0.75)

	rows, err := s.GetPlayerHistory("100")
	if err != nil {
		t.Fatalf("GetPlayerHistory: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("history = %d rows, want 2: %+v", len(rows), rows)
	}
	if rows[0].MatchID != newer || rows[1].MatchID != older {
		t.Fatalf("history order = %d, %d; want most-recent-first (%d, %d)",
			rows[0].MatchID, rows[1].MatchID, newer, older)
	}
	if rows[0].ADR == nil || *rows[0].ADR != 63.5 {
		t.Errorf("newer ADR = %v, want 63.5 (the stored `adr` row, own units)", rows[0].ADR)
	}
	if rows[0].KASTPct == nil || *rows[0].KASTPct != 75 {
		t.Errorf("newer KASTPct = %v, want 75 (the stored 0.75 fraction ×100 for the 0..100 cell)", rows[0].KASTPct)
	}
	if rows[1].ADR != nil || rows[1].KASTPct != nil {
		t.Errorf("older adr/kast = %v/%v, want nil/nil (no fresh rows → honest gap)",
			rows[1].ADR, rows[1].KASTPct)
	}
	// The raw/inferred cells the history keeps are untouched.
	if rows[0].Kills != 10 || rows[0].Deaths != 0 || rows[0].Map == "" {
		t.Errorf("newer row lost its raw columns: %+v", rows[0])
	}
}
