package store

// Tests for matches.analyzed_rule_version — the analytics rule stamp:
// its write/read contract (including that a reprocess never clobbers it)
// and the Behind list facet (the behind predicate + the ready gate + the
// count) the Settings re-run button is built on.

import (
	"errors"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// TestMatchRuleStamp pins the stamp's contract: a fresh import reads 0
// (never analyzed — SaveExtracted does not write the column), set→get
// roundtrips, a REPROCESS leaves the stamp untouched (the analyze stage
// re-stamps afterwards; until then the old stamp still describes the
// rows that are there), and unknown ids yield ErrNotFound.
func TestMatchRuleStamp(t *testing.T) {
	s := openMem(t)
	base := time.Now().Truncate(time.Second)
	id := saveTestMatch(t, s, "/d/stamp.dem", "sha-stamp", base)

	v, err := s.GetMatchRuleVersion(id)
	if err != nil || v != 0 {
		t.Fatalf("initial stamp = %d, %v; want 0, nil (SaveExtracted must leave the default standing)", v, err)
	}
	if err := s.SetMatchRuleVersion(id, 3); err != nil {
		t.Fatalf("SetMatchRuleVersion: %v", err)
	}
	if v, err := s.GetMatchRuleVersion(id); err != nil || v != 3 {
		t.Fatalf("stamp after set = %d, %v; want 3, nil", v, err)
	}

	// Reprocess: SaveExtracted rewrites every extract-owned column of the
	// match row — the stamp must survive it (matchOwnedElsewhere's point).
	if err := s.SaveExtracted(id, testExtracted("sha-stamp", base)); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	if v, err := s.GetMatchRuleVersion(id); err != nil || v != 3 {
		t.Fatalf("stamp after reprocess = %d, %v; want 3, nil (SaveExtracted must not clobber it)", v, err)
	}

	if _, err := s.GetMatchRuleVersion(424242); !errors.Is(err, ErrNotFound) {
		t.Errorf("GetMatchRuleVersion(unknown) = %v, want ErrNotFound", err)
	}
	if err := s.SetMatchRuleVersion(424242, 1); !errors.Is(err, ErrNotFound) {
		t.Errorf("SetMatchRuleVersion(unknown) = %v, want ErrNotFound", err)
	}
}

// listIDs projects a ListMatches result to its ids (the assertions below
// compare id sequences).
func listIDs(t *testing.T, s *Store, query string, filters ...MatchListFilter) []int64 {
	t.Helper()
	rows, err := s.ListMatches(query, "", false, filters...)
	if err != nil {
		t.Fatalf("ListMatches(%q, %+v): %v", query, filters, err)
	}
	out := make([]int64, 0, len(rows))
	for _, r := range rows {
		out = append(out, r.ID)
	}
	return out
}

// TestBehindFacet pins THE behind predicate (matchListWhere's spelling):
// analyzed_rule_version < the live rule version — 0/never is behind, an
// equal stamp is current — restricted to status 'ready' (a non-ready row
// cannot be re-run), ANDed with the free-text query and the other facets,
// and counted by CountMatches exactly as ListMatches lists it.
func TestBehindFacet(t *testing.T) {
	s := openMem(t)
	base := time.Now().Truncate(time.Second)
	never := saveTestMatch(t, s, "/d/never.dem", "sha-behind-never", base)
	current := saveTestMatch(t, s, "/d/current.dem", "sha-behind-current", base.Add(time.Hour))
	older := saveTestMatch(t, s, "/d/older.dem", "sha-behind-older", base.Add(2*time.Hour))
	nonReady := saveTestMatch(t, s, "/d/nonready.dem", "sha-behind-nonready", base.Add(3*time.Hour))

	// Live rules at v3: current is AT the version, older is behind it,
	// never (stamp 0) is behind it.
	if _, err := s.SetConfig(models.AnalysisConfig{
		TradeWindowS: 5, EcoFullBuy: 20000, EcoForce: 10000,
		TradeOppDistance: 1000, RuleVersion: 3,
	}); err != nil {
		t.Fatalf("SetConfig: %v", err)
	}
	if err := s.SetMatchRuleVersion(current, 3); err != nil {
		t.Fatalf("stamp current: %v", err)
	}
	if err := s.SetMatchRuleVersion(older, 2); err != nil {
		t.Fatalf("stamp older: %v", err)
	}
	// The fourth row is behind by stamp but NOT re-runnable → excluded.
	if _, err := s.db.Exec(`UPDATE matches SET status = 'queued' WHERE id = ?`, nonReady); err != nil {
		t.Fatalf("flip non-ready: %v", err)
	}

	behind := MatchListFilter{Behind: true}
	if got := listIDs(t, s, "", behind); len(got) != 2 || got[0] != never || got[1] != older {
		t.Errorf("behind ids = %v, want [%d %d] (never + older; current and non-ready excluded)", got, never, older)
	}
	if n, err := s.CountMatches("", behind); err != nil || n != 2 {
		t.Errorf("CountMatches(behind) = %d, %v; want 2 (must agree with the list)", n, err)
	}
	// The unconstrained list still sees every row.
	if got := listIDs(t, s, ""); len(got) != 4 {
		t.Errorf("unfiltered list = %v, want 4 rows", got)
	}
	// ANDed with free-text: a behind row outside the text is dropped, and
	// a matching row that is NOT behind is dropped too.
	if got := listIDs(t, s, "/d/older", behind); len(got) != 1 || got[0] != older {
		t.Errorf("text+behind = %v, want [%d]", got, older)
	}
	if got := listIDs(t, s, "/d/current", behind); len(got) != 0 {
		t.Errorf("current row survived text+behind: %v", got)
	}
	if got := listIDs(t, s, "/d/nonready", behind); len(got) != 0 {
		t.Errorf("non-ready row survived text+behind: %v", got)
	}
	if n, err := s.CountMatches("/d/current", behind); err != nil || n != 0 {
		t.Errorf("CountMatches(current+behind) = %d, %v; want 0", n, err)
	}
}

// TestBehindFacetUnseededConfig pins the COALESCE arm: a store whose
// single analysis_config row has never been written (no GetConfig yet)
// reads as the schema's rule_version default (1), so every never-analyzed
// match is still behind — never a NULL comparison that silently matches
// nothing.
func TestBehindFacetUnseededConfig(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/fresh.dem", "sha-behind-fresh", time.Now().Truncate(time.Second))

	got := listIDs(t, s, "", MatchListFilter{Behind: true})
	if len(got) != 1 || got[0] != id {
		t.Errorf("behind ids on an unseeded config = %v, want [%d]", got, id)
	}
}
