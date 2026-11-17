package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// sessionFileName matches an ad-hoc wave/session file-name prefix — the
// letter groups used for dispatch waves (w27, me0, r13) followed by a
// digit. Domain names never take that shape (report3, web5, match12 all
// read as name+digit with a non-matching letter group).
var sessionFileName = regexp.MustCompile(`^(w|me|r)[0-9]`)

// TestNoSessionLeakageInFileNames pins the no-session-leakage naming rule
// (AGENTS.md): committed files are named for the DOMAIN they cover, never
// for the ad-hoc wave/session/branch that produced them — w27_…, me0_…,
// r13_… mean nothing a week later. Dated wave references inside comments
// (the ledger style) are history and are not this test's concern; only
// file NAMES are. Walks the source tree from this package's directory
// (<repo>/src), skipping generated/bulk dirs.
func TestNoSessionLeakageInFileNames(t *testing.T) {
	root, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	skip := map[string]bool{"node_modules": true, "dist": true, "bin": true, "bindings": true}
	var offenders []string
	err = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if skip[d.Name()] {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if sessionFileName.MatchString(d.Name()) {
			rel, rerr := filepath.Rel(root, path)
			if rerr != nil {
				rel = path
			}
			offenders = append(offenders, rel)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", root, err)
	}
	if len(offenders) > 0 {
		t.Errorf("session-named file(s) in the tree — name files for the DOMAIN, not the wave/session that produced them (AGENTS.md, no-session-leakage): %s",
			strings.Join(offenders, ", "))
	}
}
