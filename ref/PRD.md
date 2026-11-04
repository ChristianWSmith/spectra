# Spectra
## Product Requirements Document (PRD)

**Product:** Spectra  
**Category:** CS2 Demo Analysis & Visualization Platform  
**Product descriptor:** A comprehensive CS2 demo analysis platform combining tactical replay, advanced match statistics, positional analytics, utility analysis, and detailed game-data inspection.  
**Platform:** Desktop application  
**Deployment model:** Local-first, offline-capable  
**Status:** Initial product specification  
**Version:** 1.1

---

# 1. Product Overview

## 1.1 Vision

Spectra aims to be the definitive environment for inspecting, understanding, and analyzing Counter-Strike 2 matches.

It transforms raw CS2 demo files into an interactive, searchable, and deeply explorable representation of a match.

Rather than limiting users to conventional demo playback and a handful of statistics, Spectra exposes as much information as the underlying demo contains, allowing users to move seamlessly between high-level match analysis and granular, tick-level inspection.

The application should serve both casual players looking to understand why they lost a round and advanced users who want to investigate individual engagements, reconstruct positioning, analyze utility usage, inspect raw game events, or build custom statistical queries.

## 1.2 Product Philosophy

Spectra is built around five principles.

**1. Comprehensive data access**

Extract and preserve as much useful information from a demo as technically possible. Do not unnecessarily discard data simply because the initial interface does not use it.

**2. Easy to use, extremely full-featured, power-user ready**

The application should be approachable without sacrificing analytical depth. Basic workflows should be obvious, while advanced functionality should be accessible through progressive disclosure, contextual navigation, configurable workspaces, and developer tools.

**3. Everything is connected**

Statistics, events, positions, audio, and round information should not exist in isolated sections. A user should be able to click a statistic, identify the events contributing to it, and immediately inspect those events in synchronized replay.

**4. Local-first and independent**

Ordinary application functionality should not require CS2, Steam, a running game, a remote server, or an internet connection. Demos and extracted data should remain under the user's control.

**5. Distinguish fact from inference**

The application must clearly distinguish directly recorded information, reconstructed information, calculated statistics, and heuristic conclusions. Inferred tactical observations should never be presented as objective game facts.

---

# 2. Goals and Non-Goals

## 2.1 Primary Goals

- Import, organize, and analyze CS2 demo files.
- Reconstruct matches as detailed, interactive 2D tactical replays.
- Provide comprehensive match, player, round, combat, economy, and utility statistics.
- Expose a searchable timeline of match events.
- Preserve and visualize per-tick positional information.
- Extract and synchronize voice data when available.
- Support cross-match player and team analysis.
- Provide raw-data inspection and advanced custom analytics.
- Offer export functionality for data, reports, audio, and visualizations.
- Operate reliably without requiring the original game installation.

## 2.2 Non-Goals

The following are explicitly outside the core product scope:

- Replacing CS2's native 3D demo playback.
- Requiring a live CS2 installation to render or inspect demos.
- Hosting matches, matchmaking, or managing FACEIT accounts.
- Providing a live game overlay or real-time anti-cheat functionality.
- Reconstructing information that was never recorded in the demo.
- Guaranteeing that every statistic or feature is available in every demo format.
- Requiring cloud services for ordinary analysis.

---

# 3. Target Users

## 3.1 Competitive Players

Players reviewing their own matches to identify mistakes, understand engagements, improve positioning, and evaluate performance.

Primary needs:
- Easy match import and review.
- Round-by-round breakdowns.
- Tactical replay.
- Death and engagement analysis.
- Utility and positioning feedback.
- Personal performance trends.

## 3.2 Advanced Players and Team Analysts

Users conducting detailed tactical analysis across multiple matches.

Primary needs:
- Positional reconstruction.
- Team setups and rotations.
- Execute and retake analysis.
- Utility effectiveness.
- Communication review.
- Cross-match comparisons.
- Custom statistical queries.

## 3.3 Demo Enthusiasts and Researchers

Users interested in the technical details of CS2 demos and the game state they contain.

Primary needs:
- Raw event and message inspection.
- Entity and property inspection.
- Tick-level data.
- Schema exploration.
- Data export.
- Reproducible extraction.

---

# 4. Core Application Structure

The application should be organized around the following primary sections:

1. **Library** — Demo management and match discovery.
2. **Match Overview** — Match summary, scoreboard, and performance.
3. **Rounds** — Round browser and individual round analysis.
4. **Tactical Replay** — Interactive 2D match reconstruction AND the
   universal event explorer (its landmark feed — §5.5; one canonical
   event-navigation and inspection experience per match, owned by Replay).
