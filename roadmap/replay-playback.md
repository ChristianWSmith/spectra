# Replay playback: Smart Mode & damage numbers — roadmap research

**Unit:** replay-playback · **Priority tier:** P1 · **Date:** 2026-11-10
**LoE (aggregate):** M — one M (speed-policy + hover semantics + audio/recording interplay) and one S (a renderer draw pass over data already on the client); all frontend.
**Feasibility:** high — both items are frontend-only: the engine already re-reads `state.speed` every rAF (mid-playback speed changes are one setter call), and every input Smart Mode and the numerals need (kills, damage + `dmg` + victim position, grenade/flash/blind ticks) already arrives in the replay view pre-engine. No backend, schema, or sidecar changes.

## Items in scope

1. **Smart Mode playback** — auto speed-up of idle moments with slow-motion on
   frags/flashes, plus hover-to-pause and ¼×–2× presets
2. **Floating damage numbers** — damage numerals rendered over the victim
   during replay

## Current state

- **Playback engine** — `frontend/src/lib/replay/engine.js`: rAF-driven clock over a typed-array position store; fractional-tick lerp source of truth; `SPEEDS = [0.25, 0.5, 1, 2, 4, 8]`; `setSpeed` accepts any finite value, `stepSpeed` walks the ladder (`,` / `.` in `lib/replay/input.js`). `loop()` does `tickF += tr * dt * state.speed` **per frame**, and every subsystem already reacts to speed: the view syncs `uiSpeed` via `engine.onChange`, the voice engine re-anchors (pitch-corrected pre-stretch, cache keyed by speed — `replay/audio.js`), sfx re-anchors its beep clock and gates cues with `cueGapJump` (`replay/sfx.js`). **Speed changes mid-playback are therefore structurally easy — a policy layer is literally "call setSpeed".**
- **Per-frame policy precedent** — `skipFreeze` inside `loop()` consulting `freezeWindowAt` (`lib/rounds.js`), with a documented one-check-per-frame / loop-yield invariant set. That is the in-engine hook pattern; the lighter alternative is a view-side `engine.onChange` subscription (the `camera_mode`/`skip_freeze` view-owned-pref pattern).
- **Speed UI** — toolbar speed popover (`Replay.svelte` ~L3036: `SPEEDS` buttons, `onSpeed` → `setSpeed`), plus `KBD_HINTS` (10 entries, one per line in the toolbar hints cell title — asserted by `frontend/test/replay.dom.mjs`).
- **Event stream available pre-engine** — `load()` fetches, before the engine starts: the **draw feed** `getEvents({kinds: DRAW_KINDS, limit: 0})` (unfiltered by category chips: `kill`, `damage` — with `dmg`, victim `posX/posY/posZ`, `victim`, `headshot` — grenade detonations incl. Flashbang, throws/bounces/lands, bomb lifecycle, round boundaries), the **blind rows** (`kind: 'blind'` + `getBlindDurations` → `{slot, tick, ms}`), sound events, chat. All tick-stamped and sorted — a binary-search "next interesting tick" policy has the exact `frameForTick`/`freezeWindowAt` shape to copy.
- **Damage rendering today** — `replay/renderer.js`: `setLandmarks` buckets damage ticks **per victim slot** (`damages[slot] = [tick,…]`), `drawPlayers` paints a 0.35 s white pop + red ring (`DAMAGE_FLASH_S`) as a pure function of tick (seek-correct); `hitTracers` already consume the row's stored victim hit position; `slotOfSteam` resolves victim → dot. Text/measure precedents everywhere (player name labels, `killFeedLayout`/`drawKillFeed` with `KILL_FEED_MAX` cap, `drawChat`).
- **Canvas overlays vs world layers** — `draw()` has two gates: the gameplay/world layers (never gated) and `setOverlaysVisible` (HUD + kill feed + chat). Opt-in world layers exist (`setDropLayers` — Guns/Utility/Kits popover, OFF by default) — the clutter-control pattern to copy.
- **Recording already burns the canvas** — the WebM clip recorder (`Replay.svelte` `startClip`, `canvas.captureStream(30)` + `MediaRecorder`) **forces `setSpeed(1)`** and plays; whatever the renderer paints (kill feed today) is in the recording.
- **Hover** — nothing hover-pauses today; no canvas hit-testing and no screen→world inverse is exported (`worldToImage` only). DOM surfaces (scrubber, player cards, feed rows) are trivially hover-able; hovering a player dot on the canvas needs new inverse math.
- **Naming collision** — camera mode `'smart'` (`camMode`, `stepSmart`) already exists and is the default camera. "Smart Mode playback" must pick a distinct label (e.g. "auto speed") in UI, prefs, aria and tests.

