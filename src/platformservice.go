package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/ChristianWSmith/spectra/internal/data"
	"github.com/ChristianWSmith/spectra/internal/metrics"
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/plugin"
	"github.com/ChristianWSmith/spectra/internal/report"
	"github.com/ChristianWSmith/spectra/internal/sidecar"
	"github.com/ChristianWSmith/spectra/internal/spatial"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// PlatformService is M5 §2.3–2.5 + §2.7: data-explorer reads, spatial
// series (sidecar-derived), declarative plugins, and report rendering.
// Heavy outputs (report files, DB copy) download over HTTP routes under
// /api/export/… in main.go — this service returns small JSON/strings only.

// ProvenancePanel is the per-match reproducibility surface (PRD §9.2):
// every input that shaped the rows on screen.
type ProvenancePanel struct {
	MatchID       int64  `json:"matchId"`
	ParserVersion string `json:"parserVersion"`
	ExtractedAt   string `json:"extractedAt"`
	ParseMS       int64  `json:"parseMs"`
	Warnings      int    `json:"warnings"`
	EncMessages   int    `json:"encMessages"`
	SampleRate    int    `json:"sampleRate"`
	VoiceChunks   int    `json:"voiceChunks"`
	// RuleVersion is the MATCH's own stamp (matches.analyzed_rule_version
	// — the rule_version its derived rows were last computed under), NOT
	// the live config's version: reporting the live one claimed rows were
	// current when they might not be. 0 = never analyzed / unknown —
	// never a real version (analysis_config starts at 1) — and the same
	// missing-data convention as VoiceChunks above (0, no fabricated
	// number).
	RuleVersion int `json:"ruleVersion"`
	// TradeWindowS is the LIVE config's trade window — the rules a
	// re-run would apply; the per-match stamp carries only the version,
	// not the values.
	TradeWindowS float64  `json:"tradeWindowS"`
	Map          string   `json:"map"`
	Status       string   `json:"status"`
	Notes        []string `json:"notes"` // descoped/caveat annotations (e.g. chat.decrypted provenance)
}

// EntitySummary describes what the parser saw (schema-browser-lite; full
// per-prop browser descoped — needs parse-time capture, see M5 status).
type EntitySummary struct {
	EntityClasses int    `json:"entityClasses"`
	EndEntities   int    `json:"endEntities"`
	GenericTypes  int    `json:"genericTypes"`
	GenericTotal  int    `json:"genericTotal"`
	Notes         string `json:"notes"`
}

// SpatialSeries is one recomputable sidecar series (M5 §2.4 subset that
// needs no region polygons): values in world units over time buckets.
type SpatialSeries struct {
	Kind     string    `json:"kind"` // spacing|spread
	Buckets  int       `json:"buckets"`
	FromTick int       `json:"fromTick"`
	ToTick   int       `json:"toTick"`
	Values   []float64 `json:"values"` // same length; -1 = no data (team dead / warmup)
	MS       int64     `json:"ms"`
}

// PluginManifest is the spectra-plugin.json contract (M5 §2.7 v1:
// declarative — metric expressions + report templates only, no scripts).
// Metrics are models.MetricRow with loader-assigned id/origin/pluginId
// (id stays 0 here — manifest rows are pre-persistence).
type PluginManifest struct {
	ID          string             `json:"id"` // slug, unique
	Name        string             `json:"name"`
	Version     string             `json:"version"`
	Author      string             `json:"author,omitempty"`
	Description string             `json:"description,omitempty"`
	Hash        string             `json:"hash,omitempty"`    // sha256 of bundle (share format)
	Metrics     []models.MetricRow `json:"metrics,omitempty"` // origin=plugin filled by loader
	ReportTpls  []ReportTemplate   `json:"reportTpls,omitempty"`
	Extra       map[string]string  `json:"extra,omitempty"`
}

// PluginState is one installed plugin (registry row + manifest).
type PluginState struct {
	Manifest PluginManifest `json:"manifest"`
	Path     string         `json:"path"`
	Enabled  bool           `json:"enabled"`
	Error    string         `json:"error,omitempty"` // validation error if any
}

// ReportTemplate is a report definition (builtin or plugin).
type ReportTemplate struct {
	ID     string `json:"id"` // slug
	Title  string `json:"title"`
	Scope  string `json:"scope"`  // match|player|round
	Format string `json:"format"` // md|html
	Origin string `json:"origin"` // builtin|plugin
	Body   string `json:"body"`   // template source (text/template)
}

