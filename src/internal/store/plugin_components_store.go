package store

import (
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// PluginComponentDef is one component a plugin supplies: its name and its Svelte source. The source is
// compiled in the frontend (the component builder's save gate), not here, so a broken one is shown where
// it is used rather than refused at install.
type PluginComponentDef struct {
	Name   string
	Source string
}

// CheckPluginComponentNames refuses an install whose component names clash with a built-in component,
// with one of yours, or with a component another plugin supplies. A name the same plugin already holds is
// its own (a reinstall replaces it). Nothing is written.
func (s *Store) CheckPluginComponentNames(pluginID string, defs []PluginComponentDef) error {
	for _, d := range defs {
		var origin, owner string
		err := s.db.QueryRow(`SELECT origin, plugin_id FROM components WHERE name = ?`, scrub(d.Name)).Scan(&origin, &owner)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return fmt.Errorf("couldn't check the plugin's components: %w", err)
		}
		switch {
		case origin == "builtin":
			return fmt.Errorf("the plugin's component %q clashes with a built-in component", d.Name)
		case origin == "user":
			return fmt.Errorf("the plugin's component %q clashes with one of your components; rename yours first", d.Name)
		case owner != pluginID:
			return fmt.Errorf("the plugin's component %q is already supplied by the plugin %q", d.Name, owner)
		}
	}
	return nil
}

// ReplacePluginComponents writes one plugin's component rows, replacing whatever the plugin held before.
// Run it after CheckPluginComponentNames.
func (s *Store) ReplacePluginComponents(pluginID string, defs []PluginComponentDef) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("couldn't save the plugin's components: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := deletePluginComponentRows(tx, pluginID); err != nil {
		return err
	}
	now := time.Now()
	for _, d := range defs {
		if _, err := tx.Exec(
			`INSERT INTO components (name, source, origin, plugin_id, created_at, updated_at) VALUES (?, ?, 'plugin', ?, ?, ?)`,
			scrub(d.Name), scrub(d.Source), scrub(pluginID), now, now,
		); err != nil {
			if isUniqueErr(err) {
				return fmt.Errorf("a component named %q already exists", d.Name)
			}
			return fmt.Errorf("couldn't save the plugin's components: %w", err)
		}
	}
	return tx.Commit()
}

// DeletePluginComponents removes every component a plugin supplied (its disable and its remove).
func (s *Store) DeletePluginComponents(pluginID string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("couldn't remove the plugin's components: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := deletePluginComponentRows(tx, pluginID); err != nil {
		return err
	}
	return tx.Commit()
}

// deletePluginComponentRows clears one plugin's component rows and the references they were recorded with.
func deletePluginComponentRows(tx *sql.Tx, pluginID string) error {
	if _, err := tx.Exec(
		`DELETE FROM component_refs WHERE referrer IN (SELECT name FROM components WHERE origin = 'plugin' AND plugin_id = ?)`,
		scrub(pluginID),
	); err != nil {
		return fmt.Errorf("couldn't clear the plugin's components: %w", err)
	}
	if _, err := tx.Exec(`DELETE FROM components WHERE origin = 'plugin' AND plugin_id = ?`, scrub(pluginID)); err != nil {
		return fmt.Errorf("couldn't clear the plugin's components: %w", err)
	}
	return nil
}

// PluginComponentRefRow is one plugin component's references.
type PluginComponentRefRow struct {
	Name string
	Refs ComponentRefs
}

// SetPluginComponentRefs records the references of a plugin's components. Every name must be a component
// that plugin supplies; any other name refuses the whole write.
func (s *Store) SetPluginComponentRefs(pluginID string, rows []PluginComponentRefRow) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("couldn't save the plugin's references: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	for _, r := range rows {
		var origin, owner string
		err := tx.QueryRow(`SELECT origin, plugin_id FROM components WHERE name = ?`, scrub(r.Name)).Scan(&origin, &owner)
		if errors.Is(err, sql.ErrNoRows) || (err == nil && (origin != "plugin" || owner != pluginID)) {
			return fmt.Errorf("%q is not a component of the plugin %q", r.Name, pluginID)
		}
		if err != nil {
			return fmt.Errorf("couldn't save the plugin's references: %w", err)
		}
		if err := replaceComponentRefs(tx, r.Name, r.Name, r.Refs); err != nil {
			return err
		}
	}
	return tx.Commit()
}
