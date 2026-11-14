package main

import (
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/metrics"
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// W2b — the metric() reference GRAPH at the service level (design §2):
// deps round-trip after every save shape, the delete block, the
// cross-scope matrix, cycle rejection, the rename splice (including an
// identical evaluation on seed data) and its no-bump rule, plus the
// system-path verifications (plugin replace never routes through
// DeleteMetric; metric_deps.metric_id's FK CASCADE is the backstop).

// depsFixture is a MetricsService over a file-backed store (file-backed
// because previews run on the read-only session).
type depsFixture struct {
	svc  *MetricsService
	st   *store.Store
	path string
}

func newDepsFixture(t *testing.T) *depsFixture {
	t.Helper()
	path := filepath.Join(t.TempDir(), "metricdeps.db")
	st, err := store.Open(path)
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.CloseRO(); _ = st.Close() })
	return &depsFixture{svc: &MetricsService{st: st}, st: st, path: path}
}

// save runs SaveMetric with the field defaults every fixture row wants.
func (f *depsFixture) save(t *testing.T, m models.MetricRow) models.MetricRow {
	t.Helper()
	if m.Format == "" {
		m.Format = "int"
	}
	if m.Scope == "" {
		m.Scope = "match"
	}
	if m.Doc == "" {
		m.Doc = "Formula: " + m.Expr
	}
	saved, err := f.svc.SaveMetric(m)
	if err != nil {
		t.Fatalf("SaveMetric(%q): %v", m.Name, err)
	}
	return saved
}

// wantDeps pins THE round-trip contract (design §2): after every save
// shape the stored edges equal the DISTINCT metrics.MetricRefs of the
// CURRENT expression (sorted — metric_deps is a set, the walk keeps
// every occurrence).
func (f *depsFixture) wantDeps(t *testing.T, id int64, expr string) {
	t.Helper()
	spec, perr := metrics.Parse(expr)
	if perr != nil {
		t.Fatalf("Parse(%q): %v", expr, perr)
	}
	want := metrics.DistinctNames(metrics.MetricRefs(spec))
	sort.Strings(want)
	got, err := f.st.MetricDeps(id)
	if err != nil {
		t.Fatalf("MetricDeps(%d): %v", id, err)
	}
	if len(got) == 0 && len(want) == 0 {
		return
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("edges = %v, want %v (edges == distinct refs of the stored expr)", got, want)
	}
}

// builtinOf returns the schema-seeded built-in row.
func builtinOf(t *testing.T, svc *MetricsService) models.MetricRow {
	t.Helper()
	list, err := svc.ListMetrics()
	if err != nil {
		t.Fatalf("ListMetrics: %v", err)
	}
	for _, m := range list {
		if m.Origin == "builtin" {
			return m
		}
	}
	t.Fatal("schema-seeded builtin missing")
	return models.MetricRow{}
}

