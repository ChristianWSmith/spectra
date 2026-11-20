package store

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// W4 — the canonical READ surface (stored-metrics design §5): the two
// value reads every view uses for a SAVED metric. These pin the four
// design contracts the views rely on —
//
//  1. FRESH rows only (the same metricValueFreshCond the sweep's
//     selection and MetricCoverage spell: an outdated row is physically
//     present but never served, so no view can render a stale value);
//  2. the grain split (match rows at match_id > 0 via
//     GetMetricValuesForMatch, career rows at match_id = 0 via
//     GetMetricValuesForPlayer — the two never cross);
//  3. canonical metric order (metricOrder: builtin → user → plugin,
//     name ASC) then subject_key, so a view zips rows against ListMetrics
//     without a second sort;
//  4. absent-row honesty — a player the statement produced no row for
//     has NO row here (never a fabricated 0; the view renders the
//     state).
//
// The DTO shape itself (exactly {metricId, subjectKey, value,
// valueKey, n}) is pinned by models.TestMetricValueJSONContract.

// seedOrderMetric inserts a definition with an explicit origin (the
// canonical order test needs all three origin ranks).
func seedOrderMetric(t *testing.T, s *Store, name, origin string) models.MetricRow {
	t.Helper()
	m, err := s.CreateMetric(models.MetricRow{
		Name: name, Title: name, Expr: "from events: count()",
		Scope: "match", Origin: origin,
	})
	if err != nil {
		t.Fatalf("CreateMetric(%s): %v", name, err)
	}
	return m
}

// TestGetMetricValuesForMatchFreshOrderedAndHonest pins the match-grain
// read: fresh-only serving, canonical metric order then subject_key, the
// grain guard (match id required), the metric filter and absent-row
// honesty.
func TestGetMetricValuesForMatchFreshOrderedAndHonest(t *testing.T) {
	s, _ := openFileStore(t)
	t.Cleanup(func() { _ = s.CloseRO() })
	cfg, err := s.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	live := cfg.RuleVersion

	matchA := seedReadyMatch(t, s, "read-a")
	matchB := seedReadyMatch(t, s, "read-b")

	// Canonical order is by ORIGIN RANK then name — created in exactly
	// the reverse of the order they must come back.
	plugin := seedOrderMetric(t, s, "z_plug", "plugin")
	user := seedOrderMetric(t, s, "a_user", "user")
	builtin := seedOrderMetric(t, s, "m_builtin", "builtin")

	// Fresh rows for match A: two players on the builtin metric, one on
	// the others (subject_key ties break the order inside a metric).
	if err := s.InsertMetricValues(builtin.ID, builtin.Version, live, []MetricValueRow{
		{MatchID: matchA, SubjectKey: "76561198000000002", Value: 2, N: 5},
		{MatchID: matchA, SubjectKey: "76561198000000001", Value: 1, N: 4},
	}); err != nil {
		t.Fatalf("insert builtin: %v", err)
	}
	for _, m := range []models.MetricRow{user, plugin} {
		if err := s.InsertMetricValues(m.ID, m.Version, live, []MetricValueRow{
			{MatchID: matchA, SubjectKey: "76561198000000001", Value: 9, N: 9},
		}); err != nil {
			t.Fatalf("insert %s: %v", m.Name, err)
		}
	}
	// An OUTDATED row for the same match (metric_version 0 = never
	// stamped = behind): physically present, never served.
	if err := s.InsertMetricValues(user.ID, 0, live, []MetricValueRow{
		{MatchID: matchA, SubjectKey: "76561198000000003", Value: 77, N: 77},
	}); err != nil {
		t.Fatalf("insert stale: %v", err)
	}

	rows, err := s.GetMetricValuesForMatch(matchA, nil)
	if err != nil {
		t.Fatalf("GetMetricValuesForMatch: %v", err)
	}
	// Order: builtin (2 players, steam ASC) → user → plugin; the stale
	// user row for …0003 must not appear.
	if len(rows) != 4 {
		t.Fatalf("rows = %d, want 4 (fresh only): %+v", len(rows), rows)
	}
	wantOrder := []struct {
		metric int64
		steam  string
	}{
		{builtin.ID, "76561198000000001"},
		{builtin.ID, "76561198000000002"},
		{user.ID, "76561198000000001"},
		{plugin.ID, "76561198000000001"},
	}
	for i, w := range wantOrder {
		if rows[i].MetricID != w.metric || rows[i].SubjectKey != w.steam {
			t.Errorf("row[%d] = {metric %d, %s}, want {metric %d, %s}",
				i, rows[i].MetricID, rows[i].SubjectKey, w.metric, w.steam)
		}
	}
	// Absent-row honesty: …0003 has no fresh row → NO row (never a 0).
	for _, r := range rows {
		if r.SubjectKey == "76561198000000003" {
			t.Errorf("outdated row served: %+v (fresh-only contract broken)", r)
		}
	}
	if n := storedCount(t, s, user.ID); n != 2 {
		t.Errorf("user metric physical rows = %d, want 2 (the stale one is present-but-invisible)", n)
	}

	// The metric filter narrows the read (a view's pin/checkbox set).
	filt, err := s.GetMetricValuesForMatch(matchA, []int64{user.ID})
	if err != nil {
		t.Fatalf("filtered read: %v", err)
	}
	if len(filt) != 1 || filt[0].MetricID != user.ID {
		t.Errorf("filtered rows = %+v, want only metric %d", filt, user.ID)
	}

	// Grain guard: match 0 is the career grain — never this read.
	if _, err := s.GetMetricValuesForMatch(0, nil); err == nil {
		t.Error("GetMetricValuesForMatch(0) succeeded, want the match-id guard")
	}

	// Another match with no stored rows returns NOTHING (the view
	// renders behind, never a fabricated value).
	other, err := s.GetMetricValuesForMatch(matchB, nil)
	if err != nil {
		t.Fatalf("read match B: %v", err)
	}
	if len(other) != 0 {
		t.Errorf("match B rows = %+v, want none", other)
	}
}

