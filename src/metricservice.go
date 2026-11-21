package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/ChristianWSmith/spectra/internal/budget"
	"github.com/ChristianWSmith/spectra/internal/metrics"
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// MetricsService is the custom-metric service. Definitions live in the
// `metrics` table (origin builtin|user|plugin). An expression is one raw SQL
// statement: the one save gate (internal/metrics CheckRawSave) validates it,
// and the sweep runs it on the read-only connection (internal/metrics raw.go).
// Pinned metrics appear as scoreboard/profile
// columns.
//
// The groupBy parameter is gone from every signature (PreviewMetric,
// ValidateExpr and the frontend wrappers), and SaveMetric validates + writes
// the real scope — the W1
// ignored-arg shims and the forced scope 'match' are retired with the
// frontend form change that ships in the same wave.
//
// W2b (composability save-side) adds metric('name') references as a
// save-time graph: the service RESOLVES each reference against the
// catalog (metrics.name is UNIQUE across origins, so name→id is total),
// enforces existence / cross-scope / acyclicity, and persists the edges
// wholesale into metric_deps inside the save transaction — with the
// rename splice re-validated before anything is written.
//
// W3 (the compute pass — design §4) is DONE here too: a semantic save
// bumps the metric's version AND every transitive dependent's inside the
// same tx (SaveMetricWithDeps' semanticBump), then schedules the sweep;
// metriccompute.go owns the scheduler, spectra:metric-progress /
// spectra:metric-done, the transient processing/failed records and
// GetMetricComputeState; the pass itself (behind-set, topo order,
// two-phase unit) is metrics.Sweep in internal/metrics.

// MetricPreviewRow is one preview result row.
type MetricPreviewRow struct {
	MatchID  int64   `json:"matchId"` // the row's match address (team-subject rows at library scope; 0 otherwise)
	Group    string  `json:"group"`   // subject key ("" for none)
	Dim      string  `json:"dim"`     // partition value ("" = unpartitioned)
	Label    string  `json:"label"`   // display name (player name etc when resolvable; an identity row labels its WINNER)
	Value    float64 `json:"value"`
	ValueKey string  `json:"valueKey"` // identity winner's key (argmax rows only — §3.3; "" on numeric rows)
}

// MetricPreview is a preview response. Metric is models.MetricRow — the
// stored-definition shape (definitions are served and saved as rows; no
// service twin).
type MetricPreview struct {
	Metric    models.MetricRow   `json:"metric"`
	Rows      []MetricPreviewRow `json:"rows"`
	MS        int64              `json:"ms"`
	SQL       string             `json:"sql"` // compiled SQL (debug/provenance view)
	Truncated bool               `json:"truncated"`
}

// ExprError describes a validation failure (line/col when parseable).
type ExprError struct {
	Message string `json:"message"`
	Pos     int    `json:"pos"`
}

// ---- metric expressions (raw SQL) ----
//
// A metric's expression is one SELECT or WITH statement. The one gate
// (internal/metrics GateSQL, reached through CheckRawSave) validates it on
// every path: the Builder's live check, save and the sweep. This service
// forwards statements to that gate and maps its refusals onto the
// ExprError binding shape.

