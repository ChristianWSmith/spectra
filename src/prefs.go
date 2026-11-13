package main

import (
	"math"
	"path/filepath"

	"github.com/adrg/xdg"
	"github.com/wailsapp/wails/v3/pkg/services/kvstore"

	"github.com/ChristianWSmith/spectra/internal/budget"
)

// Preference keys stored in the app's kvstore (a JSON file under the OS
// config directory — see prefsFilename).
const (
	// prefsWindowWidthKey / prefsWindowHeightKey persist the window size.
	prefsWindowWidthKey  = "window_width"
	prefsWindowHeightKey = "window_height"

	// prefsMapPackCS2PathKey holds a manually chosen CS2 folder (empty =
	// auto-detect through Steam). Written through
	// MapPackService.SetCS2Dir — the prompt-state pref that used to sit
	// beside it is GONE on purpose: the launch prompt is presence-driven
	// (it re-opens every launch until the assets exist), so there is
	// nothing to persist but the folder.
	prefsMapPackCS2PathKey = "mappack_cs2_path"

	// prefsFontSizeKey is the app font-size setting: "small" | "medium" |
	// "large". "medium" is the default (unset/corrupt values fall back to
	// it in the frontend); "small" is today's hardcoded size. The frontend
	// reads/writes it directly through the kvstore service — Go never
	// consumes it.
	prefsFontSizeKey = "font_size"

	// The knife/warmup display pref (show knife + warmup rounds in the
	// round lists) is RETIRED: the extractor discards knife/warmup
	// rounds at ingest, so every stored round is a counted round and
	// there is nothing left to filter (a stale value in a user's
	// kvstore is orphaned and ignored — pinned gone by
	// TestRetiredKnifeWarmupRoundsPrefGone).

	// prefsDemoDirsKey holds the "import dirs" folder list the
	// Library scans (absolute paths, normalized by library.NormalizeDirs).
	// Unset = the defaults (library.DefaultDemoDirs: Downloads + CS2's
	// replay folder), recomputed on every read; an empty list = scan
	// nothing. Written and read by LibraryService — the frontend goes
	// through GetDemoDirs/SetDemoDirs/ResetDemoDirs, never the raw key.
	prefsDemoDirsKey = "demo_dirs"

	// prefsCopyOnImportKey toggles whether an import copies the demo into
	// the managed demo dir (data.DemosDir) — the copy that lets Reprocess
	// survive the source file going away. Boolean, DEFAULT true (unset =
	// copy). Written by LibraryService.SetDemoCopyOnImport, read by
	// library.Options.CopyEnabled PER JOB at process time (a toggle in
	// Settings applies to jobs already queued) and surfaced by
	// GetDemoCopyOnImport — the frontend never touches the raw key.
	prefsCopyOnImportKey = "copy_on_import"

	// prefsImportConcurrencyKey is how many import jobs run AT ONCE (the
	// "Concurrent imports" numeric control in Settings; 1 = sequential).
	// Integer, DEFAULT budget.MachineTokens — the machine's work-token
	// budget (unset ⇒ maxConcurrentImports below decides the ladder). Written by
	// LibraryService.SetImportConcurrency, read by
	// library.Options.Concurrency PER JOB at claim time (so a change
	// applies to jobs already queued — the copy-on-import shape) and
	// surfaced by GetImportConcurrency — the frontend never touches the
	// raw key.
	prefsImportConcurrencyKey = "import_concurrency"

	// prefsVoiceVolumeKey / prefsGunsVolumeKey / prefsUtilityVolumeKey /
	// prefsC4VolumeKey / prefsAnnouncerVolumeKey persist the replay-audio
	// fader levels (0..1; default 0.8) — the volume popover under the
	// scrubber and Settings' Audio & voice section write the same keys.
	// prefsFootstepsVolumeKey joins them for the player-sound (footsteps /
	// land / jump / fall) fader; its frontend read default is 0.8 (80 %,
	// owner instruction 2026-11-12 — inline with the other five) — muted
	// by the session mute in the replay volume popover, not by
	// the fader (the key itself is just registered here — Go never
	// consumes it).
	// The frontend reads/writes all six directly through the kvstore
	// service — Go never consumes them.
	prefsVoiceVolumeKey     = "voice_volume"
	prefsGunsVolumeKey      = "guns_volume"
	prefsUtilityVolumeKey   = "utility_volume"
	prefsC4VolumeKey        = "c4_volume"
	prefsAnnouncerVolumeKey = "announcer_volume"
	prefsFootstepsVolumeKey = "footsteps_volume"
)

// prefsFilename returns the path of the on-disk prefs file, creating the
// parent directory if needed.
func prefsFilename() string {
	path, err := xdg.ConfigFile(appName + "/prefs.json")
	if err != nil {
		return filepath.Join(xdg.ConfigHome, appName, "prefs.json")
	}
	return path
}

