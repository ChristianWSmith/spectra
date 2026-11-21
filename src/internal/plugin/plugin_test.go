package plugin

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

func openStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

const goodManifest = `{
  "id": "test-plug",
  "name": "Test Plug",
  "version": "1.0.0",
  "author": "tester",
  "description": "fixture",
  "capabilities": {"metrics": {}, "report_templates": {}},
  "metrics": [
    {"name": "plug_count", "title": "Plug count", "expr": "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id", "doc": "counts events"}
  ],
  "reportTpls": [
    {"id": "plug-match", "title": "Plug match", "scope": "match", "format": "md", "body": "plug report for {{.Match.Map}}"}
  ]
}`

// writeGoodManifest writes manifestJSON as a SINGLE-FILE bundle source —
// the only install source since w27 (folder sources are refused by
// Install) — in dir and returns its path.
func writeGoodManifest(t *testing.T, dir string, manifestJSON string) string {
	t.Helper()
	f := filepath.Join(dir, ManifestName)
	if err := os.WriteFile(f, []byte(manifestJSON), 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
	return f
}

// writeOrphanBundle writes an ON-DISK bundle FOLDER straight into the
// manager's plugin dir — the installed layout List() scans for orphans
// (never an Install source, so it stays folder-shaped).
func writeOrphanBundle(t *testing.T, dir string, manifestJSON string) {
	t.Helper()
	b := filepath.Join(dir, "test-plug")
	if err := os.MkdirAll(b, 0o755); err != nil {
		t.Fatalf("mkdir bundle: %v", err)
	}
	if err := os.WriteFile(filepath.Join(b, ManifestName), []byte(manifestJSON), 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
}

func metricCount(t *testing.T, st *store.Store, pluginID string) int {
	t.Helper()
	n, err := st.CountPluginMetrics(pluginID)
	if err != nil {
		t.Fatalf("CountPluginMetrics: %v", err)
	}
	return n
}

func TestInstallGoodBundle(t *testing.T) {
	st := openStore(t)
	mgr := NewManager(st, t.TempDir())
	src := writeGoodManifest(t, t.TempDir(), goodManifest)

	got, err := mgr.Install(src)
	if err != nil {
		t.Fatalf("Install: %v", err)
	}
	if got.Manifest.ID != "test-plug" || got.Error != "" || !got.Enabled {
		t.Fatalf("state mismatch: %+v", got)
	}
	if got.Path == "" || got.Manifest.Hash == "" {
		t.Fatalf("path/hash not recorded: %+v", got)
	}
	if n := metricCount(t, st, "test-plug"); n != 1 {
		t.Fatalf("metrics rows = %d, want 1", n)
	}
	// Plugins declare no scope (ruling 51): the manifest above is match-bound,
	// so its scope derives to 'match', and version stays at DEFAULT 1.
	mrows, err := st.ListMetrics()
	if err != nil {
		t.Fatalf("ListMetrics: %v", err)
	}
	for _, m := range mrows {
		if m.Origin != "plugin" {
			continue
		}
		if m.Scope != "match" {
			t.Errorf("plugin metric %q scope = %q, want match (derived from its binds)", m.Name, m.Scope)
		}
		if m.Version != 1 {
			t.Errorf("plugin metric %q version = %d, want 1 (column DEFAULT)", m.Name, m.Version)
		}
	}
	list, err := mgr.List()
	if err != nil || len(list) != 1 || list[0].Error != "" {
		t.Fatalf("List: %v, %+v", err, list)
	}

	// Disable → metrics gone; enable → back (no restart, acceptance 6).
	if _, err := mgr.SetEnabled("test-plug", false); err != nil {
		t.Fatalf("SetEnabled(false): %v", err)
	}
	if n := metricCount(t, st, "test-plug"); n != 0 {
		t.Fatalf("metrics rows after disable = %d, want 0", n)
	}
	if _, err := mgr.SetEnabled("test-plug", true); err != nil {
		t.Fatalf("SetEnabled(true): %v", err)
	}
	if n := metricCount(t, st, "test-plug"); n != 1 {
		t.Fatalf("metrics rows after enable = %d, want 1", n)
	}

	// Reinstall keeps enabled state and revalidates.
	if _, err := mgr.Install(src); err != nil {
		t.Fatalf("reinstall: %v", err)
	}
	if n := metricCount(t, st, "test-plug"); n != 1 {
		t.Fatalf("metrics rows after reinstall = %d, want 1", n)
	}

	if err := mgr.Remove("test-plug"); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if n := metricCount(t, st, "test-plug"); n != 0 {
		t.Fatalf("metrics rows after remove = %d, want 0", n)
	}
	if _, err := os.Stat(got.Path); !os.IsNotExist(err) {
		t.Fatalf("bundle dir still present after Remove: %v", err)
	}
}

// TestPluginMetricScopeFromBinds pins that a plugin metric's scope is
// derived from its binds at Install (ruling 51): a :steam_id statement reads
// profile, a :match_id one match, and version stays at DEFAULT 1 either way.
func TestPluginMetricScopeFromBinds(t *testing.T) {
	st := openStore(t)
	mgr := NewManager(st, t.TempDir())
	manifest := `{
  "id": "test-plug",
  "name": "Test Plug",
  "version": "1.0.0",
  "metrics": [
    {"name": "plug_career", "title": "Career", "expr": "SELECT :steam_id AS subject_key, '' AS dim, COUNT(*) AS value FROM events", "doc": "counts events"},
    {"name": "plug_match", "title": "Match", "expr": "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id", "doc": "counts events"}
  ]
}`
	src := writeGoodManifest(t, t.TempDir(), manifest)
	if _, err := mgr.Install(src); err != nil {
		t.Fatalf("Install: %v", err)
	}
	rows, err := st.ListMetrics()
	if err != nil {
		t.Fatalf("ListMetrics: %v", err)
	}
	got := map[string]models.MetricRow{}
	for _, m := range rows {
		if m.Origin == "plugin" {
			got[m.Name] = m
		}
	}
	if len(got) != 2 {
		t.Fatalf("plugin rows = %d, want 2 (%+v)", len(got), got)
	}
	if m := got["plug_career"]; m.Scope != "profile" || m.Version != 1 {
		t.Errorf("plug_career = scope %q version %d, want profile/1 (derived from :steam_id)", m.Scope, m.Version)
	}
	if m := got["plug_match"]; m.Scope != "match" || m.Version != 1 {
		t.Errorf("plug_match = scope %q version %d, want match/1 (derived from :match_id)", m.Scope, m.Version)
	}
}

func TestInstallValidationMatrix(t *testing.T) {
	st := openStore(t)
	mgr := NewManager(st, t.TempDir())
	src := t.TempDir()

	cases := []struct {
		name     string
		manifest string
		wantErr  string
	}{
		{"unknown capability", `{"id":"bad-cap","name":"B","version":"1","capabilities":{"scripts":{}}}`, "unknown capability"},
		{"bad slug", `{"id":"Bad Slug!","name":"B","version":"1"}`, "must match"},
		{"missing name", `{"id":"no-name","version":"1"}`, "name is required"},
		{"missing version", `{"id":"no-ver","name":"B"}`, "version is required"},
		{"empty metric expr", `{"id":"no-expr","name":"B","version":"1","metrics":[{"name":"m1","expr":"  "}]}`, "empty expr"},
		{"bad tpl scope", `{"id":"bad-scope","name":"B","version":"1","reportTpls":[{"id":"tpl-r","scope":"deck","format":"md","body":"x"}]}`, "scope"},
		{"bad tpl format", `{"id":"bad-fmt","name":"B","version":"1","reportTpls":[{"id":"tpl-r","scope":"match","format":"pdf","body":"x"}]}`, "format"},
		{"not json", `not json at all`, "not valid JSON"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// w27: the source is the manifest FILE itself.
			f := filepath.Join(src, tc.name+".json")
			if err := os.WriteFile(f, []byte(tc.manifest), 0o644); err != nil {
				t.Fatalf("write: %v", err)
			}
			_, err := mgr.Install(f)
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("Install err = %v, want contains %q", err, tc.wantErr)
			}
		})
	}
}

