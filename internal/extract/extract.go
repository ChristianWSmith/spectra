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

// Parse reads one raw .dem stream, aggregating a normalized ExtractedMatch.
// progress, if non-nil, is called with (framesDone, framesTotal); framesTotal
// is 0 until the playback values are known (they only arrive at the end of a
// Source 2 demo). Calls are throttled to ~every 1000 frames plus one final
// call. ctx is honored via parser.ParseToEnd(ctx) — cancellation returns
// ctx.Err() wrapped.
func Parse(ctx context.Context, r io.Reader, progress func(done, total int)) (*models.ExtractedMatch, error) {
	parseStart := time.Now()

	p := demoinfocs.NewParser(r,
		option.IgnorePacketEntitiesPanic(true), // corrupt PacketEntities → ParserWarn, not fatal
		option.MsgQueueBufferSize(0),           // sequential parse, lower memory (as proven)
	)
	defer func() { _ = p.Close() }()

	a := newAgg()
	registerHandlers(p, a)

	pt := &progressTracker{cb: progress}
	frames := 0
	p.RegisterEventHandler(func(events.FrameDone) {
		frames++
		a.flushRaw()
		pt.frame(frames, frameTotal(p))
	})

	if err := p.ParseToEnd(ctx); err != nil {
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
