// strings-audit.test.js — the mechanical pin for the criterion in
// AGENTS.md: "user-facing text speaks the user's domain — never
// implementation language" (owner, 2026-11-14). It scans every app-rendered
// string medium and fails on implementation
// language, with the criterion's exemptions in ONE block below
// (the webstorage.test.js:1-40 pattern: rule → failing test, comment-stripped
// scan, exemptions in one const).
//
// The criterion partitions user-facing text into four classes (this test's
// own four-way reading of it):
//   class 1 — free chrome copy (markup text/attrs)  → catalog (lib/strings/)
//   class 2 — domain-keyed table values             → stay with their table; scanned
//   class 3 — content prose (glossary/seed docs/templates/docs manual)
//                                                    → CONTENT_FILES; scanned, sweep scope
//   class 4 — power surfaces (SQL console, cs2find) → POWER_SURFACES; exempt
// Check A (denylist over all five media) fails NEW violations anywhere;
// pre-existing ones sit in the dated PENDING_DENYLIST ledger and are removed
// as the sweep rewords them (a stale entry fails too — the ledger is a
// contract, webstorage's PREF_SITES liveness pin pattern).
// Check B (the class-1 ratchet) is unconditional: every non-power-surfaced
// Svelte file that carries free chrome copy must import the catalog.
// Check D (length tiers, owner 2026-11-15) is the character-budget pin:
// tier 1 ≤70 chars, tier 2 ≤200 chars over the same media, default-tight
// classification (unknown ⇒ tier 1) — its inputs, declarations and rule
// live beside HINT_KEYS below. Check E (verb-like input hints, same owner,
// same day) has its own dated block after TIER2_MAX — it reads no budgets.
//
// Check A also pins the layering-prefix rule: a `pkg: `-prefixed string in
// non-test Go is package vocabulary that reaches errText verbatim. Since
// store-B (2026-11-15) that check fires on EVERY literal of EVERY non-test
// Go file — any file, any position — with two structural carve-outs only:
// log call sites (never rendered; cut in goScan) and PREFIX_EXEMPT's frozen
// playerJobError tokens. Its exemptions and liveness run through the same
// ledger test as DENYLIST_EXEMPT's.
//
// Run: node --test src/lib/strings-audit.test.js   (from frontend/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'svelte/compiler';

// Repo module root (…/src/) — every path below is relative to it.
const SRC = fileURLToPath(new URL('../../../', import.meta.url));
const FE = path.join(SRC, 'frontend/src');

// ---------------------------------------------------------------------------
// Exemptions — ONE dated block. Power surfaces are exempt outright; content
// files are scanned (content-shaped) but never fail; the denylist ledger is
// the migration ratchet (it only ever shrinks).
// ---------------------------------------------------------------------------

// class 4 — deliberate developer-facing surfaces, exempt by construction
// (AGENTS.md criterion bullet, "Exempt power surfaces").
const POWER_SURFACES = new Set([
  'frontend/src/lib/views/SqlConsole.svelte', // the SQL console (named product feature)
  'internal/metrics/doc.go', // the expression grammar reference
  'internal/mappack/devtool.go', // cs2find internals — a developer CLI
]);
const POWER_PREFIXES = [
  'cmd/cs2find/', // cs2find help text — a developer tool (AGENTS.md criterion bullet, "Exempt power surfaces")
];

// class 3 — long-form prose with its own content model. Scanned (the content
// test below enumerates them) but never failing: class 3 is content prose,
// reported as sweep scope rather than blocked — chrome copy is class 1's
// job. `lib/docs/` covers the docs manual (it exists — markdown.js,
// registry.js and the manuals/ modules; the directory prefix covers its
// content modules).
const CONTENT_FILES = [
  'frontend/src/lib/definitions.js', // glossary (AGENTS canonical home)
  'frontend/src/lib/docs/', // the docs manual (content model)
  'internal/store/schema.sql', // seed `doc` column (metrics tooltips)
  'internal/report/templates/match.md',
  'internal/report/templates/match.html',
  'internal/report/templates/player.md',
  'internal/report/templates/round.md',
];

// Check A ledger — pre-existing denylist hits, keyed file → exact literal
// text. Seeded 2026-11-14 with 42 entries across 11 files (30 bound-service
// entries covering 35 construction sites + 12 store/extract/seed literals),
// then drained the SAME day by Strings Stage 3 / Sweep-A: every entry was
// reworded at emit in Go and deleted here in the same commit. Empty today —
// and that is the contract: NEW strings matching the denylist fail anywhere,
// an entry that stops matching must be deleted here, and a reword must take
// its entry with it (a stale entry fails Check A-ledger below).
const PENDING_DENYLIST = {};

// Check A exemptions — denylist hits that are NOT user copy at all: their
// context is code the user never reads, so they are not sweep scope and never
// belong in the ledger. Same `file` → literal keying as PENDING_DENYLIST and
// the same liveness contract (Check A-ledger); `why` is mandatory.
const DENYLIST_EXEMPT = {
  'internal/store/query_store.go': [
    {
      text: 'commit',
      why: 'SQL keyword context — the read-only console validator rejects the SQLite identifier `commit`; it is SQL, not git tooling',
    },
  ],
};

// Check A exemptions for the PREFIX rule (mirrors DENYLIST_EXEMPT): a
// layering prefix that must stay, because the literal is not error copy the
// UI ever renders. Same `file` → literal keying, same liveness contract
// (Check A-ledger), `why` mandatory (asserted there too). Everything else
// with a prefix was reworded at the source (2026-11-15, store-B) — this set
// holds only the tokens of the ONE mechanism that reads them on purpose.
const PREFIX_EXEMPT = {
  'internal/library/library.go': [
    {
      text: 'store: ',
      why: "playerJobError's strip/classify token (jobErrPrefixes + the frame arms) — the import-pipeline framing mechanism itself; rewriting it is a playerJobError behavior change, fenced out of store-B. A no-op for the reworded store family.",
    },
    {
      text: 'analytics: ',
      why: "same strip/classify list — the analysis-failure frame arm; the compute family is reworded, so the token only ever matches nothing.",
    },
    {
      text: 'sidecar: ',
      why: 'same strip/classify list — the save-failure frame arm; the sidecar family is reworded, so the token only ever matches nothing.',
    },
    {
      text: 'library: ',
      why: 'same strip/classify list — the library token (errShuttingDown was already reworded in store-A, so it was already a no-op).',
    },
  ],
};

// ---------------------------------------------------------------------------
// Check D — length tiers (owner's three answers, 2026-11-15): tier 1 common
// locations ≤70 characters, tier 2 hints ≤200 characters, tier 3 anything
// longer must be a help affordance to the user guide (guide prose itself is
// never capped — it IS the destination).
//
// Classification rule (2026-11-15, DEFAULT-TIGHT): unclassified copy is
// tier 1 — new copy must fit 70 characters unless deliberately declared a
// hint. A catalog key is tier 2 only when (a) the markup references it from
// a `title=` attribute (a tooltip is a hint; derived mechanically below) or
// (b) it is declared in HINT_KEYS here. Wholesale tier 2 by medium, per the
// owner's rulings: seed `doc` values (measured whole — Formula included,
// what the user hovers is what counts), definitions.js strings (measured as
// exported — the derived *_DEF constants carry their "Term — " prefix, which
// is exactly the hovered text) and Go error format strings that surface
// through errText. Inline literals are tier 2 only at a `title=` position or
// via HINT_INLINE. Counts are of the static string: catalog templates keep
// their {arg} placeholders. Exempt, never measured: lib/docs/ guide prose
// (the tier-3 destination), the report templates (exported documents, not
// chrome), class-4 power surfaces (POWER_SURFACES/POWER_PREFIXES), test
// files.
// ---------------------------------------------------------------------------

