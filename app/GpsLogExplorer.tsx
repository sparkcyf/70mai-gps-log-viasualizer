"use client";

import { LineChart } from "echarts/charts";
import {
  AxisPointerComponent,
  DataZoomComponent,
  GridComponent,
  MarkLineComponent,
  TooltipComponent,
} from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { layers, namedFlavor } from "@protomaps/basemaps";
import {
  ChevronLeft,
  ChevronRight,
  CirclePause,
  CirclePlay,
  Clock3,
  Gauge,
  MapPin,
  Route,
  Satellite,
  TriangleAlert,
} from "lucide-react";
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { FeatureCollection, LineString, Point } from "geojson";
import { Protocol } from "pmtiles";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AppNav from "./AppNav";

echarts.use([
  LineChart,
  AxisPointerComponent,
  DataZoomComponent,
  GridComponent,
  MarkLineComponent,
  TooltipComponent,
  CanvasRenderer,
]);

type SessionSummary = {
  id: number;
  startTime: number;
  endTime: number;
  durationSeconds: number;
  distanceMeters: number;
  maxSpeedKmh: number;
  pointCount: number;
  invalidRows: number;
  gaps: number;
  timestampAnomalies: number;
  videoCount: number;
  bounds: [number, number, number, number];
  file: string;
};

type Manifest = {
  formatVersion: number;
  source: string;
  generatedAt: string;
  timezone: string;
  rawTimestampCorrectionSeconds: number;
  timestampCorrectionBasis: string;
  totals: {
    sessionCount: number;
    pointCount: number;
    invalidRows: number;
    durationSeconds: number;
    distanceMeters: number;
    videoCount: number;
    maxSpeedKmh: number;
    startTime: number;
    endTime: number;
    timestampAnomalies: number;
  };
  sessions: SessionSummary[];
};

type SessionData = {
  id: number;
  t: number[];
  rawT: number[];
  lat: number[];
  lon: number[];
  speed: number[];
  heading: number[];
  g: number[];
  sensorX: number[];
  sensorY: number[];
  sensorZ: number[];
  videoIndex: number[];
  videos: string[];
  breakBefore: number[];
  flags: number[];
};

const EMPTY_GEOJSON: FeatureCollection = { type: "FeatureCollection", features: [] };
const PROTOMAPS_ARCHIVE = "https://build.protomaps.com/20260713.pmtiles";

type RouteSectionProperties = {
  startIndex: number;
  endIndex: number;
};

type SpeedSectionProperties = RouteSectionProperties & {
  speed: number;
};

function formatDistance(meters: number) {
  if (meters < 1_000) return `${Math.round(meters)} m`;
  return `${(meters / 1_000).toFixed(meters >= 100_000 ? 0 : 1)} km`;
}

