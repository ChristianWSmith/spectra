// Hand-rolled hash router: deep-navigable URLs without a router
// dependency. parseHash is pure (hash string → route object) so the route
// table is unit-testable headlessly; App.svelte owns the hashchange
// wiring, the legacy canonicalize() rewrite and the view switch.
//
//   #/library                default (also: "", "#", unknown hashes)
//   #/match/:id              the match view, Overview tab (the default)
//   #/match/:id/<tab-slug>   any match tab — slug = tab name lowercased
//                            (MATCH_TABS below is the canonical list;
//                            Match.svelte's tab bar consumes it too)
//   #/match/:id/round/:n     round numbers can be negative (knife /
//                            warmup rounds carry negative indices — see
//                            extract's renumber), so the round segment
//                            allows "-?"
//   #/player/:steamid        17-digit Steam id
//   #/compare/:id
//   #/timeline/:id           legacy — parses to the match view's Timeline
//                            tab with legacy: true (canonicalize() in
//                            App.svelte rewrites the address bar)
//   #/replay/:id
//   #/explorer/:id           optional context id: the match Explorer's
//                            inspectors preselect (absent = newest match)
//   #/reports/:id            optional context id: Reports' match preselect
//   #/builder | #/sql | #/explorer | #/reports | #/settings
//
// Prefix routes (builder/sql/explorer/reports/settings) match with
// startsWith, so "#/settings/foo" is still Settings; every other shape
// falls through to the library default.

// Canonical match-tab list (display order). Shared by Match.svelte's tab
// bar and the route table so a deep link can never drift from the tabs
// that exist: slug = tab.toLowerCase(). The Raw tab is gone (its
// inspectors live in the Explorer view — #/explorer/:id), so "#/match/:id/
// raw" parses to the library default like any unknown segment.
export const MATCH_TABS = [
  'Overview',
  'Scoreboard',
  'Rounds',
  'Economy',
  'Utility',
  'Heatmaps',
  'Combat',
  'Timeline',
  'Chat',
  'Context',
];

// matchTabSlug is the URL segment for a tab; matchTabFromSlug is its
// inverse (null for anything that is not a tab).
export function matchTabSlug(tab) {
  return String(tab).toLowerCase();
}

export function matchTabFromSlug(slug) {
  return MATCH_TABS.find((t) => matchTabSlug(t) === slug) || null;
}

export function parseHash(hash) {
  const h = hash.replace(/^#/, '') || '/library';
  // Round numbers can be negative (knife/warmup rounds carry negative
  // indices — see extract's renumber), so the round segment allows "-?".
  // Checked before the generic tab segment so "round" never reads as a
  // tab slug.
  let m = h.match(/^\/match\/(\d+)\/round\/(-?\d+)$/);
  if (m) return { name: 'round', id: Number(m[1]), round: Number(m[2]) };
  // Any match tab: #/match/:id/<tab-slug>. An unknown segment (or a
  // removed tab such as "raw") is not a route — it falls through to the
  // library default, same as any other unmatched shape.
  m = h.match(/^\/match\/(\d+)\/([a-z]+)$/);
  if (m) {
    const tab = matchTabFromSlug(m[2]);
    if (tab) return { name: 'match', id: Number(m[1]), tab };
  }
  m = h.match(/^\/match\/(\d+)$/);
  if (m) return { name: 'match', id: Number(m[1]) };
  m = h.match(/^\/player\/(\d{17})$/);
  if (m) return { name: 'player', steamId: m[1] };
  m = h.match(/^\/compare\/(\d+)$/);
  if (m) return { name: 'compare', id: Number(m[1]) };
  // Legacy deep link from before Timeline was a match tab — parse it
  // straight into the match view's Timeline tab (canonicalize() below
  // rewrites the address bar).
  m = h.match(/^\/timeline\/(\d+)$/);
  if (m) return { name: 'match', id: Number(m[1]), tab: 'Timeline', legacy: true };
  m = h.match(/^\/replay\/(\d+)$/);
  if (m) return { name: 'replay', id: Number(m[1]) };
  if (h.startsWith('/builder')) return { name: 'builder' };
  if (h.startsWith('/sql')) return { name: 'sql' };
  // Context ids are optional: absent → no id key (the view keeps its own
  // default), present → {id}. Prefix semantics stay startsWith.
  if (h.startsWith('/explorer')) {
    const ex = h.match(/^\/explorer\/(\d+)/);
    return ex ? { name: 'explorer', id: Number(ex[1]) } : { name: 'explorer' };
  }
  if (h.startsWith('/reports')) {
    const rp = h.match(/^\/reports\/(\d+)/);
    return rp ? { name: 'reports', id: Number(rp[1]) } : { name: 'reports' };
  }
  if (h.startsWith('/settings')) return { name: 'settings' };
  return { name: 'library' };
}
