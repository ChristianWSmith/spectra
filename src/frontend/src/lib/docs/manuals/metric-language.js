// The metric-language manual — the REAL content chapter of the user
// guide (user-guide.js composes these sections in at its
// metric-language position; every other guide section is an explicit
// placeholder until written).
//
// PORTED VERBATIM from the researcher's reference draft (2026-11-14),
// whose accepted AND refused examples were executed against the real
// engine (69/69 checks — see the draft's accuracy appendix). The
// wording is content, not chrome: do not "improve" a claim without
// re-verifying it against src/internal/metrics (doc.go / parse.go /
// whitelist.go / compile.go). Two mechanical port notes: the draft's
// `###` subsections are `# here` (the section title owns the popup's
// <h2>, so content headings start at <h3> — no heading-level skips),
// and the draft's own TOC was dropped (the popup renders its own).
//
// RECONCILED 2026-11-14 (manual-content reconciliation, after W1's
// merge): the `sources` and `player-anchor` sections re-based on the
// 14-source whitelist (four new sources — round_classifications,
// round_side_classes, round_player_sides, engagements_victim — and the
// grown playerSources anchor list, whose verbatim refusal message is
// re-quoted below), and `built-in-metrics` went COUNT-FREE (the seed
// catalogue grew 16 → 58 in that wave and is owner-growable; prose
// never hard-codes a count — names stay listed instead). Re-verify
// against whitelist.go / doc.go before touching those three sections.
//
// SUBJECT PASS 2026-11-18 (metrics expansion Phase 7 — the falsified-
// claim sweep): "always per player" → the subject model (player/match/
// team, §3.1/§3.4), every source's "cannot lead" claim re-based on
// anchored-for-subject (whitelist.go sourceSubject/teamSources +
// compile.go's three anchor messages, quoted verbatim), the operators
// table gained argmax/next/diff with their positions/refusals
// (parse.go/doc.go wordings), the scope section gained the subject ×
// scope matrix, denominators the team reading, missing-data the
// identity N, a new `partitions` section (§3.2), and
// `built-in-metrics` re-listed against the seed block (still
// count-free). Every quoted message was re-executed against the engine
// in this pass.
export const metricLanguageSections = [
  {
    id: 'metric-language',
    title: 'Metric language',
    blocks: `A **metric** is one number for one **subject**: "this player's trade rate", "this match's lost equipment", "this team's force-win rate". Everything in the language exists to let you state such a number precisely.

Three properties are worth knowing before anything else:

- **It is always about one subject** — a **player**, a **match** or a **team**. Every formula must be anchored for its subject: the leading source has to name what the number is about (see [Anchors](#player-anchor)).
- **Saved metrics are kept, not recalculated on the spot.** Once you save a metric and it has been worked out, the app keeps the value and every screen reads that kept value — reports and scoreboards do not re-derive it each time they open. If something changes that affects it (new matches imported, the analysis rules updated), it is worked out again in the background and the slot waits honestly until then (see [Missing data](#missing-data)). An expression you have **not** saved is the exception: it is calculated on demand while you preview it.
- **Every metric has a scope** — one match, or the whole library (a player's career is their library-wide scope; a match or team value always belongs to a single match) (see [Scope](#scope)).

A saved metric also carries a written explanation of its own formula — one is required when you save — shown in the ⓘ tooltip next to it, so nobody has to read the expression to know what a number means.`,
  },
  {
    id: 'writing-an-expression',
    title: 'Writing an expression',
    parent: 'metric-language',
    blocks: `The whole language is one shape:

\`\`\`
from <sources>: <aggregation>, <aggregation>, …
\`\`\`

For example:

\`\`\`
from player_stats: ratio(sum(kills), sum(deaths))
\`\`\`

- **Sources** come after \`from\`, separated by commas, and are closed by a \`:\`. One source is the usual case; a comma list lets you pull in extra data (see [Combining sources](#combining-sources)). The first source always leads.
- **Aggregations** follow the colon, separated by commas. Each one is \`op(...)\`. The **first** aggregation is the value the metric shows; further ones are carried along for provenance.
- An optional \`AS name\` label may follow any top-level aggregation. It is a label only — it does not change the value.
- Keywords are case-insensitive: \`from\`, \`FROM\`, \`sum\`, \`SUM\`, \`where\`, \`WHERE\` all work. Source and column names are **not**: they must be spelled exactly as listed here — \`Kills\` is wrong, \`kills\` is right.
- Text in \`-- …\` (to end of line) or \`/* … */\` is a comment and is ignored. String literals use single quotes; write \`''\` inside a string for a literal quote (\`text = 'it''s fine'\`).
- Practical limits: 8192 bytes of text, up to 16 aggregations, conditions nested up to 64 levels deep.
- Errors point at the place in your text that failed, so the builder can show you the exact spot.`,
  },
  {
    id: 'sources',
    title: 'Sources',
    parent: 'metric-language',
    blocks: `A **source** is one of the bodies of stored data a formula may count and add up over; each has a fixed set of columns you may mention. Every source the language offers is listed below.

| Source | One row is … | Anchors on (the player column) |
|---|---|---|
| \`events\` | one recorded match event (kill, damage, flash, grenade, bomb action, round boundary) | \`attacker\` |
| \`engagements\` | one duel record: an opening, a trade, or a death that was traded or left untraded | \`a_steam\` |
| \`rounds\` | one round | — none |
| \`player_stats\` | one player's line in one match (the scoreboard numbers) | \`steam_id\` |
| \`player_round_stats\` | one player's numbers in one round | \`steam_id\` |
| \`round_economy\` | one side's economy in one round | — none |
| \`clutches\` | one detected 1vN clutch | \`steam_id\` |
| \`utility_events\` | one grenade throw paired with its detonation | \`thrower\` |
| \`chat\` | one chat line | \`steam_id\` |
| \`match_trade_opps\` | the trade opportunities analytics recorded for one player in one match | \`steam_id\` |
| \`round_classifications\` | one round's buy-type label as the analysis decided it, with how sure the decision is | — none |
| \`round_side_classes\` | one side's buy type in one round, with the reason behind it | — none |
| \`round_player_sides\` | which side a player was on in one round | \`steam_id\` |
| \`engagements_victim\` | the same duel records as \`engagements\`, anchored on the player who died | \`b_steam\` |

# events

Every recorded event of a match: kills, damage, blinding, grenade and bomb actions, round start/end. Rows with no acting player (an event nobody caused) are never counted.

**Columns:** \`match_id\`, \`seq\`, \`tick\`, \`round\`, \`kind\`, \`attacker\`, \`victim\`, \`assister\`, \`weapon\`, \`headshot\`, \`wallbang\`, \`noscope\`, \`through_smoke\`, \`attacker_blind\`, \`attacker_inair\`, \`assisted_flash\`, \`distance\`, \`hitgroup\`, \`dmg\`, \`site\`, \`pos_x\`, \`pos_y\`, \`pos_z\`, \`same_side\`, \`capped_dmg\`

\`same_side\` marks damage that stayed on one team (both sides known and equal — friendly fire); it is 0 for enemy damage and for rows whose sides are unknown, so \`where … and same_side = 0\` counts enemy damage only.

\`capped_dmg\` is that hit's damage credit: the raw \`dmg\` clamped to the victim's remaining health in the order the hits landed (a 115-damage hit on a 10-HP player credited 10), and 0 for play after the match ends. Sum it instead of \`dmg\` whenever the total should match the boards' HP-capped damage.

# engagements

Duel records the analysis pass derives from the event feed: \`opening\` (first blood), \`trade\` (answering a teammate's death), \`traded\` and \`untraded\` deaths. Each row pairs the actor (\`a_steam\`) with the other player (\`b_steam\`) and records who won the duel (\`won_by\`) and how far apart they were.

**Columns:** \`match_id\`, \`seq\`, \`tick\`, \`round\`, \`kind\`, \`a_steam\`, \`a_name\`, \`b_steam\`, \`b_name\`, \`distance\`, \`won_by\`

# rounds

One row per round: who won it and why, how long it lasted, the MVP, each side's equipment value, the bomb site, and which player drew first blood (\`first_kill_steam\`) and who died first (\`first_death_steam\`). A round belongs to no single player and carries no team column, so a **player-** or **team-subject** metric cannot be led by it; a **match-subject** metric may lead with it (the shipped Winner equipment value advantage and Pistol → next round both do) — see [Anchors](#player-anchor).

**Columns:** \`match_id\`, \`number\`, \`winner\`, \`reason\`, \`duration_s\`, \`start_tick\`, \`end_tick\`, \`mvp\`, \`mvp_reason\`, \`equip_ct\`, \`equip_t\`, \`bomb_site\`, \`freeze_end_tick\`, \`first_kill_steam\`, \`first_death_steam\`

# player_stats

The classic scoreboard line, one row per player per match: kills, deaths, assists, headshots, damage dealt and taken, ADR, rounds played, entry and opening kills/deaths, trade kills, best streak, multi-kill tiers (2K–5K), utility damage, enemies flashed, times flashed, bomb plants and defuses, and money spent.

**Columns:** \`match_id\`, \`steam_id\`, \`side\`, \`name\`, \`kills\`, \`deaths\`, \`assists\`, \`flash_assists\`, \`headshots\`, \`teamkills\`, \`suicides\`, \`mvps\`, \`score\`, \`total_damage\`, \`damage_taken\`, \`shots\`, \`hits\`, \`adr\`, \`hs_pct\`, \`rounds_played\`, \`entry_kills\`, \`entry_deaths\`, \`opening_kills\`, \`opening_deaths\`, \`trade_kills\`, \`best_streak\`, \`two_k\`, \`three_k\`, \`four_k\`, \`five_k\`, \`utility_damage\`, \`enemies_flashed\`, \`flashed_times\`, \`bomb_plants\`, \`bomb_defuses\`, \`money_spent_total\`, \`team\`, \`won\`, \`map\`

\`team\` is the stamped team each player finished on (the team-subject anchor/filter), \`won\` the 0/1 match result the win seeds sum, and \`map\` the map-partition column.

# player_round_stats

One row per player per round: kills, assists, deaths, whether the death was traded, whether they survived, the KAST flag for that round, damage and utility damage, and the money and equipment they started the round with.

**Columns:** \`match_id\`, \`round\`, \`steam_id\`, \`name\`, \`kills\`, \`assists\`, \`deaths\`, \`traded\`, \`survived\`, \`kast\`, \`dmg\`, \`util_dmg\`, \`money_start\`, \`equip\`, \`spent\`, \`rule_version\`, \`side\`, \`won\`

\`side\` is the per-round side sample (the side-partition carrier) and \`won\` the per-round win flag the side win-rate sums.

# round_economy

One row per round **per side**: equipment value, sampled money, money spent, and the free pistol-round value. A side belongs to no single player, so a **player-subject** metric cannot be led by it; it carries the stamped team column, so a **match-** or **team-subject** metric may lead with it — see [Anchors](#player-anchor).

**Columns:** \`match_id\`, \`round\`, \`side\`, \`equip_value\`, \`money_sampled_sum\`, \`money_samples\`, \`spent\`, \`free_pistol_value\`, \`team\`

# clutches

One row per detected 1vN situation: how many opponents the lone player was up against when it began (\`size\` — a 1v3 has size 3), who was in it, when it started and ended, the bomb state, hit points left, equipment, and whether it was won (\`won\`, stored as 0/1).

**Columns:** \`match_id\`, \`round\`, \`size\`, \`steam_id\`, \`name\`, \`start_tick\`, \`end_tick\`, \`bomb_state\`, \`hp_left\`, \`equip\`, \`won\`, \`replay_anchor\`

# utility_events

One row per grenade throw paired with its detonation: who threw it (\`thrower\`), what kind (\`he\`, \`flash\`, \`smoke\`, \`molotov\`, \`decoy\`), where and when it was thrown (\`throw_x\`, \`throw_y\`, \`throw_tick\`), where and when it detonated (\`det_x\`, \`det_y\`, \`tick\`), how much damage it did, how long the flash blinded, and the site. A detonation with no matched throw keeps \`throw_tick\` at 0 and its throw coordinates empty — a throw that was never observed is never invented.

**Columns:** \`match_id\`, \`seq\`, \`tick\`, \`round\`, \`thrower\`, \`thrower_name\`, \`kind\`, \`throw_tick\`, \`throw_x\`, \`throw_y\`, \`det_x\`, \`det_y\`, \`damage\`, \`flash_ms\`, \`site\`

# chat

One row per chat line, plus the speaker's channel and the provenance columns for encrypted chat (\`decrypted\`, \`key_source\`). \`text\` is available so you can count exact phrases.

**Columns:** \`id\`, \`match_id\`, \`tick\`, \`round\`, \`steam_id\`, \`name\`, \`text\`, \`kind\`, \`channel\`, \`decrypted\`, \`key_source\`

# match_trade_opps

One row per player per match with the trade opportunities the analysis recorded for them (\`opps\`) and how many they missed (\`missed\`). This source is **sparse**: a player who had no opportunities has no row, and bots are never written here — see [Missing data](#missing-data).

**Columns:** \`match_id\`, \`steam_id\`, \`opps\`, \`missed\`

# round_classifications

One row per round: the round's buy-type label as the analysis decided it (\`label\`), how sure that decision is (\`confidence\`), the rules version it was decided under, and the reason in words (\`explanation\`). The label describes the whole round, not one player and not one team, so a **player-** or **team-subject** metric cannot be led by it (a **match-subject** one may) — see [Anchors](#player-anchor). The label and the reason exist for **filtering** in a joined formula (\`from player_round_stats, round_classifications: count(where label = 'full')\`), never as values to add up.

**Columns:** \`match_id\`, \`round\`, \`label\`, \`confidence\`, \`rule_version\`, \`explanation\`

# round_side_classes

One row per round **per side**: that side's buy type for the round (\`class\`) and the reason it was classified that way (\`why\`) — what the Economy view's per-side chips show. A side belongs to no single player, so a **player-subject** metric cannot be led by it; it carries the stamped team column, so a **match-** or **team-subject** one may — see [Anchors](#player-anchor).

**Columns:** \`match_id\`, \`round\`, \`side\`, \`class\`, \`why\`, \`team\`

# round_player_sides

One row per player per round: which side (\`ct\` or \`t\`) they were on in that round — a freeze-time-end sample for every counted round, so a player's side stays right across the halftime switch. It names a player in every row, so it can lead a formula (and it carries the stamped team column too), and it is the player-side key the per-side classes pair with.

**Columns:** \`match_id\`, \`round\`, \`steam_id\`, \`side\`, \`team\`

# engagements_victim

The same duel records as \`engagements\` — one row per duel — but anchored on the player who **died** (\`b_steam\`): the victim's side of every duel. Count how often a player dropped first in the round (an opening), fell to a trade kill, or died with their death answered (\`traded\`) or not (\`untraded\`). Exactly the same columns as its twin; what differs is which player each row is about.

**Columns:** \`match_id\`, \`seq\`, \`tick\`, \`round\`, \`kind\`, \`a_steam\`, \`a_name\`, \`b_steam\`, \`b_name\`, \`distance\`, \`won_by\`

> **Not available as columns:** payload columns that hold JSON or lists (for example the per-weapon damage breakdowns) are deliberately excluded; a metric is a single number, and there is no way to break a value down by category inside the language. Two stored columns of \`utility_events\` are therefore named nowhere above: \`affected\` (the JSON list of players a throw hit) and \`trajectory_ref\` (a per-throw trajectory reference nothing fills yet).`,
  },
  {
    id: 'player-anchor',
    title: 'Anchors',
    parent: 'metric-language',
    blocks: `Every metric answers a question about one **subject** — a player, a match or a team — and the source that *leads* your formula must be **anchored for that subject**. The subject is a property you pick for the metric (like its scope or denominator), not text you write in the expression; a formula you are drafting starts as a player metric.

# Leading for a player subject

The leading source must name a player in every row. \`rounds\`, \`round_economy\`, \`round_classifications\` and \`round_side_classes\` describe rounds and sides, not people, so they cannot lead a player metric. Starting with one is refused immediately:

\`\`\`
from rounds: count()
\`\`\`

\`\`\`
expression is not player-anchored: primary source "rounds" has no player
subject — a metric's value must be per player (player sources: events,
engagements, player_stats, player_round_stats, clutches, chat,
utility_events, match_trade_opps, round_player_sides,
engagements_victim; round-grain sources can only join a
player-anchored expression)
\`\`\`

The sources that **can** lead a player metric are \`events\`, \`engagements\`, \`player_stats\`, \`player_round_stats\`, \`clutches\`, \`chat\`, \`utility_events\`, \`match_trade_opps\`, \`round_player_sides\` and \`engagements_victim\` — each one names a player in every row (\`attacker\`, \`a_steam\`, \`b_steam\`, \`thrower\` or \`steam_id\`).

# Leading for a match or team subject

A **match** subject needs match grain — and every source carries the match id, so **any source may lead** it, round sources included (the shipped Winner equipment value advantage leads with \`rounds\` itself).

A **team** subject needs the stamped team column, which four sources carry (\`player_stats\`, \`round_economy\`, \`round_side_classes\`, \`round_player_sides\`). Leading with anything else is refused the same way:

\`\`\`
expression is not team-anchored: primary source "rounds" has no team column
(team sources: player_stats, round_economy, round_side_classes,
round_player_sides)
\`\`\`

The rule is about the *first* source only. Round-level sources remain perfectly usable as extra sources behind an anchored lead (shown here for a player metric):

\`\`\`
from engagements, rounds: count()          -- allowed: engagements leads
from rounds, events: count()               -- refused: rounds leads
\`\`\``,
  },
  {
    id: 'operators',
    title: 'Operators',
    parent: 'metric-language',
    blocks: `| Operator | What it produces |
|---|---|
| \`count()\` | the number of rows in scope |
| \`count(<condition>)\` | the rows where the condition holds |
| \`sum(col)\` / \`sum(a + b + …)\` | a total — the one place columns may be added |
| \`avg(col)\` / \`min(col)\` / \`max(col)\` | mean, smallest, largest — read over one column |
| \`min(a, b, …)\` / \`max(a, b, …)\` | the least/greatest of whole values and numbers — at least two (see below) |
| \`stddev(col)\` | population standard deviation (σ), never below 0 |
| \`percentile(p, col)\` | the p-quantile of that subject's own values, \`p\` between 0 and 1 |
| \`median(col)\` | shorthand for \`percentile(0.5, col)\` |
| \`ratio(a, b)\` | \`a ÷ b\`, with a zero denominator answered honestly (see below) |
| \`metric('name')\` | another saved metric's value — see [Metric references](#metric-references) |
| \`argmax(<col>)\` | the identity winner — a WHO, not a number (see below) |
| \`next(<col>)\` | the next round's value — inside a condition only (see below) |
| \`diff(a, b, <condition>)\` | a per-row oriented subtraction — only inside \`sum\`/\`avg\` (see below) |

Anything else is refused at that position: an unknown name gets the list of valid operators in the message (\`unknown aggregation "x" (valid: count, sum, avg, min, max, stddev, percentile, median, ratio, metric, argmax)\`), while \`exists(...)\` and \`next(...)\` each answer with a message of their own — they are conditions and can never be values — and \`diff(...)\` states it belongs inside \`sum\`/\`avg\` (see [Conditions and filters](#conditions-and-filters)).

# count

\`\`\`
from player_stats: count()
from events: count(where kind = 'kill' and headshot)
from events: count(headshot)
\`\`\`

\`count()\` counts every row. A condition counts only the rows that satisfy it; \`where\` is optional in \`count\`, so \`count(kind = 'kill')\` and \`count(where kind = 'kill')\` mean the same thing. A bare operand means "is set": \`count(headshot)\` counts the rows where \`headshot\` is not zero.

# sum, avg, min and max

\`\`\`
from player_stats: sum(total_damage)
from player_stats: sum(where side = 'ct', total_damage)
from events: min(tick), max(tick)
\`\`\`

In their **aggregate** form each takes **one** column: they read that column row by row and reduce it over the rows in scope. An optional filter comes first, after \`where\`, separated by a comma: \`sum(where <condition>, col)\` keeps only the rows the condition selects.

\`min\` and \`max\` also have a second, **value** form: give them at least two computed values or numbers and they answer the least/greatest of them — the operator itself reads no column; it only compares the finished values:

\`\`\`
from player_stats: max(sum(deaths), 1)
from player_stats: ratio(sum(kills), max(sum(deaths), 1))
\`\`\`

Which form you get is decided by what follows the bracket: \`where\` or a plain column name means the aggregate form above; a number, a \`-\`, or another aggregation (\`sum(\`, \`count(\`, …) means the value form. In the value form **every argument must be a whole aggregation or a number** — bare columns are refused (\`max(kills, deaths)\` is an error), strings are refused, and there must be at least two (a single argument is the aggregate form over one column). A nested \`percentile\`, \`median\`, \`ratio\` or \`metric()\` is refused there too. A \`-\` before a number works: \`max(sum(kills), -1)\`.

# sum with several columns

\`sum\` is the only operator that accepts added columns:

\`\`\`
from player_stats: sum(opening_kills + opening_deaths)
from player_stats: ratio(sum(kills + assists), sum(deaths))
\`\`\`

Adding inside \`sum\` is the same as adding the separate totals, which is why it is allowed and nothing else is: \`avg(kills + deaths)\`, \`min(a + b)\` and \`sum(kills) + sum(deaths)\` are all refused. Columns only — no numbers, no parentheses, no \`metric()\` inside the chain.

# stddev

\`\`\`
from player_stats: stddev(adr)
\`\`\`

The population standard deviation of that player's own values. It is clamped at 0 so rounding noise can never produce a negative spread.

# percentile and median

\`\`\`
from events: percentile(0.95, dmg)
from events: median(dmg)
\`\`\`

\`p\` must be between 0 and 1 (so \`percentile(1.5, dmg)\` is refused). The percentile is taken over **that subject's own rows in scope** — each subject gets its own distribution, interpolated between their sorted values — and \`N\` reports how many values went into it. \`median(col)\` is exactly \`percentile(0.5, col)\`.

# ratio

\`\`\`
from player_stats: ratio(sum(kills), sum(deaths))
\`\`\`

\`ratio(a, b)\` divides \`a\` by \`b\`. Both halves must be aggregations from this list — \`count\`, \`sum\`, \`avg\`, \`min\`, \`max\`, \`stddev\` or \`metric('name')\` — and never another \`ratio\` or a \`percentile\`. Either half may also be a \`min\`/\`max\` **value** form, which is how a floor travels inside the formula: \`ratio(sum(kills), max(sum(deaths), 1))\` divides a deathless subject's kills by 1 instead of answering 0 beside N. If \`b\` is zero and nothing floors it, the value comes out as **0 beside N** rather than an error or an invented number (see [Missing data](#missing-data)).

# argmax

\`\`\`
from player_stats: argmax(kills)
\`\`\`

\`argmax(<col>)\` makes the metric's value a **who**, not a number: it takes the lead's pool of players in each match and emits the row with the highest \`<col>\` — that player's key stored beside the winning value, rendered as a name everywhere it shows (a key that resolves to no name shows a dash, never a raw id). Exactly one shape is legal: the **sole** aggregation of a **match-subject** metric, on a player-anchored lead, with **no denominator** (its sample size is the pool itself — see [Missing data](#missing-data)). Every other shape refuses with its own message: a player or team subject (\`argmax() needs subject "match"\`), a career (profile) scope — a career has no match pool to choose from —, a lead with no player column (\`argmax() needs a player-anchored lead\`), any other aggregation beside it (\`argmax() is the whole expression\`), nesting inside \`ratio()\`/\`max()\` (the shared "cannot be nested" copy) and a denominator (\`argmax() takes no denominator\`). Ties break on the player key ascending, so the same pool always picks the same winner.

# next

\`\`\`
from rounds, round_classifications: ratio(count(where label = 'pistol' and winner != '' and next(winner) = winner), count(where label = 'pistol' and winner != ''))
\`\`\`

\`next(<col>)\` reads that column from the **next round's row** of the leading source — the row of the same match with the next round number. It is legal exactly where a condition is accepted (inside \`count(...)\` or a \`where\` filter, including \`diff()\`'s orientation condition); in every value position it refuses with \`next() is a round window — it can only appear where a condition is accepted (count()'s argument or a where filter); it reads another round's row, never this row's value\`. Only round-grain sources (\`rounds\`, \`round_classifications\`) may carry it, the column is the leading source's own, and the window ignores filters — it is the next round of the match, never the next row your own conditions selected. The match's last round has no next round, so a comparison over it is unknown and the row never counts as held. One level only: \`next(next(...))\` and \`next()\` inside \`exists()\` are refused.

# diff

\`\`\`
from rounds: avg(where winner != '', diff(equip_ct, equip_t, winner = 'ct'))
\`\`\`

\`diff(<a>, <b>, <condition>)\` subtracts two values **of the same row**: \`<a> − <b>\` where the condition holds, \`<b> − <a>\` otherwise — which is how one formula says "winner's equipment value minus loser's" over rounds whose winner flips. It appears exactly as \`sum(...)\`'s or \`avg(...)\`'s column argument and nowhere else — never an aggregation itself, never a ratio operand, chain term or condition (\`diff() is a row difference — it appears only as sum()'s or avg()'s argument, never as an aggregation, a value term, a chain term or a condition\`). Exactly three arguments: two columns of the leading source and the orientation condition (\`diff() takes exactly three arguments: two columns and the orientation condition (diff(<column>, <column>, <condition>))\`). \`exists()\` may not sit inside that condition: \`exists() cannot appear inside diff() — put the existence filter in the aggregation's where or count()\`. And aggregate arithmetic is still not part of the language — \`sum(a) - sum(b)\` stays refused: \`diff()\` is the subtraction, done per row before anything is totalled.

# Conditions and filters

Conditions select rows, and appear in \`count(...)\` and in the \`where …,\` filter prefix of \`sum\`/\`avg\`/\`min\`/\`max\`/\`stddev\`/\`percentile\`/\`median\`.

- **Operands:** a column, a number, a \`'string'\`, or \`true\`/\`false\`.
- **Comparisons:** \`=\`, \`!=\`, \`>\`, \`>=\`, \`<\`, \`<=\`.
- **Logic:** \`and\`, \`or\`, \`not\`, and parentheses for grouping.
- A bare operand means "is set": \`count(headshot)\`.

\`\`\`
from events: count(where dmg >= 50 and (kind = 'kill' or not headshot))
from player_stats: sum(where side = 'ct', total_damage)
\`\`\`

Conditions are row-by-row tests over the source's own columns — with ONE exception, \`exists(<condition>)\`: it asks whether **another row of the same source** matches the condition. Inside its parentheses the bare columns name that other row, \`outer.<column>\` names the row being tested, and the app pairs the two rows on the same match by itself:

\`\`\`
from events: count(where kind = 'damage' and exists(kind = 'kill' and tick = outer.tick and attacker = outer.attacker and victim = outer.victim))
\`\`\`

That counts damage whose kill landed on the same tick for the same attacker and victim — this player's damage that converted into a kill. \`exists()\` is accepted exactly where a condition is (a \`count(...)\` argument or a \`where\` filter), never nests inside itself, never appears as a value, and is refused inside \`diff()\`'s orientation condition (\`exists() cannot appear inside diff() — put the existence filter in the aggregation's where or count()\`); \`next()\` is refused inside it too — its subquery already scans other rows of the source.

Everywhere else the row-by-row rule holds, so **arithmetic and \`metric()\` are not allowed inside conditions**: \`count(where a + b > 0)\` is a syntax error, and a \`metric()\` reference in a condition is refused with \`metric() is a value reference — it cannot appear in a condition or filter (they are row-level predicates over source columns)\`.`,
  },
  {
    id: 'combining-sources',
    title: 'Combining sources',
    parent: 'metric-language',
    blocks: `A comma list after \`from\` brings a second (or third) source into the same formula:

\`\`\`
from player_stats, match_trade_opps: ratio(sum(trade_kills), sum(opps))
\`\`\`

- **You never describe how the rows line up.** The app works out the pairing from the data itself: the first source leads, and each extra source is matched to it on the fields they share (match, round, player, side). There is no syntax for writing a join condition, and none is needed.
- **Matching is generous, not strict.** A player with no matching row in the extra source still gets their value (the missing side simply contributes nothing, which shows up as 0 beside N) instead of disappearing.
- **Double counting is refused.** An extra source may only be used if its rows are uniquely identified by the shared fields; otherwise every leading row would be multiplied and every \`count()\`/\`sum()\` would be inflated. For example:

  \`\`\`
  from engagements, rounds: count()          -- fine: rounds is unique per round of a match
  from player_stats, rounds: count()         -- refused
  cannot join source "rounds" to "player_stats": secondary "rounds" is not
  unique on the shared dimensions (its primary key/unique key must consist
  entirely of join dimensions: match, round, player, side)
  \`\`\`

- **Numbers come from the lead, or from a one-to-one partner.** \`sum\`/\`avg\`/\`min\`/\`max\`/\`stddev\`/\`percentile\` may read a column from the extra source only when the pairing is one-to-one, so a coarse number can never be repeated at a finer grain:

  \`\`\`
  from engagements, rounds: sum(duration_s)
  value column "duration_s" comes from secondary source "rounds", but the join
  is not 1:1 — value columns must come from the primary (or from a 1:1 join)
  \`\`\`

  Filters have no such restriction, because filtering never multiplies rows: \`from engagements, rounds: count(where duration_s > 30)\` is fine.
- **Shared column names must be unique in your list.** If two listed sources both own a column, it cannot be named on its own — \`from events, player_round_stats: count(where round > 3)\` is refused with \`ambiguous column "round" (owned by multiple sources — the grammar has no qualified-identifier syntax)\`. Pick a column only one of them has, or drop one of the sources.
- The same source may not be listed twice.`,
  },
  {
    id: 'scope',
    title: 'Scope',
    parent: 'metric-language',
    blocks: `A metric's scope answers **over how much of the library** the number is taken; its subject answers **about whom or what** it is (see [Anchors](#player-anchor)). Both are picked for the metric — neither is written into its expression text.

| Scope | Means | Shown as |
|---|---|---|
| \`match\` | this subject in this match | a pinned metric appears as a scoreboard column on every match, and saved metrics are appended to match reports |
| \`profile\` | the player's career, over every match in the library | pinned metrics appear as cards on a player profile, alongside Matches and Win% |

Which subject × scope combinations exist:

| Subject | One match | Whole library |
|---|---|---|
| player | ✓ | ✓ — that player's career |
| match | ✓ | ✗ refused — a match has no career |
| team | ✓ | ✗ refused — a team has no career |

A match or team value always belongs to a single match (the profile scope refuses anything else: *profile scope is player-only*), and any other scope value is refused.`,
  },
  {
    id: 'partitions',
    title: 'Partitions',
    parent: 'metric-language',
    blocks: `A metric may declare a **partition** — \`side\`, \`map\` or \`weapon\` — as an option on the metric (like its denominator; never text in the expression). The value is then worked out **once per value of that dimension**: one row per side, per map, or per weapon — each with its own honest \`N\` and its own five states (see [Missing data](#missing-data)).

- The partition must be a column the formula's sources carry: every source of a partitioned expression must carry that column, or the first source missing it is refused.
- The shipped side, map and weapon built-ins (\`side_win_pct\`, \`map_adr\`, \`weapon_kills\`, …) are partitioned metrics — the Sides, Maps and Weapons tables on a player profile read them.
- Partitions combine with career scope: the career bucket is split per dimension value.`,
  },
  {
    id: 'denominators',
    title: 'Denominators',
    parent: 'metric-language',
    blocks: `A metric may optionally divide itself by a count of rounds or matches — that is what turns a total into a *rate* ("per round", "per match"). There are exactly two choices, \`rounds\` and \`matches\`; anything else is refused.

**One rule — the denominator always counts the units of the scope, for the metric's subject:**

- **Player, match scope:** it counts the units of *that match* — how many rounds were played in it. Every player in the match shares that same count, which is correct for a per-player rate in one match. (With \`matches\` at match scope the count is that one match, so the value is unchanged.)
- **Player, career scope:** it counts *that player's* units — the rounds of the matches they played, or the matches they played.
- **Match subject:** that match's units — every team and player row of the match shares the same count.
- **Team subject:** that team's rounds in the row's match (its \`matches\` denominator counts the row's own match).

Examples:

| Expression | Denominator | Scope | The value means |
|---|---|---|---|
| \`from player_stats: sum(kills)\` | \`rounds\` | match | kills ÷ the rounds of that match |
| \`from player_stats: sum(kills)\` | \`matches\` | career | kills ÷ the matches this player played |
| \`from player_stats: sum(total_damage)\` | \`rounds\` | career | damage ÷ the rounds of the matches this player played |

Two details worth remembering:

- The denominator divides the **first** aggregation only — the value the metric shows.
- A zero count never errors: the value becomes **0 beside N** (see [Missing data](#missing-data)).

In an ad-hoc preview of an unsaved expression, the denominator applies once the metric is saved.`,
  },
  {
    id: 'metric-references',
    title: 'Metric references',
    parent: 'metric-language',
    blocks: `\`metric('name')\` reads **another saved metric's value for the same subject**:

\`\`\`
from player_stats: ratio(sum(kills), metric('career_kd'))
\`\`\`

References are written by **name**, so formulas stay readable; renaming a metric automatically rewrites every formula that referenced it.

# Where a reference may appear

Exactly two positions — a reference may appear only where a finished value may appear:

1. **As an aggregation on its own:** \`from player_stats: metric('career_kast')\`
2. **As either half of a \`ratio()\`:** \`ratio(sum(kills), metric('career_kd'))\` or \`ratio(metric('career_kd'), count())\`

Everything else is refused, each with its own message:

| Refused place | Message | Why |
|---|---|---|
| inside \`sum\`/\`avg\`/\`min\`/\`max\`/\`stddev\`/\`percentile\`/\`median\` | \`metric() is a value reference — it cannot appear inside sum()\` | a reference is one finished number for the player, not a set of rows to average or add |
| inside a condition or filter | \`metric() is a value reference — it cannot appear in a condition or filter (they are row-level predicates over source columns)\` | a condition tests individual rows of your sources; a reference has no rows |
| inside another reference | \`metric() cannot be nested inside metric()\` | the argument of \`metric()\` is a name, not a value |
| an unknown name | \`unknown metric reference "nope"\` | the name must match a saved metric exactly |

# Scope and subject rules between references

- A match metric may read a career metric (the player's career value travels into the match row).
- A career metric may **not** read a match metric — a career number has no single match to read it from:

  \`\`\`
  metric 'trade_rate' is match-scoped and cannot be used inside a
  profile-scoped metric (a career value cannot read a per-match value)
  \`\`\`

  Recompute it from the sources instead — that is what the shipped career Trade rate does.

- The reference's subject must fit *inside* the reading metric's: a player metric reads player metrics, a match metric only match metrics, a team metric match or team metrics — an illegal pairing refuses with its own message naming both subjects.

# When the other metric isn't ready

A reference resolves only against a value that is actually there. If the referenced metric has not been computed yet (or its own inputs have changed), your metric shows **no value at all** for that player rather than a zero — "not there" and "zero" are different answers, and the language keeps them apart.

You also cannot build a loop (\`a\` reading \`b\` reading \`a\`, or a metric reading itself): cyclic references are refused when saving. And a metric that others reference cannot be deleted until those formulas are edited or removed — the refusal names them.`,
  },
  {
    id: 'missing-data',
    title: 'Missing data',
    parent: 'metric-language',
    blocks: `Every value slot shows one of three things: **a number**, **a dash**, or **a state chip**.

# N and the honest zero

Beside a number you will see **N** — how many rows stand behind that value (for a percentile, how many values went in; for an identity metric, the pool of players it chose from). It appears as its own column in the preview and report tables and as *"sample size n=…"* in a value's tooltip. It is the sample size: a number with \`N = 3\` is a much weaker claim than the same number with \`N = 300\`.

**0 beside N** means: the formula ran over real rows, but its own inputs were empty — most often a division whose bottom half was zero (a player with no deaths in a K/D formula). The value is shown as 0 with its N rather than as an error, an empty cell, or a made-up figure. It is a numeric answer: an identity metric never renders one.

**A dash (—)** means something different: there were **no rows at all** for that player in that scope (a player who never entered a clutch has no clutch win rate). An identity metric whose pool is empty shows a dash too — the winner is never invented. Nothing is fabricated in either case.

# The five value states

| State | What you see | What it means |
|---|---|---|
| \`processing\` | a busy chip — *"recomputing — this value is not final yet"* | the metric is being worked out right now; the old number (if any) is withheld rather than shown stale |
| \`failed\` | a bad chip; its tooltip carries the error text | the last attempt failed and no fresh value exists |
| \`fresh\` | the number (tooltip: the formula and its N) | a current value was read and is being shown |
| \`no-data\` | a dash — *"no data for this subject"* | the metric is up to date but has nothing to show for this subject — no row for this player, this match or this team |
| \`behind\` | an idle chip — *"value not available yet — recompute pending"* | the value has not been computed for this unit yet, or what it is computed from has changed |

Notes on how they behave:

- \`processing\` outranks everything: while a recomputation runs you never see a stale number and never a bare dash mid-flight.
- The words above are the complete vocabulary; no internal bookkeeping is ever rendered in a value slot.
- When the value is missing because a metric another one depends on is missing, the result is \`no-data\` — never a zero.`,
  },
  {
    id: 'previewing',
    title: 'Previewing',
    parent: 'metric-language',
    blocks: `You can run any expression before saving it:

- As you type, the expression is checked continuously and reported as **valid** or as an error at a byte position in your text.
- **Preview** runs it read-only against your library and lists one row per subject with the value and N (per player for a player metric; per match or per team for a match- or team-subject one). It is capped at 200 rows by default and 10 seconds; a percentile-first formula reads up to 500,000 raw values before it stops.
- **The first aggregation is the value shown.** If you list several, the others are carried along but only the first is surfaced as the value.
- A **saved, unmodified** metric shows its stored value; an **unsaved or edited** expression is calculated on the spot for the preview. Editing a saved metric's formula therefore previews your draft version until you save it.
- A preview of a metric with a denominator in an unsaved form notes that the denominator applies after save.`,
  },
  {
    id: 'built-in-metrics',
    title: 'Built-in metrics',
    parent: 'metric-language',
    blocks: `Spectra ships **built-in metrics** for the common numbers, grown over time — names and families, not an exhaustive list:

- **The scoreboard's own numbers**, match-scoped (\`kills\`, \`deaths\`, \`mvps\`, \`total_damage\`, \`utility_damage\`, \`kda\`, \`adr\`, \`trade_rate\`, \`kast\`, \`kd\`, \`dmg_no_kill\`, \`kill_conversion\`) with career twins (\`career_kills\`, \`career_kd\`, \`career_kast\`, \`win_pct\`, …).
- **Rounds, openings and clutches** (\`eng_opening\`, \`eng_trade\`, \`clutches\`, \`clutch_win_rate\`, \`pistol_rounds\`, \`round_label_eco\`, …).
- **Match-level and team-level answers** — addressed to the match itself (\`lost_equip\`, \`avg_equip_gap\`, \`pistol_hold\`) or to each team (\`team_force_win_rate\`, \`team_lost_equip\`).
- **Who led — identity metrics whose value is a player**: \`top_fragger\`, \`best_adr\`, \`most_util\`, \`entry_opens\`, \`most_mvps\`.
- **Per-side, per-map and per-weapon career tables** — partitioned metrics (\`side_win_pct\`, \`side_adr\`, \`map_win_pct\`, \`map_kd\`, \`weapon_kills\`, \`weapon_damage\`, …).

The full list is the **Builtins** group at the top of the builder's left column; a built-in's name is what you use in a \`metric('…')\` reference.

They are **read-only**:

- They load into the builder with a \`built-in\` chip and a disabled Save; *"Built-in metrics can't be edited"* and *"Built-in metrics can't be deleted"* are enforced, not merely hidden — there is no delete control on them either.
- You can still **preview** one, **reference** it from your own formula with \`metric('trade_rate')\`, and **pin** it as a column or panel entry.
- What each one measures is written in its ⓘ tooltip as \`Formula: …\`.`,
  },
  {
    id: 'worked-examples',
    title: 'Worked examples',
    parent: 'metric-language',
    blocks: `Every expression below was accepted exactly as written when checked against the app's own expression checker.

**Counts and totals**

\`\`\`
from player_stats: count()                                     -- rows for this source
from events: count(), sum(dmg), avg(distance)                  -- several aggregations
from events: count(where kind = 'kill' and headshot)           -- headshot kills
from player_stats: count() AS matches                          -- optional label
\`\`\`

**Rates and shares**

\`\`\`
from player_stats: ratio(sum(kills), sum(deaths))              -- K/D
from player_stats: ratio(sum(kills + assists), max(sum(deaths), 1)) -- KDA, floored at one death
from player_stats: sum(total_damage)                            -- ADR (with the rounds denominator)
from player_round_stats: avg(kast)                             -- KAST%
from clutches: avg(won)                                        -- clutch win share
from player_stats: ratio(sum(headshots), sum(kills))           -- HS%
\`\`\`

**Filters**

\`\`\`
from player_stats: sum(where side = 'ct', total_damage)        -- CT-side damage only
from events: count(headshot)                                   -- "is set" test
from events: count(where dmg >= 50 and (kind = 'kill' or not headshot))
\`\`\`

**The additive chain**

\`\`\`
from player_stats: sum(opening_kills + opening_deaths)         -- openings total
from player_stats: ratio(sum(kills + assists), sum(deaths))    -- KDA
from player_stats: sum(where side = 'ct', opening_kills + opening_deaths)
\`\`\`

**Spread and position**

\`\`\`
from player_stats: stddev(adr)                                 -- career ADR σ
from events: percentile(0.95, dmg)                             -- top 5% hits
from events: median(dmg)                                       -- middle hit
from events: min(tick), max(tick)
\`\`\`

**Combined sources**

\`\`\`
from player_stats, match_trade_opps: ratio(sum(trade_kills), sum(opps))
from engagements, rounds: count()
from engagements, rounds: count(where duration_s > 30)         -- a filter can read the partner
\`\`\`

**Scope and denominators** (the scope and denominator are options you pick for the metric, not part of the expression text)

| Expression | Denominator | Scope |
|---|---|---|
| \`from player_stats: count()\` | \`rounds\` | match |
| \`from player_stats: sum(kills)\` | \`matches\` | career |
| \`from events: count()\` | — | one match (\`match:7\`) |

**References**

\`\`\`
from player_stats: ratio(sum(kills), metric('career_kd'))      -- ref in a ratio
from player_stats: metric('career_kast')                       -- ref as the value
from events: ratio(metric('career_kd'), count())               -- ref in the numerator
\`\`\`

**Refused (with the message you would see)**

\`\`\`
from rounds: count()
→ expression is not player-anchored: primary source "rounds" has no player subject …
  (a player metric — what a draft starts as; the same lead is fine for a match-subject metric)

from matches: count()
→ unknown source table "matches" (valid: events, engagements, rounds, player_stats, …)

from player_stats: sum(kills) + sum(deaths)
→ expected "," or end of expression (got "+")

from player_stats: avg(kills + deaths)
→ avg() takes a single column — only sum() accepts an additive column expression (sum(col + col …))

from player_stats: sum(metric('career_kd'))
→ metric() is a value reference — it cannot appear inside sum()

from player_stats: count(where metric('career_kd') > 1)
→ metric() is a value reference — it cannot appear in a condition or filter (…)

from player_stats, rounds: count()
→ cannot join source "rounds" to "player_stats": secondary "rounds" is not unique …

from player_stats: percentile(1.5, adr)
→ percentile fraction must be in [0,1] (got "1.5")
\`\`\``,
  },
  {
    id: 'common-errors',
    title: 'Common errors',
    parent: 'metric-language',
    blocks: `| Message | What it means |
|---|---|
| \`empty expression: expected "from <table>: <aggregations>"\` | nothing was typed yet |
| \`expected "from <table>:" (got "…")\` | a formula always starts with \`from <sources>:\` |
| \`unknown source table "x" (valid: …)\` | the source name is misspelled or does not exist (see [Sources](#sources)) |
| \`unknown column "x" for source y\` | that column is not part of that source, or the name's case is wrong |
| \`ambiguous column "x" (owned by multiple sources …)\` | two sources in your list both own that column |
| \`expression is not player-anchored: …\` | the leading source does not name a player for a player metric (see [Anchors](#player-anchor)) |
| \`expression is not team-anchored: …\` | the leading source carries no stamped team column for a team metric (see [Anchors](#player-anchor)) |
| \`cannot join source "a" to "b": … not unique on the shared dimensions\` | the extra source's rows are not uniquely identified by the shared fields — using it would multiply your counts |
| \`value column "x" comes from secondary source "y", but the join is not 1:1 …\` | a number may only be read from a one-to-one partner |
| \`avg() takes a single column — only sum() accepts an additive column expression …\` | only \`sum(a + b)\` may add columns |
| \`expected "," or end of expression (got "+")\` | arithmetic between aggregations (like \`sum(a) + sum(b)\`) is not part of the language |
| \`max() takes at least two values …\` | the value form of \`min\`/\`max\` needs at least two arguments — a single argument is the aggregate over one column |
| \`expected a value aggregation or a number (got "…")\` | a \`min\`/\`max\` value-form argument must be a whole aggregation or a number — not a bare column, a string or a keyword |
| \`percentile() cannot be nested inside max()\` | percentile, median and ratio compute outside the statement — they cannot sit inside a \`min\`/\`max\` value (the same applies to a nested \`ratio()\`) |
| \`expected ")" (got ",")\` | an argument list carries more than its form allows — plain-column \`min\`/\`max\` take a single column; the multi-value form needs aggregations or numbers (see [Operators](#operators)) |
| \`percentile fraction must be in [0,1]\` | the first argument of \`percentile\` must be between 0 and 1 |
| \`unknown aggregation "x" (valid: count, sum, avg, min, max, stddev, percentile, median, ratio, metric, argmax)\` | the operator is misspelled |
| \`next() is a round window — …\` | \`next()\` sits in a value position — it belongs in a condition (see [Operators](#operators)) |
| \`diff() is a row difference — …\` | \`diff()\` sits outside \`sum()\`/\`avg()\` — that is the only place it reduces (see [Operators](#operators)) |
| \`metric() …\` (several variants) | a reference is in a place it may not appear — see [Metric references](#metric-references) |
| \`unknown metric reference "x"\` | no saved metric has that exact name |
| \`unknown denominator "x" (valid: rounds, matches)\` | only \`rounds\` and \`matches\` exist |
| \`invalid scope "x": expected "match:<id>" or "" (whole library)\` | scope is either one match or the whole library |

_The live check under the expression box reports each message exactly as written above. The same expression failure raised while **saving** appears as \`invalid metric expression: …\`; the other save-time refusals (references, cycles, built-ins, scope rules) surface the same way, as plain messages._`,
  },
];
