package source2

// Portions of this package follow ValveResourceFormat (MIT License, Copyright
// (c) 2015 ValveResourceFormat Contributors). The license text is in
// LICENSE-VRF.txt in this directory.

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"math"

	"github.com/klauspost/compress/zstd"
	"github.com/pierrec/lz4/v4"
)

// KV3 is a decoded binary KeyValues3 document (version 5 only in this spike).
//
// Node values are: nil (null), bool, int64 (signed widths), uint64 (unsigned),
// float64, string, []byte (binary blob), []any (array), map[string]any (object).
type KV3 struct {
	Version int
	Root    any
}

const (
	kv3Trailer     = 0xFFEEDD00
	kv3FrameSize   = 16384
	kv3ChainWindow = 65536
)

// Binary node types (VRF KV3BinaryNodeType).
const (
	nNull         = 1
	nBoolean      = 2
	nInt64        = 3
	nUint64       = 4
	nDouble       = 5
	nString       = 6
	nBinaryBlob   = 7
	nArray        = 8
	nObject       = 9
	nArrayTyped   = 10
	nInt32        = 11
	nUint32       = 12
	nBoolTrue     = 13
	nBoolFalse    = 14
	nInt64Zero    = 15
	nInt64One     = 16
	nDoubleZero   = 17
	nDoubleOne    = 18
	nFloat        = 19
	nInt16        = 20
	nUint16       = 21
	nInt8         = 22
	nUint8        = 23
	nArrayByteLen = 24
	nArrayAux     = 25
	nUint32Zero   = 26
	nUint32One    = 27
)

// lane is a consuming cursor over one typed byte lane.
type lane struct{ b []byte }

func (l *lane) take(n int) ([]byte, error) {
	if n < 0 || n > len(l.b) {
		return nil, fmt.Errorf("kv3: lane underrun (want %d, have %d)", n, len(l.b))
	}
	out := l.b[:n]
	l.b = l.b[n:]
	return out, nil
}

// buffers holds the four typed lanes of one decompressed buffer.
type buffers struct {
	b1, b2, b4, b8 lane
}

// header is the KV3 v5 header (after the magic).
type header struct {
	compression                           uint32
	countBytes1, countBytes4, countBytes8 int
	countTypes                            int
	countObjects                          int
	sizeUncompTotal, sizeCompTotal        int
	countBlocks, sizeBinaryBlobs          int
	countBytes2, sizeBlockCompSizes       int
	sizeUncompBuf1, sizeCompBuf1          int
	sizeUncompBuf2, sizeCompBuf2          int
	countBytes1Buf2, countBytes2Buf2      int
	countBytes4Buf2, countBytes8Buf2      int
	countObjectsBuf2                      int
}

type reader struct {
	b   []byte
	pos int
}

func (r *reader) need(n int) error {
	if n < 0 || r.pos+n > len(r.b) {
		return fmt.Errorf("kv3: read of %d bytes at %d past end %d", n, r.pos, len(r.b))
	}
	return nil
}

func (r *reader) u16() (uint16, error) {
	if err := r.need(2); err != nil {
		return 0, err
	}
	v := binary.LittleEndian.Uint16(r.b[r.pos:])
	r.pos += 2
	return v, nil
}

func (r *reader) u32() (uint32, error) {
	if err := r.need(4); err != nil {
		return 0, err
	}
	v := binary.LittleEndian.Uint32(r.b[r.pos:])
	r.pos += 4
	return v, nil
}

func (r *reader) i32() (int, error) {
	v, err := r.u32()
	return int(int32(v)), err
}

func (r *reader) bytes(n int) ([]byte, error) {
	if err := r.need(n); err != nil {
		return nil, err
	}
	out := r.b[r.pos : r.pos+n]
	r.pos += n
	return out, nil
}