// TestMetricDepsRoundTrip pins the edge contract across EVERY save
// shape: create, display-only edit, expression edit (wholesale re-derive),
// duplicate refs collapsing to one edge, and rename. The metric's version
// stays untouched throughout — bumps are wave 3 and no save shape here is
// a semantic edit the counter would answer (a rename changes no
// semantics, a display-only edit changes none either).
func TestMetricDepsRoundTrip(t *testing.T) {
	f := newDepsFixture(t)
	builtin := builtinOf(t, f.svc)

	up1 := f.save(t, models.MetricRow{Name: "rt_up1", Expr: "from events: count()"})
	f.save(t, models.MetricRow{Name: "rt_up2", Expr: "from player_stats: sum(kills)", Scope: "profile"})
	// Create: refs in a ratio operand AND the top-level list, one of them
	// repeated (one edge), plus the seeded builtin as a target.
	dep := f.save(t, models.MetricRow{
		Name: "rt_dep",
		Expr: "from events: ratio(sum(dmg), metric('rt_up1')), metric('rt_up2'), metric('" + builtin.Name + "'), metric('rt_up1')",
	})
	f.wantDeps(t, dep.ID, dep.Expr)

	// Display-only edit: the expr does not move, so the edge set does not
	// either — and version stays at the INSERT default (no bump).
	dep.Title = "RT dep retitled"
	dep.Doc = "retitled doc"
	edited := f.save(t, dep)
	if edited.Expr != dep.Expr {
		t.Fatalf("display-only edit changed the expr: %q", edited.Expr)
	}
	f.wantDeps(t, edited.ID, edited.Expr)
	if edited.Version != 1 {
		t.Errorf("version = %d, want 1 (display-only: no bump)", edited.Version)
	}

	// Expression edit: edges are re-derived WHOLESALE — dropped names
	// leave, new ones arrive.
	dep = edited
	dep.Expr = "from events: metric('rt_up2'), metric('rt_up1')"
	edited = f.save(t, dep)
	f.wantDeps(t, edited.ID, edited.Expr)
	if got, _ := f.st.MetricDeps(edited.ID); !reflect.DeepEqual(got, []string{"rt_up1", "rt_up2"}) {
		t.Errorf("edges after expr edit = %v, want [rt_up1 rt_up2] (builtin edge gone)", got)
	}

	// Duplicate refs collapse to ONE edge (metric_deps is a set).
	dep = edited
	dep.Expr = "from events: metric('rt_up1'), metric('rt_up1')"
	edited = f.save(t, dep)
	f.wantDeps(t, edited.ID, edited.Expr)
	if got, _ := f.st.MetricDeps(edited.ID); !reflect.DeepEqual(got, []string{"rt_up1"}) {
		t.Errorf("edges = %v, want a single [rt_up1]", got)
	}

	// Rename: the dependent's literal and its edge follow the new name
	// (the splice), and the edges stay equal to the rewritten expr.
	up1.Name = "rt_up1_renamed"
	renamed := f.save(t, up1)
	if renamed.Version != 1 {
		t.Errorf("upstream version = %d, want 1 (no bump on rename)", renamed.Version)
	}
	after, err := f.svc.GetMetric(edited.ID)
	if err != nil {
		t.Fatalf("GetMetric: %v", err)
	}
	if after.Expr != "from events: metric('rt_up1_renamed'), metric('rt_up1_renamed')" {
		t.Errorf("dependent expr = %q, want the spliced literals", after.Expr)
	}
	f.wantDeps(t, after.ID, after.Expr)
	if _, err := f.st.GetMetricByName("rt_up1"); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("old name still resolvable after the rename: %v", err)
	}
}

// TestDeleteMetricBlockedByReferences pins the user-side block (design
// §2): the exact copy, the builtin guard still firing FIRST, the
// unblock path, and both FK layers — metric_id's CASCADE (a deleted
// metric never leaves its OWN edges behind) versus dep_name's
// deliberate ABSENCE of an FK (a system-removed upstream leaves the edge
// so the compute pass resolves-or-fails it honestly).
func TestDeleteMetricBlockedByReferences(t *testing.T) {
	f := newDepsFixture(t)

	up := f.save(t, models.MetricRow{Name: "del_up", Expr: "from events: count()"})
	depOne := f.save(t, models.MetricRow{Name: "del_dep_one", Expr: "from events: metric('del_up')"})
	depTwo := f.save(t, models.MetricRow{Name: "del_dep_two", Expr: "from events: ratio(count(), metric('del_up'))"})

	err := f.svc.DeleteMetric(up.ID)
	want := `cannot delete metric "del_up": referenced by del_dep_one, del_dep_two — edit or delete those first`
	if err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("delete err = %v, want the block with %q", err, want)
	}
	if _, err := f.st.GetMetricByName("del_up"); err != nil {
		t.Errorf("blocked delete removed the row: %v", err)
	}

	// The builtin guard still fires FIRST: a built-in that other
	// expressions reference reports the immutability copy, never the
	// reference block (guard order is a contract, pinned).
	builtin := builtinOf(t, f.svc)
	f.save(t, models.MetricRow{
		Name: "del_uses_builtin", Expr: "from events: metric('" + builtin.Name + "')",
	})
	err = f.svc.DeleteMetric(builtin.ID)
	if err == nil || !strings.Contains(err.Error(), "built-in metrics can't be deleted") {
		t.Errorf("builtin delete err = %v, want the immutability copy", err)
	} else if strings.Contains(err.Error(), "referenced by") {
		t.Errorf("reference block fired before the builtin guard: %v", err)
	}

	// Deleting the dependents unblocks the upstream (edit or delete them
	// first — then it goes).
	for _, id := range []int64{depOne.ID, depTwo.ID} {
		if err := f.svc.DeleteMetric(id); err != nil {
			t.Fatalf("delete dependent %d: %v", id, err)
		}
	}
	if err := f.svc.DeleteMetric(up.ID); err != nil {
		t.Errorf("delete after unblocking: %v", err)
	}

	// FK CASCADE (metric_deps.metric_id → metrics.id ON DELETE CASCADE):
	// deleting a metric removes ITS OWN edges — never a dangling
	// metric_id row.
	mid := f.save(t, models.MetricRow{Name: "del_mid", Expr: "from events: count()"})
	f.save(t, models.MetricRow{Name: "del_uses_mid", Expr: "from events: metric('del_mid')"})
	if err := f.st.DeleteMetric(mid.ID); err != nil {
		t.Fatalf("store delete: %v", err)
	}
	if got, err := f.st.MetricDeps(mid.ID); err != nil || len(got) != 0 {
		t.Errorf("deleted metric's own edges = %v, %v; want none (FK CASCADE)", got, err)
	}
	// dep_name has deliberately NO FK: the dependent's edge to the
	// removed metric SURVIVES (ids churn, names don't; the pass must see
	// the dangling reference and fail it honestly — never a 0).
	if got, _ := f.st.MetricDeps(mustID(t, f.st, "del_uses_mid")); !reflect.DeepEqual(got, []string{"del_mid"}) {
		t.Errorf("dependent edge = %v, want [del_mid] (dep_name has no FK)", got)
	}
}

