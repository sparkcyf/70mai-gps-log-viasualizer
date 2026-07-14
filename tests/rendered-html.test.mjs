import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

async function readGeneratedJson(relativePath, context) {
  try {
    return JSON.parse(
      await readFile(new URL(`../public/data/${relativePath}`, import.meta.url), "utf8"),
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      context.skip("generated GPS data is absent; run npm run ingest to include data checks");
      return null;
    }
    throw error;
  }
}

test("server-renders the GPS log explorer shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>行车轨迹档案<\/title>/i);
  assert.match(html, /正在展开行车轨迹/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/);
});

test("server-renders the full-log statistics page", async () => {
  const response = await render("/stats");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>全量驾驶统计 · 行车轨迹档案<\/title>/i);
  assert.match(html, /正在汇总整份日志/);
});

test("generated manifest is internally consistent", async (context) => {
  const manifest = await readGeneratedJson("manifest.json", context);
  if (!manifest) return;

  assert.match(manifest.source, /\.txt$/i);
  assert.equal(manifest.formatVersion, 2);
  assert.equal(manifest.timezone, "America/Phoenix");
  assert.equal(manifest.rawTimestampCorrectionSeconds % 3_600, 0);
  assert.equal(manifest.timestampCorrectionBasis, "video-filename-phoenix-wall-clock");
  assert.equal(manifest.totals.sessionCount, manifest.sessions.length);
  assert.equal(
    manifest.totals.pointCount,
    manifest.sessions.reduce((total, session) => total + session.pointCount, 0),
  );
  assert.equal(
    manifest.totals.invalidRows,
    manifest.sessions.reduce((total, session) => total + session.invalidRows, 0),
  );

  const firstSummary = manifest.sessions[0];
  const firstSession = await readGeneratedJson(firstSummary.file, context);
  if (!firstSession) return;
  assert.equal(firstSession.t.length, firstSummary.pointCount);
  assert.equal(
    firstSession.t[0] - firstSession.rawT[0],
    manifest.rawTimestampCorrectionSeconds,
  );
  assert.match(firstSession.videos[firstSession.videoIndex[0]], /^NO\d{8}-\d{6}-/);
});

test("uses the requested Protomaps daily PMTiles basemap", async () => {
  const source = await readFile(
    new URL("../app/GpsLogExplorer.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /https:\/\/build\.protomaps\.com\/20260713\.pmtiles/);
  assert.match(source, /maplibregl\.addProtocol\("pmtiles"/);
  assert.match(source, /@protomaps\/basemaps/);
  assert.match(source, /createRouteOverviewGeoJson/);
  assert.match(source, /route-overview-line/);
  assert.match(source, /tolerance: 0/);
  assert.doesNotMatch(source, /tile\.openstreetmap\.org/);
});

test("precomputes full-log distance and speed statistics", async (context) => {
  const statistics = await readGeneratedJson("statistics.json", context);
  if (!statistics) return;

  assert.match(statistics.source, /\.txt$/i);
  assert.equal(statistics.formatVersion, 1);
  assert.equal(statistics.timezone, "America/Phoenix");
  assert.equal(statistics.speedBins.length, 14);
  assert.ok(statistics.totals.distanceMeters > 0);
  assert.ok(statistics.totals.movingAverageSpeedKmh > 0);
  assert.ok(statistics.longestSession.distanceMeters > 0);
  assert.match(statistics.mostActiveDay.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(statistics.totals.nightDistanceShare >= 0);
  assert.ok(statistics.totals.highSpeedDistanceShare >= 0);

  const binnedDistance = statistics.speedBins.reduce(
    (total, bin) => total + bin.distanceMeters,
    0,
  );
  assert.ok(
    Math.abs(binnedDistance - statistics.totals.distanceMeters) <= statistics.speedBins.length,
  );
});
