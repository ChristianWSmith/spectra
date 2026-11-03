// Hand-rolled hash router: deep-navigable URLs without a router
// dependency. parseHash is pure (hash string → route object) so the route
// table is unit-testable headlessly; App.svelte owns the hashchange
// wiring, the legacy canonicalize() rewrite and the view switch.
//
//   #/library                default (also: "", "#", unknown hashes)
//   #/match/:id
//   #/match/:id/timeline     the match view's Timeline tab (routeTab)
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
//   #/builder | #/sql | #/explorer | #/reports | #/settings
//
// Prefix routes (builder/sql/explorer/reports/settings) match with
// startsWith, so "#/settings/foo" is still Settings; every other shape
// falls through to the library default.

export function parseHash(hash) {
  const h = hash.replace(/^#/, '') || '/library';
  // Round numbers can be negative (knife/warmup rounds carry negative
  // indices — see extract's renumber), so the round segment allows "-?".
  let m = h.match(/^\/match\/(\d+)\/round\/(-?\d+)$/);
  if (m) return { name: 'round', id: Number(m[1]), round: Number(m[2]) };
  m = h.match(/^\/match\/(\d+)\/timeline$/);
  if (m) return { name: 'match', id: Number(m[1]), tab: 'Timeline' };
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
  if (h.startsWith('/explorer')) return { name: 'explorer' };
  if (h.startsWith('/reports')) return { name: 'reports' };
  if (h.startsWith('/settings')) return { name: 'settings' };
  return { name: 'library' };
}
