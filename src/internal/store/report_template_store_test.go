package store

import (
	"errors"
	"testing"
	"time"
)

// The report_templates round trip (the Reports Builder's storage): one
// row per authored template, id fixed at create, both timestamps honest,
// and the duplicate-id path reporting the friendly message the service's
// mint is there to prevent.
func TestReportTemplateRoundTrip(t *testing.T) {
	s := openMem(t)

	created, err := s.CreateReportTemplate(ReportTemplateRow{
		ID: "match-summary", Title: "Match summary", Scope: "match",
		Format: "md", Body: "{{.Match.Map}}", Origin: "user",
	})
	if err != nil {
		t.Fatalf("CreateReportTemplate: %v", err)
	}
	if created.ID != "match-summary" || created.Origin != "user" {
		t.Fatalf("created row = %+v, want id match-summary / origin user", created)
	}
	if created.CreatedAt.IsZero() || created.UpdatedAt.IsZero() {
		t.Fatalf("created row carries no timestamps: %+v", created)
	}

	rows, err := s.ListReportTemplates()
	if err != nil {
		t.Fatalf("ListReportTemplates: %v", err)
	}
	if len(rows) != 1 || rows[0].ID != "match-summary" || rows[0].Body != "{{.Match.Map}}" {
		t.Fatalf("list = %+v, want the one stored row", rows)
	}

	// A duplicate id is a defensive failure with the friendly message —
	// the service de-dupes before it gets here, so this can only fire if
	// a caller bypasses the mint.
	if _, err := s.CreateReportTemplate(ReportTemplateRow{
		ID: "match-summary", Title: "Other", Scope: "match", Format: "md", Body: "x",
	}); err == nil || err.Error() != `a report template named "Other" already exists` {
		t.Fatalf("duplicate id error = %v, want the friendly uniqueness error", err)
	}

	// Update rewrites the document in place: the id is FIXED (anything
	// already pointing at the template keeps resolving), created_at is
	// untouched and updated_at moves.
	time.Sleep(2 * time.Millisecond)
	updated, err := s.UpdateReportTemplate(ReportTemplateRow{
		ID: "match-summary", Title: "Match summary v2", Scope: "round",
		Format: "html", Body: "<p>{{.Match.Map}}</p>", Origin: "user",
	})
	if err != nil {
		t.Fatalf("UpdateReportTemplate: %v", err)
	}
	if updated.ID != "match-summary" || updated.Title != "Match summary v2" || updated.Format != "html" {
		t.Fatalf("updated row = %+v", updated)
	}
	if !updated.CreatedAt.Equal(created.CreatedAt) {
		t.Fatalf("created_at moved on update: %v → %v", created.CreatedAt, updated.CreatedAt)
	}
	if !updated.UpdatedAt.After(created.UpdatedAt) {
		t.Fatalf("updated_at did not move: %v → %v", created.UpdatedAt, updated.UpdatedAt)
	}

	if _, err := s.UpdateReportTemplate(ReportTemplateRow{ID: "ghost", Title: "x", Scope: "match", Format: "md", Body: "x"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("update of an unknown id = %v, want ErrNotFound", err)
	}

	if err := s.DeleteReportTemplate("match-summary"); err != nil {
		t.Fatalf("DeleteReportTemplate: %v", err)
	}
	rows, err = s.ListReportTemplates()
	if err != nil || len(rows) != 0 {
		t.Fatalf("list after delete = %+v, %v, want empty", rows, err)
	}
	if err := s.DeleteReportTemplate("match-summary"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second delete = %v, want ErrNotFound", err)
	}
}

// The schema floor: a scope or format outside the manifest's vocabulary
// is refused by the CHECK constraint, so a hand-written row can never
// hold a value the renderer's switch would reject.
func TestReportTemplateCheckConstraints(t *testing.T) {
	s := openMem(t)
	for _, bad := range []ReportTemplateRow{
		{ID: "a", Title: "a", Scope: "career", Format: "md", Body: "x"},
		{ID: "b", Title: "b", Scope: "match", Format: "pdf", Body: "x"},
	} {
		if _, err := s.CreateReportTemplate(bad); err == nil {
			t.Errorf("CreateReportTemplate(%+v) succeeded, want a CHECK rejection", bad)
		}
	}
	rows, err := s.ListReportTemplates()
	if err != nil || len(rows) != 0 {
		t.Fatalf("list = %+v, %v, want empty after rejected inserts", rows, err)
	}
}