func readHeader(r *reader, version int) (header, error) {
	var h header
	if _, err := r.bytes(16); err != nil { // format GUID (not needed to decode)
		return h, err
	}
	c, err := r.u32()
	if err != nil {
		return h, err
	}
	h.compression = c
	dict, err := r.u16()
	if err != nil {
		return h, err
	}
	if dict != 0 {
		return h, fmt.Errorf("kv3: compression dictionary %d unsupported", dict)
	}
	frame, err := r.u16()
	if err != nil {
		return h, err
	}
	if want := map[bool]uint16{true: kv3FrameSize, false: 0}[c == 1]; frame != want {
		return h, fmt.Errorf("kv3: frame size %d, want %d for compression %d", frame, want, c)
	}
	ints := []*int{&h.countBytes1, &h.countBytes4, &h.countBytes8, &h.countTypes}
	for _, p := range ints {
		if *p, err = r.i32(); err != nil {
			return h, err
		}
	}
	if _, err := r.u16(); err != nil { // countObjects (allocation hint)
		return h, err
	}
	if _, err := r.u16(); err != nil { // countArrays (allocation hint)
		return h, err
	}
	ints = []*int{&h.sizeUncompTotal, &h.sizeCompTotal, &h.countBlocks, &h.sizeBinaryBlobs}
	for _, p := range ints {
		if *p, err = r.i32(); err != nil {
			return h, err
		}
	}
	if h.countBytes2, err = r.i32(); err != nil {
		return h, err
	}
	if h.sizeBlockCompSizes, err = r.i32(); err != nil {
		return h, err
	}
	if version == 4 {
		// Version 4 has one buffer: the total sizes are the buffer's sizes.
		h.sizeUncompBuf1, h.sizeCompBuf1 = h.sizeUncompTotal, h.sizeCompTotal
		return h, nil
	}
	ints = []*int{&h.sizeUncompBuf1, &h.sizeCompBuf1, &h.sizeUncompBuf2, &h.sizeCompBuf2,
		&h.countBytes1Buf2, &h.countBytes2Buf2, &h.countBytes4Buf2, &h.countBytes8Buf2,
		new(int), &h.countObjectsBuf2, new(int), new(int)} // countNodes, countArrays, countArrayElements are hints
	for _, p := range ints {
		if *p, err = r.i32(); err != nil {
			return h, err
		}
	}
	if h.sizeUncompTotal != h.sizeUncompBuf1+h.sizeUncompBuf2 {
		return h, fmt.Errorf("kv3: uncompressed total %d != buffers %d+%d", h.sizeUncompTotal, h.sizeUncompBuf1, h.sizeUncompBuf2)
	}
	return h, nil
}

// readBuffer reads one buffer: raw when uncompressed, one LZ4 block (1), or
// one zstd frame (2).
func readBuffer(r *reader, compression uint32, uncomp, comp int) ([]byte, error) {
	if compression == 0 {
		return r.bytes(uncomp)
	}
	src, err := r.bytes(comp)
	if err != nil {
		return nil, err
	}
	if compression == 2 {
		d, err := zstd.NewReader(nil)
		if err != nil {
			return nil, err
		}
		defer d.Close()
		out, err := d.DecodeAll(src, make([]byte, 0, uncomp))
		if err != nil {
			return nil, fmt.Errorf("kv3: zstd buffer: %w", err)
		}
		if len(out) != uncomp {
			return nil, fmt.Errorf("kv3: zstd buffer decoded %d bytes, want %d", len(out), uncomp)
		}
		return out, nil
	}
	dst := make([]byte, uncomp)
	n, err := lz4.UncompressBlock(src, dst)
	if err != nil {
		return nil, err
	}
	if n != uncomp {
		return nil, fmt.Errorf("kv3: LZ4 buffer decoded %d bytes, want %d", n, uncomp)
	}
	return dst, nil
}

// parseBuffer1 splits buffer 1 into lanes and reads the string table.
func parseBuffer1(raw []byte, h header) (*buffers, []string, error) {
	b := &buffers{}
	off := 0
	take := func(n int) []byte { out := raw[off : off+n]; off += n; return out }
	alignTo := func(a int) { off = (off + a - 1) / a * a }
	var err error
	if h.countBytes1 > 0 {
		b.b1.b = take(h.countBytes1)
	}
	if h.countBytes2 > 0 {
		alignTo(2)
		b.b2.b = take(h.countBytes2 * 2)
	}
	if h.countBytes4 > 0 {
		alignTo(4)
		b.b4.b = take(h.countBytes4 * 4)
	}
	if h.countBytes8 > 0 {
		alignTo(8)
		b.b8.b = take(h.countBytes8 * 8)
	}
	if h.countBytes4 == 0 {
		return nil, nil, fmt.Errorf("kv3: buffer 1 has no string count lane")
	}
	countStrings, err := b.b4.take(4)
	if err != nil {
		return nil, nil, err
	}
	n := int(int32(binary.LittleEndian.Uint32(countStrings)))
	strs := make([]string, 0, n)
	for i := 0; i < n; i++ {
		end := 0
		for end < len(b.b1.b) && b.b1.b[end] != 0 {
			end++
		}
		if end >= len(b.b1.b) {
			return nil, nil, fmt.Errorf("kv3: string table overruns buffer 1")
		}
		strs = append(strs, string(b.b1.b[:end]))
		b.b1.b = b.b1.b[end+1:]
	}
	if off != len(raw) {
		return nil, nil, fmt.Errorf("kv3: buffer 1 has %d unparsed bytes", len(raw)-off)
	}
	return b, strs, err
}