5. **Players** — Individual player profiles and statistics.
6. **Analytics** — Advanced statistical and tactical analysis.
7. **Utility** — Grenade and equipment analysis.
8. **Communications** — Voice and chat review.
9. **Data Explorer** — Raw demo inspection and custom queries.
10. **Settings** — Application configuration and data management.

These should be logical destinations rather than rigidly isolated modules. Contextual links should allow users to navigate directly from one area to another without losing their current match, round, player, or tick selection.

---

# 5. Functional Requirements

Priority definitions:

- **P0:** Essential foundation or defining product capability.
- **P1:** Important feature for a complete release.
- **P2:** Advanced capability or future expansion.

## 5.1 Demo Library and Match Management

**Objective:** Provide a centralized, searchable library for all imported demos.

### Requirements

**P0**
- Import individual `.dem` files.
- Support drag-and-drop import.
- Parse demos in the background.
- Display parsing progress and errors.
- Detect duplicate demos.
- Extract basic match metadata.
- Identify map, match duration, rounds, teams, players, and score where available.
- Display parser and demo compatibility information.
- Maintain a searchable match library.
- Allow sorting and filtering by date, map, player, team, score, and other metadata.
- Allow users to delete extracted data without deleting original demos.
- Preserve original demo files.

**P1**
- Batch import.
- Support compressed demo formats such as `.dem.zst` and `.dem.gz`.
- Detect incomplete or corrupted demos.
- Support recovery and reprocessing.
- Recognize companion `.dem.info` files.
- Allow custom match tags, notes, favorites, and collections.
- Support match comparison.
- Maintain player identities across matches using SteamID.
- Provide library-wide performance summaries.

**P2**
- Advanced library queries.
- Automatic match categorization.
- Duplicate detection using content hashes.
- Match history anomaly detection.
- Automated import from user-configured directories.

### Match Metadata

Where available, retain:

- Map and game mode.
- Match duration.
- Server information.
- Demo build/version.
- Tickrate and relevant timing information.
- Team names and player rosters.
- SteamID64 values.
- Final score and round progression.
- Overtime information.
- Relevant ConVars.
- Recording source where identifiable.
- Parser version and extraction provenance.

## 5.2 Match Overview and Scoreboard

**Objective:** Provide an immediate understanding of match performance.

### Match Overview — P0

Display:

- Final score.
- Half-time scores.
- Round-by-round progression.
- Match duration.
- Team rosters.
- Player performance.
- Opening kills.
- MVPs.
- Economy overview.
- Bomb plants and defuses.
- Major match events.

### Advanced Scoreboard — P0/P1

Provide sortable, configurable player statistics.

**Core performance**
- Kills, deaths, assists.
- K/D and KDA.
- ADR.
- Headshot percentage.
- KAST.
- Total damage.
- Damage per round.
- Rounds played.
- Multi-kills.

**Engagements**
- Opening kills and deaths.
- Entry kills.
- Trade kills.
- Trade deaths.
- Successful and unsuccessful trades.
- Clutch attempts and wins.
- Kill streaks.

**Utility**
- HE damage.
- Flash assists.
- Enemies flashed.
- Flash duration where available.
- Utility damage and kills.
- Utility usage.

**Weapons**
- Kills and damage by weapon.
- Shots fired.
- Hits.
- Accuracy.
- Hitgroup distribution.
- Weapon-specific headshot percentage where derivable.

**Economy**
- Money over time.
- Equipment value.
- Purchase and pickup history.
- Lost equipment.
- Bomb plants and defuses.

All calculated statistics must have documented definitions. Users should be able to configure certain definitions, such as trade windows and round classifications.

Every statistic should support contextual drill-down into the underlying rounds and events.

## 5.3 Round Browser and Round Analysis

**Objective:** Make individual rounds easy to find, inspect, and compare.

### Requirements — P0

- Display all rounds chronologically.
- Show round winner and ending condition.
- Show round duration.
- Show starting and ending economy.
- Show player survival and kill information.
- Display opening engagements.
- Display bomb activity.
- Display round MVP.
- Provide direct access to the tactical replay at round start.

### Round Classification — P1

Support configurable classifications:

- Pistol rounds.
- Anti-eco rounds.
- Eco rounds.
- Force buys.
- Full buys.
- Bonus rounds.
- Save rounds.
- Retakes.
- Post-plants.
- Clutches.

Classification rules should be transparent and configurable.

### Detailed Round View — P1

For any selected round, provide:

- Kill feed.
- Damage events.
- Player health and armor.
- Weapons and equipment.
- Money changes.
- Utility events.
- Bomb lifecycle.
- Player positions.
- Voice and chat timeline where available.
- Round notes and annotations.

Users should be able to bookmark rounds, add notes, apply tags, and compare selected rounds.

