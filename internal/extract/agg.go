package extract

import (
	"fmt"
	"time"

	"github.com/ChristianWSmith/spectra/internal/analytics"
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/golang/geo/r3"
)

// headerInfo holds the demo header fields captured from the CDemoFileHeader
// net-message (demoinfocs v6 dropped Parser.Header()).
type headerInfo struct {
	mapName      string
	serverName   string
	clientName   string
	gameDir      string
	patchVersion int
	isPOV        bool
}

// metaInfo holds post-parse match-level facts (read from the parser and the
// final game state after ParseToEnd returns).
type metaInfo struct {
	tickRate       float64
	durationTicks  int
	frames         int
	entityClasses  int
	endEntityCount int
	parseMS        int64
	extractedAt    time.Time
}

// teamFinal is one side's end-of-demo team state.
type teamFinal struct {
	name       string
	flag       string
	score      int
	moneySpent int
	equipTotal int
}

// finalPlayer is one row of the end-of-demo roster snapshot (the subset of
// fields the extractor overwrites from the live entity state). Combat
// counters are deliberately absent — event-derived stats own K/D/A/MVP
// (see applyFinal).
type finalPlayer struct {
	key             uint64
	name            string
	side            string
	isBot           bool
	clanTag         string
	crosshairCode   string
	rank            int
	rankType        int
	wins            int
	ping            int
	alive           bool
	score           int
	moneySpentTotal int
}

// moneySample is one participant's freeze-time-end economy reading.
// spent is the live cumulative cash-spent counter (entity property
// m_pInGameMoneyServices.m_iTotalCashSpent) at this freeze end — freezeEnd
// diffs consecutive samples into the per-round side spend.
// freePistol is the equipment value of the free spawn-issued default
// pistols this participant still holds at the same instant
// (extract.freeSpawnPistolValue) — freezeEnd sums it per side into
// round_economy.free_pistol_value.
type moneySample struct {
	key        uint64
	name       string
	side       string
	money      int
	spent      int
	freePistol int
}

// roundInfo is one round's running state (models.Round at build time).
type roundInfo struct {
	number          int
	winner          string
	reason          string
	durationSec     float64
	startTick       int
	endTick         int
	warmup          bool
	pregame         bool
	mvp             string
	mvpReason       string
	equipCT         int
	equipT          int
	bombSite        string
	freezeEndTick   int
	firstKillSteam  string
	firstDeathSteam string
}

// tradeRec remembers one enemy kill for the strict trade-window rule: the
// killer (victimKey of a later kill trades them), when, and which side the
// dead player was on (a trade requires the later killer to be on that
// side — i.e. the death was a teammate's).
type tradeRec struct {
	tick       int
	killerKey  uint64
	victimSide string
}

// playerAgg is one participant's accumulator (models.Player + models.PlayerStats
// at build time), keyed by SteamID64 (synthetic key for bots).
type playerAgg struct {
	name            string
	isBot           bool
	side            string
	clanTag         string
	crosshairCode   string
	rank            int
	rankType        int
	wins            int
	ping            int
	finalAlive      bool
	kills           int
	deaths          int
	assists         int
	flashAssists    int
	headshots       int
	teamkills       int
	suicides        int
	mvps            int
	score           int
	totalDamage     int
	damageTaken     int
	shots           int
	hits            int
	moneySpentTotal int
	entryKills      int
	entryDeaths     int
	openingKills    int
	openingDeaths   int
	tradeKills      int
	killStreak      int
	bestStreak      int
	twoK            int
	threeK          int
	fourK           int
	fiveK           int
	utilityDamage   int
	enemiesFlashed  int
	flashedTimes    int
	bombPlants      int
	bombDefuses     int
	weaponKills     map[string]int
	weaponDmg       map[string]int
}

func newPlayerAgg(name string, bot bool) *playerAgg {
	return &playerAgg{
		name:        name,
		isBot:       bot,
		weaponKills: make(map[string]int),
		weaponDmg:   make(map[string]int),
	}
}

// rawWant remembers a typed event row awaiting its raw game-event payload.
type rawWant struct {
	idx  int
	name string
}

// agg is the match accumulator. Every demoinfocs handler funnels into one of
// its methods with plain value params, so the round state machine and the
// aggregation math are unit-testable without a parser.
type agg struct {
	header headerInfo
	meta   metaInfo

	players       map[uint64]*playerAgg
	finalPresent  map[uint64]bool
	participation map[uint64]map[int]bool

	rounds        []roundInfo
	currentRound  int
	warmupRounds  int
	pregameRounds int
	realRounds    int
	sideSwitches  int
	halfCT        int
	halfT         int
	// halfPending marks a GameHalfEnded observation awaiting the score
	// (which that event fires before — see freezeEnd).
	halfPending bool

	// victimHP tracks each participant's current-round health so damage
	// can be capped at the victim's remaining HP (external ADR basis —
	// overkill is not damage dealt). Reset every RoundStart; seeded from
	// the player_hurt `health` field (HP after the hit).
	victimHP map[uint64]int

	ctTeam teamFinal
	tTeam  teamFinal

	// tradeWindow keys recent victims → who killed them and when (the
	// strict trade-kill rule; reset every RoundStart).
	tradeWindow map[uint64]tradeRec
	roundKills  map[int]map[uint64]int

	// lastMVP tracks each player's scoreboard MVP counter for per-round
	// delta attribution at RoundEnd (RoundMVPAnnouncement is absent in
	// many demos, golden included).
	lastMVP map[uint64]int

	// lastSpent tracks each participant's cumulative money-spent counter
	// (m_iTotalCashSpent) at the previous freeze time end, so freezeEnd
	// can diff it into round_economy's per-round side spend.
	lastSpent map[uint64]int

	// lastHeldUtil tracks each participant's last EQUIPPED utility this
	// round (the death-drop util rule's "last held util first" input —
	// extract.inferDeathDrops): sampled every frame from the active
	// weapon (handlers.go FrameDone) and reset in roundStart alongside
	// the other per-round state (ONE home: roundStart).
	lastHeldUtil map[uint64]string

	roundSides []models.RoundPlayerSide

	economy  []models.RoundEconomy
	events   []models.Event
	generic  []models.GenericEvent
	chatRows []models.Chat
	warnings []string

	// svc_EncryptedData net-messages seen (M4): decrypted inner messages
	// dispatch as ordinary events, so this raw count is the extract's only
	// encrypted-chat provenance (models.Match.EncryptedMessages).
	encrypted int

	// Raw-payload pairing: demoinfocs dispatches the typed event before the
	// GenericGameEvent carrying the raw payload (same frame either way, typed
	// handlers may be delayed to frame end). Rows queued this frame are paired
	// with this frame's payloads in order at frame end.
	rawLatest  map[string]string
	frameQueue map[string][]string
	frameTyped []rawWant
}

