package extract

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"github.com/klauspost/compress/zstd"
	demoinfocs "github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs"
	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/events"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// TestDiagDropInventoryAtKill is the characterization run behind the
// death-drop inference (weapon_drop / weapon_pickup): it re-parses the
// golden demo(s) with its own handlers and answers, per events.Kill,
//
//  1. is e.Victim.Weapons() non-empty at Kill dispatch time? (the
//     authoritative inventory-at-death path — verified 7/7 demos,
//     1174/1174 kills non-empty and identical to the last frame sample,
//     so extract keeps NO last-known-inventory fallback)
//  2. what does the PRODUCTION drop rule infer there (inferDeathDrops),
//     and how does the gun ammo read (mag/reserve at death) come out?
//  3. how do inferred drops pair against events.ItemPickup rows
//     (matched = picked off the ground that round; unmatched = buys /
//     spawn restocks — the frontend evidence rule ignores those)?
//
// Run with:
//
//	SPECTRA_DIAG=1 go test ./internal/extract -run TestDiagDropInventoryAtKill -v
//
// Set SPECTRA_DIAG_ALL=1 to walk every demo in golden/ instead of just
// de_cache (slower, stronger evidence).
type dropDiagEntry struct {
	tick        int
	typ         string // "kill" | "pickup" | "round_start"
	round       int
	player      string
	weapon      string // pickup rows only
	inv         []inventoryItem
	lastInv     []inventoryItem
	lastHeld    string
	aliveAtKill bool
	hasPos      bool // victim position at the kill (the drop row's evidence)
}

func TestDiagDropInventoryAtKill(t *testing.T) {
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
			diagDrops(t, path)
		})
	}
}

