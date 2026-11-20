# 04 · COMPONENTS — Svelte components, stored in the database, editable by duplication

**Status:** design, updated 2026-11-20. Locked decisions are marked
**Decided**. One item is still to be verified: the runtime import rewrite (§5),
which a spike must confirm before the component wave relies on it.

---

## 1. What a component is

A component is **Svelte 5 source**, the same language as the app's own views.
It has no grammar, no declared input contract, and no renderer registry. Builtin
and user components are both Svelte. **Decided.**

- **Builtin.** Shipped with the app as Svelte source in the frontend. These are
  the default Match view (the tab bar and everything below it), the Profile
  view, and the Reports sections. They are not editable in place.
- **User.** Stored in the database and created in the Component Builder. A user
  creates one by **duplicating a builtin** and editing the copy, or by writing
  one from scratch.

Builtins live in code so a changed builtin reaches every install without a
wipe. A user copy does not receive later upstream changes to its builtin. That
is accepted. **Decided.**

## 2. Storage

Two tables, both in the baseline `schema.sql`, which rides the wipe:

```sql
CREATE TABLE IF NOT EXISTS components (
    id         INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL UNIQUE,  -- what the user sees and what placements reference
    source     TEXT    NOT NULL,         -- Svelte 5 source, as written
    created_at TEXT    NOT NULL,
    updated_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS layout_placements (
    surface    TEXT    NOT NULL,         -- 'match-view', 'profile-view', 'reports-appendix', …
    position   INTEGER NOT NULL,         -- order within the surface
    component  TEXT    NOT NULL,         -- builtin id, or a components.name
    props      TEXT    NOT NULL DEFAULT '{}',  -- JSON; the component's own settings
    hidden     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (surface, position)
);
```

- **Absence means the builtin.** A surface with no placement rows renders its
  builtin. A surface with rows renders exactly those rows, in order. A user with
  stored placements does not pick up new builtin placements until they reset
  that surface. State this in the guide. **Decided.**
- **Use as my view.** For `match-view` and `profile-view`, "use as my view"
  writes one placement that points to the user's component. Reset deletes the
  surface's rows. **Decided.**
- A placement that references a missing component renders an error frame in its
  slot. It does not crash the surface.

**Prefs absorbed.** `metric_order_match`, `metric_order_profile`,
`metric_order_overview`, `metric_pins_overview`, `metric_economy`,
`metric_hidden_match`, `metric_hidden_profile` and
`scoreboard_starts_transposed` become placement rows and their `props`/`hidden`
fields. The two localStorage pin keys are retired. `loop_secs` stays a plain
pref. The exact per-key mapping is written in the wave that does it.

## 3. What a component can read

A component receives a small read API from the app. Nothing else.

- `metric(name, …)`: stored metric values with the five states. The signature
  follows the binds in `03-QUERIES.md` §5, so a component can ask for match, player, or round scope.
- `query(sql)`: a read-only SQL read, through the same read-only connection as
  the console, with no timeout and no row cap. Its tables are limited to the
  same allowlist as metrics (`03-QUERIES.md` §2). **Decided** (owner,
  2026-11-20).
- `navigate(route)`: the route query used everywhere else.
- Its own props.

**Freshness.** Metric reads are fresh-or-state. `query` reads are live and carry
no freshness; they never had any.

**Formatting belongs to components.** Percent, millisecond, and money formatting
live in the component that shows the value. The metric carries none. **Decided.**

**Bots.** The frontend bot filter (`players.js`: `isHuman` / `listedPlayers`) is
available as a helper. Components that display rosters should use it, and the
builtins do.

## 4. Error boundaries

Each mounted component is wrapped in a Svelte 5 `<svelte:boundary>` with a
`failed` snippet. A failure in render or effects shows a dismissible error in
that component's frame, and the rest of the surface keeps rendering.

**Known gap:** boundaries do not catch errors thrown from event handlers or
from async code the component started. The read API and the event-binding helper
catch those and route them to the same frame. Verify against the pinned Svelte
version (5.57.3).

Every error shown is dismissible in place (PRODUCT.md **Defaults**).

## 5. Runtime compilation (D-1, decided; spike pending)

**Decided approach:** user Svelte source is compiled in the webview, lazily, on
first use. The compiler is not loaded at launch. Compiled output is cached in
memory keyed by source hash. Only the source is stored.

**The mechanism to verify in a spike:**

1. Compile with `svelte/compiler` (client output, no dev overhead).
2. The compiled module imports Svelte's runtime by module path. In this app a
   blob or data URL cannot resolve bare module specifiers, so those imports are
   rewritten to the app's own Svelte runtime, which the app already holds.
3. Evaluate the rewritten module and mount the result inside the error boundary.
4. Confirm scoped `<style>` blocks still apply, and that `<svelte:boundary>`
   catches a render error from user code.

If the import rewrite fails, the fallback is compiling in the builder only and
storing the compiled JavaScript alongside the source, which couples stored
output to the Svelte version. The spike decides this, not the design.

No Content Security Policy is set in `index.html`, so runtime evaluation is not
blocked by policy. The Wails configuration was not checked for one.

**Save-time check.** At save, the source is compiled with `svelte/compiler`. A
compile error is refused with its line and message, and nothing is written.
Runtime errors are the error boundary's job.

## 6. The Component Builder

A new top-level tab, **Component Builder**, beside the Metric Builder and the
Reports Builder, in the same visual language.

- **Left:** source editor.
- **Right:** live preview, mounted in the same error boundary the app uses, with
  a chosen match or player as its context. Save is disabled while the source has
  a compile error.
- **Actions:** save, duplicate a builtin, delete a user component (refused while
  a placement references it, with the placements named).
- **Placement** is a separate action from authoring: "use as my view" on the
  surface, or add to a Reports section.

The builder ships with a guide section in the same wave.

## 7. Builtins and the dogfood scope (decided)

The shipped Match and Profile views are rebuilt as builtin Svelte components, so
duplication has something editable to start from.

**Match view:** everything from the tab bar down is one builtin component, tab
bar included. The header, warnings, and round strip stay hardcoded above it.
A user can duplicate it, delete a tab (for example Details), save, and then
"use as my match view."

**Profile view:** the individual player profile is one builtin component.
"Use as my profile view" applies per player profile.

**Not dogfooded:** the profiles list stays hardcoded. The header and the
navigation chrome stay hardcoded.

Each stat surface under the Match view and Profile view becomes a builtin
component that reads metrics through the read API. Round-grain values come from
round-grain metrics (`03-QUERIES.md` §9).

## 8. What is dropped from the 2026-11-18 design

- The component grammar, its definitions and instances, and its parser.
- Input contracts and save-time contract refusal.
- The renderer registry and its keys.
- Stale-reference placeholders with drop-never-migrate. Replaced by the error
  frame in §2.
- Controls as typed parameters. A control is an ordinary Svelte element; its
  state is view-local.
- The "views contain zero statistics logic" scan.
- The earlier proposal for JavaScript-only user components with a template
  helper. Rejected in favor of Svelte (D-1).
