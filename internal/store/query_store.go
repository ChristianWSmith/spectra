package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// This file is the persistence surface: the read-only SQL console
// session (PRD §5.17) plus query_history / saved_queries CRUD.
//
// Console safety is layered, in execution order:
//
//  1. ValidateReadOnlySQL rejects multi-statement input, write verbs and
//     non-read PRAGMAs BEFORE anything reaches SQLite (the driver would
//     otherwise happily run a script).
//  2. RunReadOnly executes on a SEPARATE connection opened
//     `file:<path>?mode=ro&_pragma=query_only(1)` — the VFS refuses every
//     page write to the main file and query_only refuses writes on the
//     connection (temp/attached schemas), so no statement can mutate data
//     even if (1) were bypassed. The write connection is never used here.
//  3. A context deadline is enforced server-side: modernc.org/sqlite v1.61
//     installs sqlite3_progress_handler (every 1000 VM steps) plus
//     sqlite3_interrupt when the context is done, so a runaway statement
//     (e.g. a recursive-CTE bomb) is interrupted during its FIRST
//     execution step — the step where aggregates/sorts/CTEs actually run.
//     Driver caveat, documented honestly: the driver tears the progress
//     handler down when the first step returns rows, so stepping that
//     happens LATER during row iteration is not server-side interruptible;
//     iteration is bounded instead by the row cap and a per-row ctx check.
//  4. Row cap: reads stop at `limit` rows (Truncated set when more
//     existed), so a wide result can never flood the frontend grid.
//
// The write-side history/saved-query tables live on the normal handle —
// only query RESULTS are read-only.

const (
	// DefaultRowLimit is the console row cap (result grid cap).
	DefaultRowLimit = 5000
	// DefaultTimeoutMS is the console statement timeout (5 s).
	DefaultTimeoutMS = 5000
	// QueryHistoryCap is the history FIFO depth (newest kept).
	QueryHistoryCap = 100
)

// roHandles maps a *Store to its lazily-opened read-only handle. The
// Store struct lives in store.go (owned elsewhere) so the handle cannot be
// a struct field; the side table keyed by pointer gives the same
// lazily-once-per-store behavior. Call CloseRO to release (tests do;
// production holds one store for the process lifetime).
var roHandles sync.Map // *Store -> *sql.DB

// ROResult is one read-only execution result (row-major, JSON-scalar
// values: int64/float64/string/nil).
type ROResult struct {
	Columns   []string
	Rows      [][]any
	MS        int64
	Truncated bool
}

// roDSN builds the read-only connection string: SQLite's own mode=ro (the
// VFS refuses every page write to this file) plus query_only (writes on
// the connection — temp/attached schemas — fail too) and a busy timeout
// for WAL coordination with the write handle.
func roDSN(absPath string) string {
	u := &url.URL{
		Scheme:   "file",
		Path:     absPath,
		RawQuery: "mode=ro&_pragma=query_only(1)&_pragma=busy_timeout(5000)",
	}
	return u.String()
}