// MetricsService — see doc comment above. The W3 compute machinery
// (scheduler, events, transient state) lives in metriccompute.go; the
// pass itself in internal/metrics.
type MetricsService struct {
	st  *store.Store
	app *application.App

	// --- W3 compute machinery (stored-metrics design §4) — see
	// metriccompute.go for each field's contract ---
	mu sync.Mutex
	// computeLock is the shared ONE-COMPUTE-AT-A-TIME lock (main wires
	// the same mutex into AnalyticsService and library.Options): a
	// background sweep, an import-body sweep and an analytics recompute
	// never overlap. Unwired ⇒ a private slot on first use (package
	// tests: still serialized, just not cross-service).
	computeLock *sync.Mutex
	// budget is the machine-wide work-token pool: the BACKGROUND sweep
	// takes ONE token for its whole body BEFORE the compute lock (token
	// → lock, never reversed). The import body already holds its job's
	// token and never takes a second. nil = unbudgeted no-op seam.
	budget *budget.Budget
	// sweepsOn gates scheduleSweep (main wires useSweeps; package tests
	// construct the service bare and drive runSweep synchronously).
	// Coalescing (ruling, 2026-11-21): at most ONE sweep runs
	// (sweepRunning, owned by sweepLoop) and at most ONE follow-up is
	// pending (sweepWanted). Every trigger — import, save, plugin op,
	// recompute, startup — goes through scheduleSweep and nowhere else.
	sweepsOn     bool
	sweepRunning bool
	sweepWanted  bool
	// sweepIdle is signalled when sweepRunning drops (waitSweepsIdle — the
	// headless import waits on it before exit). Built by useSweeps on mu.
	sweepIdle *sync.Cond
	// sweepHook, when set, is called inside runSweep right after the
	// compute lock is taken (true) and again before it is released
	// (false). Test-only observation of how many sweeps are inside the
	// pass at once; nil in production.
	sweepHook func(entering bool)
	inflight  map[int64]bool   // metrics a live sweep is computing
	errs      map[int64]string // last failure per metric (cleared on success)
	progMu    sync.Mutex       // guards the 100 ms progress throttle
	progLast  time.Time
	// runs is every metric statement running right now (sweep and
	// preview), by metric id — what CancelMetric cancels. Guarded by
	// runsMu (its own lock: never held across a statement).
	runsMu sync.Mutex
	runs   map[int64]map[uint64]context.CancelFunc
	runSeq uint64
}

// exprError converts a metrics.GateError into the ExprError contract and
// a plain error for call paths that only return error.
func exprError(perr *metrics.GateError) ExprError {
	return ExprError{Message: perr.Message, Pos: perr.Pos}
}

func exprErrorErr(perr *metrics.GateError) error {
	return fmt.Errorf("invalid metric expression: %s", perr.Message)
}

// metricFormats are the accepted Format values (contract). float2 keeps
// a two-decimal tail unconditionally (Q6 — the K/D seeds render2.00,
// never the auto-format's "2"); it is a display tag only, no DDL and no
// grammar change. identity (the key-valued format — metrics expansion
// §4/§9) marks a metric whose value is a KEY in metric_values.value_key
// rather than a number — the M1 identity seeds carry it (plan §8), and
// fmtMetric renders it through the value_key → name lookup (unresolved
// ⇒ dash, never a raw key). The store format filter
// (store.metricFormatTokens — this vocabulary plus its filter-only
// `auto` alias for ”) offers every token including identity since
// metrics expansion Phase 7 (2026-11-18: the Builder Type group's
// Identity box); the editor's Format select deliberately does NOT
// offer identity as a fresh choice (lib/metricformats.js filterOnly —
// no subject control to gate argmax on yet). The
// filter never lists a token this map lacks.
var metricFormats = map[string]bool{"": true, "int": true, "float1": true, "float2": true, "percent": true, "currency": true, "identity": true}

// ListMetrics returns all definitions (builtin first).
func (s *MetricsService) ListMetrics() ([]models.MetricRow, error) {
	return s.st.ListMetrics()
}

