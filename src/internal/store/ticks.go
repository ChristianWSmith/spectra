package store

import (
	"database/sql"
	"fmt"
	"math"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// playerTicksCols is the player_ticks row WITHOUT match_id — the
// TickWriter's INSERT list, pinned to the DDL by
// TestColumnListConstsMatchSchema.
const playerTicksCols = `tick, steam_id, round, side, alive, hp, money, in_air, speed, weapon`

// tickChunkRows bounds one player_ticks write transaction. A golden-sized
// match streams ~1.3M rows; written in one transaction that holds the
// single writer for well over busy_timeout (5 s), starving every other
// writer (job progress, other jobs' SaveExtracted, sweeps). At this
// bound one chunk holds the writer for under a second.
const tickChunkRows = 50_000

// streamedChildTables are the per-match tables written DURING the parse
// (not by SaveExtracted), so they cannot ride childTables: SaveExtracted's
// delete-first loop runs after the parse and would erase the rows that
// just streamed in. Their reprocess wipe happens when the writer is
// created (NewTickWriter) and their failure cleanup through
// DeletePlayerTicks; DeleteMatchData clears them with the childTables.
var streamedChildTables = []string{"player_ticks"}

// tickPrev is the last positioned frame the writer saw for one player —
// the only state speed derivation needs.
type tickPrev struct {
	tick  int32
	round int
	x, y  float64
}

// TickWriter streams one match's player_ticks rows during the parse; it
// implements extract.TickSink. Rows are buffered in memory and flushed in
// transactions of at most tickChunkRows rows, each flush completing
// INSIDE AddTicks: no transaction is ever held across frames, which would
// deadlock the single-connection pool against the job's own progress
// writes made between frames. Memory is bounded by one chunk plus one
// previous-position entry per player.
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
	lastTick int32
	haveLast bool
	rows     int64
}

// tickRow is one buffered player_ticks row (match_id is the writer's).
type tickRow struct {
	tick    int32
	steamID string
	round   int
	side    string
	alive   bool
	hp      int
	money   int
	inAir   sql.NullBool
	speed   sql.NullFloat64
	weapon  sql.NullString
}

// NewTickWriter opens the tick stream for one match, first deleting any
// rows a previous parse of the match left (the reprocess wipe — the
// sidecar's truncate-at-create twin).
func (s *Store) NewTickWriter(matchID int64) (*TickWriter, error) {
	if err := s.DeletePlayerTicks(matchID); err != nil {
		return nil, err
	}
	return &TickWriter{
		s:       s,
		matchID: matchID,
		buf:     make([]tickRow, 0, 1024),
		prev:    make(map[string]tickPrev, 16),
	}, nil
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
	// A frame at the SAME tick as the previous delivered frame re-observes
	// a game tick already written (the golden demo carries one such frame
	// every 3840 ticks — the periodic full-packet frame). The table's
	// grain is one row per (match, tick, player): the first observation
	// of a tick wins, the repeat is dropped.
	if w.haveLast && tick == w.lastTick {
		return nil
	}
	if len(w.buf) > 0 && len(w.buf)+len(players) > tickChunkRows {
		if err := w.flush(); err != nil {
			return err
		}
	}
	for _, p := range players {
		row := tickRow{
			tick:    tick,
			steamID: scrub(p.SteamID),
			round:   round,
			side:    scrub(p.Side),
			alive:   p.Alive,
			hp:      p.HP,
			money:   p.Money,
		}
		if p.Alive {
			row.weapon = sql.NullString{String: scrub(p.Weapon), Valid: true}
		}
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
		w.buf = append(w.buf, row)
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

// Close flushes the remaining buffered rows. The caller deletes the
// match's rows (DeletePlayerTicks) on any failure, Close's included.
func (w *TickWriter) Close() error { return w.flush() }

// Rows reports how many rows the writer has committed so far.
func (w *TickWriter) Rows() int64 { return w.rows }

// flush writes the buffer in one transaction (row-by-row prepared
// inserts — measured equal to multi-row VALUES once chunked).
func (w *TickWriter) flush() error {
	if len(w.buf) == 0 {
		return nil
	}
	tx, err := w.s.db.Begin()
	if err != nil {
		return fmt.Errorf("saving the match's tick data: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	stmt, err := tx.Prepare(`INSERT INTO player_ticks (match_id, ` + playerTicksCols + `)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return fmt.Errorf("saving the match's tick data: %w", err)
	}
	defer stmt.Close()
	for _, r := range w.buf {
		if _, err := stmt.Exec(w.matchID, r.tick, r.steamID, r.round, r.side, b2i(r.alive),
			r.hp, r.money, r.inAir, r.speed, r.weapon); err != nil {
			return fmt.Errorf("saving the match's tick data: %w", err)
		}
	}
	if err := markTableWriteBehind(tx, w.matchID, "player_ticks"); err != nil {
		return fmt.Errorf("saving the match's tick data: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("saving the match's tick data: %w", err)
	}
	w.rows += int64(len(w.buf))
	w.buf = w.buf[:0]
	return nil
}
