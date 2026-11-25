// report-banner.dom.mjs — the author contract for spectra.report(error): the failure shows in
// the component's frame banner (role="alert", with the message), the body stays mounted, and
// the reader can dismiss the banner (the banner goes; the body remains).
// Run (from frontend/):  node test/report-banner.dom.mjs
// Then grep the log for FAIL and UNCAUGHT: the exit code is not the verdict.
import { boot } from './profile-harness.mjs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const h = await boot('report-banner');
const Probe = (await import(pathToFileURL(h.bundle(resolve('test/report-probe.svelte'))).href)).default;
const LoadProbe = (await import(pathToFileURL(h.bundle(resolve('test/load-probe.svelte'))).href)).default;

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
};

const { target, cleanup } = await h.mountComponent(Probe, { matchId: 1, steamId: null, round: null });
const alert = target.querySelector('[role="alert"]');
check('the reported failure shows in the frame banner', !!alert && alert.textContent.includes('probe load failed'),
  alert ? alert.textContent.trim() : 'no alert');
check('the component body stays mounted', target.textContent.includes('probe body'));

const dismiss = alert && alert.querySelector('button');
check('the banner has a dismiss control', !!dismiss);
if (dismiss) {
  dismiss.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await h.settle(20);
}
check('dismissing removes the banner', !target.querySelector('[role="alert"]'));
check('dismissing keeps the body', target.textContent.includes('probe body'));
cleanup();

// spectra.loadForMatch with no failure handler: a rejected load reaches the same banner.
const load = await h.mountComponent(LoadProbe, { matchId: 7, steamId: null, round: null });
const loadAlert = load.target.querySelector('[role="alert"]');
check('a failed loadForMatch shows in the frame banner', !!loadAlert && loadAlert.textContent.includes('probe match load failed'),
  loadAlert ? loadAlert.textContent.trim() : 'no alert');
check('the load body stays mounted', load.target.textContent.includes('load body'));
load.cleanup();

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(0);
