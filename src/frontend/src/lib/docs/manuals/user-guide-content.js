// The user guide's WRITTEN sections — the researched content draft
// (2026-11-14) ported verbatim into the content model. Every claim in it
// was verified against the tree at port time; the draft's accuracy
// appendix (research artifact, stays in /tmp) cites each claim to
// file:line. user-guide.js composes these around the metric-language
// chapter: the draft's section order puts the manual between
// `metric-builder` and `reports`, which is why there are two exports.
//
// Port mechanics (same contract as metric-language.js): the wording is
// content, not chrome — do not "improve" a claim without re-verifying it
// against its cited source. The draft's `##` section headings become the
// section `title` (the popup renders the <h2>); content headings stay
// `#` (→ <h3>, no level skips). The draft's inline TOC was dropped (the
// popup renders its own — lead ruling 2026-11-14), its body carries NO
// links (same-document links would be `[text](#section-id)`, the
// DocBlocks/DocsPopup mechanism the metric-language chapter already
// uses), and no prose hard-codes a count (built-ins, sources, heatmap
// kinds, report templates, columns) — names are listed instead.
export const guideSectionsBeforeManual = [
  {
    id: 'introduction',
    title: 'Introduction',
    blocks: `Spectra is an **offline Counter-Strike 2 demo viewer and match analysis toolkit**. Everything runs
on your machine: no account, no sign-in, no upload, no subscription. The About panel in Settings
says it in one line — *everything runs on your machine; nothing is uploaded anywhere.*

The whole app is built around one loop: **import a demo → watch it → learn from it.** Every
screen exists to serve that loop.

The bar on the left edge is the way around:

- **Library** — your imported matches; every match detail view starts here.
- **Profiles** — every player in your library, and each player's career page.
- **Builder** — the metric Builder, where numbers are defined and previewed.
- **SQL console** — read-only queries over your whole library.
- **Settings** — at the bottom of the bar.

Two more things are worth knowing on day one:

- **Ctrl+K opens the command palette.** Jump to any of those views, or search matches, players, saved filters, metrics and saved queries in one box.
- **This guide** opens from the Help button on the sidebar (directly above Settings) and floats over whatever you were doing — your work stays exactly where it was behind it. The \`?\` in the Metric builder's header opens the same guide straight at the **Metric language** reference. The contents list on the left groups every section under its chapter: a chapter that has subsections carries a chevron to fold them away, the header search narrows the list and marks the matching text in it, in the section headings and in the matching body text, and the list always shows the chapter and the section you are reading.

Nothing in Spectra needs the network to work. The one thing it will reach out for, on its own and
silently, is a newer version of itself (see **Getting started**); you can also ask it to check
from Settings.`,
  },
  {
    id: 'getting-started',
    title: 'Getting started',
    blocks: `**1. The app opens on the Library.** That is your home base: the list of matches you have
imported, the **Import…** button, and anything currently importing.

**2. Extract the game assets the first time.** On a fresh install Spectra offers to read three
asset families out of *your* Counter-Strike 2 installation: the official radar images (map
backgrounds), the equipment icons, and the replay's sound effects. The prompt says so plainly —
*nothing from Counter-Strike ships with the app, and nothing is uploaded; your game files are read
locally and the extracted assets are stored in Spectra's data folder.* You get three choices:

- **Extract all CS2 assets** — runs the extraction with honest progress.
- **Choose folder…** — point Spectra at your CS2 install yourself, if it wasn't found.
- **Not now** — dismiss for this launch. The prompt returns on the next launch as long as any of the three families is still missing; extracting them is what ends the loop for good.

Without radar images, maps render as a plain grid — everything else still works. You can re-run
extraction any time from **Settings → CS2 assets** (it is safe to run again, and worth re-running
after a CS2 update).

**3. Import a demo** — see **Importing demos** below.

**4. Open a match and press Watch replay** — see **Understanding a match** and **The replay**.

**5. Learn the command palette (Ctrl+K).** One box for: the nav actions (plus *Toggle theme*),
matches (\`de_mirage · 13–9\`), players (with match counts), saved filters (applies the filter in
the event browser), metrics (jumps to the Builder) and saved queries (jumps to the SQL console).

**6. Updates.** Spectra checks GitHub Releases for a newer version when it launches and offers to
install it when one exists; it tells you when you are already up to date. **Settings → About →
Check for Updates…** does the same on demand. Development builds never check.`,
  },
  {
    id: 'importing-demos',
    title: 'Importing demos',
    blocks: `Spectra reads \`.dem\` and \`.dem.zst\` demo files. Anything else is refused with *"unsupported file
type (expected .dem or .dem.zst)"*. There are three ways in.

# Three ways in

- **Import…** (Library header) — opens your system's file picker; select one or several demos.
- **Drop files** anywhere on the Library panel — the whole panel is a drop target.
- **Import dirs** — folders you nominate in **Settings → Import dirs**. The Library lists the \`.dem\` / \`.dem.zst\` files found under them in the **Demos from your import dirs** panel, each with its own one-click **Import** and a **Refresh** to rescan. Subfolders are scanned up to four levels deep; hidden folders are skipped; demos already in the library are left out. Until you customize it, the defaults are your Downloads folder and CS2's own replay folder, where the client saves downloaded matches.

Your original files are **never moved, modified or deleted** — importing only reads them.

# What happens during an import

Imports run in the background; you keep working. Each one shows as its own row with a live
status chip — queued, then parsing with progress and the current stage — and a control to cancel
it while it runs. Queued imports appear ahead of the match list until their row lands. The number
of heavy background tasks (imports, rules re-runs, asset extraction) running at once is
controlled by **Settings → Background work → Parallel work**.

If an import fails, it lands in the **Recent import problems** panel at the top of the Library
with the file name and the reason, so a bad file never disappears silently.

# Duplicates are caught by content

Importing a demo you already have reports *"already imported (match N)"* on that import — the
check compares file contents, so a renamed or re-downloaded copy of the same demo is still
recognized. The same check runs while scanning import dirs, which is why the panel can mark a
file as already imported before you touch it.

# Keeping a copy (and giving the space back)

By default Spectra keeps its own copy of every imported demo (**Settings → Import dirs → Copy
demos into Spectra's data folder**) so **Re-parse** keeps working even if your original file moves
or disappears. Turn that off and imports only reference your original file — nothing is
duplicated, but Re-parse then needs that file to still exist.

Copies are evictable at any time:

- **Free copy** on a Library row (or in a match's Details tab) deletes just that match's copy — the match keeps everything it saved, including the replay.
- **Settings → Data → Free all demo copies** reclaims the whole folder at once.`,
  },
  {
    id: 'library',
    title: 'The Library',
    blocks: `The Library is the table of everything you have imported, and the hub every match view is
reached from. Click any row to open that match.

# The table

One row per match: **Map**, **Matchup** (the two team names, or the demo file name while the row
is still parsing), **W Score** and **L Score** (the winner's and loser's scores — both score
cells and the two team names are tinted with the colour of the side each team started on), **Rounds**, **Duration**, **Size**, **Imported** (when
Spectra read the file), **Status**, and the row's actions. Every column except the matchup sorts
by clicking its header.

A row that has never finished importing shows dashes wherever no value has ever been computed —
never a made-up 0.

# Filtering and sorting

Two filters sit in the header, and they combine: **Map** (type or pick a suggestion, e.g.
\`de_mirage\`) and **Player** (every player in your library). A filled input is an active filter;
each has its own clear, and **Clear filters** resets both. The list loads in pages — **Load more**
appends the next window beneath the rows already on screen.

# Status and actions

The **Status** column carries a chip: \`ready\`, \`failed\` (with the reason on hover), or
\`queued\` / \`parsing\` with a live progress bar and the current stage. Depending on the row's
state you get:

- **Cancel / Remove** — while an import or re-parse owns the row: **Remove** takes a queued one out of line (nothing read yet), **Cancel** stops a running one.
- **Re-parse** — runs the import again from Spectra's copy when one exists (or your original file when it doesn't). It is also the fix the app offers when a match turns out to have no replay data (see **The replay**).
- **Free copy** — shown only while a managed copy exists.
- **Delete** — removes the match's data, behind a confirmation. If a managed copy exists, a second confirmation offers to delete that copy too; otherwise your original file is never touched.

# Problems and empty states

**Recent import problems** lists recent failed or cancelled imports with their status and the
reason. When the library is empty the panel says *No matches yet* and points at the Import button
or a drag-and-drop — and a failed load never masquerades as an empty library; the error is shown
instead.`,
  },
  {
    id: 'understanding-a-match',
    title: 'Understanding a match',
    blocks: `A match page opens from any Library row. It is a header, a round strip, and a row of tabs.

# The header

The two team names and the final scoreline, then **Watch replay** (the primary action — it opens
the replay at its default starting point), followed by the map, the match duration, the patch,
and the match's status chip. If the import produced warnings, a dismissible **Import warnings**
panel lists them; when there are none it says *None — this demo imported cleanly.*

# The round strip

One cell per round under the header: tinted by the side that won, with an arrow pointing at the
team that won it (so the arrow follows the team across the halftime side switch), and separators
at halftime, at the regulation/overtime boundary and every few overtime rounds. Click a cell to
open that round.

# The tabs

**Overview · Scoreboard · Rounds · Economy · Utility · Combat · Heatmaps · Reports · Details.**
The tab you are on travels with you: open a round, a comparison, the replay or a player's
profile from a tab, go back, and you land on that same tab again.

**Overview** — the headline cards (**Top fragger**, **Best ADR**, **Most util**, **Entry
opens**, **Most MVPs**) and both rosters with K/D/A and ADR. Clicking a card or a roster row
opens the replay with the camera on that player; clicking a player's name opens their profile.

**Scoreboard** — the sortable per-player table: the fixed columns (name, team, K, D, KDA,
damage, rounds, opening K/D, utility damage, MVPs, score), then **one column per metric you
have pinned** (the defaults pin A, ADR, KAST%, HS%, K/D, the multi-kill counts (2K–5K),
entries, trades and best streak), each with an ⓘ carrying its formula, and sortable. The
player column stays put while you scroll across the metrics, so you never lose the statline
you are reading. Expand a row (the chevron) for kills by weapon, damage by weapon and
the utility numbers. Bots never appear here — the scoreboard lists human players only. A row
click opens the replay following that player; the name cell opens their profile.

**Rounds** — one row per round: number, winner, the **buy-type class** chip for each side
(pistol / anti-eco / eco / force / full / bonus / save — hover a chip for the rule text and rules
version), win reason, duration, bomb site, MVP, the first blood, and the kill count. Click a row
for the round page. Tick the **Cmp** boxes on up to four rounds and a
**Compare N rounds** button appears.

**Details** — *Key facts* (server, tickrate, frame count, file size, import date, voice presence,
warning count, the source file and whether a managed copy exists)
followed by the demo's import diagnostics: import details (parse time, notes),
advanced diagnostics, and the network-message reference.

# Round detail

Reached from any round cell or row. The **round ribbon** (Previous / Next round around the round
strip) sits at the top, then **Watch round** (opens the replay at that round's start) in the
header, then the cards: **Round info** (duration, bomb site, MVP, winner, win reason and the
score so far), **Kills**, **Bomb**, the round's **Economy** (per-side buy class, equipment and
money), and the **Round chat**.

# Compare rounds

The side-by-side page for the rounds you ticked (2–4). Each column shows the round's result and
buy class, its **Economy** (equipment, money spent, buy classes), a **Loadout summary** (kills,
first blood, bomb site, MVP), its **Utility** throws, and the **Event sequence**; each column
ends with a play button (**Replay from the round start**) and **Round detail**.`,
  },
  {
    id: 'match-analysis',
    title: 'Match analysis',
    blocks: `The analysis tabs of a match do the heavy work. Calculated figures in them carry their formula or
their rule on hover, and Spectra marks what it *reads* from the demo apart from what it *works
out* — a dotted header or an **inferred** badge means calculated, with the rule on hover.

# Economy

- **The curve** — *Equip value per round* or *Team net worth per round*, one line per team, with a legend and a round strip under it. Hover for values; click a column to open that round.
- **Four summary cards** — *Pistol → next round* (pistol wins held the next round), *Force-buy win rate*, *Winner equipment value advantage* (average winner−loser equipment at freeze time end), and *Lost equipment* (marked **inferred**). Each card's tooltip states the exact formula, and clicking it watches the relevant round in the replay.
- **Buy types** — one row per round with both sides' buy-class chips (click a chip for the reason it was classified that way), equipment values, and each side's round loss bonus. The footnote names what the columns mean: equipment value is the gear a side *holds* at freeze time end — never that round's spend — and the loss-bonus ladder runs $1400 → $3400 in $500 steps: a loss steps it up, a win steps it down (never a full reset), and every half starts one level up, so a pistol loss pays $1900.

# Utility

- Filters: **Kind** (all grenade kinds) and **Thrower** (all players), with a live *n of m grenades* count.
- **Utility damage per round** — a bar per round, split by thrower team.
- **Flash effectiveness** — total blind time and affected players per team (marked **inferred**: calculated from the demo's blind events).
- **The throw log**, grouped by round — each throw shows its kind, thrower, time into the round, damage, total blind time, affected players and the detonation coordinates, with a ▶ that seeks to the throw (±10 s loop) and follows the thrower.

# Combat

- **Combat stats** — damage dealt without a kill, kill conversion %, friendly-fire damage, Entry%, Trade%, untraded deaths, missed trades, and KAST% (click KAST% for that player's per-round K/A/T/S grid).
- **Engagements** — every detected duel, filtered by independent **opening** / **trade** / **traded** / **untraded** toggles (one kill can carry several; selected toggles combine as OR, so a duel matching any of them shows), with the killer and victim, distance, and a ▶ that follows the *killer*. With every toggle off — the default — nothing is filtered and every duel shows.
- **Clutches** — the detected 1vN situations (found by counting who is still alive when a side drops to one player), with size, player, outcome, bomb state and HP left; **won** / **lost** toggles filter the list, and ▶ follows the lone player.

# Heatmaps

Pick a **Kind**, choose **Floor** (on multi-floor maps), narrow by **Player**, **Side** and a
round range, then **Generate** — heatmaps are computed on demand, and changing a control marks
the one on screen as needing a **Regenerate**. Kinds are grouped as:

- **Overview** — presence, kills, deaths, damage and K/D.
- **Grenade thrown** — one per grenade type.
- **Grenade detonation** — one per grenade type.

The map carries a legend showing the value range the colours stand for (K/D is drawn on a
two-sided scale). On kinds that carry event rows, dragging a box over the map opens the replay
filtered to what happened there — a single click opens one square — while kinds with no rows
behind them say so instead of pretending a selection did something.`,
  },
  {
    id: 'replay',
    title: 'The replay',
    blocks: `The replay is Spectra's 2D viewer: a radar map of the demo playing out in real time, no CS2
install required.

# Opening it

- **Watch replay** in a match header.
- Any ▶ or watch button in the analysis views, round detail or compare view — an event-level drill loops ±10 s around that event and often starts the camera following a specific player; a round-level one plays the round from its start.
- A roster or scoreboard row click — opens the replay following that player.

Leaving the replay does not stop it: it collapses into a small dock in the bottom-right corner
and keeps its place. **Minimize** puts it back in the dock; the dock's **✕** closes it for good
(it reloads when reopened); the dock's own play/pause works without expanding. Theater mode
hides the top bar and the transport for a clean view.

# Transport

A full-width scrubber with event markers and the playhead time, then: play/pause, frame step,
**−15 s / +15 s**, **previous / next round**, playback speed (**0.25× to 8×**), **Skip freeze
time** (auto-jump the pre-round freeze during playback), a **Loop range** control (set from/to
times, toggle the loop, or loop ±10 s around the playhead), camera mode, follow-player, UI
overlay toggles, drop markers, volume, snapshot, clip recording, and a keyboard-hints button.

# Camera

- **Smart** — keeps every player and the bomb on screen with smooth pan/zoom; dragging or wheeling takes over into Free.
- **Free** — fully manual.
- **Follow** — locks onto a player (pick from the list; \`1\`–\`9\` select, \`0\` picks, \`F\` toggles; dragging releases).

# On stage

Two columns of player cards (finished-CT left, finished-T right) show each player's health,
armour, dead/follow state, a speaking dot while voice plays, and — for the audio — a **mute
button per player** plus a **team mute**. Toggle overlays individually: **Score/timer**, **Kill
feed**, **Chat** (the in-game chat rendered in the scene) and **Stage indicators**. **Drops**
shows dropped guns, utility and defuse kits on the map (off by default).

# Sound

The volume popover carries six faders — **voice, guns, utility, C4, announcer, footsteps** — each
with its own mute (footsteps ship muted). The same faders live in Settings → Audio & voice and
survive restarts. Sound effects come from your own CS2 install; voice is decoded as the replay
plays and stays in sync, with no extra disk space. Some demo sources record no voice at all — the
match's Details tab tells you whether this one does.

# Capturing

- **Snapshot** (\`S\`) saves a PNG of the current frame.
- **Record clip** records a WebM clip — the loop range if one is set, otherwise 10 seconds from the playhead. On Linux, WebM encoding needs the GStreamer \`gst-plugins-good\` package; the button says so if it's missing.

# The event feed

The rail on the right is the event browser for the match. One **Filters** toggle reveals
everything: a **Categories** multi-select (kills, deaths, round wins, round starts, bomb,
grenade throws/detonations/landings/bounces, dropped items, damage, flashes & blinds, joins &
leaves, buys, footsteps — round starts are on by default), then round range, player, side, team, weapon,
distance range, headshot and a position filter, plus **saved filter presets** (save, apply,
delete, reset). The loaded feed exports as **CSV or JSON**. Selecting an event opens its detail
pane with the participants, a filter over its payload keys and a raw-JSON toggle.

# Keyboard shortcuts

| Key | Action | Key | Action |
|---|---|---|---|
| \`Space\` | play / pause | \`L\` | toggle loop |
| \`,\` \`.\` | speed down / up | \`F\` | toggle follow |
| \`←\` \`→\` | step one frame | \`1\`–\`9\`, \`0\` | select a player to follow |
| \`Shift\`+\`←\` \`→\` | step ~1 second | \`X\` | skip freeze time |
| \`[\` \`]\` | previous / next round | \`S\` | snapshot |

If a match has no replay data, the stage says so and offers **Go to Library** — running
**Re-parse** on the match in the Library is the fix.`,
  },
  {
    id: 'profiles',
    title: 'Profiles',
    blocks: `**Profiles** (sidebar) is the directory of every human player in your library — *click a row for
their profile* — with a search box, a live count, and sortable **Player / Matches / ADR / Last
import** columns. Empty states say *No players yet* (with a pointer to importing) or *No players
match "…"*.

A player page opens with a back button (to wherever you came from), the player's name and Steam
id, and a player search box to jump to someone else. Then:

- **Headline cards** — Matches (with wins) and Win%; the profile's other headline numbers
  (opening-duels win rate, clutches, ADR, KAST%, …) render as cards in **Career metrics** below.
- **Career metrics** — every profile-scope metric you have pinned, as name/value cards with the usual honest states (a number, a dash when there is no data for this player, or a state chip while a value is recomputing). This panel appears once something is pinned.
- **Trend** — any match-scope metric you have (ADR, KAST%, K/D, HS%, …) across the player's
  matches: search the metric picker for the one you want, then click a point to open that match.
- **Sides** — CT vs T rounds, win rate, ADR, KAST, K/D.
- **Maps** — matches, wins and ADR per map; click a row to open the Library filtered to that player and map.
- **Weapons** — kills, damage and headshots per weapon.
- **Match history** — most recent first: import date (CS2 demos record no played time, so this is when Spectra read the file), map, win/loss, score, starting side, K/D/A, ADR and KAST%; click a row to open the match.`,
  },
  {
    id: 'metric-builder',
    title: 'The metric Builder',
    blocks: `**Builder** (sidebar) is where numbers are defined. A **metric** is one number for one player —
"this player's trade rate", "this player's KAST%" — and every metric carries its own written
formula and sample-size honesty (a value is never invented; missing data shows as a dash or an
honest zero beside its \`N\`).

The **left column** lists every metric, grouped **Builtins / Yours / Plugins**, with a search box
and one **Filters** panel (origin, scope, denominator and format). Each row has a ▶ to preview
it, a pin to place it, and — for metrics you created — a delete. **New** starts a fresh metric;
**Order…** opens the ordering dialog.

The **editor** on the right has:

- **Name** (the identifier other formulas reference), **Title** (display label) and an optional **Short name** for narrow columns.
- **Scope** — *match* (this player in this match) or *profile* (this player's career).
- **Format** — how the value is displayed (auto, integer, one/two decimals, percent, currency).
- **Denominator** — none, \`rounds\` or \`matches\` (what a total is divided by to become a rate).
- **Doc (formula, required)** — the plain-language explanation shown in the ⓘ next to the number; saving without it is refused.
- **Expression** — the formula itself, checked as you type: *checking…*, *valid*, or the exact error with the byte position in your text.

**Save metric** stores it; the button reads *Saved* while nothing has changed. **Pin** places the
metric: a match-scoped metric becomes a column on the scoreboard, a profile-scoped one a row on
the player's profile. Saved metrics are appended to match reports in Reports.

**Built-ins are read-only** — they load with a \`built-in\` chip and a disabled Save (*Built-in
metrics can't be edited*), but you can still preview, reference and pin them. Plugin metrics
carry a *read-only source* chip; saving one stores a copy as your own metric.

**Preview** runs the expression read-only against your library: one row per player with the value
and its **N**. A saved, unmodified metric previews the values already stored (the panel names
which unit they came from); an unsaved or edited expression is calculated on the spot — which is
why an ad-hoc preview notes that the denominator applies after save. State chips appear in place
of numbers while a value is recomputing or has failed.

**Order…** arranges the pinned metrics: the fixed stats (Name, Team, K, D…) always come first and
cannot be reordered, while your pinned metrics — built-in and your own — reorder below them with the
↑↓ buttons (or the ↑/↓ arrow keys). **Reset order** restores the defaults.

For the formula language itself — sources, operators, scopes, references, worked examples and
every error message — see the next section.`,
  },
];

