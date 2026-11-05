// Hand-rolled hash router: deep-navigable URLs without a router
// dependency. parseHash is pure (hash string → route object) so the route
// table is unit-testable headlessly; App.svelte owns the hashchange
// wiring and the view switch.
//
//   #/library                default (also: "", "#", unknown hashes)
//   #/match/:id              the match view, Overview tab (the default)
//   #/match/:id/<tab-slug>   any match tab — slug = tab name lowercased
//                            (MATCH_TABS below is the canonical list;
//                            Match.svelte's tab bar consumes it too)
//   #/match/:id/round/:n     round numbers can be negative (knife /
//                            warmup rounds carry negative indices — see
//                            extract's renumber), so the round segment
//                            allows "-?"; ?back=<path> remembers the
//                            originating view for the return trip
//   #/player/:steamid        17-digit Steam id
//   #/compare/:id            ?rounds=3,5,7 selects the compared rounds,
//                            ?back=<path> the origin
//   #/replay/:id             the Replay landmark feed — its durable
//                            event-navigation context rides the query
//                            (parseLandmarkFilter in lib/replay/
//                            landmarks.js): cat/round/player/weapon/
//                            tick*/dmg*/dist/hs/bbox/gname plus tick
//                            (initial seek), sel (selected landmark) and
//                            back (origin path). The initial time target
//                            is resolved ONCE on entry by
//                            nav.entrySeekTick: ?tick= wins, else the
//                            ?round= scope resolves to that round's
//                            start tick, else the first frame.
//   #/explorer/:id           optional context id: the match Explorer's
//                            inspectors preselect (absent = newest match)
//   #/reports/:id            optional context id: Reports' match preselect
//   #/builder | #/sql | #/profiles | #/explorer | #/reports | #/settings
//
// Legacy raw-event routes resolve to the canonical Replay landmark feed
// with the equivalent scope (the Timeline tab, the Match Chat tab and the
// Context tab no longer exist as tabs):
//   #/match/:id/timeline           → #/replay/:id
//   #/match/:id/chat               → #/replay/:id?cat=chat
//   #/match/:id/context            → #/replay/:id?cat=chat,connects,convars,team_changes
//
// Prefix routes (builder/sql/profiles/explorer/reports/settings) match
// with startsWith, so "#/settings/foo" is still Settings; every other
// shape falls through to the library default.

// Canonical match-tab list (display order). Shared by Match.svelte's tab
// bar and the route table so a deep link can never drift from the tabs
// that exist: slug = tab.toLowerCase(). Raw/Timeline/Chat/Context are not
// tabs — their content lives in the Explorer view and Replay's landmark
// feed, and their legacy slugs redirect to #/replay/:id above instead of
// parsing as tabs. Details (the Explorer diagnostics) and Reports are
// tabs of the match view; their standalone #/explorer, #/reports routes
// still parse below unchanged.
export const MATCH_TABS = [
  'Overview',
  'Scoreboard',
  'Rounds',
  'Economy',
  'Utility',
  'Combat',
  'Heatmaps',
  'Reports',
  'Details',
];

// matchTabSlug is the URL segment for a tab; matchTabFromSlug is its
// inverse (null for anything that is not a tab).
export function matchTabSlug(tab) {
  return String(tab).toLowerCase();
}

export function matchTabFromSlug(slug) {
  return MATCH_TABS.find((t) => matchTabSlug(t) === slug) || null;
}

// buildHash renders a path + query object back into a hash string
// ("path?k=v"). Values are URL-encoded except "/" (the ?back= origin
// paths stay readable: back=match/5/rounds). Keys with undefined/null
// values are dropped (unset); an explicit "" survives — "?cat=" is the
// meaningful "no categories" state.
export function buildHash(path, query) {
  const parts = [];
  for (const [k, v] of Object.entries(query || {})) {
    if (v == null) continue;
    // Readable URLs: "/" (back= origin paths) and "," (cat lists) are
    // legal in query values and stay raw; everything else encodes.
    const val = encodeURIComponent(String(v)).replace(/%2F/g, '/').replace(/%2C/g, ',');
    parts.push(`${k}=${val}`);
  }
  return parts.length ? `${path}?${parts.join('&')}` : path;
}

