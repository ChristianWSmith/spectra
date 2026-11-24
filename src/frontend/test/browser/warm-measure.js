// A warm pane (lib/warm.js) under the real container: laid out at the container's width, invisible, out of
// the flow. Reports what a reader and the scroll container would see.
import { mount } from 'svelte';
import Probe from './Probe.svelte';
import { probe } from './probe.svelte.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const views = document.getElementById('views');
const pane = document.createElement('div');
pane.className = 'warm-pane warm-hidden';
views.appendChild(pane);
mount(Probe, { target: pane });
probe.busy = false;
probe.key = 'warm';
probe.rows = 5;
await wait(300);

const content = document.querySelector('.content');
const probeEl = document.querySelector('.probe-box');
const row = document.querySelector('.probe-row');
const out = {
  paneHeight: Math.round(probeEl.getBoundingClientRect().height),
  paneWidth: Math.round(probeEl.getBoundingClientRect().width),
  viewsWidth: Math.round(views.getBoundingClientRect().width),
  visibility: getComputedStyle(row).visibility,
  position: getComputedStyle(pane).position,
  contentScrollable: content.scrollHeight - content.clientHeight,
};
document.getElementById('out').textContent = JSON.stringify(out);
