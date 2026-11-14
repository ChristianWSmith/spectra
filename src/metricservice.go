package main

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/ChristianWSmith/spectra/internal/budget"
	"github.com/ChristianWSmith/spectra/internal/metrics"
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// MetricsService is M5 §2.1: the custom-metric engine. Definitions live in
// the `metrics` table (origin builtin|user|plugin). Expressions are parsed
// into a validated AST (whitelisted tables/columns/ops — never interpolated
// user SQL) and compiled to parameterized SQL. Preview runs against the
// whole library with a row cap; pinned metrics appear as scoreboard/profile
// columns.
//
// W2 (stored-metrics grammar wave) is DONE: the groupBy parameter is gone
// from every signature (Compile/RunPreview/PreviewMetric/ValidateExpr and
// the frontend wrappers), every statement is subject-addressed by the
// engine, and SaveMetric validates + writes the real scope — the W1
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
	Group string  `json:"group"` // group key ("" for none)
	Label string  `json:"label"` // display name (player name etc when resolvable)
	Value float64 `json:"value"`
	N     int     `json:"n"` // sample size behind the value (PRD §5.16)
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

// ---- metric expression grammar (widened — spec lives in ONE place) ----
//
// The full spec (source clause — single-source base form, comma-list
// join extension — plus the aggregation list, the op table, condition
// grammar, Subject/Denominator/Scope rules, join/population semantics,
// percentile and preview semantics) lives in ONE place: the
// internal/metrics package doc (doc.go). This service only forwards
// expressions to metrics.Compile / metrics.RunPreview and maps their
// ParseError onto the ExprError binding shape — no grammar knowledge of
// its own, so the two can never drift.

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
	sweepsOn     bool
	sweepRunning bool
	sweepWanted  bool
	inflight     map[int64]bool   // metrics a live sweep is computing
	errs         map[int64]string // last failure per metric (cleared on success)
	progMu       sync.Mutex       // guards the 100 ms progress throttle
	progLast     time.Time
}

// exprError converts a metrics.ParseError into the ExprError contract and
// a plain error for call paths that only return error.
func exprError(perr *metrics.ParseError) ExprError {
	return ExprError{Message: perr.Message, Pos: perr.Pos}
}

func exprErrorErr(perr *metrics.ParseError) error {
	return fmt.Errorf("metrics: %s (at byte %d)", perr.Message, perr.Pos)
}

// metricFormats are the accepted Format values (contract). float2 keeps
// a two-decimal tail unconditionally (Q6 — the K/D seeds render2.00,
// never the auto-format's "2"); it is a display tag only, no DDL and no
// grammar change.
var metricFormats = map[string]bool{"": true, "int": true, "float1": true, "float2": true, "percent": true, "currency": true}

// ListMetrics returns all definitions (builtin first).
func (s *MetricsService) ListMetrics() ([]models.MetricRow, error) {
	return s.st.ListMetrics()
}

// ListMetricsPage returns ONE keyset window of the same list ListMetrics
// returns (the Builder's "Load more" pagination): the rows after afterID
// (0 = the first window) for the same server-side search query AND the
// same server-side origin filter ("" = all, "builtin", "mine" = user +
// plugin, "none" = the both-toggles-off empty set — the Builder's
// Built-in / My metrics toggles; see store.ListMetricsPage), at most
// limit rows (0 = the store's default window), plus HasNext (another
// window follows) — see store.ListMetricsPage / models.MetricListPage.
// ListMetrics itself stays unbounded for its whole-library readers
// (Match's pinned scoreboard columns, Reports' appendix,
// CommandPalette's search), which are not changing.
func (s *MetricsService) ListMetricsPage(query string, originFilter string, afterID int64, limit int) (*models.MetricListPage, error) {
	return s.st.ListMetricsPage(query, originFilter, afterID, limit)
}

