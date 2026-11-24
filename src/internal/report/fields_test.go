package report

import "testing"

func findField(fs []TemplateField, name string) (TemplateField, bool) {
	for _, f := range fs {
		if f.Name == name {
			return f, true
		}
	}
	return TemplateField{}, false
}

// The match scope's top-level fields are the names templates write (.Scoreboard,
// .CTName, .Metrics), and a slice of rows exposes the row's fields one level down.
func TestTemplateFieldsMatchScope(t *testing.T) {
	fs := TemplateFields("match")
	for _, name := range []string{"Match", "CTName", "Scoreboard", "Rounds", "Metrics", "GeneratedAt"} {
		if _, ok := findField(fs, name); !ok {
			t.Errorf("match scope has no field %s", name)
		}
	}
	sb, _ := findField(fs, "Scoreboard")
	if len(sb.Fields) == 0 {
		t.Fatalf("Scoreboard lists no row fields")
	}
	if _, ok := findField(sb.Fields, "Name"); !ok {
		t.Errorf("Scoreboard rows have no Name field: %v", sb.Fields)
	}
}

// Each scope names its own root, and an unknown scope lists nothing.
func TestTemplateFieldsScopes(t *testing.T) {
	if _, ok := findField(TemplateFields("player"), "Player"); !ok {
		t.Errorf("player scope has no Player field")
	}
	if _, ok := findField(TemplateFields("round"), "Detail"); !ok {
		t.Errorf("round scope has no Detail field")
	}
	if got := TemplateFields("nope"); got != nil {
		t.Errorf("unknown scope lists %d fields, want none", len(got))
	}
}
