"""30-day-aggregated, day-of-year Q90 low-flow thresholds.

For every station with a screened 1940-2026 record (`pass_1940` in
02_alabama_record_completeness.csv - <10% missing since 1940), this builds a
calendar-day threshold table used by the Live Analysis tab to flag
below-normal streamflow days.

Method (exactly as specified - aggregate first, then take the percentile of
the aggregated values, then compare like-for-like):

  1. Daily mean discharge Q_t (already what the raw USGS CSVs contain).
  2. Trailing 30-day mean: Q30_t = mean(Q_{t-29}, ..., Q_t). A day only gets
     a Q30 value once 30 full prior days exist (no partial-window values).
  3. Group Q30_t by calendar day (month-day, so leap years don't shift the
     grouping) across every year in the reference period (1940 -> the
     station's last observation).
  4. Q90 = 90% exceedance = flow equaled or exceeded 90% of the time. Under
     numpy's standard ascending/non-exceedance percentile convention that is
     the 10th percentile: `numpy.quantile(group_values, 0.10)`.

This produces one threshold per calendar day (Q90_30(day-of-year)). A
*current* observation is only ever compared against this after being
aggregated the same way - its own trailing 30-day mean, `Q30_current` -
never a raw daily value. `Q30_current < Q90_30(current day)` means "below
Q90 / low-flow condition"; persistence rules (e.g. N consecutive days below)
are a separate, later step, not part of this threshold calculation.

Run with `uv run python compute_q90_thresholds.py`.
"""

from __future__ import annotations

import json

import numpy as np
import pandas as pd

import config

REFERENCE_START = "1940-01-01"
TRAILING_WINDOW = 30
Q90_QUANTILE = 0.10  # 90% exceedance == 10th percentile, non-exceedance convention


def load_daily_series(station: str) -> pd.Series:
    path = config.ALABAMA_RAW_DIR / f"{station}.csv"
    daily = pd.read_csv(path, usecols=["date", "value"], parse_dates=["date"])
    daily = daily.groupby("date")["value"].mean()  # collapse any duplicate same-day rows
    return daily.sort_index()


def q90_table_for_station(station: str, record_end: str) -> dict:
    raw = load_daily_series(station)

    full_index = pd.date_range(REFERENCE_START, record_end, freq="D")
    q_t = raw.reindex(full_index)  # NaN on missing days, not interpolated

    q30 = q_t.rolling(window=TRAILING_WINDOW, min_periods=TRAILING_WINDOW).mean()
    month_day = q30.index.strftime("%m-%d")

    thresholds = {}
    sample_counts = {}
    for md, values in q30.groupby(month_day):
        clean = values.dropna()
        if clean.empty:
            continue
        thresholds[md] = round(float(np.quantile(clean.to_numpy(), Q90_QUANTILE)), 3)
        sample_counts[md] = int(clean.shape[0])

    return {
        "station": station,
        "reference_period_start": REFERENCE_START,
        "reference_period_end": record_end,
        "trailing_window_days": TRAILING_WINDOW,
        "quantile_used": Q90_QUANTILE,
        "n_calendar_days_with_threshold": len(thresholds),
        "thresholds_cfs": thresholds,
        "sample_counts": sample_counts,
    }


def main() -> None:
    completeness = pd.read_csv(config.RECORD_COMPLETENESS_CSV, dtype={"station": str})
    qualifying = completeness[completeness["pass_1940"] == True]  # noqa: E712

    out_dir = config.Q90_THRESHOLDS_DIR
    out_dir.mkdir(parents=True, exist_ok=True)

    manifest = []
    for row in qualifying.itertuples():
        print(f"Computing Q90 thresholds for {row.station} ({row.record_start} -> {row.record_end}) ...")
        table = q90_table_for_station(row.station, row.record_end)
        (out_dir / f"{row.station}.json").write_text(json.dumps(table))
        manifest.append({
            "station": row.station,
            "reference_period_start": REFERENCE_START,
            "reference_period_end": row.record_end,
            "pct_missing_since_1940": row.pct_missing_1940,
        })

    (config.PROCESSED_DIR / "q90_thresholds.json").write_text(json.dumps({
        "method": "30-day trailing mean, day-of-year 10th percentile (Q90 by exceedance convention)",
        "trailing_window_days": TRAILING_WINDOW,
        "quantile_used": Q90_QUANTILE,
        "stations": manifest,
    }))
    print(f"Done -> {out_dir} ({len(manifest)} stations)")


if __name__ == "__main__":
    main()
