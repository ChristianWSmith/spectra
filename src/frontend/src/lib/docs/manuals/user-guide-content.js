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
- **Match** — the match itself, reached from any Library row. This tab is greyed out until you open one, and then goes back to the last match you had open.
- **Profiles** — every player in your library, and each player's career page. Clicking it again returns to the player you had open.
- **Builder** — the metric Builder, where numbers are defined and previewed.
- **SQL console** — read-only queries over your whole library.
- **Settings** — at the bottom of the bar.

Two more things are worth knowing on day one:

- **Ctrl+K opens the command palette.** Jump to any of those views, or search matches, players, saved filters, metrics and saved queries in one box.
- **This guide** opens from the Help button on the sidebar (directly above Settings) and floats over whatever you were doing — your work stays exactly where it was behind it. The \`?\` in the Metric builder's header opens the same guide straight at the **Metric language** reference. The view headers carry their own \`?\` too — **Replay**, **Match**, **Library**, **Reports**, **Settings** and the **SQL console** open the guide at the section that covers what you are looking at, and Match's follows the tab you are on. The contents list on the left groups every section under its chapter: a chapter that has subsections carries a chevron to fold them away, the header search narrows the list and marks the matching text in it, in the section headings and in the matching body text — press \`Enter\` for the next match, \`Shift+Enter\` for the previous one, or use the two arrow buttons beside the search box — and the list always shows the chapter and the section you are reading.

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

- **Extract all CS2 assets** — the prompt closes right away and the extraction carries on in the background: its honest progress shows in the floating work indicator at the bottom right of every view, and that indicator's ✕ hides it without stopping anything.
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
- **Import dirs** — folders you nominate in **Settings → Import dirs**. The Library lists the \`.dem\` / \`.dem.zst\` files found under them in the **Demos from your import dirs** panel, each with its own one-click **Import** and a **Refresh** to rescan. Subfolders are scanned up to four levels deep; hidden folders are skipped; empty files are skipped; demos already in the library are left out. Until you customize it, the defaults are your Downloads folder and CS2's own replay folder, where the client saves downloaded matches.

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
reached from. Click any row to open that match in the **Match** tab.

# The table

One row per match: **Map** (with the map's own icon in front of the name
once the CS2 assets have been extracted), **Matchup** (the two team names, or the demo file name while the row
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
    blocks: `A match page opens from any Library row — or from the **Match** sidebar tab, which goes
back to the last match you had open. It is a header, a round strip, and a row of tabs.

# The header

The two team names and the final scoreline, then **Watch replay** (the primary action — it opens
the replay at its default starting point), followed by the map, the match duration, the patch,
and the match's status chip. If the import produced warnings, a dismissible **Import warnings**
panel lists them — a very long list shows its opening entries and says how many more there are;
when there are none it says *None — this demo imported cleanly.*

# The round strip

One cell per round under the header: tinted by the side that won, with an arrow pointing at the
team that won it (so the arrow follows the team across the halftime side switch), and separators
at halftime, at the regulation/overtime boundary and every few overtime rounds. Click a cell to
open that round.

# The tabs

**Overview · Scoreboard · Rounds · Economy · Utility · Combat · Heatmaps · Reports · Details.**
The tab you are on travels with you: open a round, a comparison, the replay or a player's
profile from a tab, go back, and you land on that same tab again.

