package library

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Copy-on-import (the default — the copy_on_import pref in Settings can
// skip it): an accepted demo is copied into the app's managed demo
// directory (data.DemosDir by default, Options.CopyDir in tests) before
// the parse starts, named by its content hash, so Reprocess keeps working
// after the user's original file is moved or deleted. The copy is
// content-addressed: same bytes → same name → at most one copy per demo,
// and the sha256 dedupe in process() rejects a second import before any
// copy is made — concurrent jobs that hash to the SAME sha serialize on
// the per-sha gate first (shagate.go), so the loser takes the dedupe
// path instead of racing the rename or the matches insert. The user's original file is only ever read; stored copies
// are evictable (EvictDemoCopy / CopyState), and a match imported with
// copying off simply has no copy — Reprocess then reads the stored path.

// managedDemoName is the copy's file name for a demo with content hash
// sha: the source extension is preserved (.dem stays .dem, .dem.zst stays
// compressed). The hash covers the bytes as they sit on disk, so one hash
// maps to exactly one name.
func managedDemoName(sha, src string) string {
	if strings.HasSuffix(strings.ToLower(src), ".dem.zst") {
		return sha + ".dem.zst"
	}
	return sha + ".dem"
}

// managedDemoCompanion is the <demo>.info chat-key companion's name for a
// managed copy named name — the same stems infoCompanionCandidates looks
// for next to a source file, so a reprocess of the copy finds the key.
func managedDemoCompanion(name string) string {
	stem := strings.TrimSuffix(strings.TrimSuffix(name, ".zst"), ".dem")
	return stem + ".info"
}

// copyDemo copies the raw demo at src into im.copyDir under its content
// hash and returns the destination path. An existing copy is reused (same
// hash = same bytes). onProgress (optional) receives the running byte
// total while the demo itself is written — the copy stage's determinate
// progress (bytes written ÷ file size, reported by the caller). The
// <demo>.info companion sitting next to src — the chat decryption key —
// is copied best-effort alongside it so voice/chat decryption survives
// the source file going away; a missing or unreadable companion never
// fails the import. A src that already is the managed copy is a no-op.
// When copy-on-import is off this is never called (process skips the
// whole block — no copy, no StageCopy, no companion copy).
func (im *Importer) copyDemo(src, sha string, onProgress func(consumed int64)) (string, error) {
	name := managedDemoName(sha, src)
	dst := filepath.Join(im.copyDir, name)
	if samePath(src, dst) {
		return dst, nil
	}
	if err := os.MkdirAll(im.copyDir, 0o755); err != nil {
		return "", fmt.Errorf("copy demo: %w", err)
	}
	if fi, err := os.Stat(dst); err == nil && !fi.IsDir() {
		return dst, nil
	}
	if err := copyFile(src, dst, onProgress); err != nil {
		return "", fmt.Errorf("copy demo: %w", err)
	}
	if info := findInfoFile(src); info != "" {
		// Companion copy is best-effort: the demo itself already landed.
		_ = copyFile(info, filepath.Join(im.copyDir, managedDemoCompanion(name)), nil)
	}
	return dst, nil
}

// ManagedDemoPath returns the path of spectra's own copy of the demo with
// content hash sha, or "" when there is none — rows imported with
// copy-on-import off (or whose copy was evicted) only ever have the
// user's original file.
func (im *Importer) ManagedDemoPath(sha string) string {
	if sha == "" {
		return ""
	}
	for _, name := range []string{sha + ".dem.zst", sha + ".dem"} {
		p := filepath.Join(im.copyDir, name)
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			return p
		}
	}
	return ""
}

// Copy states a match's demo can be in — the ONLY values
// models.MatchSummary.CopyState / models.Match.CopyState carry. The state
// is derived from the filesystem on every read (never stored: no schema
// column, nothing to go stale), which is why the services stamp it on
// their bounded reads instead of the store filling it.
const (
	// CopyStateCopied: spectra' own copy exists — Reprocess reads it and
	// the UI may offer "Free copy" (evicting drops the match to
	// CopyStateExternal, or CopyStateMissing when the source is gone too).
	CopyStateCopied = "copied"
	// CopyStateExternal: no copy, but the STORED path still exists — the
	// user's original file is what Reprocess reads (skip-copied imports,
	// and imports from before copy-on-import).
	CopyStateExternal = "external"
	// CopyStateMissing: neither the copy nor the stored path exists — the
	// match data is intact and still viewable, but Reprocess fails fast
	// with its "Demo file not found" pre-check until a file is restored.
	CopyStateMissing = "missing"
)

