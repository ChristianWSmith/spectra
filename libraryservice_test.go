package main

import (
	"path/filepath"
	"testing"

	"github.com/wailsapp/wails/v3/pkg/services/kvstore"

	"github.com/ChristianWSmith/spectra/internal/library"
)

// newDemoDirsService builds the slice of LibraryService the demo-dir
// methods touch (the kvstore), in memory — no prefs file is written.
func newDemoDirsService(t *testing.T) *LibraryService {
	t.Helper()
	return &LibraryService{kvs: kvstore.New()}
}

// TestGetDemoDirsDefaults pins the unset-pref contract: no stored list
// means "defaults in effect" (Custom=false) and the effective list is
// exactly library.DefaultDemoDirs (Downloads + CS2's replay folder).
func TestGetDemoDirsDefaults(t *testing.T) {
	svc := newDemoDirsService(t)
	got := svc.GetDemoDirs()
	if got.Custom {
		t.Error("unset pref reported Custom=true")
	}
	want := library.DefaultDemoDirs()
	if len(got.Dirs) != len(want) {
		t.Fatalf("default dirs = %v, want %v", got.Dirs, want)
	}
	for i := range want {
		if got.Dirs[i] != want[i] {
			t.Errorf("default dirs[%d] = %q, want %q", i, got.Dirs[i], want[i])
		}
	}
}

// TestDemoDirsRoundTrip: Set normalizes (absolute, cleaned, deduped,
// blanks dropped) and persists; Get then reports the stored list as
// custom; Reset drops back to the defaults.
func TestDemoDirsRoundTrip(t *testing.T) {
	svc := newDemoDirsService(t)
	base := t.TempDir()
	a := filepath.Join(base, "new")
	b := filepath.Join(base, "old")
	// Whitespace-padded duplicate + a path with a redundant segment: all
	// three normalize to [a b].
	if err := svc.SetDemoDirs([]string{a, " " + a + " ", filepath.Join(base, "x", "..", "old"), ""}); err != nil {
		t.Fatalf("SetDemoDirs: %v", err)
	}
	got := svc.GetDemoDirs()
	if !got.Custom {
		t.Error("stored list reported Custom=false")
	}
	want := []string{a, b}
	if len(got.Dirs) != len(want) {
		t.Fatalf("stored dirs = %v, want %v", got.Dirs, want)
	}
	for i := range want {
		if got.Dirs[i] != want[i] {
			t.Errorf("stored dirs[%d] = %q, want %q", i, got.Dirs[i], want[i])
		}
	}

	// Watching nothing is a legitimate custom state (empties dropped, the
	// list itself survives as an empty array).
	if err := svc.SetDemoDirs([]string{"", "  "}); err != nil {
		t.Fatalf("SetDemoDirs(empty): %v", err)
	}
	if got := svc.GetDemoDirs(); !got.Custom || len(got.Dirs) != 0 {
		t.Fatalf("empty list = %+v, want Custom with no dirs", got)
	}

	if err := svc.ResetDemoDirs(); err != nil {
		t.Fatalf("ResetDemoDirs: %v", err)
	}
	if got := svc.GetDemoDirs(); got.Custom {
		t.Error("after reset Custom is still true")
	}
}

// TestGetDemoDirsCorruptPref: a pref that is not a list of strings must
// fall back to the defaults instead of breaking the settings tab.
func TestGetDemoDirsCorruptPref(t *testing.T) {
	svc := newDemoDirsService(t)
	if err := svc.kvs.Set(prefsDemoDirsKey, "not a list"); err != nil {
		t.Fatalf("seed corrupt pref: %v", err)
	}
	got := svc.GetDemoDirs()
	if got.Custom {
		t.Error("corrupt pref reported Custom=true")
	}
	if len(got.Dirs) != len(library.DefaultDemoDirs()) {
		t.Errorf("corrupt pref dirs = %v, want the defaults", got.Dirs)
	}
}

// TestPrefStrings covers the kvstore value shapes the demo-dir pref can
// arrive in (in-memory []string vs. JSON-round-tripped []any).
func TestPrefStrings(t *testing.T) {
	tests := []struct {
		name string
		in   any
		want []string
		ok   bool
	}{
		{"absent", nil, nil, false},
		{"not a list", "x", nil, false},
		{"in-memory shape", []string{"/a", "/b"}, []string{"/a", "/b"}, true},
		{"json shape", []any{"/a", "/b"}, []string{"/a", "/b"}, true},
		{"empty json list", []any{}, []string{}, true},
		{"mixed types", []any{"/a", 42}, nil, false},
		{"list of numbers", []any{1, 2}, nil, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := prefStrings(tt.in)
			if ok != tt.ok {
				t.Fatalf("prefStrings(%v) ok = %v, want %v", tt.in, ok, tt.ok)
			}
			if !ok {
				return
			}
			if len(got) != len(tt.want) {
				t.Fatalf("prefStrings(%v) = %q, want %q", tt.in, got, tt.want)
			}
			for i := range tt.want {
				if got[i] != tt.want[i] {
					t.Errorf("prefStrings[%d] = %q, want %q", i, got[i], tt.want[i])
				}
			}
		})
	}
}
