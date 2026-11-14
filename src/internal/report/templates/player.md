# Player report — {{.Player.Name}} ({{.SteamID}})

- Match: {{.Match.Map}} {{.Match.ScoreCT}}–{{.Match.ScoreT}} ({{.Match.Path}})
- Side: {{.Player.Side}} · Rounds played: {{.Player.RoundsPlayed}}
- K/D/A: **{{.Player.Kills}}/{{.Player.Deaths}}/{{.Player.Assists}}** (KD {{(index .Metrics .SteamID).KD}}, KDA {{printf "%.2f" .Player.KDA}})
- ADR {{(index .Metrics .SteamID).ADR}} · HS% {{(index .Metrics .SteamID).HSPct}} · Damage {{.Player.TotalDamage}} taken {{.Player.DamageTaken}}
- Openings {{.Player.OpeningKills}}/{{.Player.OpeningDeaths}} · Entry {{.Player.EntryKills}}/{{.Player.EntryDeaths}} · Trades {{.Player.TradeKills}} · Best streak {{.Player.BestStreak}}
- Utility damage {{.Player.UtilityDamage}} · Enemies flashed {{.Player.EnemiesFlashed}} · Plants {{.Player.BombPlants}} · Defuses {{.Player.BombDefuses}} · MVPs {{.Player.MVPs}} · Money {{.Player.MoneySpent}}

## Per-round

| Round | K | A | D | Traded | Survived | KAST | DMG | Util dmg | Money start | Equip | Spent |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
{{range .Rounds}}| {{.Round}} | {{.Kills}} | {{.Assists}} | {{.Deaths}} | {{.Traded}} | {{.Survived}} | {{.KAST}} | {{.DMG}} | {{.UtilDmg}} | {{.MoneyStart}} | {{.Equip}} | {{.Spent}} |
{{end}}
---

Generated {{.GeneratedAt}} by Spectra from the local library.
