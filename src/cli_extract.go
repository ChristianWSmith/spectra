package main

import (
	"fmt"
	"log"
	"os"

	"github.com/ChristianWSmith/spectra/internal/data"
	"github.com/ChristianWSmith/spectra/internal/mappack"
)

// runExtract runs every CS2 asset extractor headlessly: radar map packs (keep
// list), equipment icons, sounds, and the world-collision caches for the keep
// list. cs2Dir is the folder holding pak01_dir.vpk; empty means auto-detect.
// It exits non-zero when the install is missing or any extractor reports an
// error that leaves an asset absent.
func runExtract(cs2Dir string) {
	if err := data.EnsureDirs(); err != nil {
		log.Fatal(err)
	}
	if cs2Dir == "" {
		cs2Dir = mappack.FindCS2("")
	}
	if cs2Dir == "" {
		fmt.Fprintln(os.Stderr, "extract: Counter-Strike 2 not found (pass -cs2 <dir>)")
		os.Exit(1)
	}
	fmt.Printf("extract: CS2 install %s\n", cs2Dir)

	maps, errs, err := mappack.ExtractMapPacks(cs2Dir, data.MapsDir(), mappack.WithBundledMeta(bundledMapMeta))
	if err != nil {
		errs = append(errs, err.Error())
	}
	fmt.Printf("extract: map packs %d\n", len(maps))
	for _, e := range errs {
		fmt.Fprintf(os.Stderr, "extract: map packs: %s\n", e)
	}

	names, errs, err := mappack.ExtractIcons(cs2Dir, data.IconsDir())
	if err != nil {
		errs = append(errs, err.Error())
	}
	fmt.Printf("extract: icons %d\n", len(names))
	for _, e := range errs {
		fmt.Fprintf(os.Stderr, "extract: icons: %s\n", e)
	}

	names, errs, err = mappack.ExtractSounds(cs2Dir, data.SoundsDir())
	if err != nil {
		errs = append(errs, err.Error())
	}
	fmt.Printf("extract: sounds %d\n", len(names))
	for _, e := range errs {
		fmt.Fprintf(os.Stderr, "extract: sounds: %s\n", e)
	}

	for _, m := range mappack.SupportedWorldCollisionMaps() {
		if _, n, err := mappack.ExtractWorldCollision(cs2Dir, m, data.WorldColDir()); err != nil {
			fmt.Fprintf(os.Stderr, "extract: world collision %s: %v\n", m, err)
		} else {
			fmt.Printf("extract: world collision %s (%d meshes)\n", m, n)
		}
	}

	if ok, missing := assetsReady(); !ok {
		fmt.Fprintf(os.Stderr, "extract: incomplete, missing: %v\n", missing)
		os.Exit(1)
	}
	fmt.Println("extract: all assets ready")
}
