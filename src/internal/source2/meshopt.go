package source2

import (
	"errors"
	"fmt"
	"math/bits"
)

// Decoders for meshoptimizer's vertex and index codecs, as used by Source 2
// MVTX and MIDX blocks. A Go port of the scalar paths of the decoders in
// ValveResourceFormat (MIT, Compression/MeshOptimizerVertexDecoder.cs and
// MeshOptimizerIndexDecoder.cs), which follow meshoptimizer's vertexcodec.cpp and
// indexcodec.cpp. Malformed input returns an error, never a panic.

const (
	meshoptVertexHeader   = 0xa0
	meshoptVertexVersion  = 1
	meshoptVertexBlockMax = 256
	meshoptVertexBlockB   = 8192
	meshoptByteGroup      = 16
	meshoptGroupLimit     = 24
	meshoptTailMinV0      = 32
	meshoptTailMinV1      = 24
	meshoptIndexHeader    = 0xe0
	meshoptIndexVersion   = 1
)

var meshoptBitsV0 = []int{0, 2, 4, 8}
var meshoptBitsV1 = []int{0, 1, 2, 4, 8}

// DecodeVertexBuffer decodes a meshoptimizer vertex buffer of vertexCount
// vertices, each vertexSize bytes (a multiple of 4).
func DecodeVertexBuffer(vertexCount, vertexSize int, buf []byte) (out []byte, err error) {
	defer recoverMeshopt(&err)
	if vertexSize <= 0 || vertexSize > 256 || vertexSize%4 != 0 {
		return nil, fmt.Errorf("meshopt: vertex size %d", vertexSize)
	}
	if len(buf) < 1 || buf[0]&0xF0 != meshoptVertexHeader {
		return nil, errors.New("meshopt: bad vertex header")
	}
	version := int(buf[0] & 0x0F)
	if version > meshoptVertexVersion {
		return nil, fmt.Errorf("meshopt: vertex version %d", version)
	}
	buf = buf[1:]
	tailSize := vertexSize
	if version != 0 {
		tailSize += vertexSize / 4
	}
	tailMin := meshoptTailMinV0
	if version != 0 {
		tailMin = meshoptTailMinV1
	}
	tailPad := tailSize
	if tailPad < tailMin {
		tailPad = tailMin
	}
	if len(buf) < tailPad {
		return nil, errors.New("meshopt: vertex buffer too small for tail")
	}
	result := make([]byte, vertexCount*vertexSize)
	lastVertex := make([]byte, vertexSize)
	copy(lastVertex, buf[len(buf)-tailSize:len(buf)-tailSize+vertexSize])
	var channels []byte
	if version != 0 {
		channels = buf[len(buf)-tailSize+vertexSize : len(buf)-tailSize+vertexSize+vertexSize/4]
	}
	blockSize := (meshoptVertexBlockB / vertexSize) &^ (meshoptByteGroup - 1)
	if blockSize > meshoptVertexBlockMax {
		blockSize = meshoptVertexBlockMax
	}
	off := 0
	for off < vertexCount {
		n := blockSize
		if off+n > vertexCount {
			n = vertexCount - off
		}
		buf, err = decodeVertexBlock(buf, result[off*vertexSize:], n, vertexSize, lastVertex, channels, version)
		if err != nil {
			return nil, err
		}
		off += n
	}
	if len(buf) != tailPad {
		return nil, errors.New("meshopt: vertex tail size incorrect")
	}
	return result, nil
}

