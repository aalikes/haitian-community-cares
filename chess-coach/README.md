# Chess Coach

A personal chess coach that runs in your phone's browser. Import your own games,
get every move analysed by Stockfish, hear what went wrong and why, watch an
animated replay of the mistake and the move you should have played, and practise
the positions you keep losing.

No account, no server, no subscription. Everything runs on the device and stays
on the device.

## What it does

**Import** — pull recent games straight from Chess.com or Lichess by username
(both APIs are public, no login), or paste/upload a PGN.

**Analyse** — Stockfish 18 runs in a Web Worker in the browser. Each move is
graded, the engine's preferred line recorded, and the refutation of what you
actually played worked out.

**Explain** — every mistake gets a written and spoken explanation: what it cost,
how it gets punished, what to play instead, and the pattern behind it
("your piece was undefended", "a fork was coming"). The voice is your phone's
own text-to-speech.

**Watch** — an animated clip that plays the mistake, the punishment, and the
correct move with captions. Exportable as a video file.

**Drill** — the blunders from your games become practice positions, ordered by
which weaknesses show up most often, with simple spaced repetition so they come
back until they stick.

**Track** — a ranked list of your recurring problems, accuracy over time, and
which phase of the game leaks the most.

**Time** — what the clock says about your chess: whether your blunders come on
moves you played in a second, whether the damage happens once you are short of
time, and whether you burn the clock in the opening and then have nothing left
for the position that actually needed it.

## Quick start

```sh
npm install     # also fetches the ~7 MB Stockfish WASM build into public/engine/
npm run dev     # then open the printed LAN address on your phone
```

Build for deployment:

```sh
npm run build   # static files in dist/ — host them anywhere
npm run preview
```

The output is plain static files with no server component, so GitHub Pages,
Netlify, Cloudflare Pages, or an S3 bucket all work. The app needs **no special
response headers** (see below).

## How the analysis works

**One search per position, not two per move.** To judge a move you need the
evaluation before it and after it. The evaluation after your move is just the
negation of the engine's best score in the *next* position — which has to be
searched anyway. So a 40-move game costs 81 searches instead of 160. On a phone
that is the difference between a coffee break and a wait.

**Mistakes are measured in win probability, not centipawns.** Dropping a pawn
when you are +9 barely matters; dropping one in a level position can be the
game. Every judgement goes through a logistic win-probability curve first, so
the thresholds mean the same thing in every position:

| Verdict | Win probability given away |
|---|---|
| Inaccuracy | 10% |
| Mistake | 20% |
| Blunder | 30% |

