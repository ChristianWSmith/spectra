package extract

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/klauspost/compress/zstd"
	demoinfocs "github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs"
	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/events"
)

// TestDiagPlantDefuseSequences is the characterization run behind the
// plant/defuse lifecycle verdict: it re-parses the golden demo(s) with
// only the demoinfocs mimic-event handlers registered and sequences, per
// plant/defuse attempt,
//
//	BombPlantBegin → (BombPlantAborted | BombPlanted)
//	BombDefuseStart → (BombDefuseAborted | BombDefused)
//
// counting completions that also emit an abort and aborts with no
// preceding begin. Run with:
//
//	SPECTRA_DIAG=1 go test ./internal/extract -run TestDiagPlantDefuseSequences -v
//
// Set SPECTRA_DIAG_ALL=1 to walk every demo in golden/ instead of just
// de_cache (slower, stronger evidence).
type pdEntry struct {
	tick   int
	family string // "plant" | "defuse"
	kind   string // "begin" | "abort" | "complete"
	player string
	site   string
}

type pdAttempt struct {
	player   string
	begin    int // -1 when the attempt has no begin (orphan)
	end      int
	closedBy string // "abort" | "complete" | "" (open at demo end)
	aborted  bool   // an abort was seen inside this attempt
	complete bool   // a completion was seen inside this attempt
	after    []string
}

func TestDiagPlantDefuseSequences(t *testing.T) {
	if os.Getenv("SPECTRA_DIAG") == "" {
		t.Skip("set SPECTRA_DIAG=1")
	}
	paths := []string{"../../../golden/de_cache.dem.zst"}
	if os.Getenv("SPECTRA_DIAG_ALL") != "" {
		matches, err := filepath.Glob("../../../golden/*.dem.zst")
		if err != nil || len(matches) == 0 {
			t.Fatalf("glob golden demos: %v", err)
		}
		paths = matches
	}
	for _, path := range paths {
		t.Run(filepath.Base(path), func(t *testing.T) {
			diagPlantDefuse(t, path)
		})
	}
}

