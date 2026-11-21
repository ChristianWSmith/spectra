// The key a ComponentFrame provides to the frames nested inside it (the
// nested mount API, dogfood/04-COMPONENTS.md §3.5). Its value is
//   { reads, nav, depth, context: () => ctx }
// where `context` is a getter (the parent's context changes while it
// lives) and `depth` counts the frames above this one.
export const FRAME_KEY = Symbol('spectra.componentFrame');

// The deepest a component chain may nest. A component that mounts itself
// would otherwise recurse without end; the child at this depth shows a
// refusal in its own frame instead of mounting.
export const MAX_NEST_DEPTH = 8;

// frozenContext is the one read-only context a frame hands its component:
// the three fields always present (null when the surface sets none), and
// the object frozen so a component cannot write it.
export function frozenContext(c) {
  return Object.freeze({
    matchId: c && c.matchId != null ? c.matchId : null,
    steamId: c && c.steamId != null && c.steamId !== '' ? String(c.steamId) : null,
    round: c && c.round != null ? c.round : null,
  });
}
