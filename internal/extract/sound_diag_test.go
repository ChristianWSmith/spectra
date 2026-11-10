package extract

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"
	"testing"

	"github.com/klauspost/compress/zstd"
	demoinfocs "github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs"
	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/events"
	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/msg"

	"github.com/ChristianWSmith/spectra/internal/mappack"
)

// TestDiagSOS re-parses the golden demo and reports the CMsgSosStartSoundEvent
// facts both sound-event waves are built from: bounce message/dedupe/origin
// counts, which entity id a bounce's source index matches (thrower vs
// projectile vs blast payload — the detail_json join key), player-sound
// attribution rates and their failure reasons, and any player-sound NAME the
// static candidate table does not cover (resolved against the local install's
// soundevent table when CS2 is present). Run with:
//
//	SPECTRA_DIAG=1 go test ./internal/extract -run TestDiagSOS -v
func TestDiagSOS(t *testing.T) {
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

	type throwRec struct {
		tick      int
		projID    int // projectile entity id (e.Projectile.Entity.ID())
		throwerID int // thrower's controller entity id
	}
	var throws []throwRec

	// blastRec is one typed detonation with its projectile-entity candidates.
	type blastRec struct {
		tick       int
		grenadeEnt int // GrenadeEvent.GrenadeEntityID
		projEnt    int // GrenadeEvent.Projectile.Entity.ID() (0 when nil)
	}
	var blasts []blastRec
	payloadByTick := map[int][]int{}

	type sosRec struct {
		tick     int
		hash     uint32
		src      int32
		originOK bool // packed_params parsed to a plausible origin
	}
	var sos []sosRec

	blastNames := map[string]bool{
		"hegrenade_detonate": true, "flashbang_detonate": true,
		"smokegrenade_detonate": true, "inferno_startburn": true,
		"decoy_started": true, "decoy_detonate": true,
	}
	recordBlast := func(ge events.GrenadeEvent, tick int) {
		rec := blastRec{tick: tick, grenadeEnt: ge.GrenadeEntityID}
		if ge.Projectile != nil && ge.Projectile.Entity != nil {
			rec.projEnt = ge.Projectile.Entity.ID()
		}
		blasts = append(blasts, rec)
	}
	p.RegisterEventHandler(func(e events.GrenadeProjectileThrow) {
		if e.Projectile == nil {
			return
		}
		rec := throwRec{tick: p.GameState().IngameTick()}
		if e.Projectile.Entity != nil {
			rec.projID = e.Projectile.Entity.ID()
		}
		if e.Projectile.Thrower != nil {
			rec.throwerID = e.Projectile.Thrower.EntityID
		}
		throws = append(throws, rec)
	})
	p.RegisterEventHandler(func(e events.GenericGameEvent) {
		if !blastNames[e.Name] {
			return
		}
		var payload map[string]any
		if err := json.Unmarshal([]byte(gameEventPayloadJSON(e.Data)), &payload); err == nil {
			if v, ok := payload["entityid"].(float64); ok {
				tick := p.GameState().IngameTick()
				payloadByTick[tick] = append(payloadByTick[tick], int(v))
			}
		}
	})
	p.RegisterEventHandler(func(e events.HeExplode) {
		recordBlast(e.GrenadeEvent, p.GameState().IngameTick())
	})
	p.RegisterEventHandler(func(e events.FlashExplode) {
		recordBlast(e.GrenadeEvent, p.GameState().IngameTick())
	})
	p.RegisterEventHandler(func(e events.SmokeStart) {
		recordBlast(e.GrenadeEvent, p.GameState().IngameTick())
	})
	p.RegisterEventHandler(func(e events.DecoyExpired) {
		recordBlast(e.GrenadeEvent, p.GameState().IngameTick())
	})
	p.RegisterEventHandler(func(e events.FireGrenadeStart) {
		recordBlast(e.GrenadeEvent, p.GameState().IngameTick())
	})
	p.RegisterNetMessageHandler(func(m *msg.CMsgSosStartSoundEvent) {
		_, _, _, ok := sosOrigin(m.GetPackedParams())
		sos = append(sos, sosRec{tick: p.GameState().IngameTick(), hash: m.GetSoundeventHash(), src: m.GetSourceEntityIndex(), originOK: ok})
	})

	if err := p.ParseToEnd(context.Background()); err != nil && err != demoinfocs.ErrUnexpectedEndOfDemo {
		t.Fatalf("parse: %v", err)
	}

	// --- bounce wave -------------------------------------------------------
	projIDs := map[int]bool{}
	throwerIDs := map[int]bool{}
	for _, th := range throws {
		projIDs[th.projID] = true
		throwerIDs[th.throwerID] = true
	}
	type bounceRec struct {
		tick int
		src  int
		name string
		ok   bool
	}
	var bounces []bounceRec
	seen := map[bounceKey]bool{}
	bounceMsg, bounceOriginOK := 0, 0
	perBounce := map[string]int{}
	for _, s := range sos {
		def, ok := bounceByHash[s.hash]
		if !ok {
			continue
		}
		bounceMsg++
		perBounce[def.name]++
		if s.originOK {
			bounceOriginOK++
		}
		key := bounceKey{entity: int(s.src), tick: s.tick, name: def.name}
		if seen[key] {
			continue // duplicate message: the FIRST message's origin wins
		}
		seen[key] = true
		bounces = append(bounces, bounceRec{tick: s.tick, src: int(s.src), name: def.name, ok: s.originOK})
	}
	// Which blast-row candidate equals a bounce's source, on the SAME tick?
	nearTick := 2 // bounces and detonations land on adjacent ticks
	matchGrenade, matchProj, matchPayload, matchThrower, noBlast := 0, 0, 0, 0, 0
	for _, b := range bounces {
		found := false
		for _, bl := range blasts {
			if absInt(bl.tick-b.tick) > nearTick {
				continue
			}
			found = true
			if bl.grenadeEnt != 0 && bl.grenadeEnt == b.src {
				matchGrenade++
			}
			if bl.projEnt != 0 && bl.projEnt == b.src {
				matchProj++
			}
			for _, id := range payloadByTick[bl.tick] {
				if id != 0 && id == b.src {
					matchPayload++
					break
				}
			}
		}
		if throwerIDs[b.src] {
			matchThrower++
		}
		if !found {
			noBlast++
		}
	}
	originOKRows := 0
	for _, b := range bounces {
		if b.ok {
			originOKRows++
		}
	}
	projMatch := 0
	for _, b := range bounces {
		if projIDs[b.src] {
			projMatch++
		}
	}
	// Union coverage: which blast-row candidate id set contains a bounce's
	// src, over ALL blast rows (tick-independent — most bounces happen far
	// from the detonation).
	unionGrenade := map[int]bool{}
	unionProj := map[int]bool{}
	unionPayload := map[int]bool{}
	grenadeZero, projZero := 0, 0
	for _, bl := range blasts {
		if bl.grenadeEnt != 0 {
			unionGrenade[bl.grenadeEnt] = true
		} else {
			grenadeZero++
		}
		if bl.projEnt != 0 {
			unionProj[bl.projEnt] = true
		} else {
			projZero++
		}
	}
	for _, ids := range payloadByTick {
		for _, id := range ids {
			if id != 0 {
				unionPayload[id] = true
			}
		}
	}
	uGrenade, uProj, uPayload := 0, 0, 0
	for _, b := range bounces {
		if unionGrenade[b.src] {
			uGrenade++
		}
		if unionProj[b.src] {
			uProj++
		}
		if unionPayload[b.src] {
			uPayload++
		}
	}
	fmt.Println("== SOS: grenade bounce wave ==")
	fmt.Printf("bounce messages=%d distinct(src,tick,name)=%d per-name=%v first-origin-ok=%d/%d rows-with-origin=%d/%d\n",
		bounceMsg, len(bounces), perBounce, bounceOriginOK, bounceMsg, originOKRows, len(bounces))
	fmt.Printf("src is a thrown projectile entity=%d/%d  src is a thrower controller=%d/%d\n",
		projMatch, len(bounces), matchThrower, len(bounces))
	fmt.Printf("blast rows within ±%d ticks: none=%d  GrenadeEntityID match=%d  Projectile.Entity match=%d  payload entityid match=%d\n",
		nearTick, noBlast, matchGrenade, matchProj, matchPayload)
	fmt.Printf("blast rows=%d (grenadeEnt=0:%d projEnt=0:%d); union over ALL blasts: GrenadeEntityID=%d/%d Projectile.Entity=%d/%d payload entityid=%d/%d\n",
		len(blasts), grenadeZero, projZero, uGrenade, len(bounces), uProj, len(bounces), uPayload, len(bounces))

	// --- player-sound wave -------------------------------------------------
	// attribution measured per message: the pawn→controller walk
	// (playerByEntity) first, a direct participant hit second, and the
	// failure reason broken down so the walk's gaps are explainable.
	reasonByKind := map[string]map[string]int{}
	byKind := map[string]int{}
	classSample := map[string]string{}
	matched, pawnHit, directHit, findByHandleHit := 0, 0, 0, 0
	var failSamples, okSamples []string
	bump := func(kind, reason string) {
		if reasonByKind[kind] == nil {
			reasonByKind[kind] = map[string]int{}
		}
		reasonByKind[kind][reason]++
	}
	for _, s := range sos {
		def, ok := playerSoundByHash[s.hash]
		if !ok {
			continue
		}
		matched++
		byKind[def.kind]++
		pl := playerByEntity(p.GameState(), int(s.src))
		if pl != nil {
			pawnHit++
			if len(okSamples) < 5 {
				okSamples = append(okSamples, fmt.Sprintf("src=%d kind=%s", s.src, def.kind))
			}
			continue
		}
		if s.src == -1 {
			bump(def.kind, "src=-1")
			continue
		}
		if p.GameState().Participants().ByEntityID()[int(s.src)] != nil {
			directHit++
			continue
		}
		ent := p.GameState().Entities()[int(s.src)]
		if ent == nil {
			bump(def.kind, "entity-missing")
			continue
		}
		if classSample[ent.ServerClass().Name()] == "" {
			classSample[ent.ServerClass().Name()] = fmt.Sprintf("src=%d kind=%s", s.src, def.kind)
		}
		ctlVal, okProp := ent.PropertyValue("m_hController")
		if !okProp {
			bump(def.kind, "no-m_hController")
			continue
		}
		// Does the PUBLIC pawn→participant resolution (demoinfocs' own
		// handle walk — Participants().FindByHandle64) find the player even
		// though gs.EntityByHandle did not?
		if pl := p.GameState().Participants().FindByHandle64(ctlVal.Handle()); pl != nil {
			findByHandleHit++
			if len(failSamples) < 5 {
				failSamples = append(failSamples, fmt.Sprintf("src=%d kind=%s handle=0x%X (FindByHandle64 -> %s)", s.src, def.kind, ctlVal.Handle(), pl.Name))
			}
			continue
		}
		ctl := p.GameState().EntityByHandle(ctlVal.Handle())
		if ctl == nil {
			// Reverse walk: does a participant's OWN pawn handle (the
			// controller's m_hPawn) point at this source entity?
			for _, pl := range p.GameState().Participants().All() {
				if pawn := pl.PlayerPawnEntity(); pawn != nil && pawn.ID() == int(s.src) {
					findByHandleHit++ // reuse the counter: reverse-walk hits
					if len(failSamples) < 5 {
						failSamples = append(failSamples, fmt.Sprintf("src=%d kind=%s (reverse m_hPawn -> %s)", s.src, def.kind, pl.Name))
					}
					break
				}
			}
			bump(def.kind, "handle-unresolved")
			if len(failSamples) < 8 {
				failSamples = append(failSamples, fmt.Sprintf("src=%d kind=%s handle=0x%X idx=%d (neither path)", s.src, def.kind, ctlVal.Handle(), ctlVal.Handle()&0x3FFF))
			}
			continue
		}
		if p.GameState().Participants().ByEntityID()[ctl.ID()] == nil {
			bump(def.kind, "controller-not-participant")
			continue
		}
		bump(def.kind, "???")
	}
	fmt.Println("== SOS: player-sound wave ==")
	fmt.Printf("matched=%d by-kind=%v pawn-walk=%d (%.1f%%) direct-participant=%d reverse-m_hPawn-only=%d\n",
		matched, byKind, pawnHit, 100*float64(pawnHit)/float64(maxInt(matched, 1)), directHit, findByHandleHit)
	for kind, reasons := range reasonByKind {
		fmt.Printf("  %-6s failures: %v\n", kind, reasons)
	}
	for cls, sample := range classSample {
		fmt.Printf("  unresolved source class %q (%s)\n", cls, sample)
	}
	for _, s := range okSamples {
		fmt.Printf("  resolved: %s\n", s)
	}
	for _, s := range failSamples {
		fmt.Printf("  sample:   %s\n", s)
	}

	// --- name coverage (needs the local install for the full name table) --
	unknown := map[uint32]int{}
	for _, s := range sos {
		if _, ok := bounceByHash[s.hash]; ok {
			continue
		}
		if _, ok := playerSoundByHash[s.hash]; ok {
			continue
		}
		unknown[s.hash]++
	}
	fmt.Printf("== SOS: unmatched hashes: %d distinct / %d messages ==\n", len(unknown), len(sos)-matched-bounceMsg)
	if mappack.FindCS2("") == "" {
		fmt.Println("(no local CS2 install — cannot name the unmatched hashes)")
		return
	}
	var buf bytes.Buffer
	if code := mappack.RunDevTool([]string{"events"}, &buf, io.Discard); code != 0 {
		t.Fatalf("cs2find events: exit %d", code)
	}
	nameByHash := map[uint32]string{}
	for _, line := range bytes.Split(bytes.TrimRight(buf.Bytes(), "\n"), []byte("\n")) {
		name, _, _ := bytes.Cut(line, []byte("\t"))
		if len(name) == 0 {
			continue
		}
		nameByHash[mappack.SoundEventHash(string(name))] = string(name)
	}
	type unk struct {
		name  string
		count int
	}
	var unks []unk
	playerish := 0
	for h, n := range unknown {
		name := nameByHash[h]
		if name == "" {
			name = fmt.Sprintf("<unresolved 0x%08X>", h)
		}
		if looksPlayerSound(name) {
			playerish++
		}
		unks = append(unks, unk{name: name, count: n})
	}
	sort.Slice(unks, func(i, j int) bool {
		if unks[i].count != unks[j].count {
			return unks[i].count > unks[j].count
		}
		return unks[i].name < unks[j].name
	})
	fmt.Printf("player-sound-looking names NOT in the candidate table: %d\n", playerish)
	for i, u := range unks {
		if i >= 40 {
			fmt.Printf("  … %d more\n", len(unks)-40)
			break
		}
		fmt.Printf("  %6d  %s\n", u.count, u.name)
	}
}

// looksPlayerSound flags an unmatched soundevent name that looks like a
// player sound the candidate table should have covered.
func looksPlayerSound(name string) bool {
	for _, needle := range []string{"StepLeft", "StepRight", "WalkJump", "JumpLand", "DamageFall", "Land.", "Footstep"} {
		if bytes.Contains([]byte(name), []byte(needle)) {
			return true
		}
	}
	return false
}

func absInt(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
