package main

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/adrg/xdg"

	"github.com/ChristianWSmith/spectra/internal/data"
	"github.com/ChristianWSmith/spectra/internal/extract"
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/plugin"
	"github.com/ChristianWSmith/spectra/internal/sidecar"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// useTempXDG points the XDG data dir at a temp dir for one test (plugin
// dir + match sidecar dirs + DB path resolve there), restoring the cached
// xdg state afterwards.
func useTempXDG(t *testing.T) string {
	t.Helper()
	tmp := t.TempDir()
	t.Setenv("XDG_DATA_HOME", tmp)
	xdg.Reload()
	t.Cleanup(xdg.Reload)
	return tmp
}

// seedPlatformMatch builds a store fixture with convar payload variants
// (the three shapes the extractor emits across game builds) and returns
// the match id.
func seedPlatformMatch(t *testing.T, st *store.Store) int64 {
	t.Helper()
	id, err := st.CreateMatchRow("/demos/platform-fixture.dem", "sha-platform-fixture", 7)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	em := &models.ExtractedMatch{
		Match: models.Match{
			Map: "De_Inferno", TickRate: 64, DurationTicks: 1280, Frames: 1280,
			EntityClasses: 211, EndEntityCount: 77, ParserVersion: "vtest-1",
			ExtractedAt:   time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC),
			WarningsCount: 2, EncryptedMessages: 3, RealRounds: 1,
		},
		GenericEvents: []models.GenericEvent{
			{Name: "server_cvar", Tick: 10, Round: 1, PayloadJSON: `{"cvarname":"sv_alltalk","cvarvalue":"true"}`},
			{Name: "server_cvar", Tick: 20, Round: 1, PayloadJSON: `{"name":"mp_roundtime_defuse","value":"1.92"}`},
			{Name: "server_cvar", Tick: 30, Round: 1, PayloadJSON: `{"cvar":"fps_max","value":"400"}`},
			{Name: "server_cvar", Tick: 40, Round: 1, PayloadJSON: `{"convars":{"sv_cheats":"0","mp_freezetime":"15"}}`},
			{Name: "player_connect", Tick: 5, Round: 0, PayloadJSON: `{"name":"late"}`},
		},
	}
	for i := 0; i < 4; i++ {
		side := "ct"
		if i >= 2 {
			side = "t"
		}
		em.Players = append(em.Players, models.Player{
			SteamID: string(rune('1' + i)), Name: "p" + string(rune('0'+i)),
			Side: side, FinalStatePresent: true,
		})
		em.PlayerStats = append(em.PlayerStats, models.PlayerStats{
			SteamID: string(rune('1' + i)), Side: side, Name: "p" + string(rune('0'+i)),
			KillsByWeapon: "{}", DamageByWeapon: "{}",
		})
	}
	em.Rounds = []models.Round{{Number: 1, Winner: "ct", Reason: "CTWin", StartTick: 0, EndTick: 1279}}
	if err := st.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	return id
}

