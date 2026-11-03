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

// interruptedJobErr is stamped into jobs.error when Open finds jobs left
// queued/running by a previous process.
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
// at path, applies the embedded baseline schema, and marks any jobs left
// queued/running by a previous process as failed. The special path
// ":memory:" opens a private in-memory database (no directory is created).
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