// ListMetricsPage returns ONE keyset window of the same list ListMetrics
// returns (the Builder's "Load more" pagination): the rows after afterID
// (0 = the first window) for the same server-side search query AND the
// same server-side filters — origin (the Builder Origin group's checked
// set: "" = every box, "none" = no box, or the canonical comma-subset
// of the three origin tokens builtin/user/plugin — the Custom box is
// "user", the Plugin box "plugin") and format (the Builder's Type group:
// "" = every format, "none" = none, or the canonical comma-subset of
// format tokens where "auto" names the ” format) — which are the
// Builder's SERVER-side filter groups (the Pinning group is a render-time
// filter over
// localStorage the backend cannot see — see Builder.svelte); see
// store.ListMetricsPage — at most limit rows (0 = the store's default
// window), plus HasNext (another window follows) — see
// store.ListMetricsPage / models.MetricListPage.
// ListMetrics itself stays unbounded for its whole-library readers
// (Match's pinned scoreboard columns, Reports' appendix,
// CommandPalette's search), which are not changing.
func (s *MetricsService) ListMetricsPage(query string, originFilter string, formatFilter string, afterID int64, limit int) (*models.MetricListPage, error) {
	page, err := s.st.ListMetricsPage(query, originFilter, formatFilter, afterID, limit)
	if err != nil {
		return nil, err
	}
	if err := s.markEdited(page.Rows); err != nil {
		return nil, err
	}
	return page, nil
}

// markEdited sets Edited on every builtin row whose override is in place,
// from one read of the override table.
func (s *MetricsService) markEdited(rows []models.MetricRow) error {
	ovs, err := s.st.ListBuiltinOverrides()
	if err != nil {
		return err
	}
	edited := make(map[string]bool, len(ovs))
	for _, o := range ovs {
		edited[o.ID] = true
	}
	for i := range rows {
		rows[i].Edited = rows[i].Origin == "builtin" && edited[store.MetricOverridePrefix+rows[i].Name]
	}
	return nil
}

// GetMetric returns one by id (or name).
func (s *MetricsService) GetMetric(id int64) (models.MetricRow, error) {
	if id <= 0 {
		return models.MetricRow{}, errors.New("metric id is required")
	}
	r, err := s.st.GetMetric(id)
	if errors.Is(err, store.ErrNotFound) {
		return models.MetricRow{}, fmt.Errorf("no metric with id %d", id)
	}
	if err != nil {
		return models.MetricRow{}, err
	}
	return s.withEdited(r), nil
}

// SaveMetric validates + upserts (origin forced to user for API saves;
// plugin metrics are written by the plugin loader; an EXISTING built-in
// row is rejected below — built-ins are immutable through this API).
// Duplicate name → error.
// The frontend echoes rows back as-is; CreatedAt is store-owned (stamped
// on create, untouched on update).
//
// The validation block below runs in order — guards, the one gate
// (metrics.CheckRawSave: one statement, read-only, allowlisted tables,
// reserved binds), the scope rule, the touched set — and only THEN one
// transaction writes the metric and its metric_deps edges (re-derived
// wholesale from the CURRENT expression). Nothing is written until every
// check passes.
//
// W3 (design §4): a SEMANTIC edit (expr / scope — the
// two fields the bump answers, compared against the stored row like
// analyticservice.go's SetConfig no-op) bumps this metric's version AND
// every transitive dependent's inside that same transaction, then
// schedules the sweep. A display-only edit (title / shortName / format /
// doc), a no-op save and a rename bump nothing and schedule nothing — a
// rename changes no semantics (W2b's pin, kept).
func (s *MetricsService) SaveMetric(m models.MetricRow) (models.MetricRow, error) {
	return s.saveMetric(m, nil)
}

// SaveBuiltinMetric stores an edit of one builtin metric's SQL (owner ruling
// 44). The edit is the builtin's own row with a new expr: its name, title,
// format and doc are kept, so its value identity is kept. It passes the
// same save gate as a user metric, and
// the same semantic bump and sweep, then records the override in the same
// transaction. The shipped SQL is kept on the override for restore.
func (s *MetricsService) SaveBuiltinMetric(id int64, expr string) (models.MetricRow, error) {
	cur, err := s.builtinRow(id)
	if err != nil {
		return models.MetricRow{}, err
	}
	shipped, err := s.shippedExpr(cur)
	if err != nil {
		return models.MetricRow{}, err
	}
	cur.Expr = expr
	saved, err := s.saveMetric(cur, &store.MetricOverrideWrite{Shipped: shipped})
	if err != nil {
		return models.MetricRow{}, err
	}
	return s.withEdited(saved), nil
}

