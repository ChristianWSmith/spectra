package extract

import (
	"strings"
	"testing"

	"github.com/golang/geo/r3"
	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/common"
	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/events"

	"github.com/ChristianWSmith/spectra/internal/analytics"
	"github.com/ChristianWSmith/spectra/internal/models"
)

// Reconnect-takeover identity tests (owner's report 2026-11-17; CS2.md
// "Reconnect takeover — one life, two identities in the demo"). Synthetic
// fakes only — the repro demo is never a test dependency. The package's
// fake style is plain &common.Player{} literals (final_roster_test.go):
// their entity-backed reads are nil-safe zeros and demoinfocs' real
// entities/provider cannot be constructed outside its internal stfake, so
// the control/position reads are injected seams (pairIdentity's
// controls, remap's posOf, positionRow's pawnAlive) — the RULES are
// pinned here, the entity plumbing end-to-end on the owner's demo.

// takeoverPair is the repro's trio: the reconnecting human, the
// substitute bot he controls, and an enemy.
func takeoverPair() (human, bot, enemy *common.Player) {
	human = &common.Player{
		Name: "bvcket", SteamID64: 76561198012685780, EntityID: 10,
		IsConnected: true, Team: common.TeamCounterTerrorists,
	}
	bot = &common.Player{
		Name: "Rebel", EntityID: 11, IsBot: true,
		Team: common.TeamCounterTerrorists,
	}
	enemy = &common.Player{
		Name: "IImmortall", SteamID64: 76561199008407830, EntityID: 12,
		IsConnected: true, Team: common.TeamTerrorists,
	}
	return human, bot, enemy
}

// fakeControls builds the injected control read: human → bot.
func fakeControls(pairs ...[2]*common.Player) func(*common.Player) *common.Player {
	m := map[*common.Player]*common.Player{}
	for _, p := range pairs {
		m[p[0]] = p[1]
	}
	return func(p *common.Player) *common.Player { return m[p] }
}

// testRemap assembles a remap with injected control/position reads —
// positions are DISTINCT per player so the read's SOURCE is observable.
func testRemap(controls func(*common.Player) *common.Player, all []*common.Player, pos map[*common.Player]r3.Vector) *remap {
	return &remap{
		controls: controls,
		all:      all,
		posOf: func(p *common.Player) r3.Vector {
			if p == nil {
				return r3.Vector{}
			}
			return pos[p]
		},
	}
}

func TestActiveIdentityTakeoverPairing(t *testing.T) {
	human, bot, enemy := takeoverPair()
	alone := &common.Player{Name: "Ricksaw", EntityID: 13, IsBot: true}
	all := []*common.Player{human, bot, enemy, alone}
	controls := fakeControls([2]*common.Player{human, bot})

	// Controlling human: identity stays the human, pawn becomes the bot
	// (every pawn-carried read follows the controlled pawn).
	if id, pawn := pairIdentity(human, controls, all); id != human || pawn != bot {
		t.Errorf("controlling human → (%v, %v), want (human, bot)", id, pawn)
	}
	// Bot under a connected human's control: identity collapses onto the
	// human (the event row belongs to the human's life), pawn stays the
	// bot.
	if id, pawn := pairIdentity(bot, controls, all); id != human || pawn != bot {
		t.Errorf("controlled bot → (%v, %v), want (human, bot)", id, pawn)
	}
	// Lone bot (nobody controls it): its own life, untouched.
	if id, pawn := pairIdentity(alone, controls, all); id != alone || pawn != alone {
		t.Errorf("lone bot → (%v, %v), want (bot, bot)", id, pawn)
	}
	// An uninvolved human: untouched.
	if id, pawn := pairIdentity(enemy, controls, all); id != enemy || pawn != enemy {
		t.Errorf("uninvolved human → (%v, %v), want (enemy, enemy)", id, pawn)
	}
	// Nil participant → nil pair (every consumer nil-guards on it).
	if id, pawn := pairIdentity(nil, controls, all); id != nil || pawn != nil {
		t.Errorf("nil → (%v, %v), want (nil, nil)", id, pawn)
	}
	// A bot controlling itself is not a takeover (defensive: the prop
	// pair could theoretically resolve to the same object).
	selfish := &common.Player{Name: "odd", EntityID: 14, IsBot: true}
	selfControls := fakeControls([2]*common.Player{selfish, selfish})
	if id, pawn := pairIdentity(selfish, selfControls, all); id != selfish || pawn != selfish {
		t.Errorf("self-control → (%v, %v), want (bot, bot)", id, pawn)
	}
}