## 5.4 2D Tactical Replay

**Objective:** Provide a complete interactive reconstruction of the match in a top-down tactical environment.

This is one of Spectra's defining features and should receive significant engineering and design attention.

### Map Rendering — P0

- Render the map in a calibrated 2D representation.
- Display player positions.
- Display player orientation.
- Display player names or configurable identifiers.
- Display the bomb.
- Display grenades and relevant utility effects.
- Support zooming and panning.
- Support configurable player colors.
- Support customizable map and radar styles.
- Support map annotations and drawing tools.

### Playback Controls — P0

- Play and pause.
- Variable playback speed.
- Frame/tick stepping.
- Jump to round start.
- Jump to kills, deaths, plants, defuses, and other events.
- Landmark scrubbing (event markers on the replay scrubber).
- Reverse playback where supported by stored data.
- Loop selected intervals.
- Select custom playback ranges.
- Synchronize playback with the landmark feed (in Replay).

### Player Visualization — P0/P1

- Current position.
- View direction.
- Historical movement trails.
- Player health and armor.
- Alive/dead status.
- Current weapon where available.
- Movement speed and velocity where reconstructable.
- Configurable player labels.
- Individual player visibility controls.

### Tactical Overlays — P1

- Player view cones.
- Team separation.
- Player proximity.
- Site control.
- Map control.
- Rotations and routes.
- Post-plant positioning.
- Crossfire visualization.
- Player clustering.
- Last-known enemy positions where the required visibility information can be reconstructed.

### Advanced Replay — P2

- Follow a selected player.
- Follow the bomb.
- Follow a grenade.
- Follow a killer or victim.
- Split-screen player comparisons.
- Ghost replay, overlaying two rounds or matches.
- Snapshot capture.
- Custom replay annotations.
- Exportable 2D replay video.

### Utility Visualization

Display:
- Grenade trajectories.
- Thrower and throw timing.
- Detonation position.
- Smoke volume and lifetime.
- Inferno area and duration.
- Flash effects where available.
- Utility interactions and relevant geometry.

The application should distinguish actual recorded trajectories and effects from reconstructed approximations.

## 5.5 Universal Event Explorer

**Objective:** Make every meaningful recorded match event searchable and inspectable.

The event explorer lives in the **Replay landmark feed**: Replay is the
central application component for match events, not merely a visual kill
feed. One canonical event-navigation and inspection experience per match,
owned by Replay — discovery (configurable landmark categories, sparse by
default), filtering, inspection (payloads, chat, generic events) and
navigation (seek, round/player/tick context) all happen there; the other
analytical views link into it with their context instead of browsing
events themselves.

### Event Categories — P0/P1

- Kills.
- Deaths.
- Damage.
- Weapon fire.
- Reloads.
- Weapon purchases.
- Weapon pickups and drops.
- Equipment changes.
- Grenade throws.
- Grenade bounces.
- Grenade detonations.
- Smoke events.
- Inferno events.
- Blinds and flashes.
- Bomb plants.
- Bomb drops and pickups.
- Defuses.
- Round transitions.
- Player connections and disconnections.
- Team changes.
- Chat.
- Voice.
- Sound events.
- Relevant ConVar changes.
- Other recorded game events.

### Filtering — P1

Users should be able to filter by:

- Event type.
- Round.
- Player.
- Team.
- Weapon.
- Tick or time range.
- Position.
- Damage amount.
- Distance.
- Event properties.
- Outcome.

Support combinations of filters and saved filter presets.

### Event Inspection — P1

Selecting an event should expose:

- Timestamp and tick.
- Event type.
- Relevant players.
- Relevant entities.
- Weapon and equipment information.
- Position where available.
- Raw event payload.
- Related events.
- Associated network or user-message information where applicable.

### Event Correlation — P2

Provide tools for identifying relationships between events:

- Shots preceding a kill.
- Damage leading to a death.
- Trade opportunities.
- Flash events preceding kills.
- Utility usage preceding an execute.
- Bomb drops preceding round losses.
- Rotations following opening engagements.
- Voice communications surrounding critical events.

Correlations must be traceable to the underlying data and should not automatically imply causation.

## 5.6 Combat and Engagement Analysis

**Objective:** Enable detailed examination of individual fights and their outcomes.

### Requirements — P1

**Kill analysis**
- Killer and victim.
- Weapon.
- Hitgroup.
- Distance.
- Wallbang/penetration information where available.
- Smoke kills.
- Blind kills.
- No-scope kills.
- Flash-assisted kills.
- Relevant positioning.
- Health and armor context.

**Damage analysis**
- Damage dealt and received.
- Damage by weapon.
- Damage by player.
- Damage by hitgroup.
- Damage before death.
- Damage without a resulting kill.
- Friendly-fire damage.
- Damage conversion into kills.