func TestGetProvenanceAndEntitySummary(t *testing.T) {
	useTempXDG(t)
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	defer func() { _ = st.Close() }()
	id := seedPlatformMatch(t, st)
	svc := &PlatformService{st: st}

	p, err := svc.GetProvenance(id)
	if err != nil {
		t.Fatalf("GetProvenance: %v", err)
	}
	if p.Map != "De_Inferno" || p.Warnings != 2 || p.EncMessages != 3 {
		t.Fatalf("provenance mismatch: %+v", p)
	}
	// RuleVersion is the MATCH's stamp, never the live config's: this
	// fixture was never analyzed → 0 = unknown (the panel's
	// missing-data convention, like VoiceChunks), while TradeWindowS
	// stays the live config's (the stamp carries only the version).
	if p.RuleVersion != 0 || p.TradeWindowS != 5.0 {
		t.Fatalf("rules provenance mismatch: %+v", p)
	}
	// A stamped match reports ITS stamp — and bumping the live config
	// afterwards must not move it (only a re-run does), while the live
	// TradeWindowS follows the config.
	if err := st.SetMatchRuleVersion(id, 4); err != nil {
		t.Fatalf("SetMatchRuleVersion: %v", err)
	}
	if _, err := st.SetConfig(models.AnalysisConfig{
		TradeWindowS: 7, EcoFullBuy: 20000, EcoForce: 10000,
		TradeOppDistance: 1000, RuleVersion: 9,
	}); err != nil {
		t.Fatalf("SetConfig: %v", err)
	}
	p2, err := svc.GetProvenance(id)
	if err != nil {
		t.Fatalf("GetProvenance(stamped): %v", err)
	}
	if p2.RuleVersion != 4 || p2.TradeWindowS != 7 {
		t.Fatalf("stamped provenance = %+v, want ruleVersion 4 (the match's stamp) + tradeWindowS 7 (the live config)", p2)
	}
	joined := strings.Join(p.Notes, "\n")
	if !strings.Contains(joined, "entity schema browser descoped") {
		t.Errorf("notes missing descoped schema note: %v", p.Notes)
	}
	if !strings.Contains(joined, "chat.decrypted stays 0") {
		t.Errorf("notes missing chat.decrypted note: %v", p.Notes)
	}
	if !strings.Contains(joined, "position sidecar format: none") {
		t.Errorf("notes missing sidecar none note: %v", p.Notes)
	}

	es, err := svc.GetEntitySummary(id)
	if err != nil {
		t.Fatalf("GetEntitySummary: %v", err)
	}
	if es.EntityClasses != 211 || es.EndEntities != 77 {
		t.Fatalf("entity summary mismatch: %+v", es)
	}
	if es.GenericTypes != 2 || es.GenericTotal != 5 {
		t.Fatalf("generic counts mismatch: %+v", es)
	}
	if !strings.Contains(es.Notes, "descoped") {
		t.Fatalf("entity notes missing descoped text: %q", es.Notes)
	}
}

func TestGetSpatialSeries(t *testing.T) {
	useTempXDG(t)
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	defer func() { _ = st.Close() }()
	id := seedPlatformMatch(t, st)
	svc := &PlatformService{st: st}

	// Synthetic sidecar under the temp XDG match dir: 2 CT 10 units apart,
	// 2 T 10 units apart, 100 frames @ tick = frame index.
	dir := filepath.Join(data.MatchesDir(), "1")
	w, err := sidecar.NewWriter(dir, 64)
	if err != nil {
		t.Fatalf("NewWriter: %v", err)
	}
	for i := 0; i < 100; i++ {
		players := []extract.PositionPlayer{
			{SteamID: 1, X: 0, Y: 0}, {SteamID: 2, X: 10, Y: 0},
			{SteamID: 3, X: 0, Y: 100}, {SteamID: 4, X: 0, Y: 110},
		}
		if err := w.AddFrame(int32(i), players); err != nil {
			t.Fatalf("AddFrame: %v", err)
		}
	}
	if _, err := w.Close(64); err != nil {
		t.Fatalf("Close sidecar: %v", err)
	}

	sp, err := svc.GetSpatialSeries(id, "spacing", 1)
	if err != nil {
		t.Fatalf("GetSpatialSeries(spacing): %v", err)
	}
	if sp.Kind != "spacing" || sp.Buckets != 1 || sp.ToTick != 1280 {
		t.Fatalf("spacing header mismatch: %+v", sp)
	}
	if sp.Values[0] != 10 {
		t.Fatalf("spacing = %v, want 10", sp.Values[0])
	}
	if sp.MS < 0 {
		t.Fatalf("ms not measured: %+v", sp)
	}
	if _, err := svc.GetSpatialSeries(id, "diagonal", 1); err == nil {
		t.Fatal("unknown kind succeeded")
	}
}

const rootTestPlugin = `{
  "id": "root-plug",
  "name": "Root Plug",
  "version": "1.0.0",
  "capabilities": {"metrics": {}, "report_templates": {}},
  "metrics": [
    {"name": "root_count", "title": "Root count", "expr": "from events: count()"}
  ],
  "reportTpls": [
    {"id": "root-match", "title": "Root match", "scope": "match", "format": "md", "body": "root plugin: {{.Match.Map}}"}
  ]
}`

