# Round {{.Detail.Round.Number}} — {{.Match.Map}}

- Winner: **{{.Detail.Round.Winner}}** ({{.Detail.Round.Reason}})
- Duration: {{.Detail.Round.DurationS}} s · Site: {{.Detail.Round.BombSite}}
- MVP: {{.Detail.Round.MVPName}} ({{.Detail.Round.MVPReason}})
- First kill: {{.Detail.Round.FirstKillName}} on {{.Detail.Round.FirstDeathName}}
- Equip: CT {{.Detail.Round.EquipCT}} / T {{.Detail.Round.EquipT}}
- Ticks: {{.Detail.Round.StartTick}} → {{.Detail.Round.EndTick}} (freeze end {{.Detail.Round.FreezeEndTick}})

## Economy

| Side | Equip value | Money sum | Samples |
| --- | --- | --- | --- |
{{range .Detail.Economy}}| {{.Side}} | {{.EquipValue}} | {{.MoneySampledSum}} | {{.MoneySamples}} |
{{end}}
## Events

| Tick | Kind | Attacker | Victim | Weapon | HS | Dmg | Distance |
| --- | --- | --- | --- | --- | --- | --- | --- |
{{range .Detail.Events}}| {{.Tick}} | {{.Kind}} | {{.AttackerName}} | {{.VictimName}} | {{.Weapon}} | {{.Headshot}} | {{.Dmg}} | {{printf "%.0f" .Distance}} |
{{end}}
## Chat

| Tick | Name | Channel | Text |
| --- | --- | --- | --- |
{{range .Detail.Chat}}| {{.Tick}} | {{.Name}} | {{if eq .Channel "all"}}[ALL]{{else if eq .Channel "team"}}TEAM{{end}} | {{.Text}} |
{{end}}
---

Generated {{.GeneratedAt}} by Spectra from the local library.
