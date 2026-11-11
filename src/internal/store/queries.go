package store

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// matchColumns is the full matches column list in scan order — the ONE
// matches list: GetMatch selects it verbatim, SaveExtracted's UPDATE walks
// it (skipping the lifecycle-owned path/sha256/size and the sidecar-owned
// sample_rate/position_frames columns) so a column added
// here cannot silently drift from the extract write.
var matchColumns = []string{
	"id", "path", "sha256", "size", "map", "patch_version", "tick_rate",
	"duration_ticks", "playback_time_s", "frames", "server_name", "client_name",
	"game_dir", "net_proto", "is_pov", "warmup_rounds", "real_rounds",
	"score_ct", "score_t", "half_ct", "half_t", "side_switches",
	"entity_classes", "end_entity_count", "parser_version", "extracted_at",
	"parse_ms", "warnings_count", "status", "error",
	"sample_rate", "position_frames", "enc_messages",
}

// matchColumnsSQL is matchColumns joined for SELECT text (built once —
// GetMatch runs per view load).
var matchColumnsSQL = strings.Join(matchColumns, ", ")

// matchOwnedElsewhere are the matchColumns SaveExtracted must NOT rewrite:
// path/sha256/size stay lifecycle-owned (CreateMatchRow wrote them) and
// position_* stay sidecar-owned (SetPositionMeta writes them from the
// sidecar's close meta).
var matchOwnedElsewhere = map[string]bool{
	"id": true, "path": true, "sha256": true, "size": true,
	"sample_rate": true, "position_frames": true,
}

// Event limits: DefaultEventLimit is what GetEvents applies when the caller
// asks for <= 0 rows; MaxEventLimit is the largest limit any caller passes
// (the analytics pass — it is a NAMED CEILING, not an enforced clamp:
// queryEvents still honors an explicit larger limit).
const (
	DefaultEventLimit = 50000
	MaxEventLimit     = 100000
)

// Shared SQL expressions — ONE definition per scope. K/D and KAST% are the
// two metrics computed at both the per-match layer (one player_stats row of
// one match) and the career layer (a player's whole history, GROUP BY
// steam_id); the two shapes are genuinely different SQL, so they stay
// separate consts instead of one parameterized string. Keep them here, next
// to each other: the whole point is that the trend/profile queries and the
// scoreboard cannot drift from the career rollup.
//
// Zero-denominator spelling, deliberate scope variants (do NOT unify):
// the store floors the denominator — `MAX(deaths, 1)` — so a player with no
// deaths reports K/D 0 instead of NULL, because the scoreboard/trend cells
// are typed floats with no "missing" state. internal/metrics expresses the
// same idea generically as `1.0*a1 / NULLIF(a2, 0)` (ratio()): there a NULL
// denominator is the honest "no rows to divide by" the preview renders as
// Value 0 with N, and the operands are user-chosen columns the compiler
// cannot assume a floor for. Same intent, two scopes, two spellings.
const (
	// kdPerMatchSQL is kills/deaths for ONE match, deaths floored at 1
	// (GetScoreboard's SELECT and GetTrend's per-match series).
	kdPerMatchSQL = `CAST(ps.kills AS REAL) / MAX(ps.deaths, 1)`

	// kdCareerSQL is the career rollup's K/D (RebuildCareer): sums across
	// every match, not the average of the per-match ratios.
	kdCareerSQL = `CAST(SUM(ps.kills) AS REAL) / MAX(SUM(ps.deaths), 1)`

	// kastPerMatchSQL is a player's KAST% WITHIN one match, correlated
	// from the outer row to that match's player_round_stats rows (0 when
	// the match has no analytics rows). Used by GetTrend's per-match
	// series and GetPlayerHistory; the aliases m/ps must exist in the
	// outer query.
	kastPerMatchSQL = `COALESCE((SELECT 100.0 * AVG(prs.kast) FROM player_round_stats prs
		WHERE prs.match_id = m.id AND prs.steam_id = ps.steam_id), 0)`

	// kastCareerSQL is the career rollup's KAST% (RebuildCareer): averaged
	// over ALL of the player's player_round_stats rows (alias ps only).
	kastCareerSQL = `COALESCE((SELECT 100.0 * AVG(prs.kast) FROM player_round_stats prs
		WHERE prs.steam_id = ps.steam_id), 0)`
)

// matchListSort whitelists ListMatches sort keys (identifiers only — every
// user value is bound as a parameter).
var matchListSort = map[string]string{
	"extracted_at": "m.extracted_at",
	"map":          "m.map",
	"size":         "m.size",
	"score":        "(m.score_ct + m.score_t)",
	"duration":     "m.playback_time_s",
	"rounds":       "m.real_rounds",
	"status":       "m.status",
}

// scoreboardSort whitelists GetScoreboard sort keys (identifiers only).
// `kd`/`kda` are GetScoreboard's SELECT aliases for the two computed
// ratio expressions — ORDER BY reaches them only through the alias (see
// the GetScoreboard doc comment; without it SQLite reports "no such
// column: kd").
var scoreboardSort = map[string]string{
	"name":            "p.name",
	"side":            "ps.side",
	"kills":           "ps.kills",
	"deaths":          "ps.deaths",
	"assists":         "ps.assists",
	"headshots":       "ps.headshots",
	"hs_pct":          "ps.hs_pct",
	"adr":             "ps.adr",
	"kd":              "kd",
	"kda":             "kda",
	"total_damage":    "ps.total_damage",
	"damage_taken":    "ps.damage_taken",
	"rounds_played":   "ps.rounds_played",
	"entry_kills":     "ps.entry_kills",
	"entry_deaths":    "ps.entry_deaths",
	"opening_kills":   "ps.opening_kills",
	"opening_deaths":  "ps.opening_deaths",
	"trade_kills":     "ps.trade_kills",
	"best_streak":     "ps.best_streak",
	"two_k":           "ps.two_k",
	"three_k":         "ps.three_k",
	"four_k":          "ps.four_k",
	"five_k":          "ps.five_k",
	"utility_damage":  "ps.utility_damage",
	"enemies_flashed": "ps.enemies_flashed",
	"flashed_times":   "ps.flashed_times",
	"bomb_plants":     "ps.bomb_plants",
	"bomb_defuses":    "ps.bomb_defuses",
	"mvps":            "ps.mvps",
	"score":           "ps.score",
	"teamkills":       "ps.teamkills",
	"suicides":        "ps.suicides",
	"money_spent":     "ps.money_spent_total",
}

// playersJoin renders the ONE players-join idiom (roster display names by
// (match, SteamID)): pass joinLeft for the name-bearing form, joinInner
// where a row without a roster entry must be dropped (GetScoreboard /
// GetCombatStats' base rows), and guard=true to skip an empty SteamID —
// the fragment then tests the column for non-empty BEFORE the lookup, so a
// world/absent actor never picks up the single players row a match may
// carry with an empty steam_id. Every LEFT JOIN is guarded (that is the
// point of the guard); the INNER forms stay unguarded because guarding
// them would FILTER rows out instead of nulling a name, which is a
// result-set change, not a naming rule.
//
// Deliberately NOT a bot filter: the join only names rows. Which reads
// exclude bots is HumanOnly's call (below) — event-shaped LEFT JOINs
// (eventRowFrom, roundRowSelect) must keep bot names.
const (
	joinLeft  = "LEFT JOIN"
	joinInner = "JOIN"
)

