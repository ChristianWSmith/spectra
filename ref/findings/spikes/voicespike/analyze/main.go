package main

import (
	"encoding/binary"
	"fmt"
	"log"
	"math"
	"os"
	"sort"

	"github.com/pion/opus"
)

type chunk struct {
	tick    uint32
	payload []byte
}

func readChunks(path string) []chunk {
	b, err := os.ReadFile(path)
	if err != nil {
		log.Fatal(err)
	}
	var out []chunk
	off := 0
	for off+8 <= len(b) {
		tick := binary.LittleEndian.Uint32(b[off : off+4])
		n := int(binary.LittleEndian.Uint32(b[off+4 : off+8]))
		off += 8
		if off+n > len(b) {
			log.Fatalf("truncated at %d", off)
		}
		out = append(out, chunk{tick: tick, payload: append([]byte(nil), b[off:off+n]...)})
		off += n
	}
	return out
}

// split framings: each returns opus packets (nil,false = invalid framing for this payload)
type framing struct {
	name  string
	split func(p []byte) ([][]byte, bool)
}

func framings() []framing {
	return []framing{
		{"whole", func(p []byte) ([][]byte, bool) {
			if len(p) == 0 {
				return nil, false
			}
			return [][]byte{p}, true
		}},
		{"skip1", func(p []byte) ([][]byte, bool) {
			if len(p) <= 1 {
				return nil, false
			}
			return [][]byte{p[1:]}, true
		}},
		{"skip2", func(p []byte) ([][]byte, bool) {
			if len(p) <= 2 {
				return nil, false
			}
			return [][]byte{p[2:]}, true
		}},
		{"len1", func(p []byte) ([][]byte, bool) {
			if len(p) < 1 {
				return nil, false
			}
			n := int(p[0])
			if len(p) < 1+n || n == 0 {
				return nil, false
			}
			return [][]byte{p[1 : 1+n]}, true
		}},
		{"len1-walk", func(p []byte) ([][]byte, bool) {
			var pkts [][]byte
			off := 0
			for off < len(p) {
				if off+1 > len(p) {
					return nil, false
				}
				n := int(p[off])
				off++
				if n == 0 || off+n > len(p) {
					return nil, false
				}
				pkts = append(pkts, p[off:off+n])
				off += n
			}
			if len(pkts) == 0 {
				return nil, false
			}
			return pkts, true
		}},
		{"len2", func(p []byte) ([][]byte, bool) {
			if len(p) < 2 {
				return nil, false
			}
			n := int(binary.LittleEndian.Uint16(p[:2]))
			if len(p) < 2+n || n == 0 {
				return nil, false
			}
			return [][]byte{p[2 : 2+n]}, true
		}},
		{"len2-walk", func(p []byte) ([][]byte, bool) {
			var pkts [][]byte
			off := 0
			for off < len(p) {
				if off+2 > len(p) {
					return nil, false
				}
				n := int(binary.LittleEndian.Uint16(p[off : off+2]))
				off += 2
				if n == 0 || off+n > len(p) {
					return nil, false
				}
				pkts = append(pkts, p[off:off+n])
				off += n
			}
			if len(pkts) == 0 {
				return nil, false
			}
			return pkts, true
		}},
	}
}

type result struct {
	framing    string
	rate       int
	chunks     int
	pkts       int
	errs       int
	splitFails int
	samples    int
	sumSq      float64
	activePkts int
	sampleSet  map[int]int
}

func (r result) errRate() float64 {
	if r.pkts == 0 {
		return 1
	}
	return float64(r.errs+r.splitFails) / float64(r.pkts+r.splitFails)
}

func (r result) rms() float64 {
	if r.samples == 0 {
		return 0
	}
	return math.Sqrt(r.sumSq / float64(r.samples))
}

func (r result) activePct() float64 {
	if r.pkts == 0 {
		return 0
	}
	return 100 * float64(r.activePkts) / float64(r.pkts)
}

func (r result) meanSamples() float64 {
	tot, n := 0, 0
	for s, c := range r.sampleSet {
		tot += s * c
		n += c
	}
	if n == 0 {
		return 0
	}
	return float64(tot) / float64(n)
}