// mustID resolves a name to its id, failing the test when absent.
func mustID(t *testing.T, st *store.Store, name string) int64 {
	t.Helper()
	m, err := st.GetMetricByName(name)
	if err != nil {
		t.Fatalf("GetMetricByName(%q): %v", name, err)
	}
	return m.ID
}

// TestCrossScopeReferenceMatrix pins design §2's key-containment rule in
// BOTH directions: a profile dependency is legal anywhere (the row's
// player key carries the career scalar), a match dependency inside a
// profile metric is rejected with the design's exact copy, and a
// rejected save writes nothing.
func TestCrossScopeReferenceMatrix(t *testing.T) {
	f := newDepsFixture(t)
	f.save(t, models.MetricRow{Name: "x_match", Expr: "from events: count()", Scope: "match"})
	f.save(t, models.MetricRow{Name: "x_profile", Expr: "from events: count()", Scope: "profile"})

	const crossScopeErr = "metric 'x_match' is match-scoped and cannot be used inside a profile-scoped metric (a career value cannot read a per-match value)"
	cases := []struct {
		name, depScope, depName, wantErr string
	}{
		{"match dep in a match dependent", "match", "x_match", ""},
		{"profile dep in a match dependent", "match", "x_profile", ""},
		{"profile dep in a profile dependent", "profile", "x_profile", ""},
		{"match dep in a profile dependent", "profile", "x_match", crossScopeErr},
	}
	for i, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			name := fmt.Sprintf("x_dep_%d", i)
			_, err := f.svc.SaveMetric(models.MetricRow{
				Name: name, Expr: "from events: metric('" + c.depName + "')",
				Scope: c.depScope, Format: "int", Doc: "Formula: x",
			})
			if c.wantErr == "" {
				if err != nil {
					t.Fatalf("save rejected: %v", err)
				}
				f.wantDeps(t, mustID(t, f.st, name), "from events: metric('"+c.depName+"')")
				return
			}
			if err == nil || !strings.Contains(err.Error(), c.wantErr) {
				t.Fatalf("err = %v, want %q", err, c.wantErr)
			}
			if _, gerr := f.st.GetMetricByName(name); !errors.Is(gerr, store.ErrNotFound) {
				t.Errorf("rejected save left a row behind: %v", gerr)
			}
		})
	}
	// The rule is a DEFINITION rule: ValidateExpr carries no scope (a
	// draft is authoring state), so the same draft resolves fine — the
	// save above is what rejects it.
	ok, ee, err := f.svc.ValidateExpr("from events: metric('x_match')")
	if err != nil || !ok || ee.Message != "" {
		t.Errorf("ValidateExpr = (%v, %+v, %v), want ok (drafts resolve existence only)", ok, ee, err)
	}
}

