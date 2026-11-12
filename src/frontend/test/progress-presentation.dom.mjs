// Source pins for the progress-presentation ruling, covering the views
// with NO DOM harness (precedent: heatmap-layer.dom.mjs pins the
// Heatmaps view the same way — mounting Builder/SqlConsole/Reports/
// CommandPalette/Replay-loading here would drag in their whole service
// surface for a markup shape).
//
// Division of labour, so nothing is pinned twice:
//   - the WIDGET contract (ring vs spinner vs details-underneath vs the
//     byte-identical inline chip) is pinned MOUNTED in
//     library.dom.mjs Section G;
//   - harness-backed views pin their own loading states in their own
//     drivers (library L, combat K, round-detail G, compare-rounds,
//     profiles H, econ-tables for Match, map-pack-prompt F/F2);
//   - Heatmaps lives in heatmap-layer.dom.mjs (section N).
//
// Also pinned here: the busy-BUTTON exemption (owner ruling — a busy
// button label such as Reports' "Generating…" stays plain text).
//
// From frontend/ run:  node --test test/progress-presentation.dom.mjs
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  ok   ' + name);
  else {
    failures++;
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}
const src = (p) => readFileSync(`src/lib/${p}`, 'utf8');

console.log('A. harness-less loading lines render the canonical block widget');
{
  const builder = src('views/Builder.svelte');
  check(
    'Builder: the metrics-loading line is the block spinner',
    builder.includes('<StatusChip block detail="Loading…" />') &&
      !/role="status">Loading…<\/p>/.test(builder),
    '',
  );

  const sql = src('views/SqlConsole.svelte');
  check(
    'SqlConsole: the schema-loading line is the block spinner',
    sql.includes('<StatusChip block detail="Loading schema…" />') &&
      !/role="status">Loading schema…<\/p>/.test(sql),
    '',
  );

  const palette = src('components/CommandPalette.svelte');
  check(
    'CommandPalette: the search-loading state is the block spinner',
    palette.includes('<StatusChip block detail="Searching…" />') &&
      !/role="status">Searching…<\/div>/.test(palette),
    '',
  );
}

console.log('B. Replay’s four loading sites (harness exists but never holds a loading window)');
{
  const replay = src('views/Replay.svelte');
  check(
    'view-column load: block mode over the preload ledger',
    /<StatusChip block progress=\{loadPct\} detail=\{'Loading replay…' \+ loadDetail\} \/>/.test(replay),
    '',
  );
  check(
    'feed empty-state: "Loading events…" is the block spinner',
    replay.includes('<StatusChip block detail="Loading events…" />'),
    '',
  );
  check(
    'load-more follow-up: the hint under the button is the block spinner',
    replay.includes('<StatusChip block detail="Loading…" />'),
    '',
  );
  check(
    'detail pane: "Loading payloads…" is the block spinner',
    replay.includes('<StatusChip block detail="Loading payloads…" />'),
    '',
  );
  // The busy LOAD-MORE button keeps its label (the busy-button
  // exemption) — the spinner only ever sits OUTSIDE the button.
  check(
    'Load more keeps its busy label as plain button text',
    /\{feedLoading \? 'Loading…' : 'Load more…'\}/.test(replay),
    '',
  );
}

console.log('C. busy-button labels stay plain text (owner ruling: the exemption)');
{
  const reports = src('views/Reports.svelte');
  check(
    'Reports: "Generating…" still rides the Generate button as plain text',
    /\{#if rendering\}Generating…\{:else\}/.test(reports) && !reports.includes('chip-spin'),
    '',
  );
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
