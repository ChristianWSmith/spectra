// Package extract is the demoinfocs-based extraction engine: it reads ONE
// raw CS2 .dem stream (the caller handles .zstd decompression) and emits a
// normalized models.ExtractedMatch — no report/markdown generation, and no
// demoinfocs type ever appears in the output. It is the in-repo port of the
// proven research extractor (ref/extractor/main.go): identical parser
// options, handler families, warmup gating, and aggregation math, re-targeted
// onto the models contract.
package extract

import (
	"context"
	"fmt"
	"io"
	"time"

	demoinfocs "github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs"
	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/events"
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
// world units; Yaw is ViewDirectionY (pitch) in degrees as demoinfocs
// reports it; Air/Duck map to the q16-v1 flags bits. SteamID is the raw
// SteamID64 (0 for bots, which have no SteamID64).
type PositionPlayer struct {
	SteamID uint64
	X, Y, Z float32
	Yaw     float32
	Air     bool
	Duck    bool
}

// PositionSink receives one call per parsed frame with every alive playing
// participant. Implementations must not retain players (the slice is
// reused across frames). An error returned from AddFrame aborts the parse.
type PositionSink interface {
	AddFrame(tick int32, players []PositionPlayer) error
}

// ParseOptions configures one Parse call. Progress, if non-nil, is called
// with (framesDone, framesTotal) throttled to ~every 1000 frames plus one
// final call; framesTotal is 0 until the playback values are known (they
// only arrive at the end of a Source 2 demo). Positions, if non-nil,
// receives the per-frame alive-player sample stream (plan M2 §3).
type ParseOptions struct {
	Progress  func(done, total int)
	Positions PositionSink
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

	p := demoinfocs.NewParser(r,
		option.IgnorePacketEntitiesPanic(true), // corrupt PacketEntities → ParserWarn, not fatal
		option.MsgQueueBufferSize(0),           // sequential parse, lower memory (as proven)
	)
	defer func() { _ = p.Close() }()

	a := newAgg()
	registerHandlers(p, a)

	pt := &progressTracker{cb: opts.Progress}
	frames := 0
	var sinkErr error
	// Reused across frames: the sink consumes AddFrame synchronously.
	frameBuf := make([]PositionPlayer, 0, 10)
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
				frameBuf = append(frameBuf, PositionPlayer{
					SteamID: pl.SteamID64,
					X:       float32(pos.X),
					Y:       float32(pos.Y),
					Z:       float32(pos.Z),
					Yaw:     pl.ViewDirectionY(),
					Air:     pl.IsAirborne(),
					Duck:    pl.IsDucking(),
				})
			}
			if err := sink.AddFrame(int32(gs.IngameTick()), frameBuf); err != nil {
				sinkErr = fmt.Errorf("extract: position sink: %w", err)
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
	// overwrites), teams, and header-derived match metadata.
	gs := p.GameState()
	playing := gs.Participants().Playing()
	finals := make([]finalPlayer, 0, len(playing))
	for _, pl := range playing {
		if pl == nil {
			continue
		}
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
			kills:           pl.Kills(),
			deaths:          pl.Deaths(),
			assists:         pl.Assists(),
			mvps:            pl.MVPs(),
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
