// Click popup content + the right-to-left station detail slide-over.
const Panel = (() => {
  const overlay = document.getElementById("detail-overlay");
  const panel = document.getElementById("detail-panel");
  const content = document.getElementById("detail-content");
  const closeBtn = document.getElementById("detail-close");

  function fmtPct(v) {
    return v === null || v === undefined ? "—" : `${Number(v).toFixed(2)}%`;
  }
  function fmtNum(v) {
    return v === null || v === undefined ? "—" : v;
  }
  function refStatusLabel(isReference) {
    if (isReference === true) return "Reference (GAGES-II)";
    if (isReference === false) return "Non-reference (GAGES-II)";
    return "Not classified in GAGES-II";
  }

  // Content for the Leaflet popup shown on click. Hover only ever shows
  // the station number (see map.js's tooltip binding) - this is the
  // richer click-through view, still lightweight since it uses only
  // fields already in stations.json (no extra fetch on click).
  function popupHtml(station) {
    const totalEvents = Object.values(station.durations)
      .reduce((sum, d) => sum + (d.n_events || 0), 0);
    return `
      <div class="station-popup">
        <h4>${station.station}${station.name ? ` — ${station.name}` : ""}</h4>
        <dl>
          <dt>Analysis period</dt><dd>${station.analysis_period_start.slice(0, 4)}–${(station.analysis_period_end || "").slice(0, 4)}</dd>
          <dt>GAGES-II status</dt><dd>${refStatusLabel(station.is_reference)}</dd>
          <dt>Record length</dt><dd>${station.record_start} → ${station.record_end}</dd>
          <dt>Missing (full record)</dt><dd>${fmtPct(station.pct_missing_full_record)}</dd>
          <dt>Missing (analysis period)</dt><dd>${fmtPct(station.pct_missing_analysis_period)}</dd>
          <dt>Drought events (all durations)</dt><dd>${totalEvents || "—"}</dd>
        </dl>
        ${station.has_analysis
          ? `<button class="btn-detail" data-station="${station.station}">View drought years &amp; SDF curves &rarr;</button>`
          : `<p class="hint">No drought analysis for this station (screening not passed).</p>`}
      </div>`;
  }

  async function openDetail(station) {
    overlay.hidden = false;
    panel.hidden = false;
    requestAnimationFrame(() => panel.classList.add("open"));
    content.innerHTML = `<p class="loading">Loading station ${station.station}…</p>`;

    let detail;
    try {
      detail = await DataStore.getStationDetail(station.station);
    } catch (err) {
      content.innerHTML = `<p class="error">Could not load detail for ${station.station}: ${err.message}</p>`;
      return;
    }

    const durations = Object.keys(station.durations).map(Number).sort((a, b) => a - b);
    const defaultDuration = durations[0];

    content.innerHTML = `
      <h3>${station.station}</h3>
      <p class="muted">${station.name || ""}</p>

      <section class="detail-section">
        <h4>Drought years</h4>
        <label class="field">
          <span>Duration (water-years)</span>
          <select id="detail-duration-select">
            ${durations.map((d) => `<option value="${d}">${d}-year</option>`).join("")}
          </select>
        </label>
        <div class="chart-wrap"><canvas id="chart-drought-years"></canvas></div>
        <p class="hint" id="drought-years-count"></p>
      </section>

      <section class="detail-section">
        <h4>SDF curves (all durations)</h4>
        <div class="chart-wrap chart-wrap-tall"><canvas id="chart-sdf"></canvas></div>
      </section>
    `;

    const select = content.querySelector("#detail-duration-select");
    const countEl = content.querySelector("#drought-years-count");

    function drawDroughtYears(duration) {
      const events = (detail.drought_years[String(duration)] || []).slice();
      Charts.renderDroughtYears(content.querySelector("#chart-drought-years"), events);
      countEl.textContent = `${events.length} drought event(s) identified at the ${duration}-year duration.`;
    }

    select.value = defaultDuration;
    drawDroughtYears(defaultDuration);
    select.addEventListener("change", () => drawDroughtYears(Number(select.value)));

    Charts.renderSdfCurves(content.querySelector("#chart-sdf"), detail.sdf_curves, durations);
  }

  function closeDetail() {
    panel.classList.remove("open");
    overlay.hidden = true;
    setTimeout(() => { panel.hidden = true; }, 200);
  }

  closeBtn.addEventListener("click", closeDetail);
  overlay.addEventListener("click", closeDetail);

  return { popupHtml, openDetail, closeDetail };
})();