function formatDuration(seconds: number, compact = false) {
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  if (hours > 0) return compact ? `${hours}时${minutes}分` : `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return compact ? `${minutes}分` : `${minutes} 分 ${remainingSeconds} 秒`;
  return `${remainingSeconds} 秒`;
}

function nearestIndex(values: number[], target: number) {
  let low = 0;
  let high = values.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  if (low > 0 && Math.abs(values[low - 1] - target) < Math.abs(values[low] - target)) {
    return low - 1;
  }
  return low;
}

function speedBand(speed: number) {
  if (speed < 35) return 0;
  if (speed < 70) return 1;
  if (speed < 105) return 2;
  if (speed < 140) return 3;
  return 4;
}

function createRouteOverviewGeoJson(
  session: SessionData,
): FeatureCollection<LineString, RouteSectionProperties> {
  const features: FeatureCollection<LineString, RouteSectionProperties>["features"] = [];
  let coordinates: [number, number][] = [];
  let startIndex = 0;

  const flush = () => {
    if (coordinates.length < 2) return;
    features.push({
      type: "Feature",
      properties: { startIndex, endIndex: startIndex + coordinates.length - 1 },
      geometry: { type: "LineString", coordinates },
    });
  };

  for (let index = 0; index < session.t.length; index += 1) {
    if (index === 0 || session.breakBefore[index]) {
      flush();
      startIndex = index;
      coordinates = [[session.lon[index], session.lat[index]]];
    } else {
      coordinates.push([session.lon[index], session.lat[index]]);
    }
  }
  flush();

  return { type: "FeatureCollection", features };
}

function createRouteGeoJson(
  session: SessionData,
): FeatureCollection<LineString, SpeedSectionProperties> {
  const features: FeatureCollection<LineString, SpeedSectionProperties>["features"] = [];
  let coordinates: [number, number][] = [];
  let startIndex = 0;
  let endIndex = 0;
  let activeBand = -1;
  let speedTotal = 0;
  let speedCount = 0;

  const flush = () => {
    if (coordinates.length < 2 || speedCount === 0) return;
    features.push({
      type: "Feature",
      properties: {
        startIndex,
        endIndex,
        speed: speedTotal / speedCount,
      },
      geometry: { type: "LineString", coordinates },
    });
  };

  for (let index = 1; index < session.t.length; index += 1) {
    if (session.breakBefore[index]) {
      flush();
      coordinates = [];
      activeBand = -1;
      speedTotal = 0;
      speedCount = 0;
      continue;
    }

    const segmentSpeed = (session.speed[index - 1] + session.speed[index]) / 2;
    const nextBand = speedBand(segmentSpeed);
    if (coordinates.length === 0 || nextBand !== activeBand) {
      flush();
      coordinates = [
        [session.lon[index - 1], session.lat[index - 1]],
        [session.lon[index], session.lat[index]],
      ];
      startIndex = index - 1;
      endIndex = index;
      activeBand = nextBand;
      speedTotal = segmentSpeed;
      speedCount = 1;
    } else {
      coordinates.push([session.lon[index], session.lat[index]]);
      endIndex = index;
      speedTotal += segmentSpeed;
      speedCount += 1;
    }
  }
  flush();

  return { type: "FeatureCollection", features };
}

function nearestRouteIndex(
  session: SessionData,
  startIndex: number,
  endIndex: number,
  longitude: number,
  latitude: number,
) {
  const start = Math.max(0, Math.min(startIndex, session.t.length - 1));
  const end = Math.max(start, Math.min(endIndex, session.t.length - 1));
  const longitudeScale = Math.cos((latitude * Math.PI) / 180);
  let nearest = start;
  let nearestDistance = Infinity;

  for (let index = start; index <= end; index += 1) {
    const deltaLongitude = (session.lon[index] - longitude) * longitudeScale;
    const deltaLatitude = session.lat[index] - latitude;
    const distance = deltaLongitude ** 2 + deltaLatitude ** 2;
    if (distance < nearestDistance) {
      nearest = index;
      nearestDistance = distance;
    }
  }

  return nearest;
}

function createGapGeoJson(
  session: SessionData,
): FeatureCollection<Point, { index: number; flags: number }> {
  const features: FeatureCollection<Point, { index: number; flags: number }>["features"] = session.t.flatMap((_, index) => {
    if (index === 0 || !session.breakBefore[index]) return [];
    return [
      {
        type: "Feature",
        properties: { index, flags: session.flags[index] },
        geometry: {
          type: "Point",
          coordinates: [session.lon[index], session.lat[index]],
        },
      },
    ];
  });
  return { type: "FeatureCollection", features };
}

function createMapStyle(): maplibregl.StyleSpecification {
  const flavorName = window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";

  return {
    version: 8,
    glyphs: "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf",
    sprite: `https://protomaps.github.io/basemaps-assets/sprites/v4/${flavorName}`,
    sources: {
      protomaps: {
        type: "vector",
        url: `pmtiles://${PROTOMAPS_ARCHIVE}`,
        attribution:
          '<a href="https://protomaps.com">Protomaps</a> © <a href="https://openstreetmap.org">OpenStreetMap</a>',
      },
    },
    layers: layers("protomaps", namedFlavor(flavorName), { lang: "en" }),
  };
}