// PlatformService — see doc comment above.
type PlatformService struct {
	st  *store.Store
	app *application.App
	// promptPluginPick picks the plugin manifest file; nil = the native
	// dialogs.go chooseFile picker (the ONE plugin-source affordance —
	// w27's file-only ruling; no native dialog on Linux/Windows offers
	// files AND folders at once anyway). Tests inject a fake so both
	// cancel/failure contracts can be exercised without opening a real
	// dialog (the DialogService.promptSave precedent).
	promptPluginPick func() (string, error)
	// afterPluginOp, when set (main wires metricsSvc.scheduleSweep — the
	// same scheduler the startup sweep and a metric save use), runs after
	// EVERY install/enable/disable/remove attempt. It fires on error
	// returns too: the manager mutates metric rows before some of its own
	// failure points (SetEnabled re-inserts/deletes rows before the
	// registry write; Remove deletes rows before the registry/file
	// steps), so an error return can already have changed metric data —
	// and a sweep with no work is a cheap no-op, while a missed sweep
	// leaves exactly the stale rows this hook exists to prevent. This is
	// the whole fix for the owner ruling (2026-11-16): a re-enabled
	// plugin's rows come back with no stored values (the old ones
	// cascade-died) → the behind predicate selects them → the scheduled
	// sweep computes them to fresh; a user metric whose upstream a
	// disable/remove just took away is selected by metrics.Sweep's
	// dangling-dep clause UNCONDITIONALLY (no version bump needed — see
	// internal/metrics/pass.go), so the scheduled sweep phase-1s its
	// stale rows and fails it honestly with `unknown metric reference`
	// instead of leaving it rendering stored values as fresh.
	// scheduleSweep only spawns a goroutine, so the op never waits on
	// the sweep (the startup precedent). Nil in package tests.
	afterPluginOp func()
}

// pluginOpDone runs the optional after-plugin-op hook (nil in package
// tests, which construct the service bare).
func (s *PlatformService) pluginOpDone() {
	if s.afterPluginOp != nil {
		s.afterPluginOp()
	}
}

// --- Data explorer -----------------------------------------------------------

// GetProvenance composes the per-match reproducibility panel: match
// fields + voice presence + the analytics rule config, annotated with
// honest descoped/caveat notes (PRD §9.2).
func (s *PlatformService) GetProvenance(matchID int64) (ProvenancePanel, error) {
	m, err := s.st.GetMatch(matchID)
	if err != nil {
		return ProvenancePanel{}, err
	}
	cfg, err := s.st.GetConfig()
	if err != nil {
		return ProvenancePanel{}, err
	}
	// The match's OWN rule stamp (0 = never analyzed — see the field
	// doc): this is the value the panel must report; the live config's
	// version says nothing about which rules shaped these rows.
	stamp, err := s.st.GetMatchRuleVersion(matchID)
	if err != nil {
		return ProvenancePanel{}, err
	}
	voiceChunks := 0
	matchDir := matchSidecarDir(matchID)
	if pres, err := s.st.GetVoicePresence(matchID); err == nil {
		// Gated on the sidecar index: a presence row whose voice/*.idx is
		// absent counts chunks nothing can play (a match imported before
		// the index moved out of the DB) — the provenance panel reports
		// one honest number, never a stale count.
		if _, oerr := sidecar.OpenVoice(matchDir); oerr == nil {
			voiceChunks = pres.ChunkCount
		} else if !errors.Is(oerr, sidecar.ErrNoVoiceIndex) {
			return ProvenancePanel{}, oerr
		}
	} else if !errors.Is(err, store.ErrNotFound) {
		return ProvenancePanel{}, err
	}

	notes := []string{"entity schema browser descoped (parse-time capture)"}
	if m.EncryptedMessages > 0 {
		// chat.decrypted stays 0 in the DB even when demoinfocs decrypted
		// the stream with a .dem.info key (inner messages dispatch as
		// ordinary chat events) — the honest provenance is presence.KeyFound.
		notes = append(notes, "chat.decrypted stays 0 until an .dem.info-keyed demo")
	}
	rd, err := sidecar.Open(matchDir)
	if err == nil {
		meta := rd.Meta()
		notes = append(notes, fmt.Sprintf("position sidecar format: %s", meta.Encoding))
	} else {
		notes = append(notes, "position sidecar format: none")
	}

	extractedAt := ""
	if !m.ExtractedAt.IsZero() {
		extractedAt = m.ExtractedAt.UTC().Format(time.RFC3339)
	}
	return ProvenancePanel{
		MatchID:       m.ID,
		ParserVersion: m.ParserVersion,
		ExtractedAt:   extractedAt,
		ParseMS:       m.ParseMS,
		Warnings:      m.WarningsCount,
		EncMessages:   m.EncryptedMessages,
		SampleRate:    m.SampleRate,
		VoiceChunks:   voiceChunks,
		RuleVersion:   stamp,
		TradeWindowS:  cfg.TradeWindowS,
		Map:           m.Map,
		Status:        m.Status,
		Notes:         notes,
	}, nil
}

