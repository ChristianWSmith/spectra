package main

import (
	"errors"
	"fmt"
	"math"
	"path/filepath"
	"slices"
	"strconv"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/ChristianWSmith/spectra/internal/analytics"
	"github.com/ChristianWSmith/spectra/internal/data"
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/sidecar"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// AnalyticsService is the M3 control plane: analysis config/rules, the
// per-match derived views (economy, classifications, KAST rounds, clutches,
// engagements, utility, heatmaps), and saved filter presets. Heavy rows are
// computed by internal/analytics after import (worker stage "analyze") and
// read back through here.
//
// Row vocabulary: every derived view is served AS a models type
// (models.AnalysisConfig, EconomyRow, RoundClassification, PlayerRoundStat,
// Engagement, CombatStat, SavedFilterRow) — their JSON tags are the
// frontend contract and the store returns them directly, so there is no
// copy loop to drift. Two twins are deliberately kept below, each for a
// shape the models type does not have.

// ClutchRow is a detected 1vN (clutch v2 — alive-count analysis).
// ReplayAnchorTick = start_tick for deep
// link. KEPT (not models.Clutch): the synthetic per-row ID the frontend
// keys its list on (models.Clutch has no id — rows are stored, not
// identified) and the replayAnchorTick tag the UI reads (models tags it
// replayAnchor).
type ClutchRow struct {
	ID           int64  `json:"id"`
	Round        int    `json:"round"`
	Size         int    `json:"size"` // 1vN → N
	SteamID      string `json:"steamId"`
	Name         string `json:"name"`
	StartTick    int    `json:"startTick"`
	EndTick      int    `json:"endTick"`
	BombState    string `json:"bombState"` // planted|carried|dropped|none
	HPLeft       int    `json:"hpLeft"`
	Equip        int    `json:"equip"`
	Won          bool   `json:"won"`
	KillTicks    string `json:"killTicks"` // JSON array of int
	ReplayAnchor int    `json:"replayAnchorTick"`
}

// UtilityRow is one grenade with position/impact detail (utility_events).
// KEPT (not models.UtilityEvent): DetX/DetY are value floats — a missing
// detonation position reads 0, while models.UtilityEvent carries
// *float64 + omitempty, which would drop the key and render NaN in the
// utility grid.
type UtilityRow struct {
	Tick        int     `json:"tick"`
	Round       int     `json:"round"`
	Thrower     string  `json:"thrower"`
	ThrowerName string  `json:"throwerName"`
	Kind        string  `json:"kind"` // he|flash|smoke|molotov|incendiary|decoy
	DetX        float64 `json:"detX"`
	DetY        float64 `json:"detY"`
	Damage      int     `json:"damage"`
	FlashMs     int     `json:"flashMsTotal"`
	Affected    string  `json:"affected"` // JSON array of steamIDs
	Site        string  `json:"site"`
}

// HeatmapFilter selects the sample population for a heatmap.
//
// ZMin/ZMax restrict the population to ONE map-pack layer's world-Z band
// (the frontend sends the band of the floor its selector is on), so a
// multi-floor raster never paints another floor's samples on this floor's
// radar — one raster cannot be split per floor, hence no "all floors"
// band. The band is HALF-OPEN [ZMin, ZMax): inclusive low bound,
// exclusive high bound, the shared boundary claimed by the band whose
// zMin it is. That convention is canonical in
// frontend/src/lib/replay/layers.js layerIndexForZ ("Band convention" —
// THE rule for z→layer assignment) and is spelled out for pack authors in
// frontend/public/maps/README.md (`layers` z_min/z_max); this Go twin
// exists only because the sample pass runs server-side and must agree
// with that rule cell for cell. A nil bound is open on that side; both
// nil = no band = every sample counts (what a single-floor pack sends —
// today's behavior, unchanged).
//
// IncludeUnknownZ admits samples with no usable Z (missing or
// non-finite — they cannot be placed in any band): the frontend sets it
// for layer 0 only, mirroring layerIndexForZ's "missing Z → the default
// layer (index 0)" rule. A finite Z outside the band is dropped whether
// or not the flag is set.
type HeatmapFilter struct {
	RoundFrom       int      `json:"roundFrom"`       // <0 = all
	RoundTo         int      `json:"roundTo"`         // <0 = all
	SteamID         string   `json:"steamId"`         // "" = all players
	Team            string   `json:"team"`            // "" | ct | t
	ZMin            *float64 `json:"zMin"`            // band low bound, inclusive (nil = open)
	ZMax            *float64 `json:"zMax"`            // band high bound, exclusive (nil = open)
	IncludeUnknownZ bool     `json:"includeUnknownZ"` // count samples with a missing/non-finite Z
}

// zInBand reports whether a sample with world Z z belongs to the
// selected layer's band (hasZ = false when the sample carries no Z at
// all). The half-open test and the missing-Z→default fallback are
// layerIndexForZ's rules (frontend/src/lib/replay/layers.js, cited on
// HeatmapFilter) restated for the server-side sample pass; with no band
// (both bounds nil) every sample counts, exactly as before layers
// existed.
func (f HeatmapFilter) zInBand(z float64, hasZ bool) bool {
	if f.ZMin == nil && f.ZMax == nil {
		return true
	}
	if !hasZ || math.IsNaN(z) || math.IsInf(z, 0) {
		return f.IncludeUnknownZ
	}
	if f.ZMin != nil && z < *f.ZMin {
		return false
	}
	if f.ZMax != nil && z >= *f.ZMax {
		return false
	}
	return true
}

// HeatmapGrid is a server-computed raster over the map-pack bounds
// (world units → grid cells; streamed from the sidecar, never fully loaded
// client-side).
type HeatmapGrid struct {
	Kind    string  `json:"kind"` // presence|kills|deaths|damage|<util>_<thrown|det>|kd (kd: the signed combine, GetHeatmapKD)
	W       int     `json:"w"`
	H       int     `json:"h"`
	MinX    float64 `json:"minX"`
	MinY    float64 `json:"minY"`
	MaxX    float64 `json:"maxX"`
	MaxY    float64 `json:"maxY"`
	Max     float64 `json:"max"`
	Samples int     `json:"samples"`
	// Pad is the world-unit reach of the splat kernel the raster was
	// rendered with (= heatmapPad in heatmap.go — the 3σ reach every
	// extent is padded by). The wire carries it so the region drill can
	// expand the CLICKED CELL by it: a cell's value is the
	// Gaussian-smeared sum of everything within pad, so the events whose
	// splat can reach the cell live in cell ± pad — the raw ~30×36u cell
	// edges hold almost no event endpoints (the drill that handed those
	// edges over queried a region nothing had painted). Every grid carries
	// it, empty rasters included (one contract, no zero special case).
	Pad   float64   `json:"pad"`
	Cells []float64 `json:"cells"` // row-major w*h, time-weighted (seconds) or counts
}

// heatmapGridSide/heatmapPad and the raster arithmetic live in heatmap.go
// (shared by the presence and event kinds).

// AnalyticsService — see doc comment above. Background recompute state
// (in-flight runs) lives in rc; progress/completion is announced on the
// app's event bus (event consts below).
type AnalyticsService struct {
	st  *store.Store
	app *application.App
	rc  recomputeRunner
}

// Event names emitted by AnalyticsService. Deliberately NOT
// spectra:job-progress / spectra:job-done: those payloads key a jobId in
// the Library's job store (services.js jobProgress map), and neither a
// heatmap generate nor a re-run analysis is a library job — no jobs-table
// row, no job event (mappackservice.go eventAssetProgress carries the same
// rule for asset extraction).
//
//	heatmap-progress — progress ONLY (it changes no row, so it never
//	  enters services.js's read-cache flush list; only Heatmaps' chip
//	  subscribes).
//	analysis-progress — progress ONLY, same rule (queued run started).
//	analysis-done     — the DATA change: the recompute replaced the match's
//	  derived rows, so services.js flushes the read cache on this one.
const (
	eventHeatmapProgress  = "spectra:heatmap-progress"
	eventAnalysisProgress = "spectra:analysis-progress"
	eventAnalysisDone     = "spectra:analysis-done"
)

// heatmapProgressMinInterval throttles spectra:heatmap-progress to at
// most one per 100 ms — the same cadence as library.go's
// progressMinInterval and mappackservice.go's assetProgressMinInterval.
const heatmapProgressMinInterval = 100 * time.Millisecond

// The presence heatmap's two phases (the payload's stage values). "load"
// reads + decodes the sidecar stream — its denominator is real: the frame
// count out of the stream's total (sidecar meta Frames for a whole
// match). "raster" builds extents/cells over the already-decoded frames
// in memory — a phase with no honest work denominator the payload could
// carry, so it rides done/total 0/0 (indeterminate + truthful stage,
// exactly what the loading ladder allows — never an invented percent).
const (
	heatmapStageLoad   = "load"
	heatmapStageRaster = "raster"
)

// HeatmapProgressEvent is the payload of spectra:heatmap-progress: one
// generate's phase progress ({stage, done, total} — the shape
// AssetProgressEvent set for progress payloads, minus the family key:
// one emitter, one family, the heatmap). done/total count frames during
// "load"; total 0 marks an indeterminate phase.
type HeatmapProgressEvent struct {
	Stage string `json:"stage"`
	Done  int    `json:"done"`
	Total int    `json:"total"`
}

// heatmapProgressFor returns the spectra:heatmap-progress callback for a
// generate on a service that holds an app handle — the production adapter
// over heatmapProgress (the throttled emitter). A nil app (services
// constructed without a handle, as the package tests do) means no
// emitter: heatmapPresence turns a nil callback into a no-op.
func heatmapProgressFor(app *application.App) func(stage string, done, total int) {
	if app == nil {
		return nil
	}
	return heatmapProgress(func(ev HeatmapProgressEvent) {
		app.Event.Emit(eventHeatmapProgress, ev)
	})
}

// heatmapProgress builds the per-phase progress callback GetHeatmap wires
// into heatmapPresence — THE one spectra:heatmap-progress emitter.
// Emission goes through emit (production: app.Event.Emit via
// heatmapProgressFor; tests: a recorder), throttled to
// heatmapProgressMinInterval with two never-throttled exemptions: a STAGE
// change (the chip must switch phases immediately, never render the old
// phase's numbers against the new stage) and the closing call
// (total > 0 && done >= total — the bar lands on the end instead of
// stalling short of it).
func heatmapProgress(emit func(HeatmapProgressEvent)) func(stage string, done, total int) {
	return throttledHeatmapProgress(heatmapProgressMinInterval, emit)
}

// throttledHeatmapProgress is heatmapProgress with the throttle window
// passed in — the seam the tests use to pin the drop rule without racing
// the real clock (production always passes heatmapProgressMinInterval via
// heatmapProgress).
func throttledHeatmapProgress(window time.Duration, emit func(HeatmapProgressEvent)) func(stage string, done, total int) {
	if emit == nil {
		return nil
	}
	var last time.Time
	lastStage := ""
	return func(stage string, done, total int) {
		now := time.Now()
		complete := total > 0 && done >= total
		if !last.IsZero() && stage == lastStage && !complete && now.Sub(last) < window {
			return
		}
		last, lastStage = now, stage
		emit(HeatmapProgressEvent{Stage: stage, Done: done, Total: total})
	}
}

// GetConfig returns the active analysis rules (defaults seeded on first use).
func (s *AnalyticsService) GetConfig() (models.AnalysisConfig, error) {
	return s.st.GetConfig()
}

// SetConfig stores new rules and bumps rule_version ONLY when a value
// actually changed: saving the four thresholds identical to the stored
// row is a NO-OP — no store write, no bump, the current row returned
// untouched (clicking Save must not push every match behind by itself).
// When any of tradeWindowS / ecoFullBuy / ecoForce / tradeOppDistance
// differs, the stored version bumps by exactly 1. The input's
// RuleVersion is ignored in BOTH cases — the stored version is
// authoritative. Does NOT recompute — call RecomputeAnalysis per match
// (or RecomputeAll for the behind set) explicitly.
//
// Why every one of the four STAYS in the compare (owner ruling
// 2026-11-12 — AGENTS.md "Analysis-rule derived values"): all four are
// analysis-rule inputs whose outputs are STORED at analyze time, so a
// save must bump → every analyzed match goes behind → RecomputeAll
// rewrites the stored rows under the new rules. tradeOppDistance changes
// the match_trade_opps counts (analytics.Compute applies it at analyze
// time, not at read time); ecoFullBuy/ecoForce change the stored
// round_classifications labels AND the per-side round_side_classes the
// Economy tab and the reports read; tradeWindowS changes
// player_stats.trade_kills. A value that only affected a read could be
// excluded from this compare; none of the four is one of those — before
// this ruling the eco pair still had a read-time consumer
// (analytics.EconomyRows), which is exactly why the Economy tab could
// show new thresholds while the round chips showed old labels until a
// re-run.
//
// This is the single validation gate for analysis rules (the import
// pipeline's analyze path and RecomputeAnalysis read the already-validated
// row straight from the store).
func (s *AnalyticsService) SetConfig(c models.AnalysisConfig) (models.AnalysisConfig, error) {
	if c.TradeWindowS <= 0 {
		return models.AnalysisConfig{}, errors.New("trade window must be at least 1 second")
	}
	if c.EcoForce <= 0 || c.EcoFullBuy <= 0 {
		return models.AnalysisConfig{}, errors.New("buy thresholds must be at least $1")
	}
	if c.EcoForce > c.EcoFullBuy {
		return models.AnalysisConfig{}, errors.New("force-buy threshold can't be higher than the full-buy threshold")
	}
	if c.TradeOppDistance < 0 {
		return models.AnalysisConfig{}, errors.New("trade-opportunity distance can't be negative")
	}
	cur, err := s.st.GetConfig()
	if err != nil {
		return models.AnalysisConfig{}, err
	}
	// Identical values → return the stored row as-is: no SetConfig write,
	// no bump (owner ruling — a Save that changes nothing must leave
	// every match's behind-state alone). The caller's RuleVersion stays
	// ignored here too, so a client-sent version can never leak through.
	if c.TradeWindowS == cur.TradeWindowS && c.EcoFullBuy == cur.EcoFullBuy &&
		c.EcoForce == cur.EcoForce && c.TradeOppDistance == cur.TradeOppDistance {
		return cur, nil
	}
	c.RuleVersion = cur.RuleVersion + 1 // input RuleVersion ignored — bump on CHANGE
	return s.st.SetConfig(c)
}

// --- Background recompute ----------------------------------------------------
//
// RecomputeAnalysis SUBMITS the compute: analytics.Compute runs on a
// goroutine, so the binding returns as soon as the run is queued — the
// Settings dialog can close and the user can navigate away while it
// continues. The outcome rides events instead of the call's return:
//
//	spectra:analysis-progress {matchId, stage, done, total} — a submitted
//	  run actually started. stage is models.StageAnalyze; done/total are
//	  0/0 (indeterminate): analytics.Compute exposes no cheap per-stage
//	  counters, so the indicator is an honest indeterminate bar with a
//	  truthful stage — never a fabricated percentage.
//	spectra:analysis-done {matchId, error} — the run REPLACED the match's
//	  derived rows (error "" on success, the failure text otherwise).
//	  This is the data-change signal: services.js's listener beside the
//	  recomputeAnalysis wrapper flushes the read cache HERE, at
//	  completion — invalidating at submission would let the next read
//	  re-cache pre-compute rows and serve them stale.
//
// Runs are deduped per match (a second submit while one is in flight is a
// no-op whose events keep driving the UI) and SERIALIZED on one slot:
// analytics.Compute ends in store.RebuildCareer, a read-modify-write over
// EVERY match's player_stats — two overlapping Computes could commit a
// career rollup built from a pre-recompute snapshot (the store is
// single-connection, but each Compute issues separate transactions).
//
// RecomputeAll is the BULK twin: it resolves the behind set server-side
// (store.MatchListFilter.Behind), reads the config ONCE, and queues one
// run per id through the same slot and the same per-match events (the UI
// counts the N analysis-done). Its runs use analytics.ComputeForBatch —
// no per-match career rebuild; the runner rebuilds career ONCE inside the
// last batch member's slot hold (see submitBatch). Tradeoff, deliberate:
// if the process dies mid-batch, that deferred rebuild never happens and
// player_career stays stale until the next Compute (an import or a single
// recompute) or a match delete rebuilds it — no crash-recovery machinery
// is added for it. A single RecomputeAnalysis interleaved with a batch
// keeps today's per-run rebuild (its own Compute owns it).
//
// AnalysisProgressEvent / AnalysisDoneEvent are the two payloads; the
// progress one is progress-only (never a cache flush), the done one is
// the data change.

// AnalysisProgressEvent is the payload of spectra:analysis-progress — a
// queued background recompute starting its compute.
type AnalysisProgressEvent struct {
	MatchID int64  `json:"matchId"`
	Stage   string `json:"stage"` // models.StageAnalyze
	Done    int    `json:"done"`  // 0 — indeterminate (see RecomputeAnalysis)
	Total   int    `json:"total"` // 0 — indeterminate
}

// AnalysisDoneEvent is the payload of spectra:analysis-done — one
// background recompute's outcome; Error is "" on success.
type AnalysisDoneEvent struct {
	MatchID int64  `json:"matchId"`
	Error   string `json:"error"`
}

// RecomputeState is RecomputeStates' answer: the in-flight background
// recomputes, split by whether they hold the compute slot (running) or
// wait for it (queued) — the remount rehydration read for Settings'
// per-match indicator.
type RecomputeState struct {
	Running []int64 `json:"running"`
	Queued  []int64 `json:"queued"`
}

// recomputeRunner tracks and serializes background recomputes. Zero value
// ready to use (maps are created under mu on first submit); emit/compute
// are passed per submit so the tests can drive it with a fake compute and
// a recorder while production uses AnalyticsService's app handle.
type recomputeRunner struct {
	mu      sync.Mutex
	queued  map[int64]bool
	running map[int64]bool
	slot    sync.Mutex // one compute at a time (serialization rationale above)
}

// careerBatch is one submitBatch's deferred career rebuild: remaining is
// how many of its members have not finished their compute yet. It is
// seeded with the ACCEPTED count before any member is spawned, and the
// member that drives it to zero runs rebuild while still holding the
// compute slot — so a bulk run rebuilds career exactly once, never
// interleaved with another run.
type careerBatch struct {
	remaining int
	rebuild   func() error
}

// markQueued records matchID as queued; false when it is already queued
// or running (the per-match dedupe — no second run).
func (r *recomputeRunner) markQueued(matchID int64) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.queued == nil {
		r.queued = map[int64]bool{}
	}
	if r.running == nil {
		r.running = map[int64]bool{}
	}
	if r.queued[matchID] || r.running[matchID] {
		return false
	}
	r.queued[matchID] = true
	return true
}

