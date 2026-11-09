package main

import (
	"database/sql"
	"embed"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/pion/opus"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	"github.com/wailsapp/wails/v3/pkg/services/kvstore"
	"github.com/wailsapp/wails/v3/pkg/updater"
	"github.com/wailsapp/wails/v3/pkg/updater/providers/github"

	"github.com/ChristianWSmith/spectra/internal/analytics"
	"github.com/ChristianWSmith/spectra/internal/data"
	"github.com/ChristianWSmith/spectra/internal/extract"
	"github.com/ChristianWSmith/spectra/internal/library"
	"github.com/ChristianWSmith/spectra/internal/mappack"
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/report"
	"github.com/ChristianWSmith/spectra/internal/sidecar"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// The frontend is built by Vite into frontend/dist and embedded into the
// binary at compile time. See https://pkg.go.dev/embed for more information.
//
//go:embed all:frontend/dist
var assets embed.FS

const (
	// appName is the binary/app name. Keep in sync with Taskfile.yml's
	// APP_NAME and build/config.yml's productName — packaging, the window
	// title, the prefs file, and the updater all key off the same string.
	appName = "spectra"
	// updateRepo is the GitHub repo whose releases are checked for updates.
	// Keep in sync with the repository's owner/name.
	updateRepo = "ChristianWSmith/spectra"

	// defaultWindowWidth / defaultWindowHeight are used until the user
	// resizes the window, and whenever a saved size is missing or corrupt.
	// Data-dense tables need room; the window never opens smaller than the
	// minimums below.
	defaultWindowWidth  = 1250
	defaultWindowHeight = 1000

	// minWindowWidth / minWindowHeight keep tables/panes usable; the user
	// can grow the window freely beyond these.
	minWindowWidth  = 900
	minWindowHeight = 600
)

func main() {
	// CLI smoke import: `spectra -import path.dem[.zst]`
	// runs the full pipeline headlessly, prints the result, and exits —
	// used by dev smoke tests and useful for batch import scripting.
	importPath := flag.String("import", "", "import a demo, print the result, exit")
	flag.Parse()
	if *importPath != "" {
		runImport(*importPath)
		return
	}

	// Prefs live in a per-app JSON file under the OS config directory.
	// AutoSave persists every write immediately (the "Never must stick"
	// rule applied to update prompts; here it keeps a crash from losing
	// the latest window size).
	kvs := kvstore.NewWithConfig(&kvstore.Config{
		Filename: prefsFilename(),
		AutoSave: true,
	})
	// Load eagerly: the saved window size must be readable before the
	// window is created. The service reloads/saves again around Run.
	if err := kvs.Load(); err != nil {
		log.Printf("prefs: load: %v", err)
	}
	width, height := savedWindowSize(
		kvs.Get(prefsWindowWidthKey), kvs.Get(prefsWindowHeightKey),
		defaultWindowWidth, defaultWindowHeight)

	// Durable state first: data dirs, then the SQLite store (baseline
	// schema apply + stale-job recovery run inside Open). st.Close is deferred first, so
	// LIFO makes it run last — after imp.Shutdown below, whose worker must
	// be gone before the DB closes.
	if err := data.EnsureDirs(); err != nil {
		log.Fatal(err)
	}
	st, err := store.Open(data.DBPath())
	if err != nil {
		log.Fatal(err)
	}
	defer func() { _ = st.Close() }()

	svc := &AppService{kvs: kvs}

	// The asset server doubles as the position-sidecar endpoint (bulk
	// bytes ride HTTP fetch/Range, decompressed server-side — the
	// frontend never owns a zstd decoder). Everything else falls through
	// to the bundled frontend.
	bundled := application.AssetFileServerFS(assets)
	assetsHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if p := strings.TrimPrefix(r.URL.Path, "/api/sidecar/"); p != r.URL.Path {
			handleSidecar(st, w, r, p)
			return
		}
		if p := strings.TrimPrefix(r.URL.Path, "/api/export/"); p != r.URL.Path {
			handleExport(st, w, r, p)
			return
		}
		if p := strings.TrimPrefix(r.URL.Path, "/api/mappack/"); p != r.URL.Path {
			handleMapPack(w, r, p)
			return
		}
		if p := strings.TrimPrefix(r.URL.Path, "/api/icons/"); p != r.URL.Path {
			handleIcons(w, r, p)
			return
		}
		if p := strings.TrimPrefix(r.URL.Path, "/api/sounds/"); p != r.URL.Path {
			handleSounds(w, r, p)
			return
		}
		bundled.ServeHTTP(w, r)
	})

	app := application.New(application.Options{
		Name:        appName,
		Description: "A powerful, feature-rich CS2 demo viewer and match analysis toolkit.",
		Services: []application.Service{
			application.NewService(kvs),
			application.NewService(svc),
		},
		Assets: application.AssetOptions{
			Handler: assetsHandler,
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})
	svc.app = app

	// Import pipeline: one worker goroutine, events out through the app's
	// event manager. Deferred after st.Close above, so it runs first (LIFO).
	imp := library.New(library.Options{
		Store: st,
		Parse: extract.Parse,
		Emit: func(name string, payload any) {
			app.Event.Emit(name, payload)
		},
		ParserVersion: extract.ParserVersion,
	})
	defer imp.Shutdown()

	// Watched-folder scanner (Library's not-yet-imported demos): shares
	// the store's match index and keeps its own hash cache for the life
	// of the process.
	sc := library.NewScanner(library.ScannerOptions{Store: st})

	app.RegisterService(application.NewService(&LibraryService{st: st, imp: imp, sc: sc, kvs: kvs, app: app}))
	app.RegisterService(application.NewService(&MatchService{st: st}))
	app.RegisterService(application.NewService(&ReplayService{st: st, app: app}))
	app.RegisterService(application.NewService(&AnalyticsService{st: st, app: app}))
	app.RegisterService(application.NewService(&ProfileService{st: st, app: app}))
	app.RegisterService(application.NewService(&VoiceService{st: st, app: app}))
	app.RegisterService(application.NewService(&MetricsService{st: st, app: app}))
	app.RegisterService(application.NewService(&QueryService{st: st, app: app}))
	app.RegisterService(application.NewService(&PlatformService{st: st, app: app}))
	app.RegisterService(application.NewService(&MapPackService{kvs: kvs, app: app}))
	app.RegisterService(application.NewService(&IconService{kvs: kvs}))
	app.RegisterService(application.NewService(&SoundService{kvs: kvs}))
	// DialogService: native save dialogs + writes. SaveExport serves the
	// app's own HTTP export/sidecar routes internally (buffered) so large
	// downloads (library.db, voice WAVs) never ride the bindings.
	app.RegisterService(application.NewService(&DialogService{app: app, serve: serveHandler(assetsHandler)}))

	initUpdater(app)

	win := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:     appName,
		Width:     width,
		Height:    height,
		MinWidth:  minWindowWidth,
		MinHeight: minWindowHeight,
		URL:       "/",
		// Native file drag-and-drop: the JS runtime only forwards drops
		// (from elements marked data-file-drop-target) when this flag is on;
		// we re-emit them as a normal event the frontend subscribes to.
		EnableFileDrop: true,
	})
	win.OnWindowEvent(events.Common.WindowFilesDropped, func(ev *application.WindowEvent) {
		if files := ev.Context().DroppedFiles(); len(files) > 0 {
			app.Event.Emit("spectra:files-dropped", filesDroppedEvent{Files: files})
		}
	})

	// No native application menu: the update-check action lives in
	// Settings → About (Settings.svelte), which calls
	// AppService.CheckForUpdateNow.

	svc.maybeCheckForUpdates()

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}