// parseBuffer2 splits buffer 2 into the object-length lane, the main lanes,
// the type table, and (when there are binary blobs) the blob length and frame
// size tables that follow the types.
func parseBuffer2(raw []byte, h header) (*buffers, lane, []byte, []int, []byte, error) {
	var objLens lane
	off := 0
	take := func(n int) ([]byte, error) {
		if off+n > len(raw) {
			return nil, fmt.Errorf("kv3: buffer 2 underrun")
		}
		out := raw[off : off+n]
		off += n
		return out, nil
	}
	alignTo := func(a int) { off = (off + a - 1) / a * a }
	ol, err := take(h.countObjectsBuf2 * 4)
	if err != nil {
		return nil, objLens, nil, nil, nil, err
	}
	objLens.b = ol
	b := &buffers{}
	if h.countBytes1Buf2 > 0 {
		if b.b1.b, err = take(h.countBytes1Buf2); err != nil {
			return nil, objLens, nil, nil, nil, err
		}
	}
	if h.countBytes2Buf2 > 0 {
		alignTo(2)
		if b.b2.b, err = take(h.countBytes2Buf2 * 2); err != nil {
			return nil, objLens, nil, nil, nil, err
		}
	}
	if h.countBytes4Buf2 > 0 {
		alignTo(4)
		if b.b4.b, err = take(h.countBytes4Buf2 * 4); err != nil {
			return nil, objLens, nil, nil, nil, err
		}
	}
	if h.countBytes8Buf2 > 0 {
		alignTo(8)
		if b.b8.b, err = take(h.countBytes8Buf2 * 8); err != nil {
			return nil, objLens, nil, nil, nil, err
		}
	}
	types, err := take(h.countTypes)
	if err != nil {
		return nil, objLens, nil, nil, nil, err
	}
	if h.countBlocks == 0 {
		t, err := take(4)
		if err != nil {
			return nil, objLens, nil, nil, nil, err
		}
		if binary.LittleEndian.Uint32(t) != kv3Trailer {
			return nil, objLens, nil, nil, nil, fmt.Errorf("kv3: buffer 2 trailer missing")
		}
		return b, objLens, types, nil, nil, nil
	}
	// Blob lengths (i32 each), trailer, then u16 compressed frame sizes.
	rest := raw[off:]
	if len(rest) < h.countBlocks*4+4 {
		return nil, objLens, nil, nil, nil, fmt.Errorf("kv3: blob table truncated")
	}
	lens := make([]int, h.countBlocks)
	for i := range lens {
		lens[i] = int(int32(binary.LittleEndian.Uint32(rest[i*4:])))
	}
	rest = rest[h.countBlocks*4:]
	if binary.LittleEndian.Uint32(rest) != kv3Trailer {
		return nil, objLens, nil, nil, nil, fmt.Errorf("kv3: blob table trailer missing")
	}
	rest = rest[4:]
	return b, objLens, types, lens, rest, nil
}

