// Severity-magnitude -> color, using the bins build_dataset.py wrote into
// stations.json (so the legend and the map always agree with the data,
// even if the bin edges change later).
const Colors = (() => {
  const NO_DATA_COLOR = "#b0b0b0";

  let bins = [];

  function setBins(severityBins) {
    bins = severityBins;
  }

  // severityPct is the raw signed value (droughts are negative); the bins
  // are defined on magnitude.
  function colorFor(severityPct) {
    if (severityPct === null || severityPct === undefined || Number.isNaN(severityPct)) {
      return NO_DATA_COLOR;
    }
    const magnitude = Math.abs(severityPct);
    for (const bin of bins) {
      const withinLower = magnitude >= bin.min;
      const withinUpper = bin.max === null || magnitude < bin.max;
      if (withinLower && withinUpper) return bin.color;
    }
    return bins.length ? bins[bins.length - 1].color : NO_DATA_COLOR;
  }

  function legendEntries() {
    return bins.map((bin) => ({
      label: bin.max === null ? `> ${bin.min}%` : `${bin.min}–${bin.max}%`,
      color: bin.color,
    }));
  }

  return { setBins, colorFor, legendEntries, NO_DATA_COLOR };
})();
