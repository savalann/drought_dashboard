"""Download operational NWM v3.0 medium-range streamflow forecasts for our stations
from the CIROH NWM API (BigQuery-backed, https://nwm-api.ciroh.org) and save them as
compressed Parquet the dashboard's JavaScript reader (hyparquet) can open.

Output, one file per (forecast type, cycle, member, region, day):
  03.output/nwm_forecasts/hourly/medium_range/<cycle>/<member>/<region>/YYYYMMDD.parquet
  03.output/nwm_forecasts/daily/medium_range/<cycle>/<member>/<region>/YYYYMMDD.parquet

  hourly: usgs_id, comid, reference_time, time, lead_hour, streamflow_cms, streamflow_cfs, velocity_ms
  daily : usgs_id, comid, reference_time, date, n_hours, streamflow_cms, streamflow_cfs, velocity_ms
          (mean over the hours whose UTC valid time falls on that date; n_hours < 24 marks a partial
           first/last day, so the reader decides whether to use it)

Source: the CIROH API first. It answers HTTP 500 for whole date ranges it has no data for
(e.g. 2025-07-31..2025-08, 2026-03..2026-07), so by default (--source auto) any run the API
can't serve is read instead from the free Google bucket, which has the identical run
(see google_source.py; velocity is left empty for those). Each file's metadata records which
source it came from.

`member` is the API's ensemble number. Member 0 is the same run as Google/AWS `medium_range_mem1`
(verified: identical values for 2026-10-22 00z). Every API call costs money, so days whose files
already exist are skipped unless --overwrite is given.

The API key is read from the CIROH_NWM_API_KEY environment variable or the repo-root `.env`
file (git-ignored). Never put the key in code.

Usage (from 01.script/):
  uv run python nwm_forecast/download_medium_range.py --start 2026-10-22 --end 2026-10-22
  uv run python nwm_forecast/download_medium_range.py --start 2023-09-20 --end 2026-10-22 --cycles 00 06 12 18
"""
from __future__ import annotations

import argparse
import io
import json
import os
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import requests

from google_source import fetch_run_google

HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent.parent
OUTPUT_ROOT = PROJECT_ROOT / "03.output" / "nwm_forecasts"
API_URL = "https://nwm-api.ciroh.org/forecast"
FORECAST_TYPE = "medium_range"
CYCLES = ["00", "06", "12", "18"]
# First day on which every cycle is NWM v3.0 (v3.0 began with the 2023-09-19 12z run; the 00z
# run that day was still v2.2 - checked in the NWM_version_number attribute of the source files).
NWM_V3_FIRST_FULL_DAY = date(2023, 9, 20)
CMS_TO_CFS = 35.314666712
PARQUET_OPTIONS = dict(compression="zstd", compression_level=19, use_dictionary=["usgs_id"],
                       coerce_timestamps="ms", allow_truncated_timestamps=True)


def load_api_key() -> str:
    key = os.environ.get("CIROH_NWM_API_KEY")
    env_file = PROJECT_ROOT / ".env"
    if not key and env_file.exists():
        for line in env_file.read_text().splitlines():
            name, _, value = line.partition("=")
            if name.strip() == "CIROH_NWM_API_KEY":
                key = value.strip().strip("'\"")
    if not key:
        raise SystemExit("Set CIROH_NWM_API_KEY (environment variable or repo-root .env).")
    return key


def load_stations(region: str) -> dict[int, str]:
    data = json.loads((HERE / f"stations_{region}.json").read_text())
    return {int(v["comid"]): usgs for usgs, v in data["stations"].items()}


def output_path(kind: str, cycle: str, member: str, region: str, day: date) -> Path:
    return OUTPUT_ROOT / kind / FORECAST_TYPE / cycle / member / region / f"{day:%Y%m%d}.parquet"


class ApiNoData(RuntimeError):
    """The API answered, but can't serve this run (it returns HTTP 500 instantly for runs it lacks)."""


TRANSIENT = {429, 502, 503, 504}  # overload/gateway errors: worth waiting for
BACKOFF_SECONDS = [5, 15, 30, 60]