// RestoreBuiltinMetric deletes a builtin metric's override and puts the
// shipped SQL back as its expr. The restore is a semantic change like any
// other, so the metric and its dependents go behind and the sweep recomputes
// them with the shipped statement. A builtin with no override is returned as
// it is (nothing to restore, nothing scheduled).
func (s *MetricsService) RestoreBuiltinMetric(id int64) (models.MetricRow, error) {
	cur, err := s.builtinRow(id)
	if err != nil {
		return models.MetricRow{}, err
	}
	ov, err := s.st.GetBuiltinOverride(store.MetricOverridePrefix + cur.Name)
	if errors.Is(err, store.ErrNotFound) {
		return s.withEdited(cur), nil
	}
	if err != nil {
		return models.MetricRow{}, err
	}
	if strings.TrimSpace(ov.Shipped) == "" {
		return models.MetricRow{}, fmt.Errorf("the shipped expression of %q is not recorded, so it can't be restored", cur.Name)
	}
	cur.Expr = ov.Shipped
	saved, err := s.saveMetric(cur, &store.MetricOverrideWrite{Restore: true})
	if err != nil {
		return models.MetricRow{}, err
	}
	return s.withEdited(saved), nil
}

// builtinRow loads the stored row a builtin edit addresses; any other origin
// is refused (a user metric is edited through SaveMetric).
func (s *MetricsService) builtinRow(id int64) (models.MetricRow, error) {
	if id <= 0 {
		return models.MetricRow{}, errors.New("metric id is required")
	}
	cur, err := s.st.GetMetric(id)
	if err != nil {
		return models.MetricRow{}, err
	}
	if cur.Origin != "builtin" {
		return models.MetricRow{}, fmt.Errorf("%q is not a built-in metric", cur.Name)
	}
	return cur, nil
}

// shippedExpr is the SQL a builtin metric restores to: the shipped text
// recorded on its override, or, with no override yet, its current expr (the
// row is still shipped, since only an override ever changes a builtin's expr).
func (s *MetricsService) shippedExpr(cur models.MetricRow) (string, error) {
	ov, err := s.st.GetBuiltinOverride(store.MetricOverridePrefix + cur.Name)
	if errors.Is(err, store.ErrNotFound) {
		return cur.Expr, nil
	}
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(ov.Shipped) == "" {
		return cur.Expr, nil
	}
	return ov.Shipped, nil
}

// withEdited marks a row whose builtin has an override in place (the Builder's
// "edited" chip and Restore control read it).
func (s *MetricsService) withEdited(m models.MetricRow) models.MetricRow {
	if m.Origin != "builtin" {
		return m
	}
	if _, err := s.st.GetBuiltinOverride(store.MetricOverridePrefix + m.Name); err == nil {
		m.Edited = true
	}
	return m
}

