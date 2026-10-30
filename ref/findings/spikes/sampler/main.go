package main

import (
	"context"
	"encoding/binary"
	"flag"
	"fmt"
	"log"
	"math"
	"os"
	"path/filepath"
	"time"

	"github.com/klauspost/compress/zstd"
	demoinfocs "github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs"
	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/events"
	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/option"
)

const (
	encF32 = 1 // x,y,z float32 + yaw float32 + flags u8 = 17B/player
	encQ16 = 2 // x,y,z int16@1.0u + yaw u8 + flags u8   = 8B/player
)

type sample struct {
	x, y, z, yaw float32
	air, duk     bool
}

type ordered struct {
	slot int
	s    *sample
}

type bufSet struct {
	rawFull, rawHalf []byte
	qFull, qHalf     []byte
	framesFull       int
	framesHalf       int
	aliveSumFull     int
	slotOf           map[uint64]int
	slots            []uint64
}

func newBufSet() *bufSet { return &bufSet{slotOf: map[uint64]int{}} }

func (b *bufSet) slot(id uint64) int {
	if s, ok := b.slotOf[id]; ok {
		return s
	}
	s := len(b.slots)
	b.slotOf[id] = s
	b.slots = append(b.slots, id)
	return s
}

func (b *bufSet) emit(buf *[]byte, enc int, tick int, mask uint16, order []ordered) {
	var fh [6]byte
	binary.LittleEndian.PutUint32(fh[0:4], uint32(int32(tick)))
	binary.LittleEndian.PutUint16(fh[4:6], mask)
	*buf = append(*buf, fh[:]...)
	for _, o := range order {
		var pb [17]byte
		flags := byte(0)
		if o.s.air {
			flags |= 1
		}
		if o.s.duk {
			flags |= 2
		}
		if enc == encF32 {
			binary.LittleEndian.PutUint32(pb[0:4], math.Float32bits(o.s.x))
			binary.LittleEndian.PutUint32(pb[4:8], math.Float32bits(o.s.y))
			binary.LittleEndian.PutUint32(pb[8:12], math.Float32bits(o.s.z))
			binary.LittleEndian.PutUint32(pb[12:16], math.Float32bits(o.s.yaw))
			pb[16] = flags
			*buf = append(*buf, pb[:17]...)
		} else {
			quant := func(v float32) uint16 {
				c := math.Max(math.Min(float64(v), 32767), -32767)
				return uint16(int16(c))
			}
			binary.LittleEndian.PutUint16(pb[0:2], quant(o.s.x))
			binary.LittleEndian.PutUint16(pb[2:4], quant(o.s.y))
			binary.LittleEndian.PutUint16(pb[4:6], quant(o.s.z))
			y := (float64(o.s.yaw) + 180.0) / 360.0 * 256.0
			if y < 0 {
				y = 0
			}
			if y > 255 {
				y = 255
			}
			pb[6] = byte(y)
			pb[7] = flags
			*buf = append(*buf, pb[:8]...)
		}
	}
}

func hdr(enc, slots int) []byte {
	h := make([]byte, 32)
	copy(h[0:4], []byte("SPCS"))
	binary.LittleEndian.PutUint16(h[4:6], 1)
	binary.LittleEndian.PutUint16(h[6:8], uint16(enc))
	binary.LittleEndian.PutUint32(h[8:12], 1)
	binary.LittleEndian.PutUint16(h[12:14], uint16(slots))
	return h
}

func zsize(b []byte) uint64 {
	enc, err := zstd.NewWriter(nil)
	if err != nil {
		return 0
	}
	defer enc.Close()
	return uint64(len(enc.EncodeAll(b, make([]byte, 0, len(b)/3+128))))
}

func main() {
	demoPath := flag.String("demo", "", "path to .dem")
	outDir := flag.String("out", "/tmp/opencode/spikes/sampler/out", "output dir")
	sampleOn := flag.Bool("sample", true, "sample positions on FrameDone")
	half := flag.Bool("half", true, "also emit half-rate buffers")
	flag.Parse()

	start := time.Now()
	f, err := os.Open(*demoPath)
	if err != nil {
		log.Fatal(err)
	}
	defer f.Close()

	p := demoinfocs.NewParser(f,
		option.IgnorePacketEntitiesPanic(true),
		option.MsgQueueBufferSize(0),
	)
	defer p.Close()

	bs := newBufSet()
	frameIdx := 0
	firstTick, lastTick := 0, 0

	p.RegisterEventHandler(func(e events.FrameDone) {
		frameIdx++
		if !*sampleOn {
			return
		}
		gs := p.GameState()
		tick := gs.IngameTick()
		if frameIdx == 1 {
			firstTick = tick
		}
		lastTick = tick

		var mask uint16
		var order []ordered
		playing := gs.Participants().Playing()
		for _, pl := range playing {
			if !pl.IsAlive() {
				continue
			}
			pos := pl.Position()
			s := &sample{
				x: float32(pos.X), y: float32(pos.Y), z: float32(pos.Z),
				yaw: pl.ViewDirectionY(), air: pl.IsAirborne(), duk: pl.IsDucking(),
			}
			slot := bs.slot(pl.SteamID64)
			if slot < 16 {
				mask |= 1 << uint(slot)
			}
			order = append(order, ordered{slot, s})
		}

		bs.framesFull++
		bs.aliveSumFull += len(order)
		bs.emit(&bs.rawFull, encF32, tick, mask, order)
		bs.emit(&bs.qFull, encQ16, tick, mask, order)
		if *half && frameIdx%2 == 0 {
			bs.framesHalf++
			bs.emit(&bs.rawHalf, encF32, tick, mask, order)
			bs.emit(&bs.qHalf, encQ16, tick, mask, order)
		}
	})

	if err := p.ParseToEnd(context.Background()); err != nil {
		log.Printf("parse note: %v", err)
	}
	elapsed := time.Since(start)

	if !*sampleOn {
		fmt.Printf("BASELINE (no sampling): frames=%d wall=%s\n", frameIdx, elapsed.Round(time.Millisecond))
		return
	}

	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		log.Fatal(err)
	}
	write := func(name string, payload []byte, enc, slots int) {
		full := append(hdr(enc, slots), payload...)
		if err := os.WriteFile(filepath.Join(*outDir, name), full, 0o644); err != nil {
			log.Fatal(err)
		}
		fmt.Printf("%-20s raw=%10d  zstd=%10d\n", name, len(full), zsize(full))
	}

	write("full_f32.bin", bs.rawFull, encF32, len(bs.slots))
	write("full_q16.bin", bs.qFull, encQ16, len(bs.slots))
	write("half_f32.bin", bs.rawHalf, encF32, len(bs.slots))
	write("half_q16.bin", bs.qHalf, encQ16, len(bs.slots))

	fmt.Printf("\nframes=%d (half=%d) wall=%s ticks=%d..%d slots=%d avgAlive=%.2f\n",
		bs.framesFull, bs.framesHalf, elapsed.Round(time.Millisecond), firstTick, lastTick,
		len(bs.slots), float64(bs.aliveSumFull)/float64(max(bs.framesFull, 1)))
	for i, id := range bs.slots {
		fmt.Printf("slot[%d]=%d\n", i, id)
	}
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
