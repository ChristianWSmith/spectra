package extract

import (
	demoinfocs "github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs"
	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/common"
	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/events"
	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/msg"
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
		key, name := uint64(0), ""
		if e.Player != nil {
			key = playerKey(e.Player)
			name = e.Player.Name
		}
		a.bombDropped(p.GameState().IngameTick(), key, name)
	})

	p.RegisterEventHandler(func(e events.BombPickup) {
		key, name := uint64(0), ""
		if e.Player != nil {
			key = playerKey(e.Player)
			name = e.Player.Name
		}
		a.bombPickedUp(p.GameState().IngameTick(), key, name)
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
		a.grenadeBlast(blastFor(e.GrenadeEvent, "decoy_started", p))
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
