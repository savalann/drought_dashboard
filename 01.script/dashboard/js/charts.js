// Chart.js builders for the station detail panel: a per-duration drought
// year timeline, and the severity-duration-frequency (SDF) curve.
const Charts = (() => {
  const DURATION_PALETTE = [
    "#1b9e77", "#d95f02", "#7570b3", "#e7298a", "#66a61e",
    "#e6ab02", "#a6761d", "#666666", "#1f78b4",
  ];

  let droughtYearsChart = null;
  let sdfChart = null;

  function destroy(chart) {
    if (chart) chart.destroy();
  }

  function renderDroughtYears(canvas, events) {
    destroy(droughtYearsChart);
    const years = events.map((e) => e.water_year);
    const severities = events.map((e) => e.severity_pct);

    droughtYearsChart = new Chart(canvas, {
      type: "bar",
      data: {
        labels: years,
        datasets: [{
          label: "Severity (% below baseline flow)",
          data: severities,
          backgroundColor: severities.map((s) => Colors.colorFor(s)),
          borderRadius: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => `Water year ${ctx.label}: ${ctx.parsed.y.toFixed(1)}%`,
            },
          },
        },
        scales: {
          x: { title: { display: true, text: "Water year" } },
          y: {
            title: { display: true, text: "Severity (%)" },
            reverse: false,
          },
        },
      },
    });
  }

  function renderSdfCurves(canvas, sdfCurves, durations) {
    destroy(sdfChart);
    const datasets = [];

    durations.forEach((d, i) => {
      const curve = sdfCurves[String(d)];
      if (!curve) return;
      const color = DURATION_PALETTE[i % DURATION_PALETTE.length];

      if (curve.gpd) {
        datasets.push({
          label: `${d}-yr duration (GPD fit)`,
          data: curve.gpd.map((p) => ({ x: p.return_period_years, y: p.severity_pct })),
          borderColor: color,
          backgroundColor: color,
          pointRadius: 0,
          borderWidth: 2,
          tension: 0.15,
          showLine: true,
        });
      }
      if (curve.empirical && curve.empirical.length) {
        datasets.push({
          label: `${d}-yr duration (observed events)`,
          data: curve.empirical.map((p) => ({ x: p.return_period_years, y: p.severity_pct })),
          borderColor: color,
          backgroundColor: color,
          pointRadius: 3,
          showLine: false,
        });
      }
    });

    sdfChart = new Chart(canvas, {
      type: "scatter",
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 10 } } },
          tooltip: {
            callbacks: {
              label: (ctx) =>
                `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}% at ${ctx.parsed.x.toFixed(1)}-yr`,
            },
          },
        },
        scales: {
          x: {
            type: "logarithmic",
            title: { display: true, text: "Return period (years)" },
          },
          y: {
            title: { display: true, text: "Severity (% below baseline flow)" },
          },
        },
      },
    });
  }

  return { renderDroughtYears, renderSdfCurves };
})();
