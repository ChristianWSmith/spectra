package plugin

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/adrg/xdg"

	"github.com/ChristianWSmith/spectra/internal/metrics"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// appName must stay in sync with build/config.yml's productName and the
// main.go const of the same name (importing main is not possible here).
const appName = "spectra"

// DefaultDir is the XDG plugin root ($XDG_DATA_HOME/spectra/plugins),
// created on demand — same data-dir convention as internal/data.
func DefaultDir() string {
	return filepath.Join(xdg.DataHome, appName, "plugins")
}

// State is one installed (or on-disk) plugin: registry row + validated
// manifest. Error is set for invalid/missing bundles — listed, never
// silently dropped (registry contract).
type State struct {
	Manifest Manifest
	Path     string
	Enabled  bool
	Error    string
}

// Manager owns the plugin directory + the store's registry rows.
type Manager struct {
	st  *store.Store
	dir string
}

// NewManager creates a Manager rooted at dir (tests point it at a temp
// dir; the app uses DefaultDir).
func NewManager(st *store.Store, dir string) *Manager {
	return &Manager{st: st, dir: dir}
}

// List re-validates every registry row against the bundle on disk and
// appends unregistered bundles found in the plugin directory (flagged,
// disabled, with an Error — also never dropped).
func (m *Manager) List() ([]State, error) {
	rows, err := m.st.ListPluginRows()
	if err != nil {
		return nil, err
	}
	out := make([]State, 0, len(rows))
	seen := map[string]bool{}
	for _, row := range rows {
		seen[row.ID] = true
		out = append(out, m.stateFor(row))
	}
	entries, err := os.ReadDir(m.dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return out, nil
		}
		return nil, fmt.Errorf("plugin: scan %s: %w", m.dir, err)
	}
	var orphanIDs []string
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		mp := filepath.Join(m.dir, e.Name(), ManifestName)
		data, err := os.ReadFile(mp)
		if err != nil {
			continue // not a bundle — stray directory, ignore
		}
		man, err := ValidateManifest(data)
		if err != nil {
			orphanIDs = append(orphanIDs, e.Name())
			continue
		}
		if seen[man.ID] {
			continue
		}
		seen[man.ID] = true
		orphanIDs = append(orphanIDs, man.ID)
	}
	for _, id := range orphanIDs {
		out = append(out, State{
			Manifest: Manifest{ID: id},
			Path:     filepath.Join(m.dir, id),
			Error:    "not registered (install it before enabling)",
		})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Manifest.ID < out[j].Manifest.ID })
	return out, nil
}

// stateFor re-validates a registry row's bundle from disk.
func (m *Manager) stateFor(row store.PluginRow) State {
	st := State{
		Manifest: Manifest{ID: row.ID, Name: row.Name, Version: row.Version, Hash: row.Hash},
		Path:     row.Path,
		Enabled:  row.Enabled,
	}
	if row.Error != "" {
		st.Error = row.Error
		return st
	}
	man, err := LoadManifest(row.Path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			st.Error = "missing bundle"
		} else {
			st.Error = err.Error()
		}
		return st
	}
	if man.Hash == "" {
		// The registry always records the computed bundle hash; surface it
		// when the manifest itself carries no pin.
		man.Hash = row.Hash
	}
	st.Manifest = man
	return st
}

// Install validates sourcePath (bundle dir or single manifest JSON file),
// verifies manifest.hash when provided, copies the bundle into the plugin
// directory, records the registry row, and upserts the plugin's metric
// rows (enabled installs only). Reinstalling keeps the previous enabled
// state.
// validateMetricExprs runs the real metrics-engine grammar on every bundled
// metric so a plugin cannot persist expressions the engine would reject at
// preview time (structural manifest checks live in manifest.go).
func validateMetricExprs(man Manifest) error {
	for _, d := range man.Metrics {
		if pe := metrics.Validate(d.Expr, d.GroupBy); pe != nil {
			return fmt.Errorf("plugin %q metric %q: %s", man.ID, d.Name, pe.Message)
		}
	}
	return nil
}

