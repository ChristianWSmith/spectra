package main

import (
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// saveImportedMatch stores one more ready match the way an import does: the
// match row, its extracted children, then ready (SaveExtracted).
func saveImportedMatch(t *testing.T, f *depsFixture, sha string) {
	t.Helper()
	id, err := f.st.CreateMatchRow("/seed/"+sha+".dem", sha, 1)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	em := &models.ExtractedMatch{
		Match: models.Match{Path: "/seed/" + sha + ".dem", SHA256: sha, Map: "de_dust2", TickRate: 64, ExtractedAt: time.Now()},
		Players: []models.Player{
			{SteamID: eqHumanSID, Name: "dana", Side: "ct"},
			{SteamID: eqBotSID, Name: "BOT Neil", IsBot: true, Side: "t"},
		},
		PlayerStats: []models.PlayerStats{
			{SteamID: eqHumanSID, Name: "dana", Side: "ct"},
			{SteamID: eqBotSID, Name: "BOT Neil", Side: "t"},
		},
		Events: []models.Event{
			{Seq: 0, Tick: 100, Round: 1, Kind: "damage", Attacker: eqHumanSID, Victim: eqBotSID, Weapon: "ak47", Dmg: 10},
		},
	}
	if err := f.st.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
}

// TestImportLeavesFirstMatchFresh: after every metric is fresh for the first
// ready match, importing one more match must not mark that match's rows behind.
// Any metric it does mark is listed, so the over-invalidation is visible.
func TestImportLeavesFirstMatchFresh(t *testing.T) {
	f := newSeededFixture(t)
	if _, err := f.svc.runSweep(t.Context(), nil); err != nil {
		t.Fatalf("sweep: %v", err)
	}
	first := readyMatchIDs(t, f.st)[0]
	before := map[int64]MetricComputeState{}
	for _, s := range scopedStatesOf(t, f.svc, "match", strconv.FormatInt(first, 10)) {
		before[s.MetricID] = s
	}

	saveImportedMatch(t, f, "sha-import-scope")
	// Straight after the import, before any sweep: nothing about the first
	// match may have changed.
	for _, s := range scopedStatesOf(t, f.svc, "match", strconv.FormatInt(first, 10)) {
		if before[s.MetricID].State == MetricStateFresh && s.State != MetricStateFresh {
			t.Errorf("right after the import (no sweep): metric %d is %q for the first match", s.MetricID, s.State)
		}
	}
	if _, err := f.svc.runSweep(t.Context(), nil); err != nil {
		t.Fatalf("sweep after import: %v", err)
	}

	metricsByID := map[int64]string{}
	list, err := f.st.ListMetrics()
	if err != nil {
		t.Fatalf("ListMetrics: %v", err)
	}
	for _, m := range list {
		metricsByID[m.ID] = m.Name
	}
	for _, s := range scopedStatesOf(t, f.svc, "match", strconv.FormatInt(first, 10)) {
		if before[s.MetricID].State == MetricStateFresh && s.State != MetricStateFresh {
			t.Errorf("metric %q: first match was fresh, now %q", metricsByID[s.MetricID], s.State)
		}
	}
}

// matchScopedMetricIDs returns the metrics whose expression binds :match_id and
// no other unit (the per-match units the match-scope read answers for).
func matchScopedMetricIDs(t *testing.T, st *store.Store) map[int64]bool {
	t.Helper()
	list, err := st.ListMetrics()
	if err != nil {
		t.Fatalf("ListMetrics: %v", err)
	}
	out := map[int64]bool{}
	for _, m := range list {
		if strings.Contains(m.Expr, ":match_id") && !strings.Contains(m.Expr, ":steam_id") && !strings.Contains(m.Expr, ":round") {
			out[m.ID] = true
		}
	}
	return out
}

func scopedStatesOf(t *testing.T, svc *MetricsService, scope, id string) []MetricComputeState {
	t.Helper()
	states, err := svc.GetMetricStates(scope, id)
	if err != nil {
		t.Fatalf("GetMetricStates(%s, %s): %v", scope, id, err)
	}
	return states
}

// TestRunningSweepDoesNotMarkFreshMatchProcessing: while a sweep is running for
// another match, a metric that is fresh for this match still reads fresh. The
// in-flight mark is per metric, but the match-scope read must only show
// "processing" for a unit the sweep is actually recomputing.
func TestRunningSweepDoesNotMarkFreshMatchProcessing(t *testing.T) {
	f := newSeededFixture(t)
	if _, err := f.svc.runSweep(t.Context(), nil); err != nil {
		t.Fatalf("sweep: %v", err)
	}
	first := readyMatchIDs(t, f.st)[0]
	saveImportedMatch(t, f, "sha-running-sweep")

	ids := []int64{}
	for _, s := range scopedStatesOf(t, f.svc, "match", strconv.FormatInt(first, 10)) {
		ids = append(ids, s.MetricID)
	}
	f.svc.mu.Lock()
	if f.svc.inflight == nil {
		f.svc.inflight = map[int64]bool{}
	}
	for _, id := range ids {
		f.svc.inflight[id] = true
	}
	f.svc.mu.Unlock()
	defer func() {
		f.svc.mu.Lock()
		f.svc.inflight = nil
		f.svc.mu.Unlock()
	}()

	matchScoped := matchScopedMetricIDs(t, f.st)
	for _, s := range scopedStatesOf(t, f.svc, "match", strconv.FormatInt(first, 10)) {
		if !matchScoped[s.MetricID] {
			continue
		}
		if s.State == MetricStateProcessing {
			t.Errorf("first match (fresh) reads processing for metric %d while another match is being computed", s.MetricID)
		}
	}
}
