package main

import (
	"errors"
	"fmt"
	"strings"

	"github.com/ChristianWSmith/spectra/internal/store"
)

// ComponentService is the Component Builder's frontend-callable surface
// (dogfood/04-COMPONENTS.md §6): list, save and delete USER components.
// Builtin components are frontend source and never pass through here.
//
// The save-time syntax check: Go has no Svelte compiler, so the compile
// check runs in the webview (componentruntime/compile.js
// checkComponentSource). The frontend save wrapper (services.js
// saveComponent) is the only caller of SaveComponent and runs that check
// first, refusing a broken source with its line before this method is
// reached. This service refuses what Go can decide: an empty name or
// source, a name in the builtin namespace, a duplicate name, and a delete
// or rename while a placement references the component.
type ComponentService struct {
	st *store.Store
}

// BuiltinComponentPrefix is the reserved namespace of builtin component
// ids (frontend lib/componentbuiltins.js pins every builtin id to it). A
// user component name may not start with it, so a placement's component
// reference is a builtin id or a user name, never ambiguous.
const BuiltinComponentPrefix = "builtin-"

// maxComponentName bounds a component's name (it is a label in lists).
const maxComponentName = 60

// Component is one stored user component (the frontend contract).
type Component struct {
	Name   string `json:"name"`
	Source string `json:"source"`
}

// ListComponents returns every user component, name order.
func (s *ComponentService) ListComponents() ([]Component, error) {
	rows, err := s.st.ListComponents()
	if err != nil {
		return nil, err
	}
	out := make([]Component, 0, len(rows))
	for _, r := range rows {
		out = append(out, Component{Name: r.Name, Source: r.Source})
	}
	return out, nil
}

// validComponentName trims and checks a component name.
func validComponentName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", fmt.Errorf("a component needs a name")
	}
	if len([]rune(name)) > maxComponentName {
		return "", fmt.Errorf("a component name can be at most %d characters", maxComponentName)
	}
	if strings.HasPrefix(strings.ToLower(name), BuiltinComponentPrefix) {
		return "", fmt.Errorf("names starting with %q are reserved for built-in components", BuiltinComponentPrefix)
	}
	return name, nil
}

// SaveComponent writes one user component: an empty `original` creates
// `name`, otherwise the component named `original` is replaced (a rename
// when `name` differs). The source must have passed the frontend compile
// check (see the type comment); this method refuses empty source.
func (s *ComponentService) SaveComponent(original, name, source string) (Component, error) {
	name, err := validComponentName(name)
	if err != nil {
		return Component{}, err
	}
	if strings.TrimSpace(source) == "" {
		return Component{}, fmt.Errorf("a component needs source")
	}
	row, err := s.st.SaveComponent(strings.TrimSpace(original), name, source)
	if err != nil {
		var inUse *store.ComponentInUseError
		if errors.As(err, &inUse) {
			return Component{}, fmt.Errorf("can't rename %q while it is placed on %s", inUse.Name, placementList(inUse.Placements))
		}
		if errors.Is(err, store.ErrNotFound) {
			return Component{}, fmt.Errorf("no component named %q", strings.TrimSpace(original))
		}
		return Component{}, err
	}
	return Component{Name: row.Name, Source: row.Source}, nil
}

// DeleteComponent removes one user component. Refused while a placement
// references it, naming every placement.
func (s *ComponentService) DeleteComponent(name string) error {
	name = strings.TrimSpace(name)
	err := s.st.DeleteComponent(name)
	if err == nil {
		return nil
	}
	var inUse *store.ComponentInUseError
	if errors.As(err, &inUse) {
		return fmt.Errorf("can't delete %q while it is placed on %s", inUse.Name, placementList(inUse.Placements))
	}
	if errors.Is(err, store.ErrNotFound) {
		return fmt.Errorf("no component named %q", name)
	}
	return err
}

// surfaceLabel names a placement surface in the user's words. The
// surfaces are the ones dogfood/04 §2 lists; an unknown surface is shown
// as stored rather than guessed.
func surfaceLabel(surface string) string {
	switch {
	case surface == "match-view":
		return "the Match view"
	case surface == "profile-view" || strings.HasPrefix(surface, "profile-view:"):
		return "a Profile view"
	case surface == "reports-appendix":
		return "the Reports appendix"
	}
	return surface
}

// placementList names every placement once per surface, in order.
func placementList(ps []store.Placement) string {
	seen := map[string]bool{}
	var names []string
	for _, p := range ps {
		l := surfaceLabel(p.Surface)
		if !seen[l] {
			seen[l] = true
			names = append(names, l)
		}
	}
	return strings.Join(names, ", ")
}

// Placement is one layout_placements row (the frontend contract). Its
// position is its index in the list a surface is read or written as.
// Component is a builtin id or a user component name; the frontend decides
// which builtins exist, so ListPlacements does not flag a missing one.
type Placement struct {
	Component string `json:"component"`
	Props     string `json:"props"`
	Hidden    bool   `json:"hidden"`
}

// ListPlacements returns one surface's rows in position order. An empty
// list means the surface renders its builtin (absence means the builtin).
func (s *ComponentService) ListPlacements(surface string) ([]Placement, error) {
	rows, err := s.st.ListPlacements(strings.TrimSpace(surface), nil)
	if err != nil {
		return nil, err
	}
	out := make([]Placement, 0, len(rows))
	for _, r := range rows {
		out = append(out, Placement{Component: r.Component, Props: r.Props, Hidden: r.Hidden})
	}
	return out, nil
}

// SetPlacements replaces one surface's layout with rows, in order. The
// store refuses an empty list (use ResetPlacements), a row with no
// component, and props that are not a JSON object.
func (s *ComponentService) SetPlacements(surface string, rows []Placement) error {
	in := make([]store.PlacementRow, 0, len(rows))
	for _, r := range rows {
		in = append(in, store.PlacementRow{Component: strings.TrimSpace(r.Component), Props: r.Props, Hidden: r.Hidden})
	}
	return s.st.SetPlacements(strings.TrimSpace(surface), in)
}

// ResetPlacements deletes one surface's layout, restoring its builtin.
func (s *ComponentService) ResetPlacements(surface string) error {
	return s.st.ResetPlacements(strings.TrimSpace(surface))
}