func playersJoin(kind, alias, matchCol, steamCol string, guard bool) string {
	var b strings.Builder
	b.WriteString(kind)
	b.WriteString(" players ")
	b.WriteString(alias)
	b.WriteString(" ON ")
	b.WriteString(alias)
	b.WriteString(".match_id = ")
	b.WriteString(matchCol)
	if guard {
		b.WriteString(" AND ")
		b.WriteString(steamCol)
		b.WriteString(" <> ''")
	}
	b.WriteString(" AND ")
	b.WriteString(alias)
	b.WriteString(".steam_id = ")
	b.WriteString(steamCol)
	return b.String()
}

// HumanOnly is THE humans-only condition — the ONE place the Go side
// decides "this roster/aggregate row belongs to a human". Bots
// (players.is_bot, written from demoinfocs' Player.IsBot at import —
// extract's synthetic 0xFF-prefixed id, see extract.isBotKey) are
// excluded from EVERY roster/aggregate/selection read: GetScoreboard,
// GetCombatStats' base rows, the ListMatches player facet, the career
// rollup (RebuildCareer) and its list/read (ListPlayers, GetCareer) plus
// GetTrend (the one profile read reachable without GetCareer's guard),
// and — through the exported form — the metrics layer's `player` group
// (internal/metrics/compile.go). Event-shaped reads (round MVP/
// first-blood names, kill-feed attacker/victim cells, chat, engagements)
// deliberately do NOT use it — they record what happened. GetPlayerRefs
// keeps bots WITH the flag (the replay roster needs them).
//
// Two shapes, ONE rule; the frontend twin is frontend/src/lib/players.js
// (isHuman/listedPlayers):
//
//   - HumanOnly(alias) — a players row is already joined under alias
//     (GetScoreboard / GetCombatStats WHERE, the player facet's EXISTS,
//     RebuildCareer's players join);
//   - HumanOnlyBySteamID(steamExpr, matchExpr) — the read is keyed by a
//     steam_id expression with no joined row (player_career). matchExpr
//     scopes the lookup to one match (the players PK prefix — required
//     for per-row use); "" is the library-wide form (no match in scope).
func HumanOnly(alias string) string {
	return alias + ".is_bot = 0"
}

// HumanOnlyBySteamID renders the steam-id-keyed form of HumanOnly: no
// players row for this id is a bot. Bot identities are synthetic
// (extract.isBotKey: 0xFF00000000000000|entityID) and can never collide
// with a human SteamID64, so "a bot in ANY match" is "a bot" — which is
// what lets a library-wide career read (no match_id available) express
// the rule without a guess.
func HumanOnlyBySteamID(steamIDExpr, matchExpr string) string {
	var b strings.Builder
	b.WriteString("NOT EXISTS (SELECT 1 FROM players p WHERE ")
	if matchExpr != "" {
		b.WriteString("p.match_id = ")
		b.WriteString(matchExpr)
		b.WriteString(" AND ")
	}
	b.WriteString("p.steam_id = ")
	b.WriteString(steamIDExpr)
	b.WriteString(" AND p.is_bot = 1)")
	return b.String()
}

// eventRowCols/eventRowFrom select typed timeline columns with player
// display names joined for attacker/victim/assister. The trailing
// e.pos_* columns are NULL for events without a source position; the
// e.apos_* columns carry the attacker's position (kill events).
const eventRowCols = `e.id, e.seq, e.tick, e.round, e.kind,
	e.attacker, COALESCE(ap.name, ''), e.victim, COALESCE(vp.name, ''),
	e.assister, COALESCE(asp.name, ''),
	e.weapon, e.headshot, e.wallbang, e.noscope, e.through_smoke,
	e.attacker_blind, e.attacker_inair, e.assisted_flash, e.distance, e.hitgroup, e.dmg, e.site,
	e.pos_x, e.pos_y, e.pos_z, e.apos_x, e.apos_y, e.apos_z`

var eventRowFrom = ` FROM events e
	` + playersJoin(joinLeft, "ap", "e.match_id", "e.attacker", true) + `
	` + playersJoin(joinLeft, "vp", "e.match_id", "e.victim", true) + `
	` + playersJoin(joinLeft, "asp", "e.match_id", "e.assister", true)

// roundRowSelect joins display names for MVP/first-kill/first-death
// ("" when the SteamID is absent or unknown).
var roundRowSelect = `SELECT r.number, r.winner, r.reason, r.duration_s, r.warmup, r.pregame, r.bomb_site,
	r.mvp, COALESCE(mp.name, ''), r.mvp_reason, r.equip_ct, r.equip_t,
	(SELECT COUNT(*) FROM events e WHERE e.match_id = r.match_id AND e.round = r.number AND e.kind = 'kill'),
	r.first_kill_steam, COALESCE(fp.name, ''), r.first_death_steam, COALESCE(dp.name, ''),
	r.start_tick, r.end_tick, r.freeze_end_tick
	FROM rounds r
	` + playersJoin(joinLeft, "mp", "r.match_id", "r.mvp", true) + `
	` + playersJoin(joinLeft, "fp", "r.match_id", "r.first_kill_steam", true) + `
	` + playersJoin(joinLeft, "dp", "r.match_id", "r.first_death_steam", true) + `
	WHERE r.match_id = ?`

// matchSummaryCols/matchSummaryFrom are the library-list projection and its
// teams join — ONE denormalized read model shared by ListMatches
// (search/sort), GetMatchSummary (one row) and GetTeamNames (names only).
const matchSummaryCols = `m.id, m.path, m.map, m.size, m.score_ct, m.score_t,
	COALESCE(ct.name, ''), COALESCE(t.name, ''), m.real_rounds, m.playback_time_s,
	m.extracted_at, m.status, m.error, m.sha256`

const matchSummaryFrom = ` FROM matches m
	LEFT JOIN teams ct ON ct.match_id = m.id AND ct.side = 'ct'
	LEFT JOIN teams t ON t.match_id = m.id AND t.side = 't'`

// MatchListFilter narrows ListMatches: the library row's structured
// facets, ANDed with each other and with the free-text query. The zero
// value leaves the list unconstrained. Map is a case-insensitive
// substring match on the map name; Player is the "has player X" facet —
// ONE value matches a roster row by exact SteamID (the 17-digit profile
// deep link, #/library?player=) OR by case-insensitive name substring
// (typing a name), so the frontend needs no exact-vs-name mode switch.
// The roster side of the facet is humans-only (HumanOnly): a bot's name
// or id never matches.
type MatchListFilter struct {
	Map    string `json:"map"`
	Player string `json:"player"`
}