def fetch_run(api_key: str, comids: list[int], reference_time: datetime, member: str) -> pd.DataFrame:
    params = {
        "comids": ",".join(map(str, comids)),
        "forecast_type": FORECAST_TYPE,
        "reference_time": reference_time.strftime("%Y-%m-%dT%H:%M:%S"),
        "ensemble": member,
        "output_format": "csv",
    }
    last = None
    for attempt, wait in enumerate([0] + BACKOFF_SECONDS):
        time.sleep(wait)
        try:
            r = requests.get(API_URL, params=params, headers={"x-api-key": api_key}, timeout=300)
        except requests.RequestException as e:  # network hiccup: retry with backoff
            last = f"network error: {e}"
            continue
        if r.ok:
            return pd.read_csv(io.StringIO(r.text))
        last = f"{r.status_code} {r.text[:200]}"
        if r.status_code == 500 and attempt >= 1:
            raise ApiNoData(f"API 500 twice (no data for this run): {r.text[:120]}")
        if r.status_code != 500 and r.status_code not in TRANSIENT:
            raise RuntimeError(f"API {last}")
    raise RuntimeError(f"API failed after retries: {last}")


def to_tables(raw: pd.DataFrame, stations: dict[int, str]) -> tuple[pd.DataFrame, pd.DataFrame]:
    df = raw.rename(columns={"feature_id": "comid", "streamflow": "streamflow_cms", "velocity": "velocity_ms"})
    df["usgs_id"] = df["comid"].map(stations)
    df["reference_time"] = pd.to_datetime(df["reference_time"], utc=True)
    df["time"] = pd.to_datetime(df["time"], utc=True)
    df["lead_hour"] = ((df["time"] - df["reference_time"]).dt.total_seconds() // 3600).astype("int16")
    df["streamflow_cms"] = df["streamflow_cms"].astype("float32")
    df["streamflow_cfs"] = (df["streamflow_cms"] * CMS_TO_CFS).astype("float32")
    df["velocity_ms"] = df["velocity_ms"].astype("float32")
    hourly = (df[["usgs_id", "comid", "reference_time", "time", "lead_hour",
                  "streamflow_cms", "streamflow_cfs", "velocity_ms"]]
              .sort_values(["usgs_id", "time"]).reset_index(drop=True))

    hourly_for_daily = hourly.assign(date=hourly["time"].dt.date)
    daily = (hourly_for_daily.groupby(["usgs_id", "comid", "reference_time", "date"], as_index=False)
             .agg(n_hours=("streamflow_cms", "size"), streamflow_cms=("streamflow_cms", "mean"),
                  velocity_ms=("velocity_ms", "mean")))
    daily["n_hours"] = daily["n_hours"].astype("int16")
    daily["streamflow_cms"] = daily["streamflow_cms"].astype("float32")
    daily["streamflow_cfs"] = (daily["streamflow_cms"] * CMS_TO_CFS).astype("float32")
    daily["velocity_ms"] = daily["velocity_ms"].astype("float32")
    daily = daily[["usgs_id", "comid", "reference_time", "date", "n_hours",
                   "streamflow_cms", "streamflow_cfs", "velocity_ms"]].sort_values(["usgs_id", "date"])
    return hourly, daily.reset_index(drop=True)


def write_parquet(df: pd.DataFrame, path: Path, meta: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    table = pa.Table.from_pandas(df, preserve_index=False)
    table = table.replace_schema_metadata({**(table.schema.metadata or {}),
                                           b"nwm_forecast": json.dumps(meta).encode()})
    tmp = path.with_suffix(".parquet.tmp")
    pq.write_table(table, tmp, **PARQUET_OPTIONS)
    tmp.replace(path)  # never leave a half-written file that the skip-check would trust


def validate(raw: pd.DataFrame, comids: list[int], label: str) -> list[str]:
    problems = []
    missing = sorted(set(comids) - set(raw["feature_id"]))
    if missing:
        problems.append(f"{label}: {len(missing)} stations missing ({missing[:5]})")
    counts = raw.groupby("feature_id").size()
    if len(counts) and counts.nunique() > 1:
        problems.append(f"{label}: uneven hours per station {counts.min()}-{counts.max()}")
    return problems


@dataclass
class RunResult:
    hourly: pd.DataFrame
    daily: pd.DataFrame
    meta: dict
    source: str          # "api" or "google"
    problems: list[str]
    api_called: bool


def build_run(api_key: str, stations: dict[int, str], ref: datetime, member: str, region: str,
              source: str = "auto", min_hours: int = 0) -> RunResult:
    """Fetch ONE forecast run and return its hourly/daily tables. Writes nothing, so a scheduled
    job (laptop or Lambda) decides where the result goes.

    source "auto" = API, falling back to Google when the API has no data - or, with min_hours set,
    when its run is shorter than min_hours per station (the API can lag behind the model)."""
    comids = sorted(stations)
    label = f"{ref:%Y-%m-%d} {ref:%H}z member {member}"
    raw, used, api_called = None, "api", False
    if source in ("auto", "api"):
        api_called = True
        try:
            raw = fetch_run(api_key, comids, ref, member)
            if raw.empty:
                raise ApiNoData("empty response")
            if min_hours and raw.groupby("feature_id").size().min() < min_hours:
                raise ApiNoData(f"run shorter than {min_hours} hours")
        except ApiNoData as e:
            if source == "api":
                raise
            print(f"       {label}: API has no data ({e}); reading the same run from Google…")
            raw = None
    if raw is None:
        raw, used = fetch_run_google(comids, ref, member), "google"
    problems = validate(raw, comids, label)
    hourly, daily = to_tables(raw, stations)
    meta = {"source": API_URL if used == "api" else "gs://national-water-model (Google public bucket)",
            "forecast_type": FORECAST_TYPE, "reference_time": ref.isoformat(), "member": member,
            "region": region, "nwm_version": "v3.0",
            "downloaded_utc": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    return RunResult(hourly, daily, meta, used, problems, api_called)


def write_run(result: RunResult, cycle: str, member: str, region: str, day: date) -> None:
    write_parquet(result.hourly, output_path("hourly", cycle, member, region, day), result.meta)
    write_parquet(result.daily, output_path("daily", cycle, member, region, day), result.meta)


def log_row(log_path: Path, row: dict) -> None:
    """Appended immediately, so stopping a run never loses history."""
    log_path.parent.mkdir(parents=True, exist_ok=True)
    pd.DataFrame([row]).to_csv(log_path, mode="a", header=not log_path.exists(), index=False)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--start", required=True, type=date.fromisoformat)
    ap.add_argument("--end", required=True, type=date.fromisoformat)
    ap.add_argument("--cycles", nargs="+", default=CYCLES, choices=CYCLES)
    ap.add_argument("--member", default="0", help="API ensemble number (0 = medium_range_mem1)")
    ap.add_argument("--region", default="alabama")
    ap.add_argument("--overwrite", action="store_true")
    ap.add_argument("--allow-pre-v3", action="store_true", help=f"allow days before {NWM_V3_FIRST_FULL_DAY}")
    ap.add_argument("--source", choices=["auto", "api", "google"], default="auto",
                    help="auto = API, falling back to the free Google bucket when the API has no data")
    args = ap.parse_args()

    if args.start < NWM_V3_FIRST_FULL_DAY and not args.allow_pre_v3:
        raise SystemExit(f"--start is before NWM v3.0 ({NWM_V3_FIRST_FULL_DAY}); pass --allow-pre-v3 to override.")

    api_key = load_api_key()
    stations = load_stations(args.region)
    log_path = OUTPUT_ROOT / f"download_log_{FORECAST_TYPE}_{args.region}.csv"

    day = args.start
    calls = 0
    google_runs = 0
    while day <= args.end:
        for cycle in args.cycles:
            h_path = output_path("hourly", cycle, args.member, args.region, day)
            d_path = output_path("daily", cycle, args.member, args.region, day)
            label = f"{day} {cycle}z member {args.member}"
            if h_path.exists() and d_path.exists() and not args.overwrite:
                print(f"skip   {label} (already downloaded)")
                continue
            ref = datetime(day.year, day.month, day.day, int(cycle), tzinfo=timezone.utc)
            t0 = time.time()
            try:
                result = build_run(api_key, stations, ref, args.member, args.region, args.source)
                calls += result.api_called
                google_runs += result.source == "google"
                write_run(result, cycle, args.member, args.region, day)
                problems = result.problems
                status = (f"ok ({result.source})" if not problems
                          else f"ok ({result.source}) with warnings: " + "; ".join(problems))
                print(f"saved  {label} [{result.source}]: {len(result.hourly)} hourly rows, {len(result.daily)} daily rows, "
                      f"{time.time() - t0:.1f}s{'  WARN ' + '; '.join(problems) if problems else ''}")
            except Exception as e:  # keep going; failures are logged for a rerun
                status = f"error: {e}"
                print(f"FAILED {label}: {e}")
            log_row(log_path, {"day": day.isoformat(), "cycle": cycle, "member": args.member, "region": args.region,
                               "status": status, "logged_utc": datetime.now(timezone.utc).isoformat(timespec="seconds")})
        day += timedelta(days=1)

    print(f"\nAPI calls made: {calls}. Runs read from Google instead: {google_runs}. "
          f"Log: {log_path.relative_to(PROJECT_ROOT)}")


if __name__ == "__main__":
    main()
