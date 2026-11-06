// Package extract is the demoinfocs-based extraction engine: it reads ONE
// raw CS2 .dem stream (the caller handles .zstd decompression) and emits a
// normalized models.ExtractedMatch — no report/markdown generation, and no
// demoinfocs type ever appears in the output. Parser options, handler
// families, warmup gating, and aggregation math all target the models
// contract.
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
const ParserVersion = "demoinfocs-golang/v6@v6.0.0-rc.1"

// progressEvery throttles the progress callback to ~every 1000 frames
// (plus the one final call made after the parse ends).
const progressEvery = 1000

// PositionPlayer is one alive participant's sampled state at one frame —
// the unit the sidecar writer (internal/sidecar) encodes. Coordinates are
// world units; Yaw is ViewDirectionX (yaw) in degrees, normalized to
// -180..180 before the sink; Air/Duck map to the q16-v2 flags bits and Side
// ("ct"/"t"/"") to the side bits. SteamID is the raw SteamID64 (0 for bots,
// which have no SteamID64).
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
// vocabulary — the same strings events.weapon carries), and Attack is
// pl.IsPressingButton(common.ButtonAttack).
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
// SteamID is the raw SteamID64 (0 for bots).
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
	Attack      bool
	Alive       bool
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

// ParseOptions configures one Parse call. Progress, if non-nil, is called
// with (framesDone, framesTotal) throttled to ~every 1000 frames plus one
// final call; framesTotal is 0 until the playback values are known (they
// only arrive at the end of a Source 2 demo). Positions, if non-nil,
// receives the per-frame alive-player sample stream. State, if non-nil,
// receives the per-frame authoritative player-state sample stream (see
// StateSink); it rides alongside Positions — both are called once per
// FrameDone, Positions first (the state stream reuses the position
// stream's slot table, so the position sample assigns slots). Voice,
// if non-nil, receives every CSVCMsg_VoiceData chunk.
// NetKey, when non-empty, is the chat decryption key extracted from a
// <demo>.info companion (demoinfocs.MatchInfoDecryptionKey) and enables
// decryption of svc_EncryptedData net-messages during the parse.
type ParseOptions struct {
	Progress  func(done, total int)
	Positions PositionSink
	State     StateSink
	Voice     VoiceSink
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
	// wired — a demo-independent no-op otherwise.
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
			if err := opts.Voice.Add(VoiceChunk{
				Tick:    p.GameState().IngameTick(),
				XUID:    m.GetXuid(),
				Payload: payload,
				Caster:  m.GetCaster(),
				Section: audio.GetSectionNumber(),
			}); err != nil {
				sinkErr = fmt.Errorf("extract: voice sink: %w", err)
				cancel()
			}
		})
	}
	// svc_EncryptedData counter (M4): decrypted inner messages dispatch as
	// normal events (when NetKey is set), so the raw count is the only
	// provenance the extract output carries.
	p.RegisterNetMessageHandler(func(*msg.CSVCMsg_EncryptedData) {
		a.countEncrypted()
	})

	pt := &progressTracker{cb: opts.Progress}
	frames := 0
	// Reused across frames: the sinks consume their slices synchronously.
	frameBuf := make([]PositionPlayer, 0, 10)
	stateBuf := make([]StatePlayer, 0, 10)
	// Round-start seeds for the state stream: the first frame after each
	// round-counter change carries seed=true (see StateSink).
	seeds := roundSeeds{}
	p.RegisterEventHandler(func(events.FrameDone) {
		frames++
		a.flushRaw()
		if sink := opts.Positions; sink != nil && sinkErr == nil {
			gs := p.GameState()
			frameBuf = frameBuf[:0]
			for _, pl := range gs.Participants().Playing() {
				if pl == nil || !pl.IsAlive() {
					continue
				}
				pos := pl.Position()
				// ViewDirectionX is yaw (0..360); normalize to the
				// -180..180 range the sidecar codec expects.
				// (ViewDirectionY is pitch — feeding it here drew
				// garbage view cones.)
				yaw := pl.ViewDirectionX()
				if yaw > 180 {
					yaw -= 360
				}
				frameBuf = append(frameBuf, PositionPlayer{
					SteamID: pl.SteamID64,
					X:       float32(pos.X),
					Y:       float32(pos.Y),
					Z:       float32(pos.Z),
					Yaw:     yaw,
					Air:     pl.IsAirborne(),
					Duck:    pl.IsDucking(),
					Side:    sideString(pl.Team),
				})
			}
			if err := sink.AddFrame(int32(gs.IngameTick()), frameBuf); err != nil {
				sinkErr = fmt.Errorf("extract: position sink: %w", err)
				cancel()
			}
		}
		// State stream (see StateSink): every playing participant, dead
		// included (hp 0 is a sample, not an inference). Runs AFTER the
		// position sink so the shared slot table locks on position
		// samples first.
		if sink := opts.State; sink != nil && sinkErr == nil {
			gs := p.GameState()
			stateBuf = stateBuf[:0]
			for _, pl := range gs.Participants().Playing() {
				if pl == nil {
					continue
				}
				stateBuf = append(stateBuf, sampleStatePlayer(pl))
			}
			if err := sink.AddState(seeds.take(a.currentRound), stateBuf); err != nil {
				sinkErr = fmt.Errorf("extract: state sink: %w", err)
				cancel()
			}
		}
		pt.frame(frames, frameTotal(p))
	})

	err := p.ParseToEnd(ctx)
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

	// Final-state snapshot: end-of-demo roster (provenance flag + scoreboard
	// overwrites), teams, and header-derived match metadata. The roster is
	// every participant still on CT/T — including the players who left the
	// server after match point (see finalRoster): their controller entity
	// state survives to the demo's last tick.
	gs := p.GameState()
	playing := finalRoster(gs.Participants().All())
	finals := make([]finalPlayer, 0, len(playing))
	for _, pl := range playing {
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

	// Empty rows keep both team entries present even if a state is missing.
	ctTeam, tTeam := teamFinal{}, teamFinal{}
	if ct := gs.TeamCounterTerrorists(); ct != nil {
		ctTeam = teamFinal{
			name:       ct.ClanName(),
			flag:       ct.Flag(),
			score:      ct.Score(),
			moneySpent: ct.MoneySpentTotal(),
			equipTotal: ct.CurrentEquipmentValue(),
		}
	}
	if t := gs.TeamTerrorists(); t != nil {
		tTeam = teamFinal{
			name:       t.ClanName(),
			flag:       t.Flag(),
			score:      t.Score(),
			moneySpent: t.MoneySpentTotal(),
			equipTotal: t.CurrentEquipmentValue(),
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
// (cheap prop reads, once per frame per player — see StatePlayer). The
// weapon/ammo fields are only read while the pawn is alive; Money/Helmet
// are read on every frame like HP/Armor (they persist through death).
func sampleStatePlayer(pl *common.Player) StatePlayer {
	alive := pl.IsAlive()
	var inventory []string
	weapon, mag, reserve := "", 0, 0
	if alive {
		active := pl.ActiveWeapon()
		weapon = wepName(active)
		for _, w := range pl.Weapons() {
			if w == nil {
				continue
			}
			inventory = append(inventory, wepName(w))
		}
		if active != nil {
			mag = active.AmmoInMagazine()
			reserve = active.AmmoReserve()
		}
	}
	return buildStateSample(pl.SteamID64, alive, pl.Health(), pl.Armor(), pl.Money(), pl.HasHelmet(),
		weapon, inventory, mag, reserve, pl.IsPressingButton(common.ButtonAttack))
}

// buildStateSample is the pure shaping rule the sidecar stream depends on
// (kept separate from the parser reads so it is unit-testable): HP is
// always stored — forced to 0 when dead — armor, the unspent account and
// the helmet flag are stored as read (alive or not, deliberately: money
// lives on the player controller and round-end cash lands while dead;
// helmet rides the pawn's item services like armor), and the
// weapon/inventory/ammo fields only exist while alive (dead pawns have no
// entity props to read; the stream documents the last emitted value as
// last-known). Values are clamped onto the stored wire widths here (u8
// HP/armor, u16 money/ammo) so the writer never truncates.
func buildStateSample(steamID uint64, alive bool, health, armor, money int, helmet bool, weapon string, inventory []string, mag, reserve int, attack bool) StatePlayer {
	s := StatePlayer{
		SteamID: steamID,
		HP:      clampState8(health),
		Armor:   clampState8(armor),
		Money:   clampState16(money),
		Helmet:  helmet,
		Attack:  attack,
		Alive:   alive,
	}
	if !alive {
		s.HP = 0 // death is authoritative evidence, not an inference
		return s
	}
	s.Weapon = weapon
	s.MagAmmo = clampState16(mag)
	s.ReserveAmmo = clampState16(reserve)
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