// GetMetric returns one by id (or name).
func (s *MetricsService) GetMetric(id int64) (models.MetricRow, error) {
	if id <= 0 {
		return models.MetricRow{}, errors.New("metrics: metric id is required")
	}
	r, err := s.st.GetMetric(id)
	if errors.Is(err, store.ErrNotFound) {
		return models.MetricRow{}, fmt.Errorf("metrics: no metric with id %d", id)
	}
	if err != nil {
		return models.MetricRow{}, err
	}
	return r, nil
}

// resolveRefs resolves an expression's metric() references against the
// SAVED catalog (design §2): metrics.name is UNIQUE across every origin,
// so name→id resolution is total. Every referenced name must exist (the
// missing-name failure is the positioned "unknown metric reference" —
// the SAME copy CompileRefs spells, so a draft, a preview and a save can
// never disagree) and each target carries the grain + live stamps the
// ref join binds.
//
// dependentScope is the DEPENDENT definition's stored scope and drives
// the cross-scope rule (key containment: a ref resolves iff the
// dependent's row key contains every key column of the dependency's
// grain). "" means the caller has no stored scope — ValidateExpr's
// drafts and ad-hoc previews are authoring state, and a definition's
// scope only exists once it is saved, so those paths resolve existence
// only and leave the rule to the save (which always has a scope).
//
// `known` pre-resolves names the catalog does not carry YET: the rename
// splice re-validates dependents against the metric's NEW name while its
// row still carries the old one (the collision pre-check guarantees the
// new name is otherwise free).
//
// Returns (*ParseError, nil) for parse/resolution failures (the ExprError
// contract — positioned) and (nil, err) for store failures.
func (s *MetricsService) resolveRefs(spec metrics.Spec, dependentScope string, known map[string]metrics.RefTarget) (map[string]metrics.RefTarget, *metrics.ParseError, error) {
	found := metrics.MetricRefs(spec)
	if len(found) == 0 {
		return map[string]metrics.RefTarget{}, nil, nil
	}
	// Live rule stamp: one indexed read of the single-row config — the
	// exact value W3's compute pass stamps fresh metric_values rows with,
	// so a ref join only ever reads rows built under it.
	cfg, err := s.st.GetConfig()
	if err != nil {
		return nil, nil, err
	}
	out := make(map[string]metrics.RefTarget, len(known)+len(found))
	for name, t := range known {
		t.RuleVersion = cfg.RuleVersion
		out[name] = t
	}
	for _, r := range found {
		t, resolved := out[r.Name]
		if !resolved {
			row, err := s.st.GetMetricByName(r.Name)
			if errors.Is(err, store.ErrNotFound) {
				return nil, &metrics.ParseError{
					Message: fmt.Sprintf("unknown metric reference %q", r.Name),
					Pos:     r.Pos,
				}, nil
			}
			if err != nil {
				return nil, nil, err
			}
			t = metrics.RefTarget{ID: row.ID, Scope: row.Scope, Version: row.Version}
			out[r.Name] = t
		}
		// Cross-scope rule (design §2): a PROFILE metric may read a
		// profile ref (and a match metric either grain — the row's player
		// key carries the career scalar), but a career value cannot read
		// a per-match value: the profile row key (steam_id) contains no
		// match_id to correlate on. Applied to EVERY resolved ref,
		// `known` entries included — the rename splice re-validation runs
		// through here with the same rule.
		if dependentScope == "profile" && t.Scope == "match" {
			return nil, nil, fmt.Errorf(
				"metrics: metric '%s' is match-scoped and cannot be used inside a profile-scoped metric (a career value cannot read a per-match value)",
				r.Name)
		}
		t.RuleVersion = cfg.RuleVersion
		out[r.Name] = t
	}
	return out, nil, nil
}

// resolveRefsExpr is resolveRefs over an expression string (parse first)
// — the shape PreviewMetric and ValidateExpr need.
func (s *MetricsService) resolveRefsExpr(expr, dependentScope string) (map[string]metrics.RefTarget, *metrics.ParseError, error) {
	spec, perr := metrics.Parse(expr)
	if perr != nil {
		return nil, perr, nil
	}
	return s.resolveRefs(spec, dependentScope, nil)
}

