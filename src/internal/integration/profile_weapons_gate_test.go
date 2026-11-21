package integration_test

// M7 gate — the Weapons table's migration to partition='weapon' metric
// seeds (plan §7 M7), run through the gate BEFORE the third column
// shipped: the JSON-fold numbers (player_stats.kills_by_weapon summed
// per weapon, headshots rebuilt from kill events —
// store.GetPlayerWeaponJSONs + profileservice.mergeWeapons) must equal
// the SHIPPED seed expressions' partitioned metric values EXACTLY
// (owner ruling 2026-11-17: "if the numbers diverge, fix the metric
// until they match — we don't do exceptions").
//
// History: ME6 ran this gate 2026-11-17 with kills/headshots EXACT and
// damage DIVERGED (candidate 21626 vs fold 17117, Δ4509 = HP-cap
// residual 4330 + known-side team damage 164 + post-match damage 15),
// escalated with example rows, and the test pinned that divergence with
// the documented note that equality would FLIP it into the migrate
// signal. The flip landed 2026-11-18: the capped_dmg ingest stamp
// (extract.agg.hurt — the capDamage replay + post-match real gate,
// row-local where §6.5 forbids the rounds join) plus the same_side
// enemy gate closed all three causes, this test pinned equality over
// the golden demo, and the weapon_damage seed shipped (107th builtin).
// The census survives as failure diagnostics (every delta still gets a
// named root cause).
//
// DAMAGE LEG RETIRED 2026-11-18 (owner ruling): the fold's damage side
// lived in player_stats.damage_by_weapon, whose only remaining readers
// were these oracle tests — the column is dropped, so the weapon_damage
// candidate has no fold side to compare any more. Equality was proven
// at the flip above (commit 86300be: seed == fold over every human ×
// weapon of the golden demo), the seed is now THE damage
// implementation, and its values read the capped_dmg ingest stamp, not
// the dropped column — its numbers do not move here. The kills and
// headshots legs stand EXACTLY as they were (their columns live).
//
// The test computes both sides over the golden demo and classifies every
// delta by its root cause, so the verdict rides on numbers:
//
//	fold side   the retired fold's per-weapon {kills, headshots}
//	candidate   the SHIPPED seed row's expression compiled through the
//	            real engine (Address{Partition: "weapon", Profile: true})
//
// Skipped under -short and when the demo is absent or an LFS pointer,
// like every other golden-demo test here.

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/analytics"
	"github.com/ChristianWSmith/spectra/internal/metrics"
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// weaponFoldRow is one player's fold-side totals for one weapon.
type weaponFoldRow struct{ kills, headshots int }

// weaponFold runs the RETIRED fold's math verbatim (the reference
// oracle): sum the per-match JSON pairs, weapon by weapon — the
// mergeWeapons arithmetic without its top-N truncation (the gate
// compares the WHOLE distribution). No damage side: the fold's damage
// reference died with player_stats.damage_by_weapon (2026-11-18 owner
// ruling — see the header's damage-leg note).
func weaponFold(t *testing.T, st *store.Store, steamID string) map[string]weaponFoldRow {
	t.Helper()
	rows, err := st.GetPlayerWeaponJSONs(steamID)
	if err != nil {
		t.Fatalf("GetPlayerWeaponJSONs(%s): %v", steamID, err)
	}
	out := map[string]weaponFoldRow{}
	add := func(raw string, pick func(*weaponFoldRow) *int) {
		if raw == "" {
			return
		}
		var m map[string]int
		if err := json.Unmarshal([]byte(raw), &m); err != nil {
			return
		}
		for w, n := range m {
			r := out[w]
			*pick(&r) += n
			out[w] = r
		}
	}
	for _, r := range rows {
		add(r.KillsByWeapon, func(a *weaponFoldRow) *int { return &a.kills })
		add(r.HeadshotsByWeapon, func(a *weaponFoldRow) *int { return &a.headshots })
	}
	return out
}

