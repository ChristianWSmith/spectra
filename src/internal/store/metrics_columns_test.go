package store

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// TestMetricsTableHasNoScopeSubjectPartition pins dogfood/PLAN.md ruling 51:
// the metrics table carries no scope, subject or partition column. A
// metric's scope is derived from its binds (ScopeOfExpr) and partitioning is
// the statement's dim column, so none of the three is stored.
func TestMetricsTableHasNoScopeSubjectPartition(t *testing.T) {
	s := openMem(t)
	rows, err := s.db.Query(`PRAGMA table_info(metrics)`)
	if err != nil {
		t.Fatalf("PRAGMA table_info(metrics): %v", err)
	}
	defer rows.Close()
	var cols []string
	for rows.Next() {
		var (
			cid     int
			name    string
			ctype   string
			notnull int
			dflt    any
			pk      int
		)
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			t.Fatalf("scan table_info: %v", err)
		}
		cols = append(cols, name)
		switch name {
		case "scope", "subject", "partition":
			t.Errorf("metrics table still has the %q column (ruling 51: derived from the binds, or the dim)", name)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("table_info rows: %v", err)
	}
	if len(cols) == 0 {
		t.Fatal("metrics table not found")
	}
	// The scan list the store reads is exactly the stored column set, so a
	// removed column can never be read back by a stale SELECT.
	want := strings.Split(strings.ReplaceAll(metricColumns, "\n", ""), ",")
	for i := range want {
		want[i] = strings.TrimSpace(want[i])
	}
	stored := map[string]bool{}
	for _, c := range cols {
		stored[c] = true
	}
	for _, c := range want {
		if !stored[c] {
			t.Errorf("metricColumns names %q, which the metrics table does not store", c)
		}
	}
}

// metricsSQLRef matches a statement that touches the metrics table itself
// (not metric_values, metric_deps or metric_runs, whose names extend it).
var metricsSQLRef = regexp.MustCompile(`(?i)\b(FROM|INTO|UPDATE|JOIN)\s+metrics\b`)

// removedMetricsColumn matches a whole-word reference to one of the removed
// columns. scope_steam_id, subject_key and similar names do not match.
var removedMetricsColumn = regexp.MustCompile(`\b(scope|subject|partition)\b`)

// TestNoReaderOfRemovedMetricsColumns is the grep check for ruling 51: no Go
// source outside tests names the removed scope, subject or partition column
// in a SQL statement that reads or writes the metrics table. The scan covers
// every backtick and double-quoted literal, so a column named in a
// multi-line statement is caught too.
func TestNoReaderOfRemovedMetricsColumns(t *testing.T) {
	root := filepath.Join("..", "..")
	var offenders []string
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			name := d.Name()
			if path != root && (strings.HasPrefix(name, ".") || name == "node_modules" || name == "frontend") {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, lit := range sqlLiterals(string(src)) {
			if !metricsSQLRef.MatchString(lit) {
				continue
			}
			if m := removedMetricsColumn.FindString(lit); m != "" {
				offenders = append(offenders, path+": "+m+" in a statement on metrics")
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", root, err)
	}
	for _, o := range offenders {
		t.Errorf("a reader of the removed metrics columns remains: %s", o)
	}
}

// sqlLiterals returns the body of every raw (backtick) and interpreted
// (double-quoted) string literal in one Go source file. It is a lexical scan,
// not a parser, which is enough for SQL text in this package.
func sqlLiterals(src string) []string {
	var out []string
	for i := 0; i < len(src); i++ {
		switch src[i] {
		case '`':
			j := strings.IndexByte(src[i+1:], '`')
			if j < 0 {
				return out
			}
			out = append(out, src[i+1:i+1+j])
			i += j + 1
		case '"':
			j := i + 1
			for j < len(src) && src[j] != '"' && src[j] != '\n' {
				if src[j] == '\\' {
					j++
				}
				j++
			}
			if j < len(src) && src[j] == '"' {
				out = append(out, src[i+1:j])
			}
			i = j
		case '/':
			// Skip line comments so prose in comments is never scanned.
			if i+1 < len(src) && src[i+1] == '/' {
				j := strings.IndexByte(src[i:], '\n')
				if j < 0 {
					return out
				}
				i += j
			}
		}
	}
	return out
}

// TestScopeOfExprReadsBindsThroughMetricRefs pins the derivation ruling 51
// relies on: a career statement that reads other metrics through metric()
// is still profile, because the scope is read from its tokens and not from
// the gate's table check (which refuses metric() without the resolver).
func TestScopeOfExprReadsBindsThroughMetricRefs(t *testing.T) {
	career := "SELECT :steam_id AS subject_key, '' AS dim, 1.0 * (SELECT SUM(value) FROM metric('total_damage')) AS value"
	match := "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id"
	library := "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events"
	for _, c := range []struct{ name, expr, want string }{
		{"career through metric()", career, "profile"},
		{"match-bound", match, "match"},
		{"library-wide", library, "match"},
		{"unreadable text", "not even sql (", "match"},
	} {
		if got := ScopeOfExpr(c.expr); got != c.want {
			t.Errorf("%s: ScopeOfExpr = %q, want %q", c.name, got, c.want)
		}
	}
}