func TestPluginLifecycleViaService(t *testing.T) {
	useTempXDG(t)
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	defer func() { _ = st.Close() }()
	id := seedPlatformMatch(t, st)
	svc := &PlatformService{st: st}

	bundle := filepath.Join(t.TempDir(), "root-plug")
	if err := os.MkdirAll(bundle, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(bundle, "spectra-plugin.json"), []byte(rootTestPlugin), 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}

	got, err := svc.InstallPlugin(bundle)
	if err != nil {
		t.Fatalf("InstallPlugin: %v", err)
	}
	if got.Manifest.ID != "root-plug" || !got.Enabled || got.Error != "" {
		t.Fatalf("install state mismatch: %+v", got)
	}
	if n, err := st.CountPluginMetrics("root-plug"); err != nil || n != 1 {
		t.Fatalf("plugin metric rows = %d, %v, want 1", n, err)
	}

	list, err := svc.ListPlugins()
	if err != nil || len(list) != 1 {
		t.Fatalf("ListPlugins: %v, %+v", err, list)
	}
	tpls, err := svc.ListReportTemplates()
	if err != nil {
		t.Fatalf("ListReportTemplates: %v", err)
	}
	var found bool
	for _, tp := range tpls {
		if tp.ID == "root-match" && tp.Origin == "plugin" {
			found = true
		}
	}
	if !found {
		t.Fatalf("plugin template missing from ListReportTemplates: %+v", tpls)
	}

	// Render the plugin template against the seeded match.
	out, err := svc.RenderReport("root-match", id, "", 0)
	if err != nil {
		t.Fatalf("RenderReport(plugin): %v", err)
	}
	if out != "root plugin: De_Inferno" {
		t.Fatalf("plugin render = %q", out)
	}
	// Builtin template renders through the same path.
	mout, err := svc.RenderReport("match.md", id, "", 0)
	if err != nil {
		t.Fatalf("RenderReport(builtin): %v", err)
	}
	if !strings.Contains(mout, "De_Inferno") {
		t.Fatalf("builtin match.md missing map:\n%s", mout)
	}
	if _, err := svc.RenderReport("nope.md", id, "", 0); err == nil {
		t.Fatal("RenderReport(missing template) succeeded")
	}

	// Disable: metrics rows gone, template gone from list; enable: back.
	if _, err := svc.SetPluginEnabled("root-plug", false); err != nil {
		t.Fatalf("SetPluginEnabled(false): %v", err)
	}
	if n, err := st.CountPluginMetrics("root-plug"); err != nil || n != 0 {
		t.Fatalf("metric rows after disable = %d, %v, want 0", n, err)
	}
	tpls, err = svc.ListReportTemplates()
	if err != nil {
		t.Fatalf("ListReportTemplates: %v", err)
	}
	for _, tp := range tpls {
		if tp.ID == "root-match" {
			t.Fatal("disabled plugin template still listed")
		}
	}
	if _, err := svc.SetPluginEnabled("root-plug", true); err != nil {
		t.Fatalf("SetPluginEnabled(true): %v", err)
	}
	if n, err := st.CountPluginMetrics("root-plug"); err != nil || n != 1 {
		t.Fatalf("metric rows after enable = %d, %v, want 1", n, err)
	}

	if err := svc.RemovePlugin("root-plug"); err != nil {
		t.Fatalf("RemovePlugin: %v", err)
	}
	if n, err := st.CountPluginMetrics("root-plug"); err != nil || n != 0 {
		t.Fatalf("metric rows after remove = %d, %v, want 0", n, err)
	}
	if list, err := svc.ListPlugins(); err != nil || len(list) != 0 {
		t.Fatalf("ListPlugins after remove: %v, %+v", err, list)
	}
}