// roDB returns (creating once) the read-only handle for this store. The
// database path is recovered from the open write connection
// (PRAGMA database_list); in-memory stores have no file to reopen and are
// rejected with a clear error.
func (s *Store) roDB() (*sql.DB, error) {
	if h, ok := roHandles.Load(s); ok {
		return h.(*sql.DB), nil
	}
	var (
		seq  int
		name string
		file string
	)
	if err := s.db.QueryRow(`PRAGMA database_list`).Scan(&seq, &name, &file); err != nil {
		return nil, fmt.Errorf("store: read-only open (database_list): %w", err)
	}
	if file == "" {
		return nil, errors.New("store: read-only session requires a file-backed database")
	}
	abs, err := filepath.Abs(file)
	if err != nil {
		return nil, fmt.Errorf("store: read-only open (abs path): %w", err)
	}
	db, err := sql.Open("sqlite", roDSN(abs))
	if err != nil {
		return nil, fmt.Errorf("store: read-only open: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("store: read-only open: %w", err)
	}
	if actual, loaded := roHandles.LoadOrStore(s, db); loaded {
		_ = db.Close() // lost the race; the stored handle wins
		return actual.(*sql.DB), nil
	}
	return db, nil
}

// CloseRO releases this store's read-only handle (Store.Close in store.go
// cannot know about the side table). Safe to call when never opened.
func (s *Store) CloseRO() error {
	if h, ok := roHandles.LoadAndDelete(s); ok {
		return h.(*sql.DB).Close()
	}
	return nil
}

// RunReadOnly validates and executes one statement on the read-only
// connection (layers 1–4 above; see file doc). limit ≤0 uses
// DefaultRowLimit, timeoutMS ≤0 uses DefaultTimeoutMS. Errors are
// returned unwrapped from the driver/ctx (message includes the timeout on
// deadline); MS always reports the wall time spent.
func (s *Store) RunReadOnly(q string, args []any, limit, timeoutMS int) (ROResult, error) {
	if err := ValidateReadOnlySQL(q); err != nil {
		return ROResult{}, err
	}
	if limit <= 0 {
		limit = DefaultRowLimit
	}
	if timeoutMS <= 0 {
		timeoutMS = DefaultTimeoutMS
	}
	db, err := s.roDB()
	if err != nil {
		return ROResult{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMS)*time.Millisecond)
	defer cancel()
	start := time.Now()
	elapsed := func() int64 { return time.Since(start).Milliseconds() }

	rows, err := db.QueryContext(ctx, q, args...)
	if err != nil {
		return ROResult{MS: elapsed()}, roErr(err, ctx, timeoutMS)
	}
	defer rows.Close()

	cols, err := rows.Columns()
	if err != nil {
		return ROResult{MS: elapsed()}, roErr(err, ctx, timeoutMS)
	}
	out := ROResult{Columns: cols}
	for rows.Next() {
		if cerr := ctx.Err(); cerr != nil {
			return ROResult{MS: elapsed()}, timeoutErr(cerr, timeoutMS)
		}
		if len(out.Rows) >= limit {
			out.Truncated = true // one row beyond the cap was fetched and discarded
			break
		}
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return ROResult{MS: elapsed()}, roErr(err, ctx, timeoutMS)
		}
		for i, v := range vals {
			vals[i] = normValue(v)
		}
		out.Rows = append(out.Rows, vals)
	}
	if err := rows.Err(); err != nil {
		return ROResult{MS: elapsed()}, roErr(err, ctx, timeoutMS)
	}
	out.MS = elapsed()
	return out, nil
}

// timeoutErr formats a deadline/ interrupt failure.
func timeoutErr(err error, timeoutMS int) error {
	return fmt.Errorf("store: query exceeded the %d ms timeout: %w", timeoutMS, err)
}

// roErr distinguishes deadline/interrupt failures from SQL failures.
func roErr(err error, ctx context.Context, timeoutMS int) error {
	if ctx.Err() != nil {
		return timeoutErr(ctx.Err(), timeoutMS)
	}
	return fmt.Errorf("store: query: %w", err)
}

// normValue converts driver values to JSON scalars: []byte → string,
// time.Time → RFC3339Nano (the console grid contract is numbers/strings/
// nil — models.QueryResult).
func normValue(v any) any {
	switch t := v.(type) {
	case []byte:
		return string(t)
	case time.Time:
		return t.Format(time.RFC3339Nano)
	}
	return v
}

// readOnlyForbidden are identifier tokens rejected anywhere in a console
// statement (tokenizer-aware: a 'delete' string literal is fine, the
// ident delete is not). `replace` is handled separately because it is also
// a SQLite string function.
var readOnlyForbidden = map[string]bool{
	"insert": true, "update": true, "delete": true, "drop": true,
	"create": true, "alter": true, "attach": true, "detach": true,
	"vacuum": true, "reindex": true, "analyze": true, "replace": true,
	"begin": true, "commit": true, "rollback": true, "savepoint": true,
	"release": true, "load_extension": true, "writefile": true,
	"readfile": true,
}

// readOnlyLeading are the only permitted first keywords (after any leading
// '(' for parenthesized selects). Write forms never start these and the
// forbidden-verb scan above covers `WITH ... INSERT` as well.
var readOnlyLeading = map[string]bool{
	"select": true, "with": true, "explain": true, "pragma": true,
	"values": true,
}

