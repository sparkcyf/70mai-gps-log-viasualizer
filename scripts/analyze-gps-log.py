#!/usr/bin/env python3
"""Create a location-free structural profile of a 70mai GPS log."""

from __future__ import annotations

import argparse
import csv
from collections import Counter
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", nargs="?", default="../GPSData000001.txt")
    parser.add_argument(
        "--output",
        default="docs/images/gps-log-format-profile.png",
    )
    return parser.parse_args()


def read_profile(path: Path) -> dict[str, object]:
    statuses: Counter[str] = Counter()
    intervals: Counter[str] = Counter()
    speeds: list[float] = []
    g_magnitudes: list[float] = []
    session_count = 0
    previous_timestamp: int | None = None

    with path.open("r", encoding="utf-8", newline="") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line:
                continue
            if line.startswith("$"):
                session_count += 1
                previous_timestamp = None
                continue

            fields = next(csv.reader([line], skipinitialspace=True))
            if len(fields) != 13:
                statuses["malformed"] += 1
                previous_timestamp = None
                continue

            status = fields[1]
            statuses[status] += 1
            if status != "A":
                previous_timestamp = None
                continue

            timestamp = int(fields[0])
            if previous_timestamp is not None:
                delta = timestamp - previous_timestamp
                key = f"{delta}s" if 1 <= delta <= 5 else "irregular"
                intervals[key] += 1
            previous_timestamp = timestamp

            speeds.append(float(fields[5]) * 0.036)
            sensor = np.asarray([float(fields[6]), float(fields[7]), float(fields[8])])
            g_magnitudes.append(float(np.linalg.norm(sensor) / 100))

    return {
        "sessions": session_count,
        "statuses": statuses,
        "intervals": intervals,
        "speeds": np.asarray(speeds),
        "g_magnitudes": np.asarray(g_magnitudes),
    }


def add_bar_labels(axis: plt.Axes, bars: object) -> None:
    for bar in bars:
        value = int(bar.get_height())
        axis.annotate(
            f"{value:,}",
            (bar.get_x() + bar.get_width() / 2, value),
            xytext=(0, 4),
            textcoords="offset points",
            ha="center",
            va="bottom",
            fontsize=8,
        )


def render(profile: dict[str, object], output: Path) -> None:
    teal = "#0f766e"
    cyan = "#22a6a1"
    amber = "#d88a27"
    red = "#c83e4d"
    ink = "#17262e"
    grid = "#d8dfdd"

    plt.rcParams.update(
        {
            "font.family": "DejaVu Sans",
            "axes.edgecolor": grid,
            "axes.labelcolor": ink,
            "axes.titlecolor": ink,
            "xtick.color": ink,
            "ytick.color": ink,
        }
    )
    figure, axes = plt.subplots(2, 2, figsize=(12, 8), constrained_layout=True)
    figure.patch.set_facecolor("#f7f6f2")
    for axis in axes.flat:
        axis.set_facecolor("#f7f6f2")
        axis.grid(axis="y", color=grid, linewidth=0.7, alpha=0.8)
        axis.set_axisbelow(True)
        axis.spines[["top", "right"]].set_visible(False)

    statuses: Counter[str] = profile["statuses"]
    structure_labels = ["Session markers", "Valid fixes (A)", "Invalid fixes (V)"]
    structure_values = [profile["sessions"], statuses["A"], statuses["V"]]
    bars = axes[0, 0].bar(structure_labels, structure_values, color=[amber, teal, red])
    axes[0, 0].set_yscale("log")
    axes[0, 0].set_ylabel("Records (log scale)")
    axes[0, 0].set_title("File structure and record status")
    axes[0, 0].tick_params(axis="x", rotation=12)
    add_bar_labels(axes[0, 0], bars)

    intervals: Counter[str] = profile["intervals"]
    interval_keys = ["1s", "2s", "3s", "4s", "5s", "irregular"]
    interval_labels = ["1 s", "2 s", "3 s", "4 s", "5 s", ">5 s / irregular"]
    interval_values = [intervals[key] for key in interval_keys]
    bars = axes[0, 1].bar(interval_labels, interval_values, color=cyan)
    axes[0, 1].set_yscale("log")
    axes[0, 1].set_ylabel("Consecutive valid pairs (log scale)")
    axes[0, 1].set_title("Sampling interval distribution")
    axes[0, 1].tick_params(axis="x", rotation=18)
    add_bar_labels(axes[0, 1], bars)

    speeds: np.ndarray = profile["speeds"]
    speed_bins = np.arange(0, max(145, np.ceil(speeds.max() / 5) * 5 + 5), 5)
    axes[1, 0].hist(
        speeds,
        bins=speed_bins,
        weights=np.full(speeds.shape, 100 / speeds.size),
        color=teal,
        edgecolor="#f7f6f2",
        linewidth=0.4,
    )
    median_speed = float(np.percentile(speeds, 50))
    p95_speed = float(np.percentile(speeds, 95))
    axes[1, 0].axvline(median_speed, color=amber, linewidth=1.5, label=f"Median {median_speed:.1f}")
    axes[1, 0].axvline(p95_speed, color=red, linewidth=1.5, label=f"P95 {p95_speed:.1f}")
    axes[1, 0].set_xlabel("Speed (km/h)")
    axes[1, 0].set_ylabel("Share of valid fixes (%)")
    axes[1, 0].set_title("Speed distribution")
    axes[1, 0].legend(frameon=False, fontsize=8)

    g_magnitudes: np.ndarray = profile["g_magnitudes"]
    axes[1, 1].hist(
        g_magnitudes,
        bins=np.linspace(0.35, 2.05, 52),
        weights=np.full(g_magnitudes.shape, 100 / g_magnitudes.size),
        color=amber,
        edgecolor="#f7f6f2",
        linewidth=0.4,
    )
    axes[1, 1].axvline(1.0, color=teal, linewidth=1.5, label="1.0 g reference")
    axes[1, 1].set_xlabel("Vector magnitude (g, inferred scale)")
    axes[1, 1].set_ylabel("Share of valid fixes (%)")
    axes[1, 1].set_title("G-sensor magnitude distribution")
    axes[1, 1].legend(frameon=False, fontsize=8)

    figure.suptitle("GPS Log Structural Profile (Location-Free)", fontsize=16, color=ink)
    figure.text(
        0.5,
        -0.015,
        "Coordinates are intentionally excluded; geographic context is limited to Arizona.",
        ha="center",
        color=ink,
        fontsize=9,
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(output, dpi=180, bbox_inches="tight", facecolor=figure.get_facecolor())
    plt.close(figure)


def main() -> None:
    args = parse_args()
    render(read_profile(Path(args.input)), Path(args.output))


if __name__ == "__main__":
    main()
