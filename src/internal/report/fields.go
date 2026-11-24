package report

import (
	"reflect"
	"time"
)

// TemplateField is one field a report template can reference: the name as the
// template writes it, its Go type, and the fields of a struct (or slice of
// structs) it holds, down to templateFieldDepth levels.
type TemplateField struct {
	Name   string          `json:"name"`
	Type   string          `json:"type"`
	Fields []TemplateField `json:"fields,omitempty"`
}

// templateFieldDepth bounds how far TemplateFields descends into nested structs.
const templateFieldDepth = 2

// TemplateFields lists the fields of the data a template of this scope is
// rendered against (match, player or round). An unknown scope lists none.
func TemplateFields(scope string) []TemplateField {
	var data any
	switch scope {
	case "match":
		data = MatchReport{}
	case "player":
		data = PlayerReport{}
	case "round":
		data = RoundReport{}
	default:
		return nil
	}
	return structTemplateFields(reflect.TypeOf(data), 0)
}

func structTemplateFields(t reflect.Type, depth int) []TemplateField {
	out := []TemplateField{}
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		if !f.IsExported() {
			continue
		}
		field := TemplateField{Name: f.Name, Type: f.Type.String()}
		if depth < templateFieldDepth {
			inner := f.Type
			if inner.Kind() == reflect.Slice {
				inner = inner.Elem()
			}
			if inner.Kind() == reflect.Struct && inner != reflect.TypeOf(time.Time{}) {
				field.Fields = structTemplateFields(inner, depth+1)
			}
		}
		out = append(out, field)
	}
	return out
}
