package mappack

import "sort"

// supportedMaps is the supported set: the maps that have been in the
// competitive pool. Other install maps are not extracted.
var supportedMaps = map[string]bool{
	"de_ancient": true, "de_anubis": true, "de_cache": true, "de_dust2": true,
	"de_inferno": true, "de_mirage": true, "de_nuke": true, "de_overpass": true,
	"de_train": true, "de_vertigo": true,
}

// SupportedRenderMaps returns the maps whose render geometry is extracted, sorted.
func SupportedRenderMaps() []string {
	out := make([]string, 0, len(supportedMaps))
	for m := range supportedMaps {
		out = append(out, m)
	}
	sort.Strings(out)
	return out
}
