package main

// W27: plugin install takes a manifest FILE (owner ruling) — and the
// regression for the reported stall ("importing … says 'installing' and
// stalls forever"): a FOLDER source used to be walked and copied in full
// (the owner's 1.8 GB Desktop ran ~110s of silent hashing + copying
// while the Settings row read "Installing…"), so Install now refuses a
// folder before any work. Each case runs on a goroutine with a deadline;
// a case that misses it dumps every goroutine so the blocking call chain
// is visible in the failure output.

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/plugin"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// ownerManifestPath is the owner's Build-plugin dialog output (481-byte
// single-file manifest) — read-only diagnostic input, golden-demo
// skip-if-absent pattern.
const ownerManifestPath = "/home/christian/Desktop/spectra-plugin.json"

type installResult struct {
	st  PluginState
	err error
}

// installWithin runs fn and fails with a full goroutine dump if it has
// not returned within d.
func installWithin(t *testing.T, what string, d time.Duration, fn func() (PluginState, error)) installResult {
	t.Helper()
	done := make(chan installResult, 1)
	go func() {
		st, err := fn()
		done <- installResult{st: st, err: err}
	}()
	start := time.Now()
	select {
	case r := <-done:
		t.Logf("%s returned in %v (err=%v)", what, time.Since(start).Round(time.Millisecond), r.err)
		return r
	case <-time.After(d):
		buf := make([]byte, 1<<20)
		n := runtime.Stack(buf, true)
		t.Fatalf("%s did not return within %s — goroutine stacks:\n%s", what, d, buf[:n])
		return installResult{}
	}
}

// TestInstallPluginRejectsFolderSources is THE stall regression: a
// folder CONTAINING a valid manifest (the shape the old folder picker
// produced — a manifest plus whatever else lived in the folder) is
// refused with a clear error, promptly, and installs NOTHING. Before the
// fix this folder installed successfully after copying every file in it,
// which is what made the owner's install run unbounded.
func TestInstallPluginRejectsFolderSources(t *testing.T) {
	useTempXDG(t)
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	defer func() { _ = st.Close() }()
	svc := &PlatformService{st: st}

	// A folder shaped like the owner's pick: a valid manifest inside,
	// plus an unrelated payload file the old code copied verbatim.
	folder := t.TempDir()
	if err := os.WriteFile(filepath.Join(folder, plugin.ManifestName), []byte(rootTestPlugin), 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
	if err := os.WriteFile(filepath.Join(folder, "payload.bin"), make([]byte, 4<<20), 0o644); err != nil {
		t.Fatalf("write payload: %v", err)
	}

	r := installWithin(t, "InstallPlugin(folder)", 30*time.Second, func() (PluginState, error) {
		return svc.InstallPlugin(folder)
	})
	if r.err == nil {
		t.Fatal("InstallPlugin of a folder succeeded — the file-only source is not enforced")
	}
	if !strings.Contains(r.err.Error(), "folder") {
		t.Errorf("folder-source error = %q, want it to name the folder", r.err)
	}
	// Nothing landed: no registry row, no installed bundle on disk.
	if list, err := svc.ListPlugins(); err != nil || len(list) != 0 {
		t.Errorf("ListPlugins after the refused install = %+v, %v, want empty", list, err)
	}
	if _, err := os.Stat(filepath.Join(plugin.DefaultDir(), "root-plug")); !os.IsNotExist(err) {
		t.Errorf("a bundle landed despite the refusal: stat err = %v", err)
	}
}

// TestInstallPluginOwnerManifestFile pins the owner's own artifact
// installing as a FILE path: quick, successful, id as built. Skip if the
// artifact is absent (golden-demo pattern) — never copied into the repo.
func TestInstallPluginOwnerManifestFile(t *testing.T) {
	if _, err := os.Stat(ownerManifestPath); err != nil {
		t.Skipf("owner manifest absent (%s)", ownerManifestPath)
	}
	useTempXDG(t)
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	defer func() { _ = st.Close() }()
	svc := &PlatformService{st: st}

	r := installWithin(t, "InstallPlugin(owner manifest file)", 30*time.Second, func() (PluginState, error) {
		return svc.InstallPlugin(ownerManifestPath)
	})
	if r.err != nil {
		t.Fatalf("InstallPlugin(owner file): %v", r.err)
	}
	if r.st.Manifest.ID != "asdf" {
		t.Fatalf("installed id = %q, want asdf", r.st.Manifest.ID)
	}
}
