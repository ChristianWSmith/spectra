package store

import (
	"strings"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// TestColumnListConstsMatchSchema pins G1: every hand-written per-table
// column list const in this package names REAL columns of the table it is
// written against (the DDL in schema.sql is the other half of every drift
// pair — a schema change renaming a column must fail here instead of at
// import time).
// The metrics whitelist keeps its own curated copy (a different concern —
// internal/metrics/whitelist.go) and is checked against the same schema in
// internal/metrics' schema-consistency test.
func TestColumnListConstsMatchSchema(t *testing.T) {
	s := openMem(t)

	// const name → (table, column list)
	lists := []struct {
		name  string
		table string
		cols  string
	}{
		{"playerStatsCols", "player_stats", playerStatsCols},
		{"roundCols", "rounds", roundCols},
		{"roundEconomyCols", "round_economy", roundEconomyCols},
		{"eventCols", "events", eventCols},
		{"analysisConfigCols", "analysis_config", analysisConfigCols},
		{"roundClassCols", "round_classifications", roundClassCols},
		{"playerRoundCols", "player_round_stats", playerRoundCols},
		{"clutchCols", "clutches", clutchCols},
		{"engagementCols", "engagements", engagementCols},
		{"utilityCols", "utility_events", utilityCols},
		{"playerCareerCols", "player_career", playerCareerCols},
		{"voicePresenceCols", "voice_presence", voicePresenceCols},
		{"voiceChunksCols", "voice_chunks", voiceChunksCols},
		{"pluginCols", "plugins", pluginCols},
		{"queryHistoryCols", "query_history", queryHistoryCols},
		{"savedQueryCols", "saved_queries", savedQueryCols},
		{"savedFilterCols", "saved_filters", savedFilterCols},
		{"chatCols", "chat", chatCols},
	}
	for _, l := range lists {
		cols, err := s.schemaColumns(l.table)
		if err != nil {
			t.Fatalf("schemaColumns(%s): %v", l.table, err)
		}
		have := make(map[string]bool, len(cols))
		for _, c := range cols {
			have[c.Name] = true
		}
		for _, c := range strings.Split(l.cols, ",") {
			c = strings.TrimSpace(c)
			if c == "" {
				t.Errorf("%s: empty column entry", l.name)
				continue
			}
			if !have[c] {
				t.Errorf("%s: %q is not a column of %s", l.name, c, l.table)
			}
		}
	}

	// The matches list (slice — GetMatch SELECT + SaveExtracted UPDATE).
	matchCols, err := s.schemaColumns("matches")
	if err != nil {
		t.Fatalf("schemaColumns(matches): %v", err)
	}
	have := make(map[string]bool, len(matchCols))
	for _, c := range matchCols {
		have[c.Name] = true
	}
	for _, c := range matchColumns {
		if !have[c] {
			t.Errorf("matchColumns: %q is not a column of matches", c)
		}
	}
	// The columns SaveExtracted must skip really are other writers' columns
	// (the skip list cannot silently rot into "skip everything").
	for c := range matchOwnedElsewhere {
		if !have[c] {
			t.Errorf("matchOwnedElsewhere: %q is not a column of matches", c)
		}
	}
	if len(matchOwnedElsewhere) != 7 {
		t.Errorf("matchOwnedElsewhere has %d entries, want 7 (id/path/sha256/size + 3 sidecar)", len(matchOwnedElsewhere))
	}
}

// TestReplaceMatchRowsPlaceholderCount: replaceMatchRows derives the
// placeholder count from the column list, so a list whose commas stop
// matching its columns would bind the wrong arity. One row through every
// const catches that against the real DDL (prepare AND fill).
func TestReplaceMatchRowsPlaceholderCount(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/cols.dem", "sha-cols-probe", time.Now())

	runs := []struct {
		table string
		run   func() error
	}{
		{"round_classifications", func() error {
			return s.ReplaceRoundClassifications(id, []models.RoundClassification{
				{Round: 1, Label: "full", Confidence: 1, RuleVersion: 1, Explanation: "x"},
			})
		}},
		{"player_round_stats", func() error {
			return s.ReplacePlayerRounds(id, []models.PlayerRoundStat{
				{Round: 1, SteamID: "100", Name: "p", Kills: 1},
			})
		}},
		{"clutches", func() error {
			return s.ReplaceClutches(id, []models.Clutch{{Round: 1, Size: 1, SteamID: "100", Name: "p"}})
		}},
		{"engagements", func() error {
			return s.ReplaceEngagements(id, []models.Engagement{{Round: 1, Kind: "opening", ASteam: "100"}})
		}},
		{"utility_events", func() error {
			return s.ReplaceUtility(id, []models.UtilityEvent{{Round: 1, Kind: "he", Thrower: "100"}})
		}},
	}
	for _, r := range runs {
		if err := r.run(); err != nil {
			t.Errorf("Replace* on %s: %v", r.table, err)
			continue
		}
		var n int
		if err := s.db.QueryRow(`SELECT COUNT(*) FROM `+r.table+` WHERE match_id = ?`, id).Scan(&n); err != nil {
			t.Errorf("count %s: %v", r.table, err)
		} else if n != 1 {
			t.Errorf("%s rows = %d, want 1", r.table, n)
		}
	}
}
