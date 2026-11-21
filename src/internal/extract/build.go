package extract

import (
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
			Side:  "ct",
			Name:  a.ctTeam.name,
			Flag:  a.ctTeam.flag,
			Score: a.ctTeam.score,
		},
		{
			Side:  "t",
			Name:  a.tTeam.name,
			Flag:  a.tTeam.flag,
			Score: a.tTeam.score,
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

		out.PlayerStats = append(out.PlayerStats, models.PlayerStats{
			SteamID:     steam,
			Side:        p.side,
			Name:        p.name,
			MVPs:        p.mvps,
			Score:       p.score,
			EntryKills:  p.entryKills,
			EntryDeaths: p.entryDeaths,
			TradeKills:  p.tradeKills,
			BestStreak:  p.bestStreak,
		})
	}

	out.Rounds = make([]models.Round, 0, len(a.rounds))
	for _, r := range a.rounds {
		out.Rounds = append(out.Rounds, models.Round{
			Number:          r.number,
			Winner:          r.winner,
			Reason:          r.reason,
			StartTick:       r.startTick,
			EndTick:         r.endTick,
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
	out.RoundMoney = a.roundMoney
	out.Events = a.events
	out.GenericEvents = a.generic
	out.Chat = a.chatRows
	out.SoundEvents = a.soundEvents
	out.Warnings = a.warnings
	return out
}

// renumber assigns the ingest round numbering. During the parse every
// round is stamped with a chronological index (knife = 1, warmup = 2,
// first counted round = 3 …) so rows can reference their round before the
// match is known; the discarded (knife/warmup/post-match) rounds never
// enter a.rounds and their rows are never stored (agg.roundStart), so the
// stored set is exactly the counted rounds in chronological order and
// this pass rewrites them — and every row that carries a round number —
// through one old→new table onto the dense 1..N numbering the game and
// external scoreboards use (first-half pistol = 1). The old negative
// branch (knife = -2, warmup = -1) died with the discard: nothing is
// numbered negatively anymore, and deleting its rows needs no downstream
// renumbering — every consumer already sees 1..N.
func (a *agg) renumber() {
	mapping := make(map[int]int, len(a.rounds))
	next := 1
	for i := range a.rounds {
		mapping[a.rounds[i].number] = next
		next++
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
	for i := range a.roundMoney {
		a.roundMoney[i].Round = remap(a.roundMoney[i].Round)
	}
}