func (m *Manager) Install(sourcePath string) (State, error) {
	man, err := LoadManifest(sourcePath)
	if err != nil {
		return State{}, err
	}
	if err := validateMetricExprs(man); err != nil {
		return State{}, err
	}
	if man.Hash != "" {
		computed, err := ComputeBundleHash(sourcePath)
		if err != nil {
			return State{}, err
		}
		if !strings.EqualFold(computed, man.Hash) {
			return State{}, fmt.Errorf("plugin %q: hash mismatch: manifest pins %s, bundle hashes to %s", man.ID, man.Hash, computed)
		}
	}
	computed, err := ComputeBundleHash(sourcePath)
	if err != nil {
		return State{}, err
	}

	enabled := true
	if prev, err := m.st.GetPluginRow(man.ID); err == nil {
		enabled = prev.Enabled
	} else if !errors.Is(err, store.ErrNotFound) {
		return State{}, err
	}

	dest := filepath.Join(m.dir, man.ID)
	if err := os.RemoveAll(dest); err != nil {
		return State{}, fmt.Errorf("plugin: clear previous bundle: %w", err)
	}
	if err := copyBundle(sourcePath, dest); err != nil {
		return State{}, err
	}

	row := store.PluginRow{
		ID: man.ID, Name: man.Name, Version: man.Version,
		Path: dest, Hash: computed, Enabled: enabled,
	}
	if err := m.st.UpsertPlugin(row); err != nil {
		return State{}, err
	}
	if enabled {
		if err := m.st.ReplacePluginMetrics(man.ID, metricDefs(man)); err != nil {
			return State{}, err
		}
	}
	return m.stateFor(row), nil
}

// SetEnabled toggles a plugin: disabling deletes its metric rows;
// re-enabling reinserts them from the on-disk manifest (invalid manifest
// → the toggle is refused so the registry cannot drift from disk).
func (m *Manager) SetEnabled(id string, enabled bool) (State, error) {
	row, err := m.st.GetPluginRow(id)
	if err != nil {
		return State{}, err
	}
	if enabled {
		man, err := LoadManifest(row.Path)
		if err != nil {
			return State{}, fmt.Errorf("plugin %q: cannot enable: %w", id, err)
		}
		if err := validateMetricExprs(man); err != nil {
			return State{}, err
		}
		if err := m.st.ReplacePluginMetrics(id, metricDefs(man)); err != nil {
			return State{}, err
		}
	} else {
		if err := m.st.DeletePluginMetrics(id); err != nil {
			return State{}, err
		}
	}
	if err := m.st.SetPluginEnabledRow(id, enabled); err != nil {
		return State{}, err
	}
	row.Enabled = enabled
	return m.stateFor(row), nil
}

// Remove deletes a plugin's metric rows, registry row and bundle
// directory.
func (m *Manager) Remove(id string) error {
	row, err := m.st.GetPluginRow(id)
	if err != nil {
		return err
	}
	if err := m.st.DeletePluginMetrics(id); err != nil {
		return err
	}
	if err := m.st.DeletePluginRow(id); err != nil {
		return err
	}
	if row.Path != "" {
		if err := os.RemoveAll(row.Path); err != nil {
			return fmt.Errorf("plugin: remove bundle: %w", err)
		}
	}
	return nil
}

// metricDefs converts validated manifest metrics into store rows (the
// structural name/expr checks already ran in ValidateManifest).
func metricDefs(man Manifest) []store.PluginMetricDef {
	defs := make([]store.PluginMetricDef, 0, len(man.Metrics))
	for _, d := range man.Metrics {
		defs = append(defs, store.PluginMetricDef{
			Name: d.Name, Title: d.Title, Expr: d.Expr, GroupBy: d.GroupBy,
			Format: d.Format, Doc: d.Doc, Denominator: d.Denominator,
		})
	}
	return defs
}

// copyBundle copies a bundle directory (recursive) or a single manifest
// file into dest (created).
func copyBundle(sourcePath, dest string) error {
	st, err := os.Stat(sourcePath)
	if err != nil {
		return fmt.Errorf("plugin: stat source: %w", err)
	}
	if !st.IsDir() {
		if err := os.MkdirAll(dest, 0o755); err != nil {
			return fmt.Errorf("plugin: create bundle dir: %w", err)
		}
		data, err := os.ReadFile(sourcePath)
		if err != nil {
			return fmt.Errorf("plugin: read manifest: %w", err)
		}
		if err := os.WriteFile(filepath.Join(dest, ManifestName), data, 0o644); err != nil {
			return fmt.Errorf("plugin: write manifest: %w", err)
		}
		return nil
	}
	err = filepath.WalkDir(sourcePath, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(sourcePath, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dest, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		src, err := os.Open(path)
		if err != nil {
			return err
		}
		defer func() { _ = src.Close() }()
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		dst, err := os.Create(target)
		if err != nil {
			return err
		}
		defer func() { _ = dst.Close() }()
		_, err = io.Copy(dst, src)
		return err
	})
	if err != nil {
		return fmt.Errorf("plugin: copy bundle: %w", err)
	}
	return nil
}
