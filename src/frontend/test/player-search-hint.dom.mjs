// Source pins for the standard player-search hint (owner ruling): every
// PLAYER-search input says exactly "Search players..." — three ASCII
// periods, NOT the … glyph the old per-view hints used ("Search
// players…", "Player name or SteamID", "Find players…").
//
// Division of labour, so nothing is pinned twice:
//   - the widget's filtering / suggestion / keyboard behaviour stays
//     pinned MOUNTED in profiles.dom.mjs (C sort+filter, D suggestions)
//     and library.dom.mjs (B typing, C suggestions) — unchanged;
//   - the RENDERED hint is pinned mounted for the two views that have a
//     driver (profiles.dom.mjs A → #pf-search, library.dom.mjs A →
//     #lib-filter-player);
//   - PlayerProfile's finder has NO harness, so its hint — and the
//     component default all three sites inherit — is pinned here by
//     SOURCE (precedent: progress-presentation.dom.mjs).
//
// From frontend/ run:  node --test test/player-search-hint.dom.mjs
import { readdirSync, readFileSync } from 'node:fs';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  ok   ' + name);
  else {
    failures++;
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}
const src = (p) => readFileSync(`src/lib/${p}`, 'utf8');

console.log('A. SuggestInput owns the one spelling of the hint');
{
  const si = src('components/SuggestInput.svelte');
  check(
    'THE standard hint constant is exactly "Search players..." (three ASCII periods)',
    /const PLAYER_SEARCH_HINT = 'Search players\.\.\.';/.test(si),
    (si.match(/const PLAYER_SEARCH_HINT = [^\n]+/) || ['<absent>'])[0],
  );
  check('it never uses the … glyph', !si.includes('Search players…'));
  check(
    'a kind="player" box falls back to it; a text-kind box gets nothing',
    /kind === 'player' \? PLAYER_SEARCH_HINT : ''/.test(si),
  );
  check('the input renders the resolved hint', /placeholder=\{hint\}/.test(si));
  // An explicit caller placeholder still wins (Library's map facet relies
  // on this) — the default is a fallback, never a forced rewrite.
  check('the caller placeholder still wins over the default', /placeholder \|\|/.test(si));
}

console.log('B. every player-search site renders it (no override, one accessible name)');
{
  const sites = [
    ['views/Profiles.svelte', 'pf-search'],
    ['views/Library.svelte', 'lib-filter-player'],
    ['views/PlayerProfile.svelte', 'prof-q'],
  ];
  for (const [file, id] of sites) {
    const text = src(file);
    const blocks = text.match(/<SuggestInput[\s\S]*?\/>/g) || [];
    const block = blocks.find((b) => b.includes(`id="${id}"`)) || '';
    check(
      `${file} #${id}: found its SuggestInput block`,
      !!block,
      blocks.length ? blocks[0].slice(0, 80) : 'no SuggestInput in file',
    );
    check(
      `${file} #${id}: kind="player" with NO placeholder override (inherits the standard hint)`,
      block.includes('kind="player"') && !block.includes('placeholder'),
      block.replace(/\s+/g, ' ').slice(0, 160),
    );
    check(
      `${file} #${id}: accessible name is the same "Search players"`,
      block.includes('ariaLabel="Search players"'),
      block.replace(/\s+/g, ' ').slice(0, 160),
    );
  }
}

console.log('C. the retired per-view spellings are gone (old → new re-pin)');
{
  const retired = [
    ['views/Profiles.svelte', 'Search players…', 'the Profiles box'],
    ['views/Library.svelte', 'Player name or SteamID', 'the Library player facet'],
    ['views/PlayerProfile.svelte', 'Find players…', 'the PlayerProfile finder'],
  ];
  for (const [file, old, what] of retired) {
    const text = src(file);
    check(`${what}: "${old}" retired from ${file}`, !text.includes(old));
  }
  // The sr-only label under the profile finder names the same thing as
  // its aria-label (it is overridden by aria-label when present, so a
  // stale word there would be a second spelling).
  check(
    'PlayerProfile: the sr-only label says "Search players" too',
    src('views/PlayerProfile.svelte').includes('<label class="sr-only" for="prof-q">Search players</label>'),
  );
}

console.log('D. non-player search hints are deliberate leave-alones');
{
  // Picker-internal OPTION filters (a combobox narrowing an already-open
  // list) are a different affordance from a view-level player search —
  // MatchPicker and PlayerPicker are styled as a pair and both keep
  // "Filter …". Changing PlayerPicker alone would fork that pair.
  check(
    'MatchPicker keeps "Filter matches…" (a match filter, out of scope)',
    src('components/MatchPicker.svelte').includes('placeholder="Filter matches…"'),
  );
  check(
    'PlayerPicker keeps "Filter players…" (picker option filter, not a search box)',
    src('components/PlayerPicker.svelte').includes('placeholder="Filter players…"'),
  );

  // App-wide: no OTHER placeholder anywhere mentions players, so the
  // standard is the only player hint spelling left in the tree.
  const svelte = readdirSync('src/lib', { recursive: true }).filter((f) => String(f).endsWith('.svelte'));
  const playerHints = [];
  for (const f of svelte) {
    const text = readFileSync(`src/lib/${f}`, 'utf8');
    for (const m of text.matchAll(/placeholder="([^"]*[Pp]layer[^"]*)"/g)) {
      playerHints.push(`${f}: ${m[1]}`);
    }
  }
  check(
    'the only placeholder mentioning players anywhere is the picker leave-alone',
    JSON.stringify(playerHints) === JSON.stringify(['components/PlayerPicker.svelte: Filter players…']),
    JSON.stringify(playerHints),
  );
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
