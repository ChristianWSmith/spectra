# PRODUCT.md

The product constitution for Spectra. **This document is the authority on
what Spectra is and isn't** — written primarily for AI agents (directive
tone), secondarily for human contributors. Operational mechanics live in
`AGENTS.md`, CS2 domain facts in `CS2.md`, the roadmap execution plan
(with per-item research) in `roadmap/PATH.md`.

## Vision

- **One-liner:** "The ultimate 2D demo viewer."
- **North star:** be the best 2D offline demo playback and analysis
  tool for CS2, bar none.
- **3-year target:** the gold-standard 2D demo viewer and analysis tool
  that no other offering can compete with.
- **Never sells.** Built for the community out of love; everybody
  deserves the best possible demo viewing and analysis experience free
  of charge, forever. MIT-licensed, no monetization path, ever.

## Target user & core loop

- **Primary user ranking:** player reviewing own demos > coach/analyst
  > data nerd (SQL) > content creator > casual viewer.
- **The median user** is a competitive player looking to improve their
  play through analysis.
- **The one loop:** **Import → Watch → Learn.** Everything else in the
  app exists to support it.
- **The ideal session:** open the app, load a demo of interest, deepen
  knowledge of strategy, tactics, and team play by watching it.
- **Positioning spectrum:** viewer > analyst > notebook — all three
  matter.
- **Primary feeling:** **cockpit** (everything within reach), then
  instrument, cinema, notebook — all matter.

## What Spectra is best at

"Competitors are also good at X" is never enough; these are the
differentiators:

- **Open source.**
- **Voice comms** — the main differentiator: in-demo voice replay
  exists today, with voice analysis as the stretch.
- **Fully offline.**
- **Sharing** (clips, reports, screenshots) is an important part of the
  product even though nothing is cloud-hosted.

## Principles

### Constitution (never violate)

- **No accounts, no telemetry, no cloud, ever — ABSOLUTE.**
- **Offline promise, precisely defined:** the ability to reach the web
  does NOT violate it (curl is open source, user-controlled, and its
  function is to reach the web). What violates it is **app behavior
  being driven by something outside the user's computer**. So:
  user-initiated/optional network actions are acceptable; anything
  where external state silently changes what the app does is not.
- **Honest metrics:** missing data surfaces as value 0 beside N (the
  sample size), never a fabricated number; every metric documents its
  formula.
- **Feature-parity with competitors is evidence, never justification.**
- **Never present a feature the app cannot fully support offline.**
- **Breaking changes:** at-will before the first release; after 1.0,
  major versions only.

### Defaults (violate only with strong reason)

- **Depth governs adoption of new features, but Spectra is a cockpit
  first:** power-user features are welcome, but they must never harm
  the standard experience.
- **Simplicity wins over density;** power-user features still matter.
- **The recurring shape of features: sensible built-ins,
  user-extendable.** Mistake flagging, strategy tooling, ratings,
  metrics, and lineups all follow it: built-ins good enough for the
  median user, extension mechanisms for those who want more.
- **Data portability:** coarse-grained options and manual steps
  (digging into local directories) are acceptable ways to get data out;
  the SQL console and CSV export are the floor. Long-term interest:
  **workspaces** — the library reconceptualized as a thing that can be
  opened, modified, closed, exported.
- **Platform support is bounded** by where CS2 actually runs with asset
  extraction — see Non-goals.
- **Storage growth is not a big concern;** performance is almost always
  the priority — but the user must have ways to self-manage and
  eventually automate storage management (extending the existing
  free-copy idea).
- **Loading ladder — anticipate, then show honest progress:** pre-emptive
  background loading of data we can reasonably expect the user to
  request in the near future is the default; failing that, pre-load with
  an honest progress indication (the same honesty rule as every other
  number — an unknown denominator means indeterminate, never a
  fabricated percentage); only when no honest indication is possible do
  we fall back to a bare loading indicator. This is about perceived
  latency and honest feedback serving the **cockpit** (everything within
  reach) feeling and the **Honest metrics** principle — not prefetching
  everything at any cost: wasted work must always be cheap to abandon
  (a bail-out), so eager loading never becomes a resource obsession, and
  loading flags are transient — they never persist or restore.
