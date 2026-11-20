// Package extract is the demoinfocs-based extraction engine: it reads ONE
// raw CS2 .dem stream (the caller handles .zstd decompression) and emits a
// normalized models.ExtractedMatch — no report/markdown generation, and no
// demoinfocs type ever appears in the output. Parser options, handler
// families, the knife/warmup discard (rounds that are not counted play
// are never ingested), the pre-first-counted-round sanitization gate (the
// position/state/voice sinks only receive data from the first counted
// round's start tick on — owner ruling, 2026-11-12), and aggregation math
// all target the models contract.
package extract

import (
	"context"
	"fmt"
	"io"
	"time"

	demoinfocs "github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs"
	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/common"
	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/events"
	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/msg"
	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/option"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// ParserVersion is recorded per match (matches.parser_version).
const ParserVersion = "demoinfocs/v6@v6.0.0-rc.2"

// progressEvery throttles the progress callback to ~every 1000 frames
// (plus the one final call made after the parse ends).
const progressEvery = 1000

// PositionPlayer is one alive participant's sampled state at one frame —
// the unit the sidecar writer (internal/sidecar) encodes. Coordinates are
// world units; Yaw is ViewDirectionX (yaw) in degrees, normalized to
// -180..180 before the sink; Air/Duck map to the q16 flags bits and Side
// ("ct"/"t"/"") to the side bits. SteamID is the ACCUMULATOR KEY
// (extract.playerKey): the SteamID64 for humans, the synthetic
// 0xFF-prefixed bot key for bots — the same key space as players.steam_id
// and the sidecar slot table, so a bot's samples join the roster like any
// other player's (they used to carry 0 and were dropped at the writer).
type PositionPlayer struct {
	SteamID uint64
	X, Y, Z float32
	Yaw     float32
	Air     bool
	Duck    bool
	Side    string
}

// PositionSink receives one call per parsed frame with every alive playing
// participant. Implementations must not retain players (the slice is
// reused across frames). An error returned from AddFrame aborts the parse.
type PositionSink interface {
	AddFrame(tick int32, players []PositionPlayer) error
}

// StatePlayer is one participant's authoritative state sample at one frame —
// the unit the sidecar state stream (internal/sidecar) encodes as sparse
// change records. Every field is READ from the parser per frame (never
// arithmetically reconstructed): HP/Armor are pl.Health()/pl.Armor(), the
// weapon fields are pl.ActiveWeapon()/pl.Weapons() (canonical wepName
// vocabulary — the same strings events.weapon carries; MainMag/MainReserve
// are the MAIN — stowed — weapon's ammo, see scanWeapons), Attack is
// pl.IsPressingButton(common.ButtonAttack), and Reloading is
// pl.IsReloading (demoinfocs' live flag: set by the weapon_reload event,
// cleared when the active weapon changes — a weapon switch CANCELS the
// reload — and when the clip changes — the reload COMPLETED).
//
// Death is a sample, not an inference: Alive=false forces HP to 0, and the
// weapon/inventory/ammo fields are only sampled while alive (their entity
// props are gone when the pawn dies) — after death the sidecar keeps the
// last-known weapon/ammo as documented there, while HP stays a fresh 0
// every frame. Armor is the exception: it is read as-is even when dead (the
// stored value is whatever the demo carries; consumers gate on Alive).
// Money and Helmet join Armor in that as-read-while-dead group: Money lives
// on the player controller (m_iAccount — it survives death, and round-end
// cash lands while the player is still dead, which is exactly when a card
// needs it) and Helmet is the pawn's item-service flag read through the
// same entity path Armor uses (same lifetime, same sample-as-read rule).
// SteamID is the accumulator key (extract.playerKey — SteamID64 for
// humans, the synthetic 0xFF bot key for bots; same key space as
// PositionPlayer).
//
// Reloading is the exception that joins the WEAPON group, not the as-read
// group: it is only read while alive (a dead pawn reloads nothing) and is
// therefore false on every dead sample — the sidecar emits that fresh
// false, so a death MID-reload clears the flag instead of pinning a stale
// last-known reload (unlike weapon/ammo, which keep last-known through
// death: a reload is an ACTION, not equipment state).
type StatePlayer struct {
	SteamID     uint64
	HP          int  // 0..255, forced 0 when !Alive
	Armor       int  // 0..255 as read (even when !Alive)
	Money       int  // unspent account $, 0..65535 as read (even when !Alive)
	Helmet      bool // wearing head armor, as read (even when !Alive)
	Weapon      string
	Inventory   []string // canonical names; nil when !Alive
	MagAmmo     int      // active weapon magazine; 0 when !Alive
	ReserveAmmo int      // active weapon reserve; 0 when !Alive
	MainMag     int      // MAIN (stowed) weapon magazine; 0 when !Alive or no firearm carried
	MainReserve int      // MAIN (stowed) weapon reserve; 0 when !Alive or no firearm carried
	Attack      bool
	Reloading   bool // active weapon mid-reload (pl.IsReloading); false when !Alive
	Alive       bool
	// Side is the identity's team at this frame (sideString: "ct"/"t", ""
	// when unassigned), sampled alive or dead — a direct read, never
	// carried forward. The sidecar state stream does not encode it (the
	// position stream carries side for the replay); the tick sink's
	// per-frame side column reads it.
	Side string
}

// RosterSink is an OPTIONAL capability of a PositionSink: after the parse
// ends, Parse delivers the end-of-demo roster's teammate colors through a
// Positions sink that implements it — map[extract.playerKey]raw
// m_iCompTeammateColor (CS2.md "Player scoreboard/radar colors": 0 blue,
// 1 green, 2 yellow, 3 orange, 4 purple, -1 none/GOTV).
//
// It rides the position sink because that is the sink whose slot table
// keys the sidecar's meta.json (sidecar.Writer implements this interface
// and stores the colors against the slots); a sink that does not
// implement it simply carries no colors — Parse never fails over it.
type RosterSink interface {
	PositionSink
	SetPlayerColors(colors map[uint64]int)
}

// StateSink receives one call per parsed frame with every playing
// participant's state sample (dead included — hp 0 is evidence). seed is
// true on the first frame after each round-counter change: sinks emit a
// full seed record for every sample then, so no reader ever guesses a
// starting value. Implementations must not retain players (the slice and
// its inventory lists are reused across frames). An error returned from
// AddState aborts the parse.
type StateSink interface {
	AddState(seed bool, players []StatePlayer) error
}

// TickSink receives one call per parsed frame of a COUNTED round with
// every playing participant's merged sample (models.TickSample — the state
// sample joined with the alive-only position sample), the frame's tick,
// the stored (counted, 1..N) round number current at that frame and the
// demo's tick rate (<= 0 when the parser does not know it yet). It is
// called after the Positions and State sinks, through the same takeover
// routing (appendTargets). Frames before the first counted round and
// frames while a discarded (knife/warmup/post-match) round is current are
// never delivered — their rows would belong to no stored round.
// Implementations must not retain players (the slice is reused across
// frames). An error returned from AddTicks aborts the parse.
type TickSink interface {
	AddTicks(tick int32, round int, tickRate float64, players []models.TickSample) error
}

// ParseOptions configures one Parse call. Progress, if non-nil, is called
// with (framesDone, framesTotal) throttled to ~every 1000 frames plus one
// final call; framesTotal is 0 until the playback values are known (they
// only arrive at the end of a Source 2 demo). Positions, if non-nil,
// receives the per-frame alive-player sample stream. State, if non-nil,
// receives the per-frame authoritative player-state sample stream (see
// StateSink); it rides alongside Positions — both are called once per
// FrameDone, Positions first (the state stream reuses the position
// stream's slot table, so the position sample assigns slots). Voice,
// if non-nil, receives every CSVCMsg_VoiceData chunk. All THREE sinks are
// gated by the sanitization rule (owner ruling, 2026-11-12): nothing
// before the first counted round's start tick is delivered — see the
// gate comment in Parse's FrameDone handler. Progress is NOT gated (it
// counts the demo's frames, not the delivered stream).
// Ticks, if non-nil, receives the per-frame merged sample stream of the
// counted rounds (see TickSink) — the player_ticks table's input; it is
// gated by the same sanitization rule plus the counted-round rule.
// NetKey, when non-empty, is the chat decryption key extracted from a
// <demo>.info companion (demoinfocs.MatchInfoDecryptionKey) and enables
// decryption of svc_EncryptedData net-messages during the parse.
type ParseOptions struct {
	Progress  func(done, total int)
	Positions PositionSink
	State     StateSink
	Voice     VoiceSink
	Ticks     TickSink
	NetKey    []byte
}

// Parse reads one raw .dem stream, aggregating a normalized ExtractedMatch.
// ctx is honored via parser.ParseToEnd(ctx) — cancellation (including a
// failing Positions sink) returns ctx.Err() wrapped; a failing sink's own
// error is returned instead of the cancellation error.
func Parse(ctx context.Context, r io.Reader, opts ParseOptions) (*models.ExtractedMatch, error) {
	parseStart := time.Now()

	// Own the cancellation so a PositionSink failure can abort the parse
	// from inside a FrameDone handler (demoinfocs stops on ctx done).
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	parserOpts := []option.Option{
		option.IgnorePacketEntitiesPanic(true), // corrupt PacketEntities → ParserWarn, not fatal
		option.MsgQueueBufferSize(0),           // sequential parse, lower memory (as proven)
	}
	if len(opts.NetKey) > 0 {
		parserOpts = append(parserOpts, option.NetMessageDecryptionKey(opts.NetKey))
	}
	p := demoinfocs.NewParser(r, parserOpts...)
	defer func() { _ = p.Close() }()

	a := newAgg()
	registerHandlers(p, a)

	// sinkErr carries a failing Position/Voice sink's error out of the
	// handlers below; cancel aborts the parse so demoinfocs stops.
	var sinkErr error

	// Voice chunks (M4): net-message handlers run on the parse goroutine
	// (MsgQueueBufferSize(0) is sequential), so sinkErr/cancel mirror the
	// FrameDone positions-sink abort below. Only registered when a sink is
	// wired — a demo-independent no-op otherwise. Chunks are BUFFERED for
	// the current frame (voiceGate) and only delivered at FrameDone: the
	// sanitization gate below (owner ruling, 2026-11-12) is not yet known
	// at handler time — events.RoundStart dispatches at the END of the
	// frame, after the frame's net messages. Holding the payload for one
	// frame is safe: demoinfocs unmarshals into a fresh message per net
	// message (proto.Unmarshal copies bytes fields — parsing.go's
	// msgBufPool comment), and the slice is consumed before the next
	// FrameDone returns.
	voice := voiceGate{}
	if opts.Voice != nil {
		p.RegisterNetMessageHandler(func(m *msg.CSVCMsg_VoiceData) {
			if sinkErr != nil {
				return
			}
			audio := m.GetAudio()
			if audio == nil {
				return
			}
			payload := audio.GetVoiceData()
			if len(payload) == 0 {
				return
			}
			voice.add(VoiceChunk{
				Tick:    p.GameState().IngameTick(),
				XUID:    m.GetXuid(),
				Payload: payload,
				Caster:  m.GetCaster(),
				Section: audio.GetSectionNumber(),
			})
		})
	}
	// svc_EncryptedData counter (M4): decrypted inner messages dispatch as
	// normal events (when NetKey is set), so the raw count is the only
	// provenance the extract output carries.
	p.RegisterNetMessageHandler(func(*msg.CSVCMsg_EncryptedData) {
		a.countEncrypted()
	})
	// CMsgSosStartSoundEvent — the demo's sound-event channel, read by ALL
	// THREE sound-event waves (internal/extract/sos.go owns the three static
	// candidate tables, hashed ONCE at package init through
	// mappack.SoundEventHash — the one hash rule, and no CS2 install is
	// ever touched at import time):
	//   - Wave A: the five grenade BOUNCE soundevents → typed
	//     models.EventGrenadeBounce rows, deduped per (source entity, tick,
	//     name) with the FIRST message's origin winning; a message whose
	//     packed_params origin does not parse stores NOTHING (missing
	//     required input ⇒ skipped row, never a guessed position).
	//   - Wave B: the player-sound vocabulary (steps/lands/jumps/falls) →
	//     sound_events rows attributed source entity → player pawn →
	//     participant (extract.playerByEntity: the pawn's m_hController
	//     handle, falling back to the participant's own m_hPawn link —
	//     src -1 or a source that resolves to no player skips the row,
	//     identity is never guessed).
	//   - Wave C: the fire-cue vocabulary (extinguish / air-burst failure /
	//     fire fade) → typed cue rows
	//     (models.EventExtinguish … EventFadeOut) with Wave A's exact
	//     storage rule — deduped per (source entity, tick, name), origin
	//     required through the same packed_params header. The seen-set is
	//     Parse-local (beside this handler); the cues are audio-only (no
	//     landmark category claims them) and are drawn nowhere.
	// Tick reads the live game state; the round is the agg's current round
	// (evRound), renumbered with every other row in build.renumber.
	cueSeen := make(map[fireCueKey]bool)
	p.RegisterNetMessageHandler(func(m *msg.CMsgSosStartSoundEvent) {
		gs := p.GameState()
		hash := m.GetSoundeventHash()
		src := int(m.GetSourceEntityIndex())

		if def, ok := bounceByHash[hash]; ok {
			x, y, z, hasPos := sosOrigin(m.GetPackedParams())
			a.grenadeBounced(bounceInfo{
				tick:   gs.IngameTick(),
				entity: src,
				name:   def.name,
				weapon: def.weapon,
				hasPos: hasPos,
				x:      x,
				y:      y,
				z:      z,
			})
		}
		if def, ok := playerSoundByHash[hash]; ok {
			pl := playerByEntity(gs, src)
			if pl == nil {
				return // src -1 or a non-player source: skip, never guess
			}
			// Takeover remap: a sound emitted through the substitute
			// bot's pawn resolves to the bot's controller — the life it
			// belongs to is the controlling human's (takeover.go).
			who, _ := newRemap(gs).pair(pl)
			a.soundEvent(models.SoundEvent{
				Tick:       gs.IngameTick(),
				SteamID:    keyStr(playerKey(who)),
				Kind:       def.kind,
				Material:   def.material,
				TeamPrefix: def.team,
				SOSName:    def.name,
			})
		}
		if def, ok := fireCueByHash[hash]; ok {
			x, y, z, hasPos := sosOrigin(m.GetPackedParams())
			a.fireCue(fireCueInfo{
				tick:   gs.IngameTick(),
				entity: src,
				name:   def.name,
				kind:   def.kind,
				weapon: def.weapon,
				hasPos: hasPos,
				x:      x,
				y:      y,
				z:      z,
			}, cueSeen)
		}
	})

	pt := &progressTracker{cb: opts.Progress}
	frames := 0
	// Reused across frames: the sinks consume their slices synchronously.
	frameBuf := make([]PositionPlayer, 0, 10)
	stateBuf := make([]StatePlayer, 0, 10)
	tickBuf := make([]models.TickSample, 0, 10)
	targetBuf := make([]identityTarget, 0, 10)
	// Round-start seeds for the state stream: the first frame after each
	// round-counter change carries seed=true (see StateSink).
	seeds := roundSeeds{}
	p.RegisterEventHandler(func(events.FrameDone) {
		frames++
		a.flushRaw()
		// Deferred disconnect-time World self-kills (agg.flushWorldSelf):
		// the frame's player_disconnect has dispatched by now in EITHER
		// order relative to the kill (both orders observed on the owner's
		// repro demo), so the same-tick criterion can be decided exactly.
		a.flushWorldSelf()
		// Sanitization gate (owner ruling, 2026-11-12): the sidecar
		// timeline (positions + state) and the voice stream START AT THE
		// FIRST COUNTED round's start tick — no pre-pistol byte is ever
		// written. Gate signal: a.rounds gains its entry only for a
		// counted round (agg.roundStart), and events.RoundStart dispatches
		// BEFORE events.FrameDone for the same frame (demoinfocs v6
		// parsing.go handleFrameParsed runs processFrameGameEvents first),
		// so the boundary frame (tick == startTick) is KEPT: by the time
		// this handler evaluates the gate, the boundary round exists.
		// frames++ and the progress tracker below stay UNGATED — they
		// count the demo's frames (matches.frames / the final-progress
		// pin), not the written stream. A demo with NO counted round never
		// opens the gate: zero frames/voice are written (meta.Frames = 0)
		// and the replay renders blank through its existing frames === 0
		// guards — the ruling read literally: with no first pistol round,
		// EVERY byte is pre-pistol. Deliberate, not a bug; no fallback is
		// guessed (pre-release policy: never invent data).
		gateOpen := len(a.rounds) > 0
		if sink := opts.Positions; gateOpen && sink != nil && sinkErr == nil {
			gs := p.GameState()
			// Takeover routing (takeover.go appendTargets): during a
			// reconnect takeover the human's own pawn is the stale
			// pre-disconnect corpse — reading it blacked out the whole
			// window (owner's repro: 1840/1840 frames with no sample) —
			// so the sample runs through the controlled pawn and is
			// keyed with the identity's accumulator key (the controlling
			// human's SteamID64 post-takeover; the covering bot's
			// synthetic key before it — the marker tracks the bot from
			// ITS connect, not from the takeover, owner report
			// 2026-11-17).
			targetBuf = appendTargets(targetBuf[:0], gs.Participants().Playing(), demoinfocsControls)
			frameBuf = frameBuf[:0]
			for _, t := range targetBuf {
				row, ok := positionRow(t)
				if !ok {
					continue
				}
				frameBuf = append(frameBuf, row)
			}
			if err := sink.AddFrame(int32(gs.IngameTick()), frameBuf); err != nil {
				sinkErr = fmt.Errorf("extract: position sink: %w", err)
				cancel()
			}
		}
		// State stream (see StateSink): every playing participant, dead
		// included (hp 0 is a sample, not an inference) — through the
		// same takeover routing as the position sink (the human's row is
		// sampled through the controlled bot's LIVE pawn, keyed with the
		// human's SteamID; the covered bot emits no second row). Runs
		// AFTER the position sink so the shared slot table locks on
		// position samples first. Gated together with the position sink:
		// both sinks must advance in lockstep (sidecar's frames counter),
		// and seeds.take is NOT called while the gate is closed — the
		// zero value stays armed, so the boundary frame's round-counter
		// change makes the first written record a seed (plus the state
		// writer's !prev.valid forces full records on the first record
		// anyway).
		if sink := opts.State; gateOpen && sink != nil && sinkErr == nil {
			gs := p.GameState()
			targetBuf = appendTargets(targetBuf[:0], gs.Participants().Playing(), demoinfocsControls)
			stateBuf = stateBuf[:0]
			for _, t := range targetBuf {
				stateBuf = append(stateBuf, sampleStatePlayer(t.identity, t.pawn))
			}
			if err := sink.AddState(seeds.take(a.currentRound), stateBuf); err != nil {
				sinkErr = fmt.Errorf("extract: state sink: %w", err)
				cancel()
			}
		}
		// Tick stream (see TickSink): the same population as the state
		// stream, restricted to counted rounds — a.discarding marks a
		// knife/warmup/post-match round whose rows are never stored, and
		// while the gate is open and no discarded round is current the
		// current round is the LAST of a.rounds, whose stored number
		// (build.renumber's dense 1..N) is len(a.rounds).
		if sink := opts.Ticks; gateOpen && !a.discarding && sink != nil && sinkErr == nil {
			gs := p.GameState()
			targetBuf = appendTargets(targetBuf[:0], gs.Participants().Playing(), demoinfocsControls)
			tickBuf = tickBuf[:0]
			for _, t := range targetBuf {
				pos, hasPos := positionRow(t)
				tickBuf = append(tickBuf, tickSample(sampleStatePlayer(t.identity, t.pawn), pos, hasPos))
			}
			if err := sink.AddTicks(int32(gs.IngameTick()), len(a.rounds), p.TickRate(), tickBuf); err != nil {
				sinkErr = fmt.Errorf("extract: tick sink: %w", err)
				cancel()
			}
		}
		// Voice: deliver (or discard) this frame's buffered chunks now —
		// AFTER events.RoundStart has dispatched for the frame, so the
		// gate is evaluated post-boundary: chunks AT the startTick that
		// arrived in the boundary frame are KEPT, every earlier frame's
		// chunks were already discarded at their own FrameDone.
		if opts.Voice != nil {
			if err := voice.frameEnd(gateOpen && sinkErr == nil, opts.Voice); err != nil {
				sinkErr = err
				cancel()
			}
		}
		pt.frame(frames, frameTotal(p))
	})

	err := p.ParseToEnd(ctx)
	// Voice net messages can still arrive after the final FrameDone
	// (end-of-demo packets): deliver them when the gate is open (exactly
	// the old immediate-delivery behavior), discard them when it is
	// closed (every byte is pre-pistol by definition).
	if opts.Voice != nil && sinkErr == nil {
		if err := voice.frameEnd(len(a.rounds) > 0, opts.Voice); err != nil {
			sinkErr = err
		}
	}
	if sinkErr != nil {
		return nil, sinkErr
	}
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, fmt.Errorf("extract: parse cancelled: %w", ctxErr)
		}
		return nil, fmt.Errorf("extract: parse failed: %w", err)
	}

	// Pair typed events dispatched after the last frame with their payloads.
	a.flushRaw()
	// Drain any deferred World self-kill that never saw a disconnect
	// (genuine world-hazard death — it is a real death; the exclusion
	// needs the same-tick disconnect).
	a.flushWorldSelf()

	// Final-state snapshot: end-of-demo roster (provenance flag + scoreboard
	// overwrites), teams, and header-derived match metadata. The roster is
	// every participant still on CT/T — including the players who left the
	// server after match point (see finalRoster): their controller entity
	// state survives to the demo's last tick.
	gs := p.GameState()
	playing := finalRoster(gs.Participants().All())
	finals := make([]finalPlayer, 0, len(playing))
	// Teammate colors for the RosterSink capability: keyed by
	// extract.playerKey — the same key the position sink's slot table is
	// built from (a bot's synthetic key colors its own slot; SteamID64
	// keying collapsed every bot onto 0).
	rosterColors := make(map[uint64]int, len(playing))
	for _, pl := range playing {
		rosterColors[playerKey(pl)] = teammateColor(pl)
		finals = append(finals, finalPlayer{
			key:             playerKey(pl),
			name:            pl.Name,
			side:            sideString(pl.Team),
			isBot:           pl.IsBot,
			clanTag:         pl.ClanTag(),
			crosshairCode:   pl.CrosshairCode(),
			rank:            pl.Rank(),
			rankType:        pl.RankType(),
			wins:            pl.CompetitiveWins(),
			ping:            pl.Ping(),
			alive:           pl.IsAlive(),
			score:           pl.Score(),
			moneySpentTotal: pl.MoneySpentTotal(),
		})
	}
	a.applyFinal(finals)
	// Delivered AFTER the snapshot (the sink is only read before its
	// Close, which the caller performs once Parse has returned).
	if rs, ok := opts.Positions.(RosterSink); ok {
		rs.SetPlayerColors(rosterColors)
	}

	// Empty rows keep both team entries present even if a state is missing.
	ctTeam, tTeam := teamFinal{}, teamFinal{}
	if ct := gs.TeamCounterTerrorists(); ct != nil {
		ctTeam = teamFinal{
			name:  ct.ClanName(),
			flag:  ct.Flag(),
			score: ct.Score(),
		}
	}
	if t := gs.TeamTerrorists(); t != nil {
		tTeam = teamFinal{
			name:  t.ClanName(),
			flag:  t.Flag(),
			score: t.Score(),
		}
	}
	a.setFinalTeam("ct", ctTeam)
	a.setFinalTeam("t", tTeam)

	a.setMeta(metaInfo{
		tickRate:       p.TickRate(),
		durationTicks:  gs.IngameTick(),
		frames:         frameTotal(p),
		entityClasses:  len(p.ServerClasses().All()),
		endEntityCount: len(gs.Entities()),
		parseMS:        time.Since(parseStart).Milliseconds(),
		extractedAt:    time.Now().UTC(),
	})

	pt.finish(frames, frameTotal(p))

	return a.build(), nil
}