// readBlobs fills the binary blobs from the stream (after both buffers).
func (d *decoder) readBlobs(r *reader, h header, lens []int, frames []byte, compression uint32) error {
	total := 0
	for _, n := range lens {
		if n < 0 {
			return fmt.Errorf("kv3: negative blob length")
		}
		total += n
	}
	if total != h.sizeBinaryBlobs {
		return fmt.Errorf("kv3: blob lengths total %d, want %d", total, h.sizeBinaryBlobs)
	}
	chain := make([]byte, total)
	d.blobs = make([][]byte, len(lens))
	pos := 0
	if compression == 2 {
		// One zstd stream covers every blob: its size is the total compressed
		// size minus the two buffers. Blobs are filled in order.
		size := h.sizeCompTotal - h.sizeCompBuf1 - h.sizeCompBuf2
		src, err := r.bytes(size)
		if err != nil {
			return err
		}
		zd, err := zstd.NewReader(bytes.NewReader(src))
		if err != nil {
			return err
		}
		defer zd.Close()
		if _, err := io.ReadFull(zd, chain); err != nil {
			return fmt.Errorf("kv3: zstd blobs: %w", err)
		}
		for i, n := range lens {
			d.blobs[i] = chain[pos : pos+n]
			pos += n
		}
	} else if compression == 0 {
		for i, n := range lens {
			src, err := r.bytes(n)
			if err != nil {
				return err
			}
			copy(chain[pos:], src)
			d.blobs[i] = chain[pos : pos+n]
			pos += n
		}
	} else {
		// LZ4 frames of up to kv3FrameSize, chained: each frame may refer to
		// up to kv3ChainWindow bytes of output before it, across blobs.
		for i, n := range lens {
			start := pos
			end := pos + n
			for pos < end {
				if len(frames) < 2 {
					return fmt.Errorf("kv3: frame size table exhausted")
				}
				cl := int(binary.LittleEndian.Uint16(frames))
				frames = frames[2:]
				src, err := r.bytes(cl)
				if err != nil {
					return err
				}
				dstEnd := pos + kv3FrameSize
				if dstEnd > end {
					dstEnd = end
				}
				dictStart := pos - kv3ChainWindow
				if dictStart < 0 {
					dictStart = 0
				}
				n, err := lz4.UncompressBlockWithDict(src, chain[pos:dstEnd], chain[dictStart:pos])
				if err != nil {
					return fmt.Errorf("kv3: blob frame: %w", err)
				}
				if n < 1 {
					return fmt.Errorf("kv3: empty blob frame")
				}
				pos += n
			}
			d.blobs[i] = chain[start:end]
		}
	}
	t, err := r.u32()
	if err != nil {
		return err
	}
	if t != kv3Trailer {
		return fmt.Errorf("kv3: blob trailer %#x", t)
	}
	return nil
}

type decoder struct {
	version  int
	strings  []string
	buf      *buffers // main lanes (buffer 2)
	aux      *buffers // auxiliary lanes (buffer 1)
	objLens  lane
	types    []byte
	blobs    [][]byte
	nextBlob int
}

// Decode parses one binary KV3 v5 document: the bytes of a DATA block or a
// CTRL block (the magic is the first four bytes).
func Decode(data []byte) (*KV3, error) {
	if len(data) < 4 {
		return nil, fmt.Errorf("kv3: too short")
	}
	magic := binary.LittleEndian.Uint32(data)
	if magic&0xFFFFFF00 != 0x4B563300 {
		return nil, fmt.Errorf("kv3: magic %#x is not binary KV3", magic)
	}
	version := int(magic & 0xFF)
	if version != 4 && version != 5 {
		return nil, fmt.Errorf("kv3: version %d unsupported (versions 4 and 5)", version)
	}
	r := &reader{b: data, pos: 4}
	h, err := readHeader(r, version)
	if err != nil {
		return nil, err
	}
	if h.compression > 2 {
		return nil, fmt.Errorf("kv3: compression %d unsupported (z3)", h.compression)
	}
	if version == 4 {
		return decodeV4(r, h)
	}
	raw1, err := readBuffer(r, h.compression, h.sizeUncompBuf1, h.sizeCompBuf1)
	if err != nil {
		return nil, fmt.Errorf("kv3: buffer 1: %w", err)
	}
	aux, strs, err := parseBuffer1(raw1, h)
	if err != nil {
		return nil, err
	}
	raw2, err := readBuffer(r, h.compression, h.sizeUncompBuf2, h.sizeCompBuf2)
	if err != nil {
		return nil, fmt.Errorf("kv3: buffer 2: %w", err)
	}
	mainBuf, objLens, types, lens, frames, err := parseBuffer2(raw2, h)
	if err != nil {
		return nil, err
	}
	d := &decoder{version: 5, strings: strs, buf: mainBuf, aux: aux, objLens: objLens, types: types}
	if h.countBlocks > 0 {
		if err := d.readBlobs(r, h, lens, frames, h.compression); err != nil {
			return nil, err
		}
	}
	t, err := d.readType()
	if err != nil {
		return nil, err
	}
	root, err := d.value(t.t, mainBuf)
	if err != nil {
		return nil, err
	}
	return &KV3{Version: version, Root: root}, nil
}

