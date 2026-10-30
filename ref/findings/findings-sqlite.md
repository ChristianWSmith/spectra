# SQLite write-path benchmark: modernc.org/sqlite for a CS2 demo analysis app

Standalone Go benchmark: `/tmp/opencode/sqlitebench` (module `sqlitebench`, `main.go`).
Goal: validate that pure-Go SQLite can absorb a per-match insert of ~10k–15k event rows
with 200–800 B JSON payloads, and justify the planned "one transaction per match" writer.

## Environment & versions

| Item | Value |
|---|---|
| Go | `go1.27.3` (`go 1.27.3` in go.mod) |
| Driver | `modernc.org/sqlite v1.61.0` |
| Transitive | `modernc.org/libc v1.79.0`, `modernc.org/memory v1.12.1`, `modernc.org/mathutil v1.7.1` |
| OS/arch | linux/amd64 |
| CPU | AMD A12-9720P (4C/8T, 2016 mobile APU) — deliberately weak hardware |
| FS | ext4 on `/dev/sda2` (`nobarrier,noatime`), DB in `/var/tmp` (real disk, not tmpfs) |
| Conn settings | DSN `_pragma=busy_timeout(5000)`, `_pragma=journal_mode(WAL)`, `_pragma=foreign_keys(1)`; `SetMaxOpenConns(1)` (single writer) |
| SQLite defaults left alone | `synchronous=2 (FULL)` → one fsync per committed txn; `wal_autocheckpoint=1000` pages |
| Schema creation | 70–83 ms (once, outside insert timings) |

Verified: `journal_mode=wal`, `foreign_keys=1`, `busy_timeout=5000`.

## Workload (defaults, all flags override-able)

Per match: `hurt=566 + fire=3213 + death=146 = 3,925` `events` rows + `generic=7,000` +
`chat=200` = **11,125 event rows**, plus `rounds=22`, `players=10`, `player_stats=10`,
`matches=1` → **11,168 total rows/match** (inside the 10k–15k target band).
Payload sizes: `detail_json≈400 B`, `raw_json≈300 B` (per event), `payload_json≈200 B`
(generic) → ~4.1 MB of JSON text per match. Schema: `matches, players, player_stats,
rounds, events, generic_events, chat` with FK → `matches(id) ON DELETE CASCADE`,
PKs `(match_id, seq)` on events and secondary index `events(match_id, kind, tick)`
(+ indexes on `generic_events(match_id,name,tick)` and `chat(match_id,tick)`).

Writer under test: `db.Begin()` → `tx.Prepare` one statement per table → all rows →
`tx.Commit()`. Naive comparison: identical prepared statements, `BEGIN/COMMIT` per row.

3 full runs on ext4 (ext4-run1/2/3.log in the bench dir); a 4th run used tmpfs (`/tmp`)
and is called out where relevant.

## 1. Single match insert (1 txn, 11,168 rows) — median of 5 runs after 1 warmup

| run | median | min | throughput |
|---|---|---|---|
| ext4 #1 | **288.4 ms** | 252.7 ms | 38,730 rows/s |
| ext4 #2 | **303.7 ms** | 247.1 ms | 36,771 rows/s |
| ext4 #3 | **315.4 ms** | 266.6 ms | 35,406 rows/s |
| tmpfs (RAM) | 207.4 ms | 191.4 ms | 53,838 rows/s |

Per-run values (ext4): 253/288/315/307/272 ms, 282/304/310/317/247 ms, 315/290/355/328/267 ms
— stable, no warm-cache outlier beyond the discarded warmup.

## 2. Library scale: 100 matches (one txn each, same DB)

| run | insert total | per-match avg | throughput | wall (incl. data gen) |
|---|---|---|---|---|
| ext4 #1 | 30.816 s | 308.2 ms | 36,241 rows/s | 33.8 s |
| ext4 #2 | 30.843 s | 308.4 ms | 36,209 rows/s | 34.1 s |
| ext4 #3 | 32.119 s | 321.2 ms | 34,771 rows/s | 35.7 s |
| tmpfs | 23.118 s | 231.2 ms | 48,308 rows/s | 26.3 s |

