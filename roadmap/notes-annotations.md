# Bookmarks, notes, voice notes & tags — roadmap research

**Unit:** notes-annotations · **Priority tier:** P2 · **Date:** 2026-11-10
**LoE (aggregate):** M — two M items (bookmarks incl. the chat-command
trigger, voice notes: capture plumbing + storage lifecycle + replay UI) and
two S items (demo-notes autosave, tag store) land in roughly a week, with
the mic-capture verification as the schedule risk.
**Feasibility:** high — everything is offline, local-storage work over
existing scaffolding (SQLite baseline, replay hotkeys, chat rows, voice
serve routes); blockers: verify the Wails pin actually grants WebKitGTK
microphone access (fixed upstream in v3 PR #5567, June 2026 — repo pins
`wails/v3 v3.0.0`, unverified), and the chat-command trigger only fires
where the demo's chat is recoverable (all-chat/FACEIT plaintext; Valve-MM
team chat may be encrypted — CS2.md).

## Items in scope

1. **Bookmarks with notes** — save moments and notes during review, incl. an
   in-game chat-command bookmark trigger
2. **Voice notes** — audio annotations attached to a round
3. **Demo notes with autosave** — notes kept on a demo with autosave and
   keyboard shortcuts
4. **Tag store** — persistent tags with suggested tags

## Current state

**Nothing exists.** Grep for bookmark/note/tag across Go and frontend finds
only ROADMAP.md and the sibling research docs — no table, no service, no UI.

**Storage decision context — sidecar vs SQLite.** `internal/sidecar` is the
*extraction-time, single-writer* home of derived parse output:
`sidecar.NewWriter` truncates positions/state files on every reprocess,
`library.go` wipes `voice/` before each parse and does `os.RemoveAll` of the
whole match dir on a **failed** parse (`cleanupSidecar`), and match delete
(`libraryservice.go` Remove) does `os.RemoveAll(matches/<id>/)`. User
authored annotations must therefore NOT live under `matches/<id>/`: they
would be destroyed by a failed reprocess and are not parse output. SQLite is
the correct home for all four items' *rows*: `schema.sql` is THE baseline
(idempotent `CREATE … IF NOT EXISTS`, applied on every Open — no version
machinery needed or allowed), every child table FKs `matches(id) ON DELETE
CASCADE`, and user-row precedents already exist (`saved_filters`,
`saved_queries`, `metrics`, `plugins`). `store.scrub` strips NUL bytes from
every bound string on write — notes text rides that path for free. New
tables need the convention's `<table>Cols` const pinned by
`TestColumnListConstsMatchSchema` and any library-wide index goes in the
Tier-1 block of `schema.sql`.

