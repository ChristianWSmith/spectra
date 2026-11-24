// The loading state of one surface (a view, a panel's data): the reads in flight, the identity of the
// content they load, and the identity of the content on screen. A surface is busy while a load is in
// flight AND the content on screen is not the content being loaded: the first load, or a swap to another
// match, player or query. A refresh of the content already on screen is not busy, so the data stays put
// until the new arrives (no flash, no jitter). LoadBox turns busy into the held space and the spinner.

import { untrack } from 'svelte';

export function createLoadState() {
  let pending = $state(0);
  let want = $state(''); // identity of the content requested last
  let shown = $state(null); // identity of the content on screen; null until the first load settles
  let waiting = $state(false); // the last read has settled; the content shows after one more macrotask
  return {
    // track(promise, key): the load of content `key` (default: the content already asked for).
    // apply(value), when given, runs BEFORE the load settles: the caller stores the result, so the content and
    // the busy state change in the same step (an effect never sees "settled" with the old content).
    track(promise, key, apply) {
      // untrack: a read started inside an effect must not make that effect depend on the state it moves.
      untrack(() => {
        if (key !== undefined) want = String(key);
        pending++;
      });
      const settle = () =>
        untrack(() => {
          pending--;
          if (pending === 0) {
            // A continuation that starts the next read in the same tick is counted before the content shows:
            // the content is never unhidden with the previous step's values while the next step is on its way.
            waiting = true;
            setTimeout(() => {
              untrack(() => {
                waiting = false;
                if (pending === 0) shown = want;
              });
            }, 0);
          }
        });
      return Promise.resolve(promise).then(
        (v) => {
          try {
            apply?.(v);
          } finally {
            settle();
          }
          return v;
        },
        (e) => {
          untrack(() => pending--);
          throw e;
        },
      );
    },
    get pending() {
      return pending;
    },
    get busy() {
      return (pending > 0 || waiting) && shown !== want;
    },
    get key() {
      return want;
    },
  };
}
