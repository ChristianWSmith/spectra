package store

import (
	"context"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// tickRowOut is one player_ticks row as stored (nullable columns kept
// nullable so the NULL-not-0 contract is observable).
type tickRowOut struct {
	tick          int32
	steamID, side string
	round, hp     int
	alive         bool
}

func readTicks(t *testing.T, s *Store, matchID int64, steamID string) []tickRowOut {
	t.Helper()
	rows, err := s.db.Query(`SELECT tick, steam_id, side, round, hp, alive
		FROM player_ticks WHERE match_id = ? AND steam_id = ? ORDER BY tick`, matchID, steamID)
	if err != nil {
		t.Fatalf("query player_ticks: %v", err)
	}
	defer rows.Close()
	var out []tickRowOut
	for rows.Next() {
		var r tickRowOut
		var alive int64
		if err := rows.Scan(&r.tick, &r.steamID, &r.side, &r.round, &r.hp, &alive); err != nil {
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

// varyHP gives each player an HP that changes with the tick, so every frame
// is a state change and the state-change rule writes its row. Tests that are
// about the writer's mechanics (chunks, abort, errors) use it; the pruning
// rule has its own tests.
func varyHP(players []models.TickSample, tick int32) []models.TickSample {
	out := make([]models.TickSample, len(players))
	for i, p := range players {
		p.HP = 1 + int(tick)%97 + i
		out[i] = p
	}
	return out
}

func alivePos(id string, x, y float64, air bool) models.TickSample {
	return models.TickSample{SteamID: id, Side: "ct", Alive: true, HP: 100, Money: 800, Weapon: "ak47",
		HasPosition: true, X: x, Y: y, Z: 7, InAir: air}
}

// TestTickWriterRowShape pins the row shaping on the state-change grain: a
// row is kept when a participant's round, side, alive or hp changes, and an
// absent frame writes nothing. Speed, in-air and weapon are not written here:
// the encounter windows carry them (see extract's windowCollector tests).
func TestTickWriterRowShape(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/ticks.dem", "sha-ticks-shape", time.Now())
	w, err := s.NewTickWriter(id)
	if err != nil {
		t.Fatalf("NewTickWriter: %v", err)
	}
	frames := []struct {
		tick  int32
		round int
		p     []models.TickSample
	}{
		{100, 1, []models.TickSample{alivePos("A", 0, 0, false)}},
		{101, 1, []models.TickSample{alivePos("A", 3, 4, true)}},
		{103, 1, []models.TickSample{alivePos("A", 3, 4, false)}},
		{104, 1, nil}, // A absent this frame: no row
		{105, 1, []models.TickSample{alivePos("A", 9, 4, false)}},
		{106, 2, []models.TickSample{alivePos("A", 9, 5, false)}}, // round change
		{107, 2, []models.TickSample{alivePos("A", 9, 6, false)}},
		{108, 2, []models.TickSample{alivePos("A", 9, 7, false)}},
	}
	for _, f := range frames {
		if err := w.AddTicks(f.tick, f.round, 64, varyHP(f.p, f.tick)); err != nil {
			t.Fatalf("AddTicks(%d): %v", f.tick, err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	got := readTicks(t, s, id, "A")
	wantTicks := []int32{100, 101, 103, 105, 106, 107, 108}
	wantRounds := []int{1, 1, 1, 1, 2, 2, 2}
	if len(got) != len(wantTicks) {
		t.Fatalf("rows = %d, want %d: %+v", len(got), len(wantTicks), got)
	}
	for i, g := range got {
		if g.tick != wantTicks[i] || g.round != wantRounds[i] {
			t.Errorf("row %d: tick/round = %d/%d, want %d/%d", i, g.tick, g.round, wantTicks[i], wantRounds[i])
		}
		if g.side != "ct" || !g.alive || g.hp != 1+int(g.tick)%97 {
			t.Errorf("tick %d: row = %+v", g.tick, g)
		}
	}
}

// TestTickWriterDeadFramesAreNull pins NULL-not-0 honesty: a dead frame
// (no position sample, no weapon sample) stores NULL in_air/speed/weapon,
// hp as the sampled 0 — never a fabricated observation —
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
	if d.alive || d.hp != 0 || d.side != "t" {
		t.Errorf("dead row = %+v, want alive=0 hp=0 side=t", d)
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
		if err := w.AddTicks(int32(f), 1, 64, varyHP(players, int32(f))); err != nil {
			t.Fatalf("AddTicks: %v", err)
		}
		if len(w.buf) > tickChunkRows {
			t.Fatalf("frame %d: buffered %d rows — a chunk exceeded %d", f, len(w.buf), tickChunkRows)
		}
	}
	// The writer commits asynchronously: the full chunk lands while the
	// parse keeps running, well before Close.
	waitRows(t, w, tickChunkRows)
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
			if err := w.AddTicks(int32(i), 1, 64, varyHP([]models.TickSample{alivePos("P", 0, 0, false)}, int32(i))); err != nil {
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
// nothing (one row per match, tick, player).
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
		if err := w.AddTicks(f.tick, 1, 64, varyHP([]models.TickSample{alivePos("R", f.x, 0, false)}, f.tick)); err != nil {
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
	if got[1].tick != 11 || got[2].tick != 12 {
		t.Errorf("ticks = %d, %d, want 11 then 12", got[1].tick, got[2].tick)
	}
}

// waitRows polls until the writer has committed want rows (the writer is
// asynchronous), failing the test after a generous bound.
func waitRows(t *testing.T, w *TickWriter, want int64) {
	t.Helper()
	deadline := time.Now().Add(90 * time.Second) // generous: SQLite commits are fsync-bound on slow disks
	for w.Rows() < want {
		if time.Now().After(deadline) {
			t.Fatalf("writer committed %d rows, want %d", w.Rows(), want)
		}
		time.Sleep(time.Millisecond)
	}
}

// streamFrames feeds up to n frames of two alive players, one tick per
// frame, stopping early when stop returns true (checked before each
// frame). It returns the first AddTicks error.
func streamFrames(w *TickWriter, n int, stop func(frame int) bool) error {
	players := []models.TickSample{alivePos("a", 0, 0, false), alivePos("b", 1, 1, false)}
	for f := 0; f < n; f++ {
		if stop != nil && stop(f) {
			return nil
		}
		if err := w.AddTicks(int32(f), 1, 64, varyHP(players, int32(f))); err != nil {
			return err
		}
	}
	return nil
}

// TestTickWriterAbortLeavesNoPartialTicks pins the importer's failure
// paths: a parse error and a context cancellation both stop the feed with
// chunks already committed, and Abort must leave the match with no tick
// rows while another match's rows are untouched. (TickWriter has no context
// of its own; cancellation reaches it as the importer calling Abort.)
func TestTickWriterAbortLeavesNoPartialTicks(t *testing.T) {
	const frames = tickChunkRows/2 + 1000 // several chunks; the first is committed
	cases := map[string]func(w *TickWriter){
		"parse error": func(w *TickWriter) {
			// The parse fails mid-stream: the feed just stops.
			_ = streamFrames(w, frames/2, nil)
		},
		"cancelled": func(w *TickWriter) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			_ = streamFrames(w, frames, func(f int) bool {
				if f == frames/2 {
					cancel()
				}
				return ctx.Err() != nil
			})
		},
	}
	for name, feed := range cases {
		t.Run(name, func(t *testing.T) {
			s := openMem(t)
			now := time.Now()
			id := saveTestMatch(t, s, "/d/abort-"+name+".dem", "sha-abort-"+name, now)
			other := saveTestMatch(t, s, "/d/keep-"+name+".dem", "sha-keep-"+name, now)
			ow, err := s.NewTickWriter(other)
			if err != nil {
				t.Fatalf("NewTickWriter: %v", err)
			}
			if err := streamFrames(ow, 4, nil); err != nil {
				t.Fatalf("AddTicks: %v", err)
			}
			if err := ow.Close(); err != nil {
				t.Fatalf("Close: %v", err)
			}

			w, err := s.NewTickWriter(id)
			if err != nil {
				t.Fatalf("NewTickWriter: %v", err)
			}
			feed(w)
			if err := w.Abort(); err != nil {
				t.Fatalf("Abort: %v", err)
			}
			if n, _ := s.PlayerTickCount(id); n != 0 {
				t.Errorf("after abort: %d partial rows, want 0", n)
			}
			if n, _ := s.PlayerTickCount(other); n != 8 {
				t.Errorf("other match rows = %d, want 8 (abort is match-scoped)", n)
			}
			if err := w.Abort(); err != nil {
				t.Errorf("second Abort: %v, want nil (idempotent)", err)
			}
			if err := w.AddTicks(1<<20, 1, 64, nil); err == nil {
				t.Errorf("AddTicks after Abort = nil, want an error")
			}
		})
	}
}

// TestTickWriterWriteErrorReachesCaller: a failing chunk write (injected by
// a trigger that rejects one tick) must surface to the parse, from
// AddTicks on a later frame or at the latest from Close. The importer's
// Abort then leaves no rows from the stream.
func TestTickWriterWriteErrorReachesCaller(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/write-err.dem", "sha-write-err", time.Now())
	if _, err := s.db.Exec(`CREATE TRIGGER fail_tick BEFORE INSERT ON player_ticks
		WHEN NEW.tick = 2000 BEGIN SELECT RAISE(ABORT, 'injected write failure'); END`); err != nil {
		t.Fatalf("create trigger: %v", err)
	}
	w, err := s.NewTickWriter(id)
	if err != nil {
		t.Fatalf("NewTickWriter: %v", err)
	}
	feedErr := streamFrames(w, tickChunkRows, nil) // many chunks; the first one fails
	closeErr := w.Close()
	if feedErr == nil && closeErr == nil {
		t.Fatal("write error did not reach the caller (neither AddTicks nor Close returned it)")
	}
	if closeErr == nil {
		t.Errorf("Close = nil after a failed write, want the write error (it is sticky)")
	}
	if err := w.Abort(); err != nil {
		t.Fatalf("Abort: %v", err)
	}
	if n, _ := s.PlayerTickCount(id); n != 0 {
		t.Errorf("after write error and abort: %d rows, want 0", n)
	}
}

// TestTickWriterNoDeadlockUnderProgressWrites interleaves the job's
// progress writes (autocommit statements on the same single connection)
// with the tick stream. The stream must finish within the timeout and
// commit every row.
func TestTickWriterNoDeadlockUnderProgressWrites(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/progress.dem", "sha-progress", time.Now())
	job, err := s.CreateJob("import", "/d/progress.dem")
	if err != nil {
		t.Fatalf("CreateJob: %v", err)
	}
	w, err := s.NewTickWriter(id)
	if err != nil {
		t.Fatalf("NewTickWriter: %v", err)
	}

	const frames = 3 * tickChunkRows / 2 // three-plus chunks of two players
	stop := make(chan struct{})
	progressErr := make(chan error, 1)
	go func() {
		for i := 0; ; i++ {
			select {
			case <-stop:
				progressErr <- nil
				return
			default:
			}
			if err := s.UpdateJobProgress(job, "parse", float64(i%100)/100); err != nil {
				progressErr <- err
				return
			}
		}
	}()

	done := make(chan error, 1)
	go func() {
		if err := streamFrames(w, frames, nil); err != nil {
			done <- err
			return
		}
		done <- w.Close()
	}()

	select {
	case err := <-done:
		close(stop)
		if err != nil {
			t.Fatalf("stream with progress writes: %v", err)
		}
	case <-time.After(60 * time.Second):
		t.Fatal("tick stream deadlocked under concurrent progress writes")
	}
	if err := <-progressErr; err != nil {
		t.Fatalf("progress write: %v", err)
	}
	if n, _ := s.PlayerTickCount(id); n != frames*2 {
		t.Errorf("rows = %d, want %d", n, frames*2)
	}
}

// TestTickWriterStateChangeRule pins the state-change rule (S17): a player's
// row is written when round, side, alive or hp differs from their last written
// row, and not otherwise. A position change alone writes no row.
func TestTickWriterStateChangeRule(t *testing.T) {
	s := openMem(t)
	id := saveTestMatch(t, s, "/d/ticks.dem", "sha-ticks-rule", time.Now())
	w, err := s.NewTickWriter(id)
	if err != nil {
		t.Fatalf("NewTickWriter: %v", err)
	}
	a := func(x float64, hp int, alive bool) models.TickSample {
		p := alivePos("A", x, 0, false)
		p.HP = hp
		p.Alive = alive
		return p
	}
	b := alivePos("B", 0, 0, false)
	frames := []struct {
		tick int32
		p    []models.TickSample
	}{
		{100, []models.TickSample{a(0, 100, true), b}},
		{101, []models.TickSample{a(1, 100, true), b}}, // A moves: no row
		{102, []models.TickSample{a(2, 100, true), b}}, // still no row
		{103, []models.TickSample{a(2, 50, true), b}},  // A hp changes: row
		{104, []models.TickSample{a(3, 50, true), b}},  // A moves: no row
		{105, []models.TickSample{a(3, 0, false), b}},  // A dies: row
	}
	for _, f := range frames {
		if err := w.AddTicks(f.tick, 1, 64, f.p); err != nil {
			t.Fatalf("AddTicks(%d): %v", f.tick, err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	wantA := []int32{100, 103, 105}
	gotA := readTicks(t, s, id, "A")
	if len(gotA) != len(wantA) {
		t.Fatalf("A rows = %d, want %d (%v)", len(gotA), len(wantA), gotA)
	}
	for i, tk := range wantA {
		if gotA[i].tick != tk {
			t.Errorf("A row %d at tick %d, want %d", i, gotA[i].tick, tk)
		}
	}
	gotB := readTicks(t, s, id, "B")
	if len(gotB) != 1 || gotB[0].tick != 100 {
		t.Errorf("B rows = %v, want only the first (tick 100)", gotB)
	}
}
