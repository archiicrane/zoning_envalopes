const config = window.APP_CONFIG || {};
if (!config.mapboxToken || config.mapboxToken.includes("YOUR_MAPBOX")) {
  alert("Missing Mapbox token. Add it to web/config.js");
}

mapboxgl.accessToken = config.mapboxToken;

const map = new mapboxgl.Map({
  container: "map",
  style: "mapbox://styles/mapbox/light-v11",
  center: [-73.989358, 40.678785],
  zoom: 16,
  pitch: 50,
  bearing: -17,
  antialias: true,
});

const report = document.getElementById("report");
const coverageInput = document.getElementById("coverage");
const covVal = document.getElementById("covVal");

coverageInput.addEventListener("input", () => {
  covVal.textContent = `${coverageInput.value}%`;
});

let activeLotPolygon = null;

function setReport(text) {
  report.textContent = text;
}

function ensureSourceAndLayers() {
  if (!map.getSource("envelopes")) {
    map.addSource("envelopes", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });

    map.addLayer({
      id: "envelope-fill",
      type: "fill-extrusion",
      source: "envelopes",
      paint: {
        "fill-extrusion-color": ["get", "color"],
        "fill-extrusion-height": ["get", "height_ft"],
        "fill-extrusion-base": 0,
        "fill-extrusion-opacity": ["get", "opacity"],
      },
    });

    map.addLayer({
      id: "envelope-outline",
      type: "line",
      source: "envelopes",
      paint: {
        "line-color": "#0f172a",
        "line-width": 1,
      },
    });
  }
}

async function lookupLot() {
  const borough = document.getElementById("borough").value.trim();
  const block = document.getElementById("block").value.trim();
  const lot = document.getElementById("lot").value.trim();

  setReport("Looking up lot...");

  const res = await fetch(`/api/lot/${encodeURIComponent(borough)}/${encodeURIComponent(block)}/${encodeURIComponent(lot)}`);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Lot lookup failed: ${txt}`);
  }

  const data = await res.json();

  // Starter polygon around map center for visual prototype.
  const c = map.getCenter();
  const d = 0.00035;
  activeLotPolygon = [
    [c.lng - d, c.lat - d],
    [c.lng + d, c.lat - d],
    [c.lng + d, c.lat + d],
    [c.lng - d, c.lat + d],
    [c.lng - d, c.lat - d],
  ];

  setReport(JSON.stringify(data, null, 2));
  return data;
}

async function generateEnvelopes() {
  if (!activeLotPolygon) {
    throw new Error("Lookup a lot first so we have a base polygon.");
  }

  const payload = {
    lot_polygon: activeLotPolygon,
    use_type: document.getElementById("useType").value,
    far_mode: document.getElementById("farMode").checked,
    lot_coverage: Number(document.getElementById("coverage").value) / 100,
    floor_height_ft: Number(document.getElementById("floorHeight").value),
    zoning_far: 3.0,
    max_height_ft: 180,
  };

  setReport("Generating envelopes...");

  const res = await fetch("/api/envelope", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Envelope request failed: ${txt}`);
  }

  const data = await res.json();
  ensureSourceAndLayers();
  map.getSource("envelopes").setData(data.geojson);

  setReport(JSON.stringify(data.results, null, 2));
}

document.getElementById("lookupBtn").addEventListener("click", async () => {
  try {
    await lookupLot();
  } catch (err) {
    setReport(String(err));
  }
});

document.getElementById("runBtn").addEventListener("click", async () => {
  try {
    await generateEnvelopes();
  } catch (err) {
    setReport(String(err));
  }
});

map.on("load", () => {
  setReport("Map ready. Lookup lot, then generate envelopes.");
});
