"""Paths and constants shared by the data-prep pipeline.

Keeping every path/constant here (instead of hardcoding in build_dataset.py)
is what lets this same pipeline later point at a different state, a
different analysis run, or an S3-backed input directory without touching
the transform logic.
"""

from __future__ import annotations

from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
INPUT_DIR = PROJECT_ROOT / "02.input"
OUTPUT_DIR = PROJECT_ROOT / "03.output"

# Where the finished, dashboard-ready JSON is written. The frontend's
# js/config.js DATA_BASE_URL points here for local dev; swapping that one
# value to an S3 URL (with the same folder/file layout) is the whole
# migration to remote data.
PROCESSED_DIR = INPUT_DIR / "processed"
STATIONS_DETAIL_DIR = PROCESSED_DIR / "stations"

# Upstream analysis outputs (04.drought_analysis_visualization), already
# copied into 02.input by hand for now. Re-copy here if that project's
# pipeline is re-run with new data.
ALABAMA_RAW_DIR = INPUT_DIR / "alabama"
STATION_METADATA_CSV = ALABAMA_RAW_DIR / "00_station_metadata.csv"
REFERENCE_CLASSIFICATION_CSV = INPUT_DIR / "01_alabama_reference_classification.csv"
RECORD_COMPLETENESS_CSV = INPUT_DIR / "02_alabama_record_completeness.csv"
DROUGHT_EVENTS_PARQUET = INPUT_DIR / "03_drought_events_1990.parquet"
GPD_PARAMS_PARQUET = INPUT_DIR / "04_gpd_params_1990.parquet"
RETURN_PERIOD_SEVERITY_PARQUET = INPUT_DIR / "05_return_period_severity_1990.parquet"
MAX_DROUGHT_EVENT_CSV = INPUT_DIR / "08_max_drought_event_1990.csv"
MEDIAN_DROUGHT_EVENT_CSV = INPUT_DIR / "09_median_drought_event_1990.csv"

# One entry per state the dashboard can filter to. Adding a new state means
# adding an entry here (plus its own set of the input files above) - the
# frontend's state filter is driven entirely by what shows up in stations.json.
STATE_REGISTRY = {
    "AL": {"name": "Alabama", "fips": "01"},
}
DEFAULT_STATE = "AL"

# Duration = rolling-window length in water-years used when computing
# severity (see the upstream project's drought_lib.py). Kept here too so a
# future state/run with a different duration set only needs a config edit.
DURATIONS = [2, 3, 4, 5, 6, 7, 8, 9, 10]

# Return periods (years) already computed by the upstream pipeline.
RETURN_PERIODS = [10, 20, 50, 100]

# Return periods (years) to trace for the SDF curve shown in the station
# detail panel, using the same GPD formula the upstream pipeline used to
# produce the four RETURN_PERIODS values above (see pot_return_level in
# drought_lib.py). Log-spaced so the curve is smooth at short return periods
# without an excessive number of points out past 100 years.
SDF_CURVE_RETURN_PERIODS = [
    1.5, 2, 3, 4, 5, 7, 10, 15, 20, 30, 40, 50, 70, 100, 150, 200,
]

# Severity-magnitude (%) bins used to color stations on the map, light
# yellow -> dark orange. `None` as the upper bound means "and above".
SEVERITY_BINS = [
    (0, 25, "#ffffcc"),
    (25, 50, "#fed976"),
    (50, 75, "#fd8d3c"),
    (75, 100, "#e31a1c"),
    (100, None, "#800026"),
]

MIN_EVENTS_FOR_GPD = 5  # mirrors drought_lib.MIN_EVENTS_FOR_GPD; stations below this have no GPD curve
