<script>
  // Test harness for RoundStrip: fixture data comes from globals the
  // driver sets per scenario (RoundStrip reads the kvstore pref on mount,
  // so each scenario re-mounts the component).
  import RoundStrip from './roundstrip-bundle.js';

  const rounds = globalThis.__rounds || [];
  const current = globalThis.__current || 0;
  const sideSwitches = globalThis.__sideSwitches ?? 1;
</script>

<RoundStrip
  {rounds}
  {current}
  matchId={1}
  teamAbove="Alpha"
  teamBelow="Beta"
  {sideSwitches}
  back=""
  nav={() => {}}
/>