// spawn runs one already-queued match on a new goroutine: wait for the
// slot, flip queued → running (emitting analysis-progress), run compute,
// then flip running → gone and emit analysis-done. batch is nil for a
// single run; a batch member decrements its shared remaining count after
// its compute and the one reaching zero runs the batch's deferred career
// rebuild — still inside this run's slot hold, before its analysis-done
// leaves (so the UI's last done of the batch implies the rebuild ran).
func (r *recomputeRunner) spawn(matchID int64, emit func(name string, payload any), compute func() error, batch *careerBatch) {
	go func() {
		r.slot.Lock() // one run at a time — see the serialization rationale
		defer r.slot.Unlock()
		r.mu.Lock()
		delete(r.queued, matchID)
		r.running[matchID] = true
		r.mu.Unlock()
		emit(eventAnalysisProgress, AnalysisProgressEvent{
			MatchID: matchID, Stage: models.StageAnalyze, Done: 0, Total: 0,
		})
		err := compute()
		if batch != nil {
			r.mu.Lock()
			batch.remaining--
			last := batch.remaining == 0 && batch.rebuild != nil
			r.mu.Unlock()
			if last {
				// The batch's ONE career rebuild (RebuildCareer is a
				// full-library rollup — 16-34 s per rebuild at 1,000
				// matches, so N per-match rebuilds would dominate a bulk
				// run). A failure rides THIS member's analysis-done: the
				// members' own passes succeeded and are stamped; the
				// rollup is what lagged (it self-heals on the next
				// Compute or match delete).
				if rbErr := batch.rebuild(); rbErr != nil && err == nil {
					err = fmt.Errorf("rebuild career: %w", rbErr)
				}
			}
		}
		r.mu.Lock()
		delete(r.running, matchID)
		r.mu.Unlock()
		msg := ""
		if err != nil {
			msg = err.Error()
		}
		emit(eventAnalysisDone, AnalysisDoneEvent{MatchID: matchID, Error: msg})
	}()
}