**Engagement analysis**
- Opening duels.
- Entry engagements.
- Trade kills.
- Trade opportunities.
- Untraded deaths.
- Multi-kills.
- Clutch engagements.
- Isolated engagements.
- Multi-player engagements.

### Advanced Ballistics — P2

Where supported by the demo build and available event data:

- Bullet impacts.
- Shot-to-hit correlation.
- Penetration analysis.
- Shot-to-kill correlation.
- Shot distribution.
- Engagement positions.
- Weapon-specific accuracy analysis.

Do not assume that every relevant ballistics event is emitted in every recording.

## 5.7 Economy and Equipment Analysis

**Objective:** Reconstruct team and player economy throughout a match.

### Requirements — P1

- Starting money.
- Money changes.
- Equipment value.
- Purchases.
- Weapon pickups.
- Weapon drops.
- Grenade inventory.
- Defuse kit ownership.
- Equipment lost on death.
- Money remaining at round start.
- Money remaining at round end.
- Loss bonus progression where reconstructable.

### Advanced Analytics — P2

- Equipment value versus round outcome.
- Damage per dollar.
- Kills per dollar.
- Lost equipment value.
- Force-buy performance.
- Pistol conversion rates.
- Eco conversion rates.
- Purchase consistency.
- Player-specific spending patterns.

Distinguish actual purchase events from inferred purchase behavior. Buy-menu intent is not assumed to be recorded.

## 5.8 Utility Analysis

**Objective:** Provide a detailed environment for reviewing grenade usage and effectiveness.

### Supported Utility

- HE grenades.
- Flashbangs.
- Smoke grenades.
- Molotovs and incendiaries.
- Decoys.
- Relevant equipment.

### Requirements — P1

For each utility event, record and display where available:

- Thrower.
- Throw tick and position.
- Trajectory.
- Bounces.
- Detonation tick and position.
- Lifetime.
- Relevant effects.
- Associated damage or player impact.

### Smoke Analysis

- Placement.
- Coverage.
- Duration.
- Re-smokes.
- Overlapping smokes.
- Gaps in coverage.
- Smoke timing relative to executes and rotations.

### Flash Analysis

- Players affected.
- Blind duration.
- Self-flashes.
- Friendly flashes.
- Flash assists.
- Flash effectiveness.

### HE and Incendiary Analysis

- Damage.
- Friendly damage.
- Area coverage.
- Duration.
- Damage denial.
- Relevant interactions.

### Advanced Utility Tools — P2

- Utility effectiveness metrics.
- Lineup catalog.
- Searchable lineups.
- Saved and annotated lineups.
- Lineup comparison.
- Utility usage heatmaps.
- Round-to-round utility comparisons.
- Utility coordination analysis.

Any inferred coverage, intended target, or tactical purpose must be labeled as an inference.

## 5.9 Voice and Communications

**Objective:** Integrate voice communications directly into match analysis.

Voice integration is a major potential differentiator for Spectra.

### Requirements — P1

Where voice data is present in the demo:

- Extract and decode audio.
- Preserve timestamps.
- Identify the associated player where attribution is available.
- Generate individual player tracks.
- Generate combined match audio.
- Synchronize playback with the tactical replay.
- Display voice activity on the timeline.
- Allow individual player muting and volume control.
- Allow audio speed adjustment.
- Support looping and export.

### Audio Visualization — P1

- Per-player waveform.
- Voice activity markers.
- Match-wide communication timeline.
- Click-to-play audio segments.
- Individual and combined tracks.

### Transcription — P2

Optional local transcription:

- Timestamped transcript.
- Player attribution.
- Searchable text.
- Confidence indicators.
- Manual transcript corrections.
- SRT, VTT, TXT, and JSON export.

### Communication Analytics — P2

- Callout frequency.
- Utility calls.
- Enemy sightings.
- Rotation calls.
- Assistance requests.
- Tactical instructions.
- Acknowledgements.
- Communication around engagements.
- Communication before and after critical events.

Any classification or interpretation of communications must link to the original audio and remain distinguishable from the actual recorded speech.

### Important Availability Limitation

Voice data is not guaranteed to exist in all demos. The initial parser report identified substantial Opus voice data in the examined FACEIT demo, but did not establish equivalent availability for Valve matchmaking demos.

Voice extraction and decoding must therefore be treated as conditional capabilities, not universal demo features.

## 5.10 Movement and Positional Analytics

**Objective:** Turn the demo's recorded entity state into a detailed historical representation of player movement and positioning.

### Requirements — P0/P1

Capture and retain player state at sufficient temporal resolution to reconstruct movement.

