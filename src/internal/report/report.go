// Package report implements M5 §2.5's templated report generation: Go
// text/template documents (markdown + HTML) rendered in-process from
// store getters — no frontend round-trip, printable, diffable. Builtin
// templates cover the match/player/round scopes (acceptance: "save to a
// report"); declarative plugins may register additional templates with
// the same data maps.
//
// v1 deviation (documented): heatmap PNG embeds, clip links and the zip
// bundle are deferred — the per-match report + the SQLite file copy
// (/api/export/library.db) cover the §2.5 core; CSV/JSON exports ride
// the SQL console client-side.
package report

import (
	"bytes"
	"errors"
	"fmt"
	"strconv"
	"text/template"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// Template is one report definition (builtin or plugin-supplied).
type Template struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Scope  string `json:"scope"`  // match|player|round
	Format string `json:"format"` // md|html
	Origin string `json:"origin"` // builtin|plugin
	Body   string `json:"body"`
}

// MatchReport is the match-scope data map (builtin + plugin templates).
// CTName/TName are the display names of the two teams behind ScoreCT/
// ScoreT — teams, never sides (sides switch at halftime): see teamNames.
// Economy rows carry the STORED per-side buy classes (ClassCT/ClassT/
// ClassWhy*, PistolRound) exactly as store.GetEconomy reads them — no
// report-side enrichment, so report and app agree by construction.
// Metrics carries the metric-backed ADR/HS%/KD cells (design §3.6's Go
// read-back — MetricCells), keyed by the scoreboard row's SteamID.
type MatchReport struct {
	Match       models.Match
	CTName      string
	TName       string
	Scoreboard  []models.PlayerStatsRow
	Rounds      []models.RoundRow
	Economy     []models.EconomyRow
	Clutches    []models.Clutch
	Utility     []models.UtilityEvent
	Metrics     map[string]MetricCells
	GeneratedAt time.Time
}

// PlayerReport is the player-scope data map.
type PlayerReport struct {
	Match       models.Match
	SteamID     string
	Player      models.PlayerStatsRow
	Rounds      []models.PlayerRoundStat
	Metrics     map[string]MetricCells
	GeneratedAt time.Time
}

// MetricCells is one report subject's metric-backed display cells — the
// Go read-back (dogfooding design §3.6): the builtin templates render
// ADR / HS% / KD from the STORED fresh metric rows (one canonical read,
// store.GetMetricValuesForMatch), never from a Go computation and never
// from the scoreboard's passthrough adr/hs_pct columns. Each cell is
// already formatted for the document — the format-keyed display scale
// (store.MetricDisplayScale: percent ×100) plus the printf precision
// today's templates spelled (ADR %.1f, HS% %.0f, KD %.2f) — and a
// subject with NO fresh row carries the honest dash "—": absent or
// behind renders the missing marker, never a recomputed number and
// never a fabricated 0 (Q8).
type MetricCells struct {
	ADR   string
	HSPct string
	KD    string
}

// reportMetricSeeds are the seed names the builtin templates render,
// each bound to the MetricCells field it fills. The seed name is the
// stable identity (ids churn on plugin replace); a definition missing
// from the catalog simply leaves every cell at the dash — the same
// honest-empty contract store.seriesMetricFor gives the trend read.
var reportMetricSeeds = []struct {
	seed string
	fill func(*MetricCells, string)
}{
	{seed: "adr", fill: func(c *MetricCells, s string) { c.ADR = s }},
	{seed: "hs_pct", fill: func(c *MetricCells, s string) { c.HSPct = s }},
	{seed: "kd", fill: func(c *MetricCells, s string) { c.KD = s }},
}

// reportCellDash is what a cell renders when the store carries no fresh
// value for the subject (Q8's honest missing marker).
const reportCellDash = "—"

// reportCell formats one FRESH stored value for the document: the
// format-keyed display scale (store.MetricDisplayScale — percent
// stores a 0..1 fraction and renders 0..100) and the printf precision
// the templates used to spell over GetScoreboard's Go-computed columns
// (ADR %.1f, HS% %.0f, KD %.2f — exactly the seeds' float1/percent/
// float2 tags). The default arm is unreachable for the shipped seeds
// and keeps full precision rather than inventing a rounding.
func reportCell(v float64, format string, scale float64) string {
	switch format {
	case "percent":
		return fmt.Sprintf("%.0f", v*scale)
	case "float1":
		return fmt.Sprintf("%.1f", v*scale)
	case "float2":
		return fmt.Sprintf("%.2f", v*scale)
	default:
		return strconv.FormatFloat(v*scale, 'f', -1, 64)
	}
}