// runImport drives one import headlessly: enqueue, poll the job until it
// terminates, print the outcome, exit non-zero on failure. No window, no
// updater, no events (Emit nil).
func runImport(path string) {
	if err := data.EnsureDirs(); err != nil {
		log.Fatal(err)
	}
	st, err := store.Open(data.DBPath())
	if err != nil {
		log.Fatal(err)
	}
	defer func() { _ = st.Close() }()

	imp := library.New(library.Options{
		Store:         st,
		Parse:         extract.Parse,
		ParserVersion: extract.ParserVersion,
	})
	defer imp.Shutdown()

	ids := imp.Enqueue([]string{path})
	if len(ids) == 0 {
		log.Fatal("import: no job created")
	}
	deadline := time.Now().Add(15 * time.Minute)
	for {
		jobs, err := st.ListJobs()
		if err != nil {
			log.Fatal(err)
		}
		var job *models.Job
		for i := range jobs {
			if jobs[i].ID == ids[0] {
				job = &jobs[i]
				break
			}
		}
		if job == nil {
			log.Fatal("import: job disappeared")
		}
		switch job.Status {
		case models.JobDone:
			fmt.Printf("import ok: match %d (%s)\n", job.MatchID, path)
			return
		case models.JobFailed, models.JobCancelled:
			fmt.Fprintf(os.Stderr, "import failed: %s\n", job.Error)
			os.Exit(1)
		}
		if time.Now().After(deadline) {
			fmt.Fprintln(os.Stderr, "import: timed out after 15m")
			os.Exit(1)
		}
		time.Sleep(200 * time.Millisecond)
	}
}

