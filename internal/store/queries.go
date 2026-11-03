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
// position_format/sample_rate/position_frames columns) so a column added
// here cannot silently drift from the extract write.
var matchColumns = []string{
	"id", "path", "sha256", "size", "map", "patch_version", "tick_rate",
	"duration_ticks", "playback_time_s", "frames", "server_name", "client_name",
	"game_dir", "net_proto", "is_pov", "warmup_rounds", "real_rounds",
	"score_ct", "score_t", "half_ct", "half_t", "side_switches",
	"entity_classes", "end_entity_count", "parser_version", "extracted_at",
	"parse_ms", "warnings_count", "status", "error", "position_format",
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
	"position_format": true, "sample_rate": true, "position_frames": true,
}

// LandmarkLimit is the hard row cap for GetLandmarks (replayservice's
// scrubber markers ride it).
const LandmarkLimit = 5000

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
var scoreboardSort = map[string]string{
	"name":           "p.name",
	"side":           "ps.side",
	"kills":          "ps.kills",
	"deaths":         "ps.deaths",
	"assists":        "ps.assists",
	"headshots":      "ps.headshots",
	"hs_pct":         "ps.hs_pct",
	"adr":            "ps.adr",
	"kd":             "kd",
	"kda":            "kda",
	"total_damage":   "ps.total_damage",
	"damage_taken":   "ps.damage_taken",
	"rounds_played":  "ps.rounds_played",
	"entry_kills":    "ps.entry_kills",
	"entry_deaths":   "ps.entry_deaths",
	"opening_kills":  "ps.opening_kills",
	"opening_deaths": "ps.opening_deaths",
	"trade_kills":    "ps.trade_kills",
	"best_streak":    "ps.best_streak",
	"two_k":          "ps.two_k",
	"three_k":        "ps.three_k",
	"four_k":         "ps.four_k",
	"five_k":         "ps.five_k",
	"utility_damage": "ps.utility_damage",
	"flashes_popped": "ps.flashes_popped",
	"flashed_times":  "ps.flashed_times",
	"bomb_plants":    "ps.bomb_plants",
	"bomb_defuses":   "ps.bomb_defuses",
	"mvps":           "ps.mvps",
	"score":          "ps.score",
	"teamkills":      "ps.teamkills",
	"suicides":       "ps.suicides",
	"money_spent":    "ps.money_spent_total",
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

// eventRowCols/eventRowFrom select typed timeline columns with player
// display names joined for attacker/victim/assister. The trailing
// e.pos_* columns are NULL for events without a source position; the
// e.apos_* columns carry the attacker's position (kill events).
const eventRowCols = `e.id, e.seq, e.tick, e.round, e.kind,
	e.attacker, COALESCE(ap.name, ''), e.victim, COALESCE(vp.name, ''),
	e.assister, COALESCE(asp.name, ''),
	e.weapon, e.headshot, e.wallbang, e.noscope, e.through_smoke,
	e.attacker_blind, e.assisted_flash, e.distance, e.hitgroup, e.dmg, e.site,
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

// ListMatches returns the library list: matches matching query (a
// case-insensitive LIKE across map, path and both team names; "" matches
// all), sorted by a whitelisted sortKey (default extracted_at).
func (s *Store) ListMatches(query, sortKey string, desc bool) ([]models.MatchSummary, error) {
	order, ok := matchListSort[sortKey]
	if !ok {
		order = matchListSort["extracted_at"]
	}
	dir := "ASC"
	if desc {
		dir = "DESC"
	}
	var b strings.Builder
	b.WriteString(`SELECT ` + matchSummaryCols + matchSummaryFrom)
	var args []any
	if q := scrub(query); q != "" {
		like := "%" + q + "%"
		b.WriteString(` WHERE m.map LIKE ? OR m.path LIKE ? OR ct.name LIKE ? OR t.name LIKE ?`)
		args = append(args, like, like, like, like)
	}
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
		&m.Status, &m.Error, &m.PositionFormat, &m.SampleRate, &m.PositionFrames,
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
			`+kdPerMatchSQL+`,
			CAST(ps.kills + ps.assists AS REAL) / MAX(ps.deaths, 1),
			ps.total_damage, ps.damage_taken, ps.entry_kills, ps.entry_deaths,
			ps.opening_kills, ps.opening_deaths, ps.trade_kills, ps.best_streak,
			ps.two_k, ps.three_k, ps.four_k, ps.five_k, ps.utility_damage, ps.flashes_popped,
			ps.flashed_times, ps.bomb_plants, ps.bomb_defuses, ps.mvps, ps.score,
			ps.teamkills, ps.suicides, ps.money_spent_total, ps.kills_by_weapon, ps.damage_by_weapon
		FROM player_stats ps
		`+playersJoin(joinInner, "p", "ps.match_id", "ps.steam_id", false)+`
		WHERE ps.match_id = ?
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
			&r.FlashesPopped, &r.FlashedTimes, &r.BombPlants, &r.BombDefuses, &r.MVPs,
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
// -2 knife, -1 warmup) — so events and chat are matched EXACTLY, never
// through the GetEvents/GetChat "Round < 0 = all rounds" sentinel.
func (s *Store) GetRoundDetail(id int64, round int) (*models.RoundDetail, error) {
	rr, err := scanRoundRow(s.db.QueryRow(roundRowSelect+` AND r.number = ?`, id, round))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("store: get round detail: %w", err)
	}

	econRows, err := s.db.Query(
		`SELECT side, equip_value, money_sampled_sum, money_samples
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
		if err := econRows.Scan(&e.Side, &e.EquipValue, &e.MoneySampledSum, &e.MoneySamples); err != nil {
			return nil, fmt.Errorf("store: get round detail: %w", err)
		}
		e.MatchID, e.Round = id, round
		economy = append(economy, e)
	}
	if err := econRows.Err(); err != nil {
		return nil, fmt.Errorf("store: get round detail: %w", err)
	}

	events, err := s.queryEvents(models.EventFilter{MatchID: id, Round: round}, true)
	if err != nil {
		return nil, fmt.Errorf("store: get round detail: %w", err)
	}
	chat, err := s.queryChat(id, round, true)
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
// order after the base parameters. This is the ONE optional-filter idiom —
// it replaces both the append-the-AND loop and the optional-placeholder
// trick (a bound empty-string parameter ORed with the real filter — dead
// weight whenever the filter is off), which tied the placeholder count to
// the filter state.
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

