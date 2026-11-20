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
	name  string
	flag  string
	score int
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

// moneyEndSample is one participant's round-END economy reading — the
// source of player_round_stats' money columns. startAccount is
// m_iStartAccount (money held at round start, before buys); equipStart
// is m_unRoundStartEquipmentValue (carried gear before freeze-time
// buys, free spawn pistol included); spent is m_iCashSpentThisRound (the
// game's own per-round spend counter, complete only once mp_buytime has
// closed — hence RoundEnd rather than freeze end; see the RoundEnd
// handler). All three round-stable or round-final as characterized by
// TestDiagRoundMoneyProps.
type moneyEndSample struct {
	key          uint64
	startAccount int
	equipStart   int
	spent        int
}

// roundInfo is one round's running state (models.Round at build time).
// Only COUNTED rounds are ever accumulated here: knife/warmup/post-match
// rounds are discarded at ingest (see agg.roundStart), so the stored set
// holds counted play only.
type roundInfo struct {
	number          int
	winner          string
	reason          string
	durationSec     float64
	startTick       int
	endTick         int
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
}

func newPlayerAgg(name string, bot bool) *playerAgg {
	return &playerAgg{
		name:        name,
		isBot:       bot,
		weaponKills: make(map[string]int),
	}
}

// rawWant remembers a typed event row awaiting its raw game-event payload.
type rawWant struct {
	idx  int
	name string
}

// pendingWorldKill is one deferred World self-kill awaiting the
// disconnect-time criterion (agg.kill defers, flushWorldSelf decides):
// only the fields the victim bookkeeping needs, copied at dispatch.
type pendingWorldKill struct {
	tick       int
	victimKey  uint64
	victimName string
	victimSide string
}

