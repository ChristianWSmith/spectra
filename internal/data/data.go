// Package data owns the on-disk locations for the app's durable state:
// the SQLite database, per-match sidecar directories and the managed demo
// copies (DemosDir). Paths follow the
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

// appName is the lowercase app IDENTIFIER (XDG dirs, prefs path, GTK
// app id) — must stay in sync with the main.go const of the same name
// and Taskfile APP_NAME (importing main is not possible here). It is
// deliberately NOT build/config.yml's productName, which is the
// display name ("Spectra").
const appName = "spectra"

// RootDir returns the app data root ($XDG_DATA_HOME/spectra) without
// creating it — the directory every other path below lives in, and the
// subtree the demo scanner must never walk into (spectra's own files are
// not the user's demos).
func RootDir() string {
	return filepath.Join(xdg.DataHome, appName)
}

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

// DemosDir returns the managed demo-copy directory
// ($XDG_DATA_HOME/spectra/demos), creating it if needed. Every import
// copies the raw demo here, named by its content hash, so the match can be
// reprocessed after the user's original file is moved or deleted. Only
// files under this directory are ever deleted by the app (see
// library.Importer.RemoveManagedDemo) — a user's original demo is never
// ours to remove.
func DemosDir() string {
	dir := filepath.Join(RootDir(), "demos")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return dir
	}
	return dir
}

// MapsDir returns the extracted map-pack root
// ($XDG_DATA_HOME/spectra/maps), creating it if needed. Each map gets a
// <name>/ subdirectory (meta.json + radar.png) — the same on-disk shape
// as frontend/public/maps, but written by the in-app CS2 extractor and
// never committed (Valve IP stays local; see internal/mappack).
func MapsDir() string {
	dir := filepath.Join(xdg.DataHome, appName, "maps")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return dir
	}
	return dir
}

// IconsDir returns the extracted game-icon root
// ($XDG_DATA_HOME/spectra/icons), creating it if needed. Flat directory
// of <name>.svg files (one per canonical equipment name) written by the
// in-app CS2 extractor and never committed — the same acquisition
// posture as the map packs (Valve IP stays local; see internal/mappack).
func IconsDir() string {
	dir := filepath.Join(xdg.DataHome, appName, "icons")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return dir
	}
	return dir
}

// SoundsDir returns the extracted sound-file root
// ($XDG_DATA_HOME/spectra/sounds), creating it if needed. Flat directory
// of <name>.wav / <name>.mp3 files (one per extracted sound variant)
// written by the in-app CS2 extractor and never committed — the same
// acquisition posture as the map packs and equipment icons (Valve IP stays
// local; see internal/mappack).
func SoundsDir() string {
	dir := filepath.Join(xdg.DataHome, appName, "sounds")
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
		DemosDir(),
	} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("data: mkdir %s: %w", dir, err)
		}
	}
	return nil
}
