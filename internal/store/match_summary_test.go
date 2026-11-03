package store

import (
	"errors"
	"testing"
	"time"
)

// TestGetMatchSummaryMatchesList: GetMatchSummary must return EXACTLY the
// row ListMatches returns for that id (same projection, same joins) — the
// single-match read exists so callers stop listing the whole library.
func TestGetMatchSummaryMatchesList(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/sum.dem", "sha-summary", time.Now())

	list, err := s.ListMatches("", "", false)
	if err != nil {
		t.Fatalf("ListMatches: %v", err)
	}
	var fromList bool
	for _, m := range list {
		if m.ID != id {
			continue
		}
		fromList = true
		one, err := s.GetMatchSummary(id)
		if err != nil {
			t.Fatalf("GetMatchSummary: %v", err)
		}
		if one.ID != m.ID || one.Path != m.Path || one.Map != m.Map || one.Size != m.Size ||
			one.ScoreCT != m.ScoreCT || one.ScoreT != m.ScoreT || one.CTName != m.CTName ||
			one.TName != m.TName || one.RealRounds != m.RealRounds || one.DurationS != m.DurationS ||
			one.Status != m.Status || one.Error != m.Error || one.SHA256 != m.SHA256 ||
			!one.ExtractedAt.Equal(m.ExtractedAt) {
			t.Errorf("GetMatchSummary = %+v\n            list row = %+v", one, m)
		}
	}
	if !fromList {
		t.Fatal("fixture match missing from ListMatches")
	}
	if _, err := s.GetMatchSummary(999999); !errors.Is(err, ErrNotFound) {
		t.Errorf("GetMatchSummary(missing) err = %v, want ErrNotFound", err)
	}
}

// TestGetTeamNamesMatchesList: the two names come from the same teams join
// ListMatches uses (empty strings when the extract recorded none).
func TestGetTeamNamesMatchesList(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/teams.dem", "sha-team-names", time.Now())

	list, err := s.ListMatches("", "", false)
	if err != nil {
		t.Fatalf("ListMatches: %v", err)
	}
	for _, m := range list {
		if m.ID != id {
			continue
		}
		ct, tn, err := s.GetTeamNames(id)
		if err != nil {
			t.Fatalf("GetTeamNames: %v", err)
		}
		if ct != m.CTName || tn != m.TName {
			t.Errorf("GetTeamNames = %q/%q, list row = %q/%q", ct, tn, m.CTName, m.TName)
		}
	}
	if _, _, err := s.GetTeamNames(999999); !errors.Is(err, ErrNotFound) {
		t.Errorf("GetTeamNames(missing) err = %v, want ErrNotFound", err)
	}
}