**Overview** — the headline cards (the defaults are **Top fragger**, **Best ADR**, **Most
util**, **Entry opens** and **Most MVPs**; the metric Builder's **Order…** dialog picks which
cards show and in what order — each card names that metric's leading player beside that
player's stored value) and both rosters with K/D/A and ADR. Clicking a card or a roster row
opens the replay with the camera on that player; clicking a player's name opens their profile.

**Scoreboard** — the sortable per-player table: the fixed columns (name, team, score), then
**one column per metric you have pinned** (the defaults pin kills, deaths, damage, utility
damage and MVPs as well as A, ADR, KAST%, HS%, K/D, KDA, the multi-kill counts (2K–5K),
opening kills and opening deaths, trades and best streak), each with an ⓘ carrying its
formula, and sortable. Sorting
builds on the order you already see: sort a second stat and the first one's order still holds
inside it, so nothing you sorted by is lost. The transpose button in the top-left cell flips the
table to one row per stat and one column per player, keeping the players in the order they were
in and clearing the sort marks until you sort again; in that shape the stat column is the one
frozen at the left edge as you scroll across the players. The player column stays put while you
scroll across the metrics, so you never lose the statline you are reading. Bots never appear
here — the scoreboard lists human players only. In the player-row layout a row click opens the
replay following that player, and the name cell opens their profile; transposed, the profile
link travels with the name into the player column headers, with the team chip on its own line
beneath it.

**Rounds** — one row per round: a ▶ that watches the round in the replay, the compare box, the
number, winner, win reason, duration, bomb site, MVP, the first blood, and the kill count. The ▶
opens the replay at that round's own start with the round's span looped and a return to this tab;
clicking anywhere else in the row opens the round page. Tick the **Cmp** boxes on up to four
rounds and a **Compare N rounds** button appears.

**Details** — *Key facts* (server, tickrate, frame count, file size, import date, voice presence,
warning count, the source file and whether a managed copy exists)
followed by the demo's import diagnostics: import details (parse time, notes) and advanced
diagnostics.

# Round detail

Reached from any round cell or row. The **round ribbon** (Previous / Next round around the round
strip) sits at the top, then **Watch round** (opens the replay at that round's start) in the
header, then the cards: **Round info** (duration, bomb site, MVP, winner, win reason and the
resulting score), **Kills**, **Bomb**, the round's **Economy** (per-side buy class, equipment and
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
- **Summary cards** — one card per stat the tab shows. The shipped set covers *Pistol → next round* (pistol wins held the next round), force rounds won and force rounds played per team, *Winner equipment value advantage* (average winner−loser equipment at freeze time end), and *Lost equipment* with its per-team split (marked **inferred**). Which stats appear is reconfigurable from the metric order dialog's Economy toggles (below); each card's tooltip states the exact formula, and a card whose stat names a round watches that round in the replay.
- **Rounds** — one row per round: a ▶ that watches the round in the replay, both sides' buy-class chips (click a chip for the reason it was classified that way), each side's deaths in that round under **CT Deaths** / **T Deaths**, and each side's round loss bonus drawn as a stack of five pips filled up to that side's step (hover a cell for the exact amount). The loss-bonus ladder runs $1400 → $3400 in $500 steps: a loss steps it up, a win steps it down (never a full reset), and every half starts one level up, so a pistol loss pays $1900.

# Utility

- **The throw log** — the first card, holding the **Kind**, **Thrower** and **Round** filters with a live *n of m grenades* count. The Round filter shows one round at a time — the first round with throws is selected to keep the log compact — and **All rounds** shows every throw in the filter: kind, thrower, time into the round, damage, total blind time, affected players and the throw coordinates, each with a ▶ that seeks to the throw, loops around it for your loop length, and follows the thrower.
- **Utility damage per round** — a bar per round, split by thrower team; while the current filter leaves nothing to plot, the card hides itself instead.
- **Blind time per round** — the same bars for the total blind time each team's flashes applied (marked **inferred**: calculated from the demo's blind events); it hides itself too while the filter carries no blind time, and both cards return as soon as there is something to draw.

# Combat

- **Engagements** — every detected duel, filtered through a **Kind** dropdown of checkboxes — **opening** / **trade** / **traded** / **untraded** (one kill can carry several; checked kinds combine as OR, so a duel matching any of them shows, and the closed dropdown states the current selection, reading **All kinds** whenever nothing narrows the list) and by a **Round** dropdown beside it — round 1 is selected by default, **All rounds** shows every duel, and each round option is labelled by its scoreline (**RD7 | 4-3**), with the killer and victim, distance, and a ▶ that follows the *killer*. With no kind checked — the default — no kind filter applies, so every duel of the selected round shows.
- **Clutches** — the detected 1vN situations (found by counting who is still alive when a side drops to one player), with size, player, outcome, bomb state and HP left; **won** / **lost** toggles filter the list, and ▶ follows the lone player.

# Heatmaps

Pick a **Kind**, choose **Floor** (on multi-floor maps), narrow by **Player**, **Side** and a
round range, then press **Generate** — heatmaps are computed on demand, and changing a control marks
the one on screen as needing a **Regenerate**. The filter controls sit on the map card itself,
and **Generate** waits in the card's bottom-right corner from the first open onward — beside
**Save image** once a heatmap exists — with the round options labelled by their scoreline (**RD7 | 4-3**). Kinds are grouped as:

- **Overview** — Presence, Kills, Deaths, Damage and K/D.
- **Grenade thrown** — one per grenade type.
- **Grenade detonation** — one per grenade type.

The map carries a legend showing the value range the colours stand for (K/D is drawn on a
two-sided scale). Once a heatmap is generated, **Save image** in the map card's corner writes
the picture — radar and heatmap together — to a file you choose. On kinds that carry event
rows, dragging a box over the map opens the replay filtered to what happened there — a single
click opens one square — while kinds with no rows behind them say so instead of pretending a
selection did something.`,
  },
  {
    id: 'replay',
    title: 'The replay',
    blocks: `The replay is Spectra's 2D viewer: a radar map of the demo playing out in real time, no CS2
install required.

# Opening it

- **Watch replay** in a match header.
- Any ▶ or watch button in the analysis views, round detail or compare view — an event-level drill loops around that event for the length set in **Settings → Replay** and often starts the camera following a specific player; a round-level one plays the round from its start. The replay's own event feed does the same in place, without leaving the replay.
- A roster or scoreboard row click — opens the replay following that player.

Leaving the replay does not stop it: it collapses into a small dock in the bottom-right corner
and keeps its place. **Minimize** puts it back in the dock; the dock's **✕** closes it for good
(it reloads when reopened); the dock's own play/pause works without expanding. Theater mode
hides the top bar and the transport for a clean view.

# Transport

A full-width scrubber with event markers and the playhead time, then: play/pause, frame step,
**−15 s / +15 s**, **previous / next round**, playback speed (**0.25× to 8×**), **Skip freeze
time** (auto-jump the pre-round freeze during playback), a **Loop range** control (set from/to
times, toggle the loop, or loop around the playhead for the length set in **Settings →
Replay**), camera mode, follow-player, UI overlay toggles, drop markers, volume, snapshot, clip
recording, and a keyboard-hints button.

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
distance range, headshot and a **Position** row where the world-space bounds are typed in
directly (minimum and maximum on each axis) or cleared, plus **saved filter presets** (save, apply,
delete, reset). The loaded feed exports as **CSV or JSON**. Selecting an event opens its detail
pane with the participants, a filter over its payload keys and a raw-JSON toggle. The row's play
button — and **Watch this event** in that pane — open a loop of the length set in **Settings →
Replay** around the event and start playing from the beginning of that loop; **Hear around the
event** does the same with voice on.

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
match "…"*. The sidebar's **Profiles** tab opens this directory the first time you use it, then
takes you back to the last player you had open.

A player page opens with a back button (to wherever you came from), the player's name and Steam
id, and a player search box to jump to someone else. Then:

- **Headline and career cards** — one block of square name/value cards: every profile-scope
  metric you have pinned (Matches with its wins sub-line, Win%, opening-duels win rate,
  clutches, ADR, KAST%, …) with the usual honest states (a number, a dash when there is
  no data for this player, or a state chip while a value is recomputing). The cards wrap
  outward from the center; the defaults pin Matches and Win% ahead of the rest, and with
  nothing pinned you get no cards — the pin buttons and the metric builder's **Order…**
  dialog decide what shows and where it sits.
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
    blocks: `**Builder** (sidebar) is where numbers are defined. A **metric** is one number for one subject —
a player ("this player's trade rate"), a match or a team — and every metric carries its own written
formula and sample-size honesty (a value is never invented; missing data shows as a dash or an
honest zero beside its \`N\`).

The **left column** lists every metric, grouped **Builtins / Custom / Plugins**, with a search box
and one **Filters** panel (origin, scope, subject, denominator, format and pinning — the last narrows
the list to pinned or to unpinned metrics). The list scrolls when it grows
past the window while those controls stay put. Each row has a ▶ to preview
it, a pin to place it, and — for metrics you created — a delete. **New** starts a fresh metric;
**Order…** opens the ordering dialog; **Running metrics** lists the metrics being computed right now
and can cancel any of them (see *Cancelling a running metric*).

The **editor** on the right has:

- **Name** (the identifier other formulas reference), **Title** (display label) and an optional **Short name** for narrow columns.
- **Subject** — what the number is *about*: *player* (one player's own number), *match* (the match
itself) or *team* (one side's number). A new metric starts as *player*; which subjects may combine
with which scope is decided when you save (a match or team has no career, so those refuse *profile*).
- **Scope** — *match* (this subject in this match) or *profile* (this player's career).
- **Format** — how the value is displayed (auto, integer, one/two decimals, percent, currency).
- **Denominator** — none, \`rounds\` or \`matches\` (what a total is divided by to become a rate).
- **Doc (formula, required)** — the plain-language explanation shown in the ⓘ next to the number; saving without it is refused.
- **Expression** — the formula itself, checked as you type: *checking…*, *valid*, or the exact error with the byte position in your text. The verdict sits on the actions line at the bottom of the editor, to the left of the hint, **Pin** and **Save**.

The editor heading carries the metric's state chip — *fresh*, *behind*, *failed* or *no-data* — to
the left of the *built-in* / *read-only source* chip; while a sweep is running, the card shows the
progress block underneath instead.

**Save metric** stores it; the button reads *Saved* while nothing has changed. **Pin** places the
metric: a match-scoped metric becomes a column on the scoreboard, a profile-scoped one a row on
the player's profile. Saved metrics are appended to match reports in Reports. For a metric you
created, that actions line opens with a **trash** button that deletes it; built-in and plugin
metrics show none (neither here nor on their list row).

**Built-ins are read-only** — they load with a \`built-in\` chip and a disabled Save (*Built-in
metrics can't be edited*), but you can still preview, reference and pin them. Plugin metrics
carry a *read-only source* chip; saving one stores a copy as your own metric.

**Preview** runs the expression read-only against your library: one row per subject with the value
and its **N** (per player for a player metric; per match or per team for a match- or team-subject
one). A saved, unmodified metric previews the values already stored (the panel names
which unit they came from); an unsaved or edited expression is calculated on the spot — which is
why an ad-hoc preview notes that the denominator applies after save. State chips appear in place
of numbers while a value is recomputing or has failed. Click a column header to sort the rows:
they open with the highest **N** first, the numeric columns order by their value (never by how the
number happens to be written), and a second click on the active header flips the direction.

Under the table, **compiled SQL (provenance)** shows the statement behind those values with the
numbers and text it used written straight into it, so you can copy it and run it as it stands —
in the SQL console or any SQLite tool. A formula that mixes a percentile with other aggregations
shows a second statement beside the first; that one still reads \`?\` where its values belong (they
are not carried over), and statements like these run one at a time.

**Order…** arranges what the scoreboard, the profile cards and the match overview show — three
lists in one dialog. The fixed stats (Name, Team,
Score) lead the scoreboard list by default; every row — fixed or metric — reorders with the ↑↓
buttons (or the
↑/↓ arrow keys), so a pinned metric can sit anywhere among them. The eye button on a fixed stat
hides it from its view without taking it off this list (the scoreboard's **Name** column is the
one that cannot be hidden), and a pinned metric's pin button unpins it: the row leaves this list
at once and the metric stops showing on its surface, while its slot in the order is kept, so
pinning it again restores its place. (On the profile list there are no fixed rows — its rows are
all pinned metrics, so each row's pin unpins it.) Every scoreboard-list metric row also carries
an **Economy** toggle: on, the metric's stat shows on the match's **Economy** tab — an identity
metric's card leaves the match overview while toggled; off, it returns. The toggle moves placement
only — the metric stays pinned
and its row stays in this list — and **Reset order** restores the shipped Economy set. The
**Match overview** list picks the cards on
top of a match: its pin adds or removes a card (only metrics that name a leading player are
offered, and never one toggled to the Economy tab — a card always shows the leader beside that
player's stored value) and the arrows set
the cards' order. Each row's buttons sit together at the row's
right edge, and
**Reset order** restores every default, hidden ones included. Under the scoreboard list, the
**Scoreboard starts transposed** checkbox sets the shape a match opens in; a match you flip during
this session keeps the shape you left it in until you restart Spectra.

For the formula language itself — sources, operators, scopes, references, worked examples and
every error message — see the next section.`,
  },
  {
    id: 'metric-cancel',
    title: 'Cancelling a running metric',
    blocks: `A metric is **running** while Spectra computes it: when you save a metric, and when a sweep
recomputes metrics after an import or a save. The Builder's **Running metrics** button opens the list of
metrics running right now, each with its own **Cancel**. The list refreshes while it is open; a metric
that finishes drops off it.

Cancelling stops that metric at once and keeps **no values** for it. Its old values are removed with the
run, so it reads as *failed* with the reason *cancelled* — in the list row and in the editor's state chip
— and nothing stale is shown in its place. The metrics that build on it are left behind (they read as
*behind* until they are computed again). Other metrics keep running.

A cancelled metric does **not** run again on its own — not after an import, and not when a metric it
depends on changes. It runs again only when you **save** it. That save clears the cancel, and the next
sweep computes it and the metrics that depend on it. Until then, its values stay absent: the cells that
would show it read as failed, never as an old number.
`,
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
and press **Save report** — beside the stats field further down this panel — to write the
document to disk.

**Stats appendix** — type into the stats field to search and pick what goes under the report: it
lands as a highlighted chip in the field, and each picked stat earns a line under the field
carrying its expression and its row count — while it has no computed number for this match, that
line shows its state chip instead. The field also offers the match's **recorded values** — the
scoreboard's stored numbers with no formula behind them (today that is the match's **Score**),
offered as recorded rather than computed: a recorded pick carries a *Recorded value* chip instead
of an expression or a state, and its exported section says so plainly, with each player's stored
round count beside the value. Every other scoreboard number offers through the metric list —
one entity per stat, never a recorded twin beside it. Remove a chip with its ✕, or with Backspace
while the field is
empty; with no chips the saved document carries no appendix. Picked stats and their sections
follow the same order as everywhere else.

