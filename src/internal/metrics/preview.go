package metrics

import (
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/ChristianWSmith/spectra/internal/store"
)

// Preview execution constants: the runner uses the store's read-only
// session (preview target < 1 s @ 100 matches — the timeout is a
// safety net, not the target) and a hard raw-value cap for percentiles.
const (
	PreviewTimeoutMS  = 10000
	PreviewDefaultRow = 200
	percentileCap     = 500000
	steamIDPrefix     = "7656119"
)

// Def is the runtime metric handle Preview needs (the stored definition —
// models.MetricRow — maps its Expr/Denominator onto this; the addressing
// is the engine's: every statement is subject-grouped since the groupBy
// parameter retired with W2). Refs carries the expression's metric()
// references RESOLVED against the saved catalog (design §2) — the
// service fills it; a nil map compiles only ref-free expressions.
type Def struct {
	Expr        string
	Denominator string
	Refs        map[string]RefTarget
}

// PreviewRow is one preview result (Label resolved — see Preview). Group
// is the row's ADDRESS — the subject column of the statement (a
// SteamID64 for every player-addressed row).
type PreviewRow struct {
	Group string
	Label string
	Value float64
	N     int
}

// Preview is a compiled-and-run metric preview.
type Preview struct {
	Rows      []PreviewRow
	MS        int64  // read-only session wall time (SQL execution + row scan)
	SQL       string // compiled statement (+ companion) — provenance view
	Truncated bool
}

// RunPreview compiles def, runs it against the whole library (scope "") or a
// single match ("match:<id>") with a row cap of limit (≤0 → 200), and maps
// subjects. Returns (*ParseError, nil) for validation failures, (nil, err)
// for execution failures. Subject values that look like SteamID64 resolve to
// the players-table name (scoped match, else library-wide latest); every
// other group falls back to its raw key as Label.
func RunPreview(st *store.Store, def Def, scope string, limit int) (Preview, *ParseError, error) {
	if limit <= 0 {
		limit = PreviewDefaultRow
	}
	plan, perr := CompileRefs(def.Expr, def.Denominator, scope, def.Refs)
	if perr != nil {
		return Preview{}, perr, nil
	}
	pv := Preview{SQL: plan.SQL}
	if plan.Secondary != "" {
		pv.SQL += "\n" + plan.Secondary
	}

	fetch := limit
	if plan.Mode == ModePercentile {
		fetch = percentileCap
	}
	res, err := st.RunReadOnly(plan.SQL, plan.Args, fetch, PreviewTimeoutMS)
	pv.MS = res.MS
	if err != nil {
		return pv, nil, err
	}
	pv.Truncated = res.Truncated

	matchID, _ := ParseScope(scope) // already validated by Compile
	switch plan.Mode {
	case ModeGrouped:
		for _, r := range res.Rows {
			if len(r) < 2 {
				continue
			}
			pv.Rows = append(pv.Rows, PreviewRow{
				Group: toKey(r[0]),
				Value: toFloat(r[1]),
				N:     toN(r[len(r)-1]),
			})
		}
	case ModePercentile:
		// Partition the raw fetch by the row's ADDRESS — the subject. A
		// match-scoped run sees one match, so the subject alone is the
		// address; "" scope partitions the whole library by subject (the
		// batched pass addresses (match, subject) the same way). Each
		// partition is THE subject's rows in scope: the p-quantile over
		// its own sample, N = the numeric values behind it, and the
		// denominator taken from the partition's OWN row (correlated on
		// the subject at profile scope, a shared scalar at match scope).
		// A subject the statement produced no row for has no partition (no
		// row); a partition whose rows carry no numeric value yields value
		// 0 with N 0 — the missing-data indicator, never a fabricated
		// number. Keys sort like phase1's ORDER BY grp.
		type partition struct {
			vals     []float64
			denom    float64
			denomSet bool
		}
		parts := make(map[string]*partition)
		keys := make([]string, 0, len(res.Rows))
		for _, r := range res.Rows {
			if len(r) < 2 {
				continue
			}
			key := toKey(r[0])
			p := parts[key]
			if p == nil {
				p = &partition{}
				parts[key] = p
				keys = append(keys, key)
			}
			if v, ok := numeric(r[1]); ok {
				p.vals = append(p.vals, v)
			}
			if plan.HasDenom && !p.denomSet {
				p.denom = toFloat(r[len(r)-1])
				p.denomSet = true
			}
		}
		sort.Strings(keys)
		for _, key := range keys {
			p := parts[key]
			sort.Float64s(p.vals)
			v := percentileOf(p.vals, plan.PercentileP)
			if plan.HasDenom {
				if p.denom != 0 {
					v /= p.denom
				} else {
					v = 0
				}
			}
			pv.Rows = append(pv.Rows, PreviewRow{Group: key, Value: v, N: len(p.vals)})
		}
	}

	resolveLabels(st, pv.Rows, matchID)
	return pv, nil, nil
}

