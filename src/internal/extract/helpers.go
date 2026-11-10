package extract

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"

	"github.com/golang/geo/r3"
	demoinfocs "github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs"
	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/common"
	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/events"
	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/msg"
)

// sideString maps a game team onto the models side vocabulary. Models use
// lowercase "ct"/"t"; spectators and unassigned map to "".
func sideString(t common.Team) string {
	switch t {
	case common.TeamCounterTerrorists:
		return "ct"
	case common.TeamTerrorists:
		return "t"
	default:
		return ""
	}
}

// sameSide reports whether two observed sides are both known and equal
// (an unknown side never matches — permissive attribution for bots /
// unassigned players).
func sameSide(a, b string) bool { return a != "" && a == b }

// finalRoster selects the end-of-demo roster rows that applyFinal folds
// into the accumulators: every participant whose final team state is CT or
// T, including players who disconnected before the demo's last tick.
//
// Participants().Playing() must NOT be used for the snapshot: it iterates
// ByUserID(), which requires IsConnected, so it silently drops every player
// who left the server between the last round and the end of the demo
// stream. That window is routinely non-empty — the golden demo's GOTV tail
// runs ~300 ticks past match point and 7 of its 10 players disconnect
// inside it (ticks 136598..136885 vs the final tick 136896), even though
// their player controller entities and every property applyFinal reads
// (name, side, score, ping, money, crosshair) are still intact. The CT/T
// filter is what made Playing() safe for this snapshot: it drops GOTV's
// own DemoRecorder participant (no team, SteamID 0) and any spectator, and
// a player whose team state is gone is genuinely absent from the snapshot
// (its rows keep their event-derived provenance).
func finalRoster(participants []*common.Player) []*common.Player {
	roster := make([]*common.Player, 0, len(participants))
	for _, pl := range participants {
		if pl == nil {
			continue
		}
		if pl.Team != common.TeamCounterTerrorists && pl.Team != common.TeamTerrorists {
			continue
		}
		roster = append(roster, pl)
	}
	return roster
}

// teammateColor reads one participant's CS2 teammate color — the raw
// int of the player controller property m_iCompTeammateColor (CS2.md
// "Player scoreboard/radar colors"): 0 blue, 1 green, 2 yellow, 3 orange,
// 4 purple, -1 none/GOTV. The value is read RAW: demoinfocs'
// common.Color enum names mislabel CS2 colors (it says 0=Yellow — that is
// the CS:GO ordering), so only the int is ever carried.
//
// Missing entity (a participant whose controller is gone) or a missing /
// unexpected property type yields -1 ("no color") — never a guessed value.
func teammateColor(pl *common.Player) int {
	const noColor = -1
	if pl == nil || pl.Entity == nil {
		return noColor
	}
	v, ok := pl.Entity.PropertyValue("m_iCompTeammateColor")
	if !ok {
		return noColor
	}
	switch n := v.Any.(type) {
	case int32:
		return int(n)
	case int64:
		return int(n)
	case int:
		return n
	case uint32:
		return int(n)
	case uint64:
		return int(n)
	default:
		return noColor
	}
}