func newAgg() *agg {
	return &agg{
		players:       make(map[uint64]*playerAgg),
		finalPresent:  make(map[uint64]bool),
		participation: make(map[uint64]map[int]bool),
		victimHP:      make(map[uint64]int),
		tradeWindow:   make(map[uint64]tradeRec),
		roundKills:    make(map[int]map[uint64]int),
		lastMVP:       make(map[uint64]int),
		lastSpent:     make(map[uint64]int),
		lastHeldUtil:  make(map[uint64]string),
		economy:       make([]models.RoundEconomy, 0, 64),
		roundSides:    make([]models.RoundPlayerSide, 0, 256),
		events:        make([]models.Event, 0, 512),
		generic:       make([]models.GenericEvent, 0, 21000),
		chatRows:      make([]models.Chat, 0, 64),
		warnings:      make([]string, 0, 8),
		rawLatest:     make(map[string]string),
		frameQueue:    make(map[string][]string),
	}
}

// ensure returns the participant's accumulator, creating it on first sighting
// (bots keep the synthetic key; names are never updated after creation — the
// final-state snapshot owns name/side/identity overwrites).
func (a *agg) ensure(key uint64, name string) *playerAgg {
	if p, ok := a.players[key]; ok {
		return p
	}
	p := newPlayerAgg(name, isBotKey(key))
	a.players[key] = p
	return p
}

// evRound is the extractor's current round number for stored rows. Rows
// emitted before the first RoundStart are attributed to round 1 so every
// stored row lands inside the match's round range.
func (a *agg) evRound() int {
	if a.currentRound < 1 {
		return 1
	}
	return a.currentRound
}

func (a *agg) setHeader(h headerInfo) { a.header = h }

func (a *agg) setPOV() { a.header.isPOV = true }

func (a *agg) setMeta(m metaInfo) { a.meta = m }

// countEncrypted bumps the svc_EncryptedData counter (net-message handler).
func (a *agg) countEncrypted() { a.encrypted++ }

func (a *agg) setFinalTeam(side string, t teamFinal) {
	if side == "t" {
		a.tTeam = t
	} else {
		a.ctTeam = t
	}
}

// setHalfPending records that a half ended; the score is resolved at the
// next freezeEnd (GameHalfEnded fires before the winning round's score
// increments — see freezeEnd).
func (a *agg) setHalfPending() { a.halfPending = true }

func (a *agg) sideSwitch() { a.sideSwitches++ }

func (a *agg) warn(typeID int, message string) {
	a.warnings = append(a.warnings, fmt.Sprintf("[type=%d] %s", typeID, message))
}

// applyFinal folds the end-of-demo roster snapshot into the accumulators:
// present players get their identity/scoreboard-only fields overwritten
// from live entity state and are marked FinalStatePresent (provenance).
// K/D/A/MVPs are deliberately NOT overwritten: event-derived stats follow
// one convention for every player (warmup/pregame excluded, flash assists
// split out) while the game's own counters disagree (m_iAssists includes
// flash assists; m_iMVPs included the golden demo's knife-round MVP).
func (a *agg) applyFinal(finals []finalPlayer) {
	for _, f := range finals {
		p := a.ensure(f.key, f.name)
		p.name = f.name
		p.isBot = f.isBot
		p.side = f.side
		p.clanTag = f.clanTag
		p.crosshairCode = f.crosshairCode
		p.rank = f.rank
		p.rankType = f.rankType
		p.wins = f.wins
		p.ping = f.ping
		p.finalAlive = f.alive
		p.score = f.score
		p.moneySpentTotal = f.moneySpentTotal
		a.finalPresent[f.key] = true
	}
}

// ---- round state machine ----

func (a *agg) roundStart(tick int, warmup, pregame bool, timeLimit int, objective string) {
	a.currentRound++
	switch {
	case warmup:
		a.warmupRounds++
	case pregame:
		a.pregameRounds++
	default:
		a.realRounds++
	}
	a.rounds = append(a.rounds, roundInfo{
		number:    a.currentRound,
		startTick: tick,
		warmup:    warmup,
		pregame:   pregame,
	})
	a.roundKills[a.currentRound] = make(map[uint64]int)
	a.tradeWindow = make(map[uint64]tradeRec)
	// Health resets with the round: every player spawns back at 100 HP.
	a.victimHP = make(map[uint64]int)
	// The last-held util is a PER-ROUND fact (the death-drop rule scopes
	// it to the round the death happens in) — cleared with the rest of
	// the per-round state here, the ONE round-reset home.
	a.lastHeldUtil = make(map[uint64]string)
	a.addEvent(models.Event{
		Tick:       tick,
		Kind:       models.EventRoundStart,
		DetailJSON: detailJSON(map[string]any{"timeLimit": timeLimit, "objective": objective}),
	}, "round_start")
}

