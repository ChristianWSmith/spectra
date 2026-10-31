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
	out := &models.ExtractedMatch{}

	playbackTimeS := 0.0
	if a.meta.tickRate > 0 {
		playbackTimeS = float64(a.meta.durationTicks) / a.meta.tickRate
	}

	out.Match = models.Match{
		Map:            a.header.mapName,
		PatchVersion:   a.header.patchVersion,
		TickRate:       a.meta.tickRate,
		DurationTicks:  a.meta.durationTicks,
		PlaybackTimeS:  playbackTimeS,
		Frames:         a.meta.frames,
		ServerName:     a.header.serverName,
		ClientName:     a.header.clientName,
		GameDir:        a.header.gameDir,
		NetProto:       strconv.Itoa(a.header.patchVersion),
		IsPOV:          a.header.isPOV,
		WarmupRounds:   a.warmupRounds,
		RealRounds:     a.realRounds,
		ScoreCT:        a.ctTeam.score,
		ScoreT:         a.tTeam.score,
		HalfCT:         a.halfCT,
		HalfT:          a.halfT,
		SideSwitches:   a.sideSwitches,
		EntityClasses:  a.meta.entityClasses,
		EndEntityCount: a.meta.endEntityCount,
		ParserVersion:  ParserVersion,
		ExtractedAt:    a.meta.extractedAt,
		ParseMS:        a.meta.parseMS,
		WarningsCount:  len(a.warnings),
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

		adr := 0.0
		if a.realRounds > 0 {
			adr = float64(p.totalDamage) / float64(a.realRounds)
		}
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

		out.PlayerStats = append(out.PlayerStats, models.PlayerStats{
			SteamID:         steam,
			Side:            p.side,
			Name:            p.name,
			Kills:           p.kills,
			Deaths:          p.deaths,
			Assists:         p.assists,
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
			ThreeK:          p.threeK,
			FourK:           p.fourK,
			FiveK:           p.fiveK,
			UtilityDamage:   p.utilityDamage,
			FlashesPopped:   p.flashesPopped,
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
	out.Events = a.events
	out.GenericEvents = a.generic
	out.Chat = a.chatRows
	out.Warnings = a.warnings
	return out
}
