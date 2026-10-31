package extract

import (
	"fmt"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
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
// fields the extractor overwrites from the live entity state).
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
	kills           int
	deaths          int
	assists         int
	mvps            int
	score           int
	moneySpentTotal int
}

// moneySample is one participant's freeze-time-end economy reading.
type moneySample struct {
	key   uint64
	name  string
	side  string
	money int
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
	mvp             string
	mvpReason       string
	equipCT         int
	equipT          int
	bombSite        string
	freezeEndTick   int
	firstKillSteam  string
	firstDeathSteam string
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
	threeK          int
	fourK           int
	fiveK           int
	utilityDamage   int
	flashesPopped   int
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

	rounds       []roundInfo
	currentRound int
	warmupRounds int
	realRounds   int
	sideSwitches int
	halfCT       int
	halfT        int

	ctTeam teamFinal
	tTeam  teamFinal

	lastDeathTick map[string]int
	roundKills    map[int]map[uint64]int

	economy  []models.RoundEconomy
	events   []models.Event
	generic  []models.GenericEvent
	chatRows []models.Chat
	warnings []string

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
		lastDeathTick: make(map[string]int),
		roundKills:    make(map[int]map[uint64]int),
		economy:       make([]models.RoundEconomy, 0, 64),
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

func (a *agg) setFinalTeam(side string, t teamFinal) {
	if side == "t" {
		a.tTeam = t
	} else {
		a.ctTeam = t
	}
}

func (a *agg) halfEnd(ctScore, tScore int) {
	a.halfCT = ctScore
	a.halfT = tScore
}

func (a *agg) sideSwitch() { a.sideSwitches++ }

func (a *agg) warn(typeID int, message string) {
	a.warnings = append(a.warnings, fmt.Sprintf("[type=%d] %s", typeID, message))
}

// applyFinal folds the end-of-demo roster snapshot into the accumulators:
// present players get their identity/scoreboard fields overwritten from live
// entity state and are marked FinalStatePresent (provenance).
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
		p.kills = f.kills
		p.deaths = f.deaths
		p.assists = f.assists
		p.mvps = f.mvps
		p.score = f.score
		p.moneySpentTotal = f.moneySpentTotal
		a.finalPresent[f.key] = true
	}
}

// ---- round state machine ----