// realPeriod reports whether stats-eligible (real) play is underway: the
// match has started, warmup is over, and the game phase has advanced past
// Pregame. IsWarmupPeriod() alone misses two polluters observed in real
// demos:
//
//   - pre-match (knife) rounds: warmup=false, IsMatchStarted()=true,
//     GamePhase()==Pregame — the scoreboard resets to 0-0 afterwards and
//     the game's own counters exclude them (golden demo round 1);
//   - post-match cooldown kills: IsMatchStarted() flips back to false
//     after the final round (golden demo's trailing World suicides).
func realPeriod(gs *demoinfocs.GameState) bool {
	return gs != nil && gs.IsMatchStarted() && !gs.IsWarmupPeriod() &&
		gs.GamePhase() >= common.GamePhaseStartGamePhase
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

// roundEndReasonName is the v6 port's hand-written reason map (v6's
// RoundEndReason has no String()). It renders HUMAN-READABLE names — this
// string is what the Rounds table's Reason column and the round detail
// summary show ("Bomb defused", "Elimination"), not the enum identifier.
// The raw game-event payload (raw_json) still carries the original value.
func roundEndReasonName(r events.RoundEndReason) string {
	switch r {
	case events.RoundEndReasonStillInProgress:
		return "In progress"
	case events.RoundEndReasonTargetBombed:
		return "Bomb exploded"
	case events.RoundEndReasonVIPEscaped:
		return "VIP escaped"
	case events.RoundEndReasonVIPKilled:
		return "VIP killed"
	case events.RoundEndReasonTerroristsEscaped:
		return "Terrorists escaped"
	case events.RoundEndReasonCTStoppedEscape:
		return "Escape stopped"
	case events.RoundEndReasonTerroristsStopped:
		return "Terrorists stopped"
	case events.RoundEndReasonBombDefused:
		return "Bomb defused"
	case events.RoundEndReasonCTWin, events.RoundEndReasonTerroristsWin:
		// Round decided by eliminating the other team — the Winner column
		// already says WHICH team did it.
		return "Elimination"
	case events.RoundEndReasonDraw:
		return "Draw"
	case events.RoundEndReasonHostagesRescued:
		return "Hostages rescued"
	case events.RoundEndReasonTargetSaved:
		return "Time expired"
	case events.RoundEndReasonHostagesNotRescued:
		return "Hostages not rescued"
	case events.RoundEndReasonTerroristsNotEscaped:
		return "Terrorists did not escape"
	case events.RoundEndReasonVIPNotEscaped:
		return "VIP not escaped"
	case events.RoundEndReasonGameStart:
		return "Game start"
	case events.RoundEndReasonTerroristsSurrender:
		return "Terrorists surrendered"
	case events.RoundEndReasonCTSurrender:
		return "CTs surrendered"
	case events.RoundEndReasonTerroristsPlanted:
		return "Bomb planted"
	case events.RoundEndReasonCTsReachedHostage:
		return "CTs reached hostage"
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

func wepName(w *common.Equipment) string {
	if w == nil {
		return "Unknown"
	}
	return w.Type.String()
}

// defaultPistolFreeValue is what the game's equipment value assigns to a
// free spawn-issued default sidearm (USP-S/P2000 for CT, Glock-18 for T)
// that a player still holds at freeze time end: $200, although nobody paid
// for it (CS2.md "Free spawn-issued default pistol" — verified on the
// golden demo: a player with only a knife + default pistol reads
// equipFTEnd = 200).
const defaultPistolFreeValue = 200

// freeSpawnPistolValue sums the free spawn-issued default pistols in a
// player's freeze-time-end inventory at their equipment-value price.
// The per-side total (round_economy.free_pistol_value) is recorded for
// reference: these pistols are granted, not bought, and they count
// INSIDE equipment value, so the chart's net worth (equip + cash)
// includes them and can never fall below equipment value (CS2.md "Free
// spawn-issued default pistol").
//
// Caveat (same CS2.md entry): demo data cannot tell a spawn-issued
// default apart from a rebought ($200 buy-back) or picked-up one, so all
// held USP-S/P2000/Glock-18 count as free here.
func freeSpawnPistolValue(weapons []*common.Equipment) int {
	v := 0
	for _, w := range weapons {
		if w == nil {
			continue
		}
		switch w.Type {
		case common.EqUSP, common.EqP2000, common.EqGlock:
			v += defaultPistolFreeValue
		}
	}
	return v
}

// utilEquipmentTypes is extract's copy of the utility set: the equipment
// types whose PLAYER_HURT damage counts as utility damage (h.isUtility →
// the util_dmg column). The parser gate sees equipment TYPES, not the
// canonical names models.IsUtilityWeapon keys on (demoinfocs resolves the
// raw weapon string to a type first), so the two representations are pinned
// together by TestUtilityWeaponSetsIdentical — a grenade added here must be
// added to models.utilityWeaponKinds too.
var utilEquipmentTypes = []common.EquipmentType{
	common.EqHE, common.EqMolotov, common.EqIncendiary, common.EqDecoy, common.EqSmoke, common.EqFlash,
}

// isUtilityEquipment reports whether t is one of utilEquipmentTypes.
func isUtilityEquipment(t common.EquipmentType) bool {
	for _, u := range utilEquipmentTypes {
		if u == t {
			return true
		}
	}
	return false
}

// bombSite renders the raw site rune as "A"/"B"; anything else is "".
func bombSite(s events.Bombsite) string {
	switch s {
	case events.BombsiteA:
		return "A"
	case events.BombsiteB:
		return "B"
	default:
		return ""
	}
}

// playerKey returns the accumulator key for a participant: its SteamID64, or
// a synthetic 0xFF-prefixed key derived from the entity-ID for bots (which
// have no SteamID64). The 0xFF prefix cannot collide with a real SteamID64.
func playerKey(pl *common.Player) uint64 {
	if pl == nil {
		return 0
	}
	if pl.SteamID64 != 0 {
		return pl.SteamID64
	}
	return 0xFF00000000000000 | uint64(pl.EntityID&0x0FFFFFFF)
}

// isBotKey reports whether an accumulator key is the synthetic bot key.
func isBotKey(key uint64) bool {
	return key>>56 == 0xFF
}

// keyStr is the string form of an accumulator key ("" for none) — the
// SteamID64 join key used across models rows.
func keyStr(key uint64) string {
	if key == 0 {
		return ""
	}
	return strconv.FormatUint(key, 10)
}

// posPtrs converts a world position into the Event.Pos* triple. The zero
// vector means "no position available" (demoinfocs reports {0,0,0} when
// the pawn/entity backing the position is gone) — it yields nils so the
// store keeps the column NULL instead of stamping a bogus map-center point.
func posPtrs(v r3.Vector) (px, py, pz *float64) {
	if v.X == 0 && v.Y == 0 && v.Z == 0 {
		return nil, nil, nil
	}
	x, y, z := v.X, v.Y, v.Z
	return &x, &y, &z
}

// pos3 is posPtrs for plain coordinates (grenade blasts carry x/y/z
// already extracted from the event).
func pos3(x, y, z float64) (px, py, pz *float64) {
	if x == 0 && y == 0 && z == 0 {
		return nil, nil, nil
	}
	return &x, &y, &z
}

// bombPos reads the bomb entity's position at handler time (nils when the
// bomb has no known location yet — gs.Bomb() itself is never nil).
func bombPos(gs *demoinfocs.GameState) (px, py, pz *float64) {
	if gs == nil {
		return nil, nil, nil
	}
	return posPtrs(gs.Bomb().Position())
}

// livingTeammatePos returns the world positions of the victim's teammates
// who are still alive at this instant — the players who could have traded
// the killer. The victim and the killer are excluded (a player cannot
// trade himself; in a teamkill the killer IS a victim's teammate, so the
// exclusion matters there too). Teammates without a known position (the
// zero vector — same convention as posPtrs) are skipped rather than
// guessed. A victim with no known team yields nothing.
func livingTeammatePos(gs *demoinfocs.GameState, killer, victim *common.Player) []r3.Vector {
	if victim == nil {
		return nil
	}
	team := victim.Team
	if team != common.TeamCounterTerrorists && team != common.TeamTerrorists {
		return nil
	}
	if gs == nil {
		return nil
	}
	var out []r3.Vector
	for _, p := range gs.Participants().TeamMembers(team) {
		if p == nil || !p.IsAlive() {
			continue
		}
		if p == victim || (killer != nil && p == killer) {
			continue
		}
		pos := p.Position()
		if pos.X == 0 && pos.Y == 0 && pos.Z == 0 {
			continue
		}
		out = append(out, pos)
	}
	return out
}

// nearTeammateDist measures the trade-opportunity proximity of a death:
// the shortest distance from the KILLER's position to any of the victim's
// then-living teammates — how close someone was to actually trading the
// killer. The zero vector means "no position known" (the posPtrs
// convention), so an unknown killer position or teammates without
// positions yield -1: the sentinel store.GetCombatStats treats as "not
// countable" (see the TradeOppMissed gate). Rounded to one decimal — the
// value rides in the kill event's detail_json, which the Replay detail
// pane renders.
func nearTeammateDist(killer r3.Vector, mates []r3.Vector) float64 {
	if killer.X == 0 && killer.Y == 0 && killer.Z == 0 {
		return -1
	}
	best := -1.0
	for _, m := range mates {
		if m.X == 0 && m.Y == 0 && m.Z == 0 {
			continue
		}
		d := killer.Distance(m)
		if best < 0 || d < best {
			best = d
		}
	}
	if best < 0 {
		return -1
	}
	return math.Round(best*10) / 10
}

// pct is the percentage helper ported from the extractor (0 when b is 0).
func pct(a, b int) float64 {
	if b == 0 {
		return 0
	}
	return 100 * float64(a) / float64(b)
}

// detailJSON marshals a compact derived detail object. Values are plain
// strings/numbers/bools, so marshaling cannot fail in practice.
func detailJSON(v map[string]any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return "{}"
	}
	return string(b)
}

// gameEventPayloadJSON converts a decoded legacy game-event payload (the
// generic escape hatch every GenericGameEvent carries) into JSON without
// leaking any demoinfocs/protobuf type.
func gameEventPayloadJSON(data map[string]*msg.CMsgSource1LegacyGameEventKeyT) string {
	if len(data) == 0 {
		return "{}"
	}
	out := make(map[string]any, len(data))
	for k, v := range data {
		out[k] = gameEventValue(v)
	}
	b, err := json.Marshal(out)
	if err != nil {
		return "{}"
	}
	return string(b)
}

// gameEventValue unwraps the payload key's single populated field.
func gameEventValue(k *msg.CMsgSource1LegacyGameEventKeyT) any {
	if k == nil {
		return nil
	}
	if v := k.ValString; v != nil {
		return *v
	}
	if v := k.ValFloat; v != nil {
		f := float64(*v)
		if math.IsNaN(f) || math.IsInf(f, 0) {
			return 0
		}
		return f
	}
	if v := k.ValLong; v != nil {
		return *v
	}
	if v := k.ValShort; v != nil {
		return *v
	}
	if v := k.ValByte; v != nil {
		return *v
	}
	if v := k.ValBool; v != nil {
		return *v
	}
	if v := k.ValUint64; v != nil {
		return *v
	}
	return nil
}

// payloadBool reads one boolean field from a raw game-event payload (the
// JSON gameEventPayloadJSON produced). Fail soft: an unparseable payload or
// a missing/non-bool field reads false — a flag is never guessed. Used for
// player_death's `attackerinair` (see agg.pairRaw).
func payloadBool(payload, field string) bool {
	var m map[string]any
	if err := json.Unmarshal([]byte(payload), &m); err != nil {
		return false
	}
	b, _ := m[field].(bool)
	return b
}
