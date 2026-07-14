import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(projectRoot, process.argv[2] ?? "../GPSData000001.txt");
const outputRoot = resolve(projectRoot, "public/data");
const sessionsRoot = resolve(outputRoot, "sessions");

const SPEED_TO_KMH = 0.036;
const EARTH_RADIUS_METERS = 6_371_008.8;
const TIMESTAMP_JUMP_SECONDS = 86_400;
const NORMAL_GAP_SECONDS = 5;
const PHOENIX_UTC_OFFSET_SECONDS = 7 * 60 * 60;
const VIDEO_TIMESTAMP_PATTERN = /NO(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/;
const SPEED_BIN_WIDTH_KMH = 10;
const SPEED_BIN_COUNT = 14;

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRadians = Math.PI / 180;
  const phi1 = lat1 * toRadians;
  const phi2 = lat2 * toRadians;
  const deltaPhi = (lat2 - lat1) * toRadians;
  const deltaLambda = (lon2 - lon1) * toRadians;
  const a =
    Math.sin(deltaPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(a));
}

function videoTimestampInPhoenix(video) {
  const match = video.match(VIDEO_TIMESTAMP_PATTERN);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const wallClockAsUtc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  ) / 1_000;
  return wallClockAsUtc + PHOENIX_UTC_OFFSET_SECONDS;
}

function inferTimestampCorrectionSeconds(lines) {
  const candidates = [];
  const seenVideos = new Set();

  for (const line of lines) {
    if (!line || line.startsWith("$")) continue;
    const fields = line.split(",").map((value) => value.trim());
    if (fields.length !== 13 || fields[1] !== "A" || seenVideos.has(fields[9])) continue;

    const filenameTimestamp = videoTimestampInPhoenix(fields[9]);
    const rawTimestamp = Number(fields[0]);
    if (filenameTimestamp === null || !Number.isFinite(rawTimestamp)) continue;
    seenVideos.add(fields[9]);
    candidates.push(filenameTimestamp - rawTimestamp);
  }

  if (candidates.length === 0) return 0;
  candidates.sort((left, right) => left - right);
  const median = candidates[Math.floor(candidates.length / 2)];

  // The video name marks the beginning of a clip, while its first GPS sample can
  // arrive several seconds later. Rounding the median to an hour recovers the
  // dashcam's fixed clock-zone error without baking clip latency into the time.
  return Math.round(median / 3_600) * 3_600;
}

function createSession(id) {
  return {
    id,
    invalidRows: 0,
    pendingGap: false,
    timestampOffset: 0,
    deviceT: [],
    t: [],
    rawT: [],
    lat: [],
    lon: [],
    speed: [],
    heading: [],
    g: [],
    sensorX: [],
    sensorY: [],
    sensorZ: [],
    videoIndex: [],
    videos: [],
    videoLookup: new Map(),
    breakBefore: [],
    flags: [],
  };
}