func (a *agg) roundEnd(tick int, winner, reason, message string, tickRate float64) {
	if n := len(a.rounds); n > 0 {
		r := &a.rounds[n-1]
		r.winner = winner
		r.reason = reason
		r.endTick = tick
		if r.startTick > 0 && tick > r.startTick {
			tr := tickRate
			if tr <= 0 {
				tr = analytics.DefaultTickRate
			}
			r.durationSec = float64(tick-r.startTick) / tr
		}
	}
	a.addEvent(models.Event{
		Tick:       tick,
		Kind:       models.EventRoundEnd,
		DetailJSON: detailJSON(map[string]any{"winner": winner, "reason": reason, "message": message}),
	}, "round_end")
}

// freezeEnd records freeze-time-end ticks/equip values on the current round
// and samples each playing participant's money, cumulative money-spent
// counter, free spawn-issued default-pistol value and side per side (the
// extractor's sampling method, re-targeted at per-round-per-side
// RoundEconomy rows + per-round-per-player RoundPlayerSide rows). The
// per-side Spent on a RoundEconomy row is the sum of the participants'
// cumulative-spent deltas since the previous freeze end (see the loop
// below); the per-side FreePistolValue is the sum of their held free
// default pistols (round_economy.free_pistol_value — recorded for
// reference; they count inside equipment value, see
// extract.freeSpawnPistolValue).
//
// It also resolves the pending halftime score. GameHalfEnded fires BEFORE
// the final round of the half increments the team score (golden demo:
// reads 7/4 while the same tick's RoundEnd reads the settled 8/4), so the
// handler only marks the half pending; the first freeze-end after the side
// switch reads the settled, already-swapped scores and swaps them back.
func (a *agg) freezeEnd(tick, equipCT, equipT, scoreCT, scoreT int, samples []moneySample) {
	for _, s := range samples {
		if s.key == 0 {
			continue
		}
		a.ensure(s.key, s.name)
	}
	n := len(a.rounds)
	if n == 0 {
		return
	}
	r := &a.rounds[n-1]
	r.freezeEndTick = tick
	r.equipCT = equipCT
	r.equipT = equipT
	// Warmup and pregame (knife) rounds are not "counted" play: no
	// participation credit, no stat round. This predicate is the extract
	// twin of analytics.CountedRounds (`!warmup && !pregame`) and of the
	// store's SQL twin (`warmup = 0 AND pregame = 0` in store.GetEconomy) —
	// all three must stay identical or index-based rules (MR12 pistol
	// stride, half boundaries) shift.
	counted := !r.warmup && !r.pregame

	sum := map[string]int{}
	cnt := map[string]int{}
	spent := map[string]int{}
	freeP := map[string]int{}
	for _, s := range samples {
		if s.key == 0 {
			continue
		}
		// Per-round side spend: delta of the participant's cumulative
		// money-spent counter (m_iTotalCashSpent — live entity state)
		// since the previous freeze time end. A missing baseline (the
		// demo's first freeze end) or a counter that went DOWN (a match
		// restart resets it) reads from 0, so the current total is the
		// spend since that reset.
		prev, seen := a.lastSpent[s.key]
		delta := s.spent - prev
		if !seen || delta < 0 {
			delta = s.spent
		}
		a.lastSpent[s.key] = s.spent
		if s.side == "ct" || s.side == "t" {
			// Last-observed side: the final-side source for the players the
			// end-of-demo snapshot genuinely lacks (controller entity gone
			// before the demo's last tick — post-match leavers are kept, see
			// finalRoster), plus exact per-round rows for analytics/replay
			// consumers.
			if p := a.players[s.key]; p != nil {
				p.side = s.side
			}
			a.roundSides = append(a.roundSides, models.RoundPlayerSide{
				Round: r.number, SteamID: keyStr(s.key), Side: s.side,
			})
			sum[s.side] += s.money
			cnt[s.side]++
			spent[s.side] += delta
			freeP[s.side] += s.freePistol
		}
		if counted {
			rounds := a.participation[s.key]
			if rounds == nil {
				rounds = make(map[int]bool)
				a.participation[s.key] = rounds
			}
			rounds[r.number] = true
		}
	}
	a.economy = append(a.economy,
		models.RoundEconomy{Round: r.number, Side: "ct", EquipValue: equipCT, MoneySampledSum: sum["ct"], MoneySamples: cnt["ct"], Spent: spent["ct"], FreePistolValue: freeP["ct"]},
		models.RoundEconomy{Round: r.number, Side: "t", EquipValue: equipT, MoneySampledSum: sum["t"], MoneySamples: cnt["t"], Spent: spent["t"], FreePistolValue: freeP["t"]},
	)

	if a.halfPending {
		a.halfPending = false
		if a.sideSwitches > 0 {
			// Scores already reflect the swap — flip them back to the
			// first-half sides.
			a.halfCT, a.halfT = scoreT, scoreCT
		} else {
			a.halfCT, a.halfT = scoreCT, scoreT
		}
	}
}

