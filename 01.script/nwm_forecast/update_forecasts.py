"""Keep the pre-downloaded NWM medium-range forecasts current: fetch every run that has been
published since the last pass and save it in the same layout as download_medium_range.py.

It is safe to run as often as you like (e.g. every 6 hours from launchd/cron):
  - it looks back --lookback-days days, so a missed pass (laptop asleep, no internet, API outage)
    is filled in by the next one;
  - a run is only attempted once it has had PUBLISH_DELAY_HOURS to appear (a run takes about
    6.5 hours to be published), and only if its files are missing;
  - a run that isn't complete yet is not saved - it is simply tried again on the next pass;
  - existing files are never touched, so no API money is spent twice.

It does NOT push to GitHub. Commit/push the new files yourself.

The work for one run lives in download_medium_range.build_run(), which returns the tables
without writing anything - a Lambda can call the same function and write to S3 instead.

Usage (from 01.script/):
  uv run python nwm_forecast/update_forecasts.py --dry-run     # show what it would fetch
  uv run python nwm_forecast/update_forecasts.py               # last 3 days, all four cycles
  uv run python nwm_forecast/update_forecasts.py --cycles 00   # only the 00z run (what the dashboard uses)
"""
from __future__ import annotations

import argparse
import fcntl
import sys
import time
from datetime import datetime, timedelta, timezone

from download_medium_range import (CYCLES, FORECAST_TYPE, NWM_V3_FIRST_FULL_DAY, OUTPUT_ROOT, build_run,
                                    load_api_key, load_stations, log_row, output_path, write_run)

PUBLISH_DELAY_HOURS = 7   # measured ~6.5 h from cycle time to the last file being available
EXPECTED_HOURS = 240      # member 0 / medium_range_mem1 runs 240 hours; fewer means not fully published


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--lookback-days", type=int, default=3)
    ap.add_argument("--cycles", nargs="+", default=CYCLES, choices=CYCLES)
    ap.add_argument("--member", default="0")
    ap.add_argument("--region", default="alabama")
    ap.add_argument("--source", choices=["auto", "api", "google"], default="auto")
    ap.add_argument("--dry-run", action="store_true", help="list the missing runs and stop")
    args = ap.parse_args()

    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    lock = open(OUTPUT_ROOT / ".update.lock", "w")
    try:  # two passes at once would pay for the same runs twice
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print("Another update is already running; exiting.")
        return 0

    now = datetime.now(timezone.utc)
    ready_before = now - timedelta(hours=PUBLISH_DELAY_HOURS)
    todo, waiting = [], []
    for back in range(args.lookback_days, -1, -1):
        day = (now - timedelta(days=back)).date()
        if day < NWM_V3_FIRST_FULL_DAY:
            continue
        for cycle in args.cycles:
            ref = datetime(day.year, day.month, day.day, int(cycle), tzinfo=timezone.utc)
            have = all(output_path(k, cycle, args.member, args.region, day).exists() for k in ("hourly", "daily"))
            if have:
                continue
            (todo if ref <= ready_before else waiting).append((day, cycle, ref))

    print(f"{now:%Y-%m-%d %H:%M}Z  missing and ready: {len(todo)}   not published yet: {len(waiting)}")
    for day, cycle, _ in waiting:
        print(f"  wait   {day} {cycle}z")
    for day, cycle, _ in todo:
        print(f"  fetch  {day} {cycle}z")
    if args.dry_run or not todo:
        return 0

    api_key = load_api_key() if args.source != "google" else ""
    stations = load_stations(args.region)
    log_path = OUTPUT_ROOT / f"download_log_{FORECAST_TYPE}_{args.region}.csv"
    failures = 0
    for day, cycle, ref in todo:
        label = f"{day} {cycle}z member {args.member}"
        t0 = time.time()
        try:
            result = build_run(api_key, stations, ref, args.member, args.region, args.source,
                               min_hours=EXPECTED_HOURS)
            write_run(result, cycle, args.member, args.region, day)
            status = f"ok ({result.source})" + (f" with warnings: {'; '.join(result.problems)}" if result.problems else "")
            print(f"saved  {label} [{result.source}] {time.time() - t0:.1f}s")
        except Exception as e:  # not published yet / API down: leave no file, the next pass retries
            failures += 1
            status = f"error: {e}"
            print(f"FAILED {label}: {e}")
        log_row(log_path, {"day": day.isoformat(), "cycle": cycle, "member": args.member, "region": args.region,
                           "status": status, "logged_utc": datetime.now(timezone.utc).isoformat(timespec="seconds")})
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
