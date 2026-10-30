APP := wails-template
GOPATH_BIN := $(shell go env GOPATH)/bin
# Pin the CLI to the same version the app imports: go.mod is the single
# source of truth (Dependabot bumps it like any other dependency).
WAILS_VERSION := $(shell go list -m -f '{{.Version}}' github.com/wailsapp/wails/v3)

# The stock Taskfiles shell out to `wails3`, so the CLI must be on PATH.
export PATH := $(GOPATH_BIN):$(PATH)

.PHONY: build run dev build-assets test lint fmt vet linux-deps deps package artifact artifact-name clean

# deps ensures the developer toolchain the build needs: the pinned wails3
# CLI (auto-installed into GOPATH/bin) and Node.js 22+ (checked — install
# from https://nodejs.org if missing). On Linux it also warns when the
# GTK4/WebKitGTK 6.0 build libraries are absent — install those with
# `make linux-deps` (or build with `-tags gtk3` on older distros).
deps:
	@command -v wails3 >/dev/null 2>&1 && \
	  [ "$$(wails3 version 2>/dev/null | head -1 | tr -d 'v' | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+')" = "$(WAILS_VERSION:v%=%)" ] || \
	  go install github.com/wailsapp/wails/v3/cmd/wails3@$(WAILS_VERSION)
	@major=$$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0); \
	if [ "$$major" -lt 22 ]; then \
	  echo "error: Node.js 22+ is required (found $$(node -v 2>/dev/null || echo 'nothing on PATH'))." >&2; \
	  echo "Install it from https://nodejs.org (or your package manager) and re-run 'make deps'." >&2; \
	  exit 1; \
	fi
	@if [ "$$(go env GOOS)" = "linux" ] && command -v pkg-config >/dev/null 2>&1 && ! pkg-config --exists webkitgtk-6.0; then \
	  echo "warning: WebKitGTK 6.0 dev libraries not found; run 'make linux-deps'," >&2; \
	  echo "         or build with '-tags gtk3' on distributions that ship WebKit2GTK 4.1." >&2; \
	fi

build: deps
	wails3 build

run: build
	./bin/$(APP)

dev: deps
	wails3 dev

# Regenerates the platform build assets (Info.plist, Windows version
# resources, .desktop, nfpm metadata) from build/config.yml's info block —
# run after editing it. Wraps the task so wails3 is on PATH.
build-assets: deps
	wails3 task common:update:build-assets

# frontend/dist is embedded into the binary (//go:embed) but only exists
# after a frontend build. Stub it so plain `go vet` / `go test` compile on
# a fresh clone; the first `make build` replaces it with the real bundle.
frontend/dist:
	mkdir -p frontend/dist && touch frontend/dist/index.html

test: | frontend/dist
	go test -short ./...

lint: | frontend/dist
	go tool golangci-lint run ./...

fmt:
	gofmt -w .

vet: | frontend/dist
	go vet ./...

# linux-deps installs the Wails v3 cgo build dependencies (Linux only):
# GTK4 + WebKitGTK 6.0 — Ubuntu 24.04+/Debian 13+. Older distros that ship
# only WebKit2GTK 4.1 must build with `-tags gtk3` (supported through
# v3.0.x). One definition shared by ci.yml and lint.yml.
linux-deps:
	sudo apt-get update
	sudo apt-get install -y \
		build-essential \
		pkg-config \
		libgtk-4-dev \
		libwebkitgtk-6.0-dev

# package produces the platform's release payload: darwin builds the .app
# bundle (ad-hoc codesigned); on linux and windows the built binary itself
# is the payload, so build is enough.
package: build
ifeq ($(shell go env GOOS),darwin)
	wails3 package
endif

artifact-name:
	@case "$$(go env GOOS)" in \
	linux) echo "$(APP)-linux-$$(go env GOARCH)" ;; \
	darwin) echo "$(APP)-darwin-$$(go env GOARCH).zip" ;; \
	windows) echo "$(APP)-windows-$$(go env GOARCH).exe" ;; \
	*) echo "unsupported GOOS $$(go env GOOS)" >&2; exit 1 ;; \
	esac

# artifact produces the release asset the in-app updater downloads for this
# platform. Names must contain GOOS+GOARCH (the GitHub provider's
# DefaultAssetMatcher picks by substring) and the macOS zip must hold the
# .app as its sole top-level entry (the updater rejects multi-entry
# archives). The release skill adds a SHA256SUMS sidecar over all assets.
artifact: package
	@set -eu; \
	name="$$($(MAKE) -s artifact-name)"; \
	case "$$(go env GOOS)" in \
	linux) cp bin/$(APP) "$$name" ;; \
	windows) cp bin/$(APP).exe "$$name" ;; \
	darwin) (cd bin && zip -ry "../$$name" $(APP).app) ;; \
	esac; \
	echo "built $$name"

clean:
	rm -rf bin .task frontend/dist frontend/bindings \
	  $(APP)-linux-* $(APP)-darwin-*.zip $(APP)-windows-*.exe.zip SHA256SUMS
