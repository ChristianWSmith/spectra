# Replay link audit — "does this link actually land at its promised time?"

Audit of every place in the app that links to a point in time in the
replay (round links, tick links, landmark/event links): `replayHash`,
`go(`, `nav(`, `tick:`/`round:` usages across `frontend/src/lib/views/*`
and `components/*`, verified against how `Replay.svelte` +
`lib/router.js`/`lib/nav.js` honor the target.

Scope rule applied: sites in files owned by this agent
(`Replay.svelte`, `VoiceLanes.svelte`, `Economy.svelte`,
`Utility.svelte`, `nav.js`, `router.js`, `rounds.js`,
`ref/ui-elements.csv`) were **fixed here**; sites in other agents' files
(`Match.svelte`, `EconCurve.svelte`, `Combat.svelte`,
`Library.svelte`/`Settings.svelte`, `heatramp.js`/`Heatmaps.svelte`) and
in files owned by nobody (`CompareRounds.svelte`, `RoundDetail.svelte`,
`CommandPalette.svelte`) are **recorded only** — do not edit them from
this branch.

## The contract (fixed in this branch, `Replay.svelte` + `nav.js`)

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

### Bugs this fixed (in owned files)

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
| `Match.svelte:460-467` `openPlayerEvents` / `openReplay` | none (steam scope + optional `?follow=` camera) | No time target by design — first frame is correct for a non-time link (the camera hand-off is changes.txt item 6, another agent's) |
| `Heatmaps.svelte:158` | bbox scope only | No time target — OK |
| `EconCurve.svelte:264/267/314`, `RoundStrip.svelte:80`, `Match.svelte:1035` | `#/match/:id/round/:n` (RoundDetail) | Not replay links — OK |
| `Library.svelte`, `Settings.svelte`, `heatramp.js` | — | No replay time links at all (grep-verified) — nothing to fix |

## Findings — files NOT edited by this agent

### `frontend/src/lib/views/CompareRounds.svelte`

- **`:141-143` `replayStart(col)`** — current:
  `nav(replayHash(id, {}, { tick: col.detail?.round?.startTick || 0, back: ... }))`.
  If that column's round-detail fetch failed (`detail` null) the link
  still renders and navigates with `tick=0`, which `entrySeekTick`
  treats as "no promise" → the replay silently lands on the **first
  frame** while the button implies the round start. Correct: resolve the
  start from the rounds list instead of `|| 0`, or don't navigate when
  the start is unknown. Suggested one-line fix:
  `tick: col.detail?.round?.startTick ?? roundStartTick(rounds, col.round)`
  (import `roundStartTick` from `../rounds.js`; skip navigation when the
  result is null).
- `:137-139` `openEvent(row)` — `tick` + `sel` both present: honored
  (tick wins; sel selects the row) — OK.

### `frontend/src/lib/views/Combat.svelte`

- Main links are honored: `:165-167` `replay(tick)` stamps an exact
  `?tick=` (engagement ▶ `:319-324`, clutch ▶ `:397-402`) — OK;
  `:169-172` `openRoundEvents(round)` (round chips `:328-332`,
  `:405-409`) is a round link — **now honored via the entry contract
  (rule 2), no Combat edit needed**.
- **`:397-402` clutch ▶** — current:
  `tick={c.replayAnchorTick || c.startTick}` with both fields possibly
  `0` (`ClutchRow.ReplayAnchor` is only set when the anchor could be
  identified — `analyticservice.go:33-37`), producing `tick=0` → first
  frame silently. Correct: only offer the ▶ when an anchor exists.
  Suggested one-line fix: `onclick={() => c.replayAnchorTick && replay(c.replayAnchorTick || c.startTick)}`.

### `frontend/src/lib/views/Match.svelte`

- `:460-463` `openPlayerEvents` (roster/scoreboard/overview-card rows)
  and `:465-467` `openReplay` carry **no time target** — first frame is
  the correct behavior for them; `?follow=` only moves the camera. No
  fix required. (If the overview cards should also open *at a time* —
  changes.txt item 6 — stamp `tick` in the `replayHash` extras there.)

### `frontend/src/lib/components/EconCurve.svelte`, `Library.svelte`,
### `Settings.svelte`, `heatramp.js`, `Heatmaps.svelte`

- `EconCurve.svelte:264/267/314` link to `#/match/:id/round/:n`
  (RoundDetail), not to the replay — no time link to verify.
- `Library.svelte` (`:388`, `:513`) and `Settings.svelte` navigate to
  match/settings routes only — no replay links.
- `heatramp.js` is a pure color ramp; `Heatmaps.svelte:158` links with a
  `bbox` filter and `back`, no tick/round — no time target, OK.

### `frontend/src/lib/components/CommandPalette.svelte` (unowned)

- `:260-293` saved-filter entry — `replayHash(mid,
  parseLandmarkFilter(f))`. Saved filters carry no `tick`
  (`serializeLandmarkFilter` has no tick key), but may carry a `round`,
  which now resolves to that round's start on entry (rule 2) — correct.

### `frontend/src/lib/views/RoundDetail.svelte` (unowned)

- `:179-181` + `:191` `watchTick(detail.round.startTick || 0)` — the
  button only renders under `{#if detail}`, and round rows always carry
  `startTick`, so `|| 0` is unreachable in practice — OK (minor: could
  use `roundStartTick` for consistency).
- `:172-175` `openEvents()` — round link, **now honored via rule 2**.

## Design-level finding (pre-existing, not fixed here)

- **The `-1` round sentinel collision**: `parseLandmarkFilter`'s
  "all rounds" sentinel is `-1`, and extract's renumber makes the
  *warmup round* number `-1` too (`-2` knife, `-1` warmup —
  `internal/extract/build.go` renumber). Consequences: a warmup round's
  "Events in Replay" link serializes to **no** `round=` at all
  (`serializeLandmarkFilter` omits `-1`), so the feed shows every round,
  and `entrySeekTick` deliberately never seeks on parsed `-1`
  (absent-vs-warmup is indistinguishable post-parse — pinned by
  `nav.test.js`). Knife (`-2`) links scope and seek correctly. Proper
  fix (any owner of `lib/replay/landmarks.js`): move the sentinel to a
  value that collides with no real round number (e.g. `null`/absent =
  all rounds), which would also let warmup links scope and seek.

## Out-of-scope observation (own file, deliberately NOT fixed)

- **Replay does not reload when the route id changes without unmount**:
  `App.svelte:130-131` renders `<Replay id={route.id} ...>` inside a
  plain `{#if route.name === 'replay'}` (no `{#key}`), and `Replay`
  loads only in `onMount`. Navigating replay → replay (reachable via
  CommandPalette: a saved filter for a *different* match while already
  in the Replay) changes `id` without re-running `load()`: the landmark
  feed refetches (its effect reads `id`) but meta/positions/engine stay
  on the previous match — so no time target (or match) is honored at all.
  Suggested fix (needs care with `load()`'s liveness flags, hence not
  done in this branch): either wrap the component in
  `{#key route.id}` in `App.svelte`, or replace `onMount(load)` with an
  `$effect` on `id` plus a load-generation guard in `Replay.svelte`.
