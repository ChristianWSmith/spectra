package analytics

import (
	"sort"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// CombatStats derives per-player engagement/damage deep-dive rows from
// in-memory rows. Definitions (mirrored by the store's SQL read
// path, store.GetCombatStats — both are unit-tested against the same
// fixtures):
//
//	DMGNoKill      Σ damage − damage on events where the victim died on the
//	               same tick (same attacker) — an approximation of
//	               "damage without a kill credit"
//	DMGConvPct     damage-on-kills / total damage × 100
//	FFDamage       damage whose victim shares the attacker's FINAL side
//	               (events carry no team — approximation, badge)
//	EntryRate      player_stats.entry_kills / rounds_played
//	TradeRate      player_stats.trade_kills / max(deaths, 1)
//	UntradedDeaths engagement rows kind=untraded with the player as victim
//	TradeOppMissed = UntradedDeaths (inferred heuristic — no position
//	               opportunity scan in v1; UI badge required)
//	KASTPct        average of the player's player_round_stats.kast × 100
//
// Rows are emitted for every player in stats (player_stats of the match).
func CombatStats(events []models.Event, players []PlayerRef, _ []RoundInfo, prs []PlayerRound, engs []Engagement, stats []models.PlayerStats, cfg Config) []CombatStat {
	_ = cfg
	team := teamOf(players)
	sorted := sortedEvents(events)

	type dmgAgg struct{ total, onKill, ff int }
	dmgs := map[string]*dmgAgg{}
	agg := func(sid string) *dmgAgg {
		a := dmgs[sid]
		if a == nil {
			a = &dmgAgg{}
			dmgs[sid] = a
		}
		return a
	}
	// Victim died this tick (any killer) — the kill-credit approximation.
	diedAt := map[string]map[int]bool{} // victim → tick set
	for _, e := range sorted {
		if e.Kind == models.EventKill && e.Victim != "" {
			m := diedAt[e.Victim]
			if m == nil {
				m = map[int]bool{}
				diedAt[e.Victim] = m
			}
			m[e.Tick] = true
		}
	}
	for _, e := range sorted {
		if e.Kind != models.EventDamage || e.Attacker == "" {
			continue
		}
		a := agg(e.Attacker)
		a.total += e.Dmg
		if diedAt[e.Victim][e.Tick] {
			a.onKill += e.Dmg
		}
		if e.Victim != "" && team[e.Attacker] != "" && team[e.Attacker] == team[e.Victim] {
			a.ff += e.Dmg
		}
	}

	untraded := map[string]int{}
	for _, g := range engs {
		if g.Kind == KindUntraded && g.BSteam != "" {
			untraded[g.BSteam]++
		}
	}
	kastSum, kastN := map[string]int{}, map[string]int{}
	for _, p := range prs {
		if p.KAST {
			kastSum[p.SteamID]++
		}
		kastN[p.SteamID]++
	}

	out := make([]CombatStat, 0, len(stats))
	for _, ps := range stats {
		a := dmgs[ps.SteamID]
		if a == nil {
			a = &dmgAgg{}
		}
		r := CombatStat{
			SteamID:        ps.SteamID,
			Name:           ps.Name,
			DMGNoKill:      a.total - a.onKill,
			FFDamage:       a.ff,
			UntradedDeaths: untraded[ps.SteamID],
			TradeOppMissed: untraded[ps.SteamID], // inferred heuristic
		}
		if a.total > 0 {
			r.DMGConvPct = 100 * float64(a.onKill) / float64(a.total)
		}
		if ps.RoundsPlayed > 0 {
			r.EntryRate = float64(ps.EntryKills) / float64(ps.RoundsPlayed)
		}
		if ps.Deaths > 0 {
			r.TradeRate = float64(ps.TradeKills) / float64(ps.Deaths)
		}
		if kastN[ps.SteamID] > 0 {
			r.KASTPct = 100 * float64(kastSum[ps.SteamID]) / float64(kastN[ps.SteamID])
		}
		out = append(out, r)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].SteamID < out[j].SteamID })
	return out
}