// GetEntitySummary returns parser-scope counts + notes (schema-browser-
// lite; the full per-prop browser needs parse-time capture — descoped).
func (s *PlatformService) GetEntitySummary(matchID int64) (EntitySummary, error) {
	m, err := s.st.GetMatch(matchID)
	if err != nil {
		return EntitySummary{}, err
	}
	hist, err := s.st.GetGenericHistogram(matchID)
	if err != nil {
		return EntitySummary{}, err
	}
	total := 0
	for _, nc := range hist {
		total += nc.Count
	}
	return EntitySummary{
		EntityClasses: m.EntityClasses,
		EndEntities:   m.EndEntityCount,
		GenericTypes:  len(hist),
		GenericTotal:  total,
		Notes:         "entity schema browser descoped (parse-time capture)",
	}, nil
}

// --- Spatial series ----------------------------------------------------------

// GetSpatialSeries computes a sidecar-derived series (kind spacing|spread)
// over time buckets (≤0 → 120). Spacing = average distance between alive
// teammates; spread = mean pairwise distance across all alive players —
// see internal/spatial for the exact per-frame definitions. Values are
// world units; -1 buckets carry no valid sample.
func (s *PlatformService) GetSpatialSeries(matchID int64, kind string, buckets int) (SpatialSeries, error) {
	m, err := s.st.GetMatch(matchID)
	if err != nil {
		return SpatialSeries{}, err
	}
	refs, err := s.st.GetPlayerRefs(matchID)
	if err != nil {
		return SpatialSeries{}, err
	}
	sides := make(map[uint64]string, len(refs))
	for _, r := range refs {
		if id, err := strconv.ParseUint(r.SteamID, 10, 64); err == nil {
			sides[id] = r.Side
		}
	}
	t0 := time.Now()
	ser, err := spatial.Compute(
		filepath.Join(data.MatchesDir(), strconv.FormatInt(matchID, 10)),
		kind, buckets, m.DurationTicks, sides,
	)
	if err != nil {
		return SpatialSeries{}, fmt.Errorf("couldn't compute the spatial series: %w", err)
	}
	return SpatialSeries{
		Kind: ser.Kind, Buckets: ser.Buckets, FromTick: ser.FromTick,
		ToTick: ser.ToTick, Values: ser.Values,
		MS: time.Since(t0).Milliseconds(),
	}, nil
}

// --- Plugins -----------------------------------------------------------------

// pluginManager returns the XDG-rooted plugin manager (manifest/loader in
// internal/plugin; registry rows in the store).
func (s *PlatformService) pluginManager() *plugin.Manager {
	return plugin.NewManager(s.st, plugin.DefaultDir())
}

// ListPlugins scans the plugin directory + registry (invalid manifests listed
// with Error set, never silently dropped).
func (s *PlatformService) ListPlugins() ([]PluginState, error) {
	states, err := s.pluginManager().List()
	if err != nil {
		return nil, err
	}
	out := make([]PluginState, len(states))
	for i, st := range states {
		out[i] = PluginState{
			Manifest: manifestFromPlugin(st.Manifest),
			Path:     st.Path,
			Enabled:  st.Enabled,
			Error:    st.Error,
		}
	}
	return out, nil
}

// InstallPlugin validates + copies the single manifest JSON at
// sourcePath (a folder source is refused — see plugin.Manager.Install).
// Rejects: unknown capability keys, missing id/name/version, hash
// mismatch when provided (M5 §7.5 trust model).
// Metric expressions get a structural check here; the metrics engine
// validates them fully on preview/use.
//
// The sweep trigger fires even on an error return (one rule for all three
// plugin ops): a failed install leaves the metric rows unchanged (the
// replace is transactional), so the sweep is a cheap no-op — while
// SetPluginEnabled/RemovePlugin below CAN fail after their metric-row
// write, where the trigger is load-bearing.
func (s *PlatformService) InstallPlugin(sourcePath string) (PluginState, error) {
	st, err := s.pluginManager().Install(sourcePath)
	s.pluginOpDone()
	if err != nil {
		return PluginState{}, err
	}
	return PluginState{
		Manifest: manifestFromPlugin(st.Manifest),
		Path:     st.Path,
		Enabled:  st.Enabled,
		Error:    st.Error,
	}, nil
}