// matchListWhere renders the shared ListMatches/ListMatchesPage filter
// clause (the free-text LIKE group ANDed with every structured facet) and
// its bound arguments — the ONE spelling of the library-list conditions,
// so the paged read can never drift from the full read. Returns "" when
// nothing narrows the list.
func matchListWhere(query string, filters []MatchListFilter) (string, []any) {
	// Conditions join with AND, so the free-text OR group needs its own
	// parentheses (AND binds tighter than OR).
	var conds []string
	var args []any
	if q := scrub(query); q != "" {
		like := "%" + q + "%"
		conds = append(conds, `(m.map LIKE ? OR m.path LIKE ? OR ct.name LIKE ? OR t.name LIKE ?)`)
		args = append(args, like, like, like, like)
	}
	for _, f := range filters {
		if m := strings.TrimSpace(scrub(f.Map)); m != "" {
			conds = append(conds, `m.map LIKE ?`)
			args = append(args, "%"+m+"%")
		}
		if p := strings.TrimSpace(scrub(f.Player)); p != "" {
			// Roster membership: exact SteamID OR name substring. The
			// players PK (match_id, steam_id) makes the EXISTS a lookup.
			// HumanOnly keeps a BOT's name out of the facet (a bot is
			// never a "player this match contains").
			conds = append(conds, `EXISTS (SELECT 1 FROM players p
				WHERE p.match_id = m.id AND `+HumanOnly("p")+` AND (p.steam_id = ? OR p.name LIKE ?))`)
			args = append(args, p, "%"+p+"%")
		}
	}
	if len(conds) == 0 {
		return "", nil
	}
	return " WHERE " + strings.Join(conds, " AND "), args
}

// ListMatches returns the library list: matches matching query (a
// case-insensitive LIKE across map, path and both team names; "" matches
// all), narrowed by any filters (each ANDed with the query and with the
// other filters — see MatchListFilter), sorted by a whitelisted sortKey
// (default extracted_at).
//
// The filters ride a variadic tail rather than a fixed parameter: the
// zero filter is "no constraint", and every existing call site (import
// scan, single-row readers' tests) passes none — adding a parameter
// would touch callers across the read surface for no gain. The one
// binding that forwards a filter (LibraryService.ListMatches) always
// passes exactly one.
//
// The list is unbounded by design: its readers (Scanner.importIndex's
// import dedupe, MatchPicker, Settings' recompute list) need the WHOLE
// filtered set. The view-facing "Load more" window is ListMatchesPage.
func (s *Store) ListMatches(query, sortKey string, desc bool, filters ...MatchListFilter) ([]models.MatchSummary, error) {
	order, ok := matchListSort[sortKey]
	if !ok {
		order = matchListSort["extracted_at"]
	}
	dir := "ASC"
	if desc {
		dir = "DESC"
	}
	where, args := matchListWhere(query, filters)
	var b strings.Builder
	b.WriteString(`SELECT ` + matchSummaryCols + matchSummaryFrom)
	b.WriteString(where)
	fmt.Fprintf(&b, " ORDER BY %s %s, m.id DESC", order, dir)

	rows, err := s.db.Query(b.String(), args...)
	if err != nil {
		return nil, fmt.Errorf("store: list matches: %w", err)
	}
	defer rows.Close()
	var out []models.MatchSummary
	for rows.Next() {
		mm, err := scanMatchSummary(rows)
		if err != nil {
			return nil, fmt.Errorf("store: list matches: %w", err)
		}
		out = append(out, mm)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list matches: %w", err)
	}
	return out, nil
}

// Library-list window bounds (ListMatchesPage's rows per window).
const (
	// ListMatchesPageSize is the default window (the Library's first
	// window and every "Load more" click fetch one of these).
	ListMatchesPageSize = 200
	// ListMatchesPageMaxRows is the largest window any caller may ask
	// for — the roster IN-list and the row scan stay bounded either way.
	ListMatchesPageMaxRows = 5000
)

// ListMatchesPage returns ONE keyset window of the library list: the
// rows strictly after the cursor row (afterID — 0 starts the first
// window), in ListMatches' exact order for query/sortKey/desc with the
// same filters, limited to limit rows (<= 0 means ListMatchesPageSize,
// clamped to ListMatchesPageMaxRows). HasNext reports whether another
// window exists beyond the returned rows (the query reads limit+1 rows —
// a window of exactly limit rows with no successor reports false).
//
// CURSOR: the caller passes the last row's ID, and the store resolves it
// to that row's STORED (sort value, id). Resolving inside the store keeps
// the DATETIME round trip on one driver path (a time parsed out of
// matches.extracted_at is bound back in the exact format it was written
// in — never a JS string), and a cursor row that vanished between
// windows is an ErrNotFound instead of a silently mis-placed page.
//
// KEYSET PREDICATE — E is the whitelisted sort expression, cid the cursor
// row id; the tie-break `E = ? AND m.id < ?` mirrors the ORDER BY's
// `m.id DESC`, so rows sharing one E (batch imports land on the same
// extracted_at second constantly) are neither skipped nor duplicated
// across windows:
//
//	desc, cursor E non-NULL: (E < ?) OR (E = ? AND m.id < ?) OR (E IS NULL)
//	desc, cursor E NULL:     (E IS NULL AND m.id < ?)
//	asc,  cursor E non-NULL: (E > ?) OR (E = ? AND m.id < ?)
//	asc,  cursor E NULL:     (E IS NOT NULL) OR (E IS NULL AND m.id < ?)
//
// NULL sorts smallest in SQLite (first under ASC, last under DESC): the
// explicit IS NULL / IS NOT NULL arms keep that placement reachable. A
// plain `E < ?` compares NULL to anything as NULL (false), so without
// them a DESC window with a non-NULL cursor would drop every queued match
// (extracted_at IS NULL) forever, and a NULL cursor would match nothing.
//
// ROSTERS: the window also carries the matchup-synthesis rosters for its
// rows whose teams rows recorded no clan name (see models.MatchListPage)
// — the ONE batched read that replaced the view's per-row GetScoreboard
// fetches.
func (s *Store) ListMatchesPage(query, sortKey string, desc bool, afterID int64, limit int, filters ...MatchListFilter) (*models.MatchListPage, error) {
	order, ok := matchListSort[sortKey]
	if !ok {
		order = matchListSort["extracted_at"]
	}
	dir := "ASC"
	if desc {
		dir = "DESC"
	}
	if limit <= 0 {
		limit = ListMatchesPageSize
	}
	if limit > ListMatchesPageMaxRows {
		limit = ListMatchesPageMaxRows
	}
	where, args := matchListWhere(query, filters)
	if afterID > 0 {
		after, a, err := s.keysetAfter(order, dir, afterID)
		if err != nil {
			return nil, err
		}
		if where == "" {
			where = " WHERE " + after
		} else {
			where += " AND (" + after + ")"
		}
		args = append(args, a...)
	}
	// limit+1: the extra row is the "there is more" probe, never returned.
	var b strings.Builder
	b.WriteString(`SELECT ` + matchSummaryCols + matchSummaryFrom)
	b.WriteString(where)
	fmt.Fprintf(&b, " ORDER BY %s %s, m.id DESC LIMIT %d", order, dir, limit+1)

	rows, err := s.db.Query(b.String(), args...)
	if err != nil {
		return nil, fmt.Errorf("store: list matches page: %w", err)
	}
	defer rows.Close()
	page := &models.MatchListPage{Rows: []models.MatchSummary{}}
	for rows.Next() {
		mm, err := scanMatchSummary(rows)
		if err != nil {
			return nil, fmt.Errorf("store: list matches page: %w", err)
		}
		page.Rows = append(page.Rows, mm)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list matches page: %w", err)
	}
	if len(page.Rows) > limit {
		page.Rows = page.Rows[:limit]
		page.HasNext = true
	}
	if err := s.pageRosters(page); err != nil {
		return nil, err
	}
	return page, nil
}

