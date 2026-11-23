// Package ablation is the scratch-library harness behind backlog S03: copy a
// library snapshot, optionally change it (null a column, redirect a read),
// force a full metric sweep, dump metric_values, and diff the dump against a
// baseline dump per metric, subject and dimension.
//
// Nothing here runs by default. The driver is ablation_test.go, which is
// skipped unless ABLATION_SNAPSHOT is set. This file holds the reusable
// parts: the dump read, the diff, and the report text.
package ablation

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"sort"
	"strings"
)

// Row is one metric_values row, keyed by the table's primary key (metric,
// match, subject, dim, scope) plus value_key and row_json so that every
// stored cell has exactly one identity.
type Row struct {
	Metric     string   `json:"metric"`
	MatchID    int64    `json:"match_id"`
	SubjectKey string   `json:"subject_key"`
	Dim        string   `json:"dim"`
	ScopeSteam string   `json:"scope_steam_id"`
	ScopeRound int64    `json:"scope_round"`
	ValueKey   string   `json:"value_key"`
	RowJSON    string   `json:"row_json"`
	Value      *float64 `json:"value"`
}

// Identity is the join key used by the diff.
func (r Row) Identity() string {
	return fmt.Sprintf("%s|%d|%s|%s|%s|%d|%s|%s", r.Metric, r.MatchID, r.SubjectKey,
		r.Dim, r.ScopeSteam, r.ScopeRound, r.ValueKey, r.RowJSON)
}

// Group is the grain the report summarises at: one metric, one subject and
// dimension. The subject is shown as stored (SteamID64, team key or ”).
func (r Row) Group() string {
	return fmt.Sprintf("%s  subject=%q dim=%q", r.Metric, r.SubjectKey, r.Dim)
}

