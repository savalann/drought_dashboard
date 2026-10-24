"""Pre-computed day-by-day Q90 drought status, so the Live Status tab can
show any monitored past day instantly (read one small JSON file) instead of
re-deriving it live in the browser every time.

For each pass_1940 station, this applies the SAME 30-day trailing mean +
Q90 comparison as compute_q90_thresholds.py (run that first - this reads
its output) across every day from MONITORING_PERIOD_START through the
station's last observation, and writes one file per calendar year with
every station's status for that year:

  02.input/processed/drought_status_history/<YYYY>.json
    { "year": YYYY, "dates": [...], "stations": { "<station>": { "q30_cfs": [...], "is_below_q90": [...] } } }

`dates`/`q30_cfs`/`is_below_q90` are parallel arrays (shared `dates` across
every station, since they're daily calendar series) - `null` where a
station has no value that day (record not started yet, or a data gap wide
enough that the 30-day window isn't full).

The manifest (`drought_status_history.json`) records, per station, the last
date this covers - the Live Status tab's cutoff between "read the
pre-computed file" and "fetch today's gap live from USGS".

Run with `uv run python build_drought_status_history.py` (after
compute_q90_thresholds.py).
"""

from __future__ import annotations

import json
from collections import defaultdict

import pandas as pd

import config

TRAILING_WINDOW = 30


def load_daily_series(station: str) -> pd.Series:
    path = config.ALABAMA_RAW_DIR / f"{station}.csv"
    daily = pd.read_csv(path, usecols=["date", "value"], parse_dates=["date"])
    daily = daily.groupby("date")["value"].mean()
    return daily.sort_index()


def station_status_series(station: str, record_end: str, thresholds_cfs: dict) -> pd.DataFrame:
    raw = load_daily_series(station)

    # Seed the rolling window TRAILING_WINDOW-1 days before the monitoring
    # period starts, so day 1 of the output already has a full 30-day mean.
    seed_start = pd.Timestamp(config.MONITORING_PERIOD_START) - pd.Timedelta(days=TRAILING_WINDOW - 1)
    full_index = pd.date_range(seed_start, record_end, freq="D")
    q_t = raw.reindex(full_index)
    q30 = q_t.rolling(window=TRAILING_WINDOW, min_periods=TRAILING_WINDOW).mean()

    q30 = q30.loc[config.MONITORING_PERIOD_START:]
    month_day = q30.index.strftime("%m-%d")
    threshold = month_day.map(thresholds_cfs).astype(float)

    is_below = pd.Series(pd.NA, index=q30.index, dtype="boolean")
    comparable = q30.notna() & threshold.notna()
    is_below[comparable] = (q30[comparable] < threshold[comparable].to_numpy())

    return pd.DataFrame({"q30_cfs": q30, "is_below_q90": is_below})


def main() -> None:
    completeness = pd.read_csv(config.RECORD_COMPLETENESS_CSV, dtype={"station": str})
    stations = completeness[completeness["pass_1940"] == True]  # noqa: E712

    per_station_series = {}
    last_dates = {}
    for row in stations.itertuples():
        threshold_path = config.Q90_THRESHOLDS_DIR / f"{row.station}.json"
        if not threshold_path.exists():
            print(f"SKIP {row.station}: no Q90 thresholds found - run compute_q90_thresholds.py first")
            continue
        thresholds_cfs = json.loads(threshold_path.read_text())["thresholds_cfs"]
        print(f"Computing drought status history for {row.station} ({config.MONITORING_PERIOD_START} -> {row.record_end}) ...")
        per_station_series[row.station] = station_status_series(row.station, row.record_end, thresholds_cfs)
        last_dates[row.station] = row.record_end

    if not per_station_series:
        raise SystemExit("No stations processed - nothing to write.")

    config.DROUGHT_STATUS_HISTORY_DIR.mkdir(parents=True, exist_ok=True)

    all_years = sorted({d.year for s in per_station_series.values() for d in s.index})
    for year in all_years:
        year_start, year_end = f"{year}-01-01", f"{year}-12-31"
        dates = None
        stations_out = {}
        for station, series in per_station_series.items():
            year_slice = series.loc[year_start:year_end]
            if year_slice.empty:
                continue
            if dates is None:
                dates = [d.strftime("%Y-%m-%d") for d in year_slice.index]
            stations_out[station] = {
                "q30_cfs": [None if pd.isna(v) else round(float(v), 3) for v in year_slice["q30_cfs"]],
                "is_below_q90": [None if pd.isna(v) else bool(v) for v in year_slice["is_below_q90"]],
            }
        if dates is None:
            continue
        out_path = config.DROUGHT_STATUS_HISTORY_DIR / f"{year}.json"
        out_path.write_text(json.dumps({"year": year, "dates": dates, "stations": stations_out}))

    manifest = {
        "monitoring_period_start": config.MONITORING_PERIOD_START,
        "trailing_window_days": TRAILING_WINDOW,
        "years_written": all_years,
        "stations": {s: {"last_date": d} for s, d in last_dates.items()},
        "last_computed_date": min(last_dates.values()),
    }
    (config.PROCESSED_DIR / "drought_status_history.json").write_text(json.dumps(manifest, indent=2))
    print(f"Done -> {config.DROUGHT_STATUS_HISTORY_DIR} ({len(all_years)} year files, "
          f"{len(per_station_series)} stations, last computed date {manifest['last_computed_date']})")


if __name__ == "__main__":
    main()