**Save report** renders the template's body, composes every picked stat's table onto it and
hands the whole document to the save dialog; the filename ends in .md or .html to match the
template's format.`,
  },
  {
    id: 'reports-builder',
    title: 'The Reports builder',
    blocks: `**Reports builder** (sidebar) is where report templates are written. The templates a report
is built from — the match, player and round documents, plus any a plugin contributes — are picked
in **Reports**; this view authors them.

The **left panel** lists every template: its title, then a **scope** chip (match, player or round),
a **format** chip (md or html) and an **origin** chip naming where it came from — a built-in, one of
yours, or a plugin. **New** starts a fresh template, the search box narrows the list by title, and
the **Origin** checkboxes show or hide each group. Click a row to load it into the editor; for a
template you created, the row carries a trash button that deletes it.

The **editor** has **Title**, **Scope**, **Format** and the **Template body** — the document
itself, written with \`{{ … }}\` placeholders that fill in from the match, player or round the
report points at, so a body can be read off a built-in and edited into your own. **Save** stores it
as yours. **Preview target** chooses what the draft renders against — a match for every scope, plus
a player or a round where the scope needs one — and **Preview** renders the body you are editing,
unsaved, showing the document exactly as it would be written out. Nothing is chosen for you: the
preview stays off until you pick a target.

**Inside the braces** — every \`{{ … }}\` names one value by its path from the top of the data:
\`{{.Match.Map}}\` is the match's map, \`{{.Detail.Round.Number}}\` a round's number. What sits at
the top follows the template's **Scope**:

- **match** — \`{{.Match}}\` (the match itself: map, file, score, round count, duration, tick rate,
  import details), \`{{.CTName}}\` / \`{{.TName}}\` (the teams' display names), \`{{.Scoreboard}}\`
  (a row per player), \`{{.Rounds}}\` (a row per round), \`{{.Economy}}\` (each round's buys:
  equipment, money and loss bonus per side, buy class), \`{{.Clutches}}\` (round, player, size,
  outcome, HP left), \`{{.Utility}}\` (each throw: tick, thrower, kind, damage, flash, site),
  \`{{.Metrics}}\`, \`{{.GeneratedAt}}\` (when it rendered).
- **player** — \`{{.Match}}\`, \`{{.SteamID}}\`, \`{{.Player}}\` (that player's own scoreboard row),
  \`{{.Rounds}}\` (their per-round rows), \`{{.Metrics}}\`, \`{{.GeneratedAt}}\`.
- **round** — \`{{.Match}}\`, \`{{.GeneratedAt}}\` and \`{{.Detail}}\`: \`{{.Detail.Round}}\` (winner,
  reason, duration, site, MVP, first kill, equipment, ticks), \`{{.Detail.Economy}}\` (a row per
  side), \`{{.Detail.Events}}\` (tick, kind, attacker, victim, weapon, damage) and
  \`{{.Detail.Chat}}\` (tick, name, channel, text).

To walk a list, \`{{range .Scoreboard}} … {{end}}\` loops it and \`.\` becomes the row being
printed (\`{{.Name}}\`, \`{{.Kills}}\`), with \`$\` still meaning the top of the data.
\`{{.Metrics}}\` (match and player scopes) is looked up instead of looped: it carries the stat
values the built-ins print — ADR, HS%, KD, KDA, assists, openings, trades, best streak, enemies
flashed — under each player's \`SteamID\`, a dash where a value isn't current, fetched as
\`{{index $.Metrics .SteamID}}\`. Number formatting (\`{{printf "%.1f" .DurationS}}\`) and value
tests (\`{{if eq .Channel "all"}}\`) appear in the built-ins as well — and each built-in's body
loads read-only in the editor, so the templates are worked examples to copy from.

**Built-ins are read-only** — they load with a \`built-in\` chip and a disabled Save (*Built-in
templates can't be edited*), but you can still read and preview them. Plugin templates carry a
*read-only source* chip; saving one stores a copy as your own. Only your own templates can be
deleted.`,
  },
  {
    id: 'component-builder',
    title: 'The Component builder',
    blocks: `**Component builder** (sidebar) is where components are written. A component is a small piece
of a view that shows figures from your matches: it reads the stored stats it asks for and shows them
the way it is written. This view writes and checks them; **Preview** shows one running as it would
on a match or a player you choose.

The **left panel** lists the components. **Built-in** comes first: the shipped example, which
loads read-only. Below it, **Yours** lists the components you saved. Click a row to open it in the
editor, and **New** starts an empty one.

**Built-in components can't be changed.** Open one and **Duplicate** saves a copy as yours and opens
the copy, which you can then edit. A copy is yours alone: it does not follow later changes to the
built-in it came from.

The **editor** has the **Name** and the **Source** of the component. The source is the component's
text: what it shows and how it responds. Under the source, the check reads **Ready to save.** when the
source is sound, or names the line that needs fixing. **Save** stays off until the check passes, and
then it stores the component under its name. A name must be unique among yours, at most 60
characters, and can't begin with *built-in*.

**Preview** shows the component as written. **Preview with** chooses what it runs against: **A match**
or **A player**, picked from the lists beside it. Nothing is chosen for you, so a component that reads
a match shows its prompt until you pick one. The preview appears once the source checks out, and it
keeps the last version that checked out while you type, so a half-finished edit never blanks it.

When a component fails while it runs, its own box shows the error and the rest of the screen keeps
working. **Try again** redraws a component whose display failed, and the box's ✕ dismisses the error.

**Delete** removes one of yours. It is the red button in the editor, or the trash button on the row.
Built-in components can't be deleted.`,
  },
  {
    id: 'sql-console',
    title: 'SQL console',
    blocks: `**SQL console** (sidebar) is a read-only query window over your whole library — for when you want
the data on your own terms. It is read-only by construction: the statement runs on a separate
read-only connection, one statement at a time, and writes and multi-statement scripts are
rejected before they run.

- **Schema** (left) — every table with its note; expand one to see its columns and types, and click a column name to insert it into your statement.
- **Statement** — the editor; **Run** or **Ctrl/Cmd+Enter**. The stated limits are *rows cap 5,000 · timeout 5 s*. A statement carrying parameters (\`?\`, \`:name\`) is refused with *this statement has parameters — replace them with values* — the console is never given values, so put them in yourself; a metric's **compiled SQL** already has its values written in (see *The metric Builder*), so a single statement of it runs as pasted.
- **Results** — the row grid with the query time, the row count, and a *truncated* chip when the cap was hit. The grid pages through every returned row: a footer names the rows on screen, with **Prev** / **Next** to step through them (each dimmed at its own end). Exports always carry every returned row.
- **Export** — saves the result of the last run as **JSON** or **CSV**; the control sits in the **Statement** card, beside **Run**.
- **Saved queries** — the queries you have saved: click one to load it, with its name and description, back into the statement, or delete one you no longer need. Its **name**, **description** and **Save** fields live in the **Statement** card — that is where the current statement gets named and saved.
- **History (last 50)** — the statements you have run, newest first. Click a line to load it into the statement with the name and description cleared, so you can name it afresh; **Remove** drops that one line — **Clear** still drops them all.`,
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
- **Plugins** — **Build plugin…** opens a dialog where you name the plugin (its id derives from the name), pick your own metrics and report templates into it (type to search, click to add a chip — built-ins and installed plugin content stay with their source) and **Save plugin** writes the file — \`spectra-plugin.json\` by default — that you can hand to someone else. **Browse…** picks the plugin's \`spectra-plugin.json\` file (install takes that file — never a folder), and **Install from path** installs the file showing; enable, disable and remove them. They contribute metrics and report templates on the next list — no restart, and a plugin change recomputes the metric values it affects in the background right away: a re-enabled plugin's numbers refresh on their own, and a metric of yours that referenced one you removed reports the missing reference instead of keeping its old numbers. The panel's own warning stands: install only bundles you built or got from someone you trust; there is no auto-update.
- **Audio & voice** — a **Run audio self-test** that checks Spectra can open your audio device, and the same six volume faders the replay uses (they stay in sync). Sound effects are extracted from your local CS2 install; voice is decoded as the replay plays.
- **Replay** — **Loop length (seconds)**: how long a loop spans around the playhead or an event (1–60, default 5). The transport's loop popover quick-range button and every event ▶ link — in the analysis views and in the replay's own event feed — arm exactly this width.
- **Analysis rules** — the thresholds that decide Spectra's analysis: **Trade window (seconds)**, **Full-buy threshold (equip $)**, **Trade-opportunity distance (units)** and **Force threshold (equip $)**. **Save rules** stores them and, when a rule actually changed, recomputes the matches behind the new rules in the background — their numbers refresh as each match finishes, so there is no manual re-run step.`,
  },
];