// checkMetricCycle walks {existing metric_deps edges} ∪ {the saved
// metric's new refs} from the metric being saved (design §2) and rejects
// anything cyclic BEFORE any write — a self-reference is an immediate
// cycle. The walk itself is pure (metrics.FindCycle, no DB); only the
// edge loading happens here, and the graph it walks is the POST-save
// one: a rename's dependents are spliced in the same transaction, so
// their edges to the old name already count as edges to the new one.
func (s *MetricsService) checkMetricCycle(newName, oldName string, refs []string) error {
	edges, err := s.st.ListMetricEdges()
	if err != nil {
		return err
	}
	if oldName != "" && oldName != newName {
		for node, deps := range edges {
			for i, d := range deps {
				if d == oldName {
					deps[i] = newName // the splice rewrites these literals in the same tx
				}
			}
			edges[node] = deps // same backing array — spelled out so the graph edit is visible
		}
		delete(edges, oldName)
	}
	edges[newName] = refs // {existing} with the saved metric's own out-edges replaced by {new}
	if cycle := metrics.FindCycle(newName, edges); cycle != nil {
		return fmt.Errorf("metrics: cyclic metric reference: %s", strings.Join(cycle, " → "))
	}
	return nil
}

// SaveMetric validates + upserts (origin forced to user for API saves;
// plugin metrics are written by the plugin loader; an EXISTING built-in
// row is rejected below — built-ins are immutable through this API).
// Duplicate name → error.
// The frontend echoes rows back as-is; CreatedAt is store-owned (stamped
// on create, untouched on update).
//
// W2b: the validation block below runs in the design's order — guards,
// grammar (Parse), reference resolution (existence → cross-scope), the
// full Compile, the cycle check, the rename splice — and only THEN one
// transaction writes the metric, its metric_deps edges (re-derived
// wholesale from the CURRENT expression) and any dependents' splices.
// Nothing is written until every check passes.
//
// W3 (design §4): a SEMANTIC edit (expr / scope / denominator — the
// three fields the bump answers, compared against the stored row like
// analyticservice.go's SetConfig no-op) bumps this metric's version AND
// every transitive dependent's inside that same transaction, then
// schedules the sweep. A display-only edit (title / shortName / format /
// doc), a no-op save and a rename bump nothing and schedule nothing — a
// rename changes no semantics (W2b's pin, kept).
func (s *MetricsService) SaveMetric(m models.MetricRow) (models.MetricRow, error) {
	m.Name = strings.TrimSpace(m.Name)
	if m.Name == "" {
		return models.MetricRow{}, errors.New("metrics: metric name is required")
	}
	m.Title = strings.TrimSpace(m.Title)
	if m.Title == "" {
		m.Title = m.Name
	}
	// Optional short label (like title): trimmed, never required — an
	// empty one keeps the display fallback (short_name || title || name).
	m.ShortName = strings.TrimSpace(m.ShortName)
	m.Format = strings.TrimSpace(m.Format)
	if !metricFormats[m.Format] {
		return models.MetricRow{}, fmt.Errorf("metrics: unknown format %q (valid: int, float1, float2, percent, currency)", m.Format)
	}
	// Scope is a REAL field since W2: the DDL CHECK admits exactly these
	// two values, so anything else (including an omitted "") is rejected
	// here with the same friendly shape as Format — the API always writes
	// it (the store's '' → 'match' fallback stays for direct
	// CreateMetric/UpdateMetric callers).
	m.Scope = strings.TrimSpace(m.Scope)
	if m.Scope != "match" && m.Scope != "profile" {
		return models.MetricRow{}, fmt.Errorf("metrics: unknown scope %q (valid: match, profile)", m.Scope)
	}
	// API path: origin forced to user; plugin rows are the loader's
	// territory (platform_store.ReplacePluginMetrics) and cannot be
	// created or hijacked through here.
	m.Origin = "user"
	m.PluginID = ""
	// Built-ins are immutable through this API. The verdict reads the
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
		if existing.Origin == "builtin" {
			return models.MetricRow{}, errors.New("metrics: built-in metrics can't be edited")
		}
	}
	// Grammar first (the compile's own first step — ref-free expressions
	// report exactly what they did before W2b): the parse carries the
	// metric() reference spans every later step works from.
	spec, perr := metrics.Parse(m.Expr)
	if perr != nil {
		return models.MetricRow{}, exprErrorErr(perr)
	}
	// A rename onto a name that already exists must fail HERE, before the
	// cycle graph is built: that graph describes the POST-save catalog,
	// and a collision would merge two metrics' edges into one node.
	if m.ID > 0 && m.Name != existing.Name {
		_, err := s.st.GetMetricByName(m.Name)
		if err == nil {
			return models.MetricRow{}, fmt.Errorf("metrics: a metric named %q already exists", m.Name)
		}
		if !errors.Is(err, store.ErrNotFound) {
			return models.MetricRow{}, err
		}
	}
	// The metric resolves its OWN name: it IS the row being written (its
	// grain and — on an edit — its id/version do not change with the
	// name), so a self-reference reaches the CYCLE check below, where it
	// belongs, instead of reporting itself as an unknown name. The
	// create-path version is the INSERT default and is never bound: a
	// self-reference is rejected before any write.
	ownVersion := 1
	if m.ID > 0 {
		ownVersion = existing.Version
	}
	known := map[string]metrics.RefTarget{
		m.Name: {ID: m.ID, Scope: m.Scope, Version: ownVersion},
	}
	// Reference resolution: existence + the cross-scope rule, and the
	// targets Compile binds into the ref joins.
	refs, perr, err := s.resolveRefs(spec, m.Scope, known)
	if err != nil {
		return models.MetricRow{}, err
	}
	if perr != nil {
		return models.MetricRow{}, exprErrorErr(perr)
	}
	// Validate expression (+denominator) BEFORE any write. CompileRefs
	// also enforces the player anchor (a primary without a subject is
	// rejected), so a player-less definition never lands.
	if _, perr := metrics.CompileRefs(m.Expr, m.Denominator, "", refs); perr != nil {
		return models.MetricRow{}, exprErrorErr(perr)
	}
	depNames := metrics.DistinctNames(metrics.MetricRefs(spec))
	// Cycle rejection: pure walk over {existing edges} ∪ {new refs}.
	if err := s.checkMetricCycle(m.Name, existing.Name, depNames); err != nil {
		return models.MetricRow{}, err
	}
	// Rename splice (design §2): a changed name with dependents > 0
	// rewrites each dependent's metric('old') literals with the parse's
	// own spans, re-parses, re-resolves and re-Compile-validates the
	// result, and hands the store a prepared rewrite for the SAME
	// transaction. Any failure errors the save with nothing written.
	// No bump, no recompute: a rename changes no semantics.
	var rewrites []store.DependentRewrite
	if m.ID > 0 && m.Name != existing.Name {
		dependents, err := s.st.MetricDependents(existing.Name)
		if err != nil {
			return models.MetricRow{}, err
		}
		if len(dependents) > 0 {
			// `known` already resolves the metric's NEW name (the row
			// still carries the old one until the tx commits) with the
			// post-save grain — dependents' re-validation reads through
			// it with the same rule.
			for _, dep := range dependents {
				newExpr, perr := metrics.RenameRefs(dep.Expr, existing.Name, m.Name)
				if perr != nil {
					return models.MetricRow{}, exprErrorErr(perr)
				}
				depSpec, perr := metrics.Parse(newExpr)
				if perr != nil {
					return models.MetricRow{}, exprErrorErr(perr)
				}
				depRefs, perr, err := s.resolveRefs(depSpec, dep.Scope, known)
				if err != nil {
					return models.MetricRow{}, err
				}
				if perr != nil {
					return models.MetricRow{}, exprErrorErr(perr)
				}
				if _, perr := metrics.CompileRefs(newExpr, dep.Denominator, "", depRefs); perr != nil {
					return models.MetricRow{}, exprErrorErr(perr)
				}
				rewrites = append(rewrites, store.DependentRewrite{
					ID:   dep.ID,
					Expr: newExpr,
					Deps: metrics.DistinctNames(metrics.MetricRefs(depSpec)),
				})
			}
		}
	}
	if strings.TrimSpace(m.Doc) == "" {
		m.Doc = "Formula: " + m.Expr // PRD §5.16: formula documentation on every metric
	}
	// Design §4's semantic test — exactly the three fields the version
	// bump answers (expr, scope, denominator), read off the STORED row
	// before anything is written (the analyticservice.go SetConfig
	// no-op pattern). A create never bumps (the INSERT default starts
	// the counter at 1 and a new metric has no rows — absent → behind
	// already) but DOES schedule the sweep: its rows must be computed.
	semantic := m.ID > 0 && (m.Expr != existing.Expr ||
		m.Scope != existing.Scope || m.Denominator != existing.Denominator)
	created := m.ID == 0
	// ONE transaction: the metric row, its edges wholesale, the splices,
	// and (semantic) the version bump for this metric + every transitive
	// dependent — atomic, so nothing is partially behind after commit.
	saved, err := s.st.SaveMetricWithDeps(m, depNames, rewrites, semantic)
	if err != nil {
		return models.MetricRow{}, err
	}
	// Invalidation trigger (design §4): behind work exists → sweep now
	// (coalesced — a sweep already running re-resolves the behind set on
	// its follow-up run). Display-only/rename saves deliberately do not
	// schedule: no bump, no recompute.
	if created || semantic {
		s.scheduleSweep()
	}
	return saved, nil
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
		return errors.New("metrics: built-in metrics can't be deleted")
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
		return fmt.Errorf("metrics: cannot delete metric %q: referenced by %s — edit or delete those first",
			existing.Name, strings.Join(names, ", "))
	}
	return s.st.DeleteMetric(id)
}