// roundMVP fills the round's MVP fields from the round_mvp announcement
// (reason source). The COUNT is not incremented here — mvpScan's
// per-round counter diffs own counting so demos emitting both paths cannot
// double-credit.
func (a *agg) roundMVP(key uint64, name, reason string) {
	if n := len(a.rounds); n > 0 {
		r := &a.rounds[n-1]
		if key != 0 && r.mvp == "" {
			r.mvp = keyStr(key)
		}
		if r.mvpReason == "" {
			r.mvpReason = reason
		}
	}
}

// mvpScan diffs a player's scoreboard MVP counter at RoundEnd against the
// last observed value and credits the delta to the round being closed.
// RoundMVPAnnouncement is absent in many CS2 demos (golden included);
// m_iMVPs is not. The diff base starts at 0 so the first observed round
// carries the full count (correct when the counter increments inside the
// demo, e.g. the golden demo's knife-round MVP — which the game's own
// counter includes and the external scoreboard matches). Warmup rounds are
// never credited.
func (a *agg) mvpScan(key uint64, name string, count int) {
	if key == 0 {
		return
	}
	prev := a.lastMVP[key]
	a.lastMVP[key] = count
	delta := count - prev
	if delta <= 0 {
		return
	}
	n := len(a.rounds)
	if n == 0 || a.rounds[n-1].warmup {
		return
	}
	p := a.ensure(key, name)
	p.mvps += delta
	if a.rounds[n-1].mvp == "" {
		a.rounds[n-1].mvp = keyStr(key)
	}
}

// ---- combat ----

// killInfo carries the plain values a Kill handler extracts from the event.
// real marks stats-eligible play (warmup/pregame/post-match excluded —
// handlers compute it via realPeriod).
type killInfo struct {
	tick          int
	real          bool
	tickRate      float64
	killerKey     uint64
	killerName    string
	killerSide    string
	victimKey     uint64
	victimName    string
	victimSide    string
	assisterKey   uint64
	assisterName  string
	assisterSide  string
	weapon        string
	headshot      bool
	wallbang      bool
	noscope       bool
	throughSmoke  bool
	attackerBlind bool
	assistedFlash bool
	distance      float64
	samePlayer    bool
	// Victim position at handler time (nil when unknown).
	posX, posY, posZ *float64
	// Attacker position at handler time (nil when unknown) — the kills
	// heatmap plots where the killer was, the deaths heatmap where the
	// victim fell.
	attackerPosX, attackerPosY, attackerPosZ *float64
	// matePos are the world positions of the victim's living teammates at
	// the death tick (killer/victim excluded, unknown positions dropped):
	// the raw input for the trade-opportunity proximity stored on the kill
	// event as detail_json.nearDist (config-independent, measured once).
	matePos []r3.Vector
	// inv is the victim's inventory AT the kill tick (dropInventory —
	// names + gun ammo), the input for the death-drop inference below.
	inv []inventoryItem
}