func (a *agg) roundStart(tick int, warmup bool, timeLimit int, objective string) {
	a.currentRound++
	if warmup {
		a.warmupRounds++
	} else {
		a.realRounds++
	}
	a.rounds = append(a.rounds, roundInfo{
		number:    a.currentRound,
		startTick: tick,
		warmup:    warmup,
	})
	a.roundKills[a.currentRound] = make(map[uint64]int)
	a.lastDeathTick = make(map[string]int)
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
				tr = 64
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
// and samples each playing participant's money per side (the extractor's
// sampling method, re-targeted at per-round-per-side RoundEconomy rows).
func (a *agg) freezeEnd(tick int, equipCT, equipT int, samples []moneySample, warmup bool) {
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

	sum := map[string]int{}
	cnt := map[string]int{}
	for _, s := range samples {
		if !warmup {
			rounds := a.participation[s.key]
			if rounds == nil {
				rounds = make(map[int]bool)
				a.participation[s.key] = rounds
			}
			rounds[r.number] = true
		}
		if s.side == "ct" || s.side == "t" {
			sum[s.side] += s.money
			cnt[s.side]++
		}
	}
	a.economy = append(a.economy,
		models.RoundEconomy{Round: r.number, Side: "ct", EquipValue: equipCT, MoneySampledSum: sum["ct"], MoneySamples: cnt["ct"]},
		models.RoundEconomy{Round: r.number, Side: "t", EquipValue: equipT, MoneySampledSum: sum["t"], MoneySamples: cnt["t"]},
	)
}

// roundMVP is best-effort: many demos never announce a round MVP (the golden
// demo does not) — rows stay empty when absent.
func (a *agg) roundMVP(key uint64, name, reason string) {
	if key != 0 {
		a.ensure(key, name).mvps++
	}
	if n := len(a.rounds); n > 0 {
		r := &a.rounds[n-1]
		r.mvp = keyStr(key)
		r.mvpReason = reason
	}
}

// ---- combat ----

// killInfo carries the plain values a Kill handler extracts from the event.
type killInfo struct {
	tick          int
	warmup        bool
	tickRate      float64
	killerKey     uint64
	killerName    string
	killerSide    string
	victimKey     uint64
	victimName    string
	victimSide    string
	assisterKey   uint64
	assisterName  string
	weapon        string
	headshot      bool
	wallbang      bool
	noscope       bool
	throughSmoke  bool
	attackerBlind bool
	assistedFlash bool
	distance      float64
	samePlayer    bool
}

func (a *agg) kill(k killInfo) {
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
		DetailJSON: detailJSON(map[string]any{
			"killer":   k.killerName,
			"victim":   k.victimName,
			"assister": k.assisterName,
		}),
	}, "player_death")

	// Warmup knife fights never pollute stats (event row still emitted).
	if k.warmup {
		return
	}

	if k.killerKey != 0 {
		kp := a.ensure(k.killerKey, k.killerName)
		kp.kills++
		kp.weaponKills[k.weapon]++
		if k.headshot {
			kp.headshots++
		}
		if k.killerSide != "" && k.killerSide == k.victimSide {
			kp.teamkills++
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

		// Trade: kill an enemy within 5 s of any prior death on that side
		// (window resets at every RoundStart).
		if k.victimKey != 0 {
			if lt, ok := a.lastDeathTick[k.victimSide]; ok {
				tr := k.tickRate
				if tr <= 0 {
					tr = 64
				}
				if float64(k.tick-lt)/tr <= 5.0 {
					kp.tradeKills++
				}
			}
		}

		// Per-round multi-kills: exact-hit at 3/4/5.
		if a.roundKills[a.currentRound] == nil {
			a.roundKills[a.currentRound] = make(map[uint64]int)
		}
		a.roundKills[a.currentRound][k.killerKey]++
		switch a.roundKills[a.currentRound][k.killerKey] {
		case 3:
			kp.threeK++
		case 4:
			kp.fourK++
		case 5:
			kp.fiveK++
		}

		kp.killStreak++
		if kp.killStreak > kp.bestStreak {
			kp.bestStreak = kp.killStreak
		}
	}

	if k.victimKey != 0 {
		vp := a.ensure(k.victimKey, k.victimName)
		vp.deaths++
		vp.killStreak = 0
		if k.samePlayer {
			vp.suicides++
		}
		a.lastDeathTick[k.victimSide] = k.tick
		// The first-blood victim gets the matching entry/opening death.
		if n := len(a.rounds); n > 0 {
			r := &a.rounds[n-1]
			if r.firstDeathSteam != "" && r.firstDeathSteam == keyStr(k.victimKey) {
				vp.entryDeaths++
				vp.openingDeaths++
			}
		}
	}

	if k.assisterKey != 0 {
		a.ensure(k.assisterKey, k.assisterName).assists++
	}
}

// hurtInfo carries the plain values a PlayerHurt handler extracts.
type hurtInfo struct {
	tick              int
	warmup            bool
	attackerKey       uint64
	attackerName      string
	victimKey         uint64
	victimName        string
	weapon            string
	isUtility         bool
	healthDamage      int
	healthDamageTaken int
	health            int
	hitgroup          string
}

func (a *agg) hurt(h hurtInfo) {
	// Every PlayerHurt becomes an event (the extractor's TotalHurt is
	// ungated); stat accumulation below is warmup-gated.
	a.addEvent(models.Event{
		Tick:     h.tick,
		Kind:     models.EventDamage,
		Attacker: keyStr(h.attackerKey),
		Victim:   keyStr(h.victimKey),
		Weapon:   h.weapon,
		Dmg:      h.healthDamage,
		Hitgroup: h.hitgroup,
		DetailJSON: detailJSON(map[string]any{
			"attacker":    h.attackerName,
			"victim":      h.victimName,
			"health":      h.health,
			"damageTaken": h.healthDamageTaken,
		}),
	}, "player_hurt")

	if h.warmup {
		return
	}
	if h.attackerKey != 0 {
		ap := a.ensure(h.attackerKey, h.attackerName)
		ap.totalDamage += h.healthDamage
		ap.hits++
		ap.weaponDmg[h.weapon] += h.healthDamage
		if h.isUtility {
			ap.utilityDamage += h.healthDamage
		}
	}
	if h.victimKey != 0 {
		a.ensure(h.victimKey, h.victimName).damageTaken += h.healthDamageTaken
	}
}

