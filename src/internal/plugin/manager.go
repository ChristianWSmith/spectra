package plugin

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/adrg/xdg"

	"github.com/ChristianWSmith/spectra/internal/metrics"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// appName is the lowercase app IDENTIFIER (XDG dirs, prefs path, GTK
// app id) — must stay in sync with the main.go const of the same name
// and Taskfile APP_NAME (importing main is not possible here). It is
// deliberately NOT build/config.yml's productName, which is the
// display name ("Spectra").
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
		return nil, fmt.Errorf("couldn't read the plugin folder %s: %w", m.dir, err)
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

// Install validates sourcePath (a single manifest JSON file — folder
// sources are refused at the top, see below), refuses a metric naming a
// built-in (see CheckBuiltinMetricCollisions), verifies manifest.hash when
// provided, copies the manifest into the plugin directory as the installed
// bundle, records the registry row, and upserts the plugin's metric rows
// (enabled installs only). Reinstalling keeps the previous enabled state.
// validateMetricExprs runs the metric gate on every bundled metric so a
// plugin cannot persist a statement the engine would refuse at save (the
// structural manifest checks live in manifest.go).
func validateMetricExprs(man Manifest) error {
	for _, d := range man.Metrics {
		if pe := metrics.Validate(d.Expr); pe != nil {
			return fmt.Errorf("plugin %q metric %q: %s", man.ID, d.Name, pe.Message)
		}
	}
	return nil
}

func (m *Manager) Install(sourcePath string) (State, error) {
	src, err := os.Stat(sourcePath)
	if err != nil {
		return State{}, fmt.Errorf("couldn't read %s: %w", sourcePath, err)
	}
	// The source is ONE manifest file (owner ruling, w27): a folder
	// source used to walk + copy the ENTIRE folder (the owner's Desktop
	// made one install run ~110s of silent hashing/copying — the reported
	// "installing forever" stall), and no code ever read a bundle's
	// non-manifest files. The installed bundle on disk stays a folder
	// (LoadManifest below still reads those); only the SOURCE is
	// file-only, so this refuses before any work happens.
	if src.IsDir() {
		return State{}, fmt.Errorf("plugin source %q is a folder — choose the spectra-plugin.json file itself", sourcePath)
	}
	man, err := LoadManifest(sourcePath)
	if err != nil {
		return State{}, err
	}
	if err := validateMetricExprs(man); err != nil {
		return State{}, err
	}
	// The builtin-collision guard BEFORE anything is written: the bundle
	// copy and the registry row below must not land for a bundle whose
	// metric would replace a built-in row (ReplacePluginMetrics runs the
	// same check as the writer's choke point — this early one keeps a
	// refused install from half-installing).
	if err := m.st.CheckBuiltinMetricCollisions(metricDefs(man)); err != nil {
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
		return State{}, fmt.Errorf("couldn't remove the previous plugin files: %w", err)
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
			return fmt.Errorf("couldn't remove the plugin files: %w", err)
		}
	}
	return nil
}

// metricDefs converts validated manifest metrics into store rows (the
// structural name/expr/scope checks already ran in ValidateManifest).
// Scope passes through: the store normalizes an omitted ("") scope to the
// DDL DEFAULT 'match' (its omitted-field rule, same as CreateMetric), so
// the INSERT always writes a CHECK-legal value.
func metricDefs(man Manifest) []store.PluginMetricDef {
	defs := make([]store.PluginMetricDef, 0, len(man.Metrics))
	for _, d := range man.Metrics {
		defs = append(defs, store.PluginMetricDef{
			Name: d.Name, Title: d.Title, Expr: d.Expr, Scope: d.Scope,
			Format: d.Format, Doc: d.Doc,
		})
	}
	return defs
}

// copyBundle writes the single manifest file into dest (created) — the
// installed bundle layout. Install refuses folder sources, so there is no
// recursive copy: a bundle is ONE self-contained spectra-plugin.json (w27
// file-only ruling; nothing ever read a bundle's other files).
func copyBundle(sourcePath, dest string) error {
	data, err := os.ReadFile(sourcePath)
	if err != nil {
		return fmt.Errorf("couldn't read the plugin manifest: %w", err)
	}
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return fmt.Errorf("couldn't create the plugin folder: %w", err)
	}
	if err := os.WriteFile(filepath.Join(dest, ManifestName), data, 0o644); err != nil {
		return fmt.Errorf("couldn't write the plugin manifest: %w", err)
	}
	return nil
}
