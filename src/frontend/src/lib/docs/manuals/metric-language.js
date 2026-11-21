// The metric-language manual — the REAL content chapter of the user
// guide (user-guide.js composes these sections in at its
// metric-language position; every other guide section is written in
// user-guide-content.js).
//
// B5 (dogfood/PLAN.md): the sugar grammar is retired. A metric is one raw
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

- **Match and roster:** \`matches\`, \`teams\`, \`players\` (the humans-only roster lookup).
- **Match facts:** \`rounds\`, \`events\`, \`engagements\`, \`utility_events\`, \`chat\`, \`sound_events\`, \`player_ticks\`.
- **Per-player and per-round statistics:** \`player_stats\`, \`player_round_stats\`, \`round_economy\`, \`round_player_money\`, \`round_player_sides\`, \`round_classifications\`, \`round_side_classes\`, \`clutches\`, \`match_trade_opps\`.
- **The raw event payload:** \`generic_events\`. Its \`payload_json\` keys come from the game's own event schema, so a statement that reads one key can break after a parser change.

Everything else is closed to a statement, including the app's own tables (metric and component definitions, reports, saved queries, plugins, the analysis rule table) and the metric store itself. Metrics reach stored values only through \`metric('name')\`, which reads a saved metric's stored value for the same match, player or round (see [Other metrics](#metric-references)).

A metric's statement sees the players in the library as they are, bots included, because a metric you write is not filtered. The built-in metrics do filter bots, and they show the same rule in their SQL (see [Built-in metrics](#built-in-metrics)).`,
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
5. **Scope.** The binds decide the scope, and the stored scope must agree with them (see [Scope](#scope)).
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

A statement that binds \`:steam_id\` cannot also bind \`:match_id\` or \`:round\`. A profile metric is one value per player, so it reads \`:steam_id\` and keeps the career total itself. The save refuses a metric whose stored scope does not match its binds, with the message in [Common errors](#common-errors).

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
    blocks: `Previewing a statement before you save it is not available yet. The live check under the expression box still runs the save gate on what you typed, so a statement that would be refused is marked at once, with its message.

To see the values a statement produces, save it. Its values appear in the list and on the screens that show metrics once the sweep has run it. A statement that fails when it runs shows the failed state, with its error text.

The statement a metric runs is shown as written, with the metric, so you can copy it out and run it in the SQL console.`,
  },
  {
    id: 'built-in-metrics',
    title: 'Built-in metrics',
    parent: 'metric-language',
    blocks: `Spectra ships its own metrics, the ones the screens use: kills, damage per round, trade and entry rates, the economy figures, clutches, weapon damage and more. Each one is a statement like any you write, and each one is shown with its formula.

The built-in statements leave out bots. They use one shared rule for it, so a bot never appears in a roster, an aggregate or a selection. Event rows keep their bot names, because an event records what happened.

Built-in metrics cannot be edited. A statement of your own does not filter bots unless it says so.

The built-in list grows with each release, so this chapter does not count it.`,
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
| \`a metric that reads :steam_id is profile-scoped and one that doesn't is match-scoped (this one is …-scoped)\` | Set the scope to match the binds the statement uses (see [Scope](#scope)). |
| \`unknown metric reference "x": no metric has that name; save that metric first\` | Save the metric the reference reads, or fix the name (see [Other metrics](#metric-references)). |
| \`metric "x" would reference itself through a cycle (…); remove one of the references\` | Remove the reference that loops back (see [Other metrics](#metric-references)). |
| \`the statement must return the columns subject_key, dim and value (missing: …)\` | Name the three columns as the statement's result (see [Writing a statement](#writing-an-expression)). |
| \`row N repeats subject_key "…" and dim "…"; each subject and dim may appear once per run\` | Group the statement so each subject and dim has one row. |
| \`row N: value must be a number or NULL\` | Return a number, or \`NULL\` for no data. |
| \`previewing raw SQL isn't available yet; save the metric and its values appear once it has run\` | Save the metric first (see [Previewing](#previewing)). |`,
  },
];
