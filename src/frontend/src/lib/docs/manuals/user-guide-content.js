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

- **Library**: your imported matches. Every match detail view starts here.
- **Match**: the match itself, reached from any Library row. This tab is greyed out until you open one, and then goes back to the last match you had open.
- **Profiles**: every player in your library, and each player's career page. Clicking it again returns to the player you had open.
- **Metric builder**: where numbers are defined and previewed.
- **Reports builder**: where report templates are written.
- **Component builder**: where the pieces of a view are written.
- **SQL console**: read-only queries over your whole library.
- **Settings**: at the bottom of the bar.

Two more things are worth knowing on day one:

- **Ctrl+K opens the command palette.** Jump to any of those views, or search matches, players, saved filters, metrics and saved queries in one box.
- **This guide** opens from the Help button on the sidebar (directly above Settings) and floats over whatever you were doing — your work stays exactly where it was behind it. The \`?\` in the Metric builder's header opens the same guide straight at the **Metric language** reference. The view headers carry their own \`?\` too — **Replay**, **Match**, **Library**, **Reports**, **Settings** and the **SQL console** open the guide at the section that covers what you are looking at, and Match's follows the tab you are on. The contents list on the left shows every section in document order, and the section you last went to is highlighted. The header search marks the matching text in the section headings and the body, and never filters the list: press \`Enter\` for the next match, \`Shift+Enter\` for the previous one, or use the two arrow buttons beside the search box.

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
kinds of asset out of *your* Counter-Strike 2 installation: the official radar images (map
backgrounds) with the map geometry that goes with them, the equipment icons, and the replay's
sound effects. The prompt says so plainly —
*Nothing from Counter-Strike ships with the app, and nothing is uploaded — your game files are read locally
and the extracted packs are stored in Spectra's data folder on this machine.* You get three choices:

- **Extract all CS2 assets** — the prompt closes right away and the extraction carries on in the background: its honest progress shows in the floating work indicator at the bottom right of every view, and that indicator's ✕ hides it without stopping anything.
- **Choose folder…** — point Spectra at your CS2 install yourself, if it wasn't found.
- **Not now** — dismiss for this launch. The prompt returns on the next launch as long as any of the three families is still missing; extracting them is what ends the loop for good.

Without radar images, maps render as a plain grid — everything else still works. Without the map
geometry, a demo still imports completely: its stats, rounds, economy and replay are all there. What
is missing is the **encounter windows**, the sight-line analysis of who could see whom. Those are
skipped, and the match's warnings say so; extract the map geometry and re-import the match to get them. You can re-run
extraction any time from **Settings → CS2 assets** (it is safe to run again, and worth re-running
after a CS2 update).

**3. Import a demo** — see **Importing demos** below.

**4. Open a match and press Watch replay** — see **Understanding a match** and **The replay**.

**5. Learn the command palette (Ctrl+K).** One box for: the nav actions (plus *Toggle theme*),
matches (\`de_mirage · 13–9\`), players (with match counts), saved filters (applies the filter in
the event browser), metrics (jumps to the Metric builder) and saved queries (jumps to the SQL console).

**6. Updates.** When Spectra launches it checks GitHub Releases for a newer version, silently, and offers to install one when it exists. **Settings → About → Check for Updates…** checks on demand, and tells you when you are already up to date. Development builds skip the check on launch; the Settings button still works.`,
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

Importing never moves, modifies or deletes your original files: importing only reads them. The one way a demo file leaves disk through Spectra is an explicit action: each file in the **Demos from your import dirs** panel offers **Delete from disk**, which asks first and removes that file.

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
Spectra read the file), **Status**, and the row's actions. Map, W Score, L Score, Rounds, Duration, Size, Imported and
Status sort by clicking their header; Matchup and the actions do not.

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

**Overview** — the headline cards (**Top fragger**, **Best ADR**, **Most util**, **Entry
opens** and **Most MVPs**; each card names that stat's leading player beside that player's
stored value, and a card with no one to name shows no player) and both rosters with K/D/A and
ADR: the Counter-Terrorist roster, then the Terrorist roster, then any player with no side on
record. Clicking a card or a roster row opens the replay with the camera on that player;
clicking a player's name opens their profile.