Scale stability (run #3): first 20 matches avg 302.1 ms vs last 20 avg 317.8 ms
→ **1.05× growth** over 508 MB of DB; insert cost stays flat as the library grows.

## 3. Batched txn per match vs naive txn per row

| path | per match (11,168 rows) | rows/s | ratio |
|---|---|---|---|
| batched, 1 txn/match (planned) | 288–315 ms | ~36–39 k | 1× |
| naive, 1 txn/row (ext4, `synchronous=FULL`) | 17.8 / 19.4 / 21.9 s | 511–628 | **58–76× slower** |
| naive on tmpfs (no real fsync) | 971 ms | 11,499 | 4.7× slower |

Naive costs ~1.7 ms/txn (fsync-dominated on ext4). Extrapolated: loading a 100-match
library naive ≈ 30+ minutes vs ~31 s batched. The batched path pays 1 fsync/match;
CPU (b-tree + memcpy) dominates it instead — which is why the tmpfs/disk gap there is
only 207→288 ms. This alone justifies the single-transaction-per-match design.

## 4. Resulting DB size after 100 matches (WAL checkpointed `TRUNCATE`)

- `db = 507.7 MB`, `-wal = 0 B` (checkpointed), `-shm = 32 KB` → **5.077 MB/match**
- Identical across all 3 runs (deterministic payloads).
- ~4.1 MB/match is raw JSON text; the remaining ~1 MB is row/index overhead (~24%).

## 5. Read smoke — `SELECT * FROM events WHERE match_id=? AND kind=? ORDER BY tick`

Covered by `events(match_id, kind, tick)` index (no sort step). Timed over all 100 matches:

| kind | rows returned | avg/query | total for 100 queries |
|---|---|---|---|
| `weapon_fire` (3,213 rows ≈ 2.2 MB JSON/query) | 321,300 | 29.5 / 32.0 / 80.2 ms | 3.0 / 3.2 / 8.0 s |
| `player_death` (146 rows) | 14,600 | 2.3 / 2.6 ms | 0.23 / 0.26 s |

The 80 ms outlier was the run immediately after writing 508 MB (cold page cache).
ms-scale per query as targeted; the heavy kind's cost is payload materialization
(`SELECT *` pulls ~2.2 MB of JSON through `database/sql` per match) — a narrow column
list or JSON on demand would cut it further.

## 6. JSON marshal cost (3,925 events, detail+raw, median of 7 reps after warmup)

Same logical output (2.2 MB per rep for all three variants):

| approach | µs/event | for all 10,925 JSON rows/match | vs `json.Marshal` |
|---|---|---|---|
| `json.Marshal` (struct → new `[]byte` each time) | 9.22 / 9.53 / 10.09 | 100.7 / 104.1 / 110.2 ms (≈ 32–38% of a match insert) | 1× |
| `json.Encoder` into reused `bytes.Buffer`, `SetEscapeHTML(false)` | 7.67 / 8.46 / 8.66 | 83.8 / 92.4 / 94.6 ms | 11–17% faster |
| hand-built string + pre-marshaled shared fragments (per-round / per-flag / per-steam cache) | 2.55 / 2.45 / 2.37 | 27.8 / 26.8 / 25.9 ms | **~72–76% faster (~3.6×)** |

Delta: per-event `json.Marshal` adds **~73–84 ms/match** vs hand-built — on this weak
CPU that is roughly a third of the whole insert. Not a blocker (0.30 s → 0.40 s), but
the single easiest win: reuse a buffer or assemble the small detail payload directly,
and reuse shared context blobs (`json.RawMessage`/pre-marshaled) instead of re-marshaling
them inside every event.

## Verdict

**Yes — modernc.org/sqlite is comfortably fast enough for these volumes.**

- **Single match insert: ~0.29–0.32 s** (median of 5, 11,168 rows, one transaction) —
  ~3× under the 1 s target, on a 2016 mobile CPU. A current desktop/laptop should land
  near 0.1–0.15 s. Headroom also exists in the workload flags (the tested point sits at
  the low end of the 10k–15k row band; scaling is linear).
- **100-match library: ~31 s insert (~35 s wall) at ~35–36 k rows/s**, reproducible to
  ±2%, and flat as the DB grows (1.05× first-20 vs last-20). That is "in seconds" as a
  bulk import, not an interactive operation — reasonable for a background
  "import/scan library" job; do it with progress reporting rather than blocking a UI.
- **DB size: 5.077 MB/match (507.7 MB / 100 matches)** after WAL checkpoint. Expect
  ~4–6 MB/match while payloads are stored at 200–800 B/event; if footprint matters,
  make `raw_json` optional/sparse or drop it after parsing — it is ~half the payload.
- **Design confirmed:** one transaction per match is **58–76× faster** than one per row
  on disk (0.31 s vs 19.4 s per match); naive would need ~30 minutes for the same 100
  matches. Keep the batch writer as planned — do not auto-commit per row.
- **Reads are fine:** indexed kind query returns ms-scale results (2–32 ms typical per
  match; 80 ms worst-case cold cache on a 3,213-row/2.2 MB result).
- **JSON marshal matters more than the DB does:** `json.Marshal` per event costs
  ~100 ms/match (~⅓ of insert time); reusing an encoder buffer gets ~15%, a hand-built
  payload with shared-fragment reuse ~75%. Budget for the cheap approach if
  per-match latency matters, otherwise accept ~100 ms and stay simple.

Caveats: single writer (`MaxOpenConns(1)`), FK checks enabled, `synchronous=FULL`,
local SSD (not NFS/network storage — WAL over NFS would need separate validation),
synthetic payloads sized to spec rather than real parsed demos. Numbers are from the
bench binary in `/tmp/opencode/sqlitebench` (`go build . && ./sqlitebench`; flags for
every row count/payload size; logs `full-run.log`, `ext4-run1..3.log`).