// frameTotal reports the demo's recorded frame count, or 0 when unknown
// (Source 2 playback values only become available at the end of the parse).
func frameTotal(p *demoinfocs.Parser) int {
	if n := p.FrameCount(); n > 0 {
		return n
	}
	return 0
}

// progressTracker throttles progress reporting to ~every progressEvery
// frames, plus one final call carrying the closing counts (deduplicated if
// the last throttled call already reported that exact value).
type progressTracker struct {
	cb       func(done, total int)
	last     int
	reported bool
}

func (pt *progressTracker) frame(done, total int) {
	if pt.cb == nil || done-pt.last < progressEvery {
		return
	}
	pt.last = done
	pt.reported = true
	pt.cb(done, total)
}

func (pt *progressTracker) finish(done, total int) {
	if pt.cb == nil || (pt.reported && done == pt.last) {
		return
	}
	pt.last = done
	pt.reported = true
	pt.cb(done, total)
}

// roundSeeds decides when a state frame is a round-start seed: the first
// frame after each round-counter change seeds once, every later frame in
// the round does not. The zero value is armed for the very first frame it
// sees (the demo's first frame seeds too) — a starting value is never
// guessed downstream (see StateSink).
type roundSeeds struct {
	last  int
	armed bool
}

// take reports whether the frame at round must emit seed records.
func (rs *roundSeeds) take(round int) bool {
	if rs.armed && round == rs.last {
		return false
	}
	rs.armed = true
	rs.last = round
	return true
}

