// strings-audit.test.js — the mechanical pin for the queued principle
// "User-facing text is for end users, not for developers"
// (queue-user-text-philosophy.md; design: /tmp/opencode/strings-centralization.md
// §4). It scans every app-rendered string medium and fails on implementation
// language, with the criterion's exemptions in ONE block below
// (the webstorage.test.js:1-40 pattern: rule → failing test, comment-stripped
// scan, exemptions in one const).
//
// The criterion partitions user-facing text into four classes (design §3.1):
//   class 1 — free chrome copy (markup text/attrs)  → catalog or PENDING_INLINE
//   class 2 — domain-keyed table values             → stay with their table; scanned
//   class 3 — content prose (glossary/seed docs/templates/docs manual)
//                                                    → CONTENT_FILES; scanned, sweep scope
//   class 4 — power surfaces (SQL console, cs2find) → POWER_SURFACES; exempt
// Check A (denylist over all five media) fails NEW violations anywhere;
// pre-existing ones sit in the dated PENDING_DENYLIST ledger and are removed
// as the sweep rewords them (a stale entry fails too — the ledger is a
// contract, webstorage's PREF_SITES liveness pin pattern).
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
// files are scanned (content-shaped, for the sweep) but never fail; the two
// ledgers are the migration ratchet (they only ever shrink).
// ---------------------------------------------------------------------------

// class 4 — deliberate developer-facing surfaces, exempt by construction
// (queue-user-text-philosophy.md:38-41).
const POWER_SURFACES = new Set([
  'frontend/src/lib/views/SqlConsole.svelte', // the SQL console (named product feature)
  'internal/metrics/doc.go', // the expression grammar reference
  'internal/mappack/devtool.go', // cs2find internals — a developer CLI
]);
const POWER_PREFIXES = [
  'cmd/cs2find/', // cs2find help text (design §3.3: a developer tool)
];

// class 3 — long-form prose with its own content model. Scanned (the sweep
// enumerates them via the content test below) but their rewording is Sweep-A's
// job (design §5.2), so they never fail this test. `lib/docs/` covers the
// docs manual as it lands (it does not exist yet — directory prefix, because
// content modules arrive with their waves).
const CONTENT_FILES = [
  'frontend/src/lib/definitions.js', // glossary (AGENTS canonical home)
  'frontend/src/lib/docs/', // the upcoming docs manual (content model)
  'internal/store/schema.sql', // seed `doc` column (metrics tooltips)
  'internal/report/templates/match.md',
  'internal/report/templates/match.html',
  'internal/report/templates/player.md',
  'internal/report/templates/round.md',
];

// class 1 ratchet — files whose inline chrome copy predates the catalog.
// Seeded 2026-11-14 with every .svelte file that carries class-1 literals
// today; shrinks to zero as Sweep-B extracts each file into lib/strings/,
// after which Check B is unconditional (design §5.2 Stage 3 gate).
const PENDING_INLINE = new Set([
  'frontend/src/App.svelte',
  'frontend/src/lib/components/CommandPalette.svelte',
  'frontend/src/lib/components/ConfirmDialog.svelte',
  'frontend/src/lib/components/EconCurve.svelte',
  'frontend/src/lib/components/EventFlags.svelte',
  'frontend/src/lib/components/FilterBar.svelte',
  'frontend/src/lib/components/HeatmapLayer.svelte',
  'frontend/src/lib/components/LandmarkRow.svelte',
  'frontend/src/lib/components/MapPackPrompt.svelte',
  'frontend/src/lib/components/MatchPicker.svelte',
  'frontend/src/lib/components/MetricOrderDialog.svelte',
  'frontend/src/lib/components/PayloadTree.svelte',
  'frontend/src/lib/components/PlayerCard.svelte',
  'frontend/src/lib/components/PlayerPicker.svelte',
  'frontend/src/lib/components/RoundStrip.svelte',
  'frontend/src/lib/components/SortTh.svelte',
  'frontend/src/lib/components/StatusChip.svelte',
  'frontend/src/lib/components/SuggestInput.svelte',
  'frontend/src/lib/components/TeamColumn.svelte',
  'frontend/src/lib/views/Combat.svelte',
  'frontend/src/lib/views/CompareRounds.svelte',
  'frontend/src/lib/views/Economy.svelte',
  'frontend/src/lib/views/Explorer.svelte',
  'frontend/src/lib/views/Heatmaps.svelte',
  'frontend/src/lib/views/Library.svelte',
  'frontend/src/lib/views/PlayerProfile.svelte',
  'frontend/src/lib/views/Profiles.svelte',
  'frontend/src/lib/views/Reports.svelte',
  'frontend/src/lib/views/Utility.svelte',
]);

