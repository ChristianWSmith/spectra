package main

import (
	"bufio"
	"context"
	"fmt"
	"log"
	"os"
	"sort"
	"strings"
	"time"

	demoinfocs "github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs"
	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/common"
	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/events"
	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/msg"
	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/option"
)

type playerAgg struct {
	Name              string
	SteamID64         uint64
	Team              string
	Kills             int
	Deaths            int
	Assists           int
	Headshots         int
	TeamKills         int
	Suicides          int
	WallbangKills     int
	NoScopes          int
	ThroughSmoke      int
	AttackerBlindK    int
	FlashAssists      int
	MVPs              int
	Score             int
	Rank              int
	RankType          int
	CompetitiveWins   int
	Ping              int
	TotalDamage       int
	DmgTaken          int
	Shots             int
	Hits              int
	MoneySpentTotal   int
	MoneySpentRound   int
	MoneySum          int
	MoneySamples      int
	EquipValueEndSum  int
	ClanTag           string
	CrosshairCode     string
	IsBot             bool
	RankUpdates       []string
	MVPReasons        map[string]int
	WeaponKills       map[string]int
	WeaponShots       map[string]int
	WeaponDmg         map[string]int
	EntryKills        int
	EntryDeaths       int
	RoundsMultiKill   map[int]int
	KillStreak        int
	BestKillStreak    int
	FlashesPopped     int
	FlashedTimes      int
	HEThrows          int
	SmokesThrown      int
	MollyThrown       int
	DecoysThrown      int
	BombPlants        int
	BombDefuses       int
	BombKills         int
	ItemsBought       map[string]int
	DmgByHitGroup     map[string]int
	DmgTakenByWeapon  map[string]int
	DeathsByWeapon    map[string]int
	TradeKills        int
	KillDistances     []float32
	UtilityDmg        int
	ThreeK            int
	FourK             int
	FiveK             int
}

type roundInfo struct {
	Number        int
	Winner        string
	Reason        string
	DurationSec   float64
	StartTick     int
	EndTick       int
	Warmup        bool
	Kills         []string
	Plants        []string
	Defuses       []string
	Explodes      []string
	MVP           string
	MVPReason     string
	CTEquipVal    int
	TEquipVal     int
	BombSite      string
	FreezeEndTick int
	FirstKill     string
	FirstDeath    string
}

type finalPlayer struct {
	Name              string
	SteamID64         uint64
	Team              string
	Kills, Deaths     int
	Assists, MVPs     int
	Score, Ping       int
	Rank              int
	Money, Armor, HP  int
	HasHelmet         bool
	HasDefusKit       bool
	IsAlive           bool
	IsBot             bool
	ClanTag           string
	Crosshair         string
	LastPlace         string
	Position          [3]float64
	ActiveWeapon      string
	Inventory         []string
	CompetitiveWins   int
	RankType          int
	EquipValue        int
	MoneySpentTotal   int
	MoneySpentRound   int
	TotalDamage       int
	UtilityDamage     int
}

type matchData struct {
	MapName             string
	ServerName          string
	ClientName          string
	GameDir             string
	NetProto            int
	HeaderTickRate      float64
	PlaybackTime        time.Duration
	PlaybackTicks       int
	PlaybackFrames      int
	TickRate            float64
	Players             map[uint64]*playerAgg
	Rounds              []roundInfo
	CurrentRound        int
	InWarmup            bool
	MatchStarted        bool
	SideSwitches        int
	FinalCT             int
	FinalT              int
	Chat                []string
	SayText             []string
	RankUpdates         []string
	Votes               []string
	Warnings            []string
	ConVarUpdates       []string
	GenericEventCounts  map[string]int
	BombEvents          []string
	Connections         []string
	NameChanges         []string
	TeamChanges         []string
	HostageEvents       []string
	OtherDeaths         []string
	ItemDrops           map[string]int
	ItemPickups         map[string]int
	TotalShots          int
	TotalKills          int
	TotalHurt           int
	TotalDamage         int
	GamePhases          []string
	HalfTimes           []string
	Overtimes           []string
	Infernos            int
	Smokes              int
	HEExplodes          int
	FlashExplodes       int
	Decoys              int
	BulletDmg           int
	MVPTally            map[string]int
	RoundReasons        map[string]int
	ShotsByWeapon       map[string]int
	KillsByWeapon       map[string]int
	DmgByWeapon         map[string]int
	ScoreAtHalf         [2]int
	WarmupRounds        int
	RealRounds          int
	GrenadeSamples      []string
	PlantTimes          []string
	DefusesWithKit      int
	DefusesNoKit        int
	Plants              int
	Defuses             int
	Explodes            int
	PlantAborted        int
	DefuseAborted       int
	BombPickups         int
	BombDrops           int
	Announcements       []string
	IsPOV               bool
	FileName            string
	FileSize            int64
	Aces                []string
	TKList              []string
	SuicideList         []string
	WallbangList        []string
	NoScopeList         []string
	SmokeKillList       []string
	BlindKillList       []string
	FlashAssistList     []string
	LongestKill         string
	LongestKillDist     float32
	TradeKillList       []string
	ThreeK              []string
	FourK               []string
	FiveK               []string
	HEKillList          []string
	MollyKillList       []string
	BombKillList        []string
	WorldKills          int
	SiteAPlants         int
	SiteBPlants         int
	UtilDmgByPlayer     map[string]int
	Jumps               map[string]int
	Footsteps           int
	Inspects            int
	Spectators          []string
	Bots                []string
	Clutch1v1           int
	Clutch1v2           int
	Clutch1v3           int
	Clutch1v4           int
	Clutch1v5           int
	MatchStartTick      int
	MatchEndTick        int
	KillFeed            []string
	RealPlayTime        time.Duration
	ParseDuration       time.Duration
	FramesParsed        int
	DemoDurationParsed  time.Duration
	FinalTotalRounds    int
	FinalGamePhase      string
	FinalOvertime       int
	EntityCountAtEnd    int
	WeaponCountAtEnd    int
	GrenadeCountAtEnd   int
	InfernoCountAtEnd   int
	HostageCountAtEnd   int
	FinalConVars        map[string]string
	CTClanName, TClanName string
	CTFlag, TFlag         string
	EndScoreCT, EndScoreT int
	ConnectedAtEnd        int
	CTMoneySpent, TMoneySpent int
	CTEquipTotal, TEquipTotal int
	ServerClassCount      int
	// trade tracking
	lastDeathTick map[common.Team]int
	lastDeathBy   map[common.Team]*common.Player
	roundKills    map[int]map[uint64]int
	// clutch tracking: alive counts on each kill
	// simplified clutch: on RoundEnd winner, check if any player on winning team was sole survivor - skip complex, implement via kill-time check for 1vN kills that end the round
	clutchPending map[int]*clutchState // round -> state
}

type clutchState struct {
	// when a player gets a kill while being the last alive on their team and >0 enemies alive, and that kill reduces enemies to 0 before their team would lose - approximate: count "round-winning kills as last man standing"
	// simpler: at each kill, if killer is only alive on team and enemies were >1 alive before kill and after kill enemies==0 and round won by killer team later - too complex; do simpler 1vN: at kill moment count enemies alive; if killer sole alive on team and eventually wins round with n enemies killed while alone
	// implement: track for each round, for each player, whether they got a "clutch kill" as sole survivor; count max enemies killed as sole survivor; on round end if winner and sole survivor got >=1 such kills and started alone after teammates died - approximate clutch win of size = number of enemies killed while sole survivor
	soleSurvivorKills map[uint64]int
	becameSole        map[uint64]bool
}

func teamName(t common.Team) string {
	switch t {
	case common.TeamTerrorists:
		return "T"
	case common.TeamCounterTerrorists:
		return "CT"
	case common.TeamSpectators:
		return "SPEC"
	default:
		return "UNASSIGNED"
	}
}

func hitGroupName(h events.HitGroup) string {
	switch h {
	case events.HitGroupGeneric:
		return "Generic"
	case events.HitGroupHead:
		return "Head"
	case events.HitGroupChest:
		return "Chest"
	case events.HitGroupStomach:
		return "Stomach"
	case events.HitGroupLeftArm:
		return "LeftArm"
	case events.HitGroupRightArm:
		return "RightArm"
	case events.HitGroupLeftLeg:
		return "LeftLeg"
	case events.HitGroupRightLeg:
		return "RightLeg"
	default:
		return fmt.Sprintf("Unknown(%d)", h)
	}
}

func roundEndReasonName(r events.RoundEndReason) string {
	switch r {
	case events.RoundEndReasonStillInProgress:
		return "StillInProgress"
	case events.RoundEndReasonTargetBombed:
		return "TargetBombed"
	case events.RoundEndReasonVIPEscaped:
		return "VIPEscaped"
	case events.RoundEndReasonVIPKilled:
		return "VIPKilled"
	case events.RoundEndReasonTerroristsEscaped:
		return "TerroristsEscaped"
	case events.RoundEndReasonCTStoppedEscape:
		return "CTStoppedEscape"
	case events.RoundEndReasonTerroristsStopped:
		return "TerroristsStopped"
	case events.RoundEndReasonBombDefused:
		return "BombDefused"
	case events.RoundEndReasonCTWin:
		return "CTWin"
	case events.RoundEndReasonTerroristsWin:
		return "TerroristsWin"
	case events.RoundEndReasonDraw:
		return "Draw"
	case events.RoundEndReasonHostagesRescued:
		return "HostagesRescued"
	case events.RoundEndReasonTargetSaved:
		return "TargetSaved"
	case events.RoundEndReasonHostagesNotRescued:
		return "HostagesNotRescued"
	case events.RoundEndReasonTerroristsNotEscaped:
		return "TerroristsNotEscaped"
	case events.RoundEndReasonVIPNotEscaped:
		return "VIPNotEscaped"
	case events.RoundEndReasonGameStart:
		return "GameStart"
	case events.RoundEndReasonTerroristsSurrender:
		return "TerroristsSurrender"
	case events.RoundEndReasonCTSurrender:
		return "CTSurrender"
	case events.RoundEndReasonTerroristsPlanted:
		return "TerroristsPlanted"
	case events.RoundEndReasonCTsReachedHostage:
		return "CTsReachedHostage"
	default:
		return fmt.Sprintf("Reason%d", r)
	}
}