func TestInstallHashPinning(t *testing.T) {
	st := openStore(t)
	mgr := NewManager(st, t.TempDir())
	src := t.TempDir()

	// withHash returns goodManifest with its top-level hash field set.
	withHash := func(hash string) string {
		var m map[string]any
		if err := json.Unmarshal([]byte(goodManifest), &m); err != nil {
			t.Fatalf("unmarshal fixture: %v", err)
		}
		m["hash"] = hash
		data, err := json.Marshal(m)
		if err != nil {
			t.Fatalf("marshal fixture: %v", err)
		}
		return string(data)
	}

	// A pin can never verify for a SINGLE-FILE source (the digest covers
	// the pin field itself — platformservice.go BuildPluginBundle ships
	// hash empty for exactly this reason), so a manifest carrying one is
	// refused as a mismatch. The directory-era "correct pin" flow died
	// with the file-only source (w27).
	bundle := writeGoodManifest(t, src, withHash(strings.Repeat("0", 64)))
	if _, err := mgr.Install(bundle); err == nil || !strings.Contains(err.Error(), "hash mismatch") {
		t.Fatalf("Install(mismatched hash) err = %v, want hash mismatch", err)
	}

	// The same manifest WITHOUT the pin installs cleanly (the shipped
	// single-file shape).
	good := writeGoodManifest(t, src, goodManifest)
	if _, err := mgr.Install(good); err != nil {
		t.Fatalf("Install(unpinned) err = %v, want success", err)
	}
}