// Tier-2 catalog declarations — key path → why it is a hint (mandatory,
// asserted in Check D; a declared key that leaves the catalog fails as
// stale, the PENDING_DENYLIST liveness contract). Every entry renders as a
// tooltip, footnote or in-place explanatory note, never as a label.
const HINT_KEYS = {
  'builder.headNoteScopes': 'in-form note under the scope picker — a footnote explaining scope granularity',
  'combat.noteTail': 'footnote tail under the calculated-badges legend',
  'common.mapPackNotFoundIntro': 'asset-prompt explanatory copy — the paragraph guiding the no-radar decision',
  'common.mapPackNotFoundFine': 'asset-prompt explanatory copy — the offline/local-storage assurance',
  'common.mapPackFoundIntro': 'asset-prompt explanatory copy — the paragraph listing what extraction reads',
  'common.mapPackFoundFine': 'asset-prompt explanatory copy — the local-storage assurance',
  'common.metricOrderNote': 'footnote under the metric-order list (pin-more pointer)',
  'economy.tableNote': 'footnote defining the table headers (Equip / Loss) and the loss-bonus pip ladder',
  'economy.tableNoteTail': 'footnote tail for the Loss-cell inferred marker over the pips',
  'heatmaps.bboxHint': 'drag/click hint under the map — how the region selection behaves',
  'library.encKeyStatus': 'in-place note pointing at the per-match key status',
  'library.importDirsNote': 'footnote under the import listing (scan depth + copy semantics)',
  'profiles.sparkFootnote': 'footnote under the match-history sparkline',
  'replay.noSidecarNote': 'in-place note explaining missing position data',
  'reports.appendixHint': 'token-field hint under the appendix stats picker (type → chip; ✕/Backspace removes)',
  'settings.updateCheckHint': 'hint beside the update check (what it contacts / reports)',
  'settings.demoCopyHint': 'hint under the demo-copies setting (what keeping a copy buys)',
  'settings.importDirsNote': 'footnote under the import-dirs list (scan depth + copy semantics)',
  'settings.defaultsEffect': 'footnote naming the default import dirs',
  'settings.copyOnImportHint': 'hint under the copy-on-import switch (on/off consequences)',
  'settings.backgroundWorkNote': 'footnote under the parallel-work setting (what shares the budget)',
  'settings.parallelWorkHint': 'hint beside the parallel-work stepper (units, default, ceiling)',
  'settings.loopSecsHint': 'hint beside the loop-length stepper (range, default, which controls it drives)',
  'settings.cs2AssetsNote': 'footnote under CS2 assets (where they are read from)',
  'settings.extractHint': 'hint under the asset-extraction button (what it extracts)',
  'settings.themeHint': 'hint under the theme picker (default + persistence)',
  'settings.fontSizeHint': 'hint under the font-size picker (scale + persistence)',
  'settings.pluginsNoteTail': 'footnote tail for the plugin formats line',
  'settings.trustModelNote': 'footnote stating the trust model (no auto-update)',
  'settings.volAnnouncerHint': 'hint under the announcer-volume slider (which lines)',
  'settings.volFootstepsHint': 'hint under the footsteps-volume slider (default state)',
  'settings.soundEffectsNote': 'footnote under sound effects (provenance + playback)',
  'settings.voiceDecodeNote': 'footnote under voice decode (streaming behaviour)',
  'settings.tradeOppHint': 'hint beside the trade-opportunity distance field (what counts)',
};

// Tier-2 inline declarations — same contract as HINT_KEYS (why mandatory,
// prefix liveness asserted in Check D): a class-1 inline literal whose
// rendered role is a hint rather than a label. Matched by trimmed prefix so
// a reword of the body does not silently orphan the declaration.
const HINT_INLINE = [
  {
    file: 'frontend/src/lib/views/Builder.svelte',
    prefix: 'from <table>',
    why: 'the expression editor’s grammar hint under the expression field — a footnote over the expression grammar (tables and full rules live in the metric guide)',
  },
];

const TIER1_MAX = 70;
const TIER2_MAX = 200;

// ---------------------------------------------------------------------------
// Check E — input hints speak in actions (owner, 2026-11-15: "all input hints
// should be verb-like — 'Search players...' is good, while 'e.g. de_mirage'
// is bad").
//
// Scope = `placeholder=` attributes in markup: an INPUT HINT. An aria-label, a
// `title` tooltip and a select option are other media (label, tooltip,
// choice) and are deliberately not checked here.
//
// Rule: the first whitespace-separated word of the RESOLVED hint text must be
// a member of the closed VERB_ALLOWLIST below. FAIL-CLOSED — a first word
// nobody declared is a violation, never an implicit pass, so a new hint verb
// is a declared change (each entry carries its `why`).
//
// Exemptions are ONE dated HINT_* block below (never scattered whitelisting),
// each entry with a non-empty `why` AND a liveness contract (an entry whose
// site disappeared fails Check E's declaration assertions, like the
// PENDING_DENYLIST ledger):
//   • power surfaces — the SQL console's three placeholders go through
//     POWER_SURFACES (class 4, checked by the isPower() filter); the
//     expression editor's EXAMPLE sits in HINT_EXEMPT explicitly because
//     Builder is not itself a POWER_SURFACES file (AGENTS.md exempts "metric
//     expression text / Formula: content, the expression editor").
//   • endpoint markers — from / to / min / max / start / stop (HINT_NONVERB),
//     owner ruling: the placeholder IS the field's only visible per-field
//     label (a mini-label, not a hint) — the full name lives in the
//     aria-label or sr-only label (FilterBar, Replay's loop inputs).
//   • unresolvable expressions — HINT_PASSTHROUGH (the rendered text resolves
//     at another site, which is checked there).
//   • hint consts — HINT_SOURCES: text that renders as a hint without sitting
//     on a placeholder attribute of its own (SuggestInput's PLAYER_SEARCH_HINT,
//     the owner's own canonical example — 'Search players...').
//
// Orthogonal to Check D: this check never reads a length budget, and every
// length tier still applies to the reworded hints independently.
// ---------------------------------------------------------------------------

// Closed verb allowlist — first whitespace token only. Each entry declares WHY
// the verb belongs (mandatory, asserted in Check E-decls); unused-but-declared
// verbs are allowed (they are the vocabulary a future hint may reach for),
// stale EXEMPTIONS are not (they must match a live site).
const VERB_ALLOWLIST = {
  Search: 'the search idiom — the box finds rows the library already has (Search players…, Search metrics…, Search sections)',
  Filter: 'the facet idiom — narrows an already-listed set (Filter matches…, Filter by map...)',
  Type: 'free-text entry that is neither a path nor a value (Type a command or search…)',
  Enter: 'typed-value entry fields — paths, names and labels the user supplies (Enter a plugin path or manifest.json…)',
  Select: 'pickers asking for a choice among offered options (Select match… — MatchPicker’s own default hint)',
  Describe: 'prose fields whose content is user-authored explanation (Describe what this counts…)',
  Name: 'fields whose whole job is naming an entity (Name this saved query…)',
  Document: 'the metric Doc field, which points at the Formula: convention (Document the formula — …)',
};

// Exempt class 1 — endpoint markers (owner ruling, 2026-11-15). Keyed by the
// catalog key (the site's id); criterion repeated in every entry's why so no
// one can extend the class without restating it.
const HINT_NONVERB = {
  'common.filterBarFrom':
    'endpoint marker (ruling 2026-11-15) — the placeholder IS the round-from field’s only visible per-field label (mini-label); the full name is its aria-label "First round"',
  'common.filterBarTo':
    'endpoint marker (ruling 2026-11-15) — the placeholder IS the round-to field’s only visible per-field label (mini-label); the full name is its aria-label "Last round"',
  'common.filterBarMin':
    'endpoint marker (ruling 2026-11-15) — the placeholder IS the distance-min field’s only visible per-field label (mini-label); the full name is its aria-label "Minimum distance"',
  'common.filterBarMax':
    'endpoint marker (ruling 2026-11-15) — the placeholder IS the distance-max field’s only visible per-field label (mini-label); the full name is its aria-label "Maximum distance"',
  'replay.loopStartPlaceholder':
    'endpoint marker (ruling 2026-11-15) — the placeholder IS the loop-from field’s only visible per-field label (mini-label); the full name is its sr-only label "Loop start time"',
  'replay.loopStopPlaceholder':
    'endpoint marker (ruling 2026-11-15) — the placeholder IS the loop-to field’s only visible per-field label (mini-label); the full name is its sr-only label "Loop stop time"',
};

// Exempt class 2 — power surfaces that are NOT a POWER_SURFACES file: the
// expression editor's example script (AGENTS.md criterion bullet, "Exempt
// power surfaces"). Keyed `<rel file>#<site id>`.
const HINT_EXEMPT = {
  'frontend/src/lib/views/Builder.svelte#const:EXAMPLE':
    'the expression editor’s EXAMPLE script — power-surface content (metric expression text / the expression editor); Builder is outside POWER_SURFACES, so the exemption is declared here',
};

// Exempt class 3 — placeholder values that cannot be resolved statically; the
// text they render is checked at the site that owns it (the caller's own
// placeholder, or an HINT_SOURCES const below). Same `<rel file>#<site id>` key.
const HINT_PASSTHROUGH = {
  'frontend/src/lib/components/SuggestInput.svelte#expr:hint':
    'the $derived `hint` expression — resolves to the caller’s placeholder (checked at its own site) or to PLAYER_SEARCH_HINT (checked via HINT_SOURCES); no literal to classify here',
  'frontend/src/lib/components/TokenSelect.svelte#expr:placeholder':
    'the component’s placeholder prop — passes the caller’s own hint through to the input (resolved and verb-checked at the caller’s site, reports.metricHint = "Search stats…"); no literal to classify here',
};