// submit queues compute on a new goroutine for matchID and returns false
// when that match is already queued or running (dedupe — no second run).
// It returns as soon as the run is queued: the goroutine first waits for
// the slot, then flips queued → running (emitting analysis-progress) and
// runs compute, then flips running → gone and emits analysis-done.
func (r *recomputeRunner) submit(matchID int64, emit func(name string, payload any), compute func() error) bool {
	if !r.markQueued(matchID) {
		return false
	}
	r.spawn(matchID, emit, compute, nil)
	return true
}

// submitBatch queues every id that is not already in flight as ONE batch
// (the rest are skipped by the same per-match dedupe as submit) and
// returns (submitted, skipped) — RecomputeAll's honest k/N. The accepted
// members share a careerBatch: career is rebuilt exactly ONCE, after their
// last compute, inside that member's slot hold (see spawn). The whole id
// list is resolved under mu BEFORE any member spawns, so a fast member
// can never decrement the count while later ids are still being accepted.
// An empty accepted set rebuilds nothing — the runs it would have joined
// already own their own rebuild.
func (r *recomputeRunner) submitBatch(ids []int64, emit func(name string, payload any), compute func(id int64) error, rebuild func() error) (submitted, skipped int) {
	r.mu.Lock()
	if r.queued == nil {
		r.queued = map[int64]bool{}
	}
	if r.running == nil {
		r.running = map[int64]bool{}
	}
	accepted := make([]int64, 0, len(ids))
	for _, id := range ids {
		if r.queued[id] || r.running[id] {
			skipped++
			continue
		}
		r.queued[id] = true // also dedupes a repeated id inside ids
		accepted = append(accepted, id)
	}
	r.mu.Unlock()
	if len(accepted) == 0 {
		return 0, skipped
	}
	batch := &careerBatch{remaining: len(accepted), rebuild: rebuild}
	for _, id := range accepted {
		id := id
		r.spawn(id, emit, func() error { return compute(id) }, batch)
	}
	return len(accepted), skipped
}

