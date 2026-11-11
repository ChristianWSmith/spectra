# Localization — roadmap research

**Unit:** platform · **Priority tier:** P5 · **Date:** 2026-11-10
**LoE (aggregate):** L — the framework/pref itself is S–M (a tiny dict + kvstore key + Settings selector ≈ 1–2 days), but the one-time mechanical sweep is the cost: ~1,400 user-facing string literals across 39 Svelte files (16.8k LOC) + ~400–600 in `lib/*.js` + Go-side report/error/schema surfaces, plus translating dense CS2-analytics prose (the `definitions.js` glossary entries are multi-hundred-word paragraphs) into Russian and maintaining ~400 exact-string DOM-test pins. Full RU/EN parity = several weeks; an M-sized first increment (infra + core views, en fallback) is a legitimate phase cut.
**Feasibility:** high — no blockers; UI-only (no data-model change), the pref follows the proven `font_size` pattern, and Svelte 5 runes make runtime switching trivial. Owner decisions required first: language ranking and how much Go-side surface ships translated vs. English-only.

## Items in scope

1. **Localization** — Russian/English UI; later — start with the most commonly spoken languages in CS2 and work down

## Current state

- **Zero i18n infrastructure.** No i18n dependency (`frontend/package.json` = svelte, vite, codicons, wails runtime only), no locale pref (`prefs.go` has no language key), no `<html lang>` handling beyond the hard-coded `lang="en"` in `frontend/index.html`, no dictionary module anywhere (`rg` for i18n/locale/dictionary: no hits outside roadmap docs). Every string is a hard-coded literal.
- **Frontend string surface (the bulk), grep-estimated ~1,400 translatable literals:**
  - **39 Svelte files / 16,826 LOC** (12,243 in `lib/views/` + 4,427 in `lib/components/`): ~998 prose string literals (quoted, containing a space, excluding `class=` attrs), ~465 text-node fragments, ~294 `title`/`placeholder`/`aria-label` attributes. Heaviest: `Replay.svelte` (3,880 LOC), `Settings.svelte` (1,273), `Match.svelte` (1,265).
  - **`lib/*.js` non-test: ~627 quoted strings with spaces** (labels, error text, hints) — incl. `landmarks.js` (643 LOC, ~226 strings — THE event categorization labels), `definitions.js` (193 LOC: `GLOSSARY` = 10 long-form entries + ~14 derived tooltip consts + `ENG_KIND_TITLES`), `nav.js` `NAV_ACTIONS` (5 labels, also the CommandPalette Actions section), `fmt.js` (272 LOC — mostly format symbols, `[ALL]`/`[T]`/`[CT]` chat tags, `—` placeholders), `csv.js` (no headers — headers are built at call sites).
  - **Specific named surfaces:** `KBD_HINTS` in `Replay.svelte` (~line 2763, 10 entries, pinned verbatim by `test/replay.dom.mjs`); `CommandPalette.svelte` (section headers `Actions/Matches/Players/Saved filters/Metrics/Saved queries`, placeholder, footer hints); `StatusChip.svelte` `STAGE_LABELS` (7) + `LABELS` (7) — already a display-layer translation table over Go stage constants (the comment says so explicitly: "translated to player language HERE"); `errText` in `lib/services.js` — 101 call sites across 17 views, a pure passthrough of **Go** error strings; Settings (sections, glossary render from `GLOSSARY`, ~1,273 LOC of prose); dialogs/popovers (`Dialog`, `ConfirmDialog`, `Popover`); picker footers (`↑↓ move · Enter select · Esc close` ×3).
  - **Tests pin English strings hard:** ~400+ exact-string assertions across `frontend/test/*.mjs` (`replay.dom.mjs` alone: 151 literal matches incl. the 10 `KBD_HINTS` lines; `library.dom.mjs` 86; `player-card.dom.mjs` 86). These stay green only if the default test locale resolves to `en` — a deliberate design constraint, not luck.
- **Go-side surface (smaller but real), ~200–400 strings:**
  - **`internal/report`** — the translatable *content* surface: 4 embedded templates (`match.md`/`match.html`/`player.md`/`round.md`, 134 LOC of English markdown/HTML table headers and prose) + `builtinMeta` titles ("Match report", …) via `//go:embed templates/*`.
  - **Errors surfaced through `errText`:** ~9 user-facing validation errors in `package main` ("give the filter a name", "trade window must be at least 1 second", …) plus service-layer errors (`query:`, `metrics:`, `library:` prefixed) — of the ~527 `errors.New`/`fmt.Errorf` in non-test Go, only this validation/tier reaches users; internal wrapped errors ("store: …", "sidecar: …") are developer text.
  - **`internal/query/schema.go`** `tableNotes` (~30 table descriptions — the SQL console schema browser); `metricservice.go` `"Formula: "` doc fallback; **7 builtin metric titles seeded in `schema.sql`** (stored in DB rows — see risks); `eventlabels.go` (mostly structural `k=v`/`team →` fragments, minimal).
  - Go job-stage constants (`models.Stage*`, `Status*`) are a **data contract, deliberately not translated** — `StatusChip` maps them at display layer. Keep this boundary.
