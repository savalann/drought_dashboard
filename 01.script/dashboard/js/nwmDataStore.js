// Reads National Water Model medium-range FORECAST streamflow directly out
// of the public CIROH community datastream S3 bucket, entirely client-side.
// (The "previous 20 days" side of the Live Analysis tab uses real USGS
// observations instead - see usgsDataStore.js - so this module only ever
// covers the future/forecast side of the window.)
//
// Bucket layout (reverse-engineered by hand, see 01.script/build_nwm_crosswalk.py
// for the fuller writeup):
//   outputs/<model>/v2.2_hydrofabric/ngen.<YYYYMMDD>/medium_range/00/1/<VPU>/ngen-run/outputs/troute/*.parquet
// `<model>` is one of MODELS below - the bucket runs more than one NextGen
// configuration side by side on the same hydrofabric, so switching which
// one the Live Status tab reads is just swapping that path segment.
// Each parquet file has columns feature_id (hydrofabric flowpath id, NOT a
// USGS site number or raw NHDPlus comid - see build_nwm_crosswalk.py),
// time, flow (m3/s), among others. The bucket allows anonymous GET/HEAD
// with permissive CORS and HTTP range requests, which is what makes
// reading this from a browser (no backend) possible at all.
//
// Every station in a given VPU's forecast lives in the SAME set of ~10
// parquet files, so the reader fetches and parses each file once per VPU
// and pulls out every requested feature_id in that one pass, rather than
// re-fetching per station.
const NwmDataStore = (() => {
  const BUCKET = "https://ciroh-community-ngen-datastream.s3.amazonaws.com";
  const CMS_TO_CFS = 35.314666712;

  // Model configurations available in the bucket for the medium-range
  // forecast. Both are experimental NextGen community runs (see the
  // warning banner on the Live Status tab) - neither is the official
  // operational National Water Model.
  const MODELS = {
    cfe_nom: { label: "CFE-NOAH (physics-based)" },
    lstm_0: { label: "LSTM (machine-learning)" },
  };
  const DEFAULT_MODEL = "cfe_nom";

  let hyparquetModules = null;
  function loadHyparquet() {
    if (!hyparquetModules) {
      hyparquetModules = Promise.all([
        import("https://cdn.jsdelivr.net/npm/hyparquet@1.29.2/+esm"),
        import("https://cdn.jsdelivr.net/npm/hyparquet-compressors@1/+esm"),
      ]).then(([hyparquet, hyparquetCompressors]) => ({
        parquetReadObjects: hyparquet.parquetReadObjects,
        asyncBufferFromUrl: hyparquet.asyncBufferFromUrl,
        compressors: hyparquetCompressors.compressors,
      }));
    }
    return hyparquetModules;
  }

  function pad2(n) { return String(n).padStart(2, "0"); }
  function toYYYYMMDD(d) { return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`; }
  function toDateKey(d) { return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; }
  function addDays(d, n) { const copy = new Date(d.getTime()); copy.setUTCDate(copy.getUTCDate() + n); return copy; }

  async function listTrouteFiles(prefix) {
    const url = `${BUCKET}/?list-type=2&prefix=${encodeURIComponent(prefix)}&delimiter=/`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const xml = new DOMParser().parseFromString(await res.text(), "application/xml");
    return Array.from(xml.getElementsByTagName("Key")).map((k) => `${BUCKET}/${k.textContent}`);
  }

  // Reads one parquet file once, returning { featureId: [{time, flow_cms}, ...] }
  // for every feature_id in `featureIds` found in the file.
  async function readFeaturesFromFile(fileUrl, featureIds) {
    const { parquetReadObjects, asyncBufferFromUrl, compressors } = await loadHyparquet();
    const file = await asyncBufferFromUrl({ url: fileUrl });
    const rows = await parquetReadObjects({ file, columns: ["feature_id", "time", "flow"], compressors });
    const wanted = new Set(featureIds);
    const out = new Map(featureIds.map((f) => [f, []]));
    rows.forEach((r) => {
      const fid = Number(r.feature_id);
      if (wanted.has(fid)) out.get(fid).push({ time: new Date(r.time), flow_cms: r.flow });
    });
    return out;
  }

  function dailyMeansFromRows(rows, modelKey) {
    const byDate = new Map();
    rows.forEach(({ time, flow_cms }) => {
      const key = toDateKey(time);
      if (!byDate.has(key)) byDate.set(key, []);
      byDate.get(key).push(flow_cms);
    });
    const out = new Map();
    byDate.forEach((values, key) => {
      const meanCms = values.reduce((a, b) => a + b, 0) / values.length;
      out.set(key, { mean_cfs: meanCms * CMS_TO_CFS, n_hours: values.length, source: `medium_range_forecast:${modelKey}` });
    });
    return out;
  }

  function medianRangePrefix(modelKey, runDate, vpu) {
    return `outputs/${modelKey}/v2.2_hydrofabric/ngen.${toYYYYMMDD(runDate)}/medium_range/00/1/${vpu}/ngen-run/outputs/troute/`;
  }

  // The bucket publishes each day's run with a real-world lag (the run for
  // "today" often isn't there yet, especially earlier in the day) - so
  // "the latest forecast" means probing backward for the most recent run
  // that actually exists, not trusting the system clock. Returns the run
  // Date found, or null if nothing turned up within maxLookbackDays.
  async function findLatestAvailableRunDate(vpu, model, fromDate, maxLookbackDays = 5) {
    const modelKey = model && MODELS[model] ? model : DEFAULT_MODEL;
    for (let i = 0; i <= maxLookbackDays; i++) {
      const candidate = addDays(fromDate, -i);
      const files = await listTrouteFiles(medianRangePrefix(modelKey, candidate, vpu));
      if (files.length) return candidate;
    }
    return null;
  }

  // Medium-range forecast for MULTIPLE stations in the same VPU at once:
  // one run (00Z of `runDate`) covers ~10 days forward. Returns
  // Map<featureId, Map<dateKey, {mean_cfs, n_hours, source}>>.
  async function getMediumRangeDailyMeansForFeatures(vpu, featureIds, runDate, model, onProgress) {
    const modelKey = model && MODELS[model] ? model : DEFAULT_MODEL;
    const files = await listTrouteFiles(medianRangePrefix(modelKey, runDate, vpu));

    const rowsByFeature = new Map(featureIds.map((f) => [f, []]));
    let done = 0;
    for (const fileUrl of files) {
      const fileRows = await readFeaturesFromFile(fileUrl, featureIds);
      fileRows.forEach((rows, fid) => rowsByFeature.get(fid).push(...rows));
      done += 1;
      if (onProgress) onProgress(done, files.length);
    }

    const out = new Map();
    rowsByFeature.forEach((rows, fid) => out.set(fid, dailyMeansFromRows(rows, modelKey)));
    return out;
  }

  return {
    CMS_TO_CFS,
    MODELS,
    DEFAULT_MODEL,
    toDateKey,
    addDays,
    findLatestAvailableRunDate,
    getMediumRangeDailyMeansForFeatures,
  };
})();