// Dump reads every metric_values row of the library behind db, ordered by
// identity, so two dumps of the same state are byte-identical.
func Dump(db *sql.DB) ([]Row, error) {
	rows, err := db.Query(`
		SELECT m.name, v.match_id, v.subject_key, v.dim, v.scope_steam_id,
		       v.scope_round, v.value_key, v.row_json, v.value
		FROM metric_values v JOIN metrics m ON m.id = v.metric_id
		ORDER BY m.name, v.match_id, v.subject_key, v.dim, v.scope_steam_id,
		         v.scope_round, v.value_key, v.row_json`)
	if err != nil {
		return nil, fmt.Errorf("read metric_values: %w", err)
	}
	defer rows.Close()
	var out []Row
	for rows.Next() {
		var r Row
		var v sql.NullFloat64
		if err := rows.Scan(&r.Metric, &r.MatchID, &r.SubjectKey, &r.Dim, &r.ScopeSteam,
			&r.ScopeRound, &r.ValueKey, &r.RowJSON, &v); err != nil {
			return nil, fmt.Errorf("scan metric_values: %w", err)
		}
		if v.Valid {
			f := v.Float64
			r.Value = &f
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// WriteDump and ReadDump persist a dump as JSON (the baseline file).
func WriteDump(path string, rows []Row) error {
	b, err := json.MarshalIndent(rows, "", " ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o644)
}

func ReadDump(path string) ([]Row, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var rows []Row
	if err := json.Unmarshal(b, &rows); err != nil {
		return nil, fmt.Errorf("parse dump %s: %w", path, err)
	}
	return rows, nil
}

// Diff counts for one metric/subject/dimension group.
type GroupDiff struct {
	Group    string
	Changed  int // both sides have a value and they differ
	NullNow  int // baseline had a value, variant is NULL
	ValueNow int // baseline was NULL, variant has a value
	Missing  int // row in baseline, absent in variant
	Added    int // row in variant, absent in baseline
	Samples  []string
}

func (g GroupDiff) Total() int {
	return g.Changed + g.NullNow + g.ValueNow + g.Missing + g.Added
}

// Report is the full diff of a variant dump against a baseline dump.
type Report struct {
	BaselineRows int
	VariantRows  int
	Groups       []GroupDiff // sorted by Group; only groups with differences
	Identical    bool
}

// Totals sums the per-group counts.
func (r Report) Totals() (changed, nulls, values, missing, added int) {
	for _, g := range r.Groups {
		changed += g.Changed
		nulls += g.NullNow
		values += g.ValueNow
		missing += g.Missing
		added += g.Added
	}
	return
}

const (
	floatTol        = 1e-9
	samplesPerGroup = 3
)

func sameValue(a, b *float64) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	if *a == *b {
		return true
	}
	diff := math.Abs(*a - *b)
	return diff <= floatTol*math.Max(1, math.Max(math.Abs(*a), math.Abs(*b)))
}

func fmtValue(v *float64) string {
	if v == nil {
		return "NULL"
	}
	return fmt.Sprintf("%g", *v)
}

// Diff compares variant against baseline row by row. A row present on only
// one side is counted as missing or added. Values are equal when identical
// or within floatTol relative tolerance; NULL matches only NULL.
func Diff(baseline, variant []Row) Report {
	base := make(map[string]Row, len(baseline))
	for _, r := range baseline {
		base[r.Identity()] = r
	}
	seen := make(map[string]bool, len(variant))
	groups := map[string]*GroupDiff{}
	get := func(r Row) *GroupDiff {
		g := r.Group()
		if groups[g] == nil {
			groups[g] = &GroupDiff{Group: g}
		}
		return groups[g]
	}
	addSample := func(g *GroupDiff, s string) {
		if len(g.Samples) < samplesPerGroup {
			g.Samples = append(g.Samples, s)
		}
	}
	for _, v := range variant {
		id := v.Identity()
		seen[id] = true
		b, ok := base[id]
		if !ok {
			g := get(v)
			g.Added++
			addSample(g, fmt.Sprintf("added match=%d value=%s", v.MatchID, fmtValue(v.Value)))
			continue
		}
		if sameValue(b.Value, v.Value) {
			continue
		}
		g := get(v)
		switch {
		case b.Value != nil && v.Value == nil:
			g.NullNow++
		case b.Value == nil && v.Value != nil:
			g.ValueNow++
		default:
			g.Changed++
		}
		addSample(g, fmt.Sprintf("match=%d value_key=%q baseline=%s variant=%s",
			v.MatchID, v.ValueKey, fmtValue(b.Value), fmtValue(v.Value)))
	}
	for _, b := range baseline {
		if !seen[b.Identity()] {
			g := get(b)
			g.Missing++
			addSample(g, fmt.Sprintf("missing match=%d baseline=%s", b.MatchID, fmtValue(b.Value)))
		}
	}
	rep := Report{BaselineRows: len(baseline), VariantRows: len(variant)}
	for _, g := range groups {
		if g.Total() > 0 {
			rep.Groups = append(rep.Groups, *g)
		}
	}
	sort.Slice(rep.Groups, func(i, j int) bool { return rep.Groups[i].Group < rep.Groups[j].Group })
	rep.Identical = len(rep.Groups) == 0
	return rep
}

// Text renders the report: a one-line verdict, the totals, then one block
// per differing metric/subject/dimension with a few sample rows.
func (r Report) Text() string {
	var b strings.Builder
	if r.Identical {
		fmt.Fprintf(&b, "IDENTICAL: %d baseline rows, %d variant rows, zero differences\n",
			r.BaselineRows, r.VariantRows)
		return b.String()
	}
	changed, nulls, values, missing, added := r.Totals()
	fmt.Fprintf(&b, "DIFFERS: %d baseline rows, %d variant rows\n", r.BaselineRows, r.VariantRows)
	fmt.Fprintf(&b, "  changed=%d  NULL-now=%d  value-now=%d  missing=%d  added=%d\n",
		changed, nulls, values, missing, added)
	for _, g := range r.Groups {
		fmt.Fprintf(&b, "%s: changed=%d null=%d value=%d missing=%d added=%d\n",
			g.Group, g.Changed, g.NullNow, g.ValueNow, g.Missing, g.Added)
		for _, s := range g.Samples {
			fmt.Fprintf(&b, "    %s\n", s)
		}
	}
	return b.String()
}