// keysetAfter resolves the cursor row (afterID) to its stored sort value
// and renders the "strictly after" predicate for (order, dir) with its
// bound arguments (see ListMatchesPage's predicate table). E is one of
// matchListSort's whitelisted expressions — identifiers only, never user
// input. ErrNotFound when the cursor row no longer exists.
func (s *Store) keysetAfter(order, dir string, afterID int64) (string, []any, error) {
	var raw any
	err := s.db.QueryRow(
		`SELECT `+order+` FROM matches m WHERE m.id = ?`, afterID,
	).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil, fmt.Errorf("store: list matches page: cursor match %d: %w", afterID, ErrNotFound)
	}
	if err != nil {
		return "", nil, fmt.Errorf("store: list matches page: cursor match %d: %w", afterID, err)
	}
	// TEXT comes back as []byte on some driver paths; bind it back as a
	// string so the comparison stays TEXT-vs-TEXT (a BLOB parameter would
	// never equal a TEXT column, silently breaking the tie-break arm).
	if b, ok := raw.([]byte); ok {
		raw = string(b)
	}
	if raw == nil { // NULL sort value (only extracted_at: a queued match never extracted)
		if dir == "DESC" {
			return "(" + order + " IS NULL AND m.id < ?)", []any{afterID}, nil
		}
		return "(" + order + " IS NOT NULL OR (" + order + " IS NULL AND m.id < ?))", []any{afterID}, nil
	}
	cmp := " > "
	if dir == "DESC" {
		cmp = " < "
	}
	nullArm := ""
	if dir == "DESC" {
		// NULL sorts last under DESC: rows below a non-NULL cursor.
		nullArm = " OR (" + order + " IS NULL)"
	}
	return "(" + order + cmp + "? OR (" + order + " = ? AND m.id < ?)" + nullArm + ")",
		[]any{raw, raw, afterID}, nil
}