// choosePluginPath runs the plugin-source picker through the seam and
// folds its result into the picker contract: the chosen path verbatim,
// or "" on cancel AND on dialog failure — the
// LibraryService.ChooseDemoDir / MapPackService.ChooseCS2Dir contract.
func (s *PlatformService) choosePluginPath(native func() (string, error)) string {
	choose := s.promptPluginPick
	if choose == nil {
		choose = native
	}
	path, err := choose()
	if err != nil || path == "" {
		return ""
	}
	return path
}

// ChoosePluginFile opens the native MANIFEST-FILE picker — THE plugin
// source picker (w27: install takes a manifest FILE, never a folder) —
// and returns the chosen path; "" means cancel or dialog failure.
func (s *PlatformService) ChoosePluginFile() string {
	return s.choosePluginPath(func() (string, error) {
		return chooseFile(s.app, "Choose a plugin manifest file")
	})
}

// SetPluginEnabled toggles a plugin (metrics/templates appear/disappear on
// the next list — no restart, acceptance walkthrough 6). The sweep trigger
// fires on both paths like InstallPlugin's: SetEnabled re-inserts or
// deletes the metric rows before the registry write that can still fail.
func (s *PlatformService) SetPluginEnabled(id string, enabled bool) (PluginState, error) {
	st, err := s.pluginManager().SetEnabled(id, enabled)
	s.pluginOpDone()
	if err != nil {
		return PluginState{}, err
	}
	return PluginState{
		Manifest: manifestFromPlugin(st.Manifest),
		Path:     st.Path,
		Enabled:  st.Enabled,
		Error:    st.Error,
	}, nil
}

// RemovePlugin deletes an installed plugin (metrics rows, registry row and
// bundle directory). The sweep trigger fires on both paths: the metric-row
// delete runs first inside the manager, so even a later failure (registry
// row, bundle files) leaves changed rows behind.
func (s *PlatformService) RemovePlugin(id string) error {
	err := s.pluginManager().Remove(id)
	s.pluginOpDone()
	return err
}

// manifestFromPlugin converts the loader's manifest to the service type.
func manifestFromPlugin(m plugin.Manifest) PluginManifest {
	out := PluginManifest{
		ID: m.ID, Name: m.Name, Version: m.Version, Author: m.Author,
		Description: m.Description, Hash: m.Hash, Extra: m.Extra,
	}
	for _, d := range m.Metrics {
		out.Metrics = append(out.Metrics, models.MetricRow{
			Name: d.Name, Title: d.Title, Expr: d.Expr, Scope: d.Scope,
			Format: d.Format, Doc: d.Doc, Origin: "plugin", PluginID: m.ID,
			Denominator: d.Denominator,
		})
	}
	for _, r := range m.ReportTpls {
		out.ReportTpls = append(out.ReportTpls, reportTplFromPlugin(r))
	}
	return out
}

// reportTplFromPlugin converts one plugin template to the service type.
// Attribution rides Origin ("plugin") — the ONE field every template
// list and chip reads (platformservice.go ListReportTemplates), never a
// prefix on the id: ids are plain slugs the manifest owns.
func reportTplFromPlugin(r plugin.ReportTemplate) ReportTemplate {
	return ReportTemplate{
		ID: r.ID, Title: r.Title, Scope: r.Scope, Format: r.Format,
		Origin: "plugin", Body: r.Body,
	}
}

// --- Reports -----------------------------------------------------------------

