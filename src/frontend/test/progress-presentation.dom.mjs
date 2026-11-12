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
//   - Heatmaps lives in heatmap-layer.dom.mjs (section N);
//   - Settings (settings.dom.mjs) and Explorer (payload-tree.dom.mjs)
//     have harnesses but never HOLD a loading or extraction window —
//     their converted sites are pinned by SOURCE here (section D).
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

console.log('D. Settings + Explorer: the follow-up sites (block mode, copy preserved)');
{
  const sett = src('views/Settings.svelte');
  // Four bare loading lines (Data, CS2 assets, Plugins, Analysis rules)
  // → block chips, each keeping its exact existing words as the details
  // text ("Loading…" ×3, "Loading plugins…").
  check(
    'Settings: the three bare "Loading…" lines are block chips, none left as raw <p>',
    (sett.match(/<StatusChip block detail="Loading…" \/>/g) || []).length === 3 &&
      !/role="status">Loading…<\/p>/.test(sett),
    String((sett.match(/<StatusChip block detail="Loading…" \/>/g) || []).length),
  );
  check(
    'Settings: "Loading plugins…" keeps its copy as the details text',
    sett.includes('<StatusChip block detail="Loading plugins…" />') &&
      !/role="status">Loading plugins…<\/p>/.test(sett),
    '',
  );
  // The asset-extraction line: block mode, the honest counts still drive
  // the indicator, and the old inline "Extracting {step}…" sibling text
  // (now the details line) is gone from the markup.
  check(
    'Settings: the asset-extraction line is the block widget',
    sett.includes('<StatusChip block progress={mpPct} detail={mpDetail} />') &&
      !/Extracting \{mpStep\}…/.test(sett),
    '',
  );
  // Copy byte-preservation: mpDetail must be byte-identical to
  // MapPackPrompt's stepDetail (the identical site the progress pass
  // already converted) once the mp* identifiers are renamed — so the
  // rendered words cannot drift between the two callers.
  const derivedBody = (s, name) => {
    const m = new RegExp(`const ${name} = \\$derived\\(([\\s\\S]*?)\\n  \\);`).exec(s);
    return m ? m[1].replace(/mpStepProgress/g, 'stepProgress').replace(/mpStep/g, 'step') : '';
  };
  const settDetail = derivedBody(sett, 'mpDetail');
  const promptDetail = derivedBody(src('components/MapPackPrompt.svelte'), 'stepDetail');
  check(
    'Settings mpDetail is byte-identical to MapPackPrompt stepDetail',
    !!settDetail && settDetail === promptDetail,
    `${JSON.stringify(settDetail.slice(0, 120))} vs ${JSON.stringify(promptDetail.slice(0, 120))}`,
  );

  // Deliberate leave-alones (owner rulings) — pinned so a later pass
  // cannot quietly move them.
  check(
    'Settings: busy buttons keep their plain labels (the exemption)',
    sett.includes("{mpBusy ? 'Extracting…' : 'Extract all CS2 assets'}") &&
      sett.includes("{audioRunning ? 'Testing…' : 'Run audio self-test'}") &&
      !/\{mpBusy \? 'Extracting…'[\s\S]{0,120}chip-spin/.test(sett),
    '',
  );
  check(
    'Settings: the re-run per-row chips stay inline (row-shaped list items are cells)',
    /<StatusChip\n\s+status=\{state\}/.test(sett) &&
      !/sett-match-row[\s\S]*?<StatusChip block/.test(sett),
    '',
  );
  check(
    'Settings: the k/N batch chip stays inline beside its count text',
    /<StatusChip\n\s+status="running"\n\s+progress=\{allRun\.submitted/.test(sett),
    '',
  );
  check(
    'Settings: the behind count line keeps its own honest text (incl. its Loading… slot)',
    sett.includes('{:else if behindLoading && !behindRows.length}') &&
      /behindLoading && !behindRows\.length\}\n\s+Loading…/.test(sett),
    '',
  );

  const expl = src('views/Explorer.svelte');
  check(
    'Explorer: both bare "Loading…" lines are block chips, none left as raw <p>',
    (expl.match(/<StatusChip block detail="Loading…" \/>/g) || []).length === 2 &&
      !/role="status">Loading…<\/p>/.test(expl),
    String((expl.match(/<StatusChip block detail="Loading…" \/>/g) || []).length),
  );
  check(
    'Explorer: the provenance labels stay untouched (match stamp vs current rules)',
    expl.includes('<dt>Rules version (match stamp)</dt>') &&
      expl.includes('<dt>Trade window (current rules)</dt>'),
    '',
  );
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
