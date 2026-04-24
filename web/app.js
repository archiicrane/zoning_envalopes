async function resolveMapboxToken() {
  const local = (window.APP_CONFIG && window.APP_CONFIG.mapboxToken) || "";
  if (local && !local.includes("YOUR_MAPBOX")) {
    return local;
  }

  const res = await fetch("/api/config");
  if (res.ok) {
    const cfg = await res.json();
    const token = (cfg && cfg.mapboxToken) || "";
    if (token) {
      return token;
    }
  }

  throw new Error("Missing Mapbox token. Set MAPBOX_PUBLIC_TOKEN in your environment.");
}

const EMPTY_FC = { type: "FeatureCollection", features: [] };
const ZONING_RULES_URL = "/zoning-rules.jsonld";

let map = null;
let activeLotPolygon = null;
let activeLotData = null;
let activeZoneOverride = null;
let activeOriginalZone = null;
let baselineEnvelopeGeojson = null;
let baselineEnvelopeResults = null;
let scenarioEnvelopeGeojson = null;
let scenarioEnvelopeResults = null;
let activeNeighborhood = null;
let activeNeighborhoodData = EMPTY_FC;
let availableNeighborhoods = [];
let zoningRuleIndex = new Map();

const report = document.getElementById("report");
const coverageInput = document.getElementById("coverage");
const covVal = document.getElementById("covVal");
const farInput = document.getElementById("farSlider");
const farVal = document.getElementById("farVal");
const envelopeOpacitySlider = document.getElementById("envelopeOpacitySlider");
const envelopeOpacityVal = document.getElementById("envelopeOpacityVal");
const lotSummary = document.getElementById("lotSummary");
const dataStatus = document.getElementById("dataStatus");
const neighborhoodSelect = document.getElementById("neighborhoodSelect");
const showBuildingToggle = document.getElementById("showBuildingToggle");
const showEnvelopeToggle = document.getElementById("showEnvelopeToggle");
const showBuildingsBtn = document.getElementById("showBuildingsBtn");
const showEnvelopeBtn = document.getElementById("showEnvelopeBtn");

coverageInput.addEventListener("input", () => {
  covVal.textContent = `${coverageInput.value}%`;
});

farInput.addEventListener("input", () => {
  farVal.textContent = Number(farInput.value).toFixed(2);
});

envelopeOpacitySlider.addEventListener("input", () => {
  const transparencyPercent = Number(envelopeOpacitySlider.value);
  envelopeOpacityVal.textContent = `${transparencyPercent}%`;
  if (map && map.getLayer("zoning-envelope-fill")) {
    // Invert: transparency 0 = fully opaque, transparency 100 = fully transparent
    const opacityValue = 1 - transparencyPercent / 100;
    map.setPaintProperty(
      "zoning-envelope-fill",
      "fill-extrusion-opacity",
      [
        "case",
        ["==", ["get", "compare_variant"], "baseline"],
        opacityValue * 0.35,
        opacityValue,
      ]
    );
  }
});

showBuildingToggle.addEventListener("change", syncLayerVisibility);
showEnvelopeToggle.addEventListener("change", syncLayerVisibility);
if (showBuildingsBtn) {
  showBuildingsBtn.addEventListener("click", () => {
    showBuildingToggle.checked = !showBuildingToggle.checked;
    syncLayerVisibility();
  });
}
if (showEnvelopeBtn) {
  showEnvelopeBtn.addEventListener("click", () => {
    showEnvelopeToggle.checked = !showEnvelopeToggle.checked;
    syncLayerVisibility();
  });
}

function setReport(text) {
  report.textContent = text;
}

function setDataStatus(text) {
  dataStatus.textContent = text;
}

function formatNumber(value, digits = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return "n/a";
  }
  return num.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

async function loadZoningRules() {
  try {
    const res = await fetch(ZONING_RULES_URL);
    if (!res.ok) {
      throw new Error(`Failed to load zoning rules: ${res.status}`);
    }

    const payload = await res.json();
    const rules = Array.isArray(payload?.rules) ? payload.rules : [];
    zoningRuleIndex = new Map(
      rules
        .filter((rule) => rule && rule.zoneCode)
        .map((rule) => [normalizeZoneToken(rule.zoneCode), rule])
    );

    console.log("[zoning-rules] loaded", zoningRuleIndex.size, "rules from", ZONING_RULES_URL);
  } catch (err) {
    zoningRuleIndex = new Map();
    console.warn("[zoning-rules] falling back to built-in heuristics:", err);
  }
}

function coerceNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function extractProps(feature) {
  return feature && feature.properties ? feature.properties : {};
}

function featureGeometryToLotPolygon(feature) {
  const geometry = feature && feature.geometry ? feature.geometry : null;
  if (!geometry || !geometry.coordinates) {
    return null;
  }
  if (geometry.type === "Polygon" && geometry.coordinates[0]) {
    return geometry.coordinates[0];
  }
  if (geometry.type === "MultiPolygon" && geometry.coordinates[0] && geometry.coordinates[0][0]) {
    return geometry.coordinates[0][0];
  }
  return null;
}

function computeNeighborhoodBounds(geojson) {
  let bounds = null;
  for (const feature of geojson.features || []) {
    const polygon = featureGeometryToLotPolygon(feature);
    if (!polygon || !polygon.length) {
      continue;
    }
    if (!bounds) {
      bounds = new mapboxgl.LngLatBounds(polygon[0], polygon[0]);
    }
    for (const point of polygon) {
      bounds.extend(point);
    }
  }
  return bounds;
}

