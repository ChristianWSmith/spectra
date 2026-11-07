package mappack

import (
	"encoding/binary"
	"fmt"
	"image"

	"github.com/klauspost/compress/zstd"
	"github.com/pierrec/lz4/v4"
)

// Source 2 vtex_c decoder: resource container → texture header → pixel
// data → image.NRGBA. The container layout (28-byte header, block index
// with position-relative offsets, DATA block) follows
// https://s2v.app/ValveResourceFormat/guides/read-resource.html and the
// texture header follows VRF's Texture.Read; enum values come from
// VTexFormat/VTexExtraData. CS2 radars are 1024×1024, 1 mip, either
// BGRA8888 (format 28) or DXT5 (format 2) with an LZ4-compressed mip —
// verified across every *_radar_psd.vtex_c in pak01_dir.vpk (CS2.md).

// VTexFormat values used here (VTexFormat.cs).
const (
	vtexFormatDXT5     = 2
	vtexFormatRGBA8888 = 4
	vtexFormatBGRA8888 = 28
)

// COMPRESSED_MIP_SIZE (extra data type 4) compression methods.
const (
	mipCompressNone = 0
	mipCompressLZ4  = 1
	mipCompressZstd = 2
)

// resourceBlock parses a Source 2 resource container (16-byte header:
// fileSize, headerVersion, version, blockOffset, blockCount) and returns
// the offset and size of the block named by fourCC. The block index is a
// run of 12-byte entries {FourCC, rel offset, size} where the offset is
// relative to the position of the offset field itself (s2v.app
// read-resource guide). The ONE block-table parser: decodeVTex (textures),
// decodeVSVG (equipment silhouettes) and decodeVSnd (audio — the CTRL
// block of a v5 .vsnd_c) share it.
// kind prefixes error messages with the caller's resource name.
func resourceBlock(data []byte, fourCC, kind string) (off, size int, err error) {
	const resHeaderSize = 16
	if len(data) < resHeaderSize {
		return 0, 0, fmt.Errorf("%s: %d bytes is too short for a header", kind, len(data))
	}
	blockCount := int(binary.LittleEndian.Uint32(data[12:16]))
	tablePos := int(8 + binary.LittleEndian.Uint32(data[8:12]))
	found := false
	for i := 0; i < blockCount; i++ {
		p := tablePos + i*12
		if p+12 > len(data) {
			return 0, 0, fmt.Errorf("%s: block table overruns file", kind)
		}
		if string(data[p:p+4]) == fourCC {
			off = p + 4 + int(binary.LittleEndian.Uint32(data[p+4:p+8]))
			size = int(binary.LittleEndian.Uint32(data[p+8 : p+12]))
			found = true
		}
	}
	if !found || off < 0 || size < 0 || off+size > len(data) {
		return 0, 0, fmt.Errorf("%s: missing or truncated %s block", kind, fourCC)
	}
	return off, size, nil
}

// resourceDataBlock is resourceBlock for the DATA block — the texture and
// silhouette decoders keep their call sites so the block-table walk itself
// stays in one place (resourceBlock).
func resourceDataBlock(data []byte, kind string) (off, size int, err error) {
	return resourceBlock(data, "DATA", kind)
}

