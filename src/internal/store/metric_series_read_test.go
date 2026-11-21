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
	"testing"
	"time"
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
		{MatchID: matchID, SubjectKey: steamID, Value: value},
	}); err != nil {
		t.Fatalf("InsertMetricValues(%s): %v", name, err)
	}
}

// legacyTrendExpr is the RETIRED trendMetricWhitelist, verbatim: the
// per-match SQL expressions GetTrend used before it read stored metric
// rows (dogfooding W3). Identifiers only — no user input ever reaches
// the oracle's query text either. The kast/kd entries reuse the shared
// scope consts in queries.go, exactly as the production map did.

// TestGetPlayerHistoryReadsStoredMetricRows pins the history table's three
// metric-backed cells (design §3.5's D13 for ADR/KAST, the inferred-
// conversion W3a swap for the K/D/A triple's A half): Assists, ADR and
// KAST% come from the stored match-scope `assists`/`adr`/`kast` rows —
// ADR in the metric's own units, KAST% scaled ×100 for the 0..100 cell,
// Assists as the count it is (scale 1) — and a match with no fresh row
// leaves the cell NIL (the profile's honest "—"), never the retired
// query-time ps.adr / ps.assists / kastPerMatchSQL arithmetic and never
// a 0.
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
	seedFreshMetricValue(t, s, "assists", "100", newer, 2)
	seedFreshMetricValue(t, s, "adr", "100", newer, 63.5)
	seedFreshMetricValue(t, s, "kast", "100", newer, 0.75)
	seedFreshMetricValue(t, s, "kills", "100", newer, 10)
	seedFreshMetricValue(t, s, "deaths", "100", newer, 0)

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
	if rows[0].Assists == nil || *rows[0].Assists != 2 {
		t.Errorf("newer Assists = %v, want 2 (the stored `assists` row, count units)", rows[0].Assists)
	}
	if rows[0].ADR == nil || *rows[0].ADR != 63.5 {
		t.Errorf("newer ADR = %v, want 63.5 (the stored `adr` row, own units)", rows[0].ADR)
	}
	if rows[0].KASTPct == nil || *rows[0].KASTPct != 75 {
		t.Errorf("newer KASTPct = %v, want 75 (the stored 0.75 fraction ×100 for the 0..100 cell)", rows[0].KASTPct)
	}
	if rows[1].Assists != nil || rows[1].ADR != nil || rows[1].KASTPct != nil {
		t.Errorf("older assists/adr/kast = %v/%v/%v, want nil/nil/nil (no fresh rows → honest gap)",
			rows[1].Assists, rows[1].ADR, rows[1].KASTPct)
	}
	// The raw/inferred cells the history keeps are untouched — K and D
	// stay stored columns (Q2: the triple composes per half, so the
	// retired ps.assists select is the only assist source that died).
	if rows[0].Kills != 10 || rows[0].Deaths != 0 || rows[0].Map == "" {
		t.Errorf("newer row lost its raw columns: %+v", rows[0])
	}
}
