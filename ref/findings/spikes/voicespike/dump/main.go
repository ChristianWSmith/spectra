package main

import (
	"context"
	"encoding/binary"
	"fmt"
	"log"
	"os"
	"sort"

	demoinfocs "github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs"
	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/msg"
)

type chunk struct {
	tick     uint32
	msgTick  uint32
	payload  []byte
	sr       uint32
	numPkt   uint32
	offsets  []uint32
	section  uint32
	seqBytes int32
	format   msg.VoiceDataFormatT
}

func main() {
	f, err := os.Open("/tmp/opencode/donk.dem")
	if err != nil {
		log.Fatal(err)
	}
	defer f.Close()

	byXuid := map[uint64][]chunk{}
	hist := map[int]int{}
	var all []chunk
	srHist := map[uint32]int{}
	numPktHist := map[uint32]int{}
	offsetsSet := 0

	p := demoinfocs.NewParser(f)
	defer p.Close()

	p.RegisterNetMessageHandler(func(m *msg.CSVCMsg_VoiceData) {
		a := m.GetAudio()
		c := chunk{
			tick:     uint32(p.GameState().IngameTick()),
			msgTick:  m.GetTick(),
			payload:  a.GetVoiceData(),
			sr:       a.GetSampleRate(),
			numPkt:   a.GetNumPackets(),
			offsets:  a.GetPacketOffsets(),
			section:  a.GetSectionNumber(),
			seqBytes: a.GetSequenceBytes(),
			format:   a.GetFormat(),
		}
		if len(c.offsets) > 0 {
			offsetsSet++
		}
		hist[len(c.payload)]++
		srHist[c.sr]++
		numPktHist[c.numPkt]++
		byXuid[m.GetXuid()] = append(byXuid[m.GetXuid()], c)
		all = append(all, c)
	})

	if err := p.ParseToEnd(context.Background()); err != nil {
		fmt.Println("parse note:", err)
	}

	fmt.Printf("total voice chunks: %d\n", len(all))
	fmt.Printf("chunks with PacketOffsets: %d\n", offsetsSet)
	fmt.Printf("sample_rate histogram: %v\n", srHist)
	fmt.Printf("num_packets histogram: %v\n", numPktHist)
	fmt.Printf("format histogram: %v\n", func() map[msg.VoiceDataFormatT]int {
		m := map[msg.VoiceDataFormatT]int{}
		for _, c := range all {
			m[c.format]++
		}
		return m
	}())

	// payload size histogram
	sizes := make([]int, 0, len(hist))
	for s := range hist {
		sizes = append(sizes, s)
	}
	sort.Ints(sizes)
	fmt.Println("payload size histogram (size:count):")
	totalBytes := 0
	for _, s := range sizes {
		fmt.Printf("  %4d: %6d\n", s, hist[s])
		totalBytes += s * hist[s]
	}
	fmt.Printf("total payload bytes: %d\n", totalBytes)

	// first 20 hexdump
	fmt.Println("\nfirst 20 payloads:")
	for i, c := range all[:min(20, len(all))] {
		hex := ""
		n := min(32, len(c.payload))
		for j := 0; j < n; j++ {
			hex += fmt.Sprintf("%02x ", c.payload[j])
		}
		off := ""
		for _, o := range c.offsets {
			off += fmt.Sprintf("%d ", o)
		}
		fmt.Printf("  [%2d] tick=%-8d len=%-4d sr=%-5d numpkt=%-3d offs=[%s] seq=%d sec=%d bytes=%s\n",
			i, c.tick, len(c.payload), c.sr, c.numPkt, off, c.seqBytes, c.section, hex)
	}

	// DTX check
	dtx := 0
	for _, c := range all {
		if len(c.payload) <= 2 {
			dtx++
		}
	}
	fmt.Printf("payloads of size <=2 (DTX?): %d\n", dtx)

	// section_number continuity per xuid (gaps = lost/missing chunks in demo)
	for x, cs := range byXuid {
		gaps, back, jumps := 0, 0, 0
		for i := 1; i < len(cs); i++ {
			d := int64(cs[i].section) - int64(cs[i-1].section)
			if d == 0 {
				back++
			} else if d > 1 {
				gaps++
				if d > 100 {
					jumps++
				}
			} else if d < 0 {
				back++
			}
		}
		fmt.Printf("section continuity xuid=%d: forward-adjacent=%d gaps(>1)=%d bigjumps(>100)=%d resets/back=%d\n",
			x, len(cs)-1-gaps-back, gaps, jumps, back)
	}

	// top XUIDs
	type kv struct {
		x uint64
		n int
	}
	var xs []kv
	for x, cs := range byXuid {
		xs = append(xs, kv{x, len(cs)})
	}
	sort.Slice(xs, func(i, j int) bool { return xs[i].n > xs[j].n })
	fmt.Println("xuids by chunk count:")
	for _, e := range xs {
		cs := byXuid[e.x]
		minT, maxT := cs[0].tick, cs[0].tick
		for _, c := range cs {
			if c.tick < minT {
				minT = c.tick
			}
			if c.tick > maxT {
				maxT = c.tick
			}
		}
		// tick gap histogram (ticks between consecutive chunks)
		gaps := map[int]int{}
		for i := 1; i < len(cs); i++ {
			gaps[int(cs[i].tick)-int(cs[i-1].tick)]++
		}
		gs := make([]int, 0, len(gaps))
		for g := range gaps {
			gs = append(gs, g)
		}
		sort.Ints(gs)
		gsStr := ""
		for _, g := range gs {
			gsStr += fmt.Sprintf("%d:%d ", g, gaps[g])
		}
		fmt.Printf("  xuid=%d chunks=%d tickspan=%d..%d (%.1fs wall @64hz) gaps: %s\n", e.x, e.n, minT, maxT, float64(maxT-minT)/64, gsStr)
	}

	// tick field of the message itself (sanity)
	msgTicks := map[uint32]int{}
	for _, c := range all {
		msgTicks[c.msgTick]++
	}
	fmt.Printf("m.Tick histogram (top5): ")
	type kv2 struct {
		t uint32
		n int
	}
	var mts []kv2
	for t, n := range msgTicks {
		mts = append(mts, kv2{t, n})
	}
	sort.Slice(mts, func(i, j int) bool { return mts[i].n > mts[j].n })
	for i := 0; i < min(5, len(mts)); i++ {
		fmt.Printf("%d:%d ", mts[i].t, mts[i].n)
	}
	fmt.Println()

	// dump top-2 xuids to length-prefixed files: [tick u32][len u32][payload]
	for i := 0; i < min(2, len(xs)); i++ {
		x := xs[i].x
		path := fmt.Sprintf("/tmp/opencode/voicespike/xuid_%d.bin", x)
		out, err := os.Create(path)
		if err != nil {
			log.Fatal(err)
		}
		for _, c := range byXuid[x] {
			var hdr [8]byte
			binary.LittleEndian.PutUint32(hdr[0:4], c.tick)
			binary.LittleEndian.PutUint32(hdr[4:8], uint32(len(c.payload)))
			out.Write(hdr[:])
			out.Write(c.payload)
		}
		out.Close()
		fmt.Printf("wrote %s (%d chunks)\n", path, len(byXuid[x]))
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
