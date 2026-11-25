package main

import (
	"fmt"
	"regexp"
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/report"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// Owner rulings 43 and 44: a builtin report template and a builtin metric
// are edited in place. The edit stores an override (builtin_overrides, keyed
// by kind), restore to default deletes it, and an edited builtin keeps its
// shipped name and its value identity.

// mustBuiltinMetric resolves a shipped builtin by name.
func mustBuiltinMetric(t *testing.T, st *store.Store, name string) models.MetricRow {
	t.Helper()
	m, err := st.GetMetricByName(name)
	if err != nil {
		t.Fatalf("GetMetricByName(%q): %v", name, err)
	}
	if m.Origin != "builtin" {
		t.Fatalf("%q origin = %q, want builtin", name, m.Origin)
	}
	return m
}

// valueSnapshot is one metric's stored rows as text, in a stable order, so a
// recompute can be compared with an earlier one.
func valueSnapshot(t *testing.T, st *store.Store, metricID int64) string {
	t.Helper()
	res, err := st.QueryWrite(t.Context(),
		`SELECT match_id, subject_key, dim, value FROM metric_values WHERE metric_id = ? ORDER BY match_id, subject_key, dim`,
		[]any{metricID}, 1000000)
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	var b strings.Builder
	for _, r := range res.Rows {
		fmt.Fprintln(&b, r...)
	}
	return b.String()
}

// (b) An edited builtin metric's save passes the gate and keeps its shipped
// name, id and origin; a bad edit is refused with the gate's message and the
// stored override is left as it was.
func TestBuiltinMetricEditPassesGateAndBadSQLIsRefused(t *testing.T) {
	f := newSeededFixture(t)
	b := mustBuiltinMetric(t, f.st, "trade_rate")

	good := "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id"
	saved, err := f.svc.SaveBuiltinMetric(b.ID, good)
	if err != nil {
		t.Fatalf("SaveBuiltinMetric(good): %v", err)
	}
	if saved.ID != b.ID || saved.Name != b.Name || saved.Origin != "builtin" {
		t.Fatalf("identity changed: id %d→%d name %q→%q origin %q", b.ID, saved.ID, b.Name, saved.Name, saved.Origin)
	}
	if saved.Expr != good || !saved.Edited {
		t.Fatalf("saved expr/edited = %q/%v, want the edit and true", saved.Expr, saved.Edited)
	}
	if saved.Scope != b.Scope || saved.Format != b.Format {
		t.Fatalf("definition fields changed by an expr edit: %+v", saved)
	}

	// A table outside the allowlist is refused, and the refusal names it.
	bad := "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM jobs WHERE match_id = :match_id"
	if _, err := f.svc.SaveBuiltinMetric(b.ID, bad); err == nil || !strings.Contains(err.Error(), "jobs") {
		t.Fatalf("bad table edit err = %v, want a refusal naming jobs", err)
	}
	// A write verb is refused too.
	if _, err := f.svc.SaveBuiltinMetric(b.ID, "DELETE FROM events"); err == nil {
		t.Fatal("write-verb edit was accepted")
	}
	// A refused edit leaves the stored override and expr as they were.
	cur, err := f.svc.GetMetric(b.ID)
	if err != nil {
		t.Fatalf("GetMetric: %v", err)
	}
	if cur.Expr != good || !cur.Edited {
		t.Fatalf("after refused edits expr = %q edited=%v, want the earlier edit", cur.Expr, cur.Edited)
	}
}

// (c) Saving an override marks the metric behind and its dependents behind,
// and a recompute runs for those only: an unrelated metric stays fresh and is
// never attempted.
func TestBuiltinMetricEditMarksBehindAndRecomputesScopeOnly(t *testing.T) {
	f := newSeededFixture(t)
	if _, err := f.svc.runSweep(t.Context(), nil); err != nil {
		t.Fatalf("initial sweep: %v", err)
	}
	b := mustBuiltinMetric(t, f.st, "trade_rate")
	dep := f.save(t, models.MetricRow{Name: "dep_on_trade_rate",
		Expr: "SELECT subject_key, dim, value FROM metric('trade_rate') WHERE :match_id > 0"})
	other := f.save(t, models.MetricRow{Name: "unrelated_events",
		Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id"})
	if _, err := f.svc.runSweep(t.Context(), nil); err != nil {
		t.Fatalf("sweep before edit: %v", err)
	}
	for _, id := range []int64{b.ID, dep.ID, other.ID} {
		if behind, _ := coverageOf(t, f.st, id); behind {
			t.Fatalf("metric %d behind before the edit", id)
		}
	}

	edit := strings.Replace(b.Expr, "1.0*ps.trade_kills", "3.0*ps.trade_kills", 1)
	if edit == b.Expr {
		t.Fatal("test edit did not change trade_rate's expr; update the replacement")
	}
	if _, err := f.svc.SaveBuiltinMetric(b.ID, edit); err != nil {
		t.Fatalf("SaveBuiltinMetric: %v", err)
	}
	if behind, _ := coverageOf(t, f.st, b.ID); !behind {
		t.Fatal("edited builtin is not behind after its save")
	}
	if behind, _ := coverageOf(t, f.st, dep.ID); !behind {
		t.Fatal("dependent of the edited builtin is not behind")
	}
	if behind, _ := coverageOf(t, f.st, other.ID); behind {
		t.Fatal("unrelated metric went behind on a builtin edit")
	}

	res, err := f.svc.runSweep(t.Context(), nil)
	if err != nil {
		t.Fatalf("sweep after edit: %v", err)
	}
	attempted := map[int64]bool{}
	for _, id := range res.Attempted {
		attempted[id] = true
	}
	if !attempted[b.ID] || !attempted[dep.ID] {
		t.Fatalf("sweep attempted %v, want the edited builtin and its dependent", res.Attempted)
	}
	if attempted[other.ID] {
		t.Fatalf("sweep recomputed the unrelated metric: attempted %v", res.Attempted)
	}
	if behind, fresh := coverageOf(t, f.st, b.ID); behind || fresh == 0 {
		t.Fatalf("edited builtin after recompute = (behind=%v, fresh=%d)", behind, fresh)
	}
}

// (d) Restore to default deletes the override, puts the shipped SQL back as
// expr, and recomputes with it: the stored values match the first run's.
func TestBuiltinMetricRestoreRecomputesShipped(t *testing.T) {
	f := newSeededFixture(t)
	if _, err := f.svc.runSweep(t.Context(), nil); err != nil {
		t.Fatalf("initial sweep: %v", err)
	}
	b := mustBuiltinMetric(t, f.st, "trade_rate")
	shippedValues := valueSnapshot(t, f.st, b.ID)
	if shippedValues == "" {
		t.Fatal("trade_rate has no stored values to compare; the fixture is wrong")
	}

	edit := strings.Replace(b.Expr, "1.0*ps.trade_kills", "3.0*ps.trade_kills", 1)
	if _, err := f.svc.SaveBuiltinMetric(b.ID, edit); err != nil {
		t.Fatalf("SaveBuiltinMetric: %v", err)
	}
	if _, err := f.svc.runSweep(t.Context(), nil); err != nil {
		t.Fatalf("sweep after edit: %v", err)
	}
	if valueSnapshot(t, f.st, b.ID) == shippedValues {
		t.Fatal("the edit did not change trade_rate's values; the restore check would prove nothing")
	}

	restored, err := f.svc.RestoreBuiltinMetric(b.ID)
	if err != nil {
		t.Fatalf("RestoreBuiltinMetric: %v", err)
	}
	if restored.Expr != b.Expr || restored.Edited {
		t.Fatalf("restored expr is not the shipped SQL, or still edited: edited=%v", restored.Edited)
	}
	if _, err := f.st.GetBuiltinOverride(store.MetricOverridePrefix + b.Name); err == nil {
		t.Fatal("restore left the override row in place")
	}
	if behind, _ := coverageOf(t, f.st, b.ID); !behind {
		t.Fatal("restored builtin is not behind; its values would not be recomputed")
	}
	if _, err := f.svc.runSweep(t.Context(), nil); err != nil {
		t.Fatalf("sweep after restore: %v", err)
	}
	if got := valueSnapshot(t, f.st, b.ID); got != shippedValues {
		t.Fatalf("values after restore differ from the shipped run:\nwant %s\ngot  %s", shippedValues, got)
	}

	// Restoring a builtin with no override changes nothing and schedules nothing.
	again, err := f.svc.RestoreBuiltinMetric(b.ID)
	if err != nil {
		t.Fatalf("second restore: %v", err)
	}
	if again.Expr != b.Expr || again.Edited {
		t.Fatalf("second restore changed the metric: %+v", again)
	}
	if behind, _ := coverageOf(t, f.st, b.ID); behind {
		t.Fatal("a restore with no override marked the metric behind")
	}
}

// (e) With no override, a shipped builtin metric reads exactly as shipped and
// is not marked edited; only the builtin's own origin is refused for a user save.
func TestBuiltinMetricWithoutOverrideIsShipped(t *testing.T) {
	f := newSeededFixture(t)
	b := mustBuiltinMetric(t, f.st, "trade_rate")
	got, err := f.svc.GetMetric(b.ID)
	if err != nil {
		t.Fatalf("GetMetric: %v", err)
	}
	if got.Expr != b.Expr || got.Edited {
		t.Fatalf("unedited builtin = expr-same %v edited %v", got.Expr == b.Expr, got.Edited)
	}
	page, err := f.svc.ListMetricsPage("trade_rate", "builtin", "", 0, 10)
	if err != nil {
		t.Fatalf("ListMetricsPage: %v", err)
	}
	for _, r := range page.Rows {
		if r.Name == "trade_rate" && r.Edited {
			t.Fatal("unedited builtin listed as edited")
		}
	}
	if _, err := f.svc.SaveMetric(models.MetricRow{ID: b.ID, Name: b.Name, Expr: "SELECT 1", Format: b.Format, Doc: b.Doc}); err == nil {
		t.Fatal("SaveMetric accepted a builtin without the override path")
	}
}

// (a) and (e) for reports: an edited builtin report renders the edit, restore
// brings the shipped text back, and with no edit the shipped template renders
// and lists exactly as before.
func TestBuiltinReportEditRendersAndRestores(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	matchID := seedPlatformMatch(t, st)
	svc := &PlatformService{st: st}

	var shipped string
	for _, tp := range report.Builtins() {
		if tp.ID == "match.md" {
			shipped = tp.Body
		}
	}
	if shipped == "" {
		t.Fatal("match.md builtin missing")
	}
	before, err := svc.RenderReport("match.md", matchID, "", 0)
	if err != nil {
		t.Fatalf("RenderReport(shipped): %v", err)
	}
	tpls, err := svc.ListReportTemplates()
	if err != nil {
		t.Fatalf("ListReportTemplates: %v", err)
	}
	for _, tp := range tpls {
		if tp.ID == "match.md" && (tp.Edited || tp.Body != shipped) {
			t.Fatalf("unedited builtin listed as edited or with a changed body")
		}
	}

	const marker = "EDITED-REPORT-MARKER"
	edited := shipped + "\n" + marker + "\n"
	got, err := svc.SaveBuiltinReport("match.md", edited)
	if err != nil {
		t.Fatalf("SaveBuiltinReport: %v", err)
	}
	if !got.Edited || got.Body != edited || got.Title != "Match report" || got.Origin != "builtin" {
		t.Fatalf("saved DTO = %+v", got)
	}
	out, err := svc.RenderReport("match.md", matchID, "", 0)
	if err != nil {
		t.Fatalf("RenderReport(edited): %v", err)
	}
	if !strings.Contains(out, marker) {
		t.Fatalf("edited report does not render the edit:\n%s", out)
	}
	tpls, err = svc.ListReportTemplates()
	if err != nil {
		t.Fatalf("ListReportTemplates(edited): %v", err)
	}
	listed := false
	for _, tp := range tpls {
		if tp.ID == "match.md" {
			listed = tp.Edited && tp.Body == edited
		}
	}
	if !listed {
		t.Fatal("edited builtin is not listed with its edit")
	}

	restored, err := svc.RestoreBuiltinReport("match.md")
	if err != nil {
		t.Fatalf("RestoreBuiltinReport: %v", err)
	}
	if restored.Edited || restored.Body != shipped {
		t.Fatalf("restore did not bring the shipped text back: edited=%v", restored.Edited)
	}
	after, err := svc.RenderReport("match.md", matchID, "", 0)
	if err != nil {
		t.Fatalf("RenderReport(restored): %v", err)
	}
	// The render stamps its generation time; everything else must match.
	stamp := regexp.MustCompile(`Generated [^\n]*`)
	if strings.Contains(after, marker) || stamp.ReplaceAllString(after, "") != stamp.ReplaceAllString(before, "") {
		t.Fatal("restored report does not render exactly as the shipped one")
	}

	// The report edit lives in the shared table, but a component reader sees
	// only builtin- keys.
	if _, err := svc.SaveBuiltinReport("match.md", edited); err != nil {
		t.Fatalf("SaveBuiltinReport(again): %v", err)
	}
	comps, err := (&ComponentService{st: st}).ListBuiltinOverrides()
	if err != nil || len(comps) != 0 {
		t.Fatalf("component overrides = %+v, %v; a report edit leaked into the component list", comps, err)
	}
	if _, err := svc.SaveBuiltinReport("root-match", "x"); err == nil {
		t.Fatal("a non-builtin id was accepted as a builtin edit")
	}
	if _, err := svc.SaveBuiltinReport("match.md", "  "); err == nil {
		t.Fatal("an empty builtin body was accepted")
	}
}
