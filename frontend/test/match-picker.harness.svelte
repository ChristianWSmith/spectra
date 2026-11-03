<script>
  // Test harness for MatchPicker: fixed match list, selection recorded
  // globally so a driver script can assert on it.
  import MatchPicker from './matchpicker-bundle.js';

  const matches = [
    {
      id: 2,
      map: 'de_cache',
      scoreCT: 10,
      scoreT: 13,
      ctName: 'Team Alpha',
      tName: 'Team Beta',
      realRounds: 24,
      durationS: 2319,
      extractedAt: '2026-11-02T12:00:00Z',
      status: 'ready',
      path: '/demos/cache.dem',
    },
    {
      id: 5,
      map: 'de_mirage',
      scoreCT: 13,
      scoreT: 9,
      ctName: '',
      tName: '',
      realRounds: 22,
      durationS: 2100,
      extractedAt: '2026-11-01T09:00:00Z',
      status: 'failed',
      error: 'parse failed',
      path: '/demos/mirage.dem',
    },
    {
      id: 7,
      map: 'de_nuke',
      scoreCT: 12,
      scoreT: 12,
      ctName: 'Gamma',
      tName: 'Delta',
      realRounds: 24,
      durationS: 2400,
      extractedAt: '2026-10-30T09:00:00Z',
      status: 'parsing',
      path: '',
    },
  ];

  let value = $state(2);
  globalThis.__selected = [];
</script>

<MatchPicker
  {matches}
  {value}
  id="expl-match"
  onselect={(id) => {
    globalThis.__selected.push(id);
    value = id;
  }}
/>
