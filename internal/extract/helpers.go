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
// RoundEndReason has no String()).
func roundEndReasonName(r events.RoundEndReason) string {
	switch r {
	case events.RoundEndReasonStillInProgress:
		return "StillInProgress"
	case events.RoundEndReasonTargetBombed:
		return "TargetBombed"
	case events.RoundEndReasonVIPEscaped:
		return "VIPEscaped"
	case events.RoundEndReasonVIPKilled:
		return "VIPKilled"
	case events.RoundEndReasonTerroristsEscaped:
		return "TerroristsEscaped"
	case events.RoundEndReasonCTStoppedEscape:
		return "CTStoppedEscape"
	case events.RoundEndReasonTerroristsStopped:
		return "TerroristsStopped"
	case events.RoundEndReasonBombDefused:
		return "BombDefused"
	case events.RoundEndReasonCTWin:
		return "CTWin"
	case events.RoundEndReasonTerroristsWin:
		return "TerroristsWin"
	case events.RoundEndReasonDraw:
		return "Draw"
	case events.RoundEndReasonHostagesRescued:
		return "HostagesRescued"
	case events.RoundEndReasonTargetSaved:
		return "TargetSaved"
	case events.RoundEndReasonHostagesNotRescued:
		return "HostagesNotRescued"
	case events.RoundEndReasonTerroristsNotEscaped:
		return "TerroristsNotEscaped"
	case events.RoundEndReasonVIPNotEscaped:
		return "VIPNotEscaped"
	case events.RoundEndReasonGameStart:
		return "GameStart"
	case events.RoundEndReasonTerroristsSurrender:
		return "TerroristsSurrender"
	case events.RoundEndReasonCTSurrender:
		return "CTSurrender"
	case events.RoundEndReasonTerroristsPlanted:
		return "TerroristsPlanted"
	case events.RoundEndReasonCTsReachedHostage:
		return "CTsReachedHostage"
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