// pageRosters fills page.Rosters with the roster rows the Matchup column
// synthesizes `team_<player>` names from — for exactly the window rows
// that recorded no team clan name (both names present → no entry; an
// empty roster → no entry, the cell stays "—"). Humans only (HumanOnly):
// this roster feeds a display listing, so the canonical Go bot filter
// applies; the frontend runs its twin (listedPlayers) on arrival too.
// One IN-list query per window — the batched read behind the page's
// single-call list load.
func (s *Store) pageRosters(page *models.MatchListPage) error {
	var ids []int64
	for _, mm := range page.Rows {
		if mm.CTName == "" || mm.TName == "" {
			ids = append(ids, mm.ID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	const chunk = 400 // stay well under SQLite's bound-parameter ceiling
	for start := 0; start < len(ids); start += chunk {
		part := ids[start:min(start+chunk, len(ids))]
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(part)), ",")
		rows, err := s.db.Query(
			`SELECT p.match_id, p.steam_id, p.name, p.side, p.is_bot
			 FROM players p WHERE p.match_id IN (`+placeholders+`) AND `+HumanOnly("p")+`
			 ORDER BY p.match_id, p.steam_id`, args64(part)...)
		if err != nil {
			return fmt.Errorf("store: list matches page: rosters: %w", err)
		}
		for rows.Next() {
			var (
				id  int64
				ref models.PlayerRef
			)
			if err := rows.Scan(&id, &ref.SteamID, &ref.Name, &ref.Side, &ref.IsBot); err != nil {
				rows.Close()
				return fmt.Errorf("store: list matches page: rosters: %w", err)
			}
			if page.Rosters == nil {
				page.Rosters = map[int64][]models.PlayerRef{}
			}
			page.Rosters[id] = append(page.Rosters[id], ref)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return fmt.Errorf("store: list matches page: rosters: %w", err)
		}
		rows.Close()
	}
	return nil
}

// args64 boxes int64 ids as bind arguments.
func args64(ids []int64) []any {
	out := make([]any, len(ids))
	for i, id := range ids {
		out[i] = id
	}
	return out
}

// ListMapNames returns the distinct map names present in the library,
// A→Z — the source for the Library map facet's suggestion dropdown. Only
// non-empty names qualify (a row created before extraction, or a demo
// whose map the parser could not read, is never a suggestion), and the
// DISTINCT collapses the per-match rows to one entry each. Names come
// back exactly as stored (no case folding on read — the facet's LIKE is
// the case-insensitive side).
func (s *Store) ListMapNames() ([]string, error) {
	rows, err := s.db.Query(`SELECT DISTINCT map FROM matches
		WHERE TRIM(map) <> '' ORDER BY map`)
	if err != nil {
		return nil, fmt.Errorf("store: list map names: %w", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var m string
		if err := rows.Scan(&m); err != nil {
			return nil, fmt.Errorf("store: list map names: %w", err)
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list map names: %w", err)
	}
	return out, nil
}

// GetMatchSummary returns ONE match's library-list row (the ListMatches
// projection, no search/sort) — the single-match read for callers that
// would otherwise list the whole library and filter (ErrNotFound when
// absent).
func (s *Store) GetMatchSummary(id int64) (models.MatchSummary, error) {
	row := s.db.QueryRow(`SELECT `+matchSummaryCols+matchSummaryFrom+` WHERE m.id = ?`, id)
	mm, err := scanMatchSummary(row)
	if errors.Is(err, sql.ErrNoRows) {
		return models.MatchSummary{}, ErrNotFound
	}
	if err != nil {
		return models.MatchSummary{}, fmt.Errorf("store: get match summary: %w", err)
	}
	return mm, nil
}

// GetTeamNames returns a match's two display names: the score line names
// TEAMS, never sides (sides switch at halftime — see the teams join). Both
// are "" when the extract recorded none (callers synthesize `team_<player>`
// or fall back to the bare side). ErrNotFound when the match is absent.
func (s *Store) GetTeamNames(id int64) (ctName, tName string, err error) {
	err = s.db.QueryRow(
		`SELECT COALESCE(ct.name, ''), COALESCE(t.name, '')`+matchSummaryFrom+` WHERE m.id = ?`, id,
	).Scan(&ctName, &tName)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", ErrNotFound
	}
	if err != nil {
		return "", "", fmt.Errorf("store: get team names: %w", err)
	}
	return ctName, tName, nil
}

// scanMatchSummary reads the matchSummaryCols projection.
func scanMatchSummary(row interface{ Scan(...any) error }) (models.MatchSummary, error) {
	var (
		mm        models.MatchSummary
		extracted sql.NullTime
	)
	if err := row.Scan(
		&mm.ID, &mm.Path, &mm.Map, &mm.Size, &mm.ScoreCT, &mm.ScoreT, &mm.CTName, &mm.TName,
		&mm.RealRounds, &mm.DurationS, &extracted, &mm.Status, &mm.Error, &mm.SHA256,
	); err != nil {
		return models.MatchSummary{}, err
	}
	mm.ExtractedAt = nullTime(extracted)
	return mm, nil
}

// GetMatch returns one match header row (ErrNotFound when absent).
func (s *Store) GetMatch(id int64) (*models.Match, error) {
	var (
		m         models.Match
		extracted sql.NullTime
	)
	err := s.db.QueryRow(`SELECT `+matchColumnsSQL+` FROM matches WHERE id = ?`, id).Scan(
		&m.ID, &m.Path, &m.SHA256, &m.Size, &m.Map, &m.PatchVersion, &m.TickRate,
		&m.DurationTicks, &m.PlaybackTimeS, &m.Frames, &m.ServerName, &m.ClientName,
		&m.GameDir, &m.NetProto, &m.IsPOV, &m.WarmupRounds, &m.RealRounds, &m.ScoreCT,
		&m.ScoreT, &m.HalfCT, &m.HalfT, &m.SideSwitches, &m.EntityClasses,
		&m.EndEntityCount, &m.ParserVersion, &extracted, &m.ParseMS, &m.WarningsCount,
		&m.Status, &m.Error, &m.SampleRate, &m.PositionFrames,
		&m.EncryptedMessages,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("store: get match: %w", err)
	}
	m.ExtractedAt = nullTime(extracted)
	return &m, nil
}

// GetScoreboard returns one player's-aggregate rows for a match, joined
// with identity, sorted by a whitelisted sortKey (default kills DESC).
// KD = kdPerMatchSQL (kills/max(deaths,1)); KDA = (kills+assists)/max(deaths,1).
// Both ratio expressions are aliased `kd`/`kda` in the SELECT: the
// scoreboardSort map orders by those bare identifiers, and ORDER BY can
// only reach a computed expression through its result-column alias (the
// aliases are applied here, at the use site — kdPerMatchSQL itself stays
// unaliased for GetTrend). Pinned by TestGetScoreboardKDAndKDASorting.
// BOTS ARE EXCLUDED (HumanOnly) — this is THE roster read, so every
// consumer inherits the exclusion (Match's tables/cards and top-stats,
// the Combat/Utility/Heatmaps/Economy/CompareRounds/RoundDetail/Reports/
// FilterBar player lists, the library player facet's roster side, the
// report export's Scoreboard). Event-shaped reads keep bot names.
func (s *Store) GetScoreboard(id int64, sortKey string, desc bool) ([]models.PlayerStatsRow, error) {
	order, ok := scoreboardSort[sortKey]
	dir := "ASC"
	if desc {
		dir = "DESC"
	}
	if !ok {
		// Unknown/empty key falls back to the fixed default kills DESC.
		order, dir = "ps.kills", "DESC"
	}
	rows, err := s.db.Query(
		`SELECT ps.steam_id, p.name, p.is_bot, p.side, p.final_state_present,
			ps.rounds_played, ps.kills, ps.deaths,
			ps.assists, ps.flash_assists, ps.headshots, ps.hs_pct, ps.adr,
			`+kdPerMatchSQL+` AS kd,
			CAST(ps.kills + ps.assists AS REAL) / MAX(ps.deaths, 1) AS kda,
			ps.total_damage, ps.damage_taken, ps.entry_kills, ps.entry_deaths,
			ps.opening_kills, ps.opening_deaths, ps.trade_kills, ps.best_streak,
			ps.two_k, ps.three_k, ps.four_k, ps.five_k, ps.utility_damage, ps.enemies_flashed,
			ps.flashed_times, ps.bomb_plants, ps.bomb_defuses, ps.mvps, ps.score,
			ps.teamkills, ps.suicides, ps.money_spent_total, ps.kills_by_weapon, ps.damage_by_weapon
		FROM player_stats ps
		`+playersJoin(joinInner, "p", "ps.match_id", "ps.steam_id", false)+`
		WHERE ps.match_id = ? AND `+HumanOnly("p")+`
		ORDER BY `+order+` `+dir+`, p.name ASC`,
		id,
	)
	if err != nil {
		return nil, fmt.Errorf("store: get scoreboard: %w", err)
	}
	defer rows.Close()
	var out []models.PlayerStatsRow
	for rows.Next() {
		var r models.PlayerStatsRow
		if err := rows.Scan(
			&r.SteamID, &r.Name, &r.IsBot, &r.Side, &r.FinalStatePresent,
			&r.RoundsPlayed, &r.Kills, &r.Deaths,
			&r.Assists, &r.FlashAssists, &r.Headshots, &r.HSPct, &r.ADR, &r.KD, &r.KDA, &r.TotalDamage,
			&r.DamageTaken, &r.EntryKills, &r.EntryDeaths, &r.OpeningKills, &r.OpeningDeaths,
			&r.TradeKills, &r.BestStreak, &r.TwoK, &r.ThreeK, &r.FourK, &r.FiveK, &r.UtilityDamage,
			&r.EnemiesFlashed, &r.FlashedTimes, &r.BombPlants, &r.BombDefuses, &r.MVPs,
			&r.Score, &r.Teamkills, &r.Suicides, &r.MoneySpent, &r.KillsByWeapon, &r.DamageByWeapon,
		); err != nil {
			return nil, fmt.Errorf("store: get scoreboard: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: get scoreboard: %w", err)
	}
	return out, nil
}

// GetRounds returns a match's rounds by number ASC.
func (s *Store) GetRounds(id int64) ([]models.RoundRow, error) {
	rows, err := s.db.Query(roundRowSelect+` ORDER BY r.number ASC`, id)
	if err != nil {
		return nil, fmt.Errorf("store: get rounds: %w", err)
	}
	defer rows.Close()
	var out []models.RoundRow
	for rows.Next() {
		rr, err := scanRoundRow(rows)
		if err != nil {
			return nil, fmt.Errorf("store: get rounds: %w", err)
		}
		out = append(out, rr)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: get rounds: %w", err)
	}
	return out, nil
}

// GetRoundDetail returns one round with its economy, typed events and chat
// lines (ErrNotFound when the round is absent). Negative round numbers are
// real rounds here — knife/warmup rounds take them (extract.agg.renumber:
// -2 knife, -1 warmup) — so events are matched EXACTLY through
// queryEvents' exactRound (never through the range, whose 0 = open
// sentinel cannot express a round 0) and chat through queryChat's
// exactRound switch.
func (s *Store) GetRoundDetail(id int64, round int) (*models.RoundDetail, error) {
	rr, err := scanRoundRow(s.db.QueryRow(roundRowSelect+` AND r.number = ?`, id, round))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("store: get round detail: %w", err)
	}

	econRows, err := s.db.Query(
		`SELECT side, equip_value, money_sampled_sum, money_samples, spent, free_pistol_value
		 FROM round_economy WHERE match_id = ? AND round = ? ORDER BY side`,
		id, round,
	)
	if err != nil {
		return nil, fmt.Errorf("store: get round detail: %w", err)
	}
	defer econRows.Close()
	var economy []models.RoundEconomy
	for econRows.Next() {
		var e models.RoundEconomy
		if err := econRows.Scan(&e.Side, &e.EquipValue, &e.MoneySampledSum, &e.MoneySamples, &e.Spent, &e.FreePistolValue); err != nil {
			return nil, fmt.Errorf("store: get round detail: %w", err)
		}
		e.MatchID, e.Round = id, round
		economy = append(economy, e)
	}
	if err := econRows.Err(); err != nil {
		return nil, fmt.Errorf("store: get round detail: %w", err)
	}

	events, err := s.queryEvents(models.EventFilter{MatchID: id}, &round)
	if err != nil {
		return nil, fmt.Errorf("store: get round detail: %w", err)
	}
	chat, err := s.queryChat(id, round, true, "")
	if err != nil {
		return nil, fmt.Errorf("store: get round detail: %w", err)
	}

	return &models.RoundDetail{Round: rr, Economy: economy, Events: events, Chat: chat}, nil
}

func scanRoundRow(row interface{ Scan(...any) error }) (models.RoundRow, error) {
	var rr models.RoundRow
	err := row.Scan(
		&rr.Number, &rr.Winner, &rr.Reason, &rr.DurationS, &rr.Warmup, &rr.Pregame, &rr.BombSite,
		&rr.MVP, &rr.MVPName, &rr.MVPReason, &rr.EquipCT, &rr.EquipT, &rr.Kills,
		&rr.FirstKillSteam, &rr.FirstKillName, &rr.FirstDeathSteam, &rr.FirstDeathName,
		&rr.StartTick, &rr.EndTick, &rr.FreezeEndTick,
	)
	return rr, err
}

// whereClause accumulates the optional AND'ed filters of a read whose base
// WHERE clause is fixed (match-scoped): add each fragment with its bound
// values, render with sql() ("" when nothing was added), bind bound() in
// order after the base parameters. This is the ONE optional-filter idiom:
// no bound empty-string parameter is ORed with the real filter (dead
// weight whenever the filter is off) and the placeholder count never
// depends on the filter state.
type whereClause struct {
	parts []string
	args  []any
}

// add appends one AND'ed fragment and its arguments.
func (w *whereClause) add(clause string, args ...any) {
	w.parts = append(w.parts, clause)
	w.args = append(w.args, args...)
}

// sql renders the fragments as ` AND a AND b` (empty string when no filter
// was added — the base WHERE then stands alone).
func (w *whereClause) sql() string {
	if len(w.parts) == 0 {
		return ""
	}
	return " AND " + strings.Join(w.parts, " AND ")
}

// bound returns the filter arguments in clause order.
func (w *whereClause) bound() []any { return w.args }

// kindsToAny lifts a []string to []any for whereClause arg binding.
func kindsToAny(kinds []string) []any {
	out := make([]any, len(kinds))
	for i, k := range kinds {
		out[i] = k
	}
	return out
}

// GetEvents returns typed timeline rows for a filter, ordered by seq.
// The round bounds are a PARTIAL inclusive range (RoundFrom/RoundTo, 0 =
// open on that side — round 0 never exists, so 0 is the "unset"
// sentinel): both unset selects every round of the match (the read the
// Replay landmark feed, heatmaps and analytics pass make); Kind ""/Kinds
// nil all kinds; SteamID matches attacker or victim. Limit <= 0 means
// the hard cap of DefaultEventLimit. Round detail needs EXACT matching
// for its round instead (the range cannot express round 0 — 0 is the
// open sentinel) — see queryEvents' exactRound.
func (s *Store) GetEvents(f models.EventFilter) ([]models.EventRow, error) {
	return s.queryEvents(f, nil)
}

// queryEvents is the one typed-event read: every optional filter ANDs
// into the shared whereClause builder (no bound empty-string parameter,
// no placeholder-count drift).
//
// exactRound, when non-nil, replaces the round range with `e.round = ?`
// for THAT number — the round-detail read must match its (possibly
// negative knife/warmup, possibly 0) round exactly. nil = the documented
// EventFilter contract: an INCLUSIVE, PARTIAL range where each bound
// adds its own clause only when non-zero, so a knife/warmup round number
// (-1, -2) filters exactly like a positive one and 0 on a side means
// "no bound on that side".
func (s *Store) queryEvents(f models.EventFilter, exactRound *int) ([]models.EventRow, error) {
	var w whereClause
	if exactRound != nil {
		w.add("e.round = ?", *exactRound)
	} else {
		if f.RoundFrom != 0 {
			w.add("e.round >= ?", f.RoundFrom)
		}
		if f.RoundTo != 0 {
			w.add("e.round <= ?", f.RoundTo)
		}
	}
	if k := scrub(f.Kind); k != "" && len(f.Kinds) == 0 {
		w.add("e.kind = ?", k)
	}
	// Multi-kind form (the Replay landmark feed's category sets): an IN
	// filter that takes precedence over the single Kind clause above.
	if kinds := f.Kinds; len(kinds) > 0 {
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(kinds)), ",")
		w.add("e.kind IN ("+placeholders+")", kindsToAny(kinds)...)
	}
	if sid := scrub(f.SteamID); sid != "" {
		w.add("(e.attacker = ? OR e.victim = ?)", sid, sid)
	}
	// M3 advanced filters: every clause is an AND'ed bound
	// parameter; zero/""/nil means unconstrained. The distance bounds are
	// a partial range (either side may be open).
	if ww := scrub(f.Weapon); ww != "" {
		w.add("e.weapon = ?", ww)
	}
	if f.DistanceMin > 0 {
		w.add("e.distance >= ?", f.DistanceMin)
	}
	if f.DistanceMax > 0 {
		w.add("e.distance <= ?", f.DistanceMax)
	}
	if f.HeadshotOnly {
		w.add("e.headshot = 1")
	}
	if bb := f.BBox; bb != nil {
		// EITHER endpoint inside the rect = "events touching this region",
		// parenthesized as a whole so it ANDs with the clauses above.
		// e.pos_* is the victim/hit position while e.apos_* is the
		// attacker's (schema.sql events DDL) — and the kills heatmap
		// RASTERIZES THE ATTACKER POSITION (AnalyticsService.GetHeatmap:
		// `kind == "kills"` plots AttackerPosX/Y), so a region click
		// surrounds the KILLER: victim-only matching caught only
		// point-blank kills, where the victim still stood inside the
		// killer's ~40u cell. Damage/grenade rows keep their old
		// behavior through the pos_* half (their apos_* is NULL — SQL
		// three-valued logic: NULL OR TRUE = TRUE, NULL OR FALSE = NULL,
		// both NULL = no match), which the bbox tests pin per case.
		w.add(
			"((e.pos_x BETWEEN ? AND ? AND e.pos_y BETWEEN ? AND ?) OR (e.apos_x BETWEEN ? AND ? AND e.apos_y BETWEEN ? AND ?))",
			bb.MinX, bb.MaxX, bb.MinY, bb.MaxY,
			bb.MinX, bb.MaxX, bb.MinY, bb.MaxY,
		)
	}
	limit := f.Limit
	if limit <= 0 {
		limit = DefaultEventLimit
	}
	q := `SELECT ` + eventRowCols + eventRowFrom + ` WHERE e.match_id = ?` + w.sql() + ` ORDER BY e.seq LIMIT ?`
	args := make([]any, 0, 1+len(w.args)+2)
	args = append(args, f.MatchID)
	args = append(args, w.bound()...)
	args = append(args, limit)
	if f.Offset > 0 {
		q += ` OFFSET ?`
		args = append(args, f.Offset)
	}

	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, fmt.Errorf("store: get events: %w", err)
	}
	defer rows.Close()
	var out []models.EventRow
	for rows.Next() {
		er, err := scanEventRow(rows)
		if err != nil {
			return nil, fmt.Errorf("store: get events: %w", err)
		}
		out = append(out, er)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: get events: %w", err)
	}
	return out, nil
}

