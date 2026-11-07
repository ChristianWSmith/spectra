package main

import (
	"strings"

	"github.com/wailsapp/wails/v3/pkg/services/kvstore"

	"github.com/ChristianWSmith/spectra/internal/data"
	"github.com/ChristianWSmith/spectra/internal/mappack"
)

// SoundService is the frontend-facing weapon/utility-audio surface: extract
// the game's firing and detonation sounds from the user's own CS2 install
// into the app data dir, and report which canonical equipment names have
// which sound variants ready. Same acquisition posture as the radar map
// packs and equipment icons — Valve IP never ships; extraction runs locally
// on demand (frontend/public/maps/README.md).
//
// Sound keys are the canonical demoinfocs equipment names — the exact
// common.EquipmentType.String() strings iconTable keys on ("AK-47",
// "HE Grenade", …) — so a lookup is one exact-match hit against whatever
// the replay stream already says. A name with no sound (no CS2 installed,
// file missing after a game update) is simply absent from the manifest:
// the replay plays nothing for it.
type SoundService struct {
	kvs *kvstore.KVStoreService
}

// SoundManifest is the one sounds contract, returned by the service AND
// served at GET /api/sounds/manifest.json (built fresh from the sounds
// dir, never a stale manifest file):
//
//	{"extracted": bool, "count": N,
//	 "sounds": {"<canonical name>": ["/api/sounds/<file>.wav", …], …},
//	 "note": "…"}   // human-readable status, omitted when empty
//
// The value is a LIST because a logical item can have several sound
// variants (ak47_01/02/04) — the replay picks one at random per play.
type SoundManifest struct {
	Extracted bool                `json:"extracted"`
	Count     int                 `json:"count"`
	Sounds    map[string][]string `json:"sounds"`
	Note      string              `json:"note,omitempty"`
}

// GetSoundManifest returns the current manifest from the extracted-sounds
// directory. extracted=false (with an empty sounds map) simply means
// nothing has been extracted yet — not an error; the replay stays silent
// and the Settings tab offers the extraction button.
func (s *SoundService) GetSoundManifest() SoundManifest {
	m := buildSoundManifest(data.SoundsDir())
	if !m.Extracted {
		m.Note = "sounds not extracted yet"
	}
	return m
}

// ExtractSounds extracts every sound in mappack's table from the CS2
// install at cs2Dir (empty = auto-detect: the saved mappack_cs2_path pref
// first, then the conventional Steam roots — mappack.FindCS2, the same
// detection MapPackService and IconService use) into the app data dir and
// returns the refreshed manifest. Never panics and never fails the call: a
// missing install or a VPK error comes back as extracted=false with a
// human-readable note, because "no sounds" is a fallback state (silence),
// not an error.
func (s *SoundService) ExtractSounds(cs2Dir string) SoundManifest {
	manual, _ := s.kvs.Get(prefsMapPackCS2PathKey).(string)
	return extractSounds(cs2Dir, manual, data.SoundsDir())
}

// extractSounds is the testable core of ExtractSounds: detect the install
// (explicit dir wins over detection via the saved manual path), extract
// into outDir, and describe the outcome as a manifest.
func extractSounds(cs2Dir, manual, outDir string) SoundManifest {
	if cs2Dir == "" {
		cs2Dir = mappack.FindCS2(manual)
	}
	if cs2Dir == "" {
		return SoundManifest{
			Sounds: map[string][]string{},
			Note:   "Counter-Strike 2 not found (install it, or choose its folder in Settings)",
		}
	}
	_, errs, err := mappack.ExtractSounds(cs2Dir, outDir)
	m := buildSoundManifest(outDir)
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

// buildSoundManifest turns a sounds directory into the served manifest:
// mappack lists the extracted files fresh (no stale manifest file), groups
// them per canonical name through the reverse table, and every URL points
// at this process's own /api/sounds route. File order comes from the fresh
// directory listing (os.ReadDir sorts by name), so the manifest is
// deterministic.
func buildSoundManifest(dir string) SoundManifest {
	files := mappack.SoundFiles(dir)
	sounds := make(map[string][]string, len(files))
	for name, variants := range files {
		urls := make([]string, 0, len(variants))
		for _, f := range variants {
			urls = append(urls, "/api/sounds/"+f)
		}
		sounds[name] = urls
	}
	return SoundManifest{
		Extracted: len(sounds) > 0,
		Count:     len(sounds),
		Sounds:    sounds,
	}
}
