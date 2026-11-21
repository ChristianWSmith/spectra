package analytics

import (
	"github.com/ChristianWSmith/spectra/internal/models"
)

// PlayerRounds derives per-player-per-round stats incl. the KAST
// decomposition from a match's typed events:
//
//	K        kill credited to the player (kill event attacker; suicides
//	         and teamkills excluded — no self-kill is ever kill credit,
//	         unknown sides included: e.Attacker != e.Victim is
//	         unconditional, ruling 2026-11-17)
//	A        assist (kill event assister, AssistedFlash excluded — the
//	         external-scoreboard convention)
//	S        survived — no death event for them in the round
//	T        traded — their death was answered: a teammate of theirs killed
//	         their killer within cfg.TradeWindowS after the death (enemy
//	         deaths only — a teamkill death is never traded)
//	kast     K || A || T || S
//
// A disconnect-time World self-kill (killer == victim, weapon World, the
// victim's player_disconnect on the same tick) is NOT a death: the row
// stays in events (the feed records what happened) but earns no stat —
// the extractor's agg.kill drops the same rows, so player_round_stats
// agrees with player_stats (ruling, lead 2026-11-17, owner's
// reconnect-takeover report).
//
// DMG/UtilDmg aggregate ENEMY damage events (attacker side; util = the
// utility set in models.IsUtilityWeapon). Same-side damage leaves both
// accumulators — owner ruling 2026-11-17: the fold is the stored twin
// of the replay playhead's fold, the same permissive predicate as
// player_stats.total_damage and the events.same_side stamp (both sides
// known AND equal → same-side → skip; an unknown side counts).
//
// MoneyStart/Equip/Spent come from the extractor's round-end money
// samples (money — round → steamID → row, store.GetRoundPlayerMoney):
// MoneyStart is m_iStartAccount, the game's own snapshot of the account
// at round start before any buys (it carries the pistol/OT money
// resets); Equip is m_unRoundStartEquipmentValue, the equipment value
// carried into the round before freeze-time buys (free spawn pistol
// included); Spent is m_iCashSpentThisRound, the game's per-round spend
// counter read at RoundEnd once mp_buytime has closed. A player-round
// without a sample (player disconnected before round end, or the demo
// carried no start-account prop) keeps the table's absence-as-zero
// default — the same convention as kills/dmg for rounds not played,
// never a derived guess. The three props and the RoundEnd sample point
// are characterized by extract.TestDiagRoundMoneyProps; sources in
// CS2.md "Per-round money props".
// Rows are emitted for EVERY HUMAN player ×
// every counted round (round ASC, players sorted by SteamID for stable
// output) — bots are dropped entirely (ruling 2026-11-17: a bot's
// roster×round row existed in rounds it never played; every consumer of
// player_round_stats is per-player-addressed and no surface can address
// a bot, so presence-scoped bot rows would only ever be read by tests —
// see the emission loop). sides carries the extractor's exact per-round
// freeze-end side samples; a round without them leaves every side unknown —
// kills/assists stay permissive (an unknown side never matches) and no
// trade is claimed.
func PlayerRounds(events []models.Event, rounds []RoundInfo, players []PlayerRef, cfg Config, sides map[int]map[string]string, money map[int]map[string]models.RoundPlayerMoney) []PlayerRound {
	real := CountedRounds(rounds)
	if len(real) == 0 {
		return nil
	}
	byRound := map[int][]models.Event{}
	for _, e := range sortedEvents(events) {
		byRound[e.Round] = append(byRound[e.Round], e)
	}
	// Every (player, tick) carrying a player_disconnect row — the second
	// half of the disconnect-time World self-kill criterion below (both
	// halves are required: a player may disconnect several times, so the
	// lookup is a tick SET, not a last-tick map).
	disconnects := map[string]map[int]bool{}
	for _, e := range events {
		if e.Kind == models.EventDisconnect && e.Attacker != "" {
			if disconnects[e.Attacker] == nil {
				disconnects[e.Attacker] = map[int]bool{}
			}
			disconnects[e.Attacker][e.Tick] = true
		}
	}

	sorted := sortedPlayerRefs(players)
	window := cfg.ticks(cfg.TradeWindowS)

	out := make([]PlayerRound, 0, len(real)*len(sorted))
	for _, r := range real {
		teamR := resolveRoundSides(sides, r.Number)
		roundEvents := byRound[r.Number]
		var kills, assists, deaths = map[string]int{}, map[string]int{}, map[string]int{}
		deathTick := map[string]int{}   // victim → death tick
		killerOf := map[string]string{} // victim → killer
		for _, e := range roundEvents {
			switch e.Kind {
			case models.EventKill:
				// Disconnect-time World self-kill: not a death, not a
				// suicide — no stat at all (ruling, lead 2026-11-17).
				// The row itself is never removed from `events`; the feed
				// is a record of what happened, the stats stay honest.
				if e.Victim != "" && e.Attacker == e.Victim &&
					e.Weapon == WorldWeapon && disconnects[e.Victim][e.Tick] {
					continue
				}
				kt, vt := teamR[e.Attacker], teamR[e.Victim]
				// Enemy kills only (suicides/teamkills excluded); an
				// unknown side is permissive — count it. The
				// attacker != victim half is UNCONDITIONAL (ruling
				// 2026-11-17): without it a self-kill in a round whose
				// sides are unknown credited the victim's own kill.
				if e.Attacker != "" && e.Attacker != e.Victim && !sameSide(kt, vt) {
					kills[e.Attacker]++
				}
				// Assists: cross-team, non-flash (external convention).
				if e.Assister != "" && e.Assister != e.Victim &&
					!sameSide(vt, teamR[e.Assister]) && !e.AssistedFlash {
					assists[e.Assister]++
				}
				if e.Victim != "" {
					deaths[e.Victim]++
					deathTick[e.Victim] = e.Tick
					killerOf[e.Victim] = e.Attacker
				}
			case models.EventDamage:
				// Enemy damage only (owner ruling 2026-11-17): both
				// sides known AND equal → same-side → skip; an
				// unknown side counts (the permissive rule — the
				// same predicate as the events.same_side stamp,
				// player_stats.total_damage and the replay
				// playhead's fold in lib/replay/livestats.js).
			}
		}
		// Trades: a death is traded when the victim's killer dies to one of
		// the victim's teammates within the trade window after the death.
		// Enemy deaths only (a teamkill death is never tradeable — the
		// extractor writes no trade record for it and Engagements anchors
		// enemy kills only, so KAST "T" stays bijective with trade kills);
		// an unknown killer side cannot be classified either.
		traded := map[string]bool{}
		for victim, dTick := range deathTick {
			killer := killerOf[victim]
			if killer == "" {
				continue
			}
			vTeam := teamR[victim]
			if vTeam == "" {
				continue
			}
			if killerSide := teamR[killer]; killerSide == "" || killerSide == vTeam {
				continue
			}
			for _, e := range roundEvents {
				if e.Kind != models.EventKill || e.Tick <= dTick || e.Tick-dTick > window {
					continue
				}
				if e.Victim != killer || teamR[e.Attacker] != vTeam || e.Attacker == victim {
					continue
				}
				traded[victim] = true
				break
			}
		}
		for _, p := range sorted {
			// (d) ruling 2026-11-17: bots carry NO per-round rows. The
			// roster×rounds matrix is a HUMAN stats surface: every
			// consumer of player_round_stats is per-player-addressed
			// (the store's profile/ADR/KAST reads, the per-player metric
			// seeds, report.go's per-player round table) and no picker
			// can address a bot (frontend listedPlayers filters them), so
			// a bot's rows were read by nothing while claiming
			// survived/kast for rounds the bot never existed. Bots keep
			// their player_stats row (their real participation).
			if p.SteamID == "" || p.IsBot {
				continue
			}
			k := kills[p.SteamID] > 0
			a := assists[p.SteamID] > 0
			s := deaths[p.SteamID] == 0
			t := traded[p.SteamID]
			// The round-end money sample for this player-round (absent
			// → the zero value, i.e. the columns' absence-as-zero
			// default — see the function doc).
			rm := money[r.Number][p.SteamID]
			// The row's side stamp: the SAME freeze-end sample the side
			// splits join on (resolveRoundSides — exact, never a final-
			// side guess).
			side := teamR[p.SteamID]
			out = append(out, PlayerRound{
				Round:       r.Number,
				SteamID:     p.SteamID,
				Name:        p.Name,
				Traded:      t,
				KAST:        k || a || t || s,
				MoneyStart:  rm.MoneyStart,
				Equip:       rm.Equip,
				Spent:       rm.Spent,
				RuleVersion: cfg.RuleVersion,
				Side:        side,
			})
		}
	}
	return out
}
