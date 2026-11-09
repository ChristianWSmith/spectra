package main

import (
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/services/kvstore"

	"github.com/ChristianWSmith/spectra/internal/data"
	"github.com/ChristianWSmith/spectra/internal/mappack"
)

// MapPackService is the frontend-facing radar map-pack surface: detect a
// local CS2 install, extract official radar images + transforms from the
// user's own pak01_dir.vpk into the app data dir, and track the one-time
// extraction prompt. Valve IP never ships in releases — extraction runs
// locally on demand (frontend/public/maps/README.md acquisition posture).
type MapPackService struct {
	app *application.App
	kvs *kvstore.KVStoreService
}

// MapPackStatus reports what the frontend needs to decide whether to
// prompt: whether CS2 was found, where, which packs are already
// extracted, and the prompt state.
type MapPackStatus struct {
	Found       bool     `json:"found"`
	Path        string   `json:"path"`   // detected or manually chosen CS2 dir
	Manual      bool     `json:"manual"` // path came from the folder picker
	PromptState string   `json:"promptState"`
	Maps        []string `json:"maps"` // extracted map names
}

// ExtractOutcome is returned by ExtractMapPacks: what succeeded, what
// didn't, and where the packs landed.
type ExtractOutcome struct {
	Maps   []string `json:"maps"`
	Errors []string `json:"errors"`
	Dir    string   `json:"dir"`
}

// GetMapPackStatus detects the CS2 install (manual path wins over
// auto-detect) and lists already-extracted packs. Detection failures are
// not errors — Found=false simply means no prompt.
func (s *MapPackService) GetMapPackStatus() MapPackStatus {
	manual, _ := s.kvs.Get(prefsMapPackCS2PathKey).(string)
	path := mappack.FindCS2(manual)
	st := MapPackStatus{
		Found:       path != "",
		Path:        path,
		Manual:      manual != "" && path != "",
		PromptState: prefString(s.kvs.Get(prefsMapPackPromptKey)),
		Maps:        extractedMaps(data.MapsDir()),
	}
	return st
}

// ExtractMapPacks extracts every official-map radar from the CS2 install
// at cs2Dir (empty = auto-detect / manual pref) into the app data dir.
// Per-map failures are reported in the outcome; the extraction is
// idempotent, so re-running after a game update refreshes the packs.
// The bundled frontend/public/maps copies ride along (WithBundledMeta +
// bundledMapMeta below) so the hand-authored elevation_regions land in
// the data-dir pack too — both extraction entry points (Settings and the
// first-run prompt) come through here.
func (s *MapPackService) ExtractMapPacks(cs2Dir string) ExtractOutcome {
	if cs2Dir == "" {
		manual, _ := s.kvs.Get(prefsMapPackCS2PathKey).(string)
		cs2Dir = mappack.FindCS2(manual)
	}
	if cs2Dir == "" {
		return ExtractOutcome{Errors: []string{"Counter-Strike 2 not found"}}
	}
	maps, errs, err := mappack.ExtractMapPacks(cs2Dir, data.MapsDir(),
		mappack.WithBundledMeta(bundledMapMeta))
	if err != nil {
		errs = append(errs, err.Error())
	}
	var names []string
	for _, m := range maps {
		names = append(names, m.Map)
	}
	if len(names) > 0 {
		// Extraction satisfies the prompt permanently.
		if setErr := s.kvs.Set(prefsMapPackPromptKey, "done"); setErr != nil {
			slog.Warn("save map pack prompt state", "error", setErr)
		}
	}
	return ExtractOutcome{Maps: names, Errors: errs, Dir: data.MapsDir()}
}

// bundledMapMeta returns the repo-committed meta.json for mapName out of
// the embedded frontend build: frontend/public/maps is copied verbatim
// into frontend/dist by Vite, and main.go embeds that dist — the very
// bytes the frontend falls back to at /maps/<map>/meta.json when the
// data-dir pack is missing. That copy is the canonical home of the
// hand-authored elevation_regions; extraction merges them into the
// fresh data-dir meta (mappack.WithBundledMeta → preserveElevation).
//
// nil means "no bundled pack for this map": an unsafe/unknown name, or a
// stub dist without maps (a fresh clone where only make test's index.html
// stub exists). Extraction then keeps whatever the data-dir copy already
// has — never an error.
func bundledMapMeta(mapName string) []byte {
	if !validPackName(mapName) {
		return nil
	}
	b, err := assets.ReadFile("frontend/dist/maps/" + mapName + "/meta.json")
	if err != nil {
		return nil
	}
	return b
}

// SetMapPackPromptState records the prompt decision ("declined" = never
// ask again) and, when path is non-empty, stores a manually chosen CS2
// folder for future detection.
func (s *MapPackService) SetMapPackPromptState(state, path string) error {
	if state != "" {
		if err := s.kvs.Set(prefsMapPackPromptKey, state); err != nil {
			return err
		}
	}
	if path != "" {
		if err := mappack.ValidateInstall(path); err != nil {
			return err
		}
		if err := s.kvs.Set(prefsMapPackCS2PathKey, path); err != nil {
			return err
		}
	}
	return nil
}

// ChooseCS2Dir opens the native folder picker for non-Steam or custom
// installs; an empty string means cancel. The choice is validated and
// persisted via SetMapPackPromptState by the caller. The picker itself
// lives in dialogs.go (chooseDirectory — one implementation for every
// folder the user picks).
func (s *MapPackService) ChooseCS2Dir() string {
	dir, err := chooseDirectory(s.app, "Choose your Counter-Strike 2 folder")
	if err != nil || dir == "" {
		return ""
	}
	return dir
}

// extractedMaps lists subdirectories of dir that contain a meta.json.
func extractedMaps(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if !e.IsDir() || strings.ContainsAny(e.Name(), "/\\") {
			continue
		}
		if _, err := os.Stat(filepath.Join(dir, e.Name(), "meta.json")); err == nil {
			out = append(out, e.Name())
		}
	}
	return out
}

// prefString coerces a prefs value to a string ("" when absent).
func prefString(v any) string {
	s, _ := v.(string)
	return s
}