func mvpReasonName(r events.RoundMVPReason) string {
	switch r {
	case events.MVPReasonMostEliminations:
		return "MostEliminations"
	case events.MVPReasonBombDefused:
		return "BombDefused"
	case events.MVPReasonBombPlanted:
		return "BombPlanted"
	default:
		return fmt.Sprintf("Reason%d", r)
	}
}

func rankName(r int) string {
	names := []string{
		"Unranked", "Silver I", "Silver II", "Silver III", "Silver IV", "Silver Elite",
		"Silver Elite Master", "Gold Nova I", "Gold Nova II", "Gold Nova III", "Gold Nova Master",
		"Master Guardian I", "Master Guardian II", "Master Guardian Elite",
		"Distinguished Master Guardian", "Legendary Eagle", "Legendary Eagle Master",
		"Supreme Master First Class", "The Global Elite",
	}
	if r >= 0 && r < len(names) {
		return names[r]
	}
	return fmt.Sprintf("Rank(%d)", r)
}

func div(a, b int) float64 {
	if b == 0 {
		return float64(a)
	}
	return float64(a) / float64(b)
}

func pct(a, b int) float64 {
	if b == 0 {
		return 0
	}
	return 100 * float64(a) / float64(b)
}

func sortedCounts(m map[string]int) string {
	type kv struct {
		K string
		V int
	}
	var s []kv
	for k, v := range m {
		s = append(s, kv{k, v})
	}
	sort.Slice(s, func(i, j int) bool { return s[i].V > s[j].V })
	var parts []string
	for _, x := range s {
		parts = append(parts, fmt.Sprintf("%s:%d", x.K, x.V))
	}
	return strings.Join(parts, ", ")
}

func newAgg(name string, steamID uint64, bot bool) *playerAgg {
	return &playerAgg{
		Name:             name,
		SteamID64:        steamID,
		IsBot:            bot,
		MVPReasons:       make(map[string]int),
		WeaponKills:      make(map[string]int),
		WeaponShots:      make(map[string]int),
		WeaponDmg:        make(map[string]int),
		RoundsMultiKill:  make(map[int]int),
		ItemsBought:      make(map[string]int),
		DmgByHitGroup:    make(map[string]int),
		DmgTakenByWeapon: make(map[string]int),
		DeathsByWeapon:   make(map[string]int),
	}
}