// handleMapPack serves user-extracted radar map packs from the app data
// dir (written by MapPackService.ExtractMapPacks) over the asset server:
//
//	/api/mappack/<map>/meta.json    pack manifest (schema_version 1)
//	/api/mappack/<map>/radar.png    decoded radar image
//	/api/mappack/<map>/radar_*.png  multi-floor layer images (layers[])
//
// Paths are strictly validated (map = [a-z0-9_]+, file = validPackFile)
// so a crafted URL can't escape the data dir. 404 when the pack is
// absent — the frontend falls back to the bundled /maps/ copy
// (metadata only, no radar art ships; a map with neither renders a
// plain grid — see frontend/public/maps/README.md).
func handleMapPack(w http.ResponseWriter, r *http.Request, p string) {
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	mapName, file, ok := strings.Cut(p, "/")
	if !ok || file == "" || strings.Contains(file, "/") {
		http.NotFound(w, r)
		return
	}
	if !validPackName(mapName) {
		http.NotFound(w, r)
		return
	}
	if !validPackFile(file) {
		http.NotFound(w, r)
		return
	}
	path := filepath.Join(data.MapsDir(), mapName, file)
	if _, err := os.Stat(path); err != nil {
		http.NotFound(w, r)
		return
	}
	http.ServeFile(w, r, path)
}

