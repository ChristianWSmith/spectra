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
    channel: 'all',
    tick: 2048,
    round: 5,
    steamId: '76561198012345678',
    who: 'alice',
    label: 'mid',
  };

  // Team chat + the side inputs: the tag is the SPEAKER'S SIDE in that
  // round (bob is ct here → [CT] — fmt.chatTag + teams.playerSideAt).
  const chatTeam = {
    key: 'c:2',
    source: 'chat',
    kind: 'chat',
    category: 'chat',
    channel: 'team',
    tick: 2060,
    round: 5,
    steamId: '76561198012345679',
    who: 'bob',
    label: 'b site',
  };
  const chatSideProps = {
    players: [{ steamId: '76561198012345679', name: 'bob', side: 'ct' }],
    sideSwitches: 0,
    rounds: [{ number: 5 }],
  };

  // The generic fixture mirrors the ONE generic category the registry
  // still has (Q3a: buys → item_purchase — team_changes/game_events left
  // the filter surface), so the row's chip resolves through
  // categoryById instead of falling back to a raw id.
  const generic = {
    key: 'g:1',
    source: 'generic',
    category: 'buys',
    tick: 3000,
    round: 5,
    who: 'alice',
    label: 'alice bought AK-47',
    name: 'item_purchase',
  };

  // The same generic row without a resolver in the props (CompareRounds
  // never sees generic rows; Replay always passes one) — stays plain text.
  const genericUnresolved = { ...generic, key: 'g:2', who: 'dave', label: 'round start' };
  const resolveSteam = (name) => (name === 'alice' ? '76561198012345678' : '');

  // Round lookup (Replay passes roundsByNumber + tickRate): rows then
  // show the ROUND + MATCH-CLOCK columns instead of the legacy tick
  // cell. Round 5 starts at tick 1920; round -2 is a LEGACY knife row
  // (the discard removed the row flags — the number rule labels it).
  const rounds = [
    { number: 5, startTick: 1920 },
    { number: -2, startTick: 100 },
  ];
  const rbn = new Map(rounds.map((r) => [r.number, r]));
  const timed = { ...kill, key: 'e:3', tick: 3000, round: 5 };
  const knife = { ...kill, key: 'e:4', tick: 2100, round: -2 };
  // A round_start row exactly as the default feed emits it: its tick IS
  // the round's startTick (Go extract sets round_start.Tick =
  // round.startTick), so a round-relative clock would read 0:00 — the
  // time cell renders the MATCH-relative clock for every row instead.
  const roundStart = {
    key: 'e:5',
    source: 'event',
    kind: 'round_start',
    category: 'round_starts',
    tick: 1920,
    round: 5,
  };
</script>

<div>
  <div data-testid="kill-row">
    <LandmarkRow row={kill} {nav} {onselect} {onseek} />
  </div>
  <div data-testid="timed-row">
    <LandmarkRow row={timed} roundByNumber={rbn} tickRate={64} {nav} {onselect} {onseek} />
  </div>
  <div data-testid="knife-row">
    <LandmarkRow row={knife} roundByNumber={rbn} tickRate={64} {nav} {onselect} {onseek} />
  </div>
  <div data-testid="round-start-row">
    <LandmarkRow row={roundStart} roundByNumber={rbn} tickRate={64} {nav} {onselect} {onseek} />
  </div>
  <div data-testid="bot-row">
    <LandmarkRow row={botKill} {nav} {onselect} {onseek} />
  </div>
  <div data-testid="chat-row">
    <LandmarkRow row={chat} {nav} {onselect} {onseek} />
  </div>
  <div data-testid="chat-team-row">
    <LandmarkRow row={chatTeam} {...chatSideProps} {nav} {onselect} {onseek} />
  </div>
  <div data-testid="generic-row">
    <LandmarkRow row={generic} {nav} {resolveSteam} {onselect} {onseek} />
  </div>
  <div data-testid="generic-unresolved-row">
    <LandmarkRow row={genericUnresolved} {nav} {onselect} {onseek} />
  </div>
</div>
