package extract

import (
	"encoding/json"
	"sort"
	"strconv"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// build assembles the accumulated state into the normalized extract output.
// Match ID/Path/SHA256/Size/Status/Error stay zero — the store owns them.
func (a *agg) build() *models.ExtractedMatch {
	// Ingest round numbering first: rows stamped during the parse carry the
	// chronological index and are remapped together with the rounds.
	a.renumber()
	// Multi-kill tiers from each round's final kill total (exact-hit:
	// a round counts at ONE tier, 2K included — see buildMultiKills).
	a.buildMultiKills()

	out := &models.ExtractedMatch{}

	playbackTimeS := 0.0
	if a.meta.tickRate > 0 {
		playbackTimeS = float64(a.meta.durationTicks) / a.meta.tickRate
	}

	out.Match = models.Match{
		Map:               a.header.mapName,
		PatchVersion:      a.header.patchVersion,
		TickRate:          a.meta.tickRate,
		DurationTicks:     a.meta.durationTicks,
		PlaybackTimeS:     playbackTimeS,
		Frames:            a.meta.frames,
		ServerName:        a.header.serverName,
		ClientName:        a.header.clientName,
		GameDir:           a.header.gameDir,
		NetProto:          strconv.Itoa(a.header.patchVersion),
		IsPOV:             a.header.isPOV,
		WarmupRounds:      a.warmupRounds,
		RealRounds:        a.realRounds,
		ScoreCT:           a.ctTeam.score,
		ScoreT:            a.tTeam.score,
		HalfCT:            a.halfCT,
		HalfT:             a.halfT,
		SideSwitches:      a.sideSwitches,
		EntityClasses:     a.meta.entityClasses,
		EndEntityCount:    a.meta.endEntityCount,
		ParserVersion:     ParserVersion,
		ExtractedAt:       a.meta.extractedAt,
		ParseMS:           a.meta.parseMS,
		WarningsCount:     len(a.warnings),
		EncryptedMessages: a.encrypted,
	}

	out.Teams = []models.Team{
		{
			Side:       "ct",
			Name:       a.ctTeam.name,
			Flag:       a.ctTeam.flag,
			Score:      a.ctTeam.score,
			MoneySpent: a.ctTeam.moneySpent,
			EquipTotal: a.ctTeam.equipTotal,
		},
		{
			Side:       "t",
			Name:       a.tTeam.name,
			Flag:       a.tTeam.flag,
			Score:      a.tTeam.score,
			MoneySpent: a.tTeam.moneySpent,
			EquipTotal: a.tTeam.equipTotal,
		},
	}

	keys := make([]uint64, 0, len(a.players))
	for k := range a.players {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })

	out.Players = make([]models.Player, 0, len(keys))
	out.PlayerStats = make([]models.PlayerStats, 0, len(keys))
	for _, key := range keys {
		p := a.players[key]
		steam := keyStr(key)

		out.Players = append(out.Players, models.Player{
			SteamID:           steam,
			Name:              p.name,
			IsBot:             p.isBot,
			Side:              p.side,
			ClanTag:           p.clanTag,
			CrosshairCode:     p.crosshairCode,
			Rank:              p.rank,
			RankType:          p.rankType,
			Wins:              p.wins,
			Ping:              p.ping,
			FinalAlive:        p.finalAlive,
			FinalStatePresent: a.finalPresent[key],
		})

		killsByWeapon, err := json.Marshal(p.weaponKills)
		if err != nil {
			killsByWeapon = []byte("{}")
		}
		damageByWeapon, err := json.Marshal(p.weaponDmg)
		if err != nil {
			damageByWeapon = []byte("{}")
		}
		roundsPlayed := 0
		if rs := a.participation[key]; rs != nil {
			roundsPlayed = len(rs)
		}
		// ADR = enemy damage per round the player played. Damage is
		// capped per hit at the victim's remaining HP while parsing (see
		// agg.capDamage) — the external-board basis the golden demo's
		// official values were checked against.
		adr := 0.0
		if roundsPlayed > 0 {
			adr = float64(p.totalDamage) / float64(roundsPlayed)
		}

		out.PlayerStats = append(out.PlayerStats, models.PlayerStats{
			SteamID:         steam,
			Side:            p.side,
			Name:            p.name,
			Kills:           p.kills,
			Deaths:          p.deaths,
			Assists:         p.assists,
			FlashAssists:    p.flashAssists,
			Headshots:       p.headshots,
			Teamkills:       p.teamkills,
			Suicides:        p.suicides,
			MVPs:            p.mvps,
			Score:           p.score,
			TotalDamage:     p.totalDamage,
			DamageTaken:     p.damageTaken,
			Shots:           p.shots,
			Hits:            p.hits,
			ADR:             adr,
			HSPct:           pct(p.headshots, p.kills),
			RoundsPlayed:    roundsPlayed,
			EntryKills:      p.entryKills,
			EntryDeaths:     p.entryDeaths,
			OpeningKills:    p.openingKills,
			OpeningDeaths:   p.openingDeaths,
			TradeKills:      p.tradeKills,
			BestStreak:      p.bestStreak,
			TwoK:            p.twoK,
			ThreeK:          p.threeK,
			FourK:           p.fourK,
			FiveK:           p.fiveK,
			UtilityDamage:   p.utilityDamage,
			EnemiesFlashed:  p.enemiesFlashed,
			FlashedTimes:    p.flashedTimes,
			BombPlants:      p.bombPlants,
			BombDefuses:     p.bombDefuses,
			MoneySpentTotal: p.moneySpentTotal,
			KillsByWeapon:   string(killsByWeapon),
			DamageByWeapon:  string(damageByWeapon),
		})
	}

	out.Rounds = make([]models.Round, 0, len(a.rounds))
	for _, r := range a.rounds {
		out.Rounds = append(out.Rounds, models.Round{
			Number:          r.number,
			Winner:          r.winner,
			Reason:          r.reason,
			DurationS:       r.durationSec,
			StartTick:       r.startTick,
			EndTick:         r.endTick,
			Warmup:          r.warmup,
			Pregame:         r.pregame,
			MVP:             r.mvp,
			MVPReason:       r.mvpReason,
			EquipCT:         r.equipCT,
			EquipT:          r.equipT,
			BombSite:        r.bombSite,
			FreezeEndTick:   r.freezeEndTick,
			FirstKillSteam:  r.firstKillSteam,
			FirstDeathSteam: r.firstDeathSteam,
		})
	}

	out.RoundEconomy = a.economy
	out.RoundSides = a.roundSides
	out.Events = a.events
	out.GenericEvents = a.generic
	out.Chat = a.chatRows
	out.SoundEvents = a.soundEvents
	out.Warnings = a.warnings
	return out
}

