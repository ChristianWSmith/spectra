package store

import (
	"database/sql"
	"errors"
	"fmt"
	"math"
	"sync"
	"sync/atomic"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// playerTicksCols is the player_ticks row WITHOUT match_id — the
// TickWriter's INSERT list, pinned to the DDL by
// TestColumnListConstsMatchSchema.
const playerTicksCols = `tick, steam_id, round, side, alive, hp, in_air, speed, weapon`

// tickChunkRows bounds one player_ticks write transaction. A golden-sized
// match streams ~1.3M rows; written in one transaction that holds the
// single writer for well over busy_timeout (5 s), starving every other
// writer (job progress, other jobs' SaveExtracted, sweeps). At this
// bound one chunk holds the writer for under a second.
const tickChunkRows = 50_000

// tickQueueDepth bounds the full chunks queued ahead of the writer
// goroutine. With the chunk being written and the chunk being filled, the
// writer's memory is at most tickQueueDepth+2 chunks; when the queue is
// full the parse thread waits (backpressure), it never buffers unboundedly.
const tickQueueDepth = 2

// errTickWriterClosed is returned by AddTicks / Close after Abort (or a
// second Close after Abort): the stream is over.
var errTickWriterClosed = errors.New("tick writer is closed")

// streamedChildTables are the per-match tables written DURING the parse
// (not by SaveExtracted), so they cannot ride childTables: SaveExtracted's
// delete-first loop runs after the parse and would erase the rows that
// just streamed in. Their reprocess wipe happens when the writer is
// created (NewTickWriter) and their failure cleanup through
// DeletePlayerTicks; DeleteMatchData clears them with the childTables.
var streamedChildTables = []string{"player_ticks"}

// tickState is the retained state of one player at their last written row.
// A row is written only when round, side, alive or hp differs from it (S17
// state-change rule, owner ruling: HP is retained). Frames that repeat the
// state are not written; no reader treats a missing row as "no change"
// (see the S10 roster rule for the alive-count and clutch consumers).
type tickState struct {
	round int
	side  string
	alive bool
	hp    int
}

// tickPrev is the last positioned frame the writer saw for one player —
// the only state speed derivation needs.
type tickPrev struct {
	tick  int32
	round int
	x, y  float64
}

// TickWriter streams one match's player_ticks rows during the parse; it
// implements extract.TickSink. Rows are buffered on the parse thread and
// handed in chunks of at most tickChunkRows rows to a single writer
// goroutine, which commits each chunk in its own short transaction. No
// transaction is ever held across frames on the parse thread, and the
// parse thread never holds a transaction while it waits on the writer, so
// the single-connection pool cannot deadlock: the writer's transaction
// only waits on the database, and the job's progress writes (autocommit,
// one statement each) simply queue behind it. Memory is bounded by the
// chunk queue (see tickQueueDepth) plus one previous-position entry per
// player.
//
// Threading: AddTicks, Close and Abort must all be called from ONE
// goroutine (the parse thread's owner). The writer goroutine is the only
// other goroutine that touches the database for this stream. A write error
// is sticky: it is returned from the next AddTicks (aborting the parse) and
// from Close, so the importer's failure path sees it.
//
// speed is derived here, from consecutive positioned frames of the same
// player: the horizontal (x/y) distance divided by the elapsed time
// (Δtick / tickRate), in world units per second. It is NULL — never a
// guessed 0 — when the frame has no position, when the player had no
// positioned sample on the immediately preceding delivered frame (first
// appearance, a dead/absent gap), across a round change, when Δtick <= 0,
// or when the tick rate is unknown (<= 0).
type TickWriter struct {
	s        *Store
	matchID  int64
	buf      []tickRow
	prev     map[string]tickPrev
	last     map[string]tickState
	lastTick int32
	haveLast bool
	rows     atomic.Int64 // committed rows, written by the writer goroutine

	queue   chan []tickRow // full chunks: parse thread -> writer
	recycle chan []tickRow // emptied chunks: writer -> parse thread
	stop    chan struct{}  // closed by Abort: the writer stops writing
	done    chan struct{}  // closed when the writer goroutine has exited

	errMu sync.Mutex
	err   error // first write error (sticky)

	finished bool // Close or Abort has run (parse-thread state)
}

// tickRow is one buffered player_ticks row (match_id is the writer's).
type tickRow struct {
	tick    int32
	steamID string
	round   int
	side    string
	alive   bool
	hp      int
	inAir   sql.NullBool
	speed   sql.NullFloat64
	weapon  sql.NullString
}

// NewTickWriter opens the tick stream for one match, first deleting any
// rows a previous parse of the match left (the reprocess wipe — the
// sidecar's truncate-at-create twin). It starts the writer goroutine: every
// stream must be ended with Close (success) or Abort (failure, which also
// deletes the match's rows; safe after Close). Without one of them the
// writer goroutine is left running.
func (s *Store) NewTickWriter(matchID int64) (*TickWriter, error) {
	if err := s.DeletePlayerTicks(matchID); err != nil {
		return nil, err
	}
	w := &TickWriter{
		s:       s,
		matchID: matchID,
		buf:     make([]tickRow, 0, 1024),
		prev:    make(map[string]tickPrev, 16),
		last:    make(map[string]tickState, 16),
		queue:   make(chan []tickRow, tickQueueDepth),
		recycle: make(chan []tickRow, tickQueueDepth+1),
		stop:    make(chan struct{}),
		done:    make(chan struct{}),
	}
	go w.run()
	return w, nil
}

// DeletePlayerTicks removes one match's player_ticks rows — the reprocess
// wipe and every import failure path's cleanup of a half-written stream.
func (s *Store) DeletePlayerTicks(matchID int64) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("clearing the match's tick data: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`DELETE FROM player_ticks WHERE match_id = ?`, matchID); err != nil {
		return fmt.Errorf("clearing the match's tick data: %w", err)
	}
	if err := markTableWriteBehind(tx, matchID, "player_ticks"); err != nil {
		return fmt.Errorf("clearing the match's tick data: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("clearing the match's tick data: %w", err)
	}
	return nil
}

// PlayerTickCount reports how many player_ticks rows one match holds —
// the lifecycle probe (reprocess wipe, failure cleanup, deletion).
func (s *Store) PlayerTickCount(matchID int64) (int, error) {
	var n int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM player_ticks WHERE match_id = ?`, matchID).Scan(&n); err != nil {
		return 0, fmt.Errorf("counting the match's tick data: %w", err)
	}
	return n, nil
}

// AddTicks buffers one frame's rows (see extract.TickSink) and flushes a
// full chunk before the buffer would exceed tickChunkRows.
func (w *TickWriter) AddTicks(tick int32, round int, tickRate float64, players []models.TickSample) error {
	if w.finished {
		return errTickWriterClosed
	}
	// A write error from the writer goroutine aborts the parse here, on the
	// next frame, rather than letting the parse run to its end.
	if err := w.writeErr(); err != nil {
		return err
	}
	// A frame at the SAME tick as the previous delivered frame re-observes
	// a game tick already written (the golden demo carries one such frame
	// every 3840 ticks — the periodic full-packet frame). The table's
	// grain is one row per (match, tick, player): the first observation
	// of a tick wins, the repeat is dropped.
	if w.haveLast && tick == w.lastTick {
		return nil
	}
	if len(w.buf) > 0 && len(w.buf)+len(players) > tickChunkRows {
		w.hand()
	}
	for _, p := range players {
		row := tickRow{
			tick:    tick,
			steamID: scrub(p.SteamID),
			round:   round,
			side:    scrub(p.Side),
			alive:   p.Alive,
			hp:      p.HP,
		}
		if p.Alive {
			row.weapon = sql.NullString{String: scrub(p.Weapon), Valid: true}
		}
		// Speed is derived from every positioned frame, before the pruning
		// decision: a pruned frame still advances the previous position.
		state := tickState{round: round, side: row.side, alive: p.Alive, hp: p.HP}
		prevState, seen := w.last[p.SteamID]
		changed := !seen || prevState != state
		if p.HasPosition {
			row.inAir = sql.NullBool{Bool: p.InAir, Valid: true}
			if prev, ok := w.prev[p.SteamID]; ok && w.haveLast && prev.tick == w.lastTick {
				if v, ok := tickSpeed(prev, tick, round, p.X, p.Y, tickRate); ok {
					row.speed = sql.NullFloat64{Float64: v, Valid: true}
				}
			}
			w.prev[p.SteamID] = tickPrev{tick: tick, round: round, x: p.X, y: p.Y}
		} else {
			delete(w.prev, p.SteamID)
		}
		if changed {
			w.last[p.SteamID] = state
			w.buf = append(w.buf, row)
		}
	}
	w.lastTick, w.haveLast = tick, true
	return nil
}

// tickSpeed is the pure speed rule: horizontal distance from prev to
// (x, y) over the elapsed time, units/s; ok=false on a round change, a
// non-positive Δtick or an unknown tick rate.
func tickSpeed(prev tickPrev, tick int32, round int, x, y, tickRate float64) (float64, bool) {
	dt := tick - prev.tick
	if prev.round != round || dt <= 0 || tickRate <= 0 {
		return 0, false
	}
	return math.Hypot(x-prev.x, y-prev.y) * tickRate / float64(dt), true
}

// Close hands over the remaining buffered rows, waits until the writer has
// committed everything, and returns the first write error (nil on success).
// The caller deletes the match's rows (DeletePlayerTicks) on any failure,
// Close's included — or calls Abort, which does both.
func (w *TickWriter) Close() error {
	if w.finished {
		if w.writeErr() != nil {
			return w.writeErr()
		}
		return errTickWriterClosed
	}
	w.finished = true
	if len(w.buf) > 0 {
		w.queue <- w.buf
		w.buf = nil
	}
	close(w.queue)
	<-w.done
	return w.writeErr()
}

// Abort stops the writer, waits for it to exit, and then deletes the
// match's player_ticks rows. Ordering is the point: the writer cannot
// commit anything after the delete, so no partial stream survives a failed
// or cancelled import. Safe to call after Close (the writer has already
// exited; only the delete runs) and idempotent. The importer calls it on
// every failure path; the returned error is the delete's error.
func (w *TickWriter) Abort() error {
	if !w.finished {
		w.finished = true
		close(w.stop)
		close(w.queue) // the writer discards whatever is still queued
		<-w.done
	}
	return w.s.DeletePlayerTicks(w.matchID)
}

// Rows reports how many rows the writer has committed so far.
func (w *TickWriter) Rows() int64 { return w.rows.Load() }

// hand sends the full buffer to the writer and takes an empty one, reusing
// a chunk the writer has already emptied when one is available. It blocks
// only when tickQueueDepth chunks are already waiting (backpressure).
func (w *TickWriter) hand() {
	w.queue <- w.buf
	select {
	case w.buf = <-w.recycle:
	default:
		w.buf = make([]tickRow, 0, tickChunkRows)
	}
}

// run is the writer goroutine: it commits each chunk it receives, in order,
// until the queue is closed. After a write error or an Abort it keeps
// draining the queue WITHOUT writing, so a blocked parse thread is never
// left waiting on a dead writer.
func (w *TickWriter) run() {
	defer close(w.done)
	for chunk := range w.queue {
		if !w.stopped() && w.writeErr() == nil {
			if err := w.flush(chunk); err != nil {
				w.setErr(err)
			}
		}
		select {
		case w.recycle <- chunk[:0]:
		default:
		}
	}
}

// stopped reports whether Abort has been called.
func (w *TickWriter) stopped() bool {
	select {
	case <-w.stop:
		return true
	default:
		return false
	}
}

func (w *TickWriter) writeErr() error {
	w.errMu.Lock()
	defer w.errMu.Unlock()
	return w.err
}

func (w *TickWriter) setErr(err error) {
	w.errMu.Lock()
	defer w.errMu.Unlock()
	if w.err == nil {
		w.err = err
	}
}

// flush writes one chunk in one transaction (row-by-row prepared inserts —
// measured equal to multi-row VALUES once chunked). It runs on the writer
// goroutine only.
func (w *TickWriter) flush(buf []tickRow) error {
	if len(buf) == 0 {
		return nil
	}
	tx, err := w.s.db.Begin()
	if err != nil {
		return fmt.Errorf("saving the match's tick data: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	stmt, err := tx.Prepare(`INSERT INTO player_ticks (match_id, ` + playerTicksCols + `)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return fmt.Errorf("saving the match's tick data: %w", err)
	}
	defer stmt.Close()
	for _, r := range buf {
		if _, err := stmt.Exec(w.matchID, r.tick, r.steamID, r.round, r.side, b2i(r.alive),
			r.hp, r.inAir, r.speed, r.weapon); err != nil {
			return fmt.Errorf("saving the match's tick data: %w", err)
		}
	}
	if err := markTableWriteBehind(tx, w.matchID, "player_ticks"); err != nil {
		return fmt.Errorf("saving the match's tick data: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("saving the match's tick data: %w", err)
	}
	w.rows.Add(int64(len(buf)))
	return nil
}