// metricCells resolves the report's seed names → ids and reads this
// match's FRESH rows in ONE canonical read (design §3.6 — never a
// recomputation), returning steamId → the formatted cells. Every roster
// row starts at the dash, so a subject the read produced no row for
// (absent, behind, or filtered out of the roster) keeps it.
func metricCells(st *store.Store, matchID int64, sb []models.PlayerStatsRow) (map[string]MetricCells, error) {
	cells := make(map[string]MetricCells, len(sb))
	for _, r := range sb {
		cells[r.SteamID] = MetricCells{ADR: reportCellDash, HSPct: reportCellDash, KD: reportCellDash}
	}
	type resolved struct {
		id     int64
		format string
		scale  float64
		fill   func(*MetricCells, string)
	}
	want := make([]resolved, 0, len(reportMetricSeeds))
	for _, sc := range reportMetricSeeds {
		def, err := st.GetMetricByName(sc.seed)
		if errors.Is(err, store.ErrNotFound) {
			continue // definition gone → the cells stay at the dash
		}
		if err != nil {
			return nil, fmt.Errorf("report: metric %s: %w", sc.seed, err)
		}
		want = append(want, resolved{id: def.ID, format: def.Format, scale: store.MetricDisplayScale(def.Format), fill: sc.fill})
	}
	if len(want) == 0 {
		return cells, nil
	}
	ids := make([]int64, len(want))
	byID := make(map[int64]resolved, len(want))
	for i, w := range want {
		ids[i] = w.id
		byID[w.id] = w
	}
	values, err := st.GetMetricValuesForMatch(matchID, ids)
	if err != nil {
		return nil, fmt.Errorf("report: metric values: %w", err)
	}
	for _, v := range values {
		w, ok := byID[v.MetricID]
		if !ok {
			continue
		}
		c, ok := cells[v.SteamID]
		if !ok {
			c = MetricCells{ADR: reportCellDash, HSPct: reportCellDash, KD: reportCellDash}
		}
		w.fill(&c, reportCell(v.Value, w.format, w.scale))
		cells[v.SteamID] = c
	}
	return cells, nil
}

// RoundReport is the round-scope data map.
type RoundReport struct {
	Match       models.Match
	Detail      models.RoundDetail
	GeneratedAt time.Time
}

// BuildMatchData composes the match-scope data from store getters.
func BuildMatchData(st *store.Store, matchID int64) (*MatchReport, error) {
	m, err := st.GetMatch(matchID)
	if err != nil {
		return nil, err
	}
	sb, err := st.GetScoreboard(matchID, "", false)
	if err != nil {
		return nil, fmt.Errorf("report: scoreboard: %w", err)
	}
	rounds, err := st.GetRounds(matchID)
	if err != nil {
		return nil, fmt.Errorf("report: rounds: %w", err)
	}
	econ, err := st.GetEconomy(matchID)
	if err != nil {
		return nil, fmt.Errorf("report: economy: %w", err)
	}
	// No read-time enrichment here: store.GetEconomy already returns the
	// STORED per-side buy classes (round_side_classes — written by
	// analytics.Compute under the run's config; AGENTS.md "Analysis-rule
	// derived values" forbids re-classifying at read time). Report and
	// Economy tab therefore agree by construction, and a match analyzed
	// under older rules shows the same honestly-stale classes in both.
	clutches, err := st.GetClutches(matchID)
	if err != nil {
		return nil, fmt.Errorf("report: clutches: %w", err)
	}
	utility, err := st.GetUtility(matchID)
	if err != nil {
		return nil, fmt.Errorf("report: utility: %w", err)
	}
	ctName, tName := teamNames(st, matchID, sb)
	// The metric-backed ADR/HS%/KD cells (design §3.6's Go read-back):
	// ONE canonical read of the stored fresh rows for this match.
	cells, err := metricCells(st, matchID, sb)
	if err != nil {
		return nil, err
	}
	return &MatchReport{
		Match: *m, CTName: ctName, TName: tName, Scoreboard: sb,
		Rounds: rounds, Economy: econ,
		Clutches: clutches, Utility: utility, Metrics: cells,
		GeneratedAt: time.Now().UTC(),
	}, nil
}

