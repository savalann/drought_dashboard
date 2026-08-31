"""Build the dashboard-ready dataset from the upstream drought-analysis outputs.

Reads the CSV/parquet files copied into 02.input (see config.py for exact
paths) and writes:

  02.input/processed/stations.json
      One row per screened Alabama gauge (lat/lon, GAGES-II status, record
      length/completeness, and - for stations with a GPD fit - severity at
      each duration x metric combination). This is the only file the map
      and filters need, so it stays light even as more states are added.

  02.input/processed/stations/<station>.json
      Per-station detail, fetched lazily when a station is clicked: the
      drought-year timeline and the SDF curve (GPD + empirical) for every
      duration. Splitting these out (one small file per station, same shape
      a future S3 "stations/<id>.json" key would have) is what keeps this
      scalable to the full US instead of one ever-growing blob.

Run with `uv run python build_dataset.py` from this directory.
"""

from __future__ import annotations

import json
from datetime import date

import numpy as np
import pandas as pd

import config


def pot_return_level(shape: float, scale: float, rate_per_year: float,
                      return_period) -> np.ndarray:
    """Same formula as the upstream project's drought_lib.pot_return_level."""
    rt = rate_per_year * np.asarray(return_period, dtype=float)
    if abs(shape) < 1e-8:
        return scale * np.log(rt)
    return (scale / shape) * (rt ** shape - 1.0)


def load_station_metadata() -> pd.DataFrame:
    df = pd.read_csv(config.STATION_METADATA_CSV, dtype={"id": str})
    df["station"] = df["id"].str.replace("USGS-", "", regex=False)
    return df[["station", "monitoring_location_name", "latitude", "longitude", "drainage_area"]].rename(
        columns={"monitoring_location_name": "name", "latitude": "lat", "longitude": "lon"}
    )


def load_reference_classification() -> pd.DataFrame:
    df = pd.read_csv(config.REFERENCE_CLASSIFICATION_CSV, dtype={"station": str})
    df["is_reference"] = df["is_reference"].map({"True": True, "False": False, True: True, False: False}).where(
        df["is_reference"].notna(), None
    )
    return df[["station", "is_reference", "AGGECOREGION", "HYDRO_DISTURB_INDX"]]


def load_record_completeness() -> pd.DataFrame:
    df = pd.read_csv(config.RECORD_COMPLETENESS_CSV, dtype={"station": str})
    df["is_reference"] = df["is_reference"].map({"True": True, "False": False, True: True, False: False}).where(
        df["is_reference"].notna(), None
    )
    return df


def compute_full_record_missing_pct(station: str, record_start: str, record_end: str) -> float | None:
    """Percent of calendar days between the station's own first/last
    observation without a discharge value - not tied to any fixed decade
    start, unlike the pct_missing_<yr> columns in record_completeness.csv."""
    path = config.ALABAMA_RAW_DIR / f"{station}.csv"
    if not path.exists() or pd.isna(record_start) or pd.isna(record_end):
        return None
    daily = pd.read_csv(path, usecols=["date", "value"], parse_dates=["date"])
    daily = daily.dropna(subset=["value"])
    n_with_value = daily["date"].dt.normalize().nunique()
    total_days = (pd.Timestamp(record_end) - pd.Timestamp(record_start)).days + 1
    if total_days <= 0:
        return None
    return round(100.0 * (1 - n_with_value / total_days), 2)


def build_severity_lookup() -> pd.DataFrame:
    """Long table: station, duration, metric, severity_pct.

    metric is one of rp10/rp20/rp50/rp100 (from the GPD fit, extrapolated
    return levels) or median/max (the actual worst / typical observed
    drought event for that station/duration).
    """
    rp = pd.read_parquet(config.RETURN_PERIOD_SEVERITY_PARQUET)
    rp["metric"] = "rp" + rp["return_period_years"].astype(str)
    rp = rp[["station", "duration", "metric", "severity_pct"]]

    max_ev = pd.read_csv(config.MAX_DROUGHT_EVENT_CSV, dtype={"station": str})
    max_ev = max_ev.assign(metric="max")[["station", "duration", "metric", "severity_pct"]]

    median_ev = pd.read_csv(config.MEDIAN_DROUGHT_EVENT_CSV, dtype={"station": str})
    median_ev = median_ev.assign(metric="median")[["station", "duration", "metric", "severity_pct"]]

    return pd.concat([rp, max_ev, median_ev], ignore_index=True)


