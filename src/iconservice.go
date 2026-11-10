package main

import (
	"strings"

	"github.com/wailsapp/wails/v3/pkg/services/kvstore"

	"github.com/ChristianWSmith/spectra/internal/data"
	"github.com/ChristianWSmith/spectra/internal/mappack"
)

// IconService is the frontend-facing equipment-icon surface: extract the
// game's SVG silhouettes (weapons, utility, armor, bomb) from the user's
// own CS2 install into the app data dir, and report which canonical
// equipment names have an icon ready. Same acquisition posture as the
// radar map packs — Valve IP never ships; extraction runs locally on
// demand (frontend/public/maps/README.md).
//
// Icon keys are the canonical demoinfocs equipment names — the exact
// common.EquipmentType.String() strings the replay state stream's
// weapon/inventory fields carry ("AK-47", "Smoke Grenade",
// "Kevlar + Helmet", …) — so a lookup is one exact-match hit against
// whatever the stream already says. A name with no icon (no CS2
// installed, file missing after a game update) is simply absent from the
// manifest: the frontend falls back to a text label.
type IconService struct {
	kvs *kvstore.KVStoreService
}

// IconManifest is the one icons contract, returned by the service AND
// served at GET /api/icons/manifest.json (built fresh from the icons
// dir, never a stale manifest file):
//
//	{"extracted": bool, "count": N,
//	 "icons": {"<canonical name>": "/api/icons/<file>.svg", …},
//	 "note": "…"}   // human-readable status, omitted when empty
type IconManifest struct {
	Extracted bool              `json:"extracted"`
	Count     int               `json:"count"`
	Icons     map[string]string `json:"icons"`
	Note      string            `json:"note,omitempty"`
}

// GetIconManifest returns the current manifest from the extracted-icons
// directory. extracted=false (with an empty icons map) simply means
// nothing has been extracted yet — not an error; the frontend decides
// whether to offer the one-time extraction prompt.
func (s *IconService) GetIconManifest() IconManifest {
	m := buildIconManifest(data.IconsDir())
	if !m.Extracted {
		m.Note = "icons not extracted yet"
	}
	return m
}

// ExtractIcons extracts every equipment icon from the CS2 install at
// cs2Dir (empty = auto-detect: the saved mappack_cs2_path pref first,
// then the conventional Steam roots — mappack.FindCS2, the same
// detection MapPackService uses) into the app data dir and returns the
// refreshed manifest. Never panics and never fails the call: a missing
// install or a VPK error comes back as extracted=false/Partial with a
// human-readable note, because "no icons" is a fallback state (text
// labels), not an error.
func (s *IconService) ExtractIcons(cs2Dir string) IconManifest {
	manual, _ := s.kvs.Get(prefsMapPackCS2PathKey).(string)
	return extractIcons(cs2Dir, manual, data.IconsDir())
}

// extractIcons is the testable core of ExtractIcons: detect the install
// (explicit dir wins over detection via the saved manual path), extract
// into outDir, and describe the outcome as a manifest.
func extractIcons(cs2Dir, manual, outDir string) IconManifest {
	if cs2Dir == "" {
		cs2Dir = mappack.FindCS2(manual)
	}
	if cs2Dir == "" {
		return IconManifest{
			Icons: map[string]string{},
			Note:  "Counter-Strike 2 not found (install it, or choose its folder in Settings)",
		}
	}
	_, errs, err := mappack.ExtractIcons(cs2Dir, outDir)
	m := buildIconManifest(outDir)
	var notes []string
	if err != nil {
		notes = append(notes, err.Error())
	}
	if len(errs) > 0 {
		notes = append(notes, strings.Join(errs, "; "))
	}
	m.Note = strings.Join(notes, " — ")
	return m
}

// buildIconManifest turns an icons directory into the served manifest:
// mappack lists the extracted files fresh (no stale manifest file), and
// every URL points at this process's own /api/icons route.
func buildIconManifest(dir string) IconManifest {
	files := mappack.IconFiles(dir)
	icons := make(map[string]string, len(files))
	for name, file := range files {
		icons[name] = "/api/icons/" + file
	}
	return IconManifest{
		Extracted: len(icons) > 0,
		Count:     len(icons),
		Icons:     icons,
	}
}