// TestCycleRejectedOnSave pins the service path of design §2's cycle
// rejection: the self-reference, a loop closed by an edit over
// {existing edges} ∪ {new refs}, a longer chain — and that a rejected
// save writes NOTHING (row and edges alike).
func TestCycleRejectedOnSave(t *testing.T) {
	f := newDepsFixture(t)

	// Self-reference: immediate cycle, nothing written.
	_, err := f.svc.SaveMetric(models.MetricRow{
		Name: "selfy", Expr: "from events: metric('selfy')", Scope: "match", Format: "int", Doc: "d",
	})
	if err == nil || !strings.Contains(err.Error(), "cyclic metric reference: selfy → selfy") {
		t.Fatalf("self-reference err = %v, want the cycle copy", err)
	}
	if _, gerr := f.st.GetMetricByName("selfy"); !errors.Is(gerr, store.ErrNotFound) {
		t.Errorf("rejected save wrote a row: %v", gerr)
	}

	// Existing edges: node_b → node_a. Editing node_a to reference
	// node_b closes a → b → a.
	a := f.save(t, models.MetricRow{Name: "node_a", Expr: "from events: count()"})
	b := f.save(t, models.MetricRow{Name: "node_b", Expr: "from events: metric('node_a')"})
	_, err = f.svc.SaveMetric(models.MetricRow{
		ID: a.ID, Name: a.Name, Title: a.Title, Expr: "from events: metric('node_b')",
		Scope: "match", Format: "int", Doc: "d",
	})
	if err == nil || !strings.Contains(err.Error(), "cyclic metric reference: node_a → node_b → node_a") {
		t.Fatalf("pair cycle err = %v, want node_a → node_b → node_a", err)
	}
	// Nothing written: row and edges both untouched.
	stored, err := f.st.GetMetric(a.ID)
	if err != nil {
		t.Fatalf("GetMetric: %v", err)
	}
	if stored.Expr != "from events: count()" {
		t.Errorf("expr = %q, want the pre-save expression", stored.Expr)
	}
	if got, _ := f.st.MetricDeps(a.ID); len(got) != 0 {
		t.Errorf("edges = %v, want none (rejected save wrote nothing)", got)
	}

	// A longer chain: node_c → node_b exists, so editing node_b to
	// reference node_c walks b → c → b.
	f.save(t, models.MetricRow{Name: "node_c", Expr: "from events: metric('node_b')"})
	_, err = f.svc.SaveMetric(models.MetricRow{
		ID: b.ID, Name: b.Name, Title: b.Title, Expr: "from events: metric('node_c')",
		Scope: "match", Format: "int", Doc: "d",
	})
	if err == nil || !strings.Contains(err.Error(), "cyclic metric reference: node_b → node_c → node_b") {
		t.Fatalf("chain cycle err = %v, want node_b → node_c → node_b", err)
	}
	// A non-cyclic edit to the same metric still lands (the check rejects
	// cycles, not edits).
	landed, err := f.svc.SaveMetric(models.MetricRow{
		ID: b.ID, Name: b.Name, Title: "retitled", Expr: b.Expr,
		Scope: "match", Format: "int", Doc: "d",
	})
	if err != nil {
		t.Fatalf("acyclic edit rejected: %v", err)
	}
	if landed.Title != "retitled" {
		t.Errorf("title = %q, want retitled", landed.Title)
	}
	f.wantDeps(t, landed.ID, landed.Expr)
}

