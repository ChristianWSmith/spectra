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

func TestGetProvenanceAndConVarsAndEntitySummary(t *testing.T) {
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
	if p.RuleVersion != 1 || p.TradeWindowS != 5.0 {
		t.Fatalf("config provenance mismatch: %+v", p)
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

	cvs, err := svc.GetConVars(id)
	if err != nil {
		t.Fatalf("GetConVars: %v", err)
	}
	got := map[string]string{}
	for _, c := range cvs {
		got[c.Name] = c.Value
	}
	for k, want := range map[string]string{
		"sv_alltalk": "true", "mp_roundtime_defuse": "1.92", "fps_max": "400",
		"sv_cheats": "0", "mp_freezetime": "15",
	} {
		if got[k] != want {
			t.Errorf("convar %s = %q, want %q (rows: %+v)", k, got[k], want, cvs)
		}
	}
	if len(cvs) != 5 { // 1+1+1 flat rows + 2 convars-map entries
		t.Errorf("convar rows = %d, want 5: %+v", len(cvs), cvs)
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
    {"name": "root_count", "title": "Root count", "expr": "from events: count()", "groupBy": "none"}
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
	if cd := rec.Header().Get("Content-Disposition"); cd != `attachment; filename="spectra-1-match.md"` {
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
