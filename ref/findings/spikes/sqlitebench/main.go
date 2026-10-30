package main

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

var (
	flagMatches      = flag.Int("matches", 100, "matches for the library phase")
	flagSingleRuns   = flag.Int("single-runs", 6, "single-match runs, first is warmup")
	flagHurts        = flag.Int("hurts", 566, "player_hurt events per match")
	flagFires        = flag.Int("fires", 3213, "weapon_fire events per match")
	flagDeaths       = flag.Int("deaths", 146, "player_death events per match")
	flagGeneric      = flag.Int("generic", 7000, "generic_events rows per match")
	flagGenericTypes = flag.Int("generic-types", 46, "distinct generic event names")
	flagRounds       = flag.Int("rounds", 22, "rounds per match")
	flagPlayers      = flag.Int("players", 10, "players per match")
	flagChat         = flag.Int("chat", 200, "chat rows per match")
	flagDetailBytes  = flag.Int("detail-bytes", 400, "approx size of detail_json per event")
	flagRawBytes     = flag.Int("raw-bytes", 300, "approx size of raw_json per event")
	flagPayloadBytes = flag.Int("payload-bytes", 200, "approx size of generic payload_json")
	flagJsonReps     = flag.Int("json-reps", 7, "timed reps per json variant after warmup")
	flagJsonEvents   = flag.Int("json-events", 0, "events for json bench, 0 = one match events")
	flagNaiveRuns    = flag.Int("naive-runs", 1, "naive txn-per-row runs, 0 skips phase")
	flagSeed         = flag.Int64("seed", 42, "rng seed")
)

type Config struct {
	Hurts, Fires, Deaths, Generic, GenericTypes, Rounds, Players, Chat int
	DetailBytes, RawBytes, PayloadBytes                                int
	Seed                                                               int64
}

type MatchMeta struct {
	Path, SHA, Map     string
	TickRate, Duration int
	ParserVersion      string
	Status             string
	CreatedAt          int64
}

type PlayerRow struct {
	MatchID       int64
	SteamID, Name string
	Team          string
	FirstSeen     int
}

type StatRow struct {
	MatchID                  int64
	SteamID                  string
	Kills, Deaths, Assists   int
	TotalDamage              int
	ADR, HsPct, KAST, Rating float64
	Plants, Defuses          int
}

type RoundRow struct {
	MatchID   int64
	Number    int
	Winner    string
	WinReason string
	StartTick int
	EndTick   int
}

type EventRow struct {
	MatchID                  int64
	Seq, Tick, Round         int
	Kind                     string
	Attacker, Victim, Weapon string
	Headshot, Dmg            int
	DetailJSON, RawJSON      string
}

type GenericRow struct {
	MatchID int64
	Name    string
	Tick    int
	Round   int
	Payload string
}

type ChatRow struct {
	MatchID       int64
	Tick, Round   int
	SteamID, Name string
	Text, Kind    string
}

type MatchData struct {
	Meta    MatchMeta
	Players []PlayerRow
	Stats   []StatRow
	Rounds  []RoundRow
	Events  []EventRow
	Generic []GenericRow
	Chat    []ChatRow
}

const schema = `
CREATE TABLE matches (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL UNIQUE,
  map TEXT NOT NULL,
  tick_rate INTEGER NOT NULL,
  duration_ticks INTEGER NOT NULL,
  parser_version TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE players (
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  steam_id TEXT NOT NULL,
  name TEXT NOT NULL,
  team TEXT NOT NULL,
  first_seen_tick INTEGER NOT NULL,
  PRIMARY KEY (match_id, steam_id)
);
CREATE TABLE player_stats (
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  steam_id TEXT NOT NULL,
  kills INTEGER NOT NULL,
  deaths INTEGER NOT NULL,
  assists INTEGER NOT NULL,
  total_damage INTEGER NOT NULL,
  adr REAL NOT NULL,
  hs_pct REAL NOT NULL,
  kast REAL NOT NULL,
  rating REAL NOT NULL,
  plants INTEGER NOT NULL,
  defuses INTEGER NOT NULL,
  PRIMARY KEY (match_id, steam_id)
);
CREATE TABLE rounds (
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  winner TEXT NOT NULL,
  win_reason TEXT NOT NULL,
  start_tick INTEGER NOT NULL,
  end_tick INTEGER NOT NULL,
  PRIMARY KEY (match_id, number)
);
CREATE TABLE events (
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  round INTEGER NOT NULL,
  kind TEXT NOT NULL,
  attacker TEXT,
  victim TEXT,
  weapon TEXT,
  headshot INTEGER NOT NULL,
  dmg INTEGER NOT NULL,
  detail_json TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  PRIMARY KEY (match_id, seq)
);
CREATE INDEX events_match_kind_tick ON events (match_id, kind, tick);
CREATE TABLE generic_events (
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  tick INTEGER NOT NULL,
  round INTEGER NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX generic_match_name_tick ON generic_events (match_id, name, tick);
CREATE TABLE chat (
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  tick INTEGER NOT NULL,
  round INTEGER NOT NULL,
  steam_id TEXT,
  name TEXT NOT NULL,
  text TEXT NOT NULL,
  kind TEXT NOT NULL
);
CREATE INDEX chat_match_tick ON chat (match_id, tick);
`

