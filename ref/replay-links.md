# Replay link audit — "does this link actually land at its promised time?"

Audit of every place in the app that links to a point in time in the
replay (round links, tick links, landmark/event links): `replayHash`,
`go(`, `nav(`, `tick:`/`round:` usages across `frontend/src/lib/views/*`
and `components/*`, verified against how `Replay.svelte` +
`lib/router.js`/`lib/nav.js` honor the target. Every finding below was
either fixed or recorded as a known issue; re-run the same sweep when a
new link-to-replay surface is added.

## The contract (`Replay.svelte` + `nav.js`)

An entry URL's time target is resolved **once**, after the position data
loads, by the new canonical resolver `nav.entrySeekTick(query, rounds)`
(Replay `startEngine`):

1. `?tick=` (an exact tick link) wins as-is;
2. else `?round=` — a round-scoped link — resolves to **that round's
   start tick** (`rounds.roundStartTick`, canonical home
   `lib/rounds.js`) — a round link is a link to a point in time, never
   the first frame;
3. else `0` → the first frame (no time promise was made);
4. a `?sel=` landmark's own seek applies if no explicit tick/round
   resolved it — and it no longer races the loader (see below).

Applied only on entry: in-session filter changes (`navigateFilter`)
preserve the params but never re-seek, so the user's playback position
stays theirs. `?tick=` never seeks *before* loading (there is no engine
to seek); it seeks in `startEngine` immediately after `load()` finishes.

### Bugs this fixed

- **`Economy.svelte:177` `drill(round)`** — the "Winner equipment value
  advantage" card (and the three sibling summary cards) promised
  "open Replay events for round {gapRound}" but only stamped the feed
  scope (`?round=`), leaving the playhead on the **first tick** (the
  reported bug). Now `?round=N` resolves to round N's start tick on
  entry, so the card lands on `gapRound`. The producer needed no change:
  the round parameter carries both the feed scope and the time target,
  resolved in one place (contract rule 2 above) — no second resolution
  layer was added in the view.
- **`Replay.svelte` `?sel=` race** — the entry-selection effect called
  `engine?.seekTick(...)` while the feed routinely settles *before* the
  position data (engine still null): the optional chain silently no-opped
  and the replay stayed on the first frame. A `?sel=`-only link was
  therefore never honored. Fixed with `seekEntry()`: it seeks now if the
  engine is up, else remembers the tick for `startEngine`
  (`entrySelTick`). Existing `?sel=` links also carry `?tick=`
  (CompareRounds), so they were covered by the tick either way — this
  makes the documented `?sel=` contract true regardless of load order.
- **`Replay.svelte` jump-to-round selector** — `r.startTick || 0` jumped
  to the **first frame** when a round row had no start tick; now uses
  canonical `roundStartTick` and keeps the position instead of a
  first-frame jump.

### Audit verdict per link site

| Site | Target | Verdict |
|---|---|---|
| `Economy.svelte:177` `drill(round)` — all 4 summary cards | round N | **Fixed here** (contract rule 2) |
| `Utility.svelte` `openEvents(r)` (events button) | round scope | **Fixed here** (rule 2); hint text updated to say the replay opens at the round's start |
| `Utility.svelte` `openReplay(r)` (replay button) | exact throw tick | Honored — `?tick=` applied after load |
| `Replay.svelte` in-Replay seeks (feed ▶, "Seek to event", voice-lane click, `Hear ±10s`) | current row's tick | Honored — in-place `engine.seekTick`, no navigation |
| `Replay.svelte` `?tick=` entry (any producer) | exact tick | Honored — applied once in `startEngine`, after loading |
| `Replay.svelte` `?sel=` entry | landmark tick | **Fixed here** (loader race) |
| `Match.svelte:460-467` `openPlayerEvents` / `openReplay` | none (steam scope + optional `?follow=` camera) | No time target by design — first frame is correct for a non-time link; the `?follow=` camera hand-off is implemented (Overview stat cards and roster/scoreboard rows all pass it) |
| `Heatmaps.svelte:158` | bbox scope only | No time target — OK |
| `EconCurve.svelte:264/267/314`, `RoundStrip.svelte:80`, `Match.svelte:1035` | `#/match/:id/round/:n` (RoundDetail) | Not replay links — OK |
| `Library.svelte`, `Settings.svelte`, `heatramp.js` | — | No replay time links at all (grep-verified) — nothing to fix |

## Findings

### `frontend/src/lib/views/CompareRounds.svelte` — FIXED

- **`:141-143` `replayStart(col)`** — it stamped
  `tick: col.detail?.round?.startTick || 0`: if the column's round-detail
  fetch had failed the link still rendered and navigated with `tick=0`,
  which `entrySeekTick` treats as "no promise" → the replay silently
  landed on the **first frame** while the button implied the round
  start. Now resolves the start from the detail row and falls back to
  `roundStartTick(rounds, col.round)`; with no known start the button
  does not navigate (no time promise, no lying link).