function addPoint(session, fields, timestampCorrectionSeconds) {
  const rawTimestamp = Number(fields[0]);
  const latitude = Number(fields[2]);
  const longitude = Number(fields[3]);
  const heading = Number(fields[4]) / 100;
  const speedKmh = Number(fields[5]) * SPEED_TO_KMH;
  const sensorX = Number(fields[6]);
  const sensorY = Number(fields[7]);
  const sensorZ = Number(fields[8]);
  const video = fields[9];
  const previousIndex = session.t.length - 1;

  let deviceTimestamp = rawTimestamp + session.timestampOffset;
  let timestampAnomaly = false;
  let spatialJump = false;

  if (previousIndex >= 0) {
    const rawDelta = rawTimestamp - session.rawT[previousIndex];
    const previousDeviceTimestamp = session.deviceT[previousIndex];

    if (rawDelta < -TIMESTAMP_JUMP_SECONDS) {
      session.timestampOffset = Math.round(previousDeviceTimestamp + 1.5 - rawTimestamp);
      deviceTimestamp = rawTimestamp + session.timestampOffset;
      timestampAnomaly = true;
    } else if (
      session.timestampOffset !== 0 &&
      rawDelta > TIMESTAMP_JUMP_SECONDS &&
      rawTimestamp >= previousDeviceTimestamp - 5 &&
      rawTimestamp <= previousDeviceTimestamp + 300
    ) {
      session.timestampOffset = 0;
      deviceTimestamp = rawTimestamp;
      timestampAnomaly = true;
    }

    const deltaSeconds = deviceTimestamp - previousDeviceTimestamp;
    const distance = haversineMeters(
      session.lat[previousIndex],
      session.lon[previousIndex],
      latitude,
      longitude,
    );
    spatialJump = deltaSeconds > 0 && deltaSeconds <= NORMAL_GAP_SECONDS && distance / deltaSeconds > 80;
  }

  let flags = 0;
  if (session.pendingGap) flags |= 1;
  if (timestampAnomaly) flags |= 2;
  if (spatialJump) flags |= 4;

  const timeGap =
    previousIndex >= 0 &&
    (deviceTimestamp <= session.deviceT[previousIndex] ||
      deviceTimestamp - session.deviceT[previousIndex] > NORMAL_GAP_SECONDS);
  const shouldBreak = previousIndex < 0 || flags !== 0 || timeGap;

  let videoIndex = session.videoLookup.get(video);
  if (videoIndex === undefined) {
    videoIndex = session.videos.length;
    session.videoLookup.set(video, videoIndex);
    session.videos.push(video);
  }

  session.deviceT.push(Math.round(deviceTimestamp));
  session.t.push(Math.round(deviceTimestamp + timestampCorrectionSeconds));
  session.rawT.push(rawTimestamp);
  session.lat.push(round(latitude, 6));
  session.lon.push(round(longitude, 6));
  session.speed.push(round(speedKmh, 2));
  session.heading.push(round(heading, 2));
  session.g.push(round(Math.sqrt(sensorX ** 2 + sensorY ** 2 + sensorZ ** 2) / 100, 3));
  session.sensorX.push(sensorX);
  session.sensorY.push(sensorY);
  session.sensorZ.push(sensorZ);
  session.videoIndex.push(videoIndex);
  session.breakBefore.push(shouldBreak ? 1 : 0);
  session.flags.push(flags);
  session.pendingGap = false;
}

function summarizeSession(session) {
  const pointCount = session.t.length;
  let distanceMeters = 0;
  let gaps = 0;
  let timestampAnomalies = 0;
  let maxSpeedKmh = 0;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;

  for (let index = 0; index < pointCount; index += 1) {
    minLat = Math.min(minLat, session.lat[index]);
    maxLat = Math.max(maxLat, session.lat[index]);
    minLon = Math.min(minLon, session.lon[index]);
    maxLon = Math.max(maxLon, session.lon[index]);
    maxSpeedKmh = Math.max(maxSpeedKmh, session.speed[index]);

    if (session.flags[index] & 2) timestampAnomalies += 1;
    if (index > 0 && session.breakBefore[index]) gaps += 1;
    if (index > 0 && !session.breakBefore[index]) {
      distanceMeters += haversineMeters(
        session.lat[index - 1],
        session.lon[index - 1],
        session.lat[index],
        session.lon[index],
      );
    }
  }

  const serializable = {
    id: session.id,
    t: session.t,
    rawT: session.rawT,
    lat: session.lat,
    lon: session.lon,
    speed: session.speed,
    heading: session.heading,
    g: session.g,
    sensorX: session.sensorX,
    sensorY: session.sensorY,
    sensorZ: session.sensorZ,
    videoIndex: session.videoIndex,
    videos: session.videos,
    breakBefore: session.breakBefore,
    flags: session.flags,
  };

  return {
    serializable,
    summary: {
      id: session.id,
      startTime: session.t[0],
      endTime: session.t[pointCount - 1],
      durationSeconds: Math.max(0, session.t[pointCount - 1] - session.t[0]),
      distanceMeters: Math.round(distanceMeters),
      maxSpeedKmh: round(maxSpeedKmh, 1),
      pointCount,
      invalidRows: session.invalidRows,
      gaps,
      timestampAnomalies,
      videoCount: session.videos.length,
      bounds: [round(minLon, 6), round(minLat, 6), round(maxLon, 6), round(maxLat, 6)],
      file: `sessions/${String(session.id).padStart(3, "0")}.json`,
    },
  };
}

function percentile(sortedValues, ratio) {
  if (sortedValues.length === 0) return 0;
  return sortedValues[Math.floor((sortedValues.length - 1) * ratio)];
}