// Not exemptions but declaration inputs: consts whose text renders as an input
// hint WITHOUT sitting on a placeholder attribute — they must still pass the
// verb rule (the owner’s canonical 'Search players...' lives here). Keyed by
// file; `name` is the same-file const the extractor resolves.
const HINT_SOURCES = {
  'frontend/src/lib/components/SuggestInput.svelte': {
    name: 'PLAYER_SEARCH_HINT',
    why: 'the owner’s canonical hint — rendered into placeholder={hint} by SuggestInput’s player kind without a placeholder attribute of its own',
  },
};

// ---------------------------------------------------------------------------
// The denylist — terms that are never the user's business (implementation
// language, browser chrome), with the reason attached (AGENTS.md criterion
// bullet, "Must NOT name" — each term's `why` below states its own reason).
// Case-sensitive unless noted.
// ---------------------------------------------------------------------------
const DENYLIST = [
  { term: 'Go stats', re: /Go stats/, why: 'fixed Go stats — the owner-reported violation class' },
  { term: 'fixed Go', re: /fixed Go/, why: 'developer shorthand' },
  { term: 'golang', re: /\bgolang\b/, why: 'a programming language is never the user’s business' },
  { term: 'seed(s)', re: /\bseeds?\b/, why: 'a seeding mechanism the user does not operate' },
  { term: 'binding(s)', re: /\bbindings?\b/, why: 'generated-code plumbing' },
  { term: 'sweep(s)', re: /\bsweeps?\b/, why: 'our migration waves, not the product' },
  { term: 'worktree(s)', re: /\bworktrees?\b/, why: 'git tooling' },
  { term: 'commit(s)', re: /\bcommits?\b/, why: 'git tooling (SQL keyword contexts are ledgered below)' },
  { term: 'stub(s)', re: /\bstubs?\b/, why: 'dev scaffolding' },
  { term: 'refactor', re: /\brefactor/i, why: 'dev-process verb' },
  { term: 'backfill', re: /\bbackfill/i, why: 'dev-process verb' },
  { term: 'migration(s)', re: /\bmigrations?\b/i, why: 'dev-process noun' },
  // Browser chrome (owner, 2026-11-14): "though this project leverages
  // web technology, it is not a web app, it is a desktop app" — the
  // guide's "address bar … copied link" line was the second sighting.
  { term: 'address bar', re: /address bar/i, why: 'browser chrome — Spectra is a desktop app, not a web app' },
];

// DB table names in prose. The table set is read from schema.sql DDL at test
// time (underscored names only — bare names like `rounds`/`clutches` are the
// user’s own vocabulary and are never denied). Applies to prose media only:
// svelte markup, JS modules, catalog values, content prose and the bound
// service layer’s error strings — never to SQL/expression code.
const TABLE_TERMS = (() => {
  const ddl = readFileSync(path.join(SRC, 'internal/store/schema.sql'), 'utf8');
  return [...new Set([...ddl.matchAll(/^CREATE TABLE(?: IF NOT EXISTS)? ([a-z_]+)/gm)]
    .map((m) => m[1]).filter((n) => n.includes('_')))];
})();

// Expression/SQL context exemption (AGENTS.md criterion bullet: table names
// are denied in prose only — "expressions exempt"). A literal that IS
// expression content — starts with `Formula:` or with the expression
// grammar’s `from <table>…` shape — is exempt as a whole; prose around a
// Formula: segment inside a longer sentence is not.
const EXPRESSION_CONTEXT = /^\s*(?:Formula:|from\s+[<&])/;

// Package prefixes on Go errors that surface through errText verbatim —
// implementation artifacts the user never asked for (AGENTS.md criterion
// bullet, "Must NOT name"). Contract since store-B (2026-11-15): checked
// over EVERY literal of EVERY non-test Go file — any file, any position —
// because the thin-delegate services pass these strings to errText
// unwrapped. The only carve-outs are structural: log call sites (never
// rendered; goScan) and PREFIX_EXEMPT's frozen mechanism tokens.
const PREFIX_RE = /^(store|metrics|query|dialogs|platform|analytics|plugin|library|report|sidecar): /;

// The service layer — top-level *service.go files plus dialogs.go. The
// prefix gate no longer uses it (store-B widened to every Go file); it
// defines the file set for TestServiceErrorsAreUserFacing, the zero-bypass
// pin that asserts service errors are user-facing copy by construction.
const SVC_FILE = /^[^/]*service\.go$|^dialogs\.go$/;

const SRC_EXT = new Set(['.js', '.svelte']);
const isPower = (rel) => POWER_SURFACES.has(rel) || POWER_PREFIXES.some((p) => rel.startsWith(p));
const isContent = (f) => CONTENT_FILES.some((c) => (c.endsWith('/') ? f.startsWith(c) : f === c));
const isTestFile = (name) => name.endsWith('.test.js');

