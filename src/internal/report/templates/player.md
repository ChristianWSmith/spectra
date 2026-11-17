# Player report — {{.Player.Name}} ({{.SteamID}})

- Match: {{.Match.Map}} {{.Match.ScoreCT}}–{{.Match.ScoreT}} ({{.Match.Path}})
- Side: {{.Player.Side}} · Rounds played: {{(index .Metrics .SteamID).RoundsPlayed}}
- K/D/A: **{{(index .Metrics .SteamID).Kills}}/{{(index .Metrics .SteamID).Deaths}}/{{(index .Metrics .SteamID).Assists}}** (KD {{(index .Metrics .SteamID).KD}}, KDA {{(index .Metrics .SteamID).KDA}})
- ADR {{(index .Metrics .SteamID).ADR}} · HS% {{(index .Metrics .SteamID).HSPct}} · Damage {{(index .Metrics .SteamID).TotalDamage}} taken {{(index .Metrics .SteamID).DamageTaken}}
- Openings {{(index .Metrics .SteamID).EntryKills}}/{{(index .Metrics .SteamID).EntryDeaths}} · Open K/D {{(index .Metrics .SteamID).EntryKills}}/{{(index .Metrics .SteamID).EntryDeaths}} · Trades {{(index .Metrics .SteamID).TradeKills}} · Best streak {{(index .Metrics .SteamID).BestStreak}}
- Utility damage {{(index .Metrics .SteamID).UtilityDamage}} · Enemies flashed {{(index .Metrics .SteamID).EnemiesFlashed}} · Plants {{(index .Metrics .SteamID).BombPlants}} · Defuses {{(index .Metrics .SteamID).BombDefuses}} · MVPs {{(index .Metrics .SteamID).MVPs}} · Money {{(index .Metrics .SteamID).MoneySpent}}

## Per-round

| Round | K | A | D | Traded | Survived | KAST | DMG | Util dmg | Money start | Equip | Spent |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
{{range .Rounds}}| {{.Round}} | {{.Kills}} | {{.Assists}} | {{.Deaths}} | {{.Traded}} | {{.Survived}} | {{.KAST}} | {{.DMG}} | {{.UtilDmg}} | {{.MoneyStart}} | {{.Equip}} | {{.Spent}} |
{{end}}
---

Generated {{.GeneratedAt}} by Spectra from the local library.
