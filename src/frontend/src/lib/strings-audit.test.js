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
// bullet, "Must NOT name"). Checked only at error-construction positions.
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
  // The two helper-label shapes — string literals that reach the user
  // WITHOUT passing through fmt.Errorf/errors.New at their own site
  // (see the dated note where they become candidates below).
  const labels = [];
  for (const m of code.matchAll(/\bconst\s+op\s*=\s*"((?:[^"\\\n]|\\.)*)"/g)) labels.push(m[1]);
  for (const m of code.matchAll(/\baffectedOrNotFound\([^,)]*,\s*"((?:[^"\\\n]|\\.)*)"/g)) labels.push(m[1]);
  return { all, errors, labels };
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
  const { all, errors, labels } = goScan(f);
  for (const text of all) if (DENYLIST.some((d) => d.re.test(text))) add(file, text);
  for (const text of errors) {
    const svc = SVC_FILE.test(file);
    const tableHit = TABLE_TERMS.some((t) => new RegExp(`\\b${t}\\b`).test(text)) && !EXPRESSION_CONTEXT.test(text);
    if (tableHit || (svc && PREFIX_RE.test(text))) add(file, text);
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
  // labels a player reads on failure, so they carry the same prefix rule
  // the service-file gate applies elsewhere — checked here WITHOUT the
  // SVC_FILE gate on purpose (these shapes live in internal/store, which
  // is not a *service.go file; widening PREFIX_RE's own gate is store-B's).
  // Scope is exactly these two shapes: no other helper is scanned.
  for (const text of labels) {
    if (PREFIX_RE.test(text) || DENYLIST.some((d) => d.re.test(text))) add(file, text);
  }
}

const pendingKeys = new Set(
  Object.entries(PENDING_DENYLIST).flatMap(([file, texts]) => texts.map((t) => `${file}\u0000${t}`)),
);
// Exemptions are consulted by Check A alongside the ledger: an exempt key is
// never a violation (its denylist hit is deliberate, in a context the user
// never reads) and, like a ledger entry, must stay live — an exemption whose
// literal stopped matching is dead weight and fails Check A-ledger below.
const exemptKeys = new Set(
  Object.entries(DENYLIST_EXEMPT).flatMap(([file, items]) => items.map((i) => `${file}\u0000${i.text}`)),
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

test('Check A ledger — every PENDING_DENYLIST/DENYLIST_EXEMPT entry is a live hit (drop reworded entries)', () => {
  assert.deepEqual(
    staleLedger,
    [],
    'stale PENDING_DENYLIST entries — these literals no longer hit the denylist; remove them from the ledger:\n' +
      staleLedger.map(([f, t]) => `  ${f} :: ${JSON.stringify(t)}`).join('\n'),
  );
  assert.deepEqual(
    staleExempt,
    [],
    'stale DENYLIST_EXEMPT entries — these literals no longer hit the denylist; remove them from the exemptions:\n' +
      staleExempt.map(([f, t]) => `  ${f} :: ${JSON.stringify(t)}`).join('\n'),
  );
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