**Scoreboard** — one row per human player (bots never appear here). The columns are name, team
and score, then kills, deaths, damage, utility damage, MVPs, assists, ADR, KAST%, HS%, K/D, KDA,
the multi-kill counts (2K to 5K), opening kills and opening deaths, trade kills and best streak.
It opens sorted by kills, highest first. Click a header to sort on it. A newly clicked column becomes the
main sort, and the columns you sorted on before break its ties; clicking the main column again reverses it. The
list starts sorted by kills, highest first. A dash is a stat with no value for that player. A word such as
*Calculating* or *Out of date* stands in for a value that is being worked out or is stale.
A row click opens the replay following that player, and the name cell opens their profile.
The scoreboard always opens in this one-row-per-player layout. To get a different layout,
open the scoreboard in the Component builder and edit it. **Restore to default** there brings the shipped layout back.

**Rounds** — one row per round: a ▶ that watches the round in the replay, the number, winner, win reason, duration, bomb site, MVP, the first blood, and the kill count. The ▶
opens the replay at that round's own start with the round's span looped and a return to this tab;
clicking the row (or pressing Enter on it) expands it in place to the round's details:
the kill feed, the bomb timeline, the economy by side (per-side buy class, equipment and money) and
the round's chat, with the scoreline and the MVP's reason in its header. The kill feed and the bomb
timeline each start with a ▶ that watches that event. A dash is a round fact the demo does not
record, such as a round with no bomb site. The rounds table is a component like the scoreboard:
to change its columns or its layout, open it in the Component builder and edit it.

**Details** — *Key facts* (server, tickrate, frame count, file size, import date, voice presence,
warning count, the source file and whether a managed copy exists)
followed by the demo's import diagnostics: import details (parse time, notes) and advanced
diagnostics. The stored facts (server, tickrate, frame count, file size, import date, parser,
warning count and source file) are a component, so you can edit them in the Component
builder. Voice presence and the managed-copy line stay as they are.`,
  },
  {
    id: 'match-analysis',
    title: 'Match analysis',
    blocks: `The analysis tabs of a match do the heavy work. Calculated figures in them carry their formula or
their rule on hover, and Spectra marks what it *reads* from the demo apart from what it *works
out* — a dotted header or an **inferred** badge means calculated, with the rule on hover.

# Economy

- **The curve** — *Equip value per round* or *Team net worth per round*, one line per team, with a legend and a round strip under it. Hover for values; click a column to open that round.
- **Summary cards** — one card per stat the tab shows. The shipped set covers *Pistol → next round* (pistol wins held the next round), force rounds won and force rounds played per team, *Winner equipment value advantage* (average winner−loser equipment at freeze time end), and *Lost equipment* with its per-team split (marked **inferred**). The card set is the shipped one and does not change; each card's tooltip states the exact formula, and a card whose stat names a round watches that round in the replay.
- **Rounds** — one row per round: a ▶ that watches the round in the replay, both sides' buy-class chips (click a chip for the reason it was classified that way), each side's deaths in that round under **CT Deaths** / **T Deaths** (a dash where the round's deaths are not stored), and each side's round loss bonus drawn as a stack of five pips filled up to that side's step (hover a cell for the exact amount). The loss-bonus ladder runs $1400 → $3400 in $500 steps: a loss steps it up, a win steps it down (never a full reset), and every half starts one level up, so a pistol loss pays $1900.

# Utility

- **The throw log** — the first card, holding the **Kind**, **Thrower** and **Round** filters with a live *n of m grenades* count. The Round filter shows one round at a time — the first round with throws is selected to keep the log compact — and **All rounds** shows every throw in the filter: kind, thrower, time into the round, damage, total blind time, affected players and the throw coordinates, each with a ▶ that seeks to the throw, loops around it for your loop length, and follows the thrower.
- **Utility damage per round** — a bar per round, split by thrower team; while the current filter leaves nothing to plot, the card hides itself instead.
- **Blind time per round** — the same bars for the total blind time each team's flashes applied (marked **inferred**: calculated from the demo's blind events); it hides itself too while the filter carries no blind time, and both cards return as soon as there is something to draw.

