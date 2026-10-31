package store

import (
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
)

func openMem(t *testing.T) *Store {
	t.Helper()
	s, err := Open(":memory:")
	if err != nil {
		t.Fatalf("Open(:memory:): %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func openFileStore(t *testing.T) (*Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "spectra.db")
	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open(%s): %v", path, err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s, path
}

// testExtracted builds a synthetic extract: NUL bytes in player/chat/warning
// strings, 2 players, 2 rounds (0 warmup + 1 real), 5 events, 3 generic
// events, 2 chat lines, 1 warning, teams and economies.
func testExtracted(sha string, extractedAt time.Time) *models.ExtractedMatch {
	return &models.ExtractedMatch{
		Match: models.Match{
			Path: "/demos/te\x00st.dem", SHA256: sha, Size: 1234,
			Map: "De_MiRaGe", PatchVersion: 14000, TickRate: 64,
			DurationTicks: 1000, PlaybackTimeS: 15.625, Frames: 900,
			ServerName: "sv\x00r", ClientName: "GOTV", GameDir: "csgo",
			NetProto: "13371", WarmupRounds: 1, RealRounds: 1,
			ScoreCT: 1, ScoreT: 0, HalfCT: 1, HalfT: 0,
			EntityClasses: 220, EndEntityCount: 80, ParserVersion: "v6.0.0-rc.1",
			ExtractedAt: extractedAt, ParseMS: 42, WarningsCount: 1,
		},
		Teams: []models.Team{
			{Side: "ct", Name: "alpha", Flag: "se", Score: 1, MoneySpent: 16000, EquipTotal: 25000},
			{Side: "t", Name: "beta", Flag: "de", Score: 0, MoneySpent: 14000, EquipTotal: 20000},
		},
		Players: []models.Player{
			{SteamID: "100", Name: "al\x00ice", Side: "ct", ClanTag: "cl\x00an", Rank: 4,
				RankType: 6, Wins: 10, Ping: 5, FinalAlive: true, FinalStatePresent: true},
			{SteamID: "200", Name: "bob", Side: "t", FinalStatePresent: false},
		},
		PlayerStats: []models.PlayerStats{
			{SteamID: "100", Side: "ct", Name: "al\x00ice", Kills: 10, Deaths: 0, Assists: 2,
				Headshots: 4, MVPs: 1, Score: 22, TotalDamage: 1200, DamageTaken: 400, Shots: 50,
				Hits: 20, ADR: 60, HSPct: 40, RoundsPlayed: 2, EntryKills: 1, OpeningKills: 1,
				TradeKills: 2, BestStreak: 5, ThreeK: 1, UtilityDamage: 50, FlashesPopped: 3,
				BombPlants: 1, MoneySpentTotal: 7500,
				KillsByWeapon: `{"ak47":10}`, DamageByWeapon: `{"ak47":1200}`},
			{SteamID: "200", Side: "t", Name: "bob", Kills: 5, Deaths: 2, Assists: 1,
				Headshots: 1, Score: 11, TotalDamage: 600, DamageTaken: 1100, ADR: 30,
				HSPct: 20, RoundsPlayed: 2, EntryDeaths: 1, OpeningDeaths: 1,
				KillsByWeapon: `{"awp":5}`, DamageByWeapon: `{"awp":600}`},
		},
		Rounds: []models.Round{
			{Number: 0, Warmup: true},
			{Number: 1, Winner: "ct", Reason: "CTWin", DurationS: 117.5, StartTick: 100,
				EndTick: 7620, MVP: "100", MVPReason: "kill", EquipCT: 25000, EquipT: 20000,
				FreezeEndTick: 150, FirstKillSteam: "100", FirstDeathSteam: "200"},
		},
		RoundEconomy: []models.RoundEconomy{
			{Round: 1, Side: "ct", EquipValue: 25000, MoneySampledSum: 15000, MoneySamples: 5},
			{Round: 1, Side: "t", EquipValue: 20000, MoneySampledSum: 12500, MoneySamples: 5},
		},
		Events: []models.Event{
			{Tick: 100, Round: 1, Kind: models.EventKill, Attacker: "100", Victim: "200",
				Weapon: "ak47", Headshot: true, Distance: 12.5, Dmg: 100,
				DetailJSON: `{"k":1}`, RawJSON: `{"r":1}`},
			{Tick: 99, Round: 1, Kind: models.EventDamage, Attacker: "100", Victim: "200",
				Weapon: "ak47", Dmg: 30},
			{Tick: 200, Round: 1, Kind: models.EventKill, Attacker: "200", Victim: "100",
				Weapon: "awp", Headshot: true},
			{Tick: 150, Round: 1, Kind: models.EventBombPlant, Attacker: "200", Site: "A"},
			{Tick: 300, Round: 1, Kind: models.EventRoundEnd},
		},
		GenericEvents: []models.GenericEvent{
			{Name: "player_death", Tick: 100, Round: 1, PayloadJSON: `{"a":1}`},
			{Name: "player_death", Tick: 200, Round: 1, PayloadJSON: `{"a":2}`},
			{Name: "bomb_planted", Tick: 150, Round: 1, PayloadJSON: `{"site":"A"}`},
		},
		Chat: []models.Chat{
			{Tick: 5, Round: 0, Kind: "system", Text: "Warmup started"},
			{Tick: 10, Round: 1, SteamID: "100", Name: "al\x00ice", Text: "gl\x00hf", Kind: "chat"},
		},
		Warnings: []string{"null\x00byte warning"},
	}
}

func saveTestMatch(t *testing.T, s *Store, path, sha string, at time.Time) int64 {
	t.Helper()
	id, err := s.CreateMatchRow(path, sha, 1234)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	if err := s.SaveExtracted(id, testExtracted(sha, at)); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	return id
}

func TestOpenMigrationsIdempotent(t *testing.T) {
	s, path := openFileStore(t)
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	s2, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer func() { _ = s2.Close() }()

	var n int
	if err := s2.db.QueryRow(`SELECT COUNT(*) FROM schema_version`).Scan(&n); err != nil {
		t.Fatalf("schema_version: %v", err)
	}
	if n != 1 {
		t.Fatalf("schema_version rows = %d, want 1", n)
	}
	for _, table := range []string{"matches", "teams", "players", "player_stats", "rounds",
		"round_economy", "events", "generic_events", "chat", "warnings", "jobs"} {
		var name string
		if err := s2.db.QueryRow(
			`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, table,
		).Scan(&name); err != nil {
			t.Errorf("table %s missing: %v", table, err)
		}
	}
}

func TestSaveExtractedRoundtrip(t *testing.T) {
	s := openMem(t)
	const sha = "sha-roundtrip"
	id, err := s.CreateMatchRow("/demos/te\x00st.dem", sha, 1234)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}

	m, err := s.GetMatch(id)
	if err != nil {
		t.Fatalf("GetMatch before save: %v", err)
	}
	if m.Status != models.StatusQueued {
		t.Errorf("status before save = %q, want queued", m.Status)
	}

	gotSHA, ok, err := s.GetMatchBySHA(sha)
	if err != nil || !ok || gotSHA != id {
		t.Fatalf("GetMatchBySHA(%q) = %d,%v,%v want %d,true,nil", sha, gotSHA, ok, err, id)
	}
	if _, ok, err := s.GetMatchBySHA("nope"); err != nil || ok {
		t.Fatalf("GetMatchBySHA(nope) ok=%v err=%v, want false,nil", ok, err)
	}

	at := time.Now().Truncate(time.Microsecond)
	if err := s.SaveExtracted(id, testExtracted(sha, at)); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}

	m, err = s.GetMatch(id)
	if err != nil {
		t.Fatalf("GetMatch: %v", err)
	}
	if m.Path != "/demos/test.dem" {
		t.Errorf("Path = %q, want NUL-scrubbed /demos/test.dem", m.Path)
	}
	if m.ServerName != "svr" {
		t.Errorf("ServerName = %q, want svr (NUL-scrubbed)", m.ServerName)
	}
	if m.Map != "De_MiRaGe" || m.SHA256 != sha || m.Size != 1234 || m.PatchVersion != 14000 ||
		m.TickRate != 64 || m.DurationTicks != 1000 || m.PlaybackTimeS != 15.625 || m.Frames != 900 ||
		m.ClientName != "GOTV" || m.GameDir != "csgo" || m.NetProto != "13371" || m.IsPOV ||
		m.WarmupRounds != 1 || m.RealRounds != 1 || m.ScoreCT != 1 || m.ScoreT != 0 ||
		m.HalfCT != 1 || m.HalfT != 0 || m.SideSwitches != 0 || m.EntityClasses != 220 ||
		m.EndEntityCount != 80 || m.ParserVersion != "v6.0.0-rc.1" || m.ParseMS != 42 ||
		m.WarningsCount != 1 || m.Status != models.StatusReady || m.Error != "" {
		t.Errorf("GetMatch mismatch: %+v", m)
	}
	if !m.ExtractedAt.Equal(at) {
		t.Errorf("ExtractedAt = %v, want %v", m.ExtractedAt, at)
	}

	sums, err := s.ListMatches("", "", false)
	if err != nil {
		t.Fatalf("ListMatches: %v", err)
	}
	if len(sums) != 1 {
		t.Fatalf("ListMatches len = %d, want 1", len(sums))
	}
	sum := sums[0]
	if sum.ID != id || sum.Map != "De_MiRaGe" || sum.CTName != "alpha" || sum.TName != "beta" ||
		sum.ScoreCT != 1 || sum.ScoreT != 0 || sum.RealRounds != 1 || sum.DurationS != 15.625 ||
		sum.Size != 1234 || sum.SHA256 != sha || sum.Status != models.StatusReady {
		t.Errorf("MatchSummary mismatch: %+v", sum)
	}

	board, err := s.GetScoreboard(id, "", false)
	if err != nil {
		t.Fatalf("GetScoreboard: %v", err)
	}
	if len(board) != 2 {
		t.Fatalf("GetScoreboard len = %d, want 2", len(board))
	}
	alice, bob := board[0], board[1]
	if alice.SteamID != "100" || alice.Name != "alice" || alice.Side != "ct" || alice.IsBot {
		t.Errorf("alice row mismatch: %+v", alice)
	}
	if alice.Kills != 10 || alice.Deaths != 0 || alice.Assists != 2 || alice.KD != 10 || alice.KDA != 12 {
		t.Errorf("alice stats mismatch: %+v", alice)
	}
	if alice.HSPct != 40 || alice.ADR != 60 || alice.MoneySpent != 7500 ||
		alice.KillsByWeapon != `{"ak47":10}` || alice.DamageByWeapon != `{"ak47":1200}` {
		t.Errorf("alice detail mismatch: %+v", alice)
	}
	if bob.SteamID != "200" || bob.Name != "bob" || bob.Side != "t" || bob.KD != 2.5 || bob.KDA != 3 {
		t.Errorf("bob row mismatch: %+v", bob)
	}

	rounds, err := s.GetRounds(id)
	if err != nil {
		t.Fatalf("GetRounds: %v", err)
	}
	if len(rounds) != 2 {
		t.Fatalf("GetRounds len = %d, want 2", len(rounds))
	}
	if rounds[0].Number != 0 || !rounds[0].Warmup || rounds[0].MVPName != "" {
		t.Errorf("warmup round mismatch: %+v", rounds[0])
	}
	r1 := rounds[1]
	if r1.Number != 1 || r1.Winner != "ct" || r1.Reason != "CTWin" || r1.DurationS != 117.5 ||
		r1.MVP != "100" || r1.MVPName != "alice" || r1.MVPReason != "kill" ||
		r1.FirstKillSteam != "100" || r1.FirstKillName != "alice" ||
		r1.FirstDeathSteam != "200" || r1.FirstDeathName != "bob" || r1.Kills != 2 ||
		r1.BombSite != "" || r1.EquipCT != 25000 || r1.EquipT != 20000 {
		t.Errorf("round 1 mismatch: %+v", r1)
	}

	detail, err := s.GetRoundDetail(id, 1)
	if err != nil {
		t.Fatalf("GetRoundDetail: %v", err)
	}
	if detail.Round.Number != 1 {
		t.Errorf("detail round = %+v", detail.Round)
	}
	if len(detail.Economy) != 2 || detail.Economy[0].Side != "ct" || detail.Economy[0].EquipValue != 25000 ||
		detail.Economy[0].MatchID != id || detail.Economy[0].Round != 1 {
		t.Errorf("detail economy mismatch: %+v", detail.Economy)
	}
	if len(detail.Events) != 5 {
		t.Fatalf("detail events len = %d, want 5", len(detail.Events))
	}
	e0 := detail.Events[0]
	if e0.Seq != 0 || e0.Kind != models.EventKill || e0.Attacker != "100" || e0.AttackerName != "alice" ||
		e0.Victim != "200" || e0.VictimName != "bob" || e0.Weapon != "ak47" || !e0.Headshot ||
		e0.Distance != 12.5 || e0.Dmg != 100 || e0.ID == 0 {
		t.Errorf("first event mismatch: %+v", e0)
	}
	if len(detail.Chat) != 1 || detail.Chat[0].Text != "glhf" || detail.Chat[0].Name != "alice" ||
		detail.Chat[0].Kind != "chat" {
		t.Errorf("detail chat mismatch: %+v", detail.Chat)
	}

	warmup, err := s.GetRoundDetail(id, 0)
	if err != nil {
		t.Fatalf("GetRoundDetail(0): %v", err)
	}
	if len(warmup.Events) != 0 || len(warmup.Economy) != 0 || len(warmup.Chat) != 1 {
		t.Errorf("warmup detail mismatch: %+v", warmup)
	}
	if _, err := s.GetRoundDetail(id, 99); !errors.Is(err, ErrNotFound) {
		t.Errorf("GetRoundDetail(99) err = %v, want ErrNotFound", err)
	}

	all, err := s.GetEvents(models.EventFilter{MatchID: id, Round: -1})
	if err != nil {
		t.Fatalf("GetEvents: %v", err)
	}
	if len(all) != 5 {
		t.Fatalf("GetEvents len = %d, want 5", len(all))
	}
	det, err := s.GetEvent(all[0].ID)
	if err != nil {
		t.Fatalf("GetEvent: %v", err)
	}
	if det.DetailJSON != `{"k":1}` || det.RawJSON != `{"r":1}` || det.Seq != 0 {
		t.Errorf("GetEvent mismatch: %+v", det)
	}
	if _, err := s.GetEvent(999999); !errors.Is(err, ErrNotFound) {
		t.Errorf("GetEvent(999999) err = %v, want ErrNotFound", err)
	}

	chat, err := s.GetChat(id, -1)
	if err != nil {
		t.Fatalf("GetChat: %v", err)
	}
	if len(chat) != 2 || chat[0].Tick != 5 || chat[1].Tick != 10 {
		t.Errorf("GetChat mismatch: %+v", chat)
	}

	hist, err := s.GetGenericHistogram(id)
	if err != nil {
		t.Fatalf("GetGenericHistogram: %v", err)
	}
	if len(hist) != 2 || hist[0] != (models.NameCount{Name: "player_death", Count: 2}) ||
		hist[1] != (models.NameCount{Name: "bomb_planted", Count: 1}) {
		t.Errorf("histogram mismatch: %+v", hist)
	}

	warns, err := s.GetWarnings(id)
	if err != nil {
		t.Fatalf("GetWarnings: %v", err)
	}
	if len(warns) != 1 || warns[0] != "nullbyte warning" {
		t.Errorf("warnings = %v, want [nullbyte warning]", warns)
	}
}

func TestSaveExtractedReplaces(t *testing.T) {
	s := openMem(t)
	const sha = "sha-replace"
	id, err := s.CreateMatchRow("/d/a.dem", sha, 1)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	em := testExtracted(sha, time.Now())
	if err := s.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted #1: %v", err)
	}
	em.Match.ScoreCT = 13
	if err := s.SaveExtracted(id, em); err != nil {
		t.Fatalf("SaveExtracted #2: %v", err)
	}

	checks := []struct {
		name string
		n    int
	}{
		{"board", len(mustBoard(t, s, id))},
		{"rounds", len(mustRounds(t, s, id))},
		{"events", len(mustEvents(t, s, models.EventFilter{MatchID: id, Round: -1}))},
		{"chat", len(mustChat(t, s, id, -1))},
		{"warnings", len(mustWarnings(t, s, id))},
		{"histogram", len(mustHist(t, s, id))},
	}
	want := map[string]int{"board": 2, "rounds": 2, "events": 5, "chat": 2, "warnings": 1, "histogram": 2}
	for _, c := range checks {
		if c.n != want[c.name] {
			t.Errorf("%s count = %d, want %d (no duplicates)", c.name, c.n, want[c.name])
		}
	}
	m, err := s.GetMatch(id)
	if err != nil {
		t.Fatalf("GetMatch: %v", err)
	}
	if m.ScoreCT != 13 || m.Status != models.StatusReady {
		t.Errorf("header not updated on replace: %+v", m)
	}
}

func TestListMatches(t *testing.T) {
	s := openMem(t)
	base := time.Now().Truncate(time.Second)
	id1 := saveTestMatch(t, s, "/d/a.dem", "sha1", base)
	id2 := saveTestMatch(t, s, "/d/b.dem", "sha2", base.Add(time.Hour))

	// Retarget match 2's map + teams for the LIKE checks.
	em := testExtracted("sha2", base.Add(time.Hour))
	em.Match.Map = "de_cache"
	em.Teams = []models.Team{
		{Side: "ct", Name: "gamma", Flag: "pl"},
		{Side: "t", Name: "delta", Flag: "dk"},
	}
	if err := s.SaveExtracted(id2, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}

	listed, err := s.ListMatches("", "", false)
	if err != nil {
		t.Fatalf("ListMatches: %v", err)
	}
	if len(listed) != 2 || listed[0].ID != id1 || listed[1].ID != id2 {
		t.Fatalf("default asc order = %+v, want [%d %d]", listed, id1, id2)
	}
	desc, err := s.ListMatches("", "extracted_at", true)
	if err != nil {
		t.Fatalf("ListMatches desc: %v", err)
	}
	if len(desc) != 2 || desc[0].ID != id2 || desc[1].ID != id1 {
		t.Errorf("desc order = %+v, want [%d %d]", desc, id2, id1)
	}

	cases := []struct {
		query string
		want  []int64
	}{
		{"", []int64{id1, id2}},
		{"de_", []int64{id1, id2}}, // case-insensitive across both maps
		{"alph", []int64{id1}},
		{"GAMMA", []int64{id2}}, // case-insensitive team name
		{"/d/b.dem", []int64{id2}},
		{"nothing", nil},
	}
	for _, c := range cases {
		got, err := s.ListMatches(c.query, "", false)
		if err != nil {
			t.Fatalf("ListMatches(%q): %v", c.query, err)
		}
		var ids []int64
		for _, g := range got {
			ids = append(ids, g.ID)
		}
		if len(ids) != len(c.want) {
			t.Errorf("ListMatches(%q) ids = %v, want %v", c.query, ids, c.want)
			continue
		}
		for i := range ids {
			if ids[i] != c.want[i] {
				t.Errorf("ListMatches(%q) ids = %v, want %v", c.query, ids, c.want)
				break
			}
		}
	}

	// Bogus sort key falls back to extracted_at ascending.
	bogus, err := s.ListMatches("", "status; DROP TABLE matches", false)
	if err != nil {
		t.Fatalf("ListMatches bogus: %v", err)
	}
	if len(bogus) != 2 || bogus[0].ID != id1 || bogus[1].ID != id2 {
		t.Errorf("bogus sortKey order = %+v, want [%d %d]", bogus, id1, id2)
	}
}

func TestGetScoreboardSorting(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/a.dem", "sha-sort", time.Now())

	// Default: kills DESC → alice (10), bob (5).
	board, err := s.GetScoreboard(id, "", false)
	if err != nil {
		t.Fatalf("GetScoreboard: %v", err)
	}
	if len(board) != 2 || board[0].SteamID != "100" || board[1].SteamID != "200" {
		t.Fatalf("default order mismatch: %+v", board)
	}

	// kills ASC → bob first.
	board, err = s.GetScoreboard(id, "kills", false)
	if err != nil {
		t.Fatalf("GetScoreboard kills asc: %v", err)
	}
	if board[0].SteamID != "200" || board[1].SteamID != "100" {
		t.Errorf("kills asc order = %+v", board)
	}

	// deaths DESC → bob (2) first.
	board, err = s.GetScoreboard(id, "deaths", true)
	if err != nil {
		t.Fatalf("GetScoreboard deaths desc: %v", err)
	}
	if board[0].SteamID != "200" || board[1].SteamID != "100" {
		t.Errorf("deaths desc order = %+v", board)
	}

	// name DESC → bob first.
	board, err = s.GetScoreboard(id, "name", true)
	if err != nil {
		t.Fatalf("GetScoreboard name desc: %v", err)
	}
	if board[0].Name != "bob" || board[1].Name != "alice" {
		t.Errorf("name desc order = %+v", board)
	}

	// Bogus key falls back to default kills DESC.
	board, err = s.GetScoreboard(id, "kd; DROP TABLE players", false)
	if err != nil {
		t.Fatalf("GetScoreboard bogus: %v", err)
	}
	if board[0].SteamID != "100" || board[1].SteamID != "200" {
		t.Errorf("bogus key order = %+v", board)
	}
}

func TestGetEventsFilters(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/a.dem", "sha-events", time.Now())

	get := func(f models.EventFilter) []models.EventRow {
		t.Helper()
		f.MatchID = id
		rows, err := s.GetEvents(f)
		if err != nil {
			t.Fatalf("GetEvents(%+v): %v", f, err)
		}
		return rows
	}

	if got := get(models.EventFilter{Kind: models.EventKill, Round: -1}); len(got) != 2 ||
		got[0].Seq != 0 || got[1].Seq != 2 {
		t.Errorf("kind=kill → %+v", got)
	}
	if got := get(models.EventFilter{Round: 0}); len(got) != 0 {
		t.Errorf("round=0 → %+v", got)
	}
	if got := get(models.EventFilter{Round: 1}); len(got) != 5 {
		t.Errorf("round=1 len = %d, want 5", len(got))
	}
	// SteamID matches attacker OR victim: 200 is victim of seq 0,1 and
	// attacker of seq 2,3; 100 is attacker of 0,1 and victim of 2.
	if got := get(models.EventFilter{SteamID: "200", Round: -1}); len(got) != 4 {
		t.Errorf("steam=200 len = %d, want 4 (%+v)", len(got), got)
	}
	if got := get(models.EventFilter{SteamID: "100", Round: -1}); len(got) != 3 {
		t.Errorf("steam=100 len = %d, want 3", len(got))
	}
	if got := get(models.EventFilter{Limit: 2, Round: -1}); len(got) != 2 || got[0].Seq != 0 || got[1].Seq != 1 {
		t.Errorf("limit=2 → %+v", got)
	}
	if got := get(models.EventFilter{Round: -1}); len(got) != 5 {
		t.Errorf("zero limit → len %d, want 5 (hard cap path)", len(got))
	}
	if got := get(models.EventFilter{Kind: models.EventKill, Round: 1, SteamID: "100"}); len(got) != 2 ||
		got[0].Seq != 0 || got[1].Seq != 2 {
		t.Errorf("combined filter → %+v", got)
	}
}

func TestJobsLifecycle(t *testing.T) {
	s := openMem(t)

	j1, err := s.CreateJob("import", "/p\x00ath/a.dem")
	if err != nil {
		t.Fatalf("CreateJob: %v", err)
	}
	jobs, err := s.ListJobs()
	if err != nil {
		t.Fatalf("ListJobs: %v", err)
	}
	if len(jobs) != 1 {
		t.Fatalf("ListJobs len = %d, want 1", len(jobs))
	}
	j := jobs[0]
	if j.ID != j1 || j.Kind != "import" || j.Path != "/path/a.dem" ||
		j.Status != models.JobQueued || j.Stage != models.StageQueued || j.Progress != 0 ||
		j.Error != "" || j.StartedAt != nil || j.FinishedAt != nil || j.MatchID != 0 || j.CreatedAt.IsZero() {
		t.Errorf("fresh job mismatch: %+v", j)
	}

	if err := s.SetJobMatch(j1, 7); err != nil {
		t.Fatalf("SetJobMatch: %v", err)
	}
	if err := s.UpdateJob(j1, models.JobRunning, models.StageParse, 0.5, ""); err != nil {
		t.Fatalf("UpdateJob running: %v", err)
	}
	jobs, err = s.ListJobs()
	if err != nil {
		t.Fatalf("ListJobs: %v", err)
	}
	j = jobs[0]
	if j.Status != models.JobRunning || j.Stage != models.StageParse || j.Progress != 0.5 ||
		j.MatchID != 7 || j.StartedAt == nil || j.FinishedAt != nil {
		t.Errorf("running job mismatch: %+v", j)
	}

	if err := s.UpdateJob(j1, models.JobDone, models.StageDone, 1, ""); err != nil {
		t.Fatalf("UpdateJob done: %v", err)
	}
	jobs, _ = s.ListJobs()
	if jobs[0].Status != models.JobDone || jobs[0].FinishedAt == nil {
		t.Errorf("done job mismatch: %+v", jobs[0])
	}

	if err := s.UpdateJob(999999, models.JobRunning, models.StageParse, 0, ""); !errors.Is(err, ErrNotFound) {
		t.Errorf("UpdateJob(999999) err = %v, want ErrNotFound", err)
	}

	j2, err := s.CreateJob("reprocess", "/b.dem")
	if err != nil {
		t.Fatalf("CreateJob #2: %v", err)
	}
	if err := s.CancelJob(j2); err != nil {
		t.Fatalf("CancelJob: %v", err)
	}
	if err := s.CancelJob(999999); !errors.Is(err, ErrNotFound) {
		t.Errorf("CancelJob(999999) err = %v, want ErrNotFound", err)
	}
	jobs, err = s.ListJobs()
	if err != nil {
		t.Fatalf("ListJobs: %v", err)
	}
	// created_at DESC, id DESC → j2 first.
	if len(jobs) != 2 || jobs[0].ID != j2 || jobs[1].ID != j1 {
		t.Fatalf("job order = %+v", jobs)
	}
	if jobs[0].Status != models.JobCancelled || jobs[0].FinishedAt == nil {
		t.Errorf("cancelled job mismatch: %+v", jobs[0])
	}
}

func TestOpenMarksStaleJobsInterrupted(t *testing.T) {
	s, path := openFileStore(t)

	done, err := s.CreateJob("import", "/done.dem")
	if err != nil {
		t.Fatalf("CreateJob: %v", err)
	}
	if err := s.UpdateJob(done, models.JobRunning, models.StageParse, 0.1, ""); err != nil {
		t.Fatalf("UpdateJob running: %v", err)
	}
	if err := s.UpdateJob(done, models.JobDone, models.StageDone, 1, ""); err != nil {
		t.Fatalf("UpdateJob done: %v", err)
	}
	stale, err := s.CreateJob("import", "/stale.dem")
	if err != nil {
		t.Fatalf("CreateJob #2: %v", err)
	}
	if err := s.UpdateJob(stale, models.JobRunning, models.StageParse, 0.4, ""); err != nil {
		t.Fatalf("UpdateJob running #2: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	s2, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer func() { _ = s2.Close() }()
	jobs, err := s2.ListJobs()
	if err != nil {
		t.Fatalf("ListJobs: %v", err)
	}
	if len(jobs) != 2 {
		t.Fatalf("ListJobs len = %d, want 2", len(jobs))
	}
	byID := map[int64]models.Job{}
	for _, j := range jobs {
		byID[j.ID] = j
	}
	if j := byID[stale]; j.Status != models.JobFailed || j.Error != interruptedJobErr || j.FinishedAt == nil {
		t.Errorf("stale job = %+v, want failed/%q", j, interruptedJobErr)
	}
	if j := byID[done]; j.Status != models.JobDone {
		t.Errorf("done job changed on reopen: %+v", j)
	}
}

func TestSetMatchStatus(t *testing.T) {
	s := openMem(t)
	id, err := s.CreateMatchRow("/d/a.dem", "sha-status", 1)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	if err := s.SetMatchStatus(id, models.StatusParsing, ""); err != nil {
		t.Fatalf("SetMatchStatus: %v", err)
	}
	m, err := s.GetMatch(id)
	if err != nil {
		t.Fatalf("GetMatch: %v", err)
	}
	if m.Status != models.StatusParsing {
		t.Errorf("status = %q, want parsing", m.Status)
	}
	if err := s.SetMatchStatus(id, models.StatusFailed, "bad\x00input"); err != nil {
		t.Fatalf("SetMatchStatus failed: %v", err)
	}
	m, _ = s.GetMatch(id)
	if m.Error != "badinput" {
		t.Errorf("error = %q, want NUL-scrubbed badinput", m.Error)
	}
	if err := s.SetMatchStatus(999999, models.StatusReady, ""); !errors.Is(err, ErrNotFound) {
		t.Errorf("SetMatchStatus(999999) err = %v, want ErrNotFound", err)
	}
}

func TestDeleteMatchData(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/a.dem", "sha-del", time.Now())

	if err := s.DeleteMatchData(id); err != nil {
		t.Fatalf("DeleteMatchData: %v", err)
	}
	if _, err := s.GetMatch(id); !errors.Is(err, ErrNotFound) {
		t.Errorf("GetMatch after delete err = %v, want ErrNotFound", err)
	}
	if sums, err := s.ListMatches("", "", false); err != nil || len(sums) != 0 {
		t.Errorf("ListMatches after delete = %v, %v; want empty", sums, err)
	}
	if err := s.DeleteMatchData(id); !errors.Is(err, ErrNotFound) {
		t.Errorf("second DeleteMatchData err = %v, want ErrNotFound", err)
	}
}

func mustBoard(t *testing.T, s *Store, id int64) []models.PlayerStatsRow {
	t.Helper()
	b, err := s.GetScoreboard(id, "", false)
	if err != nil {
		t.Fatalf("GetScoreboard: %v", err)
	}
	return b
}

func mustRounds(t *testing.T, s *Store, id int64) []models.RoundRow {
	t.Helper()
	r, err := s.GetRounds(id)
	if err != nil {
		t.Fatalf("GetRounds: %v", err)
	}
	return r
}

func mustEvents(t *testing.T, s *Store, f models.EventFilter) []models.EventRow {
	t.Helper()
	e, err := s.GetEvents(f)
	if err != nil {
		t.Fatalf("GetEvents: %v", err)
	}
	return e
}

func mustChat(t *testing.T, s *Store, id int64, round int) []models.ChatRow {
	t.Helper()
	c, err := s.GetChat(id, round)
	if err != nil {
		t.Fatalf("GetChat: %v", err)
	}
	return c
}

func mustWarnings(t *testing.T, s *Store, id int64) []string {
	t.Helper()
	w, err := s.GetWarnings(id)
	if err != nil {
		t.Fatalf("GetWarnings: %v", err)
	}
	return w
}

func mustHist(t *testing.T, s *Store, id int64) []models.NameCount {
	t.Helper()
	h, err := s.GetGenericHistogram(id)
	if err != nil {
		t.Fatalf("GetGenericHistogram: %v", err)
	}
	return h
}
