package library

import (
	"path/filepath"
	"strings"

	"github.com/adrg/xdg"

	"github.com/ChristianWSmith/spectra/internal/mappack"
)

// Import-dir defaults and normalization for the "import dirs" list —
// edited in Settings, consumed by the Library's scan. The
// list itself is a kvstore pref (prefsDemoDirsKey in prefs.go); an unset
// pref means "use the defaults below", which are recomputed on every read
// so a newly installed CS2 or a relocated Downloads folder shows up
// without a settings edit.

// DefaultDemoDirs returns the import dirs to use when the user has never
// configured any: the user's Downloads folder plus the CS2 client's
// replay folder — the directory in-game match downloads (Premier etc.)
// land in, `<CS2 install>/game/csgo/replays`, which varies per OS only
// through the Steam library location (CS2.md "CS2 demo download folder
// (in-client)"; mappack.FindCS2 is the canonical Steam/CS2 detection).
func DefaultDemoDirs() []string {
	return defaultDemoDirs(xdg.UserDirs.Download, mappack.FindCS2(""))
}

// defaultDemoDirs is the pure half of DefaultDemoDirs: downloads is the
// user's Downloads folder ("" when the platform doesn't report one),
// cs2Dir is the directory holding pak01_dir.vpk ("" when CS2 wasn't
// found). Existence is not checked here — the defaults are advertised
// even for a folder that does not exist yet (CS2's replay folder appears
// with the first in-client download), and the scan skips missing roots.
func defaultDemoDirs(downloads, cs2Dir string) []string {
	var out []string
	if downloads != "" {
		out = append(out, downloads)
	}
	if cs2Dir != "" {
		out = append(out, filepath.Join(cs2Dir, "replays"))
	}
	return out
}

// NormalizeDirs canonicalizes a user-supplied folder list: trims space,
// drops empty entries, makes paths absolute and clean, and removes
// duplicates while keeping the first occurrence. Absolute paths are the
// contract — a relative entry would make the scanner's output depend on
// the process working directory.
func NormalizeDirs(dirs []string) []string {
	out := make([]string, 0, len(dirs))
	seen := make(map[string]bool, len(dirs))
	for _, d := range dirs {
		d = filepath.Clean(strings.TrimSpace(d))
		if d == "" || d == "." {
			continue
		}
		if abs, err := filepath.Abs(d); err == nil {
			d = abs
		}
		if seen[d] {
			continue
		}
		seen[d] = true
		out = append(out, d)
	}
	return out
}
