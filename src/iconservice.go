package main

import (
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/services/kvstore"

	"github.com/ChristianWSmith/spectra/internal/data"
	"github.com/ChristianWSmith/spectra/internal/mappack"
)

// IconService is the frontend-facing icon surface: extract the game's
// SVG silhouettes (weapons, utility, armor, bomb), its death-notice
// glyphs and its per-map square logos from the user's own CS2 install
// into the app data dir, and report which names have an icon ready. Same
// acquisition posture as the radar map packs — Valve IP never ships;
// extraction runs locally on demand (frontend/public/maps/README.md).
//
// Icon keys are the canonical demoinfocs equipment names — the exact
// common.EquipmentType.String() strings the replay state stream's
// weapon/inventory fields carry ("AK-47", "Smoke Grenade",
// "Kevlar + Helmet", …) — so a lookup is one exact-match hit against
// whatever the stream already says; the death-notice glyphs key on the
// renderer's glyph names, and the map logos on the MAP name
// ("de_mirage", manifest half `maps`). A name with no icon (no CS2
// installed, file missing after a game update) is simply absent from the
// manifest: the frontend falls back to a text label.
type IconService struct {
	kvs *kvstore.KVStoreService
	// app is the handle the shared spectra:asset-progress emitter rides
	// (assetProgressFor in mappackservice.go) — nil in tests, which
	// simply means no emission.
	app *application.App
}

// IconManifest is the one icons contract, returned by the service AND
// served at GET /api/icons/manifest.json (built fresh from the icons
// dir, never a stale manifest file):
//
//	{"extracted": bool, "count": N,
//	 "icons": {"<canonical name>": "/api/icons/<file>.svg", …},
//	 "maps": {"<map name>": "/api/icons/map_icon_<map>.svg", …},
//	 "mapCount": N,
//	 "note": "…"}   // human-readable status, omitted when empty
//
// count and mapCount are SPLIT on purpose: count is the equipment +
// death-notice set (Settings' "Equipment icons" row reads it, and the
// Replay preload walks `icons` — folding the map logos in would drag
// ≈1.75 MB of SVGs into a preload that never draws one). maps/mapCount
// are omitted when empty; `count` stays the `icons` size.
type IconManifest struct {
	Extracted bool              `json:"extracted"`
	Count     int               `json:"count"`
	Icons     map[string]string `json:"icons"`
	Maps      map[string]string `json:"maps,omitempty"`
	MapCount  int               `json:"mapCount,omitempty"`
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

// ExtractIcons extracts every icon the manifest serves (equipment +
// death-notice glyphs + the map logos) from the CS2 install at
// cs2Dir (empty = auto-detect: the saved mappack_cs2_path pref first,
// then the conventional Steam roots — mappack.FindCS2, the same
// detection MapPackService uses) into the app data dir and returns the
// refreshed manifest. Never panics and never fails the call: a missing
// install or a VPK error comes back as extracted=false/Partial with a
// human-readable note, because "no icons" is a fallback state (text
// labels), not an error. Per-icon progress rides the shared
// spectra:asset-progress emitter (assetProgressFor, family "icons") so
// the frontend can render a determinate bar.
func (s *IconService) ExtractIcons(cs2Dir string) IconManifest {
	manual, _ := s.kvs.Get(prefsMapPackCS2PathKey).(string)
	return extractIcons(cs2Dir, manual, data.IconsDir(), assetProgressFor(s.app, assetFamilyIcons))
}

// extractIcons is the testable core of ExtractIcons: detect the install
// (explicit dir wins over detection via the saved manual path), extract
// into outDir, and describe the outcome as a manifest. progress (nil =
// no emission) is the per-item callback forwarded to
// mappack.WithProgress; the honest denominator is mappack's job list —
// the canonical icon table plus the map icons the VPK carries — known
// before the first item.
func extractIcons(cs2Dir, manual, outDir string, progress func(done, total int)) IconManifest {
	if cs2Dir == "" {
		cs2Dir = mappack.FindCS2(manual)
	}
	if cs2Dir == "" {
		return IconManifest{
			Icons: map[string]string{},
			Note:  "Counter-Strike 2 not found (install it, or choose its folder in Settings)",
		}
	}
	_, errs, err := mappack.ExtractIcons(cs2Dir, outDir, mappack.WithProgress(progress))
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
// every URL points at this process's own /api/icons route. The flat
// listing splits by family: a map icon (IsMapIconFile) lands in Maps
// with its map name as the key, everything else in Icons with its
// canonical name — Count stays the equipment+notice size (see
// IconManifest), Extracted is true when EITHER family is on disk.
func buildIconManifest(dir string) IconManifest {
	files := mappack.IconFiles(dir)
	icons := make(map[string]string, len(files))
	maps := make(map[string]string)
	for name, file := range files {
		url := "/api/icons/" + file
		if mappack.IsMapIconFile(file) {
			maps[name] = url
		} else {
			icons[name] = url
		}
	}
	m := IconManifest{
		Extracted: len(icons)+len(maps) > 0,
		Count:     len(icons),
		Icons:     icons,
	}
	if len(maps) > 0 {
		m.Maps = maps
		m.MapCount = len(maps)
	}
	return m
}