// Check A ledger — pre-existing denylist hits, keyed file → exact literal
// text. 2026-11-14 seed (35 entries): the bound-service package prefixes
// (34 of 42 service-layer literals per design §1.4; reworded by Stage 4 /
// Sweep-A), the three dev-speak error literals the design's Go scan found
// (seed.go / schema.go / analytics.go), five propagated store errors whose
// text names a table (they surface through MatchService raw), the SQL
// keyword table of the read-only console validator, and the demoinfocs
// parser-version constant recorded as provenance. NEW strings matching the
// denylist fail anywhere; an entry that stops matching must be deleted here.
const PENDING_DENYLIST = {
  'analyticservice.go': [
    'analytics: unknown heatmap kind %q',
    'analytics: heatmap presence: %w',
  ],
  'dialogs.go': [
    'dialogs: serve %q: not an absolute URL path',
    'dialogs: save file: %w',
    'dialogs: write file: empty path',
    'dialogs: write file %s: %w',
    'dialogs: save export: no exporter wired',
    'dialogs: save export %s: %w',
    'dialogs: save export %s: unexpected status %d',
    'dialogs: save export: %w',
    'dialogs: choose directory: %w',
  ],
  'metricservice.go': [
    'metrics: %s (at byte %d)',
    'metrics: metric id is required',
    'metrics: no metric with id %d',
    "metrics: metric '%s' is match-scoped and cannot be used inside a profile-scoped metric (a career value cannot read a per-match value)",
    'metrics: cyclic metric reference: %s',
    'metrics: metric name is required',
    'metrics: unknown format %q (valid: int, float1, float2, percent, currency)',
    'metrics: unknown scope %q (valid: match, profile)',
    "metrics: built-in metrics can't be edited",
    'metrics: a metric named %q already exists',
    "metrics: built-in metrics can't be deleted",
    'metrics: cannot delete metric %q: referenced by %s — edit or delete those first',
  ],
  'platformservice.go': [
    'platform: spatial series: %w',
    'platform: list plugin templates: %w',
    'platform: template %q has unknown scope %q',
  ],
  'queryservice.go': [
    'query: query name is required',
    'query: query description is required',
    'query: SQL is required',
    'query: no saved query with id %d',
  ],
  'internal/extract/extract.go': ['demoinfocs-golang/v6@v6.0.0-rc.1'],
  'internal/metrics/seed.go': ['metrics: load seed: %w'],
  'internal/store/analytics.go': [
    'store: seed analysis_config: %w',
    'store: get analysis_config: %w',
    'store: set analysis_config: %w',
  ],
  'internal/store/lifecycle.go': [
    'store: save extracted: player_stats: %w',
    'store: save extracted: round_player_sides: %w',
    'store: save extracted: round_economy: %w',
    'store: save extracted: generic_events: %w',
    'store: save extracted: sound_events: %w',
  ],
  'internal/store/query_store.go': ['commit'],
  'internal/store/schema.go': ['store: commit schema: %w'],
};

// ---------------------------------------------------------------------------
// The denylist — terms that are never the user's business (implementation
// language, browser chrome), with the reason attached
// (queue-user-text-philosophy.md:33-36). Case-sensitive unless noted.
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

// Expression/SQL context exemption (design §4.1: table names are denied
// "only outside Formula:/expression/SQL contexts"). A literal that IS
// expression content — starts with `Formula:` or with the expression
// grammar’s `from <table>…` shape — is exempt as a whole; prose around a
// Formula: segment inside a longer sentence is not.
const EXPRESSION_CONTEXT = /^\s*(?:Formula:|from\s+[<&])/;

// Package prefixes on Go errors that surface through errText verbatim
// (design §4.1). Checked only at error-construction positions.
const PREFIX_RE = /^(store|metrics|query|dialogs|platform|analytics|plugin|library): /;

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
// queue-user-text-philosophy.md:47-49; the prose around it is not, e.g.
// "N is the player_stats rows…"). The segment runs to the em-dash that
// follows it (or the end of the doc).
const contentProse = (doc) => doc.replace(/Formula:[^—]*(?:—|$)/g, ' ');

