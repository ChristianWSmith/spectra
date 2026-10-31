package main

import (
	"embed"
	"flag"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	"github.com/wailsapp/wails/v3/pkg/services/kvstore"
	"github.com/wailsapp/wails/v3/pkg/updater"
	"github.com/wailsapp/wails/v3/pkg/updater/providers/github"

	"github.com/ChristianWSmith/spectra/internal/data"
	"github.com/ChristianWSmith/spectra/internal/extract"
	"github.com/ChristianWSmith/spectra/internal/library"
	"github.com/ChristianWSmith/spectra/internal/models"
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
	// minimums below (M1 plan §3.5).
	defaultWindowWidth  = 1280
	defaultWindowHeight = 800

	// minWindowWidth / minWindowHeight keep tables/panes usable; the user
	// can grow the window freely beyond these.
	minWindowWidth  = 900
	minWindowHeight = 600
)

func main() {
	// CLI smoke import (M1 plan §5.4): `spectra -import path.dem[.zst]`
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

	// Durable state first: data dirs, then the SQLite store (migrations +
	// stale-job recovery run inside Open). st.Close is deferred first, so
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

	app := application.New(application.Options{
		Name:        appName,
		Description: "A powerful, feature-rich CS2 demo viewer and match analysis toolkit.",
		Services: []application.Service{
			application.NewService(kvs),
			application.NewService(svc),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
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

	app.RegisterService(application.NewService(&LibraryService{st: st, imp: imp, app: app}))
	app.RegisterService(application.NewService(&MatchService{st: st}))

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

	menu := app.Menu.New()
	appMenu := menu.AddSubmenu("Help")
	appMenu.Add("Check for Updates…").OnClick(func(*application.Context) {
		svc.checkForUpdateNow()
	})
	app.Menu.SetApplicationMenu(menu)

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