// ListReportTemplates returns builtin + stored user + enabled-plugin
// templates, in the store's canonical origin rank (builtin → user →
// plugin — store.metricOrder's order, so every origin-partitioned list in
// the app reads the same way). Attribution rides each row's Origin field;
// ids are plain slugs the manifest (builtins, plugins) or the mint
// (user rows) owns.
func (s *PlatformService) ListReportTemplates() ([]ReportTemplate, error) {
	out := []ReportTemplate{}
	for _, t := range report.Builtins() {
		out = append(out, ReportTemplate{
			ID: t.ID, Title: t.Title, Scope: t.Scope, Format: t.Format,
			Origin: t.Origin, Body: t.Body,
		})
	}
	rows, err := s.st.ListReportTemplates()
	if err != nil {
		return out, fmt.Errorf("couldn't load the report templates: %w", err)
	}
	for _, r := range rows {
		out = append(out, reportTemplateFromRow(r))
	}
	states, err := s.pluginManager().List()
	if err != nil {
		return out, fmt.Errorf("couldn't load the report templates: %w", err)
	}
	for _, st := range states {
		if !st.Enabled || st.Error != "" {
			continue
		}
		for _, r := range st.Manifest.ReportTpls {
			out = append(out, reportTplFromPlugin(r))
		}
	}
	return out, nil
}

// reportTemplateFromRow maps a stored row to the service DTO (the
// frontend contract — the store row itself never leaves this layer).
func reportTemplateFromRow(r store.ReportTemplateRow) ReportTemplate {
	return ReportTemplate{
		ID: r.ID, Title: r.Title, Scope: r.Scope, Format: r.Format,
		Origin: r.Origin, Body: r.Body,
	}
}

// RenderReport renders templateID for a target (matchID/steamID/round as
// applicable to scope) → document text (md or html).
func (s *PlatformService) RenderReport(templateID string, matchID int64, steamID string, round int) (string, error) {
	out, _, err := renderReportDoc(s.st, templateID, matchID, steamID, round)
	return out, err
}

// RenderReportDraft renders a DRAFT template body — the Reports Builder's
// Preview of unsaved edits — against a target. It runs the SAME render
// path a stored template takes (renderTemplateDoc below), so a preview
// can never disagree with what Save + RenderReport would produce. scope
// is validated here exactly like SaveReportTemplate (the frontend never
// decides what the renderer accepts) and NOTHING is stored: the body
// reaches the template engine and nowhere else.
func (s *PlatformService) RenderReportDraft(scope, body string, matchID int64, steamID string, round int) (string, error) {
	scope = strings.TrimSpace(scope)
	if err := validateReportScope(scope); err != nil {
		return "", err
	}
	if err := validateReportBody(body); err != nil {
		return "", err
	}
	return renderTemplateDoc(s.st, report.Template{ID: "draft", Title: "draft", Scope: scope, Body: body}, matchID, steamID, round)
}

// validateReportScope / validateReportFormat / validateReportBody are the
// closed vocabularies a report template is stored and rendered under —
// the SAME three the plugin manifest validates its reportTpls against
// (internal/plugin/manifest.go), so a stored row can never hold a value
// the renderer's switch or a later bundle would reject. SaveReportTemplate
// runs all three, RenderReportDraft the scope and body it actually reads.
// Errors are plain user copy: they reach errText verbatim (no package
// prefix, no implementation nouns).
func validateReportScope(scope string) error {
	switch scope {
	case "match", "player", "round":
		return nil
	}
	return fmt.Errorf("a report template's scope must be match, player or round")
}

func validateReportFormat(format string) error {
	switch format {
	case "md", "html":
		return nil
	}
	return fmt.Errorf("a report template's format must be md or html")
}

func validateReportBody(body string) error {
	if strings.TrimSpace(body) == "" {
		return fmt.Errorf("a report template needs a body")
	}
	return nil
}