// resolveLabels fills Row.Label: SteamID64-shaped groups resolve to the
// players-table name (scoped match → store.GetPlayerRefs, the roster read
// model; library-wide → one batched IN-list lookup, latest match wins),
// everything else falls back to its raw key. Best effort — a label lookup
// failure never fails the preview (it gives up quietly, labels stay "").
func resolveLabels(st *store.Store, rows []PreviewRow, matchID int64) {
	names := map[string]string{}
	var ids []string
	seen := map[string]bool{}
	for _, r := range rows {
		if r.Group == "" || !isSteamID(r.Group) || seen[r.Group] {
			continue
		}
		seen[r.Group] = true
		ids = append(ids, r.Group)
	}
	if len(ids) > 0 {
		if matchID > 0 {
			// Scoped preview: every id must come from THIS match's roster —
			// GetPlayerRefs is exactly that read (no chunked IN-list needed).
			refs, err := st.GetPlayerRefs(matchID)
			if err != nil {
				return // labels are cosmetic — give up quietly
			}
			for _, ref := range refs {
				if ref.SteamID != "" {
					names[ref.SteamID] = ref.Name
				}
			}
		} else {
			// Library-wide: the latest name per SteamID across matches.
			for start := 0; start < len(ids); start += 400 {
				end := start + 400
				if end > len(ids) {
					end = len(ids)
				}
				chunk := ids[start:end]
				q := `SELECT steam_id, name FROM players WHERE steam_id IN (` + strings.TrimSuffix(strings.Repeat("?,", len(chunk)), ",") + `) ORDER BY match_id DESC`
				args := make([]any, 0, len(chunk))
				for _, id := range chunk {
					args = append(args, id)
				}
				res, err := st.RunReadOnly(q, args, len(chunk), PreviewTimeoutMS)
				if err != nil {
					return // labels are cosmetic — give up quietly
				}
				for _, r := range res.Rows {
					if len(r) != 2 {
						continue
					}
					sid, _ := r[0].(string)
					name, _ := r[1].(string)
					if sid == "" {
						continue
					}
					if _, dup := names[sid]; !dup {
						names[sid] = name // ORDER BY match_id DESC → first hit is latest
					}
				}
			}
		}
	}
	for i := range rows {
		g := rows[i].Group
		if g == "" {
			rows[i].Label = ""
			continue
		}
		if name, ok := names[g]; ok && name != "" {
			rows[i].Label = name
			continue
		}
		rows[i].Label = g
	}
}

// isSteamID reports the SteamID64 shape (17 digits, standard 7656119…
// prefix) used to decide label lookup.
func isSteamID(s string) bool {
	return len(s) == 17 && strings.HasPrefix(s, steamIDPrefix) && allDigits(s)
}

func allDigits(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// percentileOf computes the p-quantile of a sorted slice with linear
// interpolation between order statistics (position p·(n−1)); p ∈ [0,1]
// (median = percentileOf(..., 0.5)).
func percentileOf(sorted []float64, p float64) float64 {
	n := len(sorted)
	if n == 0 {
		return 0
	}
	if p <= 0 {
		return sorted[0]
	}
	if p >= 1 {
		return sorted[n-1]
	}
	pos := p * float64(n-1)
	lo := int(pos)
	hi := lo + 1
	if hi >= n {
		hi = n - 1
	}
	return sorted[lo] + (pos-float64(lo))*(sorted[hi]-sorted[lo])
}

// numeric coerces a scanned driver value to float64. Values arrive through
// store.RunReadOnly, which already normalizes driver types (the store's
// normValue: []byte → string, time.Time → RFC3339Nano), so the coercers
// below only ever see JSON scalars — there is deliberately NO second
// []byte/time normalization here (one canonical normalizer, in the store).
func numeric(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case int64:
		return float64(t), true
	case string:
		f, err := strconv.ParseFloat(t, 64)
		return f, err == nil
	}
	return 0, false
}

// toFloat coerces a value cell to the preview's float64 (NULL/text → 0 —
// PRD §5.16 missing data shows via N; min/max over TEXT columns are not
// representable in the numeric contract and surface as 0).
func toFloat(v any) float64 {
	f, _ := numeric(v)
	return f
}

// toN coerces the sample-size cell.
func toN(v any) int {
	switch t := v.(type) {
	case int64:
		return int(t)
	case float64:
		return int(t)
	}
	return 0
}

// toKey renders a group cell as the preview group string.
func toKey(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case int64:
		return strconv.FormatInt(t, 10)
	case float64:
		return strconv.FormatFloat(t, 'g', -1, 64)
	case nil:
		return ""
	case fmt.Stringer:
		return t.String()
	}
	return fmt.Sprintf("%v", v)
}