export const guideSectionsAfterManual = [
  {
    id: 'reports',
    title: 'Reports',
    blocks: `**Reports** builds a document from a match, a player or a round. It lives as a tab on every match
(where the target is that match), and the same page is reachable on its own with a match picker.

**Template & target** — pick one of the templates: **Match report**, **Match report (HTML)**,
**Player report**, **Round report** (plus any a plugin contributes); each card shows its scope
and format. Then pick the target the template needs — the match, a player, or a round number —
and press **Save report** (at the top of this panel) to write the document to disk.

**Stats appendix** — type into the stats field to search the match-scoped stats and pick one:
it lands as a chip, and each picked stat earns a line under the field carrying its expression
and its row count — while it has no computed number for this match, that line shows its state
chip instead. Remove a chip with its ✕, or with Backspace while the field is empty; with no
chips the saved document carries no appendix. Picked stats and their sections follow the same
order as everywhere else.

**Save report** renders the template's body, composes every picked stat's table onto it and
hands the whole document to the save dialog; the filename ends in .md or .html to match the
template's format.`,
  },
  {
    id: 'sql-console',
    title: 'SQL console',
    blocks: `**SQL console** (sidebar) is a read-only query window over your whole library — for when you want
the data on your own terms. It is read-only by construction: the statement runs on a separate
read-only connection, one statement at a time, and writes and multi-statement scripts are
rejected before they run.

- **Schema** (left) — every table with its note; expand one to see its columns and types, and click a column name to insert it into your statement.
- **Statement** — the editor; **Run** or **Ctrl/Cmd+Enter**. The stated limits are *rows cap 5,000 · timeout 5 s*.
- **Results** — the row grid with the query time, the row count, and a *truncated* chip when the cap was hit. The grid renders the first 2,000 rows; exports always carry every returned row.
- **Export CSV / Export JSON** — saves the result of the last run.
- **Saved queries** — give the current statement a name and description, save it, re-run it later, delete what you no longer need.
- **History (last 50)** — the statements you have run, with **Clear**.`,
  },
  {
    id: 'settings',
    title: 'Settings',
    blocks: `**Settings** (bottom of the sidebar), section by section:

- **About** — the version, the one-line privacy statement, and **Check for Updates…**.
- **Data** — where your database, matches folder and demo copies live (with the copy count and total size), the parser version, and **Free all demo copies**. Matches keep everything they saved; Re-parse then needs your original file.
- **Import dirs** — add or remove folders (**Add folder…**), **Reset to defaults**, and the **Copy demos into Spectra's data folder** toggle (on by default — see **Importing demos**).
- **Background work** — **Parallel work**: how many heavy background tasks (imports, rules re-runs, asset extraction) run at once. 1 = one at a time; the default and maximum are this machine's parallelism, and a change applies to work already queued.
- **CS2 assets** — detects your Counter-Strike 2 install and reports what has been extracted (radar packs, equipment icons, replay sounds), with **Choose folder…** and **Extract all CS2 assets**. Safe to re-run; worth re-running after a CS2 update.
- **Appearance** — theme (**Dark** / **Light**) and font size (small / medium / large — the whole UI scales). Both apply immediately and are remembered.
- **Plugins** — install a bundle from a path (a directory with a plugin manifest, or a single manifest file); enable, disable and remove them. They contribute metrics and report templates on the next list — no restart. The panel's own warning stands: install only bundles you built or got from someone you trust; there is no auto-update.
- **Audio & voice** — a **Run audio self-test** that checks Spectra can open your audio device, and the same six volume faders the replay uses (they stay in sync). Sound effects are extracted from your local CS2 install; voice is decoded as the replay plays. Voice-to-text transcription isn't available yet.
- **Analysis rules** — the thresholds that decide Spectra's analysis: **Trade window (seconds)**, **Full-buy threshold (equip $)**, **Trade-opportunity distance (units)** and **Force threshold (equip $)**. **Save rules** stores them and, when a rule actually changed, recomputes the matches behind the new rules in the background — their numbers refresh as each match finishes, so there is no manual re-run step.`,
  },
];
