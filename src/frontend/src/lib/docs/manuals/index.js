// One import line per manual — the manuals self-register as a side
// effect (user-guide.js → registerDoc). A future manual is a new module
// under manuals/ plus one line here; renderer, TOC, popup and entry
// points need zero changes. Deliberately NOT import.meta.glob: plain
// `node` unit tests and the jsdom drivers import this tree without
// Vite, and a Vite-only mechanism would break them.
//
// (./metric-language.js is not a line of its own: its sections are
// composed INTO the user guide by user-guide.js — the guide's
// metric-language chapter is where they render.)
import './user-guide.js';