// states reports the in-flight matches (sorted — map order is random).
func (r *recomputeRunner) states() RecomputeState {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := RecomputeState{Running: []int64{}, Queued: []int64{}}
	for id := range r.running {
		out.Running = append(out.Running, id)
	}
	for id := range r.queued {
		out.Queued = append(out.Queued, id)
	}
	slices.Sort(out.Running)
	slices.Sort(out.Queued)
	return out
}

// RecomputeAnalysis re-runs classification + analytics for one match under
// the current rules and refreshes career rollups — IN THE BACKGROUND: it
// returns as soon as the run is queued (only the config read is
// synchronous), and the outcome arrives as spectra:analysis-done. A match
// already queued or running is a no-op. See the background-recompute
// block above for the events and the serialization rule.
func (s *AnalyticsService) RecomputeAnalysis(matchID int64) error {
	c, err := s.st.GetConfig()
	if err != nil {
		return err
	}
	cfg := analytics.ConfigFrom(c, 0)
	st := s.st
	s.rc.submit(matchID, s.emitEvent, func() error {
		return analytics.Compute(st, matchID, cfg)
	})
	return nil
}

// RecomputeStates reports the in-flight background recomputes — what a
// freshly (re)mounted Settings uses to keep an already-running run's
// indicator honest.
func (s *AnalyticsService) RecomputeStates() RecomputeState {
	return s.rc.states()
}

