// Package store persists extraction output in SQLite and serves the
// frontend-facing queries. The database is opened with WAL, a busy timeout
// and foreign keys enabled, capped at a single connection; every string
// bound into SQL is scrubbed of NUL bytes (demo names contain them).
package store

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
	_ "modernc.org/sqlite"
)

// ErrNotFound is returned when a requested row does not exist.
var ErrNotFound = errors.New("store: not found")

// interruptedJobErr is stamped into jobs.error (and matches.error, for a
// match row left lifecycle-pending by a dead process) when Open finds rows
// left queued/running by a previous process.
const interruptedJobErr = "interrupted by restart"

// childTables are the per-match child tables deleted (oldest dependency
// first) by SaveExtracted and DeleteMatchData. All FK to matches(id).
// voice_* tables join here too (M4): SaveExtracted clears them before a
// reprocess's InsertVoice refills them.
var childTables = []string{
	"events", "generic_events", "chat", "round_economy", "rounds",
	"round_player_sides", "player_stats", "players", "teams", "warnings",
	"round_classifications", "player_round_stats", "clutches",
	"engagements", "utility_events",
	"voice_chunks", "voice_presence",
}

// Store is a SQLite-backed persistence handle. The underlying database is
// capped at one open connection (single-writer design).
type Store struct {
	db *sql.DB
}

// Open opens (creating the parent directory if needed) the SQLite database
// at path, applies the embedded baseline schema, and repairs the lifecycle
// rows a dead process left behind: jobs stuck queued/running become failed
// ("interrupted by restart"), and so do match rows stuck queued/parsing
// that no live job owns — a dead worker cannot finish them, and leaving
// them would keep the Library's Reprocess/Delete buttons disabled forever.
// The jobs repair runs FIRST so the matches pass sees the post-repair
// job table (a match whose job just became failed is by definition
// jobless). The special path ":memory:" opens a private in-memory database
// (no directory is created).
func Open(path string) (*Store, error) {
	if path != ":memory:" {
		if dir := filepath.Dir(path); dir != "" && dir != "." {
			if err := os.MkdirAll(dir, 0o755); err != nil {
				return nil, fmt.Errorf("store: create database directory: %w", err)
			}
		}
	}
	dsn := path + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("store: open: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("store: open: %w", err)
	}
	s := &Store{db: db}
	if err := s.applySchema(); err != nil {
		_ = db.Close()
		return nil, err
	}
	if _, err := s.db.Exec(
		`UPDATE jobs SET status = ?, error = ?, finished_at = ? WHERE status IN (?, ?)`,
		models.JobFailed, interruptedJobErr, time.Now(), models.JobQueued, models.JobRunning,
	); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("store: mark interrupted jobs: %w", err)
	}
	// Match rows stuck mid-lifecycle with no live job own them: the jobs
	// repair above just failed every non-terminal job, so a row still
	// queued/parsing here has nothing running that could finish it. Mark
	// it failed (same message) — that re-enables Reprocess/Delete on the
	// row instead of stranding it behind a queue that no longer exists.
	if _, err := s.db.Exec(
		`UPDATE matches SET status = ?, error = ?
		 WHERE status IN (?, ?)
		   AND NOT EXISTS (
		     SELECT 1 FROM jobs
		     WHERE jobs.match_id = matches.id AND jobs.status IN (?, ?)
		   )`,
		models.StatusFailed, interruptedJobErr,
		models.StatusQueued, models.StatusParsing,
		models.JobQueued, models.JobRunning,
	); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("store: mark interrupted matches: %w", err)
	}
	return s, nil
}

// Close releases the underlying database handle.
func (s *Store) Close() error { return s.db.Close() }

// scrub removes NUL bytes from demo-sourced strings before they are bound
// into SQL.
func scrub(s string) string { return strings.ReplaceAll(s, "\x00", "") }

// b2i converts a bool to its SQLite INTEGER encoding (0/1).
func b2i(b bool) int64 {
	if b {
		return 1
	}
	return 0
}

// i2b is b2i's inverse for scanned INTEGER columns (0/1 → bool).
func i2b(v int64) bool { return v != 0 }

// nullTime dereferences a scanned nullable DATETIME: the zero time on NULL
// (ListMatches/GetMatch/GetPlayerHistory/scanMetric — "never extracted").
func nullTime(nt sql.NullTime) time.Time {
	if !nt.Valid {
		return time.Time{}
	}
	return nt.Time
}

// nullTimePtr dereferences a scanned nullable DATETIME into an OPTIONAL
// timestamp: nil on NULL (jobs.started_at/finished_at before the job
// reaches that stage).
func nullTimePtr(nt sql.NullTime) *time.Time {
	if !nt.Valid {
		return nil
	}
	t := nt.Time
	return &t
}

// nullFloat dereferences a scanned nullable REAL into an optional float:
// nil on NULL (utility_events.det_x/det_y — grenades with no detonation
// position).
func nullFloat(nf sql.NullFloat64) *float64 {
	if !nf.Valid {
		return nil
	}
	v := nf.Float64
	return &v
}

// isUniqueErr reports whether err is SQLite's UNIQUE-constraint violation
// (the driver message carries "UNIQUE" — used to turn duplicate names into
// user-facing errors).
func isUniqueErr(err error) bool {
	return err != nil && strings.Contains(err.Error(), "UNIQUE")
}

// nvl dereferences a nullable float for SQL binding: nil becomes an untyped
// NULL, non-nil its value (events.pos_* are NULL-able by design).
func nvl(p *float64) any {
	if p == nil {
		return nil
	}
	return *p
}