// DecodeIndexBuffer decodes a meshoptimizer index buffer of indexCount indices
// (a multiple of 3), each indexSize bytes (2 or 4), into little-endian indices.
func DecodeIndexBuffer(indexCount, indexSize int, buf []byte) (out []byte, err error) {
	defer recoverMeshopt(&err)
	if indexCount%3 != 0 {
		return nil, errors.New("meshopt: index count not a multiple of 3")
	}
	if indexSize != 2 && indexSize != 4 {
		return nil, fmt.Errorf("meshopt: index size %d", indexSize)
	}
	dataOffset := 1 + indexCount/3
	if len(buf) < dataOffset+16 {
		return nil, errors.New("meshopt: index buffer too short")
	}
	if buf[0]&0xF0 != meshoptIndexHeader {
		return nil, errors.New("meshopt: bad index header")
	}
	version := int(buf[0] & 0x0F)
	if version > meshoptIndexVersion {
		return nil, fmt.Errorf("meshopt: index version %d", version)
	}
	var edgeFifo [16][2]uint32
	var vertexFifo [16]uint32
	edgeOff, vertexOff := 0, 0
	var next, last uint32
	fecmax := 15
	if version >= 1 {
		fecmax = 13
	}
	code := buf[1:dataOffset]
	data := buf[dataOffset:]
	position := 0
	dataSafeEnd := len(data) - 16
	codeaux := data[dataSafeEnd:]
	dst := make([]byte, indexCount*indexSize)
	w := 0
	write := func(a, b, c uint32) {
		if indexSize == 2 {
			put16(dst[w:], uint16(a))
			put16(dst[w+2:], uint16(b))
			put16(dst[w+4:], uint16(c))
			w += 6
			return
		}
		put32(dst[w:], a)
		put32(dst[w+4:], b)
		put32(dst[w+8:], c)
		w += 12
	}
	pushEdge := func(a, b uint32) {
		edgeFifo[edgeOff] = [2]uint32{a, b}
		edgeOff = (edgeOff + 1) & 15
	}
	pushVertex := func(v uint32, cond bool) {
		vertexFifo[vertexOff] = v
		if cond {
			vertexOff = (vertexOff + 1) & 15
		}
	}
	for _, codetri := range code {
		if codetri < 0xf0 {
			fe := int(codetri >> 4)
			ab := edgeFifo[(edgeOff-1-fe)&15]
			a, b := ab[0], ab[1]
			var c uint32
			fec := int(codetri & 15)
			if fec < fecmax {
				cf := vertexFifo[(vertexOff-1-fec)&15]
				if fec == 0 {
					c = next
				} else {
					c = cf
				}
				fec0 := fec == 0
				if fec0 {
					next++
				}
				pushVertex(c, fec0)
			} else {
				if position > dataSafeEnd {
					return nil, errors.New("meshopt: index data truncated")
				}
				if fec != 15 {
					last = last + uint32(int32(fec*2-27))
					c = last
				} else {
					last = decodeIndex(data, last, &position)
					c = last
				}
				pushVertex(c, true)
			}
			pushEdge(c, b)
			pushEdge(a, c)
			write(a, b, c)
		} else if codetri < 0xfe {
			ca := codeaux[codetri&15]
			feb := int(ca >> 4)
			fec := int(ca & 15)
			a := next
			next++
			bf := vertexFifo[(vertexOff-feb)&15]
			var b uint32
			if feb == 0 {
				b = next
			} else {
				b = bf
			}
			feb0 := feb == 0
			if feb0 {
				next++
			}
			cf := vertexFifo[(vertexOff-fec)&15]
			var c uint32
			if fec == 0 {
				c = next
			} else {
				c = cf
			}
			fec0 := fec == 0
			if fec0 {
				next++
			}
			write(a, b, c)
			pushVertex(a, true)
			pushVertex(b, feb0)
			pushVertex(c, fec0)
			pushEdge(b, a)
			pushEdge(c, b)
			pushEdge(a, c)
		} else {
			if position > dataSafeEnd {
				return nil, errors.New("meshopt: index data truncated")
			}
			ca := data[position]
			position++
			fea := 15
			if codetri == 0xfe {
				fea = 0
			}
			feb := int(ca >> 4)
			fec := int(ca & 15)
			if ca == 0 {
				next = 0
			}
			var a, b, c uint32
			if fea == 0 {
				a = next
				next++
			}
			if feb == 0 {
				b = next
				next++
			} else {
				b = vertexFifo[(vertexOff-feb)&15]
			}
			if fec == 0 {
				c = next
				next++
			} else {
				c = vertexFifo[(vertexOff-fec)&15]
			}
			if fea == 15 {
				last = decodeIndex(data, last, &position)
				a = last
			}
			if feb == 15 {
				last = decodeIndex(data, last, &position)
				b = last
			}
			if fec == 15 {
				last = decodeIndex(data, last, &position)
				c = last
			}
			write(a, b, c)
			pushVertex(a, true)
			pushVertex(b, feb == 0 || feb == 15)
			pushVertex(c, fec == 0 || fec == 15)
			pushEdge(b, a)
			pushEdge(c, b)
			pushEdge(a, c)
		}
	}
	if position != dataSafeEnd {
		return nil, errors.New("meshopt: index data malformed")
	}
	return dst, nil
}