// RecomputeAllResult is RecomputeAll's answer — honest k/N for the
// "re-run everything behind" button: Submitted runs were queued, Skipped
// were already queued or running (the runner's per-match dedupe), Total
// is the behind set resolved at submission (Submitted + Skipped == Total;
// Total 0 = nothing is behind).
type RecomputeAllResult struct {
	Submitted int `json:"submitted"`
	Skipped   int `json:"skipped"`
	Total     int `json:"total"`
}

// RecomputeAll SUBMITS a background re-run of every match behind the
// current rules (store.MatchListFilter.Behind: ready AND an older
// analyzed_rule_version — 0/never counts as behind). The set is resolved
// SERVER-SIDE at submission, so the button can never act on a stale
// client list; every id goes through the same runner as
// RecomputeAnalysis — per-match dedupe, the single compute slot, and the
// per-match spectra:analysis-progress / spectra:analysis-done events the
// UI counts its N dones from (nothing about the per-match event contract
// changes).
//
// Config capture: the rules are read ONCE, before the first submit, and
// the SAME analytics.Config rides every run of the batch — so every member
// computes AND stamps one rule_version (a save-rules change mid-batch
// therefore lands on the next batch, never half of this one).
//
// Career: the members run analytics.ComputeForBatch (no per-match
// RebuildCareer) and the runner rebuilds career ONCE after the last
// member, inside the compute slot — see the background-recompute block
// above for the crash tradeoff (mid-batch death leaves player_career
// stale until the next compute/rebuild; deliberate, no recovery
// machinery). Returns the counts as soon as the runs are queued.
func (s *AnalyticsService) RecomputeAll() (RecomputeAllResult, error) {
	behind, err := s.st.ListMatches("", "", false, store.MatchListFilter{Behind: true})
	if err != nil {
		return RecomputeAllResult{}, err
	}
	ids := make([]int64, len(behind))
	for i, m := range behind {
		ids[i] = m.ID
	}
	// ONE config read for the whole batch (see the doc above).
	c, err := s.st.GetConfig()
	if err != nil {
		return RecomputeAllResult{}, err
	}
	cfg := analytics.ConfigFrom(c, 0)
	st := s.st
	submitted, skipped := s.rc.submitBatch(ids, s.emitEvent,
		func(id int64) error { return analytics.ComputeForBatch(st, id, cfg) },
		func() error { return st.RebuildCareer() },
	)
	return RecomputeAllResult{Submitted: submitted, Skipped: skipped, Total: len(ids)}, nil
}

// emitEvent sends payload on the app's event bus; a service constructed
// without an app handle (the package tests) emits nothing.
func (s *AnalyticsService) emitEvent(name string, payload any) {
	if s.app == nil {
		return
	}
	s.app.Event.Emit(name, payload)
}

// GetEconomy returns per-round economy + buy classes (warmup rounds
// excluded). EVERYTHING rule-shaped in the result is a STORED read: the
// per-side classes come from round_side_classes and the round label from
// round_classifications (both written by analytics.Compute at analyze
// time under the run's config), so the rows are uniformly stale until a
// rules change bumps rule_version → behind → RecomputeAll — never a mix
// of new-threshold side chips against old-threshold round chips (AGENTS.md
// "Analysis-rule derived values"). Loss bonus stays a read-time
// reconstruction (hardcoded CS2 loss-count rules — not a config rule) and
// the inferred flags label it.
func (s *AnalyticsService) GetEconomy(matchID int64) ([]models.EconomyRow, error) {
	return s.st.GetEconomy(matchID)
}

// GetRoundClasses returns stored classifications.
func (s *AnalyticsService) GetRoundClasses(matchID int64) ([]models.RoundClassification, error) {
	return s.st.GetRoundClasses(matchID)
}

// GetPlayerRounds returns per-round rows for one player ("" = all players).
func (s *AnalyticsService) GetPlayerRounds(matchID int64, steamID string) ([]models.PlayerRoundStat, error) {
	return s.st.GetPlayerRounds(matchID, steamID)
}