// sampleStatePlayer reads one participant's authoritative per-frame state
// (cheap prop reads, once per frame per player — see StatePlayer),
// split across the takeover pair: the row is KEYED with the identity's
// accumulator key (extract.playerKey — the controlling human's SteamID64
// on a takeover; a lone bot's synthetic 0xFF key, so its window is
// stored instead of dropped at the sidecar slot table),
// while every pawn-carried read (alive/HP/armor/weapons/reload/buttons)
// runs through the pawn — the controlled bot's during a takeover, the
// participant's own otherwise (identical reads when identity == pawn).
// Money stays with the identity: it is a controller property (the
// identity's own account, as read — never a guess). The weapon/ammo
// fields and the reload flag are only read while the pawn is alive;
// Money/Helmet are read on every frame like HP/Armor (they persist
// through death).
func sampleStatePlayer(identity, pawn *common.Player) StatePlayer {
	alive := pawn.IsAlive()
	var inventory []string
	weapon, mag, reserve := "", 0, 0
	mainMag, mainReserve, reloading := 0, 0, false
	if alive {
		active := pawn.ActiveWeapon()
		weapon = wepName(active)
		var main *common.Equipment
		inventory, main = scanWeapons(pawn.Weapons())
		if active != nil {
			mag = active.AmmoInMagazine()
			reserve = active.AmmoReserve()
		}
		if main != nil {
			mainMag = main.AmmoInMagazine()
			mainReserve = main.AmmoReserve()
		}
		reloading = pawn.IsReloading
	}
	s := buildStateSample(playerKey(identity), alive, pawn.Health(), pawn.Armor(), identity.Money(), pawn.HasHelmet(),
		weapon, inventory, mag, reserve, mainMag, mainReserve, pawn.IsPressingButton(common.ButtonAttack), reloading)
	s.Side = sideString(identity.Team)
	return s
}

