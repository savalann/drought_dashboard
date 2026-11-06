// Operational NWM v3.0 medium-range forecasts, pre-downloaded from the CIROH NWM
// API by 01.script/nwm_forecast/download_medium_range.py into small daily-mean
// Parquet files (one per run day, all stations):
//   <NWM_FORECAST_BASE_URL>/daily/medium_range/<cycle>/<member>/<region>/YYYYMMDD.parquet
// columns: usgs_id, comid, reference_time, date, n_hours, streamflow_cms, streamflow_cfs, velocity_ms
// Each file is ~8 KB, so this is a single small fetch instead of a live model download.
const NwmDailyStore = (() => {
  const FORECAST_TYPE = "medium_range";
  const CYCLE = "00";
  const MEMBER = "0"; // API ensemble 0 == NWM medium_range_mem1
  const REGION = "alabama";
  const MIN_HOURS_PER_DAY = 20; // skip the partial first/last day of a run, as the other sources do
  // First day every cycle is NWM v3.0; the downloader starts here.
  const FIRST_DAY = "2023-09-20";

  const fileCache = new Map(); // url -> Promise<rows[] | null>

  function pad2(n) { return String(n).padStart(2, "0"); }
  function toYYYYMMDD(d) { return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`; }

  function fileUrl(runDate) {
    return `${APP_CONFIG.NWM_FORECAST_BASE_URL}/daily/${FORECAST_TYPE}/${CYCLE}/${MEMBER}/${REGION}/${toYYYYMMDD(runDate)}.parquet`;
  }

  // Resolves to the file's rows, or null when no file was downloaded for that day.
  function readFile(runDate) {
    const url = fileUrl(runDate);
    if (!fileCache.has(url)) {
      fileCache.set(url, (async () => {
        const res = await fetch(url);
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`Could not load ${url}: ${res.status}`);
        const { parquetReadObjects, compressors } = await NwmDataStore.loadHyparquet();
        return parquetReadObjects({ file: await res.arrayBuffer(), compressors });
      })());
      fileCache.get(url).catch(() => fileCache.delete(url));
    }
    return fileCache.get(url);
  }

  async function findLatestRunDate(fromDate, maxLookbackDays = 5) {
    for (let i = 0; i <= maxLookbackDays; i++) {
      const candidate = NwmDataStore.addDays(fromDate, -i);
      if (NwmDataStore.toDateKey(candidate) < FIRST_DAY) return null;
      if (await readFile(candidate)) return candidate;
    }
    return null;
  }

  // Returns Map<station, Map<dateKey, {mean_cfs, n_hours, source}>>.
  async function getMediumRangeDailyMeans(stationIds, runDate) {
    const rows = (await readFile(runDate)) || [];
    const out = new Map(stationIds.map((s) => [s, new Map()]));
    rows.forEach((r) => {
      if (!out.has(r.usgs_id) || r.n_hours < MIN_HOURS_PER_DAY || r.streamflow_cfs === null) return;
      const dateKey = new Date(r.date).toISOString().slice(0, 10);
      out.get(r.usgs_id).set(dateKey, { mean_cfs: r.streamflow_cfs, n_hours: r.n_hours, source: "medium_range_forecast:nwm_v3" });
    });
    return out;
  }

  return { FIRST_DAY, findLatestRunDate, getMediumRangeDailyMeans };
})();