// TestDemoinfocsControlsGates pins the connected/not-controlling gates
// with entity-free fakes: a disconnected controller never yields its bot
// (the repro's 91080..91334 window — bvcket keeps m_bControllingBot
// while the bot plays on alone), and a connected participant without
// m_bControllingBot yields nil. Both reads are nil-entity safe.
func TestDemoinfocsControlsGates(t *testing.T) {
	if got := demoinfocsControls(nil); got != nil {
		t.Errorf("nil controller → %v, want nil", got)
	}
	if got := demoinfocsControls(&common.Player{Name: "gone", IsConnected: false}); got != nil {
		t.Errorf("disconnected controller → %v, want nil (bot plays on alone)", got)
	}
	if got := demoinfocsControls(&common.Player{Name: "here", IsConnected: true}); got != nil {
		t.Errorf("connected non-controlling participant → %v, want nil", got)
	}
}

func TestTakeoverDeathUsesControllingPawnPosition(t *testing.T) {
	human, bot, enemy := takeoverPair()
	all := []*common.Player{human, bot, enemy}
	// The repro's two candidate death positions: the stale pre-disconnect
	// corpse (what e.Victim.Position() returned through the human's own
	// dead pawn) vs the life's real spot (the paired bomb_drop evidence
	// at tick 93172).
	stale := r3.Vector{X: -1675.62, Y: 351.70, Z: -63.97}
	live := r3.Vector{X: 414.16, Y: 1881.41, Z: 136.14}
	r := testRemap(
		fakeControls([2]*common.Player{human, bot}),
		all,
		map[*common.Player]r3.Vector{human: stale, bot: live, enemy: {}},
	)

	// userid-keyed death of the controlling human (the repro's tick
	// 93172): identity stays the human, the POSITION is read through the
	// LIVE controlled pawn — the owner's "wrong position (byte-identical
	// stale corpse)" bug.
	k := killInfoFor(events.Kill{Victim: human, Killer: enemy}, r)
	if k.victimKey != human.SteamID64 || k.victimName != "bvcket" {
		t.Errorf("victim = %d/%q, want the human's identity", k.victimKey, k.victimName)
	}
	if k.posX == nil || *k.posX != live.X || k.posY == nil || *k.posY != live.Y {
		t.Errorf("victim pos = (%v,%v,%v), want the controlled pawn's live spot (%v,%v)",
			k.posX, k.posY, k.posZ, live.X, live.Y)
	}
	if k.samePlayer {
		t.Error("enemy kill flagged samePlayer")
	}

	// A pawn-keyed resolution to the bot (bomb_pickup's domain — the
	// same split player_death-vs-bomb_pickup showed) collapses onto the
	// human's identity with the bot's position.
	k2 := killInfoFor(events.Kill{Victim: bot, Killer: enemy}, r)
	if k2.victimKey != human.SteamID64 || k2.victimName != "bvcket" {
		t.Errorf("bot-resolved victim = %d/%q, want the controlling human", k2.victimKey, k2.victimName)
	}
	if k2.posX == nil || *k2.posX != live.X {
		t.Errorf("bot-resolved victim pos = %v, want %v", k2.posX, live.X)
	}

	// Attacker side of the same rule: a killer read through a takeover
	// pair takes the human's identity and the controlled pawn's spot.
	k3 := killInfoFor(events.Kill{Victim: enemy, Killer: human}, r)
	if k3.killerKey != human.SteamID64 {
		t.Errorf("killer = %d, want the human's key", k3.killerKey)
	}
	if k3.attackerPosX == nil || *k3.attackerPosX != live.X {
		t.Errorf("attacker pos = %v, want the controlled pawn's %v", k3.attackerPosX, live.X)
	}

	// Identity-level samePlayer: killer resolving to the bot IS the
	// human's own life — one life, never a cross-kill.
	k4 := killInfoFor(events.Kill{Victim: human, Killer: bot}, r)
	if !k4.samePlayer {
		t.Error("takeover pair (bot killer, human victim) must collapse to one life (samePlayer)")
	}
}