// saveMetric is SaveMetric's body. ov is nil for a user save; for a builtin
// edit or restore it is the override write the save carries (the builtin's
// origin is kept, and only its expr may change).
func (s *MetricsService) saveMetric(m models.MetricRow, ov *store.MetricOverrideWrite) (models.MetricRow, error) {
	m.Name = strings.TrimSpace(m.Name)
	if m.Name == "" {
		return models.MetricRow{}, errors.New("metric name is required")
	}
	m.Title = strings.TrimSpace(m.Title)
	if m.Title == "" {
		m.Title = m.Name
	}
	// Optional short label (like title): trimmed, never required — an
	// empty one keeps the display fallback (short_name || title || name).
	// A filled one is capped at SIX characters (runes, not bytes — it is
	// a width-constrained header label, and every seeded short_name
	// honors the same cap; see schema.sql). Existing over-limit rows are
	// rejected on save, never silently truncated: pre-release, the fix
	// for a stale local seed is a wipe + re-import.
	m.ShortName = strings.TrimSpace(m.ShortName)
	if n := utf8.RuneCountInString(m.ShortName); n > 6 {
		return models.MetricRow{}, fmt.Errorf("short name must be 6 characters or fewer (yours has %d)", n)
	}
	m.Format = strings.TrimSpace(m.Format)
	if !metricFormats[m.Format] {
		return models.MetricRow{}, fmt.Errorf("unknown format %q (valid: int, float1, float2, percent, currency, identity)", m.Format)
	}
	// API path: origin forced to user; plugin rows are the loader's
	// territory (platform_store.ReplacePluginMetrics) and cannot be
	// created or hijacked through here.
	m.Origin = "user"
	m.PluginID = ""
	// Built-ins are immutable through this API, except the override write
	// (SaveBuiltinMetric / RestoreBuiltinMetric), which keeps the origin. The verdict reads the
	// STORED row's origin — never what the caller sent (the payload's
	// origin was just forced to "user" above, so it could not tell us
	// anything anyway). Placement: cheapest-first — one indexed
	// GetMetric BEFORE the compile, so a rejected edit never parses an
	// expression — and only on the update path (m.ID > 0): a CREATE
	// cannot touch a builtin, it can only COLLIDE with one, which stays
	// CreateMetric's uniqueness error (the distinct path, pinned by
	// TestSaveMetricBuiltinGuards).
	var existing models.MetricRow
	if m.ID > 0 {
		var err error
		existing, err = s.st.GetMetric(m.ID)
		if err != nil {
			return models.MetricRow{}, err // unknown id: the store's ErrNotFound, as before
		}
		if existing.Origin == "builtin" && ov == nil {
			return models.MetricRow{}, errors.New("built-in metrics can't be edited")
		}
		if ov != nil {
			if existing.Origin != "builtin" {
				return models.MetricRow{}, fmt.Errorf("%q is not a built-in metric", existing.Name)
			}
			m.Origin = "builtin"
		}
	}
	// The expression is one SELECT or WITH statement, gated by the one save
	// gate (metrics.CheckRawSave). Its scope is derived from its binds
	// (03-QUERIES.md §5, ruling 51), so there is nothing to validate beside
	// it. Its metric() references must name existing metrics; they become
	// its dependency edges.
	gate, perr, err := metrics.CheckRawSave(s.st, m.Expr)
	if err != nil {
		return models.MetricRow{}, err
	}
	if perr != nil {
		return models.MetricRow{}, exprErrorErr(perr)
	}
	m.Touched = gate.Touched
	// metric() references are the statement's dependency edges. A reference
	// that would close a cycle through this metric is refused before any
	// write, using the same walk as the rest of the graph.
	depNames := metrics.RefNames(gate)
	if err := s.checkMetricCycle(m.Name, existing.Name, depNames); err != nil {
		return models.MetricRow{}, err
	}
	if strings.TrimSpace(m.Doc) == "" {
		m.Doc = "Formula: " + m.Expr // PRD §5.16: formula documentation on every metric
	}
	// Design §4's semantic test — the field the version bump answers
	// (expr; scope is derived from it), read off the STORED row
	// before anything is written (the analyticservice.go SetConfig
	// no-op pattern). A create never bumps (the INSERT default starts
	// the counter at 1 and a new metric has no rows — absent → behind
	// already) but DOES schedule the sweep: its rows must be computed.
	semantic := m.ID > 0 && m.Expr != existing.Expr
	created := m.ID == 0
	// ONE transaction: the metric row, its edges wholesale, and (semantic)
	// the version bump for this metric + every transitive dependent —
	// atomic, so nothing is partially behind after commit.
	var saved models.MetricRow
	if ov != nil {
		saved, err = s.st.SaveBuiltinMetric(m, depNames, semantic, *ov)
	} else {
		saved, err = s.st.SaveMetricWithDeps(m, depNames, nil, semantic)
	}
	if err != nil {
		return models.MetricRow{}, err
	}
	// Saving is the explicit trigger that clears a user cancel's hold: a
	// cancelled metric re-runs only when it is saved (or the user runs it
	// again), never on its own.
	released, err := s.st.ReleaseMetricHold(saved.ID)
	if err != nil {
		return models.MetricRow{}, err
	}
	// Invalidation trigger (design §4): behind work exists → sweep now
	// (coalesced — a sweep already running re-resolves the behind set on
	// its follow-up run). Display-only/rename saves deliberately do not
	// schedule: no bump, no recompute — unless they clear a hold, whose
	// metric has no rows and must be computed.
	if created || semantic || released {
		s.scheduleSweep()
	}
	return saved, nil
}