func (a *agg) kill(k killInfo) {
	// Trade-opportunity proximity (config-independent, measured once at
	// extract time): the closest living teammate of the victim to the
	// KILLER at this death tick, -1 when nobody is measurable. Stored on
	// the kill event as detail_json.nearDist; store.GetCombatStats gates
	// "Trade opp missed" on it against analysis_config.trade_opp_distance.
	nearDist := -1.0
	if k.attackerPosX != nil && k.attackerPosY != nil && k.attackerPosZ != nil {
		nearDist = nearTeammateDist(
			r3.Vector{X: *k.attackerPosX, Y: *k.attackerPosY, Z: *k.attackerPosZ},
			k.matePos,
		)
	}
	a.addEvent(models.Event{
		Tick:          k.tick,
		Kind:          models.EventKill,
		Attacker:      keyStr(k.killerKey),
		Victim:        keyStr(k.victimKey),
		Assister:      keyStr(k.assisterKey),
		Weapon:        k.weapon,
		Headshot:      k.headshot,
		Wallbang:      k.wallbang,
		Noscope:       k.noscope,
		ThroughSmoke:  k.throughSmoke,
		AttackerBlind: k.attackerBlind,
		AssistedFlash: k.assistedFlash,
		Distance:      k.distance,
		PosX:          k.posX,
		PosY:          k.posY,
		PosZ:          k.posZ,
		AttackerPosX:  k.attackerPosX,
		AttackerPosY:  k.attackerPosY,
		AttackerPosZ:  k.attackerPosZ,
		DetailJSON: detailJSON(map[string]any{
			"killer":   k.killerName,
			"victim":   k.victimName,
			"assister": k.assisterName,
			"nearDist": nearDist,
		}),
	}, "player_death")

	// Death drops (weapon_drop — inference, no raw game event of its
	// own): one row per inferred drop (a gun + at most one util, the
	// inferDeathDrops rules). The position is the VICTIM's position at
	// the kill tick, stored exactly like bomb_drop stores the C4
	// carrier's position at release: the item's real landing spot is a
	// physics result the demo does not record — "stored at release, may
	// slide short" (CS2.md's dropped-C4 caveat — same accepted
	// semantics here). A victim with no stored position (zero vector)
	// still stores the row — the frontend draws nothing without
	// coordinates (drops.js), never a guessed one.
	//
	// Emitted for EVERY kill (warmup/pregame included) like the kill row
	// itself: these are evidence rows for the map layer, not stats.
	for _, d := range inferDeathDrops(k.inv, a.lastHeldUtil[k.victimKey]) {
		detail := map[string]any{
			"player": k.victimName,
			"cat":    d.cat,
			"source": "victim",
		}
		if d.cat == "gun" {
			// Dropped guns track their ammo/mag state at death — the
			// authoritative mag/reserve on the row (util carries none).
			detail["mag"] = d.mag
			detail["reserve"] = d.reserve
		}
		a.addEvent(models.Event{
			Tick:       k.tick,
			Kind:       models.EventWeaponDrop,
			Attacker:   keyStr(k.victimKey),
			Weapon:     d.name,
			PosX:       k.posX,
			PosY:       k.posY,
			PosZ:       k.posZ,
			DetailJSON: detailJSON(detail),
		}, "")
	}

	// Warmup knife fights, pregame (knife) rounds and post-match kills
	// never pollute stats (event rows are still emitted).
	if !k.real {
		return
	}

	// Live side observation: the freshest side truth for identity.
	if k.victimSide == "ct" || k.victimSide == "t" {
		a.ensure(k.victimKey, k.victimName).side = k.victimSide
	}

	// Victim bookkeeping: every real death counts (incl. suicides and
	// teamkills — the scoreboard's D column does too).
	if k.victimKey != 0 {
		vp := a.ensure(k.victimKey, k.victimName)
		vp.deaths++
		vp.killStreak = 0
		if k.samePlayer {
			vp.suicides++
		}
	}

	// Killer credit requires a real ENEMY kill: no credit for world/no
	// killer, suicides (killer == victim) or teamkills — only kills++ for
	// enemies (awpy/HLTV convention; the game's scoreboard agrees).
	if k.killerKey == 0 || k.samePlayer {
		return
	}
	kp := a.ensure(k.killerKey, k.killerName)
	if k.killerSide == "ct" || k.killerSide == "t" {
		kp.side = k.killerSide
	}
	if sameSide(k.killerSide, k.victimSide) {
		kp.teamkills++
		return
	}
	kp.kills++
	kp.weaponKills[k.weapon]++
	if k.headshot {
		kp.headshots++
	}

	// Strict trade: a kill answers a teammate's death when the victim is
	// the player who killed one of the killer's teammates within the
	// 5 s window (HLTV/Leetify rule — the KAST "T" rule mirrored).
	//
	// This is the IMPORT-TIME DEFAULT only: the extractor has no access
	// to analysis_config, so analytics.Compute rewrites
	// player_stats.trade_kills from the cfg-aware engagements pass right
	// after import (and on every rule recompute). The two rules must stay
	// equivalent at 5 s — pinned by the golden trade-rule test — and the
	// gates here (enemy kills only: no teamkills, no suicides, no
	// post-match kills) are mirrored in analytics.Engagements.
	if k.victimKey != 0 && k.killerSide != "" {
		tr := k.tickRate
		if tr <= 0 {
			tr = analytics.DefaultTickRate
		}
		window := int(5 * tr)
		for _, rec := range a.tradeWindow {
			if rec.killerKey == k.victimKey && k.tick-rec.tick <= window &&
				rec.victimSide == k.killerSide {
				kp.tradeKills++
				break
			}
		}
	}

	// First blood of the round: entry + opening attribution.
	if n := len(a.rounds); n > 0 {
		r := &a.rounds[n-1]
		if r.firstKillSteam == "" {
			r.firstKillSteam = keyStr(k.killerKey)
			r.firstDeathSteam = keyStr(k.victimKey)
			kp.entryKills++
			kp.openingKills++
		}
	}

	// Per-round multi-kills: only the running count is kept here — the
	// exact 2K/3K/4K/5K tiers are decided in build() from the round's final
	// total (external scoreboards count a round at exactly one tier: a
	// 4-kill round is a 4K, not also a 3K).
	if a.roundKills[a.currentRound] == nil {
		a.roundKills[a.currentRound] = make(map[uint64]int)
	}
	a.roundKills[a.currentRound][k.killerKey]++

	kp.killStreak++
	if kp.killStreak > kp.bestStreak {
		kp.bestStreak = kp.killStreak
	}

	// Record the death for future trade checks (who killed whom, when).
	if k.victimKey != 0 {
		a.tradeWindow[k.victimKey] = tradeRec{tick: k.tick, killerKey: k.killerKey, victimSide: k.victimSide}
	}

	// Entry/opening death: the first-blood victim.
	if n := len(a.rounds); n > 0 {
		r := &a.rounds[n-1]
		if r.firstDeathSteam != "" && r.firstDeathSteam == keyStr(k.victimKey) {
			vp := a.players[k.victimKey]
			if vp == nil {
				vp = a.ensure(k.victimKey, k.victimName)
			}
			vp.entryDeaths++
			vp.openingDeaths++
		}
	}

	// Assists: cross-team only (no suicide/teamkill assists), and flash
	// assists are split into their own column — external scoreboards
	// exclude them from the assist column (the game's m_iAssists
	// includes them).
	if k.assisterKey != 0 && k.assisterKey != k.victimKey &&
		!sameSide(k.assisterSide, k.victimSide) {
		ap := a.ensure(k.assisterKey, k.assisterName)
		if k.assistedFlash {
			ap.flashAssists++
		} else {
			ap.assists++
		}
	}
}

// hurtInfo carries the plain values a PlayerHurt handler extracts. real
// marks stats-eligible play (warmup/pregame/post-match excluded).
type hurtInfo struct {
	tick              int
	real              bool
	attackerKey       uint64
	attackerName      string
	attackerSide      string
	victimKey         uint64
	victimName        string
	victimSide        string
	weapon            string
	isUtility         bool
	healthDamage      int
	healthDamageTaken int
	health            int
	hitgroup          string
	// Victim hit position at handler time (nil when unknown).
	posX, posY, posZ *float64
}

