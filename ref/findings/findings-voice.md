# Voice spike: can we decode CS2 demo voice (Opus) with pure Go?

**Date:** 2026-10-30 · **Spike dir:** `/tmp/opencode/voicespike/` · **Input demo:** `/tmp/opencode/donk.dem` (FACEIT SourceTV, de_cache, 64 Hz, 35m39s)

## Verdict

**YES — pure-Go decode is viable. No libopus/cgo needed.**

- Framing: **whole payload = exactly one raw Opus packet** (no length prefix, no Steam TOC
  wrapper). Confirmed 3 ways: message metadata (`num_packets=1`,
  `packet_offsets=[len,0,0,0]`), byte histogram (TOC first byte constant), and an
  empirical framing sweep (all alternatives fail).
- Sample rate: **48000 Hz mono**, 10 ms frames = **480 samples per chunk**
  (stdev 0.0 across 41k chunks).
- Decoder: `github.com/pion/opus` **v0.1.1-0.20261026214112-e7b8aa55508c** (main,
  commit `e7b8aa5`, 138 commits ahead of tag v0.1.0) — pure Go, builds with
  `CGO_ENABLED=0`.
- Decode success: **0 errors / 41,288 packets** across two players' full corpora.
- Spectrograms show real speech (harmonics, formant bands, silence gaps), not noise smears.

Caveats: pin the pseudo-version (v0.1.0 tag also passed our sweep, but main carries
decoder fixes); `CSVCMsg_VoiceData.tick` is 0 in this demo — use the demo/ingame tick;
no DTX packets exist, so silence = *absence* of chunks, not comfort-noise frames.

---

## 1. Capture

`dump/main.go` (demoinfocs-golang v6.0.0-rc.1) registers
`p.RegisterNetMessageHandler(func(m *msg.CSVCMsg_VoiceData){...})`, records
`GameState().IngameTick()` + `m.GetAudio()` fields, and dumps the top-2 XUIDs to
length-prefixed files (`xuid_<id>.bin`: `[tick u32][len u32][payload]`).

- 123,507 VoiceData msgs, 10 XUIDs, 0 casters (matches prior probe).
- All 123,507: `format=VOICEDATA_FORMAT_OPUS`, `sample_rate=48000`, `num_packets=1`,
  `packet_offsets=[<payload len>,0,0,0]`, `m.Tick=0` (field unset by SourceTV).
- Top XUIDs: `76561198210730700` (23,376 chunks), `76561198372023214` (17,912).

Full console output: `dump-out.txt`.

## 2. Payload size histogram

123,507 payloads, 7,713,815 bytes total · min 31, max 137, **mean 62.46, median 65,
p90 74** → ≈ 62.46 × 8 / 10 ms ≈ **50 kbps**.

| bytes | count | % |
|---|---:|---:|
| 31–40 | 6,877 | 5.6% |
| 41–50 | 12,246 | 9.9% |
| 51–60 | 20,802 | 16.8% |
| **61–70** | **56,128** | **45.4%** |
| 71–80 | 26,682 | 21.6% |
| 81–90 | 689 | 0.6% |
| 91–137 | 83 | 0.1% |

Per-size table: `dump-out.txt`. **No payload ≤ 2 bytes → no DTX/comfort-noise frames.**

## 3. Framing discovered (byte-level layout)

```
CSVCMsg_VoiceData (net message)
├─ xuid      fixed64            → sender Steam ID
├─ tick      varint = 0         → IGNORE; use demo/ingame tick (64 Hz)
├─ caster    bool = false
└─ audio : CMsgVoiceAudio
   ├─ format            = VOICEDATA_FORMAT_OPUS (enum 1)
   ├─ sample_rate       = 48000            ← authoritative
   ├─ num_packets       = 1                ← one Opus packet per message
   ├─ packet_offsets    = [N, 0, 0, 0]     ← end-offsets; N = len(payload)
   ├─ section_number    = per-sender chunk counter (+1 each chunk)
   └─ voice_data : bytes[0..N)  =  RAW OPUS PACKET, no prefix, no padding
      ┌────────┬──────────────────────────────┐
      │ byte 0 │ TOC                          │
      │  0x70  │ config=14 Hybrid FB, mono,   │ 23,184/23,376 (99.2%)
      │  0xf0  │ config=30 CELT FB, mono,     │    192/23,376 (0.8%)
      │        │ frameCode=0 → 1 frame, 10 ms │
      │ byte1… │ range-coded Opus payload     │
      └────────┴──────────────────────────────┘
      ⇒ 10 ms mono @ 48 kHz = 480 samples S16LE
```

Tick cadence corroborates: gaps between consecutive chunks of one player are
0/1/2 ticks (64 Hz) with mean **0.64 tick = 10.0 ms** while talking — exactly the
frame duration. No length prefix is needed or present (`len1`, `len2`, `skip1`,
`skip2` framings all fail; see §4).

## 4. Decode success metrics (pion/opus main, mono)

Framing × sample-rate sweep, scored on the first 3,000 chunks of player 1
(`analyze/main.go`, score table printed on run):

