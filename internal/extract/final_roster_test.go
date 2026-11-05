package extract

import (
	"testing"

	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/common"
)

// TestFinalRoster pins the end-of-demo roster selection: CT/T participants
// are kept WHETHER OR NOT they are still connected (post-match leavers are
// the common case — see the finalRoster doc comment), while spectators,
// unassigned participants (GOTV's own DemoRecorder) and nil entries are
// dropped.
func TestFinalRoster(t *testing.T) {
	connectedCT := &common.Player{Name: "a", Team: common.TeamCounterTerrorists, IsConnected: true}
	leftT := &common.Player{Name: "b", Team: common.TeamTerrorists, IsConnected: false}
	recorder := &common.Player{Name: "DemoRecorder", Team: common.TeamUnassigned, IsConnected: true}
	spectator := &common.Player{Name: "cast", Team: common.TeamSpectators, IsConnected: true}

	got := finalRoster([]*common.Player{nil, connectedCT, leftT, recorder, spectator})
	if len(got) != 2 || got[0] != connectedCT || got[1] != leftT {
		t.Fatalf("finalRoster = %+v, want the two team players (connected and not)", got)
	}

	if got := finalRoster(nil); len(got) != 0 {
		t.Fatalf("finalRoster(nil) = %+v, want empty", got)
	}
}
