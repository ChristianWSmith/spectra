// viewstate.svelte.js — THE process-scoped view-state registry (the one
// sanctioned module-scoped view-state exception; AGENTS "Frontend
// helpers" + "Canonical homes").
//
// The ruling this implements (hybrid model, guardrails):
//   * view-local, NON-navigation state survives navigation for the life
//     of the process (tab switches, sidebar hops) and NOTHING else —
//   * NO persistence of any kind: never sessionStorage / localStorage
//     (webstorage.test.js scans src/ and fails on a new reference),
//     never restart durability. The URL stays the SOLE durable
//     navigation record: nothing that is or should be a link is ever
//     stored here, no query param is added for it, and seed() only ever
//     fills what the route/query leaves at its default (URL wins — the
//     registry never participates in URL-owned state such as Replay's
//     filter or Match's tab);
//   * transient state never restores: dialogs, modals, popovers,
//     busy/error/loading, toasts — views simply never pass them;
//   * arbitration is a PURE function (prev, route) → next — arbitrate()
//     below reads no registry and no globals (the keepalive.js
//     discipline, pinned in viewstate.test.js); match-scoped state can
//     never cross matches because matchKey() puts the match id IN the
//     key (state for match A is stored and read under match A's key
//     only);
//   * tests call resetViewState() — REQUIRED in jsdom driver setup:
//     drivers copy/import this module and the instance persists across
//     every mount/unmount in the file, so a pin that needs a fresh
//     mount must reset first or a prior section's state leaks into it
//     (the module header of each driver pin says so).
//
// Wiring pattern (see the wired views for both shapes):
//   flat view (Library, SqlConsole, Builder, Reports, Profiles,
//   PlayerProfile):      let x = $state(seed('sql', { sql: '' }).sql)
//                        $effect(() => remember('sql', { sql }));
//   match-scoped view (Match, Combat, Utility, Heatmaps): the key comes
//   from matchKey('combat', id), and because App's {#if} chain does NOT
//   remount a same-name route when the id changes, ONE combined effect
//   re-seeds whenever the key changes and writes through otherwise —
//   self-ordering (it applies the seed before any write can land, and a
//   write only happens when the key did NOT change), so no effect-order
//   assumption can poison the new key with the old match's state.
//
// Deliberately PLAIN JS despite the .svelte.js name: the registry holds
// no reactive state of its own (views copy what they need into their own
// $state), so `node --test` and the jsdom drivers import it raw — a rune
// in here would break every plain-node import. Vite's module-rune pass
// compiles it unchanged.

// The one registry: key → entry (a plain object of the view's recorded
// fields). Process-scoped by construction — no serialization, no storage
// handle, nothing outlives the module instance.
const registry = new Map();

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// sameKind — the per-field validity rule seed() applies: a stored value
// only replaces the default when it has the default's shape (typeof,
// with arrays pinned to arrays). Missing key, wrong type, a non-object
// where an object belongs → the default stands.
function sameKind(value, dflt) {
  if (Array.isArray(dflt)) return Array.isArray(value);
  if (isPlainObject(dflt)) return isPlainObject(value);
  if (dflt === null) return value === null || isPlainObject(value); // grid: null | object
  return typeof value === typeof dflt && value !== null;
}

// seed — THE registry read: the entry for `key` merged OVER `defaults`
// (whitelisted to the defaults' own keys, each value validated against
// its default's shape), or the defaults when the entry is absent/holds
// nothing usable. Always returns a FRESH object — the caller's $state
// owns it; mutating it never writes through (remember() does that).
export function seed(key, defaults) {
  const out = { ...defaults };
  const entry = registry.get(key);
  if (!isPlainObject(entry)) return out;
  for (const k of Object.keys(defaults)) {
    if (!Object.prototype.hasOwnProperty.call(entry, k)) continue;
    if (sameKind(entry[k], defaults[k])) out[k] = entry[k];
  }
  return out;
}