// PreviewMetric compiles expr (empty expr → use id) and runs it.
// scope: "" = whole library; scope="match:<id>" limits single-match
// sources. The engine addresses every preview row by its subject — there
// is no groupBy argument any more (retired with W2).
//
// W2b: every metric() reference in the expression is resolved against
// the saved catalog first (drafts are CALCULATED — a ref resolves
// against saved metrics, never against other drafts), so a draft with
// refs previews exactly like the save would validate it.
func (s *MetricsService) PreviewMetric(id int64, expr string, scope string, limit int) (MetricPreview, error) {
	var (
		def      metrics.Def
		echo     models.MetricRow
		depScope string // the dependent's stored scope ("" for a draft)
	)
	if strings.TrimSpace(expr) == "" {
		full, err := s.GetMetric(id)
		if err != nil {
			return MetricPreview{}, err
		}
		def = metrics.Def{Expr: full.Expr, Denominator: full.Denominator}
		echo = full
		depScope = full.Scope
	} else {
		// Ad-hoc expression: no denominator (rates are a property of the
		// saved definition); the subject addressing is the engine's.
		def = metrics.Def{Expr: expr}
		echo = models.MetricRow{ID: id, Expr: expr}
	}
	refs, perr, err := s.resolveRefsExpr(def.Expr, depScope)
	if err != nil {
		return MetricPreview{}, err
	}
	if perr != nil {
		return MetricPreview{}, exprErrorErr(perr)
	}
	def.Refs = refs
	// limit ≤0 is normalized inside metrics.RunPreview — the one canonical
	// default (PreviewDefaultRow), never here.
	pv, perr, err := metrics.RunPreview(s.st, def, scope, limit)
	if perr != nil {
		return MetricPreview{}, exprErrorErr(perr)
	}
	if err != nil {
		return MetricPreview{Metric: echo, MS: pv.MS, SQL: pv.SQL}, err
	}
	rows := make([]MetricPreviewRow, len(pv.Rows))
	for i, r := range pv.Rows {
		rows[i] = MetricPreviewRow{Group: r.Group, Label: r.Label, Value: r.Value, N: r.N}
	}
	return MetricPreview{
		Metric: echo, Rows: rows, MS: pv.MS, SQL: pv.SQL, Truncated: pv.Truncated,
	}, nil
}