- **Formatting today:** `fmt.js` uses `toLocaleString(undefined, …)` (browser-default locale) in `fmtDate`/`fmtMoney`/`fmtInt`/`Reports.svelte` — locale-aware by accident, never pinned to a chosen language. KAST%/ADR/HS% notation is symbolic (universally readable; no translation needed). Go report dates render via `time` formatting in templates.
- **Prior art in the repo:** several roadmap files already pre-decide the policy "new strings ship English until localization lands, keep them in key-based/central surfaces" (`export-formats`, `export-tooling`, `stats-*`, `replay-*`, `notes-*`, `video-detection`, `strategy-board`) — i.e. the sweep has been anticipated and deferred consciously, not ignored.

## Implementation path

**Phase 0 — owner decisions (blockers for PATH, not LoE):**
1. **Language ranking.** ROADMAP says "Russian/English"; PRODUCT says "start with the most commonly spoken languages in CS2 and work down". The owner should fix the ordered list (RU+EN first is the implied pair; candidates down the list are a product call) — **do not decide this agent-side.**
2. **Go-side depth:** full translation of report templates + validation errors vs. English-only Go v1 (frontend-only localization). Recommendation: reports ride the locale (they're shareable output — the audience reads them), Go error strings stay English v1 (they're technical, low-count, and translating them means error-code-ifying `errText` — a refactor).

**Phase 1 — infrastructure (S–M):**
- **Framework: custom dictionary modules, no dependency.** Options weighed: `svelte-i18n` (4.0.1 allows svelte 5 as peer dep, but it's store-based/pre-runes, the maintainer states v5 rework isn't planned, and it drags `intl-messageformat`/`cli-color`/`deepmerge` — against dependency minimalism); `i18next` (large generic runtime, worse fit); `@sveltia/i18n`/`@nomideusz/svelte-i18n` (runes-native but niche/new). A custom `lib/i18n/` is ~100 lines: one locale `$state` store, `t(key, params)` with `{placeholder}` interpolation, flat per-locale JSON files, per-key English fallback. This also matches the **VS Code precedent the owner's aesthetic points to**: VS Code's own localization is string tables with placeholders — stable keys, one JSON bundle per locale (`nls.*`/`l10n`), keys never re-flowed per language. Cite that as the design model.
- **Locale file layout:** `frontend/src/lib/i18n/en.json` (+ `ru.json`, …), namespaced flat keys (`settings.analysis.title`, `statuschip.stage.parse`, `defs.kast.text`). `en` = source of truth; missing key in any locale falls back to the `en` string (never the raw key in production; raw key as dev-time loud failure is a nice-to-have). Keys extracted from existing literals — English text moves into `en.json` verbatim so no user-visible wording changes on migration (same discipline as the shortcut-registry research).
- **Pref:** kvstore key `language` in `prefs.go` following the `font_size` pattern (frontend reads/writes directly; default `en` or navigator-negotiated once, then persisted). **Runtime switch, not launch-time:** Svelte 5 runes make the locale store reactive — every `t()` re-renders live, VS Code-style. Go learns the locale **explicitly per call** (frontend passes it to `RenderReport`) rather than Go reading the pref — keeps Go pref-free like every other frontend-owned pref.
- **Settings selector:** a Language dropdown in Settings (next to font size) writing the kvstore key; `<html lang>` updated reactively.

**Phase 2 — the sweep (the L):**
- **Order by canonical home, not by file:** start with the surfaces other units already promised to keep key-based — `definitions.js` (glossary + tooltips = the highest-value, most-read prose), `StatusChip`, `errText` call sites, `nav.js`/`CommandPalette`, dialog/confirm strings, picker footers — then per-view extraction view by view (Replay last: biggest file, most test pins). Each extraction = literal → key in `en.json`, no wording changes, tests untouched (they resolve `en`).
- **Go side:** report templates → per-locale template dirs (`templates/en/…`, `templates/ru/…`) under the same `embed.FS`, or one template + a Go label map for the headers — pick one, don't fork both; `tableNotes` and builtin metric titles either get a small Go-side label table keyed by id or ship English (decision = phase 0 item 2).
- **Formatting:** thread the active locale into `fmt.js` formatters (`toLocaleString(locale)` instead of `undefined`) and `fmtDate`; KAST/ADR/percent notation stays symbolic; decimal/comma and date order follow the locale via `Intl`.
- **Incremental adoption is viable and recommended:** Phase 1 + the canonical-home surfaces can ship as an M increment with `en`-only content and a hidden selector; the long tail (every view, RU translation of dense prose) lands in batches. Nothing breaks with partial coverage thanks to per-key `en` fallback.

