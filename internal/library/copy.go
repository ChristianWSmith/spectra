package library

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Copy-on-import: every accepted demo is copied into the app's managed
// demo directory (data.DemosDir by default, Options.CopyDir in tests)
// before the parse starts, named by its content hash, so Reprocess keeps
// working after the user's original file is moved or deleted. The copy is
// content-addressed: same bytes → same name → at most one copy per demo,
// and the sha256 dedupe in process() rejects a second import before any
// copy is made. The user's original file is only ever read.

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
// content hash sha, or "" when there is none — rows imported before
// copy-on-import only ever have the user's original file.
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
// else the stored path. Rows imported before copy-on-import point at the
// user's original file and must keep working — that is the fallback.
func (im *Importer) resolveDemoFile(sha, storedPath string) string {
	if p := im.ManagedDemoPath(sha); p != "" {
		return p
	}
	return storedPath
}

// copyFile copies src to dst atomically (temp file + rename): a crash or
// a full disk never leaves a truncated copy behind for a later import to
// mistake for the real thing. onProgress (optional) receives the running
// byte total as the copy reads — see copyDemo. The fixed temp name is
// safe — the pipeline has a single worker, so two copies never run at
// once.
func copyFile(src, dst string, onProgress func(consumed int64)) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".part"
	out, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
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
