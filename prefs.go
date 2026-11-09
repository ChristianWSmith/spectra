package main

import (
	"math"
	"path/filepath"

	"github.com/adrg/xdg"
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

	// prefsShowKnifeWarmupRoundsKey toggles showing knife (pregame) and
	// warmup rounds — negative-numbered, not counted play — in the round
	// lists. Boolean; default false (hidden). The frontend reads/writes it
	// directly through the kvstore service — Go never consumes it.
	prefsShowKnifeWarmupRoundsKey = "show_knife_warmup_rounds"

	// prefsDemoDirsKey holds the "import dirs" folder list the
	// Library scans (absolute paths, normalized by library.NormalizeDirs).
	// Unset = the defaults (library.DefaultDemoDirs: Downloads + CS2's
	// replay folder), recomputed on every read; an empty list = scan
	// nothing. Written and read by LibraryService — the frontend goes
	// through GetDemoDirs/SetDemoDirs/ResetDemoDirs, never the raw key.
	prefsDemoDirsKey = "demo_dirs"

	// prefsVoiceVolumeKey / prefsGunsVolumeKey / prefsUtilityVolumeKey /
	// prefsC4VolumeKey / prefsAnnouncerVolumeKey persist the FIVE
	// replay-audio fader levels (0..1;
	// default 0.8) — the volume popover under the scrubber and Settings'
	// Audio & voice section write the same keys. The frontend reads/writes
	// them directly through the kvstore service — Go never consumes them.
	prefsVoiceVolumeKey     = "voice_volume"
	prefsGunsVolumeKey      = "guns_volume"
	prefsUtilityVolumeKey   = "utility_volume"
	prefsC4VolumeKey        = "c4_volume"
	prefsAnnouncerVolumeKey = "announcer_volume"
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