// GetClutches returns clutch v2 records.
func (s *AnalyticsService) GetClutches(matchID int64) ([]ClutchRow, error) {
	rows, err := s.st.GetClutches(matchID)
	if err != nil {
		return nil, err
	}
	out := make([]ClutchRow, len(rows))
	for i, r := range rows {
		out[i] = ClutchRow{
			ID: int64(i + 1), Round: r.Round, Size: r.Size, SteamID: r.SteamID, Name: r.Name,
			StartTick: r.StartTick, EndTick: r.EndTick, BombState: r.BombState, HPLeft: r.HPLeft,
			Equip: r.Equip, Won: r.Won, KillTicks: r.KillTicks, ReplayAnchor: r.ReplayAnchor,
		}
	}
	return out, nil
}

// GetEngagements returns detected engagements; kind "" = all.
func (s *AnalyticsService) GetEngagements(matchID int64, kind string) ([]models.Engagement, error) {
	return s.st.GetEngagements(matchID, kind)
}

// GetUtility returns per-grenade rows.
func (s *AnalyticsService) GetUtility(matchID int64) ([]UtilityRow, error) {
	rows, err := s.st.GetUtility(matchID)
	if err != nil {
		return nil, err
	}
	out := make([]UtilityRow, len(rows))
	for i, r := range rows {
		u := UtilityRow{
			Tick: r.Tick, Round: r.Round, Thrower: r.Thrower, ThrowerName: r.ThrowerName,
			Kind: r.Kind, Damage: r.Damage, FlashMs: r.FlashMs, Affected: r.Affected, Site: r.Site,
		}
		if r.DetX != nil {
			u.DetX = *r.DetX
		}
		if r.DetY != nil {
			u.DetY = *r.DetY
		}
		out[i] = u
	}
	return out, nil
}

// GetCombatStats returns per-player engagement/damage deep-dive rows
// (computed from stored rows; TradeOppMissed is inferred — UI badge).
func (s *AnalyticsService) GetCombatStats(matchID int64) ([]models.CombatStat, error) {
	return s.st.GetCombatStats(matchID)
}

// GetHeatmap computes a raster for kind presence|kills|deaths|damage or
// one of the per-grenade kinds "<util>_thrown" / "<util>_det"
// (grenadeHeatmapKinds in heatmap.go; the signed kills−deaths combine is
// GetHeatmapKD). presence streams the M2 sidecar; kills use the
// attacker's position (where the killer was), deaths/damage the victim's/
// hit position; the grenade kinds plot the throw origin (grenade_throw
// pos_*) or the blast position (grenade pos_*) of ONE utility kind
// (models.UtilityWeaponKind — Molotov ≡ Incendiary). Filters are
// applied server-side:
// presence by round range via the tick↔round spans — with every frame
// inside a round's freeze window skipped (inFreezeTime — freeze time is
// not live play, so the spawns never weigh the raster) — + steam/team via
// the slot table; events by round, attacker (kills, and both grenade flavors —
// the thrower) or victim (deaths/damage) and their side in that round
// (exact freeze-end samples —
// a round without them resolves no side, so a team filter drops it) and
// the layer z band (HeatmapFilter's half-open [ZMin,ZMax) — the pack's
// own layer band, cited there). Bounds
// come from the sampled extents ± heatmapPad — 450u, the 3σ reach of the
// Gaussian splat (sigma 150u), so an edge sample paints a whole blob
// instead of a clipped half; the grid is 128×128 with per-axis cell sizes;
// presence cells are dwell seconds (1/sample-rate per frame per player),
// event cells are counts. presence emits spectra:heatmap-progress while it
// works (throttled, honest denominators — heatmapProgress).
func (s *AnalyticsService) GetHeatmap(matchID int64, kind string, f HeatmapFilter) (HeatmapGrid, error) {
	switch kind {
	case "presence", "kills", "deaths", "damage":
	default:
		if _, ok := grenadeHeatmapKinds[kind]; !ok {
			return HeatmapGrid{}, fmt.Errorf("analytics: unknown heatmap kind %q", kind)
		}
	}
	// ONE round read feeds both shapes the heatmap needs: the canonical
	// store.GetRoundInfos (warmup/pregame included — callers filter) plus
	// the Number/StartTick/EndTick projection store.RoundForTick's domain
	// type takes (the shared tick→round mapping, same helper the voice
	// writer uses).
	roundInfos, err := s.st.GetRoundInfos(matchID)
	if err != nil {
		return HeatmapGrid{}, err
	}
	roundSpans := make([]models.Round, len(roundInfos))
	for i, r := range roundInfos {
		// FreezeEndTick rides along so presence can skip each round's
		// freeze window (the stored round clock — inFreezeTime below).
		roundSpans[i] = models.Round{Number: r.Number, StartTick: r.StartTick,
			EndTick: r.EndTick, FreezeEndTick: r.FreezeEndTick}
	}
	// Team filters resolve sides from the extractor's exact per-round
	// freeze-end samples: a round (or player) without a stored sample
	// resolves "" there, so a team filter excludes it — sides are never
	// guessed from final sides here.
	exact, err := s.st.GetRoundPlayerSides(matchID)
	if err != nil {
		return HeatmapGrid{}, err
	}
	sideAt := func(steamID string, round int) string { return exact[round][steamID] }
	if kind == "presence" {
		// The one phase with real work (sidecar read + decode + two frame
		// passes) carries the honest progress emitter; the event kinds are
		// a single indexed query plus small in-memory loops and emit
		// nothing — the frontend chip stays indeterminate for them, which
		// is truthful.
		return s.heatmapPresence(matchID, f, roundSpans, sideAt, heatmapProgressFor(s.app))
	}
	return s.heatmapEvents(matchID, kind, f, sideAt)
}