// checkMetricCycle refuses a save whose references would close a cycle
// through the metric being saved. The graph is the stored edges, with the
// saved metric's own out-edges replaced by its new references (and its old
// name's edges dropped on a rename). metrics.FindCycle walks it; a
// self-reference is the one-node cycle.
func (s *MetricsService) checkMetricCycle(name, oldName string, refs []string) error {
	if len(refs) == 0 {
		return nil
	}
	edges, err := s.st.ListMetricEdges()
	if err != nil {
		return err
	}
	if oldName != "" && oldName != name {
		delete(edges, oldName)
	}
	edges[name] = refs
	if cycle := metrics.FindCycle(name, edges); cycle != nil {
		return fmt.Errorf("metric %q would reference itself through a cycle (%s); remove one of the references", name, strings.Join(cycle, " -> "))
	}
	return nil
}

// DeleteMetric removes a user metric. Built-ins are rejected HERE with
// the friendly service copy (store.DeleteMetric's own builtin guard
// stays as the backstop behind it); the stored row is read once up front,
// so an unknown id still reports the store's ErrNotFound exactly as
// before. Plugin rows stay deletable (the plugin host re-seeds them on
// enable) and user rows pass straight through.
//
// AFTER the builtin guard: a metric that other expressions still
// reference is blocked (design §2 — preventable user graph surgery is
// blocked; the copy follows the friendly-uniqueness precedent). The
// system paths never route through here: ReplacePluginMetrics and
// DeletePluginMetrics issue their own `DELETE FROM metrics WHERE
// plugin_id = ?` (platform_store.go) and never call this method, so the
// block can never block a plugin replace — and metric_deps.dep_name has
// NO foreign key precisely so a system-removed upstream leaves its edge
// for the compute pass to resolve-or-fail honestly.
func (s *MetricsService) DeleteMetric(id int64) error {
	existing, err := s.st.GetMetric(id)
	if err != nil {
		return err
	}
	if existing.Origin == "builtin" {
		return errors.New("built-in metrics can't be deleted")
	}
	dependents, err := s.st.MetricDependents(existing.Name)
	if err != nil {
		return err
	}
	if len(dependents) > 0 {
		names := make([]string, len(dependents))
		for i, d := range dependents {
			names[i] = d.Name
		}
		return fmt.Errorf("cannot delete metric %q: referenced by %s — edit or delete those first",
			existing.Name, strings.Join(names, ", "))
	}
	return s.st.DeleteMetric(id)
}

// PreviewMetric refuses until a preview path exists for raw SQL: a
// statement is previewed by saving it, and its values appear once the
// sweep has run it. The one gate still runs first, so a bad statement
// reports its positioned refusal.
func (s *MetricsService) PreviewMetric(id int64, expr string, limit int) (MetricPreview, error) {
	if strings.TrimSpace(expr) == "" {
		full, err := s.GetMetric(id)
		if err != nil {
			return MetricPreview{}, err
		}
		expr = full.Expr
	}
	_, perr, err := metrics.CheckRawSave(s.st, expr)
	if err != nil {
		return MetricPreview{}, err
	}
	if perr != nil {
		return MetricPreview{}, exprErrorErr(perr)
	}
	return MetricPreview{}, errors.New("previewing raw SQL isn't available yet; save the metric and its values appear once it has run")
}