// tickSample merges one target's state sample with its position sample
// (hasPos false = no position this frame: the pawn is dead) into the tick
// sink's unit. Pure — the shaping rule the player_ticks honesty contract
// depends on: the state sample's death rules carry over unchanged (HP 0
// and no weapon when dead), and the position fields are only set when a
// position was sampled, so a dead frame can never carry a fabricated
// position, speed or in-air flag downstream.
func tickSample(st StatePlayer, pos PositionPlayer, hasPos bool) models.TickSample {
	ts := models.TickSample{
		SteamID: keyStr(st.SteamID),
		Side:    st.Side,
		Alive:   st.Alive,
		HP:      st.HP,
		Money:   st.Money,
	}
	if st.Alive {
		ts.Weapon = st.Weapon
	}
	if hasPos {
		ts.HasPosition = true
		ts.X, ts.Y, ts.Z = float64(pos.X), float64(pos.Y), float64(pos.Z)
		ts.InAir = pos.Air
	}
	return ts
}

// scanWeapons walks one participant's weapon list IN ORDER (pl.Weapons()
// — the same loop order the frontend's `inventory` array is built from,
// so both sides see the same first-primary/first-secondary) and returns
// the canonical inventory names plus the MAIN weapon: the first primary,
// else the first secondary, else nil (NO firearm carried — a knife round
// or a dropped sidearm yields no main, so the card shows nothing; there
// is deliberately no starter-pistol fallback here).
//
// Frontend twin: loadout.js mainWeaponOf(inventory, { starter: false })
// — the sets themselves are models.IsPrimaryWeapon/IsSecondaryWeapon
// (quoted from loadout.js's PRIMARY_WEAPONS/SECONDARY_WEAPONS).
func scanWeapons(weapons []*common.Equipment) (inventory []string, main *common.Equipment) {
	var secondary *common.Equipment
	for _, w := range weapons {
		if w == nil {
			continue
		}
		name := wepName(w)
		inventory = append(inventory, name)
		if main == nil && models.IsPrimaryWeapon(name) {
			main = w // first primary wins, wherever it sits in the order
		}
		if secondary == nil && models.IsSecondaryWeapon(name) {
			secondary = w
		}
	}
	if main == nil {
		main = secondary
	}
	return inventory, main
}

