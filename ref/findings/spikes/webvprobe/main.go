package main

import (
	"bytes"
	"embed"
	"io/fs"
	"net/http"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

//go:embed all:frontend
var frontendAssets embed.FS

const blobSize = 32 << 20 // 32 MiB

var blob []byte

func makeBlob() []byte {
	b := make([]byte, blobSize)
	for i := range b {
		b[i] = byte(i % 251)
	}
	return b
}

type ProbeService struct{}

func (s *ProbeService) GetData() []byte { return blob }

type GreetingService struct{}

func (g *GreetingService) Hello() string { return "hi" }

func main() {
	blob = makeBlob()

	sub, err := fs.Sub(frontendAssets, "frontend")
	if err != nil {
		panic(err)
	}
	fallback := application.BundledAssetFileServer(sub)

	mux := http.NewServeMux()
	// Range-capable raw byte serving via stdlib ServeContent.
	mux.HandleFunc("/blob", func(w http.ResponseWriter, r *http.Request) {
		http.ServeContent(w, r, "blob.bin", time.Time{}, bytes.NewReader(blob))
	})

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/blob" {
			mux.ServeHTTP(w, r)
			return
		}
		fallback.ServeHTTP(w, r)
	})

	app := application.New(application.Options{
		Name: "webvprobe",
		Services: []application.Service{
			application.NewService(&ProbeService{}),
			application.NewService(&GreetingService{}),
		},
		Assets: application.AssetOptions{
			Handler:        handler,
			DisableLogging: true,
		},
	})

	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:  "webvprobe",
		Width:  1280,
		Height: 1024,
		URL:    "/",
	})

	if err := app.Run(); err != nil {
		panic(err)
	}
}
