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
//  4. defuse-kit seams (stage 1 of the kit feature): does
//     HasDefuseKit() still read TRUE at Kill dispatch (the pawn
//     property is the ONLY kit-possession signal — no stream carries
//     it), does it agree with the victim's last alive-frame sample, how
//     many kit rows does the production rule infer, how many
//     item_pickup "Defuse Kit" rows does the gate now let through (buys
//     + ground pickups alike), and how many rounds carry a
//     buytime_ended generic row (the frontend's buy-vs-ground rule
//     input)?
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
	// Defuse-kit possession at the kill dispatch (the seam kit drops
	// depend on — HasDefuseKit reads the pawn's m_pItemServices.
	// m_bHasDefuser, which is NOT inventory data): hasKit is the
	// dispatch-time read the production handler uses, lastKit the
	// victim's last alive-frame sample (the cross-check: if the
	// dispatch read came back false for a kit owner, the frame sample
	// is where the fallback would have to come from).
	hasKit  bool
	lastKit bool
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
	// Per-frame last-known inventory / last-held util / kit possession,
	// reset every round (the same reset home the production path uses).
	lastInv := map[uint64][]inventoryItem{}
	lastHeld := map[uint64]string{}
	lastKit := map[uint64]bool{}

	p.RegisterEventHandler(func(events.RoundStart) {
		round++
		lastInv = map[uint64][]inventoryItem{}
		lastHeld = map[uint64]string{}
		lastKit = map[uint64]bool{}
		seq = append(seq, dropDiagEntry{tick: p.GameState().IngameTick(), typ: "round_start", round: round})
	})

	p.RegisterEventHandler(func(events.FrameDone) {
		for _, pl := range p.GameState().Participants().Playing() {
			if pl == nil || !pl.IsAlive() {
				continue
			}
			key := playerKey(pl)
			lastInv[key] = dropInventory(pl.Weapons())
			lastKit[key] = pl.HasDefuseKit()
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
			// The seam under test: the production read (handlers.go) and
			// the last alive-frame sample it would fall back to.
			hasKit:  e.Victim.HasDefuseKit(),
			lastKit: lastKit[key],
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
	buyEnds := map[int]int{} // round → tick of its buytime_ended row (the
	//                        frontend's buy-vs-ground rule input,
	//                        lib/replay/kits.js buildKitEvidence)
	buyEndDuplicates := 0
	p.RegisterEventHandler(func(e events.GenericGameEvent) {
		if e.Name == "item_purchase" {
			buys++
		}
		if e.Name == "buytime_ended" {
			if _, seen := buyEnds[round]; seen {
				buyEndDuplicates++
			}
			buyEnds[round] = p.GameState().IngameTick()
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

	// Kit seams (see the doc header's item 4).
	kitDrops := 0                                     // inferred kit death-drop rows
	kitPickups := 0                                   // item_pickup "Defuse Kit" rows the gate keeps
	kitDropPos := 0                                   // kit drops carrying a victim position
	kitPickupAfterDrop := 0                           // kit pickups with an earlier same-round kit drop (naive pairing)
	kitPickupBeforeAnyDrop := 0                       // kit pickups with NO earlier same-round drop (buys / restocks)
	kitPickupInBuytime, kitPickupAfterBuytime := 0, 0 // buy vs ground per buytime_ended
	killsHasKit, killsLastKit := 0, 0                 // dispatch read vs last-frame sample
	kitReadDisagree := 0                              // the two reads differ on a kill
	kitDispatchOnly := 0                              // dispatch true, frame sample false
	kitFrameOnly := 0                                 // frame sample true, dispatch false
	var kitKillNames []string

	for _, e := range seq {
		switch e.typ {
		case "kill":
			kills++
			if e.aliveAtKill {
				notDeadAtKill++
			} else {
				deadAtKill++
			}
			// Kit-possession seam: the dispatch read (production) vs the
			// victim's last alive-frame sample.
			if e.hasKit {
				killsHasKit++
				kitKillNames = append(kitKillNames, fmt.Sprintf("%s@%d r%d", e.player, e.tick, e.round))
			}
			if e.lastKit {
				killsLastKit++
			}
			if e.hasKit != e.lastKit {
				kitReadDisagree++
				if e.hasKit {
					kitDispatchOnly++
				} else {
					kitFrameOnly++
				}
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
			for _, d := range inferDeathDrops(inv, e.lastHeld, e.hasKit) {
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
				case "kit":
					kitDrops++
					if e.hasPos {
						kitDropPos++
					}
				}
				drops = append(drops, inferred{round: e.round, tick: e.tick, weapon: d.name})
			}
		case "pickup":
			if e.weapon == "Defuse Kit" {
				kitPickups++
				// Naive same-round pairing (the diag's own matcher, NOT
				// the frontend's nearest-death rule): does an earlier
				// kit drop exist in this round?
				earlier := false
				for _, d := range drops {
					if d.round == e.round && d.weapon == e.weapon && d.tick < e.tick {
						earlier = true
						break
					}
				}
				if earlier {
					kitPickupAfterDrop++
				} else {
					kitPickupBeforeAnyDrop++
				}
				// The buytime classification Stage 2's rule uses:
				// item_pickup at/before the round's buytime_ended = a
				// BUY (never terminates a drop); after it = a ground
				// pickup (a disambiguation candidate). No buytime_ended
				// row for the round → 0 (open bound: treated as after).
				if end, ok := buyEnds[e.round]; ok && e.tick <= end {
					kitPickupInBuytime++
				} else {
					kitPickupAfterBuytime++
				}
			}
			if dropCat(e.weapon) == "" {
				pickupRowsFiltered++ // the production filter: not gun/util/kit
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
		ds := inferDeathDrops(inv, e.lastHeld, e.hasKit)
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
	fmt.Printf("KIT seam: kills with HasDefuseKit()==true at Kill dispatch=%d/%d; last-alive-frame sample true=%d; reads disagree=%d (dispatch-only=%d frame-only=%d)\n",
		killsHasKit, kills, killsLastKit, kitReadDisagree, kitDispatchOnly, kitFrameOnly)
	for _, n := range kitKillNames {
		fmt.Printf("  kit-at-kill %s\n", n)
	}
	fmt.Printf("KIT rows: inferred kit death drops=%d (with a victim position=%d/%d); item_pickup \"Defuse Kit\" kept by the gate=%d (earlier same-round kit drop=%d, none/buys=%d)\n",
		kitDrops, kitDropPos, kitDrops, kitPickups, kitPickupAfterDrop, kitPickupBeforeAnyDrop)
	fmt.Printf("KIT pickups by buytime: at/before buytime_ended (buys — never terminate a drop)=%d; after (ground candidates)=%d\n",
		kitPickupInBuytime, kitPickupAfterBuytime)
	fmt.Printf("buytime_ended generic rows: rounds covered=%d/%d (duplicate rows in a round=%d)\n",
		len(buyEnds), round, buyEndDuplicates)
	fmt.Printf("item_pickup events=%d (raw item_purchase game events=%d): filtered(non gun/util/kit)=%d kept=%d matched-to-drop=%d unmatched(buys/restock)=%d\n",
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
