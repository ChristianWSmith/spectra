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
		gs := p.GameState()
		ct, t := 0, 0
		if s := gs.TeamCounterTerrorists(); s != nil {
			ct = s.Score()
		}
		if s := gs.TeamTerrorists(); s != nil {
			t = s.Score()
		}
		a.halfEnd(ct, t)
	})

	p.RegisterEventHandler(func(events.TeamSideSwitch) {
		a.sideSwitch()
	})

	// ---- round state machine ----

	p.RegisterEventHandler(func(e events.RoundStart) {
		gs := p.GameState()
		a.roundStart(gs.IngameTick(), gs.IsWarmupPeriod(), e.TimeLimit, e.Objective)
	})

	p.RegisterEventHandler(func(e events.RoundFreezetimeChanged) {
		if e.NewIsFreezetime {
			return
		}
		gs := p.GameState()
		equipCT, equipT := 0, 0
		if ct := gs.TeamCounterTerrorists(); ct != nil {
			equipCT = ct.FreezeTimeEndEquipmentValue()
		}
		if t := gs.TeamTerrorists(); t != nil {
			equipT = t.FreezeTimeEndEquipmentValue()
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
			})
		}
		a.freezeEnd(gs.IngameTick(), equipCT, equipT, samples, gs.IsWarmupPeriod())
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
			warmup:        gs.IsWarmupPeriod(),
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
		}
		if e.Victim != nil {
			k.victimKey = playerKey(e.Victim)
			k.victimName = e.Victim.Name
			k.victimSide = sideString(e.Victim.Team)
			k.samePlayer = e.Killer != nil && e.Killer.EntityID == e.Victim.EntityID
		}
		if e.Assister != nil {
			k.assisterKey = playerKey(e.Assister)
			k.assisterName = e.Assister.Name
		}
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
			warmup:            gs.IsWarmupPeriod(),
			weapon:            wn,
			healthDamage:      e.HealthDamage,
			healthDamageTaken: e.HealthDamageTaken,
			health:            e.Health,
			hitgroup:          hitGroupName(e.HitGroup),
		}
		if e.Weapon != nil {
			switch e.Weapon.Type {
			case common.EqHE, common.EqMolotov, common.EqIncendiary, common.EqDecoy, common.EqSmoke, common.EqFlash:
				h.isUtility = true
			}
		}
		if e.Attacker != nil {
			h.attackerKey = playerKey(e.Attacker)
			h.attackerName = e.Attacker.Name
		}
		if e.Player != nil {
			h.victimKey = playerKey(e.Player)
			h.victimName = e.Player.Name
		}
		a.hurt(h)
	})

	p.RegisterEventHandler(func(e events.WeaponFire) {
		gs := p.GameState()
		if e.Shooter == nil || gs.IsWarmupPeriod() {
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
			warmup:     gs.IsWarmupPeriod(),
			playerKey:  playerKey(e.Player),
			playerName: e.Player.Name,
			flashMs:    int(e.FlashDuration().Milliseconds()),
		}
		if e.Attacker != nil {
			b.attackerKey = playerKey(e.Attacker)
			b.attackerName = e.Attacker.Name
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
		a.bombPlanted(gs.IngameTick(), bombSite(e.Site), key, name)
	})

	p.RegisterEventHandler(func(e events.BombDefused) {
		gs := p.GameState()
		key, name, hasKit := uint64(0), "", false
		if e.Player != nil {
			key = playerKey(e.Player)
			name = e.Player.Name
			hasKit = e.Player.HasDefuseKit()
		}
		a.bombDefused(gs.IngameTick(), bombSite(e.Site), key, name, hasKit)
	})

	p.RegisterEventHandler(func(e events.BombExplode) {
		a.bombExploded(p.GameState().IngameTick(), bombSite(e.Site))
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
		a.grenadeBlast(blastFor(e.GrenadeEvent, "hegrenade_detonate", p, false))
	})

	p.RegisterEventHandler(func(e events.FlashExplode) {
		a.grenadeBlast(blastFor(e.GrenadeEvent, "flashbang_detonate", p, true))
	})

	p.RegisterEventHandler(func(e events.SmokeStart) {
		a.grenadeBlast(blastFor(e.GrenadeEvent, "smokegrenade_detonate", p, false))
	})

	p.RegisterEventHandler(func(e events.FireGrenadeStart) {
		a.grenadeBlast(blastFor(e.GrenadeEvent, "inferno_startburn", p, false))
	})

	p.RegisterEventHandler(func(e events.DecoyStart) {
		a.grenadeBlast(blastFor(e.GrenadeEvent, "decoy_started", p, false))
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
		a.grenadeThrown(p.GameState().IngameTick(), key, name, weapon)
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

// blastFor converts a grenade detonation event into blastInfo. isFlash marks
// flashbang detonations (they attribute pops to the thrower).
func blastFor(ge events.GrenadeEvent, source string, p *demoinfocs.Parser, isFlash bool) blastInfo {
	g := blastInfo{
		tick:   p.GameState().IngameTick(),
		weapon: ge.GrenadeType.String(),
		source: source,
		x:      ge.Position.X,
		y:      ge.Position.Y,
		z:      ge.Position.Z,
	}
	g.isFlash = isFlash
	if ge.Thrower != nil {
		g.throwerKey = playerKey(ge.Thrower)
		g.throwerName = ge.Thrower.Name
	}
	return g
}