func TestTakeoverBombPickupAttributedToControllingHuman(t *testing.T) {
	human, bot, enemy := takeoverPair()
	all := []*common.Player{human, bot, enemy}
	live := r3.Vector{X: 120.0, Y: 240.0, Z: 128.0}
	r := testRemap(
		fakeControls([2]*common.Player{human, bot}),
		all,
		map[*common.Player]r3.Vector{human: {}, bot: live, enemy: {}},
	)

	// handlers.go BombPickup: bomb_pickup carries only userid_pawn, so
	// demoinfocs hands us the substitute BOT's controller while the C4
	// is in the reconnecting human's hands (repro tick 92916 landed on
	// the bot's key before this rule). participantRow is the row the
	// handler stores: identity from the controlling human, position from
	// the controlled pawn.
	key, name, side, pos := participantRow(bot, r)
	if key != human.SteamID64 || name != "bvcket" {
		t.Errorf("pickup row = %d/%q, want the controlling human's identity", key, name)
	}
	if side != "ct" {
		t.Errorf("pickup side = %q, want ct (identity's side)", side)
	}
	if pos != live {
		t.Errorf("pickup pos = %v, want the controlled pawn's %v", pos, live)
	}
}

func TestTakeoverStateStreamShowsControllingHumanAlive(t *testing.T) {
	human, bot, _ := takeoverPair()
	all := []*common.Player{human, bot}
	controls := fakeControls([2]*common.Player{human, bot})

	// The frame yields ONE target for the pair — the human's, sampled
	// through the BOT's pawn (the live one: the human's own pawn is the
	// stale pre-disconnect corpse, so reading it kept hp=0 for the whole
	// window). The covered bot emits no second row (its steamId-0 key
	// could not be stored anyway).
	targets := appendTargets(nil, all, controls)
	if len(targets) != 1 {
		t.Fatalf("targets = %d, want 1 (the pair collapses to the human's entry)", len(targets))
	}
	if targets[0].identity != human || targets[0].pawn != bot {
		t.Fatalf("target = (identity %v, pawn %v), want (human, bot)", targets[0].identity, targets[0].pawn)
	}
	// The row is KEYED with the human — the sidecar slot table stores
	// human SteamIDs, so this is what keeps the takeover window from
	// going dark (the repro: 1840/1840 frames with no bvcket sample).
	row := sampleStatePlayer(targets[0].identity, targets[0].pawn)
	if row.SteamID != human.SteamID64 {
		t.Errorf("state SteamID = %d, want the human's %d", row.SteamID, human.SteamID64)
	}
	// Alive/HP/weapon are read through the pawn the target carries —
	// the bot's, which is the live one (end-to-end hp is verified on the
	// owner's repro demo; a nil-entity fake can only read dead).
	if targets[0].pawn != bot {
		t.Error("state sample must run through the controlled pawn")
	}
}

func TestTakeoverSamplesCarryHumanKey(t *testing.T) {
	human, bot, _ := takeoverPair()
	all := []*common.Player{human, bot}
	controls := fakeControls([2]*common.Player{human, bot})

	// Only the controlled pawn is alive this frame — the takeover window
	// as the sidecar sees it (the human's own pawn is dead, the bot's is
	// live). Swapped under t.Cleanup; production never touches it.
	was := pawnAlive
	pawnAlive = func(p *common.Player) bool { return p == bot }
	t.Cleanup(func() { pawnAlive = was })

	targets := appendTargets(nil, all, controls)
	row, ok := positionRow(targets[0])
	if !ok {
		t.Fatal("no position row while the controlled pawn is alive — the window would go dark")
	}
	// THE pin: the remapped sample carries the HUMAN's key (never the
	// bot's steamId-0), so the sidecar's slot table keeps it.
	if row.SteamID != human.SteamID64 {
		t.Errorf("position SteamID = %d, want the human's %d", row.SteamID, human.SteamID64)
	}
	if row.Side != "ct" {
		t.Errorf("position side = %q, want the identity's ct", row.Side)
	}
}

