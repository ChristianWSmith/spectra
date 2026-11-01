package mappack

import (
	"fmt"
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
	return o, nil
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
