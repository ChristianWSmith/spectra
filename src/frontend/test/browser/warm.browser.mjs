// Real-browser check of the warm-pane layout (lib/warm.js + style.css .warm-hidden): a warm pane sits in the
// real container at its width, has its real height, is invisible, and adds no scroll.
// Run from src/frontend: node test/browser/warm.browser.mjs. Starts and stops its own Vite and Chromium.
import { spawn } from 'node:child_process';

const CHROME = process.env.CHROME_BIN || '/usr/bin/chromium';
const PORT = 9313;
const BASE = `http://127.0.0.1:${PORT}`;
let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ' — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore' });
let up = false;
for (let i = 0; i < 120 && !up; i++) {
  try {
    up = (await fetch(`${BASE}/test/browser/warm.html`)).ok;
  } catch {
    await sleep(500);
  }
}

let dom = '';
if (up) {
  dom = await new Promise((resolve) => {
    const chrome = spawn(
      CHROME,
      ['--headless', '--no-sandbox', '--disable-gpu', '--virtual-time-budget=6000', '--dump-dom', `${BASE}/test/browser/warm.html`],
      { stdio: ['ignore', 'pipe', 'ignore'], detached: true },
    );
    let buf = '';
    const done = (text) => {
      clearTimeout(limit);
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
  console.log(up ? 'FAIL: the warm pane did not report' : 'FAIL: the Vite server did not start');
  process.exit(1);
}
const o = JSON.parse(m[1].replace(/&quot;/g, '"'));
console.log('Warm pane in headless Chromium');
check('the warm pane lays out its content (real height)', o.paneHeight === 200, JSON.stringify(o));
check('it takes the container\'s width', o.paneWidth === o.viewsWidth, `${o.paneWidth} vs ${o.viewsWidth}`);
check('it is invisible to a reader', o.visibility === 'hidden', o.visibility);
check('it is out of the flow', o.position === 'absolute', o.position);
check('it adds no scroll to the content', o.contentScrollable <= 0, String(o.contentScrollable));
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
