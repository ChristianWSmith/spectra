package library

import (
	"path/filepath"
	"strings"
	"testing"
)

// abs is filepath.Abs with a test-fatal error (used to build OS-neutral
// expectations: the same normalization NormalizeDirs applies).
func abs(t *testing.T, p string) string {
	t.Helper()
	out, err := filepath.Abs(p)
	if err != nil {
		t.Fatalf("abs %q: %v", p, err)
	}
	return out
}

func TestDefaultDemoDirs(t *testing.T) {
	cs2Dir := filepath.Join(string(filepath.Separator)+"steam", "steamapps", "common",
		"Counter-Strike Global Offensive", "game", "csgo")
	downloads := filepath.Join(string(filepath.Separator)+"home", "u", "Downloads")

	tests := []struct {
		name      string
		downloads string
		cs2Dir    string
		want      []string
	}{
		{
			name:      "downloads + CS2 replays",
			downloads: downloads,
			cs2Dir:    cs2Dir,
			// The client's demos land in <CS2 install>/game/csgo/replays
			// (CS2.md "CS2 demo download folder").
			want: []string{downloads, filepath.Join(cs2Dir, "replays")},
		},
		{
			name:      "downloads only (CS2 not installed)",
			downloads: downloads,
			want:      []string{downloads},
		},
		{
			name:   "CS2 only (platform reports no Downloads)",
			cs2Dir: filepath.Join(string(filepath.Separator)+"games", "csgo"),
			want:   []string{filepath.Join(string(filepath.Separator)+"games", "csgo", "replays")},
		},
		{
			name: "neither",
			want: nil,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := defaultDemoDirs(tt.downloads, tt.cs2Dir)
			if len(got) != len(tt.want) {
				t.Fatalf("defaultDemoDirs(%q, %q) = %v, want %v", tt.downloads, tt.cs2Dir, got, tt.want)
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Errorf("defaultDemoDirs[%d] = %q, want %q", i, got[i], tt.want[i])
				}
			}
		})
	}
}

func TestNormalizeDirs(t *testing.T) {
	a := string(filepath.Separator) + "a"
	base := filepath.Join(a, "b")
	c := filepath.Join(a, "c")
	d := filepath.Join(a, "d")
	tests := []struct {
		name string
		in   []string
		want []string
	}{
		{"nil", nil, []string{}},
		{"drops blanks and dots", []string{"", "  ", "."}, []string{}},
		{
			"trims, cleans and dedupes in order",
			[]string{base, " " + base + " ", filepath.Join(a, "c", "..", "c"), d},
			[]string{abs(t, base), abs(t, c), abs(t, d)},
		},
		{
			"relative paths become absolute",
			[]string{"sub"},
			[]string{abs(t, "sub")},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := NormalizeDirs(tt.in)
			if len(got) != len(tt.want) {
				t.Fatalf("NormalizeDirs(%q) = %q, want %q", tt.in, got, tt.want)
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Errorf("NormalizeDirs[%d] = %q, want %q", i, got[i], tt.want[i])
				}
			}
		})
	}
}

// TestNormalizeDirsProducesAbsolutePaths pins the scanner contract: a
// relative entry would make the scan output depend on the process cwd.
func TestNormalizeDirsProducesAbsolutePaths(t *testing.T) {
	for _, d := range NormalizeDirs([]string{"relative/dir", "..", filepath.Join("already", "abs")}) {
		if !filepath.IsAbs(d) {
			t.Errorf("NormalizeDirs produced non-absolute %q", d)
		}
		if strings.Contains(d, "..") {
			t.Errorf("NormalizeDirs left a dot-dot segment in %q", d)
		}
	}
}