type typeInfo struct{ t, flag byte }

// readType consumes one type byte, and for v3+ its optional flag byte and the
// unused extra byte (flag 0x40).
func (d *decoder) readType() (typeInfo, error) {
	if len(d.types) == 0 {
		return typeInfo{}, fmt.Errorf("kv3: type table exhausted")
	}
	db := d.types[0]
	d.types = d.types[1:]
	var flag byte
	if db&0x80 != 0 {
		if len(d.types) == 0 {
			return typeInfo{}, fmt.Errorf("kv3: flag byte missing")
		}
		flag = d.types[0]
		d.types = d.types[1:]
	}
	if db&0x40 != 0 {
		d.types = d.types[1:]
	}
	return typeInfo{t: db & 0x3F, flag: flag}, nil
}

func (d *decoder) str(id int32) string {
	if id < 0 || int(id) >= len(d.strings) {
		return ""
	}
	return d.strings[id]
}

func (d *decoder) u32Main() (uint32, error) {
	b, err := d.buf.b4.take(4)
	if err != nil {
		return 0, err
	}
	return binary.LittleEndian.Uint32(b), nil
}

// value reads one value of node type t. Primitive values come from l; strings,
// blobs, container lengths and member names come from the main buffer.
func (d *decoder) value(t byte, l *buffers) (any, error) {
	prim := func(ln *lane, n int) ([]byte, error) { return ln.take(n) }
	switch t {
	case nNull:
		return nil, nil
	case nBoolTrue:
		return true, nil
	case nBoolFalse:
		return false, nil
	case nInt64Zero:
		return int64(0), nil
	case nInt64One:
		return int64(1), nil
	case nDoubleZero:
		return float64(0), nil
	case nDoubleOne:
		return float64(1), nil
	case nUint32Zero:
		return uint64(0), nil
	case nUint32One:
		return uint64(1), nil
	case nBoolean:
		b, err := prim(&l.b1, 1)
		return b[0] != 0, err
	case nInt8:
		b, err := prim(&l.b1, 1)
		return int64(int8(b[0])), err
	case nUint8:
		b, err := prim(&l.b1, 1)
		return uint64(b[0]), err
	case nInt16:
		b, err := prim(&l.b2, 2)
		return int64(int16(binary.LittleEndian.Uint16(b))), err
	case nUint16:
		b, err := prim(&l.b2, 2)
		return uint64(binary.LittleEndian.Uint16(b)), err
	case nInt32:
		b, err := prim(&l.b4, 4)
		return int64(int32(binary.LittleEndian.Uint32(b))), err
	case nUint32:
		b, err := prim(&l.b4, 4)
		return uint64(binary.LittleEndian.Uint32(b)), err
	case nFloat:
		b, err := prim(&l.b4, 4)
		return float64(math.Float32frombits(binary.LittleEndian.Uint32(b))), err
	case nInt64:
		b, err := prim(&l.b8, 8)
		return int64(binary.LittleEndian.Uint64(b)), err
	case nUint64:
		b, err := prim(&l.b8, 8)
		return binary.LittleEndian.Uint64(b), err
	case nDouble:
		b, err := prim(&l.b8, 8)
		return math.Float64frombits(binary.LittleEndian.Uint64(b)), err
	case nString:
		v, err := d.u32Main()
		return d.str(int32(v)), err
	case nBinaryBlob:
		if d.nextBlob >= len(d.blobs) {
			return nil, fmt.Errorf("kv3: blob index out of range")
		}
		d.nextBlob++
		return d.blobs[d.nextBlob-1], nil
	case nArray:
		n, err := d.u32Main()
		if err != nil {
			return nil, err
		}
		arr := make([]any, 0, int(n))
		for i := 0; i < int(n); i++ {
			if err := d.member(&arr, nil); err != nil {
				return nil, err
			}
		}
		return arr, nil
	case nArrayTyped, nArrayByteLen, nArrayAux:
		var n int
		if t == nArrayTyped {
			v, err := d.u32Main()
			if err != nil {
				return nil, err
			}
			n = int(v)
		} else {
			b, err := d.buf.b1.take(1)
			if err != nil {
				return nil, err
			}
			n = int(b[0])
		}
		sub, err := d.readType()
		if err != nil {
			return nil, err
		}
		el := d.buf
		if t == nArrayAux {
			el = d.aux
		}
		arr := make([]any, 0, n)
		for i := 0; i < n; i++ {
			v, err := d.value(sub.t, el)
			if err != nil {
				return nil, err
			}
			arr = append(arr, v)
		}
		return arr, nil
	case nObject:
		var b []byte
		var err error
		if d.version < 5 {
			// Before version 5 the object lengths are in the main buffer's 4-byte lane.
			b, err = l.b4.take(4)
		} else {
			b, err = d.objLens.take(4)
		}
		if err != nil {
			return nil, err
		}
		n := int(int32(binary.LittleEndian.Uint32(b)))
		obj := make(map[string]any, n)
		for i := 0; i < n; i++ {
			if err := d.member(nil, obj); err != nil {
				return nil, err
			}
		}
		return obj, nil
	}
	return nil, fmt.Errorf("kv3: unknown node type %d", t)
}