// decodeVTex parses a Source 2 texture resource and returns mip 0 (the
// full-resolution image) as NRGBA.
func decodeVTex(data []byte) (*image.NRGBA, error) {
	// --- resource container header (16 bytes: fileSize, headerVersion,
	// version, blockOffset, blockCount) ---
	const resHeaderSize = 16
	if len(data) < resHeaderSize {
		return nil, fmt.Errorf("vtex: %d bytes is too short for a header", len(data))
	}
	if headerVersion := binary.LittleEndian.Uint16(data[4:6]); headerVersion != 12 {
		return nil, fmt.Errorf("vtex: header version %d (want 12)", headerVersion)
	}
	dataOff, dataSize, err := resourceDataBlock(data, "vtex")
	if err != nil {
		return nil, err
	}
	if dataSize < 40 {
		return nil, fmt.Errorf("vtex: missing or truncated DATA block")
	}

	// --- texture header inside the DATA block (VRF Texture.Read) ---
	d := data[dataOff : dataOff+dataSize]
	if ver := binary.LittleEndian.Uint16(d[0:2]); ver != 1 {
		return nil, fmt.Errorf("vtex: texture version %d (want 1)", ver)
	}
	width := int(binary.LittleEndian.Uint16(d[20:22]))
	height := int(binary.LittleEndian.Uint16(d[22:24]))
	depth := int(binary.LittleEndian.Uint16(d[24:26]))
	format := int(d[26])
	numMips := int(d[27])
	if width <= 0 || height <= 0 || depth <= 0 {
		return nil, fmt.Errorf("vtex: bad dimensions %dx%dx%d", width, height, depth)
	}
	if numMips < 1 {
		return nil, fmt.Errorf("vtex: numMips=%d", numMips)
	}

	// Extra data: extraDataOffset(u32)@32, extraDataCount(u32)@36; the
	// table starts at 40 + (extraDataOffset - 8), entries are
	// {type(u32), offset(u32), size(u32)} with payload at
	// entryEnd + offset - 8 (VRF: position after the 12-byte entry,
	// then += offset - 8).
	mipMethod := uint32(mipCompressNone)
	var compressedSizes []int
	extraDataOffset := int(binary.LittleEndian.Uint32(d[32:36]))
	extraDataCount := int(binary.LittleEndian.Uint32(d[36:40]))
	pos := dataOff + 40 + (extraDataOffset - 8)
	for i := 0; i < extraDataCount; i++ {
		if pos+12 > len(data) {
			return nil, fmt.Errorf("vtex: extra data table overruns file")
		}
		etype := binary.LittleEndian.Uint32(data[pos : pos+4])
		eoff := int(binary.LittleEndian.Uint32(data[pos+4 : pos+8]))
		next := pos + 12
		if etype == 4 { // COMPRESSED_MIP_SIZE
			base := next + eoff - 8
			if base+12 > len(data) {
				return nil, fmt.Errorf("vtex: compressed mip table overruns file")
			}
			method := binary.LittleEndian.Uint32(data[base : base+4])
			mipsOff := int(binary.LittleEndian.Uint32(data[base+4 : base+8]))
			mips := int(binary.LittleEndian.Uint32(data[base+8 : base+12]))
			switch method {
			case mipCompressNone, mipCompressLZ4, mipCompressZstd:
			default:
				return nil, fmt.Errorf("vtex: unknown mip compression method %d", method)
			}
			mipMethod = method
			if mips > 0 {
				if mips > numMips {
					mips = numMips
				}
				// sizes array at (after the 12-byte header) + mipsOff - 8
				sizesAt := base + 4 + mipsOff
				if sizesAt+4*mips > len(data) {
					return nil, fmt.Errorf("vtex: mip size array overruns file")
				}
				compressedSizes = make([]int, mips)
				for m := 0; m < mips; m++ {
					compressedSizes[m] = int(int32(binary.LittleEndian.Uint32(
						data[sizesAt+4*m : sizesAt+4*m+4])))
				}
			}
		}
		pos = next
	}

	// --- pixel data: mips stored smallest-first after the DATA block ---
	pix := data[dataOff+dataSize:]
	return readMip0(pix, width, height, format, numMips, compressedSizes, mipMethod)
}

