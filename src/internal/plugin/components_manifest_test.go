package plugin

import (
	"fmt"
	"strings"
	"testing"
)

// TestValidateManifestComponents: a component needs a name and a source, names are unique and at
// most 60 characters.
func TestValidateManifestComponents(t *testing.T) {
	const tmpl = `{"id":"cm-plugin","name":"CM","version":"1.0.0","components":%s}`
	man, err := ValidateManifest([]byte(fmt.Sprintf(tmpl, `[{"name":"cm_widget","source":"<p/>"}]`)))
	if err != nil {
		t.Fatalf("valid components refused: %v", err)
	}
	if len(man.Components) != 1 || man.Components[0].Name != "cm_widget" {
		t.Fatalf("components = %+v, want one named cm_widget", man.Components)
	}

	bad := map[string]string{
		"no name":      `[{"name":"","source":"<p/>"}]`,
		"empty source": `[{"name":"w","source":"   "}]`,
		"duplicate":    `[{"name":"w","source":"a"},{"name":"w","source":"b"}]`,
		"too long":     `[{"name":"` + strings.Repeat("a", 61) + `","source":"<p/>"}]`,
	}
	for label, comps := range bad {
		if _, err := ValidateManifest([]byte(fmt.Sprintf(tmpl, comps))); err == nil {
			t.Errorf("%s: manifest accepted", label)
		}
	}
}
