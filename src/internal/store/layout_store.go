package store

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Storage for user components and layout placements (`components` and
// `layout_placements` in the baseline schema.sql). Builtin components are
// code, never rows. This file holds the column lists, the placement read the
// missing-component contract needs, and the placement writers (replace one
// surface's rows, reset one surface).

// componentCols is the components column list in scan order (every column
// except id), pinned to the DDL by TestColumnListConstsMatchSchema.
const componentCols = `name, source, origin, plugin_id, created_at, updated_at`

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

// PlacementRow is one layout_placements row as written: the position is
// its index in the slice SetPlacements is given, so a surface's rows are
// always dense and ordered. Props is JSON text (an object); empty means
// "{}".
type PlacementRow struct {
	Component string
	Props     string
	Hidden    bool
}

// SetPlacements replaces one surface's rows with rows, in one transaction:
// the surface's old rows are deleted and the new ones inserted, and no
// other surface is touched. It refuses an empty surface, an empty rows
// slice (absence means the builtin, so an empty layout is written as a
// reset, never as zero rows), a row with no component, and props that are
// not a JSON object. A component that names nothing known is stored as
// given: a dangling reference is reported at read time, never refused.
func (s *Store) SetPlacements(surface string, rows []PlacementRow) error {
	surface = scrub(surface)
	if surface == "" {
		return fmt.Errorf("a placement needs a surface")
	}
	if len(rows) == 0 {
		return fmt.Errorf("a surface with no placements is reset, not written empty")
	}
	for i, r := range rows {
		if strings.TrimSpace(r.Component) == "" {
			return fmt.Errorf("placement %d needs a component", i)
		}
		if err := checkPlacementProps(r.Props); err != nil {
			return fmt.Errorf("placement %d: %w", i, err)
		}
	}
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("couldn't save the layout: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`DELETE FROM layout_placements WHERE surface = ?`, surface); err != nil {
		return fmt.Errorf("couldn't save the layout: %w", err)
	}
	for i, r := range rows {
		props := r.Props
		if strings.TrimSpace(props) == "" {
			props = "{}"
		}
		if _, err := tx.Exec(
			`INSERT INTO layout_placements (`+layoutPlacementCols+`) VALUES (?, ?, ?, ?, ?)`,
			surface, i, r.Component, props, b2i(r.Hidden),
		); err != nil {
			return fmt.Errorf("couldn't save the layout: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("couldn't save the layout: %w", err)
	}
	return nil
}

// ResetPlacements deletes every placement on one surface, so the surface
// renders its builtin again. Resetting a surface with no rows is not an
// error; other surfaces are untouched.
func (s *Store) ResetPlacements(surface string) error {
	surface = scrub(surface)
	if surface == "" {
		return fmt.Errorf("a placement needs a surface")
	}
	if _, err := s.db.Exec(`DELETE FROM layout_placements WHERE surface = ?`, surface); err != nil {
		return fmt.Errorf("couldn't reset the layout: %w", err)
	}
	return nil
}

// checkPlacementProps accepts an empty string (stored as "{}") or a JSON
// object.
func checkPlacementProps(props string) error {
	if strings.TrimSpace(props) == "" {
		return nil
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal([]byte(props), &obj); err != nil || obj == nil {
		return fmt.Errorf("props must be a JSON object")
	}
	return nil
}
