// combatpanel.svelte.js — the data layer the two Combat panels share (Kill tags and
// Clutches): the match's list read with its side data (players, rounds, side
// switches, tick rate), the error line, the loop length read once at mount, the
// per-round colour of a name, and the replay a row opens. A panel passes the list
// read and what to do with the list; the rest is here. Call it once at the top
// level of the component.
//
//   const combat = combatPanel(() => spectra, () => id, {
//     read: (matchId) => getClutches(matchId),
//     apply: (list) => (clutches = list),
//   });

import { onMount } from 'svelte';
import { errText } from '../../services.js';
import { loadLoopSecs } from '../../loopsecs.js';
import { LOOP_SECS_DEFAULT } from '../../nav.js';
import { roundSideClassOf, openReplay, matchTab } from '../../builtinhelpers.js';
import { whileCurrent } from '../../current.js';
import { loadCombatSide } from './combatdata.js';

export function combatPanel(getSpectra, getMatchId, { read, apply }) {
  let error = $state('');
  let players = $state([]);
  let sideSwitches = $state(0);
  let rounds = $state([]);
  let tickRate = $state(64);
  let loopSecs = LOOP_SECS_DEFAULT;
  onMount(() => {
    loadLoopSecs().then((v) => (loopSecs = v));
  });
  const playerRoundCls = roundSideClassOf(() => ({ players, sideSwitches, rounds }));

  $effect(() =>
    whileCurrent((isCurrent) => {
      const matchId = getMatchId();
      getSpectra()
        .track(Promise.all([read(matchId), loadCombatSide(matchId)]))
        .then(([list, side]) => {
          if (!isCurrent()) return;
          apply(list || []);
          players = side.players;
          sideSwitches = side.sideSwitches;
          rounds = side.rounds;
          tickRate = side.tickRate;
          error = '';
        })
        .catch((e) => {
          if (!isCurrent()) return;
          // A read failure is the frame's banner (no retry here): the error stays for the empty line.
          error = errText(e);
          getSpectra().report(e);
        });
    }),
  );

  // Deep link into the replay at a tick, back to this panel's tab.
  function replay(tick, loop, follow) {
    const matchId = getMatchId();
    openReplay(getSpectra(), matchId, { tick, loop, follow, back: matchTab(matchId, 'combat') });
  }

  return {
    get error() {
      return error;
    },
    get players() {
      return players;
    },
    get sideSwitches() {
      return sideSwitches;
    },
    get rounds() {
      return rounds;
    },
    get tickRate() {
      return tickRate;
    },
    get loopSecs() {
      return loopSecs;
    },
    playerRoundCls,
    replay,
  };
}