// readOnlyPragmas whitelists PRAGMA names whose every form is read-only or
// connection-local (table browse, compile options, integrity checks,
// busy/cache/mmap settings). Mutating pragmas (journal_mode, query_only,
// user_version, writable_schema, wal_checkpoint, optimize, …) are absent by
// construction — they are rejected by name.
var readOnlyPragmas = map[string]bool{
	"table_info": true, "table_xinfo": true, "table_list": true,
	"database_list": true, "index_list": true, "index_info": true,
	"index_xinfo": true, "foreign_key_list": true, "foreign_key_check": true,
	"compile_options": true, "function_list": true, "pragma_list": true,
	"module_list": true, "page_count": true, "freelist_count": true,
	"integrity_check": true, "quick_check": true, "busy_timeout": true,
	"cache_size": true, "mmap_size": true, "temp_store": true,
}

// sqlTok is one console-statement token (strings/comments are consumed by
// the lexer and never appear — that is what makes `'1; DROP'` safe).
type sqlTok struct {
	kind byte // 'i' ident, 'n' number, 's' string, 'p' punctuation
	text string
}

// lexSQL tokenizes a statement for validation. Quoted strings/idents and
// -- / /* */ comments are skipped (their contents never become tokens);
// two-character operators are merged. Unterminated quotes/comments and
// unknown characters are errors.
func lexSQL(q string) ([]sqlTok, error) {
	var toks []sqlTok
	isIdentStart := func(c byte) bool {
		return c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
	}
	isIdent := func(c byte) bool { return isIdentStart(c) || (c >= '0' && c <= '9') || c == '$' }
	i := 0
	for i < len(q) {
		c := q[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v':
			i++
		case c == '-' && i+1 < len(q) && q[i+1] == '-':
			for i < len(q) && q[i] != '\n' {
				i++
			}
		case c == '/' && i+1 < len(q) && q[i+1] == '*':
			j := strings.Index(q[i+2:], "*/")
			if j < 0 {
				return nil, errors.New("store: unterminated block comment")
			}
			i += 2 + j + 2
		case c == '\'' || c == '"':
			j := i + 1
			for j < len(q) {
				if q[j] == c {
					if j+1 < len(q) && q[j+1] == c { // doubled quote escape
						j += 2
						continue
					}
					break
				}
				j++
			}
			if j >= len(q) {
				return nil, errors.New("store: unterminated quoted string")
			}
			kind := 's'
			if c == '"' {
				kind = 'i' // quoted identifier (e.g. "select") stays an ident
			}
			toks = append(toks, sqlTok{kind: byte(kind), text: q[i : j+1]})
			i = j + 1
		case c >= '0' && c <= '9' || (c == '.' && i+1 < len(q) && q[i+1] >= '0' && q[i+1] <= '9'):
			j := i
			for j < len(q) && q[j] >= '0' && q[j] <= '9' {
				j++
			}
			if j < len(q) && q[j] == '.' {
				j++
				for j < len(q) && q[j] >= '0' && q[j] <= '9' {
					j++
				}
			}
			if j < len(q) && (q[j] == 'e' || q[j] == 'E') {
				k := j + 1
				if k < len(q) && (q[k] == '+' || q[k] == '-') {
					k++
				}
				if k < len(q) && q[k] >= '0' && q[k] <= '9' {
					for k < len(q) && q[k] >= '0' && q[k] <= '9' {
						k++
					}
					j = k
				}
			}
			toks = append(toks, sqlTok{kind: 'n', text: q[i:j]})
			i = j
		case isIdentStart(c):
			j := i
			for j < len(q) && isIdent(q[j]) {
				j++
			}
			toks = append(toks, sqlTok{kind: 'i', text: q[i:j]})
			i = j
		case c == '!' || c == '<' || c == '>' || c == '=':
			if i+1 < len(q) && q[i+1] == '=' {
				toks = append(toks, sqlTok{kind: 'p', text: q[i : i+2]})
				i += 2
			} else {
				toks = append(toks, sqlTok{kind: 'p', text: string(c)})
				i++
			}
		default:
			toks = append(toks, sqlTok{kind: 'p', text: string(c)})
			i++
		}
	}
	return toks, nil
}