func decodeIndex(data []byte, last uint32, position *int) uint32 {
	v := decodeVByte(data, position)
	d := (v >> 1) ^ (0 - (v & 1))
	return last + d
}

func decodeVByte(data []byte, position *int) uint32 {
	lead := uint32(data[*position])
	*position++
	if lead < 128 {
		return lead
	}
	result := lead & 127
	shift := 7
	for i := 0; i < 4; i++ {
		group := uint32(data[*position])
		*position++
		result |= (group & 127) << shift
		shift += 7
		if group < 128 {
			break
		}
	}
	return result
}

func decodeVertexBlock(data, vertexData []byte, vertexCount, vertexSize int, lastVertex, channels []byte, version int) ([]byte, error) {
	if vertexCount <= 0 || vertexCount > meshoptVertexBlockMax {
		return nil, errors.New("meshopt: bad vertex block count")
	}
	countAligned := (vertexCount + meshoptByteGroup - 1) &^ (meshoptByteGroup - 1)
	controlSize := 0
	if version != 0 {
		controlSize = vertexSize / 4
	}
	if len(data) < controlSize {
		return nil, errors.New("meshopt: control data too small")
	}
	control := data[:controlSize]
	data = data[controlSize:]
	buffer := make([]byte, meshoptVertexBlockMax*4)
	transposed := make([]byte, meshoptVertexBlockB)
	var err error
	for k := 0; k < vertexSize; k += 4 {
		var ctrlByte byte
		if version != 0 {
			ctrlByte = control[k/4]
		}
		for j := 0; j < 4; j++ {
			ctrl := (ctrlByte >> (j * 2)) & 3
			seg := buffer[j*vertexCount : j*vertexCount+vertexCount]
			switch ctrl {
			case 3:
				if len(data) < vertexCount {
					return nil, errors.New("meshopt: literal data too small")
				}
				copy(seg, data[:vertexCount])
				data = data[vertexCount:]
			case 2:
				clear(seg)
			default:
				bitsSel := meshoptBitsV0
				if version != 0 {
					bitsSel = meshoptBitsV1[ctrl:]
				}
				data, err = decodeBytes(data, buffer[j*vertexCount:j*vertexCount+countAligned], bitsSel)
				if err != nil {
					return nil, err
				}
			}
		}
		var channel byte
		if version != 0 {
			channel = channels[k/4]
		}
		switch channel & 3 {
		case 0:
			decodeDeltas1(1, buffer, transposed[k:], vertexCount, vertexSize, lastVertex[k:], 0)
		case 1:
			decodeDeltas1(2, buffer, transposed[k:], vertexCount, vertexSize, lastVertex[k:], 0)
		case 2:
			decodeDeltas1(4, buffer, transposed[k:], vertexCount, vertexSize, lastVertex[k:], (32-int(channel>>4))&31)
		default:
			return nil, errors.New("meshopt: invalid channel type")
		}
	}
	copy(vertexData, transposed[:vertexCount*vertexSize])
	copy(lastVertex, transposed[vertexSize*(vertexCount-1):vertexSize*(vertexCount-1)+vertexSize])
	return data, nil
}

func decodeBytes(data, buffer []byte, bitsSel []int) ([]byte, error) {
	if len(buffer)%meshoptByteGroup != 0 {
		return nil, errors.New("meshopt: group size")
	}
	groups := len(buffer) / meshoptByteGroup
	headerSize := (groups + 3) / 4
	if len(data) < headerSize {
		return nil, errors.New("meshopt: header too small")
	}
	header := data[:headerSize]
	data = data[headerSize:]
	var err error
	for i := 0; i < len(buffer); i += meshoptByteGroup {
		if len(data) < meshoptGroupLimit {
			return nil, errors.New("meshopt: cannot decode group")
		}
		ho := i / meshoptByteGroup
		bk := (header[ho/4] >> ((ho % 4) * 2)) & 3
		data, err = decodeBytesGroup(data, buffer[i:], bitsSel[bk])
		if err != nil {
			return nil, err
		}
	}
	return data, nil
}