// GetEvent returns one event with its JSON payloads (ErrNotFound when
// absent).
func (s *Store) GetEvent(id int64) (*models.EventDetail, error) {
	var (
		er  models.EventRow
		det string
		raw string
	)
	err := s.db.QueryRow(
		`SELECT `+eventRowCols+`, e.detail_json, e.raw_json`+eventRowFrom+` WHERE e.id = ?`, id,
	).Scan(
		&er.ID, &er.Seq, &er.Tick, &er.Round, &er.Kind, &er.Attacker, &er.AttackerName,
		&er.Victim, &er.VictimName, &er.Assister, &er.AssisterName, &er.Weapon, &er.Headshot,
		&er.Wallbang, &er.Noscope, &er.ThroughSmoke, &er.AttackerBlind, &er.AttackerInAir, &er.AssistedFlash,
		&er.Distance, &er.Hitgroup, &er.Dmg, &er.Site, &er.PosX, &er.PosY, &er.PosZ,
		&er.AttackerPosX, &er.AttackerPosY, &er.AttackerPosZ,
		&det, &raw,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("store: get event: %w", err)
	}
	return &models.EventDetail{EventRow: er, DetailJSON: det, RawJSON: raw}, nil
}

// GetBlindFlashDetails returns detail_json for every blind event of a
// match, keyed by events.seq (UNIQUE (match_id, seq) — one entry per
// blind row). This is the one payload read outside GetEvent/GetRoundDetail:
// analytics.Compute needs the extractor's flashDurationMs to fill
// utility_events.flash_ms, and widening eventRowCols would drag
// detail_json into every timeline read (the typed-columns boundary —
// models.EventRow — stays payload-free).
func (s *Store) GetBlindFlashDetails(matchID int64) (map[int]string, error) {
	rows, err := s.db.Query(
		`SELECT seq, detail_json FROM events WHERE match_id = ? AND kind = ?`,
		matchID, models.EventBlind,
	)
	if err != nil {
		return nil, fmt.Errorf("store: get blind details: %w", err)
	}
	defer rows.Close()
	out := map[int]string{}
	for rows.Next() {
		var seq int
		var det string
		if err := rows.Scan(&seq, &det); err != nil {
			return nil, fmt.Errorf("store: get blind details: %w", err)
		}
		out[seq] = det
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: get blind details: %w", err)
	}
	return out, nil
}

