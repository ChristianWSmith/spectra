package store

import "fmt"

// Storage for user components and layout placements (`components` and
// `layout_placements` in the baseline schema.sql). Builtin components are
// code, never rows. This file holds only the column lists and the one read
// the missing-component contract needs; the components API owns the writers.

// componentCols is the components column list in scan order (every column
// except id), pinned to the DDL by TestColumnListConstsMatchSchema.
const componentCols = `name, source, created_at, updated_at`

// layoutPlacementCols is the layout_placements column list in scan order,
// pinned to the DDL by TestColumnListConstsMatchSchema.
const layoutPlacementCols = `surface, position, component, props, hidden`

// Placement is one layout_placements row plus whether its component
// resolved. MissingComponent is true when the referenced component is
// neither a builtin id nor a stored components.name; the caller renders an
// error frame in that slot and the rest of the surface keeps rendering.
type Placement struct {
	Surface          string
	Position         int
	Component        string
	Props            string
	Hidden           bool
	MissingComponent bool
}

// ListPlacements returns a surface's placements in position order. A
// placement whose component is not a builtin (per isBuiltin, which may be
// nil) and has no components row is returned with MissingComponent set: a
// dangling reference is data to report, never an error.
func (s *Store) ListPlacements(surface string, isBuiltin func(string) bool) ([]Placement, error) {
	rows, err := s.db.Query(
		`SELECT `+layoutPlacementCols+`, EXISTS(SELECT 1 FROM components c WHERE c.name = p.component)
		 FROM layout_placements p WHERE surface = ? ORDER BY position ASC`, surface,
	)
	if err != nil {
		return nil, fmt.Errorf("list placements: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []Placement
	for rows.Next() {
		var p Placement
		var hidden, stored int
		if err := rows.Scan(&p.Surface, &p.Position, &p.Component, &p.Props, &hidden, &stored); err != nil {
			return nil, err
		}
		p.Hidden = hidden != 0
		p.MissingComponent = stored == 0 && (isBuiltin == nil || !isBuiltin(p.Component))
		out = append(out, p)
	}
	return out, rows.Err()
}
