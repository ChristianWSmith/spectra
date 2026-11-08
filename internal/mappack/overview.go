package mappack

import (
	"fmt"
	"sort"
	"strconv"
)

// Overview is the parsed content of resource/overviews/<map>.txt — the
// Valve overview config that carries the world→radar transform (pos_x,
// pos_y, scale) plus loading-screen icon fractions. Present for every
// official CS2 map (CS2.md "Radar/overview assets"). Values are strings
// in KeyValues; we convert the numeric ones.
type Overview struct {
	PosX  float64
	PosY  float64
	Scale float64
	// Icon fractions (0..1 of the radar image) from the loading-screen
	// keys; zero when absent.
	BombA     [2]float64
	BombB     [2]float64
	CTSpawn   [2]float64
	TSpawn    [2]float64
	HasSites  bool // whether bombA/bombB were present
	HasSpawns bool // whether CT/T spawn fractions were present
	// Sections: the optional verticalsections block — one entry per
	// radar floor (default / lower / …) with its world-Z band. Empty
	// for single-floor maps. The section names map to radar textures:
	// default → <map>_radar, <section> → <map>_<section>_radar
	// (CS2.md "verticalsections"). Order preserved as parsed; the
	// frontend keys off these bands to assign entities to layers.
	Sections []Section
}

// Section is one verticalsections entry: a named radar floor with the
// world-Z altitude band that selects it in game.
type Section struct {
	Name string
	ZMin float64
	ZMax float64
}

// parseOverview parses an overview txt. Missing transform values are an
// error (a pack without a transform is useless for positioning).
func parseOverview(data []byte) (*Overview, error) {
	kv, err := parseKV(data)
	if err != nil {
		return nil, fmt.Errorf("overview: %w", err)
	}
	// The file wraps everything under a root key named after the map.
	var obj map[string]kvValue
	for _, v := range kv {
		if o, ok := v.(map[string]kvValue); ok {
			obj = o
			break
		}
	}
	if obj == nil {
		return nil, fmt.Errorf("overview: no root object")
	}
	o := &Overview{}
	if o.PosX, err = kvFloat(obj, "pos_x"); err != nil {
		return nil, fmt.Errorf("overview: %w", err)
	}
	if o.PosY, err = kvFloat(obj, "pos_y"); err != nil {
		return nil, fmt.Errorf("overview: %w", err)
	}
	if o.Scale, err = kvFloat(obj, "scale"); err != nil {
		return nil, fmt.Errorf("overview: %w", err)
	}
	if o.Scale <= 0 {
		return nil, fmt.Errorf("overview: non-positive scale %v", o.Scale)
	}

	o.BombA, o.HasSites = kvPair(obj, "bombA_x", "bombA_y")
	bombB, bOK := kvPair(obj, "bombB_x", "bombB_y")
	o.BombB = bombB
	o.HasSites = o.HasSites && bOK

	ct, ctOK := kvPair(obj, "CTSpawn_x", "CTSpawn_y")
	t, tOK := kvPair(obj, "TSpawn_x", "TSpawn_y")
	o.CTSpawn, o.TSpawn = ct, t
	o.HasSpawns = ctOK && tOK

	// verticalsections is optional (single-floor maps omit it); a
	// malformed block degrades to no sections rather than failing the
	// whole overview (the transform above is what must stay valid).
	if vs, ok := obj["verticalsections"].(map[string]kvValue); ok {
		for name, v := range vs {
			sec, ok := v.(map[string]kvValue)
			if !ok {
				continue
			}
			zMax, err1 := kvFloat(sec, "AltitudeMax")
			zMin, err2 := kvFloat(sec, "AltitudeMin")
			if err1 != nil || err2 != nil {
				continue
			}
			o.Sections = append(o.Sections, Section{Name: name, ZMin: zMin, ZMax: zMax})
		}
		// Stable order: default first, then alphabetical — map iteration
		// order is random and the frontend's layer layout must be
		// deterministic (tests pin it).
		sortSections(o.Sections)
	}
	return o, nil
}

// sortSections orders sections for the pack: the "default" section
// (the upper/main radar) first, everything else alphabetically.
func sortSections(s []Section) {
	sort.SliceStable(s, func(i, j int) bool {
		if s[i].Name == "default" {
			return true
		}
		if s[j].Name == "default" {
			return false
		}
		return s[i].Name < s[j].Name
	})
}

// kvFloat parses a numeric leaf.
func kvFloat(obj map[string]kvValue, key string) (float64, error) {
	s, ok := kvString(obj, key)
	if !ok {
		return 0, fmt.Errorf("missing %q", key)
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, fmt.Errorf("bad %q=%q", key, s)
	}
	return f, nil
}

// kvPair parses two numeric leaves as an [x, y] pair; ok=false when
// either is missing or bad (icon fractions are optional).
func kvPair(obj map[string]kvValue, xKey, yKey string) ([2]float64, bool) {
	xs, ok := kvString(obj, xKey)
	if !ok {
		return [2]float64{}, false
	}
	ys, ok := kvString(obj, yKey)
	if !ok {
		return [2]float64{}, false
	}
	x, err := strconv.ParseFloat(xs, 64)
	if err != nil {
		return [2]float64{}, false
	}
	y, err := strconv.ParseFloat(ys, 64)
	if err != nil {
		return [2]float64{}, false
	}
	return [2]float64{x, y}, true
}
