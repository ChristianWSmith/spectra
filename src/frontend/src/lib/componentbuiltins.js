// The builtin component registry: every component shipped with the app,
// as Svelte source the user can duplicate (dogfood/04-COMPONENTS.md §1).
// Builtins are not editable in place; the Component builder loads them
// read-only and "Duplicate" saves a user copy of `source`.
//
// Ids live in a reserved namespace: every id starts with BUILTIN_PREFIX
// (the Go twin is componentservice.go BuiltinComponentPrefix, which
// refuses that prefix on a user component name), so a placement's
// component reference is a builtin id or a user name, never both.
// componentbuiltins.test.js pins the prefix and that every source passes
// the save-time check.
//
// PLACEHOLDER: the shipped Match and Profile views are rebuilt as builtin
// components in a later change. Until then the registry holds one
// placeholder builtin (`placeholder: true`, shown with a placeholder chip)
// so duplication has something to start from. It is mounted from its
// source like a user component; the rebuilt builtins will be app source
// compiled by the bundler, with their source text kept here for
// duplication.

import * as S from './strings/index.js';

export const BUILTIN_PREFIX = 'builtin-';

// The placeholder's source: Svelte 5, reading only through the read API
// it receives (`spectra`) and its read-only `context` prop (04 §3): the
// query's :match_id bind defaults from the context, so no value is written
// into the SQL here.
const PLACEHOLDER_SOURCE = `<script>
  // A small example: the rounds of the chosen match, or the chosen player.
  let { spectra, context } = $props();

  const matchId = $derived(context.matchId);
  const steamId = $derived(context.steamId);

  const rounds = $derived(
    matchId == null
      ? null
      : spectra.query('SELECT number, winner FROM rounds WHERE match_id = :match_id ORDER BY number'),
  );
</script>

<section class="example">
  {#if matchId != null}
    {#await rounds then r}
      <p>Rounds: {r.rows.length}</p>
      <ol>
        {#each r.rows as [number, winner] (number)}
          <li>Round {number}: {winner || '-'}</li>
        {/each}
      </ol>
    {:catch}
      <p>-</p>
    {/await}
  {:else if steamId}
    <p>Player {steamId}</p>
  {:else}
    <p>Choose a match or a player to preview with.</p>
  {/if}
</section>

<style>
  .example ol {
    margin: 0;
    padding-left: 1.4em;
  }
</style>
`;

export const BUILTIN_COMPONENTS = Object.freeze([
  Object.freeze({
    id: BUILTIN_PREFIX + 'example',
    label: S.componentbuilder.placeholderName,
    placeholder: true,
    source: PLACEHOLDER_SOURCE,
  }),
]);

// isBuiltinId reports whether a placement's component reference names a
// shipped builtin.
export function isBuiltinId(id) {
  return BUILTIN_COMPONENTS.some((b) => b.id === id);
}

export function builtinById(id) {
  return BUILTIN_COMPONENTS.find((b) => b.id === id) || null;
}
