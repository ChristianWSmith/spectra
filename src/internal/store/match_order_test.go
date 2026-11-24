package store

import (
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// A reprocess keeps the first extraction stamp, so the row keeps its place in the date-sorted
// library list.
func TestReextractionKeepsFirstExtractedAt(t *testing.T) {
	s := openMem(t)
	first := time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC)
	id := saveTestMatch(t, s, "/d/reorder.dem", "sha-reorder", first)
	if err := s.SaveExtracted(id, testExtracted("sha-reorder", first.Add(48*time.Hour))); err != nil {
		t.Fatalf("re-extract: %v", err)
	}
	m, err := s.GetMatch(id)
	if err != nil {
		t.Fatalf("GetMatch: %v", err)
	}
	if !m.ExtractedAt.Equal(first) {
		t.Errorf("ExtractedAt = %v after a reprocess, want the first stamp %v", m.ExtractedAt, first)
	}
}

// A queued import is sorted by its import time before it is extracted.
func TestQueuedRowSortsByImportTime(t *testing.T) {
	s := openMem(t)
	id, err := s.CreateMatchRow("/d/queued.dem", "sha-queued", 1)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	var key string
	if err := s.db.QueryRow(`SELECT COALESCE(extracted_at, imported_at) FROM matches WHERE id = ?`, id).Scan(&key); err != nil || key == "" {
		t.Fatalf("sort key = %q, %v; want the import time", key, err)
	}
	if m, _ := s.GetMatch(id); m.Status != models.StatusQueued {
		t.Errorf("status = %q, want queued", m.Status)
	}
}
