// Fetch + cache layer. Every other module reads data through here instead
// of calling fetch() directly, so the local-vs-S3 switch in config.js and
// the per-station lazy loading stay in one place.
const DataStore = (() => {
  let manifestPromise = null;
  const stationDetailCache = new Map();

  async function fetchJson(path) {
    const res = await fetch(path);
    if (!res.ok) {
      throw new Error(`Failed to load ${path}: ${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  function getManifest() {
    if (!manifestPromise) {
      manifestPromise = fetchJson(`${APP_CONFIG.DATA_BASE_URL}/stations.json`);
    }
    return manifestPromise;
  }

  async function getStationDetail(stationId) {
    if (stationDetailCache.has(stationId)) {
      return stationDetailCache.get(stationId);
    }
    const detail = await fetchJson(`${APP_CONFIG.DATA_BASE_URL}/stations/${stationId}.json`);
    stationDetailCache.set(stationId, detail);
    return detail;
  }

  const q90Cache = new Map();
  async function getQ90Thresholds(stationId) {
    if (q90Cache.has(stationId)) {
      return q90Cache.get(stationId);
    }
    const thresholds = await fetchJson(`${APP_CONFIG.DATA_BASE_URL}/q90_thresholds/${stationId}.json`);
    q90Cache.set(stationId, thresholds);
    return thresholds;
  }

  let droughtStatusManifestPromise = null;
  function getDroughtStatusManifest() {
    if (!droughtStatusManifestPromise) {
      droughtStatusManifestPromise = fetchJson(`${APP_CONFIG.DATA_BASE_URL}/drought_status_history.json`);
    }
    return droughtStatusManifestPromise;
  }

  const droughtStatusYearCache = new Map();
  async function getDroughtStatusYear(year) {
    if (droughtStatusYearCache.has(year)) {
      return droughtStatusYearCache.get(year);
    }
    const data = await fetchJson(`${APP_CONFIG.DATA_BASE_URL}/drought_status_history/${year}.json`);
    droughtStatusYearCache.set(year, data);
    return data;
  }

  return {
    getManifest, getStationDetail, getQ90Thresholds,
    getDroughtStatusManifest, getDroughtStatusYear,
  };
})();