// TestRenameSplicesDependents pins the design §2 rename: ONE save
// rewrites every dependent's metric('old') literal with the parse's own
// spans, rewrites its metric_deps rows, leaves non-dependents alone, and
// bumps NOTHING (semantics unchanged — version is untouched because the
// bump machinery deliberately does not exist yet).
func TestRenameSplicesDependents(t *testing.T) {
	f := newDepsFixture(t)

	up := f.save(t, models.MetricRow{Name: "upstream", Expr: "from events: count()", Scope: "match"})
	depOne := f.save(t, models.MetricRow{Name: "ren_dep_one", Expr: "from events: metric('upstream')"})
	depTwo := f.save(t, models.MetricRow{
		Name: "ren_dep_two",
		Expr: "from events: ratio(metric('upstream'), count()), metric('upstream')",
	})
	other := f.save(t, models.MetricRow{Name: "ren_other", Expr: "from events: count()"})

	up.Name = "renamed_up"
	renamed, err := f.svc.SaveMetric(up)
	if err != nil {
		t.Fatalf("rename: %v", err)
	}
	if renamed.Name != "renamed_up" {
		t.Errorf("name = %q, want renamed_up", renamed.Name)
	}
	if renamed.Version != 1 {
		t.Errorf("version = %d, want 1 — a rename must not bump (bumps are wave 3)", renamed.Version)
	}

	// Every dependent's expression AND edge set follow the name.
	for _, tc := range []struct {
		id   int64
		want string
	}{
		{depOne.ID, "from events: metric('renamed_up')"},
		{depTwo.ID, "from events: ratio(metric('renamed_up'), count()), metric('renamed_up')"},
	} {
		now, err := f.svc.GetMetric(tc.id)
		if err != nil {
			t.Fatalf("GetMetric(%d): %v", tc.id, err)
		}
		if now.Expr != tc.want {
			t.Errorf("dependent %d expr = %q, want %q", tc.id, now.Expr, tc.want)
		}
		f.wantDeps(t, now.ID, now.Expr)
		if now.Version != 1 {
			t.Errorf("dependent %d version = %d, want 1 (no bump on a rename)", tc.id, now.Version)
		}
	}
	// A non-dependent is untouched.
	if now, err := f.svc.GetMetric(other.ID); err != nil || now.Expr != other.Expr {
		t.Errorf("non-dependent = (%q, %v), want untouched", now.Expr, err)
	}
	if _, err := f.st.GetMetricByName("upstream"); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("old name still resolvable: %v", err)
	}
	// The graph view agrees: the renamed metric carries no edges of its
	// own (its expr is ref-free), and both spliced dependents point at
	// the NEW name.
	edges, err := f.st.ListMetricEdges()
	if err != nil {
		t.Fatalf("ListMetricEdges: %v", err)
	}
	if got, ok := edges["renamed_up"]; ok {
		t.Errorf("renamed metric's own edges = %v, want none", got)
	}
	for _, node := range []string{"ren_dep_one", "ren_dep_two"} {
		if got := edges[node]; !reflect.DeepEqual(got, []string{"renamed_up"}) {
			t.Errorf("edges[%s] = %v, want [renamed_up]", node, got)
		}
	}
}

// TestRenameSpliceFailureAbortsAtomically pins the abort rule: any
// dependent whose rewritten expression fails re-validation errors the
// save and NOTHING is written — not the rename, not the dependent.
func TestRenameSpliceFailureAbortsAtomically(t *testing.T) {
	f := newDepsFixture(t)

	// (1) The rewritten dependent resolves a SECOND reference that no
	// longer exists (a system-removed upstream): the splice succeeds but
	// re-validation fails on the dangling name.
	f.save(t, models.MetricRow{Name: "atom_up", Expr: "from events: count()"})
	ghost := f.save(t, models.MetricRow{Name: "atom_ghost", Expr: "from events: count()"})
	dep := f.save(t, models.MetricRow{
		Name: "atom_dep", Expr: "from events: metric('atom_up'), metric('atom_ghost')",
	})
	// Remove the upstream at the STORE level (the API would block it) —
	// its own edges cascade away, the dependent's edge dangles.
	if err := f.st.DeleteMetric(ghost.ID); err != nil {
		t.Fatalf("store delete: %v", err)
	}
	got, _ := f.st.MetricDeps(dep.ID)
	if !reflect.DeepEqual(got, []string{"atom_ghost", "atom_up"}) {
		t.Fatalf("edges = %v, want both (the dangling one must be there)", got)
	}

	_, err := f.svc.SaveMetric(models.MetricRow{
		ID: mustID(t, f.st, "atom_up"), Name: "atom_up_renamed", Title: "atom_up",
		Expr: "from events: count()", Scope: "match", Format: "int", Doc: "d",
	})
	if err == nil || !strings.Contains(err.Error(), `unknown metric reference "atom_ghost"`) {
		t.Fatalf("rename err = %v, want the dependent's re-validation failure", err)
	}
	// Nothing written: the upstream kept its name AND its row.
	if _, err := f.st.GetMetricByName("atom_up"); err != nil {
		t.Errorf("rejected rename renamed the row: %v", err)
	}
	if _, err := f.st.GetMetricByName("atom_up_renamed"); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("rejected rename wrote the new name: %v", err)
	}
	now, err := f.svc.GetMetric(dep.ID)
	if err != nil {
		t.Fatalf("GetMetric: %v", err)
	}
	if now.Expr != "from events: metric('atom_up'), metric('atom_ghost')" {
		t.Errorf("dependent expr = %q, want untouched", now.Expr)
	}
	f.wantDeps(t, now.ID, now.Expr)

	// (2) A rename that would leave a PROFILE dependent reading a
	// now-match-grained dependency fails the cross-scope rule during the
	// splice — same atomicity.
	up := f.save(t, models.MetricRow{Name: "atom_prof", Expr: "from events: count()", Scope: "profile"})
	f.save(t, models.MetricRow{Name: "atom_prof_dep", Expr: "from events: metric('atom_prof')", Scope: "profile"})
	up.Name = "atom_prof_renamed"
	up.Scope = "match"
	_, err = f.svc.SaveMetric(up)
	if err == nil || !strings.Contains(err.Error(), "is match-scoped and cannot be used inside a profile-scoped metric") {
		t.Fatalf("scope-changing rename err = %v, want the cross-scope rejection", err)
	}
	if still, err := f.svc.GetMetric(up.ID); err != nil || still.Scope != "profile" || still.Name != "atom_prof" {
		t.Errorf("rejected rename landed: (%q, %q, %v)", still.Name, still.Scope, err)
	}
}