- `:137-139` `openEvent(row)` — `tick` + `sel` both present: honored
  (tick wins; sel selects the row) — OK.

### `frontend/src/lib/views/Combat.svelte` — FIXED

- Main links are honored: `:165-167` `replay(tick)` stamps an exact
  `?tick=` (engagement ▶ `:319-324`); `:169-172`
  `openRoundEvents(round)` (round chips `:328-332`, `:405-409`) is a
  round link — honored via the entry contract (rule 2).
- **`:397-402` clutch ▶** — `tick={c.replayAnchorTick || c.startTick}`
  could produce `tick=0` → first frame silently. The anchor is the
  clutch's start tick (`analytics/clutches.go`, pinned equal in
  `analytics_test.go`), so the `|| startTick` fallback was dead weight
  that only masked the zero case. The button now renders only when
  `replayAnchorTick > 0` — a clutch with no anchor offers no watch
  button instead of a link that promises a time it cannot keep.

### `frontend/src/lib/views/Match.svelte`

- `:460-463` `openPlayerEvents` (roster/scoreboard/overview-card rows)
  and `:465-467` `openReplay` carry **no time target** — first frame is
  the correct behavior for them; `?follow=` only moves the camera. No
  fix required (the Overview stat cards pass `follow` too, matching the
  roster rows).

### `frontend/src/lib/components/EconCurve.svelte`, `Library.svelte`,
### `Settings.svelte`, `heatramp.js`, `Heatmaps.svelte`

- `EconCurve.svelte:264/267/314` link to `#/match/:id/round/:n`
  (RoundDetail), not to the replay — no time link to verify.
- `Library.svelte` (`:388`, `:513`) and `Settings.svelte` navigate to
  match/settings routes only — no replay links.
- `heatramp.js` is a pure color ramp; `Heatmaps.svelte:158` links with a
  `bbox` filter and `back`, no tick/round — no time target, OK.

### `frontend/src/lib/components/CommandPalette.svelte`

- `:260-293` saved-filter entry — `replayHash(mid,
  parseLandmarkFilter(f))`. Saved filters carry no `tick`
  (`serializeLandmarkFilter` has no tick key), but may carry a `round`,
  which now resolves to that round's start on entry (rule 2) — correct.

### `frontend/src/lib/views/RoundDetail.svelte`

- `:179-181` + `:191` `watchTick(detail.round.startTick || 0)` — the
  button only renders under `{#if detail}`, and round rows always carry
  `startTick`, so `|| 0` is unreachable in practice — OK (minor: could
  use `roundStartTick` for consistency).
- `:172-175` `openEvents()` — round link, honored via rule 2.

## Known issue — the `-1` round sentinel collision (scope, not time)

`parseLandmarkFilter`'s "all rounds" sentinel is `-1`, and extract's
renumber makes the *warmup round* number `-1` too (`-2` knife, `-1`
warmup — `internal/extract/build.go` renumber). Split verdict:

- **Time: fixed.** `entrySeekTick` reads the RAW `?round=` param instead
  of the parsed filter, so a URL that names the warmup round still seeks
  to its start tick while an absent param stays "no promise" (pinned by
  `nav.test.js`).
- **Feed scope: still broken for negative rounds.** `serializeLandmarkFilter`
  omits `-1`, so a warmup link's URL carries no round at all, and the Go
  contract is `EventFilter.Round < 0 = all rounds`
  (`internal/store/queries.go queryEvents`), so even a `-2` knife round
  never scopes `GetEvents`/`GetChat`/`GetGenericEvents` — while
  `FilterBar.svelte` offers warmup/knife options claiming "the feed's
  round filter matches exactly" (it does not; only `GetRoundDetail`'s
  `exactRound` path matches exactly). Fixing this needs a contract
  change across `lib/replay/landmarks.js`, `FilterBar.svelte` and the
  three Go reads (e.g. an exact-round flag, or a sentinel that collides
  with no real round number).

## FIXED — Replay did not reload when the route id changed without unmount

`App.svelte` rendered `<Replay id={route.id} ...>` inside a plain
`{:else if route.name === 'replay'}` (no `{#key}`), and `Replay` loads
only in `onMount`. Navigating replay → replay (reachable via
CommandPalette: a saved filter for a *different* match while already in
the Replay) changed `id` without re-running `load()`: the landmark feed
refetched (its effect reads `id`) but meta/positions/engine stayed on
the previous match — so no time target (or match) was honored at all.
Fixed by wrapping the component in `{#key route.id}`: an id change
remounts (full reload), query-only changes keep the component and its
playback position.
