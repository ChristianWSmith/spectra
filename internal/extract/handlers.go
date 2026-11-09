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
		// announcement is absent in many demos, golden included).
		for _, pl := range gs.Participants().Playing() {
			if pl == nil {
				continue
			}
			a.mvpScan(playerKey(pl), pl.Name, pl.MVPs())
		}
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
		k := killInfo{
			tick:          gs.IngameTick(),
			real:          realPeriod(gs),
			tickRate:      p.TickRate(),
			weapon:        wepName(e.Weapon),
			headshot:      e.IsHeadshot,
			wallbang:      e.IsWallBang(),
			noscope:       e.NoScope,
			throughSmoke:  e.ThroughSmoke,
			attackerBlind: e.AttackerBlind,
			assistedFlash: e.AssistedFlash,
			distance:      float64(e.Distance),
		}
		if e.Killer != nil {
			k.killerKey = playerKey(e.Killer)
			k.killerName = e.Killer.Name
			k.killerSide = sideString(e.Killer.Team)
			k.attackerPosX, k.attackerPosY, k.attackerPosZ = posPtrs(e.Killer.Position())
		}
		if e.Victim != nil {
			k.victimKey = playerKey(e.Victim)
			k.victimName = e.Victim.Name
			k.victimSide = sideString(e.Victim.Team)
			k.samePlayer = e.Killer != nil && e.Killer.EntityID == e.Victim.EntityID
			k.posX, k.posY, k.posZ = posPtrs(e.Victim.Position())
		}
		if e.Assister != nil {
			k.assisterKey = playerKey(e.Assister)
			k.assisterName = e.Assister.Name
			k.assisterSide = sideString(e.Assister.Team)
		}
		// Trade-opportunity proximity input: the victim's living
		// teammates' positions at this death tick (config-independent —
		// measured once here, gated later against analysis_config).
		k.matePos = livingTeammatePos(gs, e.Killer, e.Victim)
		a.kill(k)
	})

	p.RegisterEventHandler(func(e events.PlayerHurt) {
		gs := p.GameState()
		wn := wepName(e.Weapon)
		if e.WeaponString != "" && (e.Weapon == nil || e.Weapon.Type == common.EqUnknown) {
			wn = e.WeaponString
		}
		h := hurtInfo{
			tick:              gs.IngameTick(),
			real:              realPeriod(gs),
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
			h.attackerKey = playerKey(e.Attacker)
			h.attackerName = e.Attacker.Name
			h.attackerSide = sideString(e.Attacker.Team)
		}
		if e.Player != nil {
			h.victimKey = playerKey(e.Player)
			h.victimName = e.Player.Name
			h.victimSide = sideString(e.Player.Team)
			h.posX, h.posY, h.posZ = posPtrs(e.Player.Position())
		}
		a.hurt(h)
	})

	p.RegisterEventHandler(func(e events.WeaponFire) {
		gs := p.GameState()
		if e.Shooter == nil || !realPeriod(gs) {
			return
		}
		a.shot(playerKey(e.Shooter), e.Shooter.Name)
	})

	p.RegisterEventHandler(func(e events.PlayerFlashed) {
		if e.Player == nil {
			return
		}
		gs := p.GameState()
		b := blindInfo{
			tick:       gs.IngameTick(),
			real:       realPeriod(gs),
			playerKey:  playerKey(e.Player),
			playerName: e.Player.Name,
			playerSide: sideString(e.Player.Team),
			flashMs:    int(e.FlashDuration().Milliseconds()),
		}
		if e.Attacker != nil {
			b.attackerKey = playerKey(e.Attacker)
			b.attackerName = e.Attacker.Name
			b.attackerSide = sideString(e.Attacker.Team)
		}
		a.blind(b)
	})

	// ---- bomb ----

	p.RegisterEventHandler(func(e events.BombPlanted) {
		gs := p.GameState()
		key, name := uint64(0), ""
		if e.Player != nil {
			key = playerKey(e.Player)
			name = e.Player.Name
		}
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
	// rows; warmup attempts are stored like every other bomb row (only
	// the stats side gates on realPeriod).
	p.RegisterEventHandler(func(e events.BombPlantBegin) {
		gs := p.GameState()
		key, name := uint64(0), ""
		if e.Player != nil {
			key = playerKey(e.Player)
			name = e.Player.Name
		}
		a.bombPlantBegin(gs.IngameTick(), bombSite(e.Site), key, name)
	})

	p.RegisterEventHandler(func(e events.BombPlantAborted) {
		gs := p.GameState()
		key, name := uint64(0), ""
		if e.Player != nil {
			key = playerKey(e.Player)
			name = e.Player.Name
		}
		a.bombPlantAborted(gs.IngameTick(), key, name)
	})

	p.RegisterEventHandler(func(e events.BombDefuseStart) {
		gs := p.GameState()
		key, name, hasKit := uint64(0), "", false
		if e.Player != nil {
			key = playerKey(e.Player)
			name = e.Player.Name
			hasKit = e.Player.HasDefuseKit()
		}
		a.bombDefuseStart(gs.IngameTick(), bombSite(e.Site), key, name, hasKit)
	})

	p.RegisterEventHandler(func(e events.BombDefuseAborted) {
		gs := p.GameState()
		key, name := uint64(0), ""
		if e.Player != nil {
			key = playerKey(e.Player)
			name = e.Player.Name
		}
		a.bombDefuseAborted(gs.IngameTick(), key, name)
	})

	p.RegisterEventHandler(func(e events.BombDefused) {
		gs := p.GameState()
		key, name, hasKit := uint64(0), "", false
		if e.Player != nil {
			key = playerKey(e.Player)
			name = e.Player.Name
			hasKit = e.Player.HasDefuseKit()
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
		key, name := uint64(0), ""
		if e.Player != nil {
			key = playerKey(e.Player)
			name = e.Player.Name
		}
		// Evidence (dropped-C4 positions): the CARRIER's position at
		// this instant is the drop site — BombDropped fires when the C4
		// loses its owner (release time; death drops included — see the
		// CS2.md entry), so the pawn marks where it left their hands.
		// The bomb entity's own position rides along as corroborating
		// DetailJSON evidence when it has one (bombPos — free, same
		// zero-vector convention as posPtrs).
		var px, py, pz *float64
		if e.Player != nil {
			px, py, pz = posPtrs(e.Player.Position())
		}
		bx, by, bz := bombPos(gs)
		a.bombDropped(gs.IngameTick(), key, name, px, py, pz, bx, by, bz)
	})

	p.RegisterEventHandler(func(e events.BombPickup) {
		gs := p.GameState()
		key, name := uint64(0), ""
		if e.Player != nil {
			key = playerKey(e.Player)
			name = e.Player.Name
		}
		// Evidence: where the pickup happened — the bomb entity's
		// position, falling back to the pickup player's pawn when the
		// entity has no known location; DetailJSON `source` records
		// which one the columns carry.
		px, py, pz := bombPos(gs)
		source := "bomb"
		if px == nil {
			source = "player"
			if e.Player != nil {
				px, py, pz = posPtrs(e.Player.Position())
			}
		}
		a.bombPickedUp(gs.IngameTick(), key, name, px, py, pz, source)
	})

	// ---- grenades ----

	p.RegisterEventHandler(func(e events.HeExplode) {
		a.grenadeBlast(blastFor(e.GrenadeEvent, "hegrenade_detonate", p))
	})

	p.RegisterEventHandler(func(e events.FlashExplode) {
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
		key, name := uint64(0), ""
		if e.Projectile.Thrower != nil {
			key = playerKey(e.Projectile.Thrower)
			name = e.Projectile.Thrower.Name
		}
		weapon := "Unknown"
		if e.Projectile.WeaponInstance != nil {
			weapon = e.Projectile.WeaponInstance.Type.String()
		}
		var px, py, pz *float64
		if e.Projectile.Entity != nil {
			px, py, pz = posPtrs(e.Projectile.Position())
		}
		a.grenadeThrown(p.GameState().IngameTick(), key, name, weapon, px, py, pz)
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

	p.RegisterEventHandler(func(e events.ChatMessage) {
		steam, name := "", ""
		if e.Sender != nil {
			steam = keyStr(playerKey(e.Sender))
			name = e.Sender.Name
		}
		a.chat(p.GameState().IngameTick(), steam, name, e.Text)
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
	if ge.Thrower != nil {
		g.throwerKey = playerKey(ge.Thrower)
		g.throwerName = ge.Thrower.Name
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
