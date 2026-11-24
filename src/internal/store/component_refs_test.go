package store

import (
	"errors"
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// Builtin component names are seeded rows: a user component can never take one, and a builtin
// is never renamed or deleted through the component store.
func TestBuiltinComponentNamesAreSeededAndPermanent(t *testing.T) {
	s := openMem(t)
	ok, err := s.IsBuiltinComponent("match-overview")
	if err != nil || !ok {
		t.Fatalf("match-overview not a seeded builtin: %v %v", ok, err)
	}
	if _, err := s.SaveComponent("", "match-overview", "<p>mine</p>", ComponentRefs{}); err == nil || !strings.Contains(err.Error(), "built-in component") {
		t.Fatalf("creating over a builtin name: err = %v, want the uniqueness refusal", err)
	}
	if _, err := s.SaveComponent("match-overview", "renamed", "<p>x</p>", ComponentRefs{}); err == nil {
		t.Fatal("renaming a builtin row succeeded")
	}
	if err := s.DeleteComponent("match-overview"); err == nil {
		t.Fatal("deleting a builtin row succeeded")
	}
	list, err := s.ListComponents()
	if err != nil {
		t.Fatalf("ListComponents: %v", err)
	}
	for _, c := range list {
		if c.Name == "match-overview" {
			t.Fatal("the builtin row leaked into the user component list")
		}
	}
}

// A component another component mounts by name cannot be renamed or deleted out from under it.
func TestComponentReferencedByAnotherCannotBeRenamedOrDeleted(t *testing.T) {
	s := openMem(t)
	if _, err := s.SaveComponent("", "leaf", "<p>leaf</p>", ComponentRefs{}); err != nil {
		t.Fatalf("create leaf: %v", err)
	}
	if _, err := s.SaveComponent("", "parent", `<script>let { spectra } = $props();</script><spectra.Child name="leaf" />`, ComponentRefs{Components: []string{"leaf"}}); err != nil {
		t.Fatalf("create parent: %v", err)
	}
	_, err := s.SaveComponent("leaf", "leaf2", "<p>leaf</p>", ComponentRefs{})
	var ref *ComponentReferencedError
	if !errors.As(err, &ref) || len(ref.By) != 1 || ref.By[0] != "parent" {
		t.Fatalf("rename of a referenced component: err = %v, want a reference refusal naming parent", err)
	}
	if err := s.DeleteComponent("leaf"); !errors.As(err, &ref) {
		t.Fatalf("delete of a referenced component: err = %v, want a reference refusal", err)
	}
	// Once the referrer no longer mounts it, the leaf can go.
	if _, err := s.SaveComponent("parent", "parent", "<p>none</p>", ComponentRefs{}); err != nil {
		t.Fatalf("edit parent: %v", err)
	}
	if err := s.DeleteComponent("leaf"); err != nil {
		t.Fatalf("delete after the reference is gone: %v", err)
	}
}

// A metric a component reads by name cannot be renamed or deleted out from under the component.
func TestMetricReadByAComponentCannotBeRenamedOrDeleted(t *testing.T) {
	s := openMem(t)
	const expr = "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id"
	m, err := s.CreateMetric(models.MetricRow{Name: "my_metric", Title: "My metric", ShortName: "MM", Expr: expr, Format: "int", Doc: "d", Origin: "user"})
	if err != nil {
		t.Fatalf("CreateMetric: %v", err)
	}
	if _, err := s.SaveComponent("", "reader", "<script>let { spectra } = $props();</script>{spectra.metric('my_metric')}", ComponentRefs{Metrics: []string{"my_metric"}}); err != nil {
		t.Fatalf("create reader: %v", err)
	}
	var ref *ComponentReferencedError
	m.Name = "renamed_metric"
	if _, err := s.UpdateMetric(m); !errors.As(err, &ref) || ref.By[0] != "reader" {
		t.Fatalf("rename of a metric a component reads: err = %v, want a reference refusal naming reader", err)
	}
	if err := s.DeleteMetric(m.ID); !errors.As(err, &ref) {
		t.Fatalf("delete of a metric a component reads: err = %v, want a reference refusal", err)
	}
}

// A rename moves the component's references with it: the new name guards its targets, and the old
// name guards nothing.
func TestRenamedReferrerKeepsItsReferences(t *testing.T) {
	s := openMem(t)
	if _, err := s.SaveComponent("", "leaf", "<p>leaf</p>", ComponentRefs{}); err != nil {
		t.Fatalf("create leaf: %v", err)
	}
	if _, err := s.SaveComponent("", "parent", "<p>p</p>", ComponentRefs{Components: []string{"leaf"}}); err != nil {
		t.Fatalf("create parent: %v", err)
	}
	if _, err := s.SaveComponent("parent", "parent2", "<p>p</p>", ComponentRefs{Components: []string{"leaf"}}); err != nil {
		t.Fatalf("rename parent: %v", err)
	}
	var ref *ComponentReferencedError
	if err := s.DeleteComponent("leaf"); !errors.As(err, &ref) || len(ref.By) != 1 || ref.By[0] != "parent2" {
		t.Fatalf("delete of the leaf after the rename: err = %v, want a refusal naming parent2", err)
	}
	var n int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM component_refs WHERE referrer = 'parent'`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("old name still referenced: n=%d err=%v", n, err)
	}
}