// savedWindowSize returns the persisted window size when both values are
// usable integers in a sane range, else defW x defH. The store decodes JSON
// numbers as float64, so that shape is accepted too; a corrupt or
// out-of-range pref must not break launch.
func savedWindowSize(w, h any, defW, defH int) (int, int) {
	ww, okW := prefInt(w)
	hh, okH := prefInt(h)
	if !okW || !okH || ww < 200 || hh < 200 || ww > 10000 || hh > 10000 {
		return defW, defH
	}
	return ww, hh
}

// prefInt coerces a value read from the prefs store to an int.
func prefInt(v any) (int, bool) {
	switch n := v.(type) {
	case float64:
		if n != math.Trunc(n) {
			return 0, false
		}
		return int(n), true
	case int:
		return n, true
	case int64:
		return int(n), true
	default:
		return 0, false
	}
}

// prefStrings coerces a value read from the prefs store to a string
// slice. ok is false when the value is absent or is not a list of
// strings, so a corrupt pref makes the caller fall back to its default
// instead of breaking the feature. The store round-trips JSON: an array
// arrives as []any of string after a reload and stays []string until
// then — both shapes are accepted.
func prefStrings(v any) ([]string, bool) {
	switch t := v.(type) {
	case []string:
		return t, true
	case []any:
		out := make([]string, 0, len(t))
		for _, e := range t {
			s, ok := e.(string)
			if !ok {
				return nil, false
			}
			out = append(out, s)
		}
		return out, true
	default:
		return nil, false
	}
}

// prefBool coerces a value read from the prefs store to a bool. ok is
// false when the value is absent or is not a boolean, so a caller with a
// non-false default (copy-on-import: unset = COPY) can fall back to it
// instead of reading "corrupt" as "off" — the (value, ok) shape mirrors
// prefInt/prefStrings.
func prefBool(v any) (bool, bool) {
	b, ok := v.(bool)
	return b, ok
}

// copyOnImportPref is library.Options.CopyEnabled wired to the kvstore:
// the copy_on_import pref consulted ONCE PER JOB (process time), so a
// Settings toggle applies to jobs already queued. Unset or corrupt ⇒
// true — the default is copying, and a broken pref must never silently
// stop making backups. The kvstore is internally locked (RWMutex), so
// the worker goroutine may call this while Settings writes.
func copyOnImportPref(kvs *kvstore.KVStoreService) func() bool {
	return func() bool {
		enabled, ok := prefBool(kvs.Get(prefsCopyOnImportKey))
		return !ok || enabled
	}
}

// maxConcurrentImports is the ceiling AND the default of the
// import_concurrency pref — the owner's thread ladder (2026-11-12; the
// ladder's home is budget.MachineTokens since 2026-11-13), one
// rung at a time:
//
//  1. Threads: runtime.GOMAXPROCS(0) — see budget.MachineTokens, THE
//     canonical ladder (consolidated there 2026-11-13): Go's execution
//     parallelism honors a GOMAXPROCS env var or container CPU quota
//     where NumCPU would over-allocate. This is rung 1 and it is
//     reachable, so it is THE default.
//  2. Cores: unreachable portably — Go exposes no physical-core API
//     (SMT makes threads ≠ cores and there is no stdlib way to ask), so
//     this rung is documented rather than taken.
//  3. Single-threaded: the floor — budget.MachineTokens' n < 1 guard
//     collapses a degenerate answer to 1 so the setting can never ask
//     for 0 (or negative) jobs.
//
// The pref now means "how many of the machine's work tokens imports
// may take" (one token per job — internal/budget). The stored value is
// clamped into [1, this] on every read and write
// (clampImportConcurrency): a corrupt or stale pref never asks for more
// concurrency than the pool has workers (library.workerCount — the same
// budget.MachineTokens, so the two bounds always agree), nor for less
// than one.
func maxConcurrentImports() int {
	return budget.MachineTokens()
}

// clampImportConcurrency folds a requested value into [1, max].
func clampImportConcurrency(n int) int {
	max := maxConcurrentImports()
	if n < 1 {
		return 1
	}
	if n > max {
		return max
	}
	return n
}

// importConcurrencyPref is library.Options.Concurrency wired to the
// kvstore: the import_concurrency pref consulted ONCE PER JOB (claim
// time), so a Settings change applies to jobs already queued — the same
// per-job shape as copyOnImportPref. Unset or corrupt ⇒ the default
// (maxConcurrentImports — the machine's work-token budget); an out-of-range
// integer clamps into [1, max] instead of falling back, so a stale pref
// from a bigger machine still runs here — at this machine's bound. The
// kvstore is internally locked (RWMutex), so a worker goroutine may call
// this while Settings writes.
func importConcurrencyPref(kvs *kvstore.KVStoreService) func() int {
	return func() int {
		n, ok := prefInt(kvs.Get(prefsImportConcurrencyKey))
		if !ok {
			return maxConcurrentImports()
		}
		return clampImportConcurrency(n)
	}
}
