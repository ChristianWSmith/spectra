# GUI examples and how to reproduce them

Companion to `GUI-VERIFICATION.md`. Items 3, 4 and 7 need a person to look.

Demo names match the golden files in your library. Match ids in your library may
differ, so find each demo by its name, then go to the round and the tick.

## 3. Overlay the blocking geometry (how to)

A dev tool renders one kill's sight lines over the map: the plan view (over the
radar) and a side view (x against z). Green lines are clear. Red lines are blocked,
and the blocking triangles are marked in red.

Run it from `src/internal/encounter` with the app's data directory (it holds the
library database, `matches/`, `maps/` and `worldcol/`):

```sh
cd src/internal/encounter
SPECTRA_ENC=$HOME/.local/share/spectra SPECTRA_DATA=$HOME/.local/share/spectra \
SPECTRA_OVERLAY_MATCH=<match id> SPECTRA_OVERLAY_TICK=<kill tick> \
SPECTRA_OVERLAY_OUT=/tmp/overlays go test -count=1 -run TestKillOverlay -v
```

It writes `kill-<match>-<tick>-plan.png` and `kill-<match>-<tick>-side.png`. The
wireframe is dense, so look for the red lines and the red triangles where they meet.
On this machine the same kill (de_ancient, match 1, tick 33911) produced the
`side` image; the blocked lines pass through dense geometry close to the players.

## 4. Encounter examples (replay)

Encounter windows from a fresh de_cache import, with the seed tick (the shot that
started the window). Open the match in the replay at the window's start and step
forward to the seed tick. Check that the two players are visible to each other.

| id | demo | round | window ticks | seed tick | shooter | enemy | samples |
|---|---|---|---|---|---|---|---|
| 176 | de_cache.dem.zst | 12 | 65655-66230 | 65984 | kRaSnaL | Zuedsta | 576 |
| 270 | de_cache.dem.zst | 18 | 102484-102790 | 102759 | FREELOOK | Zuedsta | 307 |
| 287 | de_cache.dem.zst | 19 | 111311-111616 | 111444 | -meg2k | llorente | 306 |
| 269 | de_cache.dem.zst | 18 | 102499-102796 | 102714 | donk666 | adamS | 298 |
| 285 | de_cache.dem.zst | 19 | 111278-111566 | 111430 | donk666 | llorente | 289 |
| 284 | de_cache.dem.zst | 19 | 111373-111616 | 111396 | Magnojezzz | llorente | 244 |
| 72 | de_cache.dem.zst | 5 | 30571-30794 | 30706 | forever2kELO | adamS | 224 |

Design point to decide: mutual fights produce two windows (A shoots B, then B
shoots A, same stretch of time). Ids 175 and 176 are one example. Merge them, or
keep both per-shooter windows?

## 7. Unexplained kills (replay)

36 bullet kills blocked in every frame of the window (no wallbang, no smoke, no
penetration, not grenade or fire). Each one should be checked in the replay at the
kill tick. For the overlay, use the procedure in section 3.

