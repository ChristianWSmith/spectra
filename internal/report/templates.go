package report

import (
	"embed"
	"fmt"
	"sort"
)

//go:embed templates/*
var templatesFS embed.FS

// builtinMeta maps template id → (title, scope, format) for the embedded
// template files. The body is read once at init (embed is compile-time
// truth — a missing file is a build bug, surfaced as a panic).
var builtinMeta = map[string]struct {
	title, scope, format string
}{
	"match.md":   {"Match report", "match", "md"},
	"match.html": {"Match report (HTML)", "match", "html"},
	"player.md":  {"Player report", "player", "md"},
	"round.md":   {"Round report", "round", "md"},
}

var builtins []Template

func init() {
	for id, meta := range builtinMeta {
		body, err := templatesFS.ReadFile("templates/" + id)
		if err != nil {
			panic(fmt.Sprintf("report: embedded template %s: %v", id, err))
		}
		builtins = append(builtins, Template{
			ID: id, Title: meta.title, Scope: meta.scope,
			Format: meta.format, Origin: "builtin", Body: string(body),
		})
	}
}

// Builtins returns the embedded builtin templates (stable order by id).
func Builtins() []Template {
	out := make([]Template, len(builtins))
	copy(out, builtins)
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}