// depSteamID / otherDepSteamID are the fixture roster (17-digit shape).
const (
	depSteamID  = "76561198000000001"
	otherDepSID = "76561198000000002"
)

// seedDepEventsMatch stores one match with a two-player roster and three
// damage events for depSteamID (10 + 20 + 30 = 60 damage).
func seedDepEventsMatch(t *testing.T, st *store.Store) int64 {
	t.Helper()
	id, err := st.CreateMatchRow("/d/deps/dep1.dem", "sha-deps-1", 1)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	em := &models.ExtractedMatch{
		Match: models.Match{
			Path: "/d/deps/dep1.dem", SHA256: "sha-deps-1", Map: "de_dust2",
			TickRate: 64, ExtractedAt: time.Now(),
		},
		Players: []models.Player{
			{SteamID: depSteamID, Name: "alice", Side: "ct"},
			{SteamID: otherDepSID, Name: "bob", Side: "t"},
		},
		PlayerStats: []models.PlayerStats{
			{SteamID: depSteamID, Name: "alice", Side: "ct", RoundsPlayed: 1},
			{SteamID: otherDepSID, Name: "bob", Side: "t", RoundsPlayed: 1},
		},
	}
	for i, dmg := range []int{10, 20, 30} {
		em.Events = append(em.Events, models.Event{
			Seq: i, Tick: 100 + i, Round: 1, Kind: "damage",
			Attacker: depSteamID, Victim: otherDepSID, Weapon: "ak47", Dmg: dmg,
		})
	}
	if err := st.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	return id
}

