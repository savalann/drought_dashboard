// Central place for anything that changes when this dashboard scales:
// where data comes from, and which tabs exist.
//
// To switch from the laptop-local files to an S3 bucket, change ONLY
// DATA_BASE_URL below to the bucket's (static-website or CloudFront) URL,
// e.g. "https://drought-dashboard-data.s3.amazonaws.com/processed" - the
// file layout build_dataset.py writes (stations.json + stations/<id>.json)
// is designed to be dropped into a bucket unchanged. Nothing else in the
// frontend needs to know where the data physically lives.
const APP_CONFIG = {
  DATA_BASE_URL: "../../02.input/processed",

  // Pre-downloaded operational NWM forecasts (01.script/nwm_forecast/download_medium_range.py).
  // Same layout locally and on GitHub Pages; point at a bucket URL later without other changes.
  NWM_FORECAST_BASE_URL: "../../03.output/nwm_forecasts",

  // Human-readable names for the state codes in stations.json's `states`
  // list. Add an entry here whenever build_dataset.py's STATE_REGISTRY
  // (01.script/config.py) gains a new state.
  STATE_NAMES: {
    AL: "Alabama",
  },

  // Each tab is a self-contained "view". Adding a new state or a new kind
  // of analysis (e.g. a future online/streaming Python job) means adding
  // an entry here with its own `type` handler - the tab bar and routing
  // are generated from this list, nothing else needs to change.
  TABS: [
    {
      id: "alabama-drought",
      label: "Alabama · Streamflow Drought",
      type: "map",
      state: "AL",
    },
    {
      id: "conus-drought",
      label: "CONUS (coming soon)",
      type: "placeholder",
      title: "Continental US coverage",
      body: "This tab will extend the same station map, filters, and drought-detail panel to every state once national-scale data is available from the analysis pipeline.",
    },
    {
      id: "live-analysis",
      label: "Live Status (Beta)",
      type: "live-analysis",
      state: "AL",
    },
  ],
};
