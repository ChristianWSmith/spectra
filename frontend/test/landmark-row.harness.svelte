<script>
  // Test harness for LandmarkRow: one row per landmark source (event /
  // chat / generic ± resolver) with nav/select/seek recorded globally so
  // the driver can assert on them.
  import LandmarkRow from './components/LandmarkRow.js';

  globalThis.__nav = [];
  globalThis.__selected = [];
  globalThis.__seek = [];

  const nav = (hash) => globalThis.__nav.push(hash);
  const onselect = (r) => globalThis.__selected.push(r.key);
  const onseek = (r) => globalThis.__seek.push(r.key);

  const kill = {
    key: 'e:1',
    source: 'event',
    kind: 'kill',
    category: 'kills',
    tick: 1024,
    round: 5,
    attacker: '76561198012345678',
    attackerName: 'alice',
    victim: '76561198012345679',
    victimName: 'bob',
    weapon: 'ak47',
    distance: 312.4,
  };

  const botKill = {
    key: 'e:2',
    source: 'event',
    kind: 'kill',
    category: 'kills',
    tick: 1500,
    round: 5,
    attacker: '',
    attackerName: 'BOT',
    victim: '',
    victimName: 'carol',
    weapon: 'glock',
  };

  const chat = {
    key: 'c:1',
    source: 'chat',
    kind: 'chat',
    category: 'chat',
    tick: 2048,
    round: 5,
    steamId: '76561198012345678',
    who: 'alice',
    label: 'mid',
  };

  const generic = {
    key: 'g:1',
    source: 'generic',
    category: 'team_changes',
    tick: 3000,
    round: 5,
    who: 'alice',
    label: 'moved to CT',
    name: 'player_team',
  };

  // The same generic row without a resolver in the props (CompareRounds
  // never sees generic rows; Replay always passes one) — stays plain text.
  const genericUnresolved = { ...generic, key: 'g:2', who: 'dave', label: 'round start' };
  const resolveSteam = (name) => (name === 'alice' ? '76561198012345678' : '');
</script>

<div>
  <div data-testid="kill-row">
    <LandmarkRow row={kill} {nav} {onselect} {onseek} />
  </div>
  <div data-testid="bot-row">
    <LandmarkRow row={botKill} {nav} {onselect} {onseek} />
  </div>
  <div data-testid="chat-row">
    <LandmarkRow row={chat} {nav} {onselect} {onseek} />
  </div>
  <div data-testid="generic-row">
    <LandmarkRow row={generic} {nav} {resolveSteam} {onselect} {onseek} />
  </div>
  <div data-testid="generic-unresolved-row">
    <LandmarkRow row={genericUnresolved} {nav} {onselect} {onseek} />
  </div>
</div>
