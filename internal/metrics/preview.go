package metrics

import (
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/ChristianWSmith/spectra/internal/store"
)

// Preview execution constants: the runner uses the store's read-only
// session (plan §6 preview target < 1 s @ 100 matches — the timeout is a
// safety net, not the target) and a hard raw-value cap for percentiles.
const (
	PreviewTimeoutMS  = 10000
	PreviewDefaultRow = 200
	percentileCap     = 500000
	steamIDPrefix     = "7656119"
)

// Def is the runtime metric handle Preview needs (the service maps its
// frozen MetricDef onto this — metrics cannot import package main).
type Def struct {
	Expr        string
	GroupBy     string
	Denominator string
}

// PreviewRow is one preview result (Label resolved — see Preview).
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
// groups. Returns (*ParseError, nil) for validation failures, (nil, err)
// for execution failures. Group values that look like SteamID64 resolve to
// the players-table name (scoped match, else library-wide latest); every
// other group falls back to its raw key as Label.
func RunPreview(st *store.Store, def Def, scope string, limit int) (Preview, *ParseError, error) {
	if limit <= 0 {
		limit = PreviewDefaultRow
	}
	plan, perr := Compile(def.Expr, def.GroupBy, def.Denominator, scope)
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
	case ModePlain:
		if len(res.Rows) == 0 {
			pv.Rows = append(pv.Rows, PreviewRow{}) // aggregate should always yield one row
		} else {
			r := res.Rows[0]
			pv.Rows = append(pv.Rows, PreviewRow{Value: toFloat(r[0]), N: toN(r[len(r)-1])})
		}
	case ModePercentile:
		vals := make([]float64, 0, len(res.Rows))
		for _, r := range res.Rows {
			if len(r) == 0 {
				continue
			}
			if v, ok := numeric(r[0]); ok {
				vals = append(vals, v)
			}
		}
		sort.Float64s(vals)
		v := percentileOf(vals, plan.PercentileP)
		if plan.HasDenom {
			d := 0.0
			if len(res.Rows) > 0 {
				last := res.Rows[0][len(res.Rows[0])-1]
				d = toFloat(last)
			}
			if d != 0 {
				v /= d
			} else {
				v = 0
			}
		}
		pv.Rows = append(pv.Rows, PreviewRow{Value: v, N: len(vals)})
	}

	resolveLabels(st, pv.Rows, matchID)
	return pv, nil, nil
}

// resolveLabels fills Row.Label: SteamID64-shaped groups resolve to the
// players-table name (one batched lookup; scoped match, else latest by
// match id), everything else falls back to its raw key. Best effort — a
// label lookup failure never fails the preview.
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
	for start := 0; start < len(ids); start += 400 {
		end := start + 400
		if end > len(ids) {
			end = len(ids)
		}
		chunk := ids[start:end]
		q := `SELECT steam_id, name FROM players WHERE steam_id IN (` + strings.TrimSuffix(strings.Repeat("?,", len(chunk)), ",") + `)`
		args := make([]any, 0, len(chunk)+1)
		for _, id := range chunk {
			args = append(args, id)
		}
		if matchID > 0 {
			q += ` AND match_id = ?`
			args = append(args, matchID)
		}
		q += ` ORDER BY match_id DESC`
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

// numeric coerces a scanned driver value to float64.
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