// seedStoredValue writes ONE metric_values row through a second SQLite
// connection. It is a TEST FIXTURE, not a writer: the compute pass and
// its writers are wave 3 and this package ships no production code that
// writes the table (nothing here is exported).
func seedStoredValue(t *testing.T, dbPath string, metricID, matchID int64, steamID string, value float64, n, metricVersion, ruleVersion int) {
	t.Helper()
	db, err := sql.Open("sqlite", dbPath+"?_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.Exec(
		`INSERT INTO metric_values (metric_id, match_id, steam_id, value, n, metric_version, rule_version)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		metricID, matchID, steamID, value, n, metricVersion, ruleVersion,
	); err != nil {
		t.Fatalf("seed metric_values: %v", err)
	}
}

// TestRenameSpliceEvaluatesIdentically pins the rename round-trip END
// TO END: with real source rows AND a stored upstream value, the
// dependent's preview returns exactly the same rows before and after the
// upstream's rename (60 damage over a stored 2 → 30, n = 3) — the splice
// rewrites text, never semantics.
func TestRenameSpliceEvaluatesIdentically(t *testing.T) {
	f := newDepsFixture(t)
	matchID := seedDepEventsMatch(t, f.st)

	up := f.save(t, models.MetricRow{Name: "ev_up", Expr: "from events: count()"})
	dep := f.save(t, models.MetricRow{Name: "ev_dep", Expr: "from events: ratio(sum(dmg), metric('ev_up'))"})

	cfg, err := f.st.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	// The join pins BOTH stamps, so the fixture row must be live: the
	// upstream's own version and the live rule version.
	seedStoredValue(t, f.path, up.ID, matchID, depSteamID, 2, 1, up.Version, cfg.RuleVersion)

	before, err := f.svc.PreviewMetric(dep.ID, "", "", 10)
	if err != nil {
		t.Fatalf("preview before rename: %v", err)
	}
	if len(before.Rows) != 1 {
		t.Fatalf("rows before = %+v, want the one seeded subject", before.Rows)
	}
	if before.Rows[0].Group != depSteamID || before.Rows[0].Value != 30 || before.Rows[0].N != 3 {
		t.Errorf("row before = %+v, want {group depSteamID value 30 n 3} (60 dmg / stored 2)", before.Rows[0])
	}

	up.Name = "ev_up_renamed"
	if _, err := f.svc.SaveMetric(up); err != nil {
		t.Fatalf("rename: %v", err)
	}

	after, err := f.svc.PreviewMetric(dep.ID, "", "", 10)
	if err != nil {
		t.Fatalf("preview after rename: %v", err)
	}
	if !reflect.DeepEqual(before.Rows, after.Rows) {
		t.Errorf("rows changed across the rename:\nbefore %+v\nafter  %+v", before.Rows, after.Rows)
	}
	if before.SQL != after.SQL {
		t.Errorf("compiled statement changed across the rename:\nbefore %s\nafter  %s", before.SQL, after.SQL)
	}
}

// TestDraftRefsResolveAgainstSavedMetrics pins the ad-hoc paths (design
// §5's "drafts are calculated"): ValidateExpr and an ad-hoc
// PreviewMetric both ACCEPT a draft carrying refs (the ref resolves
// against saved metrics), an unsaved name reports the positioned
// unknown-reference error a save would, and a ref-bearing preview over
// the still-empty metric_values table honestly returns no rows (INNER:
// upstream absent ⇒ dependent dropped, never 0).
func TestDraftRefsResolveAgainstSavedMetrics(t *testing.T) {
	f := newDepsFixture(t)
	f.save(t, models.MetricRow{Name: "draft_up", Expr: "from events: count()"})

	ok, ee, err := f.svc.ValidateExpr("from events: metric('draft_up')")
	if err != nil || !ok || ee.Message != "" {
		t.Errorf("ValidateExpr(draft with ref) = (%v, %+v, %v), want ok", ok, ee, err)
	}

	// An ad-hoc preview runs the draft against the saved metric.
	pv, err := f.svc.PreviewMetric(0, "from events: metric('draft_up')", "", 10)
	if err != nil {
		t.Fatalf("ad-hoc preview: %v", err)
	}
	if len(pv.Rows) != 0 {
		t.Errorf("rows = %+v, want none (metric_values is empty until W3 — INNER drops the dependent)", pv.Rows)
	}
	if !strings.Contains(pv.SQL, "INNER JOIN metric_values") {
		t.Errorf("preview SQL carries no ref join:\n%s", pv.SQL)
	}

	// A saved ref-bearing metric previews through the same resolution.
	f.save(t, models.MetricRow{Name: "draft_dep", Expr: "from events: metric('draft_up')"})
	if _, err := f.svc.PreviewMetric(mustID(t, f.st, "draft_dep"), "", "", 10); err != nil {
		t.Fatalf("saved ref-bearing preview: %v", err)
	}

	// An unsaved name is the positioned error on BOTH paths (one copy).
	ok, ee, err = f.svc.ValidateExpr("from events: metric('never_saved')")
	if err != nil || ok {
		t.Fatalf("ValidateExpr(unknown ref) = (%v, %+v, %v), want rejection", ok, ee, err)
	}
	if ee.Message != `unknown metric reference "never_saved"` || ee.Pos <= 0 {
		t.Errorf("ExprError = %+v, want the positioned unknown-reference copy", ee)
	}
	_, err = f.svc.SaveMetric(models.MetricRow{
		Name: "bad_draft", Expr: "from events: metric('never_saved')", Scope: "match", Format: "int", Doc: "d",
	})
	if err == nil || !strings.Contains(err.Error(), `unknown metric reference "never_saved"`) {
		t.Errorf("save err = %v, want the same copy", err)
	}
	if _, gerr := f.st.GetMetricByName("bad_draft"); !errors.Is(gerr, store.ErrNotFound) {
		t.Errorf("rejected save wrote a row: %v", gerr)
	}
}

// TestPluginPathsBypassTheDeleteBlock verifies the design's split:
// ReplacePluginMetrics / DeletePluginMetrics never route through
// MetricsService.DeleteMetric, so a referenced plugin metric can still be
// replaced and removed — while the dependent's NAME-keyed edge survives
// the id churn and dangles honestly afterwards (dep_name has no FK).
func TestPluginPathsBypassTheDeleteBlock(t *testing.T) {
	f := newDepsFixture(t)
	defs := []store.PluginMetricDef{{Name: "plug_up", Title: "Plug Up", Expr: "from events: count()"}}
	if err := f.st.ReplacePluginMetrics("p_deps", defs); err != nil {
		t.Fatalf("ReplacePluginMetrics: %v", err)
	}
	before, err := f.st.GetMetricByName("plug_up")
	if err != nil {
		t.Fatalf("GetMetricByName: %v", err)
	}
	dep := f.save(t, models.MetricRow{Name: "plug_dep", Expr: "from events: metric('plug_up')"})

	// The API blocks deleting the referenced upstream...
	if err := f.svc.DeleteMetric(before.ID); err == nil ||
		!strings.Contains(err.Error(), `cannot delete metric "plug_up"`) {
		t.Errorf("api delete err = %v, want the reference block", err)
	}
	// ...while the plugin host's own path never touches DeleteMetric:
	// replace lands (delete + re-insert → a FRESH id, AUTOINCREMENT).
	defs[0].Title = "Plug Up v2"
	if err := f.st.ReplacePluginMetrics("p_deps", defs); err != nil {
		t.Fatalf("ReplacePluginMetrics: %v", err)
	}
	after, err := f.st.GetMetricByName("plug_up")
	if err != nil {
		t.Fatalf("GetMetricByName after replace: %v", err)
	}
	if after.ID == before.ID {
		t.Errorf("id %d unchanged — fixture assumes the delete+insert id churn", after.ID)
	}
	// The NAME-keyed edge survived the id churn, and the SERVICE's
	// resolution (which has the catalog) still resolves it against the
	// replanted row. The package-level Validate carries no catalog and
	// reports the unresolvable ref — the one copy, both paths.
	f.wantDeps(t, dep.ID, dep.Expr)
	if perr := metrics.Validate(dep.Expr); perr == nil {
		t.Error("Validate (no catalog) accepted a reference — got nil")
	} else if perr.Message != `unknown metric reference "plug_up"` {
		t.Errorf("Validate error = %q, want the unknown-reference copy", perr.Message)
	}
	if ok, ee, err := f.svc.ValidateExpr(dep.Expr); err != nil || !ok || ee.Message != "" {
		t.Errorf("ValidateExpr after replace = (%v, %+v, %v), want ok", ok, ee, err)
	}

	// System removal (disable) leaves the edge behind on purpose.
	if err := f.st.DeletePluginMetrics("p_deps"); err != nil {
		t.Fatalf("DeletePluginMetrics: %v", err)
	}
	if got, _ := f.st.MetricDeps(dep.ID); !reflect.DeepEqual(got, []string{"plug_up"}) {
		t.Errorf("edges after system removal = %v, want [plug_up] (dep_name has no FK)", got)
	}
	// And a save of the dependent now reports the missing upstream
	// (resolution is honest — never a silent 0).
	if _, err := f.svc.SaveMetric(models.MetricRow{
		ID: dep.ID, Name: dep.Name, Expr: dep.Expr, Scope: "match", Format: "int", Doc: dep.Doc,
	}); err == nil || !strings.Contains(err.Error(), `unknown metric reference "plug_up"`) {
		t.Errorf("save after system removal err = %v, want the unknown-reference copy", err)
	}
}