// member reads one entry: appended to arr when the parent is an array, else
// stored in obj under its name (a repeated name replaces the earlier value).
func (d *decoder) member(arr *[]any, obj map[string]any) error {
	t, err := d.readType()
	if err != nil {
		return err
	}
	if arr != nil {
		v, err := d.value(t.t, d.buf)
		if err != nil {
			return err
		}
		*arr = append(*arr, v)
		return nil
	}
	id, err := d.u32Main()
	if err != nil {
		return err
	}
	v, err := d.value(t.t, d.buf)
	if err != nil {
		return err
	}
	obj[d.str(int32(id))] = v
	return nil
}

// decodeV4 reads a version 4 binary KV3 document: one buffer holding the lanes,
// the strings, the types, and (with binary blobs) the blob tables. Blobs are LZ4
// frames after the buffer, or, with zstd, part of the buffer's single stream.
func decodeV4(r *reader, h header) (*KV3, error) {
	var raw []byte
	var err error
	zstdBlobs := h.compression == 2 && h.countBlocks > 0
	if zstdBlobs {
		// One zstd stream holds the buffer and then the blobs.
		src, err := r.bytes(h.sizeCompTotal)
		if err != nil {
			return nil, err
		}
		zd, err := zstd.NewReader(nil)
		if err != nil {
			return nil, err
		}
		defer zd.Close()
		raw, err = zd.DecodeAll(src, make([]byte, 0, h.sizeUncompTotal+h.sizeBinaryBlobs))
		if err != nil {
			return nil, fmt.Errorf("kv3: zstd buffer: %w", err)
		}
		if len(raw) != h.sizeUncompTotal+h.sizeBinaryBlobs {
			return nil, fmt.Errorf("kv3: zstd buffer decoded %d bytes, want %d", len(raw), h.sizeUncompTotal+h.sizeBinaryBlobs)
		}
	} else {
		raw, err = readBuffer(r, h.compression, h.sizeUncompTotal, h.sizeCompTotal)
		if err != nil {
			return nil, fmt.Errorf("kv3: buffer: %w", err)
		}
	}
	mainBuf, strs, types, lens, frames, err := parseBufferV4(raw, h)
	if err != nil {
		return nil, err
	}
	d := &decoder{version: 4, strings: strs, buf: mainBuf, aux: mainBuf, types: types}
	if h.countBlocks > 0 {
		if zstdBlobs {
			total := 0
			for _, n := range lens {
				if n < 0 {
					return nil, fmt.Errorf("kv3: negative blob length")
				}
				total += n
			}
			if total != h.sizeBinaryBlobs {
				return nil, fmt.Errorf("kv3: blob lengths total %d, want %d", total, h.sizeBinaryBlobs)
			}
			pos := h.sizeUncompTotal
			d.blobs = make([][]byte, len(lens))
			for i, n := range lens {
				d.blobs[i] = raw[pos : pos+n]
				pos += n
			}
			t, err := r.u32()
			if err != nil {
				return nil, err
			}
			if t != kv3Trailer {
				return nil, fmt.Errorf("kv3: blob trailer %#x", t)
			}
		} else if err := d.readBlobs(r, h, lens, frames, h.compression); err != nil {
			return nil, err
		}
	}
	t, err := d.readType()
	if err != nil {
		return nil, err
	}
	root, err := d.value(t.t, mainBuf)
	if err != nil {
		return nil, err
	}
	return &KV3{Version: 4, Root: root}, nil
}

