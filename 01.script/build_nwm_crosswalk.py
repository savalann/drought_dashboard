"""USGS gage -> NextGen hydrofabric flowpath crosswalk, for the Live
Analysis tab's National Water Model medium-range forecast lookups.

The troute output parquet files in the CIROH community datastream
(ciroh-community-ngen-datastream) index streamflow by an internal
hydrofabric flowpath `feature_id` (e.g. 483124, from hydrofabric id
"wb-483124") - NOT the USGS site number and NOT the raw NHDPlusV2 comid
(confirmed by hand: gage 02342500's NLDI comid, 3435970, does not appear as
a feature_id anywhere in its VPU's output). The only reliable link is the
per-VPU hydrofabric geopackage's `hydrolocations` table, which records
`hl_link` (the USGS site number) -> `id` (the "wb-<feature_id>" flowpath)
for every gage-colocated flowpath.

This script queries those geopackages directly over HTTP (GDAL's /vsicurl/,
via `ogr2ogr`) - no need to download the ~100-200MB file per VPU - for every
station in this project's Q90 threshold set (pass_1940 stations; see
compute_q90_thresholds.py). Alabama's gauges span more than one hydrofabric
VPU and VPU membership does NOT line up cleanly with simple HUC-code
prefixes (02342500 is HUC 0313 / Chattahoochee-ish but its flowpath is in
VPU_03W, not VPU_03N) - so every candidate VPU is queried and whichever one
actually contains the gage wins, rather than guessing from HUC.

Run with `uv run python build_nwm_crosswalk.py`.
"""

from __future__ import annotations

import json
import subprocess

import pandas as pd

import config

GPKG_URL_TEMPLATE = (
    "/vsicurl/https://ciroh-community-ngen-datastream.s3.amazonaws.com/"
    "resources/v2.2_hydrofabric/geopackages/{vpu}/nextgen_{vpu}.gpkg"
)

# Every VPU that could plausibly contain an Alabama gauge's flowpath.
# 03N/03S/03W/06 border or cover the state; the rest are here only as a
# defensive fallback and will simply return no rows.
CANDIDATE_VPUS = ["VPU_03W", "VPU_03N", "VPU_03S", "VPU_06", "VPU_04"]


def query_vpu(vpu: str, stations: list[str]) -> list[dict]:
    station_list = ",".join(f"'{s}'" for s in stations)
    sql = (
        "SELECT poi_id, id, nex_id, hl_link FROM hydrolocations "
        f"WHERE hl_reference = 'gages' AND hl_link IN ({station_list})"
    )
    result = subprocess.run(
        ["ogr2ogr", "-f", "GeoJSON", "/vsistdout/", GPKG_URL_TEMPLATE.format(vpu=vpu), "-sql", sql],
        capture_output=True, text=True,
        env={"CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".gpkg", "PATH": "/usr/bin:/bin:/opt/homebrew/bin"},
    )
    if result.returncode != 0:
        print(f"  {vpu}: query failed - {result.stderr.strip()[:200]}")
        return []
    data = json.loads(result.stdout)
    return [
        {
            "station": f["properties"]["hl_link"],
            "vpu": vpu,
            "flowpath_id": f["properties"]["id"],
            "feature_id": int(f["properties"]["id"].removeprefix("wb-")),
        }
        for f in data["features"]
    ]


def main() -> None:
    completeness = pd.read_csv(config.RECORD_COMPLETENESS_CSV, dtype={"station": str})
    stations = completeness[completeness["pass_1940"] == True]["station"].tolist()  # noqa: E712

    found: dict[str, dict] = {}
    for vpu in CANDIDATE_VPUS:
        remaining = [s for s in stations if s not in found]
        if not remaining:
            break
        print(f"Querying {vpu} for {len(remaining)} remaining station(s) ...")
        for match in query_vpu(vpu, remaining):
            found[match["station"]] = match

    missing = [s for s in stations if s not in found]
    if missing:
        print(f"WARNING: no hydrofabric flowpath found for {len(missing)} station(s): {missing}")

    crosswalk = {
        "candidate_vpus_searched": CANDIDATE_VPUS,
        "stations": found,
        "unmatched_stations": missing,
    }
    out_path = config.PROCESSED_DIR / "nwm_crosswalk.json"
    out_path.write_text(json.dumps(crosswalk, indent=2))
    print(f"Matched {len(found)}/{len(stations)} stations -> {out_path}")


if __name__ == "__main__":
    main()