// ---------------------------------------------------------------------------
// Medium 1 — svelte markup (skip <script>/<style>; class-1 literals only:
// user-facing attrs, text nodes, string literals in markup expressions).
// One shared extractor feeds both Check A (denylist) and Check B (ratchet).
// ---------------------------------------------------------------------------
const USER_ATTRS = new Set(['title', 'aria-label', 'placeholder', 'alt', 'label', 'heading', 'message', 'confirmLabel', 'cancelLabel']);
const SKIP_ATTRS = new Set(['class', 'style', 'href', 'src', 'd', 'viewBox', 'fill', 'stroke', 'id', 'role', 'tabindex', 'type', 'width', 'height', 'min', 'max', 'step', 'for', 'name', 'value', 'key', 'ref', 'target', 'rel', 'datetime']);
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
// denylist over every literal, table-in-prose + package prefix additionally
// at error-construction positions).
// ---------------------------------------------------------------------------
const SVC_FILE = /^[^/]*service\.go$|^dialogs\.go$/;
function goScan(file) {
  let code = stripComments(readFileSync(file, 'utf8'));
  code = code
    .replace(/^[ \t]*import\s*\(([\s\S]*?)^[ \t]*\)/gm, '')
    .replace(/^[ \t]*import\s+(?:[\w.]+\s+)?"[^"]*"/gm, '')
    .replace(/^[ \t]*import\s+(?:[\w.]+\s+)?`[^`]*`/gm, '');
  const all = [];
  for (const m of code.matchAll(/"((?:[^"\\\n]|\\.)*)"|`([^`]*)`/g)) all.push(m[1] ?? m[2] ?? '');
  const errors = [];
  for (const m of code.matchAll(/\b(?:fmt\.Errorf|errors\.New)\(\s*"((?:[^"\\\n]|\\.)*)"/g)) errors.push(m[1]);
  return { all, errors };
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
  const { all, errors } = goScan(f);
  for (const text of all) if (DENYLIST.some((d) => d.re.test(text))) add(file, text);
  for (const text of errors) {
    const svc = SVC_FILE.test(file);
    const tableHit = TABLE_TERMS.some((t) => new RegExp(`\\b${t}\\b`).test(text)) && !EXPRESSION_CONTEXT.test(text);
    if (tableHit || (svc && PREFIX_RE.test(text))) add(file, text);
  }
}

const pendingKeys = new Set(
  Object.entries(PENDING_DENYLIST).flatMap(([file, texts]) => texts.map((t) => `${file}\u0000${t}`)),
);
const violations = [...candidates].filter((k) => !pendingKeys.has(k)).map((k) => k.split('\u0000'));
const staleLedger = [...pendingKeys].filter((k) => !candidates.has(k)).map((k) => k.split('\u0000'));

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
    'implementation language in user-facing text (criterion: queue-user-text-philosophy.md). ' +
      'User copy goes in lib/strings/<area>.js; existing hits are sweep scope and belong in PENDING_DENYLIST only if they predate this test:\n' +
      violations.map(([f, t]) => `  ${f} :: ${JSON.stringify(t.slice(0, 160))}`).join('\n'),
  );
});

test('Check A ledger — every PENDING_DENYLIST entry is a live hit (drop reworded entries)', () => {
  assert.deepEqual(
    staleLedger,
    [],
    'stale PENDING_DENYLIST entries — these literals no longer hit the denylist; remove them from the ledger:\n' +
      staleLedger.map(([f, t]) => `  ${f} :: ${JSON.stringify(t)}`).join('\n'),
  );
});

test('Check A (content) — seed docs / templates / glossary prose are scanned for the sweep (non-blocking)', () => {
  // Class 3 never fails this test (Sweep-A rewords it); this enumerates the
  // sweep's scope and pins that extraction keeps working.
  assert.ok(seed.rows >= 16, `extracted only ${seed.rows} seed-doc rows — the schema.sql extractor is broken`);
  console.log(`content hits (Sweep-A scope, ${contentHits.length}):\n  ${contentHits.join('\n  ')}`);
});

test('Check B — inline chrome copy is catalog-referenced or in PENDING_INLINE (the ratchet)', () => {
  const violationsB = inlineFiles.filter(
    (file) => !isPower(file) && !PENDING_INLINE.has(file) && !importsCatalog(file),
  );
  assert.deepEqual(
    violationsB,
    [],
    'these files carry free chrome copy outside the catalog — route new copy through lib/strings/index.js ' +
      'or, for pre-migration files, seed PENDING_INLINE with a dated entry:\n  ' +
      violationsB.join('\n  '),
  );
  // Ledger liveness: a file with no class-1 literals left must leave the
  // ledger (the drain is the gate; an undrained ledger forgets the rule).
  const staleFiles = [...PENDING_INLINE].filter(
    (file) => !svelteLits.has(file) || svelteLits.get(file).length === 0,
  );
  assert.deepEqual(staleFiles, [], `no longer inline-bearing — drop from PENDING_INLINE: ${staleFiles.join(', ')}`);
});

test('Check C — catalog hygiene: plain-string values, denylist-clean, barrel intact', async () => {
  const S = await import('./strings/index.js');
  const entries = Object.entries(S);
  const areas = entries.filter(([, v]) => v !== null && typeof v === 'object');
  const helpers = entries.filter(([, v]) => typeof v === 'function');
  // The barrel shape (design §3.2): every area exported, fill() the one helper.
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
    assert.ok(v !== null && typeof v === 'object', `catalog entry ${trail} must be a plain string (design §3.2: no functions, no concatenation)`);
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

  // Duplicates are a warning for now — collapsing them is Sweep-B's job.
  const byValue = new Map();
  for (const [trail, value] of leaves) {
    if (!byValue.has(value)) byValue.set(value, []);
    byValue.get(value).push(trail);
  }
  for (const [value, trails] of byValue) {
    if (trails.length > 1) console.warn(`duplicate catalog value ${JSON.stringify(value)}: ${trails.join(', ')}`);
  }
});
