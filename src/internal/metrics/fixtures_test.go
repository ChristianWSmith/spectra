package metrics

import (
	"database/sql"
	"path/filepath"
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

// builtinSeed maps the NINETY-TWO schema-seeded builtins (schema.sql —
// name/expr/scope/subject/format/short_name/denominator are LOCKED to
// the baseline seed by this table) onto their hand-computed seed
// expectations. (2026-11-17 re-pin of the FIFTY-NINE count: plan §7 M3
// / §8 adds the dmg_no_kill + kill_conversion match rows; the same
// day's owner Option A extension adds the 22-row count addendum —
// EIGHTY-THREE / 64 match + 19 profile — an owner amendment the
// plan's §8 does not list; the subject-axis addendum (plan §8 (M8/M4
// rows), 2026-11-17) then adds 4 rows with an explicit subject —
// EIGHTY-SEVEN / 67 match + 20 profile — pistol_hold and
// avg_equip_gap among the plan's six rows reported NOT expressible in
// the grammar; the identity addendum (plan §8 (M1 identity row),
// 2026-11-17) finally adds the five M1 top-card seeds — NINETY-TWO /
// 72 match + 20 profile — subject=match, format=identity.) interpretation records how the seeded expression states
// the metric (never silently — the formula and any proxy/deviation
// live in the row's doc). Since the subject axis, every statement is
// grouped by the DECLARED subject's key — the player shape for the
// player rows (the groupBy parameter retired with W2), the match/team
// key for the addendum rows.
//
// The expectations are hand-computed over the committed corpus
// (testdata/seed.sql — 3 identical matches × 8 players × 24 rounds;
// formulas in its header): player_stats carries kills = 2i, deaths = i,
// headshots = i, total_damage = 100i, adr = 50+5i (the hand-written
// gradient only career_adr_sigma still reads — every ADR seed now
// recomputes from total_damage with the `rounds` denominator, owner
// rule 2026-11-16), rounds_played = 24 (no seed reads it any more),
// trade_kills = i per match for player i (1..8), entry_kills /
// utility_damage / enemies_flashed are absent → 0, and every player has
// 72 player_round_stats rows with a 0.5 KAST mean (36 of 72). The
// corpus has NO clutches and no player_round_stats surprises, which is
// what makes the N values (COUNT(*) behind each aggregate) exact.
var builtinSeed = []struct {
	name           string
	expr           string
	scope          string
	subject        string // "" = player (the DDL default the player rows rely on)
	format         string
	shortName      string
	denominator    string
	interpretation string
	rows           int
	wantValues     []float64 // per subject, ORDER BY grp ASC (nil → wantAll)
	wantAll        float64
	wantN          int    // expected N per row (0 = don't assert)
	wantLabels     string // expected labels joined ("" = don't assert)
}{
	{
		name:        "trade_rate",
		expr:        "from player_stats, match_trade_opps: ratio(sum(trade_kills), sum(opps))",
		scope:       "match",
		format:      "percent",
		shortName:   "",
		denominator: "",
		interpretation: "trade successes / total trade opportunities over the engine-derived LEFT JOIN " +
			"(match_id, steam_id) — a ratio, not a share, so it may exceed 100% (profile TradeRate note)",
		// join_test.go TestJoinedAcceptanceRatio's seed math: ratio =
		// 3i/30i = 0.1 for i ≤ 6; Grace's stored opps = 0 and Heidi's
		// absent row both surface as Value 0 beside N.
		rows: 8, wantValues: []float64{0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0, 0}, wantN: 3,
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
		name: "adr", expr: "from player_stats: sum(total_damage)",
		scope: "match", format: "float1", shortName: "ADR", denominator: "rounds",
		interpretation: "damage per round of the match re-computed from raw inputs (extract's adr formula)",
		rows:           8,
		wantValues:     []float64{300.0 / 72, 600.0 / 72, 900.0 / 72, 1200.0 / 72, 1500.0 / 72, 1800.0 / 72, 2100.0 / 72, 2400.0 / 72},
		wantN:          3, wantLabels: eightLabels,
	},
	{
		// D7: entry_kills is absent from the corpus's INSERTs → 0 for
		// everyone; the `rounds` denominator (the subject's 72 career
		// rounds) is non-NULL, so the value is a plain 0, not
		// NULL-beside-N.
		name: "entry_rate", expr: "from player_stats: sum(entry_kills)",
		scope: "match", format: "percent", shortName: "Entry%", denominator: "rounds",
		interpretation: "entry (first-blood) kills per round of the match (0 — the corpus records no entry kills)",
		rows:           8, wantAll: 0, wantN: 3, wantLabels: eightLabels,
	},
	{
		// D4: sum(headshots)/sum(kills) = 3i/6i = 0.5 for every player.
		name: "hs_pct", expr: "from player_stats: ratio(sum(headshots), sum(kills))",
		scope: "match", format: "percent", shortName: "HS%", denominator: "",
		interpretation: "headshot share of kills (corpus: headshots = kills/2 → 0.5)",
		rows:           8, wantAll: 0.5, wantN: 3, wantLabels: eightLabels,
	},
	{
		// D6: AVG over the player's 72 player_round_stats rows — 36
		// KAST rounds each → 0.5, N = 72 (the source rows, not matches).
		name: "kast", expr: "from player_round_stats: avg(kast)",
		scope: "match", format: "percent", shortName: "KAST%", denominator: "",
		interpretation: "per-round KAST flag mean (36/72 per player)",
		rows:           8, wantAll: 0.5, wantN: 72, wantLabels: eightLabels,
	},
	{
		// D5: sum(kills)/sum(deaths) = 6i/3i = 2 for every player (no
		// zero-death subject here — Q1's NULLIF edge is the doc note).
		name: "kd", expr: "from player_stats: ratio(sum(kills), sum(deaths))",
		scope: "match", format: "float2", shortName: "K/D", denominator: "",
		interpretation: "kills per death (corpus: kills = 2×deaths → 2)",
		rows:           8, wantAll: 2, wantN: 3, wantLabels: eightLabels,
	},
	{
		// w13d: the scoreboard's KDA conversion — the scalar max()
		// value form floors the denominator exactly like the Go
		// spelling GetScoreboard served ((kills+assists)/MAX(deaths,1)),
		// which scoreboard_equivalence_test.go pins as its oracle.
		// Corpus math: (2i + 0)/max(i, 1) = 2 (assists = 0, deaths = i
		// ≥ 1 — the zero-death floor has no subject here, so that edge
		// is the equivalence test's, with its own zero-death row).
		name: "kda", expr: "from player_stats: ratio(sum(kills + assists), max(sum(deaths), 1))",
		scope: "match", format: "float2", shortName: "KDA", denominator: "",
		interpretation: "kills plus assists per floored death (corpus: kills = 2×deaths, assists = 0 → 2)",
		rows:           8, wantAll: 2, wantN: 3, wantLabels: eightLabels,
	},
	{
		// D8: sum(trade_kills)/sum(deaths) = 3i/3i = 1 (100%) — a ratio
		// over OWN deaths, unlike trade_rate's opportunities denominator.
		name: "trade_rate_deaths", expr: "from player_stats: ratio(sum(trade_kills), sum(deaths))",
		scope: "match", format: "percent", shortName: "Trade%", denominator: "",
		interpretation: "trades as a share of the player's own deaths (corpus: equal → 1)",
		rows:           8, wantAll: 1, wantN: 3, wantLabels: eightLabels,
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
		name: "career_adr", expr: "from player_stats: sum(total_damage)",
		scope: "profile", format: "float1", shortName: "ADR", denominator: "rounds",
		interpretation: "pooled career damage per round (Σ damage ÷ Σ rounds — never a mean of per-match ADRs)",
		rows:           8,
		wantValues:     []float64{300.0 / 72, 600.0 / 72, 900.0 / 72, 1200.0 / 72, 1500.0 / 72, 1800.0 / 72, 2100.0 / 72, 2400.0 / 72},
		wantN:          3, wantLabels: eightLabels,
	},
	{
		// D3: population σ over three IDENTICAL values → exactly 0
		// (the sqrt(max(…,0)) idiom clamps float noise).
		name: "career_adr_sigma", expr: "from player_stats: stddev(adr)",
		scope: "profile", format: "float1", shortName: "ADR σ", denominator: "",
		interpretation: "population stddev of per-match ADR (constant series → 0)",
		rows:           8, wantAll: 0, wantN: 3, wantLabels: eightLabels,
	},
	{
		// D11: enemies_flashed absent from the corpus's INSERTs → 0.
		name: "career_avg_enemies_flashed", expr: "from player_stats: avg(enemies_flashed)",
		scope: "profile", format: "float1", shortName: "Flash", denominator: "",
		interpretation: "mean enemies flashed per match (0 — the corpus records none)",
		rows:           8, wantAll: 0, wantN: 3, wantLabels: eightLabels,
	},
	{
		// D12: utility_damage absent from the corpus's INSERTs → 0.
		name: "career_avg_util_damage", expr: "from player_stats: avg(utility_damage)",
		scope: "profile", format: "float1", shortName: "Util", denominator: "",
		interpretation: "mean utility damage per match (0 — the corpus records none)",
		rows:           8, wantAll: 0, wantN: 3, wantLabels: eightLabels,
	},
	{
		// D10: the corpus records NO clutches (see TestSyntheticCorpus-
		// Counts), so a subject-grouped statement produces no groups →
		// zero rows. Honest empty, never a fabricated 0 row.
		name: "career_clutch_win_rate", expr: "from clutches: avg(won)",
		scope: "profile", format: "percent", shortName: "CW%", denominator: "",
		interpretation: "share of the player's clutches won (clutchless corpus → no rows)",
		rows:           0,
	},
	{
		// D4p: same pooled shape as hs_pct at profile scope (the corpus
		// is three identical matches, so pooled == per-match).
		name: "career_hs_pct", expr: "from player_stats: ratio(sum(headshots), sum(kills))",
		scope: "profile", format: "percent", shortName: "HS%", denominator: "",
		interpretation: "career pooled headshot share (0.5 — identical to the match seed here)",
		rows:           8, wantAll: 0.5, wantN: 3, wantLabels: eightLabels,
	},
	{
		// D6p: all 72 career rows — same mean as the match seed here
		// (three identical matches), N the career row count.
		name: "career_kast", expr: "from player_round_stats: avg(kast)",
		scope: "profile", format: "percent", shortName: "KAST%", denominator: "",
		interpretation: "career KAST mean over every stored round (0.5 — 36/72)",
		rows:           8, wantAll: 0.5, wantN: 72, wantLabels: eightLabels,
	},
	{
		// D5p: pooled kills/deaths over the whole career — 2 (sums,
		// never a mean of ratios).
		name: "career_kd", expr: "from player_stats: ratio(sum(kills), sum(deaths))",
		scope: "profile", format: "float2", shortName: "K/D", denominator: "",
		interpretation: "career pooled kills per death (6i/3i = 2)",
		rows:           8, wantAll: 2, wantN: 3, wantLabels: eightLabels,
	},
	{
		// D9: byte-identical expr to trade_rate at PROFILE scope — the
		// cross-scope ref ban forbids referencing the match seed, so the
		// join recomputes from the sources; same numbers here.
		name: "career_trade_rate", expr: "from player_stats, match_trade_opps: ratio(sum(trade_kills), sum(opps))",
		scope: "profile", format: "percent", shortName: "Trade%", denominator: "",
		interpretation: "career trade opportunities ratio (recomputes the join — cross-scope ref ban)",
		rows:           8, wantValues: []float64{0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0, 0}, wantN: 3,
		wantLabels: eightLabels,
	},
	// ---- inferred set, match scope (27). Corpus math (seed.sql header):
	// the per-match columns the corpus does NOT write default to 0, the
	// per-round flags are exact, and the N of a player_stats-backed seed
	// is the subject's 3 matches.
	{
		name: "assists", expr: "from player_stats: sum(assists)",
		scope: "match", format: "int", shortName: "A", denominator: "",
		interpretation: "cross-team assist count (corpus records assists = 0)",
		rows:           8, wantAll: 0, wantN: 3, wantLabels: eightLabels,
	},
	{
		name: "flash_assists", expr: "from player_stats: sum(flash_assists)",
		scope: "match", format: "int", shortName: "", denominator: "",
		interpretation: "AssistedFlash-split assists (column absent from the corpus → 0)",
		rows:           8, wantAll: 0, wantN: 3, wantLabels: eightLabels,
	},
	{
		name: "enemies_flashed", expr: "from player_stats: sum(enemies_flashed)",
		scope: "match", format: "int", shortName: "", denominator: "",
		interpretation: "blinded enemies (column absent from the corpus → 0)",
		rows:           8, wantAll: 0, wantN: 3, wantLabels: eightLabels,
	},
	{
		name: "entry_kills", expr: "from player_stats: sum(entry_kills)",
		scope: "match", format: "int", shortName: "Open K", denominator: "",
		interpretation: "first bloods (column absent → 0; the corpus writes opening_kills instead, which is why the I4 direct form diverges here)",
		rows:           8, wantAll: 0, wantN: 3, wantLabels: eightLabels,
	},
	{
		name: "entry_deaths", expr: "from player_stats: sum(entry_deaths)",
		scope: "match", format: "int", shortName: "Open D", denominator: "",
		interpretation: "first-blood victims (column absent → 0)",
		rows:           8, wantAll: 0, wantN: 3, wantLabels: eightLabels,
	},
	{
		name: "best_streak", expr: "from player_stats: max(best_streak)",
		scope: "match", format: "int", shortName: "Streak", denominator: "",
		interpretation: "longest streak (column absent → 0); one player_stats row per subject-match, so max == the stored value",
		rows:           8, wantAll: 0, wantN: 3, wantLabels: eightLabels,
	},
	{
		name: "two_k", expr: "from player_stats: sum(two_k)",
		scope: "match", format: "int", shortName: "2K", denominator: "",
		interpretation: "rounds with exactly 2 kills (column absent → 0)",
		rows:           8, wantAll: 0, wantN: 3, wantLabels: eightLabels,
	},
	{
		name: "three_k", expr: "from player_stats: sum(three_k)",
		scope: "match", format: "int", shortName: "3K", denominator: "",
		interpretation: "rounds with exactly 3 kills (column absent → 0)",
		rows:           8, wantAll: 0, wantN: 3, wantLabels: eightLabels,
	},
	{
		name: "four_k", expr: "from player_stats: sum(four_k)",
		scope: "match", format: "int", shortName: "4K", denominator: "",
		interpretation: "rounds with exactly 4 kills (column absent → 0)",
		rows:           8, wantAll: 0, wantN: 3, wantLabels: eightLabels,
	},
	{
		name: "five_k", expr: "from player_stats: sum(five_k)",
		scope: "match", format: "int", shortName: "5K", denominator: "",
		interpretation: "rounds with exactly 5 kills (column absent → 0)",
		rows:           8, wantAll: 0, wantN: 3, wantLabels: eightLabels,
	},
	{
		// The corpus writes assists = 0 in every player_round_stats row.
		name: "rounds_with_assist", expr: "from player_round_stats: count(where assists > 0)",
		scope: "match", format: "int", shortName: "", denominator: "",
		interpretation: "rounds with ≥1 assist (the KAST A component as a count — corpus: 0)",
		rows:           8, wantAll: 0, wantN: 72, wantLabels: eightLabels,
	},
	{
		// traded iff the player died and the round ≤ 12 → 3 per match
		// (seed.sql header) → 9 over the three identical matches.
		name: "rounds_traded", expr: "from player_round_stats: sum(traded)",
		scope: "match", format: "int", shortName: "", denominator: "",
		interpretation: "the player's traded deaths (the KAST T flag; corpus: 3/match × 3)",
		rows:           8, wantAll: 9, wantN: 72, wantLabels: eightLabels,
	},
	{
		// trade_kills = i per match for player i (1..8) → library 3i.
		name: "trade_kills", expr: "from player_stats: sum(trade_kills)",
		scope: "match", format: "int", shortName: "Trade", denominator: "",
		interpretation: "stored trade-kill count (corpus: 3i)",
		rows:           8, wantValues: []float64{3, 6, 9, 12, 15, 18, 21, 24}, wantN: 3,
		wantLabels: eightLabels,
	},
	{
		// missed = i per match for i ≤ 6, Grace stored-zero, Heidi
		// absent (LEFT JOIN → NULL → 0 beside N), exactly like
		// TestJoinedAcceptanceRatio's opps side.
		name: "missed_trades", expr: "from player_stats, match_trade_opps: sum(missed)",
		scope: "match", format: "int", shortName: "", denominator: "",
		interpretation: "missed trade opps over the player_stats-anchored LEFT JOIN (corpus: 3i / 0 / 0)",
		rows:           8, wantValues: []float64{3, 6, 9, 12, 15, 18, 0, 0}, wantN: 3,
		wantLabels: eightLabels,
	},
	{
		// engagements: 1 opening + 1 trade + 1 untraded per round over
		// 8 players; the subject's N is its own a_steam rows (36/18
		// alternating), so N is deliberately not asserted (wantN 0).
		name: "eng_opening", expr: "from engagements: count(where kind = 'opening')",
		scope: "match", format: "int", shortName: "", denominator: "",
		interpretation: "opening duels with the subject as A-side (corpus: 18/0 alternating)",
		rows:           8, wantValues: []float64{18, 0, 18, 0, 0, 18, 0, 18},
		wantLabels: eightLabels,
	},
	{
		name: "eng_trade", expr: "from engagements: count(where kind = 'trade')",
		scope: "match", format: "int", shortName: "", denominator: "",
		interpretation: "strict-window trades, A-side (corpus: the opening pattern's complement)",
		rows:           8, wantValues: []float64{0, 18, 0, 18, 18, 0, 18, 0},
		wantLabels: eightLabels,
	},
	{
		name: "eng_traded", expr: "from engagements: count(where kind = 'traded')",
		scope: "match", format: "int", shortName: "", denominator: "",
		interpretation: "A-side kills that got answered — the corpus records NO traded rows (the traded FLAG lives on player_round_stats)",
		rows:           8, wantAll: 0, wantLabels: eightLabels,
	},
	{
		name: "eng_untraded", expr: "from engagements: count(where kind = 'untraded')",
		scope: "match", format: "int", shortName: "", denominator: "",
		interpretation: "A-side kills nobody answered (corpus: 18/0 alternating)",
		rows:           8, wantValues: []float64{18, 0, 18, 0, 0, 18, 0, 18},
		wantLabels: eightLabels,
	},
	{
		// Clutchless corpus (TestSyntheticCorpusCounts) — honest empty,
		// never a fabricated 0 row: rows 0 for all five match-scope
		// clutch seeds and the profile twin below.
		name: "clutches", expr: "from clutches: count()",
		scope: "match", format: "int", shortName: "", denominator: "",
		interpretation: "1vN attempt count (clutchless corpus → no rows)",
		rows:           0,
	},
	{
		name: "clutch_win_rate", expr: "from clutches: avg(won)",
		scope: "match", format: "percent", shortName: "", denominator: "",
		interpretation: "share of clutches won (clutchless corpus → no rows)",
		rows:           0,
	},
	{
		name: "clutch_avg_size", expr: "from clutches: avg(size)",
		scope: "match", format: "float1", shortName: "", denominator: "",
		interpretation: "mean clutch size (clutchless corpus → no rows)",
		rows:           0,
	},
	{
		name: "clutch_avg_hp", expr: "from clutches: avg(hp_left)",
		scope: "match", format: "float1", shortName: "", denominator: "",
		interpretation: "mean ending HP (clutchless corpus → no rows)",
		rows:           0,
	},
	{
		name: "clutch_avg_equip", expr: "from clutches: avg(equip)",
		scope: "match", format: "currency", shortName: "", denominator: "",
		interpretation: "mean held equipment value (clutchless corpus → no rows)",
		rows:           0,
	},
	{
		// utility_events: 216 rows over 8 subjects (3 matches × 24
		// rounds × 1 detonation of each of 3 kinds ÷ 8) → 27 each.
		name: "util_nades", expr: "from utility_events: count()",
		scope: "match", format: "int", shortName: "", denominator: "",
		interpretation: "detonation count (corpus: 27 per subject)",
		rows:           8, wantAll: 27, wantN: 27, wantLabels: eightLabels,
	},
	{
		name: "util_dmg", expr: "from utility_events: sum(damage)",
		scope: "match", format: "int", shortName: "", denominator: "",
		interpretation: "paired detonation damage (corpus: 180 per subject)",
		rows:           8, wantAll: 180, wantN: 27, wantLabels: eightLabels,
	},
	{
		name: "util_flash_ms", expr: "from utility_events: sum(flash_ms)",
		scope: "match", format: "int", shortName: "", denominator: "",
		interpretation: "paired blind milliseconds (corpus: 5400 per subject)",
		rows:           8, wantAll: 5400, wantN: 27, wantLabels: eightLabels,
	},
	{
		// No weapon_drop events in the corpus → value 0; the subject's N
		// is its own event count (270/234 alternating) → not asserted.
		name: "weapon_drops", expr: "from events: count(where kind = 'weapon_drop')",
		scope: "match", format: "int", shortName: "", denominator: "",
		interpretation: "death-drop count (corpus: none recorded)",
		rows:           8, wantAll: 0, wantLabels: eightLabels,
	},
	// ---- inferred set, T2 (10): the corpus writes NEITHER analysis
	// table (round_classifications / round_player_sides are empty), so
	// every label/class count is 0 over a LEFT JOIN that keeps all 72
	// player-rounds (N), while the empty round_player_sides primary
	// produces no groups at all — the value-acceptance rig with INSERTed
	// rows lives in join_test.go TestJoinedClassificationValues.
	{
		name: "round_label_eco", expr: "from player_round_stats, round_classifications: count(where label = 'eco')",
		scope: "match", format: "int", shortName: "", denominator: "",
		interpretation: "rounds labeled eco (empty secondary → 0 beside N = the primary's rounds)",
		rows:           8, wantAll: 0, wantN: 72, wantLabels: eightLabels,
	},
	{
		name: "round_label_force", expr: "from player_round_stats, round_classifications: count(where label = 'force')",
		scope: "match", format: "int", shortName: "", denominator: "",
		interpretation: "rounds labeled force (empty secondary → 0)",
		rows:           8, wantAll: 0, wantN: 72, wantLabels: eightLabels,
	},
	{
		name: "round_label_full", expr: "from player_round_stats, round_classifications: count(where label = 'full')",
		scope: "match", format: "int", shortName: "", denominator: "",
		interpretation: "rounds labeled full (empty secondary → 0)",
		rows:           8, wantAll: 0, wantN: 72, wantLabels: eightLabels,
	},
	{
		name: "round_label_save", expr: "from player_round_stats, round_classifications: count(where label = 'save')",
		scope: "match", format: "int", shortName: "", denominator: "",
		interpretation: "rounds labeled save (empty secondary → 0)",
		rows:           8, wantAll: 0, wantN: 72, wantLabels: eightLabels,
	},
	{
		name: "pistol_rounds", expr: "from player_round_stats, round_classifications: count(where label = 'pistol')",
		scope: "match", format: "int", shortName: "", denominator: "",
		interpretation: "rounds carrying the stored pistol label (empty secondary → 0)",
		rows:           8, wantAll: 0, wantN: 72, wantLabels: eightLabels,
	},
	{
		name: "side_class_eco", expr: "from round_player_sides, round_side_classes: count(where class = 'eco')",
		scope: "match", format: "int", shortName: "", denominator: "",
		interpretation: "rounds played on an eco-classified side (empty primary → no rows)",
		rows:           0,
	},
	{
		name: "side_class_force", expr: "from round_player_sides, round_side_classes: count(where class = 'force')",
		scope: "match", format: "int", shortName: "", denominator: "",
		interpretation: "rounds played on a force-classified side (empty primary → no rows)",
		rows:           0,
	},
	{
		name: "side_class_full", expr: "from round_player_sides, round_side_classes: count(where class = 'full')",
		scope: "match", format: "int", shortName: "", denominator: "",
		interpretation: "rounds played on a full-buy side (empty primary → no rows)",
		rows:           0,
	},
	{
		name: "side_class_save", expr: "from round_player_sides, round_side_classes: count(where class = 'save')",
		scope: "match", format: "int", shortName: "", denominator: "",
		interpretation: "rounds played on a save side (empty primary → no rows)",
		rows:           0,
	},
	{
		name: "side_class_pistol", expr: "from round_player_sides, round_side_classes: count(where class = 'pistol')",
		scope: "match", format: "int", shortName: "", denominator: "",
		interpretation: "rounds played on a pistol-classified side (empty primary → no rows)",
		rows:           0,
	},
	// ---- inferred set, profile scope (1).
	{
		name: "career_clutches", expr: "from clutches: count()",
		scope: "profile", format: "int", shortName: "", denominator: "",
		interpretation: "career 1vN count (clutchless corpus → no rows)",
		rows:           0,
	},
	// ---- addendum: the opening-duel trio (profile) + the victim-side
	// duel count (match).
	{
		// opening_kills = i per match, opening_deaths absent → the
		// denominator equals the numerator, so the rate is exactly 1.
		name: "career_opening_rate", expr: "from player_stats: ratio(sum(opening_kills), sum(opening_kills + opening_deaths))",
		scope: "profile", format: "percent", shortName: "", denominator: "",
		interpretation: "career first-blood duel win share (corpus records no opening deaths → 1.0)",
		rows:           8, wantAll: 1, wantN: 3, wantLabels: eightLabels,
	},
	{
		name: "career_openings", expr: "from player_stats: sum(opening_kills + opening_deaths)",
		scope: "profile", format: "int", shortName: "", denominator: "",
		interpretation: "career opening duels (corpus: 3i)",
		rows:           8, wantValues: []float64{3, 6, 9, 12, 15, 18, 21, 24}, wantN: 3,
		wantLabels: eightLabels,
	},
	{
		name: "career_opener_wins", expr: "from player_stats: sum(opening_kills)",
		scope: "profile", format: "int", shortName: "", denominator: "",
		interpretation: "career opening kills (corpus: 3i)",
		rows:           8, wantValues: []float64{3, 6, 9, 12, 15, 18, 21, 24}, wantN: 3,
		wantLabels: eightLabels,
	},
	{
		// addendum: the victim-side count — the SAME untraded rows read
		// through engagements_victim (subject b_steam). Every corpus
		// player appears as a victim (so 8 rows; 4 of them with value
		// 18, the other 4 with 0 — rows with no untraded duel, never a
		// missing row), and the per-subject N is that victim's own
		// engagement rows (18/36 alternating) → not asserted.
		name: "untraded_deaths", expr: "from engagements_victim: count(where kind = 'untraded')",
		scope: "match", format: "int", shortName: "", denominator: "",
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
		// position three times). N (the subject's own event rows —
		// the kill/blind distribution is not uniform across subjects)
		// is deliberately not asserted (wantN 0), like
		// untraded_deaths above; the ME0 value semantics pin in
		// combat_equivalence_test.go.
		name:  "dmg_no_kill",
		expr:  "from events: sum(where kind = 'damage' and not exists(kind = 'kill' and tick = outer.tick and attacker = outer.attacker and victim = outer.victim), dmg)",
		scope: "match", format: "int", shortName: "", denominator: "",
		interpretation: "damage that never converted into a kill (corpus: no shared tick → all damage, 9900)",
		rows:           8, wantAll: 9900, wantLabels: eightLabels,
	},
	{
		// Same corpus truth from the other side: the converted half
		// sums to 0 for everyone, so the ratio is exactly 0 (a real
		// 0 beside N — the denominator never vanishes). The
		// interesting conversion semantics (same-tick actor pair)
		// are pinned in combat_equivalence_test.go against the
		// retired SQL's characterized values.
		name:  "kill_conversion",
		expr:  "from events: ratio(sum(where kind = 'damage' and exists(kind = 'kill' and tick = outer.tick and attacker = outer.attacker and victim = outer.victim), dmg), sum(where kind = 'damage', dmg))",
		scope: "match", format: "percent", shortName: "", denominator: "",
		interpretation: "share of this player's damage that converts into kills (corpus: 0 — no shared tick)",
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
		name: "kills", expr: "from player_stats: sum(kills)",
		scope: "match", format: "int", shortName: "K", denominator: "",
		interpretation: "kill count (corpus: 6i over the three identical matches)",
		rows:           8, wantValues: []float64{6, 12, 18, 24, 30, 36, 42, 48}, wantN: 3, wantLabels: eightLabels,
	},
	{
		name: "deaths", expr: "from player_stats: sum(deaths)",
		scope: "match", format: "int", shortName: "D", denominator: "",
		interpretation: "death count (corpus: 3i)",
		rows:           8, wantValues: []float64{3, 6, 9, 12, 15, 18, 21, 24}, wantN: 3, wantLabels: eightLabels,
	},
	{
		name: "mvps", expr: "from player_stats: sum(mvps)",
		scope: "match", format: "int", shortName: "MVPs", denominator: "",
		interpretation: "MVP award count (corpus: 1 per match → 3)",
		rows:           8, wantAll: 3, wantN: 3, wantLabels: eightLabels,
	},
	{
		name: "total_damage", expr: "from player_stats: sum(total_damage)",
		scope: "match", format: "int", shortName: "DMG", denominator: "",
		interpretation: "damage dealt (corpus: 300i)",
		rows:           8, wantValues: []float64{300, 600, 900, 1200, 1500, 1800, 2100, 2400}, wantN: 3, wantLabels: eightLabels,
	},
	{
		name: "utility_damage", expr: "from player_stats: sum(utility_damage)",
		scope: "match", format: "int", shortName: "Util", denominator: "",
		interpretation: "scoreboard Util total (corpus: column absent → 0)",
		rows:           8, wantAll: 0, wantN: 3, wantLabels: eightLabels,
	},
	{
		name: "headshots", expr: "from player_stats: sum(headshots)",
		scope: "match", format: "int", shortName: "", denominator: "",
		interpretation: "headshot kills (corpus: 3i)",
		rows:           8, wantValues: []float64{3, 6, 9, 12, 15, 18, 21, 24}, wantN: 3, wantLabels: eightLabels,
	},
	{
		name: "teamkills", expr: "from player_stats: sum(teamkills)",
		scope: "match", format: "int", shortName: "", denominator: "",
		interpretation: "team-kill count (corpus: column absent → 0)",
		rows:           8, wantAll: 0, wantN: 3, wantLabels: eightLabels,
	},
	{
		name: "suicides", expr: "from player_stats: sum(suicides)",
		scope: "match", format: "int", shortName: "", denominator: "",
		interpretation: "suicide count (corpus: column absent → 0)",
		rows:           8, wantAll: 0, wantN: 3, wantLabels: eightLabels,
	},
	{
		name: "damage_taken", expr: "from player_stats: sum(damage_taken)",
		scope: "match", format: "int", shortName: "", denominator: "",
		interpretation: "damage absorbed (corpus: 150i)",
		rows:           8, wantValues: []float64{150, 300, 450, 600, 750, 900, 1050, 1200}, wantN: 3, wantLabels: eightLabels,
	},
	{
		name: "shots", expr: "from player_stats: sum(shots)",
		scope: "match", format: "int", shortName: "", denominator: "",
		interpretation: "shots fired (corpus: column absent → 0)",
		rows:           8, wantAll: 0, wantN: 3, wantLabels: eightLabels,
	},
	{
		name: "hits", expr: "from player_stats: sum(hits)",
		scope: "match", format: "int", shortName: "", denominator: "",
		interpretation: "shots that connected (corpus: column absent → 0)",
		rows:           8, wantAll: 0, wantN: 3, wantLabels: eightLabels,
	},
	{
		name: "rounds_played", expr: "from player_stats: sum(rounds_played)",
		scope: "match", format: "int", shortName: "", denominator: "",
		interpretation: "rounds the player appeared in (corpus: 24 per match → 72)",
		rows:           8, wantAll: 72, wantN: 3, wantLabels: eightLabels,
	},
	{
		name: "flashed_times", expr: "from player_stats: sum(flashed_times)",
		scope: "match", format: "int", shortName: "", denominator: "",
		interpretation: "times blinded (corpus: column absent → 0)",
		rows:           8, wantAll: 0, wantN: 3, wantLabels: eightLabels,
	},
	{
		name: "bomb_plants", expr: "from player_stats: sum(bomb_plants)",
		scope: "match", format: "int", shortName: "", denominator: "",
		interpretation: "bomb plants (corpus: column absent → 0)",
		rows:           8, wantAll: 0, wantN: 3, wantLabels: eightLabels,
	},
	{
		name: "bomb_defuses", expr: "from player_stats: sum(bomb_defuses)",
		scope: "match", format: "int", shortName: "", denominator: "",
		interpretation: "bomb defuses (corpus: column absent → 0)",
		rows:           8, wantAll: 0, wantN: 3, wantLabels: eightLabels,
	},
	{
		name: "money_spent_total", expr: "from player_stats: sum(money_spent_total)",
		scope: "match", format: "int", shortName: "", denominator: "",
		interpretation: "money spent (corpus: 150000 per match → 450000)",
		rows:           8, wantAll: 450000, wantN: 3, wantLabels: eightLabels,
	},
	{
		name: "career_kills", expr: "from player_stats: sum(kills)",
		scope: "profile", format: "int", shortName: "", denominator: "",
		interpretation: "career kill count (corpus: 6i — the match seed's library twin)",
		rows:           8, wantValues: []float64{6, 12, 18, 24, 30, 36, 42, 48}, wantN: 3, wantLabels: eightLabels,
	},
	{
		name: "career_deaths", expr: "from player_stats: sum(deaths)",
		scope: "profile", format: "int", shortName: "", denominator: "",
		interpretation: "career death count (corpus: 3i)",
		rows:           8, wantValues: []float64{3, 6, 9, 12, 15, 18, 21, 24}, wantN: 3, wantLabels: eightLabels,
	},
	{
		name: "career_assists", expr: "from player_stats: sum(assists)",
		scope: "profile", format: "int", shortName: "", denominator: "",
		interpretation: "career cross-team assists (corpus: 0)",
		rows:           8, wantAll: 0, wantN: 3, wantLabels: eightLabels,
	},
	{
		name: "career_mvps", expr: "from player_stats: sum(mvps)",
		scope: "profile", format: "int", shortName: "", denominator: "",
		interpretation: "career MVP awards (corpus: 1 per match → 3)",
		rows:           8, wantAll: 3, wantN: 3, wantLabels: eightLabels,
	},
	{
		name: "career_total_damage", expr: "from player_stats: sum(total_damage)",
		scope: "profile", format: "int", shortName: "", denominator: "",
		interpretation: "career damage dealt (corpus: 300i)",
		rows:           8, wantValues: []float64{300, 600, 900, 1200, 1500, 1800, 2100, 2400}, wantN: 3, wantLabels: eightLabels,
	},
	{
		name: "career_matches", expr: "from player_stats: count()",
		scope: "profile", format: "int", shortName: "", denominator: "",
		interpretation: "matches the player appears in (corpus: 3)",
		rows:           8, wantAll: 3, wantN: 3, wantLabels: eightLabels,
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
		expr:  "from round_economy, rounds: sum(where winner != '' and side != winner and team != '', equip_value)",
		scope: "match", subject: "match", format: "currency", shortName: "", denominator: "",
		interpretation: "freeze-end money lost by the losing side over decided, team-known rounds — the card total, addressed per match (over the joined sources)",
		rows:           3, wantAll: 54000, wantN: 48, wantLabels: "1,2,3",
	},
	{
		// The Economy card's per-team force half: team ct wins only
		// round 3 of its three force rounds (1/3), team t wins rounds 2
		// and 4 (2/3); match 1 carries no class rows (join_test's
		// classification rig owns that match's analysis tables) — two
		// matches × two teams, N = the team's classified rounds.
		name:  "team_force_win_rate",
		expr:  "from round_side_classes, rounds: ratio(count(where class = 'force' and winner = side), count(where class = 'force'))",
		scope: "match", subject: "team", format: "percent", shortName: "", denominator: "",
		interpretation: "force-buy rounds won ÷ that team's own force rounds — the card's per-team force rate (over the joined sources)",
		rows:           4, wantValues: []float64{1.0 / 3, 2.0 / 3, 1.0 / 3, 2.0 / 3}, wantN: 3, wantLabels: "ct,t,ct,t",
	},
	{
		// The Economy card's per-team lost-equip split: the loser row's
		// team takes the money — ct loses the 12 even rounds at 2500
		// (30000), t the 12 odd rounds at 2000 (24000), per match; N is
		// the group's rows — every economy row of that team (24 rounds).
		name:  "team_lost_equip",
		expr:  "from round_economy, rounds: sum(where winner != '' and side != winner and team != '', equip_value)",
		scope: "match", subject: "team", format: "currency", shortName: "", denominator: "",
		interpretation: "the losing side's freeze-end money credited to its team — the card's per-team split (over the joined sources)",
		rows:           6, wantValues: []float64{30000, 24000, 30000, 24000, 30000, 24000}, wantN: 24, wantLabels: "ct,t,ct,t,ct,t",
	},
	{
		// The profile Win% card's ratio over the won stamp: the corpus
		// matches are all 12-12 ties (won = 0 — a tie is not a win,
		// models.WinFor), so every career row is 0/3.
		name: "win_pct", expr: "from player_stats: ratio(sum(won), count())",
		scope: "profile", format: "percent", shortName: "", denominator: "",
		interpretation: "career wins ÷ matches played — the profile Win% card's stored twin (ties are no wins → 0 over the tied corpus)",
		rows:           8, wantAll: 0, wantN: 3, wantLabels: eightLabels,
	},
	// ---- identity addendum (plan §8 (M1 identity row), 2026-11-17):
	// the five M1 top-card seeds — subject=match, format=identity, rows
	// = 3 (one identity per match), N = 8 (the pool the argmax chose
	// from — every player_stats row of the match), labels = the
	// WINNER's name per match. Corpus math (seed.sql): kills = 2i and
	// adr = 50+5i rise with i, so Heidi (i=8) leads both outright
	// (16 kills / 90 ADR); utility_damage and entry_kills are absent
	// (= 0) and mvps is 1 for every player, so those three TIE across
	// all eight and the deterministic tie-break (player key ASC) names
	// Alice (…001). The engine-side pins (emission, refusal set,
	// filtered pool, empty pool) live in argmax_test.go.
	{
		name: "top_fragger", expr: "from player_stats: argmax(kills)",
		scope: "match", subject: "match", format: "identity", shortName: "", denominator: "",
		interpretation: "the match's leading fragger by stored kills (corpus: Heidi, 16 kills, over the 8-player pool)",
		rows:           3, wantValues: []float64{16, 16, 16}, wantN: 8, wantLabels: "Heidi,Heidi,Heidi",
	},
	{
		name: "best_adr", expr: "from player_stats: argmax(adr)",
		scope: "match", subject: "match", format: "identity", shortName: "", denominator: "",
		interpretation: "the match's highest stored ADR (corpus: Heidi, 90, over the 8-player pool)",
		rows:           3, wantValues: []float64{90, 90, 90}, wantN: 8, wantLabels: "Heidi,Heidi,Heidi",
	},
	{
		name: "most_util", expr: "from player_stats: argmax(utility_damage)",
		scope: "match", subject: "match", format: "identity", shortName: "", denominator: "",
		interpretation: "the match's leading utility-damage player (corpus: column absent → 0 for everyone → tie → Alice by key ASC)",
		rows:           3, wantValues: []float64{0, 0, 0}, wantN: 8, wantLabels: "Alice,Alice,Alice",
	},
	{
		name: "entry_opens", expr: "from player_stats: argmax(entry_kills)",
		scope: "match", subject: "match", format: "identity", shortName: "", denominator: "",
		interpretation: "the match's round-opening first-blood leader (corpus: column absent → 0 for everyone → tie → Alice by key ASC)",
		rows:           3, wantValues: []float64{0, 0, 0}, wantN: 8, wantLabels: "Alice,Alice,Alice",
	},
	{
		name: "most_mvps", expr: "from player_stats: argmax(mvps)",
		scope: "match", subject: "match", format: "identity", shortName: "", denominator: "",
		interpretation: "the match's MVP-award leader (corpus: 1 per player → tie → Alice by key ASC)",
		rows:           3, wantValues: []float64{1, 1, 1}, wantN: 8, wantLabels: "Alice,Alice,Alice",
	},
}

// eightLabels is the corpus roster in subject (steam_id) ASC order —
// every grouped preview's label expectation.
const eightLabels = "Alice,Bob,Carol,Dave,Eve,Frank,Grace,Heidi"

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
		`SELECT name, expr, scope, subject, denominator, doc, format, short_name FROM metrics WHERE origin = 'builtin' ORDER BY name`,
		nil, 100, 5000,
	)
	if err != nil {
		t.Fatalf("read builtins: %v", err)
	}
	type seedRow struct{ expr, scope, subject, denom, doc, format, shortName string }
	got := map[string]seedRow{}
	for _, r := range res.Rows {
		got[r[0].(string)] = seedRow{
			expr: r[1].(string), scope: r[2].(string), subject: r[3].(string), denom: r[4].(string),
			doc: r[5].(string), format: r[6].(string), shortName: r[7].(string),
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
		if row.expr != f.expr || row.scope != f.scope || row.subject != wantSubject || row.denom != f.denominator {
			t.Errorf("builtin %q seeded row = expr %q scope %q subject %q denom %q, want expr %q scope %q subject %q denom %q",
				f.name, row.expr, row.scope, row.subject, row.denom, f.expr, f.scope, wantSubject, f.denominator)
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
		// The join wording is required of exactly the MULTI-SOURCE
		// exprs — the source clause (up to the ":") carries the comma,
		// never a function-argument list.
		srcClause := f.expr
		if i := strings.Index(f.expr, ":"); i >= 0 {
			srcClause = f.expr[:i]
		}
		if strings.Contains(srcClause, ",") && !strings.Contains(row.doc, "over the joined sources") {
			t.Errorf("builtin %q doc missing the joined-source phrasing: %s", f.name, row.doc)
		}
	}

	// (b)+(c)+(d) compile → run → assert values, sample sizes, labels.
	for _, f := range builtinSeed {
		t.Run(f.name, func(t *testing.T) {
			wantSubject := f.subject
			if wantSubject == "" {
				wantSubject = "player"
			}
			addr := Address{Subject: wantSubject, Profile: f.scope == "profile"}
			if _, perr := Compile(f.expr, "", "", addr); perr != nil {
				t.Fatalf("Compile: %v", perr)
			}
			pv, perr, err := RunPreview(st, Def{
				Expr: f.expr, Denominator: f.denominator,
				Subject: wantSubject, Profile: f.scope == "profile",
			}, "", 500)
			if perr != nil {
				t.Fatalf("parse: %v", perr)
			}
			if err != nil {
				t.Fatalf("run: %v (sql: %s)", err, pv.SQL)
			}
			if len(pv.Rows) != f.rows {
				t.Fatalf("rows = %d, want %d (%+v)", len(pv.Rows), f.rows, pv.Rows)
			}
			for i, r := range pv.Rows {
				want := f.wantAll
				if f.wantValues != nil {
					want = f.wantValues[i]
				}
				if r.Value != want {
					t.Errorf("row %d value = %v, want %v", i, r.Value, want)
				}
				if f.wantN != 0 && r.N != f.wantN {
					t.Errorf("row %d N = %d, want %d", i, r.N, f.wantN)
				}
			}
			if f.wantLabels != "" {
				var labels []string
				for _, r := range pv.Rows {
					labels = append(labels, r.Label)
				}
				joined := joinComma(labels)
				if joined != f.wantLabels {
					t.Errorf("labels = %q, want %q", joined, f.wantLabels)
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
		"engagements": 216, "utility_events": 216,
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

// TestScopePreview proves scope="match:<id>" binding on a single-match
// source (648 events/match): every statement is subject-addressed, so
// the scoped run returns one row PER SUBJECT and their counts sum to the
// match total; an unknown-but-well-formed match has no subject rows, so
// the preview has no rows at all (a group the statement did not produce
// has no row).
func TestScopePreview(t *testing.T) {
	st := seededStore(t)
	pv, perr, err := RunPreview(st, Def{Expr: "from events: count()"}, "match:2", 100)
	if perr != nil || err != nil {
		t.Fatalf("preview: %v %v", perr, err)
	}
	if len(pv.Rows) != 8 {
		t.Fatalf("scoped rows = %d, want 8 (one per subject) (%+v)", len(pv.Rows), pv.Rows)
	}
	total := 0
	for _, r := range pv.Rows {
		total += r.N
	}
	if total != 648 {
		t.Errorf("per-subject counts total %d, want 648 (the match's events)", total)
	}
	if _, perr, _ := RunPreview(st, Def{Expr: "from events: count()"}, "match:99", 10); perr != nil {
		t.Fatalf("compile: %v", perr)
	}
	// Unknown-but-well-formed match → no rows (no subject in scope).
	pv, _, err = RunPreview(st, Def{Expr: "from events: count(where kind='kill')"}, "match:99", 10)
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	if len(pv.Rows) != 0 {
		t.Fatalf("empty-scope preview = %+v, want no rows", pv.Rows)
	}
}

// subjectStat is one subject's oracle row (subjectStats).
type subjectStat struct {
	n        int
	min, max float64
}

// subjectStats is the independent oracle for the partition pins: per
// subject, the stored row count and value range of that subject's
// events — plain SQL over the seed, no engine code involved. where is an
// optional filter ("" = every event).
func subjectStats(t *testing.T, st *store.Store, where string) map[string]subjectStat {
	t.Helper()
	q := "SELECT attacker, COUNT(*), MIN(dmg), MAX(dmg) FROM events"
	if where != "" {
		q += " WHERE " + where
	}
	q += " GROUP BY attacker"
	res, err := st.RunReadOnly(q, nil, 100, 5000)
	if err != nil {
		t.Fatalf("oracle query: %v", err)
	}
	out := map[string]subjectStat{}
	for _, r := range res.Rows {
		out[r[0].(string)] = subjectStat{
			n:   int(r[1].(int64)),
			min: toFloat(r[2]),
			max: toFloat(r[3]),
		}
	}
	return out
}

// TestPercentilePreview covers the Go-side percentile path — now
// PARTITIONED BY SUBJECT: one row per subject, each value the p-quantile
// of THAT subject's rows (N and the value range are pinned against the
// independent oracle above, so a partition that collapsed into a
// library-wide quantile fails here). Hand-computable expectations live
// in metrics_test.go's TestPercentilePartitionsBySubject; the
// denominator case is exact because percentile(1.0, ·) is the subject's
// max (100 — every player lands a kill) over the subject's career
// rounds (72 = 3 matches × 24 player_round_stats rows).
func TestPercentilePreview(t *testing.T) {
	st := seededStore(t)
	cases := []struct {
		name, expr, filter string
	}{
		{"p95 per subject", "from events: percentile(0.95, dmg)", ""},
		{"median per subject", "from events: median(dmg)", ""},
		{"filtered median per subject", "from events: percentile(where kind='damage', 0.5, dmg)", "kind = 'damage'"},
		{"percentile first of many", "from events: percentile(0.5, dmg), avg(dmg), count()", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			pv, perr, err := RunPreview(st, Def{Expr: c.expr}, "", 500)
			if perr != nil || err != nil {
				t.Fatalf("preview %q: %v %v", c.expr, perr, err)
			}
			oracle := subjectStats(t, st, c.filter)
			if len(pv.Rows) != len(oracle) {
				t.Fatalf("rows = %d, want %d (one per subject)", len(pv.Rows), len(oracle))
			}
			seen := 0
			for _, r := range pv.Rows {
				want, ok := oracle[r.Group]
				if !ok {
					t.Errorf("row group %q is not a subject of the oracle", r.Group)
					continue
				}
				seen++
				if r.N != want.n {
					t.Errorf("subject %s N = %d, want %d (its own rows)", r.Group, r.N, want.n)
				}
				if r.Value < want.min || r.Value > want.max {
					t.Errorf("subject %s value %v outside its own [%v, %v]", r.Group, r.Value, want.min, want.max)
				}
			}
			if seen != len(oracle) {
				t.Errorf("matched %d subjects, want %d", seen, len(oracle))
			}
		})
	}

	// Percentile + denominator: profile scope correlates the denominator
	// on the subject — 100 (every subject's max) / 72 (its career
	// rounds), exact for all eight subjects.
	pv, perr, err := RunPreview(st, Def{Expr: "from events: percentile(1.0, dmg)", Denominator: "rounds"}, "", 100)
	if perr != nil || err != nil {
		t.Fatalf("preview with denom: %v %v", perr, err)
	}
	if len(pv.Rows) != 8 {
		t.Fatalf("denominated percentile rows = %d, want 8 (%+v)", len(pv.Rows), pv.Rows)
	}
	want := 100.0 / 72.0
	for _, r := range pv.Rows {
		if r.Value != want {
			t.Errorf("subject %s denominated max = %v, want %v (100 / 72 career rounds)", r.Group, r.Value, want)
		}
		if r.N == 0 {
			t.Errorf("subject %s N = 0, want its event count", r.Group)
		}
	}
}

// TestRowCapAndTruncation pins preview caps (preview has a row
// cap over the SUBJECT rows it returns; Truncated reports hitting it).
func TestRowCapAndTruncation(t *testing.T) {
	st := seededStore(t)
	pv, perr, err := RunPreview(st, Def{Expr: "from events: count()"}, "", 3)
	if perr != nil || err != nil {
		t.Fatalf("preview: %v %v", perr, err)
	}
	if len(pv.Rows) != 3 || !pv.Truncated {
		t.Fatalf("rows = %d truncated = %v, want 3 rows capped", len(pv.Rows), pv.Truncated)
	}
	pv, _, err = RunPreview(st, Def{Expr: "from events: count()"}, "", 500)
	if err != nil || pv.Truncated {
		t.Fatalf("uncapped preview truncated = %v (err %v)", pv.Truncated, err)
	}
	if len(pv.Rows) != 8 {
		t.Fatalf("uncapped rows = %d, want 8 (one per subject)", len(pv.Rows))
	}
}

// joinComma renders label expectations readably.
func joinComma(ss []string) string {
	out := ""
	for i, s := range ss {
		if i > 0 {
			out += ","
		}
		out += s
	}
	return out
}
