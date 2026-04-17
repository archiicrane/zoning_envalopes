async function resolveMapboxToken() {
  const local = (window.APP_CONFIG && window.APP_CONFIG.mapboxToken) || "";
  if (local && !local.includes("YOUR_MAPBOX")) {
    return local;
  }

  try {
    const res = await fetch("/api/config");
    if (res.ok) {
      const cfg = await res.json();
      const token = (cfg && cfg.mapboxToken) || "";
      if (token) {
        return token;
      }
    }
  } catch (err) {
    // Continue to explicit error below.
  }

  throw new Error(
    "Missing Mapbox token. Set MAPBOX_PUBLIC_TOKEN in Vercel Environment Variables."
  );
}

let map = null;
let activeLotPolygon = null;

function initMap(token) {
  mapboxgl.accessToken = token;
  map = new mapboxgl.Map({
    container: "map",
    style: "mapbox://styles/mapbox/light-v11",
    center: [-73.989358, 40.678785],
    zoom: 16,
    pitch: 50,
    bearing: -17,
    antialias: true,
  });

  map.on("load", () => {
    ensureSelectionSourceAndLayers();

    map.on("click", async (ev) => {
      try {
        await selectLotAtPoint(ev.lngLat.lng, ev.lngLat.lat);
      } catch (err) {
        setReport(String(err));
      }
    });

    setReport("Map ready. Lookup lot, then generate envelopes.");
  });
}

const report = document.getElementById("report");
const coverageInput = document.getElementById("coverage");
const covVal = document.getElementById("covVal");

coverageInput.addEventListener("input", () => {
  covVal.textContent = `${coverageInput.value}%`;
});

function setReport(text) {
  report.textContent = text;
}

function ensureSelectionSourceAndLayers() {
  if (!map.getSource("selected-lot")) {
    map.addSource("selected-lot", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });

    map.addLayer({
      id: "selected-lot-fill",
      type: "fill",
      source: "selected-lot",
      paint: {
        "fill-color": "#14b8a6",
        "fill-opacity": 0.2,
      },
    });

    map.addLayer({
      id: "selected-lot-outline",
      type: "line",
      source: "selected-lot",
      paint: {
        "line-color": "#0f766e",
        "line-width": 3,
      },
    });
  }
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
        "fill-extrusion-height": ["coalesce", ["get", "height_m"], ["get", "height_ft"], 0],
        "fill-extrusion-base": ["coalesce", ["get", "base_m"], 0],
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

  if (data.lot_polygon && Array.isArray(data.lot_polygon) && data.lot_polygon.length >= 4) {
    activeLotPolygon = data.lot_polygon;
    updateBblInputsFromLotData(data);
    updateSelectionVisual(activeLotPolygon);
  } else {
    throw new Error("BBL lookup found attributes but no lot polygon geometry.");
  }

  setReport(JSON.stringify(data, null, 2));
  return data;
}

function updateSelectionVisual(polygon) {
  ensureSelectionSourceAndLayers();
  map.getSource("selected-lot").setData({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [polygon],
        },
      },
    ],
  });

  const bounds = polygon.reduce(
    (acc, pt) => acc.extend(pt),
    new mapboxgl.LngLatBounds(polygon[0], polygon[0])
  );
  map.fitBounds(bounds, {
    padding: 50,
    duration: 700,
    maxZoom: 19.2,
    pitch: 55,
    bearing: -20,
  });
}

function updateBblInputsFromLotData(data) {
  if (data && data.borough) {
    document.getElementById("borough").value = String(data.borough);
  }
  if (data && data.block) {
    document.getElementById("block").value = String(data.block);
  }
  if (data && data.lot) {
    document.getElementById("lot").value = String(data.lot);
  }
}

async function fetchLotAtPoint(lng, lat) {
  const url = `/api/lot_at_point?lng=${encodeURIComponent(lng)}&lat=${encodeURIComponent(lat)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Lot selection failed: ${txt}`);
  }
  return res.json();
}

async function selectLotAtPoint(lng, lat, seedData) {
  const data = seedData || (await fetchLotAtPoint(lng, lat));

  if (!data.lot_polygon || !Array.isArray(data.lot_polygon) || data.lot_polygon.length < 4) {
    throw new Error("Clicked lot does not have a valid polygon geometry.");
  }

  activeLotPolygon = data.lot_polygon;
  updateBblInputsFromLotData(data);
  updateSelectionVisual(activeLotPolygon);

  const zoneText = data.zone ? ` | Zone: ${data.zone}` : "";
  setReport(`Selected lot by map click:\nBBL: ${data.bbl || "n/a"}\nBorough/Block/Lot: ${data.borough || "?"}/${data.block || "?"}/${data.lot || "?"}${zoneText}`);

  return data;
}


async function generateEnvelopes() {
  if (!activeLotPolygon) {
    throw new Error("Lookup a lot first so we have a base polygon.");
  }

  const upzone = document.getElementById("upzoneToggle").checked;

  // Default zoning FAR and max height
  let zoning_far = 3.0;
  let max_height_ft = 180;

  // If upzoning, increase FAR and max height
  if (upzone) {
    zoning_far = 6.0; // Example: double the FAR
    max_height_ft = 360; // Example: double the max height
  }

  const payload = {
    lot_polygon: activeLotPolygon,
    use_type: document.getElementById("useType").value,
    far_mode: document.getElementById("farMode").checked,
    lot_coverage: Number(document.getElementById("coverage").value) / 100,
    floor_height_ft: Number(document.getElementById("floorHeight").value),
    zoning_far,
    max_height_ft,
  };

  setReport(upzone ? "Generating upzoned envelopes..." : "Generating envelopes...");

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
    if (!map) {
      throw new Error("Map is still loading.");
    }
    await lookupLot();
  } catch (err) {
    setReport(String(err));
  }
});

document.getElementById("runBtn").addEventListener("click", async () => {
  try {
    if (!map) {
      throw new Error("Map is still loading.");
    }
    await generateEnvelopes();
  } catch (err) {
    setReport(String(err));
  }
});

(async function bootstrap() {
  try {
    const token = await resolveMapboxToken();
    initMap(token);
  } catch (err) {
    setReport(String(err));
    alert(String(err));
  }
})();