Where available:

- Position.
- View angles.
- Velocity.
- Movement speed.
- Alive/dead state.
- Health.
- Armor.
- Active weapon.
- Relevant movement state.

### Heatmaps — P1

- Player position heatmaps.
- Team position heatmaps.
- Kill locations.
- Death locations.
- Damage locations.
- Engagement locations.
- Utility locations.
- Bomb plant and defuse locations.
- Time-weighted position distributions.

### Spatial Analytics — P2

- Average distance between teammates.
- Team spread and clustering.
- Distance from bomb.
- Distance from site.
- Choke-point occupancy.
- Rotation routes.
- Positioning before engagements.
- Movement before first contact.
- Time spent in map regions.
- Player overlap and crossfire opportunities.

### Advanced Positioning Analysis — P2

Potential analytical observations:

- Overexposure.
- Isolation.
- Poor trade spacing.
- Defensive gaps.
- Excessive clustering.
- Late rotations.
- Inefficient movement.
- Missed crossfire opportunities.

These should be presented as measurable heuristics with supporting replay evidence, not authoritative judgments.

## 5.11 Team Tactical Analysis

**Objective:** Identify and compare recurring team behaviors and tactical patterns.

### Offensive Analysis — P2

- Site preference.
- Execute frequency.
- Execute success rate.
- Plant success.
- First-contact positions.
- Entry success.
- Trade success.
- Default patterns.
- Splits.
- Late executes.
- Post-plant positioning.

### Defensive Analysis — P2

- Site setups.
- Defensive aggression.
- Information-gathering behavior.
- Site holds.
- Retakes.
- Saves.
- Rotation timing.
- Site abandonment.
- Player distribution.

### Team Coordination

- Trade spacing.
- Trade timing.
- Flash and utility sequencing.
- Player clustering.
- Rotation coordination.
- Communication patterns.
- Post-plant coordination.

### Pattern Recognition

Identify recurring:
- Setups.
- Routes.
- Executes.
- Utility combinations.
- Defensive responses.
- Rotation patterns.

Allow users to compare similar rounds and investigate changes in performance.

## 5.12 Clutch Analysis

**Objective:** Provide dedicated analysis of clutch situations.

### Requirements — P1

- Detect 1v1 through 1v5 situations.
- Identify clutch start and end.
- Identify participants.
- Record bomb state and timer.
- Record health and equipment.
- Record relevant positions.
- Record kills and damage.
- Record utility usage.
- Record outcome.

### Advanced Clutch Review — P2

- Clutch success rate by size.
- Clutch success by map and side.
- Clutch duration.
- Clutch weapon performance.
- Clutch utility effectiveness.
- Clutch replay mode.
- Last-known enemy positions.
- Communication review.
- Decision and repositioning analysis.

## 5.13 Player Profiles and Cross-Match Analytics

**Objective:** Build persistent player profiles and enable longitudinal performance analysis.

### Requirements — P1

- Identify players by SteamID.
- Track match participation.
- Preserve match-specific names.
- Maintain player notes and tags.
- Provide player-specific match history.
- Display career statistics across imported demos.

### Statistics

- K/D and ADR trends.
- Headshot percentage.
- KAST.
- Opening duel performance.
- Trade statistics.
- Clutch performance.
- Utility effectiveness.
- Weapon performance.
- Map performance.
- Side-specific performance.
- Consistency and variance.

### Advanced Analytics — P2

- Player comparisons.
- Role tendency analysis.
- Performance trends.
- Map and position preferences.
- Behavioral archetypes.
- Match-to-match performance changes.

Potential archetypes include entry, AWP, support, lurk, anchor, rotator, trade fragger, and IGL-like tendencies.

These should be described as statistical tendencies rather than definitive player roles.

## 5.14 Sound and Game-Event Analysis

**Objective:** Expose recorded sound-related information for deeper investigation.

### Requirements — P2

- Extract sound events where available.
- Display sound events on the timeline.
- Record associated event type and parameters.
- Show source position or entity where available.
- Filter by event type and player.
- Correlate sound events with movement, combat, and rotations.
- Provide spatial sound-event visualizations.

Important: a recorded sound event does not necessarily establish what a particular player actually heard.

## 5.15 Chat and Match Administration

**Objective:** Preserve contextual information surrounding the match.

### Requirements — P1

- Chat timeline.
- Player attribution.
- Timestamp preservation.
- Search and filtering.
- Export.
- Synchronization with replay.

Where applicable, support public-chat decryption using the required companion `.dem.info` key.

Encrypted team chat should not be assumed to be recoverable.

### Match Administration — P1/P2

Where available:

