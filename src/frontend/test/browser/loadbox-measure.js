// Headless-Chromium measurement of the shared loading shell (LoadBox): mount a probe, walk a load timeline,
// sample the box's height every animation frame, and report each phase's heights and the largest jump
// between consecutive frames. Results land in <pre id="out"> as JSON for the runner to read.
import { mount, tick } from 'svelte';
import Probe from './Probe.svelte';
import { probe } from './probe.svelte.js';

const samples = [];
let phase = 'mount';
const box = () => document.querySelector('.probe-box');

function sample() {
  const el = box();
  if (el) {
    const r = el.getBoundingClientRect();
    samples.push({
      phase,
      h: Math.round(r.height),
      busy: el.classList.contains('load-busy'),
      first: el.classList.contains('load-first'),
      // what a reader sees: the content's visibility and the spinner's (the box's own pseudo-element)
      content: getComputedStyle(el.querySelector('.probe-row') || el).visibility,
      spinner: getComputedStyle(el, '::after').visibility,
    });
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function step(name, change) {
  phase = name;
  change();
  await tick();
  await wait(350);
}

const app = mount(Probe, { target: document.getElementById('host') });
const timer = setInterval(sample, 8);
await wait(100);

// The content changes when the data LANDS (the request starts first, the rows arrive later), as in the views.
// 1. first load: the box reserves its default height and hides the content until it lands
await step('first-load', () => {
  probe.busy = true;
  probe.key = 'a';
  probe.rows = 5;
});
await step('landed-a', () => {
  probe.busy = false;
});
// 2. a new identity (eight rows) is requested: the old content stays under a dim and a spinner while it loads
await step('swap-to-b-requested', () => {
  probe.busy = true;
  probe.key = 'b';
});
await step('swap-to-b-landed', () => {
  probe.rows = 8;
  probe.busy = false;
});
// 3. back to a: its remembered height is recalled while it loads
await step('swap-to-a-requested', () => {
  probe.busy = true;
  probe.key = 'a';
});
await step('swap-to-a-landed', () => {
  probe.rows = 5;
  probe.busy = false;
});
clearInterval(timer);
const phases = {};
let maxJump = 0;
let prev = null;
for (const s of samples) {
  const p = (phases[s.phase] ??= { min: Infinity, max: 0, n: 0, first: false, busyStart: null });
  p.min = Math.min(p.min, s.h);
  p.max = Math.max(p.max, s.h);
  p.n++;
  if (s.first) p.first = true;
  if (prev && prev.phase === s.phase) maxJump = Math.max(maxJump, Math.abs(s.h - prev.h));
  prev = s;
}
const visible = {};
for (const s of samples) visible[s.phase] = { content: s.content, spinner: s.spinner };
const out = { phases, visible, maxJumpWithinPhase: maxJump, frames: samples.length };
document.getElementById('out').textContent = JSON.stringify(out);
app.$destroy?.();
