// Puts the Stockfish WASM engine into public/engine/ so Vite serves it as a
// static asset.
//
// We use the "lite-single" build specifically:
//   * single-threaded  -> no SharedArrayBuffer, so the app needs no COOP/COEP
//                         response headers and runs on iOS Safari and on plain
//                         static hosts (GitHub Pages, Netlify, S3).
//   * lite (small net) -> ~7 MB of WASM instead of ~113 MB, which is the
//                         difference between "works on a phone" and "doesn't".
//
// Two sources, in order:
//   1. A CDN copy of the two files (~7 MB total). This is the default.
//   2. node_modules/stockfish, if you installed the optional package.
// The npm package is 240 MB unpacked because it also carries the full-strength
// nets we do not ship, which is why it is not a hard dependency.
import { createRequire } from "node:module";
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "18.0.8";
const FILES = ["stockfish-18-lite-single.js", "stockfish-18-lite-single.wasm"];
const CDNS = [
  (file) => `https://cdn.jsdelivr.net/npm/stockfish@${VERSION}/bin/${file}`,
  (file) => `https://unpkg.com/stockfish@${VERSION}/bin/${file}`,
];

const here = dirname(fileURLToPath(import.meta.url));
const dest = join(here, "..", "public", "engine");

await mkdir(dest, { recursive: true });

if (FILES.every((file) => existsSync(join(dest, file)))) {
  console.log("[engine] already present, nothing to do.");
  process.exit(0);
}

if (await copyFromNodeModules()) process.exit(0);
if (await downloadFromCdn()) process.exit(0);

console.error(
  [
    "[engine] Could not obtain the Stockfish WASM build.",
    "",
    "  Fix it either way:",
    `    a) npm install --no-save stockfish@${VERSION} && npm run engine`,
    `       (240 MB download — the package also ships full-strength nets we don't use)`,
    `    b) download these two files by hand into public/engine/:`,
    ...FILES.map((file) => `       ${CDNS[0](file)}`),
    "",
    "  The app builds and runs without them, but analysis will not start.",
  ].join("\n"),
);
process.exit(1);

async function copyFromNodeModules() {
  const require = createRequire(import.meta.url);
  let binDir;
  try {
    binDir = join(dirname(require.resolve("stockfish/package.json")), "bin");
  } catch {
    return false;
  }
  try {
    for (const file of FILES) {
      await copyFile(join(binDir, file), join(dest, file));
      await report(file, "node_modules");
    }
    return true;
  } catch (error) {
    console.warn(`[engine] node_modules copy failed: ${error.message}`);
    return false;
  }
}

async function downloadFromCdn() {
  for (const url of CDNS) {
    try {
      for (const file of FILES) {
        const response = await fetch(url(file));
        if (!response.ok) throw new Error(`HTTP ${response.status} for ${file}`);
        await writeFile(join(dest, file), Buffer.from(await response.arrayBuffer()));
        await report(file, new URL(url(file)).host);
      }
      return true;
    } catch (error) {
      console.warn(`[engine] ${error.message}`);
    }
  }
  return false;
}

async function report(file, source) {
  const { size } = await stat(join(dest, file));
  console.log(`[engine] ${file} — ${(size / 1024 / 1024).toFixed(1)} MB from ${source}`);
}
