package mappack

import (
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"strings"
)

// Extraction: from a CS2 install dir, enumerate radar textures in
// pak01_dir.vpk, decode each to PNG, pair with its overview txt, and
// write a map pack (meta.json + radar.png) per map into the output
// directory — the same on-disk contract as frontend/public/maps/, so the
// frontend needs no per-source logic beyond lookup order.

const (
	radarPrefix  = "panorama/images/overheadmaps/"
	radarSuffix  = "_radar_psd.vtex_c"
	overviewPfx  = "resource/overviews/"
	packRadarPNG = "radar.png"
	packMetaJSON = "meta.json"
)

// ExtractResult reports one extracted map pack.
type ExtractResult struct {
	Map  string `json:"map"`
	File string `json:"file"` // radar.png path
}

// packMeta is the meta.json written next to radar.png — schema_version 1,
// matching frontend/public/maps/README.md.
type packMeta struct {
	SchemaVersion int         `json:"schema_version"`
	Radar         *packRadar  `json:"radar,omitempty"`
	Transform     *packXform  `json:"transform,omitempty"`
	Sites         packMarkers `json:"sites"`
	Spawns        packMarkers `json:"spawns"`
	Source        packSource  `json:"source"`
}

type packRadar struct {
	File   string `json:"file"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}

type packXform struct {
	PosX  float64 `json:"pos_x"`
	PosY  float64 `json:"pos_y"`
	Scale float64 `json:"scale"`
}

// packMarkers holds optional fractional (0..1) radar-space anchors.
type packMarkers struct {
	A  *fracPoint `json:"a,omitempty"`
	B  *fracPoint `json:"b,omitempty"`
	CT *fracPoint `json:"ct,omitempty"`
	T  *fracPoint `json:"t,omitempty"`
}

type fracPoint struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type packSource struct {
	Note string `json:"note"`
}

// ExtractMapPacks extracts every official-map radar from the CS2 install
// at cs2Dir into outDir (created if needed), one subdirectory per map.
// Existing packs are overwritten (idempotent re-extract after game
// updates). Individual map failures are reported in errs but don't abort
// the rest; a failure to even open the VPK is fatal.
func ExtractMapPacks(cs2Dir, outDir string) (maps []ExtractResult, errs []string, err error) {
	pak := resolvePak(cs2Dir)
	if pak == "" {
		return nil, nil, fmt.Errorf("no pak01_dir.vpk under %s", cs2Dir)
	}
	v, err := openVPK(pak)
	if err != nil {
		return nil, nil, err
	}
	defer v.close()

	for _, radarPath := range v.names(radarPrefix, radarSuffix) {
		mapName := mapNameFromRadar(radarPath)
		if mapName == "" {
			continue
		}
		if err := extractOne(v, mapName, radarPath, outDir); err != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", mapName, err))
			continue
		}
		maps = append(maps, ExtractResult{
			Map:  mapName,
			File: filepath.Join(outDir, mapName, packRadarPNG),
		})
	}
	if len(maps) == 0 && len(errs) > 0 {
		return nil, errs, fmt.Errorf("no map packs extracted (%d errors)", len(errs))
	}
	return maps, errs, nil
}

// mapNameFromRadar derives the map name from a radar path:
// panorama/images/overheadmaps/de_mirage_radar_psd.vtex_c → de_mirage.
func mapNameFromRadar(path string) string {
	base := strings.TrimPrefix(path, radarPrefix)
	name := strings.TrimSuffix(base, radarSuffix)
	// Skip lower-level radars (de_nuke_lower…) — one pack per map for now.
	if strings.HasSuffix(name, "_lower") {
		return ""
	}
	if name == "" || strings.ContainsAny(name, "/\\") {
		return ""
	}
	return name
}

// extractOne decodes one map's radar + overview into outDir/<map>/.
func extractOne(v *vpk, mapName, radarPath, outDir string) error {
	raw, found, err := v.read(radarPath)
	if err != nil {
		return err
	}
	if !found {
		return fmt.Errorf("radar vanished from tree")
	}
	img, err := decodeVTex(raw)
	if err != nil {
		return err
	}

	meta := packMeta{
		SchemaVersion: 1,
		Radar: &packRadar{
			File:   packRadarPNG,
			Width:  img.Bounds().Dx(),
			Height: img.Bounds().Dy(),
		},
		Source: packSource{
			Note: "extracted from local CS2 install (pak01_dir.vpk)",
		},
	}

	// Overview txt supplies the transform + icon anchors; optional (some
	// community/workshop maps lack one) — without it the pack still ships
	// radar pixels, and the frontend falls back to a world grid.
	if data, found, err := v.read(overviewPfx + mapName + ".txt"); err != nil {
		return fmt.Errorf("overview: %w", err)
	} else if found {
		if ov, err := parseOverview(data); err == nil {
			meta.Transform = &packXform{PosX: ov.PosX, PosY: ov.PosY, Scale: ov.Scale}
			if ov.HasSites {
				meta.Sites.A = &fracPoint{X: ov.BombA[0], Y: ov.BombA[1]}
				meta.Sites.B = &fracPoint{X: ov.BombB[0], Y: ov.BombB[1]}
			}
			if ov.HasSpawns {
				meta.Spawns.CT = &fracPoint{X: ov.CTSpawn[0], Y: ov.CTSpawn[1]}
				meta.Spawns.T = &fracPoint{X: ov.TSpawn[0], Y: ov.TSpawn[1]}
			}
		}
		// A malformed overview degrades to radar-only; the transform is
		// optional in the contract.
	}

	dir := filepath.Join(outDir, mapName)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if err := writePNGAtomic(filepath.Join(dir, packRadarPNG), img); err != nil {
		return err
	}
	metaJSON, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, packMetaJSON), append(metaJSON, '\n'), 0o644)
}

// writePNGAtomic writes via a temp file + rename so a crash mid-write
// can't leave a truncated PNG that the frontend would happily decode.
func writePNGAtomic(path string, img *image.NRGBA) error {
	tmp := path + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if err := png.Encode(f, img); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}