| # | demo | map | round | tick | killer | victim | weapon |
|---|---|---|---|---|---|---|---|
| 1 | de_ancient.dem.zst | de_ancient | 1 | 8013 | dziugss | -kelq | USP-S |
| 2 | de_ancient.dem.zst | de_ancient | 5 | 33911 | djgor1lla | REL7 | AK-47 |
| 3 | de_ancient.dem.zst | de_ancient | 9 | 53473 | Bymas | donk666 | M4A4 |
| 4 | de_ancient.dem.zst | de_ancient | 11 | 60882 | awks | Oquvece | AWP |
| 5 | de_ancient.dem.zst | de_ancient | 12 | 67626 | Bymas | awks | M4A4 |
| 6 | de_ancient.dem.zst | de_ancient | 15 | 83160 | donk666 | dziugss | Desert Eagle |
| 7 | de_ancient.dem.zst | de_ancient | 19 | 104144 | xPOZYYY | donk666 | Desert Eagle |
| 8 | de_ancient.dem.zst | de_ancient | 24 | 147040 | donk666 | xPOZYYY | M4A1 |
| 9 | de_ancient.dem.zst | de_ancient | 25 | 151563 | lilpeepfan- | xPOZYYY | M4A1 |
| 10 | de_ancient.dem.zst | de_ancient | 28 | 166154 | Oquvece | djgor1lla | M4A1 |
| 11 | de_anubis.dem.zst | de_anubis | 14 | 81712 | donk666 | tamefear | AK-47 |
| 12 | de_cache.dem.zst | de_cache | 11 | 61274 | adamS | forever2kELO | AK-47 |
| 13 | de_cache.dem.zst | de_cache | 12 | 64526 | forever2kELO | adamS | M4A1 |
| 14 | de_cache.dem.zst | de_cache | 20 | 118611 | adamS | -meg2k | M4A1 |
| 15 | de_cache.dem.zst | de_cache | 21 | 124303 | llorente | Magnojezzz | MP9 |
| 16 | de_dust2.dem.zst | de_dust2 | 8 | 59849 | -EmAa--- | donk666 | AWP |
| 17 | de_dust2.dem.zst | de_dust2 | 11 | 87488 | donk666 | shen | AK-47 |
| 18 | de_inferno.dem.zst | de_inferno | 5 | 35739 | lilpeepfan- | Urosi | AK-47 |
| 19 | de_inferno.dem.zst | de_inferno | 6 | 43389 | oyesil- | Ixolibul | M4A1 |
| 20 | de_inferno.dem.zst | de_inferno | 6 | 46267 | Afodowapo | lilpeepfan- | M4A1 |
| 21 | de_inferno.dem.zst | de_inferno | 10 | 73683 | sh1pz09 | pwL | AWP |
| 22 | de_inferno.dem.zst | de_inferno | 10 | 75594 | lilpeepfan- | blaze999- | AK-47 |
| 23 | de_inferno.dem.zst | de_inferno | 14 | 102068 | Afodowapo | s1mbalance | AK-47 |
| 24 | de_inferno.dem.zst | de_inferno | 14 | 102712 | Afodowapo | Ixolibul | AK-47 |
| 25 | de_inferno.dem.zst | de_inferno | 18 | 130486 | lilpeepfan- | sh1pz09 | M4A4 |
| 26 | de_inferno.dem.zst | de_inferno | 18 | 131761 | blaze999- | lilpeepfan- | MAC-10 |
| 27 | de_inferno.dem.zst | de_inferno | 21 | 152431 | Ixolibul | Afodowapo | AK-47 |
| 28 | de_mirage.dem.zst | de_mirage | 3 | 25427 | Bymas | lilpeepfan- | AK-47 |
| 29 | de_mirage.dem.zst | de_mirage | 7 | 56514 | Bymas | -R3ZLOO | AK-47 |
| 30 | de_mirage.dem.zst | de_mirage | 11 | 82554 | Bymas | lilpeepfan- | AK-47 |
| 31 | de_mirage.dem.zst | de_mirage | 12 | 86476 | donk666 | vil111 | AK-47 |
| 32 | de_mirage.dem.zst | de_mirage | 17 | 118836 | sensacja | upE | AK-47 |
| 33 | de_mirage.dem.zst | de_mirage | 18 | 124094 | donk666 | sensacja | AK-47 |
| 34 | de_mirage.dem.zst | de_mirage | 18 | 125161 | upE | REL7 | AK-47 |
| 35 | de_nuke.dem.zst | de_nuke | 7 | 58698 | Kr3shProSkuf | -NEOOOOOOOOO | MP9 |
| 36 | de_nuke.dem.zst | de_nuke | 14 | 91374 | Ayuwapo | rbfurious | Desert Eagle |