func (a *agg) hurt(h hurtInfo) {
	// Every PlayerHurt becomes an event (raw damage stream is never
	// gated); stat accumulation below is gated.
	a.addEvent(models.Event{
		Tick:     h.tick,
		Kind:     models.EventDamage,
		Attacker: keyStr(h.attackerKey),
		Victim:   keyStr(h.victimKey),
		Weapon:   h.weapon,
		Dmg:      h.healthDamage,
		Hitgroup: h.hitgroup,
		PosX:     h.posX,
		PosY:     h.posY,
		PosZ:     h.posZ,
		DetailJSON: detailJSON(map[string]any{
			"attacker":    h.attackerName,
			"victim":      h.victimName,
			"health":      h.health,
			"damageTaken": h.healthDamageTaken,
		}),
	}, "player_hurt")

	if !h.real {
		return
	}
	// Health bookkeeping for EVERY real hit (team/world damage drains HP
	// too) — the returned credit is capped at the victim's remaining HP.
	dealt := a.capDamage(h.victimKey, h.healthDamage, h.health)
	// Attacker stats count ENEMY damage only — friendly fire and self
	// damage are not "damage dealt" on any scoreboard (awpy/HLTV/ProSettings).
	enemy := h.attackerKey != 0 && h.attackerKey != h.victimKey &&
		!sameSide(h.attackerSide, h.victimSide)
	if enemy {
		ap := a.ensure(h.attackerKey, h.attackerName)
		ap.totalDamage += dealt
		ap.hits++
		ap.weaponDmg[h.weapon] += dealt
		if h.isUtility {
			ap.utilityDamage += dealt
		}
	}
	if h.victimKey != 0 {
		a.ensure(h.victimKey, h.victimName).damageTaken += h.healthDamageTaken
	}
}

// capDamage credits one hit at most the victim's remaining HP — external
// ADR/total-damage boards do not count overkill (a 115-damage AWP hit on
// a 10-HP player dealt 10 damage). HP is tracked per round, starting at
// 100, and updated from the player_hurt `health` field (the victim's HP
// AFTER the hit), which is authoritative — simulating `before - dmg`
// drifts (events the extractor does not model, e.g. world damage).
// Returns the damage credit for this hit (0 when the victim is already
// down or the hit is outside a tracked victim).
func (a *agg) capDamage(victim uint64, dmg, healthAfter int) int {
	if victim == 0 || dmg <= 0 {
		return 0
	}
	before, ok := a.victimHP[victim]
	if !ok {
		before = 100
	}
	dealt := dmg
	switch {
	case before <= 0:
		dealt = 0
	case dealt > before:
		dealt = before
	}
	after := healthAfter
	if after < 0 {
		after = 0
	}
	if after == 0 {
		// `health` is 0 both for a kill and for an absent field: trust the
		// field only when the simulation agrees the victim went down.
		if sim := before - dmg; sim > 0 {
			after = sim
		}
	}
	a.victimHP[victim] = after
	return dealt
}

func (a *agg) shot(key uint64, name string) {
	if key == 0 {
		return
	}
	a.ensure(key, name).shots++
}

// blindInfo carries the plain values a PlayerFlashed handler extracts.
// playerSide/attackerSide are the live entity sides at handler time — the
// enemy check for the thrower's credit (see blind).
type blindInfo struct {
	tick         int
	real         bool
	playerKey    uint64
	playerName   string
	playerSide   string
	attackerKey  uint64
	attackerName string
	attackerSide string
	flashMs      int
}

func (a *agg) blind(b blindInfo) {
	a.addEvent(models.Event{
		Tick:     b.tick,
		Kind:     models.EventBlind,
		Attacker: keyStr(b.attackerKey),
		Victim:   keyStr(b.playerKey),
		DetailJSON: detailJSON(map[string]any{
			"player":          b.playerName,
			"attacker":        b.attackerName,
			"flashDurationMs": b.flashMs,
		}),
	}, "player_blind")
	if !b.real {
		return
	}
	if b.playerKey != 0 {
		a.ensure(b.playerKey, b.playerName).flashedTimes++
	}
	// Enemies flashed: credit the THROWER once per blinded enemy player
	// (player_blind fires per player blinded by the flash — CS2.md
	// "Enemies flashed"). Teammates and self-blinds credit nothing: same
	// cross-team rule as assists/damage (sameSide — an unknown side never
	// matches). Warmup/pregame blinds are already gated by b.real.
	if b.attackerKey != 0 && b.attackerKey != b.playerKey &&
		!sameSide(b.attackerSide, b.playerSide) {
		a.ensure(b.attackerKey, b.attackerName).enemiesFlashed++
	}
}

// ---- utility & objective ----

// blastInfo carries a grenade detonation (EventGrenade); source is the game
// event the raw payload will be paired from.
type blastInfo struct {
	tick        int
	weapon      string
	source      string
	throwerKey  uint64
	throwerName string
	x, y, z     float64
}

func (a *agg) grenadeBlast(g blastInfo) {
	px, py, pz := pos3(g.x, g.y, g.z)
	a.addEvent(models.Event{
		Tick:     g.tick,
		Kind:     models.EventGrenade,
		Attacker: keyStr(g.throwerKey),
		Weapon:   g.weapon,
		PosX:     px,
		PosY:     py,
		PosZ:     pz,
		DetailJSON: detailJSON(map[string]any{
			"thrower": g.throwerName,
			"grenade": g.weapon,
			"x":       g.x,
			"y":       g.y,
			"z":       g.z,
		}),
	}, g.source)
}

