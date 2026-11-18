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
  formula. A computed metric is shown as its stored value — while a
  recompute is pending the slot shows a processing/behind state, never
  a stale number. For an **identity** metric N is the pool it chose
  from: an empty pool shows a dash — the winner is never invented —
  and 0-beside-N is the numeric answer only, never an identity.
- **User-facing text speaks the user's domain — never implementation
  language:** every string the UI or an export renders (labels, titles,
  tooltips, empty states, chips, placeholder/help copy, glossary and
  seed-doc prose, exported report prose, surfaced errors) names what the
  user knows — matches, players, rounds, stats, metrics, pins, built-ins,
  processing/behind states — and never an implementation artifact: no
  programming language, no database table or column, no developer
  shorthand. Metric expression text, the expression editor and the SQL
  console are power surfaces: they speak developer by design.
- **User-facing text is tiered by length:** common locations stay terse —
  short, but never lying or misleading; hints may run a little longer;
  anything longer than that demands a help button linking to the user
  guide, which carries the full detailed explanation.
- **Input hints speak in actions:** an input's placeholder tells the user
  what to do — an imperative ("Search players…"), never a bare example
  ("e.g. de_mirage").
- **Feature-parity with competitors is evidence, never justification.**
- **Never present a feature the app cannot fully support offline.**
- **Valve IP never ships:** extracted CS2 assets are re-extractable
  from the user's install, never bundled.
- **Breaking changes:** at-will before the first release; after 1.0,
  major versions only.
- **The manual stays in lockstep:** any change that alters user-visible
  behavior, surfaces, or wording updates the user guide in the SAME
  change — the manual is never a follow-up.

### Facts, metrics and records — every number has a class

Ratified 2026-11-18. Every number the app renders belongs to exactly
one of three classes:

- **Fact** — a recorded observation at its declared grain: a value the
  demo or its analysis pass recorded, read straight from its row (a
  player's kills in a match, a round's equipment values, the final
  scoreline). A fact carries no formula; nothing is derived when it is
  read.
- **Metric** — an expression over facts, carrying its formula and its
  N: the gameplay-statistics layer. Seeded built-ins and user
  definitions are equal citizens, and **Honest metrics** above is their
  contract.
- **Record** — rows, labels and series displayed as what they are:
  event rows, chat, buy-class chips, chart series. A record never
  poses as a statistic, and a statistic never hides behind a record.

The classification is **closed**: a new rendered number joins one of
those three classes — it never invents a fourth, and a number is never
re-classified at a call site. A number that renders outside the three
classes is an **exception**, and the exception list is closed and
ratified (audited 2026-11-18): each member below carries the one-line
reason it was kept. Growing the list is an owner decision recorded
here, never an implementation shortcut. View-computed numbers remain
governed by the view-level-aggregate rule in `AGENTS.md` — a pure
function over already-fetched rows with its formula on the card, and a
value a stored metric can carry relocates into one.

| Exception | Where it lives | Why it stays ratified |
|---|---|---|
| **Playhead "so far"** — live K/D/A + ADR at the playhead | `lib/replay/livestats.js` (Replay's player cards) | A transient position over the events the playhead has passed: no stored subject can address "partial match up to X" honestly (a stored value there would go stale by definition), and the surface discloses the fold in its own copy. |
| **`scoreThrough`** — the scoreline as of round N | `lib/rounds.js` (Round detail's score, the replay HUD, round picker labels) | A pure view aggregate over already-fetched rounds — cumulative counted wins by side — and the ONE scoreline aggregate: it cites the view-aggregate rule in its own comment, never re-spelled at a call site. |
| **UI row counts** — counts of a view's own rows | Library's showing-count, the Reports appendix's row counts, console pagination | Inventory of what is on screen right now — never a statistic about the game, so no formula or N could apply. |
| **`score`** — the final scoreline | The scoreboard's fixed Score column, the library's score sorts, the appendix's raw offer | A recorded game result read off its column; it has no seed by owner ruling — a sum over a per-match scoreline has no honest reading. |
| **Sort-on-raw (narrowed)** — recorded columns as ordering keys | `store`'s scoreboard sort whitelist (fetch row order only) and the scoreboard comparator's raw arm (name / side / score) | Ordering keys may name recorded columns only; displayed values always come from their class's canonical read, so a stale row never re-orders the view. The whitelist is narrowed to the id-keyed fetch's one seed — no displayed statistic is ever read raw to sort it. |
| **Appendix records** — recorded values offered in Reports | The appendix's recorded-value offer, exactly `raw:score` | Recorded fields with no seed, offered as recorded (each player's stored round count beside the value), never as a computed metric — one entity per stat, never a raw twin beside a metric. |
| **Raw event reads + the dated selfkill render exception** | Event surfaces, exports, and `lib/replay/selfkill.js` | Event surfaces record what happened: raw reads, the events table and every export keep every row. The ONE dated deviation (2026-11-18): a disconnect self-kill death line never renders on the feed list, the kill ticker or the death marker — a disconnect side-effect is not an event-shaped fact worth showing, the row stays in the record, and its predicate is imported, never re-spelled. |

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
  we fall back to a bare loading indicator — whose shape is the centered
  spinner with its details text underneath, never a number (see
  **Progress presentation** below). This is about perceived
  latency and honest feedback serving the **cockpit** (everything within
  reach) feeling and the **Honest metrics** principle — not prefetching
  everything at any cost: wasted work must always be cheap to abandon
  (a bail-out), so eager loading never becomes a resource obsession, and
  loading flags are transient — they never persist or restore.
- **Progress presentation — outside a cell it is centered:** a progress
  display shown OUTSIDE a table cell (row-shaped list items count as
  cells) is centered: a progress **ring** when the work can be
  quantified, a **spinner** when it cannot — an unknown denominator is
  indeterminate, so never a fabricated percentage — with its details
  text underneath it: what is actually happening (the existing stage
  vocabulary) plus the honest count or percentage. **Busy buttons are
  exempt** — a button that is working keeps its plain "Generating…"
  label. Progress inside a table cell or list row stays compact and
  inline (the small pill + bar): density there is deliberate, and the
  column-width arithmetic in the library tables depends on it. This is
  about perceived latency and honest feedback serving the **cockpit**
  feeling — the same motivation as the loading ladder above.
- **Every error indication is dismissible:** an error may gate an
  action, but the user must always be able to clear it in place — close
  it, acknowledge it, or make it go away by retrying — never be left
  stuck with a message whose only escape is navigating elsewhere or
  restarting the app. Errors stay honest about what happened and what
  to do next, and they are transient like every other UI flag.
- **The launch asset prompt is presence-driven:** it opens whenever
  any of the three asset families is missing (map packs / icons /
  sounds) — every launch, until extraction fills them; there is no
  suppression preference, and "Not now" / Escape dismiss for the
  session only.
- **Event surfaces record what happened:** kill feed, chat, round-MVP
  and similar event rows show bot names as they occurred; bots are
  filtered from rosters, aggregates and selections.

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
   checkboxes; when the owner has explicitly opened roadmap work, keep
   it updated as work lands.

## README rule

`README.md` is the app's **front page** — the GitHub repo is the
primary distribution channel, so README is player-facing product copy
(features, download), NOT developer documentation. Dev depth belongs in
`AGENTS.md` or the Makefile; keep README brief (its Developers section
= "how to run this repo locally", nothing deeper), and no screenshots
for now.