func diagDrops(t *testing.T, path string) {
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

	var seq []dropDiagEntry
	round := 0
	// Per-frame last-known inventory / last-held util, reset every round
	// (the same reset home the production path uses).
	lastInv := map[uint64][]inventoryItem{}
	lastHeld := map[uint64]string{}

	p.RegisterEventHandler(func(events.RoundStart) {
		round++
		lastInv = map[uint64][]inventoryItem{}
		lastHeld = map[uint64]string{}
		seq = append(seq, dropDiagEntry{tick: p.GameState().IngameTick(), typ: "round_start", round: round})
	})

	p.RegisterEventHandler(func(events.FrameDone) {
		for _, pl := range p.GameState().Participants().Playing() {
			if pl == nil || !pl.IsAlive() {
				continue
			}
			key := playerKey(pl)
			lastInv[key] = dropInventory(pl.Weapons())
			if w := pl.ActiveWeapon(); w != nil && isUtilityEquipment(w.Type) {
				lastHeld[key] = wepName(w)
			}
		}
	})

	p.RegisterEventHandler(func(e events.Kill) {
		if e.Victim == nil {
			return
		}
		key := playerKey(e.Victim)
		pos := e.Victim.Position()
		seq = append(seq, dropDiagEntry{
			tick:        p.GameState().IngameTick(),
			typ:         "kill",
			round:       round,
			player:      e.Victim.Name,
			inv:         dropInventory(e.Victim.Weapons()),
			lastInv:     lastInv[key],
			lastHeld:    lastHeld[key],
			aliveAtKill: e.Victim.IsAlive(),
			hasPos:      !(pos.X == 0 && pos.Y == 0 && pos.Z == 0),
		})
	})

	pickups := 0
	p.RegisterEventHandler(func(e events.ItemPickup) {
		pickups++
		name := ""
		if e.Player != nil {
			name = e.Player.Name
		}
		seq = append(seq, dropDiagEntry{
			tick: p.GameState().IngameTick(), typ: "pickup", round: round,
			player: name, weapon: wepName(e.Weapon),
		})
	})

	buys := 0
	p.RegisterEventHandler(func(e events.GenericGameEvent) {
		if e.Name == "item_purchase" {
			buys++
		}
	})

	if err := p.ParseToEnd(context.Background()); err != nil && err != demoinfocs.ErrUnexpectedEndOfDemo {
		t.Fatalf("parse: %v", err)
	}

	// ---- report ----
	kills, nonEmpty, empty, emptyButLast := 0, 0, 0, 0
	agree, disagree, deadAtKill, notDeadAtKill := 0, 0, 0, 0
	var emptyNames []string
	gunPrimary, gunSecondary, gunNone := 0, 0, 0
	utilLast, utilExpensive, utilNone := 0, 0, 0
	gunWithAmmo, gunNoAmmo, magEmpty := 0, 0, 0
	type inferred struct {
		round  int
		tick   int
		weapon string
	}
	var drops []inferred
	matched, unmatched, pickupRowsFiltered := 0, 0, 0
	unmatchedByWeapon := map[string]int{}

	for _, e := range seq {
		switch e.typ {
		case "kill":
			kills++
			if e.aliveAtKill {
				notDeadAtKill++
			} else {
				deadAtKill++
			}
			if len(e.inv) > 0 {
				nonEmpty++
				if len(e.lastInv) > 0 && !sameItems(e.inv, e.lastInv) {
					disagree++
				} else {
					agree++
				}
			} else {
				empty++
				if len(e.lastInv) > 0 {
					emptyButLast++
					emptyNames = append(emptyNames, fmt.Sprintf("%s@%d last=%v", e.player, e.tick, e.lastInv))
				}
			}
			inv := e.inv
			if len(inv) == 0 {
				inv = e.lastInv
			}
			for _, d := range inferDeathDrops(inv, e.lastHeld) {
				switch d.cat {
				case "gun":
					switch {
					case models.IsPrimaryWeapon(d.name):
						gunPrimary++
					default:
						gunSecondary++
					}
					if d.mag > 0 || d.reserve > 0 {
						gunWithAmmo++
					} else {
						gunNoAmmo++
					}
					if d.mag == 0 {
						magEmpty++
					}
				case "util":
					if d.name == e.lastHeld {
						utilLast++
					} else {
						utilExpensive++
					}
				}
				drops = append(drops, inferred{round: e.round, tick: e.tick, weapon: d.name})
			}
		case "pickup":
			if dropCat(e.weapon) == "" {
				pickupRowsFiltered++ // the production filter: not gun/util
				continue
			}
			hit := -1
			for i, d := range drops {
				if d.round == e.round && d.weapon == e.weapon && d.tick < e.tick {
					if hit < 0 || d.tick < drops[hit].tick {
						hit = i // earliest unconsumed drop of that weapon before the pickup
					}
				}
			}
			if hit >= 0 {
				matched++
				drops = append(drops[:hit], drops[hit+1:]...)
			} else {
				unmatched++
				unmatchedByWeapon[e.weapon]++
			}
		}
	}
	// gun/util "none" counts: kills where the inference produced no gun
	// / no util decision.
	for _, e := range seq {
		if e.typ != "kill" {
			continue
		}
		inv := e.inv
		if len(inv) == 0 {
			inv = e.lastInv
		}
		ds := inferDeathDrops(inv, e.lastHeld)
		hasGun, hasUtil := false, false
		for _, d := range ds {
			if d.cat == "gun" {
				hasGun = true
			}
			if d.cat == "util" {
				hasUtil = true
			}
		}
		if !hasGun {
			gunNone++
		}
		if !hasUtil {
			utilNone++
		}
	}

	fmt.Printf("== %s ==\n", filepath.Base(path))
	fmt.Printf("kills=%d at-kill inventory: non-empty=%d empty=%d (of empty: had last-frame sample=%d)\n", kills, nonEmpty, empty, emptyButLast)
	fmt.Printf("at-kill vs last-frame inventory: agree=%d disagree=%d; victim alive at Kill dispatch: yes=%d no=%d\n", agree, disagree, notDeadAtKill, deadAtKill)
	killPos := 0
	for _, e := range seq {
		if e.typ == "kill" && e.hasPos {
			killPos++
		}
	}
	fmt.Printf("kills with a stored victim position (the drop rows' evidence): %d/%d\n", killPos, kills)
	if len(emptyNames) > 0 {
		fmt.Println("-- kills with EMPTY at-kill inventory --")
		for _, n := range emptyNames {
			fmt.Printf("  %s\n", n)
		}
	}
	fmt.Printf("production drop rule: gun primary=%d secondary=%d none=%d; util last-held=%d most-expensive=%d none=%d; drop rows=%d\n",
		gunPrimary, gunSecondary, gunNone, utilLast, utilExpensive, utilNone, len(drops))
	fmt.Printf("gun drop ammo at death: has mag/reserve>0=%d all-zero=%d (mag==0=%d)\n", gunWithAmmo, gunNoAmmo, magEmpty)
	fmt.Printf("item_pickup events=%d (raw item_purchase game events=%d): filtered(non gun/util)=%d kept=%d matched-to-drop=%d unmatched(buys/restock)=%d\n",
		pickups, buys, pickupRowsFiltered, pickups-pickupRowsFiltered, matched, unmatched)
	names := make([]string, 0, len(unmatchedByWeapon))
	for k := range unmatchedByWeapon {
		names = append(names, k)
	}
	sort.Strings(names)
	for _, n := range names {
		fmt.Printf("  unmatched pickup %q x%d\n", n, unmatchedByWeapon[n])
	}
}

// sameItems compares two inventories (names + ammo, in order).
func sameItems(a, b []inventoryItem) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
