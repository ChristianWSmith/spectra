// Package data owns the on-disk locations for the app's durable state:
// the SQLite database and per-match sidecar directories. Paths follow the
// XDG base-directory spec ($XDG_DATA_HOME, default ~/.local/share), mirroring
// how prefs.go derives the config path — a crash or upgrade must never move
// data out from under the user.
package data

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/adrg/xdg"
)

// appName must stay in sync with build/config.yml's productName and the
// main.go const of the same name (importing main is not possible here).
const appName = "spectra"

// DBPath returns the SQLite database path ($XDG_DATA_HOME/spectra/spectra.db),
// creating the parent directory if needed.
func DBPath() string {
	path, err := xdg.DataFile(appName + "/spectra.db")
	if err != nil {
		return filepath.Join(xdg.DataHome, appName, "spectra.db")
	}
	return path
}

// MatchesDir returns the per-match sidecar directory root
// ($XDG_DATA_HOME/spectra/matches), creating it if needed. Each match gets a
// <id>/ subdirectory (position/voice sidecars land there in later milestones).
func MatchesDir() string {
	dir := filepath.Join(xdg.DataHome, appName, "matches")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return dir
	}
	return dir
}

// TempDir returns a scratch directory for in-progress work (decompressed
// demos mid-import), creating it if needed.
func TempDir() string {
	dir := filepath.Join(xdg.DataHome, appName, "tmp")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return dir
	}
	return dir
}

// EnsureDirs creates every directory the app writes to. Called once at
// startup so later call sites can assume paths exist.
func EnsureDirs() error {
	for _, dir := range []string{
		filepath.Dir(DBPath()),
		MatchesDir(),
		TempDir(),
	} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("data: mkdir %s: %w", dir, err)
		}
	}
	return nil
}