| framing | rate | err rate | mean samples | stdev | RMS | active% | verdict |
|---|---|---:|---:|---:|---:|---:|---|
| **whole** | **48000** | **0.0000** | **480.0** | **0.0** | **2293** | **37.8** | ✅ |
| whole | 24000/16000/12000/8000 | 0.0000 | 240/160/120/80 | 0.0 | ~2293 | ~37.8 | decodes (resampled), but 48000 is the message's rate |
| skip1 | any | 0.5547 | 799.7 | 731.9 | 10602 | 38.3 | ❌ garbage (noise-level RMS) |
| skip2 | any | 0.5523 | 1189.3 | 1181.3 | 9446 | 33.9 | ❌ garbage |
| len1 / len1-walk | any | 0.5000 | 0 | – | 0 | 0 | ❌ split fails 50% |
| len2 / len2-walk | any | 0.5000 | 0 | – | 0 | 0 | ❌ split fails 50% |

Full-corpus runs (best candidate, 48 kHz):

| player | XUID | chunks | pkts | decode errors | mean samples | RMS | active% |
|---|---|---:|---:|---:|---:|---:|---:|
| 1 | 76561198210730700 | 23,376 | 23,376 | **0 (0.000000)** | 480.0 | 2549 | 43.0% |
| 2 | 76561198372023214 | 17,912 | 17,912 | **0 (0.000000)** | 480.0 | 1442 | 39.8% |

Sample-rate note: the Opus TOC picks the *coding* bandwidth (FB), while the decoder's
output rate only controls resampling — every rate decodes, so `sample_rate=48000`
from the message is the value to use (48 kHz also preserves the FB content visible
in the spectrogram).

## 5. WAV output & duration alignment math

Windows: longest ≥60 s wall-time dense-talk span per player, PCM placed on the
**wall-clock timeline** (zero-filling pauses between chunks).

| file | ticks (64 Hz) | wall span | WAV duration | samples @48k | chunks × 10 ms | nonzero |
|---|---|---|---|---:|---:|---:|
| `out/player1.wav` | 35337..40158 | 4821/64 = **75.33 s** | **75.338 s** | 3,616,230 | 2,722 × 10 ms = 27.22 s | 33.7% |
| `out/player2.wav` | 78001..82173 | 4172/64 = **65.19 s** | **65.198 s** | 3,129,480 | 3,212 × 10 ms = 32.12 s | 48.5% |

Alignment checks (all consistent):
- `samples/48000 == wall span` exactly (timeline placement by tick).
- Voiced-audio fraction ≈ nonzero fraction: 27.22/75.33 = 36% vs 33.7% nonzero;
  32.12/65.19 = 49% vs 48.5% nonzero.
- Cadence: 10 ms/chunk ⇒ 100 chunks/s while talking; observed mean gap during
  speech = 0.64 tick @64 Hz = 10.0 ms. ✅

astats (ffmpeg): player1 peak −2.3 dBFS / RMS −27.3 dB, player2 peak −9.8 dBFS /
RMS −34.4 dB — sane voice levels, no clipping, no DC/flat-line artifacts.

## 6. Spectrograms (visually inspected)

| file | what it shows |
|---|---|
| `out/player1-spectrogram.png` | 75 s: ~15 talk bursts, black silence gaps between, harmonic striations + formant bands <5 kHz |
| `out/player1-spectrogram-zoom.png` | 20 s slice (t=5–25 s): clear pitch pulses, F0/overtones, formant transitions, sharp burst boundaries |
| `out/player2-spectrogram.png` | 65 s: dense speech 0–37 s then sparse, structure identical to player1 |
| `out/player2-spectrogram-zoom.png` | 20 s slice: same harmonic/formant structure |

Reading: horizontal-ish bright bands = formants, vertical striations = pitch periods,
clean black gaps = silence between utterances, energy tapers above ~5 kHz with some
content to ~16 kHz (fullband encoder). **No noise-like full-band smears → framing is
correct; audio is not robotic/garbled.** A short broadband patch (e.g. player1 ~1.5–2.5 s)
is consistent with breath/background noise, not misframing.

Commands: `ffmpeg -i out/playerX.wav -lavfi showspectrumpic=s=1280x720 out/playerX-spectrogram.png`.

## 7. Bonus: DTX, loss, tick clustering

- **DTX:** none — 0 payloads of size ≤ 2 of 123,507. Silence is encoded simply as
  "no VoiceData messages". (So VAD/gate for the UI must come from chunk presence.)
- **Loss:** `section_number` is a per-sender chunk counter, contiguous +1 for
  123,490/123,507 chunks — only **17 gaps total (0.014%)**, max per-player 4.
  The demo barely drops voice; section_number can be used to detect the rare gap.
- **Clustering:** bursty, as expected — player1: 164 bursts (gap ≤ 8 ticks),
  longest run 8.9 s of continuous chunks; huge inter-burst gaps (up to 6,541 ticks
  ≈ 102 s) between rounds/phases. Total speech wall-time 232 s over a 2,104 s span.
  10 players × intermittent talk = 123,507 chunks over 35.6 min.

## 8. Reproduce

```sh
cd /tmp/opencode/voicespike
go run ./dump        # parse demo → histogram + hexdump + xuid_*.bin  (~2 min)
go run ./analyze     # framing×rate sweep + WAVs to out/
ffmpeg -y -i out/player1.wav -lavfi showspectrumpic=s=1280x720 out/player1-spectrogram.png
ffmpeg -y -i out/player1.wav -af astats=metadata=1:reset=0 -f null -
```

Key files: `dump/main.go`, `analyze/main.go`, `dump-out.txt`, `out/*.wav`, `out/*.png`.
Module pins: `demoinfocs-golang/v6 v6.0.0-rc.1`, `pion/opus v0.1.1-0.20261026214112-e7b8aa55508c`.
Fallback demo (`/home/christian/Programming/demo/demo.dem`) was **not needed** —
donk.dem voice decoded cleanly.
