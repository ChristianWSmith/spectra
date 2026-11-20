package store

import (
	"database/sql"
	"math"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// tickRowOut is one player_ticks row as stored (nullable columns kept
// nullable so the NULL-not-0 contract is observable).
type tickRowOut struct {
	tick             int32
	steamID, side    string
	round, hp, money int
	alive            bool
	inAir            sql.NullInt64
	speed            sql.NullFloat64
	weapon           sql.NullString
}

func readTicks(t *testing.T, s *Store, matchID int64, steamID string) []tickRowOut {
	t.Helper()
	rows, err := s.db.Query(`SELECT tick, steam_id, side, round, hp, money, alive, in_air, speed, weapon
		FROM player_ticks WHERE match_id = ? AND steam_id = ? ORDER BY tick`, matchID, steamID)
	if err != nil {
		t.Fatalf("query player_ticks: %v", err)
	}
	defer rows.Close()
	var out []tickRowOut
	for rows.Next() {
		var r tickRowOut
		var alive int64
		if err := rows.Scan(&r.tick, &r.steamID, &r.side, &r.round, &r.hp, &r.money, &alive,
			&r.inAir, &r.speed, &r.weapon); err != nil {
			t.Fatalf("scan: %v", err)
		}
		r.alive = alive != 0
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}
	return out
}

func alivePos(id string, x, y float64, air bool) models.TickSample {
	return models.TickSample{SteamID: id, Side: "ct", Alive: true, HP: 100, Money: 800, Weapon: "ak47",
		HasPosition: true, X: x, Y: y, Z: 7, InAir: air}
}

// TestTickWriterRowsAndSpeed pins the row shaping and the speed rule:
// speed is the HORIZONTAL distance between consecutive positioned frames
// over Δtick/tickRate (z ignored), NULL on the first frame of a stretch,
// across a round change, after a gap frame and with an unknown tick rate.
func TestTickWriterRowsAndSpeed(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/ticks.dem", "sha-ticks-speed", time.Now())
	w, err := s.NewTickWriter(id)
	if err != nil {
		t.Fatalf("NewTickWriter: %v", err)
	}
	const rate = 64.0
	frames := []struct {
		tick  int32
		round int
		rate  float64
		p     []models.TickSample
	}{
		{100, 1, rate, []models.TickSample{alivePos("A", 0, 0, false)}}, // first: NULL
		{101, 1, rate, []models.TickSample{alivePos("A", 3, 4, true)}},  // 5 u in 1 tick → 320 u/s
		{103, 1, rate, []models.TickSample{alivePos("A", 3, 4, false)}}, // consecutive frame, Δtick 2, still → 0
		{104, 1, rate, nil}, // A absent this frame
		{105, 1, rate, []models.TickSample{alivePos("A", 9, 4, false)}}, // gap → NULL
		{106, 2, rate, []models.TickSample{alivePos("A", 9, 5, false)}}, // round change → NULL
		{107, 2, 0, []models.TickSample{alivePos("A", 9, 6, false)}},    // unknown tick rate → NULL
		{108, 2, rate, []models.TickSample{alivePos("A", 9, 7, false)}}, // 1 u in 1 tick → 64 u/s
	}
	for _, f := range frames {
		if err := w.AddTicks(f.tick, f.round, f.rate, f.p); err != nil {
			t.Fatalf("AddTicks(%d): %v", f.tick, err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	got := readTicks(t, s, id, "A")
	want := []struct {
		tick  int32
		round int
		speed float64 // NaN = NULL
		air   bool
	}{
		{100, 1, math.NaN(), false}, {101, 1, 320, true}, {103, 1, 0, false},
		{105, 1, math.NaN(), false}, {106, 2, math.NaN(), false}, {107, 2, math.NaN(), false},
		{108, 2, 64, false},
	}
	if len(got) != len(want) {
		t.Fatalf("rows = %d, want %d: %+v", len(got), len(want), got)
	}
	for i, w := range want {
		g := got[i]
		if g.tick != w.tick || g.round != w.round {
			t.Errorf("row %d: tick/round = %d/%d, want %d/%d", i, g.tick, g.round, w.tick, w.round)
		}
		if math.IsNaN(w.speed) {
			if g.speed.Valid {
				t.Errorf("tick %d: speed = %v, want NULL", g.tick, g.speed.Float64)
			}
		} else if !g.speed.Valid || math.Abs(g.speed.Float64-w.speed) > 1e-9 {
			t.Errorf("tick %d: speed = %+v, want %v", g.tick, g.speed, w.speed)
		}
		if !g.inAir.Valid || (g.inAir.Int64 != 0) != w.air {
			t.Errorf("tick %d: in_air = %+v, want %v", g.tick, g.inAir, w.air)
		}
		if g.side != "ct" || !g.alive || g.hp != 100 || g.money != 800 || g.weapon.String != "ak47" {
			t.Errorf("tick %d: row = %+v", g.tick, g)
		}
	}
}

// TestTickWriterDeadFramesAreNull pins NULL-not-0 honesty: a dead frame
// (no position sample, no weapon sample) stores NULL in_air/speed/weapon,
// hp as the sampled 0 and money as read — never a fabricated observation —
// and the first positioned frame after it has no previous sample (NULL
// speed), so a respawn/teleport never produces a speed.
func TestTickWriterDeadFramesAreNull(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/dead.dem", "sha-ticks-dead", time.Now())
	w, err := s.NewTickWriter(id)
	if err != nil {
		t.Fatalf("NewTickWriter: %v", err)
	}
	dead := models.TickSample{SteamID: "B", Side: "t", Alive: false, HP: 0, Money: 3150, Weapon: "ignored"}
	steps := [][]models.TickSample{
		{alivePos("B", 0, 0, false)},
		{dead},
		{alivePos("B", 500, 500, false)},
	}
	for i, p := range steps {
		if err := w.AddTicks(int32(10+i), 1, 64, p); err != nil {
			t.Fatalf("AddTicks: %v", err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	got := readTicks(t, s, id, "B")
	if len(got) != 3 {
		t.Fatalf("rows = %d, want 3", len(got))
	}
	d := got[1]
	if d.alive || d.hp != 0 || d.money != 3150 || d.side != "t" {
		t.Errorf("dead row = %+v, want alive=0 hp=0 money=3150 side=t", d)
	}
	if d.inAir.Valid || d.speed.Valid || d.weapon.Valid {
		t.Errorf("dead row in_air/speed/weapon = %+v/%+v/%+v, want NULL (never 0)", d.inAir, d.speed, d.weapon)
	}
	if got[2].speed.Valid {
		t.Errorf("first positioned frame after death: speed = %v, want NULL", got[2].speed.Float64)
	}
}

// TestTickWriterChunksTransactions pins the chunked write: rows commit in
// transactions of at most tickChunkRows — a chunk lands mid-stream,
// inside AddTicks, never deferred to Close as one huge transaction.
func TestTickWriterChunksTransactions(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/chunk.dem", "sha-ticks-chunk", time.Now())
	w, err := s.NewTickWriter(id)
	if err != nil {
		t.Fatalf("NewTickWriter: %v", err)
	}
	players := make([]models.TickSample, 10)
	for i := range players {
		players[i] = alivePos(string(rune('a'+i)), 0, 0, false)
	}
	const frames = tickChunkRows/10 + 5 // just over one chunk
	for f := 0; f < frames; f++ {
		if err := w.AddTicks(int32(f), 1, 64, players); err != nil {
			t.Fatalf("AddTicks: %v", err)
		}
		if w.Rows() > tickChunkRows || len(w.buf) > tickChunkRows {
			t.Fatalf("frame %d: committed %d / buffered %d rows — a chunk exceeded %d", f, w.Rows(), len(w.buf), tickChunkRows)
		}
	}
	if w.Rows() != tickChunkRows {
		t.Errorf("committed before Close = %d, want one full chunk of %d", w.Rows(), tickChunkRows)
	}
	n, err := s.PlayerTickCount(id)
	if err != nil {
		t.Fatalf("PlayerTickCount: %v", err)
	}
	if n != tickChunkRows {
		t.Errorf("visible rows before Close = %d, want %d", n, tickChunkRows)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if n, _ := s.PlayerTickCount(id); n != frames*10 {
		t.Errorf("rows after Close = %d, want %d", n, frames*10)
	}
}

// TestPlayerTicksLifecycle pins the streamed-table lifecycle: rows
// survive SaveExtracted (they stream in BEFORE it — a childTables entry
// would erase them), a new writer for the match wipes the previous
// parse's rows (reprocess), DeletePlayerTicks clears them (failure
// cleanup), and DeleteMatchData removes them with the match.
func TestPlayerTicksLifecycle(t *testing.T) {
	s := openMem(t)
	now := time.Now()
	id := saveTestMatch(t, s, "/d/life.dem", "sha-ticks-life", now)
	other := saveTestMatch(t, s, "/d/other.dem", "sha-ticks-other", now)

	write := func(matchID int64, n int) {
		t.Helper()
		w, err := s.NewTickWriter(matchID)
		if err != nil {
			t.Fatalf("NewTickWriter: %v", err)
		}
		for i := 0; i < n; i++ {
			if err := w.AddTicks(int32(i), 1, 64, []models.TickSample{alivePos("P", 0, 0, false)}); err != nil {
				t.Fatalf("AddTicks: %v", err)
			}
		}
		if err := w.Close(); err != nil {
			t.Fatalf("Close: %v", err)
		}
	}
	count := func(matchID int64) int {
		t.Helper()
		n, err := s.PlayerTickCount(matchID)
		if err != nil {
			t.Fatalf("PlayerTickCount: %v", err)
		}
		return n
	}

	write(id, 5)
	write(other, 2)
	if err := s.SaveExtracted(id, testExtracted("sha-ticks-life", now)); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
	if n := count(id); n != 5 {
		t.Fatalf("after SaveExtracted: %d rows, want 5 (streamed rows must survive the save)", n)
	}

	write(id, 3) // reprocess: the new writer wipes the old parse's rows first
	if n := count(id); n != 3 {
		t.Errorf("after reprocess: %d rows, want 3 (no stranded rows from the previous parse)", n)
	}

	if err := s.DeletePlayerTicks(id); err != nil {
		t.Fatalf("DeletePlayerTicks: %v", err)
	}
	if n := count(id); n != 0 {
		t.Errorf("after failure cleanup: %d rows, want 0", n)
	}

	write(id, 4)
	if err := s.DeleteMatchData(id); err != nil {
		t.Fatalf("DeleteMatchData: %v", err)
	}
	if n := count(id); n != 0 {
		t.Errorf("after DeleteMatchData: %d rows, want 0", n)
	}
	if n := count(other); n != 2 {
		t.Errorf("other match rows = %d, want 2 (deletion is match-scoped)", n)
	}
}

// TestTickWriterRepeatedTickFirstWins: a frame delivered at the same tick
// as the previous frame (the periodic full-packet frame) re-observes a
// tick already written — the first observation wins, the repeat writes
// nothing (one row per match, tick, player) and does not disturb speed.
func TestTickWriterRepeatedTickFirstWins(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/repeat.dem", "sha-ticks-repeat", time.Now())
	w, err := s.NewTickWriter(id)
	if err != nil {
		t.Fatalf("NewTickWriter: %v", err)
	}
	for _, f := range []struct {
		tick int32
		x    float64
	}{{10, 0}, {11, 1}, {11, 99}, {12, 2}} {
		if err := w.AddTicks(f.tick, 1, 64, []models.TickSample{alivePos("R", f.x, 0, false)}); err != nil {
			t.Fatalf("AddTicks(%d): %v", f.tick, err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	got := readTicks(t, s, id, "R")
	if len(got) != 3 {
		t.Fatalf("rows = %d, want 3 (the repeated tick writes once)", len(got))
	}
	for i, r := range got[1:] {
		if !r.speed.Valid || math.Abs(r.speed.Float64-64) > 1e-9 {
			t.Errorf("row %d (tick %d): speed = %+v, want 64 (the first observation of tick 11 kept)", i+1, r.tick, r.speed)
		}
	}
}