// stripComments — quote-aware removal of /* … */ and // … tails. This is THE
// canonical stripper (webstorage.test.js:40); it is not exported there and
// importing that test file would register its suite inside this process, so
// the pattern is mirrored here — if webstorage ever exports it, import instead.
function stripComments(src) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out
    .split('\n')
    .map((line) => {
      let quote = null;
      for (let i = 0; i < line.length - 1; i++) {
        const c = line[i];
        if (quote) {
          if (c === quote && line[i - 1] !== '\\') quote = null;
          continue;
        }
        if (c === "'" || c === '"' || c === '`') {
          quote = c;
          continue;
        }
        if (c === '/' && line[i + 1] === '/') return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
  return out;
}

function walk(dir, accept, ignore = new Set(), out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (ignore.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, accept, ignore, out);
    else if (accept(e.name)) out.push(p);
  }
  return out;
}

const rel = (p) => path.relative(SRC, p).split(path.sep).join('/');

// --- denylist evaluation for one prose-context literal ---------------------
function denyHits(text, { expression = true } = {}) {
  if (expression && EXPRESSION_CONTEXT.test(text)) return [];
  const out = DENYLIST.filter((d) => d.re.test(text)).map((d) => `${d.term} (${d.why})`);
  for (const t of TABLE_TERMS) {
    if (new RegExp(`\\b${t}\\b`).test(text)) out.push(`table ${t} in prose`);
  }
  return out;
}

// Content prose (class 3): seed docs are scanned as prose units with the
// `Formula: <expr>` segment cut out (the expression itself is exempt —
// AGENTS.md criterion bullet, "expressions exempt"; the prose around it is
// not, e.g.
// "N is the player_stats rows…"). The segment runs to the em-dash that
// follows it (or the end of the doc).
const contentProse = (doc) => doc.replace(/Formula:[^—]*(?:—|$)/g, ' ');

// ---------------------------------------------------------------------------
// Medium 1 — svelte markup (skip <script>/<style>; class-1 literals only:
// user-facing attrs, text nodes, string literals in markup expressions).
// One shared extractor feeds both Check A (denylist) and Check B (ratchet).
// ---------------------------------------------------------------------------
const USER_ATTRS = new Set(['title', 'aria-label', 'placeholder', 'alt', 'label', 'heading', 'message', 'confirmLabel', 'cancelLabel']);
// SKIP_ATTRS — attribute values that are never free copy: styling/routing/
// wiring tokens. `transform` joined 2026-11-15 (S3-C2): its value is an
// SVG geometry token (`rotate(-90 14 14)`), the same criterion as the
// existing d/fill/stroke entries. Blast radius = the three ring-geometry
// sites in the tree (StatusChip ×1, PlayerCard ×2) — StatusChip's ONLY
// counted literal, which is what lets it drain to 0 with no extraction.
const SKIP_ATTRS = new Set(['class', 'style', 'href', 'src', 'd', 'viewBox', 'fill', 'stroke', 'id', 'role', 'tabindex', 'type', 'width', 'height', 'min', 'max', 'step', 'for', 'name', 'value', 'key', 'ref', 'target', 'rel', 'datetime', 'transform']);
const isCopy = (s) => /[A-Za-z]{3}/.test(s) && s.trim().length > 0;

function collectSvelte(file) {
  const ast = parse(readFileSync(file, 'utf8'));
  const lits = [];
  const seen = new Set();
  const visit = (n, ctx) => {
    if (!n || typeof n !== 'object' || seen.has(n)) return;
    if (Array.isArray(n)) {
      for (const c of n) visit(c, ctx);
      return;
    }
    if (typeof n.type === 'string') seen.add(n);
    if (n.type === 'Script' || n.type === 'Style') return; // markup only
    if (n.type === 'Attribute' && typeof n.name === 'string') {
      const nm = n.name;
      const raw = n.value;
      const vals = Array.isArray(raw) ? raw : raw ? [raw] : [];
      const literals = vals
        .filter((v) => v && ((v.type === 'Literal' && typeof v.value === 'string') || (v.type === 'Text' && typeof v.data === 'string')))
        .map((v) => (v.type === 'Text' ? { value: v.data } : v));
      const sub = { ...ctx, attr: nm, inAttr: true };
      if (USER_ATTRS.has(nm) || nm.endsWith('Label')) {
        for (const l of literals) if (isCopy(l.value) && !/^(true|false)$/.test(l.value)) lits.push({ attr: nm, text: l.value });
      } else if (!SKIP_ATTRS.has(nm) && !nm.startsWith('class') && !nm.startsWith('style') && !nm.startsWith('on')) {
        if (!/^(true|false|\d+)$/.test(literals.map((l) => l.value).join(''))) {
          for (const l of literals) if (isCopy(l.value)) lits.push({ attr: `?${nm}`, text: l.value });
        }
      }
      for (const k of Object.keys(n)) {
        if (k === 'type' || k === 'parent' || k === 'start' || k === 'end' || k === 'loc' || k === 'name') continue;
        if (n[k] && typeof n[k] === 'object') visit(n[k], sub);
      }
      return;
    }
    if (n.type === 'Text' && !ctx.inAttr && isCopy(n.data)) lits.push({ attr: '(text)', text: n.data });
    if (n.type === 'Literal' && typeof n.value === 'string' && isCopy(n.value)) {
      const a = ctx.attr;
      if (a && (a.startsWith('class') || a.startsWith('style') || a.startsWith('on'))) {
        // skip — not chrome copy
      } else if (/^[a-z][a-z0-9\-/._]*$/.test(n.value) || /^(codicon|rp-|mp-|pk-|pp-)/.test(n.value)) {
        // skip — codicon/class/route token
      } else {
        lits.push({ attr: a ? `(expr ${a})` : '(expr)', text: n.value });
      }
    }
    for (const k of Object.keys(n)) {
      if (k === 'type' || k === 'parent' || k === 'start' || k === 'end' || k === 'loc') continue;
      if (n[k] && typeof n[k] === 'object') visit(n[k], ctx);
    }
  };
  visit(ast, { attr: null, inAttr: false });
  return lits;
}

// ---------------------------------------------------------------------------
// Medium 2 — JS modules (comment-stripped; import/export specifiers skipped —
// ../../bindings/… paths are module wiring, not copy).
// ---------------------------------------------------------------------------
function jsLiterals(file) {
  let code = stripComments(readFileSync(file, 'utf8'));
  code = code
    .replace(/^[ \t]*import\b[\s\S]*?\sfrom\s*['"][^'"]*['"];?/gm, '')
    .replace(/^[ \t]*export\b[\s\S]*?\sfrom\s*['"][^'"]*['"];?/gm, '')
    .replace(/^[ \t]*import\s*['"][^'"]*['"];?/gm, '')
    .replace(/(?:^|[^\w$.])import\(\s*['"][^'"]*['"]\s*\)/g, '');
  const out = [];
  for (const m of code.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
    const v = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\$\{[^}]*\}/g, '');
    if (v) out.push(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Medium 3 — Go (non-test; comments and import declarations stripped;
// denylist over every literal; table-in-prose at error-construction
// positions; the package prefix over EVERY literal — store-B's ratchet:
// a layering prefix anywhere in non-test Go is error copy that reaches
// errText verbatim, so the position + service-file gate is gone).
// ---------------------------------------------------------------------------
function goScan(file) {
  let code = stripComments(readFileSync(file, 'utf8'));
  code = code
    .replace(/^[ \t]*import\s*\(([\s\S]*?)^[ \t]*\)/gm, '')
    .replace(/^[ \t]*import\s+(?:[\w.]+\s+)?"[^"]*"/gm, '')
    .replace(/^[ \t]*import\s+(?:[\w.]+\s+)?`[^`]*`/gm, '');
  // Log call sites — the first argument of log.*/slog.* — are developer
  // output (stderr / the log file only, never errText), so they sit OUTSIDE
  // the prefix rule. Criterion-based rather than a ledger entry: a new
  // prefixed log line is not user copy and must never need an exemption.
  // The denylist still scans them (it bans the words everywhere).
  const logRanges = [];
  for (const m of code.matchAll(/\b(?:log|slog)\.\w+\(\s*"((?:[^"\\\n]|\\.)*)"/g)) {
    logRanges.push([m.index, m.index + m[0].length]);
  }
  const inLog = (m) => logRanges.some(([a, b]) => m.index >= a && m.index + m[0].length <= b);
  const all = [];
  const allNoLogs = [];
  for (const m of code.matchAll(/"((?:[^"\\\n]|\\.)*)"|`([^`]*)`/g)) {
    const v = m[1] ?? m[2] ?? '';
    if (!v) continue;
    all.push(v);
    if (!inLog(m)) allNoLogs.push(v);
  }
  const errors = [];
  for (const m of code.matchAll(/\b(?:fmt\.Errorf|errors\.New)\(\s*"((?:[^"\\\n]|\\.)*)"/g)) errors.push(m[1]);
  // The two helper-label shapes — string literals that reach the user
  // WITHOUT passing through fmt.Errorf/errors.New at their own site
  // (see the dated note where they become candidates below).
  const labels = [];
  for (const m of code.matchAll(/\bconst\s+op\s*=\s*"((?:[^"\\\n]|\\.)*)"/g)) labels.push(m[1]);
  for (const m of code.matchAll(/\baffectedOrNotFound\([^,)]*,\s*"((?:[^"\\\n]|\\.)*)"/g)) labels.push(m[1]);
  return { all, allNoLogs, errors, labels };
}

// ---------------------------------------------------------------------------
// Medium 4 — seed `doc` column values from schema.sql's metrics INSERT
// (content: extracted for the sweep report, never failing).
// ---------------------------------------------------------------------------
function unquote(s) {
  const t = s.trim();
  return t.startsWith("'") && t.endsWith("'") ? t.slice(1, -1).replace(/''/g, "'") : t;
}
function splitTuples(body) {
  const rows = [];
  let depth = 0;
  let cur = '';
  let inStr = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inStr) {
      cur += c;
      if (c === "'") {
        if (body[i + 1] === "'") cur += body[++i];
        else inStr = false;
      }
      continue;
    }
    if (c === "'") {
      inStr = true;
      cur += c;
      continue;
    }
    if (c === '(') {
      if (depth === 0) cur = '';
      depth++;
      if (depth > 1) cur += c;
      continue;
    }
    if (c === ')') {
      depth--;
      if (depth === 0) rows.push(cur);
      else cur += c;
      continue;
    }
    if (depth > 0) cur += c;
  }
  return rows;
}
function splitFields(tuple) {
  const fields = [];
  let depth = 0;
  let cur = '';
  let inStr = false;
  for (let i = 0; i < tuple.length; i++) {
    const c = tuple[i];
    if (inStr) {
      cur += c;
      if (c === "'") {
        if (tuple[i + 1] === "'") cur += tuple[++i];
        else inStr = false;
      }
      continue;
    }
    if (c === "'") {
      inStr = true;
      cur += c;
      continue;
    }
    if (c === '(' || c === ')') {
      depth += c === '(' ? 1 : -1;
      if (depth > 0) cur += c;
      continue;
    }
    if (c === ',' && depth === 0) {
      fields.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  fields.push(cur);
  return fields;
}
function seedDocs() {
  const sql = readFileSync(path.join(SRC, 'internal/store/schema.sql'), 'utf8');
  const m = sql.match(/INSERT OR IGNORE INTO metrics \(([^)]*)\) VALUES([\s\S]*?);\n/);
  if (!m) return { rows: 0, docs: [] };
  const cols = m[1].split(',').map((s) => s.trim());
  const docIdx = cols.indexOf('doc');
  if (docIdx < 0) return { rows: 0, docs: [] };
  const docs = splitTuples(m[2]).map((tuple) => {
    const f = splitFields(tuple);
    return { name: unquote(f[0] ?? ''), doc: unquote(f[docIdx] ?? '') };
  });
  return { rows: docs.length, docs };
}

// ---------------------------------------------------------------------------
// The scans (run once — one shared extractor over every medium).
// ---------------------------------------------------------------------------
const svelteFiles = walk(FE, (n) => n.endsWith('.svelte')).sort();
const jsFiles = walk(FE, (n) => n.endsWith('.js') && !isTestFile(n)).sort();
const goFiles = walk(SRC, (n) => n.endsWith('.go') && !n.endsWith('_test.go'), new Set(['frontend', 'node_modules', 'bin'])).sort();

const svelteLits = new Map(); // rel file → [{attr,text}]
for (const f of svelteFiles) svelteLits.set(rel(f), collectSvelte(f));

// chains — the one member-chain reader: collects `S.<a>.<b>…` paths from any
// AST node/value (string paths without the leading `S`). Shared by Check D's
// `title=` derivation and Check E's `placeholder=` resolution — refactor out of
// titleHintKeyScan 2026-11-15 (verb-hints) so neither check owns a copy.
const chains = (n, out = [], seen = new Set()) => {
  if (!n || typeof n !== 'object' || seen.has(n)) return out;
  if (Array.isArray(n)) {
    for (const c of n) chains(c, out, seen);
    return out;
  }
  if (typeof n.type === 'string') seen.add(n);
  if (n.type === 'MemberExpression' || n.type === 'Identifier') {
    const parts = [];
    let cur = n;
    for (;;) {
      if (!cur || cur.type !== 'MemberExpression') {
        if (cur && cur.type === 'Identifier') parts.unshift(cur.name);
        break;
      }
      if (!cur.property || cur.property.type !== 'Identifier' || cur.computed) break;
      parts.unshift(cur.property.name);
      cur = cur.object;
    }
    if (parts[0] === 'S' && parts.length > 1) out.push(parts.slice(1).join('.'));
  }
  for (const k of Object.keys(n)) {
    if (k === 'type' || k === 'parent' || k === 'start' || k === 'end' || k === 'loc' || k === 'name') continue;
    if (n[k] && typeof n[k] === 'object') chains(n[k], out, seen);
  }
  return out;
};

// Check D inputs — which catalog keys are referenced from a `title=` attribute
// anywhere in the markup (a tooltip is a hint, owner 2026-11-15). Title
// position only — every other reference position stays tier 1 by default
// (unknown ⇒ tier 1, the default-tight rule).
function titleHintKeyScan() {
  const keys = new Set();
  for (const f of svelteFiles) {
    const ast = parse(readFileSync(f, 'utf8'));
    const seen = new Set();
    const visit = (n) => {
      if (!n || typeof n !== 'object' || seen.has(n)) return;
      if (Array.isArray(n)) {
        for (const c of n) visit(c);
        return;
      }
      if (typeof n.type === 'string') seen.add(n);
      if (n.type === 'Script' || n.type === 'Style') return; // markup only
      if (n.type === 'Attribute' && typeof n.name === 'string' && n.name === 'title') {
        for (const c of chains(n.value)) keys.add(c);
        return; // a title value is fully handled here
      }
      for (const k of Object.keys(n)) {
        if (k === 'type' || k === 'parent' || k === 'start' || k === 'end' || k === 'loc' || k === 'name') continue;
        if (n[k] && typeof n[k] === 'object') visit(n[k]);
      }
    };
    visit(ast);
  }
  return keys;
}
const titleHintKeys = titleHintKeyScan();

// candidates: pre-suppression denylist hits, keyed `file\0text`
const candidates = new Set();
const add = (file, text) => candidates.add(`${file}\u0000${text}`);
for (const [file, lits] of svelteLits) {
  if (isPower(file)) continue;
  for (const l of lits) if (denyHits(l.text).length) add(file, l.text);
}
for (const f of jsFiles) {
  const file = rel(f);
  if (isContent(file)) continue; // class 3 — content report below
  for (const text of jsLiterals(f)) if (denyHits(text).length) add(file, text);
}
for (const f of goFiles) {
  const file = rel(f);
  if (isPower(file)) continue;
  const { all, allNoLogs, errors, labels } = goScan(f);
  for (const text of all) if (DENYLIST.some((d) => d.re.test(text))) add(file, text);
  // The package-prefix rule over EVERY literal of EVERY non-test Go file
  // (store-B, 2026-11-15: the SVC_FILE-gated error-position path is gone —
  // thin-delegate services hand these strings to errText unwrapped, so any
  // layering prefix anywhere is user-facing copy). Log call sites are cut
  // in goScan (never rendered); PREFIX_EXEMPT below holds the tokens of the
  // one mechanism that still reads prefixes on purpose.
  for (const text of allNoLogs) if (PREFIX_RE.test(text)) add(file, text);
  // Table-in-prose stays exactly where it was: error-construction positions.
  for (const text of errors) {
    const tableHit = TABLE_TERMS.some((t) => new RegExp(`\\b${t}\\b`).test(text)) && !EXPRESSION_CONTEXT.test(text);
    if (tableHit) add(file, text);
  }
  // Two helper-label shapes, candidates under the SAME pipeline (prefix +
  // denylist → ledger/exempt → violations), 2026-11-15, store-A. Why they
  // need their own shapes: neither literal sits at a fmt.Errorf/errors.New
  // call site, so the position scan above never sees them — yet both reach
  // errText verbatim. (a) `const op = "…"` is rendered by
  // `fmt.Errorf("%s: %w", op, err)` (store's replaceMatchRows and friends),
  // so it appears as `<op>: <err>` in the Settings analysis-failure
  // tooltip; (b) the `affectedOrNotFound(res, "…")` label is rendered by
  // that helper's own `fmt.Errorf("%s: %w", op, err)`. Both are operation
  // labels a player reads on failure, so they carry the prefix rule.
  // store-B's all-literals scan above now subsumes them — the explicit
  // shapes stay as the named pin for exactly these two (no other helper is
  // scanned), so narrowing the general scan cannot silently unpin them.
  for (const text of labels) {
    if (PREFIX_RE.test(text) || DENYLIST.some((d) => d.re.test(text))) add(file, text);
  }
}

const pendingKeys = new Set(
  Object.entries(PENDING_DENYLIST).flatMap(([file, texts]) => texts.map((t) => `${file}\u0000${t}`)),
);
// Exemptions are consulted by Check A alongside the ledger: an exempt key is
// never a violation (its hit is deliberate, in a context the user never
// reads) and, like a ledger entry, must stay live — an exemption whose
// literal stopped matching is dead weight and fails Check A-ledger below.
const exemptKeys = new Set(
  [...Object.entries(DENYLIST_EXEMPT), ...Object.entries(PREFIX_EXEMPT)]
    .flatMap(([file, items]) => items.map((i) => `${file}\u0000${i.text}`)),
);
const violations = [...candidates]
  .filter((k) => !pendingKeys.has(k) && !exemptKeys.has(k))
  .map((k) => k.split('\u0000'));
const staleLedger = [...pendingKeys].filter((k) => !candidates.has(k)).map((k) => k.split('\u0000'));
const staleExempt = [...exemptKeys].filter((k) => !candidates.has(k)).map((k) => k.split('\u0000'));

// Check B inputs: which svelte files still carry class-1 literals
const inlineFiles = [...svelteLits].filter(([, lits]) => lits.length > 0).map(([file]) => file);
const importsCatalog = (file) => /strings\/index\.js/.test(readFileSync(path.join(SRC, file), 'utf8'));

// content inputs (class 3 — swept, reported, never failing)
const seed = seedDocs();
const contentHits = [];
for (const { name, doc } of seed.docs) {
  const h = denyHits(contentProse(doc), { expression: false });
  if (h.length) contentHits.push(`internal/store/schema.sql :: ${name} :: ${h.join('; ')}`);
}
for (const t of ['match.md', 'match.html', 'player.md', 'round.md']) {
  const p = path.join(SRC, 'internal/report/templates', t);
  if (!existsSync(p)) continue;
  const prose = readFileSync(p, 'utf8').replace(/\{\{[^}]*\}\}/g, '');
  const h = denyHits(prose, { expression: false });
  if (h.length) contentHits.push(`internal/report/templates/${t} :: ${h.join('; ')}`);
}
for (const text of jsLiterals(path.join(FE, 'lib/definitions.js'))) {
  const h = denyHits(text, { expression: false });
  if (h.length) contentHits.push(`frontend/src/lib/definitions.js :: ${h.slice(0, 4).join('; ')}`);
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

test('Check A — denylist over every app-rendered literal (svelte markup, JS, Go, + content enumerated)', () => {
  // Sanity: the walk must see the tree (webstorage.test.js:95 pattern — a
  // broken walk would pass vacuously).
  assert.ok(svelteFiles.length > 30, `walked only ${svelteFiles.length} svelte files — the scan is broken`);
  assert.ok(jsFiles.length > 40, `walked only ${jsFiles.length} js files — the scan is broken`);
  assert.ok(goFiles.length > 80, `walked only ${goFiles.length} go files — the scan is broken`);
  assert.ok(candidates.size > 0, 'candidate extraction found nothing — the scan is broken');
  assert.deepEqual(
    violations,
    [],
    'implementation language in user-facing text (criterion: AGENTS.md — user-facing text speaks the user\'s domain). ' +
      'User copy goes in lib/strings/<area>.js; existing hits are sweep scope and belong in PENDING_DENYLIST only if they predate this test:\n' +
      violations.map(([f, t]) => `  ${f} :: ${JSON.stringify(t.slice(0, 160))}`).join('\n'),
  );
});

test('Check A ledger — every PENDING_DENYLIST/DENYLIST_EXEMPT/PREFIX_EXEMPT entry is a live hit and justified (drop reworded entries)', () => {
  assert.deepEqual(
    staleLedger,
    [],
    'stale PENDING_DENYLIST entries — these literals no longer hit the denylist; remove them from the ledger:\n' +
      staleLedger.map(([f, t]) => `  ${f} :: ${JSON.stringify(t)}`).join('\n'),
  );
  assert.deepEqual(
    staleExempt,
    [],
    'stale DENYLIST_EXEMPT/PREFIX_EXEMPT entries — these literals no longer hit; remove them from the exemptions:\n' +
      staleExempt.map(([f, t]) => `  ${f} :: ${JSON.stringify(t)}`).join('\n'),
  );
  // Both exemption sets carry a mandatory `why` — an exemption nobody
  // justified is how a rule quietly rots.
  const noWhy = [...Object.entries(DENYLIST_EXEMPT), ...Object.entries(PREFIX_EXEMPT)]
    .flatMap(([file, items]) => items.filter((i) => !i.why || !i.why.trim()).map((i) => `${file} :: ${JSON.stringify(i.text)}`));
  assert.deepEqual(noWhy, [], `exemptions missing their mandatory why: ${noWhy.join(', ')}`);
});

test('Check A (content) — seed docs / templates / glossary prose are scanned for the sweep (non-blocking)', () => {
  // Class 3 never fails this test (content prose is reported, not
  // blocked); this enumerates the content scope and pins that extraction
  // keeps working.
  assert.ok(seed.rows >= 16, `extracted only ${seed.rows} seed-doc rows — the schema.sql extractor is broken`);
  console.log(`content hits (class-3 scope, ${contentHits.length}):\n  ${contentHits.join('\n  ')}`);
});

// Check B — the ratchet, UNCONDITIONAL since 2026-11-15 (Stage 3 closing):
// the class-1 inline ledger (PENDING_INLINE, seeded 2026-11-14) drained to
// empty with S3-C2, so its bypass is gone. Every non-power-surfaced Svelte
// file that still carries class-1 literals must import the catalog; power
// surfaces (class 4) stay exempt.
test('Check B — every inline-bearing Svelte file imports the catalog (unconditional)', () => {
  const violationsB = inlineFiles.filter((file) => !isPower(file) && !importsCatalog(file));
  console.log(`check B scope: ${inlineFiles.length} inline-bearing svelte file(s)`);
  assert.deepEqual(
    violationsB,
    [],
    'these files carry free chrome copy outside the catalog — move the copy into ' +
      'lib/strings/<area>.js and import it from strings/index.js:\n  ' +
      violationsB.join('\n  '),
  );
});

test('Check C — catalog hygiene: plain-string values, denylist-clean, barrel intact', async () => {
  const S = await import('./strings/index.js');
  const entries = Object.entries(S);
  const areas = entries.filter(([, v]) => v !== null && typeof v === 'object');
  const helpers = entries.filter(([, v]) => typeof v === 'function');
  // The barrel shape (AGENTS.md canonical table, "User-facing chrome copy"):
  // every area exported, fill() the one helper.
  assert.ok(areas.length >= 10, `only ${areas.length} area exports in strings/index.js — the barrel is incomplete`);
  assert.strictEqual(typeof S.fill, 'function', 'fill() must be exported from strings/index.js');
  assert.strictEqual(S.fill('a {x} b', { x: 1 }), 'a 1 b', 'fill() must substitute {arg} placeholders');
  assert.strictEqual(S.fill('keep {x}', {}), 'keep {x}', 'fill() must leave unknown placeholders intact');

  const leaves = [];
  const walkArea = (name, v, trail) => {
    if (typeof v === 'string') {
      leaves.push([trail, v]);
      return;
    }
    assert.ok(v !== null && typeof v === 'object', `catalog entry ${trail} must be a plain string (no functions, no concatenation — the audit test reads values as data)`);
    for (const [k, child] of Object.entries(v)) walkArea(name, child, `${trail}.${k}`);
  };
  for (const [name, area] of areas) walkArea(name, area, name);

  for (const [trail, value] of leaves) {
    assert.deepEqual(
      denyHits(value),
      [],
      `catalog value ${trail} violates the denylist: ${JSON.stringify(value)}`,
    );
  }

  // Duplicates are a warning for now — collapsing them is a later cleanup,
  // never a gate (the values themselves are already denylist-pinned above).
  const byValue = new Map();
  for (const [trail, value] of leaves) {
    if (!byValue.has(value)) byValue.set(value, []);
    byValue.get(value).push(trail);
  }
  for (const [value, trails] of byValue) {
    if (trails.length > 1) console.warn(`duplicate catalog value ${JSON.stringify(value)}: ${trails.join(', ')}`);
  }
});

// ---------------------------------------------------------------------------
// TestServiceErrorsAreUserFacing — added 2026-11-15, Stage 3 closing
// (HANDOFF's optional Stage-4 pin, adopted). A ZERO-BYPASS assertion for the
// service error layer: literals constructed at fmt.Errorf/errors.New
// positions in the service files must (a) carry no PREFIX_RE package prefix
// and (b) pass the DENYLIST — asserted directly against those files' scan
// results, WITHOUT consulting PENDING_DENYLIST or DENYLIST_EXEMPT. That is
// the point: Check A would forgive a service-error hit a ledger entry or an
// exemption could hide, but a service error surfaces through errText
// verbatim, so it may never be ledgered into visibility.
// ---------------------------------------------------------------------------
test('TestServiceErrorsAreUserFacing — service error literals: no package prefix, denylist-clean', () => {
  const svcFiles = goFiles.map(rel).filter((f) => SVC_FILE.test(f));
  // Sanity: the walk must see the service layer (a broken walk would pass
  // vacuously — webstorage.test.js:95 pattern).
  assert.ok(svcFiles.length >= 5, `walked only ${svcFiles.length} service files — the scan is broken`);
  const scans = svcFiles.map((file) => ({ file, errors: goScan(path.join(SRC, file)).errors }));
  const errTotal = scans.reduce((n, s) => n + s.errors.length, 0);
  assert.ok(errTotal > 0, 'the service scan extracted no error literals — goScan is broken');
  console.log(`service pin scope: ${svcFiles.length} files, ${errTotal} error literals`);
  const bad = [];
  for (const { file, errors } of scans) {
    for (const text of errors) {
      if (PREFIX_RE.test(text)) bad.push(`${file} :: package prefix :: ${JSON.stringify(text)}`);
      const hits = DENYLIST.filter((d) => d.re.test(text)).map((d) => d.term);
      if (hits.length) bad.push(`${file} :: denylist (${hits.join(', ')}) :: ${JSON.stringify(text)}`);
    }
  }
  assert.deepEqual(
    bad,
    [],
    'service errors are user-facing copy (they reach errText verbatim): no package prefix, no implementation ' +
      'language — reword at the construction site (AGENTS.md criterion bullet), never ledgered here:\n  ' +
      bad.join('\n  '),
  );
});

// ---------------------------------------------------------------------------
// Check D — length tiers (added 2026-11-15, the owner's three answers). The
// character-budget pin over every user-read medium: catalog values, inline
// class-1 literals, seed `doc` values, definitions.js strings and Go error
// format strings (the two helper-label shapes included — they reach errText
// like errors do). Classification is default-tight — see the dated block
// beside HINT_KEYS above; the media-level exemptions (guide prose, report
// templates, class-4 power surfaces, tests) hold by construction: none of
// those media are walked into the scope below (power surfaces are filtered
// per file, the rest are different files entirely).
// ---------------------------------------------------------------------------
test('Check D — length tiers: common copy ≤70, hints ≤200 (owner, 2026-11-15)', async () => {
  const S = await import('./strings/index.js');
  const leaves = [];
  const walkArea = (v, trail) => {
    if (typeof v === 'string') {
      leaves.push([trail, v]);
      return;
    }
    assert.ok(v !== null && typeof v === 'object', `catalog entry ${trail} must be a plain string`);
    for (const [k, child] of Object.entries(v)) walkArea(child, `${trail}.${k}`);
  };
  for (const [name, area] of Object.entries(S)) {
    if (area !== null && typeof area === 'object') walkArea(area, name);
  }
  const leafPaths = new Set(leaves.map(([t]) => t));

  // definitions.js as exported — the derived *_DEF constants measure with
  // their "Term — " prefix (that is exactly what the user hovers), glossary
  // bodies and chip titles as-is.
  const D = await import('./definitions.js');
  const defs = [];
  const collectDefs = (v) => {
    if (typeof v === 'string') {
      defs.push(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) collectDefs(x);
      return;
    }
    if (v !== null && typeof v === 'object') for (const x of Object.values(v)) collectDefs(x);
  };
  for (const v of Object.values(D)) if (typeof v !== 'function') collectDefs(v);

  const inline = [];
  for (const [file, lits] of svelteLits) {
    if (isPower(file)) continue;
    for (const l of lits) inline.push({ file, ...l });
  }

  const goErrs = [];
  for (const f of goFiles) {
    const file = rel(f);
    if (isPower(file)) continue;
    const { errors, labels } = goScan(f);
    for (const text of errors) goErrs.push({ file, text });
    for (const text of labels) goErrs.push({ file, text });
  }

  // Anti-vacuity — every medium must have been seen (webstorage.test.js:95
  // pattern: a broken walk would pass vacuously).
  assert.ok(leaves.length > 800, `extracted only ${leaves.length} catalog leaves — the scan is broken`);
  assert.ok(titleHintKeys.size > 100, `title derivation found only ${titleHintKeys.size} keys — the scan is broken`);
  assert.ok(inline.length > 100, `extracted only ${inline.length} inline literals — the scan is broken`);
  assert.ok(seed.docs.length >= 50, `extracted only ${seed.docs.length} seed docs — the schema.sql extractor is broken`);
  assert.ok(defs.length >= 20, `extracted only ${defs.length} definitions.js strings — the scan is broken`);
  assert.ok(goErrs.length > 400, `extracted only ${goErrs.length} Go error literals — the scan is broken`);

  // Declaration liveness — `why` mandatory, nothing stale (the ledger
  // contract the denylist exemptions already run).
  const stale = [];
  for (const [key, why] of Object.entries(HINT_KEYS)) {
    if (!why || !why.trim()) stale.push(`HINT_KEYS ${key} is missing its mandatory why`);
    if (!leafPaths.has(key)) stale.push(`HINT_KEYS ${key} is not a catalog key — drop the stale declaration`);
  }
  for (const e of HINT_INLINE) {
    if (!e.why || !e.why.trim()) stale.push(`HINT_INLINE ${JSON.stringify(e.prefix)} is missing its mandatory why`);
    const lits = svelteLits.get(e.file) ?? [];
    if (!lits.some((l) => l.text.trimStart().startsWith(e.prefix))) {
      stale.push(`HINT_INLINE ${e.file} :: ${JSON.stringify(e.prefix)} matches no inline literal — drop the stale declaration`);
    }
  }
  assert.deepEqual(stale, [], `stale or undescribed length-tier declarations:\n  ${stale.join('\n  ')}`);

  const bad = [];
  // Medium 1 — catalog values: tier 2 only via title= derivation or HINT_KEYS.
  for (const [trail, value] of leaves) {
    const max = titleHintKeys.has(trail) || Object.hasOwn(HINT_KEYS, trail) ? TIER2_MAX : TIER1_MAX;
    if (value.length > max) bad.push(`catalog :: ${trail} (${value.length} > ${max}) :: ${JSON.stringify(value)}`);
  }
  // Medium 2 — inline class-1 literals: title position or HINT_INLINE, else tier 1.
  for (const l of inline) {
    const atTitle = l.attr === 'title' || l.attr === '(expr title)';
    const declared = HINT_INLINE.some((e) => e.file === l.file && l.text.trimStart().startsWith(e.prefix));
    const max = atTitle || declared ? TIER2_MAX : TIER1_MAX;
    if (l.text.length > max) bad.push(`inline :: ${l.file} [${l.attr}] (${l.text.length} > ${max}) :: ${JSON.stringify(l.text)}`);
  }
  // Medium 3 — seed docs: tier 2 wholesale (measured whole, Formula included).
  for (const { name, doc } of seed.docs) {
    if (doc.length > TIER2_MAX) bad.push(`seed doc :: ${name} (${doc.length} > ${TIER2_MAX}) :: ${JSON.stringify(doc)}`);
  }
  // Medium 4 — definitions.js: tier 2 wholesale (glossary paragraphs, owner ruling 2).
  for (const text of defs) {
    if (text.length > TIER2_MAX) bad.push(`definitions.js (${text.length} > ${TIER2_MAX}) :: ${JSON.stringify(text)}`);
  }
  // Medium 5 — Go errors: tier 2 wholesale (error details, owner ruling 3).
  for (const { file, text } of goErrs) {
    if (text.length > TIER2_MAX) bad.push(`go error :: ${file} (${text.length} > ${TIER2_MAX}) :: ${JSON.stringify(text)}`);
  }

  console.log(
    `check D scope: ${leaves.length} catalog leaves (${leaves.filter(([t]) => titleHintKeys.has(t) || Object.hasOwn(HINT_KEYS, t)).length} tier-2), ` +
      `${inline.length} inline literals, ${seed.docs.length} seed docs, ${defs.length} definition strings, ` +
      `${goErrs.length} go error literals — ${bad.length} over budget`,
  );
  assert.deepEqual(
    bad,
    [],
    'user-facing text over its length tier (AGENTS.md length-tiers bullet; owner, 2026-11-15): tier 1 ≤70, ' +
      'tier 2 ≤200 — shorten without lying (detail that does not fit belongs in the user guide), or declare a ' +
      'genuine hint in HINT_KEYS/HINT_INLINE:\n  ' + bad.join('\n  '),
  );
});

// ---------------------------------------------------------------------------
// Check E — input hints are verb-like (owner, 2026-11-15). Extraction and
// classification; the rule statement and its declarations live in the dated
// block beside TIER2_MAX above.
//
// Extraction is its own `placeholder` attribute scan — deliberately NOT
// collectSvelte: that extractor skips <script> for markup-copy reasons and
// drops short hints behind isCopy (a `[A-Za-z]{3}` test would swallow 'min'
// and 'max'), while Check E must see EVERY placeholder attribute, inline and
// endpoint markers included. It DOES share the `chains()` member-chain reader
// with Check D's title= derivation (refactored out of titleHintKeyScan for
// exactly this — one chain reader, never two).
//
// Resolution ladder, per attribute value:
//   Text/Literal only        → inline text        (source 'inline')
//   single `{S.a.b}` chain   → the strings barrel (source 'catalog')
//   single `{NAME}`          → same-file `const NAME = '…'`, comments
//                              stripped           (source 'script')
//   anything else            → no text            (source 'unresolved');
//                              must be declared in HINT_PASSTHROUGH
// plus the HINT_SOURCES consts injected per file (source 'source').
// ---------------------------------------------------------------------------
const catalogValue = (root, dotted) =>
  dotted.split('.').reduce((o, k) => (o == null ? o : o[k]), root);

const exprId = (e) => {
  if (!e) return '?';
  if (e.type === 'Identifier') return e.name;
  if (e.type === 'CallExpression' && e.callee && e.callee.type === 'Identifier') return e.callee.name;
  return e.type;
};

function placeholderHintSites(S) {
  const sites = [];
  for (const f of svelteFiles) {
    const file = rel(f);
    const src = readFileSync(f, 'utf8');
    const ast = parse(src);
    // Same-file string consts, comments stripped — a commented-out copy can
    // never satisfy a lookup (webstorage stripComments contract).
    const consts = new Map();
    for (const m of stripComments(src).matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*'((?:[^'\\]|\\.)*)'/g)) {
      consts.set(m[1], m[2]);
    }
    const seen = new Set();
    const visit = (n) => {
      if (!n || typeof n !== 'object' || seen.has(n)) return;
      if (Array.isArray(n)) {
        for (const c of n) visit(c);
        return;
      }
      if (typeof n.type === 'string') seen.add(n);
      if (n.type === 'Script' || n.type === 'Style') return; // sites are markup attributes
      if (n.type === 'Attribute' && n.name === 'placeholder') {
        const vals = Array.isArray(n.value) ? n.value : [];
        const inline = vals
          .filter(
            (v) =>
              (v.type === 'Text' && typeof v.data === 'string') ||
              (v.type === 'Literal' && typeof v.value === 'string'),
          )
          .map((v) => (v.type === 'Text' ? v.data : v.value))
          .join('');
        // `{…}` value nodes: MustacheTag in Svelte 5's AST (Expression in
        // older shapes) — both carry `.expression`.
        const exprs = vals.filter((v) => v && v.expression);
        if (exprs.length === 0 && vals.length > 0) {
          sites.push({ file, id: `inline:${inline}`, text: inline, source: 'inline' });
        } else if (exprs.length === 1 && vals.length === 1) {
          const e = exprs[0].expression;
          // chains() yields every prefix too (`S.a.b` → 'a.b' and 'a'), so the
          // resolution target is the LONGEST chain in the value.
          const keys = chains(e);
          const key = keys.length
            ? keys.reduce((a, b) => (b.split('.').length > a.split('.').length ? b : a))
            : null;
          const text = key ? catalogValue(S, key) : undefined;
          if (typeof text === 'string') {
            sites.push({ file, id: key, text, source: 'catalog' });
          } else if (e.type === 'Identifier' && consts.has(e.name)) {
            sites.push({ file, id: `const:${e.name}`, text: consts.get(e.name), source: 'script' });
          } else {
            sites.push({ file, id: `expr:${exprId(e)}`, text: null, source: 'unresolved' });
          }
        } else {
          sites.push({ file, id: `attr:${inline}`, text: null, source: 'unresolved' });
        }
        return;
      }
      for (const k of Object.keys(n)) {
        if (k === 'type' || k === 'parent' || k === 'start' || k === 'end' || k === 'loc' || k === 'name') continue;
        if (n[k] && typeof n[k] === 'object') visit(n[k]);
      }
    };
    visit(ast);
    for (const [declFile, decl] of Object.entries(HINT_SOURCES)) {
      if (declFile !== file) continue;
      sites.push({
        file,
        id: `const:${decl.name}`,
        text: consts.has(decl.name) ? consts.get(decl.name) : null,
        source: 'source',
      });
    }
  }
  return sites;
}