// GetEvents returns typed timeline rows for a filter, ordered by seq.
// Round < 0 selects all rounds (the sentinel the timeline, heatmaps and
// analytics pass over the whole match); Kind "" all kinds; SteamID matches
// attacker or victim. Limit <= 0 means the hard cap of DefaultEventLimit.
// Round detail needs exact matching for the negative knife/warmup round
// numbers instead — see queryEvents.
func (s *Store) GetEvents(f models.EventFilter) ([]models.EventRow, error) {
	return s.queryEvents(f, false)
}

// queryEvents is GetEvents with an exactRound switch: true forces
// `e.round = ?` for EVERY round number, including the negative ones knife/
// warmup rounds carry (a round-detail read of round -1 must return that
// round's rows, not the whole match). false keeps the documented
// EventFilter contract (Round < 0 = all rounds).
func (s *Store) queryEvents(f models.EventFilter, exactRound bool) ([]models.EventRow, error) {
	var w whereClause
	if f.Round >= 0 || exactRound {
		w.add("e.round = ?", f.Round)
	}
	if k := scrub(f.Kind); k != "" {
		w.add("e.kind = ?", k)
	}
	if sid := scrub(f.SteamID); sid != "" {
		w.add("(e.attacker = ? OR e.victim = ?)", sid, sid)
	}
	// M3 advanced filters: every clause is an AND'ed bound
	// parameter; zero/""/nil means unconstrained.
	if ww := scrub(f.Weapon); ww != "" {
		w.add("e.weapon = ?", ww)
	}
	if f.TickFrom > 0 {
		w.add("e.tick >= ?", f.TickFrom)
	}
	if f.TickTo > 0 {
		w.add("e.tick <= ?", f.TickTo)
	}
	if f.DmgMin > 0 {
		w.add("e.dmg >= ?", f.DmgMin)
	}
	if f.DmgMax > 0 {
		w.add("e.dmg <= ?", f.DmgMax)
	}
	if f.DistanceMax > 0 {
		w.add("e.distance <= ?", f.DistanceMax)
	}
	if f.HeadshotOnly {
		w.add("e.headshot = 1")
	}
	if bb := f.BBox; bb != nil {
		w.add("e.pos_x BETWEEN ? AND ? AND e.pos_y BETWEEN ? AND ?", bb.MinX, bb.MaxX, bb.MinY, bb.MaxY)
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
		&er.Wallbang, &er.Noscope, &er.ThroughSmoke, &er.AttackerBlind, &er.AssistedFlash,
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

// landmarkKinds are event kinds that surface as replay anchors even when
// their position columns are NULL (a missing bomb entity must
// not hide the plant/defuse/explode marker from the scrubber).
var landmarkKinds = []string{
	models.EventKill,
	models.EventGrenade,
	models.EventGrenadeThrow,
	models.EventBombPlant,
	models.EventBombDefuse,
	models.EventBombExplode,
}

// GetLandmarks returns position-stamped anchor events for one match —
// every event carrying a position plus the landmark kinds above — ordered
// by tick/seq. limit <= 0 means the hard cap of LandmarkLimit.
func (s *Store) GetLandmarks(matchID int64, limit int) ([]models.EventRow, error) {
	if limit <= 0 || limit > LandmarkLimit {
		limit = LandmarkLimit
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(landmarkKinds)), ",")
	q := `SELECT ` + eventRowCols + eventRowFrom +
		` WHERE e.match_id = ? AND (e.pos_x IS NOT NULL OR e.kind IN (` + placeholders + `))` +
		` ORDER BY e.tick, e.seq LIMIT ?`
	args := make([]any, 0, len(landmarkKinds)+2)
	args = append(args, matchID)
	for _, k := range landmarkKinds {
		args = append(args, k)
	}
	args = append(args, limit)

	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, fmt.Errorf("store: get landmarks: %w", err)
	}
	defer rows.Close()
	var out []models.EventRow
	for rows.Next() {
		er, err := scanEventRow(rows)
		if err != nil {
			return nil, fmt.Errorf("store: get landmarks: %w", err)
		}
		out = append(out, er)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: get landmarks: %w", err)
	}
	return out, nil
}

