# 03 · QUERIES — SQL as the metrics definition language + the five-rule contract

**Step 3 deliverable of `PLANNING.md`.** Contracts: `dogfood/MANIFESTO.md` §5–§7
(the blacklist model, honesty, what N is) and §10 items 1, 5, 6, 7; baseline
`dogfood/01-BASELINE.md` **Part A** (reconciled at `611a8e6`). Planning
document only — no app code, no schema change, no test change; every SQL claim
below was executed (see §0). Citations are `file:line` into the worktree at
`611a8e6`.

**Status:** complete (sections 1–9). The crux (§1) was prototyped first, as the
manifesto demands.

---

## 0. Method and how to reproduce

Two experiments, both scratch-only:

1. **Rule-3 prototype SQL** — run against `/tmp/opencode/r3.db`:
   `sqlite3 r3.db < src/internal/store/schema.sql`, then
   `< src/internal/metrics/testdata/seed.sql` (the committed 3-match × 8-player
   × 24-round corpus), then two scratch amendments (marked E0 in the script):
   `UPDATE player_stats SET shots = kills*4, hits = kills*2;` (the corpus
   leaves `shots`/`hits` at 0, so hit rate needs values) and one **bot roster
   row** for match 1 (`players.is_bot = 1`, `player_stats` kills 99 — the shape
   `bot_group_test.go` seeds). Script + full output:
   `/tmp/opencode/r3_experiments.sql`, `/tmp/opencode/r3_results.txt`
   (ephemeral — key outputs are inlined below). **The live library DB was never
   opened.**
2. **Actual compiler-emitted SQL** — a throwaway test in
   `src/internal/metrics/` printed `Plan.SQL` for six representative sugar
   expressions (run with `go test -run TestScratchPrintPlans`); **the file was
   deleted before this document was committed** (the tree carries only this
   file as the change). The emitted statements quoted in §1/§2 are that output.

Confidence key: **H** = executed / read directly here · **M** = derived from
adjacent code · **flagged** = open question, see the note.

---

## 1. Rule-3 prototype — the crux (first, before anything else)

### 1.0 The model: derivation ladder + declaration fallback

Rule 3 (manifesto §5.3): every accepted query must **either** yield N
mechanically, **or** carry a declared pool whose table set is checked against
the query's actual FROM and, where cheap, companion-counted; otherwise refuse.
The prototype turns that into a decision procedure evaluated **at save-time**
(the compile gate, `metricservice.go:473`) and re-evaluated at run-time (the
sweep's compile at `pass.go:304-315` — same funnel, `compileRefs`
`compile.go:223`, baseline A1/A9.2):