// decodeBytesGroup decodes one group of 16 bytes at the given bit width.
func decodeBytesGroup(data, buffer []byte, nbits int) ([]byte, error) {
	switch nbits {
	case 0:
		clear(buffer[:meshoptByteGroup])
		return data, nil
	case 1:
		dataVar := 2
		var b byte
		spread := func(x byte) byte {
			return byte(((uint64(x) * 0x80200802) & 0x0884422110) * 0x0101010101 >> 32)
		}
		next := func(n uint, encv byte) byte {
			enc := b >> (8 - n)
			b <<= n
			if enc == byte((1<<n)-1) {
				dataVar++
				return encv
			}
			return enc
		}
		b = spread(data[0])
		for i := 0; i < 8; i++ {
			buffer[i] = next(1, data[dataVar])
		}
		b = spread(data[1])
		for i := 8; i < 16; i++ {
			buffer[i] = next(1, data[dataVar])
		}
		return data[dataVar:], nil
	case 2:
		dataVar := 4
		var b byte
		next := func(encv byte) byte {
			enc := b >> 6
			b <<= 2
			if enc == 3 {
				dataVar++
				return encv
			}
			return enc
		}
		for g := 0; g < 4; g++ {
			b = data[g]
			for i := 0; i < 4; i++ {
				buffer[g*4+i] = next(data[dataVar])
			}
		}
		return data[dataVar:], nil
	case 4:
		dataVar := 8
		var b byte
		next := func(encv byte) byte {
			enc := b >> 4
			b <<= 4
			if enc == 15 {
				dataVar++
				return encv
			}
			return enc
		}
		for g := 0; g < 8; g++ {
			b = data[g]
			buffer[g*2] = next(data[dataVar])
			buffer[g*2+1] = next(data[dataVar])
		}
		return data[dataVar:], nil
	case 8:
		copy(buffer[:meshoptByteGroup], data[:meshoptByteGroup])
		return data[meshoptByteGroup:], nil
	}
	return nil, errors.New("meshopt: unexpected bit length")
}

// decodeDeltas1 undoes the per-byte-lane delta coding of one channel group.
func decodeDeltas1(size int, buffer, transposed []byte, vertexCount, vertexSize int, lastVertex []byte, rot int) []byte {
	for k := 0; k < 4; k += size {
		vertexOffset := k
		var p uint32
		for j := 0; j < size; j++ {
			p |= uint32(lastVertex[j]) << (8 * j)
		}
		for i := 0; i < vertexCount; i++ {
			v := uint32(buffer[i])
			for j := 1; j < size; j++ {
				v |= uint32(buffer[i+vertexCount*j]) << (8 * j)
			}
			switch size {
			case 1:
				v = uint32(unzigzag8(byte(v))) + p
			case 2:
				v = uint32(unzigzag16(uint16(v))) + p
			default:
				v = bits.RotateLeft32(v, rot) ^ p
			}
			for j := 0; j < size; j++ {
				transposed[vertexOffset+j] = byte(v >> (8 * j))
			}
			p = v
			vertexOffset += vertexSize
		}
		buffer = buffer[vertexCount*size:]
		lastVertex = lastVertex[size:]
	}
	return buffer
}

func unzigzag8(v byte) byte      { return (0 - (v & 1)) ^ (v >> 1) }
func unzigzag16(v uint16) uint16 { return (0 - (v & 1)) ^ (v >> 1) }

func recoverMeshopt(err *error) {
	if r := recover(); r != nil {
		*err = fmt.Errorf("meshopt: malformed data: %v", r)
	}
}

func put16(b []byte, v uint16) { b[0], b[1] = byte(v), byte(v>>8) }
func put32(b []byte, v uint32) {
	b[0], b[1], b[2], b[3] = byte(v), byte(v>>8), byte(v>>16), byte(v>>24)
}