func main() {
	demoPath := "demo.dem"
	outPath := "REPORT.md"
	if len(os.Args) > 1 {
		demoPath = os.Args[1]
	}
	if len(os.Args) > 2 {
		outPath = os.Args[2]
	}

	f, err := os.Open(demoPath)
	if err != nil {
		log.Fatal(err)
	}
	defer f.Close()

	st, _ := f.Stat()
	fileSize := int64(0)
	if st != nil {
		fileSize = st.Size()
	}

	md := &matchData{
		Players:            make(map[uint64]*playerAgg),
		GenericEventCounts: make(map[string]int),
		ItemDrops:          make(map[string]int),
		ItemPickups:        make(map[string]int),
		MVPTally:           make(map[string]int),
		RoundReasons:       make(map[string]int),
		ShotsByWeapon:      make(map[string]int),
		KillsByWeapon:      make(map[string]int),
		DmgByWeapon:        make(map[string]int),
		lastDeathTick:      make(map[common.Team]int),
		lastDeathBy:        make(map[common.Team]*common.Player),
		roundKills:         make(map[int]map[uint64]int),
		UtilDmgByPlayer:    make(map[string]int),
		Jumps:              make(map[string]int),
		FileName:           demoPath,
		FileSize:           fileSize,
		clutchPending:      make(map[int]*clutchState),
	}

	p := demoinfocs.NewParser(f,
		option.IgnorePacketEntitiesPanic(true),
		option.MsgQueueBufferSize(0), // sequential, lower memory
	)
	defer p.Close()

	// Capture full CS2 demo header via the DEM_FileHeader message (v6 doesn't expose Parser.Header()).
	var demoHeader msg.CDemoFileHeader
	p.RegisterNetMessageHandler(func(m *msg.CDemoFileHeader) {
		demoHeader = *m
		md.ServerName = m.GetServerName()
		md.ClientName = m.GetClientName()
		md.MapName = m.GetMapName()
		md.GameDir = m.GetGameDirectory()
		md.NetProto = int(m.GetPatchVersion())
	})

	getAgg := func(pl *common.Player) *playerAgg {
		if pl == nil {
			return nil
		}
		key := pl.SteamID64
		bot := pl.IsBot
		if key == 0 {
			key = uint64(0xFF00000000000000) | uint64(pl.EntityID&0x0FFFFFFF)
			bot = true
		}
		if a, ok := md.Players[key]; ok {
			return a
		}
		a := newAgg(pl.Name, pl.SteamID64, bot)
		md.Players[key] = a
		return a
	}

	wepName := func(w *common.Equipment) string {
		if w == nil {
			return "Unknown"
		}
		return w.Type.String()
	}

	// ---- Header is filled during parse via CDemoFileHeader net-message ----

	// ---- Handlers ----

	p.RegisterEventHandler(func(e events.GenericGameEvent) {
		md.GenericEventCounts[e.Name]++
	})

	p.RegisterEventHandler(func(e events.ParserWarn) {
		md.Warnings = append(md.Warnings, fmt.Sprintf("[type=%d] %s", e.Type, e.Message))
	})

	p.RegisterEventHandler(func(e events.MatchStartedChanged) {
		md.MatchStarted = e.NewIsStarted
		if e.NewIsStarted {
			md.MatchStartTick = p.GameState().IngameTick()
			md.Announcements = append(md.Announcements, "Match started")
		} else {
			md.Announcements = append(md.Announcements, "Match not started (warmup/reset)")
		}
	})

	p.RegisterEventHandler(func(e events.MatchStart) {
		md.Announcements = append(md.Announcements, "MatchStart event")
	})

	p.RegisterEventHandler(func(e events.AnnouncementMatchStarted) {
		md.Announcements = append(md.Announcements, "Announcement: match is starting")
	})

	p.RegisterEventHandler(func(e events.AnnouncementFinalRound) {
		md.Announcements = append(md.Announcements, "Announcement: final round of half")
	})

	p.RegisterEventHandler(func(e events.AnnouncementLastRoundHalf) {
		md.Announcements = append(md.Announcements, "Announcement: last round of half")
	})

	p.RegisterEventHandler(func(e events.AnnouncementWinPanelMatch) {
		md.Announcements = append(md.Announcements, "Announcement: win panel / match end")
		md.MatchEndTick = p.GameState().IngameTick()
	})

	p.RegisterEventHandler(func(e events.GameHalfEnded) {
		gs := p.GameState()
		md.ScoreAtHalf = [2]int{gs.TeamCounterTerrorists().Score(), gs.TeamTerrorists().Score()}
		md.HalfTimes = append(md.HalfTimes, fmt.Sprintf("Half ended (score at that moment CT=%d T=%d)", md.ScoreAtHalf[0], md.ScoreAtHalf[1]))
	})

	p.RegisterEventHandler(func(e events.TeamSideSwitch) {
		md.SideSwitches++
		md.Announcements = append(md.Announcements, "Team side switch")
	})

	p.RegisterEventHandler(func(e events.IsWarmupPeriodChanged) {
		md.InWarmup = e.NewIsWarmupPeriod
		md.Announcements = append(md.Announcements, fmt.Sprintf("Warmup=%v", e.NewIsWarmupPeriod))
	})

	p.RegisterEventHandler(func(e events.GamePhaseChanged) {
		md.GamePhases = append(md.GamePhases, fmt.Sprintf("tick=%d phase %s→%s", p.GameState().IngameTick(), e.OldGamePhase, e.NewGamePhase))
	})

	p.RegisterEventHandler(func(e events.OvertimeNumberChanged) {
		md.Overtimes = append(md.Overtimes, fmt.Sprintf("Overtime count → %d", e.NewCount))
	})

	p.RegisterEventHandler(func(e events.PlayerConnect) {
		md.Connections = append(md.Connections, fmt.Sprintf("%s connected (steamID=%d bot=%v)", e.Player.Name, e.Player.SteamID64, e.Player.IsBot))
		if e.Player.IsBot {
			md.Bots = append(md.Bots, e.Player.Name)
		}
	})

	p.RegisterEventHandler(func(e events.PlayerDisconnected) {
		md.Connections = append(md.Connections, fmt.Sprintf("%s disconnected", e.Player.Name))
	})

	p.RegisterEventHandler(func(e events.PlayerNameChange) {
		md.NameChanges = append(md.NameChanges, fmt.Sprintf("%q → %q", e.OldName, e.NewName))
	})

	p.RegisterEventHandler(func(e events.PlayerTeamChange) {
		md.TeamChanges = append(md.TeamChanges, fmt.Sprintf("%s: %s → %s", e.Player.Name, teamName(e.OldTeam), teamName(e.NewTeam)))
	})

	p.RegisterEventHandler(func(e events.RoundStart) {
		md.CurrentRound++
		gs := p.GameState()
		warmup := gs.IsWarmupPeriod()
		if warmup {
			md.WarmupRounds++
		} else {
			md.RealRounds++
		}
		md.Rounds = append(md.Rounds, roundInfo{
			Number:    md.CurrentRound,
			StartTick: gs.IngameTick(),
			Warmup:    warmup,
		})
		md.roundKills[md.CurrentRound] = make(map[uint64]int)
		md.lastDeathTick = make(map[common.Team]int)
		md.lastDeathBy = make(map[common.Team]*common.Player)
		md.clutchPending[md.CurrentRound] = &clutchState{
			soleSurvivorKills: make(map[uint64]int),
			becameSole:        make(map[uint64]bool),
		}
	})

	p.RegisterEventHandler(func(e events.RoundFreezetimeChanged) {
		if e.NewIsFreezetime {
			return
		}
		if len(md.Rounds) > 0 {
			r := &md.Rounds[len(md.Rounds)-1]
			r.FreezeEndTick = p.GameState().IngameTick()
			gs := p.GameState()
			if ct := gs.TeamCounterTerrorists(); ct != nil {
				r.CTEquipVal = ct.FreezeTimeEndEquipmentValue()
			}
			if t := gs.TeamTerrorists(); t != nil {
				r.TEquipVal = t.FreezeTimeEndEquipmentValue()
			}
		}
		for _, pl := range p.GameState().Participants().Playing() {
			if a := getAgg(pl); a != nil {
				a.MoneySum += pl.Money()
				a.MoneySamples++
				a.EquipValueEndSum += pl.EquipmentValueFreezeTimeEnd()
			}
		}
	})

	p.RegisterEventHandler(func(e events.RoundEnd) {
		gs := p.GameState()
		winner := teamName(e.Winner)
		if len(md.Rounds) > 0 {
			r := &md.Rounds[len(md.Rounds)-1]
			r.Winner = winner
			r.Reason = roundEndReasonName(e.Reason)
			r.EndTick = gs.IngameTick()
			if r.StartTick > 0 && r.EndTick > r.StartTick {
				tr := p.TickRate()
				if tr <= 0 {
					tr = 64
				}
				r.DurationSec = float64(r.EndTick-r.StartTick) / tr
			}
		}
		md.RoundReasons[roundEndReasonName(e.Reason)]++
		if !gs.IsWarmupPeriod() {
			switch e.Winner {
			case common.TeamCounterTerrorists:
				md.FinalCT++
			case common.TeamTerrorists:
				md.FinalT++
			}
			// clutch detection: sole survivor on winning team with >=1 solo kills
			if cs := md.clutchPending[md.CurrentRound]; cs != nil && e.Winner != common.TeamSpectators {
				// find sole survivor
				var survivors []*common.Player
				for _, pl := range gs.Participants().Playing() {
					if pl.Team == e.Winner && pl.IsAlive() {
						survivors = append(survivors, pl)
					}
				}
				if len(survivors) == 1 {
					sk := cs.soleSurvivorKills[survivors[0].SteamID64]
					if survivors[0].SteamID64 == 0 {
						sk = cs.soleSurvivorKills[uint64(0xFF00000000000000)|uint64(survivors[0].EntityID&0x0FFFFFFF)]
					}
					if sk >= 1 {
						n := sk
						name := survivors[0].Name
						switch {
						case n >= 5:
							md.Clutch1v5++
						case n == 4:
							md.Clutch1v4++
						case n == 3:
							md.Clutch1v3++
						case n == 2:
							md.Clutch1v2++
						case n == 1:
							md.Clutch1v1++
						}
						_ = name
					}
				}
			}
		}
	})

	p.RegisterEventHandler(func(e events.RoundMVPAnnouncement) {
		name := ""
		if e.Player != nil {
			name = e.Player.Name
			if a := getAgg(e.Player); a != nil {
				a.MVPs++
				a.MVPReasons[mvpReasonName(e.Reason)]++
			}
			md.MVPTally[name]++
		}
		if len(md.Rounds) > 0 {
			r := &md.Rounds[len(md.Rounds)-1]
			r.MVP = name
			r.MVPReason = mvpReasonName(e.Reason)
		}
	})

	p.RegisterEventHandler(func(e events.Kill) {
		md.TotalKills++
		gs := p.GameState()
		roundNo := md.CurrentRound
		warmup := gs.IsWarmupPeriod()

		killerName, victimName := "", ""
		var ka, va *playerAgg
		var killerKey, victimKey uint64
		if e.Killer != nil {
			killerName = e.Killer.Name
			ka = getAgg(e.Killer)
			killerKey = e.Killer.SteamID64
			if killerKey == 0 {
				killerKey = uint64(0xFF00000000000000) | uint64(e.Killer.EntityID&0x0FFFFFFF)
			}
		}
		if e.Victim != nil {
			victimName = e.Victim.Name
			va = getAgg(e.Victim)
			victimKey = e.Victim.SteamID64
			if victimKey == 0 {
				victimKey = uint64(0xFF00000000000000) | uint64(e.Victim.EntityID&0x0FFFFFFF)
			}
		}
		wn := wepName(e.Weapon)

		if e.Weapon != nil && e.Weapon.Type == common.EqWorld {
			md.WorldKills++
		}

		var flags []string
		if e.IsHeadshot {
			flags = append(flags, "HS")
		}
		if e.IsWallBang() {
			flags = append(flags, "WB")
		}
		if e.NoScope {
			flags = append(flags, "NoScope")
		}
		if e.ThroughSmoke {
			flags = append(flags, "ThroughSmoke")
		}
		if e.AttackerBlind {
			flags = append(flags, "AttackerBlind")
		}
		if e.AssistedFlash {
			flags = append(flags, "FlashAssist")
		}
		flagStr := ""
		if len(flags) > 0 {
			flagStr = " (" + strings.Join(flags, ", ") + ")"
		}
		line := fmt.Sprintf("R%d %s <%s>%s %s [%.0fu]", roundNo, killerName, wn, flagStr, victimName, e.Distance)

		if !warmup {
			md.KillFeed = append(md.KillFeed, line)
		}

		if ka != nil && !warmup {
			ka.Kills++
			ka.WeaponKills[wn]++
			md.KillsByWeapon[wn]++
			if e.IsHeadshot {
				ka.Headshots++
			}
			if e.IsWallBang() {
				ka.WallbangKills++
				md.WallbangList = append(md.WallbangList, line)
			}
			if e.NoScope {
				ka.NoScopes++
				md.NoScopeList = append(md.NoScopeList, line)
			}
			if e.ThroughSmoke {
				ka.ThroughSmoke++
				md.SmokeKillList = append(md.SmokeKillList, line)
			}
			if e.AttackerBlind {
				ka.AttackerBlindK++
				md.BlindKillList = append(md.BlindKillList, line)
			}
			if e.AssistedFlash {
				ka.FlashAssists++
				md.FlashAssistList = append(md.FlashAssistList, line)
			}
			if e.Weapon != nil && e.Weapon.Type == common.EqBomb {
				ka.BombKills++
				md.BombKillList = append(md.BombKillList, line)
			}
			if e.Weapon != nil && e.Weapon.Type == common.EqHE {
				md.HEKillList = append(md.HEKillList, line)
			}
			if e.Weapon != nil && (e.Weapon.Type == common.EqMolotov || e.Weapon.Type == common.EqIncendiary) {
				md.MollyKillList = append(md.MollyKillList, line)
			}
			if e.Distance > md.LongestKillDist {
				md.LongestKillDist = e.Distance
				md.LongestKill = line
			}
			ka.KillDistances = append(ka.KillDistances, e.Distance)

			if e.Victim != nil && e.Killer != nil && e.Killer.Team == e.Victim.Team {
				ka.TeamKills++
				md.TKList = append(md.TKList, line)
			}

			if md.roundKills[roundNo] == nil {
				md.roundKills[roundNo] = make(map[uint64]int)
			}
			md.roundKills[roundNo][killerKey]++
			mk := md.roundKills[roundNo][killerKey]
			ka.RoundsMultiKill[roundNo] = mk
			switch mk {
			case 3:
				ka.ThreeK++
				md.ThreeK = append(md.ThreeK, fmt.Sprintf("%s (R%d)", killerName, roundNo))
			case 4:
				ka.FourK++
				md.FourK = append(md.FourK, fmt.Sprintf("%s (R%d)", killerName, roundNo))
			case 5:
				ka.FiveK++
				md.FiveK = append(md.FiveK, fmt.Sprintf("%s (R%d, ACE)", killerName, roundNo))
				md.Aces = append(md.Aces, fmt.Sprintf("%s (R%d)", killerName, roundNo))
			}

			ka.KillStreak++
			if ka.KillStreak > ka.BestKillStreak {
				ka.BestKillStreak = ka.KillStreak
			}

			if len(md.Rounds) > 0 {
				r := &md.Rounds[len(md.Rounds)-1]
				if r.FirstKill == "" {
					r.FirstKill = killerName
					r.FirstDeath = victimName
					ka.EntryKills++
				}
			}

			if e.Victim != nil {
				if lt, ok := md.lastDeathTick[e.Victim.Team]; ok {
					tr := p.TickRate()
					if tr <= 0 {
						tr = 64
					}
					if float64(gs.IngameTick()-lt)/tr <= 5.0 {
						ka.TradeKills++
						md.TradeKillList = append(md.TradeKillList, line)
					}
				}
			}

			// clutch sole-survivor kills
			if cs := md.clutchPending[roundNo]; cs != nil {
				// count alive on killer team
				aliveOwn, aliveEnemy := 0, 0
				for _, pl := range gs.Participants().Playing() {
					if !pl.IsAlive() {
						continue
					}
					// victim already dead at this point in some demos? Kill event fires after death typically
					if e.Killer != nil && pl.Team == e.Killer.Team {
						aliveOwn++
					} else if e.Killer != nil {
						aliveEnemy++
					}
				}
				// if killer is sole alive on own team (aliveOwn==1 means only killer counted if still alive - victim already dead)
				if aliveOwn == 1 && aliveEnemy >= 1 {
					cs.soleSurvivorKills[killerKey]++
				}
			}
		}

		if va != nil && !warmup {
			va.Deaths++
			va.DeathsByWeapon[wn]++
			va.KillStreak = 0
			if e.Killer != nil && e.Killer.EntityID == e.Victim.EntityID {
				va.Suicides++
				md.SuicideList = append(md.SuicideList, line)
			}
			md.lastDeathTick[e.Victim.Team] = gs.IngameTick()
			md.lastDeathBy[e.Victim.Team] = e.Victim

			// entry death
			if len(md.Rounds) > 0 {
				r := &md.Rounds[len(md.Rounds)-1]
				if r.FirstDeath == victimName && r.FirstKill != "" && r.FirstDeath != "" {
					// already set via first kill
				}
			}
		}

		if e.Assister != nil && !warmup {
			if aa := getAgg(e.Assister); aa != nil {
				aa.Assists++
			}
		}

		if len(md.Rounds) > 0 && !warmup {
			r := &md.Rounds[len(md.Rounds)-1]
			r.Kills = append(r.Kills, line)
		}
	})

	p.RegisterEventHandler(func(e events.OtherDeath) {
		if !p.GameState().IsWarmupPeriod() {
			md.OtherDeaths = append(md.OtherDeaths, fmt.Sprintf("R%d %s died (%v)", md.CurrentRound, e.OtherType, e.Weapon))
		}
	})

	p.RegisterEventHandler(func(e events.PlayerHurt) {
		md.TotalHurt++
		if p.GameState().IsWarmupPeriod() {
			return
		}
		wn := wepName(e.Weapon)
		if e.WeaponString != "" && (e.Weapon == nil || e.Weapon.Type == common.EqUnknown) {
			wn = e.WeaponString
		}
		if e.Attacker != nil {
			if aa := getAgg(e.Attacker); aa != nil {
				aa.TotalDamage += e.HealthDamage
				aa.Hits++
				aa.WeaponDmg[wn] += e.HealthDamage
				aa.DmgByHitGroup[hitGroupName(e.HitGroup)] += e.HealthDamage
				if e.Weapon != nil {
					switch e.Weapon.Type {
					case common.EqHE, common.EqMolotov, common.EqIncendiary, common.EqDecoy, common.EqSmoke, common.EqFlash:
						aa.UtilityDmg += e.HealthDamage
						md.UtilDmgByPlayer[aa.Name] += e.HealthDamage
					}
				}
				md.DmgByWeapon[wn] += e.HealthDamage
				md.TotalDamage += e.HealthDamage
			}
		}
		if e.Player != nil {
			if va := getAgg(e.Player); va != nil {
				va.DmgTaken += e.HealthDamageTaken
				va.DmgTakenByWeapon[wn] += e.HealthDamageTaken
			}
		}
	})

	p.RegisterEventHandler(func(e events.BulletDamage) {
		md.BulletDmg++
	})

	p.RegisterEventHandler(func(e events.WeaponFire) {
		if e.Shooter == nil || p.GameState().IsWarmupPeriod() {
			return
		}
		md.TotalShots++
		wn := wepName(e.Weapon)
		md.ShotsByWeapon[wn]++
		if a := getAgg(e.Shooter); a != nil {
			a.Shots++
			a.WeaponShots[wn]++
		}
	})

	p.RegisterEventHandler(func(e events.BombPlanted) {
		md.Plants++
		site := string(e.Site)
		player := ""
		if e.Player != nil {
			player = e.Player.Name
			if a := getAgg(e.Player); a != nil {
				a.BombPlants++
			}
		}
		tick := p.GameState().IngameTick()
		line := fmt.Sprintf("R%d plant by %s at site %s (tick=%d)", md.CurrentRound, player, site, tick)
		md.BombEvents = append(md.BombEvents, line)
		md.PlantTimes = append(md.PlantTimes, line)
		if e.Site == 'A' {
			md.SiteAPlants++
		} else if e.Site == 'B' {
			md.SiteBPlants++
		}
		if len(md.Rounds) > 0 {
			md.Rounds[len(md.Rounds)-1].Plants = append(md.Rounds[len(md.Rounds)-1].Plants, line)
			md.Rounds[len(md.Rounds)-1].BombSite = site
		}
	})

	p.RegisterEventHandler(func(e events.BombDefused) {
		md.Defuses++
		player := ""
		if e.Player != nil {
			player = e.Player.Name
			if a := getAgg(e.Player); a != nil {
				a.BombDefuses++
				if e.Player.HasDefuseKit() {
					md.DefusesWithKit++
				} else {
					md.DefusesNoKit++
				}
			}
		}
		line := fmt.Sprintf("R%d defuse by %s at site %s", md.CurrentRound, player, string(e.Site))
		md.BombEvents = append(md.BombEvents, line)
		if len(md.Rounds) > 0 {
			md.Rounds[len(md.Rounds)-1].Defuses = append(md.Rounds[len(md.Rounds)-1].Defuses, line)
		}
	})

	p.RegisterEventHandler(func(e events.BombExplode) {
		md.Explodes++
		line := fmt.Sprintf("R%d bomb EXPLODED at site %s", md.CurrentRound, string(e.Site))
		md.BombEvents = append(md.BombEvents, line)
		if len(md.Rounds) > 0 {
			md.Rounds[len(md.Rounds)-1].Explodes = append(md.Rounds[len(md.Rounds)-1].Explodes, line)
		}
	})

	p.RegisterEventHandler(func(e events.BombPlantAborted) {
		md.PlantAborted++
		player := ""
		if e.Player != nil {
			player = e.Player.Name
		}
		md.BombEvents = append(md.BombEvents, fmt.Sprintf("R%d plant aborted by %s", md.CurrentRound, player))
	})

	p.RegisterEventHandler(func(e events.BombDefuseAborted) {
		md.DefuseAborted++
		player := ""
		if e.Player != nil {
			player = e.Player.Name
		}
		md.BombEvents = append(md.BombEvents, fmt.Sprintf("R%d defuse aborted by %s", md.CurrentRound, player))
	})

	p.RegisterEventHandler(func(e events.BombPickup) {
		md.BombPickups++
		player := ""
		if e.Player != nil {
			player = e.Player.Name
		}
		md.BombEvents = append(md.BombEvents, fmt.Sprintf("R%d bomb pickup by %s", md.CurrentRound, player))
	})

	p.RegisterEventHandler(func(e events.BombDropped) {
		md.BombDrops++
		player := ""
		if e.Player != nil {
			player = e.Player.Name
		}
		md.BombEvents = append(md.BombEvents, fmt.Sprintf("R%d bomb dropped by %s", md.CurrentRound, player))
	})

	p.RegisterEventHandler(func(e events.HeExplode) {
		md.HEExplodes++
		thrower := ""
		if e.Thrower != nil {
			thrower = e.Thrower.Name
			if a := getAgg(e.Thrower); a != nil {
				a.HEThrows++
			}
		}
		if !p.GameState().IsWarmupPeriod() {
			md.GrenadeSamples = append(md.GrenadeSamples, fmt.Sprintf("HE R%d by %s at (%.0f,%.0f,%.0f)", md.CurrentRound, thrower, e.Position.X, e.Position.Y, e.Position.Z))
		}
	})

	p.RegisterEventHandler(func(e events.FlashExplode) {
		md.FlashExplodes++
		thrower := ""
		if e.Thrower != nil {
			thrower = e.Thrower.Name
			if a := getAgg(e.Thrower); a != nil {
				a.FlashesPopped++
			}
		}
		if !p.GameState().IsWarmupPeriod() {
			md.GrenadeSamples = append(md.GrenadeSamples, fmt.Sprintf("Flash R%d by %s at (%.0f,%.0f,%.0f)", md.CurrentRound, thrower, e.Position.X, e.Position.Y, e.Position.Z))
		}
	})

	p.RegisterEventHandler(func(e events.SmokeStart) {
		md.Smokes++
		thrower := ""
		if e.Thrower != nil {
			thrower = e.Thrower.Name
			if a := getAgg(e.Thrower); a != nil {
				a.SmokesThrown++
			}
		}
		if !p.GameState().IsWarmupPeriod() {
			md.GrenadeSamples = append(md.GrenadeSamples, fmt.Sprintf("Smoke R%d by %s at (%.0f,%.0f,%.0f)", md.CurrentRound, thrower, e.Position.X, e.Position.Y, e.Position.Z))
		}
	})

	p.RegisterEventHandler(func(e events.FireGrenadeStart) {
		md.Infernos++
		thrower := ""
		if e.Thrower != nil {
			thrower = e.Thrower.Name
			if a := getAgg(e.Thrower); a != nil {
				a.MollyThrown++
			}
		}
		if !p.GameState().IsWarmupPeriod() {
			md.GrenadeSamples = append(md.GrenadeSamples, fmt.Sprintf("Molly R%d by %s at (%.0f,%.0f,%.0f)", md.CurrentRound, thrower, e.Position.X, e.Position.Y, e.Position.Z))
		}
	})

	p.RegisterEventHandler(func(e events.DecoyStart) {
		md.Decoys++
		if e.Thrower != nil {
			if a := getAgg(e.Thrower); a != nil {
				a.DecoysThrown++
			}
		}
	})

	p.RegisterEventHandler(func(e events.PlayerFlashed) {
		if p.GameState().IsWarmupPeriod() {
			return
		}
		if e.Player != nil {
			if a := getAgg(e.Player); a != nil {
				a.FlashedTimes++
			}
		}
	})

	p.RegisterEventHandler(func(e events.ChatMessage) {
		sender := "console/unknown"
		if e.Sender != nil {
			sender = e.Sender.Name
		}
		md.Chat = append(md.Chat, fmt.Sprintf("[R%d] %s: %s", md.CurrentRound, sender, e.Text))
	})

	p.RegisterEventHandler(func(e events.SayText) {
		md.SayText = append(md.SayText, e.Text)
	})

	p.RegisterEventHandler(func(e events.RankUpdate) {
		name := "unknown"
		if e.Player != nil {
			name = e.Player.Name
		}
		line := fmt.Sprintf("%s: rank %d (%s) → %d (%s), change=%.2f, wins=%d, steamID32=%d",
			name, e.RankOld, rankName(e.RankOld), e.RankNew, rankName(e.RankNew), e.RankChange, e.WinCount, e.SteamID32)
		md.RankUpdates = append(md.RankUpdates, line)
		if a := getAgg(e.Player); a != nil {
			a.RankUpdates = append(a.RankUpdates, line)
			a.Rank = e.RankNew
			a.CompetitiveWins = e.WinCount
		}
	})

	// Votes (not available in v4 API / not present in all demos)

	p.RegisterEventHandler(func(e events.ItemDrop) {
		if e.Player == nil {
			return
		}
		md.ItemDrops[wepName(e.Weapon)]++
	})

	p.RegisterEventHandler(func(e events.ItemPickup) {
		if e.Player == nil {
			return
		}
		wn := wepName(e.Weapon)
		md.ItemPickups[wn]++
		if a := getAgg(e.Player); a != nil {
			a.ItemsBought[wn]++
		}
	})

	p.RegisterEventHandler(func(e events.HostageRescued) {
		md.HostageEvents = append(md.HostageEvents, fmt.Sprintf("R%d hostage rescued", md.CurrentRound))
	})
	p.RegisterEventHandler(func(e events.HostageRescuedAll) {
		md.HostageEvents = append(md.HostageEvents, fmt.Sprintf("R%d all hostages rescued", md.CurrentRound))
	})
	p.RegisterEventHandler(func(e events.HostageHurt) {
		md.HostageEvents = append(md.HostageEvents, fmt.Sprintf("R%d hostage hurt", md.CurrentRound))
	})
	p.RegisterEventHandler(func(e events.HostageKilled) {
		md.HostageEvents = append(md.HostageEvents, fmt.Sprintf("R%d hostage killed", md.CurrentRound))
	})

	p.RegisterEventHandler(func(e events.Footstep) {
		md.Footsteps++
	})
	p.RegisterEventHandler(func(e events.PlayerJump) {
		if e.Player != nil && !p.GameState().IsWarmupPeriod() {
			md.Jumps[e.Player.Name]++
		}
	})
	// PlayerInspectingWeapon not available in v6
	p.RegisterEventHandler(func(e events.ConVarsUpdated) {
		for k, v := range e.UpdatedConVars {
			md.ConVarUpdates = append(md.ConVarUpdates, fmt.Sprintf("%s=%s", k, v))
		}
	})
	p.RegisterEventHandler(func(e events.POVRecordingPlayerDetected) {
		md.IsPOV = true
	})

	// ---- Parse ----
	parseStart := time.Now()
	parseErr := p.ParseToEnd(context.Background())
	md.ParseDuration = time.Since(parseStart)

	// ---- Final state ----
	gs := p.GameState()
	md.TickRate = p.TickRate()
	md.FramesParsed = p.CurrentFrame()
	md.DemoDurationParsed = p.CurrentTime()
	md.FinalTotalRounds = gs.TotalRoundsPlayed()
	md.FinalOvertime = gs.OvertimeCount()
	md.FinalGamePhase = gs.GamePhase().String()
	md.EntityCountAtEnd = len(gs.Entities())
	md.WeaponCountAtEnd = len(gs.Weapons())
	md.GrenadeCountAtEnd = len(gs.GrenadeProjectiles())
	md.InfernoCountAtEnd = len(gs.Infernos())
	md.HostageCountAtEnd = len(gs.Hostages())
	md.FinalConVars = gs.Rules().ConVars()
	md.ServerClassCount = len(p.ServerClasses().All())
	md.PlaybackFrames = p.FrameCount()
	md.PlaybackTicks = gs.IngameTick()
	if md.TickRate > 0 {
		md.PlaybackTime = time.Duration(float64(md.PlaybackTicks) / md.TickRate * float64(time.Second))
	}

	if ct := gs.TeamCounterTerrorists(); ct != nil {
		md.CTClanName = ct.ClanName()
		md.CTFlag = ct.Flag()
		md.EndScoreCT = ct.Score()
		md.CTMoneySpent = ct.MoneySpentTotal()
		md.CTEquipTotal = ct.CurrentEquipmentValue()
	}
	if t := gs.TeamTerrorists(); t != nil {
		md.TClanName = t.ClanName()
		md.TFlag = t.Flag()
		md.EndScoreT = t.Score()
		md.TMoneySpent = t.MoneySpentTotal()
		md.TEquipTotal = t.CurrentEquipmentValue()
	}

	playing := gs.Participants().Playing()
	connected := gs.Participants().Connected()
	md.ConnectedAtEnd = len(connected)

	var finals []finalPlayer
	for _, pl := range playing {
		inv := []string{}
		for _, wp := range pl.Weapons() {
			inv = append(inv, wp.String())
		}
		sort.Strings(inv)
		pos := pl.Position()
		fp := finalPlayer{
			Name: pl.Name, SteamID64: pl.SteamID64, Team: teamName(pl.Team),
			Kills: pl.Kills(), Deaths: pl.Deaths(), Assists: pl.Assists(), MVPs: pl.MVPs(),
			Score: pl.Score(), Ping: pl.Ping(), Rank: pl.Rank(), Money: pl.Money(),
			Armor: pl.Armor(), HP: pl.Health(),
			HasHelmet: pl.HasHelmet(), HasDefusKit: pl.HasDefuseKit(), IsAlive: pl.IsAlive(), IsBot: pl.IsBot,
			ClanTag: pl.ClanTag(), Crosshair: pl.CrosshairCode(), LastPlace: pl.LastPlaceName(),
			Position: [3]float64{pos.X, pos.Y, pos.Z},
			CompetitiveWins: pl.CompetitiveWins(), RankType: pl.RankType(),
			EquipValue: pl.EquipmentValueCurrent(), MoneySpentTotal: pl.MoneySpentTotal(), MoneySpentRound: pl.MoneySpentThisRound(),
			TotalDamage: pl.TotalDamage(), UtilityDamage: pl.UtilityDamage(),
			Inventory: inv,
		}
		if aw := pl.ActiveWeapon(); aw != nil {
			fp.ActiveWeapon = aw.String()
		}
		finals = append(finals, fp)

		if a := getAgg(pl); a != nil {
			a.Name = pl.Name
			a.Team = teamName(pl.Team)
			a.Ping = pl.Ping()
			a.Score = pl.Score()
			a.Rank = pl.Rank()
			a.RankType = pl.RankType()
			a.CompetitiveWins = pl.CompetitiveWins()
			a.ClanTag = pl.ClanTag()
			a.CrosshairCode = pl.CrosshairCode()
			a.IsBot = pl.IsBot
			a.Kills = pl.Kills()
			a.Deaths = pl.Deaths()
			a.Assists = pl.Assists()
			a.MVPs = pl.MVPs()
			a.MoneySpentTotal = pl.MoneySpentTotal()
			a.MoneySpentRound = pl.MoneySpentThisRound()
		}
	}

	playingSet := make(map[*common.Player]bool)
	for _, pl := range playing {
		playingSet[pl] = true
	}
	for _, pl := range connected {
		if !playingSet[pl] {
			md.Spectators = append(md.Spectators, fmt.Sprintf("%s (bot=%v)", pl.Name, pl.IsBot))
		}
	}

	var longest, shortest *roundInfo
	for i := range md.Rounds {
		r := &md.Rounds[i]
		if r.Warmup {
			continue
		}
		if longest == nil || r.DurationSec > longest.DurationSec {
			longest = r
		}
		if shortest == nil || r.DurationSec < shortest.DurationSec {
			shortest = r
		}
	}

	// ---- Report ----
	out, err := os.Create(outPath)
	if err != nil {
		log.Fatal(err)
	}
	defer out.Close()
	w := bufio.NewWriter(out)
	defer w.Flush()

	fmt.Fprintf(w, "# Full Demo Data Report\n\n")
	fmt.Fprintf(w, "Extracted with [demoinfocs-golang](https://github.com/markus-wa/demoinfocs-golang) v6.0.0-rc.1 (CS2 / Source 2).\n\n")
	fmt.Fprintf(w, "Generated %s · parse wall-time %s\n\n", time.Now().Format(time.RFC3339), md.ParseDuration.Round(time.Millisecond))
	if parseErr != nil {
		fmt.Fprintf(w, "> Parse finished with note: `%v`\n\n", parseErr)
	}

	fmt.Fprintf(w, "---\n\n## 1. Demo File & Header\n\n")
	fmt.Fprintf(w, "| Field | Value |\n|---|---|\n")
	fmt.Fprintf(w, "| File | `%s` (%.1f MB) |\n", md.FileName, float64(md.FileSize)/(1024*1024))
	fmt.Fprintf(w, "| Filestamp | `%s` |\n", demoHeader.GetDemoFileStamp())
	fmt.Fprintf(w, "| Patch version | %d |\n", demoHeader.GetPatchVersion())
	fmt.Fprintf(w, "| Network protocol (patch) | %d |\n", md.NetProto)
	fmt.Fprintf(w, "| Server name | %s |\n", md.ServerName)
	fmt.Fprintf(w, "| Client name | %s |\n", md.ClientName)
	fmt.Fprintf(w, "| Map | **%s** |\n", md.MapName)
	fmt.Fprintf(w, "| Game directory | %s |\n", md.GameDir)
	fmt.Fprintf(w, "| Game | %s |\n", demoHeader.GetGame())
	fmt.Fprintf(w, "| Demo version | %s (guid %s, build %d) |\n", demoHeader.GetDemoVersionName(), demoHeader.GetDemoVersionGuid(), demoHeader.GetBuildNum())
	fmt.Fprintf(w, "| Addons | %s |\n", demoHeader.GetAddons())
	fmt.Fprintf(w, "| Server start tick | %d |\n", demoHeader.GetServerStartTick())
	fmt.Fprintf(w, "| Fullpackets version | %d |\n", demoHeader.GetFullpacketsVersion())
	fmt.Fprintf(w, "| Allows clientside entities / particles | %v / %v |\n", demoHeader.GetAllowClientsideEntities(), demoHeader.GetAllowClientsideParticles())
	fmt.Fprintf(w, "| Playback time (est.) | %s (%.0f s) |\n", md.PlaybackTime, md.PlaybackTime.Seconds())
	fmt.Fprintf(w, "| Playback ticks (ingame tick at end) | %d |\n", md.PlaybackTicks)
	fmt.Fprintf(w, "| Playback frames | %d |\n", md.PlaybackFrames)
	fmt.Fprintf(w, "| Tick rate (server info) | %.2f Hz |\n", md.TickRate)
	fmt.Fprintf(w, "| Tick time | %s |\n", p.TickTime())
	fmt.Fprintf(w, "| POV demo | %v |\n", md.IsPOV)
	fmt.Fprintf(w, "| Frames parsed | %d |\n", md.FramesParsed)
	fmt.Fprintf(w, "| Parsed demo duration | %s |\n", md.DemoDurationParsed)
	fmt.Fprintf(w, "| Server classes (entity types) | %d |\n", md.ServerClassCount)

	fmt.Fprintf(w, "\n### Server rules / ConVars (final snapshot)\n\n")
	if len(md.FinalConVars) > 0 {
		keys := make([]string, 0, len(md.FinalConVars))
		for k := range md.FinalConVars {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		fmt.Fprintf(w, "| ConVar | Value |\n|---|---|\n")
		for _, k := range keys {
			fmt.Fprintf(w, "| `%s` | `%s` |\n", k, md.FinalConVars[k])
		}
	} else {
		fmt.Fprintf(w, "_No ConVars captured (FACEIT/Valve MM demos encrypt some net-messages; a `match730_*.dem.info` decryption key would unlock more)._ \n")
	}
	if len(md.ConVarUpdates) > 0 {
		fmt.Fprintf(w, "\n**ConVar updates during demo (%d):**\n\n", len(md.ConVarUpdates))
		for _, cu := range md.ConVarUpdates {
			fmt.Fprintf(w, "- `%s`\n", cu)
		}
	}

	fmt.Fprintf(w, "\n---\n\n## 2. Match Overview\n\n")
	fmt.Fprintf(w, "| Field | Value |\n|---|---|\n")
	fmt.Fprintf(w, "| Map | %s |\n", md.MapName)
	fmt.Fprintf(w, "| CT clan / flag | %s / %s |\n", md.CTClanName, md.CTFlag)
	fmt.Fprintf(w, "| T clan / flag | %s / %s |\n", md.TClanName, md.TFlag)
	fmt.Fprintf(w, "| Final score | **CT %d – %d T** |\n", md.EndScoreCT, md.EndScoreT)
	fmt.Fprintf(w, "| Rounds tracked (incl. warmup) | %d |\n", len(md.Rounds))
	fmt.Fprintf(w, "| Real (non-warmup) rounds | %d |\n", md.RealRounds)
	fmt.Fprintf(w, "| Warmup rounds | %d |\n", md.WarmupRounds)
	fmt.Fprintf(w, "| Side switches | %d |\n", md.SideSwitches)
	fmt.Fprintf(w, "| Overtimes | %d |\n", md.FinalOvertime)
	fmt.Fprintf(w, "| Final game phase | %s |\n", md.FinalGamePhase)
	fmt.Fprintf(w, "| Total rounds played (game rules) | %d |\n", md.FinalTotalRounds)
	fmt.Fprintf(w, "| Match started | %v (tick %d) |\n", md.MatchStarted, md.MatchStartTick)
	fmt.Fprintf(w, "| Total kills | %d |\n", md.TotalKills)
	fmt.Fprintf(w, "| Total hurt events | %d |\n", md.TotalHurt)
	fmt.Fprintf(w, "| Total shots fired | %d |\n", md.TotalShots)
	fmt.Fprintf(w, "| Total damage dealt (event sum) | %d |\n", md.TotalDamage)
	fmt.Fprintf(w, "| Connected players at end | %d |\n", md.ConnectedAtEnd)
	fmt.Fprintf(w, "| Entities at end | %d |\n", md.EntityCountAtEnd)
	fmt.Fprintf(w, "| Weapons at end | %d |\n", md.WeaponCountAtEnd)
	fmt.Fprintf(w, "| Grenade projectiles at end | %d |\n", md.GrenadeCountAtEnd)
	fmt.Fprintf(w, "| Infernos at end | %d |\n", md.InfernoCountAtEnd)
	fmt.Fprintf(w, "| Hostages at end | %d |\n", md.HostageCountAtEnd)
	if longest != nil {
		fmt.Fprintf(w, "| Longest round | R%d (%.1fs, %s) |\n", longest.Number, longest.DurationSec, longest.Reason)
	}
	if shortest != nil {
		fmt.Fprintf(w, "| Shortest round | R%d (%.1fs, %s) |\n", shortest.Number, shortest.DurationSec, shortest.Reason)
	}

	fmt.Fprintf(w, "\n### Economy totals\n\n")
	fmt.Fprintf(w, "| Team | Money spent total | Current equip value |\n|---|---|---|\n")
	fmt.Fprintf(w, "| CT | $%d | $%d |\n", md.CTMoneySpent, md.CTEquipTotal)
	fmt.Fprintf(w, "| T | $%d | $%d |\n", md.TMoneySpent, md.TEquipTotal)

	fmt.Fprintf(w, "\n### Round end reasons\n\n")
	fmt.Fprintf(w, "| Reason | Count |\n|---|---|\n")
	reasonKeys := make([]string, 0, len(md.RoundReasons))
	for k := range md.RoundReasons {
		reasonKeys = append(reasonKeys, k)
	}
	sort.Slice(reasonKeys, func(i, j int) bool { return md.RoundReasons[reasonKeys[i]] > md.RoundReasons[reasonKeys[j]] })
	for _, k := range reasonKeys {
		fmt.Fprintf(w, "| %s | %d |\n", k, md.RoundReasons[k])
	}

	fmt.Fprintf(w, "\n### MVPs\n\n")
	fmt.Fprintf(w, "| Player | MVPs |\n|---|---|\n")
	mvpKeys := make([]string, 0, len(md.MVPTally))
	for k := range md.MVPTally {
		mvpKeys = append(mvpKeys, k)
	}
	sort.Slice(mvpKeys, func(i, j int) bool { return md.MVPTally[mvpKeys[i]] > md.MVPTally[mvpKeys[j]] })
	for _, k := range mvpKeys {
		fmt.Fprintf(w, "| %s | %d |\n", k, md.MVPTally[k])
	}

	fmt.Fprintf(w, "\n### Utility & objective summary\n\n")
	fmt.Fprintf(w, "| Metric | Count |\n|---|---|\n")
	fmt.Fprintf(w, "| HE explosions | %d |\n", md.HEExplodes)
	fmt.Fprintf(w, "| Flashbang detonations | %d |\n", md.FlashExplodes)
	fmt.Fprintf(w, "| Smoke starts | %d |\n", md.Smokes)
	fmt.Fprintf(w, "| Infernos (molly/incendiary) | %d |\n", md.Infernos)
	fmt.Fprintf(w, "| Decoys | %d |\n", md.Decoys)
	fmt.Fprintf(w, "| Bomb plants | %d (A:%d B:%d, aborted %d) |\n", md.Plants, md.SiteAPlants, md.SiteBPlants, md.PlantAborted)
	fmt.Fprintf(w, "| Bomb defuses | %d (with kit %d / without %d, aborted %d) |\n", md.Defuses, md.DefusesWithKit, md.DefusesNoKit, md.DefuseAborted)
	fmt.Fprintf(w, "| Bomb explosions | %d |\n", md.Explodes)
	fmt.Fprintf(w, "| Bomb pickups / drops | %d / %d |\n", md.BombPickups, md.BombDrops)
	fmt.Fprintf(w, "| BulletDamage events | %d |\n", md.BulletDmg)
	fmt.Fprintf(w, "| Footsteps | %d |\n", md.Footsteps)
	fmt.Fprintf(w, "| Jumps (non-warmup) | %d |\n", totalOf(md.Jumps))
	fmt.Fprintf(w, "| Weapon inspects | %d |\n", md.Inspects)
	fmt.Fprintf(w, "| World kills | %d |\n", md.WorldKills)

	fmt.Fprintf(w, "\n### Clutches (approximate: solo-kills as last man standing, round won)\n\n")
	fmt.Fprintf(w, "| Type | Count |\n|---|---|\n")
	fmt.Fprintf(w, "| 1v1 | %d |\n", md.Clutch1v1)
	fmt.Fprintf(w, "| 1v2 | %d |\n", md.Clutch1v2)
	fmt.Fprintf(w, "| 1v3 | %d |\n", md.Clutch1v3)
	fmt.Fprintf(w, "| 1v4 | %d |\n", md.Clutch1v4)
	fmt.Fprintf(w, "| 1v5+ | %d |\n", md.Clutch1v5)

	fmt.Fprintf(w, "\n### Weapon usage totals\n\n")
	fmt.Fprintf(w, "| Weapon | Shots | Kills | Damage |\n|---|---|---|---|\n")
	weaponSet := make(map[string]bool)
	for k := range md.ShotsByWeapon {
		weaponSet[k] = true
	}
	for k := range md.KillsByWeapon {
		weaponSet[k] = true
	}
	for k := range md.DmgByWeapon {
		weaponSet[k] = true
	}
	var weapons []string
	for k := range weaponSet {
		weapons = append(weapons, k)
	}
	sort.Slice(weapons, func(i, j int) bool { return md.DmgByWeapon[weapons[i]] > md.DmgByWeapon[weapons[j]] })
	for _, wn := range weapons {
		fmt.Fprintf(w, "| %s | %d | %d | %d |\n", wn, md.ShotsByWeapon[wn], md.KillsByWeapon[wn], md.DmgByWeapon[wn])
	}

	fmt.Fprintf(w, "\n### Item events (drops / pickups)\n\n")
	fmt.Fprintf(w, "| Item | Drops | Pickups |\n|---|---|---|\n")
	itemSet := make(map[string]bool)
	for k := range md.ItemDrops {
		itemSet[k] = true
	}
	for k := range md.ItemPickups {
		itemSet[k] = true
	}
	var items []string
	for k := range itemSet {
		items = append(items, k)
	}
	sort.Strings(items)
	for _, it := range items {
		fmt.Fprintf(w, "| %s | %d | %d |\n", it, md.ItemDrops[it], md.ItemPickups[it])
	}

	fmt.Fprintf(w, "\n---\n\n## 3. Players\n\n")
	fmt.Fprintf(w, "### Scoreboard (final state)\n\n")
	fmt.Fprintf(w, "| Name | SteamID64 | Team | Bot | Rank | Wins | K | D | A | +/- | HS%% | ADR | Score | MVPs | Ping | Money | $spent | Equip | Armor | HP | Kit | Helmet | Active weapon |\n")
	fmt.Fprintf(w, "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n")
	sort.Slice(finals, func(i, j int) bool { return finals[i].Kills > finals[j].Kills })
	for _, fp := range finals {
		hsPct := 0.0
		adr := 0.0
		if a, ok := md.Players[fp.SteamID64]; ok {
			hsPct = pct(a.Headshots, a.Kills)
			if md.RealRounds > 0 {
				adr = float64(a.TotalDamage) / float64(md.RealRounds)
			}
		}
		fmt.Fprintf(w, "| %s | %d | %s | %v | %s | %d | %d | %d | %d | %d | %.1f | %.1f | %d | %d | %d | $%d | $%d | $%d | %d | %d | %v | %v | %s |\n",
			fp.Name, fp.SteamID64, fp.Team, fp.IsBot, rankName(fp.Rank), fp.CompetitiveWins,
			fp.Kills, fp.Deaths, fp.Assists, fp.Kills-fp.Deaths, hsPct, adr,
			fp.Score, fp.MVPs, fp.Ping, fp.Money, fp.MoneySpentTotal, fp.EquipValue,
			fp.Armor, fp.HP, fp.HasDefusKit, fp.HasHelmet, fp.ActiveWeapon)
	}

	fmt.Fprintf(w, "\n### Player inventories & identity (final)\n\n")
	for _, fp := range finals {
		fmt.Fprintf(w, "- **%s** (`%s`, clan tag `%s`, crosshair `%s`, last place `%s`, pos %.0f/%.0f/%.0f)\n",
			fp.Name, fp.Crosshair, fp.ClanTag, fp.Crosshair, fp.LastPlace, fp.Position[0], fp.Position[1], fp.Position[2])
		fmt.Fprintf(w, "  - Inventory: %s\n", strings.Join(fp.Inventory, ", "))
	}

	fmt.Fprintf(w, "\n### Detailed per-player aggregates\n\n")
	var aggs []*playerAgg
	for _, a := range md.Players {
		aggs = append(aggs, a)
	}
	sort.Slice(aggs, func(i, j int) bool { return aggs[i].Kills > aggs[j].Kills })
	for _, a := range aggs {
		fmt.Fprintf(w, "#### %s\n\n", a.Name)
		fmt.Fprintf(w, "| Stat | Value |\n|---|---|\n")
		fmt.Fprintf(w, "| SteamID64 | %d |\n", a.SteamID64)
		fmt.Fprintf(w, "| Team (final) | %s |\n", a.Team)
		fmt.Fprintf(w, "| Bot | %v |\n", a.IsBot)
		fmt.Fprintf(w, "| Clan tag | `%s` |\n", a.ClanTag)
		fmt.Fprintf(w, "| Crosshair code | `%s` |\n", a.CrosshairCode)
		fmt.Fprintf(w, "| Rank (final / type) | %s / %d |\n", rankName(a.Rank), a.RankType)
		fmt.Fprintf(w, "| Competitive wins | %d |\n", a.CompetitiveWins)
		fmt.Fprintf(w, "| Ping | %d |\n", a.Ping)
		fmt.Fprintf(w, "| Score | %d |\n", a.Score)
		fmt.Fprintf(w, "| K / D / A | %d / %d / %d (K/D %.2f) |\n", a.Kills, a.Deaths, a.Assists, div(a.Kills, a.Deaths))
		fmt.Fprintf(w, "| Trade kills (≤5s after teammate death) | %d |\n", a.TradeKills)
		fmt.Fprintf(w, "| Headshot kills | %d (%.1f%%) |\n", a.Headshots, pct(a.Headshots, a.Kills))
		fmt.Fprintf(w, "| Wallbang / No-scope / Through-smoke / Blind | %d / %d / %d / %d |\n", a.WallbangKills, a.NoScopes, a.ThroughSmoke, a.AttackerBlindK)
		fmt.Fprintf(w, "| Flash assists | %d |\n", a.FlashAssists)
		fmt.Fprintf(w, "| Team kills / suicides | %d / %d |\n", a.TeamKills, a.Suicides)
		fmt.Fprintf(w, "| MVPs | %d |\n", a.MVPs)
		if len(a.MVPReasons) > 0 {
			fmt.Fprintf(w, "| MVP reasons | %v |\n", a.MVPReasons)
		}
		fmt.Fprintf(w, "| Shots fired | %d |\n", a.Shots)
		fmt.Fprintf(w, "| Hits (hurt events as attacker) | %d |\n", a.Hits)
		fmt.Fprintf(w, "| Accuracy | %.1f%% |\n", pct(a.Hits, a.Shots))
		fmt.Fprintf(w, "| Damage dealt | %d |\n", a.TotalDamage)
		if md.RealRounds > 0 {
			fmt.Fprintf(w, "| ADR | %.1f |\n", float64(a.TotalDamage)/float64(md.RealRounds))
		}
		fmt.Fprintf(w, "| Utility damage | %d |\n", a.UtilityDmg)
		fmt.Fprintf(w, "| Damage taken | %d |\n", a.DmgTaken)
		fmt.Fprintf(w, "| Entry kills | %d |\n", a.EntryKills)
		fmt.Fprintf(w, "| 3K / 4K / ACE rounds | %d / %d / %d |\n", a.ThreeK, a.FourK, a.FiveK)
		fmt.Fprintf(w, "| Best kill streak (no death) | %d |\n", a.BestKillStreak)
		fmt.Fprintf(w, "| Bomb plants / defuses | %d / %d |\n", a.BombPlants, a.BombDefuses)
		fmt.Fprintf(w, "| Bomb-kill (C4) | %d |\n", a.BombKills)
		fmt.Fprintf(w, "| HE / Molly / Smoke / Flash-pop / Decoy | %d / %d / %d / %d / %d |\n", a.HEThrows, a.MollyThrown, a.SmokesThrown, a.FlashesPopped, a.DecoysThrown)
		fmt.Fprintf(w, "| Times flashed | %d |\n", a.FlashedTimes)
		if a.MoneySamples > 0 {
			fmt.Fprintf(w, "| Avg money / equip value (freezetime end) | $%.0f / $%.0f |\n", float64(a.MoneySum)/float64(a.MoneySamples), float64(a.EquipValueEndSum)/float64(a.MoneySamples))
		}
		fmt.Fprintf(w, "| Money spent (total / this round) | $%d / $%d |\n", a.MoneySpentTotal, a.MoneySpentRound)
		if len(a.WeaponKills) > 0 {
			fmt.Fprintf(w, "| Kills by weapon | %s |\n", sortedCounts(a.WeaponKills))
		}
		if len(a.WeaponShots) > 0 {
			fmt.Fprintf(w, "| Shots by weapon | %s |\n", sortedCounts(a.WeaponShots))
		}
		if len(a.WeaponDmg) > 0 {
			fmt.Fprintf(w, "| Damage by weapon | %s |\n", sortedCounts(a.WeaponDmg))
		}
		if len(a.DmgByHitGroup) > 0 {
			fmt.Fprintf(w, "| Damage by hitgroup | %v |\n", a.DmgByHitGroup)
		}
		if len(a.DmgTakenByWeapon) > 0 {
			fmt.Fprintf(w, "| Damage taken by weapon | %s |\n", sortedCounts(a.DmgTakenByWeapon))
		}
		if len(a.ItemsBought) > 0 {
			fmt.Fprintf(w, "| Items acquired (pickup events) | %s |\n", sortedCounts(a.ItemsBought))
		}
		if len(a.KillDistances) > 0 {
			var sum float64
			var mx float32
			for _, d := range a.KillDistances {
				sum += float64(d)
				if d > mx {
					mx = d
				}
			}
			fmt.Fprintf(w, "| Kill distance avg / max | %.0f / %.0f |\n", sum/float64(len(a.KillDistances)), mx)
		}
		if len(a.RankUpdates) > 0 {
			fmt.Fprintf(w, "| Rank updates | %v |\n", a.RankUpdates)
		}
		fmt.Fprintln(w)
	}

	fmt.Fprintf(w, "\n### Spectators / non-playing connected\n\n")
	if len(md.Spectators) > 0 {
		for _, s := range md.Spectators {
			fmt.Fprintf(w, "- %s\n", s)
		}
	} else {
		fmt.Fprintf(w, "_None detected at demo end._\n")
	}
	if len(md.Bots) > 0 {
		fmt.Fprintf(w, "\n**Bots seen connecting:** %s\n", strings.Join(unique(md.Bots), ", "))
	}

	fmt.Fprintf(w, "\n---\n\n## 4. Rounds (chronological)\n\n")
	fmt.Fprintf(w, "| # | Winner | Reason | Dur (s) | Site | MVP | MVP reason | CT equip | T equip | #Kills | First blood |\n")
	fmt.Fprintf(w, "|---|---|---|---|---|---|---|---|---|---|---|\n")
	for i := range md.Rounds {
		r := &md.Rounds[i]
		wp := ""
		if r.Warmup {
			wp = " (warmup)"
		}
		fb := ""
		if r.FirstKill != "" {
			fb = fmt.Sprintf("%s killed %s", r.FirstKill, r.FirstDeath)
		}
		fmt.Fprintf(w, "| %d%s | %s | %s | %.1f | %s | %s | %s | $%d | $%d | %d | %s |\n",
			r.Number, wp, r.Winner, r.Reason, r.DurationSec, r.BombSite, r.MVP, r.MVPReason,
			r.CTEquipVal, r.TEquipVal, len(r.Kills), fb)
	}

	fmt.Fprintf(w, "\n### Objective events per round (plants/defuses/explodes)\n\n")
	for i := range md.Rounds {
		r := &md.Rounds[i]
		if len(r.Plants)+len(r.Defuses)+len(r.Explodes) == 0 {
			continue
		}
		fmt.Fprintf(w, "- **R%d** (%s):\n", r.Number, r.Winner)
		for _, x := range r.Plants {
			fmt.Fprintf(w, "  - %s\n", x)
		}
		for _, x := range r.Defuses {
			fmt.Fprintf(w, "  - %s\n", x)
		}
		for _, x := range r.Explodes {
			fmt.Fprintf(w, "  - %s\n", x)
		}
	}

	fmt.Fprintf(w, "\n---\n\n## 5. Kill feed (non-warmup)\n\n")
	fmt.Fprintf(w, "Total: %d kills\n\n", len(md.KillFeed))
	for _, line := range md.KillFeed {
		fmt.Fprintf(w, "- %s\n", line)
	}

	fmt.Fprintf(w, "\n---\n\n## 6. Notable kill lists\n\n")
	writeList := func(title string, l []string) {
		fmt.Fprintf(w, "### %s (%d)\n\n", title, len(l))
		if len(l) == 0 {
			fmt.Fprintf(w, "_None._\n\n")
			return
		}
		for _, x := range l {
			fmt.Fprintf(w, "- %s\n", x)
		}
		fmt.Fprintln(w)
	}
	writeList("Aces (5K)", md.Aces)
	writeList("4K rounds", md.FourK)
	writeList("3K rounds", md.ThreeK)
	writeList("Wallbang kills", md.WallbangList)
	writeList("No-scope kills", md.NoScopeList)
	writeList("Through-smoke kills", md.SmokeKillList)
	writeList("Attacker-blind kills", md.BlindKillList)
	writeList("Flash-assisted kills", md.FlashAssistList)
	writeList("Trade kills (≤5s)", md.TradeKillList)
	writeList("HE kills", md.HEKillList)
	writeList("Molotov/Incendiary kills", md.MollyKillList)
	writeList("Bomb (C4) kills", md.BombKillList)
	writeList("Team kills", md.TKList)
	writeList("Suicides / world deaths", md.SuicideList)
	fmt.Fprintf(w, "### Longest kill\n\n- %s\n\n", md.LongestKill)

	fmt.Fprintf(w, "---\n\n## 7. Bomb events (all)\n\n")
	for _, x := range md.BombEvents {
		fmt.Fprintf(w, "- %s\n", x)
	}

	fmt.Fprintf(w, "\n---\n\n## 8. Grenade trajectory samples (non-warmup throws/detonations)\n\n")
	fmt.Fprintf(w, "Total sampled: %d\n\n", len(md.GrenadeSamples))
	for _, x := range md.GrenadeSamples {
		fmt.Fprintf(w, "- %s\n", x)
	}

	fmt.Fprintf(w, "\n---\n\n## 9. Chat & system messages\n\n")
	fmt.Fprintf(w, "### Player chat (%d)\n\n", len(md.Chat))
	for _, x := range md.Chat {
		fmt.Fprintf(w, "- %s\n", x)
	}
	fmt.Fprintf(w, "\n### SayText / console (%d)\n\n", len(md.SayText))
	for _, x := range md.SayText {
		fmt.Fprintf(w, "- %s\n", x)
	}

	fmt.Fprintf(w, "\n---\n\n## 10. Rank updates (official MM)\n\n")
	for _, x := range md.RankUpdates {
		fmt.Fprintf(w, "- %s\n", x)
	}
	if len(md.RankUpdates) == 0 {
		fmt.Fprintf(w, "_None (FACEIT/third-party demos don't carry Valve rank updates unless the net-message decryption key is provided)._ \n")
	}

	fmt.Fprintf(w, "\n---\n\n## 11. Votes\n\n")
	for _, x := range md.Votes {
		fmt.Fprintf(w, "- %s\n", x)
	}
	if len(md.Votes) == 0 {
		fmt.Fprintf(w, "_None detected._\n")
	}

	fmt.Fprintf(w, "\n---\n\n## 12. Connections, names, teams\n\n")
	fmt.Fprintf(w, "### Connect / disconnect\n\n")
	for _, x := range md.Connections {
		fmt.Fprintf(w, "- %s\n", x)
	}
	fmt.Fprintf(w, "\n### Name changes\n\n")
	for _, x := range md.NameChanges {
		fmt.Fprintf(w, "- %s\n", x)
	}
	fmt.Fprintf(w, "\n### Team changes\n\n")
	for _, x := range md.TeamChanges {
		fmt.Fprintf(w, "- %s\n", x)
	}

	fmt.Fprintf(w, "\n---\n\n## 13. Match flow announcements, phases, halves, overtime\n\n")
	for _, x := range md.Announcements {
		fmt.Fprintf(w, "- %s\n", x)
	}
	fmt.Fprintf(w, "\n### Game phases\n\n")
	for _, x := range md.GamePhases {
		fmt.Fprintf(w, "- %s\n", x)
	}
	fmt.Fprintf(w, "\n### Halves\n\n")
	for _, x := range md.HalfTimes {
		fmt.Fprintf(w, "- %s\n", x)
	}
	fmt.Fprintf(w, "\n### Overtimes\n\n")
	for _, x := range md.Overtimes {
		fmt.Fprintf(w, "- %s\n", x)
	}

	fmt.Fprintf(w, "\n---\n\n## 14. Hostage events\n\n")
	for _, x := range md.HostageEvents {
		fmt.Fprintf(w, "- %s\n", x)
	}
	if len(md.HostageEvents) == 0 {
		fmt.Fprintf(w, "_None (bomb defusal map)._ \n")
	}

	fmt.Fprintf(w, "\n---\n\n## 15. Other deaths (non-player-weapons etc.)\n\n")
	for _, x := range md.OtherDeaths {
		fmt.Fprintf(w, "- %s\n", x)
	}
	if len(md.OtherDeaths) == 0 {
		fmt.Fprintf(w, "_None recorded._\n")
	}

	fmt.Fprintf(w, "\n---\n\n## 16. Utility damage leaderboard\n\n")
	fmt.Fprintf(w, "| Player | Utility dmg |\n|---|---|\n")
	udKeys := make([]string, 0, len(md.UtilDmgByPlayer))
	for k := range md.UtilDmgByPlayer {
		udKeys = append(udKeys, k)
	}
	sort.Slice(udKeys, func(i, j int) bool { return md.UtilDmgByPlayer[udKeys[i]] > md.UtilDmgByPlayer[udKeys[j]] })
	for _, k := range udKeys {
		fmt.Fprintf(w, "| %s | %d |\n", k, md.UtilDmgByPlayer[k])
	}

	fmt.Fprintf(w, "\n---\n\n## 17. Jumps per player (non-warmup)\n\n")
	jKeys := make([]string, 0, len(md.Jumps))
	for k := range md.Jumps {
		jKeys = append(jKeys, k)
	}
	sort.Slice(jKeys, func(i, j int) bool { return md.Jumps[jKeys[i]] > md.Jumps[jKeys[j]] })
	for _, k := range jKeys {
		fmt.Fprintf(w, "- %s: %d\n", k, md.Jumps[k])
	}

	fmt.Fprintf(w, "\n---\n\n## 18. Generic game-event type histogram (raw event names)\n\n")
	fmt.Fprintf(w, "Shows every raw game-event name the parser saw and how often:\n\n")
	fmt.Fprintf(w, "| Event | Count |\n|---|---|\n")
	gKeys := make([]string, 0, len(md.GenericEventCounts))
	for k := range md.GenericEventCounts {
		gKeys = append(gKeys, k)
	}
	sort.Slice(gKeys, func(i, j int) bool { return md.GenericEventCounts[gKeys[i]] > md.GenericEventCounts[gKeys[j]] })
	for _, k := range gKeys {
		fmt.Fprintf(w, "| `%s` | %d |\n", k, md.GenericEventCounts[k])
	}

	fmt.Fprintf(w, "\n---\n\n## 19. Parser warnings\n\n")
	if len(md.Warnings) > 0 {
		for _, x := range md.Warnings {
			fmt.Fprintf(w, "- %s\n", x)
		}
	} else {
		fmt.Fprintf(w, "_No parser warnings._\n")
	}

	fmt.Fprintf(w, "\n---\n\n## 20. Data categories NOT available from this parse\n\n")
	fmt.Fprintf(w, "The following data types exist in demos but are **not** exposed here (either encrypted for FACEIT/Valve MM, not recorded in GOTV, or outside this library's public API):\n\n")
	fmt.Fprintf(w, "- **Voice communications** (separate library: CS2VoiceData)\n")
	fmt.Fprintf(w, "- **Skin/paint/seed/wear** on weapons (not populated by this parser for CS2)\n")
	fmt.Fprintf(w, "- **Net-message payloads** in full (encrypted channels need `match730_*.dem.info` key via `MatchInfoDecryptionKey`)\n")
	fmt.Fprintf(w, "- **Raw ConVars / match metadata** locked behind encrypted `CMsgGCCStrike15V2_MatchInfo` / scoreboard GC messages\n")
	fmt.Fprintf(w, "- **Per-tick positions/angles of every player** for the whole demo (only live game-state + grenade trajectories are tracked; player position history must be recorded frame-by-frame yourself)\n")
	fmt.Fprintf(w, "- **Full buy-menu intent** (only item pickup/drop/equip events)\n")
	fmt.Fprintf(w, "- Server-side GOTV delay/caster audio\n")
	fmt.Fprintf(w, "\n---\n\n_Report complete. Source: demoinfocs-golang v6.0.0-rc.1, demo `%s` (%.1f MB)._ \n", md.FileName, float64(md.FileSize)/(1024*1024))

	log.Printf("report written to %s", outPath)
}

func totalOf(m map[string]int) int {
	s := 0
	for _, v := range m {
		s += v
	}
	return s
}

func unique(in []string) []string {
	seen := make(map[string]bool)
	var out []string
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}
