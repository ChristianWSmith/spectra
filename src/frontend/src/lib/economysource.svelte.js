// economysource.svelte.js — the economy a panel shows. Mounted alone (no rows
// given), the panel loads its own economy for the context's match. Mounted by
// the Economy composer, it takes the composer's rows, rounds, names, side
// switches and winner. Call it once from a component's top level.
//
//   const src = economySource(() => ({ spectra, context, given }));   // given = the rest props
//
// It takes a getter, not the values, so a prop that changes after mount is read
// again by the load and the derived data.
//   const rows = $derived(src.rows);
//
// The empty values (no rows, no names yet) are the same ones a panel shows while
// its own load runs; a failed own load keeps them, and the frame reports it.

import { loadEconomy } from './builtinhelpers.js';
import { whileCurrent } from './current.js';
import * as S from './strings/index.js';

const NAMES_DEFAULT = { ct: S.match.sideCt, t: S.match.sideT };

export function economySource(getInputs) {
  const standalone = $derived(getInputs().given.rows === undefined);
  let own = $state(null);
  $effect(() =>
    whileCurrent((isCurrent) => {
      const { spectra, context } = getInputs();
      if (!standalone) return;
      loadEconomy(spectra, context.matchId).then(
        (d) => {
          if (isCurrent()) own = d;
        },
        () => {},
      );
    }),
  );
  return {
    get standalone() {
      return standalone;
    },
    get rows() {
      return standalone ? (own ? own.rows : []) : (getInputs().given.rows ?? []);
    },
    get rounds() {
      return standalone ? (own ? own.rounds : []) : (getInputs().given.rounds ?? []);
    },
    get names() {
      return standalone ? (own ? own.names : NAMES_DEFAULT) : (getInputs().given.names ?? NAMES_DEFAULT);
    },
    get sideSwitches() {
      return standalone ? (own ? own.sideSwitches : 0) : (getInputs().given.sideSwitches ?? 0);
    },
    get matchWinner() {
      return standalone ? (own ? own.matchWinner : '') : (getInputs().given.matchWinner ?? '');
    },
  };
}