- **Every error indication is dismissible:** an error may gate an
  action, but the user must always be able to clear it in place — close
  it, acknowledge it, or make it go away by retrying — never be left
  stuck with a message whose only escape is navigating elsewhere or
  restarting the app. Errors stay honest about what happened and what
  to do next, and they are transient like every other UI flag.

### Preferences

- **Determinism** (same demo + same version ⇒ identical numbers) —
  preferred; can't imagine breaking it.
- **Performance** handled as needed when things get out of hand, not as
  a standing obsession.
- **Dependency minimalism:** prefer stdlib/existing deps (modernc
  sqlite, no cgo).
- **Aesthetic:** as close to **VS Code's design language** as possible.

## Non-goals

Each item is marked `never` (hard no) or `later` (deferred, not
rejected).

### Never

- **3D replay.**
- **In-engine first-person playback.**
- **Anything touching the running CS2 process** — overlays, hooks, live
  sync / tick-jumping into the game client.
- **Becoming a replay tool for other games** (e.g. Valorant).
- **Aim-trainer / skill-practice features** — carve-out: copy-pasteable
  `setpos_exact` / `setang_exact` lineup commands are fine.
- **Betting / odds integrations.**
- **Pro match catalogs, VOD links, browsable online content** — too
  liable to break.
- **Multi-window / multi-monitor layouts.**
- **Theming / skins.**
- **Veto simulation.**
- **BO3 / BO5 series aggregation.**
- **Game-binary introspection from CS2 DLLs.**
- **Windows registry install discovery** — current discovery is strong
  enough.
- **Embeddable Go/npm library API** — the desktop app is the whole
  product; a library API would add too much LoE to everything.
- **CS:GO demo support.**
- **macOS builds** — CS2 asset extraction is core to the experience;
  better to offer nothing on macOS than a crappy experience.
- **linux-arm64** — CS2 can't run on ARM; same "extraction is core"
  reasoning.
- **Niche event-family completeness for its own sake** — chicken /
  coach / hostage rows, per-purchase economy rows. Exceptions: grenade
  bounce/destroy rows are already leveraged for trajectory
  reconstruction, and coach **voice** is wanted eventually (no golden
  demo with a coach yet).

### Later

- **Localization** — start with the most commonly spoken languages in
  CS2 and work down.
- **Per-shot aim telemetry.**

### Explicitly allowed (do NOT treat as an anti-goal)

- **Plugins that execute arbitrary user code** — "hey man, what they
  want to do is their business." User extensibility is welcome in
  general.

## Feature decision rubric

When evaluating a new feature proposal:

1. Does it serve the **Import → Watch → Learn** loop and the primary
   user (competitive player improving through analysis)?
2. Competitor interest is **evidence, not justification**. Depth over
   breadth. Cockpit-first: never harm the standard experience.
   Simplicity wins.
3. Prefer the **built-ins + user-extendable** shape.
4. Anything requiring network-dependent content or external state is
   suspect.
5. Roadmap candidates and the execution plan live in
   `roadmap/PATH.md`; new candidates are added **only when the owner
   asks** — agents do not append feature ideas to it. The owner is the
   PO; rejections are not recorded anywhere — removed means removed.
6. `roadmap/PATH.md` carries the priority order and the completion
   checkboxes; keep it updated as work lands.

## README rule

`README.md` is the app's **front page** — the GitHub repo is the
primary distribution channel, so README is player-facing product copy
(features, download), NOT developer documentation. Dev depth belongs in
`AGENTS.md` or the Makefile; keep README brief (its Developers section
= "how to run this repo locally", nothing deeper), and no screenshots
for now.