function phoenixDateParts(timestamp) {
  const phoenixWallClock = new Date((timestamp - PHOENIX_UTC_OFFSET_SECONDS) * 1_000);
  return {
    date: phoenixWallClock.toISOString().slice(0, 10),
    month: phoenixWallClock.toISOString().slice(0, 7),
    hour: phoenixWallClock.getUTCHours(),
  };
}

function createStatistics(sessions, source) {
  const speedBins = Array.from({ length: SPEED_BIN_COUNT }, (_, index) => ({
    label:
      index === SPEED_BIN_COUNT - 1
        ? `≥${index * SPEED_BIN_WIDTH_KMH}`
        : `${index * SPEED_BIN_WIDTH_KMH}–${(index + 1) * SPEED_BIN_WIDTH_KMH}`,
    minSpeedKmh: index * SPEED_BIN_WIDTH_KMH,
    maxSpeedKmh: index === SPEED_BIN_COUNT - 1 ? null : (index + 1) * SPEED_BIN_WIDTH_KMH,
    distanceMeters: 0,
    durationSeconds: 0,
  }));
  const hourlyDistanceMeters = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    distanceMeters: 0,
  }));
  const dailyDistance = new Map();
  const monthlyDistance = new Map();
  const speedSamples = [];
  let totalDistanceMeters = 0;
  let trackedSeconds = 0;
  let movingDistanceMeters = 0;
  let movingSeconds = 0;
  let stationarySeconds = 0;
  let highSpeedDistanceMeters = 0;
  let nightDistanceMeters = 0;
  let longestSession = { id: 0, distanceMeters: 0, startTime: 0 };

  for (const session of sessions) {
    if (session.t.length === 0) continue;
    speedSamples.push(...session.speed);
    let sessionDistanceMeters = 0;

    for (let index = 1; index < session.t.length; index += 1) {
      if (session.breakBefore[index]) continue;
      const durationSeconds = session.t[index] - session.t[index - 1];
      if (durationSeconds <= 0 || durationSeconds > NORMAL_GAP_SECONDS) continue;

      const distanceMeters = haversineMeters(
        session.lat[index - 1],
        session.lon[index - 1],
        session.lat[index],
        session.lon[index],
      );
      const speedKmh = (session.speed[index - 1] + session.speed[index]) / 2;
      const binIndex = Math.min(
        SPEED_BIN_COUNT - 1,
        Math.max(0, Math.floor(speedKmh / SPEED_BIN_WIDTH_KMH)),
      );
      const { date, month, hour } = phoenixDateParts(session.t[index]);

      speedBins[binIndex].distanceMeters += distanceMeters;
      speedBins[binIndex].durationSeconds += durationSeconds;
      hourlyDistanceMeters[hour].distanceMeters += distanceMeters;
      dailyDistance.set(date, (dailyDistance.get(date) ?? 0) + distanceMeters);
      monthlyDistance.set(month, (monthlyDistance.get(month) ?? 0) + distanceMeters);
      totalDistanceMeters += distanceMeters;
      trackedSeconds += durationSeconds;
      sessionDistanceMeters += distanceMeters;

      if (speedKmh >= 5) {
        movingDistanceMeters += distanceMeters;
        movingSeconds += durationSeconds;
      }
      if (speedKmh < 1) stationarySeconds += durationSeconds;
      if (speedKmh >= 100) highSpeedDistanceMeters += distanceMeters;
      if (hour < 6 || hour >= 20) nightDistanceMeters += distanceMeters;
    }

    if (sessionDistanceMeters > longestSession.distanceMeters) {
      longestSession = {
        id: session.id,
        distanceMeters: sessionDistanceMeters,
        startTime: session.t[0],
      };
    }
  }

  speedSamples.sort((left, right) => left - right);
  const mostActiveDay = [...dailyDistance.entries()].reduce(
    (best, [date, distanceMeters]) =>
      distanceMeters > best.distanceMeters ? { date, distanceMeters } : best,
    { date: "", distanceMeters: 0 },
  );

  return {
    formatVersion: 1,
    source,
    timezone: "America/Phoenix",
    totals: {
      distanceMeters: Math.round(totalDistanceMeters),
      trackedSeconds: Math.round(trackedSeconds),
      movingAverageSpeedKmh: round(
        movingSeconds > 0 ? (movingDistanceMeters / 1_000) / (movingSeconds / 3_600) : 0,
        1,
      ),
      stationarySeconds: Math.round(stationarySeconds),
      highSpeedDistanceMeters: Math.round(highSpeedDistanceMeters),
      highSpeedDistanceShare: round(
        totalDistanceMeters > 0 ? highSpeedDistanceMeters / totalDistanceMeters : 0,
        4,
      ),
      nightDistanceMeters: Math.round(nightDistanceMeters),
      nightDistanceShare: round(
        totalDistanceMeters > 0 ? nightDistanceMeters / totalDistanceMeters : 0,
        4,
      ),
      speedP50Kmh: round(percentile(speedSamples, 0.5), 1),
      speedP85Kmh: round(percentile(speedSamples, 0.85), 1),
      speedP95Kmh: round(percentile(speedSamples, 0.95), 1),
      speedP99Kmh: round(percentile(speedSamples, 0.99), 1),
    },
    speedBins: speedBins.map((bin) => ({
      ...bin,
      distanceMeters: Math.round(bin.distanceMeters),
      durationSeconds: Math.round(bin.durationSeconds),
      distanceShare: round(
        totalDistanceMeters > 0 ? bin.distanceMeters / totalDistanceMeters : 0,
        4,
      ),
    })),
    hourlyDistanceMeters: hourlyDistanceMeters.map((item) => ({
      ...item,
      distanceMeters: Math.round(item.distanceMeters),
    })),
    monthlyDistanceMeters: [...monthlyDistance.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([month, distanceMeters]) => ({ month, distanceMeters: Math.round(distanceMeters) })),
    longestSession: {
      ...longestSession,
      distanceMeters: Math.round(longestSession.distanceMeters),
    },
    mostActiveDay: {
      ...mostActiveDay,
      distanceMeters: Math.round(mostActiveDay.distanceMeters),
    },
  };
}

