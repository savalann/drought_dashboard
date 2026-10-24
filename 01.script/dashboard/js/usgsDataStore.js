// Live USGS daily-discharge observations, fetched directly from the public
// NWIS water services API (no key needed, CORS-enabled) - used for the
// "previous days" side of the Live Status window. Real gage readings, not a
// model estimate, so there's no offline snapshot to keep in sync - every
// run asks USGS fresh. Values already come back in cfs, no unit conversion
// needed (unlike the NWM forecast, which is m3/s).
const UsgsDataStore = (() => {
  const DV_URL = "https://waterservices.usgs.gov/nwis/dv/";
  const PARAM_DISCHARGE = "00060"; // daily mean discharge, ft3/s

  // NWIS rate-limits bursts with a short cooldown, answering 503/429 for a
  // stretch rather than just once - so the retry has to outlast that
  // cooldown, with jitter so repeat attempts don't land in lockstep.
  const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);
  const RETRY_DELAYS_MS = [1500, 4000, 9000, 15000];

  const responseCache = new Map(); // url -> Promise<timeSeries[]> (this page load)
  const STORAGE_PREFIX = "usgs-dv:";
  const STORAGE_TTL_MS = 6 * 60 * 60 * 1000; // published daily values for past days don't change

  function pad2(n) { return String(n).padStart(2, "0"); }
  function toISODate(d) { return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; }
  function addDays(d, n) { const copy = new Date(d.getTime()); copy.setUTCDate(copy.getUTCDate() + n); return copy; }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // Surviving a reload matters here: without it, every refresh re-hits NWIS
  // and makes getting rate-limited more likely, not less.
  function readStored(url, { allowStale = false } = {}) {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + url);
      if (!raw) return null;
      const { storedAt, series } = JSON.parse(raw);
      if (!storedAt) return null;
      if (!allowStale && Date.now() - storedAt > STORAGE_TTL_MS) return null;
      return series;
    } catch { return null; }
  }

  function writeStored(url, series) {
    try {
      localStorage.setItem(STORAGE_PREFIX + url, JSON.stringify({ storedAt: Date.now(), series }));
    } catch {
      // Quota or private-mode - caching is an optimization, never required.
    }
  }

  async function fetchDailyValues(stationIds, startDate, endInclusive) {
    const url = `${DV_URL}?format=json&sites=${stationIds.join(",")}&parameterCd=${PARAM_DISCHARGE}`
      + `&startDT=${toISODate(startDate)}&endDT=${toISODate(endInclusive)}`;
    if (responseCache.has(url)) return responseCache.get(url);

    const stored = readStored(url);
    if (stored) {
      const cached = Promise.resolve(stored);
      responseCache.set(url, cached);
      return cached;
    }

    const promise = (async () => {
      let lastError = null;
      for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
        if (attempt > 0) {
          const base = RETRY_DELAYS_MS[attempt - 1];
          await sleep(base + Math.random() * 1000); // jitter
        }
        let res;
        try {
          res = await fetch(url);
        } catch (networkErr) {
          lastError = networkErr;
          continue;
        }
        if (res.ok) {
          const data = await res.json();
          const series = data?.value?.timeSeries || [];
          writeStored(url, series);
          return series;
        }
        if (res.status === 404) return []; // USGS 404s when a request matches no data at all
        lastError = new Error(`USGS NWIS request failed: ${res.status} ${res.statusText}`.trim());
        if (!TRANSIENT_STATUSES.has(res.status)) break;
      }

      // NWIS is unreachable/throttled right now. A previously-cached copy,
      // even an expired one, is far better than failing outright: these are
      // daily means feeding a 30-day average, so hours-old values barely
      // move the result.
      const stale = readStored(url, { allowStale: true });
      if (stale) {
        console.warn("USGS unreachable - falling back to the last cached observations:", lastError?.message);
        return stale;
      }
      throw lastError;
    })();

    // Don't cache failures - a transient blip shouldn't poison later loads.
    responseCache.set(url, promise);
    promise.catch(() => responseCache.delete(url));
    return promise;
  }

  // Every view in this tab wants some recent window (the monitoring day's
  // 30-day run-up, the forecast's 20-day run-up, ...). Asking NWIS for each
  // one separately means several near-identical requests per page load,
  // which is exactly what trips its rate limiting. Instead, any range that
  // falls inside the recent past is widened to ONE canonical window, so all
  // of them share a single cached request and the result is sliced locally.
  const CANONICAL_WINDOW_DAYS = 60;

  function canonicalRange(startDate, endInclusive) {
    const now = new Date();
    const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const windowStart = addDays(todayUtc, -CANONICAL_WINDOW_DAYS);
    const insideRecentWindow = startDate >= windowStart && endInclusive <= todayUtc;
    return insideRecentWindow ? { start: windowStart, end: todayUtc } : { start: startDate, end: endInclusive };
  }

  // Returns Map<station, Map<dateKey, {mean_cfs, source}>> for calendar
  // days [startDate, endDateExclusive).
  async function getDailyMeansForStations(stationIds, startDate, endDateExclusive) {
    const result = new Map(stationIds.map((s) => [s, new Map()]));
    if (!stationIds.length) return result;

    const endInclusive = addDays(endDateExclusive, -1);
    if (endInclusive < startDate) return result;

    const { start: fetchStart, end: fetchEnd } = canonicalRange(startDate, endInclusive);
    const keepFrom = toISODate(startDate);
    const keepTo = toISODate(endInclusive);
    const series = await fetchDailyValues(stationIds, fetchStart, fetchEnd);
    series.forEach((ts) => {
      const station = ts.sourceInfo?.siteCode?.[0]?.value;
      if (!station || !result.has(station)) return;
      const values = ts.values?.[0]?.value || [];
      values.forEach((v) => {
        const num = Number(v.value);
        if (!Number.isFinite(num) || num < -1e6) return; // USGS uses large negative sentinels for no-data
        const dateKey = v.dateTime.slice(0, 10);
        if (dateKey < keepFrom || dateKey > keepTo) return; // canonical window is wider than asked for
        result.get(station).set(dateKey, { mean_cfs: num, source: "usgs_observed" });
      });
    });

    return result;
  }

  return { getDailyMeansForStations };
})();
