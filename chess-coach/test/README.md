# Tests

Two suites, both run by hand. There is no test runner configured and no test
dependency in `package.json` — that is deliberate for a personal project, but
it means the commands below are the whole story.

## `timing.test.ts` — clock arithmetic and bucketing

Pure functions only: time-control parsing, `[%clk]` / `[%emt]` extraction,
seconds-per-move from clock readings, pace bucketing, finding thresholds, and
cross-game aggregation. Fast, no browser, no engine.

```sh
npx esbuild test/timing.test.ts --bundle --platform=node --format=esm \
  --outfile=/tmp/timing.test.mjs --log-level=error && node /tmp/timing.test.mjs
```

Exits non-zero on failure. The arithmetic assertions are worked out
independently in the test rather than read back from the code, so a change to
the formula fails rather than silently redefining the expected answer.

## `e2e-timing.mjs` — the whole path, in a real browser

Imports a PGN with clock comments, analyses it with the real Stockfish build,
and checks the review screen's clock card, its graph, the findings, the
per-move times, the side-switch rebuild, and the pooled Insights panel — plus
that the console stayed clean.

Needs `dist/` built **after** the engine has been fetched, or the worker gets
served HTML and fails with a confusing syntax error:

```sh
npm run engine && npm run build
PLAYWRIGHT_MODULE=/path/to/playwright/index.js node test/e2e-timing.mjs
```

`PLAYWRIGHT_MODULE` can be omitted if `playwright` resolves normally. Takes a
couple of minutes, most of it the engine analysing 33 positions at depth 14.
