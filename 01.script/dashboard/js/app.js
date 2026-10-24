// Bootstraps the tab bar from APP_CONFIG.TABS and wires up whichever tab
// type each one declares. Adding a tab is a config.js edit, not a change
// here, as long as it's one of the existing `type`s (or a new `renderX`
// case is added below for a genuinely new tab type).
(async function main() {
  const tabBar = document.getElementById("tab-bar");
  const tabPanels = document.getElementById("tab-panels");
  const mapInvalidators = new Map(); // tab id -> fn to call on activation (Leaflet needs its container visible/sized first)

  let manifest;
  try {
    manifest = await DataStore.getManifest();
  } catch (err) {
    tabPanels.innerHTML = `<p class="error">Could not load dashboard data: ${err.message}. Is a local server running from the project root?</p>`;
    return;
  }

  Colors.setBins(manifest.severity_bins);
  document.getElementById("generated-at").textContent = `Data generated ${manifest.generated_at}`;

  APP_CONFIG.TABS.forEach((tab, i) => {
    const btn = document.createElement("button");
    btn.className = "tab-btn";
    btn.textContent = tab.label;
    btn.setAttribute("role", "tab");
    btn.dataset.tabId = tab.id;
    btn.addEventListener("click", () => activateTab(tab.id));
    tabBar.appendChild(btn);

    const panel = document.createElement("div");
    panel.className = "tab-panel";
    panel.id = `tab-panel-${tab.id}`;
    panel.hidden = i !== 0;
    tabPanels.appendChild(panel);

    if (tab.type === "map") renderMapTab(tab, panel);
    else if (tab.type === "placeholder") renderPlaceholderTab(tab, panel);
    else if (tab.type === "live-analysis") renderLiveAnalysisTab(tab, panel);
  });

  activateTab(APP_CONFIG.TABS[0].id);

  function activateTab(tabId) {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tabId === tabId));
    document.querySelectorAll(".tab-panel").forEach((p) => { p.hidden = p.id !== `tab-panel-${tabId}`; });
    const invalidate = mapInvalidators.get(tabId);
    if (invalidate) requestAnimationFrame(invalidate);
  }

  function renderPlaceholderTab(tab, panel) {
    const tpl = document.getElementById("tpl-placeholder-tab").content.cloneNode(true);
    tpl.querySelector('[data-role="title"]').textContent = tab.title;
    tpl.querySelector('[data-role="body"]').textContent = tab.body;
    panel.appendChild(tpl);
  }

  function renderMapTab(tab, panel) {
    const tpl = document.getElementById("tpl-map-tab").content.cloneNode(true);
    panel.appendChild(tpl);

    const stateManifest = { ...manifest, states: manifest.states.filter((s) => s === tab.state || !tab.state) };
    const stations = manifest.stations.filter((s) => !tab.state || s.state === tab.state);

    const mapId = `map-${tab.id}`;
    panel.querySelector("#map").id = mapId;
    DroughtMap.init(mapId, tab.state);
    DroughtMap.setStations(stations);

    Filters.setup(panel, stateManifest, (filterState) => {
      const { shown, analyzed } = DroughtMap.render(filterState);
      panel.querySelector("#stat-total").textContent = shown;
      panel.querySelector("#stat-analyzed").textContent = analyzed;
    });

    mapInvalidators.set(tab.id, () => DroughtMap.invalidateSize());
  }

  function renderLiveAnalysisTab(tab, panel) {
    const tpl = document.getElementById("tpl-live-analysis-tab").content.cloneNode(true);
    panel.appendChild(tpl);
    const stateManifest = { ...manifest, stations: manifest.stations.filter((s) => !tab.state || s.state === tab.state) };
    LiveAnalysis.setup(panel, stateManifest);
    mapInvalidators.set(tab.id, () => LiveAnalysis.invalidateSize());
  }
})();