// readMip0 skips the smaller mips (stored first), decompresses mip 0 if
// needed, and decodes it to NRGBA.
func readMip0(pix []byte, w, h, format, numMips int, compressed []int, method uint32) (*image.NRGBA, error) {
	bpp := pixelBPP(format)
	if bpp == 0 {
		return nil, fmt.Errorf("vtex: unsupported format %d", format)
	}
	uncompressed := imageSize(w, h, bpp)

	// Skip smaller mips (mip m is w>>m × h>>m); stored size is the
	// compressed length when compression kicked in for that mip.
	skip := 0
	for m := numMips - 1; m >= 1; m-- {
		u := imageSize(w>>m, h>>m, bpp)
		sz := u
		if m < len(compressed) && compressed[m] > 0 && compressed[m] < u {
			sz = compressed[m]
		}
		skip += sz
	}
	if skip > len(pix) {
		return nil, fmt.Errorf("vtex: mip skip %d exceeds %d pixel bytes", skip, len(pix))
	}
	body := pix[skip:]

	// Mip 0: stored compressed when that is smaller than uncompressed.
	stored := uncompressed
	if len(compressed) > 0 && compressed[0] > 0 && compressed[0] < uncompressed {
		stored = compressed[0]
	}
	if stored > len(body) {
		return nil, fmt.Errorf("vtex: mip0 needs %d bytes, have %d", stored, len(body))
	}
	raw := body[:stored]
	if stored < uncompressed {
		dec := make([]byte, uncompressed)
		switch method {
		case mipCompressLZ4:
			n, err := lz4.UncompressBlock(raw, dec)
			if err != nil {
				return nil, fmt.Errorf("vtex: lz4: %w", err)
			}
			if n != uncompressed {
				return nil, fmt.Errorf("vtex: lz4 decoded %d bytes, want %d", n, uncompressed)
			}
		case mipCompressZstd:
			out, err := zstdDecompress(raw, uncompressed)
			if err != nil {
				return nil, fmt.Errorf("vtex: zstd: %w", err)
			}
			dec = out
		default:
			return nil, fmt.Errorf("vtex: mip compressed but method is %d", method)
		}
		raw = dec
	}
	return decodePixels(raw, w, h, format)
}

// zstdDecompress expands a single Zstd-compressed mip.
func zstdDecompress(src []byte, want int) ([]byte, error) {
	d, err := zstd.NewReader(nil)
	if err != nil {
		return nil, err
	}
	defer d.Close()
	out, err := d.DecodeAll(src, make([]byte, 0, want))
	if err != nil {
		return nil, err
	}
	if len(out) != want {
		return nil, fmt.Errorf("zstd decoded %d bytes, want %d", len(out), want)
	}
	return out, nil
}

// pixelBPP returns bytes per pixel for linear formats, or bytes per 4×4
// block (16) for DXT5; 0 when unsupported.
func pixelBPP(format int) int {
	switch format {
	case vtexFormatBGRA8888, vtexFormatRGBA8888:
		return 4
	case vtexFormatDXT5:
		return 16
	default:
		return 0
	}
}

// imageSize is the stored byte size of a w×h image at bpp (block sizes
// round dimensions up to 4).
func imageSize(w, h, bpp int) int {
	if bpp == 16 {
		bw, bh := (w+3)/4, (h+3)/4
		if bw < 1 {
			bw = 1
		}
		if bh < 1 {
			bh = 1
		}
		return bw * bh * 16
	}
	return w * h * bpp
}

// decodePixels converts raw top-level pixels to NRGBA.
func decodePixels(raw []byte, w, h, format int) (*image.NRGBA, error) {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	switch format {
	case vtexFormatBGRA8888:
		want := w * h * 4
		if len(raw) < want {
			return nil, fmt.Errorf("vtex: BGRA data %d < %d", len(raw), want)
		}
		for i := 0; i < w*h; i++ {
			o := i * 4
			img.Pix[o+0] = raw[o+2] // R
			img.Pix[o+1] = raw[o+1] // G
			img.Pix[o+2] = raw[o+0] // B
			img.Pix[o+3] = raw[o+3] // A
		}
		return img, nil
	case vtexFormatRGBA8888:
		want := w * h * 4
		if len(raw) < want {
			return nil, fmt.Errorf("vtex: RGBA data %d < %d", len(raw), want)
		}
		copy(img.Pix, raw[:want])
		return img, nil
	case vtexFormatDXT5:
		if err := decodeDXT5(raw, img); err != nil {
			return nil, err
		}
		return img, nil
	}
	return nil, fmt.Errorf("vtex: unsupported format %d", format)
}