func TestInstallSingleManifestFile(t *testing.T) {
	st := openStore(t)
	mgr := NewManager(st, t.TempDir())
	f := filepath.Join(t.TempDir(), "solo-plugin.json")
	if err := os.WriteFile(f, []byte(goodManifest), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	got, err := mgr.Install(f)
	if err != nil {
		t.Fatalf("Install(single file): %v", err)
	}
	if _, err := os.Stat(filepath.Join(got.Path, ManifestName)); err != nil {
		t.Fatalf("manifest not copied into bundle: %v", err)
	}
}

func TestListInvalidManifestKept(t *testing.T) {
	st := openStore(t)
	dir := t.TempDir()
	mgr := NewManager(st, dir)
	src := writeGoodManifest(t, t.TempDir(), goodManifest)
	if _, err := mgr.Install(src); err != nil {
		t.Fatalf("Install: %v", err)
	}
	// Corrupt the INSTALLED manifest: the row must survive with Error set.
	if err := os.WriteFile(filepath.Join(dir, "test-plug", ManifestName), []byte(`{`), 0o644); err != nil {
		t.Fatalf("corrupt: %v", err)
	}
	list, err := mgr.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	var found bool
	for _, s := range list {
		if s.Manifest.ID == "test-plug" {
			found = true
			if s.Error == "" {
				t.Fatal("corrupt manifest listed without Error")
			}
		}
	}
	if !found {
		t.Fatalf("plugin with corrupt manifest dropped from List: %+v", list)
	}

	// Delete the bundle entirely → "missing bundle".
	if err := os.RemoveAll(filepath.Join(dir, "test-plug")); err != nil {
		t.Fatalf("remove bundle: %v", err)
	}
	list, err = mgr.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	for _, s := range list {
		if s.Manifest.ID == "test-plug" && s.Error != "missing bundle" {
			t.Fatalf("missing bundle Error = %q", s.Error)
		}
	}
}

func TestListOrphanBundle(t *testing.T) {
	st := openStore(t)
	dir := t.TempDir()
	mgr := NewManager(st, dir)
	writeOrphanBundle(t, dir, goodManifest) // on disk, never installed
	list, err := mgr.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 1 || list[0].Enabled || list[0].Error == "" {
		t.Fatalf("orphan bundle listing mismatch: %+v", list)
	}
}
