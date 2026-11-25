# Career report — {{.Name}} ({{.SteamID}})

- Matches played: {{index .Metrics "career_matches"}} · Win {{index .Metrics "win_pct"}}
- ADR {{index .Metrics "career_adr"}} (σ {{index .Metrics "career_adr_sigma"}}) · HS% {{index .Metrics "career_hs_pct"}} · K/D {{index .Metrics "career_kd"}} · KAST {{index .Metrics "career_kast"}}
- Opening kill tags {{index .Metrics "career_opening_rate"}} · Trade rate {{index .Metrics "career_trade_rate"}}
- Clutches {{index .Metrics "career_clutches"}} (won {{index .Metrics "career_clutch_win_rate"}}) · Enemies flashed per match {{index .Metrics "career_avg_enemies_flashed"}} · Utility damage per match {{index .Metrics "career_avg_util_damage"}}

## Match history

| Imported | Map | Result | Score | Start | K | D | ADR | KAST |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
{{range .Matches}}| {{.ExtractedAt}} | {{.Map}} | {{if .Win}}win{{else}}loss{{end}} | {{.ScoreCT}}–{{.ScoreT}} | {{.StartSide}} | {{.Kills}} | {{.Deaths}} | {{with .ADR}}{{printf "%.1f" .}}{{else}}—{{end}} | {{with .KASTPct}}{{printf "%.1f" .}}%{{else}}—{{end}} |
{{end}}
---

Generated {{.GeneratedAt}} by Spectra from the local library.