// decodeDXT5 decodes BC3/DXT5 blocks (16 bytes per 4×4: 8 bytes alpha —
// two endpoints + 3-bit indices — then a BC1 color block) into img.
func decodeDXT5(raw []byte, img *image.NRGBA) error {
	w, h := img.Bounds().Dx(), img.Bounds().Dy()
	bw, bh := (w+3)/4, (h+3)/4
	want := bw * bh * 16
	if len(raw) < want {
		return fmt.Errorf("vtex: DXT5 data %d < %d", len(raw), want)
	}
	var blk [16]byte
	for by := 0; by < bh; by++ {
		for bx := 0; bx < bw; bx++ {
			copy(blk[:], raw[(by*bw+bx)*16:])
			decodeDXT5Block(&blk, img, bx*4, by*4, w, h)
		}
	}
	return nil
}

func decodeDXT5Block(blk *[16]byte, img *image.NRGBA, x0, y0, w, h int) {
	// Alpha palette: two endpoints + interpolated values — 6 steps when
	// a0 > a1, else 4 steps + 0 + 255.
	a0, a1 := blk[0], blk[1]
	var alpha [8]byte
	alpha[0], alpha[1] = a0, a1
	if a0 > a1 {
		for i := 1; i <= 6; i++ {
			alpha[1+i] = byte((int(a0)*(7-i) + int(a1)*i) / 7)
		}
	} else {
		for i := 1; i <= 4; i++ {
			alpha[1+i] = byte((int(a0)*(5-i) + int(a1)*i) / 5)
		}
		alpha[6], alpha[7] = 0, 255
	}
	// 48-bit little-endian alpha indices, 3 bits per texel.
	var alphaBits uint64
	for i := 0; i < 6; i++ {
		alphaBits |= uint64(blk[2+i]) << (8 * i)
	}

	// Color palette: RGB565 endpoints; 4 colors when c0 > c1, else
	// 3 colors + black (BC1 opaque modes — alpha comes from above).
	c0 := binary.LittleEndian.Uint16(blk[8:10])
	c1 := binary.LittleEndian.Uint16(blk[10:12])
	r0, g0, b0 := rgb565(c0)
	r1, g1, b1 := rgb565(c1)
	var pal [4][3]byte
	pal[0] = [3]byte{r0, g0, b0}
	pal[1] = [3]byte{r1, g1, b1}
	if c0 > c1 {
		pal[2] = [3]byte{
			byte((2*int(r0) + int(r1)) / 3),
			byte((2*int(g0) + int(g1)) / 3),
			byte((2*int(b0) + int(b1)) / 3),
		}
		pal[3] = [3]byte{
			byte((int(r0) + 2*int(r1)) / 3),
			byte((int(g0) + 2*int(g1)) / 3),
			byte((int(b0) + 2*int(b1)) / 3),
		}
	} else {
		pal[2] = [3]byte{
			byte((int(r0) + int(r1)) / 2),
			byte((int(g0) + int(g1)) / 2),
			byte((int(b0) + int(b1)) / 2),
		}
		pal[3] = [3]byte{0, 0, 0}
	}
	colorBits := binary.LittleEndian.Uint32(blk[12:16])

	for t := 0; t < 16; t++ {
		x, y := x0+t%4, y0+t/4
		if x >= w || y >= h {
			continue
		}
		a := alpha[(alphaBits>>(3*t))&7]
		c := pal[(colorBits>>(2*t))&3]
		o := img.PixOffset(x, y)
		img.Pix[o+0] = c[0]
		img.Pix[o+1] = c[1]
		img.Pix[o+2] = c[2]
		img.Pix[o+3] = a
	}
}

func rgb565(v uint16) (r, g, b byte) {
	r5 := uint32(v >> 11)
	g6 := uint32((v >> 5) & 0x3f)
	b5 := uint32(v & 0x1f)
	return byte(r5<<3 | r5>>2), byte(g6<<2 | g6>>4), byte(b5<<3 | b5>>2)
}