// GetBlindFlashDurations returns the extractor's flashDurationMs for
// every blind event of a match, keyed by events.seq (UNIQUE (match_id,
// seq) — one entry per blind row). The SAME narrow payload side channel
// as GetBlindFlashDetails — models.EventRow stays payload-free and
// eventRowCols is not widened — but it pulls only the one integer the
// replay's flash-white overlay needs instead of the whole detail_json.
// json_valid guards malformed payloads (json_extract would error — the
// guard the nearDist reads in analytics.go use); a blind row without the
// field, or a non-integer value, maps to 0 (the caller drops those).
func (s *Store) GetBlindFlashDurations(matchID int64) (map[int]int, error) {
	rows, err := s.db.Query(
		`SELECT seq,
		   CASE WHEN json_valid(detail_json)
		        THEN COALESCE(CAST(json_extract(detail_json, '$.flashDurationMs') AS INTEGER), 0)
		        ELSE 0 END
		  FROM events
		  WHERE match_id = ? AND kind = ?
		  ORDER BY seq`,
		matchID, models.EventBlind,
	)
	if err != nil {
		return nil, fmt.Errorf("store: get blind durations: %w", err)
	}
	defer rows.Close()
	out := map[int]int{}
	for rows.Next() {
		var seq int
		var ms int
		if err := rows.Scan(&seq, &ms); err != nil {
			return nil, fmt.Errorf("store: get blind durations: %w", err)
		}
		out[seq] = ms
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: get blind durations: %w", err)
	}
	return out, nil
}