**Chat (the `!bm` trigger's source).** Chat is captured at import from
`SayText2` (extract `handlers.go` — `chatChannel` maps MsgName →
`all|team|''`), one row per message into the `chat` table
(`match_id, tick, round, steam_id, name, text, kind, channel, decrypted`),
and rendered in the replay chat feed / canvas chat through `LandmarkRow`.
CS2.md: Valve-MM public chat decrypts with the `.dem.info` key; **team chat
may be unrecoverable** (private key unavailable, hedged source); FACEIT/HLTV
demos carry plaintext. Detection has not been attempted anywhere.

**Replay hotkeys & markers.** `lib/replay/input.js` is THE key owner
(modifiers ignored, `isTextEntry` swallows typing, `REPEATABLE` set, digits
= player slots; free letters include B/M/N/T). Scrubber markers come from
`landmarks.js` `scrubberMarkerClass`, gated by enabled feed categories —
bookmarks are *user rows, not demo events*, so they need their own marker
source and toggle, not a forged event kind. `store.RoundForTick(rounds,
tick)` already maps tick → round for anchoring.

**Voice plumbing (playback yes, capture no).** In-demo voice: sidecar
`voice/<xuid>.opus` + fixed-record `.idx`, `VoiceService` reads, HTTP
`/api/sidecar/<id>/voice/{pcm,wav}` (s16le mono 16 kHz), Web Audio engine
clocked to the replay (`lib/replay/audio.js`), `voiceWavURL`/`saveExportURL`
for downloads. **No `getUserMedia`/MediaRecorder/permission code exists
anywhere in the repo.** Upstream: Wails v3 denied WebKitGTK mic access
because the `permission-request` signal was unhandled (wails issue #5552)
and fixed it via a cross-platform Permissions map (PR #5567, June 2026) —
the pin (`v3.0.0`) must be verified to include it.

**Autosave.** No debounce/autosave helper exists in the frontend (grep
empty). The precedent is Go-side: kvstore created with `AutoSave: true` so
every pref write is durable immediately — the same "a crash must not lose
state" bar applies to notes.

**Tag surface.** Library search = `store.MatchListFilter{Map, Player}` +
`matchListWhere` (THE one spelling, ANDed facets) + `Library.svelte` two
facets seeded from the route query (`#/library?map=&player=` via
`router.js` buildHash/parseHash). `SuggestInput` is THE suggestion dropdown
(sources: `store.ListMapNames` + `ProfileService.ListPlayers`) — the natural
home for tag suggestions.

## Implementation path

### 1. Bookmarks with notes — LoE: M

- **Storage: SQLite `bookmarks` table** —
  `(id, match_id FK cascade, tick, round, note TEXT, source TEXT
  'manual'|'chat', chat_id, created_at, updated_at)`. Not a sidecar:
  bookmarks are user rows that must (a) survive reprocess (sidecar files are
  truncated/wiped by it), (b) be searchable *across* the library
  (`SELECT … WHERE note LIKE …` — a sidecar would force a whole-library
  file scan), and (c) cascade with match delete. No format versioning: the
  table is THE layout, added to the baseline `schema.sql` (idempotent).
- **Save during review:** a replay hotkey (e.g. `B` — free in `input.js`)
  captures the engine tick + current note text → `AddBookmark` binding;
  note editing afterwards rides the canonical `Dialog`/`Popover`. Round is
  stamped at save (server-side `RoundForTick` or the frontend rounds list —
  one source, never both).
- **Surfaces:** scrubber/round-strip markers from a *separate* bookmark
  marker source (do not bolt onto `landmarks.js` categories — its marker
  loop is category-gated and bookmark visibility is not an event category);
  a bookmark list in the Match view + click-to-seek (deep link via
  `nav.js` `replayHash`); optional feed rows through `LandmarkRow`.
- **Chat-command trigger: on-read derivation, never extract-time.** Chat
  rows are already in the DB after import; a Go pass (invoked when a
  match's bookmarks are first read / on replay load) scans `chat` for lines
  matching the user-configured command (pref key in `prefs.go`, default
  e.g. `!bm`), extracts the trailing note text, and upserts bookmark rows
  idempotently (keyed on chat row id). On-read keeps the pref live (a
  command change needs no reprocess), keeps the parse deterministic, and
  causes **zero golden-fixture churn** (extraction untouched). Recognized
  command lines should be hidden from the chat feed by one display rule.
  Feasibility is bounded by chat recoverability (see Risks).

### 2. Voice notes — LoE: M

- **Capture:** `getUserMedia({audio:true})` in the webview → capture PCM
  (AudioWorklet/ScriptProcessor → Float32 → mono WAV bytes in JS — no
  MediaRecorder/opus dependency, which WebKitGTK support for is unverified)
  → ship bytes through a binding (a ≤60 s note at 16 kHz mono ≈ 2 MB —
  fine as a `[]byte` argument). Enforce duration + size caps in the
  recorder. Verify first that the pinned Wails grants mic permission
  (upstream fix PR #5567); if not, that is a fork/patch or a Go-side
  capture decision — check before building UI.
- **Storage: audio files outside the parse-managed sidecar** — e.g.
  `$XDG_DATA_HOME/spectra/voicenotes/<matchID>/<id>.wav` (sibling of
  `demos/`), *not* `matches/<id>/`: a failed reprocess does
  `os.RemoveAll` of that dir and would eat user audio. A SQLite
  `voice_notes` row (`match_id FK cascade, tick, round, file, duration_s,
  created_at`) indexes them; match delete (and reprocess-failure cleanup)
  gets an explicit second removal beside the existing `os.RemoveAll` in
  `libraryservice.go`. Text fields scrubbed like every write; no format
  versioning — WAV (or one chosen format) is THE layout.
- **Round association:** tick anchor at record time (engine tick, or the
  current round start when recorded from a round view); round derived once
  at save via `RoundForTick`.
- **Playback in replay:** a new HTTP route beside the voice ones (pattern:
  `/api/sidecar/…` in `main.go`, or a `voicenotes` route) + a plain
  `<audio>` element or a one-shot Web Audio play — no clock-sync needed
  (unlike in-demo voice; the `audio.js` engine stays untouched). Surface:
  note list in the Match view / replay toolbar, click = seek + play;
  `LandmarkRow`-style row optional.

### 3. Demo notes with autosave — LoE: S

- **Storage: one SQLite row per match** — `match_notes(match_id PK/FK
  cascade, text, updated_at)`. (Or a `notes` column on `matches`; a
  separate row table keeps the baseline matches DDL untouched.)
- **Autosave:** textarea in the Match view (and/or a replay notes panel)
  → debounced (~0.5–1 s) `SaveMatchNotes` binding; flush on blur and on
  view teardown; a small "saved" indicator (VS Code aesthetic). No
  frontend debounce helper exists yet — add the one canonical helper rather
  than three inline timers. The kvstore `AutoSave: true` precedent is the
  durability bar, but the store here is SQLite (single-writer, immediate
  commit) — not the kvstore itself; don't put per-match prose in prefs.
- **Keyboard shortcuts:** force-save (`Ctrl/Cmd+S`) and note-taking keys
  ride `input.js` conventions — `isTextEntry` already keeps typing from
  firing transport keys, and modifier combos are ignored by the hotkey
  owner today (they'd need an explicit registration if wanted). Any new
  replay-side shortcut (bookmark key from item 1) must be added to the
  "Keyboard shortcut reference" roadmap item's table.

### 4. Tag store — LoE: S

- **Schema:** `tags(id, name UNIQUE, created_at)` +
  `match_tags(match_id FK cascade, tag_id FK tags ON DELETE CASCADE,
  PRIMARY KEY(match_id, tag_id))` in the baseline `schema.sql`, with
  `<table>Cols` consts + the pinned test and a Tier-1 index leading on
  `tag_id` (and `match_id` is the PK). Tags are library-level — the
  human-only rule is irrelevant (it filters rosters, not metadata).
- **Service:** `ListTags` / `AddTagToMatch` / `RemoveTagFromMatch` /
  `SuggestTags` — suggestions = frequency-based
  (`SELECT t.name, COUNT(*) … GROUP BY … ORDER BY COUNT DESC LIMIT n`)
  over `match_tags`; cheap with the index, no background pass.
- **Surface:** a third facet in `MatchListFilter` + `matchListWhere` (extend
  THE one spelling — never a second filter query) rendered in
  `Library.svelte` beside map/player and seeded from the route query
  (`#/library?tag=`); tag chips on match rows / the Match view with edit via
  `SuggestInput` (add a `ListTags` suggestion source alongside
  `ListMapNames`/`ListPlayers`). MatchPicker/Reports/Builder pick up tags
  for free once the facet exists.

## Existing scaffolding to reuse

- `schema.sql` baseline + `TestColumnListConstsMatchSchema` + Tier-1 index
  block — every new table/row writer follows this, no versioning.
- `store.matchListWhere` / `MatchListFilter`, `Library.svelte` facets,
  `router.js` buildHash/parseHash — the tag filter surface end to end.
- `SuggestInput` (THE suggestion dropdown) — tag suggestions.
- `input.js` hotkey owner (`isTextEntry`, `REPEATABLE`) — bookmark/note
  shortcuts; `nav.js` `replayHash` — deep links to a tick.
- `store.RoundForTick` — the one tick→round mapping for anchors.
- `LandmarkRow` + `landmarks.js` + RoundStrip/scrubber marker patterns —
  rendering/seek precedents (bookmark markers get their own source).
- Voice serve pattern (`/api/sidecar/<id>/voice/{pcm,wav}`,
  `services.js` `voiceWavURL`, `saveExportURL`, `Dialog.svelte` native
  save) — voice-note playback/download plumbing, deliberately a *separate*
  pipeline from in-demo voice (roadmap/voice.md: keep the two distinct).
- `saved_filters`/`saved_queries`/`metrics` — SQLite user-row precedents;
  `cachedRead` in `services.js` — read caching + `spectra:*` invalidation
  for the new reads (mutations flush the cache per the canonical rule).
- `Dialog`/`Popover` — note editors; `CommandPalette` — optional bookmark
  jump list later.

## Dependencies & overlaps

- **Drawings/telestration (sibling unit, biggest conflict):** shares
  `Replay.svelte`, the scrubber and the "pinned to the demo clock" anchor
  concept. The storage split is the coordination point: drawings are
  per-frame geometry (sidecar-shaped, bulk, wiped-with-parse by design),
  notes/bookmarks/tags are small queryable rows (SQLite). Decide once, per
  the replay-overlays doc's "ONE home for user-authored data" note, and
  don't let either unit store rows in the parse-managed sidecar dir.
- **Replay:** hotkeys (`input.js`), scrubber markers, feed rows —
  merge-conflict-prone surface, no logic overlap.
- **Statistics:** moments rows (clutch steps, $-lost deaths) are declared
  "natural bookmark seeds" by stats-advanced/stats-descriptive — keep
  `source` in the bookmarks schema so auto-seeds can join later.
- **Voice:** shares PCM/WAV/serve/save plumbing only; voice notes are NOT
  in-demo data — pipelines stay distinct (roadmap/voice.md overlap note).
- **Video/clips & highlights:** bookmarks are the natural future in/out
  points for clip export; drawings burn-in is that unit's concern, not
  ours.
- **Library:** match delete cascade + reprocess-failure wipe (drive the
  `voicenotes/` cleanup hooks); the scan/chat-trigger pass must stay
  read-side so it never touches job kinds/queue coalescing; workspaces +
  storage management eventually export/retain tags & notes (coarse export
  is explicitly acceptable per PRODUCT.md).
- **Metadata / localization / SQL console:** metadata enriches bookmark
  lists; note/tag UI strings ride localization later; new tables are
  queryable in the read-only console for free.

## Risks & unknowns

- **Mic capture unverified:** Wails fixed WebKitGTK `getUserMedia`
  (issue #5552 → PR #5567, June 2026) behind a cross-platform Permissions
  map — confirm the pinned `v3.0.0` contains it *before* building voice
  notes; fallbacks are patching/forking Wails or Go-side capture (cgo
  audio — against dependency minimalism). Also verify WAV-capture approach
  (avoid MediaRecorder/opus support questions in WebKitGTK) and the
  GStreamer plugin set for output (already a documented user hint).
- **Chat-command trigger coverage:** `!bm` typed in team chat may be
  unrecoverable in Valve-MM demos (CS2.md encrypted team chat), and in
  all-chat it is visible to everyone in the match (the user must plan ahead
  in-game). The feature must degrade honestly (no chat → no trigger) and
  should be documented, not promised universally.
- **Reprocess-failure wipe:** anything stored under `matches/<id>/` dies
  with `cleanupSidecar` — voice notes and any future user files belong in
  sibling data-dir locations with explicit delete hooks.
- **Marker/visibility coupling:** bolting bookmarks onto `landmarks.js`
  category gating would hide them when feed chips are off — keep a separate
  marker source + toggle; `replay.dom.mjs` and `renderer.test.js` pin
  existing UI and will need deliberate updates.
- **Hotkey collisions:** input.js owns single-letter keys (digits are
  slots); pick free letters, respect `isTextEntry`, and land the entry in
  the keyboard-shortcut-reference roadmap item.
- **Convention overhead per table:** Cols consts + pinned test, Tier-1
  index placement, scrub-on-write, `cachedRead` invalidation — small but
  mandatory per AGENTS.md consolidation rules.
- **Parallel instances:** notes/tags are last-writer-wins across two live
  instances sharing one DB — the documented XDG per-worktree isolation
  covers agents; a single user running two instances on one data dir is
  the accepted app-wide exposure (same as prefs).
