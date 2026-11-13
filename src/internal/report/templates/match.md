# Match report — {{.Match.Map}}

- Path: {{.Match.Path}}
- Score: **{{.CTName}} {{.Match.ScoreCT}} – {{.Match.ScoreT}} {{.TName}}**
- Rounds: {{.Match.RealRounds}}
- Duration: {{.Match.PlaybackTimeS}} s @ {{.Match.TickRate}} ticks/s
- Imported: {{.Match.ExtractedAt}} (parser {{.Match.ParserVersion}}, {{.Match.ParseMS}} ms)

## Scoreboard

| Player | Side | K | D | A | ADR | HS% | KD | Rounds | Openings | Trades | MVPs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
{{range .Scoreboard}}| {{.Name}} | {{.Side}} | {{.Kills}} | {{.Deaths}} | {{.Assists}} | {{printf "%.1f" .ADR}} | {{printf "%.0f" .HSPct}} | {{printf "%.2f" .KD}} | {{.RoundsPlayed}} | {{.OpeningKills}}/{{.OpeningDeaths}} | {{.TradeKills}} | {{.MVPs}} |
{{end}}
## Rounds

| # | Winner | Reason | Duration s | Kills | MVP | Equip CT | Equip T |
| --- | --- | --- | --- | --- | --- | --- | --- |
{{range .Rounds}}| {{.Number}} | {{.Winner}} | {{.Reason}} | {{printf "%.1f" .DurationS}} | {{.Kills}} | {{.MVPName}} | {{.EquipCT}} | {{.EquipT}} |
{{end}}
## Economy

| Round | Winner | Equip CT | Equip T | Money CT | Money T | Loss bonus CT | Loss bonus T | Class | CT buy | T buy |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
{{range .Economy}}| {{.Round}} | {{.Winner}} | {{.EquipCT}} | {{.EquipT}} | {{.MoneyCT}} | {{.MoneyT}} | {{.LossBonusCT}} | {{.LossBonusT}} | {{.Label}} | {{.ClassCT}} | {{.ClassT}} |
{{end}}
## Clutches

| Round | Player | Size | Won | HP left | Equip |
| --- | --- | --- | --- | --- | --- |
{{range .Clutches}}| {{.Round}} | {{.Name}} | {{.Size}} | {{.Won}} | {{.HPLeft}} | {{.Equip}} |
{{end}}
## Utility

| Seq | Tick | Thrower | Kind | Damage | Flash ms | Site |
| --- | --- | --- | --- | --- | --- | --- |
{{range .Utility}}| {{.Seq}} | {{.Tick}} | {{.ThrowerName}} | {{.Kind}} | {{.Damage}} | {{.FlashMs}} | {{.Site}} |
{{end}}
---

Generated {{.GeneratedAt}} by Spectra from the local library. Inferred values (loss bonus, round types) are marked in-app; exports are available in the SQL console.