function SessionMap({
  session,
  summary,
  cursorIndex,
  onCursorChange,
}: {
  session: SessionData;
  summary: SessionSummary;
  cursorIndex: number;
  onCursorChange: (index: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const loadedRef = useRef(false);
  const sessionRef = useRef(session);
  const onCursorChangeRef = useRef(onCursorChange);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    onCursorChangeRef.current = onCursorChange;
  }, [onCursorChange]);

  const updateSession = useCallback((map: MapLibreMap, nextSession: SessionData) => {
    (map.getSource("route-overview") as GeoJSONSource | undefined)?.setData(
      createRouteOverviewGeoJson(nextSession),
    );
    (map.getSource("route") as GeoJSONSource | undefined)?.setData(createRouteGeoJson(nextSession));
    (map.getSource("gaps") as GeoJSONSource | undefined)?.setData(createGapGeoJson(nextSession));
  }, []);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const protocol = new Protocol();
    maplibregl.addProtocol("pmtiles", protocol.tile);
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: createMapStyle(),
      center: [-111.04, 32.25],
      zoom: 8,
      attributionControl: false,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");

    map.on("load", () => {
      loadedRef.current = true;
      map.addSource("route-overview", {
        type: "geojson",
        data: EMPTY_GEOJSON,
        tolerance: 0,
      });
      map.addLayer({
        id: "route-overview-casing",
        type: "line",
        source: "route-overview",
        paint: {
          "line-color": "#fff8ed",
          "line-width": ["interpolate", ["linear"], ["zoom"], 2, 4.5, 7, 5.5, 15, 11],
          "line-opacity": 0.88,
        },
        layout: { "line-cap": "round", "line-join": "round" },
      });
      map.addLayer({
        id: "route-overview-line",
        type: "line",
        source: "route-overview",
        paint: {
          "line-color": "#102a35",
          "line-width": ["interpolate", ["linear"], ["zoom"], 2, 2.8, 7, 3.6, 15, 8],
          "line-opacity": 0.78,
        },
        layout: { "line-cap": "round", "line-join": "round" },
      });
      map.addSource("route", {
        type: "geojson",
        data: EMPTY_GEOJSON,
        tolerance: 0,
      });
      map.addLayer({
        id: "route-line",
        type: "line",
        source: "route",
        paint: {
          "line-color": [
            "interpolate",
            ["linear"],
            ["get", "speed"],
            0,
            "#0f766e",
            35,
            "#22a6a1",
            70,
            "#e3a326",
            105,
            "#e06b32",
            140,
            "#c83e4d",
          ],
          "line-width": ["interpolate", ["linear"], ["zoom"], 2, 1.4, 7, 2.1, 15, 5],
          "line-opacity": 0.96,
        },
        layout: { "line-cap": "round", "line-join": "round" },
      });
      map.addSource("gaps", { type: "geojson", data: EMPTY_GEOJSON });
      map.addLayer({
        id: "gap-points",
        type: "circle",
        source: "gaps",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 7, 2.5, 15, 5],
          "circle-color": "#c83e4d",
          "circle-stroke-color": "#fff8ed",
          "circle-stroke-width": 1.5,
        },
      });
      map.addSource("cursor", { type: "geojson", data: EMPTY_GEOJSON });
      map.addLayer({
        id: "cursor-halo",
        type: "circle",
        source: "cursor",
        paint: {
          "circle-radius": 13,
          "circle-color": "rgba(255, 248, 237, 0.65)",
          "circle-stroke-color": "#102a35",
          "circle-stroke-width": 1,
        },
      });
      map.addLayer({
        id: "cursor-dot",
        type: "circle",
        source: "cursor",
        paint: {
          "circle-radius": 6,
          "circle-color": "#102a35",
          "circle-stroke-color": "#fff8ed",
          "circle-stroke-width": 2,
        },
      });

      updateSession(map, sessionRef.current);
      const active = sessionRef.current;
      if (active.t.length > 0) {
        map.fitBounds(
          [
            [Math.min(...active.lon), Math.min(...active.lat)],
            [Math.max(...active.lon), Math.max(...active.lat)],
          ],
          { padding: 56, duration: 0, maxZoom: 15 },
        );
      }

      map.on("click", "route-line", (event) => {
        const properties = event.features?.[0]?.properties;
        const startIndex = Number(properties?.startIndex);
        const endIndex = Number(properties?.endIndex);
        if (Number.isFinite(startIndex) && Number.isFinite(endIndex)) {
          onCursorChangeRef.current(
            nearestRouteIndex(
              sessionRef.current,
              startIndex,
              endIndex,
              event.lngLat.lng,
              event.lngLat.lat,
            ),
          );
        }
      });
      map.on("mouseenter", "route-line", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "route-line", () => {
        map.getCanvas().style.cursor = "";
      });
    });

    return () => {
      loadedRef.current = false;
      map.remove();
      maplibregl.removeProtocol("pmtiles");
      mapRef.current = null;
    };
  }, [updateSession]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    updateSession(map, session);
    map.fitBounds(
      [
        [summary.bounds[0], summary.bounds[1]],
        [summary.bounds[2], summary.bounds[3]],
      ],
      { padding: 56, duration: 650, maxZoom: 15 },
    );
  }, [session, summary, updateSession]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current || !session.t.length) return;
    const index = Math.min(cursorIndex, session.t.length - 1);
    (map.getSource("cursor") as GeoJSONSource | undefined)?.setData({
      type: "Feature",
      properties: {},
      geometry: { type: "Point", coordinates: [session.lon[index], session.lat[index]] },
    });
  }, [cursorIndex, session]);

  return (
    <div className="map-wrap">
      <div
        ref={containerRef}
        className="map-canvas"
        role="img"
        aria-label={`第 ${summary.id} 次记录的行车路线地图`}
      />
      <div className="speed-legend" aria-label="路线速度图例">
        <span>0</span>
        <span className="speed-ramp" aria-hidden="true" />
        <span>140 km/h</span>
      </div>
    </div>
  );
}