**The numbers match Lichess deliberately.** The win-probability curve
(`k = 0.00368208`), the three thresholds above, the per-move accuracy curve
(`103.1668·exp(−0.043544·L) − 3.1669`, plus Lichess's `+1` uncertainty bonus)
and the game-level aggregation — a volatility-weighted arithmetic mean blended
with a harmonic mean over sliding windows of 2–8 moves — are all reproduced from
[lila's `AccuracyPercent.scala`](https://github.com/lichess-org/lila/blob/master/modules/analyse/src/main/AccuracyPercent.scala)
and `Advice.scala`. The per-move curve is verified to match to zero deviation.

That is a deliberate choice over inventing a stricter scale. If "84%" here meant
something different from "84%" on Lichess, the number would be worse than
useless. The volatility weighting matters because it discounts quiet positions
where a small "loss" is mostly engine noise; the harmonic mean matters because
it stops one catastrophe being averaged away by forty quiet moves.

`Only move` is claimed only when it is checkable — you played the engine's first
choice *and* every alternative was clearly worse. This is our own addition, not
a Lichess concept.

**Patterns come from the board, not from guesswork.** Weakness tags
(`hanging-piece`, `allowed-fork`, `missed-mate`, `lost-queen`, …) are derived by
replaying the engine's refutation and looking at what actually happens: which
piece gets captured, whether the capture square was defended, whether one enemy
piece ends up attacking two of yours. Nothing is inferred about what you were
thinking.

**Switching sides is free.** Everything the engine produces is
side-independent, so if the app guessed the wrong colour for "you", the toggle
in the review header re-scopes the whole analysis — commentary included —
without touching the engine.

## What the clock says

Every game imported from Chess.com or Lichess already carries a full record of
how long each move took, in PGN comments (`{[%clk 0:02:30.5]}`). The reading is
the time *remaining* after the move, with the increment already credited, so
the time a move actually took is `previous + increment − current`. A player who
moves instantly on a 2-second increment therefore gains time, which is why the
increment has to be read from the `TimeControl` tag rather than assumed to be
zero.

Moves are then grouped three ways and each group is scored on the same terms —
how much win probability it gave away per move:

| Group | Definition |
|---|---|
| Snap moves | under a third of your median move time *in that game* |
| Normal pace | everything in between |
| Long thinks | over twice your median |
| In time trouble | played with under 20% of the starting time left |

**Fast and slow are measured against your own pace, not a fixed number of
seconds.** Three seconds is a long think in bullet and an instant move in
rapid; a fixed threshold would call every bullet move rushed and every rapid
move considered. For the same reason, pooling games on the Insights tab
combines the *buckets* rather than the raw times — each game is classified
against its own tempo first, so a blitz session cannot drown out a rapid one.

Findings are only stated when a group has at least 3 moves in it and is at
least 1.4× worse than the comparison group. One fast blunder is a story, not a
pattern, and "slow down" is bad advice on that evidence.

### What it cannot tell you

**It measures pace, not intent.** A one-second move can be an instant
recapture that needed no thought. The tool reports that your fast moves cost
more, which is a prompt to look, not a diagnosis.

**Correspondence games are excluded.** "Time spent" on a daily game is the gap
between sitting down at a computer twice, which says nothing about chess.

**Pasted PGNs without a `TimeControl` tag get an estimate.** The increment is
guessed by looking for moves where a player's clock went *up*, which only
happens if they sometimes moved faster than the increment. If nobody ever did,
the guess is zero and every move is under-reported by the true increment — the
same amount each time, so comparisons between moves still hold even though the
absolute seconds do not. The review says so when this happens.

## Things worth knowing before you rely on it

**Depth matters more than you would think.** The default is 14, which catches
every blunder and most mistakes and takes about a second per move on a phone. It
is *not* deep enough to understand long sacrifices. Testing this app on Morphy's
Opera Game at depth 10, the engine confidently labelled his winning combination a
"mistake" — the refutation is simply deeper than 10 ply. If you are reviewing
sharp, sacrificial play, push the depth up in Settings and expect it to be slow.
Roughly, every two plies of depth doubles the time.

**The exported video has no audio.** Browsers do not allow a page to capture
system speech synthesis, so the file carries the on-screen captions and no voice
track. The narration plays live in the app. Exporting also runs in real time — a
15-second clip takes 15 seconds to record — because canvas capture streams frames
as they are painted.

Exported WebM files also report their duration as `Infinity`. That is how
`MediaRecorder` writes the container, not a corrupt file; playback and seeking
work, but some players show no timeline.

**The Claude coaching layer is optional and stores your key in the browser.**
The whole app works without it. If you turn it on, the API key is kept in this
browser's IndexedDB and sent only to `api.anthropic.com` — but because the
request goes directly from the page, anything running on the page can read it.
That is fine on your own phone. **Do not enable it on a deployment other people
can reach.** A shared deployment should proxy the API through a small backend
that holds the key instead.

**Storage is per-browser.** Games, analysis, and drill progress live in
IndexedDB. Clearing site data wipes them, and there is no sync between devices.

## The engine build

`scripts/copy-engine.mjs` fetches two files into `public/engine/`:

- `stockfish-18-lite-single.js` (~21 KB glue)
- `stockfish-18-lite-single.wasm` (~7 MB)

Both choices are deliberate:

- **single-threaded** — the multi-threaded builds need `SharedArrayBuffer`, which
  requires `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy`
  response headers. Most static hosts cannot set those, and iOS Safari is fussy
  about them. Single-threaded costs some speed and buys "works everywhere".
- **lite** — the full-strength network is a 113 MB `.wasm`. The lite net is 7 MB
  and still far stronger than any human opponent you will face.

The files are gitignored rather than committed. The `stockfish` npm package is
**240 MB unpacked** because it ships every net, so it is not a dependency; the
script pulls just the two files from a CDN. If your network blocks the CDN:

```sh
npm install --no-save stockfish@18.0.8 && npm run engine
```

## Project layout

```
src/
  engine/
    engine.ts       UCI worker wrapper; searches are queued, one at a time
    analysis.ts     Whole-game pipeline + rescopeAnalysis (switch sides, no engine)
  chess/
    evaluation.ts   Score handling and the win-probability curve
    classify.ts     Win-probability thresholds -> blunder / mistake / inaccuracy
    motifs.ts       Weakness detection from the board and the refutation line
    clock.ts        PGN clock comments -> seconds per move
    util.ts         PGN, SAN/UCI conversion, material, phase
  coach/
    commentary.ts   Written and spoken explanations
    timing.ts       Pace buckets, time trouble, and the findings they produce
    notation.ts     "Nxd4+" -> "knight takes d4, check", for the voice
    drills.ts       Drill generation, prioritisation, spaced repetition
    profile.ts      Cross-game weakness aggregation
    voice.ts        Web Speech API wrapper
    claude.ts       Optional Claude layer (lazy-loaded)
  board/draw.ts     Canvas renderer, shared by the UI and the video export
  video/
    storyboard.ts   The shot list, so live playback and the export cannot drift
    render.ts       Frame composition (board + caption panel)
    player.ts       Realtime playback and MediaRecorder export
  ui/               Screens: games, review, drills, insights, settings
  data/             IndexedDB storage and the game importers
```

Pieces are drawn as Unicode chess glyphs with the text-presentation selector
(`U+FE0E`) appended, so phones render them as shapes rather than colour emoji.
Both colours use the same solid glyph, filled light or dark with a contrasting
outline, which keeps them legible on either square colour and needs no image
assets.

## Not included

Playing against the engine, an opening trainer, cross-device sync, and offline
support (the app needs a connection to load; once loaded, analysis itself is
local).