# Combat

- **Kill tags** — every detected kill, one row per kill, filtered through a **Kind** dropdown of checkboxes — **opening** / **trade** / **traded** / **untraded** (one kill can carry several; checked kinds combine as OR, so a kill matching any of them shows, and the closed dropdown states the current selection, reading **All kinds** whenever nothing narrows the list) and by a **Round** dropdown beside it — round 1 is selected by default, **All rounds** shows every kill, and each round option is labelled by its scoreline (**RD7 | 4-3**), with the killer and victim, distance, and a ▶ that follows the *killer*. With no kind checked — the default — no kind filter applies, so every kill of the selected round shows.
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
- Any ▶ or watch button in the analysis views, round details — an event-level drill loops around that event for the length set in **Settings → Replay** and often starts the camera following a specific player; a round-level one plays the round from its start. The replay's own event feed does the same in place, without leaving the replay.
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

- **Headline and career cards** — one block of square name/value cards, the same set in the
  same order for every player: Matches played (with its wins sub-line), Win %, ADR, ADR σ, K/D, HS %,
  KAST %, opening kill tags, trade rate, clutches, clutch win %, average enemies flashed and average
  utility damage. Each card shows a number, a dash when there is no data for this player, or a
  state chip while a value is recomputing. The cards wrap outward from the center.
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
    blocks: `**Metric builder** (sidebar) is where numbers are defined. A **metric** is one number for one subject: a
player ("this player's trade rate"), a match or a team. Every metric carries its own written formula, and a
value is never invented: missing data shows as a dash, never as a zero.

The **left column** lists every metric, grouped **Builtins / Custom / Plugins**. Above the list, the search box
and the **Filters** dropdown sit on one row; the dropdown groups **Origin** and **Type** (the metric's format).
Each row has an on/off switch and, for metrics you created, a trash button. Preview a metric from its editor. Each row
shows its format, its state, and a marker for built-in or plugin metrics. A switched-off metric is kept, with its
values, but is never computed; it shows the **disabled** state. You can switch a metric off only when no enabled
metric reads it and no component uses it, and you can switch one on only when every metric it reads is on. The switches are locked while a sweep is computing metrics. **New** starts a fresh metric, and **Running metrics** lists
the metrics being computed right now, each with its own **Cancel** (see *Cancelling a running metric*). Metrics
appear in their default order: there is no ordering dialog, pinning or hiding.

The **editor** on the right has:

- **Name** (the identifier other formulas reference), **Title** (the display label) and an optional **Short name**, six characters at most, for narrow columns.
- **Scope** is not a field you set. The binds in the statement decide it: a statement that reads \`:steam_id\` is a career (profile) metric, one value per player across their matches. Any other metric is a match metric. The editor shows the result.
- **Format**: auto, integer, one or two decimals, percent, currency or identity.
- **Doc**: the plain-language formula shown in the ⓘ next to the number. It is required; saving without it is refused.
- **Expression**: the statement itself. The live check reads *checking…*, then *Valid*, or the error and where it is in your text.

The actions line at the bottom of the editor holds the validity indicator on the left, then **Preview**, then
**Save metric**. For a metric you created, a trash button deletes it. For a built-in you have edited, **Restore to
default** sits there too.

The editor heading carries the metric's state chip (*fresh*, *behind*, *processing*, *failed* or *no-data*) and a chip
that says whether it is built-in or a read-only plugin source.

**Raw SQL.** Every expression is one read-only SQL statement, and the save gate checks it. A write, a second statement,
a table a metric may not read, or a \`metric()\` reference to a metric that does not exist is refused, with the reason,
and nothing is saved. A \`metric()\` reference to a saved metric is allowed: it makes that metric a dependency, so a
change to it marks this one behind. The statement must return the columns \`subject_key\`, \`dim\` and \`value\`; any other
column is kept as extra detail. A NULL \`value\` shows as a dash, never as zero. The binds decide the scope: \`:match_id\`
runs once per ready match, \`:steam_id\` once per player, and \`:match_id\` with \`:round\` once per round. A statement can
also use **macros**, short names for larger pieces of SQL, which are expanded when the statement is checked. The
metric language chapter lists the tables, the checks and the macros.

**Preview** shows the stored values of a metric you have saved and not changed since: the rows the screens read,
highest value first, in a full-screen view that the X or Escape closes. Nothing is calculated for the preview. A
statement you have not saved, or have changed since saving, is refused by Preview, and the live check is what you have
until you save it. Saving a metric starts the sweep that computes its values.

**Save metric** stores it; the button reads *Saved* while nothing has changed.

When you open a metric, or save it, the expression is brought into the canonical layout: keywords in capitals and one
clause per line. Macros are left exactly as you wrote them.

**Built-in metrics are edited in place.** A built-in loads with a \`built-in\` chip. Change its **Expression** and **Save**
keeps the edit: the metric's numbers recompute with it. Its name, title and format stay as shipped, and an edited
built-in shows an *edited* chip. **Restore to default** discards the edit, brings the shipped expression back and
recomputes the numbers with it. You can still preview and reference built-ins. Plugin metrics carry a *read-only
source* chip; saving one stores a copy as your own metric.

A view shows what its component shows. The Match view's scoreboard, the profile cards and the Reports list each show
their default columns and cards in their default order. Nothing in the app pins, reorders or hides them: to change a
view, edit its component in the Component builder, or use one of your components as the view (see *The Component
builder*).

For the formula language itself (sources, scopes, references, macros, worked examples and every error message), see
the next section.`,
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
**Player report**, **Round report**, **Career report** (plus any a plugin contributes); each card shows its scope
and format. Then pick the target the template needs — a player, or a round number —
and press **Save report** — beside the stats field further down this panel — to write the
document to disk. The match is the one the tab belongs to, or the one the match picker above
the page holds.

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
follow the default order of the stats, so the same picks always give the same sections.

