package mappack

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// VPK v2 (Source 2) reader — just enough to read CS2's pak01_dir.vpk:
// a 28-byte header, a tree of NUL-terminated strings (extension → path →
// filename, each filename followed by an 18-byte entry), and file data
// either in the dir file itself (archiveIndex 0x7fff, addressed from the
// end of header+tree) or in numbered pak01_NNN.vpk archives. CS2's tree
// carries no custom-attribute strings (a Source 1 feature) — parsing them
// desyncs the tree, and all 137k real CS2 entries parse without them.
// Format facts + verified parse: CS2.md "Source 2 VPK v2 format".

const (
	vpkMagic           = 0x55aa1234 // Source 2 (Source 1 uses 'VPKC')
	vpkHeaderSize      = 28
	vpkEmbeddedArchive = 0x7fff // archiveIndex: data lives in the dir file
)

// vpkEntry locates one file's bytes inside a VPK archive set.
type vpkEntry struct {
	crc          uint32
	preloadBytes uint16
	archiveIndex uint16
	offset       uint32
	length       uint32
	preload      []byte
}

// vpk opens pak01_dir.vpk and indexes its tree for point lookups.
//
// A *vpk is safe for CONCURRENT read() calls (ExtractMapPacks' per-map
// worker pool reads the same VPK from several goroutines): entries is
// read-only after openVPK, file bytes are fetched with offset-free
// ReadAt (never a shared Seek position), and the lazily-opened archive
// handles are guarded by filesMu.
type vpk struct {
	dirPath  string // .../pak01_dir.vpk
	baseDir  string // directory holding pak01_*.vpk
	treeSize int64
	entries  map[string]vpkEntry

	filesMu sync.Mutex // guards files (lazily opened archives)
	files   map[string]*os.File
}

// openVPK parses the directory tree of the VPK at path. The whole tree is
// held in memory (CS2: ~137k entries) for O(1) case-insensitive lookups by
// full path ("<dir>/<name>.<ext>", matching Source's forward slashes).
func openVPK(path string) (*vpk, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()

	var hdr [vpkHeaderSize]byte
	if _, err := io.ReadFull(f, hdr[:]); err != nil {
		return nil, fmt.Errorf("vpk: header: %w", err)
	}
	if sig := binary.LittleEndian.Uint32(hdr[0:4]); sig != vpkMagic {
		return nil, fmt.Errorf("vpk: bad signature %#x (want Source 2 %#x)", sig, vpkMagic)
	}
	if ver := binary.LittleEndian.Uint32(hdr[4:8]); ver != 2 {
		return nil, fmt.Errorf("vpk: unsupported version %d (want 2)", ver)
	}
	treeSize := int64(binary.LittleEndian.Uint32(hdr[8:12]))

	tree := make([]byte, treeSize)
	if _, err := io.ReadFull(f, tree); err != nil {
		return nil, fmt.Errorf("vpk: tree: %w", err)
	}

	v := &vpk{
		dirPath:  path,
		baseDir:  filepath.Dir(path),
		treeSize: treeSize,
		entries:  make(map[string]vpkEntry),
		files:    make(map[string]*os.File),
	}
	r := bufio.NewReaderSize(strings.NewReader(string(tree)), 1<<20)
	for {
		ext, err := readCString(r)
		if err != nil {
			return nil, fmt.Errorf("vpk: tree: %w", err)
		}
		if ext == "" {
			break // tree done
		}
		for {
			dir, err := readCString(r)
			if err != nil {
				return nil, fmt.Errorf("vpk: tree: %w", err)
			}
			if dir == "" {
				break
			}
			for {
				name, err := readCString(r)
				if err != nil {
					return nil, fmt.Errorf("vpk: tree: %w", err)
				}
				if name == "" {
					break
				}
				var raw [18]byte
				if _, err := io.ReadFull(r, raw[:]); err != nil {
					return nil, fmt.Errorf("vpk: entry %s: %w", name, err)
				}
				e := vpkEntry{
					crc:          binary.LittleEndian.Uint32(raw[0:4]),
					preloadBytes: binary.LittleEndian.Uint16(raw[4:6]),
					archiveIndex: binary.LittleEndian.Uint16(raw[6:8]),
					offset:       binary.LittleEndian.Uint32(raw[8:12]),
					length:       binary.LittleEndian.Uint32(raw[12:16]),
				}
				if term := binary.LittleEndian.Uint16(raw[16:18]); term != 0xffff {
					return nil, fmt.Errorf("vpk: entry %s: bad terminator %#x", name, term)
				}
				if e.preloadBytes > 0 {
					e.preload = make([]byte, e.preloadBytes)
					if _, err := io.ReadFull(r, e.preload); err != nil {
						return nil, fmt.Errorf("vpk: entry %s preload: %w", name, err)
					}
				}
				// Source 2 trees carry no custom-attribute strings here.
				full := dir + "/" + name + "." + ext
				v.entries[strings.ToLower(full)] = e
			}
		}
	}
	return v, nil
}

