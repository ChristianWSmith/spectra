package extract

import (
	demoinfocs "github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs"
	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/common"
	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/events"
	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/msg"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// registerHandlers wires every demoinfocs callback to the accumulator.
// Handlers stay thin: read parser state, convert demoinfocs types into plain
// values, then call exactly one agg method — all aggregation logic lives on
// *agg and is unit-testable without a parser.
func registerHandlers(p *demoinfocs.Parser, a *agg) {
	// v6 dropped Parser.Header(); the full header arrives as a net-message.
	p.RegisterNetMessageHandler(func(m *msg.CDemoFileHeader) {
		a.setHeader(headerInfo{
			mapName:      m.GetMapName(),
			serverName:   m.GetServerName(),
			clientName:   m.GetClientName(),
			gameDir:      m.GetGameDirectory(),
			patchVersion: int(m.GetPatchVersion()),
		})
	})

	// Generic escape hatch: every game-event, named + raw payload.
	p.RegisterEventHandler(func(e events.GenericGameEvent) {
		a.genericEvent(e.Name, p.GameState().IngameTick(), gameEventPayloadJSON(e.Data))
	})

	p.RegisterEventHandler(func(e events.ParserWarn) {
		a.warn(int(e.Type), e.Message)
	})

	p.RegisterEventHandler(func(events.POVRecordingPlayerDetected) {
		a.setPOV()
	})

	p.RegisterEventHandler(func(events.GameHalfEnded) {
		// The score at this event is one increment stale (it fires from
		// the m_gamePhase prop write before the winner's score lands);
		// freezeEnd resolves the settled score once the sides switch.
		a.setHalfPending()
	})

	p.RegisterEventHandler(func(events.TeamSideSwitch) {
		a.sideSwitch()
	})

	// ---- round state machine ----

	p.RegisterEventHandler(func(e events.RoundStart) {
		gs := p.GameState()
		warmup := gs.IsWarmupPeriod()
		// Non-warmup round that isn't stats-eligible play → pregame
		// (MatchZy-style knife round: match started, phase Pregame, or a
		// post-match round while IsMatchStarted already flipped back).
		// agg.roundStart discards both flavors: a warmup/pregame round is
		// not ingested (no round row, no events/chat/sounds of that
		// round — the owner's knife/warmup discard).
		pregame := !warmup && !realPeriod(gs)
		a.roundStart(gs.IngameTick(), warmup, pregame, e.TimeLimit, e.Objective)
	})

	p.RegisterEventHandler(func(e events.RoundFreezetimeChanged) {
		if e.NewIsFreezetime {
			return
		}
		gs := p.GameState()
		equipCT, equipT := 0, 0
		scoreCT, scoreT := 0, 0
		if ct := gs.TeamCounterTerrorists(); ct != nil {
			equipCT = ct.FreezeTimeEndEquipmentValue()
			scoreCT = ct.Score()
		}
		if t := gs.TeamTerrorists(); t != nil {
			equipT = t.FreezeTimeEndEquipmentValue()
			scoreT = t.Score()
		}
		playing := gs.Participants().Playing()
		samples := make([]moneySample, 0, len(playing))
		for _, pl := range playing {
			if pl == nil {
				continue
			}
			samples = append(samples, moneySample{
				key:   playerKey(pl),
				name:  pl.Name,
				side:  sideString(pl.Team),
				money: pl.Money(),
				// Live cumulative cash-spent counter (entity property
				// m_pInGameMoneyServices.m_iTotalCashSpent): freezeEnd
				// diffs it against the previous freeze end for the
				// per-round side spend (round_economy.spent).
				spent: pl.MoneySpentTotal(),
				// Free spawn-issued default pistols still held at this
				// instant — never paid for, yet counted at $200 each in
				// the game's equipment value (see freeSpawnPistolValue).
				freePistol: freeSpawnPistolValue(pl.Weapons()),
			})
		}
		a.freezeEnd(gs.IngameTick(), equipCT, equipT, scoreCT, scoreT, samples)
	})

	p.RegisterEventHandler(func(e events.RoundEnd) {
		gs := p.GameState()
		a.roundEnd(
			gs.IngameTick(),
			sideString(e.Winner),
			roundEndReasonName(e.Reason),
			e.Message,
			p.TickRate(),
		)
		// MVP attribution via scoreboard-counter diffs (the round_mvp
		// announcement is absent in many demos, golden included) plus the
		// round-end money sample behind player_round_stats' money columns.
		// The money props are read HERE, at RoundEnd, because that is the
		// first instant the round's spend is complete: m_iCashSpentThisRound
		// keeps accruing while mp_buytime stays open past freezetime
		// (characterized on golden by TestDiagRoundMoneyProps: 15
		// player-rounds bought after freeze end), while m_iStartAccount and
		// m_unRoundStartEquipmentValue are round-stable (zero drift freeze
		// end → round end) and no spend lands between RoundEnd and the next
		// RoundStart (gap-buy check = 0). A participant without the
		// start-account prop contributes no sample (see roundStartMoney).
		playing := gs.Participants().Playing()
		samples := make([]moneyEndSample, 0, len(playing))
		for _, pl := range playing {
			if pl == nil {
				continue
			}
			a.mvpScan(playerKey(pl), pl.Name, pl.MVPs())
			if start, ok := roundStartMoney(pl); ok {
				samples = append(samples, moneyEndSample{
					key:          playerKey(pl),
					startAccount: start,
					equipStart:   pl.EquipmentValueRoundStart(),
					spent:        pl.MoneySpentThisRound(),
				})
			}
		}
		a.moneyEnd(samples)
	})

	p.RegisterEventHandler(func(e events.RoundMVPAnnouncement) {
		key, name := uint64(0), ""
		if e.Player != nil {
			key = playerKey(e.Player)
			name = e.Player.Name
		}
		a.roundMVP(key, name, mvpReasonName(e.Reason))
	})

	// ---- combat ----

	p.RegisterEventHandler(func(e events.Kill) {
		gs := p.GameState()
		k := killInfoFor(e, newRemap(gs))
		k.tick = gs.IngameTick()
		k.real = realPeriod(gs)
		k.tickRate = p.TickRate()
		// Trade-opportunity proximity input: the victim's living
		// teammates' positions at this death tick (config-independent —
		// measured once here, gated later against analysis_config).
		k.matePos = livingTeammatePos(gs, e.Killer, e.Victim)
		a.kill(k)
	})

	p.RegisterEventHandler(func(e events.PlayerHurt) {
		gs := p.GameState()
		h := hurtInfoFor(e, newRemap(gs))
		h.tick = gs.IngameTick()
		h.real = realPeriod(gs)
		a.hurt(h)
	})

	p.RegisterEventHandler(func(e events.WeaponFire) {
		gs := p.GameState()
		if e.Shooter == nil || !realPeriod(gs) {
			return
		}
		who, _ := newRemap(gs).pair(e.Shooter)
		a.shot(playerKey(who), who.Name)
	})

	p.RegisterEventHandler(func(e events.PlayerFlashed) {
		if e.Player == nil {
			return
		}
		gs := p.GameState()
		r := newRemap(gs)
		key, name, side, _ := participantRow(e.Player, r)
		b := blindInfo{
			tick:       gs.IngameTick(),
			real:       realPeriod(gs),
			playerKey:  key,
			playerName: name,
			playerSide: side,
			flashMs:    int(e.FlashDuration().Milliseconds()),
		}
		if e.Attacker != nil {
			b.attackerKey, b.attackerName, b.attackerSide, _ = participantRow(e.Attacker, r)
		}
		a.blind(b)
	})

	// ---- bomb ----

	p.RegisterEventHandler(func(e events.BombPlanted) {
		gs := p.GameState()
		key, name, _, _ := participantRow(e.Player, newRemap(gs))
		bx, by, bz := bombPos(gs)
		a.bombPlanted(gs.IngameTick(), bombSite(e.Site), key, name, realPeriod(gs), bx, by, bz)
	})

	// The ATTEMPT lifecycle (models.EventBombPlantBegin…Abort): a
	// begin/start OPENS an attempt the frontend closes with the matching
	// completion row above or the *_abort cancel below. demoinfocs
	// dispatches these from entity properties (CC4 m_bStartedArming /
	// m_hBombDefuser — spectra leaves DisableMimicSource1Events off), and
	// the characterization run (plantdefuse_diag_test.go, all seven
	// golden demos) found the cancels trustworthy: 92 plant attempts
	// (79 completed / 12 aborted / 1 round-end orphan) and 32 defuse
	// attempts (17 / 20 / 0), with an abort NEVER observed alongside a
	// completion — so the extractor stores the events as dispatched and
	// needs no completion-overrides-cancel filter. No stat counts these
	// rows; attempts of a discarded round (knife/warmup) are never stored
	// either — addEvent drops every row while agg.discarding is set.
	p.RegisterEventHandler(func(e events.BombPlantBegin) {
		gs := p.GameState()
		key, name, _, _ := participantRow(e.Player, newRemap(gs))
		a.bombPlantBegin(gs.IngameTick(), bombSite(e.Site), key, name)
	})

	p.RegisterEventHandler(func(e events.BombPlantAborted) {
		gs := p.GameState()
		key, name, _, _ := participantRow(e.Player, newRemap(gs))
		a.bombPlantAborted(gs.IngameTick(), key, name)
	})

	p.RegisterEventHandler(func(e events.BombDefuseStart) {
		gs := p.GameState()
		r := newRemap(gs)
		key, name, _, _ := participantRow(e.Player, r)
		hasKit := false
		if e.Player != nil {
			// The kit lives on the PAWN — read through the controlled
			// bot's during a takeover (participantRow's identity side
			// does not carry it).
			_, pawn := r.pair(e.Player)
			hasKit = pawn.HasDefuseKit()
		}
		a.bombDefuseStart(gs.IngameTick(), bombSite(e.Site), key, name, hasKit)
	})

	p.RegisterEventHandler(func(e events.BombDefuseAborted) {
		gs := p.GameState()
		key, name, _, _ := participantRow(e.Player, newRemap(gs))
		a.bombDefuseAborted(gs.IngameTick(), key, name)
	})

	p.RegisterEventHandler(func(e events.BombDefused) {
		gs := p.GameState()
		r := newRemap(gs)
		key, name, _, _ := participantRow(e.Player, r)
		hasKit := false
		if e.Player != nil {
			_, pawn := r.pair(e.Player)
			hasKit = pawn.HasDefuseKit()
		}
		bx, by, bz := bombPos(gs)
		a.bombDefused(gs.IngameTick(), bombSite(e.Site), key, name, hasKit, realPeriod(gs), bx, by, bz)
	})

	p.RegisterEventHandler(func(e events.BombExplode) {
		gs := p.GameState()
		bx, by, bz := bombPos(gs)
		a.bombExploded(gs.IngameTick(), bombSite(e.Site), bx, by, bz)
	})

	p.RegisterEventHandler(func(e events.BombDropped) {
		gs := p.GameState()
		key, name, _, carrierPos := participantRow(e.Player, newRemap(gs))
		// Evidence (dropped-C4 positions): the CARRIER's position at
		// this instant is the drop site — BombDropped fires when the C4
		// loses its owner (release time; death drops included — see the
		// CS2.md entry), so the pawn marks where it left their hands.
		// The bomb entity's own position rides along as corroborating
		// DetailJSON evidence when it has one (bombPos — free, same
		// zero-vector convention as posPtrs).
		var px, py, pz *float64
		if e.Player != nil {
			px, py, pz = posPtrs(carrierPos)
		}
		bx, by, bz := bombPos(gs)
		a.bombDropped(gs.IngameTick(), key, name, px, py, pz, bx, by, bz)
	})

	p.RegisterEventHandler(func(e events.BombPickup) {
		gs := p.GameState()
		// bomb_pickup carries ONLY userid_pawn, so demoinfocs resolves it
		// to the substitute BOT's controller while the C4 is in the
		// reconnecting human's hands — the takeover remap collapses the
		// two resolution domains onto the controlling human (owner's
		// repro: tick 92916 landed on the bot's key before this rule).
		key, name, _, playerPos := participantRow(e.Player, newRemap(gs))
		// Evidence: where the pickup happened — the bomb entity's
		// position, falling back to the pickup player's pawn when the
		// entity has no known location; DetailJSON `source` records
		// which one the columns carry.
		px, py, pz := bombPos(gs)
		source := "bomb"
		if px == nil {
			source = "player"
			if e.Player != nil {
				px, py, pz = posPtrs(playerPos)
			}
		}
		a.bombPickedUp(gs.IngameTick(), key, name, px, py, pz, source)
	})

	// ---- grenades ----

	p.RegisterEventHandler(func(e events.HeExplode) {
		a.grenadeBlast(blastFor(e.GrenadeEvent, "hegrenade_detonate", p))
	})

	p.RegisterEventHandler(func(e events.FlashExplode) {
		// demoinfocs v6 dispatches FlashExplode TWICE per flashbang (the
		// flashbang_detonate game event AND the projectile's entity
		// on-destroy handler — CS2.md "A flashbang detonation fires TWICE
		// in demoinfocs-golang v6"); agg.grenadeBlast's blastSeen dedupe
		// keeps ONE row per (tick, thrower, weapon), first dispatch wins.
		a.grenadeBlast(blastFor(e.GrenadeEvent, "flashbang_detonate", p))
	})

	p.RegisterEventHandler(func(e events.SmokeStart) {
		a.grenadeBlast(blastFor(e.GrenadeEvent, "smokegrenade_detonate", p))
	})

	p.RegisterEventHandler(func(e events.FireGrenadeStart) {
		a.grenadeBlast(blastFor(e.GrenadeEvent, "inferno_startburn", p))
	})

	p.RegisterEventHandler(func(e events.DecoyStart) {
		// ACTIVATION ≈ rest: the decoy lands ~2 s after the throw and
		// then makes noise for 15–18 s — this row is the flight's END
		// (the replay pairs the throw arc to it) and the noise window's
		// start (the renderer's rest icon), NOT a detonation: it gets
		// its own kind (models.EventGrenadeLand) so no stat or scrubber
		// marker mistakes it for an explosion.
		a.decoyLanded(blastFor(e.GrenadeEvent, "decoy_started", p))
	})

	p.RegisterEventHandler(func(e events.DecoyExpired) {
		// decoy_detonate → the EXPLOSION (the game plays
		// BaseGrenade.Explode — the HE files, so the row stays an
		// ordinary EventGrenade and sfx.js remaps the cue name to "HE
		// Grenade"). demoinfocs dispatches DecoyExpired from it
		// (game_events.go) — verified on golden/de_dust2.dem.zst: the
		// payload carries x/y/z (the rest position — identical to the
		// activation's) plus the thrower, so blastFor stores the real
		// coordinates; no pairing guess is needed.
		a.grenadeBlast(blastFor(e.GrenadeEvent, "decoy_detonate", p))
	})

	p.RegisterEventHandler(func(e events.GrenadeProjectileThrow) {
		if e.Projectile == nil {
			return
		}
		key, name, _, _ := participantRow(e.Projectile.Thrower, newRemap(p.GameState()))
		weapon := "Unknown"
		if e.Projectile.WeaponInstance != nil {
			weapon = e.Projectile.WeaponInstance.Type.String()
		}
		var px, py, pz *float64
		if e.Projectile.Entity != nil {
			px, py, pz = posPtrs(e.Projectile.Position())
		}
		// entity = the PROJECTILE entity id — the join key the replay pairs
		// throw → bounces → det with (models.EventGrenadeBounce). Measured
		// on golden: every bounce's SOS source index (979/979) is one of
		// these thrown-projectile ids, while the thrower's controller
		// entity id matches 0/979. 0 when the projectile entity is unknown.
		entity := 0
		if e.Projectile.Entity != nil {
			entity = e.Projectile.Entity.ID()
		}
		a.grenadeThrown(p.GameState().IngameTick(), key, name, entity, weapon, px, py, pz)
	})

	// ---- drops (weapon_drop / weapon_pickup) ----

	// Per-frame last-held-utility sample (the death-drop util rule's
	// "last held util this round" input): the ACTIVE weapon of every
	// alive participant, recorded when it is a grenade. Runs on every
	// FrameDone regardless of which sinks are wired — the death at frame
	// N reads the frame N-1 sample (the victim is dead by this frame's
	// FrameDone, so a held grenade is never overwritten by the death
	// itself). Reset per round in agg.roundStart (ONE home with the
	// other per-round resets). targetBuf is reused across frames (the
	// parse is sequential — MsgQueueBufferSize(0)).
	targetBuf := make([]identityTarget, 0, 10)
	// Control re-assumption edge (agg.botTakeover → models.EventBotTakeover
	// rows — the replay's coverage-END signal; owner report 2026-11-18):
	// every frame the control state of every participant is compared to
	// the previous one through controlEdges (takeover.go — THE pure
	// detector, pinned there). demoinfocsControls is the SAME read the
	// position/state sinks route through, so the row's tick IS the
	// identity handoff frame the position stream shows (91972 on the
	// owner's demo — Rebel's last walking frame 91971, bvcket's first
	// 91972). prevCtl persists across frames; the first FrameDone seeds
	// it silently (state, not a transition).
	prevCtl := map[uint64]ctlEdge{}
	seedsCtl := false
	p.RegisterEventHandler(func(events.FrameDone) {
		// Same takeover routing as the position/state sinks: the held
		// util of a life controlled through a bot is read from the
		// controlled pawn and noted under the controlling human's key
		// (the death-drop util rule keys the victim of a later kill —
		// which during a takeover is the human).
		targetBuf = appendTargets(targetBuf[:0], p.GameState().Participants().Playing(), demoinfocsControls)
		for _, t := range targetBuf {
			if !t.pawn.IsAlive() {
				continue
			}
			if w := t.pawn.ActiveWeapon(); w != nil && isUtilityEquipment(w.Type) {
				a.noteHeldUtil(playerKey(t.identity), wepName(w))
			}
		}
		// The control edge: one pass over EVERY participant (All, not
		// only Playing — the gate is demoinfocsControls' own IsConnected,
		// the read the sinks use, so the row's tick and the position
		// handoff can never disagree).
		gs := p.GameState()
		cur := map[uint64]ctlEdge{}
		for _, c := range gs.Participants().All() {
			if c == nil || c.IsBot {
				continue // a bot never re-assumes control — the taker is human
			}
			e := ctlEdge{bot: 0, key: playerKey(c), taker: c.Name}
			if bot := demoinfocsControls(c); bot != nil && bot != c {
				e.bot = playerKey(bot)
				e.botName = bot.Name
			}
			cur[e.key] = e
		}
		if seedsCtl {
			for _, e := range controlEdges(prevCtl, cur) {
				a.botTakeover(gs.IngameTick(), e.key, e.taker, e.bot, e.botName)
			}
		} else {
			seedsCtl = true // first frame: state, not a transition
		}
		// prev = this frame's full state: a taker absent from `cur` (a
		// disconnect) drops out, so a reconnect-while-controlling can
		// never compare equal across the absence (controlEdges' !ok
		// edges again on re-sighting).
		prevCtl = cur
	})

	// item_pickup fires for EVERY acquisition — ground pickups AND buys
	// AND spawn restocks (characterized: drops_diag_test.go saw 1473
	// events on golden vs 91 that pair with a death drop; raw
	// item_purchase never fires there). The typed row is restricted to
	// gun/util/kit items (dropCat — knife/C4/armour have no drop-evidence
	// counterpart; the KIT rides through because a kit bought on the
	// buy menu and one taken off a dead CT are the SAME item_pickup row
	// and only the frontend's buytime rule can tell them apart — see
	// lib/replay/kits.js) and the FRONTEND rule consumes only same-round
	// post-drop matches (lib/replay/drops.js), so buy-restock rows are
	// harmless there; they stay stored because nothing can tell the two
	// apart at extract time.
	p.RegisterEventHandler(func(e events.ItemPickup) {
		if e.Player == nil {
			return
		}
		// demoinfocs resolves e.Weapon from the payload's `item` field
		// (game_events.go itemEvent → common.MapEquipment("defuser") →
		// EqDefuseKit), so wepName reads "Defuse Kit" for a kit row —
		// models.DefuseKitName's spelling, verified by the diag run's
		// kit pickup counts (drops_diag_test.go).
		name := wepName(e.Weapon)
		cat := dropCat(name)
		if cat == "" {
			return
		}
		gs := p.GameState()
		key, pname, _, pos := participantRow(e.Player, newRemap(gs))
		px, py, pz := posPtrs(pos)
		a.weaponPickedUp(gs.IngameTick(), key, pname, name, cat, px, py, pz)
	})

	// ---- people, chat ----

	p.RegisterEventHandler(func(e events.PlayerConnect) {
		if e.Player == nil {
			return
		}
		a.connect(p.GameState().IngameTick(), playerKey(e.Player), e.Player.Name, e.Player.IsBot)
	})

	p.RegisterEventHandler(func(e events.BotConnect) {
		if e.Player == nil {
			return
		}
		a.connect(p.GameState().IngameTick(), playerKey(e.Player), e.Player.Name, e.Player.IsBot)
	})

	p.RegisterEventHandler(func(e events.PlayerDisconnected) {
		if e.Player == nil {
			return
		}
		a.disconnect(p.GameState().IngameTick(), playerKey(e.Player), e.Player.Name)
	})

	// bot_takeover → control re-assumption (models.EventBotTakeover).
	// The events.BotTakenOver GAME EVENT was retired as a source here
	// (owner's 2026-11-18 report wave): it never fires for reconnect-
	// recovery — ground truth on the owner's demo, zero BotTakenOver
	// events across a whole parse — so it cannot end the replay's
	// coverage window when the owner can see control change hands. THE
	// signal is the per-frame demoinfocsControls edge in the FrameDone
	// handler below: the exact read the position/state sinks route
	// through, so the recorded tick IS the frame the identity handoff
	// lands on (91972 on the owner's demo — Rebel's last walking frame
	// 91971, bvcket's first 91972).

	// Player chat is read from SayText2, NOT from events.ChatMessage:
	// SayText2 carries MsgName — the ONLY channel signal (all vs team) —
	// and is dispatched UNCONDITIONALLY for every chat message, while
	// demoinfocs synthesizes ChatMessage only for the all-chat MsgNames
	// and DROPS the team ones (Cstrike_Chat_T_Loc/CT_Loc/T_Dead/CT_Dead
	// fall through to an empty case in net_messages.go). Handling both
	// would double every all-chat row (ChatMessage has a single dispatch
	// site, inside SayText2's handler — same message, same tick), so this
	// handler is THE one chat source: one row per message, no duplicates.
	// The encrypted-MM path re-dispatches the decrypted inner message
	// through the same dispatcher, so channel decoding works there too.
	p.RegisterEventHandler(func(e events.SayText2) {
		channel := chatChannel(e.MsgName)
		if channel == "" {
			return // not chat — coach join, name change, … (never a row)
		}
		// Sender lookup mirrors demoinfocs' own ChatMessage dispatch
		// (playersByEntityID[EntIdx] — exposed publicly as
		// Participants().ByEntityID()); an unresolvable sender keeps the
		// empty steam/name exactly as before, never a guessed identity.
		steam, name := "", ""
		if pl := p.GameState().Participants().ByEntityID()[e.EntIdx]; pl != nil {
			steam = keyStr(playerKey(pl))
			name = pl.Name
		}
		// Text = Param2 — the same parameter demoinfocs passes as
		// ChatMessage.Text. The census over golden/*.dem.zst found no
		// "*DEAD*"/"*SPEC*" decoration in Params (the client adds those
		// via localization, not in the wire text), so nothing is stripped:
		// the message is stored exactly as the game sent it.
		text := ""
		if len(e.Params) > 1 {
			text = e.Params[1]
		}
		a.chat(p.GameState().IngameTick(), steam, name, text, channel)
	})

	p.RegisterEventHandler(func(e events.SayText) {
		a.systemChat(p.GameState().IngameTick(), e.Text)
	})

	p.RegisterEventHandler(func(e events.RankUpdate) {
		if e.Player == nil {
			return
		}
		a.rankUpdate(playerKey(e.Player), e.Player.Name, e.RankNew, e.WinCount)
	})
}

// killInfoFor builds the kill row's identity / position / inventory
// inputs from a typed kill event — the takeover remap runs HERE so the
// owner's two resolution domains collapse onto one life: a userid-keyed
// participant (the reconnecting human) and a pawn-keyed one (the
// substitute bot) resolve to the SAME identity, and every pawn-carried
// read runs through the controlled bot's pawn (position, death-drop
// inventory, defuse kit — the human's own pawn is the stale
// pre-disconnect corpse, CS2.md "Reconnect takeover"). gs-dependent
// inputs (tick, real, tickRate, matePos) stay in the handler.
func killInfoFor(e events.Kill, r *remap) killInfo {
	k := killInfo{
		weapon:        wepName(e.Weapon),
		headshot:      e.IsHeadshot,
		wallbang:      e.IsWallBang(),
		noscope:       e.NoScope,
		throughSmoke:  e.ThroughSmoke,
		attackerBlind: e.AttackerBlind,
		assistedFlash: e.AssistedFlash,
		distance:      float64(e.Distance),
	}
	var killerWho, victimWho *common.Player
	if e.Killer != nil {
		var pawn *common.Player
		killerWho, pawn = r.pair(e.Killer)
		k.killerKey = playerKey(killerWho)
		k.killerName = killerWho.Name
		k.killerSide = sideString(killerWho.Team)
		k.attackerPosX, k.attackerPosY, k.attackerPosZ = posPtrs(r.pos(pawn))
	}
	if e.Victim != nil {
		var pawn *common.Player
		victimWho, pawn = r.pair(e.Victim)
		k.victimKey = playerKey(victimWho)
		k.victimName = victimWho.Name
		k.victimSide = sideString(victimWho.Team)
		k.posX, k.posY, k.posZ = posPtrs(r.pos(pawn))
		// Death-drop evidence: the victim's inventory AT the kill tick
		// (ammo included) — through the controlled pawn during a
		// takeover, so the drops are the items the life actually
		// carried. Characterized on all seven golden demos —
		// drops_diag_test.go TestDiagDropInventoryAtKill: 1174/1174
		// kills dispatched with a non-empty, unmutated inventory
		// identical to the last frame's sample, so this read is
		// authoritative (no last-known fallback path).
		k.inv = dropInventory(pawn.Weapons())
		// Defuse-kit possession rides the SAME dispatch instant: the
		// kit is not inventory (HasDefuseKit reads the pawn's
		// m_pItemServices.m_bHasDefuser), so it needs its own read —
		// characterized in the same diag run (victim alive at dispatch,
		// so the pawn property is still there to read; counts reported
		// by TestDiagDropInventoryAtKill).
		k.hasKit = pawn.HasDefuseKit()
	}
	// Identity-level self-kill: the resolved identities are one life (a
	// takeover pair resolving both sides to the human IS the same life —
	// never a cross-kill). Stated on the identities, not the raw event
	// players, so the remap cannot split one life into two entities.
	k.samePlayer = killerWho != nil && victimWho != nil && killerWho.EntityID == victimWho.EntityID
	if e.Assister != nil {
		who, _ := r.pair(e.Assister)
		k.assisterKey = playerKey(who)
		k.assisterName = who.Name
		k.assisterSide = sideString(who.Team)
	}
	return k
}

// hurtInfoFor builds the damage row's identity / victim-position inputs
// from a typed player_hurt event — the same takeover remap as the kill
// pipeline (both resolution domains → one identity; position through the
// controlled pawn). gs-dependent inputs (tick, real) stay in the handler.
func hurtInfoFor(e events.PlayerHurt, r *remap) hurtInfo {
	wn := wepName(e.Weapon)
	if e.WeaponString != "" && (e.Weapon == nil || e.Weapon.Type == common.EqUnknown) {
		wn = e.WeaponString
	}
	h := hurtInfo{
		weapon:            wn,
		healthDamage:      e.HealthDamage,
		healthDamageTaken: e.HealthDamageTaken,
		health:            e.Health,
		hitgroup:          hitGroupName(e.HitGroup),
	}
	if e.Weapon != nil && isUtilityEquipment(e.Weapon.Type) {
		h.isUtility = true
	}
	if e.Attacker != nil {
		who, _ := r.pair(e.Attacker)
		h.attackerKey = playerKey(who)
		h.attackerName = who.Name
		h.attackerSide = sideString(who.Team)
	}
	if e.Player != nil {
		who, pawn := r.pair(e.Player)
		h.victimKey = playerKey(who)
		h.victimName = who.Name
		h.victimSide = sideString(who.Team)
		h.posX, h.posY, h.posZ = posPtrs(r.pos(pawn))
	}
	return h
}

// chatChannel maps a SayText2 MsgName onto the chat channel stored per
// row (models.Chat.Channel): "all" | "team" | "" (not chat). The MsgName
// vocabulary is the one demoinfocs switches on in net_messages.go —
// all-chat (incl. its spectator/dead variants) reads [ALL] downstream;
// the team-chat MsgNames read the SPECTATOR-free speaker's side instead
// (the frontend/report tag [T]/[CT]). Anything else (coach join, name
// change, …) returns "" and never becomes a chat row. The golden-pool
// census (golden/*.dem.zst) observed ONLY Cstrike_Chat_All and
// Cstrike_Chat_AllDead — no team MsgName appears in any of them.
func chatChannel(msgName string) string {
	switch msgName {
	case "Cstrike_Chat_All", "Cstrike_Chat_AllSpec", "Cstrike_Chat_AllDead":
		return "all"
	case "Cstrike_Chat_T_Loc", "Cstrike_Chat_CT_Loc", "Cstrike_Chat_T_Dead", "Cstrike_Chat_CT_Dead":
		return "team"
	default:
		return ""
	}
}

// blastFor converts a grenade detonation event into blastInfo.
func blastFor(ge events.GrenadeEvent, source string, p *demoinfocs.Parser) blastInfo {
	g := blastInfo{
		tick:   p.GameState().IngameTick(),
		weapon: ge.GrenadeType.String(),
		source: source,
		x:      ge.Position.X,
		y:      ge.Position.Y,
		z:      ge.Position.Z,
	}
	// entity = the PROJECTILE entity id — the join key the replay pairs
	// throw → bounces → det with (models.EventGrenadeBounce). Measured on
	// golden: a bounce's SOS source index is the thrown projectile entity
	// 979/979, and ge.Projectile.Entity.ID() covers every one of those ids
	// across all 387 blast rows (GrenadeEntityID only 912/979 — for a
	// molotov's inferno_startburn it is the INFERNO entity, not the
	// projectile — and the legacy payload's entityid is 912/979 too). 0 =
	// the projectile instance is unknown: recorded as-is, never guessed.
	if ge.Projectile != nil && ge.Projectile.Entity != nil {
		g.entity = ge.Projectile.Entity.ID()
	}
	if ge.Thrower != nil {
		g.throwerKey, g.throwerName, _, _ = participantRow(ge.Thrower, newRemap(p.GameState()))
	}
	return g
}

// decoyLanded emits the decoy ACTIVATION row (models.EventGrenadeLand —
// the game's decoy_started event ≈ the projectile coming to rest).
// The row is the SAME payload agg.grenadeBlast builds (same tick /
// weapon / thrower / x,y,z / raw-payload pairing via g.source) with only
// the KIND differing — that one difference is the whole point: no
// analytics rule, heatmap or scrubber marker may count an ACTIVATION as
// a detonation, while the replay pairs the throw arc to it as the rest
// position (lib/replay/decoy.js pairs it with the decoy_detonate row for
// the noise window). It lives here rather than in agg.go because only
// this handler needs the alternate kind; cross-reference:
// models.EventGrenadeLand.
func (a *agg) decoyLanded(g blastInfo) {
	px, py, pz := pos3(g.x, g.y, g.z)
	a.addEvent(models.Event{
		Tick:     g.tick,
		Kind:     models.EventGrenadeLand,
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
