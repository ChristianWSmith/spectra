package main

import (
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
	MatchID  int64   `json:"matchId"` // the row's match address (team-subject rows at library scope; 0 otherwise)
	Group    string  `json:"group"`   // subject key ("" for none)
	Dim      string  `json:"dim"`     // partition value ("" = unpartitioned)
	Label    string  `json:"label"`   // display name (player name etc when resolvable; an identity row labels its WINNER)
	Value    float64 `json:"value"`
	ValueKey string  `json:"valueKey"` // identity winner's key (argmax rows only — §3.3; "" on numeric rows)
	N        int     `json:"n"`        // sample size behind the value (PRD §5.16; for an identity, the pool)
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
// "user", the Plugin box "plugin"), scope ("match", "profile", "none"),
// subject (the Builder Subject group's checked set — the metrics
// subject axis: "" = every box, "none" = no box, or the canonical
// comma-subset of the three subject tokens player/match/team — see
// store.ListMetricsPage's SUBJECT FILTER note), denominator (the
// Denominator group's checked set as a canonical comma-subset of the
// three bucket tokens rounds/matches/none where "none" names the
// denominator-less rows: "" = every box, "empty" = no box — Reading B,
// 2026-11-16; see store.ListMetricsPage's DENOMINATOR FILTER note) and
// format (the Builder's Type group: "" = every format,
// "none" = none, or the canonical comma-subset of format tokens where
// "auto" names the ” format) — which are the Builder's five SERVER-side
// filter groups (the sixth, Pinning, is a render-time filter over
// localStorage the backend cannot see — see Builder.svelte); see
// store.ListMetricsPage — at most limit rows (0 = the store's default
// window), plus HasNext (another window follows) — see
// store.ListMetricsPage / models.MetricListPage.
// ListMetrics itself stays unbounded for its whole-library readers
// (Match's pinned scoreboard columns, Reports' appendix,
// CommandPalette's search), which are not changing.
func (s *MetricsService) ListMetricsPage(query string, originFilter string, scopeFilter string, subjectFilter string, denomFilter string, formatFilter string, afterID int64, limit int) (*models.MetricListPage, error) {
	return s.st.ListMetricsPage(query, originFilter, scopeFilter, subjectFilter, denomFilter, formatFilter, afterID, limit)
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
func (s *MetricsService) resolveRefs(spec metrics.Spec, dependentScope, dependentSubject string, known map[string]metrics.RefTarget) (map[string]metrics.RefTarget, *metrics.ParseError, error) {
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
			t = metrics.RefTarget{ID: row.ID, Scope: row.Scope, Subject: row.Subject, Version: row.Version}
			out[r.Name] = t
		}
		// Cross-scope rule (design §2): a PROFILE metric may read a
		// profile ref (and a match metric either grain — the row's player
		// key carries the career scalar), but a career value cannot read
		// a per-match value: the profile row key (subject_key at
		// match_id = 0) contains no match_id to correlate on. Applied to
		// EVERY resolved ref, `known` entries included — the rename
		// splice re-validation runs through here with the same rule.
		if dependentScope == "profile" && t.Scope == "match" {
			return nil, nil, fmt.Errorf(
				"metric '%s' is match-scoped and cannot be used inside a profile-scoped metric (a career value cannot read a per-match value)",
				r.Name)
		}
		// Subject × subject rule (metrics expansion §3.1): the
		// DEPENDENT's subject key must contain the referenced metric's
		// — the SAME containment the compile's join refusal spells
		// (metrics.RefSubjectContained), in the save's message style.
		// An empty dependent subject is authoring state (a draft), same
		// as the empty scope above — the save always has both.
		refSubject := t.Subject
		if refSubject == "" {
			refSubject = "player"
		}
		if dependentSubject != "" && !metrics.RefSubjectContained(dependentSubject, refSubject) {
			return nil, nil, fmt.Errorf(
				"metric '%s' is %s-subject and cannot be used inside a %s-subject metric (a reference's subject must be contained by the reading metric's subject)",
				r.Name, refSubject, dependentSubject)
		}
		t.RuleVersion = cfg.RuleVersion
		out[r.Name] = t
	}
	return out, nil, nil
}