// SaveReportTemplate persists ONE user template: an empty id CREATES a
// new row (minting the id from the title — see mintReportTemplateID), a
// non-empty id REPLACES the stored row carrying it. Built-in and plugin
// templates are read-only, so the frontend never addresses them here: a
// save aimed at one of theirs sends the FORK shape (an empty id) the
// metric editor uses for the same rule (Builder.svelte's `id: 0` payload
// — saving a read-only source stores a copy as your own).
//
// The row's origin is always "user" regardless of what the caller sent —
// the stored table holds one origin and the read path above composes
// attribution from the column, never from the request.
func (s *PlatformService) SaveReportTemplate(t ReportTemplate) (ReportTemplate, error) {
	scope := strings.TrimSpace(t.Scope)
	format := strings.TrimSpace(t.Format)
	title := strings.TrimSpace(t.Title)
	if title == "" {
		return ReportTemplate{}, fmt.Errorf("a report template needs a title")
	}
	if err := validateReportScope(scope); err != nil {
		return ReportTemplate{}, err
	}
	if err := validateReportFormat(format); err != nil {
		return ReportTemplate{}, err
	}
	if err := validateReportBody(t.Body); err != nil {
		return ReportTemplate{}, err
	}
	body := t.Body
	id := strings.TrimSpace(t.ID)
	if id == "" {
		taken, err := s.reportTemplateIDsInUse()
		if err != nil {
			return ReportTemplate{}, err
		}
		row, err := s.st.CreateReportTemplate(store.ReportTemplateRow{
			ID: mintReportTemplateID(title, taken), Title: title,
			Scope: scope, Format: format, Body: body, Origin: "user",
		})
		if err != nil {
			return ReportTemplate{}, err
		}
		return reportTemplateFromRow(row), nil
	}
	// Replace path. The id must be slug-shaped (the same contract
	// plugin.ValidSlug applies to manifest ids, so a stored id stays
	// bundle-able) and must name a stored row: every other id either
	// fails the shape (a builtin's dotted id) or matches nothing (a
	// plugin's id has no row here), so a read-only source can never be
	// written through this path.
	if !plugin.ValidSlug(id) {
		return ReportTemplate{}, fmt.Errorf("a report template's id must be 2-40 characters of lowercase letters, digits and hyphens")
	}
	row, err := s.st.UpdateReportTemplate(store.ReportTemplateRow{
		ID: id, Title: title, Scope: scope, Format: format, Body: body, Origin: "user",
	})
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return ReportTemplate{}, fmt.Errorf("no report template with that id")
		}
		return ReportTemplate{}, err
	}
	return reportTemplateFromRow(row), nil
}

// DeleteReportTemplate removes ONE stored user template. Only user rows
// exist in report_templates, so there is no builtin/plugin guard to
// mirror from DeleteMetric: an id that names no stored row (a builtin's,
// a plugin's, a typo) yields "no report template with that id" and
// touches nothing.
func (s *PlatformService) DeleteReportTemplate(id string) error {
	if err := s.st.DeleteReportTemplate(strings.TrimSpace(id)); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return fmt.Errorf("no report template with that id")
		}
		return err
	}
	return nil
}

// reportTemplateIDsInUse is every template id already spoken for — the
// builtins, the enabled plugins' templates and the stored user rows — so
// a minted id can never shadow one of them (report.Find resolves the
// FIRST match in the builtin → user → plugin order, so a collision would
// silently hide a template from rendering). The map is built once per
// save; the mint only ever reads it.
func (s *PlatformService) reportTemplateIDsInUse() (func(string) bool, error) {
	taken := map[string]bool{}
	for _, t := range report.Builtins() {
		taken[t.ID] = true
	}
	rows, err := s.st.ListReportTemplates()
	if err != nil {
		return nil, fmt.Errorf("couldn't load the report templates: %w", err)
	}
	for _, r := range rows {
		taken[r.ID] = true
	}
	states, err := s.pluginManager().List()
	if err != nil {
		return nil, fmt.Errorf("couldn't load the report templates: %w", err)
	}
	for _, st := range states {
		if !st.Enabled || st.Error != "" {
			continue
		}
		for _, r := range st.Manifest.ReportTpls {
			taken[r.ID] = true
		}
	}
	return func(id string) bool { return taken[id] }, nil
}

// reportTemplateSlugMax is the plugin manifest's slug ceiling (slugRe's
// {2,40}) spelled here because the mint has to ENFORCE it rather than
// merely check it.
const reportTemplateSlugMax = 40

// slugFold lowercases title and folds every separator (space, punctuation,
// any non-ASCII rune) to ONE hyphen, never leading with one — the fold half
// of the plugin manifest's `^[a-z0-9-]{2,40}$` contract (plugin.ValidSlug),
// shared by the report-template id mint below and BuildPluginBundle's
// name→id derivation. The result may be empty (a title with no letters or
// digits); callers apply their own fallback and the slug ceiling.
func slugFold(title string) string {
	var b strings.Builder
	lastDash := false
	for _, r := range strings.ToLower(title) {
		alnum := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9')
		if alnum {
			b.WriteRune(r)
			lastDash = false
			continue
		}
		// Fold every separator (space, punctuation, any non-ASCII rune)
		// to ONE hyphen, and never lead with one.
		if b.Len() > 0 && !lastDash {
			b.WriteByte('-')
			lastDash = true
		}
	}
	return strings.Trim(b.String(), "-")
}