// GetDropDetails returns the weapon_drop payload projection (cat /
// mag / reserve) for every death-drop row of a match in events.seq
// order. The SAME narrow payload side channel as GetBlindFlashDurations
// (models.EventRow stays payload-free and eventRowCols is not widened):
// the replay's gun/util/kit layer gates on the STORED classification
// (detail_json.cat — stamped at extract time by models.IsUtilityWeapon /
// models.IsKit / the firearm sets; the frontend never re-derives it) and
// labels dropped guns with their mag/reserve at death. json_valid guards
// malformed payloads
// (json_extract would error); a row missing a field maps to "" / 0 —
// the consumer draws nothing for those (never a guessed cat).
func (s *Store) GetDropDetails(matchID int64) ([]models.DropDetail, error) {
	rows, err := s.db.Query(
		`SELECT seq,
		   CASE WHEN json_valid(detail_json)
		        THEN COALESCE(json_extract(detail_json, '$.cat'), '')
		        ELSE '' END,
		   CASE WHEN json_valid(detail_json)
		        THEN COALESCE(CAST(json_extract(detail_json, '$.mag') AS INTEGER), 0)
		        ELSE 0 END,
		   CASE WHEN json_valid(detail_json)
		        THEN COALESCE(CAST(json_extract(detail_json, '$.reserve') AS INTEGER), 0)
		        ELSE 0 END
		  FROM events
		  WHERE match_id = ? AND kind = ?
		  ORDER BY seq`,
		matchID, models.EventWeaponDrop,
	)
	if err != nil {
		return nil, fmt.Errorf("store: get drop details: %w", err)
	}
	defer rows.Close()
	var out []models.DropDetail
	for rows.Next() {
		var d models.DropDetail
		if err := rows.Scan(&d.Seq, &d.Cat, &d.Mag, &d.Reserve); err != nil {
			return nil, fmt.Errorf("store: get drop details: %w", err)
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: get drop details: %w", err)
	}
	return out, nil
}

// GetHurtHealthDetails returns detail_json for every player_hurt event
// of a match, keyed by events.seq (UNIQUE (match_id, seq)). Same narrow
// read as GetBlindFlashDetails: analytics.Compute stamps these onto the
// typed event copies so the clutch HPLeft reconstruction can use the
// game's sampled victim health (detail_json.health) instead of damage
// arithmetic — without widening eventRowCols (the typed-columns
// boundary — models.EventRow — stays payload-free).
func (s *Store) GetHurtHealthDetails(matchID int64) (map[int]string, error) {
	rows, err := s.db.Query(
		`SELECT seq, detail_json FROM events WHERE match_id = ? AND kind = ?`,
		matchID, models.EventDamage,
	)
	if err != nil {
		return nil, fmt.Errorf("store: get hurt details: %w", err)
	}
	defer rows.Close()
	out := map[int]string{}
	for rows.Next() {
		var seq int
		var det string
		if err := rows.Scan(&seq, &det); err != nil {
			return nil, fmt.Errorf("store: get hurt details: %w", err)
		}
		out[seq] = det
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: get hurt details: %w", err)
	}
	return out, nil
}

// GetChat returns a match's chat lines ordered by tick, id. Round < 0
// selects all rounds (same sentinel as GetEvents — the landmark feed's
// match-wide chat read passes -1); round detail reads exact rounds
// instead, see queryChat. player "" = every sender, otherwise an exact
// steam_id match (the landmark feed's player scope).
func (s *Store) GetChat(matchID int64, round int, player string) ([]models.ChatRow, error) {
	return s.queryChat(matchID, round, false, player)
}

// queryChat is GetChat with an exactRound switch: round detail reads
// must match a possibly negative knife/warmup round exactly, while the
// public GetChat sentinel (round < 0 = all rounds) feeds the landmark
// chat source. The typed-event read no longer shares this switch — it
// uses EventFilter's inclusive, partial round range (queryEvents).
func (s *Store) queryChat(matchID int64, round int, exactRound bool, player string) ([]models.ChatRow, error) {
	q := `SELECT id, ` + chatCols + `, decrypted FROM chat WHERE match_id = ?`
	args := []any{matchID}
	if round >= 0 || exactRound {
		q += ` AND round = ?`
		args = append(args, round)
	}
	if player != "" {
		q += ` AND steam_id = ?`
		args = append(args, player)
	}
	q += ` ORDER BY tick, id`
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, fmt.Errorf("store: get chat: %w", err)
	}
	defer rows.Close()
	var out []models.ChatRow
	for rows.Next() {
		var (
			c         models.ChatRow
			decrypted int64
		)
		if err := rows.Scan(&c.ID, &c.Tick, &c.Round, &c.SteamID, &c.Name, &c.Text, &c.Kind, &c.Channel, &decrypted); err != nil {
			return nil, fmt.Errorf("store: get chat: %w", err)
		}
		c.Decrypted = i2b(decrypted)
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: get chat: %w", err)
	}
	return out, nil
}

// GetGenericHistogram returns raw game-event name counts for a match,
// most frequent first.
func (s *Store) GetGenericHistogram(id int64) ([]models.NameCount, error) {
	rows, err := s.db.Query(
		`SELECT name, COUNT(*) FROM generic_events WHERE match_id = ? GROUP BY name ORDER BY COUNT(*) DESC, name ASC`,
		id,
	)
	if err != nil {
		return nil, fmt.Errorf("store: get generic histogram: %w", err)
	}
	defer rows.Close()
	var out []models.NameCount
	for rows.Next() {
		var nc models.NameCount
		if err := rows.Scan(&nc.Name, &nc.Count); err != nil {
			return nil, fmt.Errorf("store: get generic histogram: %w", err)
		}
		out = append(out, nc)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: get generic histogram: %w", err)
	}
	return out, nil
}

// GetWarnings returns a match's extraction warnings ordered by seq.
func (s *Store) GetWarnings(id int64) ([]string, error) {
	rows, err := s.db.Query(`SELECT message FROM warnings WHERE match_id = ? ORDER BY seq`, id)
	if err != nil {
		return nil, fmt.Errorf("store: get warnings: %w", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var msg string
		if err := rows.Scan(&msg); err != nil {
			return nil, fmt.Errorf("store: get warnings: %w", err)
		}
		out = append(out, msg)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: get warnings: %w", err)
	}
	return out, nil
}

func scanEventRow(row interface{ Scan(...any) error }) (models.EventRow, error) {
	var er models.EventRow
	err := row.Scan(
		&er.ID, &er.Seq, &er.Tick, &er.Round, &er.Kind, &er.Attacker, &er.AttackerName,
		&er.Victim, &er.VictimName, &er.Assister, &er.AssisterName, &er.Weapon, &er.Headshot,
		&er.Wallbang, &er.Noscope, &er.ThroughSmoke, &er.AttackerBlind, &er.AttackerInAir, &er.AssistedFlash,
		&er.Distance, &er.Hitgroup, &er.Dmg, &er.Site, &er.PosX, &er.PosY, &er.PosZ,
		&er.AttackerPosX, &er.AttackerPosY, &er.AttackerPosZ,
	)
	return er, err
}

// GetGenericEvents returns raw game-event rows for one event name ("" =
// all names), in insertion order — the landmark feed's generic-event
// source and the payload inspector's data source. Round < 0 selects all
// rounds (the shared sentinel); limit <= 0 defaults to 500 (hard cap
// 5000): payloads are JSON blobs, so callers page (limit + offset) rather
// than pull a whole match's worth. The optional name/round filters go
// through the shared whereClause (no optional-placeholder parameter —
// see TestGetGenericEventsFilterEquivalence).
// RowID (the table has no primary key) is the record identity the
// landmark feed selects on.
func (s *Store) GetGenericEvents(id int64, name string, round int, limit int, offset int) ([]models.GenericEvent, error) {
	if limit <= 0 {
		limit = 500
	}
	if limit > 5000 {
		limit = 5000
	}
	var w whereClause
	if name != "" {
		w.add("name = ?", name)
	}
	if round >= 0 {
		w.add("round = ?", round)
	}
	q := `SELECT rowid, name, tick, round, payload_json FROM generic_events
		WHERE match_id = ?` + w.sql() + ` ORDER BY rowid LIMIT ?`
	args := make([]any, 0, 1+len(w.args)+1)
	args = append(args, id)
	args = append(args, w.bound()...)
	args = append(args, limit)
	if offset > 0 {
		q += ` OFFSET ?`
		args = append(args, offset)
	}
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, fmt.Errorf("store: get generic events: %w", err)
	}
	defer rows.Close()
	var out []models.GenericEvent
	for rows.Next() {
		var ge models.GenericEvent
		ge.MatchID = id
		if err := rows.Scan(&ge.RowID, &ge.Name, &ge.Tick, &ge.Round, &ge.PayloadJSON); err != nil {
			return nil, fmt.Errorf("store: get generic events: %w", err)
		}
		out = append(out, ge)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: get generic events: %w", err)
	}
	return out, nil
}
