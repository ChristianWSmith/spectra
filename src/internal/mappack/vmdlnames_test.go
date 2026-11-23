package mappack

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/source2"
)

// TestListVmdlNames prints the .vmdl children of a map's manifest. Opt-in: SPECTRA_VMDL_NAMES=1.
func TestListVmdlNames(t *testing.T) {
	if os.Getenv("SPECTRA_VMDL_NAMES") == "" {
		t.Skip("set SPECTRA_VMDL_NAMES=1")
	}
	mp := envOr("SPECTRA_MAP", "de_anubis")
	home, _ := os.UserHomeDir()
	v, err := openVPK(filepath.Join(home, ".steam/steam/steamapps/common/Counter-Strike Global Offensive/game/csgo/maps/"+mp+".vpk"))
	if err != nil {
		t.Fatal(err)
	}
	defer v.close()
	mapData, _, _ := v.read("maps/" + mp + ".vmap_c")
	blocks, _ := source2.ParseResource(mapData)
	red2, _ := source2.FindBlock(blocks, "RED2")
	man, _ := source2.Decode(red2)
	root, _ := man.Root.(map[string]any)
	children, _ := root["m_ChildResourceList"].([]any)
	for _, c := range children {
		name, _ := c.(string)
		if strings.HasSuffix(name, ".vmdl") {
			fmt.Println("VMDL", name)
		}
	}
}
