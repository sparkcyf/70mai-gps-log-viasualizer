"use client";

import { BarChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import {
  CalendarDays,
  Gauge,
  Moon,
  Route,
  Satellite,
  TimerReset,
  Trophy,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import AppNav from "./AppNav";

echarts.use([BarChart, GridComponent, TooltipComponent, CanvasRenderer]);

type SpeedBin = {
  label: string;
  minSpeedKmh: number;
  maxSpeedKmh: number | null;
  distanceMeters: number;
  durationSeconds: number;
  distanceShare: number;
};

type Statistics = {
  formatVersion: number;
  source: string;
  timezone: string;
  totals: {
    distanceMeters: number;
    trackedSeconds: number;
    movingAverageSpeedKmh: number;
    stationarySeconds: number;
    highSpeedDistanceMeters: number;
    highSpeedDistanceShare: number;
    nightDistanceMeters: number;
    nightDistanceShare: number;
    speedP50Kmh: number;
    speedP85Kmh: number;
    speedP95Kmh: number;
    speedP99Kmh: number;
  };
  speedBins: SpeedBin[];
  hourlyDistanceMeters: Array<{ hour: number; distanceMeters: number }>;
  monthlyDistanceMeters: Array<{ month: string; distanceMeters: number }>;
  longestSession: { id: number; distanceMeters: number; startTime: number };
  mostActiveDay: { date: string; distanceMeters: number };
};

type ChartColors = {
  ink: string;
  muted: string;
  line: string;
  surface: string;
  primary: string;
  accent: string;
};

function formatDistance(meters: number, digits = 1) {
  return `${(meters / 1_000).toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })} km`;
}

function formatDuration(seconds: number) {
  const hours = seconds / 3_600;
  if (hours >= 10) return `${hours.toFixed(1)} 小时`;
  const wholeHours = Math.floor(hours);
  const minutes = Math.round((hours - wholeHours) * 60);
  return wholeHours > 0 ? `${wholeHours} 小时 ${minutes} 分` : `${minutes} 分`;
}

function formatDate(date: string) {
  const [year, month, day] = date.split("-");
  return `${year}年${Number(month)}月${Number(day)}日`;
}

function DataChart({
  className,
  ariaLabel,
  buildOption,
}: {
  className: string;
  ariaLabel: string;
  buildOption: (colors: ChartColors) => echarts.EChartsCoreOption;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const styles = getComputedStyle(document.documentElement);
    const colors: ChartColors = {
      ink: styles.getPropertyValue("--ink").trim(),
      muted: styles.getPropertyValue("--muted-ink").trim(),
      line: styles.getPropertyValue("--line").trim(),
      surface: styles.getPropertyValue("--surface-solid").trim(),
      primary: styles.getPropertyValue("--primary").trim(),
      accent: styles.getPropertyValue("--accent").trim(),
    };
    const chart = echarts.init(containerRef.current, undefined, { renderer: "canvas" });
    const option = buildOption(colors);
    const tooltip = (option.tooltip ?? {}) as Record<string, unknown>;
    chart.setOption({
      ...option,
      animation: false,
      textStyle: { fontFamily: "var(--font-geist-sans)", color: colors.ink },
      tooltip: {
        trigger: "axis",
        confine: true,
        backgroundColor: colors.surface,
        borderColor: colors.line,
        textStyle: { color: colors.ink },
        ...tooltip,
      },
    });

    const resizeObserver = new ResizeObserver(() => chart.resize());
    resizeObserver.observe(containerRef.current);
    return () => {
      resizeObserver.disconnect();
      chart.dispose();
    };
  }, [buildOption]);

  return <div ref={containerRef} className={className} role="img" aria-label={ariaLabel} />;
}

function SpeedDistributionChart({ bins }: { bins: SpeedBin[] }) {
  const buildOption = useCallback(
    (colors: ChartColors): echarts.EChartsCoreOption => ({
      grid: { left: 58, right: 18, top: 36, bottom: 58 },
      xAxis: {
        type: "category",
        data: bins.map((bin) => bin.label),
        axisLabel: { color: colors.muted, interval: 0, rotate: 42 },
        axisLine: { lineStyle: { color: colors.line } },
        axisTick: { show: false },
      },
      yAxis: {
        type: "value",
        name: "里程 / km",
        nameTextStyle: { color: colors.muted },
        axisLabel: { color: colors.muted },
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: colors.line } },
      },
      tooltip: {
        formatter: (params: unknown) => {
          const item = Array.isArray(params)
            ? (params[0] as { dataIndex?: number } | undefined)
            : undefined;
          const bin = bins[item?.dataIndex ?? 0];
          return [
            `<strong>${bin.label} km/h</strong>`,
            `里程&nbsp;&nbsp;${formatDistance(bin.distanceMeters)}`,
            `占总里程&nbsp;&nbsp;${(bin.distanceShare * 100).toFixed(1)}%`,
            `记录时长&nbsp;&nbsp;${formatDuration(bin.durationSeconds)}`,
          ].join("<br/>");
        },
      },
      series: [
        {
          type: "bar",
          barMaxWidth: 38,
          data: bins.map((bin, index) => ({
            value: Number((bin.distanceMeters / 1_000).toFixed(1)),
            itemStyle: {
              color: ["#0f766e", "#22a6a1", "#e3a326", "#e06b32", "#c83e4d"][
                Math.min(4, Math.floor(index / 3))
              ],
              borderRadius: [5, 5, 0, 0],
            },
          })),
          label: {
            show: true,
            position: "top",
            color: colors.muted,
            formatter: (params: unknown) => {
              const index = (params as { dataIndex?: number }).dataIndex ?? 0;
              return `${(bins[index].distanceShare * 100).toFixed(0)}%`;
            },
          },
        },
      ],
    }),
    [bins],
  );

  return (
    <DataChart
      className="stats-chart stats-chart-primary"
      ariaLabel="每十公里时速区间对应的累计行驶里程柱状图"
      buildOption={buildOption}
    />
  );
}