| # | Shape of the statement | N mechanism | Verdict |
|---|---|---|---|
| 1 | **fetch** (raw value rows; percentile, future row tables) | **derived in Go** — N = rows fetched per declared key partition (today's `len(p.vals)` `pass.go:639`) | derived |
| 2 | **aggregate scalar** (top-level `GROUP BY` or top-level aggregate call) | **derived in SQL** — engine appends `, COUNT(*) AS n` to the select list (today's phase1 recipe `compile.go:1087`) | derived |
| 3 | **identity** (ranking/window, no group) | **derived structurally** — author must emit `n` as `COUNT(*) OVER (PARTITION BY <declared keys>)`; engine **pattern-checks** the n expression against the declared keys (tokenizer-level, `lexSQL`); the sugar path generates it exactly as `phaseIdentity` does today (`compile.go:1179-1181`) | derived (pattern) |
| 4 | anything the above cannot derive (set operations, non-aggregate multi-row statements) — and, where the default outer-row N is not the intended pool (inner-source values), a declaration that **overrides** the default | **declared** — `metrics.n_pool`, a `FROM … WHERE …` fragment, cross-checked `tablesOf(pool) ⊆ tablesOf(query)` and companion-counted where cheap | declared |
| 5 | neither | **refused** at save with a positioned message | — |

Derivation (rows 1–3) is checked mechanically on the token stream (`lexSQL`,
`query_store.go:268+` — strings/comments never become tokens, so textual
`FROM` inside a literal cannot fool it):

- **Append safety (row 2)**: `, COUNT(*) AS n` is inserted immediately before
  the depth-0 `FROM` token (end of the select list; a parenthesized inner
  `FROM` is at depth ≥ 1 and is skipped). The append is allowed only when the
  pre-append statement is already an aggregate (depth-0 `GROUP BY` or a depth-0
  aggregate call) — appending to a row-preserving statement collapses it
  (E6a/E6b below prove both collapses) — and only when there is no depth-0
  `UNION`/`EXCEPT`/`INTERSECT` (extending one branch is a parse error, E6c).
  `n` lands LAST — the positional contract (`mid/grp/dim/idkey/v*/n`,
  baseline A9.1) is preserved because the engine, not the author, owns the
  column's position.
- **Window shapes (row 3)**: no append (E6b shows why); `n` must already be
  the last column. The pattern check is *syntactic*: the n expression must be
  `COUNT ( * ) OVER ( PARTITION BY <exactly the declared key expressions> )`.
  It is a floor, not a semantic proof — a window count whose inner WHERE lies
  about the pool is the documented power-user residual (§1.7).

Declaration (row 4):

- **Where it lives: a furniture column `metrics.n_pool`** (TEXT, rides the
  owner's wipe like every other schema change pre-release). Rejected
  alternatives: an SQL **comment** inside the formula (pollutes the canonical
  text, breaks textual dedupe, silently disappears on the author's next edit)
  and an **expression sidecar table** (a column matches the existing furniture
  pattern — `denominator`, `format`, `doc` — and is what the UI needs to
  *mark* declared-N metrics, §10.6). Content: a `FROM … [WHERE …]` fragment,
  e.g. `FROM events WHERE kind = 'kill'`.
- **FROM cross-check is mechanical**: the same `tablesOf` extractor (§3)
  parses the fragment and the stored canonical SQL; every table named by
  `n_pool` must appear in the query's FROM/JOIN set (views resolve to their
  physical table first, §7). A pool touching a table the query never reads is
  refused — that N would be unrelated to the value. Fail-closed: a fragment
  the extractor cannot parse is refused, never accepted.
- **Companion count "where cheap"**: grouped shapes →
  `SELECT <declared key columns>, COUNT(*) FROM <n_pool> GROUP BY <keys>`;
  ungrouped → `SELECT COUNT(*) FROM <n_pool>`. The key columns come from the
  shape declaration (§4) — this is the interlock between rules 2 and 3.
  Where the keys are not expressible over the pool, the companion is skipped
  (manifesto says *where cheap*) and the declaration stands on the FROM
  cross-check alone.
- The **residual risk, stated as the manifesto states it**: a declaration
  whose *filter* lies (`n_pool = "FROM events WHERE 1=1"` on a query that
  filters heavily) yields an N that is checked for provenance, not truth.
  That is power-user territory — the same responsibility users already carry
  for meaning (wrong denominator, avg-of-ratios). What the model still
  guarantees: N exists, N's tables are tables the value reads, and N is
  disclosed with the formula.

### 1.1 Shape 1 — ratio (hit rate = hits ÷ shots) — **PASS (derived)**

The manifesto's motivating example. Corpus amendment sets `shots = kills*4`,
`hits = kills*2` (scratch only). Author-written SQL, no `n`:

```sql
SELECT steam_id AS grp, 1.0*SUM(hits)/NULLIF(SUM(shots),0) AS v
FROM player_stats
WHERE steam_id <> ''
  AND NOT EXISTS (SELECT 1 FROM players p WHERE p.match_id = player_stats.match_id
                  AND p.steam_id = player_stats.steam_id AND p.is_bot = 1)
GROUP BY grp ORDER BY grp;
```

Engine derivation appends `, COUNT(*) AS n` before `FROM` (row 2 of the
ladder). **Run result (E1a, library extent):** `grp | 0.5 | 3` for all eight
players — hit rate 0.5 over **N = 3 matches**. Batched match address (E1b):
`mid | grp | 0.5 | 1` — N = the `player_stats` rows of that (match, player)
group. This is *semantics-identical* to today's emission: N = "source rows of the
group after scope WHERE, subject conditions and the per-agg filter folded into
the value" (baseline A3; `compile.go:1087-1096`), **not** the ratio's own
divisor — the divisor (`shots`) lives inside the value, exactly as
`ratio(sum(…), sum(…))` compiles today (emitted form, printed from the
compiler: `1.0*(SUM(headshots)) / NULLIF((SUM(kills)), 0), COUNT(*) AS n`).

**Refusal when neither applies:** the ladder refuses only when the
statement's *declared kind* cannot be served by any row of the table.
Declared `scalar` requires the append (row 2); a non-aggregate statement
under a scalar declaration → rule 3: *"this statement returns rows, not an
aggregate — declare it as a fetch, or add GROUP BY"* (E6a/E6b class); a
scalar declaration over a top-level `UNION` → *"cannot derive N across a set
operation — declare a pool or rewrite"* (E6c). A column set that fits no
part of the declared kind (wrong columns/order) is refused by rule 2 before
rule 3 runs.

### 1.2 Shape 2 — rate/percentage over a pool (win rate) — **PASS (derived)**

Three runs (E2), all with the engine-appended `COUNT(*) AS n`:

- **Over player-rounds** (side win rate): `1.0*SUM(won)/COUNT(*) … FROM
  player_round_stats GROUP BY steam_id` → **0.5, N = 72** per player (72
  player-rounds = 3 matches × 24 rounds).
- **Over matches** (the manifesto's "win rate 62% over N = 50 matches"): the
  seed corpus matches are *tied* 12–12, so `SUM(won)…FROM player_stats` →
  **0, N = 3** — the honest *0-beside-N* case: the zero is a measurement over
  a visible pool, never a fabricated 0 (baseline A3; `schema.sql:543-544`).
- **Whole library, no `GROUP BY`** (`SELECT 1.0*SUM(winner='ct')/COUNT(*) …
  FROM rounds`) → **0.5, N = 72** — bare `COUNT(*)` on an aggregate statement
  is one row, append is safe.

N here is simultaneously the pool *and* (for `count()`-denominated rates) the
divisor — that coincidence is exactly what today's engine produces; for
`sum/sum` ratios N stays the row count and the denominator stays inside the
value. **No semantic change from the whitelist era; the derivation is the same
recipe the compiler already emits.**

### 1.3 Shape 3 — per-round aggregate (round-grain statistics) — **PASS for N (storage grain is §10.4's problem)**

The owner ruled round-grain statistics ARE metrics. Two readings, both
prototyped:

- **(a) A statistic summarized over rounds** — `SELECT match_id AS mid,
  AVG(duration_s) AS v, COUNT(*) AS n FROM rounds GROUP BY mid` →
  **avg 112.5 s, N = 24** rounds per match (E3a). Derived (row 2); this is the
  compiler's own round-grain emission (printed plan: `SELECT match_id AS mid,
  match_id AS grp, AVG(duration_s), COUNT(*) AS n FROM rounds GROUP BY mid,
  grp ORDER BY mid, grp`).
- **(b) A value per round over that round's rows** — `SELECT match_id, round,
  SUM(dmg) AS v, COUNT(*) AS n FROM events WHERE kind='damage' GROUP BY
  match_id, round` → **1100, N = 20** damage rows per round (E3b). Derived;
  N = the rows the value summarizes.

**The hard sub-case (E3c)** — value in a *correlated subquery*, outer row =
the round:

```sql
SELECT r.match_id AS mid, r.number AS grp,
  (SELECT COUNT(*) FROM events e WHERE e.match_id=r.match_id AND e.round=r.number
       AND e.kind='kill') AS v,
  COUNT(*) AS n
FROM rounds r GROUP BY mid, grp;
```
→ `5 | N = 1` per round: the appended N counts the *outer* rows (1 per round)
while the value summarizes *events*. This is the case where derivation's
default is defensible-but-not-intended, and it is what **declaration** exists
for: `n_pool = "FROM events"` (⊆ the query's touched tables — the subquery's
`FROM` is part of `tablesOf(Q)`) → companion count grouped by
`(match_id, round)` yields N = kill events per round. **Without a
declaration the default (outer rows) stands — recorded as the model's honest
boundary, not a failure.**

**Flagged interlock (not rule 3's to solve):** *where* a per-round value is
stored — `metric_values` PK is `(metric_id, match_id, subject_key, dim)` with
no round column (`schema.sql:560`). Round-grain materialization is manifesto
§10.4 (grain furniture), owned by a later step. Rule 3's N survives either
way.

### 1.4 Shape 4 — identity (argmax: key + caption, pool = candidates) — **PASS (structural recipe)**

Run the compiler's exact emitted statement (printed plan, `phaseIdentity`
`compile.go:1156-1221`) over the corpus **with** the humans-only condition
(E4a):

```sql
SELECT mid, grp, idkey, v, n FROM (
  SELECT match_id AS mid, match_id AS grp, steam_id AS idkey, kills AS v,
         ROW_NUMBER() OVER (PARTITION BY match_id ORDER BY kills DESC, steam_id ASC) AS rn,
         COUNT(*) OVER (PARTITION BY match_id) AS n
  FROM player_stats
  WHERE NOT EXISTS (… is_bot = 1) AND steam_id <> ''
) WHERE rn = 1 ORDER BY mid, grp;
```
→ `1|1|76561198000000008|16|8` (and matches 2, 3 alike): winner key,
companion value 16, **N = 8 candidate players**. Empty filtered pool (E4c,
`kills > 1000`) → **no row at all** — the dash is "no rows", never a
fabricated identity (baseline A3, pin `argmax_test.go:219`).

Under raw author SQL the engine cannot append into a ranked statement
(E6b proves the collapse), so the ladder's row 3 applies: **the author must
emit `n`**, and it is accepted as derived only when it pattern-matches
`COUNT(*) OVER (PARTITION BY <the declared keys>)` — the sugar's structural
recipe in author clothing. Otherwise: declared pool (`metrics.n_pool`,
cross-checked against the statement's FROM; companion count over the candidate
rows where the keys are expressible) or **refused** ("identity query must
yield its pool: add COUNT(*) OVER (PARTITION BY …) or declare a pool").

**E4b is the A9.6 trap made concrete** (same query, humans-only dropped):
match 1 → `1|1|18374686479671623692|99|9` — **the bot wins and N = 9**,
while matches 2–3 stay `…|16|8`. Nothing in the *output* flags the lie; this
is why §7's rule is input-side (views), not output-side.

### 1.5 Shape 5 — percentile (raw-fetch shape, N counted in Go) — **PASS (derived in Go)**

Phase2 today emits only the fetch (`SELECT attacker AS grp, dmg AS x FROM
events WHERE …`, printed plan) and `valuesFromPlan`/`RunPreview` partition the
fetched rows and set **`N: len(p.vals)`** (`pass.go:639`; preview twin
`preview.go:153+`, "N = the numeric values behind it"). Prototype (E5), fetch
and companion over the identical row source:

- fetch rows: **1944** (exact `COUNT(*)` over the fetch subquery);
- companion `SELECT attacker, COUNT(*) … GROUP BY attacker`:
  `…1|270, …2|234, …3|234, …4|234, …5|270, …6|234, …7|234, …8|234` — sums to
  **1944**.

The Go count per partition **is** a companion count over the same row source;
the two agree by construction (same WHERE, same grouping). Raw SQL percentile
therefore needs **no SQL-side N machinery**: the shape declaration says
"fetch" + which column is the value + the quantile `p` (today
`Plan.PercentileP` comes from the sugar; raw SQL needs it in the shape
metadata — §4), and N arrives exactly as it does today. One honesty note
carried over: the fetch runs under the row cap (`RunReadOnly`'s `Truncated`,
baseline A7) — **truncation must fail the metric, never serve a capped N**
(the phase2 comment `compile.go:1229-1230` already relies on cap-free SQL +
detectable truncation; the raw path keeps that).

### 1.6 What is refused when neither derivation nor declaration works (executed)

The through-line: **the append is never performed on a non-aggregate
statement** — each E6 case below is the engine's precondition catching it.
Disposition depends on the *declared kind* (the same text is refused under
`scalar`, accepted under `fetch`):

- **E6a — append collapse (non-aggregate + DISTINCT):**
  `SELECT DISTINCT steam_id, COUNT(*) AS n FROM player_stats` → **one row**
  (`18374686479671623692|25`) instead of 25 — proof the precondition exists.
  The pre-append form (a bare `SELECT DISTINCT` key list) carries no value
  column: it fits no declared kind → rule 2 refusal; declared `scalar` →
  rule 3 refusal (guidance: fetch, or add `GROUP BY`).
- **E6b — append collapse (window, no GROUP BY):**
  `SELECT steam_id AS grp, ROW_NUMBER() OVER (ORDER BY kills DESC) AS rn,
  COUNT(*) AS n FROM player_stats` → **one row** — window + forced aggregate
  collapses the row set. Pre-append the statement is `[key, value]` rows, so
  declared `fetch` accepts it (N = 25, counted in Go); declared `scalar` →
  rule 3 refusal (guidance above).
- **E6c — append impossible (top-level UNION):**
  `SELECT steam_id AS grp, COUNT(*) AS n FROM player_stats … UNION SELECT
  steam_id FROM player_round_stats …` → SQLite error *"SELECTs to the left
  and right of UNION do not have the same number of result columns"* — the
  engine refuses before execution (depth-0 set-operation detected): declared
  `scalar` → rule 3 *"cannot derive N across a set operation — declare a
  pool or rewrite"*; declared `fetch` over a set operation is fine (Go count
  over the union's rows).
- **Pool/FROM mismatch (static, by construction):** `n_pool` naming a table
  absent from the query's FROM/JOIN set → refused at save: *"declared pool
  reads `<t>`, which this query never reads — N must come from the query's
  own rows."*
- **Identity without derivable n** → the row-3 refusal quoted in §1.4.

### 1.7 Verdict — does N survive the shapes people actually ask for?

| Shape | N mechanism | Executed evidence | Verdict |
|---|---|---|---|
| ratio (hit rate) | derived — appended `COUNT(*)` (today's recipe) | E1a `0.5 \| N=3`, E1b `0.5 \| N=1` | **PASS** |
| rate over a pool (win rate) | derived — appended `COUNT(*)` (incl. 0-beside-N, whole-set) | E2a `0.5 \| 72`, E2b `0 \| 3`, E2c `0.5 \| 72` | **PASS** |
| per-round aggregate | derived over the round/row grain; inner-pool values via declaration | E3a `112.5 \| 24`, E3b `1100 \| 20`, E3c `5 \| 1` → declared `n_pool` | **PASS** (storage grain = §10.4) |
| identity (argmax) | structural recipe (sugar) / author `n` window-count pattern-checked / declared pool | E4a `N=8`, E4c empty→no row, E6b collapse | **PASS** |
| percentile (fetch) | derived in Go — `len(vals)` ≡ companion `COUNT(*)` | E5: 1944 fetch = 1944 Σ companion | **PASS** |

**Nothing in the five shapes falsifies the crux.** Every shape either derives
N with machinery the engine *already has today* (the phase1 append, the
phaseIdentity window count, the phase2 Go count) or takes the declared-pool
path, which is mechanical to validate (same tokenizer, table-set subset
check, optional companion count). The ladder is strictly *more* permissive
than the whitelist (raw SQL is accepted where the grammar refused) while
keeping the N-tripwire intact for the shapes the built-ins use.

**Honest qualifications (not falsifications):**

1. Derivation's *append* is unsafe outside aggregate statements (E6) — those
   shapes route to fetch-declaration or refusal; the refusal matrix for them
   is new copy, not new machinery.
2. Default N counts the **outer** row source; a value summarizing an inner
   source (E3c) needs `n_pool` to mean "pool of the value" — without it the
   answer is defensible-but-maybe-unintended. Documented, author-owned.
3. The identity `n` pattern check is **syntactic**; a lying filter inside
   the author's window/WHERE is the residual the manifesto already grants
   (power-user territory).
4. `n_pool`'s companion count requires the shape's key columns (rule-2
   interlock) — where keys aren't expressible over the pool, the FROM
   cross-check alone stands (*"where cheap"*).

---

## 2. Sugar → SQL behind the grammar

### 2.1 Refactor shape (the `Plan` seam, baseline A1/A9.1/A9.2)

`compileRefs` (`compile.go:223`) becomes a **front-end dispatcher**; every
call site (save `metricservice.go:473`, live check `:820`, preview
`preview.go:83`, sweep `pass.go:304-315`) stays untouched:

```
definition text (metrics.expr)
  ├─ parses as sugar?  Parse (parse.go:260) → existing emitters → canonical SQL  [byte-stable]
  └─ else raw SQL      gate (§3) → tablesOf/allowlist/population (§7)
                       → metric('…') ref extraction (below) → shape+N (§1)
                       → canonical SQL
            ↓  Plan{Mode, SQL, Args, Identity, Subject, Partition, MatchAddress, …}
   + NEW: Plan.Tables (rule 5), Plan.Shape (rule 2)
            ↓
RunPreview / valuesFromPlan / Sweep / DisplaySQL — UNCHANGED if the
positional column contract holds: [mid] grp [dim] [idkey] v… n, n LAST
```

**What stays byte-stable:** sugar emission text (the fixtures/refusal pins of
baseline A2/A5), the positional aliases `mid/grp/dim/idkey/v/x/n`
(`compile.go:1062-1087`, `:1141-1146`, `:1245`), `DisplaySQL`/`InlineArgs`
(`display.go:136`, `:29`), and the `metric()` ref join text
(`compile.go:158-176` comment — `INNER JOIN metric_values md0 ON md0.metric_id
= ? AND … AND md0.metric_version = ? AND md0.rule_version = ?`).

**`metric()` refs inside raw SQL** (proposal, M): keep `metric('name')` as
the ONE reserved sugar construct allowed to appear in raw text — SQLite never
sees it; the front end extracts it token-wise (deps extraction, cycle check at
`metricservice.go:478`, and the `md0` join rewrite all keep working verbatim,
including the INNER contract "missing upstream ⇒ no row, never 0"). Raw
joins against `metric_values` are then *refused* (not allowlisted for
authors) so the dependency graph cannot be bypassed. Rejected alternative:
parse literal `metric_id` joins — no name-based dep edges, cycle detection
dead.

**Raw-SQL preprocessing** = text surgery on the token stream only: ref
rewrite, `n` append (§1), nothing else. `Args`: raw SQL is authored with
literal values (the console precedent: parameterized statements refused,
`internal/query/session.go:74`) — so `Plan.Args` is empty for raw and the
console's `HasParameters` refusal applies; sugar keeps its `?` binds.

### 2.2 The stored canonical formula, dedupe, and the Formula tooltip (disposition for §10.7)

The manifesto: *sugar expands to SQL and the expanded SQL becomes the stored
canonical formula — two spellings of one query dedupe.* Disposition:

- **Two fields, one canonical.** `metrics.expr` keeps **what the author
  wrote** (sugar for built-ins and sugar users, SQL for raw authors); a new
  `metrics.canonical_sql` column holds **the expansion** (sugar → emitted
  SQL; raw → the text as stored, refs rewritten, `n` appended). Everything
  that *executes* or *compares* reads `canonical_sql`; dedupe is equality on
  it — one query, one stored spelling, regardless of how it was typed.
- **Why store rather than compute-on-read:** freezing the expansion at save
  means a later sugar-compiler change (the convenience backlog) can never
  silently re-expand a saved metric; and readers (provenance, sweep) do not
  depend on the sugar parser staying byte-identical forever. Sugar *stays
  parseable* regardless — the editor round-trips `expr`.
- **Seeds:** the 109 built-in rows keep sugar in `expr` (schema.sql stays
  authorable; `fixtures_test.go` pins keep pinning sugar). Their
  `canonical_sql` is **derived data refreshed idempotently at Open**
  (`origin='builtin'` rows: `canonical_sql IS NULL → compute`) — a derived-
  field refresh, not a versioned migration, in the same class as
  `metric_deps` wholesale re-derivation (`metrics_store.go:760`). Exact
  column naming/backfill order → PLAN (M).
- **Formula tooltip shows the authored source** (`expr`): `"Formula: " +
  expr` is today's contract (`metricservice.go:526-528`) and stays readable
  (sugar reads as sugar; built-in doc phrasing is pinned Formula-first,
  `fixtures_test.go:1141-1144`). **The expansion is shown by the existing
  provenance surface** — `CompileMetric` → `DisplaySQL`
  (`metricservice.go:748/:782`, Builder panel `Builder.svelte:1118/:1123`).
  Dedupe/equivalence reporting: when a save's `canonical_sql` equals another
  metric's, the save response says so (same query as `<name>`), which is how
  "two spellings dedupe" becomes visible instead of silent. (Recommendation,
  M — the owner may prefer the manifesto-literal single field; flipping it
  changes only the tooltip/editor round-trip, not the machinery above.)

### 2.3 Built-ins stay authored in sugar, proven by goldens

Unchanged posture (manifesto §3): all 109 seeds are sugar rows in
`schema.sql` (`:963, 1460, 1494, 1538, 1612, 1646, 1673`; baseline A5), the
`builtinSeed` value+N+labels gate (`fixtures_test.go:37-1046`, N at
`:1193-1194`) and the equivalence suites run **language-agnostically** over
values and N — they pin *results*, so they keep guarding the sugar path after
the IR swap. Additional pin for this step: **no seed row carries `n_pool`**
(a built-in must always derive — the sugar path is strictly easier, manifesto
§3). Characterization first: every existing expression must compile to the
same SQL text before/after the dispatcher split (byte-stability of sugar
emission is the migration's tripwire).

---

## 3. Rule 1 — safety gate

### 3.1 Reuse map (baseline A7 — all drop-in)

| Layer | Existing home | Reuse for saved metric queries |
|---|---|---|
| statement policy | `ValidateReadOnlySQL` `query_store.go:395-448` (single `;` final-only, tokenizer-aware write-verb ban incl. `WITH … INSERT`, leading-keyword gate) | reuse `lexSQL` + single-stmt + write-verb ban; **narrow the leading gate to `select\|with`** for metrics (no `explain`/`pragma`/`values` — the metric path never needs them; the console keeps its wider set) |
| read-only connection | `roDSN` `mode=ro` + `query_only(1)` + `busy_timeout`, `query_store.go:74-81` | unchanged — `RunReadOnly` already executes interactive plans (`preview.go:96`) |
| timeout | `query_store.go:151` + progress/interrupt | unchanged (defaults `DefaultTimeoutMS=5000` `:49`) |
| row cap | `:171-174` `Truncated`, `DefaultRowLimit=5000` `:47` | unchanged; **truncation = metric failure**, never a capped N (§1.5) |
| defense in depth | `QueryWrite` already runs `ValidateReadOnlySQL` on the sweep path (`metric_values_store.go:521-524`) | unchanged |
| parameters | console refuses `HasParameters` (`internal/query/session.go:74`) | **invert for metrics**: sugar plans keep `?` binds; raw SQL is literals-only |

### 3.2 The NEW piece — table allowlist (the flagged gap, baseline A7/A9.3)

**There is no table allowlist anywhere today** (console deliberately exposes
every non-`sqlite_%` table via `Schema()` `query_store.go:454-458`; the
whitelist's `sources` map gates grammar sources only). Design:

- **`tablesOf(sql) ([]string, error)`** — built on `lexSQL`: walk tokens,
  track paren depth, collect the identifier after every `FROM`/`JOIN`, plus
  comma-separated tables while in FROM-state (state ends at `WHERE`/`GROUP`/
  `ORDER`/`HAVING`/`LIMIT`/`WINDOW`/…); collect CTE names first
  (`WITH [RECURSIVE] name AS (`) so `FROM <cte>` is not reported as a
  physical table; **fail closed** — `FROM`/`JOIN` followed by anything that
  is not an identifier or `(` is an error (this also makes quoted table
  names (`"foo"` — skipped by the lexer, `query_store.go` doc) impossible
  rather than invisible: authors use unquoted names, our dialect). Subquery
  `FROM`s are collected too — correct for both allowlist and staleness.
  Confidence M: the state machine is modest engineering over an existing
  tokenizer; edge list (comma joins, CTEs, `FROM (SELECT …)`) is the known
  scope, and it is pinned by tests from day one.
- **The allowlist derives from existing declarations** (one canonical list,
  test-pinned to the schema like `TestSchemaConsistency`):
  `tableFor(sources)` (`whitelist.go:19` + `:146-160`) ∪ `denominatorTables`
  ∪ `denominatorCareerTables` (`whitelist.go:293-310`) ∪ `{players, matches,
  metric_values}` (the humans-only lookup, the match denominator, the ref
  join) ∪ the §7 `src_*` views ∪ **the tick tables when step 2 lands**.
  Explicitly NOT allowlisted: `generic_events` (unwhitelisted payload),
  `sqlite_*`, and the app tables (`jobs`, `query_history`, `saved_queries`,
  `plugins`, `analysis_config`, …). `rounds`/`matches` arrive via both the
  source and denominator sets — the union is the list, one spelling.
- **Where it enforces — both:**
  1. **save-time** (`SaveMetric` compile gate `metricservice.go:473`, and the
     same compile for live check/preview): `tablesOf(canonical)` ⊆ allowlist,
     refusal names the offending table and the allowed set;
  2. **run-time** (sweep execution + preview execution): re-check the text
     about to execute — defense against catalog drift and plugin-supplied
     definitions, mirroring how `QueryWrite` re-runs the read-only gate.
- **The console is unaffected** — it is a power surface with its own (wider,
  still `sqlite_%`-excluding) policy. Rule 1's allowlist is the *metric*
  gate; the manifesto's "our tables only" for metrics means exactly the list
  above.

---

## 4. Rule 2 — output-shape validation (validate the result, not the syntax)

### 4.1 What exists today (baseline A4) and what is missing

- **Nothing row-shaped**: a `metric_values` row carries one `value` (+ optional
  `value_key`); both mappers are offset-based and **silently skip rows too
  short for the shape** (`valuesFromPlan` `pass.go:523-525` `continue`;
  preview likewise) — under rule 2 that skip becomes a *refusal with a
  message*, not a silent drop (correction/extension of baseline A4: the
  defensive skip exists, but it fails *quietly*, which the blacklist model
  cannot afford).
- **No declared-shape metadata**: `metrics` DDL (`schema.sql:836-852`) has
  `format` but no kind/columns/grain; `Plan` carries the shape only
  ephemerally (`Mode`, `Identity`, `MatchAddress`, `Partition`,
  `SQLAggs` — `compile.go:77-116`).
- **format × shape NOT enforced** (baseline A4): no DDL CHECK
  (`schema.sql:834-840`), save only checks format *membership*
  (`metricservice.go:366-369`), and the editor withholds `identity` purely
  because "the format select has never been gated on the expression's SHAPE"
  (`metricformats.js:19-31`).

### 4.2 Minimal declaration rule 2 needs

A persisted **shape declaration** — proposed `metrics.shape` (TEXT, JSON;
rides the wipe), read at compile into `Plan.Shape`:

```json
{ "kind": "scalar" | "identity" | "fetch",
  "keys": ["mid","grp"] | ["grp"],        // declared grain, in positional order
  "value": "v" | "x", "value_key": "idkey",   // column roles (aliases of the positional contract)
  "p": 0.95 }                             // fetch + percentile only (today's Plan.PercentileP)
```

`kind: "rows"` (multi-column tables) is reserved for §10.4's grain furniture
— its storage key doesn't exist yet (A4), so this step ships scalar/identity/
fetch only. For scalar and identity the *columns* are engine-owned (the
positional contract), so the author declares only `kind` (+ `p` for fetch);
`keys` is derived from the furniture (subject/scope/partition ⇒ `mid/grp/dim`)
for scalar/identity, and explicitly declared for fetch.

### 4.3 The validation itself (result-side, three enforcement points)

Enforced on **executed rows** at (a) preview, (b) **save-time probe** (run the
compiled plan once under the row cap on the ro connection — refuses early,
before any materialization), (c) **every sweep materialization** (failure →
the metric's `failed` state with the refusal message — the five-state
machinery already carries errors, `metriccompute.go:340-344`):

1. **Required columns present, in positional order** — per kind:
   `scalar`: `[mid?] grp [dim] value n` (n LAST); `identity`: `… idkey value
   n`; `fetch`: `[mid?] grp [dim] x` (**no n column** — Go counts, §1.5).
   Short rows, extra columns, wrong order → refusal (today: silent skip).
2. **Keys unique at the declared grain** — duplicate `(mid, grp, dim)` rows
   in one result → refusal ("returned the same key twice — the statement's
   GROUP BY must match the declared grain"). Today a duplicate would only
   surface later as a `metric_values` PK error during insert; rule 2 moves it
   to a shaped message at the gate.
3. **Numeric values** — every value cell numeric or NULL (NULL keeps the
   0-beside-N rule via `toFloat` `preview.go:404-410`); a TEXT/blob value is a
   refusal, never coerced. **`value_key` non-empty** on every identity row
   (sugar guarantees it in SQL — `compile.go:1196-1204`; raw SQL is checked
   after the fact).
4. **format × shape** (closes the A4 gap mechanically): `format='identity'`
   ⇔ `kind='identity'` ⇔ an `idkey` column was produced and every
   `value_key` populated; numeric formats ⇔ `kind ∈ {scalar, fetch}` with
   numeric values; a mismatch is refused **at save** — which finally lets the
   editor's `identity` option stop being withheld by heuristic
   (`metricformats.js` `filterOnly` retires to a real gate).

---

## 5. Rule 4 — furniture matrix (unchanged)

Rule 4 is pure metadata validation over the `metrics` row — **no SQL, no
result**. Everything the baseline catalogued as enforced stays enforced,
at the same sites (baseline A4):

| Check | Site (unchanged) |
|---|---|
| subject × scope (profile = player-only) | `Address.normalize` `compile.go:51-71` **and** save-time `SaveMetric` `metricservice.go:397-400` (both must agree — doc says so) |
| subject × lead anchor (player/match/team anchoring) | `compile.go:303-323` (three anchor messages) — for **sugar** at compile; for **raw SQL** the anchor moves to rule 2's result check (the returned keys must be addressable by the declared subject), because there is no source clause to inspect |
| partition vocabulary + partition × columns | `compile.go:330-339` (sugar); raw SQL: columns → rule 2 (`dim` present iff partition declared) |
| partition × denominator × subject | `compile.go:406-416` (sugar — the deny rules stay; raw SQL has no separate denominator, see below) |
| denominator vocabulary (`rounds`/`matches`) | `compile.go:381-388` + `whitelist.go:293-310` (sugar) |
| scope / format / subject / partition vocabulary, short-name cap | `SaveMetric` `metricservice.go:366-400` (applies to raw and sugar alike) |
| ref subject containment + cycles | `compile.go:457-461`, `refs.go:120`, save-time cycle check `metricservice.go:478` (raw SQL keeps `metric('…')`, §2.1) |

**One deliberate carve-out:** the `denominator` furniture is a *sugar*
construct (it drives `emitDenom`, `compile.go:1316-1422`). A raw query authors
any division inline; a raw metric therefore stores `denominator = ''` and is
**refused if a non-empty denominator is declared** (the engine cannot wrap an
author's value it doesn't structure). Display implications (the denominator
hint in the UI) → PLAN; N continues to carry the pool disclosure.

---

## 6. Rule 5 — freshness from the touched-table set

### 6.1 The reality today (baseline A6/A9.5, verified here)

`MetricCoverage` (`metric_values_store.go:99-178`) is **metric-version-grained
with blanket axes**, not table-grained: behind ⟺ a row fails
`v.metric_version >= m.version AND v.rule_version >= ?`
(`metricValueFreshCond` `:45`) **or** a ready match has no fresh row **or**
the career bucket has no fresh row **or** a partitioned dim value has no fresh
row. `Plan.Source` (`compile.go:86`) records only the primary — no touched-set
exists anywhere. The live rule version is `analysis_config.rule_version`
(`metriccompute.go:318-322`). Consequence: **every** metric — even pure-fact
ones like hit rate over `player_stats` — reads `rule_version` freshness, i.e.
a rules bump marks the whole library behind (over-approximation), while a
table-grained notion has no representation at all (under-approximation for
anything with no axis).

### 6.2 Design: table → staleness axis, one canonical map

**Where table-set staleness comes from** — there is no single "table stamp"
in the schema; three axes already exist and the touched set decides *which
apply* (proposal):

| Table class | Members (M — R32 Part B pins the final list) | Staleness source (existing machinery) |
|---|---|---|
| **analysis-derived** (written by `analytics.Compute`, `store/analytics.go` `Replace*`) | `round_classifications`, `round_side_classes`, `player_round_stats`, `clutches`, `engagements`, `utility_events`, `match_trade_opps` (+ the `player_stats.trade_kills` column via `ReplaceTradeKills`) | **`analyzed_rule_version` axis**: per-match stamp `matches.analyzed_rule_version` (`schema.sql:46-57`), row stamps where the table carries `rule_version` (`round_classifications:408`, `player_round_stats:467`), live = `analysis_config.rule_version` — exactly the axis `RecomputeAll`/`SetConfig` already drive |
| **extract facts** | `matches`, `rounds`, `events`, `player_stats` (base columns), `round_economy`, `round_player_sides`, `chat`, `players`, `teams`, … | **unit axes already cover regeneration**: reprocess/import clears the match's rows (`childTables` clears by key — `metric_values_store.go:91-98` comment) → match-unit/career-unit behind; import triggers the sweep (`sweepForJob`, `AfterAnalyze` `main.go:209,348`). No per-table stamp needed today |
| **`metric_values`** (raw reads are refused — refs only, §2.1) | ref joins | **row-level**: the `md0` join already binds live `metric_version = ? AND rule_version = ?` (`compile.go:158-176`) — a stale upstream *drops the row* (INNER contract), freshness is baked into the read |

**The mapping itself** is one Go map beside `whitelist.go` (the canonical
home for "the one place a schema change must be mirrored"), pinned to the
schema by a `TestSchemaConsistency`-style test; views resolve to their
physical table first (§7).

### 6.3 How the touched set is known, and how the five states keep working

- **Storage:** `tablesOf(canonical_sql)` runs at save and stores the physical
  table set on the metric — same derived-at-save pattern (and same
  re-derivation rule) as `metric_deps` (`metrics_store.go:760`, wholesale
  replace). Proposed column/table rides the wipe; **not** versioned data —
  it's a cache of a pure function of the stored SQL.
- **Predicate change:** `MetricCoverage` gains no new *state* — its behind
  expression gains gating: the `rule_version` clause (both the row-stamp
  comparison and the fresh-cond usage for that axis) applies **only to
  metrics whose touched set intersects the analysis-derived class**; fact-only
  metrics stop going behind on rules bumps (the precision win), analysis
  metrics behave exactly as today. Mechanical note (flagged, M):
  `metricValueFreshCond` is THE one spelling (`:37-45`) — gating turns the
  const into a **single builder** parameterized by the axis flag (one
  construction site, still one spelling), and the fresh-count, canonical read
  and sweep selection must all take the same builder or they disagree.
  Conservative fallback if pins resist: keep the blanket axis (today's
  behavior) and ship rule 5 as touched-set *recording* + the map, lifting the
  blanket later — a behavior change, so it goes to PLAN either way.
- **The five states are untouched**: `GetMetricComputeState`
  (`metriccompute.go:317-357`) reads `MetricCoverage` + in-memory
  processing/failed — behind/no-data/fresh come from the same three fields
  (`Behind`, `FreshRows`, error). New axis logic lives entirely inside
  `Behind`; `metricstate.js`'s five words (`:30`) don't move.

---

## 7. Human-only / subject conditions under author SQL (the A9.6 honesty trap)

### 7.1 The trap, restated with evidence

Today the compiler injects `subjectConds` unconditionally
(`compile.go:1012-1031`): `subject <> ''` + `store.HumanOnlyBySteamID`
(a `NOT EXISTS … players … is_bot = 1` over the source's subject column,
`store/queries.go:231-243`). **Raw SQL cannot be injected into** — and the
damage is silent and *value-side*, not just key-side (E7):

- compiler condition (E7a): `AVG(kills)` match 1 → **9.0, N = 8**;
- author-written with no condition (E7b): → **19.0, N = 9** — the bot's 99
  kills moved the value *and* N, and the output looks perfectly healthy;
- identity variant (E4b): the bot *wins* the match's argmax with N = 9.

Output-side enforcement alone is **actively wrong** here: dropping rows whose
subject key is a bot would delete match 1's whole identity row (the row's
subject is the match; the bot appears as `value_key`), converting
contamination into a silently missing value. Validation-side enforcement
("does the WHERE contain a humans-only condition?") is unprovable in general
(a syntactic condition can be dead, or attached to the wrong join level).

### 7.2 The ONE canonical rule (proposed)

> **Author SQL reads row sources through sanctioned `src_*` views — one view
> per grammar source, defined in `schema.sql`, each baking exactly that
> source's *unconditional population condition*: the `subjectConds`
> humans-only half (`NOT EXISTS … is_bot = 1` over `sourceSubject`'s column,
> `whitelist.go:213-224`). The `subject <> ''` half moves to output mapping
> (drop rows with an empty subject key for player/team subjects; no empty-key
> rule for match subjects — exactly today's split, `compile.go:1016-1030`).
> The *author-path* rule-1 check admits the views plus the condition-free
> tables (`matches`, and the no-subject sources — `rounds`, `round_economy`,
> `round_classifications`, `round_side_classes` — readable raw or via their
> pass-through views); raw player-carrying source tables are refused in
> *author* SQL with a message pointing at the view. The full allowlist of §3.2
> still covers engine-generated sugar SQL. Sugar-compiled SQL is unchanged
> (raw tables + compiler-injected conditions, byte-stable).**

Why this rule, over the alternatives:

- **Criterion-based, not a whitelist exception** (AGENTS "differentiate by
  criterion"): the partition is *`sourceSubject[src] != ""`* — sources whose
  rows carry a player axis get a conditioning view; sources without one
  (`rounds`, `round_economy`, `round_classifications`, `round_side_classes`)
  get pass-through views because `subjectConds` emits nothing for them today
  either. One criterion, every source, present and future.
- **The view reproduces `subjectConds` by construction**: for every subject
  type — player (`<>''` at output + humans-only in view), team (`team<>''`
  at output + humans-only over the primary's player column when present),
  match (humans-only only, no empty-key rule) — the executed result equals
  the compiler's (verified for the player case: **E7c**, view-baked query →
  `9.0 | 8`, identical to E7a; the demo view baked *both* halves, and for a
  player-subject grouping the `<>''` half is equivalent at output — the
  proposal's split keeps it out of the view only so match-subject queries over
  actor-carrying tables keep today's semantics for actor-less rows).
- **Visible, not rewritten**: the author can `SELECT * FROM src_events` and
  *see* the population condition — aligned with the honesty posture (a hidden
  token-rewrite of table names was the alternative; rejected because the data
  semantic should be inspectable, even though `metric('…')` ref rewriting
  (§2.1) is already engine-side — that one is our own fixed construct).
- **Output-key dropping stays** as a belt-and-braces rule-2 check (empty
  subject keys never become rows — parity with `subject <> ''`), but it is
  *not* the population mechanism.

Costs and flags (all for PLAN, none fatal):

1. **Schema change**: 14 `CREATE VIEW src_…` statements in `schema.sql`
   (derived objects — no data; rides the wipe; pinned to `sources` by a
   consistency test). Rule 5 resolves `src_*` → physical via the view map.
2. **Joined-secondary divergence**: sugar joins apply humans-only only to the
   *primary's* subject column; an author query over views gets the condition
   on every view it reads. For same-key joins this is equivalent (a human
   primary's same-player secondary is human); flag `join_test.go` /
   `TestJoinedPopulationAlignment` as the arbiter for any case it isn't (M).
3. **Denominators**: today's team denominator counts `round_player_sides`
   **without** a humans filter (`compile.go:1320-1330` — verified: no
   `NOT EXISTS` in that subquery) — distinct-round counts are bot-insensitive
   anyway. Author SQL writing its own denominator over
   `src_round_player_sides` is fine (stricter, not wrong); over the raw table
   — refused by the allowlist rule above. Divergence is toward stricter; note
   it, no pin expected to break (M).
4. **`players`** stays engine-only (the `NOT EXISTS` inside views and sugar
   conditions) — never in author SQL.

---

## 8. Dispositions — manifesto §10 items 1, 5, 6, 7

### §10.1 — the rule-3 prototype (the gating question)

**Disposition: PROVEN.** §1's verdict table: all five shapes survive via the
derivation ladder (append / Go count / window-count pattern) or the declared-
pool path; refusals are shaped messages over existing tokenizer machinery.
The crux does not falsify the plan. The qualifications (§1.7) are scope for
the refusal-copy and docs waves, not architecture.

### §10.5 — editor UX + error copy for shape refusals; docs/refusal-matrix rewrite scope

**Editor UX (scope, not copy — the copy rules in AGENTS apply at
implementation):**

- The expression textarea (`Builder.svelte:1738-1746`) keeps its shape; the
  400 ms debounced live check (`:806-833` → `ValidateExpr`
  `metricservice.go:811`) runs the *full* gate for raw SQL: classify → rule 1
  (statement + allowlist + §7 views) → rule 3 (ladder + `n_pool` cross-check)
  → **save-time probe** for rules 2/3 result checks (§4.3) under the row cap.
  All refusals keep the `ExprError{Message, Pos}` shape so positioning and
  the Builder's error rendering keep working; raw SQL has no token positions
  in the sugar sense — position falls back to statement-level (Pos 0), which
  `Address.normalize` already models (`compile.go:47-50`).
- Refusals are named by rule, in domain language: safety (rule 1), shape
  (rule 2: "returned columns don't match …", "the same key twice …"), N
  (rule 3: "this query can't carry N — … or declare a pool"), furniture
  (rule 4), population (§7: "read `src_events` instead of `events`").
- SQL texture: the provenance panel already displays SQL
  (`Builder.svelte:1118/:1123`); templates = a small set of sugar snippets
  *and* SQL skeletons (fetch / grouped / identity-with-`n`), both in the one
  editor. No second editor surface.

**Docs / refusal-matrix rewrite scope:**

- `src/internal/metrics/doc.go` — stays, but repositioned: it is the **sugar
  reference** (op table, conditions, `next()`/`diff()`/`metric()`,
  subject/denominator rules) for sugar authors and built-in provenance. The
  *user-facing* story moves to the five rules.
- `frontend/src/lib/docs/manuals/metric-language.js` — the manual chapter
  rewrites to: "expressions are SQL with sugar" + the five rules + the rule-3
  ladder + the `src_*` views; the operator/refusal tables shrink to the sugar
  reference (or link to it). Registered surfaces stay pinned by
  `docslockstep`; the strings catalog/tier pins update in the same wave
  (`strings-audit.test.js`).
- **Tests split, not deleted:** the baseline A2 refusal matrix guards *sugar*
  (grammar, anchors, joins, percentile ranges, `next()`/`diff()` positions) —
  it stays, because sugar is still a guarded dialect and built-ins ride it.
  **New pins** for this step: rule-1 allowlist + `tablesOf` edge cases
  (comma joins, CTE, quoted-name fail-closed), rule-2 shape refusals
  (short/extra/duplicate/non-numeric rows), rule-3 refusals (E6a/E6b/E6c
  classes, pool/FROM mismatch, identity-without-n), §7 view equivalence
  (author-over-view == compiler result — the E7a/E7c pair as a test), no-seed-
  `n_pool`, sugar byte-stability (characterization).

### §10.6 — declared-N governance + dialect lock-in

- **How the UI marks power-user metrics:** `metrics.n_pool IS NOT NULL`
  ⇒ *declared N*. The marker is provenance disclosure, not a state — the five
  states and the no-version/stamp-never-render rules are untouched. Surfaces:
  a badge/hint in the Builder next to the expression, and a suffix on the
  Formula tooltip ("declared pool: …") — the tooltip is the honesty surface
  (§2.2). No new metric state, no new pref (the column is the single
  source of truth — one canonical way). Copy follows the domain-language and
  tier rules at implementation time.
- **Governance rule:** built-ins never declare (§2.3 test); user metrics
  declare only through the ladder's row 4; the UI never *offers* declaration
  as a shortcut above derivation (the editor shows the derived `n` plan by
  default; `n_pool` is typed, like SQL, by someone who knows what they're
  doing).
- **Dialect lock-in: accepted, SQLite-only.** Already true in fact — the
  modernc driver, the console, and `ValidateReadOnlySQL` are one dialect;
  `tablesOf`/`lexSQL` are SQLite tokenization; nothing in this design
  abstracts over engines. State it in the manual once so nobody builds a
  portability layer on top.

### §10.7 — sugar vs raw canonical form; what the Formula tooltip shows

**Disposition (recommendation, M — owner may flip):** the tooltip shows the
**authored source** (`metrics.expr`: sugar for built-ins/sugar users, SQL for
raw authors), `"Formula: " + expr` as today; the **canonical expansion**
(`metrics.canonical_sql`, §2.2) is what executes, what dedupe compares, and
what the provenance view displays. Rationale: the tooltip's contract is
disclosure in the language of definition; the built-in doc gate pins
Formula-first *prose* that only stays meaningful against sugar
(`fixtures_test.go:1141-1144`); and dedupe-by-canonical needs the expansion
stored regardless of which text humans read. Dedupe *reports* equivalence on
save (§2.2) rather than silently merging — merging two named metrics is a
user decision, not a normalization.

---

## 9. What PLAN.md must carry from this step

### Decisions made here (carry as settled, with their pins-to-write)

1. **Rule-3 derivation ladder + declared-pool fallback** (§1.0): fetch → Go
   count; aggregate scalar → appended `COUNT(*) AS n` before depth-0 FROM
   (preconditions: aggregate statement, no depth-0 set-op); identity →
   author-emitted window-count `n`, pattern-checked; else `n_pool` with
   `tablesOf` ⊆ cross-check + companion count where cheap; else refuse.
2. **`metrics.n_pool` furniture column** holds the declaration (not a comment,
   not a sidecar); content = `FROM … [WHERE …]` fragment; §10.6 marker =
   `n_pool IS NOT NULL`.
3. **Two-field canonical**: `expr` = authored source (tooltip, editor),
   `canonical_sql` = expansion (executes, dedupe, provenance); seeds'
   canonical backfilled as idempotent derived data at Open (§2.2). Column
   naming/backfill order is implementation detail; the two-field decision is
   not (flip only on owner ruling).
4. **`metric('…')` stays the one reserved construct in raw SQL**; raw
   `metric_values` reads refused (§2.1).
5. **Rule 1**: reuse map (§3.1) + `tablesOf` (fail-closed) + allowlist derived
   from `tableFor(sources) ∪ denominatorTables ∪ denominatorCareerTables ∪
   {players, matches, metric_values} ∪ src_* views ∪ step-2 tick tables`,
   enforced save-time AND run-time; console policy unchanged.
6. **Rule 2**: persisted `metrics.shape` (`kind` + keys + column roles +
   fetch `p`); result validation at preview / save-probe / sweep with the
   four checks; silent short-row skip (`pass.go:523-525`) becomes a refusal;
   format×shape enforced at save (retires `metricformats.js` `filterOnly`
   workaround).
7. **Rule 4**: matrix unchanged (§5 table); raw SQL stores `denominator=''`
   and refuses a declared one.
8. **§7 canonical rule**: author SQL over `src_*` views (humans-only baked),
   `<>''` at output mapping, raw player-carrying tables refused for authors;
   sugar path byte-stable on raw tables.
9. **Formula tooltip = authored source; provenance = canonical expansion.**

### Decisions deferred (with owners)

| Item | Owner / step | Note |
|---|---|---|
| round-grain materialization (where a per-round value row lands) | manifesto §10.4 / step 4-5 | rule 3's N is unaffected; `metric_values` PK has no round column |
| `metrics.shape`/`n_pool`/touched-set column naming, backfill order, exact DDL | PLAN wave B (rides the wipe) | derived data, never versioned |
| lifting the blanket `rule_version` axis for fact-only metrics (§6.3) | PLAN — behavior change, needs pin review | conservative fallback: ship touched-set recording first, lift blanket later |
| rows-kind (`kind: "rows"`) validation + storage | §10.4 / step 4 | shape declaration reserves the slot |
| joined-secondary population divergence verification | PLAN wave C | arbiter: `join_test.go`, `TestJoinedPopulationAlignment` |
| `denominator=''` display implications for raw metrics | PLAN wave C | N carries pool disclosure meanwhile |
| fetch truncation parity audit (today's `Truncated` handling) | PLAN wave C | rule: truncated ⇒ failure, never capped N |
| exact analysis-vs-extract table classification (§6.2 table) | step 2 (R32 Part B) | marked M here; the map is test-pinned to schema either way |
| save-time probe cost budget (one bounded run per save) | PLAN wave C | row cap + timeout already bound it |

### Falsified / corrected assumptions (read before writing the plan)

1. **Nothing in the five crux shapes failed** — the falsification slot is
   empty; §1.7 carries the qualifications (append-unsafety classes E6a–c;
   E3c default-N = outer rows; identity pattern-check is syntactic).
2. **Correction/extension to baseline A4**: the offset mappers don't just
   *exist* — `valuesFromPlan` **silently skips** shape-short rows
   (`pass.go:523-525`), which rule 2 must convert into a refusal; and
   duplicates would today fail only as a PK error at insert, not at the gate.
3. **Baseline A9.6 understates the trap**: output-side bot enforcement is not
   merely insufficient, it is *wrong* for identity/match-subject rows (E4b
   reasoning, §7.2) — which is why §7's rule is input-side.
4. **Baseline A7's "reusable layers 1–4" holds**, with one inversion noted:
   metrics must *allow* `?` binds (sugar) while the console refuses them, and
   the metric leading-keyword set is narrower (`select|with`).

### Verification executed for this document

- Rule-3 prototype: `/tmp/opencode/r3_experiments.sql` → `r3_results.txt`
  (E1–E7 all ran; outputs inlined in §1).
- Compiler emission: throwaway `TestScratchPrintPlans` (deleted; six plans
  quoted in §1/§2).
- Tree state at commit: `dogfood/03-QUERIES.md` is the only change; no app
  code, no schema, no tests touched.
