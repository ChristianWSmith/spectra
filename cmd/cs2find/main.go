// Command cs2find is the in-repo dev tool for searching and decoding the
// local CS2 install (READ-ONLY — see mappack.RunDevTool's package doc).
// It is deliberately a five-line wrapper: the engine lives in
// internal/mappack beside the VPK/vtex/vsnd internals it reuses, so
// there is no second decoder and no export churn.
package main

import (
	"os"

	"github.com/ChristianWSmith/spectra/internal/mappack"
)

func main() {
	os.Exit(mappack.RunDevTool(os.Args[1:], os.Stdout, os.Stderr))
}