func (a *agg) shot(key uint64, name string) {
	if key == 0 {
		return
	}
	a.ensure(key, name).shots++
}

// blindInfo carries the plain values a PlayerFlashed handler extracts.
type blindInfo struct {
	tick         int
	warmup       bool
	playerKey    uint64
	playerName   string
	attackerKey  uint64
	attackerName string
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
	if b.warmup {
		return
	}
	if b.playerKey != 0 {
		a.ensure(b.playerKey, b.playerName).flashedTimes++
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
	isFlash     bool
	x, y, z     float64
}

func (a *agg) grenadeBlast(g blastInfo) {
	a.addEvent(models.Event{
		Tick:     g.tick,
		Kind:     models.EventGrenade,
		Attacker: keyStr(g.throwerKey),
		Weapon:   g.weapon,
		DetailJSON: detailJSON(map[string]any{
			"thrower": g.throwerName,
			"grenade": g.weapon,
			"x":       g.x,
			"y":       g.y,
			"z":       g.z,
		}),
	}, g.source)
	if g.isFlash && g.throwerKey != 0 {
		a.ensure(g.throwerKey, g.throwerName).flashesPopped++
	}
}

// grenadeThrown is entity-derived (projectile created), so it has no raw
// game-event payload to pair.
func (a *agg) grenadeThrown(tick int, throwerKey uint64, throwerName, weapon string) {
	a.addEvent(models.Event{
		Tick:     tick,
		Kind:     models.EventGrenadeThrow,
		Attacker: keyStr(throwerKey),
		Weapon:   weapon,
		DetailJSON: detailJSON(map[string]any{
			"thrower": throwerName,
			"grenade": weapon,
		}),
	}, "")
}

func (a *agg) bombPlanted(tick int, site string, key uint64, name string) {
	if n := len(a.rounds); n > 0 {
		a.rounds[n-1].bombSite = site
	}
	if key != 0 {
		a.ensure(key, name).bombPlants++
	}
	a.addEvent(models.Event{
		Tick:       tick,
		Kind:       models.EventBombPlant,
		Attacker:   keyStr(key),
		Site:       site,
		DetailJSON: detailJSON(map[string]any{"player": name}),
	}, "bomb_planted")
}

func (a *agg) bombDefused(tick int, site string, key uint64, name string, hasKit bool) {
	if key != 0 {
		a.ensure(key, name).bombDefuses++
	}
	a.addEvent(models.Event{
		Tick:       tick,
		Kind:       models.EventBombDefuse,
		Attacker:   keyStr(key),
		Site:       site,
		DetailJSON: detailJSON(map[string]any{"player": name, "hasKit": hasKit}),
	}, "bomb_defused")
}

func (a *agg) bombExploded(tick int, site string) {
	a.addEvent(models.Event{
		Tick:       tick,
		Kind:       models.EventBombExplode,
		Site:       site,
		DetailJSON: detailJSON(map[string]any{"site": site}),
	}, "bomb_exploded")
}

func (a *agg) bombDropped(tick int, key uint64, name string) {
	a.addEvent(models.Event{
		Tick:       tick,
		Kind:       models.EventBombDrop,
		Attacker:   keyStr(key),
		DetailJSON: detailJSON(map[string]any{"player": name}),
	}, "bomb_dropped")
}

func (a *agg) bombPickedUp(tick int, key uint64, name string) {
	a.addEvent(models.Event{
		Tick:       tick,
		Kind:       models.EventBombPickup,
		Attacker:   keyStr(key),
		DetailJSON: detailJSON(map[string]any{"player": name}),
	}, "bomb_pickup")
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
				a.events[w.idx].RawJSON = q[n]
			case len(q) == 0:
				// No payload this frame: fall back to the last one seen
				// (cross-frame dispatch, e.g. datatables-driven round events).
				if r := a.rawLatest[w.name]; r != "" {
					a.events[w.idx].RawJSON = r
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
