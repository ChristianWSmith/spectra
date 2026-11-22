package mappack

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/source2"
)

func TestProbeVents(t *testing.T) {
	if os.Getenv("SPECTRA_PROBE") == "" {
		t.Skip()
	}
	v, err := openVPK(filepath.Join(FindCS2(""), "maps", "de_anubis.vpk"))
	if err != nil {
		t.Fatal(err)
	}
	defer v.close()
	for _, n := range v.names("maps/de_anubis/entities/", ".vents_c") {
		fmt.Println("VENTS name", n)
		d, _, _ := v.read(n)
		bs, _ := source2.ParseResource(d)
		for _, b := range bs {
			fmt.Println("VENTS block", b.Type, len(b.Data))
			kv, err := source2.Decode(b.Data)
			if err != nil {
				fmt.Println("VENTS decode", err)
				continue
			}
			root, _ := kv.Root.(map[string]any)
			if b.Type == "DATA" {
				ents, _ := root["m_entityKeyValues"].([]any)
				withModel, shown := 0, 0
				for _, e := range ents {
					em, _ := e.(map[string]any)
					kvd, _ := em["keyValues3Data"].(map[string]any)
					vals, _ := kvd["values"].(map[string]any)
					model := ""
					for k, vv := range vals {
						if s, ok := vv.(string); ok && strings.HasSuffix(s, ".vmdl") && strings.Contains(s, "/entities/") {
							model = s
							_ = k
						}
					}
					if model != "" {
						withModel++
						if shown < 1 {
							shown++
							fmt.Printf("VENTS example model %s\n", model)
							for k, vv := range vals {
								fmt.Printf("VENTS   val %s = %v\n", k, vv)
							}
						}
					}
				}
				fmt.Printf("VENTS entities %d, with entity model %d\n", len(ents), withModel)
			}
		}
	}
}