**Save report** renders the template's body, composes every picked stat's table onto it and
hands the whole document to the save dialog; the filename ends in .md or .html to match the
template's format.`,
  },
  {
    id: 'reports-builder',
    title: 'The Reports builder',
    blocks: `**Reports builder** (sidebar) is where report templates are written. The templates a report is built from (the match,
player and round documents, plus any a plugin contributes) are picked in **Reports**; this view writes them.

The **left panel** lists every template: its title, then a **scope** chip (match, player or round) and a **format** chip
(md or html). A template that is built-in or from a plugin also shows a marker naming that; one of yours shows none.
**New** starts a fresh template. The search box matches titles, and the **Filters** dropdown, beside it, groups
**Origin**, **Format** and **Scope**: uncheck a box to hide that kind of template. Click a row to load it into the editor;
for a template you created, the row carries a trash button that deletes it.

The **editor** has **Title**, **Scope**, **Format** and the **Template body**: the document itself, written with
\`{{ … }}\` placeholders that fill in from the match, player or round the report points at. A body can be read off a
built-in and edited into your own. **Save** stores it as yours.

The bottom-right corner of the editor holds the preview controls, in order: **Preview target**, **Preview**, **Save**.
The target is a match for every scope, plus a player or a round where the scope needs one. **Preview** renders the body
you are editing, unsaved, in a full-screen view that shows the document exactly as it would be written out, and the X or
Escape closes it. Nothing is chosen for you: Preview stays off until you pick a target.

**Inside the braces.** Every \`{{ … }}\` names one value by its path from the top of the data: \`{{.Match.Map}}\` is the
match's map, \`{{.Detail.Round.Number}}\` a round's number. What sits at the top follows the template's **Scope**:

- **match**: \`{{.Match}}\` (the match itself: map, file, score, round count, duration, tick rate, import details), \`{{.CTName}}\` and \`{{.TName}}\` (the teams' display names), \`{{.Scoreboard}}\` (a row per player), \`{{.Rounds}}\` (a row per round), \`{{.Economy}}\` (each round's buys: equipment, money and loss bonus per side, buy class), \`{{.Clutches}}\` (round, player, size, outcome, HP left), \`{{.Utility}}\` (each throw: tick, thrower, kind, damage, flash, site), \`{{.Metrics}}\`, \`{{.GeneratedAt}}\` (when it rendered).
- **player**: \`{{.Match}}\`, \`{{.SteamID}}\`, \`{{.Player}}\` (that player's own scoreboard row), \`{{.Rounds}}\` (their per-round rows), \`{{.Metrics}}\`, \`{{.GeneratedAt}}\`.
- **profile**: \`{{.Name}}\`, \`{{.SteamID}}\`, \`{{.Matches}}\` (the player's match history: imported time, map, win, score, start side, kills, deaths, ADR, KAST), \`{{.Metrics}}\` (the career values, by name: \`{{index .Metrics "career_adr"}}\`, a dash where a value is not current) and \`{{.GeneratedAt}}\`. A profile report covers one player across every match they played, so it needs no match.
- **round**: \`{{.Match}}\`, \`{{.GeneratedAt}}\` and \`{{.Detail}}\`: \`{{.Detail.Round}}\` (winner, reason, duration, site, MVP, first kill, equipment, ticks), \`{{.Detail.Economy}}\` (a row per side), \`{{.Detail.Events}}\` (tick, kind, attacker, victim, weapon, damage) and \`{{.Detail.Chat}}\` (tick, name, channel, text).

To walk a list, \`{{range .Scoreboard}} … {{end}}\` loops it, and \`.\` becomes the row being printed (\`{{.Name}}\`, \`{{.Kills}}\`), with \`$\` still meaning the top of the data. \`{{.Metrics}}\` (match and player scopes) is looked up rather than looped: it carries the stat values the built-ins print (ADR, HS%, KD, KDA, assists, openings, trades, best streak, enemies flashed) under each player's \`SteamID\`, a dash where a value is not current, fetched as \`{{index $.Metrics .SteamID}}\`. Number formatting (\`{{printf "%.1f" .DurationS}}\`) and value tests (\`{{if eq .Channel "all"}}\`) appear in the built-ins as well, and each built-in's body loads in the editor, so the templates are worked examples to copy from.

**Built-in templates are edited in place.** A built-in loads with a \`built-in\` chip. Change its **Template body** and **Save** keeps the edit: every report that uses the template shows it. Its title, scope and format stay as shipped. An edited built-in shows an *edited* chip, and **Restore to default** beside Save discards the edit and brings the shipped text back. You can still read and preview built-ins. Plugin templates carry a *read-only source* chip; saving one stores a copy as your own. Only your own templates can be deleted.`,
  },
  {
    id: 'component-builder',
    title: 'The Component builder',
    blocks: `**Component builder** (sidebar) is where components are written. A component is a small piece of a view that shows
figures from your matches: it reads the stored stats it asks for and shows them the way it is written. This view writes
and checks them; **Preview** shows one running as it would on a match or a player you choose.

The **left panel** lists the components. **Built-in** comes first: the components the app's views are made of, and the
example to copy from. Below it, **Yours** lists the components you saved, and **Plugins** lists the components that installed plugins supply. A plugin's component is read-only: change its name and save to keep your own copy. **New** starts an empty one, and the search
box filters by name. The **Filters** dropdown has two groups: **Origin** (built-in, custom, and one box for each installed plugin, which hides that plugin's components) and **View** (match view,
profile view and no view). Uncheck **no view** to hide the components that no view uses, or uncheck a view to hide the
components placed on it.

A component that a view uses wears a **match view** or **profile view** chip, in the list and in the editor's header.
The built-in components the app's views use by default wear theirs too, so a view that has not been changed shows its
chip from the start. A built-in wears a **built-in** chip, and an edited built-in wears an **edited** chip.

**Built-in components are edited in place.** Open one, change its source, and **Save** keeps the edit: it replaces the
shipped version wherever that component appears. **Restore to default** discards the edit and brings the shipped version
back. It sits beside **Use as my…**. A built-in's name stays as it is, and it can't be deleted.

The **editor** has the **Name** and the **Source** of the component. Under the source, the check reads **Valid** when the
source is sound, or names the line that needs fixing. **Save** stays off until the check passes. A name is at most 60
characters, must not be empty, and can't be the name of a built-in component.

**Preview** sits in the bottom-right corner of the editor, and opens the component as it would run, full screen. The X or
Escape closes it. It is available once the source checks out, and it keeps the last version that checked out while you
type, so a half-finished edit never blanks it. **Preview with** (**Match** or **Player**) sits beside it and chooses what
the component runs against. Nothing is chosen for you, so a component that reads a match shows its prompt until you pick
one.

Checking runs quietly as you type. Saving and loading the preview show their progress in the background-work indicator at
the bottom right, and **Cancel** appears beside **Save** while a save runs. **Cancel** stops it: nothing is saved, and the
editor says it was cancelled. There is no time limit, and the rest of the screen keeps working while it runs.

When a component fails while it runs, its own box shows the error and the rest of the screen keeps working. **Try again**
redraws a component whose display failed, and the box's ✕ dismisses the error.

**Delete** removes one of yours: the red button in the editor, or the trash button on the row. A component that a view
uses can't be deleted until that view stops using it; the message names the view.

**Use as my…** sets a view to one component. The menu lists **Match View** and **Profile View**, and marks the view the
open component already shows. Choosing a view writes it. Choosing the view the component already shows removes it, and the
view goes back to its default. **Match View** replaces the tabs below the match header, and **Profile View** replaces the
profile's panels. The header, the warnings and the round strip stay where they are. A component you have not saved yet
can't be used as a view; a built-in can.

What a component can use, its \`spectra\` helpers and display pieces, is listed in [Component helpers](#component-helpers).`,
  },
  {
    id: 'component-helpers',
    title: 'Component helpers',
    blocks: `**Component helpers** are what a component can use. A component you write in the Component builder may import nothing. Everything it needs arrives on the **\`spectra\`** prop, which every component receives, and on its **\`context\`** prop: the match, player and round it is mounted on, frozen, so read it but do not change it. Built-in components use these same helpers, so their source is a worked example.

**Reading stored values and the library**

| Helper | What it does |
|---|---|
| \`spectra.metric(name, binds?)\` | The stored value of one saved metric. Resolves to \`{ name, doc, state, value, valueKey, error, rows }\`. \`state\` is \`fresh\` (stored and current), \`no-data\`, \`processing\`, \`failed\` or \`behind\`. \`value\` is the number for the subject, and is \`null\` unless the state is \`fresh\`. When it is fresh, \`rows\` lists each subject as \`{ subject, dim, value, valueKey }\`. A failed read also rejects, and its error shows in the component's box. |
| \`spectra.readMetrics(names)\` | \`spectra.metric\` for each name at once. Resolves to a Map from name to read, in the order given. A failed read is its own \`failed\` state, and the others still arrive. |
| \`spectra.metricsByMatch(steamId, names, matchIds)\` | One player's values for several metrics across many matches, in one read. Resolves to a Map from each match id to a Map from metric name to that metric's read, the same shape as \`spectra.metric\`. |
| \`spectra.query(sql, binds?)\` | A live, read-only statement over the library, with no freshness: it reads now. Resolves to \`{ columns, rows }\`. A failed read rejects, and its error shows in the component's box. |

**Binds.** The \`binds\` argument is an object with \`match_id\`, \`steam_id\` and \`round\`, or with \`matchId\`, \`steamId\` and \`round\`. Left out, it takes the context's set. Given, it replaces that set as a whole, so a read given a steam id does not also take the context's match. Giving one bind twice, as \`matchId\` and \`match_id\`, is refused.

**Players**

- **\`spectra.isHuman(row)\`**: true unless the roster row is a bot. The row carries \`steamId\` or \`steam_id\`.
- **\`spectra.listedPlayers(rows)\`**: the list with the bots taken out, in order. Use it for any list of players.

**Loading and progress**

- **\`spectra.track(promise)\`**: counts a load the component runs on its own as a read in flight. **\`spectra.busy\`** is true while any read or tracked load is in flight.
- **\`spectra.whileCurrent(run)\`**: for a load started in an effect. \`run\` receives \`isCurrent()\`, and a late result is dropped once the inputs change or the component unmounts.
- **\`spectra.liveMetrics({ onDone })\`**: a panel's metric progress and reload wiring. \`progress\`, \`frac(id)\`, \`stage(id)\` and \`chip(def)\` show the sweep. \`reload\` goes up each time a metric finishes, so an effect or a derived value that reads it fetches again. \`onDone\` runs on each finish.

**Interaction**

- **\`spectra.navigate(route)\`**: opens a view. The route is a hash such as \`#/match/…\`, or \`{ path, query }\`.
- **\`spectra.guard(fn)\`**: wraps an event or async handler, so its error goes to the component's box instead of being lost.
- **\`spectra.report(error)\`**: shows a failed load in the component's box, which the reader can dismiss. Use it for a failed read the component has no retry for.
- **\`spectra.loadForMatch(getMatchId, load, apply)\`**: the effect body of a load for the component's match: \`$effect(spectra.loadForMatch(() => context.matchId, load, apply))\`. \`apply\` takes the value while the load is still current, and a failure goes to the component's box.
- **\`spectra.activateOnKey(fn, { enterOnly })\`**: makes a clickable row work from the keyboard. \`onkeydown={spectra.activateOnKey(open)}\` runs \`open\` on Enter, and on Space unless \`enterOnly\` is set.
- **\`spectra.Child\`**: mounts another named component inside this one: \`<spectra.Child name="…" props={…} />\`. The child receives this component's context and has its own error box. Nesting has a fixed depth limit.

**Display**

- **\`spectra.fmtMetric(value, format)\`**: the text of a stored value, in the metric's format.
- **\`spectra.metricPresentation(state, row, unitHasRows)\`**: maps a read onto what a cell shows, as a value, a no-data dash or a status chip. \`ui.MetricCell\` takes its result.
- **\`spectra.dash\`**: the one dash a missing value shows.
- **\`spectra.ui\`**: the shared display pieces, used as \`<spectra.ui.StatCard …>\`.

| Piece | What it shows | Props |
|---|---|---|
| \`ui.ErrorBanner\` | An error line, with an optional Retry and an optional dismiss | \`onretry\`, \`retryLabel\`, \`ondismiss\`, \`dismissLabel\`, children |
| \`ui.EmptyNote\` | A muted note for an empty state | children |
| \`ui.EmptyTableRow\` | The one row a table shows when it has nothing to list | \`colspan\`, \`empty\`, \`text\`, \`chip\` |
| \`ui.LoadBox\` | The loading shell: holds its height while a load runs, and shows a spinner over the content | \`busy\`, \`name\`, \`key\`, \`tag\`, children |
| \`ui.MetricCell\` | A metric's cell | \`pres\`, \`format\`, \`chip\`, \`words\` |
| \`ui.RetryButton\` | The button beside a failed read, to load it again | \`onretry\`, \`label\` |
| \`ui.WinnerCell\` | A side's name, as a chip | \`name\`, \`winner\`, \`title\` |
| \`ui.StatCard\` | A labelled figure, with an optional sub-line | \`label\`, \`value\`, \`sub\`, \`title\`, and the \`subSlot\` and \`valueSlot\` slots |
| \`ui.StatusChip\` | A status chip, with optional progress | \`status\`, \`progress\`, \`stage\`, \`block\`, \`detail\`, \`title\` |

Other helpers: \`spectra.openMatch(matchId)\` and \`spectra.openPlayer(steamId)\` open a match or a player's profile; \`spectra.fmtDate(d)\` and \`spectra.fmtDuration(seconds)\` format a timestamp and a span.

A component can import the public Svelte runtime modules (\`svelte\`, \`svelte/store\`, \`svelte/motion\`, and the rest of the public list), and nothing else: the save gate refuses any other import. Everything in this list is the whole surface. The source editor completes these names as you type: type \`spectra.\` for the helpers, \`spectra.ui.\` for the pieces, and \`context.\` for its fields.`,
  },
  {
    id: 'sql-console',
    title: 'SQL console',
    blocks: `**SQL console** (sidebar) is a read-only query window over your whole library, for when you want the data on your own
terms. It is read-only by construction: the statement runs on a separate read-only connection, one statement at a time,
and writes and multi-statement scripts are rejected before they run.

- **Schema** (left): every table with its note. Expand one to see its columns and types, and click a column name to insert it into your statement.
- **Statement**: the editor, with the name, description and **Save** fields for keeping the statement, and **Run** (or **Ctrl/Cmd+Enter**). The stated limits are *rows cap 5,000 · timeout 5 s*. A statement with parameters (\`?\` or \`:name\`) is refused with *this statement has parameters — replace them with values*: the console is never given values, so write them into the statement yourself.
- **Results**: **Run** opens them full screen. The view shows the query time, the row count, and a *truncated* chip when the row cap was hit. The grid pages through every returned row, with a footer that names the rows on screen and **Prev** and **Next** to step through them. **Export** saves every returned row as **JSON** or **CSV**, from this view. The X or Escape closes it. A failed run shows its error in the Statement card and opens no results.
- **Saved queries**: the queries you have saved. Click one to load it, with its name and description, back into the statement, or delete one you no longer need.
- **History (last 50)**: the statements you have run, newest first. Click a line to load it into the statement with the name and description cleared, so you can name it afresh. **Remove** drops that one line, and **Clear** drops them all.`,
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
- **Plugins** — **Build plugin…** opens a dialog where you name the plugin (its id derives from the name), pick your own metrics, report templates and components into it (type to search, click to add a chip — built-ins and installed plugin content stay with their source) and **Save plugin** writes the file — \`spectra-plugin.json\` by default — that you can hand to someone else. **Browse…** picks the plugin's \`spectra-plugin.json\` file (install takes that file — never a folder), and **Install from path** installs the file showing; enable, disable and remove them. They contribute metrics, report templates and components on the next list — no restart, and a plugin change recomputes the metric values it affects in the background right away: a re-enabled plugin's numbers refresh on their own, and a metric of yours that referenced one you removed reports the missing reference instead of keeping its old numbers. The panel's own warning stands: install only bundles you built or got from someone you trust; there is no auto-update.
- **Audio & voice** — a **Run audio self-test** that checks Spectra can open your audio device, and the same six volume faders the replay uses (they stay in sync). Sound effects are extracted from your local CS2 install; voice is decoded as the replay plays.
- **Replay** — **Loop length (seconds)**: how long a loop spans around the playhead or an event (1–60, default 5). The transport's loop popover quick-range button and every event ▶ link — in the analysis views and in the replay's own event feed — arm exactly this width.
- **Analysis rules** — the thresholds that decide Spectra's analysis: **Trade window (seconds)**, **Full-buy threshold (equip $)**, **Trade-opportunity distance (units)** and **Force threshold (equip $)**. **Save rules** stores them and, when a rule actually changed, recomputes the matches behind the new rules in the background — their numbers refresh as each match finishes, so there is no manual re-run step. Saved metrics are worked out again only where they read what the changed rule decides: a metric over facts alone (a count of kills, say) keeps its value, while a metric that reads the trade window, the trade-opportunity distance or the buy thresholds is recalculated, together with the metrics built on it.`,
  },
];