// ---- The canonical value reads (stored-metrics design §5) -----------------
//
// ONE read per value surface, straight through to the store's canonical
// read: fresh rows only, canonical metric order, DTO exactly
// {metricId, steamId, value, n} (no stamps — internal-only by
// construction). These are what every view reads for a SAVED metric;
// PreviewMetric stays the on-demand calculator for unsaved/dirty
// drafts, which have no stored rows to read.

// GetMetricValuesForMatch returns the requested metrics' fresh stored
// rows for ONE match (matchID > 0), canonical metric order then
// steam_id; metricIDs empty = every metric.
func (s *MetricsService) GetMetricValuesForMatch(matchID int64, metricIDs []int64) ([]models.MetricValue, error) {
	return s.st.GetMetricValuesForMatch(matchID, metricIDs)
}

// GetMetricValuesForPlayer returns fresh CAREER rows (match_id = 0):
// steamID "" = the whole career bucket (every player — the value
// slot's unit coverage plus Builder's all-players profile preview),
// non-empty = that one player. metricIDs empty = every metric.
func (s *MetricsService) GetMetricValuesForPlayer(steamID string, metricIDs []int64) ([]models.MetricValue, error) {
	return s.st.GetMetricValuesForPlayer(steamID, metricIDs)
}

// CompileMetric compiles WITHOUT executing (design §5's no-execution
// Compile): the provenance SQL a clean-saved Builder preview shows
// beside its stored rows — provenance without calculating a value, so
// a saved read never runs the plan. expr "" uses the SAVED definition
// by id (denominator + resolved refs included — exactly what
// PreviewMetric would have run); a non-empty expr is ad-hoc (no
// denominator, refs against the saved catalog). scope binds like
// PreviewMetric's ("" = whole library). Returns the statement(s), never
// a result set; parse/resolution failures come back as the shared
// ExprError-shaped error.
func (s *MetricsService) CompileMetric(id int64, expr string, scope string) (string, error) {
	var (
		def      metrics.Def
		depScope string // the dependent's stored scope ("" for a draft)
	)
	if strings.TrimSpace(expr) == "" {
		full, err := s.GetMetric(id)
		if err != nil {
			return "", err
		}
		def = metrics.Def{Expr: full.Expr, Denominator: full.Denominator}
		depScope = full.Scope
	} else {
		def = metrics.Def{Expr: expr}
	}
	refs, perr, err := s.resolveRefsExpr(def.Expr, depScope)
	if err != nil {
		return "", err
	}
	if perr != nil {
		return "", exprErrorErr(perr)
	}
	def.Refs = refs
	plan, perr := metrics.CompileRefs(def.Expr, def.Denominator, scope, def.Refs)
	if perr != nil {
		return "", exprErrorErr(perr)
	}
	sql := plan.SQL
	if plan.Secondary != "" {
		sql += "\n" + plan.Secondary
	}
	return sql, nil
}

// ValidateExpr parses without executing (builder live-check). The
// grammar check is Compile's — the player anchor included, so a
// player-less draft reports the same positioned error a save would.
// W2b: a draft carrying metric() references is resolved against the
// SAVED catalog first (drafts are calculated; a ref to an unsaved name
// reports the positioned unknown-reference error a save would report).
// The cross-scope rule is deliberately NOT enforced here: ValidateExpr
// carries no scope argument (a draft's scope is authoring state), so
// that definition-level rule stays with the save.
func (s *MetricsService) ValidateExpr(expr string) (bool, ExprError, error) {
	refs, perr, err := s.resolveRefsExpr(expr, "")
	if err != nil {
		return false, ExprError{}, err
	}
	if perr != nil {
		return false, exprError(perr), nil
	}
	if _, perr := metrics.CompileRefs(expr, "", "", refs); perr != nil {
		return false, exprError(perr), nil
	}
	return true, ExprError{}, nil
}
