package main

import (
	"errors"
	"io"
	"net/http"
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

// exportTestHandler is a stand-in for main.go's /api/* asset router: it
// serves one route with a body + query echo, answers 500 on demand and
// 404s everything else.
func exportTestHandler(statusOverride int) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case statusOverride != 0:
			http.Error(w, "boom", statusOverride)
		case r.URL.Path == "/api/export/library.db":
			w.Header().Set("Content-Type", "application/vnd.sqlite3")
			_, _ = io.WriteString(w, "db:"+r.URL.RawQuery)
		case r.URL.Path == "/api/sidecar/3/voice/wav":
			_, _ = io.WriteString(w, "wav-bytes")
		default:
			http.NotFound(w, r)
		}
	})
}

func TestServeHandler(t *testing.T) {
	serve := serveHandler(exportTestHandler(0))

	status, body, err := serve("/api/export/library.db?template=match")
	if err != nil {
		t.Fatalf("serve: %v", err)
	}
	if status != http.StatusOK || string(body) != "db:template=match" {
		t.Errorf("serve = (%d, %q), want (200, %q)", status, body, "db:template=match")
	}

	// A 404 from the router is a status, not an error — SaveExport turns
	// non-200 into a failure without writing anything.
	status, body, err = serve("/api/nope")
	if err != nil {
		t.Fatalf("serve 404: %v", err)
	}
	if status != http.StatusNotFound {
		t.Errorf("status = %d, want 404", status)
	}
	if len(body) == 0 {
		t.Error("body = empty, want the 404 page")
	}

	// Query-only sidecar routes work too (voice WAV download).
	status, _, err = serve("/api/sidecar/3/voice/wav?steamId=7656")
	if err != nil || status != http.StatusOK {
		t.Errorf("voice serve = (%d, %v), want (200, nil)", status, err)
	}

	// Anything that isn't an absolute URL path is rejected before the
	// handler ever sees it.
	for _, bad := range []string{"", "library.db", "https://evil.example/x", "//host/x"} {
		if _, _, err := serve(bad); err == nil {
			t.Errorf("serve(%q): err = nil, want error", bad)
		}
	}
}

func TestSaveExport(t *testing.T) {
	dir := t.TempDir()

	t.Run("writes the served body", func(t *testing.T) {
		dest := filepath.Join(dir, "library.db")
		s := &DialogService{
			serve: serveHandler(exportTestHandler(0)),
			promptSave: func(defaultName string, extensions []string) (string, error) {
				if defaultName != "Spectra-library.db" {
					t.Errorf("defaultName = %q, want Spectra-library.db", defaultName)
				}
				if len(extensions) != 1 || extensions[0] != "db" {
					t.Errorf("extensions = %v, want [db]", extensions)
				}
				return dest, nil
			},
		}
		got, err := s.SaveExport("/api/export/library.db", "Spectra-library.db", []string{"db"})
		if err != nil {
			t.Fatalf("SaveExport: %v", err)
		}
		if abs, _ := filepath.Abs(dest); got != abs {
			t.Errorf("path = %q, want %q", got, abs)
		}
		body, err := os.ReadFile(dest)
		if err != nil {
			t.Fatalf("read back: %v", err)
		}
		if string(body) != "db:" {
			t.Errorf("body = %q, want %q", body, "db:")
		}
		info, err := os.Stat(dest)
		if err != nil {
			t.Fatalf("stat: %v", err)
		}
		if perm := info.Mode().Perm(); perm != 0o644 {
			t.Errorf("perm = %o, want 644", perm)
		}
	})

	t.Run("cancel serves nothing and writes nothing", func(t *testing.T) {
		served := 0
		s := &DialogService{
			serve: func(string) (int, []byte, error) {
				served++
				return http.StatusOK, []byte("x"), nil
			},
			promptSave: func(string, []string) (string, error) { return "", nil },
		}
		got, err := s.SaveExport("/api/export/library.db", "x.db", []string{"db"})
		if err != nil {
			t.Fatalf("SaveExport(cancel): %v", err)
		}
		if got != "" {
			t.Errorf("path = %q, want \"\"", got)
		}
		if served != 0 {
			t.Errorf("served %d times, want 0 (cancel must not fetch)", served)
		}
	})

	t.Run("non-200 response writes nothing", func(t *testing.T) {
		dest := filepath.Join(dir, "missing.db")
		s := &DialogService{
			serve:      serveHandler(exportTestHandler(0)),
			promptSave: func(string, []string) (string, error) { return dest, nil },
		}
		if _, err := s.SaveExport("/api/export/gone", "missing.db", []string{"db"}); err == nil {
			t.Fatal("SaveExport(404): err = nil, want error")
		}
		if _, err := os.Stat(dest); !os.IsNotExist(err) {
			t.Errorf("file exists after 404: err = %v", err)
		}
	})

	t.Run("router failure surfaces", func(t *testing.T) {
		dest := filepath.Join(dir, "boom.db")
		s := &DialogService{
			serve:      serveHandler(exportTestHandler(http.StatusInternalServerError)),
			promptSave: func(string, []string) (string, error) { return dest, nil },
		}
		if _, err := s.SaveExport("/api/export/library.db", "boom.db", []string{"db"}); err == nil {
			t.Fatal("SaveExport(500): err = nil, want error")
		}
		if _, err := os.Stat(dest); !os.IsNotExist(err) {
			t.Errorf("file exists after 500: err = %v", err)
		}
	})

	t.Run("bad url path writes nothing", func(t *testing.T) {
		dest := filepath.Join(dir, "rel.db")
		s := &DialogService{
			serve:      serveHandler(exportTestHandler(0)),
			promptSave: func(string, []string) (string, error) { return dest, nil },
		}
		if _, err := s.SaveExport("library.db", "rel.db", []string{"db"}); err == nil {
			t.Fatal("SaveExport(relative): err = nil, want error")
		}
		if _, err := os.Stat(dest); !os.IsNotExist(err) {
			t.Errorf("file exists after bad path: err = %v", err)
		}
	})

	t.Run("dialog failure surfaces without serving", func(t *testing.T) {
		served := 0
		s := &DialogService{
			serve: func(string) (int, []byte, error) {
				served++
				return http.StatusOK, []byte("x"), nil
			},
			promptSave: func(string, []string) (string, error) {
				return "", errors.New("dialog broke")
			},
		}
		if _, err := s.SaveExport("/api/export/library.db", "x.db", nil); err == nil {
			t.Fatal("SaveExport(dialog err): err = nil, want error")
		}
		if served != 0 {
			t.Errorf("served %d times, want 0", served)
		}
	})

	t.Run("unwired exporter is an error", func(t *testing.T) {
		if _, err := (&DialogService{}).SaveExport("/api/export/library.db", "x.db", nil); err == nil {
			t.Fatal("SaveExport(no serve): err = nil, want error")
		}
	})
}