// parseBufferV4 splits the single version 4 buffer: the lanes (aligned as in
// version 4), then the strings, then the types, then the blob tables.
func parseBufferV4(raw []byte, h header) (*buffers, []string, []byte, []int, []byte, error) {
	b := &buffers{}
	off := 0
	take := func(n int) ([]byte, error) {
		if n < 0 || off+n > len(raw) {
			return nil, fmt.Errorf("kv3: buffer underrun")
		}
		out := raw[off : off+n]
		off += n
		return out, nil
	}
	align := func(a int) { off = (off + a - 1) / a * a }
	var err error
	if h.countBytes1 > 0 {
		if b.b1.b, err = take(h.countBytes1); err != nil {
			return nil, nil, nil, nil, nil, err
		}
	}
	if h.countBytes2 > 0 {
		align(2)
		if b.b2.b, err = take(h.countBytes2 * 2); err != nil {
			return nil, nil, nil, nil, nil, err
		}
	}
	if h.countBytes4 > 0 {
		align(4)
		if b.b4.b, err = take(h.countBytes4 * 4); err != nil {
			return nil, nil, nil, nil, nil, err
		}
	}
	if h.countBytes8 > 0 {
		align(8)
		if b.b8.b, err = take(h.countBytes8 * 8); err != nil {
			return nil, nil, nil, nil, nil, err
		}
	} else {
		// Empty lanes are still aligned before version 5.
		align(8)
	}
	if h.countBytes4 == 0 {
		return nil, nil, nil, nil, nil, fmt.Errorf("kv3: buffer has no string count lane")
	}
	cs, err := b.b4.take(4)
	if err != nil {
		return nil, nil, nil, nil, nil, err
	}
	n := int(int32(binary.LittleEndian.Uint32(cs)))
	if n < 0 {
		return nil, nil, nil, nil, nil, fmt.Errorf("kv3: string count %d", n)
	}
	// Strings follow the lanes, each null-terminated.
	strs := make([]string, 0, n)
	stringsStart := off
	for i := 0; i < n; i++ {
		end := off
		for end < len(raw) && raw[end] != 0 {
			end++
		}
		if end >= len(raw) {
			return nil, nil, nil, nil, nil, fmt.Errorf("kv3: string table overruns the buffer")
		}
		strs = append(strs, string(raw[off:end]))
		off = end + 1
	}
	// The types run to the end of CountTypes, measured from the strings' start.
	typesLen := h.countTypes - (off - stringsStart)
	types, err := take(typesLen)
	if err != nil {
		return nil, nil, nil, nil, nil, fmt.Errorf("kv3: types: %w", err)
	}
	if h.countBlocks == 0 {
		t, err := take(4)
		if err != nil {
			return nil, nil, nil, nil, nil, err
		}
		if binary.LittleEndian.Uint32(t) != kv3Trailer {
			return nil, nil, nil, nil, nil, fmt.Errorf("kv3: buffer trailer missing")
		}
		return b, strs, types, nil, nil, nil
	}
	rest := raw[off:]
	if len(rest) < h.countBlocks*4+4 {
		return nil, nil, nil, nil, nil, fmt.Errorf("kv3: blob table truncated")
	}
	lens := make([]int, h.countBlocks)
	for i := range lens {
		lens[i] = int(int32(binary.LittleEndian.Uint32(rest[i*4:])))
	}
	rest = rest[h.countBlocks*4:]
	if binary.LittleEndian.Uint32(rest) != kv3Trailer {
		return nil, nil, nil, nil, nil, fmt.Errorf("kv3: blob table trailer missing")
	}
	return b, strs, types, lens, rest[4:], nil
}