func TestDisconnectWorldKillNotCountedAsDeathOrSuicide(t *testing.T) {
	world := analytics.WorldWeapon

	// Order A: the kill dispatches BEFORE the disconnect in the frame
	// (repro tick 81343). The stat must not exist before frame end, and
	// the same-tick disconnect must drop it at flush — while the event
	// row stays (the feed records what happened).
	a := newAgg()
	a.roundStart(0, false, false, 115, "BOMB TARGET")
	a.kill(killInfo{
		tick: 100, tickRate: 64, real: true, samePlayer: true,
		killerKey: 1, killerName: "bvcket", killerSide: "ct",
		victimKey: 1, victimName: "bvcket", victimSide: "ct",
		weapon: world,
	})
	if p := a.players[1]; p != nil {
		t.Fatalf("deferred kill counted before frame end: %+v", p)
	}
	a.disconnect(100, 1, "bvcket")
	a.flushWorldSelf()
	kills, disconnects := 0, 0
	for _, e := range a.events {
		switch e.Kind {
		case models.EventKill:
			kills++
		case models.EventDisconnect:
			disconnects++
		}
	}
	if kills != 1 || disconnects != 1 {
		t.Errorf("event rows = %d kills / %d disconnects, want 1/1 (the feed keeps the record)", kills, disconnects)
	}

	// Order B: the disconnect dispatches FIRST (repro tick 89867) —
	// excluded immediately, no deferral needed.
	b := newAgg()
	b.roundStart(0, false, false, 115, "BOMB TARGET")
	b.disconnect(200, 18374686479671623694, "Rebel")
	b.kill(killInfo{
		tick: 200, tickRate: 64, real: true, samePlayer: true,
		killerKey: 18374686479671623694, killerName: "Rebel", killerSide: "t",
		victimKey: 18374686479671623694, victimName: "Rebel", victimSide: "t",
		weapon: world,
	})
	b.flushWorldSelf()

	// A genuine world-hazard self-kill (no disconnect on the tick) still
	// counts as a real death+suicide — the criterion is the PAIR, not
	// the weapon.
	c := newAgg()
	c.roundStart(0, false, false, 115, "BOMB TARGET")
	c.kill(killInfo{
		tick: 300, tickRate: 64, real: true, samePlayer: true,
		killerKey: 7, killerName: "faller", killerSide: "ct",
		victimKey: 7, victimName: "faller", victimSide: "ct",
		weapon: world,
	})
	c.flushWorldSelf()
}

func TestBotTakenOverBookkeeping(t *testing.T) {
	human, bot, _ := takeoverPair()
	a := newAgg()
	// Tick-accurate transition log AND the typed row (moved deliberately —
	// criterion ruling, lead; owner report 2026-11-18): the
	// models.EventBotTakeover row is the replay's coverage-END signal,
	// fetched through the SAME channel as the connect/disconnect rows
	// (preload readEvents → indexConnections → presentAt's controlAt).
	// Every field is read here so both stay pinned structures. The
	// 91334 tick is synthetic for this unit (the production signal is
	// the per-frame demoinfocsControls edge in handlers.go).
	a.botTakeover(91334, human.SteamID64, human.Name, playerKey(bot), bot.Name)
	if len(a.takeovers) != 1 {
		t.Fatalf("takeovers = %d, want 1", len(a.takeovers))
	}
	got := a.takeovers[0]
	if got.tick != 91334 || got.takerKey != human.SteamID64 || got.takerName != "bvcket" ||
		got.botKey != playerKey(bot) || got.botName != "Rebel" {
		t.Errorf("takeover = %+v, want the 91334 bvcket←Rebel transition", got)
	}
	if len(a.events) != 1 {
		t.Fatalf("event rows = %d, want 1 (the bot_takeover row)", len(a.events))
	}
	row := a.events[0]
	if row.Tick != 91334 || row.Kind != models.EventBotTakeover || row.Attacker != keyStr(human.SteamID64) {
		t.Errorf("row = %+v, want the 91334 bot_takeover row keyed by the taker", row)
	}
	if !strings.Contains(row.DetailJSON, `"name":"bvcket"`) || !strings.Contains(row.DetailJSON, `"bot":"Rebel"`) {
		t.Errorf("detail = %s, want the name/bot payload", row.DetailJSON)
	}
}

