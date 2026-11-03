package store

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// matchColumns is the full matches column list in scan order.
const matchColumns = `id, path, sha256, size, map, patch_version, tick_rate, duration_ticks,
	playback_time_s, frames, server_name, client_name, game_dir, net_proto, is_pov,
	warmup_rounds, real_rounds, score_ct, score_t, half_ct, half_t, side_switches,
	entity_classes, end_entity_count, parser_version, extracted_at, parse_ms,
	warnings_count, status, error,
	position_format, sample_rate, position_frames, enc_messages`

// landmarkLimit is the hard row cap for GetLandmarks.
const landmarkLimit = 5000

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

const eventRowFrom = ` FROM events e
	LEFT JOIN players ap ON ap.match_id = e.match_id AND e.attacker <> '' AND ap.steam_id = e.attacker
	LEFT JOIN players vp ON vp.match_id = e.match_id AND e.victim <> '' AND vp.steam_id = e.victim
	LEFT JOIN players asp ON asp.match_id = e.match_id AND e.assister <> '' AND asp.steam_id = e.assister`

// roundRowSelect joins display names for MVP/first-kill/first-death
// ("" when the SteamID is absent or unknown).
const roundRowSelect = `SELECT r.number, r.winner, r.reason, r.duration_s, r.warmup, r.pregame, r.bomb_site,
	r.mvp, COALESCE(mp.name, ''), r.mvp_reason, r.equip_ct, r.equip_t,
	(SELECT COUNT(*) FROM events e WHERE e.match_id = r.match_id AND e.round = r.number AND e.kind = 'kill'),
	r.first_kill_steam, COALESCE(fp.name, ''), r.first_death_steam, COALESCE(dp.name, ''),
	r.start_tick, r.end_tick, r.freeze_end_tick
	FROM rounds r
	LEFT JOIN players mp ON mp.match_id = r.match_id AND r.mvp <> '' AND mp.steam_id = r.mvp
	LEFT JOIN players fp ON fp.match_id = r.match_id AND r.first_kill_steam <> '' AND fp.steam_id = r.first_kill_steam
	LEFT JOIN players dp ON dp.match_id = r.match_id AND r.first_death_steam <> '' AND dp.steam_id = r.first_death_steam
	WHERE r.match_id = ?`

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
	b.WriteString(`SELECT m.id, m.path, m.map, m.size, m.score_ct, m.score_t,
		COALESCE(ct.name, ''), COALESCE(t.name, ''), m.real_rounds, m.playback_time_s,
		m.extracted_at, m.status, m.error, m.sha256
		FROM matches m
		LEFT JOIN teams ct ON ct.match_id = m.id AND ct.side = 'ct'
		LEFT JOIN teams t ON t.match_id = m.id AND t.side = 't'`)
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
		var (
			mm        models.MatchSummary
			extracted sql.NullTime
		)
		if err := rows.Scan(
			&mm.ID, &mm.Path, &mm.Map, &mm.Size, &mm.ScoreCT, &mm.ScoreT, &mm.CTName, &mm.TName,
			&mm.RealRounds, &mm.DurationS, &extracted, &mm.Status, &mm.Error, &mm.SHA256,
		); err != nil {
			return nil, fmt.Errorf("store: list matches: %w", err)
		}
		if extracted.Valid {
			mm.ExtractedAt = extracted.Time
		}
		out = append(out, mm)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list matches: %w", err)
	}
	return out, nil
}

