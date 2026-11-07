package extract

import (
	"context"
	"fmt"
	"io"
	"os"
	"testing"

	"github.com/klauspost/compress/zstd"
	demoinfocs "github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs"
	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/events"
)

// TestDiagBombEvidence re-parses the golden demo with its own handlers
// (no extract state) and dumps the bomb-drop/pickup evidence facts the
// CS2.md entry pins: whether death-drops dispatch BombDropped, whether
// the carrier is alive/what health it has at the event (release-time
// evidence), how far the bomb entity is from the carrier and from its
// resting place when the event fires (release vs landing), and which
// position source bomb_pickup exposes. Run with:
//
//	SPECTRA_DIAG=1 go test ./internal/extract -run TestDiagBombEvidence -v
type bombDropRec struct {
	tick      int
	name      string
	alive     bool
	health    int
	deathNear bool // a player_death for the same player within ±3 ticks
	hasP      bool
	px, py    float64 // carrier position at the event
	hasB      bool
	bx, by    float64 // bomb entity position at the event
	landTick  int     // frames until the bomb entity came to rest (−1 = not observed)
	landed    bool
}

func TestDiagBombEvidence(t *testing.T) {
	if os.Getenv("SPECTRA_DIAG") == "" {
		t.Skip("set SPECTRA_DIAG=1")
	}
	path := "../../golden/de_cache.dem.zst"
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer f.Close()
	magic := make([]byte, 4)
	if _, err := io.ReadFull(f, magic); err != nil {
		t.Fatal(err)
	}
	src := io.MultiReader(magicReader(magic), f)
	r := src
	if magic[0] == 0x28 && magic[1] == 0xb5 && magic[2] == 0x2f && magic[3] == 0xfd {
		dec, err := zstd.NewReader(src)
		if err != nil {
			t.Fatal(err)
		}
		defer dec.Close()
		r = dec
	}

	p := demoinfocs.NewParser(r)
	defer func() { _ = p.Close() }()

	type pickRec struct {
		tick   int
		name   string
		hasB   bool
		bx, by float64 // bomb entity position at the event
		hasP   bool
		px, py float64 // pickup player position at the event
	}
	var drops []*bombDropRec
	var picks []*pickRec
	deaths := map[string][]int{}
	cur := (*bombDropRec)(nil)

	zero := func(x, y float64) bool { return x == 0 && y == 0 }

	p.RegisterEventHandler(func(e events.Kill) {
		if e.Victim != nil {
			tick := p.GameState().IngameTick()
			deaths[e.Victim.Name] = append(deaths[e.Victim.Name], tick)
		}
	})
	p.RegisterEventHandler(func(e events.BombDropped) {
		gs := p.GameState()
		tick := gs.IngameTick()
		d := &bombDropRec{tick: tick, landTick: -1}
		if e.Player != nil {
			d.name = e.Player.Name
			d.alive = e.Player.IsAlive()
			d.health = e.Player.Health()
			if v := e.Player.Position(); !zero(v.X, v.Y) {
				d.px, d.py, d.hasP = v.X, v.Y, true
			}
		}
		if v := gs.Bomb().Position(); !zero(v.X, v.Y) {
			d.bx, d.by, d.hasB = v.X, v.Y, true
		}
		for _, dt := range deaths[d.name] {
			if dt >= tick-3 && dt <= tick+3 {
				d.deathNear = true
			}
		}
		drops = append(drops, d)
		cur = d
	})
	p.RegisterEventHandler(func(e events.BombPickup) {
		gs := p.GameState()
		pr := &pickRec{tick: gs.IngameTick()}
		if e.Player != nil {
			pr.name = e.Player.Name
			if v := e.Player.Position(); !zero(v.X, v.Y) {
				pr.px, pr.py, pr.hasP = v.X, v.Y, true
			}
		}
		if v := gs.Bomb().Position(); !zero(v.X, v.Y) {
			pr.bx, pr.by, pr.hasB = v.X, v.Y, true
		}
		picks = append(picks, pr)
	})

	// Rest detection: once the bomb entity holds still for two consecutive
	// frames after the drop, it has landed (or was already at rest).
	prevX, prevY, still := 0.0, 0.0, 0
	p.RegisterEventHandler(func(events.FrameDone) {
		if cur == nil || cur.landed {
			return
		}
		gs := p.GameState()
		if gs.IngameTick()-cur.tick > 128 {
			return // capped: a fast pickup keeps the bomb moving
		}
		v := gs.Bomb().Position()
		if zero(v.X, v.Y) {
			return
		}
		if v.X == prevX && v.Y == prevY {
			still++
			if still >= 2 {
				cur.landTick = gs.IngameTick() - cur.tick
				cur.landed = true
			}
		} else {
			still = 0
		}
		prevX, prevY = v.X, v.Y
	})

	if err := p.ParseToEnd(context.Background()); err != nil && err != demoinfocs.ErrUnexpectedEndOfDemo {
		t.Fatalf("parse: %v", err)
	}

	deathDrops, aliveDrops := 0, 0
	landSum, landN, landMax := 0, 0, 0
	unlanded := 0
	distinctCarriers := map[string]bool{}
	for _, d := range drops {
		if d.deathNear {
			deathDrops++
		}
		if d.alive {
			aliveDrops++
		}
		distinctCarriers[d.name] = true
		if d.landed {
			landSum += d.landTick
			landN++
			if d.landTick > landMax {
				landMax = d.landTick
			}
		} else {
			unlanded++
		}
	}
	pickBombPos, pickPlayerPos, pickBoth := 0, 0, 0
	for _, pr := range picks {
		if pr.hasB {
			pickBombPos++
		}
		if pr.hasP {
			pickPlayerPos++
		}
		if pr.hasB && pr.hasP {
			pickBoth++
		}
	}

	fmt.Println("== bomb drop evidence ==")
	fmt.Printf("drops=%d distinctCarriers=%d deathNear=%d aliveAtEvent=%d hasCarrierPos=%d hasBombPosAtEvent=%d\n",
		len(drops), len(distinctCarriers), deathDrops, aliveDrops,
		countPos(drops, func(d *bombDropRec) bool { return d.hasP }),
		countPos(drops, func(d *bombDropRec) bool { return d.hasB }))
	if landN > 0 {
		fmt.Printf("bomb at rest after drop: observed=%d mean=%d ticks max=%d ticks unobserved(capped/no-move-sample)=%d\n",
			landN, landSum/landN, landMax, unlanded)
	}
	// Carrier vs bomb entity distance at the event (release evidence).
	near := 0
	for _, d := range drops {
		if d.hasP && d.hasB {
			dx, dy := d.px-d.bx, d.py-d.by
			if dx*dx+dy*dy < 64*64 {
				near++
			}
		}
	}
	fmt.Printf("drops with both positions: %d, of those carrier within 64u of bomb entity: %d\n",
		countBoth(drops), near)
	fmt.Println("-- sample (first 12) --")
	for i, d := range drops {
		if i >= 12 {
			break
		}
		fmt.Printf("  tick=%d carrier=%q alive=%v health=%d deathNear=%v carrierPos=(%.0f,%.0f)?%v bombPos=(%.0f,%.0f)?%v land=%d\n",
			d.tick, d.name, d.alive, d.health, d.deathNear, d.px, d.py, d.hasP, d.bx, d.by, d.hasB, d.landTick)
	}

	fmt.Println("== bomb pickup evidence ==")
	fmt.Printf("pickups=%d bombEntityPos=%d playerPos=%d both=%d\n", len(picks), pickBombPos, pickPlayerPos, pickBoth)
	for i, pr := range picks {
		if i >= 8 {
			break
		}
		fmt.Printf("  tick=%d player=%q bombPos=(%.0f,%.0f)?%v playerPos=(%.0f,%.0f)?%v\n",
			pr.tick, pr.name, pr.bx, pr.by, pr.hasB, pr.px, pr.py, pr.hasP)
	}
}

func countPos(drops []*bombDropRec, f func(*bombDropRec) bool) int {
	n := 0
	for _, d := range drops {
		if f(d) {
			n++
		}
	}
	return n
}

func countBoth(drops []*bombDropRec) int {
	return countPos(drops, func(d *bombDropRec) bool { return d.hasP && d.hasB })
}
