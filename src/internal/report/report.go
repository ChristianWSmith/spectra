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
// Metrics carries the metric-backed display cells (design §3.6's Go
// read-back — MetricCells): ADR/HS%/KD/KDA plus every converting
// scoreboard cell (A, Openings, Trades), keyed by the scoreboard row's
// SteamID.
// Utility rows flow as stored; the match template's Tick column renders
// models.UtilityEvent.EffectiveTick (the paired throw's own tick, the
// detonation tick when unpaired), so the report's tick column is
// throw-based like every other time the utility log shows.
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
// Go read-back (dogfooding design §3.6, extended by the inferred
// conversion's Q2 per-half rule, §3.1): the builtin templates render
// ADR / HS% / KD / KDA AND every converting compound half — the match
// tables' A / Openings / Trades cells, the player report's K/D/A
// A-half, both opening pairs, Trades, Best streak and Enemies flashed
// — from the STORED fresh metric rows (one canonical read,
// store.GetMetricValuesForMatch), never from a Go computation and
// never from the scoreboard's passthrough columns. Each cell is
// already formatted for the document — the format-keyed display scale
// (store.MetricDisplayScale: percent ×100) plus the printf precision
// today's templates spelled (ADR %.1f, HS% %.0f, KD %.2f, KDA %.2f; the int
// seeds render their plain count) — and a subject with NO fresh row
// carries the honest dash "—": absent or behind renders the missing
// marker, never a recomputed number and never a fabricated 0 (Q8).
// The RAW halves (K, D, Rounds, MVPs…) stay on the scoreboard's stored
// fields — which source a cell reads is a per-half fact, and no cell
// ever renders a chip (invariant 9).
type MetricCells struct {
	ADR   string
	HSPct string
	KD    string
	// KDA is w13d's conversion: player.md rendered Go's
	// (kills+assists)/MAX(deaths,1) here, and the stored `kda` metric
	// row is that number now (the floored seed closes Q1's edge — a
	// deathless subject divides by 1 on both sides).
	KDA string
	// The W3b converting cells (design §3.1/§6.1). EntryKills/
	// EntryDeaths fill BOTH of player.md's pairs — opening_kills and
	// entry_kills (likewise the deaths halves) are the identical stored
	// columns, so identical columns compose identical cells.
	Assists        string
	EntryKills     string
	EntryDeaths    string
	TradeKills     string
	BestStreak     string
	EnemiesFlashed string
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
	// w13d: player.md's KDA half — the stored `kda` metric row is the
	// number Go's (kills+assists)/MAX(deaths,1) used to print here.
	{seed: "kda", fill: func(c *MetricCells, s string) { c.KDA = s }},
	// W3b (design §3.1/§6.1): the converting compound cells' metric
	// halves — the scoreboard A / Openings / Trades, the player report's
	// K/D/A A-half, both opening pairs, Trades, Best streak, Enemies
	// flashed. entry_kills fills EVERY opening/entry K half (the
	// columns are identical), entry_deaths every D half.
	{seed: "assists", fill: func(c *MetricCells, s string) { c.Assists = s }},
	{seed: "entry_kills", fill: func(c *MetricCells, s string) { c.EntryKills = s }},
	{seed: "entry_deaths", fill: func(c *MetricCells, s string) { c.EntryDeaths = s }},
	{seed: "trade_kills", fill: func(c *MetricCells, s string) { c.TradeKills = s }},
	{seed: "best_streak", fill: func(c *MetricCells, s string) { c.BestStreak = s }},
	{seed: "enemies_flashed", fill: func(c *MetricCells, s string) { c.EnemiesFlashed = s }},
}

// reportCellDash is what a cell renders when the store carries no fresh
// value for the subject (Q8's honest missing marker).
const reportCellDash = "—"