- Player connections and disconnections.
- Team changes.
- Name changes.
- SteamID information.
- Clan tags.
- Crosshair codes.
- Ping and other sampled player status.
- Warmup and match phases.
- Halftime and side changes.
- Restarts and match end.
- Relevant server configuration and ConVars.

HLTV and spectator-related metadata should be handled conditionally based on recording availability.

## 5.16 Advanced Statistics and Custom Analytics

**Objective:** Allow advanced users to define and investigate their own metrics.

This is a major long-term differentiator.

### Custom Metric Builder — P2

Support:
- Event counts.
- Sums.
- Averages.
- Medians.
- Minimum and maximum.
- Standard deviations.
- Percentiles.
- Ratios.
- Rates.
- Rolling windows.
- Time-weighted metrics.
- Distributions.
- Correlations.
- Conditional expressions.

Allow filtering and aggregation by:
- Player.
- Team.
- Round.
- Map.
- Side.
- Weapon.
- Event type.
- Time range.
- Position.

### Example Custom Queries

- How many deaths did a player suffer without being traded?
- How often did a player successfully trade within a configurable time window?
- How many kills followed a teammate's flash?
- How much utility value was spent per round?
- How often did a team convert a man advantage?
- How frequently did a player die while isolated from teammates?
- What percentage of opening kills resulted in round wins?

### Visualization

Support:
- Line charts.
- Bar charts.
- Histograms.
- Scatter plots.
- Heatmaps.
- Box plots.
- Radar charts.
- Stacked charts.
- Time-series charts.
- Spatial visualizations.

Metrics should support formula documentation, sample sizes, data provenance, and missing-data indicators.

## 5.17 Raw Data and Developer Mode

**Objective:** Make Spectra useful as a technical inspection environment, not just a consumer analytics application.

### Requirements — P1/P2

Expose inspectable representations of:

- Demo stream commands.
- Frames.
- Packets.
- Network messages.
- Game events.
- User messages.
- Entity state and properties.
- String tables.
- ConVars.
- Console commands.
- Voice metadata.
- Encrypted payload metadata.
- Raw event key/value data.

### Schema Browser

Provide searchable access to:
- Registered game events.
- User-message types.
- Network-message types.
- Entity schemas.
- Entity properties.
- Parser-supported fields.

The initial parser report identified 289 registered game events and 140 user-message types in its examined environment. These counts should be treated as parser/build-specific, not permanent product constants.

### Advanced Inspection

- Entity inspector.
- Raw event inspector.
- Schema browser.
- Developer console.
- Query language.
- JSON export.
- SQL access to extracted data.
- Saved queries.
- Query history.
- Query performance information.

Unknown events and fields should be preserved whenever possible rather than silently discarded.

## 5.18 Video, Clips, and Reporting

**Objective:** Allow users to turn analysis into shareable artifacts.

### Requirements — P1/P2

- Bookmark important moments.
- Create clips from arbitrary tick ranges.
- Create clips from kills, deaths, clutches, utility, and rounds.
- Combine multiple clips.
- Add annotations.
- Capture replay snapshots.
- Export 2D replay as video.
- Export GIFs.
- Configure resolution, speed, and overlays.
- Include optional synchronized audio.

### Reports

- Match reports.
- Player reports.
- Round reports.
- Team tactical reports.
- Utility reports.
- Comparative reports.

### Data Exports

- CSV.
- JSON.
- SQLite.
- Parquet.
- Audio.
- Transcripts.
- Position histories.
- Events.
- Trajectories.
- Other extracted datasets.

## 5.19 Customization and Workflow

**Objective:** Support both simple workflows and highly customized analytical environments.

### Requirements — P1/P2

- Customizable layouts.
- Multiple workspaces.
- Light and dark themes.
- Keyboard shortcuts.
- Command palette.
- Global search.
- Recent navigation.
- Saved filters.
- Configurable statistics columns.
- Multi-monitor support.
- Configurable storage and caching.
- User-defined defaults.

Suggested workspace presets:

- Match Review.
- Tactical Replay.
- Player Analysis.
- Utility Review.
- Communications.
- Statistics.
- Developer Mode.

## 5.20 Extensibility and Community

**Objective:** Establish an extensible platform for advanced users and community development.

### Potential Capabilities — P2

- Plugin system.
- Custom metrics.
- Custom event processors.
- Custom visualizations.
- Map extensions.
- Report templates.
- Export extensions.
- Lua or JavaScript scripting.
- Python integration.
- Local read-only API.
- Community-shared dashboards.
- Shared lineups and analytical tools.

Plugins must not compromise the integrity of the original demo files or extracted data.

---

# 6. Data Requirements and Technical Feasibility

A central requirement is that Spectra must preserve the distinction between what the demo records and what the application can derive.

