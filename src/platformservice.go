package main

import (
	"errors"
	"fmt"
	"path/filepath"
	"strconv"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/ChristianWSmith/spectra/internal/data"
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
	MatchID       int64    `json:"matchId"`
	ParserVersion string   `json:"parserVersion"`
	ExtractedAt   string   `json:"extractedAt"`
	ParseMS       int64    `json:"parseMs"`
	Warnings      int      `json:"warnings"`
	EncMessages   int      `json:"encMessages"`
	SampleRate    int      `json:"sampleRate"`
	VoiceChunks   int      `json:"voiceChunks"`
	RuleVersion   int      `json:"ruleVersion"`
	TradeWindowS  float64  `json:"tradeWindowS"`
	Map           string   `json:"map"`
	Status        string   `json:"status"`
	Notes         []string `json:"notes"` // descoped/caveat annotations (e.g. chat.decrypted provenance)
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
		RuleVersion:   cfg.RuleVersion,
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
		return SpatialSeries{}, fmt.Errorf("platform: spatial series: %w", err)
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

// InstallPlugin validates + copies a plugin bundle directory (sourcePath on
// disk) or a single manifest JSON. Rejects: unknown capability keys, missing
// id/name/version, hash mismatch when provided (M5 §7.5 trust model).
// Metric expressions get a structural check here; the metrics engine
// validates them fully on preview/use.
func (s *PlatformService) InstallPlugin(sourcePath string) (PluginState, error) {
	st, err := s.pluginManager().Install(sourcePath)
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

// SetPluginEnabled toggles a plugin (metrics/templates appear/disappear on
// the next list — no restart, acceptance walkthrough 6).
func (s *PlatformService) SetPluginEnabled(id string, enabled bool) (PluginState, error) {
	st, err := s.pluginManager().SetEnabled(id, enabled)
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
// bundle directory).
func (s *PlatformService) RemovePlugin(id string) error { return s.pluginManager().Remove(id) }

// manifestFromPlugin converts the loader's manifest to the service type.
func manifestFromPlugin(m plugin.Manifest) PluginManifest {
	out := PluginManifest{
		ID: m.ID, Name: m.Name, Version: m.Version, Author: m.Author,
		Description: m.Description, Hash: m.Hash, Extra: m.Extra,
	}
	for _, d := range m.Metrics {
		out.Metrics = append(out.Metrics, models.MetricRow{
			Name: d.Name, Title: d.Title, Expr: d.Expr, GroupBy: d.GroupBy,
			Format: d.Format, Doc: d.Doc, Origin: "plugin", PluginID: m.ID,
			Denominator: d.Denominator,
		})
	}
	for _, r := range m.ReportTpls {
		out.ReportTpls = append(out.ReportTpls, reportTplFromPlugin(m.ID, r))
	}
	return out
}

// reportTplFromPlugin converts one plugin template to the service type.
func reportTplFromPlugin(pluginID string, r plugin.ReportTemplate) ReportTemplate {
	_ = pluginID // plugin attribution rides the template ID prefix in the UI
	return ReportTemplate{
		ID: r.ID, Title: r.Title, Scope: r.Scope, Format: r.Format,
		Origin: "plugin", Body: r.Body,
	}
}

// --- Reports -----------------------------------------------------------------

// ListReportTemplates returns builtin + enabled-plugin templates.
func (s *PlatformService) ListReportTemplates() ([]ReportTemplate, error) {
	out := []ReportTemplate{}
	for _, t := range report.Builtins() {
		out = append(out, ReportTemplate{
			ID: t.ID, Title: t.Title, Scope: t.Scope, Format: t.Format,
			Origin: t.Origin, Body: t.Body,
		})
	}
	states, err := s.pluginManager().List()
	if err != nil {
		return out, fmt.Errorf("platform: list plugin templates: %w", err)
	}
	for _, st := range states {
		if !st.Enabled || st.Error != "" {
			continue
		}
		for _, r := range st.Manifest.ReportTpls {
			out = append(out, reportTplFromPlugin(st.Manifest.ID, r))
		}
	}
	return out, nil
}

// RenderReport renders templateID for a target (matchID/steamID/round as
// applicable to scope) → document text (md or html).
func (s *PlatformService) RenderReport(templateID string, matchID int64, steamID string, round int) (string, error) {
	out, _, err := renderReportDoc(s.st, templateID, matchID, steamID, round)
	return out, err
}

// renderReportDoc resolves templateID against builtins + enabled plugin
// templates, validates the scope against the target, builds the data map
// and renders. Shared by PlatformService.RenderReport and the
// /api/export/<id>/report HTTP route. Returns (text, format, error).
func renderReportDoc(st *store.Store, templateID string, matchID int64, steamID string, round int) (string, string, error) {
	tpls := report.Builtins()
	mgr := plugin.NewManager(st, plugin.DefaultDir())
	states, err := mgr.List()
	if err != nil {
		return "", "", fmt.Errorf("platform: list plugin templates: %w", err)
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
	tpl, err := report.Find(tpls, templateID)
	if err != nil {
		return "", "", err
	}
	switch tpl.Scope {
	case "match":
		data, err := report.BuildMatchData(st, matchID)
		if err != nil {
			return "", "", err
		}
		out, err := report.Render(tpl.ID, tpl.Body, data)
		return out, tpl.Format, err
	case "player":
		data, err := report.BuildPlayerData(st, matchID, steamID)
		if err != nil {
			return "", "", err
		}
		out, err := report.Render(tpl.ID, tpl.Body, data)
		return out, tpl.Format, err
	case "round":
		data, err := report.BuildRoundData(st, matchID, round)
		if err != nil {
			return "", "", err
		}
		out, err := report.Render(tpl.ID, tpl.Body, data)
		return out, tpl.Format, err
	default:
		return "", "", fmt.Errorf("platform: template %q has unknown scope %q", tpl.ID, tpl.Scope)
	}
}