// dashCells is one subject's starting cells: EVERY cell at the honest
// dash until the canonical read fills it — a subject, seed or value the
// read produced no fresh row for (absent, behind, or filtered out of
// the roster) keeps the dash, per half (Q8: never a fabricated 0).
func dashCells() MetricCells {
	return MetricCells{
		ADR: reportCellDash, HSPct: reportCellDash, KD: reportCellDash, KDA: reportCellDash,
		Assists: reportCellDash, EntryKills: reportCellDash, EntryDeaths: reportCellDash,
		TradeKills: reportCellDash, BestStreak: reportCellDash, EnemiesFlashed: reportCellDash,
	}
}

// reportCell formats one FRESH stored value for the document: the
// format-keyed display scale (store.MetricDisplayScale — percent
// stores a 0..1 fraction and renders 0..100) and the printf precision
// the templates used to spell over GetScoreboard's Go-computed columns
// (ADR %.1f, HS% %.0f, KD %.2f, KDA %.2f — exactly the seeds'
// float1/percent/float2 tags). The default arm serves the `int` seeds
// (A, Openings, Trades, Best streak, Enemies flashed): a whole count
// renders plain, no rounding invented for an integer the format tag
// already pins.
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
		cells[r.SteamID] = dashCells()
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
			return nil, err
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
		return nil, err
	}
	for _, v := range values {
		w, ok := byID[v.MetricID]
		if !ok {
			continue
		}
		c, ok := cells[v.SubjectKey]
		if !ok {
			c = dashCells()
		}
		w.fill(&c, reportCell(v.Value, w.format, w.scale))
		cells[v.SubjectKey] = c
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
		return nil, err
	}
	rounds, err := st.GetRounds(matchID)
	if err != nil {
		return nil, err
	}
	econ, err := st.GetEconomy(matchID)
	if err != nil {
		return nil, err
	}
	// No read-time enrichment here: store.GetEconomy already returns the
	// STORED per-side buy classes (round_side_classes — written by
	// analytics.Compute under the run's config; AGENTS.md "Analysis-rule
	// derived values" forbids re-classifying at read time). Report and
	// Economy tab therefore agree by construction, and a match analyzed
	// under older rules shows the same honestly-stale classes in both.
	clutches, err := st.GetClutches(matchID)
	if err != nil {
		return nil, err
	}
	utility, err := st.GetUtility(matchID)
	if err != nil {
		return nil, err
	}
	ctName, tName := teamNames(st, matchID, sb)
	// The metric-backed display cells (design §3.6's Go read-back, Q2's
	// per-half conversion): ONE canonical read of the stored fresh rows
	// for this match fills ADR/HS%/KD/KDA and every converting cell.
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
		return nil, fmt.Errorf("no player was selected for this report")
	}
	m, err := st.GetMatch(matchID)
	if err != nil {
		return nil, err
	}
	sb, err := st.GetScoreboard(matchID, "", false)
	if err != nil {
		return nil, err
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
		return nil, fmt.Errorf("player %s is not in match %d", steamID, matchID)
	}
	prs, err := st.GetPlayerRounds(matchID, steamID)
	if err != nil {
		return nil, err
	}
	// Same read-back as the match scope (design §3.6 + Q2): the player's
	// metric cells (ADR/HS%/KD/KDA and the converting K/D/A, Openings,
	// Trades, Best streak, Enemies flashed halves) come from the stored
	// fresh rows for this match.
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
		return "", fmt.Errorf("couldn't parse the report template %s: %w", id, err)
	}
	var buf bytes.Buffer
	if err := tpl.Execute(&buf, data); err != nil {
		return "", fmt.Errorf("couldn't render the report template %s: %w", id, err)
	}
	return buf.String(), nil
}

// ErrNotFound is returned by Find when no template carries the id.
var ErrNotFound = errors.New("template not found")

// Find returns the template with the given id from ts.
func Find(ts []Template, id string) (Template, error) {
	for _, t := range ts {
		if t.ID == id {
			return t, nil
		}
	}
	return Template{}, fmt.Errorf("%w: %s", ErrNotFound, id)
}