const raw = await readFile(sourcePath, "utf8");
const lines = raw.split(/\r?\n/);
const rawTimestampCorrectionSeconds = inferTimestampCorrectionSeconds(lines);
const sessions = [];
let current = null;

for (const line of lines) {
  if (!line) continue;
  if (line.startsWith("$")) {
    current = createSession(sessions.length + 1);
    sessions.push(current);
    continue;
  }
  if (!current) continue;

  const fields = line.split(",").map((value) => value.trim());
  if (fields.length !== 13) continue;
  if (fields[1] === "V") {
    current.invalidRows += 1;
    current.pendingGap = true;
    continue;
  }
  if (fields[1] === "A") addPoint(current, fields, rawTimestampCorrectionSeconds);
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(sessionsRoot, { recursive: true });

const summaries = [];
const totals = {
  sessionCount: 0,
  pointCount: 0,
  invalidRows: 0,
  durationSeconds: 0,
  distanceMeters: 0,
  videoCount: 0,
  maxSpeedKmh: 0,
  startTime: Infinity,
  endTime: -Infinity,
  timestampAnomalies: 0,
};

for (const session of sessions) {
  if (session.t.length === 0) continue;
  const { serializable, summary } = summarizeSession(session);
  summaries.push(summary);
  totals.sessionCount += 1;
  totals.pointCount += summary.pointCount;
  totals.invalidRows += summary.invalidRows;
  totals.durationSeconds += summary.durationSeconds;
  totals.distanceMeters += summary.distanceMeters;
  totals.videoCount += summary.videoCount;
  totals.maxSpeedKmh = Math.max(totals.maxSpeedKmh, summary.maxSpeedKmh);
  totals.startTime = Math.min(totals.startTime, summary.startTime);
  totals.endTime = Math.max(totals.endTime, summary.endTime);
  totals.timestampAnomalies += summary.timestampAnomalies;

  await writeFile(
    resolve(outputRoot, summary.file),
    `${JSON.stringify(serializable)}\n`,
  );
}

const manifest = {
  formatVersion: 2,
  source: basename(sourcePath),
  generatedAt: new Date().toISOString(),
  timezone: "America/Phoenix",
  rawTimestampCorrectionSeconds,
  timestampCorrectionBasis: "video-filename-phoenix-wall-clock",
  totals,
  sessions: summaries,
};

await writeFile(resolve(outputRoot, "manifest.json"), `${JSON.stringify(manifest)}\n`);
await writeFile(
  resolve(outputRoot, "statistics.json"),
  `${JSON.stringify(createStatistics(sessions, basename(sourcePath)))}\n`,
);

console.log(
  `Parsed ${totals.pointCount.toLocaleString()} points across ${totals.sessionCount} sessions into ${outputRoot}`,
);
