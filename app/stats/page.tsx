import type { Metadata } from "next";
import LogStatistics from "../LogStatistics";

export const metadata: Metadata = {
  title: "全量驾驶统计 · 行车轨迹档案",
  description: "查看整份 70mai GPS 日志的速度分布、累计里程与驾驶节律。",
};

export default function StatisticsPage() {
  return <LogStatistics />;
}