// ValidateReadOnlySQL enforces the console statement policy (layer 1):
// exactly one statement, a read-only leading keyword, no write verbs
// anywhere (tokenizer-aware), and PRAGMA limited to the read allowlist.
// This runs BEFORE execution — `SELECT 1; DROP TABLE matches` never
// reaches SQLite.
func ValidateReadOnlySQL(q string) error {
	toks, err := lexSQL(q)
	if err != nil {
		return fmt.Errorf("store: read-only validation: %w", err)
	}
	if len(toks) == 0 {
		return errors.New("store: read-only validation: empty statement")
	}
	// Single statement: at most one ';', allowed only as the final token
	// (a trailing terminator), never between statements.
	semi := -1
	for i, t := range toks {
		if t.text == ";" {
			if semi >= 0 || i != len(toks)-1 {
				return errors.New("store: read-only validation: only a single statement is allowed")
			}
			semi = i
		}
	}
	// Write verbs anywhere (covers WITH ... INSERT and friends).
	for i, t := range toks {
		if t.kind != 'i' {
			continue
		}
		word := strings.ToLower(t.text)
		if word == "replace" {
			// replace(...) is the string function; REPLACE INTO is a write.
			if i+1 < len(toks) && toks[i+1].text == "(" {
				continue
			}
		}
		if readOnlyForbidden[word] {
			return fmt.Errorf("store: read-only validation: %s statements are not allowed", word)
		}
	}
	// Leading keyword (skip parenthesized selects).
	first := 0
	for first < len(toks) && toks[first].text == "(" {
		first++
	}
	if first >= len(toks) || toks[first].kind != 'i' || !readOnlyLeading[strings.ToLower(toks[first].text)] {
		return fmt.Errorf("store: read-only validation: expected SELECT/WITH/EXPLAIN/PRAGMA, got %q", toks[first%len(toks)].text)
	}
	if strings.EqualFold(toks[first].text, "pragma") {
		if first+1 >= len(toks) || toks[first+1].kind != 'i' || !readOnlyPragmas[strings.ToLower(toks[first+1].text)] {
			name := "<missing>"
			if first+1 < len(toks) {
				name = toks[first+1].text
			}
			return fmt.Errorf("store: read-only validation: PRAGMA %s is not allowed", name)
		}
	}
	return nil
}

// Schema returns every user table plus its columns (PRAGMA table_info
// shape via the pragma table-valued function; table names come from
// sqlite_master and are bound, never interpolated). Notes are attached
// later by internal/query.
func (s *Store) Schema() ([]models.SchemaTableRow, error) {
	rows, err := s.db.Query(
		`SELECT name FROM sqlite_master
		 WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
		 ORDER BY name ASC`,
	)
	if err != nil {
		return nil, fmt.Errorf("store: schema: %w", err)
	}
	var names []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			rows.Close()
			return nil, fmt.Errorf("store: schema: %w", err)
		}
		names = append(names, n)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, fmt.Errorf("store: schema: %w", err)
	}
	rows.Close()

	out := make([]models.SchemaTableRow, 0, len(names))
	for _, n := range names {
		cols, err := s.schemaColumns(n)
		if err != nil {
			return nil, err
		}
		out = append(out, models.SchemaTableRow{Name: n, Columns: cols})
	}
	return out, nil
}