// weaponCandidates are the shipped weapon seeds the fold can still
// reference (name → the fold field their values must equal exactly).
// The third shipped seed, weapon_damage, retired its fold side with
// player_stats.damage_by_weapon (2026-11-18 — its equality was proven
// at the flip, commit 86300be; the seed is THE implementation). The
// gate reads each remaining expr from its SEEDED row — the migration
// contract pins the shipped expression, not a draft copy — and compiles
// it through the real engine. strict is always true since the
// 2026-11-18 flip: every candidate must match the fold EXACTLY over
// every human × weapon (the divergence pin ME6 documented resolved into
// this equality pin — the migrate signal).
var weaponCandidates = []struct {
	name string
	pick func(weaponFoldRow) int
}{
	{"weapon_kills", func(r weaponFoldRow) int { return r.kills }},
	{"weapon_headshots", func(r weaponFoldRow) int { return r.headshots }},
}

// seededWeaponExpr loads a weapon seed's shipped expression + addressing
// from the baseline seed (schema.sql's weapon addendum). A missing row
// fails the gate: the table migration reads these rows, so an unshipped
// seed is itself a gate failure.
func seededWeaponExpr(t *testing.T, st *store.Store, name string) string {
	t.Helper()
	res, err := st.RunReadOnly(
		`SELECT expr FROM metrics WHERE name = ? AND origin = 'builtin'`,
		[]any{name}, 10, 5000)
	if err != nil || len(res.Rows) != 1 {
		t.Fatalf("seeded row %s: err=%v rows=%d", name, err, len(res.Rows))
	}
	return res.Rows[0][0].(string)
}

// weaponRow is one row of a raw statement's result: the reserved columns
// subject_key, dim and value (ruling 22). NULL reads as NaN.
type weaponRow struct {
	Group string
	Dim   string
	Value float64
}

// storedWeaponRows reads one weapon seed's stored career rows (match 0), the
// shape the surface serves after the sweep.
func storedWeaponRows(t *testing.T, st *store.Store, name string) []weaponRow {
	t.Helper()
	res, err := st.RunReadOnly(
		`SELECT v.subject_key, v.dim, v.value FROM metric_values v JOIN metrics m ON m.id = v.metric_id
		 WHERE m.name = ? AND v.match_id = 0`,
		[]any{name}, 100000, 5000)
	if err != nil {
		t.Fatalf("read stored %s: %v", name, err)
	}
	out := make([]weaponRow, 0, len(res.Rows))
	for _, r := range res.Rows {
		row := weaponRow{Group: fmt.Sprint(r[0]), Dim: fmt.Sprint(r[1]), Value: math.NaN()}
		switch v := r[2].(type) {
		case int64:
			row.Value = float64(v)
		case float64:
			row.Value = v
		}
		out = append(out, row)
	}
	return out
}

// runWeaponStatement runs one career statement (no binds) on the metric
// connection and reads its reserved columns by name.
func runWeaponStatement(t *testing.T, st *store.Store, expr string) []weaponRow {
	t.Helper()
	res, err := st.QueryMetric(t.Context(), expr, nil)
	if err != nil {
		t.Fatalf("run: %v (sql %s)", err, expr)
	}
	idx := map[string]int{}
	for i, c := range res.Columns {
		idx[c] = i
	}
	out := make([]weaponRow, 0, len(res.Rows))
	for _, r := range res.Rows {
		row := weaponRow{Group: fmt.Sprint(keyOrEmpty(r[idx["subject_key"]])), Dim: fmt.Sprint(keyOrEmpty(r[idx["dim"]])), Value: math.NaN()}
		switch v := r[idx["value"]].(type) {
		case int64:
			row.Value = float64(v)
		case float64:
			row.Value = v
		}
		out = append(out, row)
	}
	return out
}

// keyOrEmpty reads a key column: NULL is the empty key.
func keyOrEmpty(v any) any {
	if v == nil {
		return ""
	}
	return v
}