// inFreezeTime is the Go twin of THE freeze-phase predicate,
// frontend/src/lib/rounds.js freezeWindowAt / inFreezeTime (that file is
// the canonical home of the rule — this side exists only because the
// presence raster runs server-side): true while tick sits inside a
// round's FREEZE time — round start ≤ tick < freezeEndTick, half-open,
// so the freeze-end frame itself is live play — and only when the row
// carries a USABLE window (freezeEnd > start: the warmup row ships 0 and
// a corrupt row may ship fe ≤ start; neither may ever skip a frame it
// does not actually know about, so both read as "no freeze"). The window
// is the stored round clock, rounds.start_tick → rounds.freeze_end_tick
// (read through store.GetRoundInfos; CS2.md "Competitive round clock" —
// a round splits into FREEZE TIME then ROUND TIME, no assumed duration).
// Rounds are chronological and non-overlapping, so the row whose start
// reaches tick (last one wins, tie → first — the frontend's scan) is the
// round roundAt resolved for the same tick.
func inFreezeTime(rounds []models.Round, tick int) bool {
	best := -1
	for i, r := range rounds {
		if r.StartTick > tick {
			continue
		}
		if best < 0 || r.StartTick > rounds[best].StartTick {
			best = i
		}
	}
	if best < 0 {
		return false
	}
	r := rounds[best]
	return r.FreezeEndTick > r.StartTick && tick < r.FreezeEndTick
}

// heatmapPresence streams the whole sidecar stream and accumulates
// time-weighted dwell per cell.
//
// FREEZE TIME IS NOT COUNTED: every frame whose tick falls inside a
// round's freeze window is skipped in BOTH passes (inFreezeTime — the
// stored start→freezeEnd interval), so the buy phase can no longer weigh
// the T/CT spawns unfairly. The skip is on the frame (dwell is per
// player-frame), before either the extent or the add pass sees it.
// Round range (inRoundRange) and warmup/knife rows are handled exactly as
// before: the round control governs which rounds count (an open range
// still includes knife/warmup rounds — the same population the event
// kinds select), and only freeze time is dropped now.
//
// The layer z band (f.zInBand) is applied in BOTH passes: the extent
// pass (so the raster's bounds — the raster is bounds-derived, see
// newHeatmapRaster — describe only the kept samples) and the add pass
// (so no dropped sample deposits dwell).
//
// progress is the spectra:heatmap-progress callback (nil = no emitter,
// as the package tests build the service): "load" rides sidecar
// LoadProgress's real frame denominator, "raster" starts with the
// indeterminate 0/0 — see the heatmapStage consts.
func (s *AnalyticsService) heatmapPresence(matchID int64, f HeatmapFilter, rounds []models.Round, sideAt func(string, int) string, progress func(stage string, done, total int)) (HeatmapGrid, error) {
	emit := progress
	if emit == nil {
		emit = func(string, int, int) {}
	}
	// Whole sidecar stream, decoded with honest per-block progress
	// (sidecar.LoadProgress = Open → block walk → DecodeFrames per block —
	// the Load steps; the denominator is the stream's frame count known
	// from the meta before the first read).
	stream, err := sidecar.LoadProgress(filepath.Join(data.MatchesDir(), strconv.FormatInt(matchID, 10)), 0, 0,
		func(done, total int) { emit(heatmapStageLoad, done, total) })
	if err != nil {
		return HeatmapGrid{}, fmt.Errorf("analytics: heatmap presence: %w", err)
	}
	frames := stream.Frames
	sampleRate := stream.Meta.SampleRate
	if sampleRate <= 0 {
		sampleRate = sidecar.SampleRate
	}
	dt := 1.0 / float64(sampleRate)

	keep := func(steamID string, round int) bool {
		if f.SteamID != "" && steamID != f.SteamID {
			return false
		}
		if f.Team != "" && sideAt(steamID, round) != f.Team {
			return false
		}
		return true
	}
	inRoundRange := func(round int) bool {
		if f.RoundFrom >= 0 && round < f.RoundFrom {
			return false
		}
		if f.RoundTo >= 0 && round > f.RoundTo {
			return false
		}
		return true
	}
	// Shared tick→round mapping (store.RoundForTick — the same helper the
	// voice writer uses): (round, found).
	roundAt := func(tick int) (int, bool) { return store.RoundForTick(rounds, tick) }

	// Raster phase: extents → cells over the decoded frames in memory —
	// honestly indeterminate (0/0) with a truthful stage; the load phase's
	// frame numbers must not be shown against it.
	emit(heatmapStageRaster, 0, 0)
	// Sampled extents (every 8th frame) for the bounds, then the shared
	// raster (bounds → pad → cells; see heatmap.go).
	minX, minY := math.Inf(1), math.Inf(1)
	maxX, maxY := math.Inf(-1), math.Inf(-1)
	for i, fr := range frames {
		if i%8 != 0 {
			continue
		}
		rn, ok := roundAt(fr.Tick)
		if !ok || !inRoundRange(rn) {
			continue
		}
		// Freeze frames are not live play: they set no extent (inFreezeTime
		// — the same skip the add pass applies, or the bounds would
		// describe samples the dwell pass drops).
		if inFreezeTime(rounds, fr.Tick) {
			continue
		}
		for _, p := range fr.Players {
			sid := strconv.FormatUint(p.SteamID, 10)
			if !keep(sid, rn) || !f.zInBand(p.Z, true) {
				continue
			}
			minX, minY = math.Min(minX, p.X), math.Min(minY, p.Y)
			maxX, maxY = math.Max(maxX, p.X), math.Max(maxY, p.Y)
		}
	}
	if math.IsInf(minX, 1) {
		return HeatmapGrid{Kind: "presence", W: heatmapGridSide, H: heatmapGridSide,
			Pad: heatmapPad, Cells: make([]float64, heatmapGridSide*heatmapGridSide)}, nil
	}
	g := newHeatmapRaster(minX, minY, maxX, maxY)
	samples := 0
	for _, fr := range frames {
		rn, ok := roundAt(fr.Tick)
		if !ok || !inRoundRange(rn) {
			continue
		}
		// Freeze frames deposit no dwell (the buy phase is not live play —
		// inFreezeTime): skipping the whole frame keeps the per-player dt
		// honest for the frames that DO count.
		if inFreezeTime(rounds, fr.Tick) {
			continue
		}
		for _, p := range fr.Players {
			sid := strconv.FormatUint(p.SteamID, 10)
			if !keep(sid, rn) || !f.zInBand(p.Z, true) {
				continue
			}
			if g.add(p.X, p.Y, dt) {
				samples++
			}
		}
	}
	return g.grid("presence", samples), nil
}