// resolveRefsExpr is resolveRefs over an expression string (parse first)
// — the shape PreviewMetric and ValidateExpr need.
func (s *MetricsService) resolveRefsExpr(expr, dependentScope, dependentSubject string) (map[string]metrics.RefTarget, *metrics.ParseError, error) {
	spec, perr := metrics.Parse(expr)
	if perr != nil {
		return nil, perr, nil
	}
	return s.resolveRefs(spec, dependentScope, dependentSubject, nil)
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
		return fmt.Errorf("circular metric reference: %s", strings.Join(cycle, " → "))
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
	// Scope is a REAL field since W2: the DDL CHECK admits exactly these
	// two values, so anything else (including an omitted "") is rejected
	// here with the same friendly shape as Format — the API always writes
	// it (the store's '' → 'match' fallback stays for direct
	// CreateMetric/UpdateMetric callers).
	m.Scope = strings.TrimSpace(m.Scope)
	if m.Scope != "match" && m.Scope != "profile" {
		return models.MetricRow{}, fmt.Errorf("unknown scope %q (valid: match, profile)", m.Scope)
	}
	// Subject × partition (metrics expansion §3.1/§3.2): the addressing
	// vocabulary validates beside Scope/Format with the same friendly
	// shape, an omitted subject reads as the DDL default ("player" —
	// rows that predate the field), and the matrix's INVALID
	// combinations get their own message (plan §3.1: rejected at save
	// time; the career case additionally refuses at compile time, so a
	// swept row can never exist either way).
	m.Subject = strings.TrimSpace(m.Subject)
	if m.Subject == "" {
		m.Subject = "player"
	}
	if m.Subject != "player" && m.Subject != "match" && m.Subject != "team" {
		return models.MetricRow{}, fmt.Errorf("unknown subject %q (valid: player, match, team)", m.Subject)
	}
	m.Partition = strings.TrimSpace(m.Partition)
	if m.Partition != "" && m.Partition != "side" && m.Partition != "map" && m.Partition != "weapon" {
		return models.MetricRow{}, fmt.Errorf("unknown partition %q (valid: side, map, weapon, or none)", m.Partition)
	}
	if m.Scope == "profile" && m.Subject != "player" {
		return models.MetricRow{}, fmt.Errorf(
			"a %s-subject metric can't be profile-scoped (a match or team has no career — pick match scope)", m.Subject)
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
			return models.MetricRow{}, errors.New("built-in metrics can't be edited")
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
			return models.MetricRow{}, fmt.Errorf("a metric named %q already exists", m.Name)
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
		m.Name: {ID: m.ID, Scope: m.Scope, Subject: m.Subject, Version: ownVersion},
	}
	// Reference resolution: existence + the cross-scope and subject ×
	// subject rules, and the targets Compile binds into the ref joins.
	refs, perr, err := s.resolveRefs(spec, m.Scope, m.Subject, known)
	if err != nil {
		return models.MetricRow{}, err
	}
	if perr != nil {
		return models.MetricRow{}, exprErrorErr(perr)
	}
	// Validate expression (+denominator + addressing) BEFORE any write.
	// CompileRefs enforces the subject anchor (a primary without one is
	// rejected), the subject × scope matrix (profile is player-only) and
	// the partition column rule, so a definition that could never
	// compute never lands.
	addr := metrics.Address{Subject: m.Subject, Partition: m.Partition, Profile: m.Scope == "profile"}
	plan, perr := metrics.CompileRefs(m.Expr, m.Denominator, "", addr, refs)
	if perr != nil {
		return models.MetricRow{}, exprErrorErr(perr)
	}
	// The save gate's touched set (the statements the sweep runs), stored
	// beside the expression it was derived from.
	m.Touched = plan.Touched
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
				depRefs, perr, err := s.resolveRefs(depSpec, dep.Scope, dep.Subject, known)
				if err != nil {
					return models.MetricRow{}, err
				}
				if perr != nil {
					return models.MetricRow{}, exprErrorErr(perr)
				}
				depAddr := metrics.Address{Subject: dep.Subject, Partition: dep.Partition, Profile: dep.Scope == "profile"}
				if _, perr := metrics.CompileRefs(newExpr, dep.Denominator, "", depAddr, depRefs); perr != nil {
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

// draftAddress is THE one spelling of a DRAFT's addressing rule (the
// metrics subject axis): subject "" reads as "player" — the DDL default,
// like SaveMetric — and scope contributes its profile half. The Builder's
// live check (ValidateExpr) and the ad-hoc preview leg (PreviewMetric)
// both build their address here, so a draft can never validate clean and
// then false-refuse at preview (or the other way round).
func draftAddress(subject, partition, scope string) metrics.Address {
	if subject = strings.TrimSpace(subject); subject == "" {
		subject = "player" // the DDL default — an omitted subject reads as player, like SaveMetric
	}
	return metrics.Address{Subject: subject, Partition: partition, Profile: scope == "profile"}
}

// PreviewMetric compiles expr (empty expr → use id) and runs it over the
// whole library. The engine addresses every preview row by its subject —
// there is no groupBy argument any more (retired with W2).
//
// Addressing (2026-11-18 — the deferral this leg carried is fulfilled):
// subject, partition and scope are the DRAFT's own addressing — the same
// triple ValidateExpr threads, normalized by draftAddress — instead of
// the zero-value address, which normalized to subject "player" and made
// a match/team-subject draft false-refuse at Preview whenever its lead
// was legal only for its own subject (an argmax draft refused with
// `argmax() needs subject "match"` although the same expression
// validates and saves clean). A saved definition (expr "") reads its
// addressing off its row instead; the three arguments then stay out —
// the row IS the definition. The run itself is library-wide for both
// legs (every caller passes "" as scope; the single-match run extent
// was never used — CompileMetric still binds its "match:<id>" extent
// for provenance).
//
// W2b: every metric() reference in the expression is resolved against
// the saved catalog first (drafts are CALCULATED — a ref resolves
// against saved metrics, never against other drafts), so a draft with
// refs previews exactly like the save would validate it.
//
// The reported SQL is the DISPLAY copy (bound values written in as
// literals — Preview.DisplaySQL); the run itself used the binds.
func (s *MetricsService) PreviewMetric(id int64, expr string, subject string, partition string, scope string, limit int) (MetricPreview, error) {
	var (
		def        metrics.Def
		echo       models.MetricRow
		depScope   string // the dependent's stored scope ("" for a draft)
		depSubject string // the dependent's stored subject ("" for a draft)
	)
	if strings.TrimSpace(expr) == "" {
		full, err := s.GetMetric(id)
		if err != nil {
			return MetricPreview{}, err
		}
		def = metrics.Def{
			Expr: full.Expr, Denominator: full.Denominator,
			Subject: full.Subject, Partition: full.Partition,
			Profile: full.Scope == "profile",
		}
		echo = full
		depScope = full.Scope
		depSubject = full.Subject
	} else {
		// Ad-hoc expression: no denominator (rates are a property of the
		// saved definition); the addressing is the DRAFT's own — the
		// same address the live check validates it under (draftAddress).
		addr := draftAddress(subject, partition, scope)
		def = metrics.Def{Expr: expr, Subject: addr.Subject, Partition: addr.Partition, Profile: addr.Profile}
		echo = models.MetricRow{ID: id, Expr: expr}
	}
	refs, perr, err := s.resolveRefsExpr(def.Expr, depScope, depSubject)
	if err != nil {
		return MetricPreview{}, err
	}
	if perr != nil {
		return MetricPreview{}, exprErrorErr(perr)
	}
	def.Refs = refs
	// limit ≤0 is normalized inside metrics.RunPreview — the one canonical
	// default (PreviewDefaultRow), never here. The run extent is the
	// whole library: `scope` carries the DRAFT's definition scope above,
	// not a run bound (see the doc comment).
	pv, perr, err := metrics.RunPreview(s.st, def, "", limit)
	if perr != nil {
		return MetricPreview{}, exprErrorErr(perr)
	}
	if err != nil {
		return MetricPreview{Metric: echo, MS: pv.MS, SQL: pv.DisplaySQL()}, err
	}
	rows := make([]MetricPreviewRow, len(pv.Rows))
	for i, r := range pv.Rows {
		rows[i] = MetricPreviewRow{MatchID: r.MatchID, Group: r.Group, Dim: r.Dim, Label: r.Label, Value: r.Value, ValueKey: r.ValueKey, N: r.N}
	}
	return MetricPreview{
		Metric: echo, Rows: rows, MS: pv.MS, SQL: pv.DisplaySQL(), Truncated: pv.Truncated,
	}, nil
}

// ---- The canonical value reads (stored-metrics design §5) -----------------
//
// ONE read per value surface, straight through to the store's canonical
// read: fresh rows only, canonical metric order, DTO exactly
// {metricId, subjectKey, value, valueKey, n} (no stamps — internal-only
// by construction). These are what every view reads for a SAVED metric;
// PreviewMetric stays the on-demand calculator for unsaved/dirty
// drafts, which have no stored rows to read.

// GetMetricValuesForMatch returns the requested metrics' fresh stored
// rows for ONE match (matchID > 0), canonical metric order then
// subject_key; metricIDs empty = every metric.
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

// CompileMetric compiles WITHOUT executing (design §5's no-execution
// Compile): the provenance SQL a clean-saved Builder preview shows
// beside its stored rows — provenance without calculating a value, so
// a saved read never runs the plan. expr "" uses the SAVED definition
// by id (denominator + resolved refs included — exactly what
// PreviewMetric would have run); a non-empty expr is ad-hoc (no
// denominator, refs against the saved catalog). scope binds the run
// extent ("" = whole library; "match:<id>" = one match) — the run
// bound, NOT a draft's definition scope like PreviewMetric's scope.
// Returns the statement(s), never
// a result set; parse/resolution failures come back as the shared
// ExprError-shaped error.
//
// DISPLAY ONLY: the returned text has the plan's values written in as
// literals (Plan.DisplaySQL) so what the user copies runs as-is — the
// plan itself still carries binds and nothing here executes. The
// companion statement (percentile mixes) keeps its `?`: its values are
// not carried on the plan, so they are shown honestly uninlined rather
// than inlined wrong.
func (s *MetricsService) CompileMetric(id int64, expr string, scope string) (string, error) {
	var (
		def        metrics.Def
		depScope   string // the dependent's stored scope ("" for a draft)
		depSubject string // the dependent's stored subject ("" for a draft)
	)
	if strings.TrimSpace(expr) == "" {
		full, err := s.GetMetric(id)
		if err != nil {
			return "", err
		}
		def = metrics.Def{
			Expr: full.Expr, Denominator: full.Denominator,
			Subject: full.Subject, Partition: full.Partition,
			Profile: full.Scope == "profile",
		}
		depScope = full.Scope
		depSubject = full.Subject
	} else {
		def = metrics.Def{Expr: expr}
	}
	refs, perr, err := s.resolveRefsExpr(def.Expr, depScope, depSubject)
	if err != nil {
		return "", err
	}
	if perr != nil {
		return "", exprErrorErr(perr)
	}
	def.Refs = refs
	plan, perr := metrics.CompileRefs(def.Expr, def.Denominator, scope,
		metrics.Address{Subject: def.Subject, Partition: def.Partition, Profile: def.Profile}, def.Refs)
	if perr != nil {
		return "", exprErrorErr(perr)
	}
	return plan.DisplaySQL(), nil
}

// ValidateExpr parses without executing (builder live-check). The
// grammar check is Compile's — the player anchor included, so a
// player-less draft reports the same positioned error a save would.
// W2b: a draft carrying metric() references is resolved against the
// SAVED catalog first (drafts are calculated; a ref to an unsaved name
// reports the positioned unknown-reference error a save would report).
//
// Addressing (2026-11-18 — the subject axis reached the editor): the
// check compiles the draft under ITS OWN addressing — subject,
// partition and the profile half of scope (the loaded row's values, or
// a new draft's authoring defaults) instead of the zero-value address,
// which normalized to subject "player" and made every non-player draft
// report a false refusal (the identity built-ins — top_fragger and its
// four siblings — refused to open with `argmax() needs subject "match"`
// although their stored rows compile fine). Subject/partition ARE
// authoring state, exactly like the scope that stays out below, so they
// belong on the live check; the address feeds CompileRefs' subject ×
// scope matrix (profile is still player-only — a match-subject draft
// on profile scope refuses here, as it would at save). draftAddress is
// the one spelling this shares with PreviewMetric's ad-hoc leg, so the
// live check and the preview can never disagree about a draft.
//
// The cross-scope RULE between references is still deliberately NOT
// enforced here: ValidateExpr resolves refs against the saved catalog
// as existence only (a draft's own grain is authoring state), so that
// definition-level rule stays with the save.
func (s *MetricsService) ValidateExpr(expr string, subject string, partition string, scope string) (bool, ExprError, error) {
	refs, perr, err := s.resolveRefsExpr(expr, "", "")
	if err != nil {
		return false, ExprError{}, err
	}
	if perr != nil {
		return false, exprError(perr), nil
	}
	addr := draftAddress(subject, partition, scope)
	if _, perr := metrics.CompileRefs(expr, "", "", addr, refs); perr != nil {
		return false, exprError(perr), nil
	}
	return true, ExprError{}, nil
}
