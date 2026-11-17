package store

import (
	"fmt"
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// W3 — the metric_values VALUE surface (stored-metrics design §4):
// THE behind predicate's clause matrix, the two-phase writers' crash
// boundaries (per-metric tx atomicity — no half-written rows), the
// per-metric delete scope, and the cascade version-bump walk. No schema
// is asserted here beyond what the baseline already ships (W1's
// metric_values / metric_deps — zero DDL in this wave is pinned by the
// schema tests elsewhere).

// seedValueMetric inserts a bare metric definition (the row the writers
// and the coverage query key off) and returns it.
func seedValueMetric(t *testing.T, s *Store, name, scope string) models.MetricRow {
	t.Helper()
	m, err := s.CreateMetric(models.MetricRow{
		Name: name, Title: name, Expr: "from events: count()",
		Scope: scope, Origin: "user",
	})
	if err != nil {
		t.Fatalf("CreateMetric(%s): %v", name, err)
	}
	return m
}

// seedReadyMatch inserts a match row and flips it to ready (the
// match-scope unit the behind predicate enumerates).
func seedReadyMatch(t *testing.T, s *Store, sha string) int64 {
	t.Helper()
	id, err := s.CreateMatchRow("/d/"+sha+".dem", sha, 1)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	if err := s.SetMatchStatus(id, models.StatusReady, ""); err != nil {
		t.Fatalf("SetMatchStatus: %v", err)
	}
	return id
}

// coverageOf returns the single metric's coverage row.
func coverageOf(t *testing.T, s *Store, metricID int64, liveRule int) MetricCoverage {
	t.Helper()
	all, err := s.MetricCoverage(liveRule)
	if err != nil {
		t.Fatalf("MetricCoverage: %v", err)
	}
	for _, c := range all {
		if c.MetricID == metricID {
			return c
		}
	}
	t.Fatalf("metric %d missing from coverage", metricID)
	return MetricCoverage{}
}

// storedCount counts one metric's physical rows (stamps ignored — the
// crash-matrix "present but invisible" probe needs the raw count).
func storedCount(t *testing.T, s *Store, metricID int64) int {
	t.Helper()
	res, err := s.QueryWrite(t.Context(),
		`SELECT COUNT(*) FROM metric_values WHERE metric_id = ?`, []any{metricID}, 1)
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	if len(res.Rows) != 1 {
		t.Fatalf("count rows = %d", len(res.Rows))
	}
	n, _ := res.Rows[0][0].(int64)
	return int(n)
}

// seedSubjectMetric inserts a definition carrying a subject the public
// API does not expose yet (subject/partition arrive with their surfaces):
// the write-chokepoint guard must hold for it regardless.
func seedSubjectMetric(t *testing.T, s *Store, name, scope, subject string) int64 {
	t.Helper()
	res, err := s.db.Exec(
		`INSERT INTO metrics (name, title, expr, scope, subject, origin)
		 VALUES (?, ?, 'from events: count()', ?, ?, 'user')`,
		name, name, scope, subject,
	)
	if err != nil {
		t.Fatalf("insert %s subject metric: %v", subject, err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		t.Fatalf("subject metric id: %v", err)
	}
	return id
}

// TestMatchAndTeamValuesNeedAMatch pins metric_values' app-level
// invariant (schema.sql — deliberately NO CHECK: the pre-release baseline
// takes no schema churn for an invariant the writer can hold itself):
// match_id = 0 is the career bucket alone, so a match- or team-subject
// metric's rows always carry a real match id. The store is the ONE write
// chokepoint both phase writers land in, so InsertMetricValues enforces
// it; player-subject rows stay unconstrained — match grain at match_id > 0
// and career grain at 0 are both legitimate spellings.
func TestMatchAndTeamValuesNeedAMatch(t *testing.T) {
	s, _ := openFileStore(t)
	t.Cleanup(func() { _ = s.CloseRO() })
	matchID := seedReadyMatch(t, s, "subject-match")

	team := seedSubjectMetric(t, s, "team_addressed", "match", "team")
	matchSubj := seedSubjectMetric(t, s, "match_addressed", "match", "match")
	player := seedValueMetric(t, s, "player_addressed", "match")
	career := seedValueMetric(t, s, "career_addressed", "profile")

	// A match/team subject addressed to no match: rejected before the
	// transaction opens, and nothing lands.
	for _, id := range []int64{team, matchSubj} {
		err := s.InsertMetricValues(id, 1, 1, []MetricValueRow{
			{MatchID: 0, SubjectKey: "ct", Value: 1, N: 1},
		})
		if err == nil || !strings.Contains(err.Error(), "must belong to a match") {
			t.Errorf("career-bucket insert = %v, want the match-required error", err)
		}
		if n := storedCount(t, s, id); n != 0 {
			t.Errorf("rows after the rejected insert = %d, want 0", n)
		}
	}

	// The same subjects addressed to a real match land.
	if err := s.InsertMetricValues(team, 1, 1, []MetricValueRow{
		{MatchID: matchID, SubjectKey: "ct", Value: 1, N: 1},
	}); err != nil {
		t.Errorf("team value at a match: %v", err)
	}
	if err := s.InsertMetricValues(matchSubj, 1, 1, []MetricValueRow{
		{MatchID: matchID, SubjectKey: "", Value: 2, N: 1},
	}); err != nil {
		t.Errorf("match-subject value at a match: %v", err)
	}
	// Player subject: match grain (> 0) and career bucket (= 0) both pass.
	if err := s.InsertMetricValues(player.ID, 1, 1, []MetricValueRow{
		{MatchID: matchID, SubjectKey: "76561198000000001", Value: 3, N: 1},
	}); err != nil {
		t.Errorf("player match-grain value: %v", err)
	}
	if err := s.InsertMetricValues(career.ID, 1, 1, []MetricValueRow{
		{MatchID: 0, SubjectKey: "76561198000000001", Value: 4, N: 1},
	}); err != nil {
		t.Errorf("player career-bucket value: %v", err)
	}
	if n := storedCount(t, s, player.ID); n != 1 {
		t.Errorf("player match-grain rows = %d, want 1", n)
	}
	if n := storedCount(t, s, career.ID); n != 1 {
		t.Errorf("player career rows = %d, want 1", n)
	}
}

// TestMetricCoverageBehindPredicate pins THE clause matrix (design §4's
// one spelling): absent / metric_version behind / rule_version behind /
// all-live, plus the library-empty guards that make an empty library
// no-data instead of permanent behindness.
func TestMetricCoverageBehindPredicate(t *testing.T) {
	s, _ := openFileStore(t)
	t.Cleanup(func() { _ = s.CloseRO() })
	cfg, err := s.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	live := cfg.RuleVersion

	matchID := seedReadyMatch(t, s, "cov-1")
	m := seedValueMetric(t, s, "cov_match", "match")

	// (1) Never computed: a ready match exists and has no rows → behind.
	if c := coverageOf(t, s, m.ID, live); !c.Behind || c.FreshRows != 0 {
		t.Errorf("absent = %+v, want behind with 0 fresh rows", c)
	}

	// (2) All-live: a row stamped with the current versions covers the
	// unit → not behind, one fresh row (and the OUTDATED rows are what
	// count as invisible — see (4)).
	if err := s.InsertMetricValues(m.ID, m.Version, live, []MetricValueRow{
		{MatchID: matchID, SubjectKey: "76561198000000001", Value: 3, N: 7},
	}); err != nil {
		t.Fatalf("insert: %v", err)
	}
	if c := coverageOf(t, s, m.ID, live); c.Behind || c.FreshRows != 1 {
		t.Errorf("live = %+v, want fresh (not behind)", c)
	}

	// (3) Rule axis: a rules bump (SetConfig's rule_version + 1) makes
	// every existing row fail rule_version < live — behind immediately,
	// with NO write of its own (design §4: SetConfig stays a pure config
	// bump).
	cfg.RuleVersion = live + 1
	if _, err := s.SetConfig(cfg); err != nil {
		t.Fatalf("SetConfig: %v", err)
	}
	if c := coverageOf(t, s, m.ID, live+1); !c.Behind || c.FreshRows != 0 {
		t.Errorf("rules-behind = %+v, want behind with 0 fresh (outdated rows present but invisible)", c)
	}
	if n := storedCount(t, s, m.ID); n != 1 {
		t.Errorf("physical rows after rules bump = %d, want 1 (no write — deletion is the sweep's alone)", n)
	}

	// (4) Version axis: re-stamp under the live rule version, then bump
	// the METRIC's version (the save-side cascade walk) — the row fails
	// metric_version < version → behind again.
	if err := s.ClearMetricValues(m.ID); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if err := s.InsertMetricValues(m.ID, m.Version, live+1, []MetricValueRow{
		{MatchID: matchID, SubjectKey: "76561198000000001", Value: 3, N: 7},
	}); err != nil {
		t.Fatalf("reinsert: %v", err)
	}
	if c := coverageOf(t, s, m.ID, live+1); c.Behind {
		t.Errorf("re-stamped = %+v, want fresh", c)
	}
	if _, err := s.SaveMetricWithDeps(models.MetricRow{
		ID: m.ID, Name: m.Name, Title: m.Title, Expr: "from events: count(where kind='kill')",
		Scope: "match", Origin: "user",
	}, nil, nil, true); err != nil {
		t.Fatalf("semantic save: %v", err)
	}
	if c := coverageOf(t, s, m.ID, live+1); !c.Behind || c.FreshRows != 0 {
		t.Errorf("version-behind = %+v, want behind with 0 fresh", c)
	}

	// (5) Profile guard: a profile metric with NO rows and an EMPTY
	// library (no player_stats) is NOT behind — nothing to compute is
	// no-data, never an infinite recompute loop.
	p := seedValueMetric(t, s, "cov_profile", "profile")
	if c := coverageOf(t, s, p.ID, live+1); c.Behind {
		t.Errorf("empty-library profile = %+v, want not behind (no-data)", c)
	}
	// With library data present, the cleared career bucket IS behind.
	pid := seedReadyMatch(t, s, "cov-2")
	if _, err := s.db.Exec(`INSERT INTO player_stats (match_id, steam_id) VALUES (?, ?)`,
		pid, "76561198000000002"); err != nil {
		t.Fatalf("seed player_stats: %v", err)
	}
	if c := coverageOf(t, s, p.ID, live+1); !c.Behind {
		t.Errorf("profile with data, no career rows = %+v, want behind", c)
	}

	// (6) Match-scope absence on a SECOND ready match: a new import
	// leaves the old rows live but the new unit uncovered → behind (the
	// import trigger's whole point).
	seedReadyMatch(t, s, "cov-3")
	if c := coverageOf(t, s, m.ID, live+1); !c.Behind {
		t.Errorf("new uncovered match = %+v, want behind", c)
	}
}

// TestInsertMetricValuesRollsBackAtomically is the crash-matrix pin
// (design §4): phase 2 is ONE transaction — a failure mid-insert (here a
// primary-key conflict inside the batch) rolls the WHOLE set back, so a
// failed compute never leaves half-written rows. Re-running the phase
// (the next sweep) completes it — strict fresh-or-nothing at rest.
func TestInsertMetricValuesRollsBackAtomically(t *testing.T) {
	s, _ := openFileStore(t)
	t.Cleanup(func() { _ = s.CloseRO() })
	matchID := seedReadyMatch(t, s, "crash-1")
	m := seedValueMetric(t, s, "crash_metric", "match")

	// A clean set lands.
	good := []MetricValueRow{
		{MatchID: matchID, SubjectKey: "76561198000000001", Value: 1, N: 2},
		{MatchID: matchID, SubjectKey: "76561198000000002", Value: 2, N: 3},
	}
	if err := s.InsertMetricValues(m.ID, m.Version, 1, good); err != nil {
		t.Fatalf("insert good: %v", err)
	}
	if n := storedCount(t, s, m.ID); n != 2 {
		t.Fatalf("rows after good insert = %d, want 2", n)
	}

	// A set with an internal duplicate key fails on the SECOND row —
	// after the first row of the same tx already executed. The tx must
	// roll back everything, INCLUDING that first row: no half-written
	// metric, no partially replaced generation.
	bad := []MetricValueRow{
		{MatchID: matchID, SubjectKey: "76561198000000003", Value: 9, N: 9},
		{MatchID: matchID, SubjectKey: "76561198000000003", Value: 10, N: 10}, // PK conflict
	}
	if err := s.InsertMetricValues(m.ID, m.Version, 1, bad); err == nil {
		t.Fatal("duplicate-key insert succeeded, want a constraint error")
	}
	if n := storedCount(t, s, m.ID); n != 2 {
		t.Errorf("rows after failed insert = %d, want 2 (the whole tx rolled back — no half-written batch)", n)
	}
	res, err := s.QueryWrite(t.Context(),
		`SELECT subject_key, value FROM metric_values WHERE metric_id = ? ORDER BY subject_key`,
		[]any{m.ID}, 10)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if len(res.Rows) != 2 || res.Rows[0][0] != "76561198000000001" {
		t.Errorf("rows = %+v, want the original two untouched", res.Rows)
	}

	// Re-running the full unit — phase 1 then the corrected phase 2 —
	// completes the replace: the interrupted-compute re-run the crash
	// matrix promises (absent after phase 1, exactly the fresh set after
	// phase 2 commits).
	if err := s.ClearMetricValues(m.ID); err != nil {
		t.Fatalf("re-run phase 1: %v", err)
	}
	if n := storedCount(t, s, m.ID); n != 0 {
		t.Fatalf("rows after re-run phase 1 = %d, want 0 (absent → behind)", n)
	}
	if err := s.InsertMetricValues(m.ID, m.Version, 1, []MetricValueRow{
		{MatchID: matchID, SubjectKey: "76561198000000003", Value: 9, N: 9},
	}); err != nil {
		t.Fatalf("re-run insert: %v", err)
	}
	if n := storedCount(t, s, m.ID); n != 1 {
		t.Errorf("rows after re-run = %d, want 1 (phase 2 replaced the set)", n)
	}
}

// TestClearMetricValuesIsPerMetric pins phase 1's scope: the sweep
// deletes exactly the target metric's rows and NOTHING else (the
// "sweep deletes exactly the target metrics' outdated rows and nothing
// else" clause — other metrics' values are never collateral).
func TestClearMetricValuesIsPerMetric(t *testing.T) {
	s, _ := openFileStore(t)
	t.Cleanup(func() { _ = s.CloseRO() })
	matchID := seedReadyMatch(t, s, "clear-1")
	a := seedValueMetric(t, s, "clear_a", "match")
	b := seedValueMetric(t, s, "clear_b", "match")
	for _, m := range []models.MetricRow{a, b} {
		if err := s.InsertMetricValues(m.ID, m.Version, 1, []MetricValueRow{
			{MatchID: matchID, SubjectKey: "76561198000000001", Value: 1, N: 1},
			{MatchID: matchID, SubjectKey: "76561198000000002", Value: 2, N: 2},
		}); err != nil {
			t.Fatalf("insert %s: %v", m.Name, err)
		}
	}
	if err := s.ClearMetricValues(a.ID); err != nil {
		t.Fatalf("clear a: %v", err)
	}
	if n := storedCount(t, s, a.ID); n != 0 {
		t.Errorf("a's rows after clear = %d, want 0", n)
	}
	if n := storedCount(t, s, b.ID); n != 2 {
		t.Errorf("b's rows after clearing a = %d, want 2 (untouched)", n)
	}
}

// TestBumpMetricAndDependentsCascade pins the save-side version walk
// (design §4): the edited metric AND every TRANSITIVE dependent bump by
// exactly 1 in the caller's transaction, forward-only (a hand-edited
// cycle terminates instead of looping), and non-dependents never move.
// The semantic-vs-display decision lives at the service (SaveMetric) —
// this pins the walk itself.
func TestBumpMetricAndDependentsCascade(t *testing.T) {
	s, _ := openFileStore(t)
	t.Cleanup(func() { _ = s.CloseRO() })

	up := seedValueMetric(t, s, "bump_up", "match")
	mid := seedValueMetric(t, s, "bump_mid", "match")
	leaf := seedValueMetric(t, s, "bump_leaf", "match")
	other := seedValueMetric(t, s, "bump_other", "match")
	// Edges: leaf → mid → up (save the DEPS the service would derive).
	for _, e := range []struct {
		m     models.MetricRow
		edges []string
	}{
		{mid, []string{"bump_up"}},
		{leaf, []string{"bump_mid"}},
	} {
		if _, err := s.SaveMetricWithDeps(models.MetricRow{
			ID: e.m.ID, Name: e.m.Name, Title: e.m.Title, Expr: e.m.Expr,
			Scope: "match", Origin: "user",
		}, e.edges, nil, false); err != nil {
			t.Fatalf("wire edges for %s: %v", e.m.Name, err)
		}
	}

	tx, err := s.db.Begin()
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := bumpMetricAndDependents(tx, up.ID); err != nil {
		t.Fatalf("bump: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit: %v", err)
	}

	for _, tc := range []struct {
		m    models.MetricRow
		want int
	}{
		{up, 2}, {mid, 2}, {leaf, 2}, {other, 1}, // other is not downstream
	} {
		now, err := s.GetMetric(tc.m.ID)
		if err != nil {
			t.Fatalf("GetMetric(%s): %v", tc.m.Name, err)
		}
		if now.Version != tc.want {
			t.Errorf("%s version = %d, want %d", tc.m.Name, now.Version, tc.want)
		}
	}

	// Cycle safety: a hand-edited cycle (up → other → up) terminates the
	// walk and bumps each member once — never a hang, never a loop. Run
	// synchronously: a hang is caught by the test binary's own timeout,
	// and no tx is left racing a watchdog rollback.
	if _, err := s.SaveMetricWithDeps(models.MetricRow{
		ID: up.ID, Name: up.Name, Title: up.Title, Expr: up.Expr,
		Scope: "match", Origin: "user",
	}, []string{"bump_other"}, nil, false); err != nil {
		t.Fatalf("wire cycle edge: %v", err)
	}
	if _, err := s.SaveMetricWithDeps(models.MetricRow{
		ID: other.ID, Name: other.Name, Title: other.Title, Expr: other.Expr,
		Scope: "match", Origin: "user",
	}, []string{"bump_up"}, nil, false); err != nil {
		t.Fatalf("wire cycle edge 2: %v", err)
	}
	tx2, err := s.db.Begin()
	if err != nil {
		t.Fatalf("begin 2: %v", err)
	}
	defer func() { _ = tx2.Rollback() }()
	if err := bumpMetricAndDependents(tx2, up.ID); err != nil {
		t.Fatalf("cycle bump: %v", err)
	}
	if err := tx2.Commit(); err != nil {
		t.Fatalf("commit 2: %v", err)
	}
	// Every member of the cycle bumped exactly once more (up and other
	// were both live rows; mid/leaf are downstream and follow).
	up2, err := s.GetMetric(up.ID)
	if err != nil {
		t.Fatalf("GetMetric(up): %v", err)
	}
	other2, err := s.GetMetric(other.ID)
	if err != nil {
		t.Fatalf("GetMetric(other): %v", err)
	}
	if up2.Version != 3 || other2.Version != 2 {
		t.Errorf("cycle bump versions: up=%d other=%d, want up=3 other=2 (each member once)", up2.Version, other2.Version)
	}
}

// TestMetricCoverageSubjectBranches pins THE behind predicate's
// subject-aware branches (metrics expansion §6): a match- or
// team-subject metric at match extent is behind iff a fresh row exists
// for that ready match — the same clause a player subject rides (it
// never constrains subject_key, so ANY fresh row for the match answers
// it, ONE team row included: per-team completeness is the emit's job,
// not the predicate's), and a newly imported uncovered match moves it
// behind again.
func TestMetricCoverageSubjectBranches(t *testing.T) {
	s, _ := openFileStore(t)
	t.Cleanup(func() { _ = s.CloseRO() })
	cfg, err := s.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	live := cfg.RuleVersion

	matchA := seedReadyMatch(t, s, "subj-axis-1")
	subjMetric := func(name, subject string) models.MetricRow {
		t.Helper()
		m, err := s.CreateMetric(models.MetricRow{
			Name: name, Title: name, Expr: "from rounds: count()",
			Scope: "match", Subject: subject, Origin: "user",
		})
		if err != nil {
			t.Fatalf("CreateMetric(%s): %v", name, err)
		}
		return m
	}
	mm := subjMetric("cov_match_subject", "match")
	mt := subjMetric("cov_team_subject", "team")

	// Absent on a ready match → behind for both subjects.
	if c := coverageOf(t, s, mm.ID, live); !c.Behind {
		t.Errorf("absent match-subject = %+v, want behind", c)
	}
	if c := coverageOf(t, s, mt.ID, live); !c.Behind {
		t.Errorf("absent team-subject = %+v, want behind", c)
	}

	// One fresh row for the match answers the clause — subject_key ''
	// for the match subject, ONE team key for the team subject (the
	// pinned "a fresh row exists for that match" rule).
	if err := s.InsertMetricValues(mm.ID, mm.Version, live, []MetricValueRow{
		{MatchID: matchA, SubjectKey: "", Value: 24, N: 1},
	}); err != nil {
		t.Fatalf("insert match-subject: %v", err)
	}
	if c := coverageOf(t, s, mm.ID, live); c.Behind {
		t.Errorf("match-subject with its match row = %+v, want fresh", c)
	}
	if err := s.InsertMetricValues(mt.ID, mt.Version, live, []MetricValueRow{
		{MatchID: matchA, SubjectKey: "ct", Value: 5, N: 12},
	}); err != nil {
		t.Fatalf("insert team-subject: %v", err)
	}
	if c := coverageOf(t, s, mt.ID, live); c.Behind {
		t.Errorf("team-subject with one team row for the match = %+v, want fresh (any fresh row answers the match clause)", c)
	}

	// A second ready match with no rows → behind again (the import
	// trigger's clause, subject-agnostic).
	seedReadyMatch(t, s, "subj-axis-2")
	if c := coverageOf(t, s, mm.ID, live); !c.Behind {
		t.Errorf("match-subject on a new uncovered match = %+v, want behind", c)
	}
	if c := coverageOf(t, s, mt.ID, live); !c.Behind {
		t.Errorf("team-subject on a new uncovered match = %+v, want behind", c)
	}
}

// TestMetricCoveragePartitionDimRule pins the dim-axis rule (metrics
// expansion §6 — "behind iff ANY expected dim row is missing", the
// simplest honest reading): a partitioned metric's expected dims per
// unit are the partition values its INPUTS currently carry (side: each
// side human rows played), each guarded so work that does not exist
// never reads as behind (the library-empty guard's criterion per dim).
func TestMetricCoveragePartitionDimRule(t *testing.T) {
	s, _ := openFileStore(t)
	t.Cleanup(func() { _ = s.CloseRO() })
	cfg, err := s.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	live := cfg.RuleVersion

	matchID := seedReadyMatch(t, s, "dim-rule-1")
	// Human input on BOTH sides (no players row marks them bot).
	for i, side := range []string{"ct", "t"} {
		if _, err := s.db.Exec(`INSERT INTO player_stats (match_id, steam_id, side) VALUES (?, ?, ?)`,
			matchID, fmt.Sprintf("7656119800000000%d", i+1), side); err != nil {
			t.Fatalf("seed player_stats side %s: %v", side, err)
		}
	}
	m, err := s.CreateMetric(models.MetricRow{
		Name: "cov_side_partition", Title: "cov_side_partition",
		Expr: "from player_stats: sum(kills)", Scope: "match",
		Partition: "side", Origin: "user",
	})
	if err != nil {
		t.Fatalf("CreateMetric: %v", err)
	}

	// Both input sides expect a fresh dim row: absent → behind (the
	// match clause alone already says so; the dim axis takes over once
	// SOME rows exist).
	if err := s.InsertMetricValues(m.ID, m.Version, live, []MetricValueRow{
		{MatchID: matchID, SubjectKey: "76561198000000001", Dim: "ct", Value: 3, N: 1},
		{MatchID: matchID, SubjectKey: "76561198000000002", Dim: "t", Value: 4, N: 1},
	}); err != nil {
		t.Fatalf("insert both dims: %v", err)
	}
	if c := coverageOf(t, s, m.ID, live); c.Behind {
		t.Errorf("both dims fresh = %+v, want fresh", c)
	}

	// THE RULE: drop ONE input-carried dim row → behind (any dim row
	// missing), even though the match still has a fresh row.
	if _, err := s.db.Exec(`DELETE FROM metric_values WHERE metric_id = ? AND dim = 't'`, m.ID); err != nil {
		t.Fatalf("delete dim row: %v", err)
	}
	if c := coverageOf(t, s, m.ID, live); !c.Behind {
		t.Errorf("one input side without a dim row = %+v, want behind", c)
	}

	// Guard: a side NO human input carries is not expected — restoring
	// only ct and dropping the t INPUT leaves the metric fresh, never a
	// permanent-behind loop over work that does not exist.
	if _, err := s.db.Exec(`DELETE FROM player_stats WHERE match_id = ? AND side = 't'`, matchID); err != nil {
		t.Fatalf("delete t input: %v", err)
	}
	if _, err := s.db.Exec(`DELETE FROM metric_values WHERE metric_id = ? AND dim = 'ct'`, m.ID); err != nil {
		t.Fatalf("reset dim rows: %v", err)
	}
	if err := s.InsertMetricValues(m.ID, m.Version, live, []MetricValueRow{
		{MatchID: matchID, SubjectKey: "76561198000000001", Dim: "ct", Value: 3, N: 1},
	}); err != nil {
		t.Fatalf("insert ct dim: %v", err)
	}
	if c := coverageOf(t, s, m.ID, live); c.Behind {
		t.Errorf("only the input-carried side present = %+v, want fresh (the absent side is not expected work)", c)
	}
}