// mintReportTemplateID turns a title into the id a new user template is
// stored under: slugFold (see above) plus a fallback base and the slug
// ceiling — the plugin manifest's `^[a-z0-9-]{2,40}$` contract
// (plugin.ValidSlug), so a saved template is bundle-able later without
// re-shaping its id. `taken` reports the ids
// already in use; the first free one wins, suffixing -2, -3, … (the base
// is truncated to keep the suffixed id inside the ceiling). A title that
// folds to nothing ("!!!") falls back to a fixed base, which the same
// de-dupe then numbers. The loop terminates: the taken set is finite and
// every iteration mints a distinct id.
func mintReportTemplateID(title string, taken func(string) bool) string {
	base := slugFold(title)
	if base == "" {
		base = "report"
	}
	if len(base) > reportTemplateSlugMax {
		base = strings.TrimRight(base[:reportTemplateSlugMax], "-")
	}
	id := base
	for n := 2; taken(id); n++ {
		suffix := "-" + strconv.Itoa(n)
		head := base
		if cut := reportTemplateSlugMax - len(suffix); len(head) > cut {
			head = strings.TrimRight(head[:cut], "-")
		}
		id = head + suffix
	}
	return id
}

// renderReportDoc resolves templateID against builtins, stored user
// templates and enabled plugin templates, then renders it for the
// target. Shared by PlatformService.RenderReport and the
// /api/export/<id>/report HTTP route. Returns (text, format, error).
func renderReportDoc(st *store.Store, templateID string, matchID int64, steamID string, round int) (string, string, error) {
	tpls, err := reportTemplatesFor(st)
	if err != nil {
		return "", "", err
	}
	tpl, err := report.Find(tpls, templateID)
	if err != nil {
		return "", "", err
	}
	out, err := renderTemplateDoc(st, tpl, matchID, steamID, round)
	if err != nil {
		return "", "", err
	}
	return out, tpl.Format, nil
}

// reportTemplatesFor is THE resolution list every template read shares:
// builtins, then the stored user templates, then the enabled plugins'
// (the builtin → user → plugin origin rank). ListReportTemplates maps the
// same three sources into the service DTO, and renderReportDoc and
// RenderReportDraft resolve through it, so what the list shows and what
// a render finds can never diverge.
func reportTemplatesFor(st *store.Store) ([]report.Template, error) {
	tpls := report.Builtins()
	rows, err := st.ListReportTemplates()
	if err != nil {
		return nil, fmt.Errorf("couldn't load the report templates: %w", err)
	}
	for _, r := range rows {
		tpls = append(tpls, report.Template{
			ID: r.ID, Title: r.Title, Scope: r.Scope, Format: r.Format,
			Origin: r.Origin, Body: r.Body,
		})
	}
	mgr := plugin.NewManager(st, plugin.DefaultDir())
	states, err := mgr.List()
	if err != nil {
		return nil, fmt.Errorf("couldn't load the report templates: %w", err)
	}
	for _, ps := range states {
		if !ps.Enabled || ps.Error != "" {
			continue
		}
		for _, r := range ps.Manifest.ReportTpls {
			tpls = append(tpls, report.Template{
				ID: r.ID, Title: r.Title, Scope: r.Scope, Format: r.Format,
				Origin: "plugin", Body: r.Body,
			})
		}
	}
	return tpls, nil
}

// renderTemplateDoc validates tpl's scope against the target, builds that
// scope's data map and renders tpl's body — THE render path: the
// id-addressed render (renderReportDoc) and the Builder's draft preview
// (RenderReportDraft) both land here, so a preview and a stored render
// can never disagree about how a scope resolves.
func renderTemplateDoc(st *store.Store, tpl report.Template, matchID int64, steamID string, round int) (string, error) {
	switch tpl.Scope {
	case "match":
		data, err := report.BuildMatchData(st, matchID)
		if err != nil {
			return "", err
		}
		return report.Render(tpl.ID, tpl.Body, data)
	case "player":
		data, err := report.BuildPlayerData(st, matchID, steamID)
		if err != nil {
			return "", err
		}
		return report.Render(tpl.ID, tpl.Body, data)
	case "round":
		data, err := report.BuildRoundData(st, matchID, round)
		if err != nil {
			return "", err
		}
		return report.Render(tpl.ID, tpl.Body, data)
	default:
		return "", fmt.Errorf("template %q has an unknown scope %q", tpl.ID, tpl.Scope)
	}
}

// --- Build plugin (the Settings "Build plugin…" dialog) ----------------------

