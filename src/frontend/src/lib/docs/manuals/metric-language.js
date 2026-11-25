// The metric-language manual — the REAL content chapter of the user
// guide (user-guide.js composes these sections in at its
// metric-language position; every other guide section is written in
// user-guide-content.js).
//
// B5: the sugar grammar is retired. A metric is one raw
// SQL statement, and this chapter documents exactly what the save gate
// (internal/metrics GateSQL / CheckRawSave, internal/store
// AnalyzeMetricSQL) checks and the messages it returns. Every quoted
// message below is the engine's own copy. Section ids the rest of the app
// pins are kept (the Builder's ? target is `metric-language`); the chapter
// keeps 11 minor sections under it (see docsregistry.test.js). Re-verify
// against internal/metrics/raw.go and internal/store/metric_gate.go before
// changing any claim.
export const metricLanguageSections = [
  {
    id: 'metric-language',
    title: 'Metric language',
    blocks: `A **metric** is one number for one **subject**: "this player's trade rate", "this match's damage per round", "this player's career kills". A metric is written as **one SQL statement**. The statement reads the library's tables, and whatever it returns is the metric's stored value.

Four things are worth knowing before anything else:

- **The statement is the formula.** It is shown wherever the metric is shown, so nobody has to guess what a number means. A saved metric also carries a written explanation of its own formula, required when you save, in the ⓘ tooltip next to it.
- **Saving checks the statement.** The save gate reads the statement, refuses anything that is not one read-only query over the library's tables, and records which tables it reads (see [What saving checks](#save-gate)).
- **Values are kept, not recalculated on the spot.** Once a metric has been worked out, every screen reads the kept value. When a table it reads changes, the metric is marked behind and worked out again (see [Touched tables and freshness](#freshness)).
- **The binds set the scope.** A statement that binds \`:match_id\` gives one value per match, one that binds \`:steam_id\` gives a career value per player (see [Scope](#scope)).`,
  },
  {
    id: 'writing-an-expression',
    title: 'Writing a statement',
    parent: 'metric-language',
    blocks: `A statement is one \`SELECT\` (or \`WITH … SELECT\`). It must return three columns with these names:

- **\`subject_key\`** — who the value belongs to: a player's SteamID64, or \`''\` for a match-level value.
- **\`dim\`** — a split of the value (for example a side or a map), or \`''\` when the value is not split.
- **\`value\`** — the number. A \`NULL\` means the statement had no data for that subject (see [Missing data](#missing-data)).

Any other columns the statement returns are kept as written, and do not affect the value.

\`\`\`
SELECT steam_id AS subject_key, '' AS dim, SUM(kills) AS value
FROM player_stats
WHERE match_id = :match_id
GROUP BY steam_id
\`\`\`

This is the kills of each player in one match. Each subject and \`dim\` may appear once per run; a statement that repeats one is refused when it runs.

The reserved binds are \`:match_id\`, \`:steam_id\` and \`:round\`. The engine supplies each one when it runs the statement. No other bind name is accepted, and \`?\` is not accepted either.`,
  },
  {
    id: 'sources',
    title: 'Tables you can read',
    parent: 'metric-language',
    blocks: `A statement may read these tables. Every table a statement reads must be on this list. A name that is not a table of the library is refused, and so is a table the list leaves out.

- **Matches and players:** \`matches\`, \`teams\`, \`players\` (the roster, bots included).
- **Match facts:** \`rounds\`, \`events\`, \`kill_tags\` (the kill tags), \`utility_events\`, \`chat\`, \`sound_events\`, \`player_ticks\`, \`round_player_money\`, \`encounters\`, \`encounter_windows\`, \`encounter_window_samples\`.
- **Per-player and per-round statistics:** \`player_stats\`, \`player_round_stats\`, \`round_economy\`, \`round_player_sides\`, \`round_classifications\`, \`round_side_classes\`, \`match_trade_opps\`.
- **The raw event payload:** \`generic_events\`. Its \`payload_json\` keys come from the game's own event schema, so a statement that reads one key can break after a parser change.

Everything else is closed to a statement: the app's own tables (metric and component definitions, reports, saved queries, saved filters, plugins, the analysis rule table) and the metric store itself. A metric reaches stored values only through \`metric('name')\`, which reads a saved metric's stored value for the same match, player or round (see [Other metrics](#metric-references)).

A statement sees the players in the library as they are, bots included, because a metric you write is not filtered. The built-in metrics do filter bots, and they show the same rule in their SQL (see [Built-in metrics](#built-in-metrics)).`,
  },
  {
    id: 'metric-helpers',
    title: 'Helpers in a statement',
    parent: 'metric-language',
    blocks: `What a statement can refer to, in one place. The chapter above explains each part; this is the lookup.

**Binds.** The engine fills these in when it runs a statement. Name them in the statement, and no other bind is accepted.

| Bind | Given when the metric runs for | What the scope is |
|---|---|---|
| \`:match_id\` | a match | one value per match |
| \`:steam_id\` | a player | one career value per player |
| \`:round\` | a round of a match | one value per round; it needs \`:match_id\` as well |

**Functions.** Besides SQLite's own functions, a statement may call **\`is_bot_key(steam_id)\`**, which is \`1\` for a bot and \`0\` for a human, so \`AND NOT is_bot_key(steam_id)\` leaves bots out. It may also call the JSON table functions \`json_each\` and \`json_tree\`.

**Other metrics.** **\`metric('name')\`** reads a saved metric's stored value for the same match, player or round. See [Other metrics](#metric-references).

**Tables.** The tables a statement may read are listed in [Tables you can read](#sources).

**Macros.** Short names for larger pieces of SQL, written in double braces. They are expanded when the statement is checked. See [Macros](#macros).`,
  },
  {
    id: 'save-gate',
    title: 'What saving checks',
    parent: 'metric-language',
    blocks: `Saving a metric, and the live check under the expression box, run the same gate. The gate refuses a statement unless it passes all of these:

1. **One statement.** A trailing semicolon is fine. Two statements are not.
2. **A read.** The statement starts with \`SELECT\` or \`WITH\`. Writes (\`INSERT\`, \`UPDATE\`, \`DELETE\`, \`DROP\`, \`CREATE\`, and \`CREATE VIEW\` with them) are refused wherever they appear.
3. **Tables.** Every table the statement reads is on the list in [Tables you can read](#sources). Tables inside subqueries and CTEs count too.
4. **Binds.** Only \`:match_id\`, \`:steam_id\` and \`:round\` are used. \`:round\` needs \`:match_id\`.
5. **Scope.** The binds decide the scope (see [Scope](#scope)).
6. **Metric references.** Each \`metric('name')\` must name a saved metric, and the references must not loop back to the metric being saved.

The gate does not check whether the numbers are right. It checks what the statement may read and how it runs. A statement that is valid but returns the wrong number saves without complaint.

When the gate accepts a statement, it stores the set of tables the statement reads. That set drives freshness (see [Touched tables and freshness](#freshness)).`,
  },
  {
    id: 'scope',
    title: 'Scope',
    parent: 'metric-language',
    blocks: `The binds a statement uses decide what it is worked out for:

| Binds | Scope | What the engine runs |
|---|---|---|
| \`:match_id\` (or none) | match | once for each ready match, or once for the library when it binds nothing |
| \`:steam_id\` | profile (career) | once for each human player, across all their matches |
| \`:match_id\` and \`:round\` | match, per round | once for each round of each ready match |

A statement that binds \`:steam_id\` cannot also bind \`:match_id\` or \`:round\`. A profile metric is one value per player, so it reads \`:steam_id\` and keeps the career total itself. Nothing else sets the scope: the statement's binds are the whole answer.

Career values are built from the statement, not from other metrics: a career statement sums or counts the rows it needs in one query.`,
  },
  {
    id: 'freshness',
    title: 'Touched tables and freshness',
    parent: 'metric-language',
    blocks: `Saving records the **touched tables**: every table the statement reads. It is worked out from the statement itself, and it is never typed in by hand.

A saved metric is **behind** when the work it needs is missing, and the sweep works it out again. The rules are:

- **An import or a re-parse of a match** marks behind the metrics whose touched tables that match wrote. A per-match metric goes behind only for that match.
- **An edit to an analysis rule's value** recalculates the metrics that touch the rule's analysis table, and the metrics that depend on them. Nothing else moves.
- **A change to the analysis code** marks behind every metric that touches an analysis table. A metric that reads only the facts (the tables an import writes) stays fresh.
- **Saving the metric** changes the value only if its statement or its scope changed. Saving a new description or title does not re-run it.
- **Cancelling.** A running metric can be cancelled (see [Cancelling a running metric](#metric-cancel)). The cancel stops its statement at once and keeps no values for it. It stays cancelled until you save the metric again.

A metric whose touched tables are not known yet reads as behind until the save gate has run on it.`,
  },
  {
    id: 'missing-data',
    title: 'Missing data',
    parent: 'metric-language',
    blocks: `A subject with no data is not a zero. Where a statement has nothing to count, \`value\` is \`NULL\`, and Spectra shows a dash. Zero appears only when the statement itself produced a zero, for example a \`COUNT(*)\` over an empty set of matching rows.

A subject that the statement does not return has no row at all. Spectra shows the dash for it, never a number it made up.

A division by zero is a \`NULL\` in SQL, so a rate over no rounds or no deaths shows a dash. Write \`NULLIF\` or \`COALESCE\` only where you want a different answer, and say so in the formula's explanation.`,
  },
  {
    id: 'metric-references',
    title: 'Other metrics',
    parent: 'metric-language',
    blocks: `\`metric('name')\` reads another saved metric's stored value for the same match, player or round your statement is bound to, as rows of \`subject_key\`, \`dim\` and \`value\`. Use it to build a career or profile figure from per-match values without reading the raw rows again. A stored value that is out of date, or has no row for that unit, reads as \`NULL\`, shown as a dash, never as zero.

The other metric must already be saved, and a metric cannot reference itself, directly or through other metrics. A change to the other metric marks this metric behind for the affected match or player only.`,
  },
  {
    id: 'previewing',
    title: 'Previewing',
    parent: 'metric-language',
    blocks: `Preview, in the metric editor, shows the stored values of a metric you have saved and not changed since. It reads the rows the screens read: for a match metric, the values for the newest ready match; for a career metric, the values for every player. Nothing is calculated for the preview. If a row you expect is missing, the sweep has not run the metric yet, and the metric reads as *behind* or *processing*.

A statement you have not saved, or have changed since saving, is refused by Preview with *previewing raw SQL isn't available yet; save the metric and its values appear once it has run*. Save it, and its values appear in the list and on the screens that show metrics once the sweep has run it. A statement that fails when it runs shows the failed state, with its error text.

The live check under the expression box still runs the save gate on what you typed, so a statement that would be refused is marked at once, with its message. The editor shows the statement as you wrote it, macros included; the check and every run use the expanded statement (see [Macros](#macros)).`,
  },
  {
    id: 'built-in-metrics',
    title: 'Built-in metrics',
    parent: 'metric-language',
    blocks: `Spectra ships its own metrics, the ones the screens use: kills, damage per round, trade and entry rates, the economy figures, clutches, weapon damage and more. Each one is a statement like any you write, and each one is shown with its formula.

The built-in statements leave out bots. They use one shared rule for it, so a bot never appears in a roster, an aggregate or a selection. Event rows keep their bot names, because an event records what happened.

Built-in metrics are edited in place, the same as built-in components: change the statement, and **Save** keeps the edit (see [The metric builder](#metric-builder)). A statement of your own does not filter bots unless it says so, and the way to say so is \`AND NOT is_bot_key(steam_id)\` (see [Helpers in a statement](#metric-helpers)).

The built-in list grows with each release, so this chapter does not count it.`,
  },
  {
    id: 'macros',
    title: 'Macros',
    parent: 'metric-language',
    blocks: `A statement may use **macros**: short names, written in double braces, that stand for a larger piece of SQL. They save you writing a common join or a common rule again, and they keep the built-in metrics consistent with each other. The editor shows the statement as you wrote it, macros included. When you check or save a statement, the macros are expanded into plain SQL, and that expanded statement is what the gate checks and what runs. A macro the engine does not know is refused with *unknown macro*, followed by the macro as written.

**Shared pieces.** Place one of these where its name is. Each brings a named piece of SQL, such as a common table, a join or a list, and it is usually used inside a \`WITH\` list. The clearest way to use one is to copy a built-in metric that uses it.

- \`{{KILLS_CTE}}\`, \`{{KILLS_EK}}\`, \`{{KILLS_AK}}\`, \`{{KILLS_EKR}}\`, \`{{KILLS_ROUND}}\`: the counted kills, the one kill rule every kill metric shares. The variants give the counted entry kills, the counted assists, the entry kills per round, and the round-grain kills.
- \`{{DAMAGE_CTE}}\`, \`{{DAMAGE_ROUND_CTE}}\`: the counted damage, and the same rule restricted to a round.
- \`{{BLIND_CTE}}\`: the blind-event rows of a match, one for each flash detonation, with its attacker and victim and their sides.
- \`{{UTILITY_WEAPONS}}\`: the utility weapons (grenades and fire), as the list an \`IN\` test reads.
- \`{{CLUTCH_CTE}}\`: the clutch situations.
- \`{{DISCONNECT_JOIN}}\`: the join that marks players who disconnected.
- \`{{CAREER_HEAD}}\`: the opening of a career statement, its \`subject_key\` and \`dim\` columns.
- \`{{PLAYER_STATS_COLS}}\`, \`{{PLAYER_STATS_HUMANS}}\`, \`{{PLAYER_FOLD_JOIN}}\`, \`{{PLAYER_ROUND_COLS}}\`, \`{{PLAYER_ROUND_FOLD_JOIN}}\`, \`{{PLAYER_ROUND_ROSTER_JOIN}}\`: the per-player building blocks: the match's player rows with bots left out, and the joins that attach a round to its player's roster row.
- \`{{ROLLUP_OPEN}}\`, \`{{ROLLUP_MATCH_OPEN}}\`, \`{{ROLLUP_CLOSE}}\`: the open and close of a per-match rollup.
- \`{{SIDE_DOMAIN}}\`: the two sides as a row each, for a statement that reports a value per side.

**Macros with arguments.** These take their arguments after colons, and each one's name says what it is for.

| Macro | What it stands for |
|---|---|
| \`{{SUM_STORED:name}}\` | the career sum of one stored metric, NULL when any row it sums is NULL |
| \`{{RATIO_STORED:num:den}}\` | the career ratio of two stored metrics' sums, NULL when the denominator is zero |
| \`{{EXISTS_STORED:name}}\` | a career guard: the stored metric has a row for the subject |
| \`{{SUBJECT_RATIO:num:den}}\` | the ratio of two stored metrics for each subject |
| \`{{DIM_SUM:name}}\`, \`{{DIM_RATIO:num:den}}\` | the sum, and the ratio of two sums, of a stored metric for each \`dim\` |
| \`{{SIDE_JOIN:alias:src:col}}\` | joins the player-side row for \`src.col\`, under the name \`alias\` |
| \`{{HUMAN:col}}\`, \`{{HUMAN:col:key}}\` | a guard that keeps only humans, on a SteamID column |
| \`{{ROLLUP_HUMAN_CLOSE:col}}\` | the close of a per-match rollup, with the humans-only guard on \`col\` |
| \`{{MATCH_ROUNDS:alias}}\` | the number of rounds in the match named \`alias\` |
| \`{{LIVE_EVENT:alias:kind}}\` | an event of one kind that is not after the match |
| \`{{FAKE_KILL}}\` | the flag that marks a kill row as a fake kill |
| \`{{TEAM_FREE}}\` | the rule that a kill is not a team kill |
| \`{{FOLD_PIVOT:x}}\`, \`{{ROUND_FOLD_PIVOT:x}}\` | a per-player, or per-round, pivot of one fold column |
| \`{{TOP_PER_MATCH:col}}\` ... \`{{TOP_PER_MATCH_CLOSE}}\` | the head and tail of a statement that keeps the top subject of each match, ranked by \`col\` |
| \`{{CLUTCH_STAT:agg}}\` | a clutch aggregate, for humans only |
| \`{{ROUND_LABEL_COUNT:x}}\`, \`{{SIDE_CLASS_COUNT:x}}\` | the number of counted rounds labelled \`x\`, or of side rounds classed \`x\`, for each player |

The argument forms above are exact. Some macros only make sense inside the statement shape they are written for (such as
\`{{TOP_PER_MATCH:col}}\`, which needs its closing macro), so copy a built-in that uses one rather than writing it from this table.

**Error positions.** A message about the expanded statement points at a position in that expanded text, which can differ
from the text you wrote once a macro is in it.`,
  },
  {
    id: 'worked-examples',
    title: 'Worked examples',
    parent: 'metric-language',
    blocks: `**Damage per round in each match, for each player.** The rounds of the match are the denominator, and the statement reads them itself:

\`\`\`
SELECT steam_id AS subject_key, '' AS dim,
       1.0 * SUM(total_damage) / (SELECT COUNT(*) FROM rounds WHERE match_id = :match_id) AS value
FROM player_stats
WHERE match_id = :match_id
GROUP BY steam_id
\`\`\`

Scope: match. One row per player in each match. A match with no rounds gives \`NULL\`, shown as a dash.

**Career damage for each player.** The binds select the player, so the statement is career-scoped:

\`\`\`
SELECT :steam_id AS subject_key, '' AS dim, SUM(total_damage) AS value
FROM player_stats
WHERE steam_id = :steam_id
\`\`\`

Scope: profile. One row per human player, across every match they played.

**Kills in one match.** The simplest form, a count over one table:

\`\`\`
SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value
FROM events
WHERE kind = 'kill' AND match_id = :match_id
\`\`\`

Scope: match. One row for the match, with an empty subject because the value belongs to the match itself.`,
  },
  {
    id: 'common-errors',
    title: 'Common errors',
    parent: 'metric-language',
    blocks: `These are the gate's own messages. The live check under the expression box shows each one exactly as written here. A refusal at save appears as \`invalid metric expression: …\` followed by the same text.

| Message | What to do |
|---|---|
| \`a metric is one SELECT or WITH statement\` | The statement is not a query. A metric is written as SQL, not in the older shorthand. |
| \`only a single statement is allowed\` | Keep one statement and remove the rest. |
| \`update statements are not allowed\` (or \`insert\`, \`delete\`, \`create\`, \`drop\`) | A metric reads; it never writes. Remove the write. |
| \`only the library's own tables can be read (got "x")\` | The name is not a table of the library. Check the spelling against [Tables you can read](#sources). |
| \`metrics can't read "x"; only match data is readable\` | The table exists but is closed to metrics, such as the app's own tables. |
| \`bind :x isn't available in a metric (the bind names are :match_id, :steam_id and :round)\` | Only the three reserved binds are accepted. |
| \`a metric that reads :steam_id is career-scoped and can't also bind :match_id or :round\` | A career statement selects the player by \`:steam_id\` alone. Drop the match or round bind. |
| \`:round needs :match_id (a round is one round of one match)\` | A round statement binds the match as well. |
| \`unknown metric reference "x": no metric has that name; save that metric first\` | Save the metric the reference reads, or fix the name (see [Other metrics](#metric-references)). |
| \`metric "x" would reference itself through a cycle (…); remove one of the references\` | Remove the reference that loops back (see [Other metrics](#metric-references)). |
| \`the statement must return the columns subject_key, dim and value (missing: …)\` | Name the three columns as the statement's result (see [Writing a statement](#writing-an-expression)). |
| \`row N repeats subject_key "…" and dim "…"; each subject and dim may appear once per run\` | Group the statement so each subject and dim has one row. |
| \`row N: value must be a number or NULL\` | Return a number, or \`NULL\` for no data. |
| \`previewing raw SQL isn't available yet; save the metric and its values appear once it has run\` | Save the metric first (see [Previewing](#previewing)). |
| \`unknown macro {{NAME}}\` | The name is not one of the macros in [Macros](#macros). Check its spelling, or copy a built-in that uses it. |`,
  },
];