// ---- The canonical value reads (stored-metrics design §5) -----------------
//
// ONE read per value surface, straight through to the store's canonical
// read: fresh rows only, canonical metric order, DTO exactly
// {metricId, subjectKey, dim, value, valueKey} (no stamps — internal-only
// by construction). These are what every view reads for a SAVED metric;
// PreviewMetric stays the on-demand calculator for unsaved/dirty
// drafts, which have no stored rows to read.

// GetMetricValuesForMatch returns the requested metrics' fresh stored
// rows for ONE match (matchID > 0), canonical metric order then
// subject_key; metricIDs empty = every metric.
func (s *MetricsService) GetMetricValuesForMatch(matchID int64, metricIDs []int64) ([]models.MetricValue, error) {
	return s.st.GetMetricValuesForMatch(matchID, metricIDs)
}

// GetMetricValuesForRound returns the requested metrics' fresh stored rows
// for ONE round of one match (matchID > 0, round > 0); metricIDs empty =
// every metric. Round-grain metrics bind :match_id and :round (ruling 41).
func (s *MetricsService) GetMetricValuesForRound(matchID, round int64, metricIDs []int64) ([]models.MetricValue, error) {
	return s.st.GetMetricValuesForRound(matchID, round, metricIDs)
}

// GetMetricValuesForPlayer returns fresh CAREER rows (match_id = 0):
// steamID "" = the whole career bucket (every player — the value
// slot's unit coverage plus Builder's all-players profile preview),
// non-empty = that one player. metricIDs empty = every metric.
func (s *MetricsService) GetMetricValuesForPlayer(steamID string, metricIDs []int64) ([]models.MetricValue, error) {
	return s.st.GetMetricValuesForPlayer(steamID, metricIDs)
}

// GetMetricSeries is the MATCH-grain SERIES read — the third canonical
// grain of the same stored-value contract: one player's fresh rows across
// matches (store.GetPlayerMetricSeries, the read the trend and the
// profile history already use), for the caller's metric set (metricIDs
// empty = every metric). steamID is required — a series is always one
// subject, and an empty id matches no subject key, so it serves an empty
// series rather than a population (store.GetPlayerMetricSeries's guard).
// Fresh rows only, like the two reads above: a match with no fresh row
// comes back as NO POINT, and the view renders the state — never a
// fallback number. Values are the stored numbers as they stand (the
// 0..1 percent convention included): the frontend's fmtMetric applies the
// display scale from the format tag, exactly as it does for the value
// reads.
func (s *MetricsService) GetMetricSeries(steamID string, metricIDs []int64) ([]models.MetricSeriesPoint, error) {
	return s.st.GetPlayerMetricSeries(steamID, metricIDs)
}

// CompileMetric returns the statement a metric runs, for the provenance
// view. Nothing executes: a blank expr shows the SAVED statement by id, and
// a non-blank expr is gated and shown as written.
func (s *MetricsService) CompileMetric(id int64, expr string) (string, error) {
	if strings.TrimSpace(expr) == "" {
		full, err := s.GetMetric(id)
		if err != nil {
			return "", err
		}
		return strings.TrimSpace(full.Expr), nil
	}
	_, perr, err := metrics.CheckRawSave(s.st, expr)
	if err != nil {
		return "", err
	}
	if perr != nil {
		return "", exprErrorErr(perr)
	}
	return strings.TrimSpace(expr), nil
}

// ValidateExpr is the builder's live check: the one gate, the same one save
// runs (metrics.CheckRawSave); the statement is the whole input.
func (s *MetricsService) ValidateExpr(expr string) (bool, ExprError, error) {
	_, perr, err := metrics.CheckRawSave(s.st, expr)
	if err != nil {
		return false, ExprError{}, err
	}
	if perr != nil {
		return false, exprError(perr), nil
	}
	return true, ExprError{}, nil
}
