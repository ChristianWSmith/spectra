package analytics

import (
	"sort"

	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/rules"
)

// RecoverSides fills missing final-side data for players absent from the
// demo's final-state snapshot (the M1 "disappearing players" risk: the
// extractor only persisted side for players present at match end, which on
// the golden demo is 3 of 10 — new imports populate players.side from the
// last freeze-end sample and carry exact per-round sides, making this a
// legacy-import fallback). The recovery is a 2-coloring of the
// non-warmup enemy graph (a kill edge connects opponents), oriented by the
// known final sides; bomb-plant attackers anchor the orientation when no
// final side is known at all (a planter is T). Teamkill edges (same-color
// conflicts) are skipped; in sparse graphs a teamkill can still corrupt
// the coloring (the lie edge is locally indistinguishable) — dense
// real-match graphs resolve via redundant enemy paths (documented
// limitation). Players the graph cannot reach keep Side "" — downstream
// features then skip their team-dependent rows (inferred: PRD §6.1 badge
// required in the UI).
//
// The returned Side is the FINAL-half side; the analytics pass flips it
// for pre-switch rounds via Config.HalfSwitchRound (teams do not reshuffle
// between halves — only sides swap).
func RecoverSides(events []models.Event, rounds []RoundInfo, players []PlayerRef) []PlayerRef {
	real := CountedRounds(rounds)
	realSet := map[int]bool{}
	for _, r := range real {
		realSet[r.Number] = true
	}
	out := make([]PlayerRef, len(players))
	copy(out, players)
	idx := map[string]int{}
	for i, p := range out {
		idx[p.SteamID] = i
	}

	// Enemy graph from non-warmup kills (self-kills excluded).
	adj := map[string][]string{}
	for _, e := range sortedEvents(events) {
		if e.Kind != models.EventKill || e.Attacker == "" || e.Victim == "" || e.Attacker == e.Victim {
			continue
		}
		if !realSet[e.Round] {
			continue
		}
		if _, ok := idx[e.Attacker]; !ok {
			continue
		}
		if _, ok := idx[e.Victim]; !ok {
			continue
		}
		adj[e.Attacker] = append(adj[e.Attacker], e.Victim)
		adj[e.Victim] = append(adj[e.Victim], e.Attacker)
	}

	// BFS 2-color (0/1). Conflicting edges (teamkills) are skipped.
	color := map[string]int{}
	for _, p := range out {
		color[p.SteamID] = -1
	}
	var queue []string
	for _, p := range out {
		if color[p.SteamID] != -1 {
			continue
		}
		color[p.SteamID] = 0
		queue = append(queue, p.SteamID)
		for len(queue) > 0 {
			cur := queue[0]
			queue = queue[1:]
			for _, nb := range adj[cur] {
				if color[nb] == -1 {
					color[nb] = 1 - color[cur]
					queue = append(queue, nb)
				}
				// color[nb] == color[cur] → teamkill edge, skipped.
			}
		}
	}

	// Orientation: known final sides tie a color to a real side.
	colorSide := map[int]string{}
	sideCount := map[int]map[string]int{}
	for _, p := range out {
		if p.Side != "ct" && p.Side != "t" {
			continue
		}
		c := color[p.SteamID]
		if c < 0 {
			continue
		}
		if sideCount[c] == nil {
			sideCount[c] = map[string]int{}
		}
		sideCount[c][p.Side]++
	}
	for c, votes := range sideCount {
		best, bestN := "", -1
		for side, n := range votes {
			if n > bestN || (n == bestN && side < best) {
				best, bestN = side, n
			}
		}
		colorSide[c] = best
	}
	// Bomb-plant anchor when a color lacks a known side: a planter is T in
	// that round; use a late-round planter (≈ final half).
	if _, ok := colorSide[0]; !ok {
		if side := planterColorSide(events, real, color, 0); side != "" {
			colorSide[0] = side
		}
	}
	if _, ok := colorSide[1]; !ok {
		if side := planterColorSide(events, real, color, 1); side != "" {
			colorSide[1] = side
		}
	}
	// One known side orients the other color as its opposite (exactly two
	// teams).
	if s, ok := colorSide[0]; ok {
		if _, taken := colorSide[1]; !taken {
			colorSide[1] = rules.OtherSide(s)
		}
	} else if s, ok := colorSide[1]; ok {
		colorSide[0] = rules.OtherSide(s)
	}

	for i := range out {
		if out[i].Side == "ct" || out[i].Side == "t" {
			continue
		}
		c := color[out[i].SteamID]
		if c < 0 {
			continue
		}
		if s, ok := colorSide[c]; ok {
			out[i].Side = s
		}
	}
	return out
}

// planterColorSide returns "t" for the given color when one of its
// players planted the bomb in the LAST non-warmup round with a plant;
// "" when no planter of that color exists.
func planterColorSide(events []models.Event, real []RoundInfo, color map[string]int, wantColor int) string {
	byRound := map[int][]models.Event{}
	for _, e := range sortedEvents(events) {
		if e.Kind == models.EventBombPlant {
			byRound[e.Round] = append(byRound[e.Round], e)
		}
	}
	for i := len(real) - 1; i >= 0; i-- {
		for _, e := range byRound[real[i].Number] {
			if color[e.Attacker] == wantColor {
				return "t"
			}
		}
	}
	return ""
}

// sideMapForRound resolves every player's REAL side for one round: the
// recovered/final-half side flipped for pre-switch rounds (single-switch
// parity — OT switching is not special-cased, see package doc).
func sideMapForRound(team map[string]string, cfg Config, round int) map[string]string {
	out := make(map[string]string, len(team))
	for sid, s := range team {
		out[sid] = sideAt(s, cfg, round)
	}
	return out
}

// sideAt flips a final-half side for rounds before the half switch — the
// arithmetic is canonical in rules.SideAt (shared with the store's economy
// view, the heatmap side resolver and the frontend RoundStrip).
func sideAt(finalSide string, cfg Config, round int) string {
	return rules.SideAt(finalSide, cfg.HalfSwitchRound, round)
}

// sortedPlayerRefs orders players by SteamID for stable output.
func sortedPlayerRefs(players []PlayerRef) []PlayerRef {
	out := make([]PlayerRef, len(players))
	copy(out, players)
	sort.SliceStable(out, func(i, j int) bool { return out[i].SteamID < out[j].SteamID })
	return out
}