// buildStateSample is the pure shaping rule the sidecar stream depends on
// (kept separate from the parser reads so it is unit-testable): HP is
// always stored — forced to 0 when dead — armor, the unspent account and
// the helmet flag are stored as read (alive or not, deliberately: money
// lives on the player controller and round-end cash lands while dead;
// helmet rides the pawn's item services like armor), and the
// weapon/inventory/ammo fields — active AND main — only exist while alive
// (dead pawns have no entity props to read; the stream documents the last
// emitted value as last-known). Reloading is also forced false when dead
// (a dead player reloads nothing — same authoritative-evidence rule as HP
// 0, NOT the last-known rule: the sidecar emits the fresh false so a
// death mid-reload ends the reload). Values are clamped onto the stored
// wire widths here (u8 HP/armor, u16 money/ammo) so the writer never
// truncates.
func buildStateSample(steamID uint64, alive bool, health, armor, money int, helmet bool, weapon string, inventory []string, mag, reserve, mainMag, mainReserve int, attack, reloading bool) StatePlayer {
	s := StatePlayer{
		SteamID:   steamID,
		HP:        clampState8(health),
		Armor:     clampState8(armor),
		Money:     clampState16(money),
		Helmet:    helmet,
		Attack:    attack,
		Reloading: alive && reloading,
		Alive:     alive,
	}
	if !alive {
		s.HP = 0 // death is authoritative evidence, not an inference
		return s
	}
	s.Weapon = weapon
	s.MagAmmo = clampState16(mag)
	s.ReserveAmmo = clampState16(reserve)
	s.MainMag = clampState16(mainMag)
	s.MainReserve = clampState16(mainReserve)
	if len(inventory) > 0 {
		s.Inventory = make([]string, len(inventory))
		copy(s.Inventory, inventory)
	}
	return s
}

// clampState8/16 bound an int onto the stored unsigned wire widths
// (negative reads — AmmoInMagazine's -1 sentinel — clamp to 0).
func clampState8(v int) int {
	switch {
	case v < 0:
		return 0
	case v > 255:
		return 255
	default:
		return v
	}
}

func clampState16(v int) int {
	switch {
	case v < 0:
		return 0
	case v > 65535:
		return 65535
	default:
		return v
	}
}