// takeoverRec is one bot_takeover transition — tick-accurate bookkeeping
// only (no user-visible output yet; see agg.takeovers).
type takeoverRec struct {
	tick      int
	takerKey  uint64
	takerName string
	botKey    uint64
	botName   string
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

	rounds       []roundInfo
	currentRound int
	realRounds   int
	// discarding marks that the CURRENT round (or, before the first
	// RoundStart, nothing yet) is not counted play — a knife/warmup/
	// post-match round. While it is set no row of any family is stored
	// and no a.rounds[last] write happens (the owner's knife/warmup
	// discard: those rounds "shouldn't be ingested… discarded entirely").
	// Rows emitted BEFORE the demo's first round are kept and belong to
	// it — unless that first round itself turns out to be discarded, in
	// which case dropPrefix wipes them with it.
	discarding   bool
	sideSwitches int
	halfCT       int
	halfT        int
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

	// disconnectTick is each identity's LAST observed disconnect tick —
	// the first half of the disconnect-time World self-kill criterion
	// (kill / flushWorldSelf): a self-kill at exactly this tick for this
	// key is the fake death the game fires when a player leaves or a
	// substitute bot is kicked (ruling, lead 2026-11-17, owner's
	// reconnect-takeover report). A SET of ticks would be over-precise:
	// flushWorldSelf decides within the same frame, so the map only ever
	// holds the current or an older tick and the equality check does the
	// rest.
	disconnectTick map[uint64]int

	// pendingWorldSelf holds World self-kills awaiting that criterion's
	// decision: the kill may dispatch BEFORE the player_disconnect within
	// the same frame (both orders observed on the owner's repro demo —
	// 81343 kill-first, 89867 disconnect-first), so the stat application
	// is deferred to flushWorldSelf at frame end, when both are in.
	pendingWorldSelf []pendingWorldKill

	// takeovers logs every bot_takeover transition (tick + both
	// identities) — tick-accurate bookkeeping with no user-visible
	// output yet (owner's 2026-11-17 takeover ruling): the remap itself
	// is resolved live from the controller props on every read, this log
	// pins WHEN control changed hands.
	takeovers []takeoverRec

	roundSides []models.RoundPlayerSide

	// roundMoney holds the round-end per-player economy samples
	// (moneyEndSample → models.RoundPlayerMoney) behind player_round_stats'
	// money columns — one row per connected participant per counted round.
	roundMoney []models.RoundPlayerMoney

	economy  []models.RoundEconomy
	events   []models.Event
	generic  []models.GenericEvent
	chatRows []models.Chat
	warnings []string

	// soundEvents are the player sounds (footsteps/lands/jumps/fall
	// damage) read from CMsgSosStartSoundEvent — stamped with the current
	// round like every other row and renumbered with them (build.renumber);
	// sounds of a discarded round are never stored (agg.soundEvent).
	soundEvents []models.SoundEvent

	// bounceSeen dedupes grenade-bounce SOS messages by (source entity,
	// tick, name): 87% of bounces fire TWO messages (their origins differ
	// by <1 u) and the FIRST one wins (its origin is the row's position).
	bounceSeen map[bounceKey]bool

	// blastSeen dedupes detonations the parser dispatches TWICE: exactly
	// one stored detonation row per (tick, thrower, weapon), FIRST
	// dispatch wins (its position is the row's). Today the only such twin
	// is FlashExplode — demoinfocs-golang v6 fires it from BOTH the
	// flashbang_detonate game event (game_events.go flashBangDetonate) and
	// the flash projectile's entity on-destroy handler (datatables.go
	// stOnDestroy) — so this is a no-op for the once-dispatched kinds and
	// self-heals any future mimic twin (the general criterion is "the
	// parser dispatches some detonations twice", not "flashes"). See the
	// FlashExplode handler in handlers.go and CS2.md "A flashbang
	// detonation fires TWICE in demoinfocs-golang v6". Accepted edge: two
	// DISTINCT same-kind nades from one thrower in the identical tick
	// would merge — impossible in practice (0 occurrences library-wide).
	blastSeen map[blastKey]bool

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
		players:        make(map[uint64]*playerAgg),
		finalPresent:   make(map[uint64]bool),
		participation:  make(map[uint64]map[int]bool),
		victimHP:       make(map[uint64]int),
		tradeWindow:    make(map[uint64]tradeRec),
		roundKills:     make(map[int]map[uint64]int),
		lastMVP:        make(map[uint64]int),
		lastSpent:      make(map[uint64]int),
		lastHeldUtil:   make(map[uint64]string),
		disconnectTick: make(map[uint64]int),
		economy:        make([]models.RoundEconomy, 0, 64),
		roundSides:     make([]models.RoundPlayerSide, 0, 256),
		roundMoney:     make([]models.RoundPlayerMoney, 0, 256),
		events:         make([]models.Event, 0, 512),
		generic:        make([]models.GenericEvent, 0, 21000),
		chatRows:       make([]models.Chat, 0, 64),
		warnings:       make([]string, 0, 8),
		soundEvents:    make([]models.SoundEvent, 0, 1024),
		bounceSeen:     make(map[bounceKey]bool, 512),
		blastSeen:      make(map[blastKey]bool, 128),
		rawLatest:      make(map[string]string),
		frameQueue:     make(map[string][]string),
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
// stored row lands inside the match's round range (build.renumber maps
// them onto the first stored round; when that first round is discarded,
// dropPrefix has already wiped them).
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
// one convention for every player (counted rounds only — knife/warmup
// rounds are discarded at ingest — flash assists split out) while the
// game's own counters disagree (m_iAssists includes flash assists;
// m_iMVPs includes the golden demo's knife-round MVP, which the extractor
// no longer credits).
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

// roundStart opens the next chronological round. warmup/pregame (the
// handler's detection — see handlers.RoundStart) mark a round that is
// NOT counted play: knife rounds, warmup and post-match rounds. Such a
// round is DISCARDED — it never enters a.rounds, its boundary rows are
// never emitted and every row emitted while it is current is dropped
// (the owner's ruling: knife/warmup rounds are not ingested and carry no
// setting). The chronological counter still bumps for them: row
// chronology and the sidecar's per-round seed cadence
// (extract.roundSeeds) read it, and build.renumber then renumbers the
// stored (counted) rounds onto the dense 1..N numbering.
//
// Per-round state (roundKills, tradeWindow, victimHP, lastHeldUtil) is
// reset at EVERY round start, counted or not — roundStart is the ONE
// round-reset home, and a discarded round still closes a stretch of play
// the next round must not inherit.
func (a *agg) roundStart(tick int, warmup, pregame bool, timeLimit int, objective string) {
	counted := !warmup && !pregame
	if len(a.rounds) == 0 && !counted {
		// The demo opens on a discarded round: everything emitted before
		// this first RoundStart (initial connects, pre-round system chat
		// and raw events) belongs to it and goes with it.
		a.dropPrefix()
	}
	a.currentRound++
	a.discarding = !counted
	if counted {
		a.realRounds++
		a.rounds = append(a.rounds, roundInfo{
			number:    a.currentRound,
			startTick: tick,
		})
	}
	a.roundKills[a.currentRound] = make(map[uint64]int)
	a.tradeWindow = make(map[uint64]tradeRec)
	// Health resets with the round: every player spawns back at 100 HP.
	a.victimHP = make(map[uint64]int)
	// The last-held util is a PER-ROUND fact (the death-drop rule scopes
	// it to the round the death happens in) — cleared with the rest of
	// the per-round state here, the ONE round-reset home.
	a.lastHeldUtil = make(map[uint64]string)
	if a.discarding {
		return // no round_start row for a round that does not exist
	}
	a.addEvent(models.Event{
		Tick:       tick,
		Kind:       models.EventRoundStart,
		DetailJSON: detailJSON(map[string]any{"timeLimit": timeLimit, "objective": objective}),
	}, "round_start")
}

// dropPrefix wipes every row accumulated before the demo's first
// RoundStart — a prefix that exists only while that first round turns
// out to be discarded (the rows are its: initial connects, pre-round
// system chat/raw events). Nothing else can be in the slices yet
// (economy/round_sides need a stored round; frameTyped indexes only the
// events wiped here), so truncating to zero is exact. Payload caches
// (rawLatest/frameQueue) stay: they feed pairing, not rows.
func (a *agg) dropPrefix() {
	a.events = a.events[:0]
	a.generic = a.generic[:0]
	a.chatRows = a.chatRows[:0]
	a.soundEvents = a.soundEvents[:0]
	a.frameTyped = a.frameTyped[:0]
}

func (a *agg) roundEnd(tick int, winner, reason, message string, tickRate float64) {
	if a.discarding {
		// Closing a discarded round: no round row to write (a.rounds'
		// last entry would be the PREVIOUS counted round) and no
		// round_end row for a round that does not exist.
		return
	}
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

// moneyEnd records the round-end money samples (player_round_stats'
// money_start/equip/spent): one models.RoundPlayerMoney row per sampled
// participant of the CURRENT counted round. Discarded rounds (knife/
// warmup/post-match) hang no rows — a.rounds' last entry would be the
// PREVIOUS counted round, the same guard roundEnd/mvpScan use. Samples
// arrive only for participants whose start-account prop the demo carried
// (handlers.go roundStartMoney), so a missing prop yields no row rather
// than a zeroed one; player_round_stats keeps its absence-as-zero
// default for player-rounds without a sample (players disconnected
// before round end, or not yet connected).
func (a *agg) moneyEnd(samples []moneyEndSample) {
	if a.discarding || len(a.rounds) == 0 {
		return
	}
	r := &a.rounds[len(a.rounds)-1]
	for _, s := range samples {
		if s.key == 0 {
			continue
		}
		a.roundMoney = append(a.roundMoney, models.RoundPlayerMoney{
			Round:      r.number,
			SteamID:    keyStr(s.key),
			MoneyStart: s.startAccount,
			Equip:      s.equipStart,
			Spent:      s.spent,
		})
	}
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
	// The round row is written only for a STORED (counted) round: a
	// discarded round's freeze end still runs the bookkeeping below (side
	// observation + the cumulative-spent baseline) but hangs no rows on
	// itself — there is no round to hang them on.
	r := (*roundInfo)(nil)
	if n > 0 && !a.discarding {
		r = &a.rounds[n-1]
		r.freezeEndTick = tick
		r.equipCT = equipCT
		r.equipT = equipT
	}
	// Every stored round is counted play (the extractor discards
	// knife/warmup rounds at ingest — agg.roundStart), so participation
	// credit needs no round-flag gate anymore: it is gated on having a
	// round row at all.

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
		// spend since that reset. The baseline updates on DISCARDED
		// rounds too: a knife/warmup round's spend must not leak into the
		// first counted round's delta.
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
			// consumers. Observed on discarded rounds as well (it is a fact
			// about the player, not about a round row).
			if p := a.players[s.key]; p != nil {
				p.side = s.side
			}
			if r != nil {
				a.roundSides = append(a.roundSides, models.RoundPlayerSide{
					Round: r.number, SteamID: keyStr(s.key), Side: s.side,
				})
			}
			sum[s.side] += s.money
			cnt[s.side]++
			spent[s.side] += delta
			freeP[s.side] += s.freePistol
		}
		if r != nil {
			rounds := a.participation[s.key]
			if rounds == nil {
				rounds = make(map[int]bool)
				a.participation[s.key] = rounds
			}
			rounds[r.number] = true
		}
	}
	if r != nil {
		a.economy = append(a.economy,
			models.RoundEconomy{Round: r.number, Side: "ct", EquipValue: equipCT, MoneySampledSum: sum["ct"], MoneySamples: cnt["ct"], Spent: spent["ct"], FreePistolValue: freeP["ct"]},
			models.RoundEconomy{Round: r.number, Side: "t", EquipValue: equipT, MoneySampledSum: sum["t"], MoneySamples: cnt["t"], Spent: spent["t"], FreePistolValue: freeP["t"]},
		)
	}

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
// double-credit. Ignored while discarding: a discarded round has no round
// row (a.rounds' last entry would be the previous counted round).
func (a *agg) roundMVP(key uint64, name, reason string) {
	if a.discarding {
		return
	}
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
// carries the full count — which is why the counter ALWAYS advances even
// for a discarded round: a knife round's MVP (the game's own counter
// includes it — the golden demo's knife MVP) is absorbed here and never
// credited, exactly like a warmup one. Credit therefore starts at the
// first COUNTED round's own delta (owner-accepted consequence: scoreboard
// mvps drop by one MVP per knife round).
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
	if a.discarding || len(a.rounds) == 0 {
		return
	}
	p := a.ensure(key, name)
	p.mvps += delta
	if a.rounds[len(a.rounds)-1].mvp == "" {
		a.rounds[len(a.rounds)-1].mvp = keyStr(key)
	}
}

// ---- combat ----

// killInfo carries the plain values a Kill handler extracts from the event.
// real marks stats-eligible play (post-match kills excluded — handlers
// compute it via realPeriod; discarded rounds are gated separately by
// agg.discarding).
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
	// hasKit is the victim's defuse-kit possession AT the kill tick
	// (demoinfocs Player.HasDefuseKit — pawn property, NOT inventory:
	// the kit never appears in Weapons()). The handler reads it beside
	// inv; the death-drop inference turns it into the kit drop row.
	hasKit bool
}

