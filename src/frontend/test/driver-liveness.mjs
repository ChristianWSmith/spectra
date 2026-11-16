// The one liveness guard for the jsdom drivers (test/*.dom.mjs).
//
// Why this exists: a driver that throws at mount() before its first
// assertion can still exit 0 — the driver's own uncaughtException
// handler swallows the error (it only adds to `errors`, and the tail
// that folds `errors` into the exit code never runs), so node --test
// files it as a bare PASS with ZERO checks executed. Six drivers were
// caught dead this way at the 2026-11-12 audit (confirm-dialog,
// landmark-row, match-picker, payload-tree, round-strip, stat-card —
// all missing the svelte browser-condition resolve hook), and the same
// disease had already hidden replay.dom.mjs once. A vacuous run and a
// green run look identical in the suite output, so this meta-test
// re-runs every driver and pins how many checks each one must actually
// execute.
//
// Design notes:
// - EXPECTED is the opt-in table. A NEW test/*.dom.mjs file is not in
//   it, and the sync test below fails loudly until its real check count
//   is added — additions must opt in with their executed-check count.
//   Values are minimums: legitimately removing checks re-pins the
//   number here, deliberately, never silently.
// - "Checks" = the drivers' own `  ok` / `  FAIL` line protocol (the
//   check() helper every driver defines) plus ✔ node:test assertions
//   (voice-engine.dom.mjs is the one node:test-based driver).
// - Each probe runs with cwd = a private temp "farm" (symlinks to src,
//   test, public and node_modules-minus-.cache). Drivers compile their
//   harnesses into node_modules/.cache/spectra-dom-tests/<name>/, and
//   the suite runs that same driver against the SHARED cache at the
//   same time this guard re-runs it — two writers of one file would
//   race (truncate vs read) and make this guard itself flaky. The farm
//   gives every probe a private write root while reads follow symlinks
//   into the real tree; it is removed after the probes.
// - Probes add `--preserve-symlinks --preserve-symlinks-main` (via
//   NODE_OPTIONS): drivers resolve cwd-relative URLs (their stub
//   redirects, fileURL('src/lib/…') rewrites) while the loader
//   REALPATHS ordinary resolutions through the farm's symlinks — under
//   default flags one process then holds TWO instances of a stub (the
//   shortCircuit redirect URL and the realpath diverge) and the checks
//   fail for real. With the flags every resolution is keyed by the farm
//   URL, so the identity scheme is uniform. Verified equivalent: all 22
//   drivers execute the same checks as a plain run.
// - This file and esm-dir-hook.mjs are helpers, not drivers: discovery
//   is `*.dom.mjs`, which is why this guard is named without `.dom`.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readdirSync,
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const FRONTEND = fileURLToPath(new URL('..', import.meta.url));
const PROBE_TIMEOUT_MS = 180_000;
const PROBE_POOL = 4;