// GetChat returns a match's chat lines ordered by tick, id. Round < 0
// selects all rounds (same sentinel as GetEvents — the Context view's
// match-wide chat feed passes -1); round detail reads exact rounds instead,
// see queryChat.
func (s *Store) GetChat(matchID int64, round int) ([]models.ChatRow, error) {
	return s.queryChat(matchID, round, false)
}

// queryChat is GetChat with an exactRound switch — mirror of
// queryEvents (negative knife/warmup round numbers are real rounds here).
func (s *Store) queryChat(matchID int64, round int, exactRound bool) ([]models.ChatRow, error) {
	q := `SELECT id, ` + chatCols + `, decrypted FROM chat WHERE match_id = ?`
	args := []any{matchID}
	if round >= 0 || exactRound {
		q += ` AND round = ?`
		args = append(args, round)
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
		if err := rows.Scan(&c.ID, &c.Tick, &c.Round, &c.SteamID, &c.Name, &c.Text, &c.Kind, &decrypted); err != nil {
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
		&er.Wallbang, &er.Noscope, &er.ThroughSmoke, &er.AttackerBlind, &er.AssistedFlash,
		&er.Distance, &er.Hitgroup, &er.Dmg, &er.Site, &er.PosX, &er.PosY, &er.PosZ,
		&er.AttackerPosX, &er.AttackerPosY, &er.AttackerPosZ,
	)
	return er, err
}

// GetGenericEvents returns raw game-event rows for one event name ("" = all
// names), in insertion order — the payload viewer's data source. limit <= 0
// defaults to 500 (hard cap 5000): payloads are JSON blobs, so callers page
// rather than pull a whole match's worth. The optional name filter goes
// through the shared whereClause (the old form bound a dead
// optional-placeholder parameter — see TestGetGenericEventsFilterEquivalence).
func (s *Store) GetGenericEvents(id int64, name string, limit int) ([]models.GenericEvent, error) {
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
	q := `SELECT name, tick, round, payload_json FROM generic_events
		WHERE match_id = ?` + w.sql() + ` ORDER BY rowid LIMIT ?`
	args := make([]any, 0, 1+len(w.args)+1)
	args = append(args, id)
	args = append(args, w.bound()...)
	args = append(args, limit)
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, fmt.Errorf("store: get generic events: %w", err)
	}
	defer rows.Close()
	var out []models.GenericEvent
	for rows.Next() {
		var ge models.GenericEvent
		ge.MatchID = id
		if err := rows.Scan(&ge.Name, &ge.Tick, &ge.Round, &ge.PayloadJSON); err != nil {
			return nil, fmt.Errorf("store: get generic events: %w", err)
		}
		out = append(out, ge)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: get generic events: %w", err)
	}
	return out, nil
}