func (a *agg) kill(k killInfo) {
	if a.discarding {
		// Knife/warmup/post-match round: no row, no stat — discarded at
		// ingest (agg.roundStart).
		return
	}
	// Trade-opportunity proximity (config-independent, measured once at
	// extract time): the closest living teammate of the victim to the
	// KILLER at this death tick, -1 when nobody is measurable. Stored on
	// the kill event as detail_json.nearDist; analytics.Compute gates
	// the stored "Missed trades" count on it against
	// analysis_config.trade_opp_distance (store.match_trade_opps).
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
	// own): one row per inferred drop (a gun + at most one util + a kit
	// when the victim had one — the inferDeathDrops rules). The position
	// is the VICTIM's position at the kill tick, stored exactly like
	// bomb_drop stores the C4 carrier's position at release: the item's
	// real landing spot is a physics result the demo does not record —
	// "stored at release, may slide short" (CS2.md's dropped-C4 caveat —
	// same accepted semantics here). A victim with no stored position
	// (zero vector) still stores the row — the frontend draws nothing
	// without coordinates (drops.js), never a guessed one.
	//
	// Emitted for EVERY kill of a COUNTED round like the kill row itself:
	// these are evidence rows for the map layer, not stats (kills of a
	// discarded round never reach here — the guard above).
	for _, d := range inferDeathDrops(k.inv, a.lastHeldUtil[k.victimKey], k.hasKit) {
		detail := map[string]any{
			"player": k.victimName,
			"cat":    d.cat,
			"source": "victim",
		}
		// Gun only: dropped guns track their ammo/mag state at death —
		// the authoritative mag/reserve on the row (util and kit carry
		// none; a kit row's detail_json is exactly player/cat/source).
		if d.cat == "gun" {
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

	// Post-match kills (IsMatchStarted flipped back inside the final
	// counted round's tail) never pollute stats — the discarded-round
	// case never reaches here (guard above).
	if !k.real {
		return
	}

	// Disconnect-time World self-kills are NOT deaths/suicides (ruling,
	// lead 2026-11-17, owner's reconnect-takeover report): criterion
	// killer == victim ∧ weapon World ∧ the victim's disconnect landed
	// on this exact tick. The event row is already stored above — the
	// feed keeps recording what happened — but no stat may exist: the
	// game fires this fake death when a player leaves (81343/91080) or
	// a substitute bot is kicked (89867), and counting it inflated
	// deaths/suicides (bvcket: 2 fake deaths + 2 suicides in round 12).
	// Applies to humans' disconnect kills, bots' kick-time kills and
	// post-match disconnect kills alike; analytics.PlayerRounds gates
	// the same rows (analytics.WorldWeapon is the one spelling).
	//
	// The disconnect may dispatch BEFORE or AFTER the kill inside the
	// same frame (both orders observed), so an unconfirmed kill is
	// DEFERRED to flushWorldSelf at frame end — by then both dispatches
	// are in and the criterion is decidable exactly.
	if k.samePlayer && k.weapon == analytics.WorldWeapon {
		if a.disconnectTick[k.victimKey] == k.tick {
			return // confirmed fake death: no side, no death, no suicide
		}
		a.pendingWorldSelf = append(a.pendingWorldSelf, pendingWorldKill{
			tick:       k.tick,
			victimKey:  k.victimKey,
			victimName: k.victimName,
			victimSide: k.victimSide,
		})
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

	// First blood of the round: entry attribution. (The opening_kills
	// twin was incremented in this same branch until it was retired
	// with its column on 2026-11-18 — identical stored columns.)
	if n := len(a.rounds); n > 0 {
		r := &a.rounds[n-1]
		if r.firstKillSteam == "" {
			r.firstKillSteam = keyStr(k.killerKey)
			r.firstDeathSteam = keyStr(k.victimKey)
			kp.entryKills++
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

	// Entry death: the first-blood victim. (The opening_deaths twin
	// was incremented in this same branch until it was retired with
	// its column on 2026-11-18 — identical stored columns.)
	if n := len(a.rounds); n > 0 {
		r := &a.rounds[n-1]
		if r.firstDeathSteam != "" && r.firstDeathSteam == keyStr(k.victimKey) {
			vp := a.players[k.victimKey]
			if vp == nil {
				vp = a.ensure(k.victimKey, k.victimName)
			}
			vp.entryDeaths++
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

// flushWorldSelf decides the deferred World self-kills (kill's
// disconnect-time criterion): called at every FrameDone and once after
// the parse ends, by which point the frame's player_disconnect has
// dispatched in EITHER order relative to the kill (both orders observed
// on the owner's repro demo), so the same-tick test is exact —
//
//   - disconnect seen on the kill's tick → the fake death is dropped
//     entirely (no side observation, no death, no suicide: the event row
//     stored by kill is the only trace — the feed records what happened,
//     the stats stay honest);
//   - no such disconnect → a genuine world-hazard self-kill, counted
//     exactly like any other death (the deferral costs nothing: the
//     player cannot act between their own death and this frame's end).
func (a *agg) flushWorldSelf() {
	for _, p := range a.pendingWorldSelf {
		if a.discarding || a.disconnectTick[p.victimKey] == p.tick {
			continue
		}
		if p.victimSide == "ct" || p.victimSide == "t" {
			a.ensure(p.victimKey, p.victimName).side = p.victimSide
		}
		if p.victimKey == 0 {
			continue
		}
		vp := a.ensure(p.victimKey, p.victimName)
		vp.deaths++
		vp.killStreak = 0
		vp.suicides++
	}
	a.pendingWorldSelf = a.pendingWorldSelf[:0]
}

// hurtInfo carries the plain values a PlayerHurt handler extracts. real
// marks stats-eligible play (post-match play excluded — discarded rounds
// are gated by agg.discarding).
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
	if a.discarding {
		return // discarded round: no damage row, no stat
	}
	// Every PlayerHurt of a counted round becomes an event; stat
	// accumulation below is additionally gated on real (post-match).
	//
	// same is the ONE side computation of this row: it stamps the event
	// (SameSide) AND gates the attacker's stat below — true iff both
	// sides were known and equal at the event (extract.sameSide), so
	// false covers enemy AND unknown (owner ruling 2026-11-17: damage
	// stats differentiate enemy damage; FF stays an accounting quantity
	// inside expressions/filters). The "count ENEMY damage only" gate
	// reads the identical predicate — a strict known-and-different rule
	// would desynchronize the stamp from total_damage.
	same := sameSide(h.attackerSide, h.victimSide)
	// capped is the row's HP-capped credit stamp (owner ruling 2026-11-17
	// "fix the metric until they match"; M7 weapon-damage gate
	// escalation, 2026-11-18): the exact value the per-weapon damage
	// fold credits for THIS hit, stamped where the cap replay already
	// runs with full event order (capDamage below). Every stats-eligible
	// hit runs the replay — team/world hits drain HP too — but only
	// `real` play credits: a post-match hit stamps 0 and never touches
	// the HP replay (the fold's `real` gate; §6.5 blocks joining rounds
	// into a weapon partition, so the fact must be row-local). The enemy
	// gate is deliberately NOT stamped here: SameSide + the actor
	// columns carry it, exactly where every other damage seed reads it.
	capped := 0
	if h.real {
		// Health bookkeeping for EVERY real hit (team/world damage drains HP
		// too) — the returned credit is capped at the victim's remaining HP.
		capped = a.capDamage(h.victimKey, h.healthDamage, h.health)
	}
	a.addEvent(models.Event{
		Tick:      h.tick,
		Kind:      models.EventDamage,
		Attacker:  keyStr(h.attackerKey),
		Victim:    keyStr(h.victimKey),
		Weapon:    h.weapon,
		Dmg:       h.healthDamage,
		SameSide:  same,
		CappedDmg: capped,
		Hitgroup:  h.hitgroup,
		PosX:      h.posX,
		PosY:      h.posY,
		PosZ:      h.posZ,
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
	dealt := capped
	// Attacker stats count ENEMY damage only — friendly fire and self
	// damage are not "damage dealt" on any scoreboard (awpy/HLTV/ProSettings).
	// `same` (computed above for the event stamp) IS this gate's side
	// predicate: unknown side ⇒ not same ⇒ enemy (permissive parity).
	enemy := h.attackerKey != 0 && h.attackerKey != h.victimKey && !same
	if enemy {
		ap := a.ensure(h.attackerKey, h.attackerName)
		ap.totalDamage += dealt
		ap.hits++
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
	if key == 0 || a.discarding {
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
	if a.discarding {
		return // discarded round: no blind row, no stat
	}
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
	// matches). Post-match blinds are gated by b.real.
	if b.attackerKey != 0 && b.attackerKey != b.playerKey &&
		!sameSide(b.attackerSide, b.playerSide) {
		a.ensure(b.attackerKey, b.attackerName).enemiesFlashed++
	}
}

// ---- utility & objective ----

// blastInfo carries a grenade detonation (EventGrenade); source is the game
// event the raw payload will be paired from. entity is the projectile-side
// entity id the row stores in detail_json `entity` — the join key the
// replay pairs throw → bounces → det with (see models.EventGrenadeBounce).
type blastInfo struct {
	tick        int
	weapon      string
	source      string
	throwerKey  uint64
	throwerName string
	entity      int
	x, y, z     float64
}

// blastKey is the detonation dedupe key: (tick, thrower, weapon). The
// weapon keeps a flash and an HE from the same thrower in one tick apart;
// the thrower keeps two players' simultaneous detonations apart; the tick
// is the detonation itself (see agg.blastSeen for the full rationale).
type blastKey struct {
	tick    int
	thrower uint64
	weapon  string
}

// grenadeBlast stores ONE detonation row per (tick, thrower, weapon): the
// parser dispatches some detonations TWICE (today exactly FlashExplode —
// demoinfocs-golang v6 fires it from both the flashbang_detonate game
// event and the flash projectile's entity on-destroy handler; cached in
// CS2.md), and the FIRST dispatch wins — its position is the row's.
// Uniform over all kinds: a once-dispatched detonation can never repeat a
// key, so HE/smoke/fire/decoy rows are unaffected.
func (a *agg) grenadeBlast(g blastInfo) {
	key := blastKey{tick: g.tick, thrower: g.throwerKey, weapon: g.weapon}
	if a.blastSeen[key] {
		return
	}
	a.blastSeen[key] = true
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
			"entity":  g.entity,
			"x":       g.x,
			"y":       g.y,
			"z":       g.z,
		}),
	}, g.source)
}

// grenadeThrown is entity-derived (projectile created), so it has no raw
// game-event payload to pair. px/py/pz are the throw position (nil when
// the projectile entity had no position yet). entity is the PROJECTILE
// entity id stored in detail_json `entity` — the join key the replay pairs
// throw → bounces → det with (see models.EventGrenadeBounce).
func (a *agg) grenadeThrown(tick int, throwerKey uint64, throwerName string, entity int, weapon string, px, py, pz *float64) {
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
			"entity":  entity,
		}),
	}, "")
}

// bounceKey is the grenade-bounce dedupe key: (source entity, tick, name).
// Two grenades can bounce in the same tick, and one grenade can bounce
// twice in a tick only by overlapping the same event — the entity index
// separates the former, the name the latter's look-alikes.
type bounceKey struct {
	entity int
	tick   int
	name   string
}

// bounceInfo is one grenade-bounce SOS message (see models.EventGrenadeBounce).
type bounceInfo struct {
	tick    int
	entity  int
	name    string
	weapon  string
	hasPos  bool
	x, y, z float64
}

// grenadeBounced stores ONE grenade-bounce row per (entity, tick, name):
// the game fires two SOS messages for most bounces (87% — their origins
// differ by <1 u), so the FIRST message claims the key and its origin wins.
// A first message whose origin is not parseable (hasPos false) claims the
// key too and stores NOTHING — a bounce without a required input is
// skipped, never stored with a guessed position, and its duplicate then
// dedupes away rather than inventing the missing coordinate.
func (a *agg) grenadeBounced(b bounceInfo) {
	key := bounceKey{entity: b.entity, tick: b.tick, name: b.name}
	if a.bounceSeen[key] {
		return
	}
	a.bounceSeen[key] = true
	if !b.hasPos {
		return
	}
	px, py, pz := pos3(b.x, b.y, b.z)
	if px == nil {
		return // zero vector — the posPtrs "no position known" convention
	}
	a.addEvent(models.Event{
		Tick:   b.tick,
		Kind:   models.EventGrenadeBounce,
		Weapon: b.weapon,
		PosX:   px,
		PosY:   py,
		PosZ:   pz,
		DetailJSON: detailJSON(map[string]any{
			"entity":     b.entity,
			"soundevent": b.name,
		}),
	}, "")
}

// soundEvent stores one attributed player sound (footstep/land/jump/fall —
// models.SoundEvent). The row is only built by the SOS handler AFTER the
// source entity resolved to a participant, so identity is never guessed
// here; Round is stamped through the same evRound path every other row
// uses (renumbered with them in build.renumber).
func (a *agg) soundEvent(se models.SoundEvent) {
	if a.discarding {
		return // discarded round: no sound row
	}
	se.Round = a.evRound()
	a.soundEvents = append(a.soundEvents, se)
}

func (a *agg) bombPlanted(tick int, site string, key uint64, name string, real bool, px, py, pz *float64) {
	if a.discarding {
		return // discarded round: no plant row, no bombSite write, no stat
	}
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
	if a.discarding {
		return // discarded round: no defuse row, no stat
	}
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

// bombExploded records the C4 detonation. Weapon "C4" is THE canonical
// manifest key for the row (mappack soundTable "C4" → c4_explode1.wav):
// without it sfx.js grenadeCues drops the weaponless row ("no weapon →
// dropped, never invent") and the C4 boom never plays — the row's
// explosion sound is the ONE consumer of this stamp. Side effect for
// existing libraries: the weapon column is part of the row, so an
// already-imported match needs ONE re-import to boom (pre-release
// policy — no backfill).
func (a *agg) bombExploded(tick int, site string, px, py, pz *float64) {
	a.addEvent(models.Event{
		Tick:       tick,
		Kind:       models.EventBombExplode,
		Weapon:     "C4",
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

// weaponPickedUp records a weapon_pickup row: someone acquired a gun,
// util item or defuse kit at this tick (item_pickup — buys and spawn
// restocks included at extract time, see the handler), at their own
// position. The cat is the stored classification ("gun"|"util"|"kit")
// so consumers never re-derive it. The raw item_pickup payload pairs
// onto the row (source).
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
	// Roster membership from the connect row itself. The other ensure
	// paths can all miss an identity: a substitute bot that is kicked
	// before the next freeze-end sample, whose kick-time World self-kill
	// is excluded from stats (kill's disconnect criterion), and whose
	// controller entity is gone before the end-of-demo snapshot leaves NO
	// players/player_stats row at all — the replay meta then hands the
	// frontend a BLANK roster entry (no name/side/is_bot) and the card's
	// presence rule can never resolve it (owner report 2026-11-17: the
	// card/marker/trail/camera invariant). ensure derives isBot from the
	// synthetic key shape; side is left to the observation paths
	// (freeze-end / stat-bearing kills / the final snapshot) — when none
	// fires, the renderer resolves it from the position stream's per-
	// frame flags (presentAt's injected sideAt). Gated with the row: a
	// discarded period (knife/warmup) ingests nothing, and so does the
	// pre-first-round prefix: its connect rows are wiped by dropPrefix
	// when the opening round turns out discarded, so the roster entry
	// must not outlive them (the entry exists iff the row does).
	if key != 0 && !a.discarding && a.currentRound > 0 {
		a.ensure(key, name)
	}
	a.addEvent(models.Event{
		Tick:       tick,
		Kind:       models.EventConnect,
		Attacker:   keyStr(key),
		DetailJSON: detailJSON(map[string]any{"name": name, "bot": bot}),
	}, "")
}

func (a *agg) disconnect(tick int, key uint64, name string) {
	// First half of the disconnect-time World self-kill criterion (see
	// kill): recorded even for a discarded round (the stat gate lives
	// with the kill, and a discarded round never reaches it).
	if key != 0 {
		a.disconnectTick[key] = tick
	}
	a.addEvent(models.Event{
		Tick:       tick,
		Kind:       models.EventDisconnect,
		Attacker:   keyStr(key),
		DetailJSON: detailJSON(map[string]any{"name": name}),
	}, "")
}

// botTakeover records a control re-assumption (extract.handlers' per-frame
// demoinfocsControls edge): tick-accurate bookkeeping in agg.takeovers AND
// a typed event row (models.EventBotTakeover — the replay's coverage
// predicate reads it through the same channel as the connect/disconnect
// rows; owner report 2026-11-18: coverage spans disconnect →
// re-assumption, and the reconnect alone does NOT end it). No stat.
func (a *agg) botTakeover(tick int, takerKey uint64, takerName string, botKey uint64, botName string) {
	a.takeovers = append(a.takeovers, takeoverRec{
		tick:      tick,
		takerKey:  takerKey,
		takerName: takerName,
		botKey:    botKey,
		botName:   botName,
	})
	a.addEvent(models.Event{
		Tick:       tick,
		Kind:       models.EventBotTakeover,
		Attacker:   keyStr(takerKey),
		DetailJSON: detailJSON(map[string]any{"name": takerName, "bot": botName, "bot_key": keyStr(botKey)}),
	}, "")
}

func (a *agg) chat(tick int, steam, name, text, channel string) {
	if a.discarding {
		return // discarded round: no chat row
	}
	a.chatRows = append(a.chatRows, models.Chat{
		Tick:    tick,
		Round:   a.evRound(),
		SteamID: steam,
		Name:    name,
		Text:    text,
		Kind:    "chat",
		Channel: channel, // "all" | "team"; "" for non-chat rows (never here)
	})
}

func (a *agg) systemChat(tick int, text string) {
	if a.discarding {
		return // discarded round: no chat row
	}
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
// game-event source). Rows of a discarded round are never stored (the
// owner's knife/warmup discard).
func (a *agg) addEvent(ev models.Event, source string) {
	if a.discarding {
		return
	}
	ev.Round = a.evRound()
	a.events = append(a.events, ev)
	if source != "" {
		a.frameTyped = append(a.frameTyped, rawWant{idx: len(a.events) - 1, name: source})
	}
}

// genericEvent stores one raw game-event row and queues its payload for
// pairing with this frame's typed events. The payload caches update
// unconditionally (they feed pairing for whichever typed rows this frame
// DOES store — a round boundary can mix a discarded round's generic
// payload with the next round's typed row); the row itself is only stored
// for a counted round.
func (a *agg) genericEvent(name string, tick int, payload string) {
	a.rawLatest[name] = payload
	a.frameQueue[name] = append(a.frameQueue[name], payload)
	if a.discarding {
		return
	}
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