function estimateExistingHeightFt(props) {
  const floorHeight = Number(document.getElementById("floorHeight").value) || 10;
  const numFloors = coerceNumber(props.numfloors ?? props.NumFloors);
  if (numFloors && numFloors > 0) {
    return Math.max(10, numFloors * floorHeight);
  }

  const bldgArea = coerceNumber(props.bldgarea ?? props.BldgArea);
  const lotArea = coerceNumber(props.lot_area ?? props.LotArea);
  if (bldgArea && lotArea && lotArea > 0) {
    const impliedFloors = Math.max(1, bldgArea / (lotArea * 0.55));
    return impliedFloors * floorHeight;
  }

  return 10;
}

function normalizeNeighborhoodFeature(feature, neighborhoodName) {
  const props = extractProps(feature);
  const boroughRaw = String(props.Borough ?? props.borough ?? "").trim().toUpperCase();
  const boroughMap = { MN: "1", M: "1", BX: "2", B: "2", BK: "3", K: "3", QN: "4", Q: "4", SI: "5", S: "5" };
  const lotPolygon = featureGeometryToLotPolygon(feature);
  const normalizedProps = {
    ...props,
    neighborhood_name: neighborhoodName,
    bbl: String(props.BBL ?? props.bbl ?? "") || null,
    borough: boroughMap[boroughRaw] || String(props.BoroCode ?? props.borough ?? "") || null,
    borough_raw: boroughRaw || null,
    block: String(Math.trunc(Number(props.Block ?? props.block ?? 0)) || "") || null,
    lot: String(Math.trunc(Number(props.Lot ?? props.lot ?? 0)) || "") || null,
    address: String(props.Address ?? props.address ?? "") || null,
    zonedist1: String(props.ZoneDist1 ?? props.zonedist1 ?? "") || null,
    zonedist2: String(props.ZoneDist2 ?? props.zonedist2 ?? "") || null,
    overlay1: String(props.Overlay1 ?? props.overlay1 ?? "") || null,
    overlay2: String(props.Overlay2 ?? props.overlay2 ?? "") || null,
    landuse: String(props.LandUse ?? props.landuse ?? "") || null,
    lot_area: coerceNumber(props.LotArea ?? props.lotarea),
    bldgarea: coerceNumber(props.BldgArea ?? props.bldgarea),
    numfloors: coerceNumber(props.NumFloors ?? props.numfloors),
    built_far: coerceNumber(props.BuiltFAR ?? props.built_far),
    resid_far: coerceNumber(props.ResidFAR ?? props.resid_far),
    comm_far: coerceNumber(props.CommFAR ?? props.comm_far),
    facil_far: coerceNumber(props.FacilFAR ?? props.facil_far),
    source: `split:${neighborhoodName}`,
    existing_height_ft: estimateExistingHeightFt(props),
    lot_polygon: lotPolygon,
  };

  return {
    ...feature,
    properties: normalizedProps,
  };
}

function normalizeNeighborhoodData(geojson, neighborhoodName) {
  return {
    type: "FeatureCollection",
    features: (geojson.features || [])
      .map((feature) => normalizeNeighborhoodFeature(feature, neighborhoodName))
      .filter((feature) => featureGeometryToLotPolygon(feature)),
  };
}

function computeEnvelopeHeight(props) {
  const zoneRule = resolveZoneRule(props);
  const ruleHeight = coerceNumber(zoneRule?.maximumBuildingHeightFt ?? zoneRule?.ridgeHeightFt);
  if (ruleHeight && ruleHeight > 0) {
    return ruleHeight;
  }

  const maxHeight = coerceNumber(props.max_height ?? props.maxHeight);
  if (maxHeight && maxHeight > 0) {
    return maxHeight;
  }

  const zoningHeight = coerceNumber(props.zoning_height ?? props.zoningHeight);
  if (zoningHeight && zoningHeight > 0) {
    return zoningHeight;
  }

  const far = coerceNumber(props.FAR ?? props.far ?? props.resid_far ?? props.comm_far ?? props.facil_far);
  if (far && far > 0) {
    return far * 12;
  }

  return 45;
}

function normalizeZoneToken(value) {
  const raw = String(value || "").trim().toUpperCase();
  return raw.replace(/\s+/g, "");
}

function resolveZoneRule(propsOrZone) {
  const zoneToken = normalizeZoneToken(
    typeof propsOrZone === "string"
      ? propsOrZone
      : propsOrZone?.zonedist1 ?? propsOrZone?.ZoneDist1 ?? propsOrZone?.zone ?? propsOrZone?.ZoningDist ?? ""
  );
  if (!zoneToken) {
    return null;
  }

  const direct = zoningRuleIndex.get(zoneToken);
  if (!direct) {
    return null;
  }

  const equivalent = normalizeZoneToken(direct.residentialEquivalent);
  if (!equivalent) {
    return direct;
  }

  const base = zoningRuleIndex.get(equivalent);
  return base ? { ...base, ...direct, zoneCode: direct.zoneCode } : direct;
}