// grenadeThrown is entity-derived (projectile created), so it has no raw
// game-event payload to pair. px/py/pz are the throw position (nil when
// the projectile entity had no position yet).
func (a *agg) grenadeThrown(tick int, throwerKey uint64, throwerName, weapon string, px, py, pz *float64) {
	a.addEvent(models.Event{
		Tick:     tick,
		Kind:     models.EventGrenadeThrow,
		Attacker: keyStr(throwerKey),
		Weapon:   weapon,
		PosX:     px,
		PosY:     py,
		PosZ:     pz,
		DetailJSON: detailJSON(map[string]any{
			"thrower": throwerName,
			"grenade": weapon,
		}),
	}, "")
}

func (a *agg) bombPlanted(tick int, site string, key uint64, name string, real bool, px, py, pz *float64) {
	if n := len(a.rounds); n > 0 {
		a.rounds[n-1].bombSite = site
	}
	if key != 0 && real {
		a.ensure(key, name).bombPlants++
	}
	a.addEvent(models.Event{
		Tick:       tick,
		Kind:       models.EventBombPlant,
		Attacker:   keyStr(key),
		Site:       site,
		PosX:       px,
		PosY:       py,
		PosZ:       pz,
		DetailJSON: detailJSON(map[string]any{"player": name}),
	}, "bomb_planted")
}

func (a *agg) bombDefused(tick int, site string, key uint64, name string, hasKit bool, real bool, px, py, pz *float64) {
	if key != 0 && real {
		a.ensure(key, name).bombDefuses++
	}
	a.addEvent(models.Event{
		Tick:       tick,
		Kind:       models.EventBombDefuse,
		Attacker:   keyStr(key),
		Site:       site,
		PosX:       px,
		PosY:       py,
		PosZ:       pz,
		DetailJSON: detailJSON(map[string]any{"player": name, "hasKit": hasKit}),
	}, "bomb_defused")
}

// The plant/defuse ATTEMPT lifecycle rows (models.EventBombPlantBegin …
// EventBombDefuseAbort): they OPEN/CANCEL an attempt the frontend pairs
// with the completion rows above (lib/replay/bomb.js actionIntervals —
// THE interval rule; no stat counts these rows). source is the raw game
// event paired into raw_json: bomb_beginplant / bomb_begindefuse exist
// for every attempt (raw counts matched attempt counts 1:1 on all seven
// golden demos), while the *_abort cancels have NO raw counterpart
// (there is no bomb_abortplant/defuse event in CS2) — their source is "",
// like the other entity-derived rows with no game event (grenadeThrown).
func (a *agg) bombPlantBegin(tick int, site string, key uint64, name string) {
	a.addEvent(models.Event{
		Tick:       tick,
		Kind:       models.EventBombPlantBegin,
		Attacker:   keyStr(key),
		Site:       site,
		DetailJSON: detailJSON(map[string]any{"player": name}),
	}, "bomb_beginplant")
}

func (a *agg) bombPlantAborted(tick int, key uint64, name string) {
	a.addEvent(models.Event{
		Tick:       tick,
		Kind:       models.EventBombPlantAbort,
		Attacker:   keyStr(key),
		DetailJSON: detailJSON(map[string]any{"player": name}),
	}, "")
}

func (a *agg) bombDefuseStart(tick int, site string, key uint64, name string, hasKit bool) {
	a.addEvent(models.Event{
		Tick:       tick,
		Kind:       models.EventBombDefuseStart,
		Attacker:   keyStr(key),
		Site:       site,
		DetailJSON: detailJSON(map[string]any{"player": name, "hasKit": hasKit}),
	}, "bomb_begindefuse")
}

func (a *agg) bombDefuseAborted(tick int, key uint64, name string) {
	a.addEvent(models.Event{
		Tick:       tick,
		Kind:       models.EventBombDefuseAbort,
		Attacker:   keyStr(key),
		DetailJSON: detailJSON(map[string]any{"player": name}),
	}, "")
}

func (a *agg) bombExploded(tick int, site string, px, py, pz *float64) {
	a.addEvent(models.Event{
		Tick:       tick,
		Kind:       models.EventBombExplode,
		Site:       site,
		PosX:       px,
		PosY:       py,
		PosZ:       pz,
		DetailJSON: detailJSON(map[string]any{"site": site}),
	}, "bomb_exploded")
}

// bombDropped records a bomb_drop WITH position evidence: pos* is the
// carrier's position at the drop tick (the drop site — see the handler
// for the death-drop reasoning), and bx/by/bz the bomb entity's own
// position when known (extra DetailJSON evidence, omitted otherwise).
// DetailJSON tags source "carrier" so consumers know which position the
// columns carry without guessing provenance.
func (a *agg) bombDropped(tick int, key uint64, name string, px, py, pz *float64, bx, by, bz *float64) {
	detail := map[string]any{"player": name, "source": "carrier"}
	if bx != nil && by != nil && bz != nil {
		detail["bombPos"] = []float64{*bx, *by, *bz}
	}
	a.addEvent(models.Event{
		Tick:       tick,
		Kind:       models.EventBombDrop,
		Attacker:   keyStr(key),
		PosX:       px,
		PosY:       py,
		PosZ:       pz,
		DetailJSON: detailJSON(detail),
	}, "bomb_dropped")
}

// bombPickedUp records a bomb_pickup WITH position evidence: where the
// pickup happened (bomb entity position, falling back to the pickup
// player's position — the handler resolves and flags the source).
func (a *agg) bombPickedUp(tick int, key uint64, name string, px, py, pz *float64, source string) {
	a.addEvent(models.Event{
		Tick:       tick,
		Kind:       models.EventBombPickup,
		Attacker:   keyStr(key),
		PosX:       px,
		PosY:       py,
		PosZ:       pz,
		DetailJSON: detailJSON(map[string]any{"player": name, "source": source}),
	}, "bomb_pickup")
}