export function parseHash(hash) {
  const raw = hash.replace(/^#/, '') || '/library';
  // Split "path?query": only the query-carrying routes attach a `query`
  // key (query-less hashes keep the exact shape their tests pin).
  const qi = raw.indexOf('?');
  const path = qi >= 0 ? raw.slice(0, qi) : raw;
  const query =
    qi >= 0 ? Object.fromEntries(new URLSearchParams(raw.slice(qi + 1))) : null;
  // Merges the parsed query onto the route (a route-supplied default,
  // e.g. the legacy chat/context redirects' cat, is overridden by real
  // query params); routes without params keep their exact shape.
  const withQuery = (route) => {
    if (!query || Object.keys(query).length === 0) return route;
    return { ...route, query: { ...(route.query || {}), ...query } };
  };

  // Round numbers can be negative (knife/warmup rounds carry negative
  // indices — see extract's renumber), so the round segment allows "-?".
  // Checked before the generic tab segment so "round" never reads as a
  // tab slug.
  let m = path.match(/^\/match\/(\d+)\/round\/(-?\d+)$/);
  if (m) return withQuery({ name: 'round', id: Number(m[1]), round: Number(m[2]) });

  // Legacy raw-event tabs → the canonical Replay landmark feed with the
  // equivalent scope (checked before the tab segment: they are not tabs).
  // A query on the legacy URL wins over the mapped default.
  m = path.match(/^\/match\/(\d+)\/timeline$/);
  if (m) return withQuery({ name: 'replay', id: Number(m[1]) });
  m = path.match(/^\/match\/(\d+)\/chat$/);
  if (m) return withQuery({ name: 'replay', id: Number(m[1]), query: { cat: 'chat', ...(query || {}) } });
  m = path.match(/^\/match\/(\d+)\/context$/);
  if (m)
    return withQuery({
      name: 'replay',
      id: Number(m[1]),
      query: { cat: 'chat,connects,convars,team_changes', ...(query || {}) },
    });

  // Any match tab: #/match/:id/<tab-slug>. An unknown segment (or a
  // non-tab such as "raw") is not a route — it falls through to the
  // library default, same as any other unmatched shape.
  m = path.match(/^\/match\/(\d+)\/([a-z]+)$/);
  if (m) {
    const tab = matchTabFromSlug(m[2]);
    if (tab) return withQuery({ name: 'match', id: Number(m[1]), tab });
  }
  m = path.match(/^\/match\/(\d+)$/);
  if (m) return withQuery({ name: 'match', id: Number(m[1]) });
  m = path.match(/^\/player\/(\d{17})$/);
  if (m) return withQuery({ name: 'player', steamId: m[1] });
  m = path.match(/^\/compare\/(\d+)$/);
  if (m) return withQuery({ name: 'compare', id: Number(m[1]) });
  m = path.match(/^\/replay\/(\d+)$/);
  if (m) return withQuery({ name: 'replay', id: Number(m[1]) });
  if (path.startsWith('/builder')) return withQuery({ name: 'builder' });
  if (path.startsWith('/sql')) return withQuery({ name: 'sql' });
  // The player directory (the sidebar's Profiles entry) — prefix route,
  // no params; a row click drills into /player/:steamid instead.
  if (path.startsWith('/profiles')) return withQuery({ name: 'profiles' });
  // Context ids are optional: absent → no id key (the view keeps its own
  // default), present → {id}. Prefix semantics stay startsWith.
  if (path.startsWith('/explorer')) {
    const ex = path.match(/^\/explorer\/(\d+)/);
    return withQuery(ex ? { name: 'explorer', id: Number(ex[1]) } : { name: 'explorer' });
  }
  if (path.startsWith('/reports')) {
    const rp = path.match(/^\/reports\/(\d+)/);
    return withQuery(rp ? { name: 'reports', id: Number(rp[1]) } : { name: 'reports' });
  }
  if (path.startsWith('/settings')) return withQuery({ name: 'settings' });
  return withQuery({ name: 'library' });
}
