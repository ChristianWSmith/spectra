package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// DialogService is the frontend's native-dialog + filesystem escape hatch:
// the webview cannot open OS file dialogs or write files itself, so save/
// render actions call SaveFile to pick a destination and then WriteFile to
// land the bytes there. Registered in main.go alongside the other services;
// its methods are exposed through the generated bindings.
type DialogService struct {
	app *application.App
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
func (s *DialogService) WriteFile(path string, data []byte) error {
	if strings.TrimSpace(path) == "" {
		return fmt.Errorf("dialogs: write file: empty path")
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return fmt.Errorf("dialogs: write file %s: %w", filepath.Base(path), err)
	}
	return nil
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
