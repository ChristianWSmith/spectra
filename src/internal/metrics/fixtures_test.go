package metrics

import (
	"database/sql"
	"fmt"
	"math"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/store"
)

// seededStore opens a file-backed store and loads the synthetic corpus
// (golden library fixture): a second short-lived write connection
// next to the store handle — WAL tolerates it. The metrics fixture,
// property and perf suites share it.
func seededStore(t *testing.T) *store.Store {
	t.Helper()
	path := filepath.Join(t.TempDir(), "seed.db")
	st, err := store.Open(path)
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() {
		_ = st.CloseRO()
		_ = st.Close()
	})
	db, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("open seed conn: %v", err)
	}
	if err := LoadSeed(db); err != nil {
		t.Fatalf("LoadSeed: %v", err)
	}
	_ = db.Close()
	return st
}

// builtinSeed maps the ONE HUNDRED AND NINE schema-seeded builtins
// (schema.sql —
// name/expr/scope/subject/partition/format/short_name/denominator are
// LOCKED to the baseline seed by this table) onto their hand-computed
// seed expectations. (2026-11-17 re-pin of the FIFTY-NINE count: plan §7 M3
// / §8 adds the dmg_no_kill + kill_conversion match rows; the same
// day's owner Option A extension adds the 22-row count addendum —
// EIGHTY-THREE / 64 match + 19 profile — an owner amendment the
// plan's §8 does not list; the subject-axis addendum (plan §8 (M8/M4
// rows), 2026-11-17) then adds 4 rows with an explicit subject —
// EIGHTY-SEVEN / 67 match + 20 profile — reporting pistol_hold and
// avg_equip_gap among the plan's six rows NOT expressible in the
// grammar at that point; the identity addendum (plan §8 (M1 identity row),
// 2026-11-17) finally adds the five M1 top-card seeds — NINETY-TWO /
// 72 match + 20 profile — subject=match, format=identity; the
// partition addendum (plan §8 (M5/M6 rows), 2026-11-17) then adds the
// five side- and five map-partitioned profile seeds — ONE HUNDRED AND
// TWO / 72 match + 30 profile — partition written explicitly; the
// weapon addendum (plan §8 (M7 row), 2026-11-17) finally adds the two
// EXACT weapon columns — ONE HUNDRED AND FOUR / 72 match + 32 profile
// — the damage column escalated with the gate; the grammar addendum
// (plan §8 (M8 rows), 2026-11-17) then lands those two deferred M8
// rows — ONE HUNDRED AND SIX / 74 match + 32 profile — pistol_hold
// over the next() round window, avg_equip_gap over the diff() row
// difference; the M7 weapon-damage flip (plan §8 (M7 row), 2026-11-18)
// finally lands the third weapon column — ONE HUNDRED AND SEVEN /
// 74 match + 33 profile — the capped_dmg ingest stamp closed the gate
// and the damage column migrated; the view-aggregate relocation
// addendum (ME8 exception audit, 2026-11-18) then lands the force
// card's two team count rows — ONE HUNDRED AND NINE / 76 match +
// 33 profile — cited to the view-aggregate rule, not a plan row.)
// interpretation records how the seeded expression states
// the metric (never silently — the formula and any proxy/deviation
// live in the row's doc). Since the subject axis, every statement is
// grouped by the DECLARED subject's key — the player shape for the
// player rows (the groupBy parameter retired with W2), the match/team
// key for the addendum rows — and a partitioned row additionally
// splits by dim (wantDims pins which dim each row lands on; the
// partition column itself is locked alongside the expr above).
//
// The expectations are hand-computed over the committed corpus
// (testdata/seed.sql — 3 identical matches × 8 players × 24 rounds;
// formulas in its header): player_stats carries kills = 2i, deaths = i,
// headshots = i, total_damage = 100i, adr = 50+5i (the hand-written
// gradient only career_adr_sigma still reads — every ADR seed now
// recomputes from total_damage with the `rounds` denominator, owner
// rule 2026-11-16), rounds_played = 24 (map_adr's per-match divisor
// matches it — the corpus has no absent-round player), trade_kills = i
// per match for player i (1..8), entry_kills = i per match (the
// 2026-11-18 swap that retired the identical opening_kills column —
// same values, so every opening-duel expectation kept its number),
// utility_damage / enemies_flashed are absent → 0, and every player has
// 72 player_round_stats rows with a 0.5 KAST mean (36 of 72), a 60.0
// side ADR (4320 damage / 72 rounds), 72 kills / 18 deaths (K/D 4)
// and a 36/72 round-win rate (the winners alternate ct/t by round
// parity, each player sits on ONE side all career — side_switches 0 —
// so each player has exactly ONE side dim row). The corpus has NO
// clutches and no player_round_stats surprises, which is what makes
// the N values (COUNT(*) behind each aggregate) exact.
var builtinSeed = []struct {
	name           string
	expr           string
	scope          string
	subject        string // "" = player (the DDL default the player rows rely on)
	partition      string // "" = unpartitioned (the DDL default)
	format         string
	shortName      string
	interpretation string
	rows           int
	wantValues     []float64 // per subject, ORDER BY grp ASC (nil → wantAll)
	wantAll        float64
	wantLabels     string   // expected labels joined ("" = don't assert)
	wantDims       []string // per row, ORDER BY grp, dim (nil = don't assert)
}{
	{
		name:      "trade_rate",
		expr:      "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT player_stats.match_id AS mid, player_stats.steam_id AS grp, 1.0*(SUM(player_stats.trade_kills)) / NULLIF((SUM(match_trade_opps.opps)), 0) AS v FROM player_stats LEFT JOIN match_trade_opps ON player_stats.match_id = match_trade_opps.match_id AND player_stats.steam_id = match_trade_opps.steam_id WHERE player_stats.match_id = :match_id AND (player_stats.steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope:     "match",
		format:    "percent",
		shortName: "",
		interpretation: "trade successes / total trade opportunities over the engine-derived LEFT JOIN " +
			"(match_id, steam_id) — a ratio, not a share, so it may exceed 100% (profile TradeRate note)",
		// join_test.go TestJoinedAcceptanceRatio's seed math: ratio =
		// 3i/30i = 0.1 for i ≤ 6; Grace's stored opps = 0 and Heidi's
		// absent row both surface as Value 0 beside N.
		rows: 8, wantValues: []float64{0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0, 0},
		wantLabels: eightLabels,
	},
	{
		// D1: sum(total_damage) with the `rounds` DENOMINATOR = 300i/72
		// per player across the three identical matches — the divisor is
		// the rounds count, never the rounds the player played (owner
		// rule 2026-11-16), and at this run's library scope the career
		// denominator counts the subject's 72 player_round_stats rows —
		// numerically the 72 the old sum(rounds_played) totaled, so the
		// values did not move. The corpus's hand-written adr column is
		// an independent gradient (55…90) and is NOT this seed's oracle
		// — see scoreboard_equivalence_test.go).
		name: "adr", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, 1.0*(SUM(total_damage)) / NULLIF(((SELECT COUNT(*) FROM rounds WHERE match_id = player_stats.match_id)), 0) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.total_damage, 0) AS total_damage, CAST(COALESCE(f.total_damage, 0) AS REAL) / NULLIF((SELECT COUNT(*) FROM rounds r WHERE r.match_id = ps.match_id), 0) AS adr\n  FROM player_stats ps\n  LEFT JOIN (WITH dmg AS (\n  SELECT e.match_id, e.round, e.attacker, e.victim, e.weapon, e.capped_dmg, e.detail_json,\n         sa.side AS a_side, sv.side AS v_side\n  FROM events e\n  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker\n  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim\n  WHERE e.match_id = :match_id AND e.kind = 'damage' AND e.post_match = 0\n),\nedmg AS (\n  SELECT * FROM dmg WHERE attacker <> '' AND attacker <> victim\n    AND NOT (COALESCE(a_side, '') <> '' AND a_side = v_side)\n),\nfold AS (\n    SELECT match_id, attacker AS steam_id, 'total_damage' AS f, SUM(capped_dmg) AS n FROM edmg GROUP BY match_id, attacker\n  )\n  SELECT match_id, steam_id, SUM(CASE WHEN f = 'total_damage' THEN n END) AS total_damage FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id\n  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "float1", shortName: "ADR",
		interpretation: "damage per round of the match re-computed from raw inputs (extract's adr formula)",
		rows:           8,
		wantValues:     []float64{300.0 / 72, 600.0 / 72, 900.0 / 72, 1200.0 / 72, 1500.0 / 72, 1800.0 / 72, 2100.0 / 72, 2400.0 / 72}, wantLabels: eightLabels,
	},
	{
		// D7: entry_kills = i per match (the 2026-11-18 swap of the
		// retired opening_kills column); the preview runs at library
		// scope, so the value is the career 3i over the seed's `rounds`
		// denominator (72 career rounds) = i/24 per player.
		name: "entry_rate", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, 1.0*(SUM(entry_kills)) / NULLIF(((SELECT COUNT(*) FROM rounds WHERE match_id = player_stats.match_id)), 0) AS v FROM player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "percent", shortName: "Entry%",
		interpretation: "entry (first-blood) kills per round (corpus: career 3i / 72 rounds)",
		rows:           8,
		wantValues:     []float64{3.0 / 72, 6.0 / 72, 9.0 / 72, 12.0 / 72, 15.0 / 72, 18.0 / 72, 21.0 / 72, 24.0 / 72}, wantLabels: eightLabels,
	},
	{
		// D4: sum(headshots)/sum(kills) = 3i/6i = 0.5 for every player.
		name: "hs_pct", expr: "WITH k AS (\n  SELECT e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,\n         (e.victim <> '' AND e.attacker = e.victim AND e.weapon = 'World' AND dc.attacker IS NOT NULL) AS fake,\n         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side\n  FROM events e\n  LEFT JOIN (SELECT DISTINCT attacker, tick FROM events\n             WHERE match_id = :match_id AND kind = 'player_disconnect') dc\n    ON dc.attacker = e.victim AND dc.tick = e.tick\n  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker\n  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim\n  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister\n  WHERE e.match_id = :match_id AND e.kind = 'kill' AND e.post_match = 0\n),\nek AS (\n  SELECT * FROM k WHERE attacker <> '' AND attacker <> victim AND fake = 0\n    AND NOT (COALESCE(a_side,'') <> '' AND a_side = v_side)\n),\nagg AS (\nSELECT attacker AS steam_id, COUNT(*) AS n, SUM(headshot) AS hs FROM ek GROUP BY attacker\n)\nSELECT p.steam_id AS subject_key, '' AS dim, CASE WHEN agg.n > 0 THEN 1.0 * agg.hs / agg.n END AS value\nFROM players p\nLEFT JOIN agg ON agg.steam_id = p.steam_id\nWHERE p.match_id = :match_id AND p.is_bot = 0\nORDER BY p.steam_id",
		scope: "match", format: "percent", shortName: "HS%",
		interpretation: "headshot share of kills (corpus: headshots = kills/2 → 0.5)",
		rows:           8, wantAll: 0.5, wantLabels: eightLabels,
	},
	{
		// D6: AVG over the player's 72 player_round_stats rows — 36
		// KAST rounds each → 0.5, N = 72 (the source rows, not matches).
		name: "kast", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, AVG(kast) AS v FROM player_round_stats WHERE player_round_stats.match_id = :match_id AND (steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_round_stats.match_id AND p.steam_id = player_round_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "percent", shortName: "KAST%",
		interpretation: "per-round KAST flag mean (36/72 per player)",
		rows:           8, wantAll: 0.5, wantLabels: eightLabels,
	},
	{
		// D5: sum(kills)/sum(deaths) = 6i/3i = 2 for every player (no
		// zero-death subject here — Q1's NULLIF edge is the doc note).
		name: "kd", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, 1.0*(SUM(kills)) / NULLIF((SUM(deaths)), 0) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.kills, 0) AS kills, COALESCE(f.deaths, 0) AS deaths\n  FROM player_stats ps\n  LEFT JOIN (WITH k AS (\n  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,\n         (e.victim <> '' AND e.attacker = e.victim AND e.weapon = 'World' AND dc.attacker IS NOT NULL) AS fake,\n         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side\n  FROM events e\n  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = 'player_disconnect') dc\n    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick\n  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker\n  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim\n  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister\n  WHERE e.match_id = :match_id AND e.kind = 'kill' AND e.post_match = 0\n),\nek AS (\n  SELECT * FROM k WHERE attacker <> '' AND attacker <> victim AND fake = 0\n    AND NOT (COALESCE(a_side, '') <> '' AND a_side = v_side)\n),\nfold AS (\n    SELECT match_id, attacker AS steam_id, 'kills' AS f, COUNT(*) AS n FROM ek GROUP BY match_id, attacker\n    UNION ALL SELECT match_id, victim AS steam_id, 'deaths' AS f, COUNT(*) AS n FROM k WHERE victim <> '' AND fake = 0 GROUP BY match_id, victim\n  )\n  SELECT match_id, steam_id, SUM(CASE WHEN f = 'kills' THEN n END) AS kills, SUM(CASE WHEN f = 'deaths' THEN n END) AS deaths FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id\n  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "float2", shortName: "K/D",
		interpretation: "kills per death (corpus: kills = 2×deaths → 2)",
		rows:           8, wantAll: 2, wantLabels: eightLabels,
	},
	{
		// w13d: the scoreboard's KDA conversion — the scalar max()
		// value form floors the denominator exactly like the Go
		// spelling GetScoreboard served ((kills+assists)/MAX(deaths,1)),
		// which scoreboard_equivalence_test.go pins as its oracle.
		// Corpus math: (2i + 0)/max(i, 1) = 2 (assists = 0, deaths = i
		// ≥ 1 — the zero-death floor has no subject here, so that edge
		// is the equivalence test's, with its own zero-death row).
		name: "kda", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, 1.0*(SUM(kills + assists)) / NULLIF((MAX(SUM(deaths), 1)), 0) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.kills, 0) AS kills, COALESCE(f.deaths, 0) AS deaths, COALESCE(f.assists, 0) AS assists\n  FROM player_stats ps\n  LEFT JOIN (WITH k AS (\n  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,\n         (e.victim <> '' AND e.attacker = e.victim AND e.weapon = 'World' AND dc.attacker IS NOT NULL) AS fake,\n         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side\n  FROM events e\n  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = 'player_disconnect') dc\n    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick\n  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker\n  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim\n  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister\n  WHERE e.match_id = :match_id AND e.kind = 'kill' AND e.post_match = 0\n),\nek AS (\n  SELECT * FROM k WHERE attacker <> '' AND attacker <> victim AND fake = 0\n    AND NOT (COALESCE(a_side, '') <> '' AND a_side = v_side)\n),\nak AS (\n  SELECT * FROM k WHERE assister <> '' AND assister <> victim AND attacker <> '' AND attacker <> victim AND fake = 0 AND NOT (COALESCE(a_side, '') <> '' AND a_side = v_side) AND NOT (COALESCE(s_side, '') <> '' AND s_side = v_side)\n),\nfold AS (\n    SELECT match_id, attacker AS steam_id, 'kills' AS f, COUNT(*) AS n FROM ek GROUP BY match_id, attacker\n    UNION ALL SELECT match_id, victim AS steam_id, 'deaths' AS f, COUNT(*) AS n FROM k WHERE victim <> '' AND fake = 0 GROUP BY match_id, victim\n    UNION ALL SELECT match_id, assister AS steam_id, 'assists' AS f, COUNT(*) AS n FROM ak WHERE assisted_flash = 0 GROUP BY match_id, assister\n  )\n  SELECT match_id, steam_id, SUM(CASE WHEN f = 'kills' THEN n END) AS kills, SUM(CASE WHEN f = 'deaths' THEN n END) AS deaths, SUM(CASE WHEN f = 'assists' THEN n END) AS assists FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id\n  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "float2", shortName: "KDA",
		interpretation: "kills plus assists per floored death (corpus: kills = 2×deaths, assists = 0 → 2)",
		rows:           8, wantAll: 2, wantLabels: eightLabels,
	},
	{
		// D8: sum(trade_kills)/sum(deaths) = 3i/3i = 1 (100%) — a ratio
		// over OWN deaths, unlike trade_rate's opportunities denominator.
		name: "trade_rate_deaths", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, 1.0*(SUM(trade_kills)) / NULLIF((SUM(deaths)), 0) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.deaths, 0) AS deaths\n  FROM player_stats ps\n  LEFT JOIN (WITH k AS (\n  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,\n         (e.victim <> '' AND e.attacker = e.victim AND e.weapon = 'World' AND dc.attacker IS NOT NULL) AS fake,\n         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side\n  FROM events e\n  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = 'player_disconnect') dc\n    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick\n  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker\n  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim\n  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister\n  WHERE e.match_id = :match_id AND e.kind = 'kill' AND e.post_match = 0\n),\nek AS (\n  SELECT * FROM k WHERE attacker <> '' AND attacker <> victim AND fake = 0\n    AND NOT (COALESCE(a_side, '') <> '' AND a_side = v_side)\n),\nfold AS (\n    SELECT match_id, victim AS steam_id, 'deaths' AS f, COUNT(*) AS n FROM k WHERE victim <> '' AND fake = 0 GROUP BY match_id, victim\n  )\n  SELECT match_id, steam_id, SUM(CASE WHEN f = 'deaths' THEN n END) AS deaths FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id\n  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "percent", shortName: "Trade%",
		interpretation: "trades as a share of the player's own deaths (corpus: equal → 1)",
		rows:           8, wantAll: 1, wantLabels: eightLabels,
	},
	{
		// D2: sum(total_damage) with the `rounds` DENOMINATOR at profile
		// scope = the POOLED micro-average 300i/72 (Σ damage ÷ Σ rounds
		// of the three identical matches). Owner rule 2026-11-16
		// superseded the mean-of-ratios ruling this row used to carry —
		// avg(adr) over the corpus's hand-written column gradient read
		// 50+5i, which is exactly why the expected values MOVED to the
		// pooled form. career_adr_sigma still reads stddev(adr): the
		// dispersion of per-match ADRs is unchanged by the ruling.
		name: "career_adr", expr: "SELECT :steam_id AS subject_key, '' AS dim, 1.0 * (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric('total_damage')) / NULLIF((SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric('match_rounds')), 0) AS value WHERE EXISTS (SELECT 1 FROM metric('total_damage'))",
		scope: "profile", format: "float1", shortName: "ADR",
		interpretation: "event-derived over the corpus events (the retired player_stats literal is not the truth)",
		rows:           8,
		wantValues:     []float64{97.5, 97.5, 97.5, 97.5, 97.5, 97.5, 97.5, 97.5}, wantLabels: eightLabels,
	},
	{
		// D3: population σ over three IDENTICAL values → exactly 0
		// (the sqrt(max(…,0)) idiom clamps float noise).
		name: "career_adr_sigma", expr: "SELECT :steam_id AS subject_key, '' AS dim, (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SQRT(MAX(AVG(value * value) - AVG(value) * AVG(value), 0)) END FROM metric('adr')) AS value",
		scope: "profile", format: "float1", shortName: "ADR σ",
		interpretation: "event-derived over the corpus events (the retired player_stats literal is not the truth)",
		rows:           8, wantValues: []float64{0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0}, wantLabels: eightLabels,
	},
	{
		// D11: enemies_flashed absent from the corpus's INSERTs → 0.
		name: "career_avg_enemies_flashed", expr: "SELECT :steam_id AS subject_key, '' AS dim, (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN AVG(value) END FROM metric('enemies_flashed')) AS value",
		scope: "profile", format: "float1", shortName: "Flash",
		interpretation: "event-derived over the corpus events (the retired player_stats literal is not the truth)",
		rows:           8, wantValues: []float64{6.0, 6.0, 6.0, 6.0, 6.0, 6.0, 6.0, 6.0}, wantLabels: eightLabels,
	},
	{
		// D12: utility_damage absent from the corpus's INSERTs → 0.
		name: "career_avg_util_damage", expr: "SELECT :steam_id AS subject_key, '' AS dim, (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN AVG(value) END FROM metric('utility_damage')) AS value",
		scope: "profile", format: "float1", shortName: "Util",
		interpretation: "event-derived over the corpus events (the retired player_stats literal is not the truth)",
		rows:           8, wantValues: []float64{0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0}, wantLabels: eightLabels,
	},
	{
		// D10 (re-pinned, backlog S10): the clutch alive count reads the
		// roster (round_player_sides) and the kill events, not player_ticks.
		// The corpus has 72 clutches under that rule, all lost, so the
		// share is 0 over two subjects.
		name: "career_clutch_win_rate", expr: "SELECT :steam_id AS subject_key, '' AS dim, 1.0 * (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric('match_clutch_wins')) / NULLIF((SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric('clutches')), 0) AS value WHERE EXISTS (SELECT 1 FROM metric('clutches'))",
		scope: "profile", format: "percent", shortName: "CW%",
		interpretation: "share of the player's clutches won (corpus: 72 clutches, none won → 0)",
		rows:           2, wantAll: 0,
	},
	{
		// D4p: same pooled shape as hs_pct at profile scope (the corpus
		// is three identical matches, so pooled == per-match).
		name: "career_hs_pct", expr: "SELECT :steam_id AS subject_key, '' AS dim, 1.0 * (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric('headshots')) / NULLIF((SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric('kills')), 0) AS value",
		scope: "profile", format: "percent", shortName: "HS%",
		interpretation: "event-derived over the corpus events (the retired player_stats literal is not the truth)",
		rows:           8, wantValues: []float64{1.0, 0.0, 1.0, 0.0, 1.0, 0.0, 1.0, 0.0}, wantLabels: eightLabels,
	},
	{
		// D6p: all 72 career rows — same mean as the match seed here
		// (three identical matches), N the career row count.
		name: "career_kast", expr: "SELECT :steam_id AS subject_key, '' AS dim, 1.0 * (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric('match_kast_flags')) / NULLIF((SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric('match_rounds')), 0) AS value WHERE EXISTS (SELECT 1 FROM metric('match_rounds'))",
		scope: "profile", format: "percent", shortName: "KAST%",
		interpretation: "career KAST mean over every stored round (0.5 — 36/72)",
		rows:           8, wantAll: 0.5, wantLabels: eightLabels,
	},
	{
		// D5p: pooled kills/deaths over the whole career — 2 (sums,
		// never a mean of ratios).
		name: "career_kd", expr: "SELECT :steam_id AS subject_key, '' AS dim, 1.0 * (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric('kills')) / NULLIF((SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric('deaths')), 0) AS value",
		scope: "profile", format: "float2", shortName: "K/D",
		interpretation: "event-derived over the corpus events (the retired player_stats literal is not the truth)",
		rows:           8, wantValues: []float64{1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0}, wantLabels: eightLabels,
	},
	{
		// D9: byte-identical expr to trade_rate at PROFILE scope — the
		// cross-scope ref ban forbids referencing the match seed, so the
		// join recomputes from the sources; same numbers here.
		name: "career_trade_rate", expr: "SELECT :steam_id AS subject_key, '' AS dim, 1.0 * (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric('trade_kills')) / NULLIF((SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric('match_trade_opps')), 0) AS value WHERE EXISTS (SELECT 1 FROM metric('trade_kills'))",
		scope: "profile", format: "percent", shortName: "Trade%",
		interpretation: "career trade opportunities ratio (recomputes the join — cross-scope ref ban)",
		rows:           8, wantValues: []float64{0.1, 0.1, 0.1, 0.1, 0.1, 0.1, math.NaN(), math.NaN()},
		wantLabels: eightLabels,
	},
	// ---- inferred set, match scope (27). Corpus math (seed.sql header):
	// the per-match columns the corpus does NOT write default to 0, the
	// per-round flags are exact, and the N of a player_stats-backed seed
	// is the subject's 3 matches.
	{
		name: "assists", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(assists) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.assists, 0) AS assists\n  FROM player_stats ps\n  LEFT JOIN (WITH k AS (\n  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,\n         (e.victim <> '' AND e.attacker = e.victim AND e.weapon = 'World' AND dc.attacker IS NOT NULL) AS fake,\n         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side\n  FROM events e\n  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = 'player_disconnect') dc\n    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick\n  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker\n  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim\n  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister\n  WHERE e.match_id = :match_id AND e.kind = 'kill' AND e.post_match = 0\n),\nek AS (\n  SELECT * FROM k WHERE attacker <> '' AND attacker <> victim AND fake = 0\n    AND NOT (COALESCE(a_side, '') <> '' AND a_side = v_side)\n),\nak AS (\n  SELECT * FROM k WHERE assister <> '' AND assister <> victim AND attacker <> '' AND attacker <> victim AND fake = 0 AND NOT (COALESCE(a_side, '') <> '' AND a_side = v_side) AND NOT (COALESCE(s_side, '') <> '' AND s_side = v_side)\n),\nfold AS (\n    SELECT match_id, assister AS steam_id, 'assists' AS f, COUNT(*) AS n FROM ak WHERE assisted_flash = 0 GROUP BY match_id, assister\n  )\n  SELECT match_id, steam_id, SUM(CASE WHEN f = 'assists' THEN n END) AS assists FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id\n  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "A",
		interpretation: "cross-team assist count (corpus records assists = 0)",
		rows:           8, wantAll: 0, wantLabels: eightLabels,
	},
	{
		name: "flash_assists", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(flash_assists) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.assists, 0) AS assists, COALESCE(f.flash_assists, 0) AS flash_assists\n  FROM player_stats ps\n  LEFT JOIN (WITH k AS (\n  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,\n         (e.victim <> '' AND e.attacker = e.victim AND e.weapon = 'World' AND dc.attacker IS NOT NULL) AS fake,\n         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side\n  FROM events e\n  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = 'player_disconnect') dc\n    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick\n  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker\n  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim\n  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister\n  WHERE e.match_id = :match_id AND e.kind = 'kill' AND e.post_match = 0\n),\nek AS (\n  SELECT * FROM k WHERE attacker <> '' AND attacker <> victim AND fake = 0\n    AND NOT (COALESCE(a_side, '') <> '' AND a_side = v_side)\n),\nak AS (\n  SELECT * FROM k WHERE assister <> '' AND assister <> victim AND attacker <> '' AND attacker <> victim AND fake = 0 AND NOT (COALESCE(a_side, '') <> '' AND a_side = v_side) AND NOT (COALESCE(s_side, '') <> '' AND s_side = v_side)\n),\nfold AS (\n    SELECT match_id, assister AS steam_id, 'assists' AS f, COUNT(*) AS n FROM ak WHERE assisted_flash = 0 GROUP BY match_id, assister\n    UNION ALL SELECT match_id, assister AS steam_id, 'flash_assists' AS f, COUNT(*) AS n FROM ak WHERE assisted_flash = 1 GROUP BY match_id, assister\n  )\n  SELECT match_id, steam_id, SUM(CASE WHEN f = 'assists' THEN n END) AS assists, SUM(CASE WHEN f = 'flash_assists' THEN n END) AS flash_assists FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id\n  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "",
		interpretation: "AssistedFlash-split assists (column absent from the corpus → 0)",
		rows:           8, wantAll: 0, wantLabels: eightLabels,
	},
	{
		name: "enemies_flashed", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(enemies_flashed) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.enemies_flashed, 0) AS enemies_flashed\n  FROM player_stats ps\n  LEFT JOIN (WITH bl AS (\n  SELECT e.match_id, e.attacker, e.victim, sa.side AS a_side, sv.side AS v_side\n  FROM events e\n  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker\n  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim\n  WHERE e.match_id = :match_id AND e.kind = 'blind' AND e.post_match = 0\n),\nfold AS (\n    SELECT match_id, attacker AS steam_id, 'enemies_flashed' AS f, COUNT(*) AS n FROM bl WHERE attacker <> '' AND attacker <> victim AND NOT (COALESCE(a_side, '') <> '' AND a_side = v_side) GROUP BY match_id, attacker\n  )\n  SELECT match_id, steam_id, SUM(CASE WHEN f = 'enemies_flashed' THEN n END) AS enemies_flashed FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id\n  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "",
		interpretation: "blinded enemies (column absent from the corpus → 0)",
		rows:           8, wantAll: 0, wantLabels: eightLabels,
	},
	{
		name: "entry_kills", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(entry_kills) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.kills, 0) AS kills\n  FROM player_stats ps\n  LEFT JOIN (WITH k AS (\n  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,\n         (e.victim <> '' AND e.attacker = e.victim AND e.weapon = 'World' AND dc.attacker IS NOT NULL) AS fake,\n         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side\n  FROM events e\n  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = 'player_disconnect') dc\n    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick\n  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker\n  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim\n  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister\n  WHERE e.match_id = :match_id AND e.kind = 'kill' AND e.post_match = 0\n),\nek AS (\n  SELECT * FROM k WHERE attacker <> '' AND attacker <> victim AND fake = 0\n    AND NOT (COALESCE(a_side, '') <> '' AND a_side = v_side)\n),\nfold AS (\n    SELECT match_id, attacker AS steam_id, 'kills' AS f, COUNT(*) AS n FROM ek GROUP BY match_id, attacker\n  )\n  SELECT match_id, steam_id, SUM(CASE WHEN f = 'kills' THEN n END) AS kills FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id\n  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "Open K",
		interpretation: "first bloods (corpus: entry_kills = i per match × 3 matches = 3i — the 2026-11-18 swap of the retired opening_kills column)",
		rows:           8, wantValues: []float64{3, 6, 9, 12, 15, 18, 21, 24}, wantLabels: eightLabels,
	},
	{
		name: "entry_deaths", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(entry_deaths) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.deaths, 0) AS deaths\n  FROM player_stats ps\n  LEFT JOIN (WITH k AS (\n  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,\n         (e.victim <> '' AND e.attacker = e.victim AND e.weapon = 'World' AND dc.attacker IS NOT NULL) AS fake,\n         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side\n  FROM events e\n  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = 'player_disconnect') dc\n    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick\n  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker\n  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim\n  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister\n  WHERE e.match_id = :match_id AND e.kind = 'kill' AND e.post_match = 0\n),\nek AS (\n  SELECT * FROM k WHERE attacker <> '' AND attacker <> victim AND fake = 0\n    AND NOT (COALESCE(a_side, '') <> '' AND a_side = v_side)\n),\nfold AS (\n    SELECT match_id, victim AS steam_id, 'deaths' AS f, COUNT(*) AS n FROM k WHERE victim <> '' AND fake = 0 GROUP BY match_id, victim\n  )\n  SELECT match_id, steam_id, SUM(CASE WHEN f = 'deaths' THEN n END) AS deaths FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id\n  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "Open D",
		interpretation: "first-blood victims (column absent → 0)",
		rows:           8, wantAll: 0, wantLabels: eightLabels,
	},
	{
		name: "best_streak", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, MAX(best_streak) AS v FROM player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "Streak",
		interpretation: "longest streak (column absent → 0); one player_stats row per subject-match, so max == the stored value",
		rows:           8, wantAll: 0, wantLabels: eightLabels,
	},
	{
		name: "two_k", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(two_k) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.two_k, 0) AS two_k\n  FROM player_stats ps\n  LEFT JOIN (WITH k AS (\n  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,\n         (e.victim <> '' AND e.attacker = e.victim AND e.weapon = 'World' AND dc.attacker IS NOT NULL) AS fake,\n         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side\n  FROM events e\n  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = 'player_disconnect') dc\n    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick\n  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker\n  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim\n  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister\n  WHERE e.match_id = :match_id AND e.kind = 'kill' AND e.post_match = 0\n),\nek AS (\n  SELECT * FROM k WHERE attacker <> '' AND attacker <> victim AND fake = 0\n    AND NOT (COALESCE(a_side, '') <> '' AND a_side = v_side)\n),\nekr AS (\n  SELECT match_id, round, attacker, COUNT(*) AS c FROM ek GROUP BY match_id, round, attacker\n),\nfold AS (\n    SELECT match_id, attacker AS steam_id, 'two_k' AS f, SUM(CASE WHEN c = 2 THEN 1 ELSE 0 END) AS n FROM ekr GROUP BY match_id, attacker\n  )\n  SELECT match_id, steam_id, SUM(CASE WHEN f = 'two_k' THEN n END) AS two_k FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id\n  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "2K",
		interpretation: "rounds with exactly 2 kills (column absent → 0)",
		rows:           8, wantAll: 0, wantLabels: eightLabels,
	},
	{
		name: "three_k", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(three_k) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.three_k, 0) AS three_k\n  FROM player_stats ps\n  LEFT JOIN (WITH k AS (\n  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,\n         (e.victim <> '' AND e.attacker = e.victim AND e.weapon = 'World' AND dc.attacker IS NOT NULL) AS fake,\n         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side\n  FROM events e\n  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = 'player_disconnect') dc\n    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick\n  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker\n  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim\n  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister\n  WHERE e.match_id = :match_id AND e.kind = 'kill' AND e.post_match = 0\n),\nek AS (\n  SELECT * FROM k WHERE attacker <> '' AND attacker <> victim AND fake = 0\n    AND NOT (COALESCE(a_side, '') <> '' AND a_side = v_side)\n),\nekr AS (\n  SELECT match_id, round, attacker, COUNT(*) AS c FROM ek GROUP BY match_id, round, attacker\n),\nfold AS (\n    SELECT match_id, attacker AS steam_id, 'three_k' AS f, SUM(CASE WHEN c = 3 THEN 1 ELSE 0 END) AS n FROM ekr GROUP BY match_id, attacker\n  )\n  SELECT match_id, steam_id, SUM(CASE WHEN f = 'three_k' THEN n END) AS three_k FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id\n  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "3K",
		interpretation: "rounds with exactly 3 kills (column absent → 0)",
		rows:           8, wantAll: 0, wantLabels: eightLabels,
	},
	{
		name: "four_k", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(four_k) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.four_k, 0) AS four_k\n  FROM player_stats ps\n  LEFT JOIN (WITH k AS (\n  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,\n         (e.victim <> '' AND e.attacker = e.victim AND e.weapon = 'World' AND dc.attacker IS NOT NULL) AS fake,\n         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side\n  FROM events e\n  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = 'player_disconnect') dc\n    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick\n  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker\n  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim\n  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister\n  WHERE e.match_id = :match_id AND e.kind = 'kill' AND e.post_match = 0\n),\nek AS (\n  SELECT * FROM k WHERE attacker <> '' AND attacker <> victim AND fake = 0\n    AND NOT (COALESCE(a_side, '') <> '' AND a_side = v_side)\n),\nekr AS (\n  SELECT match_id, round, attacker, COUNT(*) AS c FROM ek GROUP BY match_id, round, attacker\n),\nfold AS (\n    SELECT match_id, attacker AS steam_id, 'four_k' AS f, SUM(CASE WHEN c = 4 THEN 1 ELSE 0 END) AS n FROM ekr GROUP BY match_id, attacker\n  )\n  SELECT match_id, steam_id, SUM(CASE WHEN f = 'four_k' THEN n END) AS four_k FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id\n  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "4K",
		interpretation: "rounds with exactly 4 kills (column absent → 0)",
		rows:           8, wantAll: 0, wantLabels: eightLabels,
	},
	{
		name: "five_k", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(five_k) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.five_k, 0) AS five_k\n  FROM player_stats ps\n  LEFT JOIN (WITH k AS (\n  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,\n         (e.victim <> '' AND e.attacker = e.victim AND e.weapon = 'World' AND dc.attacker IS NOT NULL) AS fake,\n         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side\n  FROM events e\n  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = 'player_disconnect') dc\n    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick\n  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker\n  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim\n  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister\n  WHERE e.match_id = :match_id AND e.kind = 'kill' AND e.post_match = 0\n),\nek AS (\n  SELECT * FROM k WHERE attacker <> '' AND attacker <> victim AND fake = 0\n    AND NOT (COALESCE(a_side, '') <> '' AND a_side = v_side)\n),\nekr AS (\n  SELECT match_id, round, attacker, COUNT(*) AS c FROM ek GROUP BY match_id, round, attacker\n),\nfold AS (\n    SELECT match_id, attacker AS steam_id, 'five_k' AS f, SUM(CASE WHEN c >= 5 THEN 1 ELSE 0 END) AS n FROM ekr GROUP BY match_id, attacker\n  )\n  SELECT match_id, steam_id, SUM(CASE WHEN f = 'five_k' THEN n END) AS five_k FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id\n  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "5K",
		interpretation: "rounds with exactly 5 kills (column absent → 0)",
		rows:           8, wantAll: 0, wantLabels: eightLabels,
	},
	{
		// The corpus writes assists = 0 in every player_round_stats row.
		name: "rounds_with_assist", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(CASE WHEN (assists > 0) THEN 1 ELSE 0 END) AS v FROM (SELECT prs.match_id, prs.round, prs.steam_id, prs.name, prs.traded, prs.kast, prs.money_start, prs.equip, prs.spent, prs.rule_version, prs.side, COALESCE(f.assists, 0) AS assists\n  FROM player_round_stats prs\n  LEFT JOIN (WITH k AS (\n  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.assisted_flash,\n         (e.victim <> '' AND e.attacker = e.victim AND e.weapon = 'World' AND dc.attacker IS NOT NULL) AS fake,\n         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side\n  FROM events e\n  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = 'player_disconnect') dc\n    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick\n  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker\n  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim\n  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister\n  WHERE e.match_id = :match_id AND e.kind = 'kill' AND e.post_match = 0\n),\nek AS (\n  SELECT * FROM k WHERE attacker <> '' AND attacker <> victim AND fake = 0\n    AND NOT (COALESCE(a_side, '') <> '' AND a_side = v_side)\n),\nak AS (\n  SELECT * FROM k WHERE assister <> '' AND assister <> victim AND attacker <> '' AND attacker <> victim\n    AND fake = 0 AND assisted_flash = 0\n    AND NOT (COALESCE(a_side, '') <> '' AND a_side = v_side)\n    AND NOT (COALESCE(s_side, '') <> '' AND s_side = v_side)\n),\nfold AS (\n    SELECT match_id, round, assister AS steam_id, 'assists' AS f, COUNT(*) AS n FROM ak GROUP BY match_id, round, assister\n  )\n  SELECT match_id, round, steam_id, SUM(CASE WHEN f = 'assists' THEN n END) AS assists FROM fold GROUP BY match_id, round, steam_id) f ON f.match_id = prs.match_id AND f.round = prs.round AND f.steam_id = prs.steam_id\n  WHERE prs.match_id = :match_id) player_round_stats WHERE player_round_stats.match_id = :match_id AND (steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_round_stats.match_id AND p.steam_id = player_round_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "",
		interpretation: "rounds with ≥1 assist (the KAST A component as a count — corpus: 0)",
		rows:           8, wantAll: 0, wantLabels: eightLabels,
	},
	{
		// traded iff the player died and the round ≤ 12 → 3 per match
		// (seed.sql header) → 9 over the three identical matches.
		name: "rounds_traded", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(traded) AS v FROM player_round_stats WHERE player_round_stats.match_id = :match_id AND (steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_round_stats.match_id AND p.steam_id = player_round_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "",
		interpretation: "the player's traded deaths (the KAST T flag; corpus: 3/match × 3)",
		rows:           8, wantAll: 9, wantLabels: eightLabels,
	},
	{
		// trade_kills = i per match for player i (1..8) → library 3i.
		name: "trade_kills", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(trade_kills) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.kills, 0) AS kills\n  FROM player_stats ps\n  LEFT JOIN (WITH k AS (\n  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,\n         (e.victim <> '' AND e.attacker = e.victim AND e.weapon = 'World' AND dc.attacker IS NOT NULL) AS fake,\n         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side\n  FROM events e\n  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = 'player_disconnect') dc\n    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick\n  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker\n  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim\n  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister\n  WHERE e.match_id = :match_id AND e.kind = 'kill' AND e.post_match = 0\n),\nek AS (\n  SELECT * FROM k WHERE attacker <> '' AND attacker <> victim AND fake = 0\n    AND NOT (COALESCE(a_side, '') <> '' AND a_side = v_side)\n),\nfold AS (\n    SELECT match_id, attacker AS steam_id, 'kills' AS f, COUNT(*) AS n FROM ek GROUP BY match_id, attacker\n  )\n  SELECT match_id, steam_id, SUM(CASE WHEN f = 'kills' THEN n END) AS kills FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id\n  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "Trade",
		interpretation: "stored trade-kill count (corpus: 3i)",
		rows:           8, wantValues: []float64{3, 6, 9, 12, 15, 18, 21, 24},
		wantLabels: eightLabels,
	},
	{
		// missed = i per match for i ≤ 6, Grace stored-zero, Heidi
		// absent (LEFT JOIN → NULL → 0 beside N), exactly like
		// TestJoinedAcceptanceRatio's opps side.
		name: "missed_trades", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT player_stats.match_id AS mid, player_stats.steam_id AS grp, SUM(match_trade_opps.missed) AS v FROM player_stats LEFT JOIN match_trade_opps ON player_stats.match_id = match_trade_opps.match_id AND player_stats.steam_id = match_trade_opps.steam_id WHERE player_stats.match_id = :match_id AND (player_stats.steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "",
		interpretation: "missed trade opps over the player_stats-anchored LEFT JOIN (corpus: 3i / 0 / 0)",
		rows:           8, wantValues: []float64{3, 6, 9, 12, 15, 18, 0, 0},
		wantLabels: eightLabels,
	},
	{
		// kill tags: 1 opening + 1 trade + 1 untraded per round over
		// 8 players; the subject's N is its own a_steam rows (36/18
		// alternating), so N is deliberately not asserted.
		name: "kill_tag_opening", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, a_steam AS grp, SUM(CASE WHEN (kind = 'opening') THEN 1 ELSE 0 END) AS v FROM kill_tags WHERE kill_tags.match_id = :match_id AND (a_steam <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = kill_tags.match_id AND p.steam_id = kill_tags.a_steam AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "",
		interpretation: "opening duels with the subject as A-side (corpus: 18/0 alternating)",
		rows:           8, wantValues: []float64{18, 0, 18, 0, 0, 18, 0, 18},
		wantLabels: eightLabels,
	},
	{
		name: "kill_tag_trade", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, a_steam AS grp, SUM(CASE WHEN (kind = 'trade') THEN 1 ELSE 0 END) AS v FROM kill_tags WHERE kill_tags.match_id = :match_id AND (a_steam <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = kill_tags.match_id AND p.steam_id = kill_tags.a_steam AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "",
		interpretation: "strict-window trades, A-side (corpus: the opening pattern's complement)",
		rows:           8, wantValues: []float64{0, 18, 0, 18, 18, 0, 18, 0},
		wantLabels: eightLabels,
	},
	{
		name: "kill_tag_traded", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, a_steam AS grp, SUM(CASE WHEN (kind = 'traded') THEN 1 ELSE 0 END) AS v FROM kill_tags WHERE kill_tags.match_id = :match_id AND (a_steam <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = kill_tags.match_id AND p.steam_id = kill_tags.a_steam AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "",
		interpretation: "A-side kills that got answered — the corpus records NO traded rows (the traded FLAG lives on player_round_stats)",
		rows:           8, wantAll: 0, wantLabels: eightLabels,
	},
	{
		name: "kill_tag_untraded", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, a_steam AS grp, SUM(CASE WHEN (kind = 'untraded') THEN 1 ELSE 0 END) AS v FROM kill_tags WHERE kill_tags.match_id = :match_id AND (a_steam <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = kill_tags.match_id AND p.steam_id = kill_tags.a_steam AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "",
		interpretation: "A-side kills nobody answered (corpus: 18/0 alternating)",
		rows:           8, wantValues: []float64{18, 0, 18, 0, 0, 18, 0, 18},
		wantLabels: eightLabels,
	},
	{
		// The clutch family reads the roster rule (backlog S10). The corpus
		// has 72 clutches under it (none won); the match-scope seeds below are
		// run per match and not row-pinned here.
		name: "clutches", expr: store.ClutchCTE() + " SELECT c.steam_id AS subject_key, '' AS dim, COUNT(*) AS value FROM clutch c WHERE c.steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = :match_id AND p.steam_id = c.steam_id AND p.is_bot = 1) GROUP BY c.steam_id",
		scope: "match", format: "int", shortName: "",
		interpretation: "1vN attempt count (corpus: 72 clutches under the roster rule)",
		rows:           0,
	},
	{
		name: "clutch_win_rate", expr: store.ClutchCTE() + " SELECT c.steam_id AS subject_key, '' AS dim, AVG(c.won) AS value FROM clutch c WHERE c.steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = :match_id AND p.steam_id = c.steam_id AND p.is_bot = 1) GROUP BY c.steam_id",
		scope: "match", format: "percent", shortName: "",
		interpretation: "share of clutches won (corpus: 72 clutches under the roster rule)",
		rows:           0,
	},
	{
		name: "clutch_avg_size", expr: store.ClutchCTE() + " SELECT c.steam_id AS subject_key, '' AS dim, AVG(c.size) AS value FROM clutch c WHERE c.steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = :match_id AND p.steam_id = c.steam_id AND p.is_bot = 1) GROUP BY c.steam_id",
		scope: "match", format: "float1", shortName: "",
		interpretation: "mean clutch size (corpus: 72 clutches under the roster rule)",
		rows:           0,
	},
	{
		name: "clutch_avg_hp", expr: store.ClutchCTE() + " SELECT c.steam_id AS subject_key, '' AS dim, AVG(c.hp_left) AS value FROM clutch c WHERE c.steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = :match_id AND p.steam_id = c.steam_id AND p.is_bot = 1) GROUP BY c.steam_id",
		scope: "match", format: "float1", shortName: "",
		interpretation: "mean ending HP (corpus: 72 clutches under the roster rule)",
		rows:           0,
	},
	{
		name: "clutch_avg_equip", expr: store.ClutchCTE() + " SELECT c.steam_id AS subject_key, '' AS dim, AVG(c.equip) AS value FROM clutch c WHERE c.steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = :match_id AND p.steam_id = c.steam_id AND p.is_bot = 1) GROUP BY c.steam_id",
		scope: "match", format: "currency", shortName: "",
		interpretation: "mean held equipment value (corpus: 72 clutches under the roster rule)",
		rows:           0,
	},
	{
		// utility_events: 216 rows over 8 subjects (3 matches × 24
		// rounds × 1 detonation of each of 3 kinds ÷ 8) → 27 each.
		name: "util_nades", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, thrower AS grp, COUNT(*) AS v FROM utility_events WHERE utility_events.match_id = :match_id AND (thrower <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = utility_events.match_id AND p.steam_id = utility_events.thrower AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "",
		interpretation: "detonation count (corpus: 27 per subject)",
		rows:           8, wantAll: 27, wantLabels: eightLabels,
	},
	{
		name: "util_dmg", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, thrower AS grp, SUM(damage) AS v FROM utility_events WHERE utility_events.match_id = :match_id AND (thrower <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = utility_events.match_id AND p.steam_id = utility_events.thrower AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "",
		interpretation: "paired detonation damage (corpus: 180 per subject)",
		rows:           8, wantAll: 180, wantLabels: eightLabels,
	},
	{
		name: "util_flash_ms", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, thrower AS grp, SUM(flash_ms) AS v FROM utility_events WHERE utility_events.match_id = :match_id AND (thrower <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = utility_events.match_id AND p.steam_id = utility_events.thrower AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "",
		interpretation: "paired blind milliseconds (corpus: 5400 per subject)",
		rows:           8, wantAll: 5400, wantLabels: eightLabels,
	},
	{
		// No weapon_drop events in the corpus → value 0; the subject's N
		// is its own event count (270/234 alternating) → not asserted.
		name: "weapon_drops", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, attacker AS grp, SUM(CASE WHEN (kind = 'weapon_drop') THEN 1 ELSE 0 END) AS v FROM events WHERE events.match_id = :match_id AND (attacker <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = events.match_id AND p.steam_id = events.attacker AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "",
		interpretation: "death-drop count (corpus: none recorded)",
		rows:           8, wantAll: 0, wantLabels: eightLabels,
	},
	// ---- inferred set, T2 (10): the corpus writes NEITHER LABEL nor
	// CLASS table (round_classifications / round_side_classes are
	// empty), so every label/class count is 0 over a LEFT JOIN that
	// keeps all 72 player-rounds (N). round_player_sides now ships
	// FILLED for every match (testdata/seed.sql — the side-split
	// oracle needs it), so the side_class_* primaries produce their
	// 8 groups per library-scope preview instead of no rows at all —
	// the value-acceptance rig with INSERTed class rows lives in
	// join_test.go TestJoinedClassificationValues.
	{
		name: "round_label_eco", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT player_round_stats.match_id AS mid, player_round_stats.steam_id AS grp, SUM(CASE WHEN (round_classifications.label = 'eco') THEN 1 ELSE 0 END) AS v FROM player_round_stats LEFT JOIN round_classifications ON player_round_stats.match_id = round_classifications.match_id AND player_round_stats.round = round_classifications.round WHERE player_round_stats.match_id = :match_id AND (player_round_stats.steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_round_stats.match_id AND p.steam_id = player_round_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "",
		interpretation: "rounds labeled eco (empty secondary → 0 beside N = the primary's rounds)",
		rows:           8, wantAll: 0, wantLabels: eightLabels,
	},
	{
		name: "round_label_force", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT player_round_stats.match_id AS mid, player_round_stats.steam_id AS grp, SUM(CASE WHEN (round_classifications.label = 'force') THEN 1 ELSE 0 END) AS v FROM player_round_stats LEFT JOIN round_classifications ON player_round_stats.match_id = round_classifications.match_id AND player_round_stats.round = round_classifications.round WHERE player_round_stats.match_id = :match_id AND (player_round_stats.steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_round_stats.match_id AND p.steam_id = player_round_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "",
		interpretation: "rounds labeled force (empty secondary → 0)",
		rows:           8, wantAll: 0, wantLabels: eightLabels,
	},
	{
		name: "round_label_full", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT player_round_stats.match_id AS mid, player_round_stats.steam_id AS grp, SUM(CASE WHEN (round_classifications.label = 'full') THEN 1 ELSE 0 END) AS v FROM player_round_stats LEFT JOIN round_classifications ON player_round_stats.match_id = round_classifications.match_id AND player_round_stats.round = round_classifications.round WHERE player_round_stats.match_id = :match_id AND (player_round_stats.steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_round_stats.match_id AND p.steam_id = player_round_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "",
		interpretation: "rounds labeled full (empty secondary → 0)",
		rows:           8, wantAll: 0, wantLabels: eightLabels,
	},
	{
		name: "round_label_save", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT player_round_stats.match_id AS mid, player_round_stats.steam_id AS grp, SUM(CASE WHEN (round_classifications.label = 'save') THEN 1 ELSE 0 END) AS v FROM player_round_stats LEFT JOIN round_classifications ON player_round_stats.match_id = round_classifications.match_id AND player_round_stats.round = round_classifications.round WHERE player_round_stats.match_id = :match_id AND (player_round_stats.steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_round_stats.match_id AND p.steam_id = player_round_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "",
		interpretation: "rounds labeled save (empty secondary → 0)",
		rows:           8, wantAll: 0, wantLabels: eightLabels,
	},
	{
		name: "pistol_rounds", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT player_round_stats.match_id AS mid, player_round_stats.steam_id AS grp, SUM(CASE WHEN (round_classifications.label = 'pistol') THEN 1 ELSE 0 END) AS v FROM player_round_stats LEFT JOIN round_classifications ON player_round_stats.match_id = round_classifications.match_id AND player_round_stats.round = round_classifications.round WHERE player_round_stats.match_id = :match_id AND (player_round_stats.steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_round_stats.match_id AND p.steam_id = player_round_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "",
		interpretation: "rounds carrying the stored pistol label (empty secondary → 0)",
		rows:           8, wantAll: 0, wantLabels: eightLabels,
	},
	{
		// The corpus's class rows live in matches 2-3 only (rounds 2-4,
		// both sides, class 'force' — the seed.sql extension comment):
		// match 1 contributes 0 force rounds, matches 2-3 contribute 3
		// each → 6 per player over the library-scope preview, N = the
		// 72 side-sample rows behind them.
		name: "side_class_eco", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT round_player_sides.match_id AS mid, round_player_sides.steam_id AS grp, SUM(CASE WHEN (round_side_classes.class = 'eco') THEN 1 ELSE 0 END) AS v FROM round_player_sides LEFT JOIN round_side_classes ON round_player_sides.match_id = round_side_classes.match_id AND round_player_sides.round = round_side_classes.round AND round_player_sides.side = round_side_classes.side WHERE round_player_sides.match_id = :match_id AND (round_player_sides.steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = round_player_sides.match_id AND p.steam_id = round_player_sides.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "",
		interpretation: "rounds played on an eco-classified side (class rows are force-only → 0 beside N)",
		rows:           8, wantAll: 0,
	},
	{
		name: "side_class_force", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT round_player_sides.match_id AS mid, round_player_sides.steam_id AS grp, SUM(CASE WHEN (round_side_classes.class = 'force') THEN 1 ELSE 0 END) AS v FROM round_player_sides LEFT JOIN round_side_classes ON round_player_sides.match_id = round_side_classes.match_id AND round_player_sides.round = round_side_classes.round AND round_player_sides.side = round_side_classes.side WHERE round_player_sides.match_id = :match_id AND (round_player_sides.steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = round_player_sides.match_id AND p.steam_id = round_player_sides.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "",
		interpretation: "rounds played on a force-classified side (0 + 3 + 3 across the three matches)",
		rows:           8, wantAll: 6,
	},
	{
		name: "side_class_full", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT round_player_sides.match_id AS mid, round_player_sides.steam_id AS grp, SUM(CASE WHEN (round_side_classes.class = 'full') THEN 1 ELSE 0 END) AS v FROM round_player_sides LEFT JOIN round_side_classes ON round_player_sides.match_id = round_side_classes.match_id AND round_player_sides.round = round_side_classes.round AND round_player_sides.side = round_side_classes.side WHERE round_player_sides.match_id = :match_id AND (round_player_sides.steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = round_player_sides.match_id AND p.steam_id = round_player_sides.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "",
		interpretation: "rounds played on a full-buy side (force-only class rows → 0 beside N)",
		rows:           8, wantAll: 0,
	},
	{
		name: "side_class_save", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT round_player_sides.match_id AS mid, round_player_sides.steam_id AS grp, SUM(CASE WHEN (round_side_classes.class = 'save') THEN 1 ELSE 0 END) AS v FROM round_player_sides LEFT JOIN round_side_classes ON round_player_sides.match_id = round_side_classes.match_id AND round_player_sides.round = round_side_classes.round AND round_player_sides.side = round_side_classes.side WHERE round_player_sides.match_id = :match_id AND (round_player_sides.steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = round_player_sides.match_id AND p.steam_id = round_player_sides.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "",
		interpretation: "rounds played on a save side (force-only class rows → 0 beside N)",
		rows:           8, wantAll: 0,
	},
	{
		name: "side_class_pistol", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT round_player_sides.match_id AS mid, round_player_sides.steam_id AS grp, SUM(CASE WHEN (round_side_classes.class = 'pistol') THEN 1 ELSE 0 END) AS v FROM round_player_sides LEFT JOIN round_side_classes ON round_player_sides.match_id = round_side_classes.match_id AND round_player_sides.round = round_side_classes.round AND round_player_sides.side = round_side_classes.side WHERE round_player_sides.match_id = :match_id AND (round_player_sides.steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = round_player_sides.match_id AND p.steam_id = round_player_sides.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "",
		interpretation: "rounds played on a pistol-classified side (force-only class rows → 0 beside N)",
		rows:           8, wantAll: 0,
	},
	// ---- inferred set, profile scope (1).
	{
		name: "career_clutches", expr: "SELECT :steam_id AS subject_key, '' AS dim, (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric('clutches')) AS value WHERE EXISTS (SELECT 1 FROM metric('clutches'))",
		scope: "profile", format: "int", shortName: "",
		interpretation: "career 1vN count (corpus: 36 clutches per player under the roster rule)",
		rows:           2, wantAll: 36,
	},
	// ---- addendum: the opening-duel trio (profile) + the victim-side
	// duel count (match).
	{
		// entry_kills = i per match (the 2026-11-18 swap of the
		// retired opening_kills column), entry_deaths absent → the
		// denominator equals the numerator, so the rate is exactly 1.
		// The exprs re-pointed opening_* → entry_* with these same
		// values — zero number movement.
		name: "career_opening_rate", expr: "SELECT :steam_id AS subject_key, '' AS dim, 1.0 * (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric('entry_kills')) / NULLIF((SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric('entry_kills')) + (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric('entry_deaths')), 0) AS value WHERE EXISTS (SELECT 1 FROM metric('entry_kills'))",
		scope: "profile", format: "percent", shortName: "",
		interpretation: "career first-blood duel win share (corpus records no entry deaths → 1.0)",
		rows:           8, wantAll: 1, wantLabels: eightLabels,
	},
	{
		name: "career_openings", expr: "SELECT :steam_id AS subject_key, '' AS dim, (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric('entry_kills')) + (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric('entry_deaths')) AS value WHERE EXISTS (SELECT 1 FROM metric('entry_kills'))",
		scope: "profile", format: "int", shortName: "",
		interpretation: "career opening duels (corpus: 3i)",
		rows:           8, wantValues: []float64{3, 6, 9, 12, 15, 18, 21, 24},
		wantLabels: eightLabels,
	},
	{
		name: "career_opener_wins", expr: "SELECT :steam_id AS subject_key, '' AS dim, (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric('entry_kills')) AS value WHERE EXISTS (SELECT 1 FROM metric('entry_kills'))",
		scope: "profile", format: "int", shortName: "",
		interpretation: "career opening kills (corpus: 3i)",
		rows:           8, wantValues: []float64{3, 6, 9, 12, 15, 18, 21, 24},
		wantLabels: eightLabels,
	},
	{
		// addendum: the victim-side count — the SAME untraded rows read
		// through kill_tags_victim (subject b_steam). Every corpus
		// player appears as a victim (so 8 rows; 4 of them with value
		// 18, the other 4 with 0 — rows with no untraded duel, never a
		// missing row), and the per-subject N is that victim's own
		// kill tag rows (18/36 alternating) → not asserted.
		name: "untraded_deaths", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, b_steam AS grp, SUM(CASE WHEN (kind = 'untraded') THEN 1 ELSE 0 END) AS v FROM kill_tags AS kill_tags_victim WHERE kill_tags_victim.match_id = :match_id AND (b_steam <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = kill_tags_victim.match_id AND p.steam_id = kill_tags_victim.b_steam AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "",
		interpretation: "unanswered deaths (b_steam side; corpus: 0,18,0,18,18,0,18,0)",
		rows:           8, wantValues: []float64{0, 18, 0, 18, 18, 0, 18, 0},
		wantLabels: eightLabels,
	},
	// ---- addendum: the M3 combat-damage conversions (match) —
	// plan §7 M3/§8, the 2026-11-17 re-pin (EIGHTY-THREE builtins /
	// 64 match + 19 profile after the same day's owner Option A
	// count-addendum extension).
	{
		// The corpus's damage and kill rows never share a tick (kills
		// at round*3000+{0..40}, damage at +{100..119}), so NOTHING
		// converts: every damage point is unconverted damage. Per
		// subject the corpus deals 9900 damage over the three
		// identical matches (3 × 3300: each player holds each damage
		// position three times). The corpus's events carry no
		// same_side stamp (DEFAULT 0 = enemy/unknown), so the wave-B
		// enemy gate changes nothing here — 9900 stands. N (the
		// subject's own event rows — the kill/blind distribution is
		// not uniform across subjects) is deliberately not asserted
		// not asserted, like untraded_deaths above; the ME0 value
		// semantics pin in combat_equivalence_test.go.
		name:  "dmg_no_kill",
		expr:  "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT events.match_id AS mid, events.attacker AS grp, SUM(CASE WHEN ((events.kind = 'damage' AND events.post_match = 0) AND (NOT EXISTS (SELECT 1 FROM events AS x0 WHERE x0.match_id = events.match_id AND x0.kind = 'kill' AND x0.post_match = 0 AND x0.tick = events.tick AND x0.attacker = events.attacker AND x0.victim = events.victim)) AND (NOT (COALESCE(pa.side, '') <> '' AND COALESCE(pa.side, '') = COALESCE(pv.side, '')))) THEN events.dmg END) AS v FROM events LEFT JOIN round_player_sides AS pa ON pa.match_id = events.match_id AND pa.round = events.round AND pa.steam_id = events.attacker LEFT JOIN round_player_sides AS pv ON pv.match_id = events.match_id AND pv.round = events.round AND pv.steam_id = events.victim WHERE events.match_id = :match_id AND (events.attacker <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = events.match_id AND p.steam_id = events.attacker AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "",
		interpretation: "enemy damage that never converted into a kill (corpus: no shared tick → all damage, 9900)",
		rows:           8, wantAll: 9900, wantLabels: eightLabels,
	},
	{
		// Same corpus truth from the other side: the converted half
		// sums to 0 for everyone, so the ratio is exactly 0 (a real
		// 0 beside N — the denominator never vanishes). The wave-B
		// enemy gate sits in BOTH halves of the ratio and is a no-op
		// on this side-less corpus (every row stamps DEFAULT 0).
		// The interesting conversion semantics (same-tick actor pair)
		// are pinned in combat_equivalence_test.go against the
		// retired SQL's gated values.
		name:  "kill_conversion",
		expr:  "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT events.match_id AS mid, events.attacker AS grp, 1.0*(SUM(CASE WHEN ((events.kind = 'damage' AND events.post_match = 0) AND EXISTS (SELECT 1 FROM events AS x0 WHERE x0.match_id = events.match_id AND x0.kind = 'kill' AND x0.post_match = 0 AND x0.tick = events.tick AND x0.attacker = events.attacker AND x0.victim = events.victim) AND (NOT (COALESCE(pa.side, '') <> '' AND COALESCE(pa.side, '') = COALESCE(pv.side, '')))) THEN events.dmg END)) / NULLIF((SUM(CASE WHEN ((events.kind = 'damage' AND events.post_match = 0) AND (NOT (COALESCE(pa.side, '') <> '' AND COALESCE(pa.side, '') = COALESCE(pv.side, '')))) THEN events.dmg END)), 0) AS v FROM events LEFT JOIN round_player_sides AS pa ON pa.match_id = events.match_id AND pa.round = events.round AND pa.steam_id = events.attacker LEFT JOIN round_player_sides AS pv ON pv.match_id = events.match_id AND pv.round = events.round AND pv.steam_id = events.victim WHERE events.match_id = :match_id AND (events.attacker <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = events.match_id AND p.steam_id = events.attacker AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "percent", shortName: "",
		interpretation: "share of this player's enemy damage that converts into kills (corpus: 0 — no shared tick)",
		rows:           8, wantAll: 0, wantLabels: eightLabels,
	},
	// ---- addendum: the Option A count addendum (16 match + 6 profile
	// rows) — owner Option A extension, 2026-11-17 (EIGHTY-THREE
	// builtins / 64 match + 19 profile; the plan's §8 does not list
	// these — an owner amendment). Corpus math: player_stats carries
	// kills = 2i, deaths = i, headshots = i, mvps = 1, total_damage =
	// 100i, damage_taken = 50i, rounds_played = 24, money_spent_total =
	// 150000 per match per player; teamkills/suicides/shots/hits/
	// flashed_times/bomb_plants/bomb_defuses/utility_damage are absent
	// → 0 (schema DEFAULT), every sum N = the 3 player_stats rows.
	{
		name: "kills", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(kills) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.kills, 0) AS kills\n  FROM player_stats ps\n  LEFT JOIN (WITH k AS (\n  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,\n         (e.victim <> '' AND e.attacker = e.victim AND e.weapon = 'World' AND dc.attacker IS NOT NULL) AS fake,\n         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side\n  FROM events e\n  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = 'player_disconnect') dc\n    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick\n  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker\n  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim\n  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister\n  WHERE e.match_id = :match_id AND e.kind = 'kill' AND e.post_match = 0\n),\nek AS (\n  SELECT * FROM k WHERE attacker <> '' AND attacker <> victim AND fake = 0\n    AND NOT (COALESCE(a_side, '') <> '' AND a_side = v_side)\n),\nfold AS (\n    SELECT match_id, attacker AS steam_id, 'kills' AS f, COUNT(*) AS n FROM ek GROUP BY match_id, attacker\n  )\n  SELECT match_id, steam_id, SUM(CASE WHEN f = 'kills' THEN n END) AS kills FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id\n  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "K",
		interpretation: "kill count (corpus: 6i over the three identical matches)",
		rows:           8, wantValues: []float64{6, 12, 18, 24, 30, 36, 42, 48}, wantLabels: eightLabels,
	},
	{
		name: "deaths", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(deaths) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.deaths, 0) AS deaths\n  FROM player_stats ps\n  LEFT JOIN (WITH k AS (\n  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,\n         (e.victim <> '' AND e.attacker = e.victim AND e.weapon = 'World' AND dc.attacker IS NOT NULL) AS fake,\n         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side\n  FROM events e\n  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = 'player_disconnect') dc\n    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick\n  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker\n  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim\n  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister\n  WHERE e.match_id = :match_id AND e.kind = 'kill' AND e.post_match = 0\n),\nek AS (\n  SELECT * FROM k WHERE attacker <> '' AND attacker <> victim AND fake = 0\n    AND NOT (COALESCE(a_side, '') <> '' AND a_side = v_side)\n),\nfold AS (\n    SELECT match_id, victim AS steam_id, 'deaths' AS f, COUNT(*) AS n FROM k WHERE victim <> '' AND fake = 0 GROUP BY match_id, victim\n  )\n  SELECT match_id, steam_id, SUM(CASE WHEN f = 'deaths' THEN n END) AS deaths FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id\n  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "D",
		interpretation: "death count (corpus: 3i)",
		rows:           8, wantValues: []float64{3, 6, 9, 12, 15, 18, 21, 24}, wantLabels: eightLabels,
	},
	{
		name: "mvps", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(mvps) AS v FROM player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "MVPs",
		interpretation: "MVP award count (corpus: 1 per match → 3)",
		rows:           8, wantAll: 3, wantLabels: eightLabels,
	},
	{
		name: "total_damage", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(total_damage) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.total_damage, 0) AS total_damage\n  FROM player_stats ps\n  LEFT JOIN (WITH dmg AS (\n  SELECT e.match_id, e.round, e.attacker, e.victim, e.weapon, e.capped_dmg, e.detail_json,\n         sa.side AS a_side, sv.side AS v_side\n  FROM events e\n  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker\n  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim\n  WHERE e.match_id = :match_id AND e.kind = 'damage' AND e.post_match = 0\n),\nedmg AS (\n  SELECT * FROM dmg WHERE attacker <> '' AND attacker <> victim\n    AND NOT (COALESCE(a_side, '') <> '' AND a_side = v_side)\n),\nfold AS (\n    SELECT match_id, attacker AS steam_id, 'total_damage' AS f, SUM(capped_dmg) AS n FROM edmg GROUP BY match_id, attacker\n  )\n  SELECT match_id, steam_id, SUM(CASE WHEN f = 'total_damage' THEN n END) AS total_damage FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id\n  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "DMG",
		interpretation: "damage dealt (corpus: 300i)",
		rows:           8, wantValues: []float64{300, 600, 900, 1200, 1500, 1800, 2100, 2400}, wantLabels: eightLabels,
	},
	{
		name: "utility_damage", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(utility_damage) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.utility_damage, 0) AS utility_damage\n  FROM player_stats ps\n  LEFT JOIN (WITH dmg AS (\n  SELECT e.match_id, e.round, e.attacker, e.victim, e.weapon, e.capped_dmg, e.detail_json,\n         sa.side AS a_side, sv.side AS v_side\n  FROM events e\n  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker\n  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim\n  WHERE e.match_id = :match_id AND e.kind = 'damage' AND e.post_match = 0\n),\nedmg AS (\n  SELECT * FROM dmg WHERE attacker <> '' AND attacker <> victim\n    AND NOT (COALESCE(a_side, '') <> '' AND a_side = v_side)\n),\nfold AS (\n    SELECT match_id, attacker AS steam_id, 'utility_damage' AS f, SUM(CASE WHEN weapon IN ('HE Grenade', 'Flashbang', 'Smoke Grenade', 'Molotov', 'Incendiary Grenade', 'Decoy Grenade') THEN capped_dmg ELSE 0 END) AS n FROM edmg GROUP BY match_id, attacker\n  )\n  SELECT match_id, steam_id, SUM(CASE WHEN f = 'utility_damage' THEN n END) AS utility_damage FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id\n  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "Util",
		interpretation: "scoreboard Util total (corpus: column absent → 0)",
		rows:           8, wantAll: 0, wantLabels: eightLabels,
	},
	{
		name: "headshots", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(headshots) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.headshots, 0) AS headshots\n  FROM player_stats ps\n  LEFT JOIN (WITH k AS (\n  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,\n         (e.victim <> '' AND e.attacker = e.victim AND e.weapon = 'World' AND dc.attacker IS NOT NULL) AS fake,\n         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side\n  FROM events e\n  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = 'player_disconnect') dc\n    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick\n  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker\n  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim\n  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister\n  WHERE e.match_id = :match_id AND e.kind = 'kill' AND e.post_match = 0\n),\nek AS (\n  SELECT * FROM k WHERE attacker <> '' AND attacker <> victim AND fake = 0\n    AND NOT (COALESCE(a_side, '') <> '' AND a_side = v_side)\n),\nfold AS (\n    SELECT match_id, attacker AS steam_id, 'headshots' AS f, SUM(headshot) AS n FROM ek GROUP BY match_id, attacker\n  )\n  SELECT match_id, steam_id, SUM(CASE WHEN f = 'headshots' THEN n END) AS headshots FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id\n  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "",
		interpretation: "headshot kills (corpus: 3i)",
		rows:           8, wantValues: []float64{3, 6, 9, 12, 15, 18, 21, 24}, wantLabels: eightLabels,
	},
	{
		name: "teamkills", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(teamkills) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.kills, 0) AS kills, COALESCE(f.teamkills, 0) AS teamkills\n  FROM player_stats ps\n  LEFT JOIN (WITH k AS (\n  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,\n         (e.victim <> '' AND e.attacker = e.victim AND e.weapon = 'World' AND dc.attacker IS NOT NULL) AS fake,\n         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side\n  FROM events e\n  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = 'player_disconnect') dc\n    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick\n  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker\n  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim\n  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister\n  WHERE e.match_id = :match_id AND e.kind = 'kill' AND e.post_match = 0\n),\nek AS (\n  SELECT * FROM k WHERE attacker <> '' AND attacker <> victim AND fake = 0\n    AND NOT (COALESCE(a_side, '') <> '' AND a_side = v_side)\n),\nfold AS (\n    SELECT match_id, attacker AS steam_id, 'kills' AS f, COUNT(*) AS n FROM ek GROUP BY match_id, attacker\n    UNION ALL SELECT match_id, attacker AS steam_id, 'teamkills' AS f, COUNT(*) AS n FROM k WHERE attacker <> '' AND attacker <> victim AND fake = 0 AND COALESCE(a_side, '') <> '' AND a_side = v_side GROUP BY match_id, attacker\n  )\n  SELECT match_id, steam_id, SUM(CASE WHEN f = 'kills' THEN n END) AS kills, SUM(CASE WHEN f = 'teamkills' THEN n END) AS teamkills FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id\n  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "",
		interpretation: "team-kill count (corpus: column absent → 0)",
		rows:           8, wantAll: 0, wantLabels: eightLabels,
	},
	{
		name: "suicides", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(suicides) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.suicides, 0) AS suicides\n  FROM player_stats ps\n  LEFT JOIN (WITH k AS (\n  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,\n         (e.victim <> '' AND e.attacker = e.victim AND e.weapon = 'World' AND dc.attacker IS NOT NULL) AS fake,\n         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side\n  FROM events e\n  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = 'player_disconnect') dc\n    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick\n  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker\n  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim\n  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister\n  WHERE e.match_id = :match_id AND e.kind = 'kill' AND e.post_match = 0\n),\nek AS (\n  SELECT * FROM k WHERE attacker <> '' AND attacker <> victim AND fake = 0\n    AND NOT (COALESCE(a_side, '') <> '' AND a_side = v_side)\n),\nfold AS (\n    SELECT match_id, victim AS steam_id, 'suicides' AS f, COUNT(*) AS n FROM k WHERE victim <> '' AND attacker = victim AND fake = 0 GROUP BY match_id, victim\n  )\n  SELECT match_id, steam_id, SUM(CASE WHEN f = 'suicides' THEN n END) AS suicides FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id\n  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "",
		interpretation: "suicide count (corpus: column absent → 0)",
		rows:           8, wantAll: 0, wantLabels: eightLabels,
	},
	{
		name: "damage_taken", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(damage_taken) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.damage_taken, 0) AS damage_taken\n  FROM player_stats ps\n  LEFT JOIN (WITH dmg AS (\n  SELECT e.match_id, e.round, e.attacker, e.victim, e.weapon, e.capped_dmg, e.detail_json,\n         sa.side AS a_side, sv.side AS v_side\n  FROM events e\n  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker\n  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim\n  WHERE e.match_id = :match_id AND e.kind = 'damage' AND e.post_match = 0\n),\nedmg AS (\n  SELECT * FROM dmg WHERE attacker <> '' AND attacker <> victim\n    AND NOT (COALESCE(a_side, '') <> '' AND a_side = v_side)\n),\nfold AS (\n    SELECT match_id, victim AS steam_id, 'damage_taken' AS f, SUM(CASE WHEN json_valid(detail_json) THEN CAST(json_extract(detail_json, '$.damageTaken') AS INTEGER) END) AS n FROM dmg WHERE victim <> '' GROUP BY match_id, victim\n  )\n  SELECT match_id, steam_id, SUM(CASE WHEN f = 'damage_taken' THEN n END) AS damage_taken FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id\n  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "",
		interpretation: "damage absorbed (corpus: 150i)",
		rows:           8, wantValues: []float64{150, 300, 450, 600, 750, 900, 1050, 1200}, wantLabels: eightLabels,
	},
	{
		name: "shots", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(shots) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.shots, 0) AS shots\n  FROM player_stats ps\n  LEFT JOIN (WITH fold AS (\n    SELECT match_id, attacker AS steam_id, 'shots' AS f, COUNT(*) AS n FROM events e WHERE e.match_id = :match_id AND e.kind = 'weapon_fire' AND e.post_match = 0 GROUP BY match_id, attacker\n  )\n  SELECT match_id, steam_id, SUM(CASE WHEN f = 'shots' THEN n END) AS shots FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id\n  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "",
		interpretation: "shots fired (corpus: column absent → 0)",
		rows:           8, wantAll: 0, wantLabels: eightLabels,
	},
	{
		name: "hits", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(hits) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.hits, 0) AS hits\n  FROM player_stats ps\n  LEFT JOIN (WITH dmg AS (\n  SELECT e.match_id, e.round, e.attacker, e.victim, e.weapon, e.capped_dmg, e.detail_json,\n         sa.side AS a_side, sv.side AS v_side\n  FROM events e\n  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker\n  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim\n  WHERE e.match_id = :match_id AND e.kind = 'damage' AND e.post_match = 0\n),\nedmg AS (\n  SELECT * FROM dmg WHERE attacker <> '' AND attacker <> victim\n    AND NOT (COALESCE(a_side, '') <> '' AND a_side = v_side)\n),\nfold AS (\n    SELECT match_id, attacker AS steam_id, 'hits' AS f, COUNT(*) AS n FROM edmg GROUP BY match_id, attacker\n  )\n  SELECT match_id, steam_id, SUM(CASE WHEN f = 'hits' THEN n END) AS hits FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id\n  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "",
		interpretation: "shots that connected (corpus: column absent → 0)",
		rows:           8, wantAll: 0, wantLabels: eightLabels,
	},
	{
		name: "rounds_played", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(rounds_played) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.rounds_played, 0) AS rounds_played\n  FROM player_stats ps\n  LEFT JOIN (WITH fold AS (\n    SELECT match_id, steam_id, 'rounds_played' AS f, COUNT(*) AS n FROM round_player_sides WHERE match_id = :match_id GROUP BY match_id, steam_id\n  )\n  SELECT match_id, steam_id, SUM(CASE WHEN f = 'rounds_played' THEN n END) AS rounds_played FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id\n  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "",
		interpretation: "rounds the player appeared in (corpus: 24 per match → 72)",
		rows:           8, wantAll: 72, wantLabels: eightLabels,
	},
	{
		name: "flashed_times", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(flashed_times) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.flashed_times, 0) AS flashed_times\n  FROM player_stats ps\n  LEFT JOIN (WITH bl AS (\n  SELECT e.match_id, e.attacker, e.victim, sa.side AS a_side, sv.side AS v_side\n  FROM events e\n  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker\n  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim\n  WHERE e.match_id = :match_id AND e.kind = 'blind' AND e.post_match = 0\n),\nfold AS (\n    SELECT match_id, victim AS steam_id, 'flashed_times' AS f, COUNT(*) AS n FROM bl WHERE victim <> '' GROUP BY match_id, victim\n  )\n  SELECT match_id, steam_id, SUM(CASE WHEN f = 'flashed_times' THEN n END) AS flashed_times FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id\n  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "",
		interpretation: "times blinded (corpus: column absent → 0)",
		rows:           8, wantAll: 0, wantLabels: eightLabels,
	},
	{
		name: "bomb_plants", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(bomb_plants) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.bomb_plants, 0) AS bomb_plants\n  FROM player_stats ps\n  LEFT JOIN (WITH fold AS (\n    SELECT match_id, attacker AS steam_id, 'bomb_plants' AS f, COUNT(*) AS n FROM events e WHERE e.match_id = :match_id AND e.kind = 'bomb_plant' AND e.post_match = 0 GROUP BY match_id, attacker\n  )\n  SELECT match_id, steam_id, SUM(CASE WHEN f = 'bomb_plants' THEN n END) AS bomb_plants FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id\n  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "",
		interpretation: "bomb plants (corpus: column absent → 0)",
		rows:           8, wantAll: 0, wantLabels: eightLabels,
	},
	{
		name: "bomb_defuses", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(bomb_defuses) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.bomb_defuses, 0) AS bomb_defuses\n  FROM player_stats ps\n  LEFT JOIN (WITH fold AS (\n    SELECT match_id, attacker AS steam_id, 'bomb_defuses' AS f, COUNT(*) AS n FROM events e WHERE e.match_id = :match_id AND e.kind = 'bomb_defuse' AND e.post_match = 0 GROUP BY match_id, attacker\n  )\n  SELECT match_id, steam_id, SUM(CASE WHEN f = 'bomb_defuses' THEN n END) AS bomb_defuses FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id\n  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "",
		interpretation: "bomb defuses (corpus: column absent → 0)",
		rows:           8, wantAll: 0, wantLabels: eightLabels,
	},
	{
		name: "money_spent_total", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, steam_id AS grp, SUM(money_spent_total) AS v FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.money_spent_total, 0) AS money_spent_total\n  FROM player_stats ps\n  LEFT JOIN (WITH fold AS (\n    SELECT match_id, steam_id, 'money_spent_total' AS f, SUM(spent) AS n FROM round_player_money WHERE match_id = :match_id GROUP BY match_id, steam_id\n  )\n  SELECT match_id, steam_id, SUM(CASE WHEN f = 'money_spent_total' THEN n END) AS money_spent_total FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id\n  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)) GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", format: "int", shortName: "",
		interpretation: "money spent (corpus: 150000 per match → 450000)",
		rows:           8, wantAll: 450000, wantLabels: eightLabels,
	},
	{
		name: "career_kills", expr: "SELECT :steam_id AS subject_key, '' AS dim, (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric('kills')) AS value",
		scope: "profile", format: "int", shortName: "",
		interpretation: "event-derived over the corpus events (the retired player_stats literal is not the truth)",
		rows:           8, wantValues: []float64{72.0, 36.0, 36.0, 36.0, 72.0, 36.0, 36.0, 36.0}, wantLabels: eightLabels,
	},
	{
		name: "career_deaths", expr: "SELECT :steam_id AS subject_key, '' AS dim, (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric('deaths')) AS value",
		scope: "profile", format: "int", shortName: "",
		interpretation: "event-derived over the corpus events (the retired player_stats literal is not the truth)",
		rows:           8, wantValues: []float64{72.0, 36.0, 36.0, 36.0, 72.0, 36.0, 36.0, 36.0}, wantLabels: eightLabels,
	},
	{
		name: "career_assists", expr: "SELECT :steam_id AS subject_key, '' AS dim, (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric('assists')) AS value",
		scope: "profile", format: "int", shortName: "",
		interpretation: "event-derived over the corpus events (the retired player_stats literal is not the truth)",
		rows:           8, wantValues: []float64{0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0}, wantLabels: eightLabels,
	},
	{
		name: "career_mvps", expr: "SELECT :steam_id AS subject_key, '' AS dim, (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric('mvps')) AS value WHERE EXISTS (SELECT 1 FROM metric('mvps'))",
		scope: "profile", format: "int", shortName: "",
		interpretation: "career MVP awards (corpus: 1 per match → 3)",
		rows:           8, wantAll: 3, wantLabels: eightLabels,
	},
	{
		name: "career_total_damage", expr: "SELECT :steam_id AS subject_key, '' AS dim, (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric('total_damage')) AS value",
		scope: "profile", format: "int", shortName: "",
		interpretation: "event-derived over the corpus events (the retired player_stats literal is not the truth)",
		rows:           8, wantValues: []float64{7020.0, 7020.0, 7020.0, 7020.0, 7020.0, 7020.0, 7020.0, 7020.0}, wantLabels: eightLabels,
	},
	{
		name: "career_matches", expr: "SELECT :steam_id AS subject_key, '' AS dim, (SELECT COUNT(*) FROM metric('match_won')) AS value WHERE EXISTS (SELECT 1 FROM metric('match_won'))",
		scope: "profile", format: "int", shortName: "",
		interpretation: "matches the player appears in (corpus: 3)",
		rows:           8, wantAll: 3, wantLabels: eightLabels,
	},
	// ---- subject-axis addendum (plan §8 (M8/M4 rows), 2026-11-17):
	// the first non-player rows — subject WRITTEN, values hand-computed
	// over the corpus team stamps (sides never switch, so team = side).
	{
		// The Economy card's lost-equip total (its Formula title) over
		// the joined sources: every corpus round is decided (winner
		// alternates by parity), loser side equip 2000 after a CT win
		// (odd rounds ×12) and 2500 after a T win (even ×12):
		// 12×2000 + 12×2500 = 54000 per match; N is the GROUP's rows —
		// every economy row of the match (24 rounds × 2 sides = 48) —
		// the filter shapes the value, never N (one spelling).
		name:  "lost_equip",
		expr:  "SELECT '' AS subject_key, '' AS dim, v AS value FROM (SELECT round_economy.match_id AS mid, round_economy.match_id AS grp, SUM(CASE WHEN (((rounds.winner != '') AND (round_economy.side != rounds.winner)) AND (round_economy.team != '')) THEN round_economy.equip_value END) AS v FROM round_economy LEFT JOIN rounds ON round_economy.match_id = rounds.match_id AND round_economy.round = rounds.number WHERE round_economy.match_id = :match_id GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", subject: "match", format: "currency", shortName: "",
		interpretation: "freeze-end money lost by the losing side over decided, team-known rounds — the card total, addressed per match (over the joined sources)",
		rows:           3, wantAll: 54000, wantLabels: "1,2,3",
	},
	{
		// The Economy card's per-team force half: team ct wins only
		// round 3 of its three force rounds (1/3), team t wins rounds 2
		// and 4 (2/3); match 1 carries no class rows (join_test's
		// classification rig owns that match's analysis tables) — two
		// matches × two teams, N = the team's classified rounds.
		name:  "team_force_win_rate",
		expr:  "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT round_side_classes.match_id AS mid, round_side_classes.team AS grp, 1.0*(SUM(CASE WHEN ((round_side_classes.class = 'force') AND (rounds.winner = round_side_classes.side)) THEN 1 ELSE 0 END)) / NULLIF((SUM(CASE WHEN (round_side_classes.class = 'force') THEN 1 ELSE 0 END)), 0) AS v FROM round_side_classes LEFT JOIN rounds ON round_side_classes.match_id = rounds.match_id AND round_side_classes.round = rounds.number WHERE round_side_classes.match_id = :match_id AND (round_side_classes.team <> '') GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", subject: "team", format: "percent", shortName: "",
		interpretation: "force-buy rounds won ÷ that team's own force rounds — the card's per-team force rate (over the joined sources)",
		rows:           4, wantValues: []float64{1.0 / 3, 2.0 / 3, 1.0 / 3, 2.0 / 3}, wantLabels: "ct,t,ct,t",
	},
	{
		// The Economy card's per-team lost-equip split: the loser row's
		// team takes the money — ct loses the 12 even rounds at 2500
		// (30000), t the 12 odd rounds at 2000 (24000), per match; N is
		// the group's rows — every economy row of that team (24 rounds).
		name:  "team_lost_equip",
		expr:  "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT round_economy.match_id AS mid, round_economy.team AS grp, SUM(CASE WHEN (((rounds.winner != '') AND (round_economy.side != rounds.winner)) AND (round_economy.team != '')) THEN round_economy.equip_value END) AS v FROM round_economy LEFT JOIN rounds ON round_economy.match_id = rounds.match_id AND round_economy.round = rounds.number WHERE round_economy.match_id = :match_id AND (round_economy.team <> '') GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", subject: "team", format: "currency", shortName: "",
		interpretation: "the losing side's freeze-end money credited to its team — the card's per-team split (over the joined sources)",
		rows:           6, wantValues: []float64{30000, 24000, 30000, 24000, 30000, 24000}, wantLabels: "ct,t,ct,t,ct,t",
	},
	{
		// The profile Win% card's ratio over the won stamp: the corpus
		// matches are all 12-12 ties (won = 0 — a tie is not a win,
		// models.WinFor), so every career row is 0/3.
		name: "win_pct", expr: "SELECT :steam_id AS subject_key, '' AS dim, 1.0 * (SELECT CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END FROM metric('match_won')) / NULLIF((SELECT COUNT(*) FROM metric('match_won')), 0) AS value WHERE EXISTS (SELECT 1 FROM metric('match_won'))",
		scope: "profile", format: "percent", shortName: "",
		interpretation: "career wins ÷ matches played — the profile Win% card's stored twin (ties are no wins → 0 over the tied corpus)",
		rows:           8, wantAll: 0, wantLabels: eightLabels,
	},
	// ---- identity addendum (plan §8 (M1 identity row), 2026-11-17):
	// the five M1 top-card seeds — subject=match, format=identity, rows
	// = 3 (one identity per match), N = 8 (the pool the argmax chose
	// from — every player_stats row of the match), labels = the
	// WINNER's name per match. Corpus math (seed.sql): kills = 2i and
	// adr = 50+5i rise with i, so Heidi (i=8) leads both outright
	// (16 kills / 90 ADR); utility_damage is absent (= 0) and mvps is
	// 1 for every player, so those two TIE across
	// all eight and the deterministic tie-break (player key ASC) names
	// Alice (…001), while entry_kills = i (the 2026-11-18 swap of the
	// retired opening_kills column) has Heidi leading at 8. The
	// engine-side pins (emission, refusal set,
	// filtered pool, empty pool) live in argmax_test.go.
	{
		name: "top_fragger", expr: "SELECT '' AS subject_key, '' AS dim, v AS value, idkey AS idkey FROM (SELECT mid, grp, idkey, v FROM (SELECT match_id AS mid, match_id AS grp, steam_id AS idkey, kills AS v, ROW_NUMBER() OVER (PARTITION BY match_id ORDER BY kills DESC, steam_id ASC) AS rn FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.kills, 0) AS kills\n  FROM player_stats ps\n  LEFT JOIN (WITH k AS (\n  SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash,\n         (e.victim <> '' AND e.attacker = e.victim AND e.weapon = 'World' AND dc.attacker IS NOT NULL) AS fake,\n         sa.side AS a_side, sv.side AS v_side, ss.side AS s_side\n  FROM events e\n  LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = 'player_disconnect') dc\n    ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick\n  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker\n  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim\n  LEFT JOIN round_player_sides ss ON ss.match_id = e.match_id AND ss.round = e.round AND ss.steam_id = e.assister\n  WHERE e.match_id = :match_id AND e.kind = 'kill' AND e.post_match = 0\n),\nek AS (\n  SELECT * FROM k WHERE attacker <> '' AND attacker <> victim AND fake = 0\n    AND NOT (COALESCE(a_side, '') <> '' AND a_side = v_side)\n),\nfold AS (\n    SELECT match_id, attacker AS steam_id, 'kills' AS f, COUNT(*) AS n FROM ek GROUP BY match_id, attacker\n  )\n  SELECT match_id, steam_id, SUM(CASE WHEN f = 'kills' THEN n END) AS kills FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id\n  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1) AND steam_id <> '')) WHERE rn = 1 ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", subject: "match", format: "identity", shortName: "",
		interpretation: "the match's leading fragger by stored kills (corpus: Heidi, 16 kills, over the 8-player pool)",
		rows:           3, wantValues: []float64{16, 16, 16}, wantLabels: "Heidi,Heidi,Heidi",
	},
	{
		name: "best_adr", expr: "SELECT '' AS subject_key, '' AS dim, v AS value, idkey AS idkey FROM (SELECT mid, grp, idkey, v FROM (SELECT match_id AS mid, match_id AS grp, steam_id AS idkey, adr AS v, ROW_NUMBER() OVER (PARTITION BY match_id ORDER BY adr DESC, steam_id ASC) AS rn FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, CAST(COALESCE(f.total_damage, 0) AS REAL) / NULLIF((SELECT COUNT(*) FROM rounds r WHERE r.match_id = ps.match_id), 0) AS adr\n  FROM player_stats ps\n  LEFT JOIN (WITH dmg AS (\n  SELECT e.match_id, e.round, e.attacker, e.victim, e.weapon, e.capped_dmg, e.detail_json,\n         sa.side AS a_side, sv.side AS v_side\n  FROM events e\n  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker\n  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim\n  WHERE e.match_id = :match_id AND e.kind = 'damage' AND e.post_match = 0\n),\nedmg AS (\n  SELECT * FROM dmg WHERE attacker <> '' AND attacker <> victim\n    AND NOT (COALESCE(a_side, '') <> '' AND a_side = v_side)\n),\nfold AS (\n    SELECT match_id, attacker AS steam_id, 'total_damage' AS f, SUM(capped_dmg) AS n FROM edmg GROUP BY match_id, attacker\n  )\n  SELECT match_id, steam_id, SUM(CASE WHEN f = 'total_damage' THEN n END) AS total_damage FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id\n  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1) AND steam_id <> '')) WHERE rn = 1 ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", subject: "match", format: "identity", shortName: "",
		interpretation: "the match's highest stored ADR (corpus: Heidi, 90, over the 8-player pool)",
		rows:           3, wantValues: []float64{90, 90, 90}, wantLabels: "Heidi,Heidi,Heidi",
	},
	{
		name: "most_util", expr: "SELECT '' AS subject_key, '' AS dim, v AS value, idkey AS idkey FROM (SELECT mid, grp, idkey, v FROM (SELECT match_id AS mid, match_id AS grp, steam_id AS idkey, utility_damage AS v, ROW_NUMBER() OVER (PARTITION BY match_id ORDER BY utility_damage DESC, steam_id ASC) AS rn FROM (SELECT ps.match_id, ps.steam_id, ps.side, ps.name, ps.mvps, ps.score, ps.entry_kills, ps.entry_deaths, ps.trade_kills, ps.best_streak, ps.team, ps.won, ps.map, COALESCE(f.utility_damage, 0) AS utility_damage\n  FROM player_stats ps\n  LEFT JOIN (WITH dmg AS (\n  SELECT e.match_id, e.round, e.attacker, e.victim, e.weapon, e.capped_dmg, e.detail_json,\n         sa.side AS a_side, sv.side AS v_side\n  FROM events e\n  LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker\n  LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim\n  WHERE e.match_id = :match_id AND e.kind = 'damage' AND e.post_match = 0\n),\nedmg AS (\n  SELECT * FROM dmg WHERE attacker <> '' AND attacker <> victim\n    AND NOT (COALESCE(a_side, '') <> '' AND a_side = v_side)\n),\nfold AS (\n    SELECT match_id, attacker AS steam_id, 'utility_damage' AS f, SUM(CASE WHEN weapon IN ('HE Grenade', 'Flashbang', 'Smoke Grenade', 'Molotov', 'Incendiary Grenade', 'Decoy Grenade') THEN capped_dmg ELSE 0 END) AS n FROM edmg GROUP BY match_id, attacker\n  )\n  SELECT match_id, steam_id, SUM(CASE WHEN f = 'utility_damage' THEN n END) AS utility_damage FROM fold GROUP BY match_id, steam_id) f ON f.match_id = ps.match_id AND f.steam_id = ps.steam_id\n  WHERE ps.match_id = :match_id) player_stats WHERE player_stats.match_id = :match_id AND (NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1) AND steam_id <> '')) WHERE rn = 1 ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", subject: "match", format: "identity", shortName: "",
		interpretation: "the match's leading utility-damage player (corpus: column absent → 0 for everyone → tie → Alice by key ASC)",
		rows:           3, wantValues: []float64{0, 0, 0}, wantLabels: "Alice,Alice,Alice",
	},
	{
		name: "entry_opens", expr: "SELECT '' AS subject_key, '' AS dim, v AS value, idkey AS idkey FROM (SELECT mid, grp, idkey, v FROM (SELECT match_id AS mid, match_id AS grp, steam_id AS idkey, entry_kills AS v, ROW_NUMBER() OVER (PARTITION BY match_id ORDER BY entry_kills DESC, steam_id ASC) AS rn FROM player_stats WHERE player_stats.match_id = :match_id AND (NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1) AND steam_id <> '')) WHERE rn = 1 ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", subject: "match", format: "identity", shortName: "",
		interpretation: "the match's round-opening first-blood leader (corpus: entry_kills = i since the 2026-11-18 swap → Heidi, 8)",
		rows:           3, wantValues: []float64{8, 8, 8}, wantLabels: "Heidi,Heidi,Heidi",
	},
	{
		name: "most_mvps", expr: "SELECT '' AS subject_key, '' AS dim, v AS value, idkey AS idkey FROM (SELECT mid, grp, idkey, v FROM (SELECT match_id AS mid, match_id AS grp, steam_id AS idkey, mvps AS v, ROW_NUMBER() OVER (PARTITION BY match_id ORDER BY mvps DESC, steam_id ASC) AS rn FROM player_stats WHERE player_stats.match_id = :match_id AND (NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id AND p.steam_id = player_stats.steam_id AND p.is_bot = 1) AND steam_id <> '')) WHERE rn = 1 ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", subject: "match", format: "identity", shortName: "",
		interpretation: "the match's MVP-award leader (corpus: 1 per player → tie → Alice by key ASC)",
		rows:           3, wantValues: []float64{1, 1, 1}, wantLabels: "Alice,Alice,Alice",
	},
	// ---- partition addendum (plan §8 (M5/M6 rows), 2026-11-17): the
	// five side- and five map-partitioned profile seeds. The corpus
	// fills every stamp (testdata/seed.sql extension): each player sits
	// on ONE side all career (side_switches 0 — players 1-4 ct, 5-8 t),
	// so each side seed yields ONE dim row per player (N = their 72
	// rounds), while every player meets all THREE maps (one match each
	// — de_dust2 < de_inferno < de_mirage by dim ASC), so each map
	// seed yields three rows per player (N = 1 match). The corpus
	// matches are 12-12 ties, so every win cell is 0 (models.WinFor).
	{
		name: "side_rounds", expr: "SELECT :steam_id AS subject_key, dim AS dim, CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END AS value FROM metric('match_side_rounds') GROUP BY dim",
		scope: "profile", partition: "side", format: "int", shortName: "",
		interpretation: "rounds played on the player's side (all 72 career rounds sit on one side)",
		rows:           8, wantAll: 72, wantLabels: eightLabels,
		wantDims: []string{"ct", "ct", "ct", "ct", "t", "t", "t", "t"},
	},
	{
		// 36 of the player's 72 rounds were won by their side (winners
		// alternate by round parity) → 0.5.
		name: "side_win_pct", expr: "SELECT :steam_id AS subject_key, n.dim AS dim, 1.0 * n.s / NULLIF(d.s, 0) AS value FROM (SELECT dim, SUM(value) AS s FROM metric('match_side_won') GROUP BY dim) n JOIN (SELECT dim, SUM(value) AS s FROM metric('match_side_rounds') GROUP BY dim) d ON d.dim = n.dim",
		scope: "profile", partition: "side", format: "percent", shortName: "",
		interpretation: "rounds won on the side ÷ rounds played on it (36/72)",
		rows:           8, wantAll: 0.5, wantLabels: eightLabels,
		wantDims: []string{"ct", "ct", "ct", "ct", "t", "t", "t", "t"},
	},
	{
		// 4320 damage over 72 rounds = 60.0 — the pooled side ADR the
		// Sides card's ADR cell showed (SUM(dmg)/COUNT(*), never a mean
		// of per-match values).
		name: "side_adr", expr: "SELECT :steam_id AS subject_key, n.dim AS dim, 1.0 * n.s / NULLIF(d.s, 0) AS value FROM (SELECT dim, SUM(value) AS s FROM metric('match_side_dmg') GROUP BY dim) n JOIN (SELECT dim, SUM(value) AS s FROM metric('match_side_rounds') GROUP BY dim) d ON d.dim = n.dim",
		scope: "profile", partition: "side", format: "float1", shortName: "",
		interpretation: "event-derived over the corpus events (the retired player_stats literal is not the truth)",
		rows:           8, wantValues: []float64{97.5, 97.5, 97.5, 97.5, 97.5, 97.5, 97.5, 97.5}, wantLabels: eightLabels,
		wantDims: []string{"ct", "ct", "ct", "ct", "t", "t", "t", "t"},
	},
	{
		// 36 KAST rounds of 72 → 0.5 (the percent fraction the display
		// scales ×100 — the seed.sql header's 0.5 KAST mean).
		name: "side_kast", expr: "SELECT :steam_id AS subject_key, n.dim AS dim, 1.0 * n.s / NULLIF(d.s, 0) AS value FROM (SELECT dim, SUM(value) AS s FROM metric('match_side_kast') GROUP BY dim) n JOIN (SELECT dim, SUM(value) AS s FROM metric('match_side_rounds') GROUP BY dim) d ON d.dim = n.dim",
		scope: "profile", partition: "side", format: "percent", shortName: "",
		interpretation: "share of the side's rounds with a K, A, T or S (36/72)",
		rows:           8, wantAll: 0.5, wantLabels: eightLabels,
		wantDims: []string{"ct", "ct", "ct", "ct", "t", "t", "t", "t"},
	},
	{
		// 72 kills / 18 deaths — the floored denominator the Sides
		// card used (kills / max(deaths, 1)); the corpus's 18 deaths
		// never hit the floor, the seed's max() pins the spelling.
		name: "side_kd", expr: "SELECT :steam_id AS subject_key, k.dim AS dim, 1.0 * k.s / NULLIF(MAX(d.s, 1), 0) AS value FROM (SELECT dim, SUM(value) AS s FROM metric('match_side_kills') GROUP BY dim) k JOIN (SELECT dim, SUM(value) AS s FROM metric('match_side_deaths') GROUP BY dim) d ON d.dim = k.dim",
		scope: "profile", partition: "side", format: "float2", shortName: "",
		interpretation: "event-derived over the corpus events (the retired player_stats literal is not the truth)",
		rows:           8, wantValues: []float64{1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0}, wantLabels: eightLabels,
		wantDims: []string{"ct", "ct", "ct", "ct", "t", "t", "t", "t"},
	},
	{
		name: "map_matches", expr: "SELECT :steam_id AS subject_key, dim AS dim, COUNT(*) AS value FROM metric('match_map_won') GROUP BY dim",
		scope: "profile", partition: "map", format: "int", shortName: "",
		interpretation: "matches played on the map (one match per map in the corpus)",
		rows:           24, wantAll: 1, wantDims: threeMapDims,
	},
	{
		// The corpus matches are all 12-12 ties → won = 0 everywhere.
		name: "map_wins", expr: "SELECT :steam_id AS subject_key, dim AS dim, CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END AS value FROM metric('match_map_won') GROUP BY dim",
		scope: "profile", partition: "map", format: "int", shortName: "",
		interpretation: "matches won on the map (tied corpus → 0)",
		rows:           24, wantAll: 0, wantDims: threeMapDims,
	},
	{
		name: "map_win_pct", expr: "SELECT :steam_id AS subject_key, dim AS dim, 1.0 * SUM(value) / NULLIF(COUNT(*), 0) AS value FROM metric('match_map_won') GROUP BY dim",
		scope: "profile", partition: "map", format: "percent", shortName: "",
		interpretation: "matches won ÷ played on the map (tied corpus → 0/1)",
		rows:           24, wantAll: 0, wantDims: threeMapDims,
	},
	{
		// The Maps card's pooled micro-average: Σ damage over the map's
		// matches ÷ their counted rounds — 100i damage / 24 rounds per
		// player (the `rounds` denominator, dim-scoped by emitDenom to
		// the map's matches — never a mean of per-match ADRs).
		name: "map_adr", expr: "SELECT :steam_id AS subject_key, n.dim AS dim, 1.0 * n.s / NULLIF(d.s, 0) AS value FROM (SELECT dim, SUM(value) AS s FROM metric('match_map_damage') GROUP BY dim) n JOIN (SELECT dim, SUM(value) AS s FROM metric('match_map_rounds') GROUP BY dim) d ON d.dim = n.dim",
		scope: "profile", partition: "map", format: "float1", shortName: "",
		interpretation: "event-derived over the corpus events (the retired player_stats literal is not the truth)",
		rows:           24, wantValues: mapADRValues, wantDims: threeMapDims,
	},
	{
		// kills = 2i, deaths = i per match → 2i/i = 2 on every map.
		name: "map_kd", expr: "SELECT :steam_id AS subject_key, n.dim AS dim, 1.0 * n.s / NULLIF(d.s, 0) AS value FROM (SELECT dim, SUM(value) AS s FROM metric('match_map_kills') GROUP BY dim) n JOIN (SELECT dim, SUM(value) AS s FROM metric('match_map_deaths') GROUP BY dim) d ON d.dim = n.dim",
		scope: "profile", partition: "map", format: "float2", shortName: "",
		interpretation: "event-derived over the corpus events (the retired player_stats literal is not the truth)",
		rows:           24, wantValues: []float64{1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0}, wantDims: threeMapDims,
	},
	// ---- weapon addendum (plan §8 (M7 row) behind the M7 gate,
	// 2026-11-17): the two columns the golden gate proved EXACTLY equal
	// to the fold. Corpus structure: every player fires one kill weapon
	// per round-half mirrored across teams (alice/eve ak47+usp,
	// bob/frank awp, carol/grace m4a1, dave/heidi deagle — 12 kills per
	// match per group × 3), every player ALSO carries a flashbang group
	// (blind/damage events only → 0 kills beside N — the group is real,
	// the filter counted nothing), and the headshot flag lands on the
	// ak47/usp/m4a1 kills only (awp/deagle none). N varies per group
	// (that group's event rows — 216/180/36/18 here), so these entries
	// pin values + dims + labels and leave N to the group structure.
	{
		name: "weapon_kills", expr: "SELECT :steam_id AS subject_key, dim AS dim, CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END AS value FROM metric('match_weapon_kills') GROUP BY dim",
		scope: "profile", partition: "weapon", format: "int", shortName: "",
		interpretation: "enemy kills per weapon (12 per match per kill group × 3; flashbang groups carry 0 kills)",
		rows:           24, wantValues: []float64{36.0, 0.0, 36.0, 0.0, 36.0, 0.0, 0.0, 0.0, 36.0, 0.0, 36.0, 0.0, 36.0, 0.0, 36.0, 0.0, 36.0, 0.0, 0.0, 0.0, 36.0, 0.0, 36.0, 0.0}, wantLabels: "Alice,Alice,Alice,Bob,Bob,Bob,Carol,Carol,Carol,Dave,Dave,Dave,Eve,Eve,Eve,Frank,Frank,Frank,Grace,Grace,Grace,Heidi,Heidi,Heidi",
		wantDims: []string{"ak47", "flashbang", "usp", "ak47", "awp", "flashbang", "ak47", "flashbang", "m4a1", "ak47", "deagle", "flashbang", "ak47", "flashbang", "usp", "ak47", "awp", "flashbang", "ak47", "flashbang", "m4a1", "ak47", "deagle", "flashbang"},
	},
	{
		name: "weapon_headshots", expr: "SELECT :steam_id AS subject_key, dim AS dim, CASE WHEN COUNT(*) = COUNT(value) THEN SUM(value) END AS value FROM metric('match_weapon_headshots') GROUP BY dim",
		scope: "profile", partition: "weapon", format: "int", shortName: "",
		interpretation: "enemy headshot kills per weapon (ak47/usp/m4a1 headshot, awp/deagle none in the corpus)",
		rows:           24, wantValues: []float64{36.0, 0.0, 36.0, 0.0, 0.0, 0.0, 0.0, 0.0, 36.0, 0.0, 0.0, 0.0, 36.0, 0.0, 36.0, 0.0, 0.0, 0.0, 0.0, 0.0, 36.0, 0.0, 0.0, 0.0}, wantLabels: "Alice,Alice,Alice,Bob,Bob,Bob,Carol,Carol,Carol,Dave,Dave,Dave,Eve,Eve,Eve,Frank,Frank,Frank,Grace,Grace,Grace,Heidi,Heidi,Heidi",
		wantDims: []string{"ak47", "flashbang", "usp", "ak47", "awp", "flashbang", "ak47", "flashbang", "m4a1", "ak47", "deagle", "flashbang", "ak47", "flashbang", "usp", "ak47", "awp", "flashbang", "ak47", "flashbang", "m4a1", "ak47", "deagle", "flashbang"},
	},
	// ---- M7 weapon-damage flip (plan §8 (M7 row), 2026-11-18): the
	// third weapon column, exact after the capped_dmg ingest stamp
	// closed the gate (Δ4509 = HP-cap 4330 + known-side team 164 +
	// post-match 15). Corpus math (testdata/seed.sql — every damage
	// row now stamps capped_dmg): the cap replay per round (victim HP
	// starts 100, credit = min(dmg, HP), HP -= dmg) turns Σ raw 79200
	// into Σ credit 56160; the pattern is symmetric across the roster,
	// so every player's career ak47 credit is 3 × 2340 = 7020 and the
	// non-ak47 dims (kill/blind weapons, no damage rows) carry 0 beside
	// N. Same group structure as weapon_kills — identical dims/labels.
	{
		name: "weapon_damage", expr: "SELECT :steam_id AS subject_key, dim AS dim, SUM(value) AS value FROM metric('match_weapon_damage') GROUP BY dim",
		scope: "profile", partition: "weapon", format: "int", shortName: "",
		interpretation: "enemy HP-capped damage per weapon (ak47 7020 per player career — 3 matches × 2340; raw Σ 79200 caps to 56160)",
		rows:           24, wantValues: []float64{7020.0, math.NaN(), math.NaN(), 7020.0, math.NaN(), math.NaN(), 7020.0, math.NaN(), math.NaN(), 7020.0, math.NaN(), math.NaN(), 7020.0, math.NaN(), math.NaN(), 7020.0, math.NaN(), math.NaN(), 7020.0, math.NaN(), math.NaN(), 7020.0, math.NaN(), math.NaN()}, wantLabels: "Alice,Alice,Alice,Bob,Bob,Bob,Carol,Carol,Carol,Dave,Dave,Dave,Eve,Eve,Eve,Frank,Frank,Frank,Grace,Grace,Grace,Heidi,Heidi,Heidi",
		wantDims: []string{"ak47", "flashbang", "usp", "ak47", "awp", "flashbang", "ak47", "flashbang", "m4a1", "ak47", "deagle", "flashbang", "ak47", "flashbang", "usp", "ak47", "awp", "flashbang", "ak47", "flashbang", "m4a1", "ak47", "deagle", "flashbang"},
	},
	// ---- grammar addendum (plan §8 (M8 rows), 2026-11-17): the two
	// M8 rows Phase 4 reported NOT expressible, now over the next()
	// round window and the diff() row difference. Corpus math
	// (testdata/seed.sql): the shared corpus writes NEITHER
	// classification rows (see the T2 note above — join_test's rig owns
	// match 1's labels) NOR consecutive same-side wins (winners
	// alternate by parity), so pistol_hold's two counts are 0/0 → the
	// honest empty-set 0 beside N (24 rounds of the group), and
	// avg_equip_gap is (12 × +500) + (12 × −500) over the 24 decided
	// rounds → exactly 0 (equip 2500 ct / 2000 t every round: +500 on
	// each odd CT win, −500 on each even T win — a non-directional
	// subtraction would read +500 here, so the orientation is pinned).
	// The DISCRIMINATING hand-computed cases (a HELD pistol round, an
	// upset round the loser's fatter buy loses, an undecided round the
	// card skips) live in econ_equivalence_test.go's dedicated fixture
	// — the alternation and the empty label table make them
	// structurally unreachable on the shared corpus.
	{
		name: "pistol_hold", expr: "SELECT '' AS subject_key, '' AS dim, v AS value FROM (SELECT rounds.match_id AS mid, rounds.match_id AS grp, 1.0*(SUM(CASE WHEN (((round_classifications.label = 'pistol') AND (rounds.winner != '')) AND ((SELECT nx0.winner FROM rounds AS nx0 WHERE nx0.match_id = rounds.match_id AND nx0.number > rounds.number ORDER BY nx0.number LIMIT 1) = rounds.winner)) THEN 1 ELSE 0 END)) / NULLIF((SUM(CASE WHEN ((round_classifications.label = 'pistol') AND (rounds.winner != '')) THEN 1 ELSE 0 END)), 0) AS v FROM rounds LEFT JOIN round_classifications ON rounds.match_id = round_classifications.match_id AND rounds.number = round_classifications.round WHERE rounds.match_id = :match_id GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", subject: "match", format: "percent", shortName: "",
		interpretation: "pistol rounds won where that side also won the following round ÷ pistol rounds won (no label rows in the shared corpus → 0 beside N)",
		rows:           3, wantAll: 0, wantLabels: "1,2,3",
	},
	{
		name: "avg_equip_gap", expr: "SELECT '' AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, match_id AS grp, AVG(CASE WHEN (winner != '') THEN (CASE WHEN (winner = 'ct') THEN (equip_ct - equip_t) ELSE (equip_t - equip_ct) END) END) AS v FROM rounds WHERE rounds.match_id = :match_id GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", subject: "match", format: "currency", shortName: "",
		interpretation: "mean winner-minus-loser freeze-end equip over decided rounds (alternating ±500 → 0; N = the match's rounds)",
		rows:           3, wantAll: 0, wantLabels: "1,2,3",
	},
	// ---- view-aggregate relocation addendum (ME8 exception audit,
	// 2026-11-18): the force card's per-team count pairs — the last
	// view-computed card numbers, relocated onto seeds under the
	// view-aggregate rule's third clause (the discriminating shapes —
	// a side switch, both teams force-buying, an analyzed zero-force
	// match, the unanalyzed absence — live in econ_equivalence_test.go).
	// Corpus math (testdata/seed.sql): force class rows on matches 2-3
	// only (rounds 2-4 both sides; match 1 carries NONE, so it produces
	// no group and no row — the honest empty, never a fabricated 0);
	// ct wins only round 3 of its three force rounds (1), t wins rounds
	// 2 and 4 (2); N is the team's class rows behind the value (3),
	// never the filtered force rows.
	{
		name: "team_force_wins", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT round_side_classes.match_id AS mid, round_side_classes.team AS grp, SUM(CASE WHEN ((round_side_classes.class = 'force') AND (rounds.winner = round_side_classes.side)) THEN 1 ELSE 0 END) AS v FROM round_side_classes LEFT JOIN rounds ON round_side_classes.match_id = rounds.match_id AND round_side_classes.round = rounds.number WHERE round_side_classes.match_id = :match_id AND (round_side_classes.team <> '') GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", subject: "team", format: "int", shortName: "",
		interpretation: "force rounds that team won (corpus matches 2-3: ct 1, t 2; match 1 unanalyzed → no row)",
		rows:           4, wantValues: []float64{1, 2, 1, 2}, wantLabels: "ct,t,ct,t",
	},
	{
		name: "team_force_rounds", expr: "SELECT grp AS subject_key, '' AS dim, v AS value FROM (SELECT match_id AS mid, team AS grp, SUM(CASE WHEN (class = 'force') THEN 1 ELSE 0 END) AS v FROM round_side_classes WHERE round_side_classes.match_id = :match_id AND (team <> '') GROUP BY mid, grp ORDER BY mid, grp) WHERE mid = :match_id",
		scope: "match", subject: "team", format: "int", shortName: "",
		interpretation: "that team's own force-buy rounds (corpus matches 2-3: 3 each — every class row there is force)",
		rows:           4, wantValues: []float64{3, 3, 3, 3}, wantLabels: "ct,t,ct,t",
	},
	{
		name: "match_won", expr: "SELECT ps.steam_id AS subject_key, '' AS dim, ps.won AS value FROM player_stats ps WHERE ps.match_id = :match_id AND ps.steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = ps.match_id AND p.steam_id = ps.steam_id AND p.is_bot = 1)",
		scope: "match", partition: "", format: "int", shortName: "",
		interpretation: "Per player per match: won (1 win, 0 otherwise). Input of the career Win % and Matches.",
		rows:           0,
	},
	{
		name: "match_trade_opps", expr: "SELECT ps.steam_id AS subject_key, '' AS dim, COALESCE(mto.opps, 0) AS value FROM player_stats ps LEFT JOIN match_trade_opps mto ON mto.match_id = ps.match_id AND mto.steam_id = ps.steam_id WHERE ps.match_id = :match_id AND ps.steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = ps.match_id AND p.steam_id = ps.steam_id AND p.is_bot = 1)",
		scope: "match", partition: "", format: "int", shortName: "",
		interpretation: "Per player per match: trade opportunities (match_trade_opps.opps, 0 with no row).",
		rows:           0,
	},
	{
		name: "match_clutch_wins", expr: store.ClutchCTE() + " SELECT c.steam_id AS subject_key, '' AS dim, SUM(c.won) AS value FROM clutch c WHERE c.steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = :match_id AND p.steam_id = c.steam_id AND p.is_bot = 1) GROUP BY c.steam_id",
		scope: "match", partition: "", format: "int", shortName: "",
		interpretation: "Per player per match: clutches won. Numerator of the career Clutch win %.",
		rows:           0,
	},
	{
		name: "match_kast_flags", expr: "SELECT r.steam_id AS subject_key, '' AS dim, SUM(r.kast) AS value FROM player_round_stats r WHERE r.match_id = :match_id AND r.steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = r.match_id AND p.steam_id = r.steam_id AND p.is_bot = 1) GROUP BY r.steam_id",
		scope: "match", partition: "", format: "int", shortName: "",
		interpretation: "Per player per match: rounds with KAST. Numerator of career KAST%.",
		rows:           0,
	},
	{
		name: "match_rounds", expr: "SELECT r.steam_id AS subject_key, '' AS dim, COUNT(*) AS value FROM player_round_stats r WHERE r.match_id = :match_id AND r.steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = r.match_id AND p.steam_id = r.steam_id AND p.is_bot = 1) GROUP BY r.steam_id",
		scope: "match", partition: "", format: "int", shortName: "",
		interpretation: "Per player per match: stored round rows. Denominator of career ADR and KAST%.",
		rows:           0,
	},
	{
		name: "match_map_won", expr: "SELECT ps.steam_id AS subject_key, ps.map AS dim, ps.won AS value FROM player_stats ps WHERE ps.match_id = :match_id AND ps.steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = ps.match_id AND p.steam_id = ps.steam_id AND p.is_bot = 1)",
		scope: "match", partition: "map", format: "int", shortName: "",
		interpretation: "Per player per match, dim = map: won. Input of the career map splits.",
		rows:           0,
	},
	{
		name: "match_map_rounds", expr: "SELECT ps.steam_id AS subject_key, ps.map AS dim, (SELECT COUNT(*) FROM player_round_stats d WHERE d.match_id = ps.match_id AND d.steam_id = ps.steam_id) AS value FROM player_stats ps WHERE ps.match_id = :match_id AND ps.steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = ps.match_id AND p.steam_id = ps.steam_id AND p.is_bot = 1)",
		scope: "match", partition: "map", format: "int", shortName: "",
		interpretation: "Per player per match, dim = map: stored round rows. Denominator of career map ADR.",
		rows:           0,
	},
	{
		name: "match_map_damage", expr: "SELECT m.subject_key AS subject_key, ps.map AS dim, m.value AS value FROM metric('total_damage') m JOIN player_stats ps ON ps.match_id = :match_id AND ps.steam_id = m.subject_key WHERE ps.steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = ps.match_id AND p.steam_id = ps.steam_id AND p.is_bot = 1)",
		scope: "match", partition: "map", format: "int", shortName: "",
		interpretation: "Per player per match, dim = map: total_damage read through metric. Numerator of career map ADR.",
		rows:           0,
	},
	{
		name: "match_map_kills", expr: "SELECT m.subject_key AS subject_key, ps.map AS dim, m.value AS value FROM metric('kills') m JOIN player_stats ps ON ps.match_id = :match_id AND ps.steam_id = m.subject_key WHERE ps.steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = ps.match_id AND p.steam_id = ps.steam_id AND p.is_bot = 1)",
		scope: "match", partition: "map", format: "int", shortName: "",
		interpretation: "Per player per match, dim = map: kills read through metric. Numerator of career map K/D.",
		rows:           0,
	},
	{
		name: "match_map_deaths", expr: "SELECT m.subject_key AS subject_key, ps.map AS dim, m.value AS value FROM metric('deaths') m JOIN player_stats ps ON ps.match_id = :match_id AND ps.steam_id = m.subject_key WHERE ps.steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = ps.match_id AND p.steam_id = ps.steam_id AND p.is_bot = 1)",
		scope: "match", partition: "map", format: "int", shortName: "",
		interpretation: "Per player per match, dim = map: deaths read through metric. Denominator of career map K/D.",
		rows:           0,
	},
	{
		name: "match_side_rounds", expr: "SELECT r.steam_id AS subject_key, r.side AS dim, COUNT(*) AS value FROM player_round_stats r WHERE r.match_id = :match_id AND r.steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = r.match_id AND p.steam_id = r.steam_id AND p.is_bot = 1) GROUP BY r.steam_id, r.side",
		scope: "match", partition: "side", format: "int", shortName: "",
		interpretation: "Per player per match, dim = side: rounds played. Denominator of the career side splits.",
		rows:           0,
	},
	{
		name: "match_side_won", expr: "SELECT r.steam_id AS subject_key, r.side AS dim, SUM(CASE WHEN r.side <> '' AND r.side = rd.winner THEN 1 ELSE 0 END) AS value FROM player_round_stats r LEFT JOIN rounds rd ON rd.match_id = r.match_id AND rd.number = r.round WHERE r.match_id = :match_id AND r.steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = r.match_id AND p.steam_id = r.steam_id AND p.is_bot = 1) GROUP BY r.steam_id, r.side",
		scope: "match", partition: "side", format: "int", shortName: "",
		interpretation: "Per player per match, dim = side: rounds won on that side.",
		rows:           0,
	},
	{
		name: "match_side_kast", expr: "SELECT r.steam_id AS subject_key, r.side AS dim, SUM(r.kast) AS value FROM player_round_stats r WHERE r.match_id = :match_id AND r.steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = r.match_id AND p.steam_id = r.steam_id AND p.is_bot = 1) GROUP BY r.steam_id, r.side",
		scope: "match", partition: "side", format: "int", shortName: "",
		interpretation: "Per player per match, dim = side: KAST rounds on that side.",
		rows:           0,
	},
	{
		name: "match_side_kills", expr: "WITH k AS (SELECT e.round, e.attacker, e.victim, (e.victim <> '' AND e.attacker = e.victim AND e.weapon = 'World' AND dc.attacker IS NOT NULL) AS fake, sa.side AS a_side, sv.side AS v_side FROM events e LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = 'player_disconnect') dc ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim WHERE e.match_id = :match_id AND e.kind = 'kill' AND e.post_match = 0) SELECT r.steam_id AS subject_key, r.side AS dim, SUM(COALESCE(f.n, 0)) AS value FROM player_round_stats r LEFT JOIN (SELECT round, attacker AS steam_id, COUNT(*) AS n FROM k WHERE attacker <> '' AND attacker <> victim AND fake = 0 AND NOT (COALESCE(a_side, '') <> '' AND a_side = v_side) GROUP BY round, attacker) f ON f.round = r.round AND f.steam_id = r.steam_id WHERE r.match_id = :match_id AND r.steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = r.match_id AND p.steam_id = r.steam_id AND p.is_bot = 1) GROUP BY r.steam_id, r.side",
		scope: "match", partition: "side", format: "int", shortName: "",
		interpretation: "Per player per match, dim = side: enemy kills in the rounds played on that side.",
		rows:           0,
	},
	{
		name: "match_side_deaths", expr: "WITH k AS (SELECT e.round, e.attacker, e.victim, (e.victim <> '' AND e.attacker = e.victim AND e.weapon = 'World' AND dc.attacker IS NOT NULL) AS fake, sa.side AS a_side, sv.side AS v_side FROM events e LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = 'player_disconnect') dc ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim WHERE e.match_id = :match_id AND e.kind = 'kill' AND e.post_match = 0) SELECT r.steam_id AS subject_key, r.side AS dim, SUM(COALESCE(f.n, 0)) AS value FROM player_round_stats r LEFT JOIN (SELECT round, victim AS steam_id, COUNT(*) AS n FROM k WHERE victim <> '' AND fake = 0 GROUP BY round, victim) f ON f.round = r.round AND f.steam_id = r.steam_id WHERE r.match_id = :match_id AND r.steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = r.match_id AND p.steam_id = r.steam_id AND p.is_bot = 1) GROUP BY r.steam_id, r.side",
		scope: "match", partition: "side", format: "int", shortName: "",
		interpretation: "Per player per match, dim = side: deaths in the rounds played on that side.",
		rows:           0,
	},
	{
		name: "match_side_dmg", expr: "WITH edmg AS (SELECT e.round, e.attacker, e.capped_dmg, sa.side AS a_side, sv.side AS v_side FROM events e LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim WHERE e.match_id = :match_id AND e.kind = 'damage' AND e.post_match = 0 AND e.attacker <> '' AND e.attacker <> e.victim AND NOT (COALESCE(sa.side, '') <> '' AND sa.side = sv.side)), f AS (SELECT round, attacker AS steam_id, SUM(capped_dmg) AS n FROM edmg GROUP BY round, attacker) SELECT r.steam_id AS subject_key, r.side AS dim, SUM(COALESCE(f.n, 0)) AS value FROM player_round_stats r LEFT JOIN f ON f.round = r.round AND f.steam_id = r.steam_id WHERE r.match_id = :match_id AND r.steam_id <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = r.match_id AND p.steam_id = r.steam_id AND p.is_bot = 1) GROUP BY r.steam_id, r.side",
		scope: "match", partition: "side", format: "int", shortName: "",
		interpretation: "Per player per match, dim = side: HP-capped damage dealt in the rounds played on that side (ruling 49).",
		rows:           0,
	},
	{
		name: "match_weapon_kills", expr: "SELECT events.attacker AS subject_key, events.weapon AS dim, SUM(CASE WHEN ((events.kind = 'kill' AND events.post_match = 0) AND (events.attacker != events.victim)) THEN 1 ELSE 0 END) AS value FROM events WHERE events.match_id = :match_id AND events.attacker <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = events.match_id AND p.steam_id = events.attacker AND p.is_bot = 1) GROUP BY events.attacker, events.weapon",
		scope: "match", partition: "weapon", format: "int", shortName: "",
		interpretation: "Per player per match, dim = weapon: enemy kills with that weapon.",
		rows:           0,
	},
	{
		name: "match_weapon_headshots", expr: "SELECT events.attacker AS subject_key, events.weapon AS dim, SUM(CASE WHEN (((events.kind = 'kill' AND events.post_match = 0) AND (events.attacker != events.victim)) AND (events.headshot = 1)) THEN 1 ELSE 0 END) AS value FROM events WHERE events.match_id = :match_id AND events.attacker <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = events.match_id AND p.steam_id = events.attacker AND p.is_bot = 1) GROUP BY events.attacker, events.weapon",
		scope: "match", partition: "weapon", format: "int", shortName: "",
		interpretation: "Per player per match, dim = weapon: enemy headshot kills with that weapon.",
		rows:           0,
	},
	{
		name: "match_weapon_damage", expr: "SELECT events.attacker AS subject_key, events.weapon AS dim, SUM(CASE WHEN ((events.kind = 'damage' AND events.post_match = 0) AND (events.attacker != events.victim) AND (NOT (COALESCE(pa.side, '') <> '' AND COALESCE(pa.side, '') = COALESCE(pv.side, '')))) THEN events.capped_dmg END) AS value FROM events LEFT JOIN round_player_sides AS pa ON pa.match_id = events.match_id AND pa.round = events.round AND pa.steam_id = events.attacker LEFT JOIN round_player_sides AS pv ON pv.match_id = events.match_id AND pv.round = events.round AND pv.steam_id = events.victim WHERE events.match_id = :match_id AND events.attacker <> '' AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = events.match_id AND p.steam_id = events.attacker AND p.is_bot = 1) GROUP BY events.attacker, events.weapon",
		scope: "match", partition: "weapon", format: "int", shortName: "",
		interpretation: "Per player per match, dim = weapon: capped enemy damage with that weapon.",
		rows:           0,
	},
}

// eightLabels is the corpus roster in subject (steam_id) ASC order —
// every grouped preview's label expectation.
const eightLabels = "Alice,Bob,Carol,Dave,Eve,Frank,Grace,Heidi"

// threeMapDims is the map partition's row order for EIGHT players (dim
// ASC per subject: de_dust2, de_inferno, de_mirage — the corpus plays
// each map once), the wantDims expectation of every map seed row.
var threeMapDims = []string{
	"de_dust2", "de_inferno", "de_mirage",
	"de_dust2", "de_inferno", "de_mirage",
	"de_dust2", "de_inferno", "de_mirage",
	"de_dust2", "de_inferno", "de_mirage",
	"de_dust2", "de_inferno", "de_mirage",
	"de_dust2", "de_inferno", "de_mirage",
	"de_dust2", "de_inferno", "de_mirage",
	"de_dust2", "de_inferno", "de_mirage",
}

// mapADRValues is the map_adr fixture: player i's pooled per-map ADR —
// 100i damage ÷ 24 counted rounds, once per map (players 1..8, three
// dims each).
var mapADRValues = []float64{
	97.5,
	97.5,
	97.5,
	97.5,
	97.5,
	97.5,
	97.5,
	97.5,
	97.5,
	97.5,
	97.5,
	97.5,
	97.5,
	97.5,
	97.5,
	97.5,
	97.5,
	97.5,
	97.5,
	97.5,
	97.5,
	97.5,
	97.5,
	97.5,
}

// TestBuiltinSeedMetrics is the acceptance test: the schema-seeded
// builtins must (a) exist with seeded expr + subject-addressed doc
// matching this table, (b) compile, (c) return the hand-computed seed
// values with labels and sample sizes, and (d) carry formula
// documentation.
func TestBuiltinSeedMetrics(t *testing.T) {
	st := seededStore(t)

	// (a) Lock the schema-seeded builtin rows to this table. The
	// group_by column no longer exists (stored-metrics W1) and the
	// groupBy parameter retired with W2: the lock is scope + format +
	// short_name + the subject-addressed doc, per the schema.sql
	// coordination-contract header. The doc reword moves WITH this lock
	// (schema.sql's seed doc is prose-only — no DDL structure change):
	// the retired "grouped by player" phrasing must be gone and the
	// subject-addressed one present — "addressed per player" for every
	// seed, with the join wording ("over the joined sources") required
	// of exactly the multi-source exprs (the criterion that partitions
	// the two phrasings).
	res, err := st.RunReadOnly(
		// The F2 raw fold seeds (raw_*) are locked by TestRawFoldSeeds, not this table;
		// the clutch and alive_count raw seeds (PLAN item 19) are not sugar rows either.
		`SELECT name, expr, doc, format, short_name FROM metrics WHERE origin = 'builtin' AND name NOT LIKE 'raw\_%' ESCAPE '\' AND name NOT IN ('clutch', 'alive_count') ORDER BY name`,
		nil, 200, 5000,
	)
	if err != nil {
		t.Fatalf("read builtins: %v", err)
	}
	// There is no scope, subject or partition column (dogfood/PLAN.md ruling
	// 51): the scope is derived from each statement's binds and checked here.
	type seedRow struct{ expr, doc, format, shortName string }
	got := map[string]seedRow{}
	for _, r := range res.Rows {
		got[r[0].(string)] = seedRow{
			expr: r[1].(string), doc: r[2].(string), format: r[3].(string), shortName: r[4].(string),
		}
	}
	if len(got) != len(builtinSeed) {
		t.Errorf("builtin count = %d, want %d", len(got), len(builtinSeed))
	}
	for _, f := range builtinSeed {
		row, ok := got[f.name]
		if !ok {
			t.Errorf("builtin %q missing from the schema seed", f.name)
			continue
		}
		wantSubject := f.subject
		if wantSubject == "" {
			wantSubject = "player" // the DDL default every player row relies on
		}
		if row.expr != f.expr {
			t.Errorf("builtin %q seeded expr = %q, want %q", f.name, row.expr, f.expr)
		}
		if got := store.ScopeOfExpr(row.expr); got != f.scope {
			t.Errorf("builtin %q derives scope %q from its binds, want %q", f.name, got, f.scope)
		}
		if row.format != f.format {
			t.Errorf("builtin %q format = %q, want %q", f.name, row.format, f.format)
		}
		if row.shortName != f.shortName {
			t.Errorf("builtin %q short_name = %q, want %q", f.name, row.shortName, f.shortName)
		}
		if row.doc == "" {
			t.Errorf("builtin %q has empty doc (every metric documents its formula)", f.name)
		}
		if strings.Contains(row.doc, "grouped by player") {
			t.Errorf("builtin %q doc still carries the retired groupBy phrasing: %s", f.name, row.doc)
		}
		if want := "addressed per " + wantSubject; !strings.Contains(row.doc, want) {
			t.Errorf("builtin %q doc missing %q (the subject-addressed phrasing): %s", f.name, want, row.doc)
		}
	}

	// (b)+(c)+(d) compile → run → assert values, sample sizes, labels.
	// Every seed is raw SQL (ruling 22). Its stored result is the reserved
	// columns only: no N, no label. A profile seed runs library-wide, so its
	// rows are the fixture's rows. A match seed stores one row set per match
	// (there is no library-wide view of a match-scoped statement), so it is
	// checked here by running at every corpus match; its values are proven
	// per match by the equivalence suites.
	matchIDs := []int64{}
	ids, err := st.RunReadOnly(`SELECT id FROM matches ORDER BY id`, nil, 100, 5000)
	if err != nil {
		t.Fatalf("list matches: %v", err)
	}
	for _, r := range ids.Rows {
		matchIDs = append(matchIDs, r[0].(int64))
	}
	for _, f := range builtinSeed {
		t.Run(f.name, func(t *testing.T) {
			if _, perr, err := CheckRawSave(st, f.expr); err != nil || perr != nil {
				t.Fatalf("save gate: perr=%v err=%v", perr, err)
			}
			if f.scope != "profile" {
				if len(metricRefNames(f.expr)) > 0 {
					// A statement that reads metric() runs through the production
					// path, which rewrites the reference to the stored values.
					storeMatchChain(t, st, f.expr, matchIDs)
					storeMatchMetric(t, st, f.name, matchIDs)
					return
				}
				for _, id := range matchIDs {
					rawPreviewRows(t, st, f.expr, "match:"+itoa(id))
				}
				return
			}
			var rows []store.RawMetricRow
			if strings.Contains(f.expr, ":steam_id") {
				// The per-match values it reads are stored first, through the production run.
				storeMatchChain(t, st, f.expr, matchIDs)
				// A career statement runs once per player: one row each, the eight corpus humans.
				for i := 1; i <= 8; i++ {
					rows = append(rows, rawPreviewSteamRows(t, st, f.expr, fmt.Sprintf("7656119800000000%d", i))...)
				}
			} else {
				rows = rawPreviewRows(t, st, f.expr, "")
			}
			if len(rows) != f.rows {
				t.Fatalf("rows = %d, want %d (%+v)", len(rows), f.rows, rows)
			}
			for i, r := range rows {
				want := f.wantAll
				if f.wantValues != nil {
					want = f.wantValues[i]
				}
				got := rawValue(r)
				if math.IsNaN(want) != math.IsNaN(got) || (!math.IsNaN(got) && got != want) {
					t.Errorf("row %d value = %v, want %v", i, got, want)
				}
				if f.wantDims != nil && r.Dim != f.wantDims[i] {
					t.Errorf("row %d dim = %q, want %q", i, r.Dim, f.wantDims[i])
				}
			}
		})
	}
}

// TestSyntheticCorpusCounts pins the seed row counts the property tests
// and the fixture math rely on (formulas in testdata/seed.sql header).
func TestSyntheticCorpusCounts(t *testing.T) {
	st := seededStore(t)
	for table, want := range map[string]int{
		"matches": 3, "players": 24, "player_stats": 24, "rounds": 72,
		"events": 1944, "player_round_stats": 576, "round_economy": 144,
		"kill_tags": 216, "utility_events": 216,
		"chat": 12,
		// Subject-axis seed inputs: force class rows for matches 2-3
		// only (match 1 belongs to join_test's classification rig).
		"round_side_classes": 12,
		// Join fixtures: 3 matches × 7 rows (opps = 10i for i ≤ 6,
		// Grace stored-zero; Heidi absent — seed.sql header).
		"match_trade_opps": 21,
	} {
		res, err := st.RunReadOnly("SELECT COUNT(*) FROM "+table, nil, 1, 5000)
		if err != nil {
			t.Fatalf("count %s: %v", table, err)
		}
		if n := int(res.Rows[0][0].(int64)); n != want {
			t.Errorf("%s rows = %d, want %d", table, n, want)
		}
	}
}

// rawPreviewSteamRows runs a career statement (one that binds :steam_id) for
// one player and returns its rows, through the same gate and result reader
// as rawPreviewRows.
func rawPreviewSteamRows(t *testing.T, st *store.Store, expr, steam string) []store.RawMetricRow {
	t.Helper()
	rs := store.RawScope{SteamID: steam}
	g, gperr, err := GateSQL(expr, rawExists(st), rawSuppliedFor(rs))
	if err != nil {
		t.Fatalf("gate %q: %v", expr, err)
	}
	if gperr != nil {
		t.Fatalf("gate %q (steam %q): %s", expr, steam, gperr.Message)
	}
	var args []any
	for _, b := range g.Binds {
		if b == rawBindSteam {
			args = append(args, sql.Named("steam_id", steam))
		}
	}
	cfg, err := st.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	res, err := st.QueryMetric(t.Context(), rewriteRawRefs(expr, g, cfg.RuleVersion), args)
	if err != nil {
		t.Fatalf("run %q (steam %q): %v", expr, steam, err)
	}
	rows, err := rawResultRows(res)
	if err != nil {
		t.Fatalf("result %q (steam %q): %v", expr, steam, err)
	}
	return rows
}

var metricRefRE = regexp.MustCompile(`metric\('([a-z0-9_]+)'\)`)

// metricRefNames lists the metric('name') references in an expression, in order.
func metricRefNames(expr string) []string {
	var out []string
	for _, m := range metricRefRE.FindAllStringSubmatch(expr, -1) {
		out = append(out, m[1])
	}
	return out
}

// storeMatchMetric runs one match-scope builtin for each match through the
// production raw run, so its stored per-match values exist for metric() reads.
func storeMatchMetric(t *testing.T, st *store.Store, name string, matchIDs []int64) {
	t.Helper()
	def, err := st.GetMetricByName(name)
	if err != nil {
		t.Fatalf("GetMetricByName(%s): %v", name, err)
	}
	cfg, err := st.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	for _, id := range matchIDs {
		if err := RunRaw(t.Context(), st, def.ID, def.Version, cfg.RuleVersion, def.Expr, store.RawScope{MatchID: id}); err != nil {
			t.Fatalf("RunRaw(%s, match %d): %v", name, id, err)
		}
	}
}

// storeMatchChain stores, in dependency order, every match-scope metric the
// statement reads through metric(), and the metrics those read in turn, so a
// per-player statement sees fresh per-match values (the sweep's topological
// order, applied by hand).
func storeMatchChain(t *testing.T, st *store.Store, expr string, matchIDs []int64) {
	t.Helper()
	seen := map[string]bool{}
	var visit func(e string)
	visit = func(e string) {
		for _, name := range metricRefNames(e) {
			if seen[name] {
				continue
			}
			seen[name] = true
			def, err := st.GetMetricByName(name)
			if err != nil {
				t.Fatalf("GetMetricByName(%s): %v", name, err)
			}
			visit(def.Expr)
			storeMatchMetric(t, st, name, matchIDs)
		}
	}
	visit(expr)
}

// corpusMatchIDs lists the corpus match ids in ascending order.
func corpusMatchIDs(t *testing.T, st *store.Store) []int64 {
	t.Helper()
	res, err := st.RunReadOnly(`SELECT id FROM matches ORDER BY id`, nil, 100, 5000)
	if err != nil {
		t.Fatalf("list matches: %v", err)
	}
	var out []int64
	for _, r := range res.Rows {
		out = append(out, r[0].(int64))
	}
	return out
}

// careerRows runs one per-player statement for each of the eight corpus
// humans, after the per-match values it reads are stored, and returns the
// rows the stored career read would serve (a player with no row keeps none).
func careerRows(t *testing.T, st *store.Store, expr string) []store.RawMetricRow {
	t.Helper()
	storeMatchChain(t, st, expr, corpusMatchIDs(t, st))
	var rows []store.RawMetricRow
	for i := 1; i <= 8; i++ {
		rows = append(rows, rawPreviewSteamRows(t, st, expr, fmt.Sprintf("7656119800000000%d", i))...)
	}
	return rows
}

// careerPreview is careerRows keyed by subject, for a statement with no dim.
func careerPreview(t *testing.T, st *store.Store, expr string) map[string]float64 {
	t.Helper()
	out := map[string]float64{}
	for _, r := range careerRows(t, st, expr) {
		out[r.SubjectKey] = rawValue(r)
	}
	return out
}