// TestControlEdges: controlEdges is THE re-assumption detector behind
// the bot_takeover row (owner report 2026-11-18 — coverage ends at
// re-assumption, never at the reconnect). Pinned with plain maps: no
// entities, no parser — the edge rule itself.
func TestControlEdges(t *testing.T) {
	human, bot, _ := takeoverPair()
	k, b := uint64(7), playerKey(bot)
	ctl := func(botKey uint64, name string) ctlEdge {
		return ctlEdge{bot: botKey, key: k, taker: "bvcket", botName: name}
	}
	// Continuing control is NOT an edge (and a non-controlling taker
	// never is — losing control is not a re-assumption).
	if e := controlEdges(
		map[uint64]ctlEdge{k: ctl(b, "Rebel")},
		map[uint64]ctlEdge{k: ctl(b, "Rebel")},
	); len(e) != 0 {
		t.Errorf("unchanged control = %d edges, want 0", len(e))
	}
	if e := controlEdges(
		map[uint64]ctlEdge{k: ctl(b, "Rebel")},
		map[uint64]ctlEdge{k: ctl(0, "")},
	); len(e) != 0 {
		t.Errorf("lost control = %d edges, want 0 (not a re-assumption)", len(e))
	}
	// 0 → bot: THE re-assumption edge (the disconnect→takeover close).
	if e := controlEdges(
		map[uint64]ctlEdge{k: ctl(0, "")},
		map[uint64]ctlEdge{k: ctl(b, "Rebel")},
	); len(e) != 1 || e[0].key != k || e[0].bot != b || e[0].taker != "bvcket" || e[0].botName != "Rebel" {
		t.Errorf("re-assumption edges = %+v, want the one bvcket←Rebel edge", e)
	}
	// A taker absent from `prev` (a disconnect dropped it) controls on
	// re-sighting → edge, never compared equal across the absence.
	if e := controlEdges(
		map[uint64]ctlEdge{},
		map[uint64]ctlEdge{k: ctl(b, "Rebel")},
	); len(e) != 1 || e[0].bot != b {
		t.Errorf("re-sighting after absence = %+v, want the edge", e)
	}
	// Control moved to ANOTHER body → edge (botA → botB).
	other := playerKey(human)
	if e := controlEdges(
		map[uint64]ctlEdge{k: ctl(b, "Rebel")},
		map[uint64]ctlEdge{k: ctl(other, "someone")},
	); len(e) != 1 || e[0].bot != other {
		t.Errorf("bot switch = %+v, want the switch edge", e)
	}
	// A taker never in `prev` who is NOT controlling is never an edge.
	if e := controlEdges(map[uint64]ctlEdge{}, map[uint64]ctlEdge{k: ctl(0, "")}); len(e) != 0 {
		t.Errorf("non-controller = %d edges, want 0", len(e))
	}
}

