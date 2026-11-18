package extract

import (
	"github.com/golang/geo/r3"
	demoinfocs "github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs"
	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/common"
)

// This file owns the reconnect-takeover identity rule (CS2.md "Reconnect
// takeover — one life, two identities in the demo"; owner's report
// 2026-11-17): THE IDENTITY OF A LIFE IS THE CONTROLLING HUMAN, and the
// pawn a life reads through while a human controls a substitute bot is
// the BOT's pawn. demoinfocs splits one life across two *Player objects
// with two event-resolution domains (userid-keyed events name the
// reconnecting human, pawn-keyed ones name the bot) and the human
// controller keeps its own dead m_hPlayerPawn, so reads through it return
// the pre-disconnect corpse. Every consumer of an event's Player routes
// through this rule; identity-transition rows (connect/disconnect) and
// rank updates deliberately do not — they record which object appeared or
// left, not whose life was lived.

// demoinfocsControls is the production takeover read: the bot a
// CONNECTED participant's controller currently controls
// (m_bControllingBot + m_hOriginalControllerOfCurrentPawn →
// FindPlayerByHandle), nil otherwise. The IsConnected gate is load-
// bearing: a disconnected controller can keep its props (the repro's
// bvcket disconnects at 91080 while still flagged controlling, and the
// bot plays on alone until 91334) — without the gate every bot event in
// that window would remap to a player who is not in the game.
func demoinfocsControls(c *common.Player) *common.Player {
	if c == nil || !c.IsConnected || !c.IsControllingBot() {
		return nil
	}
	return c.ControlledBot()
}

// pairIdentity is THE takeover pairing rule — the pure core
// activeIdentity delegates to, with the control read injected so plain
// fake players can pin it (demoinfocs' entity-backed reads are nil-safe
// zeros on a literal *common.Player, and real entities cannot be
// constructed outside demoinfocs' internal stfake):
//
//   - a participant that controls a bot → identity stays the participant
//     (the human), pawn becomes the bot: every pawn-carried read (alive,
//     position, inventory, kit, buttons) follows the controlled pawn;
//   - a bot under a connected human's control → identity becomes the
//     human, pawn stays the bot: the event's row belongs to the human's
//     life (the bot's steamId-0 key could not be stored anyway);
//   - anything else → (pl, pl), byte-identical to pre-takeover behavior.
func pairIdentity(pl *common.Player, controls func(*common.Player) *common.Player, all []*common.Player) (identity, pawn *common.Player) {
	if pl == nil {
		return nil, nil
	}
	if bot := controls(pl); bot != nil && bot != pl {
		return pl, bot
	}
	if pl.IsBot {
		for _, c := range all {
			if c == nil || c == pl {
				continue
			}
			if controls(c) == pl {
				return c, pl
			}
		}
	}
	return pl, pl
}

// remap applies pairIdentity to one event's participant reads. Production
// builds it from the live parser (newRemap); tests build it with
// injected reads (see pairIdentity).
type remap struct {
	controls func(*common.Player) *common.Player
	all      []*common.Player
	posOf    func(*common.Player) r3.Vector
}

// newRemap builds the production remap for one event: the live takeover
// reads, the full participant list (a disconnected controller is still a
// candidate — demoinfocsControls decides), and pawn position read through
// demoinfocs.
func newRemap(gs *demoinfocs.GameState) *remap {
	var all []*common.Player
	if gs != nil {
		all = gs.Participants().All()
	}
	return &remap{controls: demoinfocsControls, all: all, posOf: (*common.Player).Position}
}

// pair resolves one participant onto the takeover rule.
func (r *remap) pair(pl *common.Player) (identity, pawn *common.Player) {
	return pairIdentity(pl, r.controls, r.all)
}

// pos reads a resolved participant's world position through the remap's
// position source — always the PAWN of a takeover pair, so a death,
// pickup or drop lands where the life actually stood (the owner's repro
// showed the stale pre-disconnect corpse position for a takeover death
// that the paired bomb_drop evidence placed ~1800 units away).
func (r *remap) pos(pawn *common.Player) r3.Vector {
	return r.posOf(pawn)
}

// participantRow resolves one event participant onto the takeover rule and
// returns the row identity — accumulator key, name, side — plus its
// position read through the resolved pawn. THE one spelling for event
// rows whose identity and position ride together (bomb carrier, item
// pickup, hurt victim, flashed player, thrower): identity from the
// controlling human, position from the controlled bot.
func participantRow(pl *common.Player, r *remap) (key uint64, name, side string, pos r3.Vector) {
	if pl == nil {
		return 0, "", "", r3.Vector{}
	}
	identity, pawn := r.pair(pl)
	return playerKey(identity), identity.Name, sideString(identity.Team), r.pos(pawn)
}

// identityTarget is one per-frame sink sample: the identity the row is
// keyed under and the participant whose pawn the reads run through.
type identityTarget struct {
	identity *common.Player
	pawn     *common.Player
}

// appendTargets is THE per-frame sink routing (position, state,
// held-utility): every playing participant yields exactly one target
// EXCEPT a bot currently covered by a connected human — its life is
// emitted through the human's own entry (human identity + bot pawn), so
// the bot never doubles the sample (and its steamId-0 key could not be
// stored by the sidecar anyway). dst is appended into and returned (the
// sinks reuse one buffer across frames); nil dst starts fresh (tests).
func appendTargets(dst []identityTarget, all []*common.Player, controls func(*common.Player) *common.Player) []identityTarget {
	for _, pl := range all {
		if pl == nil {
			continue
		}
		identity, pawn := pairIdentity(pl, controls, all)
		if identity != pl {
			continue // covered by the controlling human's own entry
		}
		dst = append(dst, identityTarget{identity: identity, pawn: pawn})
	}
	return dst
}

// pawnAlive is positionRow's liveness gate — a package var so the
// takeover keying can be pinned with fake players (a nil-entity fake can
// only report dead; takeover_test.go swaps it under t.Cleanup, production
// never does).
var pawnAlive = (*common.Player).IsAlive

// positionRow builds one PositionSink row from a target: alive /
// position / yaw / air / duck read through the PAWN (during a takeover
// the human's own pawn is the stale pre-disconnect corpse — reading it
// produced the repro's 1840/1840-frame blackout), the key and side from
// the IDENTITY (extract.playerKey — the controlling human's SteamID64
// post-takeover; a lone/covering bot's synthetic 0xFF key before it, so
// the bot's marker tracks it from ITS connect instead of popping in at
// the takeover — owner report 2026-11-17). false = no row this frame
// (dead — the position stream only carries alive players).
func positionRow(t identityTarget) (PositionPlayer, bool) {
	if !pawnAlive(t.pawn) {
		return PositionPlayer{}, false
	}
	pos := t.pawn.Position()
	// ViewDirectionX is yaw (0..360); normalize to the -180..180 range
	// the sidecar codec expects. (ViewDirectionY is pitch — feeding it
	// here drew garbage view cones.)
	yaw := t.pawn.ViewDirectionX()
	if yaw > 180 {
		yaw -= 360
	}
	return PositionPlayer{
		SteamID: playerKey(t.identity),
		X:       float32(pos.X),
		Y:       float32(pos.Y),
		Z:       float32(pos.Z),
		Yaw:     yaw,
		Air:     t.pawn.IsAirborne(),
		Duck:    t.pawn.IsDucking(),
		Side:    sideString(t.identity.Team),
	}, true
}
