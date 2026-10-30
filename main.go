package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/services/kvstore"
	"github.com/wailsapp/wails/v3/pkg/updater"
	"github.com/wailsapp/wails/v3/pkg/updater/providers/github"
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
	appName = "wails-template"
	// updateRepo is the GitHub repo whose releases are checked for updates.
	// Keep in sync with the repository's owner/name.
	updateRepo = "ChristianWSmith/wails-template"

	// defaultWindowWidth / defaultWindowHeight are used until the user
	// resizes the window, and whenever a saved size is missing or corrupt.
	defaultWindowWidth  = 480
	defaultWindowHeight = 270
)

func main() {
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

	svc := &AppService{kvs: kvs}

	app := application.New(application.Options{
		Name:        appName,
		Description: "A batteries-included Wails v3 desktop app template with GitHub Releases auto-update",
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

	initUpdater(app)

	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:  appName,
		Width:  width,
		Height: height,
		URL:    "/",
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