// Minimum executed checks per driver (see header). Counts as of the
// 2026-11-12 revival audit — the six revived drivers went 0 → their
// real number here; settings re-pinned 61 → 73 when the concurrent-
// imports control added its section H (2026-11-13), and 73 → 74 when
// that control was replaced by the machine-level "Parallel work" knob
// in its own card (one extra check: the old control's absence);
// econ-tables re-pinned 94 → 98 when section J added the scoreboard
// metric-header cap pins (2026-11-13), and 98 → 100 when the short_name
// display-criterion pin was added (2026-11-13); builder.dom.mjs entered
// with 38 (2026-11-13 — the Builder list filter toggles + built-in
// immutability wave: a NEW driver, the Builder view having had no
// harness of its own).
// W4 (stored-metrics read path, 2026-11-13): builder 38 → 56 (section I
// — state chips on list items + editor card, k/N progress, metric-done
// refetch, the draft-vs-saved preview criterion, no-version pin) and
// econ-tables 100 → 107 (section G — the Match value-slot state machine:
// five states + the honest dash + no-version pin); profiles 45 → 51
// (section I — PlayerProfile's Career metrics panel); reports.dom.mjs is
// NEW at 16 (the flat match-scope list, the stored read, the export
// copy, the behind chip + "value not computed" line, the live feed and
// the no-version pin).
// Dogfooding W1 (metric ordering, 2026-11-14): builder 56 → 72 (section
// J — the Order dialog: entry point, two stacked sections, read-only
// fixed block, write-through keyboard/button moves, Reset → Delete,
// read-only pin indicator, Close) and reports 16 → 18 (section G — the
// appendix list follows the match order pref: saved order re-sequences,
// key gone → default sequence).
// Dogfooding W3 (profile surface, 2026-11-14): profiles 51 → 67 (section
// J — the converted card set is 4 fixed cards, the Career metrics panel
// renders the nine DEFAULT pins in DEFAULT order over a reversed
// catalog, and the Profiles ADR column is metric-backed: stored value,
// honest gap, behind chip, metric-value sort with gaps last).
const EXPECTED = {
  'app-dock.dom.mjs': 59,
  // builder 72 → 95 (2026-11-14, metrics UI-A + B): UI-A rewrote the
  // filter/editor sections (72 → 91 with section J at its base 16) and
  // UI-B reworked section J 16 → 20 (pins-only list, help line + empty
  // state, grabber drag) — combined 91 − 16 + 20 = 95.
  // builder 95 → 99 (2026-11-14, metrics list-filter multi-select): the
  // three toggle-button lines became ONE Filters trigger + Popover
  // checkbox panel. Section A reworked 7 → 11 (the trigger replaces the
  // lines, opens the panel, pins the defaults — Built-in unchecked,
  // rest checked — and the three labelled groups, then closes it both
  // by click and by Escape); B/C/G/H kept their check counts and only
  // swapped toggle flips for checkbox flips; D/E/F/I/J untouched.
  // builder 99 → 107 (2026-11-14, the Type group = the format filter):
  // +1 section A (all six Type boxes checked by default beside the
  // twelve-box/four-group panel pin), +4 section C (the canonical
  // subset word per flip — Auto off, "auto,percent", all-off → "none",
  // restore), +3 section G (format composing with origin and the search
  // in ONE call, plus the restore); B/H kept their counts and only
  // gained the format arg slot / the twelve-check restore pins;
  // D/E/F/I/J untouched.
  // builder 107 → 111 (2026-11-15, built-in read-only inputs + the
  // two-row form): +4 section D — the three text inputs and the two
  // textareas are readonly (never disabled, so selection/copy stays
  // live), the three selects are disabled, and a loaded user metric
  // lifts every gate again. The row reorder (Denominator before
  // Format) moves no check: fields are addressed by id.
  // builder 111 → 112 (2026-11-15, row-order pin): +1 section D — the
  // eight #bld-* fields in DOM order deep-equal the two fixed rows
  // (Name/Title/Short · Scope/Denominator/Format, then Doc/Expression),
  // so the owner's row ruling is mechanical. The stray ">" text nodes
  // beside the two read-only chips were deleted the same day — the
  // chip assertions read the <span> only, so they moved no count.
  // builder 112 → 111 (2026-11-15, metric-reorder): −1 section J — the
  // handle-driven DnD check died with the drag path (rows are no longer
  // draggable and carry no grip); the grabber pin was rewritten IN PLACE
  // as the "no drag source anywhere" pin, which moves no count.
  // builder 111 → 118 (2026-11-15, preview N-sort — merged atop the 111
  // re-pin): +7 section E — the preview table's client-side sort (default
  // N highest-first; Value highest then lowest first by VALUE not its
  // percent text; N's first click high-first with the header marked and
  // its sample-size tooltip kept, second click low-first; a text column
  // A→Z). The stored-value stub now returns three rows for the previewed
  // metric so an ORDER is observable at all (it was single-row before).
  'builder.dom.mjs': 118,
  // combat 75 → 86 (2026-11-14, dogfooding W2): +2 section J (the KAST
  // cell renders the metric value; the dialog header reads it — the
  // client-side fallback's 100% would disagree with the stored 50%),
  // +2 section L (a dead backend now surfaces the metric-slot alert too
  // — two dismissals), +7 the new section M (header positions, the
  // default KAST-metric order, value/dash cells, the behind chip).
  // combat 86 → 87 (2026-11-14, inferred W2b): +1 section M (the two
  // W2b slots — Untraded deaths / Missed trades — render their metric
  // values, a stored 0 and the honest dash); the behind check widened in
  // place to all five slots (no count change).
  // combat 87 → 88 (2026-11-15, C11 engagement kind toggles): +1 section
  // A (fresh mount = all four kind toggles off — aria-pressed="false",
  // no .active — with every row shown: all-off = no filter, the lead
  // ruling made mechanical); sections D/E/I re-pinned in place for the
  // OR union and the removed "all" button (labels exactly the four
  // kinds; both-on shows the row once; deselect-all → all rows;
  // opening-only empties; untraded ADDED keeps the traded row) — those
  // kept their check counts.
  'combat.dom.mjs': 88,
  'compare-rounds.dom.mjs': 27,
  'confirm-dialog.dom.mjs': 20,
  // docs (documentation popup, 2026-11-14): NEW at 41 — section A (the
  // sidebar Help button's chrome/position/never-active pins, the sheet
  // opening at the guide top with the full TOC and no switcher yet, the
  // Close leg + focus return), B (the Builder `?` deep target: header
  // position, aria-current on metric-language, the composed anchor +
  // scrollTop formula, the Builder still mounted), C (Escape and bare-
  // backdrop dismissal, each with focus return), D (TOC navigation,
  // Back to top, the repeated-openDocs token re-target), E (placeholder
  // sections carry ONLY the coming-soon note; the metric chapter is
  // real prose), F (four rendered-text accuracy pins from the manual)
  // and G (a live-registered second manual flips the switcher and swaps
  // the TOC/body — run last so it cannot leak into earlier pins).
  // docs 41 → 46 (2026-11-14, user-manual content onboarding + the W1
  // manual reconciliation): A/D re-pinned in place (26 TOC entries,
  // Introduction leads — same check counts), E became the no-placeholder
  // reality (4 checks: registry flags+blocks, rendered bodies without
  // the note, the sources section's NEW count-free opener, the
  // metric-language intro) for E's old 3, F +3 (guide accuracy pins:
  // importing demos' originals-untouched promise, the Library's honest
  // dash, the SQL console's read-only construction), G +1 (the
  // placeholder render path moved here — the guide no longer ships one).
  // docs 46 → 60 (2026-11-14, docs popup UX wave): +3 section A (the
  // near-fullscreen geometry as computed styles — centred backdrop with
  // its uniform 16px margin, panel = viewport − 2×16px, no modal cap —
  // plus the header order title → search input → Close), +2 section C
  // (the search input's Escape contract: a non-empty query clears
  // first, the next Escape closes), +3 section D (the two Back-to-top
  // pins died with the button; +5 scroll-spy pins — goTo agreement, a
  // manual scroll → .active/aria-current, the threshold holding the
  // previous section, the handover, the bottom-of-doc rule — driven by
  // dispatched scroll events over a 500px-per-section offsetTop model),
  // +6 the NEW section G (TOC-only search: case-insensitive title
  // match, body untouched, transient-state pin, rendered-text-only
  // match, the catalog no-match line, clearing restores), old G
  // re-lettered H with its check count unchanged.
  // docs 60 → 69 (2026-11-14, N3+N4 manual wave): +9 the NEW section H
  // (the two-tier contents list — the ONE subsection toggle on the
  // metric-language row with its default-expanded + catalog-label pins,
  // fold → 13 entries + aria-expanded false, unfold → 26, the dual
  // highlight on a current MINOR (.active + aria-current vs the major's
  // .parent-active, exactly one aria-current) and on a current MAJOR
  // (no .parent-active anywhere), a query expanding a FOLDED chapter so
  // its marked match stays listed, the fold state surviving the query,
  // <mark> in a TOC label AND a body section heading with byte-identical
  // text, clearing removing every mark); the second-manual section
  // re-lettered H → I with its 4 checks unchanged.
  // docs 69 → 72 (2026-11-15, manual-search body highlighting): +3
  // section G (the content-only needle now marks the BODY prose, not
  // just the TOC — every <mark> in .doc-body carrying the exact needle
  // inside the importing-demos paragraph, that paragraph's textContent
  // byte-identical to its unmarked render, and the clear removing every
  // body mark); every existing G/H check untouched.
  // docs 72 → 75 (2026-11-15, C4 guide tier headers + separators): +3
  // section H — the body-side tier styling: both declared heading sizes
  // as rendered (majors 1.5rem, minors 1.15rem), the separator rule's
  // `:not(:first-child)` exemption with its 1px var(--divider)
  // border-top, and the `parent` criterion reaching the DOM (classes +
  // the injected rule matching a non-first major only, its 14px/12px
  // gap computing there — jsdom cannot compute a var()-coloured
  // border-top shorthand, so the border is pinned as source + selector
  // match, never as a computed width).
  'docs.dom.mjs': 75,
  // econ-tables 107 → 108 (2026-11-14, dogfooding W2): −3 the KAST%
  // error-dismissal sub-checks (combatError died with the KAST% metric
  // column), +4 the new section K (fixed block first, the four
  // converted metric columns after it, the m5-mth cap scope, the
  // fmtMetric cell values).
  // econ-tables 108 → 116 (2026-11-14, inferred-conversion W2a): section
  // K re-pinned for the twelve-column swap (+8: the Opening K/D
  // metric-composed pair both ways, the expand toggle, the expanded
  // row's fixed metric slots raw-vs-metric + tooltips + raw survivors,
  // the roster triple's metric A half both ways).
  // econ-tables 122 → 124 (2026-11-15, round-view C6 — merged atop the
  // 122 re-pin): section C2's round-level chip pins became per-SIDE pins
  // (two chips per round from getEconomy — the CT/T pair split the old
  // one-chip checks, +1 the side-label pin; the `—`/unknown/tooltip pins
  // re-pointed in place), I(c)'s failure source re-pointed to getEconomy.
  // econ-tables 124 → 127 (2026-11-15, help-buttons — merged atop the
  // 124 re-pin): +3 section H (the header `?` is the Match header's last
  // element right of the .spacer with the shared labels + glyph, then the
  // per-tab walk — every one of the nine tabs' `?` opens its OWN guide
  // section, and the walk fires exactly one openDocs call per tab).
  // econ-tables 127 → 121 (2026-11-15, no-expand C13 — merged atop the
  // 127 re-pin): −4 section K (the expand toggle and the expanded row's
  // three panel checks died with the row expansion; the fixed-block/
  // metric index offsets re-based onto the chevron-free first column),
  // −2 section L (the chevron-cell and chevron-button pins deleted; the
  // name cell, the header and the hover twin re-pinned to the ONE frozen
  // column at left 0).
  'econ-tables.dom.mjs': 121,
  // heatmap-layer 49 → 71 (2026-11-15, heatmap drag area-select): +22 in
  // the new section O — the rubber-band gesture's two shapes: the overlay
  // while held (presence + CSS-px geometry) with nothing emitted until the
  // release, the clipped world box + anchor value on release, the sub-
  // threshold nudge drawing no box and emitting the old cell, the inclusive
  // 4px boundary taking the region path, the canvas-edge clamp, pointercancel
  // clearing without emitting, the bbox-less kind never starting a gesture,
  // the empty-intersection anchor-cell fallback (out-of-raster, missing
  // value), the straight zero-width drag reaching the raster as a line, and
  // the owner's styling ruling (solid accent, never side colours, never
  // dashed, pointer-events none) as a CSS-text pin.
  'heatmap-layer.dom.mjs': 71,
  'landmark-row.dom.mjs': 33,
  // library 167 → 169 (2026-11-15, library-side-color): the score cells
  // and the matchup names were RE-PINNED to the START-side colour rule
  // (owner ruling: BOTH W and L are keyed to the side each team started
  // on, superseding the W cell's end-side rule) — +1 the section B
  // matchup-name colour pin, +1 the section K pin over both rendered
  // rows (their fixtures now carry an ODD side-switch count).
  // library 169 → 171 (2026-11-15, help-buttons): +2 section A (the
  // header `?` is the header's last element right of the .spacer with
  // the shared labels + glyph, and clicking it fires openDocs once with
  // the `library` section id and navigates nowhere).
  // library 171 → 173 (2026-11-15, library-fit C15 — merged atop the 171
  // re-pin; the imported-demos table trailing off the window's right
  // edge): +2 section J width-fit trim pins — both library tables carry
  // the lib-table class, and style.css trims their horizontal cell
  // padding in a rule scoped to that class (the demo-name cap 260px →
  // 170px is an in-place value re-pin; both min-width reservation pins
  // untouched).
  'library.dom.mjs': 173,
  'map-pack-prompt.dom.mjs': 48,
  'match-picker.dom.mjs': 43,
  'payload-tree.dom.mjs': 21,
  'player-card.dom.mjs': 174,
  'player-search-hint.dom.mjs': 21,
  // profiles 45 → 51 (section I — PlayerProfile's Career metrics panel),
  // then 51 → 67 for dogfooding W3 (section J — see the header note),
  // then 67 → 71 for inferred-conversion W3a (2026-11-14): +2 section E
  // (the K/D/A cell composes raw K/D with the metric-backed assists, and
  // a null assists renders the honest dash), +2 section J (both
  // converted cards gone from the grid — the Opening duels and Clutches
  // checks join the gone-loop — and their numbers render as rows), −1
  // the retired Clutches CARD value check.
  // then 71 → 79 for profile-trend-career (2026-11-15): +8 section K —
  // the trend card's metric picker (verb hint + aria, the default read
  // by NAME, the sequence listing, the profile-scope exclusion, the
  // picked TITLE in the field, the NAME on the series read, the
  // sparkline's aria-label); sections I/J moved from `tbody tr` to the
  // new `.prof-career-card` grid in place (no count change).
  'profiles.dom.mjs': 79,
  'progress-presentation.dom.mjs': 19,
  // replay 450 → 452 (2026-11-15, help-buttons): +2 section A (the
  // header `?` rides the top bar right of the ribbon — immediately
  // left of the rail toggle — with the shared labels + glyph, and
  // clicking it fires openDocs once with the `replay` section id and
  // navigates nowhere).
  // replay 452 → 453 (2026-11-15, C10 loop-length pref — merged atop the
  // 452 re-pin): +1 the E1b PREF_READS pin (the view reads loop_secs on
  // load — the same store a reload reads back, mirrored from the
  // skip_freeze pin). The quick-range label and both window checks
  // re-pinned IN PLACE for the default 5 s (label ±5 s; 0:05–0:09 at tick
  // 640, 0:00–0:05 at tick 0), so only the new pin moved the count.
  // replay 453 → 463 (2026-11-16, replay-feed C19+C20): +4 section N2
  // (C19 — the row ▶ seeks AND pauses: baseline row+playing glyph, the
  // seek delta to the event tick, pause +1 with no extra play, and the
  // uiPlaying glyph offering Play again). +4 section G3 (C20 — the
  // Position row: a partial row never commits, four finite bounds gain
  // bbox=minX,minY,maxX,maxY, they read back through the URL→prop
  // round trip, and the clear ✕ drops both). +2 beside the default-hides
  // re-pin (the field-gated Position row now SHOWS under the sparse
  // default: seeded empty, and carrying aria-labels with no
  // placeholders). The default-hides check itself, the landing-URL
  // re-pin and the label-sequence re-pin (…· POSITION) moved IN PLACE.
  'replay.dom.mjs': 463,
  // reports 18 → 20 (2026-11-14, dogfooding W4): section G gained the
  // two EXPORTED-document order pins (the appendix sections follow the
  // match sequence with the pref, and return to the default order when
  // the key is gone — design §2.5's addendum).
  // reports 20 → 22 (2026-11-14, inferred-conversion W3b): +2 section H
  // (the player picker's K/D/A triple composes per half — the stored
  // assists METRIC half renders, and an absent row dashes it to
  // 20/5/— while K/D keep their stored fields).
  // reports 22 → 24 (2026-11-15, N7 appendix metric picker): A/B/D/E/G
  // rewrote from checkbox clicks to the dropdown row interaction (+ adds
  // a row, a SuggestInput suggestion picks, − removes) — +1 section D
  // (the new row offers only the stats no other row holds) and +1
  // section G (no rows → no appendix: the − sweep drops the preview's
  // "+ appendix" suffix with only the add button left); C/F/H unchanged.
  // reports 24 → 31 (2026-11-15, appendix chip field + Save report): the
  // checkbox/SuggestInput rows became TokenSelect — picks land as chips
  // with their own ✕ (D gained the remove → re-offerable pin), G gained
  // the registry-restore, chip-sequence, Backspace-removes-last and
  // remaining-✕ pins, B gained the chip-with-remove-button pin, and C
  // became the save path: the preview panel died, so its "renders"
  // checks now read back the downloadText bytes (filename/mime pin, the
  // appendix line and the saved rows ride the file). A/D dedupe and E/F/H
  // keep their shape.
  // reports 31 → 32 (2026-11-15, reports-card): the match view's Reports
  // tab consolidated its content to a single section.panel — +1 the
  // mount-shape pin (exactly one panel renders; both headings stay in it).
  // reports 32 → 34 (2026-11-15, help-buttons — merged atop the 32 re-pin):
  // +2 the new section I (the header `?` is the standalone header's last
  // element right of the .spacer with the shared labels + glyph, and
  // clicking it fires openDocs once with the `reports` section id).
  'reports.dom.mjs': 34,
  // round-detail 64 → 76 (2026-11-15, round-view C5): header = title only
  // (meta line + buy-class chip moved out — +2 the Round info card pins:
  // renamed card, meta line landed, First kill absence), +2 ribbon pins
  // (top-of-content order, both neighbours enabled at round 5), +6 the
  // Economy card's per-team Class column (header, one chip per side row,
  // palette keys, why+rules tooltip, colspan-4 empty state), +2 the new
  // F2 block (round 1 → prev disabled), and F's end-pin flipped from
  // "next gone" to "next disabled".
  'round-detail.dom.mjs': 76,
  'round-strip.dom.mjs': 47,
  // settings 74 → 49 (2026-11-15, N1+N2): the analysis-rules card is
  // save = recompute — the "Re-run analysis…" subsection, the behind
  // list machinery and the rules-version display are gone, and the
  // Stat definitions card went with its guide bullet. Sections A–D
  // rewritten for the new card (pristine gating + card shape, the
  // absence pins for the removed UI, the bumped-save recompute kick,
  // the no-bump honesty), E is the untouched Parallel-work card, and
  // the runtime-error tail closes the file.
  // settings 49 → 51 (2026-11-15, help-buttons): +2 the new section F
  // (the header `?` — Settings gained the .spacer it never had — is the
  // header's last element with the shared labels + glyph, and clicking
  // it fires openDocs once with the `settings` section id); the
  // runtime-error tail stays the closing check after it.
  // settings 51 → 65 (2026-11-15, C10 loop-length pref — merged atop the
  // 51 re-pin): +14 section G — the new "Replay" card's Loop length
  // control: card + label presence, the min 1 / max 60 bounds, the
  // seeded default 5 (the pref read is unset on a fresh profile), NO
  // write on a plain mount, the in-range write verbatim, and the clamps
  // both ways (99 → 60, 0 → 1, garbage → the default) each with the
  // input snapping to what was stored. Sections A–F kept their check
  // counts (F's whole-run error check just runs after G now).
  'settings.dom.mjs': 65,
  // sqlconsole (2026-11-15, help-buttons): NEW at 5 — the SQL console
  // is the one view header with no driver of its own (its loading lines
  // are source-pinned in progress-presentation, its engine in Go), so
  // the shared HelpButton's mount coverage lives here: section A (the
  // `?` is the header's last element right of the .spacer with the
  // shared labels + glyph, the head note intact) and B (one openDocs
  // call with the `sql-console` section id, the route unmoved).
  'sqlconsole.dom.mjs': 5,
  'stat-card.dom.mjs': 12,
  // utility 39 → 41 (2026-11-15, I30 view-aggregate tooltips): +2 — the
  // flash-effectiveness cells' card tooltip and the per-round team-damage
  // line's formula tooltip (the AGENTS view-aggregate rule: the formula
  // lives in the card title or tooltip, not only in the section note).
  // utility 41 → 69 (2026-11-15, wave utility-tab = C7+C8+C9): the
  // per-round group cards became ONE bottom throw log (+9 section D —
  // card order, selectors/count inside, the all-off toggle default and
  // the "toggle round on" preamble the row checks now need; +6 section L
  // — lists render only for the rounds turned on, both empty states
  // distinct), the flash-effectiveness card became the blind-time chart
  // (+10 section K — its own heading, bars, era-flip hue, own pattern id,
  // stripe, legend, honest label + tooltip, the no-blind-time empty state
  // and its restore), C9 added its 2 absence pins (section J), section A
  // gained the SVG title-space pin (the {" "} that keeps "Alpha 40
  // damage" from collapsing), section I its filter-restore pin, section M
  // 3 CSS pins (stacked charts, the single-line toggle row, the retired
  // rules gone) and section E lost the group-header/flash-card checks it
  // replaced. Error-path section re-pinned to the throw-log card.
  'utility.dom.mjs': 69,
  'voice-engine.dom.mjs': 7,
};