function HourlyDistanceChart({ data }: { data: Statistics["hourlyDistanceMeters"] }) {
  const buildOption = useCallback(
    (colors: ChartColors): echarts.EChartsCoreOption => ({
      grid: { left: 52, right: 12, top: 24, bottom: 38 },
      xAxis: {
        type: "category",
        data: data.map((item) => item.hour),
        axisLabel: {
          color: colors.muted,
          interval: 0,
          formatter: (value: number, index: number) => (index % 3 === 0 ? `${value}:00` : ""),
        },
        axisLine: { lineStyle: { color: colors.line } },
        axisTick: { show: false },
      },
      yAxis: {
        type: "value",
        name: "km",
        nameTextStyle: { color: colors.muted },
        axisLabel: { color: colors.muted },
        splitLine: { lineStyle: { color: colors.line } },
      },
      tooltip: {
        formatter: (params: unknown) => {
          const item = Array.isArray(params)
            ? (params[0] as { dataIndex?: number } | undefined)
            : undefined;
          const hour = data[item?.dataIndex ?? 0];
          return `<strong>${String(hour.hour).padStart(2, "0")}:00–${String(
            (hour.hour + 1) % 24,
          ).padStart(2, "0")}:00</strong><br/>里程&nbsp;&nbsp;${formatDistance(hour.distanceMeters)}`;
        },
      },
      series: [
        {
          type: "bar",
          barMaxWidth: 18,
          itemStyle: { color: colors.primary, borderRadius: [4, 4, 0, 0] },
          data: data.map((item) => Number((item.distanceMeters / 1_000).toFixed(1))),
        },
      ],
    }),
    [data],
  );

  return (
    <DataChart
      className="stats-chart stats-chart-secondary"
      ariaLabel="Phoenix 时间一天二十四小时内的累计行驶里程柱状图"
      buildOption={buildOption}
    />
  );
}

function MonthlyDistanceChart({ data }: { data: Statistics["monthlyDistanceMeters"] }) {
  const buildOption = useCallback(
    (colors: ChartColors): echarts.EChartsCoreOption => ({
      grid: { left: 52, right: 12, top: 24, bottom: 38 },
      xAxis: {
        type: "category",
        data: data.map((item) => `${Number(item.month.slice(5))}月`),
        axisLabel: { color: colors.muted },
        axisLine: { lineStyle: { color: colors.line } },
        axisTick: { show: false },
      },
      yAxis: {
        type: "value",
        name: "km",
        nameTextStyle: { color: colors.muted },
        axisLabel: { color: colors.muted },
        splitLine: { lineStyle: { color: colors.line } },
      },
      tooltip: {
        formatter: (params: unknown) => {
          const item = Array.isArray(params)
            ? (params[0] as { dataIndex?: number } | undefined)
            : undefined;
          const month = data[item?.dataIndex ?? 0];
          return `<strong>${month.month}</strong><br/>里程&nbsp;&nbsp;${formatDistance(month.distanceMeters)}`;
        },
      },
      series: [
        {
          type: "bar",
          barMaxWidth: 46,
          itemStyle: { color: colors.accent, borderRadius: [5, 5, 0, 0] },
          data: data.map((item) => Number((item.distanceMeters / 1_000).toFixed(1))),
        },
      ],
    }),
    [data],
  );

  return (
    <DataChart
      className="stats-chart stats-chart-secondary"
      ariaLabel="日志覆盖月份的累计行驶里程柱状图"
      buildOption={buildOption}
    />
  );
}

