package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSaveFilters(t *testing.T) {
	tests := []struct {
		name string
		exts []string
		want string // "" = no filter
		pat  string
	}{
		{"single", []string{"png"}, "PNG files", "*.png"},
		{"dot-prefixed", []string{".png"}, "PNG files", "*.png"},
		{"star-prefixed", []string{"*.png"}, "PNG files", "*.png"},
		{"multi dedup", []string{"png", "PNG", ".jpg"}, "PNG/JPG files", "*.png;*.jpg"},
		{"empty list", nil, "", ""},
		{"garbage dropped", []string{"", "..", "p*ng", ".;drop"}, "", ""},
		{"mixed valid+invalid", []string{"png", "p*ng"}, "PNG files", "*.png"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := saveFilters(tt.exts)
			if tt.want == "" {
				if len(got) != 0 {
					t.Fatalf("saveFilters(%v) = %+v, want none", tt.exts, got)
				}
				return
			}
			if len(got) != 1 {
				t.Fatalf("saveFilters(%v) = %+v, want exactly one filter", tt.exts, got)
			}
			if got[0].DisplayName != tt.want || got[0].Pattern != tt.pat {
				t.Errorf("filter = {%q, %q}, want {%q, %q}",
					got[0].DisplayName, got[0].Pattern, tt.want, tt.pat)
			}
		})
	}
}

func TestWriteFile(t *testing.T) {
	s := &DialogService{}
	path := filepath.Join(t.TempDir(), "out.png")
	if err := s.WriteFile(path, []byte("bytes")); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if string(got) != "bytes" {
		t.Errorf("content = %q, want %q", got, "bytes")
	}
	// Overwrite (truncates).
	if err := s.WriteFile(path, []byte("x")); err != nil {
		t.Fatalf("WriteFile overwrite: %v", err)
	}
	got, _ = os.ReadFile(path)
	if string(got) != "x" {
		t.Errorf("after overwrite = %q, want %q", got, "x")
	}
	// Empty path is rejected (no accidental write to cwd).
	if err := s.WriteFile("  ", nil); err == nil {
		t.Error("blank path: err = nil, want error")
	}
	// Unwritable destination surfaces a real error.
	if err := s.WriteFile(filepath.Join(t.TempDir(), "no-such-dir", "x"), []byte("y")); err == nil {
		t.Error("missing parent dir: err = nil, want error")
	}
}
