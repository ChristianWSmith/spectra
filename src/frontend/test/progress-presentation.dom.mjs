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
//     profiles H, econ-tables for Match; map-pack-prompt F/F2 pin the
//     prompt's side of the 2026-11-17 rework — NO progress widget left
//     in the popup, the floating indicator owns extraction progress);
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
  // The save button moved into the Reports builtin's appendix panel (C5c).
  const reports = src('builtins/reports/ReportsAppendix.svelte');
  check(
    'Reports: "Generating…" still rides the Generate button as plain text',
    /\{#if m\.rendering\}Generating…\{:else\}/.test(reports) && !reports.includes('chip-spin'),
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
  // Copy byte-preservation: mpDetail used to be byte-identical to
  // MapPackPrompt's stepDetail (the two identical extraction-details
  // sites). The prompt's progress widget died with the close-on-extract
  // rework (owner 2026-11-17): the prompt renders NO details copy at all
  // any more, so this pin flipped IN PLACE to the absence + Settings
  // still carrying its own derived — same check count, EXPECTED stays 19.
  const derivedBody = (s, name) => {
    const m = new RegExp(`const ${name} = \\$derived\\(([\\s\\S]*?)\\n  \\);`).exec(s);
    return m ? m[1].replace(/mpStepProgress/g, 'stepProgress').replace(/mpStep/g, 'step') : '';
  };
  const settDetail = derivedBody(sett, 'mpDetail');
  const promptDetail = derivedBody(src('components/MapPackPrompt.svelte'), 'stepDetail');
  check(
    'MapPackPrompt has no stepDetail copy left (progress moved to the work indicator) while Settings keeps its own',
    promptDetail === '' && !!settDetail,
    `${JSON.stringify(promptDetail.slice(0, 80))} vs ${JSON.stringify(settDetail.slice(0, 120))}`,
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
  // The re-run subsection (per-row chips, k/N batch chip, behind count
  // line) died with the re-run UI (N1, 2026-11-15): the card is now
  // rules fields + one Save button that kicks the recompute itself.
  // These three checks flipped from copy-preservation pins to absence
  // pins in place — same check count, so EXPECTED stays 19.
  check(
    'Settings: the re-run per-row chips are gone with the re-run list',
    !/sett-match-row/.test(sett) && !/sett-sub/.test(sett) && !/status=\{state\}/.test(sett),
    '',
  );
  check(
    'Settings: the k/N batch chip is gone (the save kicks RecomputeAll itself)',
    !/allRun/.test(sett),
    '',
  );
  check(
    'Settings: the behind count line is gone (no behind fetches from this view)',
    !/behindLoading|behindTotal|behindRows/.test(sett),
    '',
  );

  // The two Loading lines moved into the Explorer builtin's panels (C5c).
  const expl = src('builtins/explorer/ExplorerProvenance.svelte') + src('builtins/explorer/ExplorerDiagnostics.svelte');
  check(
    'Explorer: both bare "Loading…" lines are block chips, none left as raw <p>',
    (expl.match(/<StatusChip block detail="Loading…" \/>/g) || []).length === 2 &&
      !/role="status">Loading…<\/p>/.test(expl),
    String((expl.match(/<StatusChip block detail="Loading…" \/>/g) || []).length),
  );
  // The two borderline provenance cells (Rules version / Trade window)
  // left Explorer with the details-technicals rework (owner ruling,
  // 2026-11-15): this check flipped IN PLACE from a copy-preservation pin
  // to an ABSENCE pin — same check count, so EXPECTED stays 19.
  check(
    'Explorer: the rules-version / trade-window facts are gone (technicals only)',
    !expl.includes('<dt>Rules version (match stamp)</dt>') &&
      !expl.includes('<dt>Trade window (current rules)</dt>'),
    '',
  );
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