func score(f framing, rate int, chunks []chunk) result {
	dec, err := opus.NewDecoderWithOutput(rate, 1)
	if err != nil {
		log.Fatal(err)
	}
	out := make([]int16, 8192)
	r := result{framing: f.name, rate: rate, chunks: len(chunks), sampleSet: map[int]int{}}
	for _, c := range chunks {
		pkts, ok := f.split(c.payload)
		if !ok {
			r.splitFails++
			r.pkts++
			continue
		}
		for _, pkt := range pkts {
			r.pkts++
			n, err := dec.DecodeToInt16(pkt, out)
			if err != nil {
				r.errs++
				continue
			}
			r.samples += n
			r.sampleSet[n]++
			var sq float64
			var e float64
			for i := 0; i < n; i++ {
				v := float64(out[i])
				sq += v * v
				if v > e {
					e = v
				}
			}
			r.sumSq += sq
			if math.Sqrt(sq/float64(max(n, 1))) >= 500 {
				r.activePkts++
			}
		}
	}
	return r
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// bestWindow: longest run of chunks with tick gap <= maxGap ticks,
// requiring at least minChunks chunks; falls back to densest wall-span.
func bestWindow(chunks []chunk, maxGap uint32, minChunks int) (int, int) {
	bestS, bestE := 0, 0
	s := 0
	for i := 1; i <= len(chunks); i++ {
		if i == len(chunks) || chunks[i].tick-chunks[i-1].tick > maxGap {
			if i-s > bestE-bestS {
				bestS, bestE = s, i
			}
			s = i
		}
	}
	if bestE-bestS >= minChunks {
		return bestS, bestE
	}
	// fallback: for each start i, take window through the first chunk at
	// >= 60s wall distance (guarantees >=60s span), maximize chunk count
	minWall := uint32(60 * 64)
	if len(chunks) == 0 {
		return 0, 0
	}
	for i := 0; i < len(chunks); i++ {
		// first j with tick_j >= tick_i + minWall
		lo, hi := i, len(chunks)
		for lo < hi {
			mid := (lo + hi) / 2
			if chunks[mid].tick-chunks[i].tick < minWall {
				lo = mid + 1
			} else {
				hi = mid
			}
		}
		if lo >= len(chunks) {
			continue
		}
		if lo-i+1 > bestE-bestS {
			bestS, bestE = i, lo+1
		}
	}
	if bestE <= bestS { // no single window reaches 60s
		return 0, len(chunks)
	}
	return bestS, bestE
}

func burstStats(chunks []chunk, maxGap uint32) (nBursts int, longest int, totalSpeechTicks int) {
	s := 0
	for i := 1; i <= len(chunks); i++ {
		if i == len(chunks) || chunks[i].tick-chunks[i-1].tick > maxGap {
			nBursts++
			if i-s > longest {
				longest = i - s
			}
			if i > s {
				totalSpeechTicks += int(chunks[i-1].tick - chunks[s].tick)
			}
			s = i
		}
	}
	return
}

func writeWAV(path string, pcm []int16, rate int) error {
	dataBytes := len(pcm) * 2
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	hdr := make([]byte, 44)
	copy(hdr[0:4], "RIFF")
	binary.LittleEndian.PutUint32(hdr[4:8], uint32(36+dataBytes))
	copy(hdr[8:12], "WAVE")
	copy(hdr[12:16], "fmt ")
	binary.LittleEndian.PutUint32(hdr[16:20], 16)
	binary.LittleEndian.PutUint16(hdr[20:22], 1) // PCM
	binary.LittleEndian.PutUint16(hdr[22:24], 1) // mono
	binary.LittleEndian.PutUint32(hdr[24:28], uint32(rate))
	binary.LittleEndian.PutUint32(hdr[28:32], uint32(rate*2)) // byte rate
	binary.LittleEndian.PutUint16(hdr[32:34], 2)              // block align
	binary.LittleEndian.PutUint16(hdr[34:36], 16)             // bits
	copy(hdr[36:40], "data")
	binary.LittleEndian.PutUint32(hdr[40:44], uint32(dataBytes))
	if _, err := f.Write(hdr); err != nil {
		return err
	}
	buf := make([]byte, dataBytes)
	for i, s := range pcm {
		binary.LittleEndian.PutUint16(buf[i*2:], uint16(s))
	}
	_, err = f.Write(buf)
	return err
}

// decodeWindow places each chunk's PCM on a wall-clock timeline (zero-filling pauses).
func decodeWindow(f framing, rate int, chunks []chunk, s, e int) (pcm []int16, info string) {
	dec, err := opus.NewDecoderWithOutput(rate, 1)
	if err != nil {
		log.Fatal(err)
	}
	out := make([]int16, 8192)
	tick0 := chunks[s].tick
	tick1 := chunks[e-1].tick
	total := (int(tick1-tick0) + 64) * rate / 64 // +1s margin
	pcm = make([]int16, total)
	var placed, errs, pkts int
	var lastEnd int
	for i := s; i < e; i++ {
		pktsAt, ok := f.split(chunks[i].payload)
		if !ok {
			errs++
			continue
		}
		tPos := int(chunks[i].tick-tick0) * rate / 64
		if tPos < lastEnd {
			tPos = lastEnd
		}
		for _, pkt := range pktsAt {
			n, err := dec.DecodeToInt16(pkt, out)
			pkts++
			if err != nil {
				errs++
				continue
			}
			if tPos+n > len(pcm) {
				break
			}
			copy(pcm[tPos:tPos+n], out[:n])
			tPos += n
			lastEnd = tPos
			placed++
		}
	}
	wallSec := float64(tick1-tick0) / 64
	info = fmt.Sprintf("chunks=%d pkts=%d placed=%d errs=%d wall=%.1fs", e-s, pkts, placed, errs, wallSec)
	// trim trailing zeros beyond last placed sample
	return pcm, info
}

func main() {
	files := []string{
		"/tmp/opencode/voicespike/xuid_76561198210730700.bin",
		"/tmp/opencode/voicespike/xuid_76561198372023214.bin",
	}
	rates := []int{48000, 24000, 16000, 12000, 8000}

	chunks := readChunks(files[0])
	fmt.Printf("loaded %d chunks from %s\n", len(chunks), files[0])

	// TOC histogram
	toc := map[byte]int{}
	for _, c := range chunks {
		if len(c.payload) > 0 {
			toc[c.payload[0]]++
		}
	}
	fmt.Println("TOC byte histogram (top 10):")
	type kv struct {
		b byte
		n int
	}
	var ts []kv
	for b, n := range toc {
		ts = append(ts, kv{b, n})
	}
	sort.Slice(ts, func(i, j int) bool { return ts[i].n > ts[j].n })
	for i := 0; i < min(10, len(ts)); i++ {
		cfg := ts[i].b >> 3
		fmt.Printf("  0x%02x: %d  (config=%d stereo=%v frameCode=%d)\n",
			ts[i].b, ts[i].n, cfg, ts[i].b&4 != 0, ts[i].b&3)
	}

	// burst stats
	nB, longest, speechTicks := burstStats(chunks, 8)
	fmt.Printf("bursts(gap<=8t): %d longest=%d chunks (%.1fs audio) totalSpeechWall=%.1fs\n",
		nB, longest, float64(longest)*0.01, float64(speechTicks)/64)

	// scoring on a sample of chunks (every chunk in a dense region)
	sample := chunks[:min(3000, len(chunks))]
	fmt.Println("\nscore table (first 3000 chunks):")
	fmt.Printf("%-10s %6s %6s %7s %8s %9s %8s %9s %8s\n",
		"framing", "rate", "pkts", "errRate", "meanSmpl", "stdevSmpl", "rms", "active%", "ms/chunk")
	var results []result
	for _, f := range framings() {
		for _, r := range rates {
			res := score(f, r, sample)
			results = append(results, res)
			// stdev
			m := res.meanSamples()
			var vs float64
			var n int
			for s, c := range res.sampleSet {
				vs += float64((s-int(m))*(s-int(m))) * float64(c)
				n += c
			}
			sd := 0.0
			if n > 0 {
				sd = math.Sqrt(vs / float64(n))
			}
			fmt.Printf("%-10s %6d %6d %7.4f %8.1f %9.1f %8.0f %9.1f %8.1f\n",
				res.framing, res.rate, res.pkts, res.errRate(), m, sd, res.rms(), res.activePct(),
				1000*m/float64(res.rate))
		}
	}

	// pick best: low err, high activity, at 48000 preferred
	sort.Slice(results, func(i, j int) bool {
		score := func(r result) float64 {
			s := 0.0
			s += (1 - math.Min(1, r.errRate()*10)) * 100
			s += math.Min(100, r.activePct())
			if r.rate == 48000 {
				s += 30
			}
			if r.rms() > 200 && r.rms() < 12000 {
				s += 20
			}
			return s
		}
		return score(results[i]) > score(results[j])
	})
	best := results[0]
	fmt.Printf("\nbest candidate: framing=%s rate=%d errRate=%.5f active=%.1f%% rms=%.0f meanSamples=%.0f\n",
		best.framing, best.rate, best.errRate(), best.activePct(), best.rms(), best.meanSamples())

	// use message sample rate 48000 with best framing
	bestRate := 48000
	var bestF framing
	for _, f := range framings() {
		if f.name == best.framing {
			bestF = f
		}
	}

	// decode windows for both players
	for fi, path := range files {
		cs := readChunks(path)
		// full-corpus metrics for this player
		full := score(bestF, bestRate, cs)
		fmt.Printf("player%d full corpus: chunks=%d pkts=%d errRate=%.6f meanSamples=%.0f rms=%.0f active=%.1f%%\n",
			fi+1, full.chunks, full.pkts, full.errRate(), full.meanSamples(), full.rms(), full.activePct())
		s, e := bestWindow(cs, 8, 6000)
		pcm, info := decodeWindow(bestF, bestRate, cs, s, e)
		// trim trailing silence
		last := len(pcm) - 1
		for last > 0 && pcm[last] == 0 {
			last--
		}
		pcm = pcm[:last+1]
		outPath := fmt.Sprintf("/tmp/opencode/voicespike/out/player%d.wav", fi+1)
		if err := writeWAV(outPath, pcm, bestRate); err != nil {
			log.Fatal(err)
		}
		// energy stats
		var sq float64
		var nz int
		for _, v := range pcm {
			vf := float64(v)
			sq += vf * vf
			if v != 0 {
				nz++
			}
		}
		rms := 0.0
		if len(pcm) > 0 {
			rms = math.Sqrt(sq / float64(len(pcm)))
		}
		fmt.Printf("player%d: %s | window ticks %d..%d (%.1fs wall) | wrote %s dur=%.1fs rms=%.0f nonzero=%.1f%%\n",
			fi+1, info, cs[s].tick, cs[e-1].tick, float64(cs[e-1].tick-cs[s].tick)/64,
			outPath, float64(len(pcm))/float64(bestRate), rms, 100*float64(nz)/float64(len(pcm)))
	}
}