// TestGetMetricValuesForPlayerGrain pins the career-grain read: only
// match_id = 0 rows, the whole-bucket vs single-player split ("" is the
// value slot's unit coverage + Builder's all-players preview) and the
// metric filter.
func TestGetMetricValuesForPlayerGrain(t *testing.T) {
	s, _ := openFileStore(t)
	t.Cleanup(func() { _ = s.CloseRO() })
	cfg, err := s.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	live := cfg.RuleVersion

	matchID := seedReadyMatch(t, s, "read-career")
	other := seedOrderMetric(t, s, "career_a", "user")
	second := seedOrderMetric(t, s, "career_b", "user")

	const (
		amy = "76561198000000001"
		bob = "76561198000000002"
	)
	// Career rows (match 0) for two players + a MATCH row for the same
	// metric — the grain split must keep them apart.
	if err := s.InsertMetricValues(other.ID, other.Version, live, []MetricValueRow{
		{MatchID: 0, SubjectKey: bob, Value: 20, N: 8},
		{MatchID: 0, SubjectKey: amy, Value: 10, N: 4},
		{MatchID: matchID, SubjectKey: amy, Value: 99, N: 1},
	}); err != nil {
		t.Fatalf("insert career: %v", err)
	}
	if err := s.InsertMetricValues(second.ID, second.Version, live, []MetricValueRow{
		{MatchID: 0, SubjectKey: amy, Value: 3, N: 2},
	}); err != nil {
		t.Fatalf("insert second: %v", err)
	}

	// The whole bucket: career rows only, canonical metric order then
	// subject_key — no match row, ever.
	bucket, err := s.GetMetricValuesForPlayer("", nil)
	if err != nil {
		t.Fatalf("bucket read: %v", err)
	}
	if len(bucket) != 3 {
		t.Fatalf("bucket rows = %d, want 3 (career grain only): %+v", len(bucket), bucket)
	}
	for _, r := range bucket {
		if r.MetricID == other.ID && r.SubjectKey == amy && r.Value != nil && *r.Value == 99 {
			t.Errorf("match-grain row leaked into the career read: %+v", r)
		}
	}
	if bucket[0].MetricID != other.ID || bucket[0].SubjectKey != amy ||
		bucket[1].MetricID != other.ID || bucket[1].SubjectKey != bob ||
		bucket[2].MetricID != second.ID {
		t.Errorf("bucket order = %+v, want [other/amy, other/bob, second/amy]", bucket)
	}

	// One player: the same read narrowed by steam id.
	one, err := s.GetMetricValuesForPlayer(amy, nil)
	if err != nil {
		t.Fatalf("player read: %v", err)
	}
	if len(one) != 2 {
		t.Fatalf("player rows = %d, want 2: %+v", len(one), one)
	}
	for _, r := range one {
		if r.SubjectKey != amy {
			t.Errorf("player read returned another subject: %+v", r)
		}
	}

	// A player with no stored row gets NO row (honest absence).
	none, err := s.GetMetricValuesForPlayer("76561198000000009", nil)
	if err != nil {
		t.Fatalf("empty player read: %v", err)
	}
	if len(none) != 0 {
		t.Errorf("unknown player rows = %+v, want none (never a fabricated 0)", none)
	}

	// The metric filter narrows the bucket read too.
	filt, err := s.GetMetricValuesForPlayer("", []int64{second.ID})
	if err != nil {
		t.Fatalf("filtered bucket read: %v", err)
	}
	if len(filt) != 1 || filt[0].MetricID != second.ID {
		t.Errorf("filtered bucket = %+v, want only metric %d", filt, second.ID)
	}
}