## Implementation path

### 1. Smart Mode playback — LoE: M
- **Policy module** (new `lib/replay/smartspeed.js`, pure + unit-testable): built once per match from the already-loaded draw feed + blind rows — "interesting" ticks = kills, damage, flashbang detonations, blinds, bomb events (round starts optional); **idle** = a gap ≥ N demo-seconds with none. Produces a target-speed function over the playhead: idle → up to 4×, live play → 1×, a frag/flash → ¼×–½× for a short pre/post window (pre-window so slow-mo catches the action, not the aftermath). Hysteresis: minimum dwell per speed (≳1 s) so the ladder never flips twice in a row — this is also what keeps the voice/sfx re-anchor churn acceptable.
- **Application**: view-side subscription `engine.onChange` → `engine.setSpeed(policy(target))` while armed (keeps `loop()`'s documented freeze/loop invariants untouched — the safer of the two precedents; an in-loop hook is only warranted if testing shows one-frame overshoot matters). Policy yields to: user speed keys/popover (manual choice suspends until re-armed or next round), freeze skip, loop wrap, and clip recording.
- **UI**: toolbar toggle armed exactly like skip-freeze (`.warn` + `aria-pressed`), persisted in a frontend-owned kvstore pref (`skip_freeze` pattern — no `prefs.go` entry, no Go change); the speed popover/`uiSpeed` already display whatever the engine holds, so policy speeds show for free. **¼×–2× presets** = the `SPEEDS` subset already in the popover plus optional direct keys (free digits/letters — note `,`/`.` already step) — extend `KBD_HINTS` and the hints title (asserted in `replay.dom.mjs`).
- **Hover-to-pause**: pointerenter on the scrubber strip (and/or player cards) pauses only if it was playing (`pausedByHover` flag — never resume a user's pause, never fire mid-drag), pointerleave resumes only if the flag is set. Canvas-dot hover is a stretch: needs a screen→world inverse + hit radius — scope v1 to DOM surfaces.
- **Recording guard**: `startClip` pins `setSpeed(1)` — the policy must be suspended for the clip's duration or the recording varies speed (see Dependencies).
- **Tests**: policy segmentation/hysteresis in `node --test` (`engine.test.js`/new `smartspeed.test.js`), key/toggle coverage in `input.test.js`, hints/toggle DOM assertions in `replay.dom.mjs`.

### 2. Floating damage numbers — LoE: S
- **Renderer draw pass** `drawDamageNumbers(tick)` beside the existing world layers: for each row in `damages`-style per-victim buckets whose tick is inside a ~0.6–1 s window, paint the numeral at the victim's dot (row `x/y/z` → `worldToScreen`, exactly like `hitTracers`' victim end) with a rise+fade envelope — all pure tick math, so it is seek-correct and frozen while paused like every other world effect. Paint before `drawPlayers` (dots/name labels stay on top) or offset above the dot — one `draw()` ordering decision.
- **Clutter control**: aggregate multiple hits on one victim within a short window (sum, like `hitTracers` dedupe on tick+pair), cap concurrent numerals (`KILL_FEED_MAX` precedent), and an opt-in toggle — either a new layer popover entry (`setDropLayers` pattern) or riding the HUD/overlay gate (`setOverlaysVisible`), plus optional per-player scope reusing the feed's existing `steamId` filter. HS/kill styling from the row's `headshot` flag is a cheap extra.
- **No backend work**: `drawRows` already carries `dmg`, victim position, weapon, headshot; nothing to add to the sidecar, schema, or bindings. Persist the toggle as a frontend-owned pref (same kvstore pattern).

## Existing scaffolding to reuse

- `engine.js` — `setSpeed`/`SPEEDS`/`onChange` (policy application), `frameForTick` (binary-search shape for the event index), `skipFreeze`/`freezeWindowAt` (in-engine per-frame policy precedent + its yield rules).
- `lib/rounds.js` `freezeWindowAt` — tick-window lookup over a precomputed row array (the smart-policy data structure twin).
- `Replay.svelte` `load()` pre-engine reads — draw feed, blind rows: the entire Smart Mode event index with **zero new fetches**; `skip_freeze`/`camera_mode` pref pattern for the arm/disarm toggle.
- `renderer.js` — `damages` per-victim buckets, `DAMAGE_FLASH_S`/`tracerProgress` envelopes, `slotOfSteam`, `hitTracers` (victim-position rendering), `killFeedLayout` measurement + cap, `setDropLayers`/`setOverlaysVisible` gating.
- `input.js` keymap + `KBD_HINTS` (preset keys, hints list), `Popover.svelte` (speed/layer popovers), `sfx.js`/`audio.js` speed re-anchoring (already handles any speed flip).
- Tests: `engine.test.js`, `input.test.js`, `renderer.test.js`, `frontend/test/replay.dom.mjs` (pins the 10-line hints title).

## Dependencies & overlaps

- **Video tier (critical):** the existing WebM clip recorder burns the canvas — damage numerals (and today's kill feed) land in recordings; and `startClip` pins speed 1×, which the Smart Mode policy must not fight. Future "Full video export / MP4 clip export" must decide explicitly: pin speed + policy off, and which overlays/layers burn in. **If the exporter reuses the live renderer, Smart Mode's variable speed would make exports non-deterministic — co-schedule the "policy suspended during capture" rule with the video unit.**
- **Keyboard shortcut reference** (Export & scripting roadmap item): preset keys and the hints list belong in that documented shortcut table; `KBD_HINTS` is today's in-app "reference".
- **Vision cones / callouts** (sibling replay items): same `renderer.js` draw pipeline (4.1k lines) — merge-conflict-prone but no logic overlap; numerals should slot into the same world-layer pass they add.
- **Annotations/drawings:** also drawn onto the recorded canvas — same "what's on the canvas gets recorded" coupling as damage numbers.
- **Naming:** camera `smart` mode vs "Smart Mode playback" — distinct label needed everywhere (UI string, pref key, aria, tests) or users/tests will confuse the two.
- **Landmark feed filters:** Smart Mode's event index must stay fed by the unfiltered draw feed (by design category chips don't gate it) — turning off the `kills`/`damage` feed chips must not change playback speed behavior; damage-number clutter control likewise must not silently couple to feed chips unless deliberately chosen.
- **Localization:** new user-facing strings (toggle label, preset labels) ride the future localization item — keep them in the existing string surfaces.
- **Statistics / library / metadata:** no impact — no backend, no schema, no jobs.

## Risks & unknowns

- **Policy tuning is UX research, not CS2 domain:** idle threshold, slow-mo depth, pre/post windows and dwell time have no canonical definition — needs a sensible built-in + a pref or two (PRODUCT.md's "sensible built-ins" shape), rated M mostly for this plus interaction handling.
- **Audio churn:** every speed change cancels/re-stretches the voice engine's scheduled windows and re-keys its cache (`audio.js`); sfx re-anchors too. Without a dwell floor, rapid flips make voice choppy — the hysteresis requirement is load-bearing, and should be sanity-checked with voice enabled (manual run — GUI tests only on request).
- **Engine loop invariants:** `loop()` documents strict freeze-skip/loop-wrap rules ("ONE check per frame, never a while"); a second in-loop policy must preserve them or stay view-side (recommended).
- **Hover semantics vs existing input rules:** `input.js` defers to focused controls and range inputs; pause-on-hover must not swallow Space, fire during scrub-drag, or resume a deliberate pause.
- **Recording/export determinism:** exports must pin speed and disable policy (see video tier) — a cross-unit contract, not an implementation detail.
- **Test churn:** `replay.dom.mjs` pins hints/buttons and `renderer.test.js` pins draw behavior — both need deliberate updates; no golden-fixture or sidecar implications.
