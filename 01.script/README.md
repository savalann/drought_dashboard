# Streamflow Drought Dashboard

A static HTML/CSS/JS dashboard (Leaflet + Chart.js, no Python web
framework) that visualizes the drought-severity analysis produced by
`04.drought_analysis_visualization`. A small `uv`-managed Python pipeline
reshapes that project's parquet/CSV outputs into the compact JSON files the
frontend reads.

## Environment (uv)

```bash
uv sync   # installs pandas, pyarrow, openpyxl into .venv
```

## 1. Build the dataset

```bash
uv run python build_dataset.py
```

Reads from `../02.input` (the analysis outputs already copied there - see
`config.py` for exact filenames) and writes:

- `../02.input/processed/stations.json` - one row per screened Alabama
  gauge: location, GAGES-II status, record completeness, and severity at
  every duration x metric combination. This is all the map/filters need.
- `../02.input/processed/stations/<station>.json` - per-station drought
  years and SDF curves, fetched lazily when a station is clicked.

Re-run this whenever the upstream analysis project produces new output
files (re-copy them into `02.input` first).

## 2. Run the dashboard

The frontend fetches its data with relative paths, so it needs to be
served over HTTP (not opened as a `file://` URL):

```bash
uv run python serve.py        # serves the whole project root on :8000
```

Then open <http://localhost:8000/01.script/dashboard/index.html>.

## Layout

```
01.script/
  config.py          # paths, durations, return periods, color bins
  build_dataset.py   # analysis outputs -> dashboard JSON
  serve.py           # local static file server
  dashboard/          # the frontend (plain HTML/CSS/JS, Leaflet + Chart.js via CDN)
    index.html
    css/styles.css
    js/
      config.js       # DATA_BASE_URL + tab registry - the two things that change as this scales
      dataStore.js     # fetch/cache layer
      colors.js        # severity -> color
      map.js           # Leaflet station layer
      filters.js        # sidebar controls
      panel.js          # click popup + drought-detail slide-over
      charts.js          # Chart.js drought-year + SDF curve charts
      app.js             # bootstraps tabs from config.js
```

## Scaling this later

- **More states / the full US**: add the state's analysis outputs to
  `config.STATE_REGISTRY`, re-run `build_dataset.py` (it already writes
  every station's `state` field), and add a matching entry to
  `dashboard/js/config.js`'s `STATE_NAMES` / `TABS`. The per-station detail
  files already scale independently of station count since they're fetched
  one at a time, not bundled.
- **S3-hosted data**: point `dashboard/js/config.js`'s `DATA_BASE_URL` at
  the bucket (the `stations.json` + `stations/<id>.json` layout is designed
  to be dropped in unchanged).
- **Online/on-demand Python analysis**: the "Live Analysis" placeholder tab
  in `config.js` is a slot for this - it would call a small API instead of
  reading static JSON, but reuse the same `DataStore`-shaped interface so
  `map.js`/`panel.js`/`charts.js` don't need to change.
- **New tabs in general**: add an entry to `APP_CONFIG.TABS`; `app.js`
  renders it from the `type` field (`"map"` or `"placeholder"` today).
