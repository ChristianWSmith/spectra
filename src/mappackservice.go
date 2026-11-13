package main

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/services/kvstore"

	"github.com/ChristianWSmith/spectra/internal/data"
	"github.com/ChristianWSmith/spectra/internal/mappack"
)

// Event name emitted while an extractor runs. Deliberately NOT
// spectra:job-progress: that payload keys a jobId in the Library's job
// store (services.js jobProgress map), and a colliding id there would
// corrupt it — asset extraction is not a library job.
const eventAssetProgress = "spectra:asset-progress"

// assetProgressMinInterval throttles asset-progress events to at most one
// per 100 ms — the same cadence as library.go's progressMinInterval. The
// closing call (done == total) is never throttled, so the bar always
// lands on the end instead of stalling short of it.
const assetProgressMinInterval = 100 * time.Millisecond

// The payload's family per extractor — all THREE families emit
// spectra:asset-progress through the one emitter below (map packs via
// MapPackService, icons via IconService, sounds via SoundService), so
// every step of a run renders a determinate bar.
const (
	assetFamilyMapPacks = "map-packs"
	assetFamilyIcons    = "icons"
	assetFamilySounds   = "sounds"
)

// AssetProgressEvent is the payload of spectra:asset-progress: one
// extractor family's per-item progress. family is map-packs / icons /
// sounds (the consts above), stage the phase within it ("extract" is the
// only one today), done the items completed out of the run's total.
type AssetProgressEvent struct {
	Family string `json:"family"`
	Stage  string `json:"stage"`
	Done   int    `json:"done"`
	Total  int    `json:"total"`
}

// assetProgressFor returns the spectra:asset-progress callback for an
// extractor run on a service that holds an app handle — the production
// adapter over assetProgress (the throttled emitter every family
// shares). A nil app (services constructed without a handle, as the
// package tests do) means no emitter: a nil callback the extractor
// simply skips.
func assetProgressFor(app *application.App, family string) func(done, total int) {
	if app == nil {
		return nil
	}
	return assetProgress(func(ev AssetProgressEvent) {
		app.Event.Emit(eventAssetProgress, ev)
	}, family)
}

// assetProgress builds the per-item progress callback one family wires
// into mappack.WithProgress — THE one spectra:asset-progress emitter,
// shared by map packs, icons and sounds (the extractors' honest
// denominators are set beside their loops: packs attempted / canonical
// icon table / canonical sound table, all known before the first item).
// Emission goes through emit (production: app.Event.Emit via
// assetProgressFor; tests: a recorder), throttled to
// assetProgressMinInterval: an intermediate call inside the window is
// dropped, the closing call (done == total) never is. Each call carries
// one COMPLETED item, so done counts 1..total — never a fabricated
// fraction.
func assetProgress(emit func(AssetProgressEvent), family string) func(done, total int) {
	return throttledAssetProgress(assetProgressMinInterval, emit, family)
}

// throttledAssetProgress is assetProgress with the throttle window
// passed in — the seam the tests use to pin the drop rule without
// racing the real clock (production always passes
// assetProgressMinInterval via assetProgress).
func throttledAssetProgress(window time.Duration, emit func(AssetProgressEvent), family string) func(done, total int) {
	if emit == nil {
		return nil
	}
	// mu guards last and the emit itself: ExtractMapPacks' per-map pool
	// completes maps on several goroutines, so callbacks may arrive
	// concurrently. Serializing here keeps `last` race-free (clean
	// under -race) and guarantees one emission at a time — the callback
	// can never overlap itself, which is also what keeps the
	// concurrent-extraction probe's maxActive ≤ 1 honest.
	var mu sync.Mutex
	var last time.Time
	return func(done, total int) {
		mu.Lock()
		defer mu.Unlock()
		now := time.Now()
		if done < total && now.Sub(last) < window {
			return
		}
		last = now
		emit(AssetProgressEvent{
			Family: family,
			Stage:  "extract",
			Done:   done,
			Total:  total,
		})
	}
}

// MapPackService is the frontend-facing radar map-pack surface: detect a
// local CS2 install, extract official radar images + transforms from the
// user's own pak01_dir.vpk into the app data dir, and report the
// presence signals the launch prompt keys on (which packs are already
// extracted). Valve IP never ships in releases — extraction runs locally
// on demand (frontend/public/maps/README.md acquisition posture).
type MapPackService struct {
	app *application.App
	kvs *kvstore.KVStoreService
}

// MapPackStatus reports what the frontend needs to decide whether to
// prompt: whether CS2 was found, where, which packs are already
// extracted. The prompt gate is presence-driven — it opens whenever any
// asset family is missing (icons and sounds ride GetIconManifest /
// GetSoundManifest) — so there is deliberately no prompt-state field.
type MapPackStatus struct {
	Found  bool     `json:"found"`
	Path   string   `json:"path"`   // detected or manually chosen CS2 dir
	Manual bool     `json:"manual"` // path came from the folder picker
	Maps   []string `json:"maps"`   // extracted map names
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
// not errors — Found=false simply means the frontend shows the
// "Counter-Strike 2 not found" prompt variant instead.
func (s *MapPackService) GetMapPackStatus() MapPackStatus {
	manual, _ := s.kvs.Get(prefsMapPackCS2PathKey).(string)
	path := mappack.FindCS2(manual)
	st := MapPackStatus{
		Found:  path != "",
		Path:   path,
		Manual: manual != "" && path != "",
		Maps:   extractedMaps(data.MapsDir()),
	}
	return st
}

// ExtractMapPacks extracts every official-map radar from the CS2 install
// at cs2Dir (empty = auto-detect / manual pref) into the app data dir.
// Per-map failures are reported in the outcome; the extraction is
// idempotent, so re-running after a game update refreshes the packs.
// Per-map progress is emitted as spectra:asset-progress (throttled) so
// the frontend can render a determinate bar instead of a bare spinner.
// The bundled frontend/public/maps copies ride along (WithBundledMeta +
// bundledMapMeta below) so the hand-authored elevation_regions land in
// the data-dir pack too — both extraction entry points (Settings and the
// launch prompt) come through here.
func (s *MapPackService) ExtractMapPacks(cs2Dir string) ExtractOutcome {
	if cs2Dir == "" {
		manual, _ := s.kvs.Get(prefsMapPackCS2PathKey).(string)
		cs2Dir = mappack.FindCS2(manual)
	}
	if cs2Dir == "" {
		return ExtractOutcome{Errors: []string{"Counter-Strike 2 not found"}}
	}
	maps, errs, err := mappack.ExtractMapPacks(cs2Dir, data.MapsDir(),
		mappack.WithProgress(assetProgressFor(s.app, assetFamilyMapPacks)),
		mappack.WithBundledMeta(bundledMapMeta))
	if err != nil {
		errs = append(errs, err.Error())
	}
	var names []string
	for _, m := range maps {
		names = append(names, m.Map)
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

// SetCS2Dir validates a manually chosen CS2 folder (path) and persists
// it for future detection (prefsMapPackCS2PathKey). It is the second
// half of ChooseCS2Dir: the picker opens the dialog, the caller persists
// the choice. An empty path is a no-op (picker cancel).
func (s *MapPackService) SetCS2Dir(path string) error {
	if path == "" {
		return nil
	}
	if err := mappack.ValidateInstall(path); err != nil {
		return err
	}
	return s.kvs.Set(prefsMapPackCS2PathKey, path)
}

// ChooseCS2Dir opens the native folder picker for non-Steam or custom
// installs; an empty string means cancel. The choice is validated and
// persisted via SetCS2Dir by the caller. The picker itself
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