def build_stations_json(severity_long: pd.DataFrame, gpd_params: pd.DataFrame) -> list[dict]:
    meta = load_station_metadata()
    ref = load_reference_classification()
    completeness = load_record_completeness()

    stations = completeness.merge(meta, on="station", how="left").merge(
        ref[["station", "AGGECOREGION"]], on="station", how="left"
    )

    events_by_station_duration = gpd_params.set_index(["station", "duration"])[
        ["n_events", "n_years", "rate_per_year"]
    ].to_dict("index")

    severity_pivot = (
        severity_long
        .pivot_table(index=["station", "duration"], columns="metric", values="severity_pct", aggfunc="first")
        .to_dict("index")
    )

    out = []
    for row in stations.itertuples():
        station = row.station
        full_missing = compute_full_record_missing_pct(station, row.record_start, row.record_end)

        durations_out = {}
        has_analysis = False
        for d in config.DURATIONS:
            key = (station, d)
            values = severity_pivot.get(key)
            ev = events_by_station_duration.get(key)
            if values is None and ev is None:
                continue
            has_analysis = True
            metrics = {m: values.get(m) for m in ("rp10", "rp20", "rp50", "rp100", "median", "max")} if values else {}
            durations_out[str(d)] = {
                **metrics,
                "n_events": ev["n_events"] if ev else None,
                "rate_per_year": ev["rate_per_year"] if ev else None,
            }

        out.append({
            "station": station,
            "name": getattr(row, "name", None),
            "lat": row.lat if pd.notna(getattr(row, "lat", np.nan)) else None,
            "lon": row.lon if pd.notna(getattr(row, "lon", np.nan)) else None,
            "state": config.DEFAULT_STATE,
            "drainage_area_sqmi": row.drainage_area if pd.notna(getattr(row, "drainage_area", np.nan)) else None,
            "is_reference": row.is_reference if pd.notna(row.is_reference) else None,
            "aggecoregion": row.AGGECOREGION if pd.notna(getattr(row, "AGGECOREGION", np.nan)) else None,
            "record_start": row.record_start,
            "record_end": row.record_end,
            "pct_missing_full_record": full_missing,
            "analysis_period_start": "1990-01-01",
            "analysis_period_end": row.record_end,
            "pct_missing_analysis_period": row.pct_missing_1990,
            "best_period": row.best_period,
            "has_analysis": has_analysis,
            "durations": durations_out,
        })
    return out


def build_station_detail(station: str, drought_events: pd.DataFrame, gpd_params: pd.DataFrame) -> dict:
    ev = drought_events[drought_events["station"] == station]
    gp = gpd_params[gpd_params["station"] == station].set_index("duration")

    drought_years = {
        str(d): ev[ev["duration"] == d][["water_year", "severity_pct", "empirical_probability"]]
                .sort_values("water_year").to_dict("records")
        for d in config.DURATIONS
        if not ev[ev["duration"] == d].empty
    }

    sdf_curves = {}
    for d in config.DURATIONS:
        if d not in gp.index:
            continue
        params = gp.loc[d]
        empirical_points = [
            {"return_period_years": round(100.0 / (100.0 - p), 3), "severity_pct": s}
            for p, s in zip(
                ev[ev["duration"] == d]["empirical_probability"],
                ev[ev["duration"] == d]["severity_pct"],
            )
            if p < 100.0
        ]
        curve = {
            "n_events": int(params["n_events"]),
            "rate_per_year": params["rate_per_year"],
            "empirical": sorted(empirical_points, key=lambda p: p["return_period_years"]),
            "gpd": None,
        }
        if pd.notna(params["gpd_shape"]) and pd.notna(params["gpd_scale"]):
            magnitudes = pot_return_level(
                params["gpd_shape"], params["gpd_scale"], params["rate_per_year"],
                config.SDF_CURVE_RETURN_PERIODS,
            )
            curve["gpd"] = [
                {"return_period_years": t, "severity_pct": -float(m)}
                for t, m in zip(config.SDF_CURVE_RETURN_PERIODS, magnitudes)
            ]
        sdf_curves[str(d)] = curve

    return {"station": station, "drought_years": drought_years, "sdf_curves": sdf_curves}


def main() -> None:
    config.PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    config.STATIONS_DETAIL_DIR.mkdir(parents=True, exist_ok=True)

    gpd_params = pd.read_parquet(config.GPD_PARAMS_PARQUET)
    drought_events = pd.read_parquet(config.DROUGHT_EVENTS_PARQUET)
    severity_long = build_severity_lookup()

    print("Building stations.json ...")
    stations = build_stations_json(severity_long, gpd_params)
    manifest = {
        "generated_at": date.today().isoformat(),
        "states": list(config.STATE_REGISTRY.keys()),
        "durations": config.DURATIONS,
        "return_periods": config.RETURN_PERIODS,
        "metrics": [f"rp{p}" for p in config.RETURN_PERIODS] + ["median", "max"],
        "severity_bins": [
            {"min": lo, "max": hi, "color": c} for lo, hi, c in config.SEVERITY_BINS
        ],
        "stations": stations,
    }
    (config.PROCESSED_DIR / "stations.json").write_text(json.dumps(manifest, default=str))
    print(f"  {len(stations)} stations, {sum(s['has_analysis'] for s in stations)} with severity data")

    analyzed_stations = gpd_params["station"].unique()
    print(f"Building per-station detail for {len(analyzed_stations)} stations ...")
    for station in analyzed_stations:
        detail = build_station_detail(station, drought_events, gpd_params)
        (config.STATIONS_DETAIL_DIR / f"{station}.json").write_text(json.dumps(detail, default=str))

    print("Done ->", config.PROCESSED_DIR)


if __name__ == "__main__":
    main()