// TestGetMetricValuesReadsCarryNoStampKeys pins the binding contract at
// the read boundary itself: the JSON a view receives from either
// canonical read carries exactly the four DTO keys — no stamp, no
// computed_at — so no rendered output can contain a version number by
// construction (design §5).
func TestGetMetricValuesReadsCarryNoStampKeys(t *testing.T) {
	s, _ := openFileStore(t)
	t.Cleanup(func() { _ = s.CloseRO() })
	cfg, err := s.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	matchID := seedReadyMatch(t, s, "read-dto")
	m := seedValueMetric(t, s, "dto_metric", "match")
	if err := s.InsertMetricValues(m.ID, m.Version, cfg.RuleVersion, []MetricValueRow{
		{MatchID: matchID, SubjectKey: "76561198000000001", Value: 1, N: 1},
	}); err != nil {
		t.Fatalf("insert: %v", err)
	}
	if err := s.InsertMetricValues(m.ID, m.Version, cfg.RuleVersion, []MetricValueRow{
		{MatchID: 0, SubjectKey: "76561198000000001", Value: 2, N: 2},
	}); err != nil {
		t.Fatalf("insert career: %v", err)
	}

	matchRows, err := s.GetMetricValuesForMatch(matchID, nil)
	if err != nil {
		t.Fatalf("match read: %v", err)
	}
	careerRows, err := s.GetMetricValuesForPlayer("", nil)
	if err != nil {
		t.Fatalf("career read: %v", err)
	}
	for name, v := range map[string]any{"match": matchRows, "career": careerRows} {
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatalf("marshal %s: %v", name, err)
		}
		s := string(b)
		for _, forbidden := range []string{
			"version", "metricVersion", "ruleVersion", "computedAt", "computed_at",
		} {
			if strings.Contains(s, forbidden) {
				t.Errorf("%s read JSON carries the internal-only %q: %s", name, forbidden, s)
			}
		}
		if !strings.Contains(s, `"metricId"`) || !strings.Contains(s, `"subjectKey"`) ||
			!strings.Contains(s, `"value"`) || !strings.Contains(s, `"n"`) {
			t.Errorf("%s read JSON missing a DTO key: %s", name, s)
		}
	}
}

// TestMetricValueIdentityKeyRoundTrip pins the identity slot through
// THE canonical read (metrics expansion §3.3): an argmax row's
// value_key rides the phase-2 write (InsertMetricValues) into
// GetMetricValuesForMatch's DTO beside the companion value, with N as
// the pool it was chosen from — while a numeric row carries "" in the
// slot. Freshness is unchanged: an outdated identity row stays
// present-but-unserved like any other stale row.
func TestMetricValueIdentityKeyRoundTrip(t *testing.T) {
	s, _ := openFileStore(t)
	t.Cleanup(func() { _ = s.CloseRO() })
	cfg, err := s.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	live := cfg.RuleVersion

	match := seedReadyMatch(t, s, "identity-read")
	ident := seedOrderMetric(t, s, "ident_leader", "user")
	numeric := seedOrderMetric(t, s, "plain_count", "user")

	if err := s.InsertMetricValues(ident.ID, ident.Version, live, []MetricValueRow{
		{MatchID: match, SubjectKey: "", ValueKey: "76561198000000008", Value: 16, N: 8},
	}); err != nil {
		t.Fatalf("insert identity: %v", err)
	}
	if err := s.InsertMetricValues(numeric.ID, numeric.Version, live, []MetricValueRow{
		{MatchID: match, SubjectKey: "76561198000000001", Value: 3, N: 8},
	}); err != nil {
		t.Fatalf("insert numeric: %v", err)
	}

	rows, err := s.GetMetricValuesForMatch(match, []int64{ident.ID, numeric.ID})
	if err != nil {
		t.Fatalf("GetMetricValuesForMatch: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("rows = %d, want 2 (%+v)", len(rows), rows)
	}
	for _, r := range rows {
		if r.MetricID == ident.ID {
			if r.ValueKey != "76561198000000008" || r.Value == nil || *r.Value != 16 || r.N != 8 || r.SubjectKey != "" {
				t.Errorf("identity row = %+v, want ValueKey …008 / Value 16 / N 8 (the pool) / subject \"\"", r)
			}
		} else if r.ValueKey != "" {
			t.Errorf("numeric row = %+v, want ValueKey \"\"", r)
		}
	}

	// An outdated identity row is present but never served (the ONE
	// freshness spelling — an identity rides it unchanged).
	staleMatch := seedReadyMatch(t, s, "identity-read-stale")
	if err := s.InsertMetricValues(ident.ID, 0, live, []MetricValueRow{
		{MatchID: staleMatch, SubjectKey: "", ValueKey: "76561198000000001", Value: 99, N: 8},
	}); err != nil {
		t.Fatalf("insert stale identity: %v", err)
	}
	fresh, err := s.GetMetricValuesForMatch(staleMatch, []int64{ident.ID})
	if err != nil {
		t.Fatalf("fresh read: %v", err)
	}
	if len(fresh) != 0 {
		t.Errorf("stale identity rows served = %+v, want none (present but invisible)", fresh)
	}
}