function SessionChart({
  session,
  cursorIndex,
  onCursorChange,
  formatTime,
}: {
  session: SessionData;
  cursorIndex: number;
  onCursorChange: (index: number) => void;
  formatTime: (timestamp: number, includeDate?: boolean) => string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const onCursorChangeRef = useRef(onCursorChange);

  useEffect(() => {
    onCursorChangeRef.current = onCursorChange;
  }, [onCursorChange]);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = echarts.init(containerRef.current, undefined, { renderer: "canvas" });
    chartRef.current = chart;
    const resizeObserver = new ResizeObserver(() => chart.resize());
    resizeObserver.observe(containerRef.current);
    return () => {
      resizeObserver.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const styles = getComputedStyle(document.documentElement);
    const ink = styles.getPropertyValue("--ink").trim();
    const muted = styles.getPropertyValue("--muted-ink").trim();
    const border = styles.getPropertyValue("--line").trim();
    const surface = styles.getPropertyValue("--surface-solid").trim();
    const timestamps = session.t.map((value) => value * 1_000);
    const gapLines = session.breakBefore.flatMap((isBreak, index) => {
      if (!isBreak || index === 0) return [];
      return [{ xAxis: timestamps[index], label: { show: false } }];
    });

    chart.setOption(
      {
        animation: false,
        textStyle: { fontFamily: "var(--font-geist-sans)", color: ink },
        axisPointer: { link: [{ xAxisIndex: [0, 1] }] },
        tooltip: {
          trigger: "axis",
          confine: true,
          backgroundColor: surface,
          borderColor: border,
          textStyle: { color: ink },
          formatter: (params: unknown) => {
            const entries = Array.isArray(params) ? params : [];
            const first = entries[0] as { dataIndex?: number } | undefined;
            const index = first?.dataIndex ?? 0;
            return [
              `<strong>${formatTime(session.t[index], true)}</strong>`,
              `速度&nbsp;&nbsp;${session.speed[index].toFixed(1)} km/h`,
              `合成 G&nbsp;&nbsp;${session.g[index].toFixed(3)} g`,
            ].join("<br/>");
          },
        },
        grid: [
          { left: 58, right: 20, top: 20, height: 72 },
          { left: 58, right: 20, top: 122, height: 72 },
        ],
        xAxis: [
          {
            type: "time",
            gridIndex: 0,
            axisLabel: { show: false },
            axisLine: { lineStyle: { color: border } },
            axisTick: { show: false },
            splitLine: { show: false },
          },
          {
            type: "time",
            gridIndex: 1,
            axisLabel: {
              color: muted,
              formatter: (value: number) =>
                new Intl.DateTimeFormat("zh-CN", {
                  timeZone: "America/Phoenix",
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false,
                }).format(value),
            },
            axisLine: { lineStyle: { color: border } },
            axisTick: { show: false },
            splitLine: { show: false },
          },
        ],
        yAxis: [
          {
            type: "value",
            gridIndex: 0,
            name: "km/h",
            nameTextStyle: { color: muted },
            min: 0,
            axisLabel: { color: muted },
            axisLine: { show: false },
            axisTick: { show: false },
            splitLine: { lineStyle: { color: border, opacity: 0.65 } },
          },
          {
            type: "value",
            gridIndex: 1,
            name: "G",
            nameTextStyle: { color: muted },
            scale: true,
            axisLabel: { color: muted, formatter: (value: number) => value.toFixed(2) },
            axisLine: { show: false },
            axisTick: { show: false },
            splitLine: { lineStyle: { color: border, opacity: 0.65 } },
          },
        ],
        dataZoom: [
          { type: "inside", xAxisIndex: [0, 1], filterMode: "none" },
          {
            type: "slider",
            xAxisIndex: [0, 1],
            bottom: 0,
            height: 18,
            borderColor: border,
            fillerColor: "rgba(15, 118, 110, 0.16)",
            handleStyle: { color: "#0f766e", borderColor: "#0f766e" },
            textStyle: { color: muted },
            showDetail: false,
          },
        ],
        series: [
          {
            name: "速度",
            type: "line",
            xAxisIndex: 0,
            yAxisIndex: 0,
            data: timestamps.map((value, index) => [value, session.speed[index]]),
            showSymbol: false,
            lineStyle: { width: 2, color: "#0f8f86" },
            areaStyle: { color: "rgba(15, 143, 134, 0.10)" },
            markLine: {
              silent: true,
              symbol: "none",
              lineStyle: { color: "#c83e4d", width: 1, opacity: 0.55 },
              data: gapLines,
            },
          },
          {
            name: "合成 G",
            type: "line",
            xAxisIndex: 1,
            yAxisIndex: 1,
            data: timestamps.map((value, index) => [value, session.g[index]]),
            showSymbol: false,
            lineStyle: { width: 1.5, color: "#d17a2c" },
          },
        ],
      },
      true,
    );

    const updateCursor = (event: unknown) => {
      const axesInfo = (event as { axesInfo?: Array<{ value?: number }> }).axesInfo;
      const value = axesInfo?.[0]?.value;
      if (typeof value === "number") {
        onCursorChangeRef.current(nearestIndex(timestamps, value));
      }
    };
    chart.on("updateAxisPointer", updateCursor);
    return () => {
      chart.off("updateAxisPointer", updateCursor);
    };
  }, [formatTime, session]);

  useEffect(() => {
    chartRef.current?.dispatchAction({ type: "showTip", seriesIndex: 0, dataIndex: cursorIndex });
  }, [cursorIndex]);

  return (
    <div
      ref={containerRef}
      className="timeline-chart"
      role="img"
      aria-label="共享时间轴上的速度与合成 G 值曲线，可滚轮缩放"
    />
  );
}

