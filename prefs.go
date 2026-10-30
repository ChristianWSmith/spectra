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