test('Check E — input hints are verb-like: every placeholder’s first word is a declared verb (owner, 2026-11-15)', async () => {
  const S = await import('./strings/index.js');
  const sites = placeholderHintSites(S);
  // `sites` is 24 placeholder attributes + the injected HINT_SOURCES consts.
  const placeholderSites = sites.filter((s) => s.source !== 'source');
  const bySource = (src) => sites.filter((s) => s.source === src);
  const catalog = bySource('catalog');
  const inline = bySource('inline');
  const script = bySource('script');
  const sources = bySource('source');
  const resolved = sites.filter((s) => s.text);
  const distinctTexts = new Set(resolved.map((s) => s.text));
  // The rule's own scope: every resolved, non-power PLACEHOLDER site — power
  // surfaces are filtered by construction (class 4), and an unresolvable site
  // has no text to classify (it must be declared in HINT_PASSTHROUGH below).
  const classified = placeholderSites.filter((s) => s.text && !isPower(s.file));
  const declaredRefs = new Set(sites.map((s) => `${s.file}#${s.id}`));

  // Anti-vacuity floors — real numbers from the 2026-11-15 inventory (24
  // placeholder sites across 12 files; 17 resolve through the barrel, 5 are
  // inline, 1 is a same-file const, 1 cannot resolve, and 1 HINT_SOURCES
  // const renders a hint with no placeholder attribute of its own). A broken
  // walk or a silently-skipped medium drops under these instead of passing
  // green.
  assert.ok(placeholderSites.length >= 20, `extracted only ${placeholderSites.length} placeholder sites — the scan is broken`);
  assert.ok(distinctTexts.size >= 20, `only ${distinctTexts.size} distinct hint texts — the scan is broken`);
  assert.ok(catalog.length >= 15, `only ${catalog.length} barrel-resolved hints — the scan is broken`);
  assert.ok(inline.length >= 4, `only ${inline.length} inline hints — the scan is broken`);
  assert.ok(script.length >= 1, `only ${script.length} script-const hints — the scan is broken`);
  assert.ok(
    sources.length >= 1 && Object.keys(HINT_SOURCES).length >= 1,
    `only ${sources.length} HINT_SOURCES consts — the owner's canonical hint is unchecked`,
  );
  assert.ok(
    classified.length >= 15,
    `only ${classified.length} classified hints (resolved + non-power) — the rule's scope collapsed`,
  );
  assert.ok(
    Object.keys(VERB_ALLOWLIST).length >= 6,
    `only ${Object.keys(VERB_ALLOWLIST).length} verbs in VERB_ALLOWLIST — a fail-closed rule needs a real vocabulary`,
  );

  // Declaration hygiene: every verb and every exemption is justified, and no
  // exemption is stale (the PENDING_DENYLIST liveness contract: an entry whose
  // site disappeared must be deleted, never left to rot).
  const stale = [];
  const requireWhy = (what, why) => {
    if (!why || !why.trim()) stale.push(`${what} is missing its mandatory why`);
  };
  for (const [key, why] of Object.entries(VERB_ALLOWLIST)) requireWhy(`VERB_ALLOWLIST ${key}`, why);
  for (const [key, why] of Object.entries(HINT_NONVERB)) {
    requireWhy(`HINT_NONVERB ${key}`, why);
    if (!sites.some((s) => s.source === 'catalog' && s.id === key)) {
      stale.push(`HINT_NONVERB ${key} matches no live placeholder — drop the stale exemption`);
    }
  }
  for (const [ref, why] of Object.entries(HINT_EXEMPT)) {
    requireWhy(`HINT_EXEMPT ${ref}`, why);
    if (!declaredRefs.has(ref)) stale.push(`HINT_EXEMPT ${ref} matches no live site — drop the stale exemption`);
  }
  for (const [ref, why] of Object.entries(HINT_PASSTHROUGH)) {
    requireWhy(`HINT_PASSTHROUGH ${ref}`, why);
    if (!declaredRefs.has(ref)) stale.push(`HINT_PASSTHROUGH ${ref} matches no live site — drop the stale exemption`);
  }
  for (const [file, decl] of Object.entries(HINT_SOURCES)) {
    requireWhy(`HINT_SOURCES ${file}#${decl.name}`, decl.why);
    if (!declaredRefs.has(`${file}#const:${decl.name}`)) {
      stale.push(`HINT_SOURCES ${file}#${decl.name} matches no live site — drop the stale declaration`);
    }
  }
  assert.deepEqual(stale, [], `stale or undescribed input-hint declarations:\n  ${stale.join('\n  ')}`);

  // The rule — fail-closed: a first word that is not declared is a violation.
  const bad = [];
  const exempted = [];
  for (const s of sites) {
    const ref = `${s.file}#${s.id}`;
    if (isPower(s.file)) continue; // class 4 — the SQL console's own placeholders
    if (Object.hasOwn(HINT_PASSTHROUGH, ref)) continue;
    if (Object.hasOwn(HINT_EXEMPT, ref)) {
      exempted.push(ref);
      continue;
    }
    if (Object.hasOwn(HINT_NONVERB, s.id)) {
      exempted.push(ref);
      continue;
    }
    if (!s.text) {
      bad.push(`${ref} :: unresolvable placeholder text — resolve it, or declare it in HINT_PASSTHROUGH with its why`);
      continue;
    }
    const first = s.text.trim().split(/\s+/)[0];
    if (!Object.hasOwn(VERB_ALLOWLIST, first)) {
      bad.push(
        `${ref} :: ${JSON.stringify(s.text)} starts with ${JSON.stringify(first)} — not in VERB_ALLOWLIST ` +
          '(reword the hint, or declare the verb/exempt class with its why)',
      );
    }
  }

  console.log(
    `check E scope: ${placeholderSites.length} placeholder sites + ${sources.length} HINT_SOURCES ` +
      `(${catalog.length} catalog, ${inline.length} inline, ${script.length} script-const, ` +
      `${placeholderSites.filter((s) => !s.text).length} unresolved), ` +
      `${distinctTexts.size} distinct texts, ${classified.length} classified, ${exempted.length} exempt, ` +
      `${bad.length} not verb-like`,
  );
  assert.deepEqual(
    bad,
    [],
    'input hints must be verb-like (AGENTS.md input-hints bullet; owner, 2026-11-15): the first word of every ' +
      'placeholder is an imperative — "Search players…", never "e.g. de_mirage". Reword it in ' +
      'lib/strings/<area>.js (or inline), or declare the verb / exempt class in VERB_ALLOWLIST / ' +
      'HINT_NONVERB / HINT_EXEMPT / HINT_PASSTHROUGH with its why:\n  ' + bad.join('\n  '),
  );
});