export default function GpsLogExplorer() {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [session, setSession] = useState<SessionData | null>(null);
  const [cursorIndex, setCursorIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/data/manifest.json")
      .then((response) => {
        if (!response.ok) throw new Error("无法载入日志索引");
        return response.json() as Promise<Manifest>;
      })
      .then((nextManifest) => {
        setManifest(nextManifest);
        setSelectedId(nextManifest.sessions.at(-1)?.id ?? null);
      })
      .catch((reason: Error) => setError(reason.message));
  }, []);

  const selectedSummary = useMemo(
    () => manifest?.sessions.find((item) => item.id === selectedId) ?? null,
    [manifest, selectedId],
  );

  useEffect(() => {
    if (!selectedSummary) return;
    const controller = new AbortController();
    fetch(`/data/${selectedSummary.file}`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("无法载入所选行程");
        return response.json() as Promise<SessionData>;
      })
      .then((nextSession) => {
        setSession(nextSession);
        setCursorIndex(0);
      })
      .catch((reason: Error) => {
        if (reason.name !== "AbortError") setError(reason.message);
      });
    return () => controller.abort();
  }, [selectedSummary]);

  const formatTime = useCallback(
    (timestamp: number, includeDate = false) =>
      new Intl.DateTimeFormat("zh-CN", {
        timeZone: manifest?.timezone ?? "America/Phoenix",
        ...(includeDate ? { month: "short", day: "numeric" } : {}),
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(timestamp * 1_000),
    [manifest?.timezone],
  );

  const formatSessionDate = useCallback(
    (timestamp: number) =>
      new Intl.DateTimeFormat("zh-CN", {
        timeZone: manifest?.timezone ?? "America/Phoenix",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(timestamp * 1_000),
    [manifest?.timezone],
  );

  useEffect(() => {
    if (!isPlaying || !session) return;
    const timer = window.setInterval(() => {
      setCursorIndex((current) => {
        if (current >= session.t.length - 1) {
          setIsPlaying(false);
          return current;
        }
        const targetTime = session.t[current] + 3;
        return Math.max(current + 1, nearestIndex(session.t, targetTime));
      });
    }, 100);
    return () => window.clearInterval(timer);
  }, [isPlaying, session]);

  const selectedPosition = manifest?.sessions.findIndex((item) => item.id === selectedId) ?? -1;
  const currentVideo =
    session && session.t.length
      ? session.videos[session.videoIndex[Math.min(cursorIndex, session.t.length - 1)]]
      : "";

  const selectByOffset = (offset: number) => {
    if (!manifest || selectedPosition < 0) return;
    const next = manifest.sessions[selectedPosition + offset];
    if (next) {
      setIsPlaying(false);
      setSelectedId(next.id);
    }
  };

  if (error) {
    return (
      <main className="loading-state" role="alert">
        <TriangleAlert aria-hidden="true" />
        <h1>日志暂时无法显示</h1>
        <p>{error}</p>
      </main>
    );
  }

  if (!manifest || !selectedSummary || !session || session.id !== selectedSummary.id) {
    return (
      <main className="loading-state" role="status">
        <Satellite aria-hidden="true" />
        <h1>正在展开行车轨迹</h1>
        <p>读取并组织 GPS 会话…</p>
      </main>
    );
  }

  const activeIndex = Math.min(cursorIndex, session.t.length - 1);
  const activeFlags = session.flags[activeIndex];

  return (
    <main className="app-shell">
      <header className="masthead">
        <div>
          <p className="eyebrow">70MAI · GPS LOG ARCHIVE</p>
          <h1>行车轨迹档案</h1>
          <p className="masthead-copy">
            {manifest.totals.pointCount.toLocaleString("zh-CN")} 个定位点，跨越 {manifest.totals.sessionCount} 次记录。
          </p>
        </div>
        <div className="masthead-aside">
          <AppNav active="route" />
          <div className="archive-range">
            <Satellite aria-hidden="true" />
            <span>{formatSessionDate(manifest.totals.startTime).slice(0, 10)}</span>
            <span aria-hidden="true">—</span>
            <span>{formatSessionDate(manifest.totals.endTime).slice(0, 10)}</span>
            <small>Phoenix 时间</small>
          </div>
        </div>
      </header>

      <section className="session-toolbar" aria-label="行程选择">
        <button
          className="icon-button"
          type="button"
          aria-label="上一段记录"
          onClick={() => selectByOffset(-1)}
          disabled={selectedPosition <= 0}
        >
          <ChevronLeft aria-hidden="true" />
        </button>
        <label className="session-select-label">
          <span>当前记录</span>
          <select
            value={selectedId ?? ""}
            onChange={(event) => {
              setIsPlaying(false);
              setSelectedId(Number(event.target.value));
            }}
          >
            {[...manifest.sessions].reverse().map((item) => (
              <option key={item.id} value={item.id}>
                #{String(item.id).padStart(3, "0")} · {formatSessionDate(item.startTime)} · {formatDuration(item.durationSeconds, true)}
              </option>
            ))}
          </select>
        </label>
        <button
          className="icon-button"
          type="button"
          aria-label="下一段记录"
          onClick={() => selectByOffset(1)}
          disabled={selectedPosition >= manifest.sessions.length - 1}
        >
          <ChevronRight aria-hidden="true" />
        </button>
        <div className="session-health">
          {selectedSummary.gaps > 0 ? (
            <>
              <TriangleAlert aria-hidden="true" />
              <span>{selectedSummary.gaps} 处数据间断</span>
            </>
          ) : (
            <>
              <Satellite aria-hidden="true" />
              <span>轨迹连续</span>
            </>
          )}
        </div>
      </section>

      <section className="summary-grid" aria-label="当前行程摘要">
        <article className="summary-item">
          <Route aria-hidden="true" />
          <div>
            <span>估算里程</span>
            <strong>{formatDistance(selectedSummary.distanceMeters)}</strong>
          </div>
        </article>
        <article className="summary-item">
          <Clock3 aria-hidden="true" />
          <div>
            <span>记录时长</span>
            <strong>{formatDuration(selectedSummary.durationSeconds)}</strong>
          </div>
        </article>
        <article className="summary-item">
          <Gauge aria-hidden="true" />
          <div>
            <span>最高速度</span>
            <strong>{selectedSummary.maxSpeedKmh.toFixed(1)} km/h</strong>
          </div>
        </article>
      </section>

      <section className="route-section" aria-label="行程地图">
        <SessionMap
          session={session}
          summary={selectedSummary}
          cursorIndex={activeIndex}
          onCursorChange={setCursorIndex}
        />
        <div className="cursor-readout" aria-live="polite">
          <div className="cursor-time">
            <MapPin aria-hidden="true" />
            <span>{formatTime(session.t[activeIndex], true)}</span>
          </div>
          <strong>{session.speed[activeIndex].toFixed(1)} <small>km/h</small></strong>
          <span>航向 {session.heading[activeIndex].toFixed(0)}°</span>
        </div>
      </section>

      <section className="telemetry-section" aria-label="行程遥测时间轴">
        <div className="telemetry-heading">
          <div>
            <p className="section-kicker">TELEMETRY</p>
            <h2>速度与合成 G</h2>
          </div>
          <button
            className="play-button"
            type="button"
            onClick={() => {
              if (activeIndex >= session.t.length - 1) setCursorIndex(0);
              setIsPlaying((playing) => !playing);
            }}
          >
            {isPlaying ? <CirclePause aria-hidden="true" /> : <CirclePlay aria-hidden="true" />}
            {isPlaying ? "暂停" : "轨迹回放"}
          </button>
        </div>
        <SessionChart
          session={session}
          cursorIndex={activeIndex}
          onCursorChange={setCursorIndex}
          formatTime={formatTime}
        />
        <label className="scrubber-label">
          <span>{formatTime(session.t[0])}</span>
          <input
            type="range"
            min="0"
            max={session.t.length - 1}
            value={activeIndex}
            onChange={(event) => {
              setIsPlaying(false);
              setCursorIndex(Number(event.target.value));
            }}
            aria-label="行程时间游标"
          />
          <span>{formatTime(session.t.at(-1) ?? session.t[0])}</span>
        </label>
        <div className="sample-detail">
          <span>{formatTime(session.t[activeIndex], true)}</span>
          <span>G {session.g[activeIndex].toFixed(3)}</span>
          <span>传感器 {session.sensorX[activeIndex]} / {session.sensorY[activeIndex]} / {session.sensorZ[activeIndex]}</span>
          <span className="clip-name">{currentVideo}</span>
          {activeFlags > 0 && <span className="anomaly-badge">数据边界</span>}
        </div>
      </section>

      <footer className="page-footer">
        <span>源文件：{manifest.source}</span>
        <span>
          时间按视频文件名校准：原始 Unix 值
          {manifest.rawTimestampCorrectionSeconds >= 0 ? " +" : " "}
          {manifest.rawTimestampCorrectionSeconds / 3_600} 小时，以 Phoenix 时间显示。
        </span>
        <span>红色节点表示 GPS 间断或时间异常；这些位置不会被直线连接。</span>
      </footer>
    </main>
  );
}
