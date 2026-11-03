package main

import (
	"bytes"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// DialogService is the frontend's native-dialog + filesystem escape hatch:
// the webview cannot open OS file dialogs or write files itself, so save/
// render actions call SaveFile to pick a destination and then WriteFile to
// land the bytes there — or SaveExport when the payload lives behind one of
// the app's HTTP routes (too large to round-trip the bindings as base64).
// Registered in main.go alongside the other services; its methods are
// exposed through the generated bindings.
type DialogService struct {
	app *application.App

	// serve fetches an HTTP route through the app's asset handler and
	// returns the buffered response; wired in main.go (SaveExport is a
	// no-op error without it).
	serve exportServe

	// promptSave picks the destination path; nil = the native dialog
	// (s.SaveFile). Tests inject a fake so SaveExport's plumbing can be
	// exercised without opening a real dialog.
	promptSave func(defaultName string, extensions []string) (string, error)
}

// exportServe fetches urlPath (path + query — e.g. "/api/export/library.db"
// or "/api/sidecar/3/voice/wav?steamId=…") through the app's own asset
// handler and returns the buffered status and body. It exists so SaveExport
// can stream URL-served files (library.db, full-match WAVs, raw reports) to
// disk without shipping them through the bindings as base64.
type exportServe func(urlPath string) (status int, body []byte, err error)

// serveHandler adapts an http.Handler (the /api/* router in main.go) into
// an exportServe. The request is synthesized as a body-less GET — the app's
// handlers only read method, URL and query — and the whole response is
// buffered in memory (the export routes are bounded: library.db is tens of
// MB, reports are text).
func serveHandler(h http.Handler) exportServe {
	return func(urlPath string) (int, []byte, error) {
		u, err := url.Parse(urlPath)
		if err != nil || u.Path == "" || u.Host != "" || !strings.HasPrefix(u.Path, "/") {
			return 0, nil, fmt.Errorf("dialogs: serve %q: not an absolute URL path", urlPath)
		}
		rec := &responseBuffer{header: make(http.Header)}
		h.ServeHTTP(rec, &http.Request{
			Method: http.MethodGet,
			URL:    u,
			Host:   u.Host,
			Header: make(http.Header),
		})
		return rec.status(), rec.body.Bytes(), nil
	}
}

// responseBuffer is a minimal http.ResponseWriter that buffers the whole
// response (the shape httptest.ResponseRecorder provides, kept local so
// production code doesn't import net/http/httptest).
type responseBuffer struct {
	header http.Header
	body   bytes.Buffer
	code   int
}

func (r *responseBuffer) Header() http.Header { return r.header }

func (r *responseBuffer) Write(p []byte) (int, error) {
	if r.code == 0 {
		r.code = http.StatusOK
	}
	return r.body.Write(p)
}

func (r *responseBuffer) WriteHeader(code int) {
	if r.code == 0 {
		r.code = code
	}
}

// status reports the response code (200 when the handler never set one —
// the same default net/http applies).
func (r *responseBuffer) status() int {
	if r.code == 0 {
		return http.StatusOK
	}
	return r.code
}

// SaveFile opens the native save dialog pre-filled with defaultName and the
// file-type filters derived from extensions (["png"] → "*.png"). It returns
// the chosen absolute path, or "" with a nil error when the user cancels —
// only a dialog failure itself is an error. An empty defaultName opens with
// no preset filename; empty/invalid extensions leave the dialog unfiltered.
func (s *DialogService) SaveFile(defaultName string, extensions []string) (string, error) {
	// SaveFileDialogStruct has no SetTitle fluent setter (unlike the open
	// dialog) — the title rides in on the options struct.
	dlg := s.app.Dialog.SaveFileWithOptions(&application.SaveFileDialogOptions{
		Title:                "Save As",
		CanCreateDirectories: true,
		AllowOtherFileTypes:  true,
		Filename:             defaultName,
	})
	for _, f := range saveFilters(extensions) {
		dlg = dlg.AddFilter(f.DisplayName, f.Pattern)
	}
	path, err := dlg.PromptForSingleSelection()
	if err != nil {
		return "", fmt.Errorf("dialogs: save file: %w", err)
	}
	// Cancel: the platform dialog yields "" (or, on some backends, a
	// closed channel read) — the contract is "" + nil, never an error.
	if path == "" {
		return "", nil
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		// Dialog output is already absolute in practice; fall back to it
		// rather than failing a choice the user already made.
		return path, nil
	}
	return abs, nil
}

// WriteFile writes data to path with 0o644 (creating or truncating). It is
// the counterpart to SaveFile: the frontend renders/exports in memory and
// asks the backend to land the bytes on the path the dialog returned.
//
// data rides the bindings as a standard base64 string (encoding/json
// decodes a JSON string into []byte that way).
func (s *DialogService) WriteFile(path string, data []byte) error {
	if strings.TrimSpace(path) == "" {
		return fmt.Errorf("dialogs: write file: empty path")
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return fmt.Errorf("dialogs: write file %s: %w", filepath.Base(path), err)
	}
	return nil
}

// SaveExport opens the native save dialog (same title/filters as SaveFile),
// then serves urlPath through the app's own HTTP routes and writes the
// response to the chosen path with 0o644. It is the SaveFile + WriteFile
// pair for URL-served payloads — library.db (~19 MB), full-match voice
// WAVs, raw report documents — which must not cross the bindings as base64.
//
// urlPath must be an absolute URL path including any query string. It
// returns the absolute path written, or "" with a nil error when the user
// cancels (nothing is served, nothing is written); a non-200 response, a
// fetch failure or a write failure is an error and writes nothing.
func (s *DialogService) SaveExport(urlPath, defaultName string, extensions []string) (string, error) {
	if s.serve == nil {
		return "", fmt.Errorf("dialogs: save export: no exporter wired")
	}
	choose := s.promptSave
	if choose == nil {
		choose = s.SaveFile
	}
	path, err := choose(defaultName, extensions)
	if err != nil {
		return "", err
	}
	if path == "" {
		// Cancel: same contract as SaveFile — "" + nil, never an error.
		return "", nil
	}
	status, body, err := s.serve(urlPath)
	if err != nil {
		return "", fmt.Errorf("dialogs: save export %s: %w", urlPath, err)
	}
	if status != http.StatusOK {
		return "", fmt.Errorf("dialogs: save export %s: unexpected status %d", urlPath, status)
	}
	if err := s.WriteFile(path, body); err != nil {
		return "", fmt.Errorf("dialogs: save export: %w", err)
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return path, nil
	}
	return abs, nil
}

// saveFilters derives native dialog filters from requested extensions:
// ["png"] → [{PNG, *.png}], ["png", "jpg"] → [{PNG/JPG, *.png;*.jpg}].
// Entries are normalized (leading "."/"*" stripped, lowercased) and empty
// or non-alphanumeric extensions are dropped so a malformed request can
// never inject a bogus pattern.
func saveFilters(extensions []string) []application.FileFilter {
	var pats []string
	var names []string
	seen := map[string]bool{}
	for _, ext := range extensions {
		e := strings.ToLower(strings.TrimPrefix(strings.TrimPrefix(strings.TrimSpace(ext), "*"), "."))
		if e == "" || seen[e] {
			continue
		}
		valid := true
		for _, r := range e {
			if (r < 'a' || r > 'z') && (r < '0' || r > '9') {
				valid = false
				break
			}
		}
		if !valid {
			continue
		}
		seen[e] = true
		pats = append(pats, "*."+e)
		names = append(names, strings.ToUpper(e))
	}
	if len(pats) == 0 {
		return nil
	}
	return []application.FileFilter{{
		DisplayName: strings.Join(names, "/") + " files",
		Pattern:     strings.Join(pats, ";"),
	}}
}