export default function LogStatistics() {
  const [statistics, setStatistics] = useState<Statistics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/data/statistics.json")
      .then((response) => {
        if (!response.ok) throw new Error("无法载入统计数据");
        return response.json() as Promise<Statistics>;
      })
      .then(setStatistics)
      .catch((reason: Error) => setError(reason.message));
  }, []);

  if (error) {
    return (
      <main className="loading-state" role="alert">
        <Satellite aria-hidden="true" />
        <h1>统计页面暂时无法显示</h1>
        <p>{error}</p>
      </main>
    );
  }

  if (!statistics) {
    return (
      <main className="loading-state" role="status">
        <Satellite aria-hidden="true" />
        <h1>正在汇总整份日志</h1>
        <p>计算速度分布与驾驶节律…</p>
      </main>
    );
  }

  const peakBin = statistics.speedBins.reduce((best, bin) =>
    bin.distanceMeters > best.distanceMeters ? bin : best,
  );

  return (
    <main className="app-shell stats-shell">
      <header className="masthead stats-masthead">
        <div>
          <p className="eyebrow">70MAI · LOG STATISTICS</p>
          <h1>全量驾驶统计</h1>
          <p className="masthead-copy">
            从整份日志聚合里程、速度分布和 Phoenix 时间下的驾驶节律。
          </p>
        </div>
        <div className="masthead-aside">
          <AppNav active="stats" />
          <span className="stats-source">{statistics.source}</span>
        </div>
      </header>

      <section className="stats-summary-grid" aria-label="全量统计摘要">
        <article className="stats-summary-item">
          <Route aria-hidden="true" />
          <span>累计估算里程</span>
          <strong>{formatDistance(statistics.totals.distanceMeters)}</strong>
          <small>{formatDuration(statistics.totals.trackedSeconds)}连续有效记录</small>
        </article>
        <article className="stats-summary-item">
          <Gauge aria-hidden="true" />
          <span>移动平均速度</span>
          <strong>{statistics.totals.movingAverageSpeedKmh.toFixed(1)} km/h</strong>
          <small>仅统计速度不低于 5 km/h 的区间</small>
        </article>
        <article className="stats-summary-item">
          <Trophy aria-hidden="true" />
          <span>最长单次记录</span>
          <strong>{formatDistance(statistics.longestSession.distanceMeters)}</strong>
          <small>记录 #{String(statistics.longestSession.id).padStart(3, "0")}</small>
        </article>
        <article className="stats-summary-item">
          <Moon aria-hidden="true" />
          <span>夜间里程占比</span>
          <strong>{(statistics.totals.nightDistanceShare * 100).toFixed(1)}%</strong>
          <small>20:00–06:00 · {formatDistance(statistics.totals.nightDistanceMeters)}</small>
        </article>
      </section>

      <section className="stats-panel stats-primary-panel" aria-labelledby="speed-distribution-title">
        <div className="stats-section-heading">
          <div>
            <p className="section-kicker">SPEED DISTRIBUTION</p>
            <h2 id="speed-distribution-title">速度区间对应里程</h2>
          </div>
          <p>
            里程峰值位于 <strong>{peakBin.label} km/h</strong>，占总里程的{" "}
            <strong>{(peakBin.distanceShare * 100).toFixed(1)}%</strong>。
          </p>
        </div>
        <SpeedDistributionChart bins={statistics.speedBins} />
      </section>

      <section className="stats-detail-grid" aria-label="驾驶节律">
        <article className="stats-panel">
          <div className="stats-section-heading compact">
            <div>
              <p className="section-kicker">TIME OF DAY</p>
              <h2>一天中的驾驶节律</h2>
            </div>
          </div>
          <HourlyDistanceChart data={statistics.hourlyDistanceMeters} />
        </article>
        <article className="stats-panel">
          <div className="stats-section-heading compact">
            <div>
              <p className="section-kicker">MONTHLY DISTANCE</p>
              <h2>每月累计里程</h2>
            </div>
          </div>
          <MonthlyDistanceChart data={statistics.monthlyDistanceMeters} />
        </article>
      </section>

      <section className="stats-insights" aria-labelledby="insights-title">
        <div className="stats-insights-heading">
          <p className="section-kicker">OBSERVATIONS</p>
          <h2 id="insights-title">日志里的几个侧面</h2>
        </div>
        <div className="stats-insight-list">
          <article>
            <CalendarDays aria-hidden="true" />
            <span>单日里程最多</span>
            <strong>{formatDate(statistics.mostActiveDay.date)}</strong>
            <small>{formatDistance(statistics.mostActiveDay.distanceMeters)}</small>
          </article>
          <article>
            <Zap aria-hidden="true" />
            <span>100 km/h 以上里程</span>
            <strong>{(statistics.totals.highSpeedDistanceShare * 100).toFixed(1)}%</strong>
            <small>{formatDistance(statistics.totals.highSpeedDistanceMeters)}</small>
          </article>
          <article>
            <TimerReset aria-hidden="true" />
            <span>接近静止的记录时间</span>
            <strong>{formatDuration(statistics.totals.stationarySeconds)}</strong>
            <small>区间平均速度低于 1 km/h</small>
          </article>
          <article>
            <Gauge aria-hidden="true" />
            <span>定位点速度 P95</span>
            <strong>{statistics.totals.speedP95Kmh.toFixed(1)} km/h</strong>
            <small>95% 的有效定位点不高于此速度</small>
          </article>
        </div>
      </section>

      <footer className="page-footer stats-footer">
        <span>里程按相邻有效 GPS 点估算，速度区间使用每段两端速度的平均值。</span>
        <span>时间分布按 Phoenix 当地时间统计。</span>
      </footer>
    </main>
  );
}