## 6.1 Data Classification

Every extracted or displayed data point should be classified internally as one of:

**Recorded:** Directly represented in the demo.

**Reconstructed:** Derived by interpreting recorded state over time.

**Calculated:** Produced by a deterministic statistical formula.

**Inferred:** Produced through heuristics, assumptions, or probabilistic analysis.

This classification should be available to the UI and, where useful, visible to the user.

## 6.2 Important Data Constraints

The initial parser investigation identified several important limitations:

| Data category | Availability / constraint |
|---|---|
| Game events | Broad event coverage; parser/build-dependent |
| Entity state | Historical positional replay requires explicit sampling during parsing |
| Voice | Present in the examined FACEIT demo; not established for Valve MM demos |
| Public chat | Encrypted in applicable cases; companion `.dem.info` key may be required |
| Team chat | Encrypted team chat is not assumed recoverable |
| Player cosmetics | Not available from the examined demo data |
| GC match metadata | Not contained in the `.dem` itself |
| Buy-menu intent | Not recorded |
| POV input | Available only in applicable POV demos |
| Ballistics | Some events may not fire on every build |
| Sound events | Additional extraction required |
| User messages | Additional extraction required |
| HLTV metadata | Dependent on recording type |
| FACEIT ranks | Generally unavailable in FACEIT demos |

These constraints must inform product behavior, feature availability indicators, and documentation.

## 6.3 Extraction Requirements

The extraction pipeline should:

1. Parse the original demo.
2. Capture metadata.
3. Extract game events.
4. Extract relevant network and user messages.
5. Capture entity state at the required temporal resolution.
6. Extract voice metadata and audio where available.
7. Preserve raw event payloads.
8. Normalize data into application-friendly structures.
9. Generate derived statistics.
10. Index data for fast querying.
11. Record extraction warnings and provenance.

Historical positions must be captured during parsing; they cannot be reconstructed later if the relevant state was discarded.

The application should support configurable extraction profiles only where there is a meaningful storage or performance tradeoff. The default profile should capture the data required for the complete Spectra experience.

---

# 7. Architecture Requirements

## 7.1 Architectural Philosophy

Extraction must be independent of presentation.

The parser should not be tightly coupled to the tactical replay, scoreboard, or any particular analytics feature.

The normalized data layer should be the shared foundation for all application modules.

## 7.2 Proposed Architecture

### Layer 1: Demo Input

- Original demo files.
- Compressed demos.
- Companion metadata files.

Original files should remain immutable.

### Layer 2: Extraction Engine

Responsible for:
- Demo parsing.
- Game event extraction.
- Network and user-message extraction.
- Entity sampling.
- Voice extraction and decoding.
- Raw data preservation.
- Extraction validation.

### Layer 3: Normalized Data Layer

Responsible for storing:
- Match metadata.
- Teams and players.
- Rounds.
- Events.
- Entity histories.
- Position histories.
- Audio assets and metadata.
- Chat.
- Utility trajectories.
- Derived statistics.
- Parser and schema information.

### Layer 4: Application Services

- Library management.
- Match search.
- Statistical analysis.
- Replay state management.
- Query execution.
- Export.
- Visualization.
- Plugin management.

### Layer 5: Presentation

- Library.
- Match overview.
- Round browser.
- Tactical replay.
- Event landmark feed (in Replay).
- Analytics.
- Voice.
- Data explorer.
- Settings.

## 7.3 Storage

Use a local persistent database for structured data, with separate efficient storage for large or high-frequency datasets where appropriate.

SQLite is a strong candidate for the primary database.

Consider:
- Efficient indexed event storage.
- Compressed positional history.
- Separate audio assets.
- Cached derived analytics.
- Incremental extraction.
- Reproducible reprocessing.
- Schema and parser version tracking.

The exact storage layout should be benchmarked against realistic large demos and multi-match libraries before being finalized.

## 7.4 Performance

The application should support:

- Background parsing.
- Cancellation and resumability where feasible.
- Efficient database indexing.
- Lazy loading of expensive visualizations.
- Cached analytics.
- Fast event filtering.
- Smooth 2D replay.
- Efficient positional history access.
- Batch processing.
- Parallel processing where safe.

Performance should be measured against representative demos, including long matches and overtime games.

## 7.5 Portability

Target:
- Windows.
- Linux.
- macOS, if practical.

The application should not require elevated privileges for normal operation.

A portable mode should be considered.

---

# 8. User Experience Requirements

## 8.1 Progressive Disclosure

Spectra must not force every user to interact with its full analytical surface.

The default experience should be simple:

1. Import a demo.
2. Open the match.
3. View the scoreboard and round history.
4. Select a round.
5. Inspect the tactical replay.
6. Drill into relevant events or statistics.

