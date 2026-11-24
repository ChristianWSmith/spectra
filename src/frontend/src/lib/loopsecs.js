// loopsecs.js — the user's loop length, read once for a panel. The `loop_secs`
// pref is coerced by nav.js prefLoopSecs; an unset or failed read keeps the
// default (LOOP_SECS_DEFAULT), so a panel never waits on it.
//
//   onMount(() => { loadLoopSecs().then((v) => (loopSecs = v)); });

import { getPref } from './services.js';
import { prefLoopSecs, LOOP_SECS_DEFAULT } from './nav.js';

export function loadLoopSecs() {
  return getPref('loop_secs').then(prefLoopSecs, () => LOOP_SECS_DEFAULT);
}
