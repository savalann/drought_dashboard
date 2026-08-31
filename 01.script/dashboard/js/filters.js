// Populates and wires the sidebar controls for a "map" tab. Kept separate
// from map.js so the control widgets (and their labels) can change without
// touching rendering logic, and vice versa.
const Filters = (() => {
  const METRIC_LABELS = {
    rp10: "10-year return period",
    rp20: "20-year return period",
    rp50: "50-year return period",
    rp100: "100-year return period",
    median: "Median drought event",
    max: "Max (worst) drought event",
  };

  const METRIC_HINTS = {
    rp10: "Severity expected to be met or exceeded once every 10 years, from the GPD fit.",
    rp20: "Severity expected to be met or exceeded once every 20 years, from the GPD fit.",
    rp50: "Severity expected to be met or exceeded once every 50 years, from the GPD fit.",
    rp100: "Severity expected to be met or exceeded once every 100 years, from the GPD fit.",
    median: "The station's typical (median) observed drought event.",
    max: "The station's single worst observed drought event.",
  };

  function populateSelect(select, options, labelFn) {
    select.innerHTML = options
      .map((opt) => `<option value="${opt}">${labelFn ? labelFn(opt) : opt}</option>`)
      .join("");
  }

  function setup(root, manifest, onChange) {
    const stateSelect = root.querySelector('[data-control="state"]');
    const durationSelect = root.querySelector('[data-control="duration"]');
    const metricSelect = root.querySelector('[data-control="metric"]');
    const referenceSelect = root.querySelector('[data-control="reference-status"]');
    const analysisOnlyCheckbox = root.querySelector('[data-control="analysis-only"]');
    const metricHint = root.querySelector('[data-role="metric-hint"]');
    const legendSwatches = root.querySelector("#legend-swatches");

    populateSelect(stateSelect, manifest.states, (code) => APP_CONFIG.STATE_NAMES?.[code] || code);
    populateSelect(durationSelect, manifest.durations, (d) => `${d}-year rolling window`);
    populateSelect(metricSelect, manifest.metrics, (m) => METRIC_LABELS[m] || m);
    metricSelect.value = "rp10";

    legendSwatches.innerHTML = Colors.legendEntries()
      .map((e) => `<div class="legend-row"><span class="swatch" style="background:${e.color}"></span>${e.label}</div>`)
      .join("") + `<div class="legend-row"><span class="swatch" style="background:${Colors.NO_DATA_COLOR}"></span>No data</div>`;

    function currentState() {
      return {
        state: stateSelect.value,
        duration: Number(durationSelect.value),
        metric: metricSelect.value,
        referenceFilter: referenceSelect.value,
        analysisOnly: analysisOnlyCheckbox.checked,
      };
    }

    function emitChange() {
      metricHint.textContent = METRIC_HINTS[metricSelect.value] || "";
      onChange(currentState());
    }

    [stateSelect, durationSelect, metricSelect, referenceSelect].forEach((el) =>
      el.addEventListener("change", emitChange)
    );
    analysisOnlyCheckbox.addEventListener("change", emitChange);

    emitChange();
    return { getState: currentState };
  }

  return { setup };
})();