const (
	qMatch   = `INSERT INTO matches(path, sha256, map, tick_rate, duration_ticks, parser_version, status, created_at) VALUES(?,?,?,?,?,?,?,?)`
	qPlayer  = `INSERT INTO players(match_id, steam_id, name, team, first_seen_tick) VALUES(?,?,?,?,?)`
	qStat    = `INSERT INTO player_stats(match_id, steam_id, kills, deaths, assists, total_damage, adr, hs_pct, kast, rating, plants, defuses) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
	qRound   = `INSERT INTO rounds(match_id, number, winner, win_reason, start_tick, end_tick) VALUES(?,?,?,?,?,?)`
	qEvent   = `INSERT INTO events(match_id, seq, tick, round, kind, attacker, victim, weapon, headshot, dmg, detail_json, raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
	qGeneric = `INSERT INTO generic_events(match_id, name, tick, round, payload_json) VALUES(?,?,?,?,?)`
	qChat    = `INSERT INTO chat(match_id, tick, round, steam_id, name, text, kind) VALUES(?,?,?,?,?,?,?)`
)

var fillPool string

func initPool(seed int64) {
	r := rand.New(rand.NewPCG(uint64(seed)+7, uint64(seed)+13))
	const alnum = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ,.-"
	b := make([]byte, 1<<16)
	for i := range b {
		b[i] = alnum[r.IntN(len(alnum))]
	}
	fillPool = string(b)
}

func payload(r *rand.Rand, target int) string {
	var b strings.Builder
	b.Grow(target + 32)
	b.WriteString(`{"t":`)
	b.WriteString(strconv.Itoa(r.IntN(1000000)))
	b.WriteString(`,"p":[`)
	for i := 0; i < 3; i++ {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(strconv.FormatFloat(r.Float64()*2200-1100, 'f', 3, 64))
	}
	b.WriteString(`],"w":`)
	b.WriteString(strconv.FormatBool(r.IntN(2) == 0))
	b.WriteString(`,"n":"`)
	need := target - (b.Len() + 2)
	if need < 4 {
		need = 4
	}
	if need > len(fillPool)-2 {
		need = len(fillPool) - 2
	}
	off := r.IntN(len(fillPool) - need - 1)
	b.WriteString(fillPool[off : off+need])
	b.WriteString(`"}`)
	return b.String()
}

var mapsPool = []string{"de_dust2", "de_mirage", "de_inferno", "de_nuke", "de_ancient", "de_anubis", "de_vertigo", "de_overpass"}

var weaponsPool = []string{"ak47", "m4a1", "awp", "deagle", "glock", "usp_silencer", "mp9", "mac10", "nova", "famas", "galilar", "sg556", "aug", "ssg08", "xm1014", "p250", "tec9", "fiveseven", "cz75a", "knife", "hegrenade", "molotov", "flashbang", "smokegrenade", "incgrenade"}

var namePool = []string{"donk", "ZywOo", "s1mple", "m0NESY", "device", "NiKo", "electronic", "broky", "rain", "karrigan", "frozen", "jL", "iM", "b1t", "fl1t", "w0nderful", "torzsi", "Spinx", "Jimpphat", "Kyojin", "Ex3rcice", "Lack1", "headtr1ck", "nawwk"}

var chatPool = []string{"gg", "wp", "nice shot", "rush B", "eco round", "need drop", "afk 1 min", "report wallhack pls", "gl hf", "what was that", "my bad", "trade me", "hold angle", "push mid", "save", "clutch or kick", "1v1 me", "lag spike", "site clear", "rotate A"}

var winReasons = []string{"elimination", "bomb_exploded", "bomb_defused", "time_expired", "target_bombed"}

var genericNames = []string{"round_start", "round_end", "bomb_planted", "bomb_defused", "bomb_exploded", "player_connect", "player_disconnect", "player_team", "player_spawn", "player_death_notice", "weapon_pickup", "weapon_drop", "item_purchase", "item_remove", "hegrenade_detonated", "flashbang_detonated", "smoke_detonated", "molotov_detonated", "inferno_startburn", "player_hurt_apply", "cs_win_panel_match", "cs_intermission", "cs_game_newmap", "match_start", "match_end", "halftime", "swap_teams", "freezetime_start", "freeze_time_end", "buyzone_enter", "buyzone_exit", "server_cvar", "player_info", "player_ready", "server_message", "chat_message", "rank_update", "skill_rating", "money_change", "ammo_pickup", "generic_bomb", "hostage_rescued", "hostage_dropped", "door_moving", "breakable_damaged", "player_jump", "player_landed"}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func genMatch(idx int, c Config) *MatchData {
	r := rand.New(rand.NewPCG(uint64(c.Seed)*31+uint64(idx)*7919+1, uint64(idx)*104729+uint64(c.Seed)+7))
	tickRate := 64
	roundTicks := tickRate * 75
	steamIDs := make([]string, c.Players)
	m := &MatchData{}
	steamBase := int64(76561190000000000) + int64(idx)*1000
	for i := 0; i < c.Players; i++ {
		steamIDs[i] = strconv.FormatInt(steamBase+int64(i), 10)
		team := "CT"
		if i%2 == 1 {
			team = "T"
		}
		name := namePool[r.IntN(len(namePool))]
		if i >= len(namePool) {
			name = fmt.Sprintf("%s%d", name, i)
		}
		m.Players = append(m.Players, PlayerRow{
			SteamID:   steamIDs[i],
			Name:      name,
			Team:      team,
			FirstSeen: -128,
		})
	}
	roundStart := make([]int, c.Rounds)
	for i := 0; i < c.Rounds; i++ {
		roundStart[i] = i*roundTicks + r.IntN(400)
		winner := "CT"
		if r.IntN(2) == 0 {
			winner = "T"
		}
		m.Rounds = append(m.Rounds, RoundRow{
			Number:    i + 1,
			Winner:    winner,
			WinReason: winReasons[r.IntN(len(winReasons))],
			StartTick: roundStart[i],
			EndTick:   roundStart[i] + roundTicks - 400,
		})
	}
	totalTicks := c.Rounds * roundTicks
	roundOf := func(tick int) int {
		n := tick/roundTicks + 1
		if n < 1 {
			n = 1
		}
		if n > c.Rounds {
			n = c.Rounds
		}
		return n
	}
	pickTick := func() int {
		return roundStart[r.IntN(c.Rounds)] + r.IntN(roundTicks-400)
	}
	pickPlayer := func() int { return r.IntN(len(steamIDs)) }

	for k := 0; k < c.Hurts; k++ {
		tick := pickTick()
		ai := pickPlayer()
		vi := pickPlayer()
		for vi == ai {
			vi = pickPlayer()
		}
		m.Events = append(m.Events, EventRow{
			Tick:       tick,
			Round:      roundOf(tick),
			Kind:       "player_hurt",
			Attacker:   steamIDs[ai],
			Victim:     steamIDs[vi],
			Weapon:     weaponsPool[r.IntN(len(weaponsPool))],
			Headshot:   boolToInt(r.IntN(100) < 28),
			Dmg:        r.IntN(111),
			DetailJSON: payload(r, c.DetailBytes),
			RawJSON:    payload(r, c.RawBytes),
		})
	}
	for k := 0; k < c.Fires; k++ {
		tick := pickTick()
		m.Events = append(m.Events, EventRow{
			Tick:       tick,
			Round:      roundOf(tick),
			Kind:       "weapon_fire",
			Attacker:   steamIDs[pickPlayer()],
			Weapon:     weaponsPool[r.IntN(len(weaponsPool))],
			DetailJSON: payload(r, c.DetailBytes),
			RawJSON:    payload(r, c.RawBytes),
		})
	}
	for k := 0; k < c.Deaths; k++ {
		tick := pickTick()
		ai := pickPlayer()
		vi := pickPlayer()
		for vi == ai {
			vi = pickPlayer()
		}
		m.Events = append(m.Events, EventRow{
			Tick:       tick,
			Round:      roundOf(tick),
			Kind:       "player_death",
			Attacker:   steamIDs[ai],
			Victim:     steamIDs[vi],
			Weapon:     weaponsPool[r.IntN(len(weaponsPool))],
			Headshot:   boolToInt(r.IntN(100) < 55),
			Dmg:        0,
			DetailJSON: payload(r, c.DetailBytes),
			RawJSON:    payload(r, c.RawBytes),
		})
	}
	sort.SliceStable(m.Events, func(i, j int) bool { return m.Events[i].Tick < m.Events[j].Tick })
	for i := range m.Events {
		m.Events[i].Seq = i
	}

	names := append([]string(nil), genericNames...)
	for i := len(names); i < c.GenericTypes; i++ {
		names = append(names, fmt.Sprintf("evt_type_%d", i))
	}
	for k := 0; k < c.Generic; k++ {
		tick := r.IntN(totalTicks)
		m.Generic = append(m.Generic, GenericRow{
			Name:    names[r.IntN(len(names))],
			Tick:    tick,
			Round:   roundOf(tick),
			Payload: payload(r, c.PayloadBytes),
		})
	}
	for k := 0; k < c.Chat; k++ {
		tick := r.IntN(totalTicks)
		i := pickPlayer()
		m.Chat = append(m.Chat, ChatRow{
			Tick:    tick,
			Round:   roundOf(tick),
			SteamID: steamIDs[i],
			Name:    m.Players[i].Name,
			Text:    chatPool[r.IntN(len(chatPool))],
			Kind:    []string{"say", "say_team"}[r.IntN(2)],
		})
	}

	kills := make([]int, c.Players)
	deaths := make([]int, c.Players)
	assists := make([]int, c.Players)
	damage := make([]int, c.Players)
	headshots := make([]int, c.Players)
	idxOf := map[string]int{}
	for i, s := range steamIDs {
		idxOf[s] = i
	}
	for _, ev := range m.Events {
		switch ev.Kind {
		case "player_death":
			if a, ok := idxOf[ev.Attacker]; ok {
				kills[a]++
				if ev.Headshot == 1 {
					headshots[a]++
				}
			}
			if v, ok := idxOf[ev.Victim]; ok {
				deaths[v]++
			}
			if r.IntN(4) == 0 {
				assists[pickPlayer()]++
			}
		case "player_hurt":
			if a, ok := idxOf[ev.Attacker]; ok && ev.Attacker != ev.Victim {
				damage[a] += ev.Dmg
			}
		}
	}
	for i := 0; i < c.Players; i++ {
		adr := float64(damage[i]) / float64(c.Rounds)
		hsPct := 0.0
		if kills[i] > 0 {
			hsPct = float64(headshots[i]) / float64(kills[i]) * 100
		}
		m.Stats = append(m.Stats, StatRow{
			SteamID:     steamIDs[i],
			Kills:       kills[i],
			Deaths:      deaths[i],
			Assists:     assists[i],
			TotalDamage: damage[i],
			ADR:         float64(int(adr*10)) / 10,
			HsPct:       float64(int(hsPct*10)) / 10,
			KAST:        float64(45+r.IntN(4000)) / 100.0,
			Rating:      float64(int((0.5+r.Float64()*1.3)*100)) / 100,
			Plants:      r.IntN(4),
			Defuses:     r.IntN(3),
		})
	}

	sum := sha256.Sum256([]byte(fmt.Sprintf("match-%d-%d", idx, c.Seed)))
	m.Meta = MatchMeta{
		Path:          fmt.Sprintf("/demos/match_%03d.dem.zst", idx),
		SHA:           hex.EncodeToString(sum[:]),
		Map:           mapsPool[idx%len(mapsPool)],
		TickRate:      tickRate,
		Duration:      totalTicks,
		ParserVersion: "0.1.0-dev",
		Status:        "parsed",
		CreatedAt:     time.Now().Unix(),
	}
	return m
}

func openDB(path string) (*sql.DB, error) {
	dsn := "file:" + path + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	return db, nil
}

func mustExec(db *sql.DB, q string) {
	if _, err := db.Exec(q); err != nil {
		panic(q + ": " + err.Error())
	}
}

func createSchema(db *sql.DB) {
	for _, stmt := range strings.Split(schema, ";") {
		s := strings.TrimSpace(stmt)
		if s == "" {
			continue
		}
		mustExec(db, s)
	}
}

func pragmaStr(db *sql.DB, name string) string {
	var v string
	if err := db.QueryRow("PRAGMA " + name).Scan(&v); err != nil {
		return "err:" + err.Error()
	}
	return v
}

type stmtSet struct {
	match, player, stat, round, event, generic, chat *sql.Stmt
}

func prepTx(tx *sql.Tx) (*stmtSet, error) {
	s := &stmtSet{}
	var err error
	if s.match, err = tx.Prepare(qMatch); err != nil {
		return nil, err
	}
	if s.player, err = tx.Prepare(qPlayer); err != nil {
		return nil, err
	}
	if s.stat, err = tx.Prepare(qStat); err != nil {
		return nil, err
	}
	if s.round, err = tx.Prepare(qRound); err != nil {
		return nil, err
	}
	if s.event, err = tx.Prepare(qEvent); err != nil {
		return nil, err
	}
	if s.generic, err = tx.Prepare(qGeneric); err != nil {
		return nil, err
	}
	if s.chat, err = tx.Prepare(qChat); err != nil {
		return nil, err
	}
	return s, nil
}

func matchArgs(m *MatchData) []any {
	return []any{m.Meta.Path, m.Meta.SHA, m.Meta.Map, m.Meta.TickRate, m.Meta.Duration, m.Meta.ParserVersion, m.Meta.Status, m.Meta.CreatedAt}
}

func countRows(m *MatchData) int64 {
	return int64(1 + len(m.Players) + len(m.Stats) + len(m.Rounds) + len(m.Events) + len(m.Generic) + len(m.Chat))
}

func insertMatchTx(db *sql.DB, m *MatchData) (int64, error) {
	tx, err := db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	st, err := prepTx(tx)
	if err != nil {
		return 0, err
	}
	res, err := st.match.Exec(matchArgs(m)...)
	if err != nil {
		return 0, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, err
	}
	for _, p := range m.Players {
		if _, err := st.player.Exec(id, p.SteamID, p.Name, p.Team, p.FirstSeen); err != nil {
			return 0, err
		}
	}
	for _, p := range m.Stats {
		if _, err := st.stat.Exec(id, p.SteamID, p.Kills, p.Deaths, p.Assists, p.TotalDamage, p.ADR, p.HsPct, p.KAST, p.Rating, p.Plants, p.Defuses); err != nil {
			return 0, err
		}
	}
	for _, rr := range m.Rounds {
		if _, err := st.round.Exec(id, rr.Number, rr.Winner, rr.WinReason, rr.StartTick, rr.EndTick); err != nil {
			return 0, err
		}
	}
	for _, ev := range m.Events {
		if _, err := st.event.Exec(id, ev.Seq, ev.Tick, ev.Round, ev.Kind, ev.Attacker, ev.Victim, ev.Weapon, ev.Headshot, ev.Dmg, ev.DetailJSON, ev.RawJSON); err != nil {
			return 0, err
		}
	}
	for _, g := range m.Generic {
		if _, err := st.generic.Exec(id, g.Name, g.Tick, g.Round, g.Payload); err != nil {
			return 0, err
		}
	}
	for _, ch := range m.Chat {
		if _, err := st.chat.Exec(id, ch.Tick, ch.Round, ch.SteamID, ch.Name, ch.Text, ch.Kind); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return countRows(m), nil
}

func insertMatchNaive(db *sql.DB, m *MatchData) (int64, error) {
	qs := []string{qMatch, qPlayer, qStat, qRound, qEvent, qGeneric, qChat}
	stmts := make([]*sql.Stmt, len(qs))
	for i, q := range qs {
		s, err := db.Prepare(q)
		if err != nil {
			return 0, err
		}
		defer s.Close()
		stmts[i] = s
	}
	exec1 := func(s *sql.Stmt, args ...any) error {
		tx, err := db.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Stmt(s).Exec(args...); err != nil {
			tx.Rollback()
			return err
		}
		return tx.Commit()
	}
	var id int64
	if err := func() error {
		tx, err := db.Begin()
		if err != nil {
			return err
		}
		defer tx.Rollback()
		res, err := tx.Stmt(stmts[0]).Exec(matchArgs(m)...)
		if err != nil {
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
		id, err = res.LastInsertId()
		return err
	}(); err != nil {
		return 0, err
	}
	for _, p := range m.Players {
		if err := exec1(stmts[1], id, p.SteamID, p.Name, p.Team, p.FirstSeen); err != nil {
			return 0, err
		}
	}
	for _, p := range m.Stats {
		if err := exec1(stmts[2], id, p.SteamID, p.Kills, p.Deaths, p.Assists, p.TotalDamage, p.ADR, p.HsPct, p.KAST, p.Rating, p.Plants, p.Defuses); err != nil {
			return 0, err
		}
	}
	for _, rr := range m.Rounds {
		if err := exec1(stmts[3], id, rr.Number, rr.Winner, rr.WinReason, rr.StartTick, rr.EndTick); err != nil {
			return 0, err
		}
	}
	for _, ev := range m.Events {
		if err := exec1(stmts[4], id, ev.Seq, ev.Tick, ev.Round, ev.Kind, ev.Attacker, ev.Victim, ev.Weapon, ev.Headshot, ev.Dmg, ev.DetailJSON, ev.RawJSON); err != nil {
			return 0, err
		}
	}
	for _, g := range m.Generic {
		if err := exec1(stmts[5], id, g.Name, g.Tick, g.Round, g.Payload); err != nil {
			return 0, err
		}
	}
	for _, ch := range m.Chat {
		if err := exec1(stmts[6], id, ch.Tick, ch.Round, ch.SteamID, ch.Name, ch.Text, ch.Kind); err != nil {
			return 0, err
		}
	}
	return countRows(m), nil
}

func median(ds []time.Duration) time.Duration {
	if len(ds) == 0 {
		return 0
	}
	s := append([]time.Duration(nil), ds...)
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	n := len(s)
	if n%2 == 1 {
		return s[n/2]
	}
	return (s[n/2-1] + s[n/2]) / 2
}

func ms(d time.Duration) string {
	return fmt.Sprintf("%.1fms", float64(d.Microseconds())/1000.0)
}

func secs(d time.Duration) string {
	return fmt.Sprintf("%.3fs", d.Seconds())
}

func rps(rows int64, d time.Duration) string {
	if d <= 0 {
		return "-"
	}
	return fmt.Sprintf("%.0f rows/s", float64(rows)/d.Seconds())
}

func fileSize(path string) int64 {
	fi, err := os.Stat(path)
	if err != nil {
		return -1
	}
	return fi.Size()
}

func cpuModel() string {
	b, err := os.ReadFile("/proc/cpuinfo")
	if err != nil {
		return "unknown"
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, "model name") {
			parts := strings.SplitN(line, ":", 2)
			if len(parts) == 2 {
				return strings.TrimSpace(parts[1])
			}
		}
	}
	return "unknown"
}

type DetailMeta struct {
	ArmorPen float64 `json:"armor_pen"`
	Armor    int     `json:"armor"`
	Dist     float64 `json:"dist"`
}

type Detail struct {
	Kind     string     `json:"kind"`
	Attacker string     `json:"attacker"`
	Victim   string     `json:"victim"`
	Weapon   string     `json:"weapon"`
	Dmg      int        `json:"dmg"`
	HS       bool       `json:"headshot"`
	Tick     int        `json:"tick"`
	Round    int        `json:"round"`
	Pos      [3]float64 `json:"pos"`
	Meta     DetailMeta `json:"meta"`
	Flags    []string   `json:"flags"`
}

type RoundInfo struct {
	Winner    string `json:"winner"`
	Number    int    `json:"number"`
	StartTick int    `json:"start_tick"`
}

type RawFull struct {
	Seq    int       `json:"seq"`
	Kind   string    `json:"kind"`
	Demo   string    `json:"demo"`
	TickRT int       `json:"tick_rate"`
	Round  RoundInfo `json:"round"`
	Detail Detail    `json:"detail"`
}

var sink int

func buildDetail(ev *EventRow, r *rand.Rand) Detail {
	flags := []string{}
	if r.IntN(3) == 0 {
		flags = append(flags, "wall")
	}
	if r.IntN(4) == 0 {
		flags = append(flags, "blind")
	}
	return Detail{
		Kind:     ev.Kind,
		Attacker: ev.Attacker,
		Victim:   ev.Victim,
		Weapon:   ev.Weapon,
		Dmg:      ev.Dmg,
		HS:       ev.Headshot == 1,
		Tick:     ev.Tick,
		Round:    ev.Round,
		Pos:      [3]float64{float64(ev.Tick%1000) / 10, float64(ev.Seq%700) / 7, 3.5},
		Meta:     DetailMeta{ArmorPen: 0.77, Armor: 100, Dist: float64(ev.Seq%40) + 0.5},
		Flags:    flags,
	}
}

func buildRaw(ev *EventRow, d Detail) RawFull {
	return RawFull{
		Seq:    ev.Seq,
		Kind:   ev.Kind,
		Demo:   "donk.dem.zst",
		TickRT: 64,
		Round:  RoundInfo{Winner: "CT", Number: ev.Round, StartTick: (ev.Round - 1) * 4800},
		Detail: d,
	}
}

type jsonRes struct {
	name     string
	d        time.Duration
	bytesOut int
}

func jsonRun(name string, reps int, f func() int) jsonRes {
	durs := make([]time.Duration, 0, reps+1)
	outs := 0
	for i := 0; i <= reps; i++ {
		t0 := time.Now()
		outs = f()
		d := time.Since(t0)
		if i == 0 {
			continue
		}
		durs = append(durs, d)
	}
	return jsonRes{name: name, d: median(durs), bytesOut: outs}
}

func handBuiltDetail(ev *EventRow, sb *strings.Builder, cache map[string]string, itoa func(int) string, f64 func(float64) string) string {
	sb.Reset()
	sb.Grow(360)
	q := func(s string) string {
		if v, ok := cache[s]; ok {
			return v
		}
		v := `"` + s + `"`
		cache[s] = v
		return v
	}
	sb.WriteString(`{"kind":`)
	sb.WriteString(q(ev.Kind))
	sb.WriteString(`,"attacker":`)
	sb.WriteString(q(ev.Attacker))
	sb.WriteString(`,"victim":`)
	sb.WriteString(q(ev.Victim))
	sb.WriteString(`,"weapon":`)
	sb.WriteString(q(ev.Weapon))
	sb.WriteString(`,"dmg":`)
	sb.WriteString(itoa(ev.Dmg))
	sb.WriteString(`,"headshot":`)
	if ev.Headshot == 1 {
		sb.WriteString("true")
	} else {
		sb.WriteString("false")
	}
	sb.WriteString(`,"tick":`)
	sb.WriteString(itoa(ev.Tick))
	sb.WriteString(`,"round":`)
	sb.WriteString(itoa(ev.Round))
	sb.WriteString(`,"pos":[`)
	sb.WriteString(f64(float64(ev.Tick%1000) / 10))
	sb.WriteByte(',')
	sb.WriteString(f64(float64(ev.Seq%700) / 7))
	sb.WriteString(`,3.5],"meta":{"armor_pen":0.77,"armor":100,"dist":`)
	sb.WriteString(f64(float64(ev.Seq%40) + 0.5))
	sb.WriteString(`},"flags":`)
	sb.WriteString(evFlagsJSON(ev, cache))
	sb.WriteByte('}')
	return sb.String()
}

func evFlagsJSON(ev *EventRow, cache map[string]string) string {
	key := "f" + strconv.Itoa(ev.Seq%12)
	if v, ok := cache[key]; ok {
		return v
	}
	var sb strings.Builder
	sb.WriteByte('[')
	if ev.Seq%3 == 0 {
		sb.WriteString(`"wall"`)
	}
	if ev.Seq%4 == 0 {
		if ev.Seq%3 == 0 {
			sb.WriteByte(',')
		}
		sb.WriteString(`"blind"`)
	}
	sb.WriteByte(']')
	cache[key] = sb.String()
	return cache[key]
}

func jsonBench(events []EventRow, reps int, jsonRows int64, singleMedian time.Duration) {
	n := len(events)
	if n == 0 {
		return
	}
	itoa := strconv.Itoa
	f64 := func(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }

	v1 := jsonRun("json.Marshal", reps, func() int {
		total := 0
		r := rand.New(rand.NewPCG(1, 2))
		for i := range events {
			d := buildDetail(&events[i], r)
			rr := buildRaw(&events[i], d)
			b, _ := json.Marshal(&d)
			c, _ := json.Marshal(&rr)
			total += len(b) + len(c)
		}
		sink += total
		return total
	})

	v2 := jsonRun("Encoder+reused buffer", reps, func() int {
		total := 0
		r := rand.New(rand.NewPCG(1, 2))
		var buf bytes.Buffer
		enc := json.NewEncoder(&buf)
		enc.SetEscapeHTML(false)
		for i := range events {
			d := buildDetail(&events[i], r)
			rr := buildRaw(&events[i], d)
			buf.Reset()
			enc.Encode(&d)
			enc.Encode(&rr)
			total += buf.Len()
		}
		sink += total
		return total
	})

	v3 := jsonRun("hand-built+shared reuse", reps, func() int {
		total := 0
		cache := map[string]string{}
		var dbs, rbs strings.Builder
		sharedHead := `{"demo":"donk.dem.zst","tick_rate":64,`
		for i := range events {
			ev := &events[i]
			detailStr := handBuiltDetail(ev, &dbs, cache, itoa, f64)
			rnd, ok := cache["round:"+itoa(ev.Round)]
			if !ok {
				var rb strings.Builder
				rb.WriteString(`{"winner":"CT","number":`)
				rb.WriteString(itoa(ev.Round))
				rb.WriteString(`,"start_tick":`)
				rb.WriteString(itoa((ev.Round - 1) * 4800))
				rb.WriteByte('}')
				rnd = rb.String()
				cache["round:"+itoa(ev.Round)] = rnd
			}
			rbs.Reset()
			rbs.Grow(len(sharedHead) + len(detailStr) + 96)
			rbs.WriteString(`{"seq":`)
			rbs.WriteString(itoa(ev.Seq))
			rbs.WriteString(`,"kind":"`)
			rbs.WriteString(ev.Kind)
			rbs.WriteString(`",`)
			rbs.WriteString(sharedHead)
			rbs.WriteString(`"round":`)
			rbs.WriteString(rnd)
			rbs.WriteString(`,"detail":`)
			rbs.WriteString(detailStr)
			rbs.WriteByte('}')
			total += len(detailStr) + rbs.Len()
		}
		sink += total
		return total
	})

	fmt.Printf("== phase F: json marshal cost (%d events, median of %d reps after warmup) ==\n", n, reps)
	baseNs := float64(v1.d.Nanoseconds()) / float64(n)
	for _, r := range []jsonRes{v1, v2, v3} {
		perEvent := float64(r.d.Nanoseconds()) / float64(n) / 1000.0
		perMatch := time.Duration(float64(jsonRows) * perEvent * 1000.0)
		pct := 0.0
		if singleMedian > 0 {
			pct = float64(perMatch) / float64(singleMedian) * 100
		}
		thisNs := float64(r.d.Nanoseconds()) / float64(n)
		fmt.Printf("  %-24s %7.2f us/event   all-%d-payload-rows/match: %-8s  %4.1f%% of single insert   json bytes=%.1f MB   %.0f%% vs json.Marshal\n",
			r.name, perEvent, jsonRows, ms(perMatch), pct, float64(r.bytesOut)/(1<<20), (1-thisNs/baseNs)*100)
	}
	saved := baseNs - float64(v3.d.Nanoseconds())/float64(n)
	fmt.Printf("  delta: hand-built saves %.2f us/event = %.1f ms per match on %d json rows; json.Marshal of one match payloads = %.1f ms\n",
		saved/1000.0, saved*float64(jsonRows)/1e6, jsonRows, baseNs*float64(jsonRows)/1e6)
}

func checkpoint(db *sql.DB) (busy, log, ckpt int64, err error) {
	err = db.QueryRow("PRAGMA wal_checkpoint(TRUNCATE)").Scan(&busy, &log, &ckpt)
	return
}

func readSmoke(db *sql.DB, matches int, kind string) (time.Duration, int64, int, error) {
	var ids []int64
	rows, err := db.Query(`SELECT id FROM matches ORDER BY id`)
	if err != nil {
		return 0, 0, 0, err
	}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, 0, 0, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, 0, 0, err
	}
	if len(ids) > matches {
		ids = ids[:matches]
	}
	q := `SELECT * FROM events WHERE match_id=? AND kind=? ORDER BY tick`
	totalRows := int64(0)
	t0 := time.Now()
	for _, id := range ids {
		rs, err := db.Query(q, id, kind)
		if err != nil {
			return 0, 0, 0, err
		}
		cols, err := rs.Columns()
		if err != nil {
			rs.Close()
			return 0, 0, 0, err
		}
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		for rs.Next() {
			if err := rs.Scan(ptrs...); err != nil {
				rs.Close()
				return 0, 0, 0, err
			}
			totalRows++
		}
		rs.Close()
		if err := rs.Err(); err != nil {
			return 0, 0, 0, err
		}
	}
	return time.Since(t0), totalRows, len(ids), nil
}

func mb(b int64) float64 {
	return float64(b) / (1 << 20)
}

func main() {
	flag.Parse()
	c := Config{
		Hurts:        *flagHurts,
		Fires:        *flagFires,
		Deaths:       *flagDeaths,
		Generic:      *flagGeneric,
		GenericTypes: *flagGenericTypes,
		Rounds:       *flagRounds,
		Players:      *flagPlayers,
		Chat:         *flagChat,
		DetailBytes:  *flagDetailBytes,
		RawBytes:     *flagRawBytes,
		PayloadBytes: *flagPayloadBytes,
		Seed:         *flagSeed,
	}
	initPool(c.Seed)

	dir, err := os.MkdirTemp("", "sqlitebench-")
	if err != nil {
		panic(err)
	}
	fmt.Println("== environment ==")
	fmt.Println("tempdir:", dir)
	fmt.Println("go:", runtime.Version(), "platform:", runtime.GOOS+"/"+runtime.GOARCH, "cpus:", runtime.NumCPU())
	fmt.Println("cpu:", cpuModel())

	m0 := genMatch(0, c)
	rowsPerMatch := countRows(m0)
	jsonRows := int64(len(m0.Events) + len(m0.Generic))
	fmt.Println("== config (per match) ==")
	fmt.Printf("events: hurt=%d fire=%d death=%d => %d | generic=%d | chat=%d | rounds=%d | players=%d\n",
		c.Hurts, c.Fires, c.Deaths, len(m0.Events), len(m0.Generic), len(m0.Chat), c.Rounds, c.Players)
	fmt.Printf("rows/match=%d  json-bearing rows=%d  detail=%dB raw=%dB generic=%dB\n",
		rowsPerMatch, jsonRows, c.DetailBytes, c.RawBytes, c.PayloadBytes)

	singlePath := filepath.Join(dir, "single.db")
	db, err := openDB(singlePath)
	if err != nil {
		panic(err)
	}
	tCreate := time.Now()
	createSchema(db)
	fmt.Println("== pragmas ==")
	fmt.Printf("journal_mode=%s foreign_keys=%s busy_timeout=%s  schema create=%s\n",
		pragmaStr(db, "journal_mode"), pragmaStr(db, "foreign_keys"), pragmaStr(db, "busy_timeout"), ms(time.Since(tCreate)))

	fmt.Println("== phase A: single match insert (one txn per match, prepared stmts per table) ==")
	var timed []time.Duration
	var singleRows int64
	for i := 0; i < *flagSingleRuns; i++ {
		mm := genMatch(i, c)
		st := time.Now()
		nr, err := insertMatchTx(db, mm)
		if err != nil {
			panic(err)
		}
		d := time.Since(st)
		singleRows = nr
		if i == 0 {
			fmt.Printf("  warmup: %s  %d rows  %s\n", ms(d), nr, rps(nr, d))
		} else {
			timed = append(timed, d)
			fmt.Printf("  run %d:   %s  %d rows  %s\n", i, ms(d), nr, rps(nr, d))
		}
	}
	if len(timed) == 0 {
		timed = append(timed, 0)
	}
	singleMedian := median(timed)
	minD := timed[0]
	for _, d := range timed {
		if d < minD {
			minD = d
		}
	}
	fmt.Printf("  MEDIAN=%s  min=%s  %s\n", ms(singleMedian), ms(minD), rps(singleRows, singleMedian))

	var naiveDur time.Duration
	if *flagNaiveRuns > 0 {
		fmt.Println("== phase B: naive (one txn per row, same prepared stmts) ==")
		ndb, err := openDB(filepath.Join(dir, "naive.db"))
		if err != nil {
			panic(err)
		}
		createSchema(ndb)
		var nd []time.Duration
		var naiveRows int64
		for i := 0; i < *flagNaiveRuns; i++ {
			mm := genMatch(1000+i, c)
			st := time.Now()
			nr, err := insertMatchNaive(ndb, mm)
			if err != nil {
				panic(err)
			}
			d := time.Since(st)
			nd = append(nd, d)
			naiveRows = nr
			fmt.Printf("  run %d: %s  %d rows  %s\n", i, ms(d), nr, rps(nr, d))
		}
		naiveDur = median(nd)
		fmt.Printf("  MEDIAN=%s  %s  batched is %.1fx faster (%s vs %s)\n",
			ms(naiveDur), rps(naiveRows, naiveDur), float64(naiveDur)/float64(singleMedian),
			ms(singleMedian), ms(naiveDur))
		ndb.Close()
	}
	db.Close()

	n := *flagMatches
	fmt.Printf("== phase C: library insert (%d matches, one txn per match) ==\n", n)
	ldb, err := openDB(filepath.Join(dir, "lib.db"))
	if err != nil {
		panic(err)
	}
	createSchema(ldb)
	var insertSum, genSum time.Duration
	var libRows int64
	var perMatchDurs []time.Duration
	wallStart := time.Now()
	for i := 0; i < n; i++ {
		g0 := time.Now()
		mm := genMatch(i, c)
		genSum += time.Since(g0)
		t0 := time.Now()
		nr, err := insertMatchTx(ldb, mm)
		if err != nil {
			panic(err)
		}
		dt := time.Since(t0)
		insertSum += dt
		perMatchDurs = append(perMatchDurs, dt)
		libRows += nr
	}
	wall := time.Since(wallStart)
	fmt.Printf("  insert total=%s  per-match avg=%s  %s\n", secs(insertSum), ms(insertSum/time.Duration(n)), rps(libRows, insertSum))
	fmt.Printf("  data generation (excluded from insert timer)=%s  wall incl generation=%s\n", secs(genSum), secs(wall))
	if n >= 20 {
		var head, tail time.Duration
		k := n / 5
		for i := 0; i < k; i++ {
			head += perMatchDurs[i]
			tail += perMatchDurs[n-k+i]
		}
		fmt.Printf("  first %d matches avg=%s   last %d matches avg=%s   (growth factor %.2fx)\n",
			k, ms(head/time.Duration(k)), k, ms(tail/time.Duration(k)), float64(tail)/float64(head))
	}

	fmt.Println("== phase D: file size (wal_checkpoint TRUNCATE) ==")
	busy, logf, ckpt, err := checkpoint(ldb)
	if err != nil {
		panic(err)
	}
	dbSize := fileSize(filepath.Join(dir, "lib.db"))
	walSize := fileSize(filepath.Join(dir, "lib.db") + "-wal")
	shmSize := fileSize(filepath.Join(dir, "lib.db") + "-shm")
	fmt.Printf("  checkpoint busy=%d log=%d checkpointed=%d\n", busy, logf, ckpt)
	fmt.Printf("  db=%.1f MB  wal=%d B  shm=%d B  => %.3f MB/match over %d matches\n",
		mb(dbSize), walSize, shmSize, mb(dbSize)/float64(n), n)

	fmt.Println("== phase E: read smoke ==")
	for _, kind := range []string{"weapon_fire", "player_death"} {
		d, rows, qn, err := readSmoke(ldb, n, kind)
		if err != nil {
			panic(err)
		}
		fmt.Printf("  SELECT * FROM events WHERE match_id=? AND kind=%q ORDER BY tick  over %d matches: total=%s avg/query=%s rows=%d\n",
			kind, qn, secs(d), ms(d/time.Duration(qn)), rows)
	}
	ldb.Close()

	eventsForJson := m0.Events
	if *flagJsonEvents > 0 && *flagJsonEvents != len(eventsForJson) {
		want := *flagJsonEvents
		expanded := make([]EventRow, want)
		for i := 0; i < want; i++ {
			expanded[i] = eventsForJson[i%len(eventsForJson)]
		}
		eventsForJson = expanded
	}
	jsonBench(eventsForJson, *flagJsonReps, jsonRows, singleMedian)

	fmt.Println("== done ==")
	fmt.Println("dbs:", dir)
}