// validPackName reports whether s is a safe map-pack directory name
// (mirrors the extractor's map-name shape: lowercase, digits, _).
func validPackName(s string) bool {
	if s == "" || len(s) > 64 {
		return false
	}
	for _, c := range s {
		if (c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '_' {
			return false
		}
	}
	return true
}

// validPackFile reports whether file is a safe pack filename: meta.json
// or a radar image (radar.png / radar_<section>.png — the extractor's
// packLayerFile spelling). Anchored to the radar prefix with only
// lowercase letters/digits/_ before .png, so no path segment can pass
// ("..", "radar/../x.png", an uppercase or dotted variant all fail) —
// stricter than the earlier exact two-name whitelist, which would have
// 404'd the multi-floor layer images.
func validPackFile(file string) bool {
	if file == "meta.json" {
		return true
	}
	if len(file) < len("radar.png") || len(file) > 64 || !strings.HasSuffix(file, ".png") {
		return false
	}
	name := strings.TrimSuffix(file, ".png")
	if !strings.HasPrefix(name, "radar") {
		return false
	}
	for _, c := range name {
		if (c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '_' {
			return false
		}
	}
	return true
}

// handleIcons serves the extracted equipment icons over the asset server
// (written by IconService.ExtractIcons):
//
//	/api/icons/manifest.json    the IconManifest, rebuilt from the icons
//	                             dir on every request (never stale)
//	/api/icons/<file>.svg       one silhouette (image/svg+xml)
//
// Filenames pass a strict whitelist (mappack.ValidIconFileBase: lowercase
// digits/_ + .svg, no path segments — mirrors handleMapPack's rejection
// style), so a crafted URL can't escape the data dir. 404 when an icon is
// absent — the frontend falls back to a text label with the canonical
// equipment name (never an error: no CS2 install / no extraction is a
// fallback state).
func handleIcons(w http.ResponseWriter, r *http.Request, p string) {
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	if p == "manifest.json" {
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(buildIconManifest(data.IconsDir())); err != nil {
			log.Printf("icons: write manifest: %v", err)
		}
		return
	}
	serveIconFile(w, r, data.IconsDir(), p)
}

// serveIconFile validates name against the icon whitelist and serves the
// file from dir as image/svg+xml (dir is a parameter for tests; the
// route passes data.IconsDir()).
func serveIconFile(w http.ResponseWriter, r *http.Request, dir, name string) {
	if !mappack.ValidIconFileBase(name) {
		http.NotFound(w, r)
		return
	}
	path := filepath.Join(dir, name)
	if _, err := os.Stat(path); err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "image/svg+xml")
	http.ServeFile(w, r, path)
}

// handleSounds serves the extracted weapon/utility audio over the asset
// server (written by SoundService.ExtractSounds):
//
//	/api/sounds/manifest.json    the SoundManifest, rebuilt from the
//	                             sounds dir on every request (never stale)
//	/api/sounds/<file>.wav       one decoded sound (audio/wav)
//	/api/sounds/<file>.mp3       one raw MP3 stream (audio/mpeg)
//
// Filenames pass a strict whitelist (mappack.ValidSoundFileBase: lowercase
// digits/_/- + .wav/.mp3, no path segments — mirrors handleIcons), so a
// crafted URL can't escape the data dir. 404 when a sound is absent —
// the replay simply stays silent for that cue (never an error: no CS2
// install / no extraction is a fallback state).
func handleSounds(w http.ResponseWriter, r *http.Request, p string) {
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	if p == "manifest.json" {
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(buildSoundManifest(data.SoundsDir())); err != nil {
			log.Printf("sounds: write manifest: %v", err)
		}
		return
	}
	serveSoundFile(w, r, data.SoundsDir(), p)
}

// serveSoundFile validates name against the sound whitelist and serves
// the file from dir with its audio content type (dir is a parameter for
// tests; the route passes data.SoundsDir()).
func serveSoundFile(w http.ResponseWriter, r *http.Request, dir, name string) {
	if !mappack.ValidSoundFileBase(name) {
		http.NotFound(w, r)
		return
	}
	path := filepath.Join(dir, name)
	if _, err := os.Stat(path); err != nil {
		http.NotFound(w, r)
		return
	}
	if strings.HasSuffix(name, ".mp3") {
		w.Header().Set("Content-Type", "audio/mpeg")
	} else {
		w.Header().Set("Content-Type", "audio/wav")
	}
	http.ServeFile(w, r, path)
}

// handleSidecar serves a match's sidecars over the asset server (HTTP
// asset-server route, server-side decompress; voice routes):
//
//	/api/sidecar/<matchID>/positions?from=&to=   decompressed q16 frame
//	                                             stream (from/to frame
//	                                             indexes; 0/0 = whole match)
//	/api/sidecar/<matchID>/state?from=&to=       decompressed sparse
//	                                             player-state record
//	                                             stream (frame-indexed
//	                                             changes; 0/0 = whole
//	                                             match; 404 when the
//	                                             match has no state
//	                                             stream)
//	/api/sidecar/<matchID>/meta                  meta.json as JSON
//	/api/sidecar/<matchID>/voice/pcm?steamId=&fromTick=&toTick=
//	                                             s16le mono @16 kHz window
//	                                             with a fixed 8-byte header
//	                                             (int32 fromTick, int32
//	                                             sampleRate); gaps zero-
//	                                             filled; ≤60 s windows
//	/api/sidecar/<matchID>/voice/wav?steamId=    full-match WAV download
//
// A missing sidecar or match is 404 (HasSidecar=false territory, not an
// error). No auth: the asset server is only reachable by the app's own
// webview.
func handleSidecar(st *store.Store, w http.ResponseWriter, r *http.Request, p string) {
	idStr, rem, ok := strings.Cut(p, "/")
	if !ok {
		http.NotFound(w, r)
		return
	}
	sub, tail, hasTail := strings.Cut(rem, "/")
	if sub != "positions" && sub != "meta" && sub != "voice" && sub != "state" {
		http.NotFound(w, r)
		return
	}
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || id <= 0 {
		http.NotFound(w, r)
		return
	}
	if _, err := st.GetMatch(id); err != nil {
		http.NotFound(w, r)
		return
	}
	if sub == "voice" {
		if !hasTail {
			http.NotFound(w, r)
			return
		}
		handleVoice(st, w, r, id, idStr, tail)
		return
	}
	rd, err := sidecar.Open(filepath.Join(data.MatchesDir(), idStr))
	if errors.Is(err, sidecar.ErrNoSidecar) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	switch sub {
	case "meta":
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(rd.Meta()); err != nil {
			log.Printf("sidecar: write meta: %v", err)
		}
	case "positions":
		from, _ := strconv.Atoi(r.URL.Query().Get("from"))
		to, _ := strconv.Atoi(r.URL.Query().Get("to"))
		buf, err := rd.ReadRange(from, to)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", strconv.Itoa(len(buf)))
		if _, err := w.Write(buf); err != nil {
			log.Printf("sidecar: write positions: %v", err)
		}
	case "state":
		// Sparse player-state records (state.go). A match without the
		// stream has no state.bin — ErrNoState is absence, not a
		// failure (404, same as a missing sidecar).
		from, _ := strconv.Atoi(r.URL.Query().Get("from"))
		to, _ := strconv.Atoi(r.URL.Query().Get("to"))
		buf, err := rd.ReadStateRange(from, to)
		if errors.Is(err, sidecar.ErrNoState) {
			http.NotFound(w, r)
			return
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", strconv.Itoa(len(buf)))
		if _, err := w.Write(buf); err != nil {
			log.Printf("sidecar: write state: %v", err)
		}
	}
}

// voiceMaxWindowTicks caps pcm windows at 60 s of match time (60 s
// @16 kHz s16 ≈ 19 MB — keeps one request bounded; the timeline
// engine asks for ≤2 s windows). 64 ticks/s is the fallback when the
// match header lacks a tick rate.
const voiceMaxWindowSeconds = 60

// handleExport serves the heavy-download routes (asset-server
// pattern; reports/export):
//
//	GET /api/export/library.db                best-effort WAL checkpoint,
//	                                          then the SQLite file as a
//	                                          download (application/vnd.sqlite3)
//	GET /api/export/<matchID>/report          rendered report attachment
//	        ?template=<id>[&format=md|html]   (template without an
//	                                          extension resolves via
//	                                          format, default md; ids like
//	                                          match.md are used as-is),
//	                                          optional &steamId= (player
//	                                          scope) &round= (round scope)
//
// A missing match/template is 404. No auth: only the app's own webview
// reaches the asset server. (Zip bundle of db + per-match reports is the
// documented §2.5 v1 deferral.)
func handleExport(st *store.Store, w http.ResponseWriter, r *http.Request, p string) {
	if p == "library.db" {
		handleExportLibraryDB(w, r)
		return
	}
	idStr, rem, ok := strings.Cut(p, "/")
	if !ok || rem != "report" {
		http.NotFound(w, r)
		return
	}
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || id <= 0 {
		http.NotFound(w, r)
		return
	}
	if _, err := st.GetMatch(id); err != nil {
		http.NotFound(w, r)
		return
	}
	q := r.URL.Query()
	templateID := q.Get("template")
	if templateID == "" {
		http.Error(w, "export: missing template", http.StatusBadRequest)
		return
	}
	if !strings.Contains(templateID, ".") {
		format := q.Get("format")
		if format == "" {
			format = "md"
		}
		templateID += "." + format
	}
	steamID := q.Get("steamId")
	round, _ := strconv.Atoi(q.Get("round"))
	text, format, err := renderReportDoc(st, templateID, id, steamID, round)
	if errors.Is(err, report.ErrNotFound) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	contentType := "text/markdown; charset=utf-8"
	if format == "html" {
		contentType = "text/html; charset=utf-8"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", `attachment; filename="spectra-`+idStr+`-`+templateID+`"`)
	if _, err := io.WriteString(w, text); err != nil {
		log.Printf("export: write report: %v", err)
	}
}

// handleExportLibraryDB checkpoints the WAL (best-effort, on a short-lived
// second connection — the store keeps its own single connection open) and
// streams the SQLite file as a download. The checkpoint only succeeds when
// the writer is idle; a busy WAL simply ships with the -wal bytes absent,
// which SQLite recovers on open.
func handleExportLibraryDB(w http.ResponseWriter, r *http.Request) {
	path := data.DBPath()
	if db, err := sql.Open("sqlite", path); err == nil {
		_, _ = db.Exec(`PRAGMA wal_checkpoint(TRUNCATE)`)
		_ = db.Close()
	}
	f, err := os.Open(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer func() { _ = f.Close() }()
	info, err := f.Stat()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/vnd.sqlite3")
	w.Header().Set("Content-Disposition", `attachment; filename="spectra-library.db"`)
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	if _, err := io.Copy(w, f); err != nil {
		log.Printf("export: write library.db: %v", err)
	}
}

// handleVoice serves the /api/sidecar/<id>/voice/{pcm,wav} routes.
func handleVoice(st *store.Store, w http.ResponseWriter, r *http.Request, matchID int64, idStr, kind string) {
	presence, err := st.GetVoicePresence(matchID)
	if errors.Is(err, store.ErrNotFound) || (err == nil && presence.ChunkCount == 0) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	m, err := st.GetMatch(matchID)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	steamID := r.URL.Query().Get("steamId")
	if steamID == "" {
		http.Error(w, "voice: missing steamId", http.StatusBadRequest)
		return
	}
	voiceDir := filepath.Join(data.MatchesDir(), idStr, sidecar.VoiceDirName)
	tickRate := m.TickRate
	if tickRate <= 0 {
		tickRate = analytics.DefaultTickRate // CS2's fixed simulation rate
	}

	switch kind {
	case "pcm":
		from := 0
		if v := r.URL.Query().Get("fromTick"); v != "" {
			from, _ = strconv.Atoi(v)
		}
		to := m.DurationTicks
		if v := r.URL.Query().Get("toTick"); v != "" {
			to, _ = strconv.Atoi(v)
		}
		if from < 0 {
			from = 0
		}
		if to > m.DurationTicks {
			to = m.DurationTicks
		}
		if to <= from {
			http.Error(w, "voice: empty tick range", http.StatusBadRequest)
			return
		}
		if to-from > int(voiceMaxWindowSeconds*tickRate) {
			http.Error(w, "voice: tick range exceeds 60s window", http.StatusBadRequest)
			return
		}
		pcm, err := decodeVoicePCM(st, voiceDir, matchID, steamID, from, to, tickRate)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		// Fixed 8-byte header: int32 fromTick | int32 sampleRate (LE), then
		// s16le mono PCM.
		out := make([]byte, 8+len(pcm))
		binary.LittleEndian.PutUint32(out[0:4], uint32(from))
		binary.LittleEndian.PutUint32(out[4:8], models.VoiceOutSampleRate)
		copy(out[8:], pcm)
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", strconv.Itoa(len(out)))
		if _, err := w.Write(out); err != nil {
			log.Printf("sidecar: write voice pcm: %v", err)
		}
	case "wav":
		from, to := 0, m.DurationTicks
		pcm, err := decodeVoicePCM(st, voiceDir, matchID, steamID, from, to, tickRate)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out := waveFile(pcm, models.VoiceOutSampleRate)
		w.Header().Set("Content-Type", "audio/wav")
		w.Header().Set("Content-Disposition", `attachment; filename="voice-`+steamID+`.wav"`)
		w.Header().Set("Content-Length", strconv.Itoa(len(out)))
		if _, err := w.Write(out); err != nil {
			log.Printf("sidecar: write voice wav: %v", err)
		}
	default:
		http.NotFound(w, r)
	}
}

// voiceSamplesPerTick converts a tick delta to output samples at 16 kHz
// (16000/64 = 250 samples per tick at the Source 2 standard rate).
func voiceSamplesPerTick(tickRate float64) int {
	if tickRate <= 0 {
		return 250
	}
	return int(math.Round(models.VoiceOutSampleRate / tickRate))
}

// decodeVoicePCM decodes one player's chunks in [from,to] onto a
// zero-filled 16 kHz s16le mono timeline. Frames are placed with an
// anchor cursor: at max((tick-from)*samplesPerTick, cursor), where
// cursor is the end of the last placed frame. Frames arriving faster
// than the tick rate (10 ms Opus vs. 15.6 ms ticks at 64 tick) continue
// back-to-back instead of clobbering each other at a shared tick
// offset, while real pauses stay silent — speech stays contiguous and
// on the timeline. A missing .opus file surfaces as an error; stray
// undecodable packets are skipped.
func decodeVoicePCM(st *store.Store, voiceDir string, matchID int64, steamID string, from, to int, tickRate float64) ([]byte, error) {
	rows, err := st.GetVoiceChunkRange(matchID, steamID, from, to)
	if err != nil {
		return nil, err
	}
	spt := voiceSamplesPerTick(tickRate)
	totalSamples := (to - from) * spt
	pcm := make([]byte, totalSamples*2) // zero-filled: silence = absence of chunks
	if len(rows) == 0 {
		return pcm, nil
	}
	f, err := os.Open(filepath.Join(voiceDir, steamID+".opus"))
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	dec, err := opus.NewDecoderWithOutput(models.VoiceOutSampleRate, 1)
	if err != nil {
		return nil, err
	}
	// 10 ms @ 48 kHz is 480 samples; 2048 leaves headroom for longer frames.
	samples := make([]int16, 2048)
	// 1275 is the max Opus packet size (RFC 6716); a smaller cap silently
	// dropped big packets as holes in the speech.
	payload := make([]byte, 1275)
	cursor := 0 // end of the last placed frame; never write before it
	for _, row := range rows {
		if row.Len <= 0 || row.Len > int64(cap(payload)) {
			continue
		}
		if _, err := f.ReadAt(payload[:row.Len], row.Off); err != nil {
			return nil, err
		}
		n, derr := dec.DecodeToInt16(payload[:row.Len], samples)
		if derr != nil || n <= 0 {
			continue // tolerate stray packets: leave the window silent there
		}
		start := (row.Tick - from) * spt
		if start < cursor {
			start = cursor // same-tick/burst frames continue after the last one
		}
		if start >= totalSamples || start < 0 {
			continue
		}
		for i := 0; i < n && start+i < totalSamples; i++ {
			binary.LittleEndian.PutUint16(pcm[(start+i)*2:], uint16(samples[i]))
		}
		cursor = start + n
	}
	return pcm, nil
}

// waveFile wraps s16le mono PCM in a canonical 44-byte RIFF/WAVE header.
func waveFile(pcm []byte, sampleRate int) []byte {
	out := make([]byte, 44+len(pcm))
	copy(out[0:4], "RIFF")
	binary.LittleEndian.PutUint32(out[4:8], uint32(36+len(pcm)))
	copy(out[8:12], "WAVE")
	copy(out[12:16], "fmt ")
	binary.LittleEndian.PutUint32(out[16:20], 16)
	binary.LittleEndian.PutUint16(out[20:22], 1) // PCM
	binary.LittleEndian.PutUint16(out[22:24], 1) // mono
	binary.LittleEndian.PutUint32(out[24:28], uint32(sampleRate))
	binary.LittleEndian.PutUint32(out[28:32], uint32(sampleRate*2)) // byte rate
	binary.LittleEndian.PutUint16(out[32:34], 2)                    // block align
	binary.LittleEndian.PutUint16(out[34:36], 16)                   // bits per sample
	copy(out[36:40], "data")
	binary.LittleEndian.PutUint32(out[40:44], uint32(len(pcm)))
	copy(out[44:], pcm)
	return out
}

// filesDroppedEvent is the payload of spectra:files-dropped: absolute paths
// the user dropped on a data-file-drop-target element (window drag-and-drop
// contract, main.go window setup).
type filesDroppedEvent struct {
	Files []string `json:"files"`
}

// initUpdater wires the framework's updater to this project's GitHub
// releases. SHA256SUMS is a sibling release asset with "sha256sum" output
// lines; the updater verifies the download against it. For tamper resistance
// beyond the registry's TLS, generate a signing key with
// `wails3 updater genkey`, embed the public key here, and sign releases with
// `wails3 updater manifest -key updater.key …` — see
// https://wails.io/guides/updater/.
func initUpdater(app *application.App) {
	gh, err := github.New(github.Config{
		Repository:    updateRepo,
		ChecksumAsset: "SHA256SUMS",
	})
	if err != nil {
		log.Fatalf("updater: %v", err)
	}
	if err := app.Updater.Init(updater.Config{
		CurrentVersion: version,
		Providers:      []updater.Provider{gh},
	}); err != nil {
		log.Fatalf("updater: %v", err)
	}
}