// remember — THE write-through: merge `partial` into the entry for
// `key` (creating it on first write). No validation here — seed() is
// the gate; keys outside a view's defaults never surface from seed().
export function remember(key, partial) {
  if (typeof key !== 'string' || !key || !isPlainObject(partial)) return;
  const prev = registry.get(key);
  registry.set(key, isPlainObject(prev) ? { ...prev, ...partial } : { ...partial });
}

// resetViewState — THE test hook (exported by construction, the
// replay/icons.js resetIconManifest() precedent): drops every entry so
// the next seed() lands on defaults. Called by every jsdom driver pin
// that needs a fresh mount, and by viewstate.test.js between cases.
export function resetViewState() {
  registry.clear();
}

// matchKey — THE one match-scoped key builder: the match id rides the
// key (`match:<id>:<view>`), so state recorded for match A can never be
// read back under match B's key — cross-match navigation restores
// defaults (or match B's own record), never foreign ids. Match-scoped
// views must derive their key through this helper, never a bare name.
export function matchKey(view, id) {
  return `match:${id}:${view}`;
}

// --- Navigation arbitration (pure — no registry, no globals) ----------

// scrollKey — the pure route → scroll-key derivation arbitrate() stands
// on: one key PER VIEW (the .content scroll position is view-level, so
// a match's tabs share `match:<id>` exactly like today's in-place tab
// swap — switching tabs never re-scrolls, returning to the view
// restores its own position). Query params never appear (they are not
// views), and a null/disabled route has no key.
function scrollKey(route) {
  switch (route.name) {
    case 'library':
      return 'library';
    case 'match':
      return `match:${route.id}`;
    case 'round':
      return `round:${route.id}`;
    case 'player':
      return `player:${route.steamId}`;
    case 'compare':
      return `compare:${route.id}`;
    case 'replay':
      return `replay:${route.id}`;
    case 'explorer':
      return `explorer:${route.id || 0}`;
    case 'reports':
      return `reports:${route.id || 0}`;
    case 'builder':
    case 'sql':
    case 'profiles':
    case 'settings':
      return route.name;
    default:
      return null;
  }
}

// arbitrate — THE pure arbitration rule: (prev, route) → next.
//   prev: the record App holds for the view being left — {key, top} as
//         returned by captureScroll (null at boot, before the first
//         navigation);
//   route: the incoming parsed route (the view about to render);
//   next: null — nothing to arbitrate (boot / no route / a route with
//         no scroll key): the caller leaves the container alone;
//         {key, keep:false} — a DIFFERENT view: the caller restores the
//         new key's stored top (scrollTopFor);
//         {key, keep:true} — the SAME view (query-only change, a match
//         tab hop, the replay overlay coming up over a preserved view):
//         the position carries untouched, exactly as today.
// Pure by construction: same inputs → same output, the registry is read
// only by the caller afterwards (pinned: viewstate.test.js).
export function arbitrate(prev, route) {
  if (!prev || !route) return null;
  const key = scrollKey(route);
  if (key === null) return null;
  return { key, keep: key === prev.key };
}

// captureScroll — the LEAVE-side registry I/O (not the arbiter): reads
// the container's scrollTop at navigation time — while the outgoing
// view is still rendered — records it under the route's scroll key and
// returns the record arbitrate() will arbitrate next time. A route with
// no scroll key yields key '' (never matches a real key), so the next
// view still restores from the registry instead of keeping a stale
// position.
export function captureScroll(route, top) {
  const key = route ? scrollKey(route) : null;
  const t = Number.isFinite(top) && top > 0 ? top : 0;
  if (key) remember(`scroll:${key}`, { top: t });
  return { key: key || '', top: t };
}

// scrollTopFor — the ENTER-side registry I/O: the stored top for an
// arbitrate() key, 0 when the view has never been scrolled (or the
// entry is missing/invalid — sameKind rejects a non-number).
export function scrollTopFor(key) {
  return seed(`scroll:${key}`, { top: 0 }).top;
}