func (s *Store) schemaColumns(table string) ([]models.SchemaColumnRow, error) {
	rows, err := s.db.Query(`SELECT name, type FROM pragma_table_info(?)`, table)
	if err != nil {
		return nil, fmt.Errorf("store: schema columns for %s: %w", table, err)
	}
	defer rows.Close()
	var out []models.SchemaColumnRow
	for rows.Next() {
		var c models.SchemaColumnRow
		if err := rows.Scan(&c.Name, &c.Type); err != nil {
			return nil, fmt.Errorf("store: schema columns for %s: %w", table, err)
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: schema columns for %s: %w", table, err)
	}
	return out, nil
}

// ---- query history (write handle; capped FIFO) ----

// Per-table column lists (G1): the row WITHOUT the autoincrement id — the
// writers insert the list verbatim, the readers select `id, ` + it.
const (
	queryHistoryCols = `sql, ms, row_count, ok, ran_at`

	savedQueryCols = `name, sql, created_at`
)

// AppendQueryHistory records one console run (success or error) and trims
// the table back to QueryHistoryCap newest entries.
func (s *Store) AppendQueryHistory(e models.QueryHistoryRow) error {
	if e.RanAt.IsZero() {
		e.RanAt = time.Now()
	}
	if _, err := s.db.Exec(
		`INSERT INTO query_history (`+queryHistoryCols+`) VALUES (?, ?, ?, ?, ?)`,
		scrub(e.SQL), e.MS, e.Rows, b2i(e.OK), e.RanAt,
	); err != nil {
		return fmt.Errorf("store: append query history: %w", err)
	}
	if _, err := s.db.Exec(
		`DELETE FROM query_history WHERE id NOT IN
			(SELECT id FROM query_history ORDER BY id DESC LIMIT ?)`,
		QueryHistoryCap,
	); err != nil {
		return fmt.Errorf("store: trim query history: %w", err)
	}
	return nil
}

// ListQueryHistory returns runs newest-first (limit ≤0 → cap).
func (s *Store) ListQueryHistory(limit int) ([]models.QueryHistoryRow, error) {
	if limit <= 0 {
		limit = QueryHistoryCap
	}
	rows, err := s.db.Query(
		`SELECT id, `+queryHistoryCols+` FROM query_history
		 ORDER BY id DESC LIMIT ?`, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("store: list query history: %w", err)
	}
	defer rows.Close()
	var out []models.QueryHistoryRow
	for rows.Next() {
		var (
			r  models.QueryHistoryRow
			ok int64
		)
		if err := rows.Scan(&r.ID, &r.SQL, &r.MS, &r.Rows, &ok, &r.RanAt); err != nil {
			return nil, fmt.Errorf("store: list query history: %w", err)
		}
		r.OK = i2b(ok)
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list query history: %w", err)
	}
	return out, nil
}

// ClearHistory wipes the console history.
func (s *Store) ClearHistory() error {
	if _, err := s.db.Exec(`DELETE FROM query_history`); err != nil {
		return fmt.Errorf("store: clear query history: %w", err)
	}
	return nil
}

// ---- saved queries (write handle; unique names) ----

// ListSavedQueries returns named console queries (name ASC).
func (s *Store) ListSavedQueries() ([]models.SavedQueryRow, error) {
	rows, err := s.db.Query(
		`SELECT id, ` + savedQueryCols + ` FROM saved_queries ORDER BY name ASC`,
	)
	if err != nil {
		return nil, fmt.Errorf("store: list saved queries: %w", err)
	}
	defer rows.Close()
	var out []models.SavedQueryRow
	for rows.Next() {
		var r models.SavedQueryRow
		if err := rows.Scan(&r.ID, &r.Name, &r.SQL, &r.CreatedAt); err != nil {
			return nil, fmt.Errorf("store: list saved queries: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list saved queries: %w", err)
	}
	return out, nil
}

// SaveQuery inserts a named query (duplicate names yield a user-facing
// error) and returns the stored row.
func (s *Store) SaveQuery(name, query string) (models.SavedQueryRow, error) {
	res, err := s.db.Exec(
		`INSERT INTO saved_queries (`+savedQueryCols+`) VALUES (?, ?, ?)`,
		scrub(name), scrub(query), time.Now(),
	)
	if err != nil {
		if isUniqueErr(err) {
			return models.SavedQueryRow{}, fmt.Errorf("store: a query named %q already exists", scrub(name))
		}
		return models.SavedQueryRow{}, fmt.Errorf("store: save query: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return models.SavedQueryRow{}, fmt.Errorf("store: save query: %w", err)
	}
	var r models.SavedQueryRow
	if err := s.db.QueryRow(
		`SELECT id, `+savedQueryCols+` FROM saved_queries WHERE id = ?`, id,
	).Scan(&r.ID, &r.Name, &r.SQL, &r.CreatedAt); err != nil {
		return models.SavedQueryRow{}, fmt.Errorf("store: save query: %w", err)
	}
	return r, nil
}

// DeleteQuery removes one saved query (unknown ids → ErrNotFound).
func (s *Store) DeleteQuery(id int64) error {
	res, err := s.db.Exec(`DELETE FROM saved_queries WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("store: delete query: %w", err)
	}
	return affectedOrNotFound(res, "store: delete query")
}