// teamNames resolves display names for a match's two teams (the score line
// names teams, never sides — sides switch at halftime): the demo's clan
// names via store.GetTeamNames (one targeted read for this match, not a
// whole-library listing) when the extract recorded them, else a
// synthesized `team_<playerName>` from
// each final side's scoreboard rows (lowest SteamID — deterministic), else
// the bare side when no player records one at all. A GetTeamNames failure
// only costs the real names.
func teamNames(st *store.Store, matchID int64, sb []models.PlayerStatsRow) (ctName, tName string) {
	ctName, tName = synthTeamNames(sb)
	if ct, t, err := st.GetTeamNames(matchID); err == nil {
		if ct != "" {
			ctName = ct
		}
		if t != "" {
			tName = t
		}
	}
	if ctName == "" {
		ctName = "CT"
	}
	if tName == "" {
		tName = "T"
	}
	return ctName, tName
}

// synthTeamNames derives `team_<playerName>` names from a scoreboard's
// final sides — the pick is the lowest SteamID on each side so the name
// doesn't depend on the store's sort order. Sides without a player yield
// "" (teamNames falls back to the bare side).
//
// CROSS-LAYER TWIN: frontend/src/lib/teams.js implements the same
// `team_<player>` synthesis for display-only surfaces (no store access).
// Different layers, deliberately both kept — the fixture is
// TestSynthTeamNames here; the matching JS fixture is
// frontend/src/lib/teams.test.js (same inputs/outputs, same tie-break).
func synthTeamNames(sb []models.PlayerStatsRow) (ctName, tName string) {
	pick := func(side string) string {
		name, steamID := "", ""
		for _, r := range sb {
			if r.Side != side || r.Name == "" {
				continue
			}
			if name == "" || r.SteamID < steamID || (r.SteamID == steamID && r.Name < name) {
				name, steamID = r.Name, r.SteamID
			}
		}
		if name == "" {
			return ""
		}
		return "team_" + name
	}
	return pick("ct"), pick("t")
}

// BuildPlayerData composes the player-scope data: the aggregate row from
// the match scoreboard + the per-round rows.
func BuildPlayerData(st *store.Store, matchID int64, steamID string) (*PlayerReport, error) {
	if steamID == "" {
		return nil, fmt.Errorf("report: player scope needs a steamId")
	}
	m, err := st.GetMatch(matchID)
	if err != nil {
		return nil, err
	}
	sb, err := st.GetScoreboard(matchID, "", false)
	if err != nil {
		return nil, fmt.Errorf("report: scoreboard: %w", err)
	}
	var agg models.PlayerStatsRow
	found := false
	for _, r := range sb {
		if r.SteamID == steamID {
			agg, found = r, true
			break
		}
	}
	if !found {
		return nil, fmt.Errorf("report: player %s not in match %d", steamID, matchID)
	}
	prs, err := st.GetPlayerRounds(matchID, steamID)
	if err != nil {
		return nil, fmt.Errorf("report: player rounds: %w", err)
	}
	// Same read-back as the match scope (design §3.6): the player's
	// ADR/HS%/KD cells come from the stored fresh rows for this match.
	cells, err := metricCells(st, matchID, sb)
	if err != nil {
		return nil, err
	}
	return &PlayerReport{
		Match: *m, SteamID: steamID, Player: agg, Rounds: prs,
		Metrics: cells, GeneratedAt: time.Now().UTC(),
	}, nil
}

// BuildRoundData composes the round-scope data (round + economy + events
// + chat).
func BuildRoundData(st *store.Store, matchID int64, round int) (*RoundReport, error) {
	m, err := st.GetMatch(matchID)
	if err != nil {
		return nil, err
	}
	det, err := st.GetRoundDetail(matchID, round)
	if err != nil {
		return nil, err
	}
	return &RoundReport{Match: *m, Detail: *det, GeneratedAt: time.Now().UTC()}, nil
}

// Render executes template body against data and returns the document.
func Render(id, body string, data any) (string, error) {
	tpl, err := template.New(id).Parse(body)
	if err != nil {
		return "", fmt.Errorf("report: parse template %s: %w", id, err)
	}
	var buf bytes.Buffer
	if err := tpl.Execute(&buf, data); err != nil {
		return "", fmt.Errorf("report: render %s: %w", id, err)
	}
	return buf.String(), nil
}

// ErrNotFound is returned by Find when no template carries the id.
var ErrNotFound = errors.New("report: template not found")

// Find returns the template with the given id from ts.
func Find(ts []Template, id string) (Template, error) {
	for _, t := range ts {
		if t.ID == id {
			return t, nil
		}
	}
	return Template{}, fmt.Errorf("%w: %s", ErrNotFound, id)
}
