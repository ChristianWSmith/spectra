package store

import (
	"fmt"
	"time"
)

// This file is the Reports Builder's persistence surface: CRUD over the
// `report_templates` table created by the baseline schema (schema.sql —
// document-shaped like saved_queries, one row per authored template).
// The write handle owns all of it — the read-only console session never
// reaches these methods.
//
// The table holds ONE origin's rows (every insert writes origin 'user'),
// so there is no origin gate to re-check here (metrics' updateMetric gate
// exists because the metrics table holds all three origins) and no
// version/migration machinery (AGENTS "Version nothing until the first
// release"): this is THE current layout, applied by the one baseline.

// reportTemplateCols is the report_templates column list in scan order:
// every column except id (the PRIMARY KEY the readers address rows by),
// pinned to the DDL by TestColumnListConstsMatchSchema.
const reportTemplateCols = `title, scope, format, body, origin, created_at, updated_at`

// ReportTemplateRow is one stored user report template. The SERVICE maps
// it to its own ReportTemplate DTO (the frontend contract) — the store
// row carries no JSON tags because it never leaves the service layer.
type ReportTemplateRow struct {
	ID        string
	Title     string
	Scope     string
	Format    string
	Body      string
	Origin    string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// scanReportTemplate reads one report_templates row (both timestamps are
// NOT NULL, so they scan straight into time.Time).
func scanReportTemplate(row interface{ Scan(...any) error }) (ReportTemplateRow, error) {
	var r ReportTemplateRow
	if err := row.Scan(
		&r.ID, &r.Title, &r.Scope, &r.Format, &r.Body, &r.Origin,
		&r.CreatedAt, &r.UpdatedAt,
	); err != nil {
		return ReportTemplateRow{}, err
	}
	return r, nil
}

// ListReportTemplates returns every stored template, title ASC. The
// service composes this list BETWEEN the builtins and the enabled-plugin
// templates — the metrics origin rank (builtin → user → plugin,
// store.metricOrder) so every template list in the app shares one order.
func (s *Store) ListReportTemplates() ([]ReportTemplateRow, error) {
	rows, err := s.db.Query(
		`SELECT id, ` + reportTemplateCols + ` FROM report_templates ORDER BY title ASC, id ASC`,
	)
	if err != nil {
		return nil, fmt.Errorf("couldn't load the report templates: %w", err)
	}
	defer rows.Close()
	out := []ReportTemplateRow{}
	for rows.Next() {
		r, err := scanReportTemplate(rows)
		if err != nil {
			return nil, fmt.Errorf("couldn't load the report templates: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("couldn't load the report templates: %w", err)
	}
	return out, nil
}

// CreateReportTemplate inserts ONE new user template with the id the
// CALLER minted — SaveReportTemplate slugifies the title and de-dupes it
// against every id already in play (the service owns the id contract,
// the store owns persistence). A duplicate id is a defensive failure
// there, reported as the friendly uniqueness error rather than the
// driver's constraint text. origin is written explicitly as 'user' and
// both timestamps are taken from now.
func (s *Store) CreateReportTemplate(t ReportTemplateRow) (ReportTemplateRow, error) {
	now := time.Now()
	if t.Origin == "" {
		t.Origin = "user"
	}
	if _, err := s.db.Exec(
		`INSERT INTO report_templates (id, title, scope, format, body, origin, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		scrub(t.ID), scrub(t.Title), t.Scope, t.Format, scrub(t.Body), t.Origin, now, now,
	); err != nil {
		if isUniqueErr(err) {
			return ReportTemplateRow{}, fmt.Errorf("a report template named %q already exists", scrub(t.Title))
		}
		return ReportTemplateRow{}, fmt.Errorf("couldn't save the report template: %w", err)
	}
	// Read back rather than trusting the arguments: the stored row is the
	// contract the list and the renderer resolve against (and the INSERT
	// normalized the timestamps itself).
	var out ReportTemplateRow
	if err := s.db.QueryRow(
		`SELECT id, `+reportTemplateCols+` FROM report_templates WHERE id = ?`, scrub(t.ID),
	).Scan(&out.ID, &out.Title, &out.Scope, &out.Format, &out.Body, &out.Origin, &out.CreatedAt, &out.UpdatedAt); err != nil {
		return ReportTemplateRow{}, fmt.Errorf("couldn't save the report template: %w", err)
	}
	return out, nil
}

// UpdateReportTemplate rewrites one stored template in place. The id is
// FIXED: renaming a template never re-mints it, so anything already
// pointing at the document keeps resolving (store.UpdateQuery precedent —
// a typo fix must not change the row's identity). Unknown ids yield
// ErrNotFound; a title rename does not collide with anything (uniqueness
// lives on id).
func (s *Store) UpdateReportTemplate(t ReportTemplateRow) (ReportTemplateRow, error) {
	res, err := s.db.Exec(
		`UPDATE report_templates SET title = ?, scope = ?, format = ?, body = ?, updated_at = ?
			WHERE id = ?`,
		scrub(t.Title), t.Scope, t.Format, scrub(t.Body), time.Now(), scrub(t.ID),
	)
	if err != nil {
		return ReportTemplateRow{}, fmt.Errorf("couldn't update the report template: %w", err)
	}
	if err := affectedOrNotFound(res, "updating the report template"); err != nil {
		return ReportTemplateRow{}, err
	}
	var out ReportTemplateRow
	if err := s.db.QueryRow(
		`SELECT id, `+reportTemplateCols+` FROM report_templates WHERE id = ?`, scrub(t.ID),
	).Scan(&out.ID, &out.Title, &out.Scope, &out.Format, &out.Body, &out.Origin, &out.CreatedAt, &out.UpdatedAt); err != nil {
		return ReportTemplateRow{}, fmt.Errorf("couldn't update the report template: %w", err)
	}
	return out, nil
}

// DeleteReportTemplate removes one stored template (unknown id →
// ErrNotFound, the DeleteQuery precedent). Only user rows live here, so
// there is no builtin/plugin guard to mirror from DeleteMetric — the
// service never routes a builtin or plugin id through this path (they
// have no row to delete).
func (s *Store) DeleteReportTemplate(id string) error {
	res, err := s.db.Exec(`DELETE FROM report_templates WHERE id = ?`, scrub(id))
	if err != nil {
		return fmt.Errorf("couldn't delete the report template: %w", err)
	}
	return affectedOrNotFound(res, "deleting the report template")
}
