// "Live Status (Beta)" tab: a map of every qualifying station's Q90
// low-flow status, same interaction language as the Alabama drought map
// (state/GAGES-II filters on the left, hover = station number, colored
// dots = status, summary counts) - but split into two independent views:
//
//   - "Today / previous days": pick any day from the monitored history
//     (1980 -> now). Anything already pre-computed by
//     build_drought_status_history.py is read straight out of one small
//     per-year JSON file - instant, no live fetch. Only the gap between
//     that pre-computed cutoff and today is computed live, by fetching the
//     missing days from real USGS observations and re-using the SAME
//     already-computed Q90 thresholds.
//   - "10-day prediction": a separate, explicit action (it's a much
//     heavier fetch) that pulls the NWM medium-range forecast and lists
//     each of the next 10 days; clicking one shows that day on the map.
//
// Every plain JS module here runs only in the visitor's browser, on
// demand. The only Python in this project (compute_q90_thresholds.py,
// build_drought_status_history.py, build_nwm_crosswalk.py, build_dataset.py)
// runs once, offline, ahead of time, to produce the static JSON these
// modules read - never triggered by a user action.
const LiveAnalysis = (() => {
  const TRAILING_WINDOW = 30;
  const MIN_WINDOW_FOR_COMPARISON = 20;
  const NORMAL_COLOR = "#3aa655";
  // Pre-downloaded operational NWM v3.0 (NwmDailyStore); NRDS models go through NwmDataStore.
  const NWM_V3_MODEL = "nwm_v3_daily";
  const NWM_V3_LABEL = "NWM v3.0 operational (pre-downloaded, Sep 2023 - now)";

  let map = null;
  let markerLayer = null;
  let hasFitBounds = false;

  let stations = [];
  let stationsById = new Map();
  let thresholdsByStation = new Map(); // station -> thresholds_cfs ({"MM-DD": cfs})
  let statusManifest = null;

  let currentView = null; // { resultsByStation: Map<station, {q30_cfs, is_below_q90}>, label }
  let filterState = { referenceFilter: "all" };

  function monthDay(dateKey) { return dateKey.slice(5); }

  function colorForResult(result) {
    if (!result || result.is_below_q90 === null || result.is_below_q90 === undefined) return Colors.NO_DATA_COLOR;
    if (!result.is_below_q90) return NORMAL_COLOR;
    const pctBelow = ((result.q90_threshold_cfs - result.q30_cfs) / result.q90_threshold_cfs) * 100;
    return Colors.colorFor(pctBelow);
  }

  // ---- Map ------------------------------------------------------------

  const ALABAMA_BOUNDS = [[30.1, -88.6], [35.1, -84.7]];

  function initMap(containerId) {
    map = L.map(containerId, { zoomControl: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    markerLayer = L.layerGroup().addTo(map);
  }

  function invalidateSize() {
    if (!map) return;
    map.invalidateSize();
    if (!hasFitBounds) {
      map.fitBounds(ALABAMA_BOUNDS);
      hasFitBounds = true;
    }
  }

  function passesFilter(station) {
    if (filterState.referenceFilter === "reference") return station.is_reference === true;
    if (filterState.referenceFilter === "non-reference") return station.is_reference === false;
    if (filterState.referenceFilter === "unclassified") return station.is_reference === null;
    return true;
  }

  function renderCurrentView(root) {
    markerLayer.clearLayers();
    let shown = 0;
    let below = 0;
    if (currentView) {
      stations.forEach((station) => {
        if (!passesFilter(station)) return;
        const result = currentView.resultsByStation.get(station.station);
        shown += 1;
        if (result && result.is_below_q90) below += 1;

        const marker = L.circleMarker([station.lat, station.lon], {
          radius: 7,
          color: "#333",
          weight: 1,
          fillColor: colorForResult(result),
          fillOpacity: 0.9,
        });
        marker.bindTooltip(station.station, { direction: "top", offset: [0, -4] });
        marker.bindPopup(`<div class="station-popup"><h4>${station.station}</h4><p>Station detail - coming soon.</p></div>`);
        marker.addTo(markerLayer);
      });
    }
    root.querySelector("#live-stat-total").textContent = shown;
    root.querySelector("#live-stat-below").textContent = below;
    root.querySelector("#live-analysis-summary").textContent = currentView ? currentView.label : "Pick a day to get started.";
  }

  // ---- Q90 comparison helper -------------------------------------------

  function evaluate(q30, dateKey, station) {
    const thresholds = thresholdsByStation.get(station);
    const threshold = thresholds ? (thresholds[monthDay(dateKey)] ?? null) : null;
    const comparable = q30 !== null && threshold !== null;
    return {
      q30_cfs: q30,
      q90_threshold_cfs: threshold,
      is_below_q90: comparable ? q30 < threshold : null,
    };
  }

  // ---- "Today / previous days" ------------------------------------------

  async function loadMonitoringDay(root, dateKey) {
    const errorEl = root.querySelector("#live-analysis-monitor-error");
    errorEl.hidden = true;
    try {
      const year = Number(dateKey.slice(0, 4));
      const resultsByStation = new Map();

      if (dateKey <= statusManifest.last_computed_date) {
        const yearData = await DataStore.getDroughtStatusYear(year);
        const idx = yearData.dates.indexOf(dateKey);
        stations.forEach((s) => {
          const stationYear = yearData.stations[s.station];
          const q30 = idx >= 0 && stationYear ? stationYear.q30_cfs[idx] : null;
          const isBelow = idx >= 0 && stationYear ? stationYear.is_below_q90[idx] : null;
          const thresholds = thresholdsByStation.get(s.station) || {};
          resultsByStation.set(s.station, {
            q30_cfs: q30,
            q90_threshold_cfs: thresholds[monthDay(dateKey)] ?? null,
            is_below_q90: isBelow,
          });
        });
        currentView = { resultsByStation, label: `${dateKey} - from pre-computed history.` };
      } else {
        const centerDate = new Date(`${dateKey}T00:00:00Z`);
        const startDate = NwmDataStore.addDays(centerDate, -(TRAILING_WINDOW - 1));
        const endExclusive = NwmDataStore.addDays(centerDate, 1);
        const usgsMeans = await UsgsDataStore.getDailyMeansForStations(
          stations.map((s) => s.station), startDate, endExclusive,
        );
        stations.forEach((s) => {
          const series = usgsMeans.get(s.station) || new Map();
          const values = [];
          for (let d = startDate; d < endExclusive; d = NwmDataStore.addDays(d, 1)) {
            const entry = series.get(NwmDataStore.toDateKey(d));
            if (entry) values.push(entry.mean_cfs);
          }
          const q30 = values.length >= MIN_WINDOW_FOR_COMPARISON
            ? values.reduce((a, b) => a + b, 0) / values.length
            : null;
          resultsByStation.set(s.station, evaluate(q30, dateKey, s.station));
        });
        currentView = { resultsByStation, label: `${dateKey} - computed live from USGS (not yet in pre-computed history).` };
      }
    } catch (err) {
      errorEl.hidden = false;
      errorEl.textContent = `Could not load ${dateKey}: ${err.message}`;
      console.error(err);
      currentView = null;
    }
    renderCurrentView(root);
  }

  // ---- "10-day prediction" ----------------------------------------------

  function buildDailySeries(usgsMeans, nwmMeans, centerDate) {
    const offsets = Array.from({ length: TRAILING_WINDOW }, (_, i) => i - 20);
    return offsets.map((i) => {
      const d = NwmDataStore.addDays(centerDate, i);
      const key = NwmDataStore.toDateKey(d);
      const entry = i < 0 ? usgsMeans.get(key) : nwmMeans.get(key);
      return { date: key, mean_cfs: entry ? entry.mean_cfs : null };
    });
  }

  function withTrailingMeans(days) {
    return days.map((day, i) => {
      const windowSlice = days.slice(Math.max(0, i - TRAILING_WINDOW + 1), i + 1);
      const valid = windowSlice.map((d) => d.mean_cfs).filter((v) => v !== null);
      const q30 = valid.length >= MIN_WINDOW_FOR_COMPARISON
        ? valid.reduce((a, b) => a + b, 0) / valid.length
        : null;
      return { ...day, q30_cfs: q30 };
    });
  }

  async function loadPredictions(root) {
    const progressEl = root.querySelector("#live-analysis-predict-progress");
    const errorEl = root.querySelector("#live-analysis-predict-error");
    const listEl = root.querySelector("#live-analysis-predictions-list");
    const btn = root.querySelector("#live-analysis-load-predictions");
    const model = root.querySelector("#live-analysis-model-select").value;
    const requestedDateStr = root.querySelector("#live-analysis-predict-rundate").value;

    errorEl.hidden = true;
    listEl.hidden = true;
    btn.disabled = true;
    progressEl.hidden = false;
    progressEl.textContent = "Fetching observed run-up from USGS…";

    try {
      const today = new Date();
      const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
      const [ry, rm, rd] = (requestedDateStr || todayUtc.toISOString().slice(0, 10)).split("-").map(Number);
      const requestedDate = new Date(Date.UTC(ry, rm - 1, rd));

      const byVpu = new Map();
      stations.forEach((s) => {
        if (!byVpu.has(s.nwm.vpu)) byVpu.set(s.nwm.vpu, []);
        byVpu.get(s.nwm.vpu).push(s);
      });

      // The bucket publishes each day's run with a real-world lag (the
      // requested day's run may not exist, whether that's "today" or an
      // explicitly picked past date) - probe backward per VPU for the
      // latest one on or before the requested date that actually exists,
      // and anchor the whole window to the OLDEST of those so every VPU's
      // data is genuinely available.
      progressEl.textContent = "Finding the latest available forecast run…";
      const isNwmV3 = model === NWM_V3_MODEL;
      let centerDate = null;
      if (isNwmV3) {
        centerDate = await NwmDailyStore.findLatestRunDate(requestedDate);
        if (!centerDate) {
          throw new Error(`No pre-downloaded NWM v3.0 forecast on or within 5 days before ${requestedDateStr} `
            + `(available from ${NwmDailyStore.FIRST_DAY}).`);
        }
      } else {
        for (const vpu of byVpu.keys()) {
          const found = await NwmDataStore.findLatestAvailableRunDate(vpu, model, requestedDate);
          if (!found) throw new Error(`No medium-range run found for ${vpu} on or before ${requestedDateStr}.`);
          if (centerDate === null || found < centerDate) centerDate = found;
        }
      }
      if (NwmDataStore.toDateKey(centerDate) !== requestedDateStr) {
        progressEl.textContent = `${requestedDateStr} has no published run yet - using the latest available, ${NwmDataStore.toDateKey(centerDate)}. Fetching observed run-up from USGS…`;
      } else {
        progressEl.textContent = "Fetching observed run-up from USGS…";
      }

      const usgsStart = NwmDataStore.addDays(centerDate, -20);
      const usgsMeansByStation = await UsgsDataStore.getDailyMeansForStations(
        stations.map((s) => s.station), usgsStart, centerDate,
      );

      const nwmMeansByStation = new Map();
      if (isNwmV3) {
        progressEl.textContent = "Loading pre-downloaded NWM v3.0 forecast…";
        const means = await NwmDailyStore.getMediumRangeDailyMeans(stations.map((s) => s.station), centerDate);
        means.forEach((v, station) => nwmMeansByStation.set(station, v));
      }
      let vpusDone = 0;
      for (const [vpu, vpuStations] of isNwmV3 ? [] : byVpu) {
        progressEl.textContent = `Fetching medium-range forecast for ${vpu} (${vpusDone + 1}/${byVpu.size} regions)…`;
        const featureIds = vpuStations.map((s) => s.nwm.feature_id);
        const means = await NwmDataStore.getMediumRangeDailyMeansForFeatures(
          vpu, featureIds, centerDate, model,
          (done, total) => { progressEl.textContent = `Fetching medium-range forecast for ${vpu}: ${done}/${total} files…`; },
        );
        vpuStations.forEach((s) => nwmMeansByStation.set(s.station, means.get(s.nwm.feature_id) || new Map()));
        vpusDone += 1;
      }

      const seriesByStation = new Map();
      stations.forEach((s) => {
        const usgsMeans = usgsMeansByStation.get(s.station) || new Map();
        const nwmMeans = nwmMeansByStation.get(s.station) || new Map();
        let days = buildDailySeries(usgsMeans, nwmMeans, centerDate);
        days = withTrailingMeans(days);
        seriesByStation.set(s.station, days);
      });

      const predictionDays = Array.from({ length: 10 }, (_, i) => {
        const dateKey = NwmDataStore.toDateKey(NwmDataStore.addDays(centerDate, i));
        const resultsByStation = new Map();
        stations.forEach((s) => {
          const day = seriesByStation.get(s.station)[20 + i];
          resultsByStation.set(s.station, evaluate(day.q30_cfs, dateKey, s.station));
        });
        return { date: dateKey, dayOffset: i, resultsByStation };
      });

      const centerMatchedRequest = NwmDataStore.toDateKey(centerDate) === requestedDateStr;
      const centerIsToday = NwmDataStore.toDateKey(centerDate) === NwmDataStore.toDateKey(todayUtc);
      const day0Tag = !centerMatchedRequest ? "latest available" : centerIsToday ? "today" : "selected day";
      const day0Word = !centerMatchedRequest ? "latest-available-run" : centerIsToday ? "today's" : "selected-day";

      listEl.innerHTML = predictionDays.map((pd) => {
        const belowCount = [...pd.resultsByStation.values()].filter((r) => r.is_below_q90).length;
        return `<li><button class="prediction-row" data-date="${pd.date}">
          <span class="prediction-date">${pd.date}</span>
          <span class="prediction-tag">${pd.dayOffset === 0 ? day0Tag : `+${pd.dayOffset}d`}</span>
          <span class="prediction-count">${belowCount}/${stations.length} below Q90</span>
        </button></li>`;
      }).join("");
      listEl.hidden = false;

      listEl.querySelectorAll(".prediction-row").forEach((btnEl) => {
        btnEl.addEventListener("click", () => {
          listEl.querySelectorAll(".prediction-row").forEach((b) => b.classList.remove("active"));
          btnEl.classList.add("active");
          const pd = predictionDays.find((p) => p.date === btnEl.dataset.date);
          const modelLabel = model === NWM_V3_MODEL ? "NWM v3.0 operational" : (NwmDataStore.MODELS[model]?.label || model);
          currentView = {
            resultsByStation: pd.resultsByStation,
            label: `${pd.date} - ${pd.dayOffset === 0 ? day0Word : `+${pd.dayOffset}-day`} forecast (NWM medium-range, ${modelLabel}).`,
          };
          renderCurrentView(root);
        });
      });

      listEl.querySelector(".prediction-row").click();
    } catch (err) {
      errorEl.hidden = false;
      const throttled = /\b(429|500|502|503|504)\b/.test(err.message);
      errorEl.textContent = throttled
        ? `USGS is throttling requests right now (${err.message}). This is on their end and usually clears in a minute - press "Load prediction" again.`
        : `Could not load predictions: ${err.message}`;
      console.error(err);
    } finally {
      progressEl.hidden = true;
      btn.disabled = false;
    }
  }

  // ---- Setup --------------------------------------------------------------

  function setup(root, manifest) {
    stations = manifest.stations.filter((s) => s.has_q90_analysis && s.nwm);
    stations.forEach((s) => stationsById.set(s.station, s));

    const stateSelect = root.querySelector('[data-control="state"]');
    stateSelect.innerHTML = manifest.states.map((c) => `<option value="${c}">${APP_CONFIG.STATE_NAMES?.[c] || c}</option>`).join("");

    const referenceSelect = root.querySelector('[data-control="reference-status"]');
    referenceSelect.addEventListener("change", () => {
      filterState.referenceFilter = referenceSelect.value;
      renderCurrentView(root);
    });

    const modelSelect = root.querySelector("#live-analysis-model-select");
    modelSelect.innerHTML = Object.entries(NwmDataStore.MODELS)
      .map(([key, m]) => `<option value="${key}">${m.label}</option>`).join("")
      + `<option value="${NWM_V3_MODEL}">${NWM_V3_LABEL}</option>`;
    modelSelect.value = NwmDataStore.DEFAULT_MODEL;

    const predictRunDateInput = root.querySelector("#live-analysis-predict-rundate");
    const todayStr = new Date().toISOString().slice(0, 10);
    predictRunDateInput.value = todayStr;
    predictRunDateInput.max = todayStr;

    const legend = root.querySelector("#live-analysis-legend");
    legend.innerHTML = `<div class="legend-row"><span class="swatch" style="background:${NORMAL_COLOR}"></span>At/above Q90 (normal)</div>`
      + Colors.legendEntries().map((e) => `<div class="legend-row"><span class="swatch" style="background:${e.color}"></span>${e.label} below Q90</div>`).join("")
      + `<div class="legend-row"><span class="swatch" style="background:${Colors.NO_DATA_COLOR}"></span>Insufficient data</div>`;

    initMap(root.querySelector("#live-analysis-map").id);

    const dateInput = root.querySelector("#live-analysis-date");
    const dateHint = root.querySelector("#live-analysis-date-hint");

    Promise.all([
      Promise.all(stations.map(async (s) => {
        const t = await DataStore.getQ90Thresholds(s.station);
        thresholdsByStation.set(s.station, t.thresholds_cfs);
      })),
      DataStore.getDroughtStatusManifest().then((m) => { statusManifest = m; }),
    ]).then(() => {
      const today = new Date().toISOString().slice(0, 10);
      dateInput.min = statusManifest.monitoring_period_start;
      dateInput.max = today;
      dateInput.value = today;
      dateHint.textContent = `Pre-computed through ${statusManifest.last_computed_date}; later days are computed live from USGS.`;
      dateInput.addEventListener("change", () => { if (dateInput.value) loadMonitoringDay(root, dateInput.value); });
      loadMonitoringDay(root, today);
    }).catch((err) => {
      dateHint.textContent = `Could not load Q90 thresholds/history manifest: ${err.message}`;
    });

    root.querySelector("#live-analysis-load-predictions").addEventListener("click", () => loadPredictions(root));
  }

  return { setup, invalidateSize };
})();
