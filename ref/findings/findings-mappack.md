# CS2 Radar / Map-Pack Research for Spectra Milestone 2

Research date: 2026-10-30. Scope: top-down radar assets + world→pixel transforms for a local-first CS2 demo viewer (Go + Wails v3 + Svelte).

**Bonus finding (golden demo):** a quick header sniff of `/tmp/opencode/donk.dem` shows a FACEIT SourceTV demo whose map name is length-prefixed as `de_cache` (bytes `08 64 65 5f 63 61 63 68 65`, game dir `/home/hz01897/cs2/game/csgo`). The golden acceptance demo is likely **de_cache**, not de_mirage. Confirm with `demoinfocs-golang` (`demo.Header().MapName`) before hard-coding. de_cache has been in the 2026 Premier active-duty pool (https://csdb.gg/maps/), so it ships in current game files.

---

## 1. Where CS2 top-down radar images come from

### (a) Official CS2 game files

CS2 keeps the same *logical* pair as CS:GO — a radar texture + a companion KeyValues overview file — but the texture moved from `resource/overviews/` into Panorama as a compiled texture:

| Asset | VPK | Internal path | Format |
|---|---|---|---|
| Radar image | `<CS2>/game/csgo/pak01_dir.vpk` | `panorama/images/overheadmaps/<map>_radar_psd.vtex_c` | compiled Source 2 texture (`.vtex_c`); decompiles to PNG/TGA. The `_psd` suffix is just Valve's internal name — output is PNG ([huntiezz/cs2-assets](https://github.com/huntiezz/cs2-assets)) |
| Overview metadata | same VPK | `resource/overviews/<map>.txt` | plain KeyValues1 text — **yes, CS2 still ships the companion txt with pos_x/pos_y/scale**, same keys as CS:GO |
| Multi-level radars | same VPK | `panorama/images/overheadmaps/<map>_lower_radar_psd.vtex_c` | second image for lower floors (nuke, vertigo, train, baggage…) |

Confirmed by two independent extractors that scan exactly these patterns:

- [invakid404/cs2-radar-extractor](https://github.com/invakid404/cs2-radar-extractor/blob/master/extract.py): `RADAR_IMAGES_PATTERN = ^panorama/images/overheadmaps/(.*?)_radar_psd.vtex_c$` and `OVERVIEWS_PATTERN = ^resource/overviews/(.*?).txt$` against `game/csgo/pak01_dir.vpk`.
- [pnxenopoulos/awpy-data](https://github.com/pnxenopoulos/awpy-data) (`scripts/lib.py` / `extract_assets.py`): radar = `pak01_dir.vpk` → `<map>_radar_psd.vtex_c`; overview = `pak01_dir.vpk` → `overviews/<map>.txt`; nav/geometry live in per-map `game/csgo/maps/<map>.vpk`.

Example `de_mirage` overview txt (identical in official dumps and community mirrors, e.g. [MurkyYT/cs2-map-icons/data/radar_info/de_mirage.txt](https://github.com/MurkyYT/cs2-map-icons/blob/main/data/radar_info/de_mirage.txt), [2mlml/cs2-radar-images/de_mirage.txt](https://github.com/2mlml/cs2-radar-images/blob/master/de_mirage.txt)):

```
"de_mirage"
{
	"material"	"overviews/de_mirage"
	"pos_x"		"-3230"	// upper-left world X
	"pos_y"		"1713"	// upper-left world Y
	"scale"		"5.00"	// world units per radar pixel
	"rotate"	"0"
	"zoom"		"0"
	"CTSpawn_x"	"0.28"	// fractional image coords (loading-screen icons)
	"bombA_x"	"0.54"
	...
}
```

CS2 added `verticalsections` for multi-floor maps (e.g. de_nuke `AltitudeMax: -495`, de_vertigo `11700`) — see parsed form in [MurkyYT available.json](https://github.com/MurkyYT/cs2-map-icons/blob/main/data/available.json) and awpy's parser below. Official radar PNGs are 1024×1024 for the active pool maps (zenojunior's viewer hard-codes `RADAR_PX = 1024`; store real pixel size in metadata anyway).

### (b) Community sources and licensing posture

| Source | What it ships | Stated license / posture |
|---|---|---|
| [MurkyYT/cs2-map-icons](https://github.com/MurkyYT/cs2-map-icons) | Auto-scraped from the game depot on every CS2 update: icons, `images/radars/<map>_radar_psd.png`, raw `data/radar_info/<map>.txt`, machine-readable `data/available.json` (parsed pos_x/pos_y/scale/rotate/verticalsections) | README: "Map icons, radars, thumbnails and overview data are property of **Valve Corporation**. This repository simply provides automated access to publicly available resources." No OSS license grant. |
| [2mlml/cs2-radar-images](https://github.com/2mlml/cs2-radar-images) | Flat dump of radar PNGs + overview txts | None stated |
| [huntiezz/cs2-assets](https://github.com/huntiezz/cs2-assets) | Radar PNGs + kill-feed SVGs, no metadata | None stated |
| [ees-q/cs2_radar_map_files](https://github.com/ees-q/cs2_radar_map_files) | Official radars extracted via Source2Viewer | None stated |
| HLTV radars | Match-page radar crops | HLTV terms; different crop/scale — not the game texture |
| [RadGen](https://radargenerator.github.io/) ([VDC page](https://developer.valvesoftware.com/wiki/RadGen)) | Community *generator* that renders custom overviews from map meshes (used by Simple Radar etc.) | Free tool, not affiliated with Valve; outputs are community art |
| [saiko.tech radar-overviews API](https://github.com/markus-wa/demoinfocs-golang/blob/master/examples/map_metadata.go) | `https://radar-overviews.csgo.saiko.tech/<map>/<crc>/radar.png` + `info.json` (used by demoinfocs examples; CS:GO-era naming) | Community service |

Practical posture across the ecosystem: everyone treats radars as Valve IP redistributed for community tooling; nobody re-licenses them. See §4.

### (c) Extracting from the VPK

- **[ValveResourceFormat / Source 2 Viewer](https://github.com/ValveResourceFormat/ValveResourceFormat)** ([s2v.app](https://s2v.app/), [CLI docs](https://s2v.app/ValveResourceFormat/guides/command-line.html)): browse VPKs, export/decompile `.vtex_c` → PNG, glTF export of models. CLI flags used by awpy-data: extract `overviews/<map>.txt` as-is; decompile `<map>_radar_psd.vtex_c` → PNG. Leetify maintains a fork ([leetify/ValveResourceFormat](https://github.com/leetify/ValveResourceFormat)).
- **Python**: `vpk` + `vdf` packages ([invakid404 extract.py](https://github.com/invakid404/cs2-radar-extractor/blob/master/extract.py)); [affectioned/CS2_DMA_RADAR tools/AssetExtractor/extract.py](https://github.com/affectioned/CS2_DMA_RADAR/blob/main/tools/AssetExtractor/extract.py) wraps `Source2Viewer-CLI.exe`.
- **JS**: MurkyYT's scraper uses `vpk-no-request.js` + `vsvg-converter.js` in-repo.
- **steamcmd**: CS2 (app 730) installs anonymously (`+login anonymous`) — awpy-data CI uses this so no Steam account is needed to rebuild the pack ([awpy-data README](https://github.com/pnxenopoulos/awpy-data)).

---

## 2. Exact coordinate transform math

CS2 (like all Source engines) is **Z-up**. Demo world positions are `(x, y, z)` Hammer units; the radar is a top-down orthographic projection of the **X/Y plane**:

- World **+X** → image **right**
- World **+Y** → image **up** in world ⇒ image **down** is +Y? **No — inverted:** world +Y is *toward the top of the radar image*, so image row = `(pos_y − y)` decreases as y increases. (The overview txt's `pos_y` is the world Y of the image's **top-left** corner.)
- World **+Z** is altitude; only used to pick the floor image via `verticalsections` / `lower_level_max_units`.

Canonical formula (world → radar-image pixels, origin top-left, py grows down):

```
pixel_x = (world_x - pos_x) / scale
pixel_y = (pos_y - world_y) / scale
```

`scale` = **world units per radar pixel**. Image coverage in world units: `[pos_x, pos_x + W_px·scale] × [pos_y − H_px·scale, pos_y]`.

Inverse:

```
world_x = pixel_x * scale + pos_x
world_y = pos_y - pixel_y * scale
```

### Cited implementations (all agree)

1. **demoinfocs-golang examples** ([map_metadata.go](https://github.com/markus-wa/demoinfocs-golang/blob/master/examples/map_metadata.go)) — the Go reference:

```go
func (m Map) Translate(x, y float64) (float64, float64) {
	return x - m.PosX, m.PosY - y
}
func (m Map) TranslateScale(x, y float64) (float64, float64) {
	x, y = m.Translate(x, y)
	return x / m.Scale, y / m.Scale
}
```

2. **zenojunior/cs2d** ([calibration.ts](https://raw.githubusercontent.com/zenojunior/cs2d/main/apps/app/src/viewer/domain/calibration.ts)) — fractions for canvas-size independence:

```ts
const fx = (x - cal.posX) / cal.scale / RADAR_PX   // RADAR_PX = 1024
const fy = (cal.posY - y) / cal.scale / RADAR_PX
```

Same file tabulates official values incl. `de_mirage: scale 5.0, posX -3230, posY 1713`, `de_cache: scale 5.5, posX -2000, posY 3250`, and Nuke/Vertigo level cuts from `verticalsections`.

3. **skkwowee/cs2-demo-viewer** ([docs/data-format.md](https://github.com/skkwowee/cs2-demo-viewer/blob/main/docs/data-format.md)) — same formula, same JSON shape as awpy (`pos_x/pos_y/scale/lower_level_max_units`).

4. **CutROOM technical guide** ([cut-room.com/learn/cs2-radar-guide](https://cut-room.com/learn/cs2-radar-guide)) — same formula for GSI overlays; notes Z is used only for floor selection/opacity.

5. **invakid404 extract.py** — computes world bounds from image size: `bottom_left_x = top_left_x + image_x * scale`, `bottom_left_y = top_left_y - image_y * scale` (confirms Y-down in image space).

6. **disalytics issue #70** ([oleksii-latyshev/disalytics](https://github.com/oleksii-latyshev/disalytics/issues/70)) — specifies `worldToRadar(map, point)` "including the inverted Y", inputs from MurkyYT overview defs.

`pos_x`/`pos_y`/`scale` are **facts from Valve's overview txt** — not approximations. For de_mirage the trio is stable across every source checked: `-3230, 1713, 5.0`.

---

## 3. How existing open-source tools handle assets + transforms

| Project | Assets shipped? | Metadata format | Transform |
|---|---|---|---|
| **demoinfocs-golang** examples | Embeds radar PNG + overview txt in `examples/_assets` (CS:GO-era); also fetches from saiko.tech | Go struct `{pos_x,pos_y,scale}` parsed from VDF | `TranslateScale` (above) |
| **awpy** ([pnxenopoulos/awpy](https://github.com/pnxenopoulos/awpy), PyPI MIT) | **No game files in the wheel.** Runtime download/cache from [awpy-data](https://github.com/pnxenopoulos/awpy-data) GitHub Releases (`awpy get`), keyed by CS2 `ClientVersion` | `map_data.json` (per-map `pos_x, pos_y, scale, rotate, zoom`, multi-level via `verticalsections` → `lower_level_max_units`) + `radars/<map>.png` (+ `_lower.png`) in `images.zip` | `awpy.plot.world_to_pixel()` — same inverted-Y formula; docs: "Pixel coordinates have the origin at the radar's top-left corner, with py growing downward" |
| **cs-demo-manager** ([akiver/cs-demo-manager](https://github.com/akiver/cs-demo-manager), MIT app) | Ships/updates radar images inside the app ("Maps radar images have been updated", "use CS2 map images instead of CSGO ones" in changelog) | Internal map registry (not a public package) | Same overview constants; Z-based level filter for heatmaps (changelog v3.6.2) |
| **zenojunior/cs2d** | Bundles `/public/maps/*_radar.png` from MurkyYT | Hand-written `MAP_CALIBRATION` TS object (+ blast radii) | `worldToFraction` |
| **skkwowee/cs2-demo-viewer** | Rasters from awpy | `map-data.json` keyed by map (awpy schema) | documented formula |
| **mwridgway/CS2Callouts** | Extracts from user's VPK; overlays on awpy radars | Per-map `out/<map>_callouts.json` polygons (from `env_cs_place` models projected to world→2D) | awpy transform |
| **hjbdev/cs2-vmap-tools** | Parses decompiled `.vmap` for `env_cs_place` callouts | JSON / Google Sheet | n/a (world-space polygons) |
| **MurkyYT/cs2-map-icons** | Full scrape incl. parsed JSON | `data/available.json` | consumers apply formula themselves |

**No widely-used npm package named `cs2-map-data`.** The de-facto metadata interchange format is awpy's `map-data.json` (small enough to vendor; schema in §5). Go has no dedicated map-pack module; demoinfocs consumers vendor the three floats per map.

Scope.gg and Leetify are closed-source products; Leetify only open-sources utilities ([github.com/leetify](https://github.com/leetify): demofile fork, VRF fork, etc.), not their radar pipeline.

---

## 4. Licensing: shipping Valve-derived radars

Facts:

- Radar textures, overview txts, nav meshes, and map geometry are **Valve copyrighted game content**. Steam Subscriber Agreement grants a license, not a sale; Fan Art provisions allow using Valve content **non-commercially** ([SSA §3.D](https://store.steampowered.com/subscriber_agreement/)); "Commercial use of some Valve game content is permitted via features such as Steam Workshop or a Steam Subscription Marketplace."
- [Valve Developer Community: Mod Content Usage](https://developer.valvesoftware.com/wiki/Mod_Content_Usage) — EULAs "usually forbid decompiling/modifying re-distributing the game's content"; non-commercial community use is tolerated in practice.
- Ecosystem practice (not legal advice): many public repos redistribute official radars (MurkyYT, 2mlml, ees-q, huntiezz, cs-demo-manager releases, HLTV mirrors) with a "property of Valve" disclaimer and no takedowns to date. Old awpy shipped **Simple Radar** images with explicit permission ([awpy 1.2.0 credits](https://pypi.org/project/awpy/1.2.0)); current awpy-data deliberately ships **only scripts** and states: "Redistributing such assets for community tooling is long-established practice … but they remain Valve's. This repo ships only the *scripts*; the assets are produced from a CI (or your own) CS2 install" ([awpy-data Licensing](https://github.com/pnxenopoulos/awpy-data)).

Three strategies for Spectra:

| Strategy | Pros | Cons |
|---|---|---|
| **A. User points Spectra at local CS2 install; extract on demand** (VPK read + vtex decompile, or pre-extracted folder) | Cleanest legally (user already owns the content); always matches their game build | Needs VPK/texture decoding in Go or a bundled helper; most users won't have tools; CS2 install required |
| **B. Runtime download of a community pack** (MurkyYT `available.json` + radars, or self-built pack like awpy-data hosted by us) | Zero repo weight; offline after first fetch; versionable by ClientVersion | Still Valve IP on *our* CDN/Git-release; same posture as awpy-data/HLTV; keep "property of Valve" notice; non-commercial OSS posture |
| **C. Bundle images in the repo/GitHub Release** | Simplest UX | Highest exposure; contradicts the careful posture of awpy-data; avoid for public OSS |

Recommended hybrid: **ship only the numeric metadata** (pos/scale/levels — facts, not artwork) in-repo; acquire **pixels** via B with fallback A (user-supplied path). Not legal advice — decide with counsel if Spectra ever commercializes.

---

## 5. Packages with per-map JSON metadata (bounds, sites, spawns, callouts)

| Need | Best existing source | Notes |
|---|---|---|
| **World→radar constants** | [awpy-data `map_data.json`](https://github.com/pnxenopoulos/awpy-data) (GitHub Release root, MIT *scripts*); MurkyYT `available.json`; awpy wheel embeds a copy (`awpy/data/map-data.json`) | Schema: `pos_x, pos_y, scale, rotate, zoom, lower_level_max_units` |
| **World bounds** | Derivable: `pos_x … pos_x+W·scale`, `pos_y−H·scale … pos_y` ([invakid404 metadata.json](https://github.com/invakid404/cs2-radar-extractor)) | Store W/H of the PNG |
| **Bomb site centers** | Overview txt fractional markers `bombA_x/y`, `bombB_x/y` (image fractions → world via inverse transform) | Points, **not polygons** |
| **Site polygons** | No ready npm/go package ships `func_bombsite` polygons. Paths: (1) extract `func_bomb_target`/bombsite brushes from decompiled `.vmap` (same technique as [mwridgway/CS2Callouts](https://github.com/mwridgway/CS2Callouts) for `env_cs_place`); (2) **nav mesh**: CS2 `.nav` areas carry `dynamic_attribute_flags` "bomb-target, defuse, …" with full corner polygons ([awpy NavMesh docs](https://awpy.readthedocs.io/en/stable/nav.html)) — union of flagged areas ≈ plantable region; (3) Valve wiki [Func_bomb_target](https://developer.valvesoftware.com/wiki/Func_bomb_target) documents the entity |
| **Spawn points** | Overview txt `CTSpawn_x/y`, `TSpawn_x/y` (fractions); full spawn sets from map entities or community datasets ([nadesdb.com spawns](https://nadesdb.com/guides/cs2-setpos-command/)); retakes spawn lists documented on [VDC](https://developer.valvesoftware.com/wiki/Counter-Strike:_Global_Offensive/Game_Modes/Retakes) |
| **Callout polygons** | [mwridgway/CS2Callouts](https://github.com/mwridgway/CS2Callouts) (JSON polygons per callout, awpy-aligned); [hjbdev writeup + cs2-vmap-tools](https://hjb.dev/posts/counter-strike-2-where-are-all-the-callouts-2); nav place names historically in awpy `nav_info.csv` |
| **Callout point dataset (CC BY 4.0)** | [CSGeoguesser data API](https://www.cs2apps.com/csgeo/api) — callout locations + minimap coords as JSON, CC BY 4.0 with credit | Points, not polygons |
| **Visibility / geometry** | awpy-data `geometry.zip` (`.mesh` AWMH) — overkill for M2 |

**Answer to Q5:** closest thing to a drop-in pack is **awpy-data releases** (PNG + `map_data.json`, versioned by ClientVersion) + **CS2Callouts-style extraction** (or nav bomb-target flags) for site polygons. Nothing ships *both* transform metadata and site polygons in one npm/go package today; Spectra should define its own small JSON (below) and generate it from those sources.

---

## Recommendation for Spectra

### Asset acquisition strategy

1. **Metadata in-repo** (MIT/Apache, our schema): a single `maps.json` (or per-map files) with transform constants for the active pool + de_cache. Generate from MurkyYT `available.json` or by parsing `resource/overviews/*.txt` out of a pinned install. No Valve artwork.
2. **Radar pixels — tiered:**
   - **Tier 0 (dev/CI):** checked-in *test fixture* radar for the golden map only, if legal review is comfortable; otherwise generate in CI from steamcmd (awpy-data pattern: anonymous install of app 730).
   - **Tier 1 (end users with CS2):** auto-detect install (libraryfolders.vdf), read `pak01_dir.vpk`, decompile `overheadmaps/<map>_radar_psd.vtex_c` → PNG cache under user data dir. Go VPK readers exist; texture decode can shell out to a bundled Source2Viewer-CLI or pre-generate a sidecar.
   - **Tier 2 (users without CS2 / first-run convenience):** optional runtime download from a community mirror (MurkyYT raw URLs or a Spectra-hosted pack we build from Tier 1), with attribution banner "Radar images © Valve, redistributed for community tooling."
3. **Multi-level:** ship both `<map>.png` and `<map>_lower.png`; pick by Z vs `lower_level_max_units` (Nuke −495, Vertigo 11700) exactly like awpy/skkwowee.

### Metadata format (JSON schema sketch)

```jsonc
{
  "schema_version": 1,
  "maps": {
    "de_mirage": {
      "radar": { "file": "radars/de_mirage.png", "width": 1024, "height": 1024 },
      "levels": [
        { "name": "upper", "radar": "radars/de_mirage.png",
          "min_z": null, "max_z": null }
      ],
      "transform": { "pos_x": -3230.0, "pos_y": 1713.0, "scale": 5.0 },
      "sites": {
        "a": { "center_frac": [0.54, 0.76], "polygon_world": [[x,y], ...] },
        "b": { "center_frac": [0.23, 0.28], "polygon_world": [[x,y], ...] }
      },
      "spawns": { "ct_frac": [0.28, 0.70], "t_frac": [0.87, 0.36] },
      "source": { "client_version": "2000873", "overview": "resource/overviews/de_mirage.txt" }
    },
    "de_nuke": {
      "transform": { "pos_x": -3453.0, "pos_y": 2887.0, "scale": 7.0 },
      "levels": [
        { "name": "upper", "radar": "radars/de_nuke.png", "min_z": -495, "max_z": null },
        { "name": "lower", "radar": "radars/de_nuke_lower.png", "min_z": null, "max_z": -495 }
      ]
    }
  }
}
```

`polygon_world` optional M2+; centers alone are enough for "bomb in site" smoke tests (distance threshold ~250–400 units or fractional radius on the radar).

### Transform formula (implement once, unit-test against golden demo)

```
px = (wx - pos_x) / scale          // image pixels, origin top-left
py = (pos_y - wy) / scale          // note inverted Y
// floor: choose level where min_z <= z < max_z (Z-up)
```

### Validation / calibration approach

1. **Parse `donk.dem.zst` with demoinfocs-golang**; assert `Header().MapName` (expected `de_cache` per header sniff — confirm). Skip test if LFS object absent.
2. **Table-driven transform tests:** for several known world points (first T spawn cluster, first CT spawn cluster), assert pixels land within N px of `spawns.*_frac * image_size` from the overview txt.
3. **Bomb invariant:** for every `bomb_planted` / bomb tick position, project to pixels and assert inside the site polygon (or within radius of `sites.*.center_frac` until polygons exist); cross-check event's `bombsite` field (A/B) matches which site contains the point.
4. **Round-trip:** `world → pixel → world` error < 1e-6 (pure math).
5. **Visual smoke:** render first-kill frame on the radar PNG (existing KDE/xdotool screenshot flow in AGENTS.md) and eyeball A-site/mid alignment.
6. **Multi-floor:** if the golden demo is single-level, add a synthetic unit test with Nuke constants (z=−500 → lower image).

### Key URLs (quick index)

- Transform refs: https://github.com/markus-wa/demoinfocs-golang/blob/master/examples/map_metadata.go · https://github.com/skkwowee/cs2-demo-viewer/blob/main/docs/data-format.md · https://raw.githubusercontent.com/zenojunior/cs2d/main/apps/app/src/viewer/domain/calibration.ts
- Extraction: https://github.com/invakid404/cs2-radar-extractor · https://github.com/pnxenopoulos/awpy-data · https://github.com/ValveResourceFormat/ValveResourceFormat
- Asset mirrors: https://github.com/MurkyYT/cs2-map-icons · https://github.com/2mlml/cs2-radar-images · https://github.com/huntiezz/cs2-assets
- Callouts/sites: https://github.com/mwridgway/CS2Callouts · https://hjb.dev/posts/counter-strike-2-where-are-all-the-callouts-2 · https://awpy.readthedocs.io/en/stable/nav.html
- Licensing: https://store.steampowered.com/subscriber_agreement/ · https://developer.valvesoftware.com/wiki/Mod_Content_Usage · awpy-data README §Licensing
