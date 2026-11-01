// Package mappack extracts CS2 radar map packs (image + transform metadata)
// from a local Counter-Strike 2 installation. Valve IP never ships in our
// releases: everything here reads the user's own pak01_dir.vpk and writes
// the results into the app's data directory. See frontend/public/maps/README.md
// for the acquisition posture this implements.
package mappack

import (
	"fmt"
	"strings"
)

// kvValue is a parsed KeyValues node: either a string (kv leaf) or a
// nested object (map[string]kvValue holding more kvValues).
type kvValue = any

// parseKV parses Valve KeyValues text — the shared format of
// steamapps/libraryfolders.vdf, steamapps/appmanifest_730.acf, and
// resource/overviews/<map>.txt. Handles quoted strings with \" \\ \n \t
// escapes, bare tokens, nested {...} objects, and // line comments.
// Later duplicate keys overwrite earlier ones.
func parseKV(data []byte) (map[string]kvValue, error) {
	p := &kvParser{src: data}
	root := map[string]kvValue{}
	if err := p.parseEntries(root); err != nil {
		return nil, err
	}
	return root, nil
}

type kvParser struct {
	src []byte
	pos int
}

// parseEntries reads key/value pairs until EOF (top level) or the closing
// brace of the enclosing object (consumed).
func (p *kvParser) parseEntries(dst map[string]kvValue) error {
	for {
		if !p.skipSpace() {
			return nil // clean EOF (top level only; objects hit '}' first)
		}
		if p.peek() == '}' {
			p.pos++
			return nil
		}
		key, err := p.parseToken()
		if err != nil {
			return err
		}
		if !p.skipSpace() {
			return fmt.Errorf("kv: key %q has no value (EOF)", key)
		}
		switch c := p.peek(); c {
		case '{':
			p.pos++
			obj := map[string]kvValue{}
			if err := p.parseEntries(obj); err != nil {
				return err
			}
			dst[key] = obj
		case '}':
			return fmt.Errorf("kv: key %q has no value before '}' at offset %d", key, p.pos)
		default:
			val, err := p.parseToken()
			if err != nil {
				return err
			}
			dst[key] = val
		}
	}
}

// skipSpace advances past whitespace and // comments; reports whether any
// non-EOF input remains.
func (p *kvParser) skipSpace() bool {
	for p.pos < len(p.src) {
		c := p.src[p.pos]
		switch {
		case c == ' ' || c == '\t' || c == '\r' || c == '\n':
			p.pos++
		case c == '/' && p.pos+1 < len(p.src) && p.src[p.pos+1] == '/':
			for p.pos < len(p.src) && p.src[p.pos] != '\n' {
				p.pos++
			}
		default:
			return true
		}
	}
	return false
}

func (p *kvParser) peek() byte {
	return p.src[p.pos]
}

// parseToken reads a quoted string (with escapes) or a bare token up to
// whitespace/braces.
func (p *kvParser) parseToken() (string, error) {
	if p.pos >= len(p.src) {
		return "", fmt.Errorf("kv: unexpected EOF at offset %d", p.pos)
	}
	if p.src[p.pos] != '"' {
		start := p.pos
		for p.pos < len(p.src) && !isKVSpace(p.src[p.pos]) && p.src[p.pos] != '{' && p.src[p.pos] != '}' {
			p.pos++
		}
		if p.pos == start {
			return "", fmt.Errorf("kv: empty token at offset %d", start)
		}
		return string(p.src[start:p.pos]), nil
	}
	p.pos++ // opening quote
	var b strings.Builder
	for p.pos < len(p.src) {
		c := p.src[p.pos]
		switch c {
		case '"':
			p.pos++
			return b.String(), nil
		case '\\':
			p.pos++
			if p.pos >= len(p.src) {
				return "", fmt.Errorf("kv: dangling escape at EOF")
			}
			switch e := p.src[p.pos]; e {
			case 'n':
				b.WriteByte('\n')
			case 't':
				b.WriteByte('\t')
			case '"':
				b.WriteByte('"')
			case '\\':
				b.WriteByte('\\')
			default:
				b.WriteByte(e)
			}
			p.pos++
		default:
			b.WriteByte(c)
			p.pos++
		}
	}
	return "", fmt.Errorf("kv: unterminated string at EOF")
}

func isKVSpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\r' || c == '\n'
}

// kvString fetches a string leaf; ok=false when missing or not a string.
func kvString(obj map[string]kvValue, key string) (string, bool) {
	v, ok := obj[key].(string)
	return v, ok
}