func diagPlantDefuse(t *testing.T, path string) {
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

	var seq []pdEntry
	add := func(family, kind, player, site string) {
		seq = append(seq, pdEntry{
			tick: p.GameState().IngameTick(), family: family, kind: kind, player: player, site: site,
		})
	}
	p.RegisterEventHandler(func(e events.BombPlantBegin) {
		n := ""
		if e.Player != nil {
			n = e.Player.Name
		}
		add("plant", "begin", n, bombsiteStr(e.Site))
	})
	p.RegisterEventHandler(func(e events.BombPlantAborted) {
		n := ""
		if e.Player != nil {
			n = e.Player.Name
		}
		add("plant", "abort", n, "")
	})
	p.RegisterEventHandler(func(e events.BombPlanted) {
		n := ""
		if e.Player != nil {
			n = e.Player.Name
		}
		add("plant", "complete", n, bombsiteStr(e.Site))
	})
	p.RegisterEventHandler(func(e events.BombDefuseStart) {
		n := ""
		if e.Player != nil {
			n = e.Player.Name
		}
		add("defuse", "begin", n, bombsiteStr(e.Site))
	})
	p.RegisterEventHandler(func(e events.BombDefuseAborted) {
		n := ""
		if e.Player != nil {
			n = e.Player.Name
		}
		add("defuse", "abort", n, "")
	})
	p.RegisterEventHandler(func(e events.BombDefused) {
		n := ""
		if e.Player != nil {
			n = e.Player.Name
		}
		add("defuse", "complete", n, bombsiteStr(e.Site))
	})

	// Raw source-1 game events (spectra's generic handler stores these) —
	// confirms which raw bomb_* names exist alongside the mimic dispatches.
	rawCounts := map[string]int{}
	p.RegisterEventHandler(func(e events.GenericGameEvent) {
		if strings.HasPrefix(e.Name, "bomb_") {
			rawCounts[e.Name]++
		}
	})

	// Interrupt evidence for the CS2.md cancel-rules entry: every damage
	// tick and flash tick per player, so each abort can be reported
	// WITH (or without) a damage/flash hit on the actor.
	type hitRec struct {
		tick int
		via  string // "damage" | "flash"
	}
	hits := map[string][]hitRec{}
	p.RegisterEventHandler(func(e events.PlayerHurt) {
		if e.Player == nil {
			return
		}
		hits[e.Player.Name] = append(hits[e.Player.Name], hitRec{tick: p.GameState().IngameTick(), via: "damage"})
	})
	p.RegisterEventHandler(func(e events.PlayerFlashed) {
		if e.Player == nil {
			return
		}
		hits[e.Player.Name] = append(hits[e.Player.Name], hitRec{tick: p.GameState().IngameTick(), via: "flash"})
	})

	if err := p.ParseToEnd(context.Background()); err != nil && err != demoinfocs.ErrUnexpectedEndOfDemo {
		t.Fatalf("parse: %v", err)
	}

	// Fold the flat sequence into per-family attempts. A begin closes any
	// still-open attempt of the same family (property flicker); an
	// abort/complete closes the currently open attempt of its family.
	folds := func(entries []pdEntry) []pdAttempt {
		var out []pdAttempt
		open := -1
		for _, e := range entries {
			switch e.kind {
			case "begin":
				if open >= 0 && out[open].closedBy == "" {
					// begin while the previous attempt never closed: leave
					// it open-tagged as "unclosed" so the count shows it.
					out[open].closedBy = "unclosed"
				}
				out = append(out, pdAttempt{player: e.player, begin: e.tick})
				open = len(out) - 1
			case "abort":
				if open < 0 || out[open].closedBy != "" {
					// abort with no open attempt (missing begin, or a
					// second abort after the attempt already closed).
					out = append(out, pdAttempt{player: e.player, begin: -1, closedBy: "orphan-abort"})
					open = -1
					continue
				}
				out[open].aborted = true
				out[open].end = e.tick
				out[open].closedBy = "abort"
			case "complete":
				if open < 0 {
					out = append(out, pdAttempt{player: e.player, begin: -1, complete: true, closedBy: "complete-no-begin"})
					continue
				}
				out[open].complete = true
				out[open].end = e.tick
				if out[open].closedBy == "" {
					out[open].closedBy = "complete"
				} else {
					// completion observed after the attempt was already
					// closed (abort-then-complete in the same attempt).
					out[open].after = append(out[open].after, fmt.Sprintf("complete@%d", e.tick))
				}
			}
		}
		return out
	}
	var plants, defuses []pdAttempt
	{
		var pp, dd []pdEntry
		for _, e := range seq {
			if e.family == "plant" {
				pp = append(pp, e)
			} else {
				dd = append(dd, e)
			}
		}
		plants, defuses = folds(pp), folds(dd)
	}

	report := func(label string, attempts []pdAttempt) {
		complete, aborted, unclosed, orphan, noBegin := 0, 0, 0, 0, 0
		both, abortThenComplete := 0, 0
		abortWithHit, abortWithoutHit := 0, 0
		completeWithHit := 0
		var deltas []int
		for i := range attempts {
			at := &attempts[i]
			switch {
			case at.begin < 0 && at.closedBy == "complete-no-begin":
				noBegin++
			case at.begin < 0:
				orphan++
			case at.closedBy == "complete":
				complete++
				deltas = append(deltas, at.end-at.begin)
			case at.closedBy == "abort":
				aborted++
				if len(at.after) > 0 {
					abortThenComplete++
				}
			default:
				unclosed++
			}
			if at.complete && at.aborted {
				both++
			}
		}
		fmt.Printf("== %s ==\n", label)
		fmt.Printf("attempts=%d completed=%d aborted=%d unclosed=%d orphan-abort=%d complete-without-begin=%d\n",
			len(attempts), complete, aborted, unclosed, orphan, noBegin)
		fmt.Printf("attempts seeing BOTH abort+complete=%d (of which completed-after-abort=%d)\n", both, abortThenComplete)
		if len(deltas) > 0 {
			min, max, sum := deltas[0], deltas[0], 0
			for _, d := range deltas {
				sum += d
				if d < min {
					min = d
				}
				if d > max {
					max = d
				}
			}
			fmt.Printf("begin→complete ticks: n=%d min=%d mean=%d max=%d\n",
				len(deltas), min, sum/len(deltas), max)
		}
		fmt.Println("-- attempts (all) --")
		for i := range attempts {
			at := attempts[i]
			// Interrupt evidence: damage/flash on the actor INSIDE the
			// attempt window (the CS2.md cancel-rules question).
			var interrupt []string
			for _, h := range hits[at.player] {
				if at.begin >= 0 && h.tick >= at.begin && h.tick <= at.end {
					interrupt = append(interrupt, fmt.Sprintf("%s@%d(+%d)", h.via, h.tick, h.tick-at.begin))
				}
			}
			if at.closedBy == "abort" {
				if len(interrupt) > 0 {
					abortWithHit++
				} else {
					abortWithoutHit++
				}
			}
			if at.closedBy == "complete" {
				// Damage/flash strictly BEFORE the completion: a hit here
				// that did NOT cancel the attempt is the counter-evidence
				// to "any damage cancels".
				for _, h := range hits[at.player] {
					if at.begin >= 0 && h.tick >= at.begin && h.tick < at.end {
						completeWithHit++
						break
					}
				}
			}
			span := -1
			if at.begin >= 0 {
				span = at.end - at.begin
			}
			fmt.Printf("  begin=%d player=%q closed=%s end=%d span=%d after=%v interrupt=%v\n",
				at.begin, at.player, at.closedBy, at.end, span, at.after, interrupt)
		}
		fmt.Printf("aborted attempts WITH damage/flash in-window=%d, WITHOUT=%d; completed WITH damage/flash before completion=%d\n",
			abortWithHit, abortWithoutHit, completeWithHit)
	}
	report("plant attempts", plants)
	report("defuse attempts", defuses)

	names := make([]string, 0, len(rawCounts))
	for k := range rawCounts {
		names = append(names, k)
	}
	sort.Strings(names)
	fmt.Println("== raw bomb_* game events seen ==")
	for _, n := range names {
		fmt.Printf("  %s=%d\n", n, rawCounts[n])
	}
}

func bombsiteStr(s events.Bombsite) string {
	switch s {
	case events.BombsiteA:
		return "A"
	case events.BombsiteB:
		return "B"
	}
	return "?"
}
