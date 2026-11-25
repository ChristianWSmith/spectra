// current.js — the load an effect starts, dropped when it is out of date.
//
// An effect that loads for its inputs must not apply a late result after the
// inputs have changed or the owner has unmounted. whileCurrent is that guard:
//
//   $effect(() => whileCurrent((isCurrent) => {
//     spectra.track(load()).then((x) => { if (isCurrent()) value = x; });
//   }));
//
// run gets isCurrent, which stays true until the effect re-runs or unmounts,
// and whileCurrent returns the effect's cleanup.
export function whileCurrent(run) {
  let current = true;
  run(() => current);
  return () => {
    current = false;
  };
}

// whenCurrent gates a promise callback on isCurrent: the callback runs only while
// the load it belongs to is still the current one. The error sink of a load is
// the usual case: .catch(whenCurrent(isCurrent, (e) => { loadError = errText(e); })).
export function whenCurrent(isCurrent, fn) {
  return (...args) => {
    if (isCurrent()) return fn(...args);
    return undefined;
  };
}

// loadForMatch is the effect body of a panel that loads for the context's match
// and applies the result while it is still current. load(matchId) is the
// panel's loader, apply takes its value, and failed (optional) takes its error.
//
//   $effect(loadForMatch(() => context.matchId, load, (d) => (data = d)));
export function loadForMatch(getMatchId, load, apply, failed) {
  // The effect body: returned as a function so $effect runs the load (and its
  // reads of the match) when the effect runs, and the cleanup is whileCurrent's.
  return () =>
    whileCurrent((isCurrent) => {
      load(getMatchId()).then(
        whenCurrent(isCurrent, apply),
        failed ? whenCurrent(isCurrent, failed) : () => {},
      );
    });
}

// latestOnly is a runner for one kind of load: a result (or failure) applies only
// while it is the newest load of that kind. Start it once per panel and call it
// for each load; a load that a newer one has overtaken is dropped.
//
//   const runProv = latestOnly();
//   runProv(getProvenance(id), (p) => (prov = p), (e) => (provError = errText(e)));
export function latestOnly() {
  let gen = 0;
  return (promise, apply, fail) => {
    const mine = ++gen;
    const current = () => mine === gen;
    promise.then(
      (v) => {
        if (current()) apply(v);
      },
      (e) => {
        if (current() && fail) fail(e);
      },
    );
  };
}
