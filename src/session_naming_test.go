package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// sessionToken matches an ad-hoc wave/session/plan-item prefix — the
// letter groups used for dispatch waves (w27, me0, r13) and for
// plan-item numbers (m5) followed by a digit, case-insensitively (test
// functions are CamelCase: TestM5ConsoleSafety). Domain names never
// take that shape (report3, web5, match12 all read as name+digit with
// a non-matching letter group).
var sessionToken = regexp.MustCompile(`(?i)^(w|me|r|m)[0-9]`)

// sessionTestFunc is the same token after `func Test` — the naming rule
// covers file AND test names; a file-name-only pin let the m5-era test
// functions through alongside their file.
var sessionTestFunc = regexp.MustCompile(`(?i)^func Test(w|me|r|m)[0-9]`)

// TestNoSessionLeakageInFileNames pins the no-session-leakage naming rule
// (AGENTS.md): committed files and test functions are named for the DOMAIN
// they cover, never for the ad-hoc wave/session/branch that produced them —
// w27_…, me0_…, r13_…, m5_… mean nothing a week later. Dated wave
// references inside comments (the ledger style) are history and are not
// this test's concern; file NAMES and Go test function names are. Walks
// the source tree from this package's directory (<repo>/src), skipping
// generated/bulk dirs.
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
		rel, rerr := filepath.Rel(root, path)
		if rerr != nil {
			rel = path
		}
		if sessionToken.MatchString(d.Name()) {
			offenders = append(offenders, rel)
			return nil
		}
		if !d.IsDir() && strings.HasSuffix(d.Name(), ".go") {
			if b, rerr := os.ReadFile(path); rerr == nil {
				for _, m := range sessionTestFunc.FindAllString(string(b), -1) {
					offenders = append(offenders, rel+": "+m)
				}
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", root, err)
	}
	if len(offenders) > 0 {
		t.Errorf("session-named file(s)/test function(s) in the tree — name them for the DOMAIN, not the wave/session/plan-item that produced them (AGENTS.md, no-session-leakage): %s",
			strings.Join(offenders, ", "))
	}
}