// TestBotSamplesCarrySyntheticKey: a lone bot's sink rows must carry ITS
// accumulator key, not steamId 0 — the sidecar slot table joins on this
// key, and 0 was dropped at the writer, which is exactly why the owner's
// covering bot "popped into existence at takeover": every pre-takeover
// sample died at the slot table (owner report 2026-11-17). Humans keep
// their SteamID64 byte-for-byte (playerKey is the identity for them).
func TestBotSamplesCarrySyntheticKey(t *testing.T) {
	human, bot, _ := takeoverPair()
	other := &common.Player{Name: "Ricksaw", EntityID: 13, IsBot: true, Team: common.TeamCounterTerrorists}
	// Pre-takeover: the covering human is disconnected, so the control
	// read yields nothing (demoinfocsControls' IsConnected gate) — both
	// bots are their own identities.
	all := []*common.Player{human, bot, other}
	controls := fakeControls()

	was := pawnAlive
	pawnAlive = func(p *common.Player) bool { return true } // every pawn alive this frame
	t.Cleanup(func() { pawnAlive = was })

	targets := appendTargets(nil, all, controls)
	if len(targets) != 3 {
		t.Fatalf("targets = %d, want 3 (nobody is covered pre-takeover)", len(targets))
	}
	seen := map[uint64]bool{}
	for _, tg := range targets {
		row, ok := positionRow(tg)
		if !ok {
			t.Fatalf("no position row for %q", tg.identity.Name)
		}
		want := playerKey(tg.identity)
		if row.SteamID != want {
			t.Errorf("%q position key = %d, want playerKey %d", tg.identity.Name, row.SteamID, want)
		}
		if row.SteamID == 0 {
			t.Errorf("%q position key = 0 — the sidecar drops steamId-0 at the slot table", tg.identity.Name)
		}
		if seen[row.SteamID] {
			t.Errorf("duplicate position key %d — bot keys must be distinct", row.SteamID)
		}
		seen[row.SteamID] = true
		st := sampleStatePlayer(tg.identity, tg.pawn)
		if st.SteamID != want || st.SteamID == 0 {
			t.Errorf("%q state key = %d, want playerKey %d", tg.identity.Name, st.SteamID, want)
		}
	}
	// The human's key is byte-identical to before this rule (SteamID64).
	if id := playerKey(human); id != human.SteamID64 {
		t.Fatalf("human key = %d, want the raw SteamID64 %d", id, human.SteamID64)
	}
}

// TestTakeoverHandoffPositionsContinuous: at the handoff the identity
// swaps (covering bot's synthetic key → controlling human's SteamID64)
// while the PAWN — the source of every coordinate — stays the same bot
// object on both sides of the swap, so the marker moves by exactly zero
// units: no jump, no gap (owner ruling, 2026-11-17). The pre-takeover
// side runs with an empty control read (the covering human is
// disconnected — the IsConnected gate), the post side with the takeover
// pair.
func TestTakeoverHandoffPositionsContinuous(t *testing.T) {
	human, bot, _ := takeoverPair()
	all := []*common.Player{human, bot}

	was := pawnAlive
	pawnAlive = func(p *common.Player) bool { return p == bot } // the controlled pawn is the live one
	t.Cleanup(func() { pawnAlive = was })

	// Pre-takeover: nobody controls — the bot emits as its own identity.
	var preBot *identityTarget
	for _, tg := range appendTargets(nil, all, fakeControls()) {
		if tg.identity == bot {
			preBot = &tg
		}
	}
	if preBot == nil {
		t.Fatal("pre-takeover: no target for the lone covering bot")
	}
	// Post-takeover: the human controls — his target reads the bot's pawn.
	var postHuman *identityTarget
	for _, tg := range appendTargets(nil, all, fakeControls([2]*common.Player{human, bot})) {
		if tg.identity == human {
			postHuman = &tg
		}
	}
	if postHuman == nil {
		t.Fatal("post-takeover: no target for the controlling human")
	}

	// Same pawn on both sides — every coordinate is read from one source.
	if preBot.pawn != postHuman.pawn || preBot.pawn != bot {
		t.Fatalf("handoff pawn = pre %v / post %v, want the same bot object", preBot.pawn, postHuman.pawn)
	}
	preRow, ok := positionRow(*preBot)
	if !ok {
		t.Fatal("pre-takeover bot row missing")
	}
	postRow, ok := positionRow(*postHuman)
	if !ok {
		t.Fatal("post-takeover human row missing")
	}
	// The ONLY thing that changes at the handoff is the key.
	if preRow.SteamID == postRow.SteamID {
		t.Errorf("handoff key stayed %d — identity must hand off to the human", preRow.SteamID)
	}
	if preRow.SteamID != playerKey(bot) || postRow.SteamID != human.SteamID64 {
		t.Errorf("handoff keys = bot %d → human %d, want %d → %d",
			preRow.SteamID, postRow.SteamID, playerKey(bot), human.SteamID64)
	}
	if preRow.X != postRow.X || preRow.Y != postRow.Y || preRow.Z != postRow.Z ||
		preRow.Yaw != postRow.Yaw || preRow.Air != postRow.Air || preRow.Duck != postRow.Duck ||
		preRow.Side != postRow.Side {
		t.Errorf("handoff teleported: pre %+v vs post %+v", preRow, postRow)
	}
}
