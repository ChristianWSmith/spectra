// Replay keep-alive — the mini-player dock's pure navigation state.
//
// Leaving the replay route used to destroy Replay (App.svelte's view
// {#if} chain), so every return re-ran the whole load chain (replay meta
// + sidecar fetch/parse + engine rebuild) and lost the playhead. The
// keep-alive keeps ONE Replay component mounted while the route is
// `replay/:id` or a SAME-id match route (`match/:id`, its tab routes,
// `match/:id/round/:n`), collapsing it into a fixed bottom-right
// mini-player panel instead; any other route destroys the instance and
// the component's own cleanup runs exactly as before.
//
// Everything here is pure (prev state + route + hash → next state) so
// the scope rules and the resume rule are unit-testable:
//   node --test src/lib/keepalive.test.js   (from frontend/)
// App.svelte owns the instance record in $state and calls these — there
// is deliberately NO persistent store: sessionStorage / localStorage
// stay forbidden (AGENTS: component state + the route query are the
// only DURABLE nav state). The one sanctioned module-scoped view-state
// exception is the process-scoped registry (viewstate.svelte.js):
// non-navigation state only, for the life of the process — it never
// holds anything that is or should be a link, and this dock's record
// stays exactly where it belongs, in App.svelte's $state.

// nextReplayAlive — THE keep-alive transition (this function IS the
// scope predicate): given the previous instance record (null = none),
// the parsed current route and the raw location hash, returns the
// record to hold:
//   replay/:id          → { id, hash }: created fresh, or REFRESHED when
//                         an instance for that id already exists — the
//                         captured hash is the live replay hash (filter,
//                         scope, loop/sel entry params, back …; a ?
//                         tick= riding along is consumed by
//                         nav.expandReplayHash on expand — the playhead
//                         lives in the engine), updated on every
//                         replay-route navigation so the expand path
//                         always carries the latest state. Same id ⇒ App's {#key id} does NOT
//                         remount: a filter change (or the palette's
//                         same-id jump) keeps the running instance.
//   same-id match route → prev UNCHANGED: the instance survives and its
//                         hash stays FROZEN at leave-time (expanding
//                         later rewrites only ?back= — see
//                         nav.expandReplayHash).
//   anything else       → null: out of scope ⇒ destroy the instance.
export function nextReplayAlive(prev, route, hash) {
  if (!route) return null;
  if (route.name === 'replay') return { id: route.id, hash: String(hash ?? '') };
  if (prev && prev.id === route.id && (route.name === 'match' || route.name === 'round')) {
    return prev;
  }
  return null;
}

// shouldResumeOnReturn — THE resume rule of the dock (the same "never
// resume a user's pause" contract as roadmap/replay-playback.md's
// pausedByHover). Deactivating (leaving the replay route) records
// wasPlaying from these two facts:
//   engine not built yet → true: the initial load is still in flight
//     and a fresh entry AUTOPLAYS, so the load finishing — before OR
//     after the user returns — must land playing (startEngine never
//     autoplays while inactive; activation applies this flag);
//   engine playing       → true: paused on leave, resumed on return;
//   engine paused        → false: the user paused deliberately —
//     expanding must keep it paused.
export function shouldResumeOnReturn(engineExists, enginePlaying) {
  return !engineExists || enginePlaying === true;
}

// backOrigin — the current hash as a ?back= origin VALUE ("match/5/
// economy", "match/5/round/3?…"): location.hash minus the leading '#'
// and '/' (goBack/nav prepend the '/' again). Used when the dock
// expands: the replay's return trip (the Minimize cell — and Close,
// which exits before its teardown) must return to the tab the user was
// ACTUALLY on, not to the entry-time origin captured in ?back=.
export function backOrigin(hash) {
  return String(hash || '').replace(/^#\/?/, '');
}