function getAvailableZoningOptions() {
  return Array.from(zoningRuleIndex.keys()).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function pickZoneColor(props) {
  const zone = normalizeZoneToken(props.zonedist1 ?? props.ZoneDist1 ?? props.zone ?? props.ZoningDist ?? "");

  const explicit = {
    "R7": "#2563eb",
    "R7-2": "#60a5fa",
    "R6": "#ec4899",
  };
  if (explicit[zone]) {
    return explicit[zone];
  }

  if (zone.startsWith("R")) {
    return "#3b82f6";
  }
  if (zone.startsWith("C")) {
    return "#14b8a6";
  }
  if (zone.startsWith("M")) {
    return "#f59e0b";
  }

  return "#00c2ff";
}

// Returns the SIDE-yard setback in meters.
// Returns 0 when the zone rule has no sideYardEachFt — meaning no side yard is required
// (e.g. attached-building contextual districts like R6A, R7A, R8A, C4, M zones).
function computeSideSetback(props) {
  const zoneRule = resolveZoneRule(props);
  const sideYardFt = coerceNumber(zoneRule?.sideYardEachFt);
  // Only inset when the rule explicitly requires a side yard
  return (sideYardFt && sideYardFt > 0) ? sideYardFt * 0.3048 : 0;
}

// Returns the STREET-wall / upper-step setback in meters (applied at base height break).
// Returns 0 when the zone rule has no street setback requirement.
function computeStreetSetback(props) {
  const zoneRule = resolveZoneRule(props);
  const insetFt = coerceNumber(
    zoneRule?.streetSetbackWideFt ??
      zoneRule?.simplifiedPlanInsetFt
  );
  return (insetFt && insetFt > 0) ? insetFt * 0.3048 : 0;
}

// Legacy alias used by older call sites
function computeSetback(props) {
  return computeStreetSetback(props);
}

const STEPPED_BULK_REGIMES = new Set([
  "base-and-setback",
  "contextual",
  "contextual-variant",
  "sky-exposure-plane",
  "sky-exposure-plane-or-tower",
  "manufacturing-sky-exposure",
]);

function _tryBuffer(geometry, distanceMeters) {
  if (distanceMeters <= 0) return null;
  try {
    const result = turf.buffer({ type: "Feature", geometry, properties: {} }, -distanceMeters, { units: "meters" });
    if (result?.geometry?.coordinates?.length > 0) return result.geometry;
  } catch (e) { /* fallback */ }
  return null;
}

function buildZoningEnvelopeFeatures(geojson) {
  const features = [];
  const samples = [];

  for (const feature of geojson.features || []) {
    const geometry = feature?.geometry;
    if (!geometry || (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")) {
      continue;
    }

    const props = extractProps(feature);
    const zoneRule = resolveZoneRule(props);
    const envelopeHeight = computeEnvelopeHeight(props);
    const envelopeColor = pickZoneColor(props);
    const farVal = coerceNumber(props.FAR ?? props.far ?? props.resid_far ?? props.comm_far ?? props.facil_far);

    if (samples.length < 5) {
      samples.push({
        bbl: props.bbl || props.BBL || "n/a",
        zone: props.zonedist1 ?? props.ZoneDist1 ?? props.zone ?? "n/a",
        far: farVal,
        envelopeColor,
        envelopeHeight,
      });
    }

    const bulkRegime = zoneRule?.bulkRegime ?? "";
    const baseHeightFt = coerceNumber(zoneRule?.maximumBaseHeightFt);

    // Side-yard inset: only non-zero when the rule explicitly requires a side yard.
    // Zones like R6A, R7A, R8A, C4, M1 have no side yard requirement → 0 → full lot width.
    const sideSetbackM = computeSideSetback(props);
    const baseGeometry = (sideSetbackM > 0)
      ? (_tryBuffer(geometry, sideSetbackM) ?? geometry)
      : geometry;

    // Street-wall / upper-step setback: only non-zero when the rule specifies one.
    const streetSetbackM = computeStreetSetback(props);
    const upperGeometry = (streetSetbackM > 0)
      ? (_tryBuffer(geometry, streetSetbackM) ?? geometry)
      : geometry;

    const isStepped = bulkRegime && STEPPED_BULK_REGIMES.has(bulkRegime)
      && baseHeightFt && baseHeightFt > 0 && baseHeightFt < envelopeHeight;

    if (isStepped) {
      // Base segment: ground → max-base-height at required side-yard footprint
      features.push({
        type: "Feature",
        geometry: baseGeometry,
        properties: { envelopeHeight: baseHeightFt, envelopeBase: 0, envelopeColor },
      });
      // Upper segment: base-height → top at street-setback-inset footprint
      features.push({
        type: "Feature",
        geometry: upperGeometry,
        properties: { envelopeHeight, envelopeBase: baseHeightFt, envelopeColor },
      });
    } else {
      // Single prism: only inset when side yards are required
      features.push({
        type: "Feature",
        geometry: baseGeometry,
        properties: { envelopeHeight, envelopeBase: 0, envelopeColor },
      });
    }
  }

  return {
    type: "FeatureCollection",
    features,
    samples,
  };
}

function refreshZoningEnvelopeFromNeighborhood() {
  if (!map || !map.getSource("zoning-envelope-source")) {
    console.log("[zoning-envelope] source not available yet");
    return;
  }

  const built = buildZoningEnvelopeFeatures(activeNeighborhoodData || EMPTY_FC);
  map.getSource("zoning-envelope-source").setData({
    type: "FeatureCollection",
    features: built.features,
  });

  console.log("[zoning-envelope] selected neighborhood:", activeNeighborhood?.name || "n/a");
  console.log("[zoning-envelope] lots loaded:", (activeNeighborhoodData?.features || []).length);
  console.log("[zoning-envelope] envelope features created:", built.features.length);
  console.log("[zoning-envelope] sample FAR/height values:", built.samples);
}

function refreshExistingBuildingsForNeighborhood() {
  if (!map || !map.getLayer("existing-buildings-mapbox") || !map.getSource("existing-buildings-source")) {
    return;
  }

  const bounds = computeNeighborhoodBounds(activeNeighborhoodData || EMPTY_FC);
  if (!bounds || bounds.isEmpty()) {
    map.getSource("existing-buildings-source").setData(EMPTY_FC);
    console.log("[existing-buildings] no active neighborhood bounds, cleared neighborhood buildings source");
    return;
  }

  const candidates = map.querySourceFeatures("composite", { sourceLayer: "building" }) || [];
  const seen = new Set();
  const features = [];
  let nonZeroHeightCount = 0;

  for (const candidate of candidates) {
    const geometry = candidate && candidate.geometry ? candidate.geometry : null;
    if (!geometry || (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")) {
      continue;
    }

    const idVal = candidate.id ?? JSON.stringify(geometry.coordinates || []);
    const key = String(idVal);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const height =
      coerceNumber(candidate.properties?.height)
      || coerceNumber(candidate.properties?.render_height)
      || (coerceNumber(candidate.properties?.levels) ? coerceNumber(candidate.properties?.levels) * 3 : null)
      || 10;
    const minHeight =
      coerceNumber(candidate.properties?.min_height)
      || coerceNumber(candidate.properties?.render_min_height)
      || 0;
    if (height > 0) {
      nonZeroHeightCount += 1;
    }

    features.push({
      type: "Feature",
      geometry,
      properties: {
        height,
        min_height: minHeight,
      },
    });
  }

  map.getSource("existing-buildings-source").setData({
    type: "FeatureCollection",
    features,
  });
  console.log("[existing-buildings] selected neighborhood:", activeNeighborhood?.name || "n/a");
  console.log("[existing-buildings] lots loaded:", (activeNeighborhoodData?.features || []).length);
  console.log("[existing-buildings] mapbox building candidates loaded:", candidates.length);
  console.log("[existing-buildings] mapbox building features loaded:", features.length);
  console.log("[existing-buildings] mapbox buildings with non-zero height:", nonZeroHeightCount);
}

function disableDefaultMapboxBuildingExtrusions() {
  const layers = map?.getStyle()?.layers || [];
  for (const layer of layers) {
    if (
      layer.id !== "existing-buildings-mapbox"
      && layer.type === "fill-extrusion"
      && layer.source === "composite"
      && layer["source-layer"] === "building"
    ) {
      map.setLayoutProperty(layer.id, "visibility", "none");
      console.log("[existing-buildings] hid default basemap building extrusion layer:", layer.id);
    }
  }
}

function initMap(token) {
  return new Promise((resolve) => {
    mapboxgl.accessToken = token;
    map = new mapboxgl.Map({
      container: "map",
      style: "mapbox://styles/mapbox/light-v11",
      center: [-73.989358, 40.678785],
      zoom: 15,
      pitch: 55,
      bearing: -17,
      antialias: true,
    });

    map.on("load", () => {
      ensureSourcesAndLayers();
      syncLayerVisibility();
      map.on("click", handleMapClick);
      setReport("Pick a neighborhood from the dropdown, then click a lot.");
      resolve();
    });
  });
}

function ensureSourcesAndLayers() {
  disableDefaultMapboxBuildingExtrusions();

  if (!map.getSource("neighborhood-lots")) {
    map.addSource("neighborhood-lots", { type: "geojson", data: EMPTY_FC });

    map.addLayer({
      id: "neighborhood-lot-fill",
      type: "fill",
      source: "neighborhood-lots",
      paint: {
        "fill-color": "#cbd5e1",
        "fill-opacity": 0.18,
      },
    });

    map.addLayer({
      id: "neighborhood-lot-outline",
      type: "line",
      source: "neighborhood-lots",
      paint: {
        "line-color": "#64748b",
        "line-width": 0.8,
        "line-opacity": 0.7,
      },
    });
  }

  if (!map.getLayer("existing-buildings-mapbox")) {
    if (!map.getSource("existing-buildings-source")) {
      map.addSource("existing-buildings-source", { type: "geojson", data: EMPTY_FC });
    }

    const layers = map.getStyle().layers || [];
    const labelLayerId = layers.find(
      (layer) => layer.type === "symbol" && layer.layout && layer.layout["text-field"]
    )?.id;

    map.addLayer(
      {
        id: "existing-buildings-mapbox",
        type: "fill-extrusion",
        source: "existing-buildings-source",
        minzoom: 14,
        paint: {
          "fill-extrusion-color": "#8b98a8",
          "fill-extrusion-height": ["get", "height"],
          "fill-extrusion-base": ["get", "min_height"],
          "fill-extrusion-opacity": 0.65,
        },
      },
      labelLayerId
    );
    console.log("[existing-buildings] added neighborhood-scoped mapbox buildings layer");
  }

  if (map.getLayer("neighborhood-building-fill")) {
    map.removeLayer("neighborhood-building-fill");
  }

  if (!map.getSource("zoning-envelope-source")) {
    map.addSource("zoning-envelope-source", { type: "geojson", data: EMPTY_FC });
  }

  if (!map.getLayer("zoning-envelope-layer")) {
    map.addLayer({
      id: "zoning-envelope-layer",
      type: "fill-extrusion",
      source: "zoning-envelope-source",
      paint: {
        "fill-extrusion-color": ["coalesce", ["get", "envelopeColor"], "#00c2ff"],
        "fill-extrusion-opacity": 0.35,
        "fill-extrusion-base": ["coalesce", ["get", "envelopeBase"], 0],
        "fill-extrusion-height": ["coalesce", ["get", "envelopeHeight"], 30],
      },
    });
    console.log("[zoning-envelope] envelope layer added successfully");
  }

  if (!map.getSource("selected-lot")) {
    map.addSource("selected-lot", { type: "geojson", data: EMPTY_FC });

    map.addLayer({
      id: "selected-lot-fill",
      type: "fill",
      source: "selected-lot",
      paint: {
        "fill-color": "#14b8a6",
        "fill-opacity": 0.24,
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

  if (!map.getSource("study-model")) {
    map.addSource("study-model", { type: "geojson", data: EMPTY_FC });

    map.addLayer({
      id: "zoning-envelope-fill",
      type: "fill-extrusion",
      source: "study-model",
      filter: ["==", ["get", "kind"], "zoning_envelope"],
      paint: {
        "fill-extrusion-color": ["coalesce", ["get", "color"], "#2563eb"],
        "fill-extrusion-height": ["coalesce", ["get", "height_ft"], 0],
        "fill-extrusion-base": ["coalesce", ["get", "base_ft"], 0],
        "fill-extrusion-opacity": [
          "case",
          ["==", ["get", "compare_variant"], "baseline"],
          0.2,
          0.42,
        ],
      },
    });

    map.addLayer({
      id: "study-outline",
      type: "line",
      source: "study-model",
      paint: {
        "line-color": "#0f172a",
        "line-width": ["case", ["==", ["get", "kind"], "selected_lot"], 2, 1],
      },
    });
  }
}

function syncLayerVisibility() {
  if (!map) {
    return;
  }
  const existingBuildingsLayerExists = !!map.getLayer("existing-buildings-mapbox");
  if (existingBuildingsLayerExists) {
    map.setLayoutProperty("existing-buildings-mapbox", "visibility", showBuildingToggle.checked ? "visible" : "none");
  }
  const envelopeLayerExists = !!map.getLayer("zoning-envelope-layer");
  if (envelopeLayerExists) {
    map.setLayoutProperty("zoning-envelope-layer", "visibility", showEnvelopeToggle.checked ? "visible" : "none");
  }
  if (showBuildingsBtn) {
    showBuildingsBtn.classList.toggle("active", showBuildingToggle.checked);
    if (existingBuildingsLayerExists) {
      showBuildingsBtn.textContent = showBuildingToggle.checked ? "Hide Existing Buildings" : "Show Existing Buildings";
    } else {
      showBuildingsBtn.textContent = "Show Existing Buildings";
    }
  }
  if (showEnvelopeBtn) {
    showEnvelopeBtn.classList.toggle("active", showEnvelopeToggle.checked);
    if (envelopeLayerExists) {
      showEnvelopeBtn.textContent = showEnvelopeToggle.checked ? "Hide Zoning Envelope" : "Show Zoning Envelope";
    } else {
      showEnvelopeBtn.textContent = "Show Zoning Envelope";
    }
  }
}

function updateSelectionVisual(polygon, shouldRefocus = true) {
  ensureSourcesAndLayers();
  map.getSource("selected-lot").setData({
    type: "FeatureCollection",
    features: polygon
      ? [
          {
            type: "Feature",
            properties: {},
            geometry: {
              type: "Polygon",
              coordinates: [polygon],
            },
          },
        ]
      : [],
  });

  if (!polygon || !shouldRefocus) {
    return;
  }

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

function updateStudyModel(geojson) {
  ensureSourcesAndLayers();
  map.getSource("study-model").setData(geojson || EMPTY_FC);
  syncLayerVisibility();
}

function _extractCompareEnvelopeFeatures(geojson, color, variant) {
  return (geojson?.features || [])
    .filter((feature) => feature?.properties?.kind === "zoning_envelope")
    .map((feature) => ({
      ...feature,
      properties: {
        ...feature.properties,
        color,
        compare_variant: variant,
      },
    }));
}

function refreshSelectedLotComparisonModel() {
  const features = [
    ..._extractCompareEnvelopeFeatures(baselineEnvelopeGeojson, "#64748b", "baseline"),
    ..._extractCompareEnvelopeFeatures(scenarioEnvelopeGeojson, "#2563eb", "scenario"),
  ];
  updateStudyModel({ type: "FeatureCollection", features });
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

function syncControlsFromLotData(data) {
  const zoning = data && data.zoning_analysis ? data.zoning_analysis : null;
  if (!zoning) {
    return;
  }
  farInput.value = zoning.base_far || farInput.value;
  farInput.max = Math.max(15, Math.ceil((zoning.base_far || 3) * 1.5));
  farVal.textContent = Number(farInput.value).toFixed(2);
  coverageInput.value = Math.round((zoning.coverage_ratio || 0.8) * 100);
  covVal.textContent = `${coverageInput.value}%`;
}

function _ft(val) {
  const n = formatNumber(val, 0);
  return n !== "—" ? `${n} ft` : "—";
}

function _buildZoningReqRows(zoning) {
  if (!zoning || !zoning.primary_zone) return "";

  const rule = resolveZoneRule(zoning.primary_zone);
  if (!rule) return "";

  const regime = zoning.bulk_regime || rule.bulkRegime || "";
  const rows = [];

  rows.push(`<div class="summary-section-head">Zoning District Requirements</div>`);
  rows.push(`<div class="summary-row"><span>Bulk Regime</span><strong>${regime || "—"}</strong></div>`);

  const standardFar = rule.standardFar ?? null;
  const qualifyingFar = rule.qualifyingFar ?? null;
  if (standardFar != null) rows.push(`<div class="summary-row"><span>Standard FAR</span><strong>${formatNumber(standardFar, 2)}</strong></div>`);
  if (qualifyingFar != null && qualifyingFar !== standardFar) rows.push(`<div class="summary-row"><span>Qualifying FAR</span><strong>${formatNumber(qualifyingFar, 2)}</strong></div>`);

  const maxBase = rule.maximumBaseHeightFt ?? null;
  const minBase = rule.minimumBaseHeightFt ?? null;
  const maxHeight = rule.maximumBuildingHeightFt ?? rule.ridgeHeightFt ?? null;
  const frontWall = rule.maximumFrontWallHeightFt ?? null;
  if (minBase != null) rows.push(`<div class="summary-row"><span>Min Base Height</span><strong>${_ft(minBase)}</strong></div>`);
  if (maxBase != null) rows.push(`<div class="summary-row"><span>Max Base Height</span><strong>${_ft(maxBase)}</strong></div>`);
  if (maxHeight != null) rows.push(`<div class="summary-row"><span>Max Building Height</span><strong>${_ft(maxHeight)}</strong></div>`);
  if (frontWall != null && maxHeight == null) rows.push(`<div class="summary-row"><span>Max Front Wall</span><strong>${_ft(frontWall)}</strong></div>`);

  const frontYard = rule.frontYardFt ?? null;
  const sideYard = rule.sideYardEachFt ?? null;
  const rearYard = rule.rearYardFt ?? null;
  const streetSetback = rule.streetSetbackWideFt ?? null;
  if (frontYard != null) rows.push(`<div class="summary-row"><span>Front Yard</span><strong>${_ft(frontYard)}</strong></div>`);
  if (sideYard != null) rows.push(`<div class="summary-row"><span>Side Yard (each)</span><strong>${_ft(sideYard)}</strong></div>`);
  if (rearYard != null) rows.push(`<div class="summary-row"><span>Rear Yard</span><strong>${_ft(rearYard)}</strong></div>`);
  if (streetSetback != null) rows.push(`<div class="summary-row"><span>Street Setback</span><strong>${_ft(streetSetback)}</strong></div>`);

  const sources = rule.sourceSections;
  if (Array.isArray(sources) && sources.length) {
    const links = sources
      .map((id) => `<a href="https://zr.planning.nyc.gov/" target="_blank" rel="noopener">${id}</a>`)
      .join(", ");
    rows.push(`<div class="summary-row summary-row--source"><span>ZR Sections</span><span>${links}</span></div>`);
  }

  return rows.join("");
}

function updateLotSummary(data, envelopeResults) {
  if (!data) {
    lotSummary.className = "lot-summary empty";
    lotSummary.textContent = "Choose a neighborhood and click a lot.";
    return;
  }

  const zoning = (envelopeResults && envelopeResults.zoning_analysis) || data.zoning_analysis || {};
  const existingHeight = envelopeResults?.existing_building_height_ft ?? data.existing_height_ft;
  const envelopeHeight = envelopeResults?.full_envelope_height_ft;
  const baselineHeight = baselineEnvelopeResults?.full_envelope_height_ft;
  const scenarioHeight = scenarioEnvelopeResults?.full_envelope_height_ft;
  const effectiveZone = activeZoneOverride || zoning.primary_zone || data.zone || data.zonedist1 || "";
  const zoneOptions = getAvailableZoningOptions();
  const zoneSelect = zoneOptions.length
    ? `<select id="zoneOverrideSelect" class="summary-zone-select">${zoneOptions
      .map((zone) => `<option value="${zone}" ${zone === effectiveZone ? "selected" : ""}>${zone}</option>`)
      .join("")}</select>`
    : `<strong>${effectiveZone || "n/a"}</strong>`;

  lotSummary.className = "lot-summary";
  lotSummary.innerHTML = `
    <div class="summary-section-head">Lot</div>
    <div class="summary-row"><span>Neighborhood</span><strong>${data.neighborhood_name || activeNeighborhood?.name || "n/a"}</strong></div>
    <div class="summary-row"><span>Address</span><strong>${data.address || "n/a"}</strong></div>
    <div class="summary-row"><span>BBL</span><strong>${data.bbl || "n/a"}</strong></div>
    <div class="summary-row"><span>Original Zone</span><strong>${activeOriginalZone || "n/a"}</strong></div>
    <div class="summary-row summary-row--zone"><span>Scenario Zone</span>${zoneSelect}</div>
    <div class="summary-row"><span>Code FAR</span><strong>${formatNumber(zoning.base_far, 2)}</strong></div>
    <div class="summary-row"><span>Existing FAR</span><strong>${formatNumber(data.built_far ?? zoning.existing_far, 2)}</strong></div>
    <div class="summary-row"><span>Scenario FAR</span><strong>${formatNumber(zoning.scenario_far || farInput.value, 2)}</strong></div>
    <div class="summary-section-head">Envelope Study</div>
    <div class="summary-row"><span>Max Height</span><strong>${formatNumber(zoning.max_height_ft, 0)} ft</strong></div>
    <div class="summary-row"><span>Existing Height</span><strong>${formatNumber(existingHeight, 0)} ft</strong></div>
    <div class="summary-row"><span>Baseline Envelope</span><strong>${formatNumber(baselineHeight, 0)} ft</strong></div>
    <div class="summary-row"><span>Scenario Envelope</span><strong>${formatNumber(scenarioHeight ?? envelopeHeight, 0)} ft</strong></div>
    ${_buildZoningReqRows(zoning)}
  `;
}

function buildClientLotData(feature) {
  const props = extractProps(feature);
  return {
    ...props,
    zone: props.zonedist1 || props.zonedist2 || null,
    lot_polygon: featureGeometryToLotPolygon(feature),
    zoning_analysis: {
      primary_zone: props.zonedist1 || props.zonedist2 || null,
      base_far: props.resid_far || props.comm_far || props.facil_far || 0,
      scenario_far: props.resid_far || props.comm_far || props.facil_far || 0,
      max_height_ft: 120,
      coverage_ratio: 0.8,
    },
  };
}

function clearActiveEnvelope() {
  activeLotPolygon = null;
  activeLotData = null;
  activeZoneOverride = null;
  activeOriginalZone = null;
  baselineEnvelopeGeojson = null;
  baselineEnvelopeResults = null;
  scenarioEnvelopeGeojson = null;
  scenarioEnvelopeResults = null;
  updateSelectionVisual(null, false);
  refreshSelectedLotComparisonModel();
  updateLotSummary(null);
}

function applySelectedZoneOverride(zoneCode) {
  if (!activeLotData) {
    return;
  }

  const zone = normalizeZoneToken(zoneCode);
  if (!zone) {
    return;
  }

  activeZoneOverride = zone;
  activeLotData.zonedist1 = zone;
  activeLotData.zone = zone;

  const rule = resolveZoneRule(zone);
  const standardFar = coerceNumber(rule?.standardFar);
  const maxHeightFt = coerceNumber(rule?.maximumBuildingHeightFt ?? rule?.ridgeHeightFt);
  const baseHeightFt = coerceNumber(rule?.maximumBaseHeightFt);

  activeLotData.zoning_analysis = {
    ...(activeLotData.zoning_analysis || {}),
    primary_zone: zone,
    base_far: standardFar ?? activeLotData.zoning_analysis?.base_far ?? 0,
    scenario_far: standardFar ?? activeLotData.zoning_analysis?.scenario_far ?? 0,
    max_height_ft: maxHeightFt ?? activeLotData.zoning_analysis?.max_height_ft ?? 120,
    base_height_ft: baseHeightFt ?? activeLotData.zoning_analysis?.base_height_ft ?? null,
    bulk_regime: rule?.bulkRegime || activeLotData.zoning_analysis?.bulk_regime || null,
  };

  if (standardFar && standardFar > 0) {
    farInput.value = standardFar;
    farVal.textContent = Number(farInput.value).toFixed(2);
  }
}

async function requestEnvelopeForZone(zoneCode) {
  if (!activeLotPolygon || !activeLotData) {
    throw new Error("Select a lot inside the active neighborhood first.");
  }

  const zoningDefaults = activeLotData.zoning_analysis || {};
  const payload = {
    lot_polygon: activeLotPolygon,
    use_type: document.getElementById("useType").value,
    far_mode: document.getElementById("farMode").checked,
    lot_coverage: Number(document.getElementById("coverage").value) / 100,
    floor_height_ft: Number(document.getElementById("floorHeight").value),
    zoning_far: Number(farInput.value),
    max_height_ft: Number(zoningDefaults.max_height_ft || 120),
    zonedist1: zoneCode || activeLotData.zonedist1,
    zonedist2: activeLotData.zonedist2,
    overlay1: activeLotData.overlay1,
    overlay2: activeLotData.overlay2,
    lot_area: activeLotData.lot_area,
    bldgarea: activeLotData.bldgarea,
    numfloors: activeLotData.numfloors,
    built_far: activeLotData.built_far,
    resid_far: activeLotData.resid_far,
    comm_far: activeLotData.comm_far,
    facil_far: activeLotData.facil_far,
    bbl: activeLotData.bbl,
    upzone: document.getElementById("upzoneToggle").checked,
  };

  const res = await fetch("/api/envelope", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Envelope request failed: ${txt}`);
  }

  return res.json();
}

async function generateBaselineEnvelope() {
  if (!activeOriginalZone) {
    return;
  }
  const data = await requestEnvelopeForZone(activeOriginalZone);
  baselineEnvelopeGeojson = data.geojson;
  baselineEnvelopeResults = data.results;
  refreshSelectedLotComparisonModel();
}

async function generateScenarioEnvelope() {
  const scenarioZone = activeZoneOverride || activeOriginalZone || activeLotData?.zonedist1;
  if (!scenarioZone) {
    return;
  }

  if (activeOriginalZone && normalizeZoneToken(scenarioZone) === normalizeZoneToken(activeOriginalZone)) {
    scenarioEnvelopeGeojson = null;
    scenarioEnvelopeResults = null;
    refreshSelectedLotComparisonModel();
    updateLotSummary(activeLotData, baselineEnvelopeResults);
    return;
  }

  const data = await requestEnvelopeForZone(scenarioZone);
  scenarioEnvelopeGeojson = data.geojson;
  scenarioEnvelopeResults = data.results;
  refreshSelectedLotComparisonModel();
  updateLotSummary(activeLotData, scenarioEnvelopeResults);
  setReport(JSON.stringify(data.results, null, 2));
}

async function loadNeighborhoodOptions() {
  const res = await fetch("/api/data/splits");
  if (!res.ok) {
    throw new Error("Failed to load neighborhood list.");
  }

  const data = await res.json();
  availableNeighborhoods = data.files || [];
  neighborhoodSelect.innerHTML = "";

  if (!availableNeighborhoods.length) {
    neighborhoodSelect.innerHTML = '<option value="">No neighborhood files found</option>';
    setDataStatus("No split_pluto neighborhood files were found.");
    return;
  }

  for (const item of availableNeighborhoods) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.name;
    neighborhoodSelect.appendChild(option);
  }

  setDataStatus(`Loaded ${availableNeighborhoods.length} neighborhood files.`);
  await loadNeighborhoodById(availableNeighborhoods[0].id);
}

async function loadNeighborhoodById(id) {
  const neighborhood = availableNeighborhoods.find((item) => item.id === id);
  if (!neighborhood) {
    throw new Error("Selected neighborhood file was not found.");
  }

  setReport(`Loading neighborhood ${neighborhood.name}...`);
  let res;
  try {
    res = await fetch(neighborhood.url);
    if (!res.ok) {
      throw new Error(`Direct fetch failed (${res.status})`);
    }
  } catch (_err) {
    // CORS-safe fallback through same-origin backend proxy.
    console.log("[split-load] direct fetch failed, retrying via backend proxy:", neighborhood.id);
    res = await fetch(`/api/data/split/${encodeURIComponent(neighborhood.id)}`);
    if (!res.ok) {
      throw new Error(`Failed to load ${neighborhood.name}.`);
    }
  }

  const geojson = await res.json();
  activeNeighborhood = neighborhood;
  activeNeighborhoodData = normalizeNeighborhoodData(geojson, neighborhood.name);
  map.getSource("neighborhood-lots").setData(activeNeighborhoodData);
  clearActiveEnvelope();
  refreshZoningEnvelopeFromNeighborhood();

  const bounds = computeNeighborhoodBounds(activeNeighborhoodData);
  if (bounds && !bounds.isEmpty()) {
    map.fitBounds(bounds, {
      padding: 40,
      duration: 800,
      maxZoom: 16.5,
      pitch: 55,
      bearing: -17,
    });
  }

  refreshExistingBuildingsForNeighborhood();
  map.once("idle", refreshExistingBuildingsForNeighborhood);
  syncLayerVisibility();

  setDataStatus(`Loaded ${activeNeighborhoodData.features.length} lots from ${neighborhood.name}.`);
  setReport(`Loaded ${neighborhood.name}. Click a lot to inspect its existing building and zoning envelope.`);
}

function findNeighborhoodLot(borough, block, lot) {
  return (activeNeighborhoodData.features || []).find((feature) => {
    const props = extractProps(feature);
    return String(props.borough || "") === String(borough)
      && String(props.block || "") === String(Number(block))
      && String(props.lot || "") === String(Number(lot));
  });
}

async function lookupLot() {
  if (!activeNeighborhoodData.features.length) {
    throw new Error("Load a neighborhood first.");
  }

  const borough = document.getElementById("borough").value.trim();
  const block = document.getElementById("block").value.trim();
  const lot = document.getElementById("lot").value.trim();
  const localMatch = findNeighborhoodLot(borough, block, lot);

  if (localMatch) {
    return selectLotFeature(localMatch);
  }

  const res = await fetch(`/api/lot/${encodeURIComponent(borough)}/${encodeURIComponent(block)}/${encodeURIComponent(lot)}`);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Lot lookup failed: ${txt}`);
  }

  const data = await res.json();
  if (!data.lot_polygon || !Array.isArray(data.lot_polygon) || data.lot_polygon.length < 4) {
    throw new Error("BBL lookup found attributes but no lot polygon geometry.");
  }

  activeLotPolygon = data.lot_polygon;
  activeLotData = data;
  activeOriginalZone = normalizeZoneToken(data.zonedist1 || data.zonedist2 || "");
  activeZoneOverride = activeOriginalZone;
  baselineEnvelopeGeojson = null;
  baselineEnvelopeResults = null;
  scenarioEnvelopeGeojson = null;
  scenarioEnvelopeResults = null;
  updateBblInputsFromLotData(data);
  updateSelectionVisual(activeLotPolygon);
  syncControlsFromLotData(data);
  updateLotSummary(data);
  setReport(JSON.stringify(data, null, 2));

  generateBaselineEnvelope()
    .then(() => updateLotSummary(activeLotData, baselineEnvelopeResults))
    .catch((err) => setReport(String(err)));

  return data;
}

function selectLotFeature(feature) {
  const data = buildClientLotData(feature);
  if (!data.lot_polygon || data.lot_polygon.length < 4) {
    throw new Error("Selected lot does not have valid polygon geometry.");
  }

  activeLotPolygon = data.lot_polygon;
  activeLotData = data;
  activeOriginalZone = normalizeZoneToken(data.zonedist1 || data.zonedist2 || "");
  activeZoneOverride = activeOriginalZone;
  baselineEnvelopeGeojson = null;
  baselineEnvelopeResults = null;
  scenarioEnvelopeGeojson = null;
  scenarioEnvelopeResults = null;
  updateBblInputsFromLotData(data);
  updateSelectionVisual(activeLotPolygon);
  syncControlsFromLotData(data);
  updateLotSummary(data);

  const zoneText = data.zonedist1 ? ` | Zone: ${data.zonedist1}` : "";
  setReport(
    `Selected ${data.address || "lot"}\nNeighborhood: ${data.neighborhood_name || activeNeighborhood?.name || "n/a"}\nBBL: ${data.bbl || "n/a"}\nBorough/Block/Lot: ${data.borough || "?"}/${data.block || "?"}/${data.lot || "?"}${zoneText}`
  );

  generateBaselineEnvelope()
    .then(() => updateLotSummary(activeLotData, baselineEnvelopeResults))
    .catch((err) => setReport(String(err)));

  return data;
}

async function handleMapClick(ev) {
  const features = map.queryRenderedFeatures(ev.point, { layers: ["neighborhood-lot-fill"] });
  if (!features.length) {
    return;
  }

  try {
    selectLotFeature(features[0]);
  } catch (err) {
    setReport(String(err));
  }
}

async function generateEnvelopes() {
  if (!baselineEnvelopeGeojson) {
    await generateBaselineEnvelope();
  }
  await generateScenarioEnvelope();
}

lotSummary.addEventListener("change", async (event) => {
  const target = event.target;
  if (!target || target.id !== "zoneOverrideSelect") {
    return;
  }

  try {
    applySelectedZoneOverride(target.value);
    updateLotSummary(activeLotData);
    await generateEnvelopes();
  } catch (err) {
    setReport(String(err));
  }
});

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

neighborhoodSelect.addEventListener("change", async () => {
  try {
    await loadNeighborhoodById(neighborhoodSelect.value);
  } catch (err) {
    setReport(String(err));
  }
});

(async function bootstrap() {
  try {
    await loadZoningRules();
    const token = await resolveMapboxToken();
    await initMap(token);
    await loadNeighborhoodOptions();
  } catch (err) {
    setReport(String(err));
  }
})();
