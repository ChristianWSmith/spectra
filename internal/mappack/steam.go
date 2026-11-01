package mappack

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// Steam install detection: locate game/csgo/pak01_dir.vpk for appid 730
// (CS2 keeps the CS:GO folder name). Probe order: explicit override (a
// manually chosen folder, from prefs), then the usual per-OS Steam roots;
// each root's libraryfolders.vdf lists every library drive, and each
// library holds steamapps/appmanifest_730.acf with the installdir.
// Facts: CS2.md "Steam CS2 install detection".

// cs2AppID is Steam's appid for Counter-Strike 2.
const cs2AppID = "730"

// defaultSteamRoots returns the conventional Steam library roots for the
// running OS. These are only starting points — real installs commonly
// live on other drives, which libraryfolders.vdf enumeration covers.
func defaultSteamRoots() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	switch runtime.GOOS {
	case "linux":
		return []string{
			filepath.Join(home, ".steam", "steam"),
			filepath.Join(home, ".local", "share", "Steam"),
		}
	case "darwin":
		return []string{filepath.Join(home, "Library", "Application Support", "Steam")}
	case "windows":
		var roots []string
		for _, env := range []string{"PROGRAMFILES(X86)", "PROGRAMFILES"} {
			if dir := os.Getenv(env); dir != "" {
				roots = append(roots, filepath.Join(dir, "Steam"))
			}
		}
		return roots
	}
	return nil
}

// FindCS2 locates the directory containing pak01_dir.vpk for the user's
// CS2 install. manual (a user-picked folder, possibly the CS2 root, the
// csgo dir, or a Steam root) is tried first and validated; then every
// conventional Steam root is scanned together with its extra libraries.
// Returns "" when nothing is found.
func FindCS2(manual string) string {
	if manual != "" {
		if pak := resolvePak(manual); pak != "" {
			return filepath.Dir(pak)
		}
	}
	for _, root := range defaultSteamRoots() {
		for _, lib := range steamLibraries(root) {
			if pak := pakInLibrary(lib); pak != "" {
				return filepath.Dir(pak)
			}
		}
	}
	return ""
}

// resolvePak accepts a user-picked path in any of the shapes a folder
// picker offers — the Steam root, the game dir, the csgo dir, or the VPK
// itself — and returns the pak01_dir.vpk path, or "".
func resolvePak(p string) string {
	fi, err := os.Stat(p)
	if err != nil {
		return ""
	}
	if !fi.IsDir() {
		if filepath.Base(p) == "pak01_dir.vpk" {
			return p
		}
		return ""
	}
	candidates := []string{
		filepath.Join(p, "pak01_dir.vpk"),
		filepath.Join(p, "csgo", "pak01_dir.vpk"),
		filepath.Join(p, "game", "csgo", "pak01_dir.vpk"),
		filepath.Join(p, "steamapps", "common", "Counter-Strike Global Offensive", "game", "csgo", "pak01_dir.vpk"),
	}
	for _, c := range candidates {
		if fileExists(c) {
			return c
		}
	}
	// A picked Steam root may hold the game via an extra library.
	for _, lib := range steamLibraries(p) {
		if pak := pakInLibrary(lib); pak != "" {
			return pak
		}
	}
	return ""
}

// steamLibraries returns every Steam library rooted at dir: the root
// itself plus each "path" entry in steamapps/libraryfolders.vdf.
func steamLibraries(dir string) []string {
	libs := []string{dir}
	data, err := os.ReadFile(filepath.Join(dir, "steamapps", "libraryfolders.vdf"))
	if err != nil {
		return libs
	}
	kv, err := parseKV(data)
	if err != nil {
		return libs
	}
	root, _ := kv["libraryfolders"].(map[string]kvValue)
	for _, v := range root {
		obj, ok := v.(map[string]kvValue)
		if !ok {
			continue
		}
		if p, ok := kvString(obj, "path"); ok && p != "" {
			libs = append(libs, p)
		}
	}
	return libs
}

// pakInLibrary finds pak01_dir.vpk for CS2 inside one Steam library via
// its appmanifest_730.acf ("" when absent).
func pakInLibrary(lib string) string {
	data, err := os.ReadFile(filepath.Join(lib, "steamapps", "appmanifest_"+cs2AppID+".acf"))
	if err != nil {
		return ""
	}
	kv, err := parseKV(data)
	if err != nil {
		return ""
	}
	state, _ := kv["AppState"].(map[string]kvValue)
	installDir, _ := kvString(state, "installdir")
	if installDir == "" {
		return ""
	}
	pak := filepath.Join(lib, "steamapps", "common", installDir, "game", "csgo", "pak01_dir.vpk")
	if fileExists(pak) {
		return pak
	}
	return ""
}

// ValidateInstall checks that dir holds a readable pak01_dir.vpk (in dir
// itself or one level down), for surfacing errors in the UI.
func ValidateInstall(dir string) error {
	if resolvePak(dir) == "" {
		return fmt.Errorf("no pak01_dir.vpk found under %s", dir)
	}
	return nil
}

func fileExists(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && !fi.IsDir()
}
