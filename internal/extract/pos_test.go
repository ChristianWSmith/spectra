package extract

import (
	"testing"

	"github.com/golang/geo/r3"
)

func TestPosPtrs(t *testing.T) {
	px, py, pz := posPtrs(r3.Vector{X: 1.5, Y: -2, Z: 3})
	if px == nil || py == nil || pz == nil || *px != 1.5 || *py != -2 || *pz != 3 {
		t.Fatalf("posPtrs(1.5,-2,3) = %v/%v/%v, want pointers", px, py, pz)
	}
	// The zero vector is demoinfocs' "no position" → nils (never a
	// bogus map-center stamp).
	px, py, pz = posPtrs(r3.Vector{})
	if px != nil || py != nil || pz != nil {
		t.Fatalf("posPtrs(zero) = %v/%v/%v, want nils", px, py, pz)
	}
}

func TestPos3(t *testing.T) {
	// All-or-nothing: any nonzero component means the position exists, so
	// the whole triple is stored (zero components are real coordinates).
	px, py, pz := pos3(0, 5, 0)
	if px == nil || py == nil || pz == nil || *px != 0 || *py != 5 || *pz != 0 {
		t.Fatalf("pos3(0,5,0) = %v/%v/%v, want 0/5/0 pointers", px, py, pz)
	}
	px, py, pz = pos3(0, 0, 0)
	if px != nil || py != nil || pz != nil {
		t.Fatalf("pos3(0,0,0) = %v/%v/%v, want nils", px, py, pz)
	}
}