// BuildPluginBundle composes the single-file spectra-plugin.json a shared
// plugin ships as, from the ids the Build-plugin dialog picked, and returns
// the exact text to hand to the native save dialog. The selection is
// re-resolved server-side against STORED rows — only user-origin metrics
// and the stored user report templates qualify (built-ins are immutable and
// a bundled built-in name would replace the recipient's built-in row on
// install; plugin rows belong to their own bundle), so the frontend never
// decides what goes in. The composed bytes are validated exactly like an
// incoming bundle: plugin.ValidateManifest (id slug, name, version, metric
// names/exprs/scopes, template ids/scope/format/body) plus the metrics
// engine's Validate on every expression — a failure is returned verbatim
// through errText. version defaults to 1.0.0. hash stays EMPTY on purpose:
// a single file hashes to its own bytes, so a pin it carried could never
// match ComputeBundleHash and every install would fail on a mismatch.
func (s *PlatformService) BuildPluginBundle(name, version string, metricIDs []int64, templateIDs []string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", fmt.Errorf("a plugin needs a name")
	}
	version = strings.TrimSpace(version)
	if version == "" {
		version = "1.0.0"
	}
	// The id auto-derives from the name through the SAME slug contract the
	// manifest enforces (slugFold above): clamped to the ceiling, then
	// checked against plugin.ValidSlug so a name that folds to fewer than
	// two characters fails here with friendly copy instead of the raw
	// regexp the manifest would quote.
	id := slugFold(name)
	if len(id) > reportTemplateSlugMax {
		id = strings.TrimRight(id[:reportTemplateSlugMax], "-")
	}
	if !plugin.ValidSlug(id) {
		return "", fmt.Errorf("a plugin name needs at least 2 letters or digits")
	}

	man := plugin.Manifest{ID: id, Name: name, Version: version}
	seenMetrics := map[int64]bool{}
	for _, mid := range metricIDs {
		if seenMetrics[mid] {
			continue // TokenSelect already de-dupes; belt for a repeated id
		}
		seenMetrics[mid] = true
		row, err := s.st.GetMetric(mid)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				return "", fmt.Errorf("no metric with that id in your library")
			}
			return "", fmt.Errorf("couldn't load the metrics: %w", err)
		}
		// The eligibility rule: a bundled builtin name would UPSERT over
		// the recipient's immutable built-in row on install, and a plugin
		// row belongs to its own bundle — only yours go in.
		if row.Origin != "user" {
			return "", fmt.Errorf("only your own metrics can go into a plugin (built-in and plugin metrics stay with their source)")
		}
		man.Metrics = append(man.Metrics, plugin.MetricDef{
			Name: row.Name, Title: row.Title, Expr: row.Expr, Scope: row.Scope,
			Format: row.Format, Doc: row.Doc, Denominator: row.Denominator,
		})
	}
	// The stored report_templates table holds ONE origin's rows (every
	// insert writes origin 'user'), so a found row is user-origin by
	// construction — no second origin gate to re-check (the store's own
	// report-template contract).
	rows, err := s.st.ListReportTemplates()
	if err != nil {
		return "", fmt.Errorf("couldn't load the report templates: %w", err)
	}
	seenTpls := map[string]bool{}
	for _, tid := range templateIDs {
		if seenTpls[tid] {
			continue
		}
		seenTpls[tid] = true
		var found bool
		for _, r := range rows {
			if r.ID != tid {
				continue
			}
			found = true
			man.ReportTpls = append(man.ReportTpls, plugin.ReportTemplate{
				ID: r.ID, Title: r.Title, Scope: r.Scope, Format: r.Format, Body: r.Body,
			})
		}
		if !found {
			return "", fmt.Errorf("no report template with that id")
		}
	}

	// The metrics engine's full grammar check — the same pass
	// plugin.Manager.Install runs on an incoming bundle, so a plugin that
	// would fail to install can never be written out.
	for _, d := range man.Metrics {
		if pe := metrics.Validate(d.Expr); pe != nil {
			return "", fmt.Errorf("metric %q: %s", d.Name, pe.Message)
		}
	}
	data, err := json.MarshalIndent(man, "", "  ")
	if err != nil {
		return "", fmt.Errorf("couldn't compose the plugin file: %w", err)
	}
	// Round-trip the composed bytes through the SAME validator an incoming
	// bundle faces — the output is installable by construction.
	if _, err := plugin.ValidateManifest(data); err != nil {
		return "", err
	}
	return string(data), nil
}
