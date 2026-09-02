/**
 * Browser check for the clock analytics, end to end: import a PGN carrying
 * clock comments, analyse it in a real browser with the real engine, and
 * confirm the timing card, the per-move times and the pooled Insights panel
 * all show up with the right numbers.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
// Playwright is not a project dependency — this suite is run by hand, not in
// CI. Point PLAYWRIGHT_MODULE at an install if it is not resolvable normally.
const pw = (await import(process.env.PLAYWRIGHT_MODULE ?? "playwright")).default;
import { Chess } from "chess.js";


const { chromium } = pw;
const ROOT = path.resolve(import.meta.dirname, "../dist");
const PORT = 4183;

let passes = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) {
    passes += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------- fixture --
// The Opera Game. Black loses; we make Black the hero and give Black a clock
// pattern with a clear story: sensible early, then panicking and moving fast.
const SAN = `e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5 Bc4 Nf6 Qb3 Qe7 Nc3 c6 Bg5 b5
Nxb5 cxb5 Bxb5+ Nbd7 O-O-O Rd8 Rxd7 Rxd7 Rd1 Qe6 Bxd7+ Nxd7 Qb8+ Nxb8 Rd8#`
  .split(/\s+/)
  .filter(Boolean);

const BASE = 300;
const INCREMENT = 0;
// Seconds per move. Black (odd indices) thinks properly for the first eight
// moves, then plays the collapse at one second a move and lands in trouble.
function secondsFor(index) {
  const black = index % 2 === 1;
  if (!black) return 4;
  return index < 16 ? 22 : 1;
}

function buildPgn() {
  const board = new Chess();
  const clocks = { w: BASE, b: BASE };
  const parts = [];
  SAN.forEach((san, index) => {
    const color = index % 2 === 0 ? "w" : "b";
    const move = board.move(san);
    if (!move) throw new Error(`illegal fixture move ${san} at ${index}`);
    clocks[color] = clocks[color] - secondsFor(index) + INCREMENT;
    if (clocks[color] < 1) throw new Error(`fixture ran out of clock at ${index}`);
    const stamp = new Date(clocks[color] * 1000).toISOString().slice(11, 19);
    if (color === "w") parts.push(`${Math.floor(index / 2) + 1}.`);
    parts.push(`${san} {[%clk ${stamp.replace(/^0/, "")}]}`);
  });
  return [
    '[Event "Paris"]',
    '[Site "Paris FRA"]',
    '[Date "1858.10.31"]',
    '[White "Morphy, Paul"]',
    '[Black "Duke Karl / Count Isouard"]',
    '[Result "1-0"]',
    '[TimeControl "300"]',
    "",
    `${parts.join(" ")} 1-0`,
  ].join("\n");
}

const PGN = buildPgn();

// Independently recompute what the app should report for Black, so the browser
// assertions are checked against arithmetic done outside the app.
const blackTimes = SAN.map((_, index) => index).filter((i) => i % 2 === 1).map(secondsFor);
const expectedTotal = blackTimes.reduce((a, b) => a + b, 0);
const expectedFinalClock = BASE - expectedTotal;

// ----------------------------------------------------------------- server --
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".json": "application/json",
};
const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);
  // The browser always asks for a favicon; answering it keeps the console
  // clean so that a real 404 is unambiguous.
  if (url === "/favicon.ico") {
    res.writeHead(200, { "Content-Type": "image/x-icon" }).end();
    return;
  }
  const file = path.join(ROOT, url === "/" ? "index.html" : url);
  // 404 rather than falling back to index.html: a missing engine file served
  // as HTML fails deep inside a worker with an unhelpful syntax error.
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (!/favicon/.test(url)) console.log(`  [server] 404 ${url}`);
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

async function main() {
  await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage({ viewport: { width: 414, height: 896 } });

  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle" });

  // ---- import ------------------------------------------------------------
  console.log("\nImport");
  await page.getByRole("button", { name: /paste pgn/i }).click();
  await page.locator("textarea").fill(PGN);
  await page.getByRole("button", { name: /add games/i }).click();
  await page.waitForSelector(".game-row", { timeout: 15000 });
  const listed = await page.getByText(/Morphy/).first().isVisible();
  check("game appears in the list", listed);

  // ---- open and set the hero side ---------------------------------------
  console.log("\nReview");
  await page.locator(".game-main").first().click();
  await page.waitForSelector(".side-switch", { timeout: 10000 });
  await page.getByRole("button", { name: "Black", exact: true }).click();
  await page.waitForTimeout(300);

  // ---- analyse -----------------------------------------------------------
  await page.getByRole("button", { name: /analyse this game/i }).click();
  await page.waitForFunction(
    () => !!document.body.textContent && /The clock/.test(document.body.textContent),
    null,
    { timeout: 240000 },
  );
  console.log("  (analysis complete)");

  // ---- the clock card ----------------------------------------------------
  const clockCard = page.locator("section.card").filter({ hasText: "The clock" }).first();
  check("clock card rendered", await clockCard.isVisible());

  const stats = await clockCard.locator(".stat").allInnerTexts();
  const statText = stats.join(" | ");
  // 8 moves at 22s + 8 at 1s = 184s used, 116s left of 300.
  check(
    `time used reported as ${Math.floor(expectedTotal / 60)}:${String(expectedTotal % 60).padStart(2, "0")}`,
    statText.includes("3:04"),
    statText,
  );
  check("time left at end reported as 1:56", statText.includes("1:56"), statText);
  check("expected arithmetic holds", expectedTotal === 184 && expectedFinalClock === 116);

  const clockGraph = clockCard.locator("svg.eval-graph");
  check("clock graph drawn", (await clockGraph.count()) === 1);
  check("both clock lines drawn", (await clockCard.locator("path.clock-line").count()) === 2);

  // ---- the finding -------------------------------------------------------
  const findings = await clockCard.locator(".finding-list li").allInnerTexts();
  console.log("  findings:");
  for (const finding of findings) console.log(`    · ${finding}`);
  check("at least one finding stated", findings.length > 0);
  check(
    "the collapse is attributed to speed or the clock",
    findings.some((text) => /under \d|time trouble|clock/i.test(text)),
    findings.join(" / "),
  );

  // ---- buckets -----------------------------------------------------------
  const bucketText = await clockCard.locator(".phase-list").first().innerText();
  check("snap moves bucket present", /Snap moves/.test(bucketText), bucketText);
  check("normal pace bucket present", /Normal pace/.test(bucketText), bucketText);
  check(
    "eight snap moves counted",
    /8 moves/.test(bucketText),
    bucketText.replace(/\n/g, " · "),
  );


  // ---- per-move time in the commentary card ------------------------------
  await page.getByRole("button", { name: /next mistake/i }).click();
  await page.waitForTimeout(400);
  const detail = await page.locator(".detail-grid").first().innerText();
  check("per-move time shown", /time taken/i.test(detail), detail.replace(/\n/g, " · "));
  check("per-move clock remaining shown", /left/i.test(detail), detail.replace(/\n/g, " · "));

  // ---- side switch rebuilds the timing without re-analysing --------------
  console.log("\nSide switch");
  await page.getByRole("button", { name: "White", exact: true }).click();
  await page.waitForTimeout(700);
  const whiteStats = (await page.locator("section.card").filter({ hasText: "The clock" }).first().locator(".stat").allInnerTexts()).join(" | ");
  // White played 17 moves at 4s = 68s, leaving 232s = 3:52.
  check("switching sides recomputes the clock report", whiteStats.includes("3:52"), whiteStats);
  check("no re-analysis was needed", !(await page.getByRole("button", { name: /analyse this game/i }).isVisible().catch(() => false)));
  await page.getByRole("button", { name: "Black", exact: true }).click();
  await page.waitForTimeout(500);

  // ---- insights ----------------------------------------------------------
  console.log("\nInsights");
  await page.locator(".tabbar .tab", { hasText: "Insights" }).click();
  await page.waitForTimeout(800);
  const insights = await page.locator(".screen").innerText();
  check("pooled clock section present", /Your clock/.test(insights));
  check("pooled section names the game count", /1 game that carried clock data/.test(insights), insights.slice(0, 400));

  // ---- console -----------------------------------------------------------
  console.log("\nConsole");
  check("no console errors", consoleErrors.length === 0, consoleErrors.join(" | "));


  await browser.close();
  server.close();

  console.log(`\n${passes} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const failure of failures) console.log(`  ✗ ${failure}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  server.close();
  process.exit(1);
});