// read returns the full contents of the named file (case-insensitive);
// found=false when absent.
func (v *vpk) read(name string) (data []byte, found bool, err error) {
	e, ok := v.entries[strings.ToLower(name)]
	if !ok {
		return nil, false, nil
	}
	data = append([]byte{}, e.preload...)
	if e.length == 0 {
		return data, true, nil
	}

	var f *os.File
	var base int64
	if e.archiveIndex == vpkEmbeddedArchive {
		// Embedded data sits in the dir file after header + tree.
		f, err = os.Open(v.dirPath)
		if err != nil {
			return nil, false, err
		}
		defer func() { _ = f.Close() }()
		base = vpkHeaderSize + v.treeSize
	} else {
		f, err = v.archiveFile(e.archiveIndex)
		if err != nil {
			return nil, false, err
		}
	}
	// ReadAt (pread) reads at an EXPLICIT offset with no shared file
	// position: concurrent pool workers reading through the same *os.File
	// can never clobber each other's offset the way Seek+Read would.
	// A short read comes back as io.EOF from ReadAt (ReadFull reported
	// ErrUnexpectedEOF) — either way the read is an error, never a
	// silently truncated buffer.
	buf := make([]byte, e.length)
	if _, err := f.ReadAt(buf, base+int64(e.offset)); err != nil {
		return nil, false, fmt.Errorf("vpk: read %s: %w", name, err)
	}
	return append(data, buf...), true, nil
}

// names returns every file path in the tree with the given prefix and
// suffix, sorted for deterministic iteration.
func (v *vpk) names(prefix, suffix string) []string {
	var out []string
	for k := range v.entries {
		if strings.HasPrefix(k, prefix) && strings.HasSuffix(k, suffix) {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

// archiveFile opens (and caches) a numbered archive pak01_NNN.vpk.
// The cache map is guarded by filesMu so concurrent pool workers can
// race to open the same archive safely (exactly one handle wins, every
// caller gets the same *os.File — safe to ReadAt concurrently).
func (v *vpk) archiveFile(idx uint16) (*os.File, error) {
	key := fmt.Sprintf("%03d", idx)
	v.filesMu.Lock()
	defer v.filesMu.Unlock()
	if f, ok := v.files[key]; ok {
		return f, nil
	}
	f, err := os.Open(filepath.Join(v.baseDir, "pak01_"+key+".vpk"))
	if err != nil {
		return nil, err
	}
	v.files[key] = f
	return f, nil
}

// close releases lazily opened archive handles. Callers must only close
// after every reader is done (ExtractMapPacks defers it past the pool's
// WaitGroup); filesMu is taken so the cache map itself is never walked
// concurrently with an open.
func (v *vpk) close() {
	v.filesMu.Lock()
	defer v.filesMu.Unlock()
	for _, f := range v.files {
		_ = f.Close()
	}
}

// readCString reads a NUL-terminated string from r.
func readCString(r *bufio.Reader) (string, error) {
	var b []byte
	for {
		c, err := r.ReadByte()
		if err != nil {
			return "", err
		}
		if c == 0 {
			return string(b), nil
		}
		b = append(b, c)
	}
}

// sortStrings sorts in place (thin alias to keep call sites short).
func sortStrings(s []string) { sort.Strings(s) }
