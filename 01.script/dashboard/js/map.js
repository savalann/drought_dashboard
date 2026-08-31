// Leaflet map: station markers, hover = station number only, click = popup
// with the fuller station summary and a link into the detail slide-over.
const DroughtMap = (() => {
  let map = null;
  let markerLayer = null;
  let allStations = [];

  const STATE_BOUNDS = {
    AL: [[30.1, -88.6], [35.1, -84.7]],
  };

  function init(containerId, stateCode) {
    map = L.map(containerId, { zoomControl: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);

    markerLayer = L.layerGroup().addTo(map);
    fitToState(stateCode);
  }

  function fitToState(stateCode) {
    const bounds = STATE_BOUNDS[stateCode];
    if (bounds) map.fitBounds(bounds);
  }

  function setStations(stations) {
    allStations = stations.filter((s) => s.lat !== null && s.lon !== null);
  }

  function severityFor(station, duration, metric) {
    const bucket = station.durations[String(duration)];
    return bucket ? bucket[metric] : null;
  }

  function render({ duration, metric, referenceFilter, analysisOnly }) {
    markerLayer.clearLayers();
    let shown = 0;
    let analyzed = 0;

    allStations.forEach((station) => {
      if (analysisOnly && !station.has_analysis) return;
      if (referenceFilter === "reference" && station.is_reference !== true) return;
      if (referenceFilter === "non-reference" && station.is_reference !== false) return;
      if (referenceFilter === "unclassified" && station.is_reference !== null) return;

      const severity = severityFor(station, duration, metric);
      const color = Colors.colorFor(severity);
      if (severity !== null && severity !== undefined) analyzed += 1;
      shown += 1;

      const marker = L.circleMarker([station.lat, station.lon], {
        radius: 6,
        color: "#333",
        weight: 1,
        fillColor: color,
        fillOpacity: 0.9,
      });

      marker.bindTooltip(station.station, { direction: "top", offset: [0, -4] });
      marker.bindPopup(Panel.popupHtml(station), { maxWidth: 320 });
      marker.on("popupopen", (e) => {
        const btn = e.popup.getElement().querySelector(".btn-detail");
        if (btn) btn.addEventListener("click", () => Panel.openDetail(station));
      });

      marker.addTo(markerLayer);
    });

    return { shown, analyzed };
  }

  function invalidateSize() {
    if (map) map.invalidateSize();
  }

  return { init, setStations, render, fitToState, invalidateSize };
})();