// TestGoldenProfileWeaponsGate runs the M7 gate and reports the full
// comparison. It PINS exact equality for both fold-referenced shipped
// weapon seeds — kills and headshots (weapon_damage's leg retired with
// its column, 2026-11-18; see the header) — the 2026-11-18 flip of
// ME6's divergence pin: a green run is the
// migrated state; a red run fails with the census's named root cause and
// example rows for the escalation).
func TestGoldenProfileWeaponsGate(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping golden-demo parse in -short mode")
	}
	if skip, reason := shouldSkip(demoPath); skip {
		t.Skip(reason)
	}
	m := parseGolden(t)

	st, err := store.Open(filepath.Join(t.TempDir(), "weapons-gate.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer func() { _ = st.Close() }()
	id, err := st.CreateMatchRow("golden-weapons-gate", "sha-golden-weapons-gate", 0)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	if err := st.SaveExtracted(id, m); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	cfg := analytics.ConfigFrom(models.AnalysisConfig{
		TradeWindowS: 5.0, EcoFullBuy: 20000, EcoForce: 10000,
		TradeOppDistance: store.DefaultConfig.TradeOppDistance, RuleVersion: 1,
	}, 0)
	if err := analytics.Compute(st, id, cfg); err != nil {
		t.Fatalf("analytics.Compute: %v", err)
	}
	// The oracle reads the stored per-weapon kill metric (raw_kills_by_weapon):
	// the production sweep stores it for the imported match.
	if _, err := metrics.Sweep(context.Background(), st, nil, nil); err != nil {
		t.Fatalf("metrics.Sweep: %v", err)
	}

	refs, err := st.GetPlayerRefs(id)
	if err != nil {
		t.Fatalf("GetPlayerRefs: %v", err)
	}

	// ---- root-cause census over the raw events (the classification
	// the report needs): every kill/damage row the fold EXCLUDED and
	// why, plus the HP-cap question for damage.
	census := runWeaponCensus(t, st, id)
	// Ruling 48: the weapon seeds are per-player and read stored per-match values.
	if _, err := metrics.Sweep(t.Context(), st, nil, nil); err != nil {
		t.Fatalf("sweep: %v", err)
	}

	for _, cand := range weaponCandidates {
		t.Run(cand.name, func(t *testing.T) {
			// The shipped seed row's stored-shape values: the sweep's
			// career statement (profile scope, weapon partition), expr
			// loaded from the seeded row itself.
			candByPlayer := map[string]map[string]float64{}
			for _, r := range storedWeaponRows(t, st, cand.name) {
				if candByPlayer[r.Group] == nil {
					candByPlayer[r.Group] = map[string]float64{}
				}
				candByPlayer[r.Group][r.Dim] = r.Value
			}

			diverged := 0
			var candTotal, foldTotal float64
			for _, ref := range refs {
				if ref.IsBot {
					continue // the fold may list bots; the metric is humans-only (§3.4)
				}
				fold := weaponFold(t, st, ref.SteamID)
				got := candByPlayer[ref.SteamID]
				weapons := map[string]bool{}
				for w := range fold {
					weapons[w] = true
				}
				for w := range got {
					weapons[w] = true
				}
				var names []string
				for w := range weapons {
					names = append(names, w)
				}
				sort.Strings(names)
				for _, w := range names {
					want := float64(cand.pick(fold[w]))
					have := got[w]
					candTotal += have
					foldTotal += want
					if have != want {
						diverged++
						t.Errorf("%s/%s: seed = %v, fold = %v (delta %s)",
							ref.Name, w, have, want, census.explain(w, cand.name))
					}
				}
			}
			if diverged == 0 {
				t.Logf("%s: EXACT match over every human × weapon (fold total %.0f)", cand.name, foldTotal)
			} else {
				t.Logf("%s: totals: seed = %.0f, fold = %.0f — census: %s",
					cand.name, candTotal, foldTotal, census)
			}
		})
	}
	t.Logf("census: %s", census)
}

// weaponCensus classifies the fold-excluded rows so every delta has a
// named root cause with example rows (the escalation report's evidence).
type weaponCensus struct {
	discardedRounds int // kill rows in rounds with no rounds-table row (warmup/knife…)
	negativeRound   int // of those, rows whose round number is negative
	teamkills       int // kill rows whose attacker/victim shared a KNOWN side
	teamDamage      int // damage rows likewise
	postMatch       int // kill rows inside a counted round but after its end tick
	// Damage sums (dmg points) for the damage candidate's classes: the
	// fold credits capDamage's HP-capped value while events.dmg carries
	// the raw hit, so the candidate's SUM(dmg) can diverge even with
	// every gate matched — these sums quantify the row classes and the
	// residual against the fold total is the cap itself.
	teamDamageDmg  int      // known-side team damage
	postMatchDmg   int      // post-match damage
	discardedDmg   int      // damage in uncounted rounds
	enemyRawDamage int      // Σ raw events.dmg over attacker-eligible damage rows (counted rounds)
	overkill       []string // (round, victim) pairs whose raw damage exceeds the 100 HP pool
	examples       []string
}

func (c weaponCensus) String() string {
	return fmt.Sprintf("discarded-round kills=%d (neg %d), teamkills=%d, post-match kills=%d | damage: known-team=%d dmg, post-match=%d dmg, discarded=%d dmg, attacker-eligible raw total=%d dmg; examples: %s",
		c.discardedRounds, c.negativeRound, c.teamkills, c.postMatch,
		c.teamDamageDmg, c.postMatchDmg, c.discardedDmg, c.enemyRawDamage,
		"overkill: "+strings.Join(c.overkill, " | ")+"; kill examples: "+strings.Join(c.examples, " | "))
}

func (c weaponCensus) explain(weapon, cand string) string {
	parts := []string{}
	if c.discardedRounds > 0 {
		parts = append(parts, fmt.Sprintf("%d rows in discarded (uncounted) rounds", c.discardedRounds))
	}
	if c.teamkills > 0 && strings.Contains(cand, "kill") {
		parts = append(parts, fmt.Sprintf("%d teamkills (same known side)", c.teamkills))
	}
	if c.teamDamage > 0 && strings.Contains(cand, "damage") {
		parts = append(parts, fmt.Sprintf("%d team-damage rows", c.teamDamage))
	}
	if c.postMatch > 0 {
		parts = append(parts, fmt.Sprintf("%d post-match rows (tick after the round's end)", c.postMatch))
	}
	if len(parts) == 0 {
		return "unclassified — see census log"
	}
	return "fold excluded: " + strings.Join(parts, "; ")
}

func runWeaponCensus(t *testing.T, st *store.Store, matchID int64) weaponCensus {
	t.Helper()
	var c weaponCensus

	// Kill rows with NO rounds-table row = a discarded round's events
	// (warmup/knife/post-match discards are never stamped into rounds).
	res, err := st.RunReadOnly(`
		SELECT COUNT(*) FROM events e
		LEFT JOIN rounds r ON r.match_id = e.match_id AND r.number = e.round
		WHERE e.kind = 'kill' AND r.match_id IS NULL`, []any{}, 10, 5000)
	if err != nil {
		t.Fatalf("census discarded kills: %v", err)
	}
	c.discardedRounds = int(res.Rows[0][0].(int64))

	res, err = st.RunReadOnly(`
		SELECT COUNT(*) FROM events e
		WHERE e.kind = 'kill' AND e.round < 0`, nil, 10, 5000)
	if err != nil {
		t.Fatalf("census negative kills: %v", err)
	}
	c.negativeRound = int(res.Rows[0][0].(int64))

	// Teamkills: attacker/victim share a KNOWN freeze-end side — the
	// exact gate GetPlayerWeaponJSONs' headshot SQL spells.
	res, err = st.RunReadOnly(`
		SELECT COUNT(*) FROM events e
		JOIN round_player_sides ka ON ka.match_id = e.match_id AND ka.round = e.round AND ka.steam_id = e.attacker
		JOIN round_player_sides kv ON kv.match_id = e.match_id AND kv.round = e.round AND kv.steam_id = e.victim
		JOIN rounds r ON r.match_id = e.match_id AND r.number = e.round
		WHERE e.kind = 'kill' AND e.attacker <> e.victim AND ka.side = kv.side`, nil, 10, 5000)
	if err != nil {
		t.Fatalf("census teamkills: %v", err)
	}
	c.teamkills = int(res.Rows[0][0].(int64))

	res, err = st.RunReadOnly(`
		SELECT COUNT(*) FROM events e
		JOIN round_player_sides ka ON ka.match_id = e.match_id AND ka.round = e.round AND ka.steam_id = e.attacker
		JOIN round_player_sides kv ON kv.match_id = e.match_id AND kv.round = e.round AND kv.steam_id = e.victim
		JOIN rounds r ON r.match_id = e.match_id AND r.number = e.round
		WHERE e.kind = 'damage' AND e.attacker <> e.victim AND ka.side = kv.side`, nil, 10, 5000)
	if err != nil {
		t.Fatalf("census team damage: %v", err)
	}
	c.teamDamage = int(res.Rows[0][0].(int64))

	// Damage sums by class — the HP-cap question lives here: the fold
	// credits capDamage's HP-capped value while events.dmg carries the
	// raw hit, so the candidate's SUM(dmg) can diverge even with every
	// gate matched. These sums quantify the row classes; the residual
	// against the fold's total is the cap itself.
	res, err = st.RunReadOnly(`
		SELECT
			COALESCE(SUM(CASE WHEN ka.side = kv.side THEN e.dmg ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN e.tick > r.end_tick THEN e.dmg ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN r.match_id IS NULL THEN e.dmg ELSE 0 END), 0),
			COALESCE(SUM(e.dmg), 0)
		FROM events e
		JOIN rounds r ON r.match_id = e.match_id AND r.number = e.round
		LEFT JOIN round_player_sides ka ON ka.match_id = e.match_id AND ka.round = e.round AND ka.steam_id = e.attacker
		LEFT JOIN round_player_sides kv ON kv.match_id = e.match_id AND kv.round = e.round AND kv.steam_id = e.victim
		WHERE e.kind = 'damage' AND e.attacker != '' AND e.attacker != e.victim`, nil, 10, 5000)
	if err != nil {
		t.Fatalf("census damage sums: %v", err)
	}
	drow := res.Rows[0]
	c.teamDamageDmg = int(drow[0].(int64))
	c.postMatchDmg = int(drow[1].(int64))
	c.discardedDmg = int(drow[2].(int64))
	c.enemyRawDamage = int(drow[3].(int64))

	// Post-match rows: inside a counted round's number but after the
	// round's recorded end tick (the demo tail's shooting).
	res, err = st.RunReadOnly(`
		SELECT COUNT(*) FROM events e
		JOIN rounds r ON r.match_id = e.match_id AND r.number = e.round
		WHERE e.kind = 'kill' AND r.end_tick > 0 AND e.tick > r.end_tick`, nil, 10, 5000)
	if err != nil {
		t.Fatalf("census post-match: %v", err)
	}
	c.postMatch = int(res.Rows[0][0].(int64))

	// HP-cap example for the escalation report: one (round, victim)
	// whose raw damage events exceed the 100 HP pool — the fold credits
	// min(Σraw, 100) through capDamage's per-hit replay, the candidate's
	// SUM(dmg) credits the raw total (order-dependent per-weapon
	// attribution: truncation lands on whichever hit crossed the line).
	res, err = st.RunReadOnly(`
		SELECT e.round, e.victim, SUM(e.dmg) AS raw
		FROM events e
		WHERE e.kind = 'damage' AND e.attacker != '' AND e.attacker != e.victim
		GROUP BY e.round, e.victim HAVING raw > 100
		ORDER BY raw DESC LIMIT 3`, nil, 3, 5000)
	if err != nil {
		t.Fatalf("census overkill: %v", err)
	}
	for _, row := range res.Rows {
		c.overkill = append(c.overkill, fmt.Sprintf("round=%v victim=%v raw=%v dmg (fold credits ≤100)", row[0], row[1], row[2]))
	}

	// Example rows for the report: five excluded kill rows with their
	// reason's raw fields.
	ex, err := st.RunReadOnly(`
		SELECT e.round, e.tick, e.weapon, e.attacker, e.victim,
			CASE WHEN r.match_id IS NULL THEN 'uncounted-round'
			     WHEN e.tick > r.end_tick THEN 'post-match'
			     ELSE 'in-counted-round' END
		FROM events e
		LEFT JOIN rounds r ON r.match_id = e.match_id AND r.number = e.round
		WHERE e.kind = 'kill' AND (r.match_id IS NULL OR e.tick > r.end_tick)
		ORDER BY e.seq LIMIT 5`, nil, 5, 5000)
	if err != nil {
		t.Fatalf("census examples: %v", err)
	}
	for _, row := range ex.Rows {
		c.examples = append(c.examples, fmt.Sprintf("round=%v tick=%v %s %v→%v (%v)",
			row[0], row[1], row[2], row[3], row[4], row[5]))
	}
	return c
}