const driverFiles = () =>
  readdirSync(join(FRONTEND, 'test'))
    .filter((f) => f.endsWith('.dom.mjs'))
    .sort();

// Checks = the drivers' `  ok` / `  FAIL` line protocol plus node:test
// ✔ assertions (voice-engine.dom.mjs). The runner's file-level wrapper
// line (`✔ test/<file>.dom.mjs (…ms)`) is NOT a check — excluding it is
// what makes a dead driver count 0 instead of 1.
const countChecks = (out) =>
  out
    .split('\n')
    .filter(
      (l) =>
        /^ {2}(?:ok|FAIL) /.test(l) ||
        (/^✔\s/.test(l) && !l.includes('.dom.mjs')),
    ).length;

// The driver's own failure lines first, else its last few lines — what
// someone needs to see when a probe comes back dead or short.
const diagnose = (out) => {
  const lines = out.split('\n').filter((l) => l.trim() !== '');
  const errs = lines
    .filter((l) => /FAIL|UNCAUGHT|REJECTION|Error|FAILED/.test(l))
    .slice(0, 6);
  return (errs.length ? errs : lines.slice(-3)).join('\n      ');
};

// A probe: run the driver exactly as the suite does (node --test, one
// file, cwd = the private farm) and count what it executed.
const probe = (file, farm) =>
  new Promise((resolve) => {
    const env = { ...process.env };
    // The suite's own test-runner context must not leak into the probe.
    delete env.NODE_TEST_CONTEXT;
    // Uniform farm-URL module identity — see the header's preserve-
    // symlinks note; without it the farm splits stub instances.
    env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + ' ' : ''}--preserve-symlinks --preserve-symlinks-main`;
    const child = spawn(process.execPath, ['--test', join('test', file)], {
      cwd: farm,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), PROBE_TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, checks: countChecks(out), out });
    });
  });

test('every test/*.dom.mjs driver is pinned in EXPECTED (new drivers opt in with their real check count)', () => {
  const files = driverFiles();
  const unlisted = files.filter((f) => !(f in EXPECTED));
  const stale = Object.keys(EXPECTED).filter((f) => !files.includes(f));
  assert.deepEqual(
    unlisted,
    [],
    `unlisted driver file(s) — add them to EXPECTED with their real executed-check count: ${unlisted.join(', ')}`,
  );
  assert.deepEqual(
    stale,
    [],
    `stale EXPECTED entr(ies) — no such driver file: ${stale.join(', ')}`,
  );
});

test('every driver actually executes its pinned checks and exits 0 (re-run from a private cwd farm)', async () => {
  const farm = mkdtempSync(join(tmpdir(), 'spectra-driver-liveness-'));
  try {
    // The farm: drivers resolve every relative path (src/, test/,
    // public/, node_modules/<pkg> and their own cache writes) against
    // cwd. Reads are symlinked to the real tree; only node_modules/
    // itself is a real directory so the .cache write root is PRIVATE
    // (.cache is deliberately not symlinked).
    for (const entry of ['src', 'test', 'public']) {
      symlinkSync(join(FRONTEND, entry), join(farm, entry), 'dir');
    }
    mkdirSync(join(farm, 'node_modules'));
    for (const entry of readdirSync(join(FRONTEND, 'node_modules'))) {
      if (entry === '.cache') continue;
      symlinkSync(join(FRONTEND, 'node_modules', entry), join(farm, 'node_modules', entry));
    }

    const queue = driverFiles().filter((f) => f in EXPECTED);
    const results = new Map();
    const workers = Array.from(
      { length: Math.min(PROBE_POOL, queue.length) },
      async () => {
        while (queue.length) {
          const file = queue.shift();
          results.set(file, await probe(file, farm));
        }
      },
    );
    await Promise.all(workers);

    const dead = [];
    for (const [file, min] of Object.entries(EXPECTED)) {
      const r = results.get(file);
      if (!r) {
        dead.push(`${file}: never probed`);
      } else if (r.signal || r.code !== 0) {
        dead.push(
          `${file}: exited ${r.code === null ? 'via signal ' + r.signal : 'code ' + r.code} before reporting\n      ${diagnose(r.out)}`,
        );
      } else if (r.checks < min) {
        dead.push(
          `${file}: executed ${r.checks} check(s), pinned minimum ${min} — vacuous exit 0\n      ${diagnose(r.out)}`,
        );
      }
    }
    assert.deepEqual(
      dead,
      [],
      `dead driver(s) — executing zero/short of checks while reporting PASS:\n      ${dead.join('\n      ')}`,
    );
  } finally {
    rmSync(farm, { recursive: true, force: true });
  }
});
