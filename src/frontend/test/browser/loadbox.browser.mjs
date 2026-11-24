// Real-browser check of the loading shell's layout (LoadBox): headless Chromium walks a load timeline and
// samples the box's height. Asserts: the box never collapses, its height holds through every request
// (the change comes only when the data lands), and a first load reserves room before the content shows.
// Run from src/frontend: node test/browser/loadbox.browser.mjs (needs /usr/bin/chromium).
// The runner starts its own Vite server and its own Chromium, and stops only those.
import { spawn } from 'node:child_process';

const CHROME = process.env.CHROME_BIN || '/usr/bin/chromium';
const PORT = 9312;
const BASE = `http://127.0.0.1:${PORT}`;
let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ' — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. our own Vite server, up when it answers
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
  stdio: 'ignore',
});
let up = false;
for (let i = 0; i < 120 && !up; i++) {
  try {
    up = (await fetch(`${BASE}/test/browser/loadbox.html`)).ok;
  } catch {
    await sleep(500);
  }
}

// 2. our own headless Chromium: the report appears in its output; it is stopped once the report is in
let dom = '';
if (up) {
  dom = await new Promise((resolve) => {
    const chrome = spawn(
      CHROME,
      ['--headless', '--no-sandbox', '--disable-gpu', '--virtual-time-budget=9000', '--dump-dom', `${BASE}/test/browser/loadbox.html`],
      { stdio: ['ignore', 'pipe', 'ignore'], detached: true },
    );
    let buf = '';
    const done = (text) => {
      clearTimeout(limit);
      // the whole group: Chromium's helper processes stop with the browser
      process.kill(-chrome.pid, 'SIGKILL');
      resolve(text);
    };
    const limit = setTimeout(() => done(buf), 120000);
    chrome.stdout.on('data', (d) => {
      buf += d;
      if (buf.includes('</pre>')) done(buf);
    });
    chrome.on('exit', () => done(buf));
  });
}
vite.kill('SIGKILL');

const m = dom.match(/<pre id="out">([\s\S]*?)<\/pre>/);
if (!m) {
  console.log(up ? 'FAIL: the measurement did not report (the page threw or never ran)' : 'FAIL: the Vite server did not start');
  process.exit(1);
}
const out = JSON.parse(m[1].replace(/&quot;/g, '"'));
const P = out.phases;
const REQUESTED = ['swap-to-b-requested', 'swap-to-a-requested'];

console.log('LoadBox in headless Chromium');
check('the box is measured for the whole timeline', out.frames > 100, `frames=${out.frames}`);
check('it never collapses (no sampled height is 0)', Object.values(P).every((p) => p.min > 0));
check(
  'a first load reserves room: the hidden content keeps its height',
  P['first-load'] && P['first-load'].min === 200 && P['first-load'].max === 200,
  JSON.stringify(P['first-load']),
);
for (const name of REQUESTED) {
  const p = P[name];
  check(`${name}: height holds while the request is in flight`, !!p && p.min === p.max, JSON.stringify(p));
}
check(
  'the swap to new content changes height only at landing (200 → 320)',
  P['swap-to-b-landed'] && P['swap-to-b-landed'].min === 320,
  JSON.stringify(P['swap-to-b-landed']),
);
for (const name of ['first-load', 'swap-to-b-requested', 'swap-to-a-requested']) {
  const cs = out.visible?.[name];
  check(`${name}: the stale content is blanked while the spinner shows`, !!cs && cs.content === 'hidden' && cs.spinner === 'visible', JSON.stringify(cs));
}
for (const name of ['landed-a', 'swap-to-b-landed']) {
  const cs = out.visible?.[name];
  check(`${name}: the landed content is visible`, !!cs && cs.content === 'visible', JSON.stringify(cs));
}
check('no jump inside a settled phase', out.maxJumpWithinPhase === 0, `maxJump=${out.maxJumpWithinPhase}`);

console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