// CopyState reports which demo file match sha would be read from:
// CopyStateCopied when spectra' copy exists, else CopyStateExternal when
// the stored source path is still on disk, else CopyStateMissing. Kept
// beside ManagedDemoPath on purpose — it is the same lookup plus one
// stat of the stored path (three stats per row at most; ListMatchesPage
// annotates ~50 rows with this).
func (im *Importer) CopyState(sha, storedPath string) string {
	if im.ManagedDemoPath(sha) != "" {
		return CopyStateCopied
	}
	if storedPath != "" {
		if fi, err := os.Stat(storedPath); err == nil && !fi.IsDir() {
			return CopyStateExternal
		}
	}
	return CopyStateMissing
}

// RemoveManagedDemo deletes spectra's own copy of sha (and its .info
// companion) and reports whether the demo file was removed. It only ever
// removes paths it constructed inside im.copyDir: a user's original demo
// file is never spectra's property to delete, so rows without a managed
// copy remove nothing.
func (im *Importer) RemoveManagedDemo(sha string) (bool, error) {
	p := im.ManagedDemoPath(sha)
	if p == "" {
		return false, nil
	}
	// Belt and braces: the path above is built from im.copyDir, but the
	// invariant (never delete outside the managed dir) is stated once.
	if !isUnder(im.copyDir, p) {
		return false, nil
	}
	if err := os.Remove(p); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, fmt.Errorf("remove managed demo: %w", err)
	}
	_ = os.Remove(filepath.Join(im.copyDir, managedDemoCompanion(filepath.Base(p))))
	return true, nil
}

// resolveDemoFile picks the file a match's demo is read from: spectra's
// own copy when one exists (stable — never moved or deleted by the user),
// else the stored path. Rows imported without a copy — copy-on-import
// off, or imported before it existed — point at the user's original file
// and must keep working; that is the fallback, and the source of the
// Reprocess "Demo file not found" pre-check when neither file is there.
func (im *Importer) resolveDemoFile(sha, storedPath string) string {
	if p := im.ManagedDemoPath(sha); p != "" {
		return p
	}
	return storedPath
}

// copyFile copies src to dst atomically (a UNIQUE temp file beside dst + rename): a crash or a full disk never leaves a truncated copy behind
// for a later import to mistake for the real thing, and CONCURRENT
// copies of the same content (two jobs that hashed to one sha — the
// importer's per-sha gate serializes the pipeline's own section, but the
// temp stays unique regardless) can never share (and truncate) a single
// .part file: each writer owns its own os.CreateTemp file and the renames
// are atomic last-wins over identical bytes. onProgress (optional)
// receives the running byte total as the copy reads — see copyDemo.
func copyFile(src, dst string, onProgress func(consumed int64)) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.CreateTemp(filepath.Dir(dst), filepath.Base(dst)+".part-*")
	if err != nil {
		return err
	}
	tmp := out.Name()
	// CreateTemp lands 0600; a managed copy is an ordinary app-data file
	// (0644 — the mode the fixed-temp version wrote).
	if err := out.Chmod(0o644); err != nil {
		_ = out.Close()
		_ = os.Remove(tmp)
		return err
	}
	if _, err := io.Copy(out, &countingReader{r: in, onRead: onProgress}); err != nil {
		_ = out.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, dst); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// samePath reports whether two paths point at the same file location
// (compared cleaned + absolute — no symlink resolution).
func samePath(a, b string) bool {
	aa, err1 := filepath.Abs(a)
	bb, err2 := filepath.Abs(b)
	return err1 == nil && err2 == nil && aa == bb
}

// isUnder reports whether path is dir itself or lives below dir. Both are
// expected cleaned/absolute (callers construct them that way).
func isUnder(dir, path string) bool {
	dir = filepath.Clean(dir)
	path = filepath.Clean(path)
	return path == dir || strings.HasPrefix(path, dir+string(filepath.Separator))
}
