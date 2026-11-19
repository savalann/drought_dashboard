"""AWS Lambda entry point: the cloud version of update_forecasts.py.

Triggered on a schedule (EventBridge, e.g. every 6 hours). Each call saves every NWM v3.0
medium-range run from the last few days that is published but not yet in S3, as daily-mean
Parquet in the same layout the dashboard reads locally:
  s3://<NWM_BUCKET>/<NWM_PREFIX>/daily/medium_range/<cycle>/<member>/<region>/YYYYMMDD.parquet

Environment variables (set on the Lambda):
  NWM_BUCKET          required - the S3 bucket
  NWM_PREFIX          default "nwm_forecasts"
  CIROH_NWM_API_KEY   the API key (not needed if NWM_SOURCE=google)
  NWM_SOURCE          auto (API, Google fallback) | api | google; default auto
  NWM_CYCLES          default "00 06 12 18"
  NWM_KINDS           default "daily"; "daily hourly" also keeps the hourly files
  NWM_LOOKBACK_DAYS   default 3

A test event may override: {"dry_run": true, "lookback_days": 10, "cycles": ["00"]}.
"""
from __future__ import annotations

import os
import time
from datetime import datetime, timezone

import boto3
from botocore.exceptions import ClientError

from download_medium_range import (OUTPUT_ROOT, build_run, load_api_key, load_stations, output_path,
                                    parquet_bytes)
from update_forecasts import EXPECTED_HOURS, plan

MEMBER = "0"
REGION = "alabama"
s3 = boto3.client("s3")


def s3_key(kind: str, cycle: str, day) -> str:
    rel = output_path(kind, cycle, MEMBER, REGION, day).relative_to(OUTPUT_ROOT).as_posix()
    return f"{os.environ.get('NWM_PREFIX', 'nwm_forecasts')}/{rel}"


def exists(bucket: str, key: str) -> bool:
    try:
        s3.head_object(Bucket=bucket, Key=key)
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] in ("404", "NoSuchKey", "NotFound"):
            return False
        raise


def handler(event, context):
    event = event or {}
    bucket = os.environ["NWM_BUCKET"]
    source = os.environ.get("NWM_SOURCE", "auto")
    kinds = os.environ.get("NWM_KINDS", "daily").split()
    cycles = event.get("cycles") or os.environ.get("NWM_CYCLES", "00 06 12 18").split()
    lookback = int(event.get("lookback_days", os.environ.get("NWM_LOOKBACK_DAYS", 3)))

    now = datetime.now(timezone.utc)
    todo, waiting = plan(now, lookback, cycles,
                         lambda day, cycle: all(exists(bucket, s3_key(k, cycle, day)) for k in kinds))
    print(f"{now:%Y-%m-%d %H:%M}Z  missing and ready: {len(todo)}   not published yet: {len(waiting)}")
    summary = {"ready": [f"{d} {c}z" for d, c, _ in todo], "waiting": [f"{d} {c}z" for d, c, _ in waiting],
               "saved": [], "failed": []}
    if event.get("dry_run") or not todo:
        return summary

    api_key = load_api_key() if source != "google" else ""
    stations = load_stations(REGION)
    for day, cycle, ref in todo:
        label = f"{day} {cycle}z"
        t0 = time.time()
        if context and context.get_remaining_time_in_millis() < 90_000:
            print(f"stopping before {label}: under 90 s left; the next scheduled call continues")
            break
        try:
            result = build_run(api_key, stations, ref, MEMBER, REGION, source, min_hours=EXPECTED_HOURS)
            for kind in kinds:
                df = result.daily if kind == "daily" else result.hourly
                s3.put_object(Bucket=bucket, Key=s3_key(kind, cycle, day), Body=parquet_bytes(df, result.meta),
                              ContentType="application/vnd.apache.parquet",
                              CacheControl="max-age=300")
            summary["saved"].append(f"{label} [{result.source}]")
            print(f"saved  {label} [{result.source}] {time.time() - t0:.1f}s")
        except Exception as e:  # not published yet / API down: nothing written, the next call retries
            summary["failed"].append(f"{label}: {e}")
            print(f"FAILED {label}: {e}")
    return summary
