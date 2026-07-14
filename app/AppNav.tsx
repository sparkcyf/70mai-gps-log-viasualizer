import { ChartNoAxesColumnIncreasing, Map } from "lucide-react";
import Link from "next/link";

export default function AppNav({ active }: { active: "route" | "stats" }) {
  return (
    <nav className="page-switch" aria-label="页面导航">
      <Link
        href="/"
        className={active === "route" ? "is-active" : undefined}
        aria-current={active === "route" ? "page" : undefined}
      >
        <Map aria-hidden="true" />
        轨迹
      </Link>
      <Link
        href="/stats"
        className={active === "stats" ? "is-active" : undefined}
        aria-current={active === "stats" ? "page" : undefined}
      >
        <ChartNoAxesColumnIncreasing aria-hidden="true" />
        统计
      </Link>
    </nav>
  );
}