func TestHandleExportRoutes(t *testing.T) {
	useTempXDG(t)
	// The library.db route streams data.DBPath() — open the store there so
	// the file exists.
	if err := data.EnsureDirs(); err != nil {
		t.Fatalf("EnsureDirs: %v", err)
	}
	st, err := store.Open(data.DBPath())
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	defer func() { _ = st.Close() }()
	id := seedPlatformMatch(t, st)

	// Report attachment: template id with extension.
	req := httptest.NewRequest("GET", "/api/export/1/report?template=match.md", nil)
	rec := httptest.NewRecorder()
	handleExport(st, rec, req, "1/report")
	if rec.Code != 200 {
		t.Fatalf("report route code = %d, body %s", rec.Code, rec.Body.String())
	}
	if cd := rec.Header().Get("Content-Disposition"); cd != `attachment; filename="Spectra-1-match.md"` {
		t.Fatalf("Content-Disposition = %q", cd)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "markdown") {
		t.Fatalf("Content-Type = %q", ct)
	}
	if !strings.Contains(rec.Body.String(), "De_Inferno") {
		t.Fatalf("report body missing map:\n%s", rec.Body.String())
	}

	// Extension-less template resolved via format=html.
	req = httptest.NewRequest("GET", "/api/export/1/report?template=match&format=html", nil)
	rec = httptest.NewRecorder()
	handleExport(st, rec, req, "1/report")
	if rec.Code != 200 {
		t.Fatalf("html report code = %d, body %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "html") {
		t.Fatalf("html Content-Type = %q", ct)
	}
	if !strings.Contains(rec.Body.String(), "<!DOCTYPE html>") {
		t.Fatal("html report body is not HTML")
	}

	// Player + round scopes.
	req = httptest.NewRequest("GET", "/api/export/1/report?template=player.md&steamId=1", nil)
	rec = httptest.NewRecorder()
	handleExport(st, rec, req, "1/report")
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "Player report") {
		t.Fatalf("player report code = %d body %s", rec.Code, rec.Body.String())
	}
	req = httptest.NewRequest("GET", "/api/export/1/report?template=round.md&round=1", nil)
	rec = httptest.NewRecorder()
	handleExport(st, rec, req, "1/report")
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "Round 1") {
		t.Fatalf("round report code = %d body %s", rec.Code, rec.Body.String())
	}

	// Missing template → 404; missing param → 400; missing match → 404.
	req = httptest.NewRequest("GET", "/api/export/1/report?template=nope.md", nil)
	rec = httptest.NewRecorder()
	handleExport(st, rec, req, "1/report")
	if rec.Code != 404 {
		t.Fatalf("missing template code = %d, want 404", rec.Code)
	}
	req = httptest.NewRequest("GET", "/api/export/1/report", nil)
	rec = httptest.NewRecorder()
	handleExport(st, rec, req, "1/report")
	if rec.Code != 400 {
		t.Fatalf("missing template param code = %d, want 400", rec.Code)
	}
	req = httptest.NewRequest("GET", "/api/export/999/report?template=match.md", nil)
	rec = httptest.NewRecorder()
	handleExport(st, rec, req, "999/report")
	if rec.Code != 404 {
		t.Fatalf("missing match code = %d, want 404", rec.Code)
	}

	// library.db streams the SQLite file.
	req = httptest.NewRequest("GET", "/api/export/library.db", nil)
	rec = httptest.NewRecorder()
	handleExport(st, rec, req, "library.db")
	if rec.Code != 200 {
		t.Fatalf("library.db code = %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/vnd.sqlite3" {
		t.Fatalf("library.db Content-Type = %q", ct)
	}
	if rec.Body.Len() == 0 {
		t.Fatal("library.db body empty")
	}
	_ = id
}

// TestReportTemplateLifecycleViaService pins the Reports Builder's
// storage contract at the SERVICE layer: the server-side shape gates (the
// frontend never decides what is stored), the slug mint (the plugin
// manifest's id contract, de-duped), the three-origin list composition,
// one render path shared by a stored template and a draft preview, and
// the read-only rule for built-in/plugin sources (fork on save — the
// metric editor's rule, Builder.svelte's `id: 0` payload).
func TestReportTemplateLifecycleViaService(t *testing.T) {
	useTempXDG(t)
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	defer func() { _ = st.Close() }()
	matchID := seedPlatformMatch(t, st)
	svc := &PlatformService{st: st}

	// Server-side validation: scope, format, title and body are all
	// required, and the vocabularies are the manifest's own.
	for _, bad := range []ReportTemplate{
		{Title: "T", Scope: "career", Format: "md", Body: "x"},
		{Title: "T", Scope: "match", Format: "pdf", Body: "x"},
		{Title: "", Scope: "match", Format: "md", Body: "x"},
		{Title: "T", Scope: "match", Format: "md", Body: "   "},
	} {
		if _, err := svc.SaveReportTemplate(bad); err == nil {
			t.Errorf("SaveReportTemplate(%+v) succeeded, want a validation error", bad)
		}
	}

	// Create: the id is minted from the title, in the manifest's slug
	// shape, with origin "user" whatever the caller claimed.
	created, err := svc.SaveReportTemplate(ReportTemplate{
		Title: "Match Summary!", Scope: "match", Format: "md", Body: "map={{.Match.Map}}",
		Origin: "builtin", // ignored — the stored row is always the user's
	})
	if err != nil {
		t.Fatalf("SaveReportTemplate(create): %v", err)
	}
	if created.ID != "match-summary" {
		t.Fatalf("minted id = %q, want match-summary", created.ID)
	}
	if !plugin.ValidSlug(created.ID) {
		t.Fatalf("minted id %q is not a plugin-manifest slug", created.ID)
	}
	if created.Origin != "user" {
		t.Fatalf("created origin = %q, want user", created.Origin)
	}

	// De-dupe: the same title mints a distinct id instead of colliding.
	two, err := svc.SaveReportTemplate(ReportTemplate{
		Title: "Match Summary!", Scope: "match", Format: "md", Body: "second",
	})
	if err != nil {
		t.Fatalf("SaveReportTemplate(dup): %v", err)
	}
	if two.ID != "match-summary-2" || !plugin.ValidSlug(two.ID) {
		t.Fatalf("de-duped id = %q, want match-summary-2", two.ID)
	}

	// The list composes all three origins (builtin → user → plugin) and
	// both stored rows ride with their origin attribute.
	list, err := svc.ListReportTemplates()
	if err != nil {
		t.Fatalf("ListReportTemplates: %v", err)
	}
	seen := map[string]string{}
	for _, tp := range list {
		seen[tp.ID] = tp.Origin
	}
	if o := seen["match.md"]; o != "builtin" {
		t.Fatalf("builtin origin = %q, want builtin", o)
	}
	if o := seen["match-summary"]; o != "user" {
		t.Fatalf("user origin = %q, want user", o)
	}
	if o := seen["match-summary-2"]; o != "user" {
		t.Fatalf("second user origin = %q, want user", o)
	}

	// A stored user template renders through the SAME path as a builtin.
	out, err := svc.RenderReport("match-summary", matchID, "", 0)
	if err != nil {
		t.Fatalf("RenderReport(user): %v", err)
	}
	if out != "map=De_Inferno" {
		t.Fatalf("user render = %q, want map=De_Inferno", out)
	}

	// Read-only sources never write through: a builtin's dotted id fails
	// the slug shape, an unknown slug names no stored row — and the
	// builtin itself still renders afterwards.
	if _, err := svc.SaveReportTemplate(ReportTemplate{
		ID: "match.md", Title: "x", Scope: "match", Format: "md", Body: "x",
	}); err == nil {
		t.Fatal("saving against a builtin id succeeded")
	}
	if _, err := svc.SaveReportTemplate(ReportTemplate{
		ID: "no-such-template", Title: "x", Scope: "match", Format: "md", Body: "x",
	}); err == nil {
		t.Fatal("saving against an unknown id succeeded")
	}
	if _, err := svc.RenderReport("match.md", matchID, "", 0); err != nil {
		t.Fatalf("builtin render after rejected saves: %v", err)
	}

	// Delete: a user row goes, a builtin id touches nothing.
	if err := svc.DeleteReportTemplate("match-summary"); err != nil {
		t.Fatalf("DeleteReportTemplate: %v", err)
	}
	if err := svc.DeleteReportTemplate("match.md"); err == nil {
		t.Fatal("deleting a builtin id succeeded")
	}
	if _, err := svc.RenderReport("match-summary", matchID, "", 0); err == nil {
		t.Fatal("deleted template still renders")
	}
	rows, err := st.ListReportTemplates()
	if err != nil || len(rows) != 1 || rows[0].ID != "match-summary-2" {
		t.Fatalf("stored rows after delete = %+v, %v, want only match-summary-2", rows, err)
	}

	// The draft preview runs the SAME render path against a target and
	// stores NOTHING (its scope is validated like a stored row's).
	draft, err := svc.RenderReportDraft("match", "draft map={{.Match.Map}}", matchID, "", 0)
	if err != nil {
		t.Fatalf("RenderReportDraft: %v", err)
	}
	if draft != "draft map=De_Inferno" {
		t.Fatalf("draft render = %q, want draft map=De_Inferno", draft)
	}
	if _, err := svc.RenderReportDraft("career", "x", matchID, "", 0); err == nil {
		t.Fatal("draft with an unknown scope succeeded")
	}
	if _, err := svc.RenderReportDraft("match", "   ", matchID, "", 0); err == nil {
		t.Fatal("draft with an empty body succeeded")
	}
	rows, err = st.ListReportTemplates()
	if err != nil || len(rows) != 1 || rows[0].ID != "match-summary-2" {
		t.Fatalf("stored rows after a draft = %+v, %v, want exactly one", rows, err)
	}
}