Advanced features should be available without cluttering the primary workflow.

## 8.2 Contextual Navigation

The same match context should persist across sections.

Examples:

- Clicking a player's ADR should reveal the contributing rounds and damage events.
- Clicking a kill should jump to the relevant replay tick.
- Clicking a grenade should show its trajectory and associated effects.
- Clicking a voice segment should synchronize the replay.
- Clicking a heatmap region should reveal the underlying events.
- Clicking an event should expose its raw data when requested.

## 8.3 Search

Provide global search across:

- Matches.
- Players.
- Rounds.
- Events.
- Notes.
- Tags.
- Saved queries.
- Transcripts where available.

## 8.4 Power-User Experience

Provide:
- Keyboard-first navigation.
- Configurable shortcuts.
- Custom layouts.
- Advanced filters.
- Query tools.
- Export controls.
- Detailed inspection panels.

The interface should make advanced functionality discoverable rather than hiding it behind an entirely separate application.

---

# 9. Reliability, Integrity, and Privacy

## 9.1 Data Integrity

- Never modify original demos.
- Preserve raw extracted data where practical.
- Version parser outputs.
- Track extraction warnings.
- Validate normalized data.
- Support reprocessing.
- Avoid silently discarding unknown data.
- Provide recovery paths for failed imports.

## 9.2 Reproducibility

A derived statistic should be reproducible from:
- Its formula.
- Its source data.
- Its configuration.
- Its parser and schema versions.

Changes to extraction logic or metric definitions should not silently alter historical results without recording the change.

## 9.3 Privacy

- Keep demo data local by default.
- Make optional external processing explicit.
- Do not require cloud accounts.
- Provide control over extracted audio and transcripts.
- Provide export and deletion controls.
- Clearly explain when data leaves the machine.

---

# 10. Development Roadmap

The milestone roadmap that delivered this spec shipped in full on
2026-10-31 and was retired from this document (git history keeps it).
Prospective work — everything still missing — lives in one place:
`ref/MISSING.md`.

---

# 11. Success Metrics

The product should be evaluated on both analytical capability and usability.

## Core Product Metrics

- Successful demo import rate.
- Average demo parsing time.
- Parsing failure rate.
- Application memory usage.
- Database size per hour of demo footage.
- Replay responsiveness.
- Event search latency.
- Library search latency.
- Export success rate.

## User Experience Metrics

- Time from importing a demo to viewing the match.
- Time required to locate a specific round or event.
- Number of steps required to navigate from a statistic to its source events.
- Ease of discovering advanced functionality.
- Frequency of successful use of core workflows.

## Analytical Quality Metrics

- Completeness of extracted events.
- Positional reconstruction accuracy.
- Correctness of derived statistics.
- Accuracy of event-to-replay synchronization.
- Audio synchronization accuracy.
- Consistency of results across supported demo builds.

All quality metrics should be tested against known reference cases, not judged solely by visual inspection.

---

# 12. Key Product Differentiators

Spectra should distinguish itself through the combination of:

1. **Comprehensive 2D tactical replay** — Detailed historical match reconstruction without requiring a 3D game installation.
2. **Universal event timeline** — One searchable interface for the match's recorded activity (Replay's landmark feed).
3. **Integrated voice analysis** — Communications synchronized with gameplay.
4. **Deep positional analytics** — Historical player movement, spatial relationships, and heatmaps.
5. **Round-level analysis** — Detailed investigation of individual tactical situations.
6. **Utility intelligence** — Deep grenade trajectory, placement, timing, and effectiveness analysis.
7. **Cross-match player analytics** — Longitudinal performance and behavioral trends.
8. **Raw data transparency** — Access to the underlying information rather than only predefined statistics.
9. **Custom analytics** — User-defined metrics, queries, and visualizations.
10. **Contextual drill-down** — Every meaningful statistic or observation connects to the match evidence supporting it.

---

# 13. Open Technical Questions

All twelve questions were closed by pre-work research before Milestone 1;
the answers are baked into the code. Residual open questions and
settle-if-needed recipes are tracked in `ref/MISSING.md`.

---

# 14. Final Product Definition

Spectra is a local-first CS2 demo analysis platform that transforms raw match recordings into a comprehensive, interactive analytical environment.

It combines a detailed 2D tactical replay with advanced match statistics, player and team analytics, positional reconstruction, utility analysis, communications, and raw game-data inspection.

Its defining characteristic is not any single feature, but the integration of all these capabilities into one coherent environment: every round, statistic, engagement, position, and communication can be explored in context and traced back to the underlying match data.

**The guiding principle: If the demo contains the information, Spectra should strive to make it accessible, understandable, and useful.**