// GetMatch returns one match header row (ErrNotFound when absent).
func (s *Store) GetMatch(id int64) (*models.Match, error) {
	var (
		m         models.Match
		extracted sql.NullTime
	)
	err := s.db.QueryRow(`SELECT `+matchColumns+` FROM matches WHERE id = ?`, id).Scan(
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
	if extracted.Valid {
		m.ExtractedAt = extracted.Time
	}
	return &m, nil
}

// GetScoreboard returns one player's-aggregate rows for a match, joined
// with identity, sorted by a whitelisted sortKey (default kills DESC).
// KD = kills/max(deaths,1); KDA = (kills+assists)/max(deaths,1).
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
			CAST(ps.kills AS REAL) / MAX(ps.deaths, 1),
			CAST(ps.kills + ps.assists AS REAL) / MAX(ps.deaths, 1),
			ps.total_damage, ps.damage_taken, ps.entry_kills, ps.entry_deaths,
			ps.opening_kills, ps.opening_deaths, ps.trade_kills, ps.best_streak,
			ps.two_k, ps.three_k, ps.four_k, ps.five_k, ps.utility_damage, ps.flashes_popped,
			ps.flashed_times, ps.bomb_plants, ps.bomb_defuses, ps.mvps, ps.score,
			ps.teamkills, ps.suicides, ps.money_spent_total, ps.kills_by_weapon, ps.damage_by_weapon
		FROM player_stats ps
		JOIN players p ON p.match_id = ps.match_id AND p.steam_id = ps.steam_id
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
// lines (ErrNotFound when the round is absent).
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

	events, err := s.GetEvents(models.EventFilter{MatchID: id, Round: round})
	if err != nil {
		return nil, fmt.Errorf("store: get round detail: %w", err)
	}
	chat, err := s.GetChat(id, round)
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

// GetEvents returns typed timeline rows for a filter, ordered by seq.
// Round < 0 selects all rounds; Kind "" all kinds; SteamID matches
// attacker or victim. Limit <= 0 means the hard cap of 50000.
func (s *Store) GetEvents(f models.EventFilter) ([]models.EventRow, error) {
	where := []string{"e.match_id = ?"}
	args := []any{f.MatchID}
	if f.Round >= 0 {
		where = append(where, "e.round = ?")
		args = append(args, f.Round)
	}
	if k := scrub(f.Kind); k != "" {
		where = append(where, "e.kind = ?")
		args = append(args, k)
	}
	if sid := scrub(f.SteamID); sid != "" {
		where = append(where, "(e.attacker = ? OR e.victim = ?)")
		args = append(args, sid, sid)
	}
	// M3 advanced filters: every clause is an AND'ed bound
	// parameter; zero/""/nil means unconstrained.
	if w := scrub(f.Weapon); w != "" {
		where = append(where, "e.weapon = ?")
		args = append(args, w)
	}
	if f.TickFrom > 0 {
		where = append(where, "e.tick >= ?")
		args = append(args, f.TickFrom)
	}
	if f.TickTo > 0 {
		where = append(where, "e.tick <= ?")
		args = append(args, f.TickTo)
	}
	if f.DmgMin > 0 {
		where = append(where, "e.dmg >= ?")
		args = append(args, f.DmgMin)
	}
	if f.DmgMax > 0 {
		where = append(where, "e.dmg <= ?")
		args = append(args, f.DmgMax)
	}
	if f.DistanceMax > 0 {
		where = append(where, "e.distance <= ?")
		args = append(args, f.DistanceMax)
	}
	if f.HeadshotOnly {
		where = append(where, "e.headshot = 1")
	}
	if bb := f.BBox; bb != nil {
		where = append(where, "e.pos_x BETWEEN ? AND ? AND e.pos_y BETWEEN ? AND ?")
		args = append(args, bb.MinX, bb.MaxX, bb.MinY, bb.MaxY)
	}
	limit := f.Limit
	if limit <= 0 {
		limit = 50000
	}
	q := `SELECT ` + eventRowCols + eventRowFrom + ` WHERE ` + strings.Join(where, " AND ") + ` ORDER BY e.seq LIMIT ?`
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
// by tick/seq. limit <= 0 means the hard cap of 5000.
func (s *Store) GetLandmarks(matchID int64, limit int) ([]models.EventRow, error) {
	if limit <= 0 || limit > landmarkLimit {
		limit = landmarkLimit
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
// selects all rounds.
func (s *Store) GetChat(matchID int64, round int) ([]models.ChatRow, error) {
	q := `SELECT id, tick, round, steam_id, name, text, kind, decrypted FROM chat WHERE match_id = ?`
	args := []any{matchID}
	if round >= 0 {
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
			decrypted int
		)
		if err := rows.Scan(&c.ID, &c.Tick, &c.Round, &c.SteamID, &c.Name, &c.Text, &c.Kind, &decrypted); err != nil {
			return nil, fmt.Errorf("store: get chat: %w", err)
		}
		c.Decrypted = decrypted != 0
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
// rather than pull a whole match's worth.
func (s *Store) GetGenericEvents(id int64, name string, limit int) ([]models.GenericEvent, error) {
	if limit <= 0 {
		limit = 500
	}
	if limit > 5000 {
		limit = 5000
	}
	q := `SELECT name, tick, round, payload_json FROM generic_events
		WHERE match_id = ? AND (? = '' OR name = ?) ORDER BY rowid LIMIT ?`
	rows, err := s.db.Query(q, id, name, name, limit)
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