**Phase 3 — translation content:** the RU bundle. The glossary/definition paragraphs are the hard part (accurate CS2-analytics Russian, terminology consistency — KAST/trade/window terms must match the CS2 RU community's vocabulary). This is content work with its own review loop, plausibly the owner's to approve; it scales with corpus size, hence Phase 2 batching.

## Existing scaffolding to reuse

- **`StatusChip` `STAGE_LABELS`** — proof of the display-layer translation boundary (Go constants → frontend labels); the pattern generalizes to every Go-contract enum.
- **`prefs.go` `font_size` pattern** — frontend-owned kvstore pref with reconcile-on-boot (`lib/fontsize.js`); copy it verbatim for `language`.
- **`definitions.js`** — already THE one glossary/tooltip source; localization makes it a dictionary surface rather than a second string home (it stays canonical).
- **`errText`** — the single error funnel (101 sites); the one place a Go→UI string policy can be applied centrally.
- **`Dialog`/`Popover`/`ConfirmDialog`, `SortTh`, `StatCard`, `MatchPicker`, `LandmarkRow`** — canonical components mean their inner strings are translated once, not per view (AGENTS canonical-homes table).
- **`eventlabels.go` / `models.Stage*` boundaries** — established rules for what is data-contract vs. display text; reuse the distinction instead of re-deriving it.
- **DOM test harnesses** (`frontend/test/*.mjs`) — keep them pinned to `en`; no test rewrite needed if default locale = `en`.
- **VS Code `nls`/`l10n` design** — the precedent for stable keys + placeholder interpolation + per-locale JSON bundles (aligns with the stated aesthetic).

## Dependencies & overlaps

- **Definitions/glossary & statistics units** — `definitions.js` strings are their tooltip/glossary content; several stats roadmap files already state "strings ship English until localization lands". Sequencing: they keep adding to `en.json` keys (or English literals that localization later lifts) — coordinate the key namespace once so the sweep doesn't re-touch new files.
- **Export-formats / export-tooling** — CSV/report headers English-only until this lands (both files say so); the shortcut-registry research (`lib/shortcuts.js`) produces one central table that localization consumes instead of sweeping footers — do shortcut-reference first if possible.
- **Reports/exports (Go `internal/report`)** — this unit owns when report output becomes multilingual; the export units own the formats. One decision needed: per-locale templates vs. label map (above), so neither builds a second mechanism.
- **YAML metrics / Builder** — user-authored metric names/descriptions are **user content, never translated**; only the 7 builtin titles in `schema.sql` + the `"Formula: "` prefix are app strings (and they're DB-stored — see risks).
- **Library / job queue** — `StatusChip` labels and job stage text ride this unit; stage constants stay English (data contract).
- **Voice unit** — transcripts are separately multilingual (RU/EN comms) — STT language coverage is *their* problem, this unit only localizes UI chrome around it; do not couple.
- **Annotations/notes/strategy-board/metadata** — all already defer "new UI strings ride localization"; no schema, no jobs, no extract impact (their own words).
- **Data model: none.** UI-only change + one kvstore key. No schema, no sidecars, no golden-fixture impact.

## Risks & unknowns

- **The sweep is the risk, not the framework.** ~2,000 literals across ~80 files + Go surfaces: partial adoption leaves mixed-language UI (mitigated by per-key `en` fallback — an untranslated string must read as clean English, never as a raw key or `undefined`). Big-bang vs. per-view batches is a scheduling call; batches keep the app shippable throughout.
- **Test-pin churn:** ~400+ exact-string DOM assertions. Safe iff tests default to `en`; any change of default locale (e.g. navigator auto-detect on first run) breaks them en masse — decide deliberately: default `en`, negotiate once, persist.
- **DB-stored display strings:** 7 builtin metric titles in `schema.sql`, `round_classifications` reason strings, stored `why`/explanation text (video-detection/annotations pre-decided "English-in-DB until localization"). Translating these at read time means either a display-side label map keyed by id (preferred, matches `StatusChip`) or re-seeding content — **no versioned migration exists by policy**, so a read-side map is the only policy-clean route. Long-form stored prose may simply stay English; flag for owner.
- **RU translation quality is unverifiable by the agent** — dense analytics prose (trade-window, net-worth paragraphs) needs a native CS2-fluent reviewer; terminology drift between `en` glossary and `ru` glossary would violate the "one source" rule the glossary exists to enforce.
- **Owner decisions gate the path:** language ranking (PRODUCT's "most commonly spoken in CS2, work down" vs. ROADMAP's RU/EN pair — the pair is implied but the ranking below it is open), and Go-side depth (reports yes / errors no is the recommendation).
- **Formatting subtleties:** `toLocaleString(undefined)` calls in tests assert browser-default output — pinning an explicit locale changes grouping/decimal rendering and touches `fmt.test.js` expectations; small but real churn.
- **No dependency risk** if custom (recommended); adopting `svelte-i18n` instead adds a semi-maintained pre-runes dependency — against the dependency-minimalism default, require strong reason to override.
