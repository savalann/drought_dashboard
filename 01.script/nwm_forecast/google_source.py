"""Fallback source: read one NWM medium-range run for a few reaches directly from the
free Google public bucket `national-water-model` (NOAA Open Data Dissemination).

Used when the CIROH NWM API has no data for a run (it answers HTTP 500 for whole
date ranges, e.g. 2025-07-31..2025-08 and 2026-03..2026-07). It is the same model
run: API ensemble 0 == Google `medium_range_mem1` (verified identical for 2026-10-22).

Each Google file is ONE forecast hour for all ~2.78M reaches (HDF5, ~12 MB). Only
the compressed blocks containing our reaches are downloaded, via HTTP Range
requests (~1.6 MB per file for our 18 stations, ~390 MB per 240-hour run).
Velocity is not read (it would double the download), so it is left empty.
"""
from __future__ import annotations

import io
import multiprocessing as mp
import os
import threading
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime

import h5py
import numpy as np
import pandas as pd
import requests

BUCKET = "https://storage.googleapis.com/national-water-model"
HOURS = range(1, 241)
READ_WINDOW = 128 * 1024  # bytes per range request; tuned in temp_data (less waste vs. more requests)
PROCESSES = 32            # h5py serializes threads, so parallelism comes from processes

_local = threading.local()
_executor: ProcessPoolExecutor | None = None


def _session() -> requests.Session:
    # One per process: on Linux (Lambda) child processes are forked copies, and sharing the
    # parent's open HTTPS connection corrupts it ("Broken pipe" / SSL record errors).
    if getattr(_local, "pid", None) != os.getpid():
        _local.s, _local.pid = requests.Session(), os.getpid()
    return _local.s


class _RangeFile(io.RawIOBase):
    """Seekable read-only file backed by HTTP Range requests with a block cache."""

    def __init__(self, url: str):
        self.url, self.pos, self.blocks = url, 0, {}
        r = _session().head(url, timeout=60)
        r.raise_for_status()
        self.size = int(r.headers["Content-Length"])

    def readable(self): return True
    def seekable(self): return True
    def tell(self): return self.pos

    def seek(self, offset, whence=0):
        self.pos = offset if whence == 0 else self.pos + offset if whence == 1 else self.size + offset
        return self.pos

    def _block(self, b: int) -> bytes:
        if b not in self.blocks:
            start = b * READ_WINDOW
            end = min(start + READ_WINDOW, self.size) - 1
            for attempt in range(4):
                try:
                    r = _session().get(self.url, headers={"Range": f"bytes={start}-{end}"}, timeout=60)
                    r.raise_for_status()
                    break
                except requests.RequestException:
                    if attempt == 3:
                        raise
            self.blocks[b] = r.content
        return self.blocks[b]

    def readinto(self, buf):
        n = min(len(buf), self.size - self.pos)
        done = 0
        while done < n:
            b, off = divmod(self.pos, READ_WINDOW)
            piece = self._block(b)[off:off + n - done]
            buf[done:done + len(piece)] = piece
            done += len(piece)
            self.pos += len(piece)
        return done


def _url(run: datetime, member: int, hour: int) -> str:
    mem = member + 1  # API ensemble N == Google medium_range_mem(N+1)
    return (f"{BUCKET}/nwm.{run:%Y%m%d}/medium_range_mem{mem}/"
            f"nwm.t{run:%H}z.medium_range.channel_rt_{mem}.f{hour:03d}.conus.nc")


def _open(url: str) -> h5py.File:
    return h5py.File(io.BufferedReader(_RangeFile(url), buffer_size=READ_WINDOW), "r")


def _positions(run: datetime, member: int, comids: list[int]) -> list[int]:
    with _open(_url(run, member, 1)) as f:
        feature_ids = f["feature_id"][:]
    lookup = {int(c): i for i, c in enumerate(feature_ids)}
    missing = [c for c in comids if c not in lookup]
    if missing:
        raise RuntimeError(f"COMIDs not in NWM reach list: {missing}")
    return [lookup[c] for c in comids]


def _read_hour(args) -> tuple[int, np.ndarray]:
    url, positions = args
    order = np.argsort(positions)
    with _open(url) as f:
        ds = f["streamflow"]
        raw = ds[np.asarray(positions)[order]]  # h5py needs increasing positions
        fill, scale = ds.attrs["_FillValue"][0], ds.attrs["scale_factor"][0]
        valid = int(f["time"][0])  # minutes since 1970-01-01 UTC
    vals = np.where(raw == fill, np.nan, raw * scale)
    out = np.empty(len(positions))
    out[order] = vals
    return valid, out


def _pipe_worker(conn, jobs) -> None:
    conn.send([_read_hour(j) for j in jobs])
    conn.close()


def _map_with_pipes(jobs: list, n: int) -> list:
    """AWS Lambda has no /dev/shm, so ProcessPoolExecutor (and multiprocessing.Pool/Queue) fail
    there; plain Processes talking over Pipes work."""
    workers = []
    for i in range(n):
        recv, send = mp.Pipe(duplex=False)
        p = mp.Process(target=_pipe_worker, args=(send, jobs[i::n]))
        p.start()
        workers.append((p, recv))
    results = []
    for p, recv in workers:
        results += recv.recv()  # read before join, or a large result blocks the child forever
        p.join()
        if p.exitcode:
            raise RuntimeError(f"Google reader process failed (exit code {p.exitcode})")
    return results


def fetch_run_google(comids: list[int], run: datetime, member: str) -> pd.DataFrame:
    """Same columns as the CIROH API CSV: feature_id, reference_time, time, ensemble, streamflow, velocity."""
    global _executor
    m = int(member)
    positions = _positions(run, m, comids)
    jobs = [(_url(run, m, h), positions) for h in HOURS]
    n = min(PROCESSES, os.cpu_count() * 4)
    if os.environ.get("AWS_LAMBDA_FUNCTION_NAME") or os.environ.get("NWM_GOOGLE_POOL") == "pipes":
        results = _map_with_pipes(jobs, n)
    else:
        if _executor is None:
            _executor = ProcessPoolExecutor(n)
        results = list(_executor.map(_read_hour, jobs))
    rows = []
    ref = run.strftime("%Y-%m-%dT%H:%M:%S")
    for valid, values in results:
        t = pd.Timestamp(valid * 60, unit="s").strftime("%Y-%m-%dT%H:%M:%S")
        rows += [(c, ref, t, m, float(v), np.nan) for c, v in zip(comids, values)]
    return pd.DataFrame(rows, columns=["feature_id", "reference_time", "time", "ensemble", "streamflow", "velocity"])