// noteHeldUtil records one participant's currently equipped utility for
// the death-drop "last held util" rule (per-frame from the FrameDone
// handler in handlers.go; reset every roundStart — see lastHeldUtil).
func (a *agg) noteHeldUtil(key uint64, weapon string) {
	if key == 0 || weapon == "" {
		return
	}
	a.lastHeldUtil[key] = weapon
}

// weaponPickedUp records a weapon_pickup row: someone acquired a gun or
// util item at this tick (item_pickup — buys and spawn restocks included
// at extract time, see the handler), at their own position. The cat is
// the stored classification ("gun"|"util") so consumers never re-derive
// it. The raw item_pickup payload pairs onto the row (source).
func (a *agg) weaponPickedUp(tick int, key uint64, name, weapon, cat string, px, py, pz *float64) {
	a.addEvent(models.Event{
		Tick:       tick,
		Kind:       models.EventWeaponPickup,
		Attacker:   keyStr(key),
		Weapon:     weapon,
		PosX:       px,
		PosY:       py,
		PosZ:       pz,
		DetailJSON: detailJSON(map[string]any{"player": name, "cat": cat}),
	}, "item_pickup")
}

// ---- people, chat, meta ----

func (a *agg) connect(tick int, key uint64, name string, bot bool) {
	a.addEvent(models.Event{
		Tick:       tick,
		Kind:       models.EventConnect,
		Attacker:   keyStr(key),
		DetailJSON: detailJSON(map[string]any{"name": name, "bot": bot}),
	}, "")
}

func (a *agg) disconnect(tick int, key uint64, name string) {
	a.addEvent(models.Event{
		Tick:       tick,
		Kind:       models.EventDisconnect,
		Attacker:   keyStr(key),
		DetailJSON: detailJSON(map[string]any{"name": name}),
	}, "")
}

func (a *agg) chat(tick int, steam, name, text string) {
	a.chatRows = append(a.chatRows, models.Chat{
		Tick:    tick,
		Round:   a.evRound(),
		SteamID: steam,
		Name:    name,
		Text:    text,
		Kind:    "chat",
	})
}

func (a *agg) systemChat(tick int, text string) {
	a.chatRows = append(a.chatRows, models.Chat{
		Tick:  tick,
		Round: a.evRound(),
		Text:  text,
		Kind:  "system",
	})
}

func (a *agg) rankUpdate(key uint64, name string, rank, wins int) {
	if key == 0 {
		return
	}
	p := a.ensure(key, name)
	p.rank = rank
	p.wins = wins
}

// ---- events, generic events, raw pairing ----

// addEvent appends a typed event; Round is stamped with the extractor's
// current round number (clamped to >= 1). source is the originating game
// event name whose raw payload is paired at frame end ("" when there is no
// game-event source).
func (a *agg) addEvent(ev models.Event, source string) {
	ev.Round = a.evRound()
	a.events = append(a.events, ev)
	if source != "" {
		a.frameTyped = append(a.frameTyped, rawWant{idx: len(a.events) - 1, name: source})
	}
}

// genericEvent stores one raw game-event row and queues its payload for
// pairing with this frame's typed events.
func (a *agg) genericEvent(name string, tick int, payload string) {
	a.rawLatest[name] = payload
	a.frameQueue[name] = append(a.frameQueue[name], payload)
	a.generic = append(a.generic, models.GenericEvent{
		Name:        name,
		Tick:        tick,
		Round:       a.evRound(),
		PayloadJSON: payload,
	})
}

// flushRaw pairs this frame's typed event rows with this frame's raw payloads
// (both in chronological order) and resets the frame buffers. Called at every
// FrameDone and once after the parse ends.
func (a *agg) flushRaw() {
	if len(a.frameTyped) > 0 {
		counts := make(map[string]int, len(a.frameTyped))
		for _, w := range a.frameTyped {
			n := counts[w.name]
			q := a.frameQueue[w.name]
			switch {
			case n < len(q):
				a.pairRaw(w.idx, w.name, q[n])
			case len(q) == 0:
				// No payload this frame: fall back to the last one seen
				// (cross-frame dispatch, e.g. datatables-driven round events).
				if r := a.rawLatest[w.name]; r != "" {
					a.pairRaw(w.idx, w.name, r)
				}
			}
			counts[w.name] = n + 1
		}
		a.frameTyped = a.frameTyped[:0]
	}
	for k := range a.frameQueue {
		delete(a.frameQueue, k)
	}
}

// pairRaw stores the paired raw payload on the typed row and derives the ONE
// kill flag that ONLY the payload carries: player_death's `attackerinair`
// (the attacker was midair).
//
// Seam note: this runs at flush time, NOT in the Kill handler — verified on
// the golden parse (2026-11-08), demoinfocs dispatches the typed events.Kill
// BEFORE the events.GenericGameEvent for the same game event (all 170
// golden deaths: kill-first, generic-first 0), and events.Kill has no MidAir
// field at all. The raw payload is the ground truth, so the flag is derived
// from the SAME string stored as raw_json — an absent/unparseable payload
// reads false (fail soft, never guessed), and only "player_death" is
// consulted (the source a.kill tags its rows with).
func (a *agg) pairRaw(idx int, name, payload string) {
	a.events[idx].RawJSON = payload
	if name == "player_death" {
		a.events[idx].AttackerInAir = payloadBool(payload, "attackerinair")
	}
}