// heatmapEvents rasterizes kill/death/damage and per-grenade event
// positions: kills plot the ATTACKER's position (where the killer was —
// events.apos_*), deaths and damage plot the VICTIM's position (where the
// player fell / the hitpoint — events.pos_*), and the grenade kinds plot
// events.pos_* for ONE utility kind — the throw origin for "<util>_thrown"
// (grenade_throw) or the blast position for "<util>_det" (grenade), see
// grenadeHeatmapKinds. The SteamID filter applies to the attacker on
// kills, to the victim on deaths/damage, and to the THROWER on both
// grenade flavors (a team filter likewise resolves the thrower's side);
// a kill with no stored attacker
// position falls back to the victim position (world kills have no killer
// entity and a vanished pawn reads {0,0,0} — both keep apos_* NULL even in
// current imports; see extract's posPtrs — the schema keeps events.apos_*
// nullable). Grenade rows carry no attacker position and never fall back:
// a throw/blast with a NULL pos_* is skipped.
//
// The layer z band (f.zInBand) is applied to the z of the SAME position
// source the sample plots: a kill that plots the attacker's x/y is tested
// against AttackerPosZ (only when the attacker x/y were taken), a victim
// position against PosZ — never victim z with attacker x/y, which would
// band-check a sample against a floor it was not sampled on. The band is
// applied before the sample is appended, so both the sample count and the
// bounds the raster is built from describe the kept population only.
func (s *AnalyticsService) heatmapEvents(matchID int64, kind string, f HeatmapFilter, sideAt func(string, int) string) (HeatmapGrid, error) {
	eventKind := map[string]string{"kills": models.EventKill, "deaths": models.EventKill, "damage": models.EventDamage}[kind]
	utilKind := ""
	if g, ok := grenadeHeatmapKinds[kind]; ok {
		eventKind, utilKind = g.eventKind, g.utilKind
	}
	rows, err := s.st.GetEvents(models.EventFilter{MatchID: matchID, Kind: eventKind, Limit: store.DefaultEventLimit})
	if err != nil {
		return HeatmapGrid{}, err
	}
	type sample struct{ x, y float64 }
	var samples []sample
	for _, e := range rows {
		if f.RoundFrom >= 0 && e.Round < f.RoundFrom {
			continue
		}
		if f.RoundTo >= 0 && e.Round > f.RoundTo {
			continue
		}
		// Grenade kinds: the weapon must normalize to this heatmap's
		// stored utility kind — through models.UtilityWeaponKind, the
		// canonical Molotov ≡ Incendiary projection (models.weapons.go),
		// never a second weapon-name table here.
		if utilKind != "" && models.UtilityWeaponKind(e.Weapon) != utilKind {
			continue
		}
		party := e.Victim // deaths/damage: victim; kills: attacker position, filter on attacker
		if kind == "kills" || utilKind != "" {
			party = e.Attacker // grenades: both flavors filter on the thrower
		}
		if f.SteamID != "" && party != f.SteamID {
			continue
		}
		if f.Team != "" && sideAt(party, e.Round) != f.Team {
			continue
		}
		x, y := e.PosX, e.PosY
		z := e.PosZ
		if kind == "kills" && e.AttackerPosX != nil && e.AttackerPosY != nil {
			x, y, z = e.AttackerPosX, e.AttackerPosY, e.AttackerPosZ
		}
		if x == nil || y == nil {
			continue
		}
		var zv float64
		hasZ := z != nil
		if hasZ {
			zv = *z
		}
		if !f.zInBand(zv, hasZ) {
			continue
		}
		samples = append(samples, sample{x: *x, y: *y})
	}
	if len(samples) == 0 {
		return HeatmapGrid{Kind: kind, W: heatmapGridSide, H: heatmapGridSide,
			Pad: heatmapPad, Cells: make([]float64, heatmapGridSide*heatmapGridSide)}, nil
	}
	minX, minY := math.Inf(1), math.Inf(1)
	maxX, maxY := math.Inf(-1), math.Inf(-1)
	for _, sm := range samples {
		minX, minY = math.Min(minX, sm.x), math.Min(minY, sm.y)
		maxX, maxY = math.Max(maxX, sm.x), math.Max(maxY, sm.y)
	}
	// Shared raster (bounds → pad → cells; see heatmap.go): each event
	// counts 1, Samples stays the pre-raster sample count.
	g := newHeatmapRaster(minX, minY, maxX, maxY)
	for _, sm := range samples {
		g.add(sm.x, sm.y, 1)
	}
	return g.grid(kind, len(samples)), nil
}

// Saved filters.
func (s *AnalyticsService) ListSavedFilters() ([]models.SavedFilterRow, error) {
	return s.st.ListSavedFilters()
}

func (s *AnalyticsService) SaveFilter(name, scope, filterJSON string) (models.SavedFilterRow, error) {
	if name == "" {
		return models.SavedFilterRow{}, errors.New("give the filter a name")
	}
	return s.st.CreateSavedFilter(name, scope, filterJSON)
}

func (s *AnalyticsService) DeleteSavedFilter(id int64) error { return s.st.DeleteSavedFilter(id) }