// renumber assigns the ingest round numbering: the first real (non-warmup,
// non-pregame) round is round 1 and real rounds count up from there, while
// knife/warmup rounds take NEGATIVE indices counting backwards from round 1
// (the round immediately before round 1 is -1). Sorting by number therefore
// stays chronological — -2 (knife), -1 (warmup), 1 (pistol), 2, … — and the
// first pistol round of the first half is round 1, matching how the game
// and external scoreboards number rounds.
//
// During the parse every round is stamped with a chronological index
// (knife = 1, warmup = 2, first real = 3 …) so rows can reference their
// round before the match is known; this pass rewrites the rounds and every
// row that carries a round number through one old→new table. Non-counted
// rounds that appear AFTER real play has started (mid-match restarts) are
// still numbered negatively, but can only sort before round 1 — a corner
// case no standard demo hits.
func (a *agg) renumber() {
	mapping := make(map[int]int, len(a.rounds))
	next := 1
	for i := range a.rounds {
		r := &a.rounds[i]
		if r.warmup || r.pregame {
			continue
		}
		mapping[r.number] = next
		next++
	}
	// Reverse walk so the non-counted round closest to round 1 gets -1.
	pre := -1
	for i := len(a.rounds) - 1; i >= 0; i-- {
		r := &a.rounds[i]
		if !r.warmup && !r.pregame {
			continue
		}
		mapping[r.number] = pre
		pre--
	}
	remap := func(old int) int {
		if n, ok := mapping[old]; ok {
			return n
		}
		return old
	}
	for i := range a.rounds {
		a.rounds[i].number = remap(a.rounds[i].number)
	}
	for i := range a.events {
		a.events[i].Round = remap(a.events[i].Round)
	}
	for i := range a.generic {
		a.generic[i].Round = remap(a.generic[i].Round)
	}
	for i := range a.chatRows {
		a.chatRows[i].Round = remap(a.chatRows[i].Round)
	}
	for i := range a.soundEvents {
		a.soundEvents[i].Round = remap(a.soundEvents[i].Round)
	}
	for i := range a.economy {
		a.economy[i].Round = remap(a.economy[i].Round)
	}
	for i := range a.roundSides {
		a.roundSides[i].Round = remap(a.roundSides[i].Round)
	}
}

// buildMultiKills resolves each player's 2K/3K/4K/5K columns from the final
// per-round kill totals. External scoreboards count a round at EXACTLY one
// tier — a round with 4 kills is one 4K and no 3K (the golden demo's
// official scoreboard: adamS 1×3K + 2×4K, not 3×3K) — so the tiers are
// mutually exclusive: exactly 2 → twoK, exactly 3 → threeK, exactly 4 →
// fourK, 5+ → fiveK. roundKills only ever holds stats-eligible kills
// (warmup/knife/post-match kills never reach it).
func (a *agg) buildMultiKills() {
	for _, perRound := range a.roundKills {
		for key, n := range perRound {
			p, ok := a.players[key]
			if !ok {
				continue
			}
			switch {
			case n == 2:
				p.twoK++
			case n == 3:
				p.threeK++
			case n == 4:
				p.fourK++
			case n >= 5:
				p.fiveK++
			}
		}
	}
}
