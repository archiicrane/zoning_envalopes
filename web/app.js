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

const feetToMeters = (ft) => Number(ft || 0) * 0.3048;

function _defaultAssumptionOverrides() {
  return {
    floorHeightFt: 10,
    transparencyPct: null,
    osrOverride: null,
    rearYardFtOverride: null,
    sideYardFtOverride: null,
    frontYardFtOverride: null,
    maxHeightFtOverride: null,
  };
}

let map = null;
let activeLotPolygon = null;
let activeLotData = null;
let activeZoneOverride = null;
let activeOriginalZone = null;
let baselineEnvelopeGeojson = null;
let baselineEnvelopeResults = null;
let scenarioEnvelopeGeojson = null;
let scenarioEnvelopeResults = null;
let assumptionOverrides = _defaultAssumptionOverrides();
let zoningStudyDefaults = null;
let lastAssumptionChanged = null;
let showYardEdgeTypes = false;
let focusSelectedLotMode = false;
let showRoadCenterlines = false;
let lastStudyResult = null;
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

function _envelopeOpacityValues() {
  const transparencyPercent = Number(envelopeOpacitySlider.value);
  const opacityValue = 1 - transparencyPercent / 100;
  const baselineMultiplier = transparencyPercent === 0 ? 1 : 0.35;
  return {
    transparencyPercent,
    scenarioOpacity: opacityValue,
    baselineOpacity: opacityValue * baselineMultiplier,
  };
}

function applyEnvelopeOpacityToLayers() {
  if (!map) {
    return;
  }
  const { scenarioOpacity, baselineOpacity } = _envelopeOpacityValues();
  if (map.getLayer("zoning-envelope-fill")) {
    map.setPaintProperty("zoning-envelope-fill", "fill-extrusion-opacity", scenarioOpacity);
  }
  if (map.getLayer("zoning-envelope-fill-baseline")) {
    map.setPaintProperty("zoning-envelope-fill-baseline", "fill-extrusion-opacity", baselineOpacity);
  }
}

envelopeOpacitySlider.addEventListener("input", () => {
  const { transparencyPercent } = _envelopeOpacityValues();
  envelopeOpacityVal.textContent = `${transparencyPercent}%`;
  const panelSlider = document.getElementById("aslider-transparency");
  if (panelSlider) {
    panelSlider.value = transparencyPercent;
    const panelVal = document.getElementById("aval-transparency");
    if (panelVal) panelVal.textContent = `${transparencyPercent}%`;
  }
  applyEnvelopeOpacityToLayers();
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
        .map((rule) => {
          const zoneCode = normalizeZoneToken(rule.zoneCode);
          const maxFar = coerceNumber(rule.qualifyingFar ?? rule.standardFar);
          const districtType = rule.districtType || (
            zoneCode.startsWith("R") ? "residential"
              : zoneCode.startsWith("C") ? "commercial"
                : zoneCode.startsWith("M") ? "manufacturing"
                  : "mixed"
          );
          const bulkRegime = String(rule.bulkRegime || "").toLowerCase();
          const usesOpenSpaceRatio =
            typeof rule.usesOpenSpaceRatio === "boolean"
              ? rule.usesOpenSpaceRatio
              : Boolean(coerceNumber(rule.openSpaceRatio) > 0 && !bulkRegime.startsWith("contextual"));
          const normalizedRule = {
            ...rule,
            districtType,
            maxFar,
            usesOpenSpaceRatio,
            notes: rule.notes || (Array.isArray(rule.sourceSections) ? `ZR ${rule.sourceSections.join(", ")}` : ""),
          };
          return [zoneCode, normalizedRule];
        })
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

function buildNeighborhoodLotFilters(geojson) {
  const lotFilters = [];
  for (const feature of geojson.features || []) {
    const geometry = feature?.geometry;
    if (!geometry || (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")) {
      continue;
    }
    try {
      const lotFeature = _featureGeometryOnly({ geometry });
      const bbox = turf.bbox(lotFeature);
      lotFilters.push({ lotFeature, bbox });
    } catch (_err) {
      // Skip malformed geometries and continue with valid lots.
    }
  }
  return lotFilters;
}

function bboxesIntersect(a, b) {
  if (!a || !b || a.length !== 4 || b.length !== 4) {
    return false;
  }
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

function intersectsNeighborhoodLots(candidateFeature, lotFilters) {
  if (!candidateFeature || !Array.isArray(lotFilters) || !lotFilters.length) {
    return false;
  }

  let candidateBbox = null;
  try {
    candidateBbox = turf.bbox(candidateFeature);
  } catch (_err) {
    return false;
  }

  for (const lot of lotFilters) {
    if (!bboxesIntersect(candidateBbox, lot.bbox)) {
      continue;
    }
    try {
      const intersects = typeof turf.booleanIntersects === "function"
        ? turf.booleanIntersects(candidateFeature, lot.lotFeature)
        : Boolean(turf.intersect(candidateFeature, lot.lotFeature));
      if (intersects) {
        return true;
      }
    } catch (_err) {
      // Keep scanning remaining lots if one geometry comparison fails.
    }
  }
  return false;
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

function extractZoneTokens(...values) {
  const tokens = [];
  for (const value of values) {
    const raw = String(value || "").toUpperCase();
    if (!raw) continue;

    // Split mixed designations like M1-R6A into M1 and R6A, but keep M1-1 intact.
    const normalized = raw
      .replace(/(?<=\d)-(?=[RCM])/g, " ")
      .replace(/[\/,;()]/g, " ");

    for (const part of normalized.split(/\s+/)) {
      const token = normalizeZoneToken(part);
      if (!token || !/^[RCM]/.test(token)) continue;
      if (!tokens.includes(token)) {
        tokens.push(token);
      }
    }
  }
  return tokens;
}

function zonePriority(zone) {
  if (zone.startsWith("R")) return [4, zone.length];
  if (/^C[34568]/.test(zone)) return [3, zone.length];
  if (zone.startsWith("M")) return [2, zone.length];
  if (/^C[127]/.test(zone)) return [1, zone.length];
  return [2, zone.length];
}

function pickPrimaryZoneToken(...values) {
  const tokens = extractZoneTokens(...values);
  if (!tokens.length) return "";
  return tokens.sort((a, b) => {
    const [pa, la] = zonePriority(a);
    const [pb, lb] = zonePriority(b);
    if (pa !== pb) return pb - pa;
    return lb - la;
  })[0];
}

function resolveZoneRule(propsOrZone) {
  const zoneToken =
    typeof propsOrZone === "string"
      ? pickPrimaryZoneToken(propsOrZone)
      : pickPrimaryZoneToken(
        propsOrZone?.zonedist1,
        propsOrZone?.ZoneDist1,
        propsOrZone?.zonedist2,
        propsOrZone?.ZoneDist2,
        propsOrZone?.zone,
        propsOrZone?.ZoningDist
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
  const zone = pickPrimaryZoneToken(
    props.zonedist1,
    props.ZoneDist1,
    props.zonedist2,
    props.ZoneDist2,
    props.zone,
    props.ZoningDist
  );

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
    const zone = normalizeZoneToken(props.zonedist1 ?? props.ZoneDist1 ?? props.zone ?? "");
    
    // Skip park and open space zones
    if (zone.startsWith("P") || zone === "OS") {
      continue;
    }

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

  const lotFilters = buildNeighborhoodLotFilters(activeNeighborhoodData || EMPTY_FC);
  if (!lotFilters.length) {
    map.getSource("existing-buildings-source").setData(EMPTY_FC);
    console.log("[existing-buildings] no valid lot polygons from split file, cleared neighborhood buildings source");
    return;
  }

  const candidates = map.querySourceFeatures("composite", { sourceLayer: "building" }) || [];
  const seen = new Set();
  const features = [];
  let nonZeroHeightCount = 0;
  let filteredOutBySplitMask = 0;

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

    const candidateFeature = { type: "Feature", geometry, properties: {} };
    if (!intersectsNeighborhoodLots(candidateFeature, lotFilters)) {
      filteredOutBySplitMask += 1;
      continue;
    }

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
  console.log("[existing-buildings] candidates removed by split-lot mask:", filteredOutBySplitMask);
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
        "fill-opacity": 0.1,
      },
    });

    map.addLayer({
      id: "neighborhood-lot-outline",
      type: "line",
      source: "neighborhood-lots",
      paint: {
        "line-color": "#64748b",
        "line-width": 0.7,
        "line-opacity": 0.5,
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
          "fill-extrusion-color": "#cbd5e1",
          "fill-extrusion-height": ["get", "height"],
          "fill-extrusion-base": ["get", "min_height"],
          "fill-extrusion-opacity": 0.22,
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
        "fill-opacity": 0.12,
      },
    });

    map.addLayer({
      id: "selected-lot-outline",
      type: "line",
      source: "selected-lot",
      paint: {
        "line-color": "#0b3d3a",
        "line-width": 4.5,
      },
    });
  }

  if (!map.getSource("study-model")) {
    map.addSource("study-model", { type: "geojson", data: EMPTY_FC });

    const { scenarioOpacity, baselineOpacity } = _envelopeOpacityValues();

    map.addLayer({
      id: "front-yard-zone-fill",
      type: "fill",
      source: "study-model",
      filter: ["==", ["get", "kind"], "front_yard_zone"],
      paint: {
        "fill-color": "#2563eb",
        "fill-opacity": 0.2,
      },
    });

    map.addLayer({
      id: "side-yard-zone-fill",
      type: "fill",
      source: "study-model",
      filter: ["==", ["get", "kind"], "side_yard_zone"],
      paint: {
        "fill-color": "#f97316",
        "fill-opacity": 0.2,
      },
    });

    map.addLayer({
      id: "rear-yard-zone-fill",
      type: "fill",
      source: "study-model",
      filter: ["==", ["get", "kind"], "rear_yard_zone"],
      paint: {
        "fill-color": "#dc2626",
        "fill-opacity": 0.2,
      },
    });

    map.addLayer({
      id: "open-space-zone-fill",
      type: "fill",
      source: "study-model",
      filter: ["==", ["get", "kind"], "open_space_zone"],
      paint: {
        "fill-color": "#10b981",
        "fill-opacity": 0.22,
      },
    });

    map.addLayer({
      id: "buildable-footprint-fill",
      type: "fill",
      source: "study-model",
      filter: ["==", ["get", "kind"], "buildable_footprint"],
      paint: {
        "fill-color": "#14b8a6",
        "fill-opacity": 0.44,
      },
    });

    map.addLayer({
      id: "zoning-envelope-fill-baseline",
      type: "fill-extrusion",
      source: "study-model",
      filter: [
        "all",
        ["==", ["get", "kind"], "zoning_envelope"],
        ["==", ["get", "compare_variant"], "baseline"],
      ],
      paint: {
        "fill-extrusion-color": ["coalesce", ["get", "color"], "#93c5fd"],
        "fill-extrusion-height": ["coalesce", ["get", "height_ft"], 0],
        "fill-extrusion-base": ["coalesce", ["get", "base_ft"], 0],
        "fill-extrusion-opacity": baselineOpacity,
      },
    });

    map.addLayer({
      id: "zoning-envelope-fill",
      type: "fill-extrusion",
      source: "study-model",
      filter: [
        "all",
        ["==", ["get", "kind"], "zoning_envelope"],
        ["!=", ["get", "compare_variant"], "baseline"],
      ],
      paint: {
        "fill-extrusion-color": ["coalesce", ["get", "color"], "#2563eb"],
        "fill-extrusion-height": ["coalesce", ["get", "height_ft"], 0],
        "fill-extrusion-base": ["coalesce", ["get", "base_ft"], 0],
        "fill-extrusion-opacity": scenarioOpacity,
      },
    });

    map.addLayer({
      id: "buildable-footprint-outline",
      type: "line",
      source: "study-model",
      filter: ["==", ["get", "kind"], "buildable_footprint"],
      paint: {
        "line-color": "#0f766e",
        "line-width": 2,
        "line-opacity": 0.95,
      },
    });

    map.addLayer({
      id: "study-outline",
      type: "line",
      source: "study-model",
      filter: ["==", ["get", "kind"], "selected_lot"],
      paint: {
        "line-color": "#115e59",
        "line-width": 2,
      },
    });

    map.addLayer({
      id: "yard-edge-front-line",
      type: "line",
      source: "study-model",
      filter: ["==", ["get", "kind"], "yard_edge_front"],
      paint: {
        "line-color": "#2563eb",
        "line-width": 4,
      },
      layout: { visibility: "none" },
    });

    map.addLayer({
      id: "yard-edge-rear-line",
      type: "line",
      source: "study-model",
      filter: ["==", ["get", "kind"], "yard_edge_rear"],
      paint: {
        "line-color": "#dc2626",
        "line-width": 4,
      },
      layout: { visibility: "none" },
    });

    map.addLayer({
      id: "yard-edge-side-line",
      type: "line",
      source: "study-model",
      filter: ["==", ["get", "kind"], "yard_edge_side"],
      paint: {
        "line-color": "#f97316",
        "line-width": 3,
      },
      layout: { visibility: "none" },
    });

    map.addLayer({
      id: "yard-edge-corner-line",
      type: "line",
      source: "study-model",
      filter: ["==", ["get", "kind"], "yard_edge_corner"],
      paint: {
        "line-color": "#7c3aed",
        "line-width": 4,
      },
      layout: { visibility: "visible" },
    });

    map.addLayer({
      id: "edge-to-road-links",
      type: "line",
      source: "study-model",
      filter: ["==", ["get", "kind"], "edge_to_road_link"],
      paint: {
        "line-color": "#facc15",
        "line-width": 1.2,
        "line-dasharray": [2, 2],
        "line-opacity": 0.95,
      },
      layout: { visibility: "none" },
    });

    map.addLayer({
      id: "yard-edge-labels",
      type: "symbol",
      source: "study-model",
      filter: ["==", ["get", "kind"], "yard_edge_label"],
      layout: {
        "text-field": ["get", "edge_label"],
        "text-size": 11,
        "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
        visibility: "visible",
      },
      paint: {
        "text-color": "#0f172a",
        "text-halo-color": "#ffffff",
        "text-halo-width": 1,
      },
    });

    map.addLayer({
      id: "buildable-label",
      type: "symbol",
      source: "study-model",
      filter: ["==", ["get", "kind"], "buildable_label"],
      layout: {
        "text-field": ["get", "edge_label"],
        "text-size": 12,
        "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
        visibility: "visible",
      },
      paint: {
        "text-color": "#0b3d3a",
        "text-halo-color": "#ffffff",
        "text-halo-width": 1.2,
      },
    });
  }

  if (!map.getSource("road-centerlines-debug")) {
    map.addSource("road-centerlines-debug", { type: "geojson", data: EMPTY_FC });
    map.addLayer({
      id: "road-centerlines-debug-line",
      type: "line",
      source: "road-centerlines-debug",
      paint: {
        "line-color": "#facc15",
        "line-width": 2.2,
        "line-opacity": 0.95,
      },
      layout: { visibility: "none" },
    });
  }
}

function applyFocusModeVisuals() {
  if (!map) return;
  if (map.getLayer("neighborhood-lot-fill")) {
    map.setPaintProperty("neighborhood-lot-fill", "fill-opacity", focusSelectedLotMode ? 0.03 : 0.1);
  }
  if (map.getLayer("neighborhood-lot-outline")) {
    map.setPaintProperty("neighborhood-lot-outline", "line-opacity", focusSelectedLotMode ? 0.12 : 0.5);
  }
  if (map.getLayer("existing-buildings-mapbox")) {
    map.setPaintProperty("existing-buildings-mapbox", "fill-extrusion-opacity", focusSelectedLotMode ? 0.09 : 0.22);
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
  const studyLayerIds = [
    "zoning-envelope-fill-baseline",
    "zoning-envelope-fill",
    "front-yard-zone-fill",
    "side-yard-zone-fill",
    "rear-yard-zone-fill",
    "open-space-zone-fill",
    "buildable-footprint-fill",
    "buildable-footprint-outline",
    "study-outline",
    "yard-edge-front-line",
    "yard-edge-rear-line",
    "yard-edge-side-line",
    "edge-to-road-links",
    "yard-edge-corner-line",
    "yard-edge-labels",
    "buildable-label",
  ];
  for (const layerId of studyLayerIds) {
    if (map.getLayer(layerId)) {
      const isOptionalDebugLine = ["yard-edge-front-line", "yard-edge-rear-line", "yard-edge-side-line"].includes(layerId);
      const isRoadLinkLayer = layerId === "edge-to-road-links";
      const visible = showEnvelopeToggle.checked
        && (!isOptionalDebugLine || showYardEdgeTypes)
        && (!isRoadLinkLayer || showRoadCenterlines);
      map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
    }
  }
  if (map.getLayer("road-centerlines-debug-line")) {
    map.setLayoutProperty("road-centerlines-debug-line", "visibility", showRoadCenterlines ? "visible" : "none");
  }
  applyFocusModeVisuals();
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

function _extractCompareEnvelopeFeatures(geojson, color, variant, includeOverlays = false) {
  return (geojson?.features || [])
    .filter((feature) => {
      const kind = feature?.properties?.kind;
      if (kind === "zoning_envelope") return true;
      if (!includeOverlays) return false;
      return [
        "selected_lot",
        "front_yard_zone",
        "side_yard_zone",
        "rear_yard_zone",
        "open_space_zone",
        "buildable_footprint",
      ].includes(kind);
    })
    .map((feature) => ({
      ...feature,
      properties: {
        ...feature.properties,
        ...(feature?.properties?.kind === "zoning_envelope" ? { color, compare_variant: variant } : {}),
      },
    }));
}

function refreshSelectedLotComparisonModel() {
  const overlaySource = scenarioEnvelopeGeojson || baselineEnvelopeGeojson;
  const features = [
    ..._extractCompareEnvelopeFeatures(baselineEnvelopeGeojson, "#64748b", "baseline", false),
    ..._extractCompareEnvelopeFeatures(scenarioEnvelopeGeojson, "#2563eb", "scenario", false),
    ..._extractCompareEnvelopeFeatures(overlaySource, "#2563eb", "scenario", true).filter(
      (feature) => feature?.properties?.kind !== "zoning_envelope"
    ),
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
  if (Array.isArray(zoning.warnings) && zoning.warnings.length) {
    for (const warning of zoning.warnings) {
      rows.push(`<div class="summary-row summary-row--warning"><span>Warning</span><strong>${warning}</strong></div>`);
    }
  }
  rows.push(`<div class="summary-row"><span>Bulk Regime</span><strong>${regime || "—"}</strong></div>`);
  if (rule.districtType) {
    rows.push(`<div class="summary-row"><span>District Type</span><strong>${rule.districtType}</strong></div>`);
  }
  if (rule.maxFar != null) {
    rows.push(`<div class="summary-row"><span>Max FAR (Rule)</span><strong>${formatNumber(rule.maxFar, 2)}</strong></div>`);
  }

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
  const rearYard = rule.rearYardFt ?? zoning.rear_yard_ft_required ?? null;
  const streetSetback = rule.streetSetbackWideFt ?? null;
  const openSpaceRatio = zoning.open_space_ratio_required ?? coerceNumber(rule.openSpaceRatio ?? rule.openSpaceRatioRequired);
  const openSpaceRequiredFt2 = zoning.open_space_required_ft2 ?? null;
  if (frontYard != null) rows.push(`<div class="summary-row"><span>Front Yard</span><strong>${_ft(frontYard)}</strong></div>`);
  if (sideYard != null) rows.push(`<div class="summary-row"><span>Side Yard (each)</span><strong>${_ft(sideYard)}</strong></div>`);
  if (rearYard != null) rows.push(`<div class="summary-row"><span>Rear Yard</span><strong>${_ft(rearYard)}</strong></div>`);
  if (streetSetback != null) rows.push(`<div class="summary-row"><span>Street Setback</span><strong>${_ft(streetSetback)}</strong></div>`);
  if (openSpaceRatio != null && Number(openSpaceRatio) > 0) {
    rows.push(`<div class="summary-row"><span>Open Space Ratio</span><strong>${formatNumber(openSpaceRatio, 2)}</strong></div>`);
  }
  if (typeof rule.usesOpenSpaceRatio === "boolean") {
    rows.push(`<div class="summary-row"><span>Uses Open Space Ratio</span><strong>${rule.usesOpenSpaceRatio ? "Yes" : "No"}</strong></div>`);
  }
  if (openSpaceRequiredFt2 != null && Number(openSpaceRequiredFt2) > 0) {
    rows.push(`<div class="summary-row"><span>Required Open Space</span><strong>${formatNumber(openSpaceRequiredFt2, 0)} sf</strong></div>`);
  }

  const sources = rule.sourceSections;
  if (Array.isArray(sources) && sources.length) {
    const links = sources
      .map((id) => `<a href="https://zr.planning.nyc.gov/" target="_blank" rel="noopener">${id}</a>`)
      .join(", ");
    rows.push(`<div class="summary-row summary-row--source"><span>ZR Sections</span><span>${links}</span></div>`);
  }
  if (rule.notes) {
    rows.push(`<div class="summary-row summary-row--source"><span>Notes</span><span>${rule.notes}</span></div>`);
  }

  return rows.join("");
}

function _buildBuildabilityStudyRows(zoning, envelopeResults) {
  const study = envelopeResults?.zoning_buildability_study;
  if (!study) return "";
  const parsedDistricts = Array.isArray(zoning?.parsed_districts) ? zoning.parsed_districts : [];
  const primaryDistrict = zoning?.primary_zone || parsedDistricts[0]?.zone || "n/a";
  const firstResEquivalent = parsedDistricts.find((d) => d?.residential_equivalent)?.residential_equivalent || "n/a";
  const mixedUseDetected = parsedDistricts.length > 1 || parsedDistricts.some((d) => String(d?.zone || "").includes("/") || String(d?.zone || "").includes("MX"));
  const appliedRuleSet = mixedUseDetected
    ? (firstResEquivalent !== "n/a" ? `${primaryDistrict} + ${firstResEquivalent}` : primaryDistrict)
    : primaryDistrict;

  // Initialize defaults from study the first time this lot/zone is rendered
  if (!zoningStudyDefaults) {
    const defaultOsr = coerceNumber(zoning?.open_space_ratio_required) ?? 0;
    const defaultRearYardFt = coerceNumber(study.rear_yard_requirement_ft) ?? 20;
    const defaultFrontYardFt = coerceNumber(study.front_yard_requirement_ft) ?? 0;
    const defaultSideYardFt = coerceNumber(study.side_yard_requirement_ft) ?? 0;
    const defaultMaxHeightFt = coerceNumber(study.height_limit_ft) ?? 120;
    const baseRearYardFt2 = coerceNumber(study.rear_yard_area_ft2) ?? 0;
    const baseTotalYardFt2 = Math.max(
      0,
      (study.lot_area_ft2 ?? 0) - (study.buildable_footprint_ft2 ?? 0) - (study.required_open_space_ft2 ?? 0)
    );
    zoningStudyDefaults = {
      lotAreaFt2: study.lot_area_ft2 ?? 0,
      far: study.far ?? 0,
      primaryDistrict,
      residentialEquivalent: firstResEquivalent,
      mixedUseDetected,
      parsedDistricts,
      defaultOsr,
      defaultRearYardFt,
      defaultFrontYardFt,
      defaultSideYardFt,
      defaultMaxHeightFt,
      baseRearYardFt2,
      baseTotalYardFt2,
      baselineBuildableFootprintFt2: study.buildable_footprint_ft2 ?? 0,
      baselineEstimatedFloors: study.estimated_floors ?? 0,
      baselineEnvelopeHeightFt: study.envelope_height_ft ?? 0,
    };
    assumptionOverrides = _defaultAssumptionOverrides();
  }

  const { defaultOsr, defaultRearYardFt, defaultFrontYardFt, defaultSideYardFt, defaultMaxHeightFt } = zoningStudyDefaults;
  const currentTransparency = Number(envelopeOpacitySlider.value);
  const sliderFloor = assumptionOverrides.floorHeightFt;
  const sliderTransparency = assumptionOverrides.transparencyPct ?? currentTransparency;
  const sliderOsr = assumptionOverrides.osrOverride ?? defaultOsr;
  const sliderFrontYard = assumptionOverrides.frontYardFtOverride ?? defaultFrontYardFt;
  const sliderSideYard = assumptionOverrides.sideYardFtOverride ?? defaultSideYardFt;
  const sliderRearYard = assumptionOverrides.rearYardFtOverride ?? defaultRearYardFt;
  const sliderMaxHeight = assumptionOverrides.maxHeightFtOverride ?? defaultMaxHeightFt;

  const lotAreaFt2 = coerceNumber(study.lot_area_ft2) ?? 0;
  const allowableFloorAreaFt2 = coerceNumber(study.allowable_floor_area_ft2) ?? 0;
  const initialFinalBuildableFt2 = coerceNumber(study.buildable_footprint_ft2) ?? 0;
  const initialRequiredOpenSpaceFt2 = coerceNumber(study.required_open_space_ft2) ?? 0;
  const initialYardAdjustedFt2 = Math.min(lotAreaFt2, initialFinalBuildableFt2 + initialRequiredOpenSpaceFt2);
  const initialProvidedOpenSpaceFt2 = Math.max(0, lotAreaFt2 - initialYardAdjustedFt2);
  const initialOpenSpaceDeficitFt2 = Math.max(0, initialRequiredOpenSpaceFt2 - initialProvidedOpenSpaceFt2);

  const yesNo = study.full_far_fits ? "Yes" : "No";
  const farFitWarning = study.full_far_fit_warning || "";

  return `
    <div class="summary-section-head">ZONING BUILDABILITY STUDY</div>
    <div class="summary-row"><span>Lot Area</span><strong>${formatNumber(study.lot_area_ft2, 0)} sf</strong></div>
    <div class="summary-row"><span>Zoning District</span><strong>${primaryDistrict}</strong></div>
    <div class="summary-row"><span>Primary District</span><strong id="study-val-primary">${primaryDistrict}</strong></div>
    <div class="summary-row"><span>Residential Equivalent</span><strong id="study-val-reseq">${firstResEquivalent}</strong></div>
    <div class="summary-row"><span>Mixed-Use District?</span><strong id="study-val-mixed">${mixedUseDetected ? "Yes" : "No"}</strong></div>
    <div id="study-row-mixed-note" class="summary-row summary-row--warning"${mixedUseDetected ? "" : " style=\"display:none\""}>
      <span>Mixed District</span><strong id="study-val-mixed-note">Mixed zoning district detected. Applying residential equivalent rule set.</strong>
    </div>
    <div class="summary-row"><span>Applied Rule Set</span><strong id="study-val-ruleset">${appliedRuleSet}</strong></div>
    <div class="summary-row"><span>FAR</span><strong>${formatNumber(study.far, 2)}</strong></div>
    <div class="summary-row"><span>Lot Type</span><strong id="study-val-lottype">Analyzing...</strong></div>
    <div class="summary-row"><span>Allowable Floor Area</span><strong id="study-val-afa">${formatNumber(study.allowable_floor_area_ft2, 0)} sf</strong></div>
    <div class="summary-row"><span>Yard-Adjusted Footprint</span><strong id="study-val-yardfp">${formatNumber(initialYardAdjustedFt2, 0)} sf</strong></div>
    <div class="summary-row"><span>Required Open Space</span><strong id="study-val-ros">${formatNumber(initialRequiredOpenSpaceFt2, 0)} sf</strong></div>
    <div class="summary-row"><span>Provided Open Space</span><strong id="study-val-pos">${formatNumber(initialProvidedOpenSpaceFt2, 0)} sf</strong></div>
    <div class="summary-row"><span>Open Space Deficit</span><strong id="study-val-osd">${formatNumber(initialOpenSpaceDeficitFt2, 0)} sf</strong></div>
    <div class="summary-row"><span>Front Yard / Street Setback</span><strong id="study-val-front-yard">${formatNumber(sliderFrontYard, 0)} ft</strong></div>
    <div class="summary-row"><span>Side Yard</span><strong id="study-val-side-yard">${formatNumber(sliderSideYard, 0)} ft</strong></div>
    <div class="summary-row"><span>Rear Yard</span><strong id="study-val-rear-yard">${formatNumber(sliderRearYard, 0)} ft</strong></div>
    <div class="summary-row"><span>Final Buildable Footprint</span><strong id="study-val-bfp">${formatNumber(initialFinalBuildableFt2, 0)} sf</strong></div>
    <div class="summary-row"><span>Estimated Floors</span><strong id="study-val-floors">${formatNumber(study.estimated_floors, 2)}</strong></div>
    <div class="summary-row"><span>Required Height</span><strong id="study-val-reqheight">${_ft(study.required_height_ft)}</strong></div>
    <div class="summary-row"><span>Max Height</span><strong id="study-val-maxheight">${_ft(study.height_limit_ft ?? defaultMaxHeightFt)}</strong></div>
    <div class="summary-row"><span>Final Envelope Height</span><strong id="study-val-height">${_ft(study.envelope_height_ft)}</strong></div>
    <div class="summary-row"><span>Full FAR Fits?</span><strong id="study-val-farfits">${yesNo}</strong></div>
    <div id="study-row-farwarn" class="summary-row summary-row--warning"${study.full_far_fits ? ' style="display:none"' : ''}>
      <span>Note</span><strong id="study-val-farwarn">${farFitWarning}</strong>
    </div>
    <div id="study-row-lotwarn" class="summary-row summary-row--warning" style="display:none">
      <span>Lot Warning</span><strong id="study-val-lotwarn"></strong>
    </div>
    <div class="summary-section-head">EDGE-BY-EDGE ZONING RULES</div>
    <div class="summary-row"><span>Lot Type</span><strong id="study-edge-lot-type">Analyzing...</strong></div>
    <div class="summary-row"><span>Street Type</span><strong id="study-edge-street-type">Analyzing...</strong></div>
    <div class="summary-row"><span>Front Edge</span><strong id="study-edge-front">Analyzing...</strong></div>
    <div class="summary-row"><span>Rear Edge</span><strong id="study-edge-rear">Analyzing...</strong></div>
    <div class="summary-row"><span>Side Edge 1</span><strong id="study-edge-side-1">Analyzing...</strong></div>
    <div class="summary-row"><span>Side Edge 2</span><strong id="study-edge-side-2">Analyzing...</strong></div>
    <div class="summary-row summary-row--source"><span>ZR References</span><span id="study-edge-zr">Analyzing...</span></div>
    <div class="summary-section-head">EDGE DETECTION</div>
    <div class="summary-row"><span>Nearest Road</span><strong id="study-detect-road">Analyzing...</strong></div>
    <div class="summary-row"><span>Front Edge Distance</span><strong id="study-detect-front-dist">Analyzing...</strong></div>
    <div class="summary-row"><span>Rear Edge Distance</span><strong id="study-detect-rear-dist">Analyzing...</strong></div>
    <div class="summary-row"><span>Lot Type</span><strong id="study-detect-lot-type">Analyzing...</strong></div>
    <div class="summary-row"><span>Detection Method</span><strong id="study-detect-method">Road centerline proximity</strong></div>
    <details class="summary-assumptions" id="assumptionsDetails">
      <summary>Assumptions</summary>
      <div class="assumption-slider-row">
        <label>Floor-to-Floor Height <span class="assumption-val" id="aval-floor-height">${sliderFloor} ft</span></label>
        <input type="range" id="aslider-floor-height" class="assumption-slider" min="8" max="16" step="0.5" value="${sliderFloor}">
        <div class="assumption-subline">Default: 10 ft | Current: <span id="acurrent-floor-height">${sliderFloor} ft</span></div>
      </div>
      <div class="assumption-slider-row">
        <label>Envelope Transparency <span class="assumption-val" id="aval-transparency">${sliderTransparency}%</span></label>
        <input type="range" id="aslider-transparency" class="assumption-slider" min="10" max="90" step="5" value="${sliderTransparency}">
        <div class="assumption-subline">Default: ${currentTransparency}% | Current: <span id="acurrent-transparency">${sliderTransparency}%</span></div>
      </div>
      <div class="assumption-slider-row">
        <label>Open Space Ratio <span class="assumption-val" id="aval-osr">${sliderOsr}</span></label>
        <input type="range" id="aslider-osr" class="assumption-slider" min="0" max="40" step="1" value="${Math.min(40, sliderOsr)}">
        <div class="assumption-subline">Default: ${formatNumber(defaultOsr, 0)} | Current: <span id="acurrent-osr">${formatNumber(Math.min(40, sliderOsr), 0)}</span></div>
      </div>
      <div class="assumption-slider-row">
        <label>Street Setback <span class="assumption-val" id="aval-front-yard">${sliderFrontYard} ft</span></label>
        <input type="range" id="aslider-front-yard" class="assumption-slider" min="0" max="30" step="1" value="${Math.max(0, Math.min(30, sliderFrontYard))}">
        <div class="assumption-subline">Default: ${formatNumber(defaultFrontYardFt, 0)} ft | Current: <span id="acurrent-front-yard">${formatNumber(Math.max(0, Math.min(30, sliderFrontYard)), 0)} ft</span></div>
      </div>
      <div class="assumption-slider-row">
        <label>Side Yard Depth <span class="assumption-val" id="aval-side-yard">${sliderSideYard} ft</span></label>
        <input type="range" id="aslider-side-yard" class="assumption-slider" min="0" max="20" step="1" value="${Math.max(0, Math.min(20, sliderSideYard))}">
        <div class="assumption-subline">Default: ${formatNumber(defaultSideYardFt, 0)} ft | Current: <span id="acurrent-side-yard">${formatNumber(Math.max(0, Math.min(20, sliderSideYard)), 0)} ft</span></div>
      </div>
      <div class="assumption-slider-row">
        <label>Rear Yard Depth, applied only to rear edge <span class="assumption-val" id="aval-rear-yard">${sliderRearYard} ft</span></label>
        <input type="range" id="aslider-rear-yard" class="assumption-slider" min="0" max="40" step="1" value="${Math.min(40, sliderRearYard)}">
        <div class="assumption-subline">Default: ${formatNumber(defaultRearYardFt, 0)} ft | Current: <span id="acurrent-rear-yard">${formatNumber(Math.min(40, sliderRearYard), 0)} ft</span></div>
        <div class="assumption-helper">Deeper rear yard -> less buildable footprint -> envelope can get taller to fit FAR.</div>
      </div>
      <div class="assumption-slider-row">
        <label>Max Height <span class="assumption-val" id="aval-max-height">${sliderMaxHeight} ft</span></label>
        <input type="range" id="aslider-max-height" class="assumption-slider" min="40" max="250" step="5" value="${Math.max(40, Math.min(250, sliderMaxHeight))}">
        <div class="assumption-subline">Default: ${formatNumber(defaultMaxHeightFt, 0)} ft | Current: <span id="acurrent-max-height">${formatNumber(Math.max(40, Math.min(250, sliderMaxHeight)), 0)} ft</span></div>
      </div>
      <div class="assumption-impact" id="study-assumption-impact">
        Move a slider to see live impact.
      </div>
      <label class="assumption-toggle"><input type="checkbox" id="showYardEdgeTypesToggle" ${showYardEdgeTypes ? "checked" : ""}> Show Colored Edge Lines (debug)</label>
      <label class="assumption-toggle"><input type="checkbox" id="showRoadCenterlinesToggle" ${showRoadCenterlines ? "checked" : ""}> Show Road Centerlines</label>
      <label class="assumption-toggle"><input type="checkbox" id="focusSelectedLotToggle" ${focusSelectedLotMode ? "checked" : ""}> Focus Selected Lot</label>
      <div class="scenario-impact" id="scenario-impact-box">
        With current assumptions, this lot allows ${formatNumber(study.allowable_floor_area_ft2, 0)} sf of floor area. The buildable footprint is ${formatNumber(initialFinalBuildableFt2, 0)} sf, requiring about ${formatNumber(study.estimated_floors, 1)} floors. The final envelope is limited to ${formatNumber(study.height_limit_ft ?? defaultMaxHeightFt, 0)} ft, so ${study.full_far_fits ? "full FAR fits" : "full FAR may not fit"}.
      </div>
      <div class="study-legend">
        <div><span class="legend-chip legend-chip-lot"></span> Selected lot outline</div>
        <div><span class="legend-chip legend-chip-front-yard"></span> Front yard / street setback</div>
        <div><span class="legend-chip legend-chip-side-yard"></span> Side yards</div>
        <div><span class="legend-chip legend-chip-rear-yard"></span> Rear yard</div>
        <div><span class="legend-chip legend-chip-open"></span> Required open space</div>
        <div><span class="legend-chip legend-chip-buildable"></span> Final buildable footprint</div>
        <div><span class="legend-chip legend-chip-envelope"></span> Final envelope extrusion</div>
        <div><span class="legend-chip legend-chip-front"></span> FRONT edge (debug)</div>
        <div><span class="legend-chip legend-chip-rear"></span> REAR edge (debug)</div>
        <div><span class="legend-chip legend-chip-side"></span> SIDE edge (debug)</div>
        <div><span class="legend-chip legend-chip-road"></span> Road centerlines</div>
        <div><span class="legend-chip legend-chip-corner"></span> CORNER edge</div>
        <div><span class="legend-chip legend-chip-buildable-label"></span> BUILDABLE AREA label</div>
      </div>
      <button type="button" id="assumption-reset-btn" class="assumption-reset-btn">Reset to Zoning Defaults</button>
      <div class="assumption-note">Results are approximate — for visualization and research only.</div>
    </details>
  `;
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
    ${_buildBuildabilityStudyRows(zoning, envelopeResults)}
  `;

  if (envelopeResults?.zoning_buildability_study && activeLotPolygon) {
    const result = _recalcStudy();
    if (result) {
      lastStudyResult = result;
      _updateStudyPanelNumbers(result);
      _redrawEnvelopeFromAssumptions(result);
    }
  }
}

function buildClientLotData(feature) {
  const props = extractProps(feature);
  const primaryZone = pickPrimaryZoneToken(props.zonedist1, props.zonedist2, props.zone);
  return {
    ...props,
    zone: primaryZone || props.zonedist1 || props.zonedist2 || null,
    lot_polygon: featureGeometryToLotPolygon(feature),
    zoning_analysis: {
      primary_zone: primaryZone || null,
      base_far: props.resid_far || props.comm_far || props.facil_far || 0,
      scenario_far: props.resid_far || props.comm_far || props.facil_far || 0,
      max_height_ft: 120,
      coverage_ratio: 0.8,
    },
  };
}

// ─── Polygon geometry helpers (mirrors backend _scale_ring / _ring_inset_scale) ───

function _polygonAreaFt2(ring) {
  const closed = _closeRing(ring);
  try {
    return turf.area({ type: "Feature", geometry: { type: "Polygon", coordinates: [closed] }, properties: {} }) * 10.7639;
  } catch (_err) {
    return 0;
  }
}

function _closeRing(ring) {
  if (!Array.isArray(ring) || !ring.length) return [];
  const out = ring.map((pt) => [pt[0], pt[1]]);
  const first = out[0];
  const last = out[out.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    out.push([first[0], first[1]]);
  }
  return out;
}

function _areaFt2FromGeometry(geometry) {
  if (!geometry) return 0;
  try {
    return turf.area({ type: "Feature", geometry, properties: {} }) * 10.7639;
  } catch (_err) {
    return 0;
  }
}

function _signedRingArea(ring) {
  let area = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return area / 2;
}

function _normalizePolygonRing(ring) {
  const closed = _closeRing(ring);
  if (_signedRingArea(closed) > 0) {
    return closed.slice().reverse();
  }
  return closed;
}

function _largestPolygonGeometry(geometry) {
  if (!geometry) return null;
  if (geometry.type === "Polygon") {
    return {
      type: "Polygon",
      coordinates: [
        _normalizePolygonRing(geometry.coordinates?.[0] || []),
        ...(geometry.coordinates || []).slice(1),
      ],
    };
  }
  if (geometry.type !== "MultiPolygon") return null;
  let best = null;
  let bestArea = -1;
  for (const polygonCoords of geometry.coordinates || []) {
    const candidate = { type: "Polygon", coordinates: polygonCoords };
    const area = _areaFt2FromGeometry(candidate);
    if (area > bestArea) {
      bestArea = area;
      best = candidate;
    }
  }
  return best ? _largestPolygonGeometry(best) : null;
}

function _normalizeStudyGeometry(geometry) {
  const largest = _largestPolygonGeometry(geometry);
  return largest || geometry;
}

function _bboxRing(ring) {
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
    [minX, minY],
  ];
}

function _edgeMidpoint(start, end) {
  return [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
}

function _ringEdges(ring) {
  const closed = _closeRing(ring);
  const edges = [];
  for (let i = 0; i < closed.length - 1; i += 1) {
    const start = closed[i];
    const end = closed[i + 1];
    edges.push({
      idx: i,
      start,
      end,
      midpoint: _edgeMidpoint(start, end),
      line: { type: "Feature", geometry: { type: "LineString", coordinates: [start, end] }, properties: { edge_idx: i } },
      lengthM: turf.distance(start, end, { units: "meters" }),
    });
  }
  return edges;
}

function _toRoadLineFeatures(features) {
  const lines = [];
  for (const feature of features || []) {
    const geometry = feature?.geometry;
    const properties = feature?.properties || {};
    if (!geometry) continue;
    if (geometry.type === "LineString") {
      lines.push({ type: "Feature", geometry, properties });
    } else if (geometry.type === "MultiLineString") {
      for (const coords of geometry.coordinates || []) {
        lines.push({ type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties });
      }
    }
  }
  return lines;
}

function _roadName(road) {
  if (!road?.properties) return "Unknown road";
  return (
    road.properties.name
    || road.properties.fullname
    || road.properties.stname
    || road.properties.street
    || road.properties.ref
    || "Unknown road"
  );
}

function _toLotBoundaryLines(features) {
  const lines = [];
  for (const feature of features || []) {
    const geometry = feature?.geometry;
    if (!geometry) continue;
    if (geometry.type === "Polygon") {
      const ring = geometry.coordinates?.[0];
      if (ring && ring.length > 3) {
        lines.push({ type: "Feature", geometry: { type: "LineString", coordinates: ring }, properties: {} });
      }
    } else if (geometry.type === "MultiPolygon") {
      for (const poly of geometry.coordinates || []) {
        const ring = poly?.[0];
        if (ring && ring.length > 3) {
          lines.push({ type: "Feature", geometry: { type: "LineString", coordinates: ring }, properties: {} });
        }
      }
    }
  }
  return lines;
}

function _getNearbyRoadLines() {
  if (!map) return [];
  let roadFeatures = [];
  try {
    roadFeatures = map.querySourceFeatures("composite", { sourceLayer: "road" }) || [];
  } catch (_err) {
    roadFeatures = [];
  }
  return _toRoadLineFeatures(roadFeatures);
}

function _getNeighborLotBoundaryLines(selectedRing) {
  const neighbors = [];
  const selected = { type: "Feature", geometry: { type: "Polygon", coordinates: [_closeRing(selectedRing)] }, properties: {} };
  for (const feature of activeNeighborhoodData?.features || []) {
    const ring = featureGeometryToLotPolygon(feature);
    if (!ring || ring.length < 4) continue;
    const candidate = { type: "Feature", geometry: { type: "Polygon", coordinates: [_closeRing(ring)] }, properties: {} };
    try {
      // Skip selected/self geometry; keep nearby intersecting/touching neighbors.
      if (turf.booleanEqual(selected, candidate)) continue;
      if (!turf.booleanDisjoint(selected, candidate)) {
        neighbors.push(feature);
      }
    } catch (_err) {
      // ignore invalid geometries
    }
  }
  return _toLotBoundaryLines(neighbors);
}

function _isAdjacentEdge(a, b, edgeCount) {
  const diff = Math.abs(a - b);
  return diff === 1 || diff === edgeCount - 1;
}

function _farthestEdgeFrom(edges, candidateIndices, fromPoint) {
  let best = null;
  let bestDist = -1;
  for (const idx of candidateIndices) {
    const edge = edges.find((e) => e.idx === idx);
    if (!edge) continue;
    const dist = turf.distance(fromPoint, edge.midpoint, { units: "meters" });
    if (dist > bestDist) {
      bestDist = dist;
      best = idx;
    }
  }
  return best;
}

function _closestEdgeToRoad(edges) {
  let best = null;
  for (const edge of edges) {
    const score = Number.isFinite(edge.minRoadDistM) ? edge.minRoadDistM : Number.POSITIVE_INFINITY;
    if (!best || score < best.score) {
      best = { idx: edge.idx, score };
    }
  }
  return best ? best.idx : (edges[0]?.idx ?? 0);
}

function _nearestRoadLineToPoint(pointCoords, roads) {
  const pt = turf.point(pointCoords);
  let nearest = null;
  for (const road of roads || []) {
    try {
      const distM = turf.pointToLineDistance(pt, road, { units: "meters" });
      if (!nearest || distM < nearest.distM) {
        nearest = { road, distM };
      }
    } catch (_err) {
      // skip malformed road geometry
    }
  }
  return nearest;
}

function _edgeTouchesNeighbor(edge, neighborLines, toleranceFt = 3) {
  const toleranceM = toleranceFt * 0.3048;
  const pt = turf.point(edge.midpoint);
  for (const line of neighborLines || []) {
    try {
      const d = turf.pointToLineDistance(pt, line, { units: "meters" });
      if (d <= toleranceM) {
        return true;
      }
    } catch (_err) {
      // ignore malformed line
    }
  }
  return false;
}

function _streetClassFromRoad(road) {
  const klass = String(
    road?.properties?.class
      || road?.properties?.road_class
      || road?.properties?.type
      || ""
  ).toLowerCase();
  if (!klass) return "unknown";
  if (/(motorway|trunk|primary|secondary|arterial|avenue|boulevard)/.test(klass)) return "wide";
  return "narrow";
}

// NYC ZR approximation rules used for study visualization.
// Approximated references:
// - ZR 12-10 lot line/street line terms
// - ZR 23-45 front yard / street line conditions
// - ZR 23-46 side yard conditions
// - ZR 23-47 rear yard rules (including through-lot caveat)
// - ZR 23-60 height and setback framework
function _buildEdgeRuleEngine(classification, context) {
  const {
    rule,
    appliedDistrict,
    mixedUseDetected,
    frontYardFt,
    sideYardFt,
    rearYardFt,
  } = context;

  const lotType = classification?.lotType || "Irregular";
  const isCorner = lotType === "Corner";
  const isThrough = lotType === "Through";
  const zrSections = Array.isArray(rule?.sourceSections) && rule.sourceSections.length
    ? rule.sourceSections
    : ["12-10", "23-45", "23-46", "23-47", "23-60"];

  const edgeRules = [];
  for (const edge of classification?.edges || []) {
    const isFront = classification.frontEdgeIndices.includes(edge.idx);
    const isRear = classification.rearEdgeIndex === edge.idx;
    const edgeType = isFront ? "front" : (isRear ? "rear" : "side");
    const streetType = isFront ? (edge.streetClass || "narrow") : null;

    let yardFt = 0;
    let zrReference = "";
    let notes = "";

    if (edgeType === "front") {
      const frontBase = Math.max(0, frontYardFt);
      const wideStreetSetback = coerceNumber(rule?.streetSetbackWideFt);
      const adjustedFront = streetType === "wide" && Number.isFinite(wideStreetSetback)
        ? Math.max(frontBase, wideStreetSetback)
        : frontBase;
      yardFt = adjustedFront;
      zrReference = "ZR 23-45";
      notes = `Front/street edge setback (${streetType || "unknown"} street).`;
    } else if (edgeType === "rear") {
      yardFt = isThrough ? 0 : Math.max(0, rearYardFt);
      zrReference = "ZR 23-47";
      notes = isThrough
        ? "Through-lot condition: rear lot line is not uniquely assigned in this approximation."
        : "Rear yard measured from rear lot line.";
    } else {
      const baseSide = Math.max(0, sideYardFt);
      yardFt = baseSide;
      zrReference = "ZR 23-46";
      notes = edge.touchesNeighbor
        ? "Side lot line touching another zoning lot."
        : "Side lot line not touching a zoning lot boundary (approximation).";
      if (isCorner && !edge.touchesNeighbor) {
        notes += " Corner condition may alter side-yard application.";
      }
    }

    edgeRules.push({
      edgeIndex: edge.idx,
      edgeType,
      lotLineType: isFront ? "street line" : "lot line",
      lotType,
      isCorner,
      isThrough,
      touchesNeighbor: !!edge.touchesNeighbor,
      streetType,
      yardFt,
      zrReference,
      notes,
    });
  }

  const frontStreetTypes = edgeRules
    .filter((edge) => edge.edgeType === "front")
    .map((edge) => edge.streetType)
    .filter(Boolean);
  const streetType = frontStreetTypes.includes("wide")
    ? "wide"
    : (frontStreetTypes[0] || "narrow");

  const lotLineRules = {
    front: {
      appliesTo: "street line",
      yardFt: Math.max(0, frontYardFt),
      notes: "Approx. ZR 23-45 front yard/street setback by street condition",
    },
    side: {
      appliesTo: "side lot line",
      yardFt: Math.max(0, sideYardFt),
      notes: "Approx. ZR 23-46 side yard conditions",
    },
    rear: {
      appliesTo: "rear lot line",
      yardFt: Math.max(0, rearYardFt),
      notes: "Approx. ZR 23-47 rear yard measured from rear lot line",
    },
  };

  return {
    district: appliedDistrict,
    mixedUseDetected,
    zrSections,
    lotLineRules,
    lotType,
    streetType,
    edgeRules,
  };
}

function _classifyLotEdges(lotRing, toleranceFt = 30) {
  const edges = _ringEdges(lotRing);
  const roads = _getNearbyRoadLines();
  const neighborLines = _getNeighborLotBoundaryLines(lotRing);
  const toleranceM = toleranceFt * 0.3048;
  const lotCentroid = turf.centroid({ type: "Feature", geometry: { type: "Polygon", coordinates: [_closeRing(lotRing)] }, properties: {} });

  const edgesByRoadDistance = [];
  for (const edge of edges) {
    const pt = turf.point(edge.midpoint);
    let minDistM = Number.POSITIVE_INFINITY;
    let nearestRoad = null;
    let nearestRoadPoint = null;
    for (const road of roads) {
      try {
        const nearestOnLine = turf.nearestPointOnLine(road, pt, { units: "meters" });
        const d = nearestOnLine?.properties?.dist ?? turf.pointToLineDistance(pt, road, { units: "meters" });
        if (d < minDistM) {
          minDistM = d;
          nearestRoad = road;
          nearestRoadPoint = nearestOnLine?.geometry?.coordinates || null;
        }
      } catch (_err) {
        // skip invalid road geometry
      }
    }
    edge.minRoadDistM = minDistM;
    edge.streetClass = _streetClassFromRoad(nearestRoad);
    edge.nearestRoad = nearestRoad;
    edge.nearestRoadName = _roadName(nearestRoad);
    edge.nearestRoadPoint = nearestRoadPoint;
    edgesByRoadDistance.push(edge);
    edge.touchesNeighbor = _edgeTouchesNeighbor(edge, neighborLines);
  }

  edgesByRoadDistance.sort((a, b) => a.minRoadDistM - b.minRoadDistM);
  const primaryFrontEdge = edgesByRoadDistance[0] || edges[0] || null;
  const streetEdgeIndices = [];
  if (primaryFrontEdge) {
    streetEdgeIndices.push(primaryFrontEdge.idx);
  }

  const secondaryFrontCandidate = edgesByRoadDistance.find((edge) => {
    if (!primaryFrontEdge || edge.idx === primaryFrontEdge.idx) return false;
    if (!Number.isFinite(edge.minRoadDistM) || !Number.isFinite(primaryFrontEdge.minRoadDistM)) return false;
    const closeToRoad = edge.minRoadDistM <= toleranceM;
    const closeToPrimary = (edge.minRoadDistM - primaryFrontEdge.minRoadDistM) <= feetToMeters(18);
    return closeToRoad && closeToPrimary;
  });
  if (secondaryFrontCandidate) {
    streetEdgeIndices.push(secondaryFrontCandidate.idx);
  }

  let lotType = "Interior";
  const warnings = [];
  const allIndices = edges.map((e) => e.idx);
  let frontEdgeIndices = [];
  let rearEdgeIndex = null;
  let sideEdgeIndices = [];
  let rearEstimated = false;

  if (streetEdgeIndices.length > 2) {
    lotType = "Irregular";
    warnings.push("More than two road-facing edges detected. Lot type set to irregular.");
  } else if (streetEdgeIndices.length > 1) {
    const unique = [...streetEdgeIndices];
    const adjacentPair = unique.some((idx, i) => unique.slice(i + 1).some((jdx) => _isAdjacentEdge(idx, jdx, edges.length)));
    if (adjacentPair) {
      lotType = "Corner";
      warnings.push("Corner lot detected by road centerline proximity.");
    } else {
      lotType = "Through";
      warnings.push("Through lot detected by opposite street-facing edges.");
    }
  }

  frontEdgeIndices = streetEdgeIndices.length ? [...streetEdgeIndices] : (primaryFrontEdge ? [primaryFrontEdge.idx] : []);

  if (lotType === "Through") {
    rearEdgeIndex = null;
    sideEdgeIndices = allIndices.filter((idx) => !frontEdgeIndices.includes(idx));
  } else {
    const frontIdx = primaryFrontEdge?.idx ?? frontEdgeIndices[0] ?? 0;
    const nonFront = allIndices.filter((idx) => !frontEdgeIndices.includes(idx));
    rearEdgeIndex = _farthestEdgeFrom(edges, nonFront, edges.find((e) => e.idx === frontIdx)?.midpoint || [0, 0]);
    if (rearEdgeIndex != null && streetEdgeIndices.includes(rearEdgeIndex)) {
      const nonStreetCandidates = nonFront.filter((idx) => !streetEdgeIndices.includes(idx));
      rearEdgeIndex = _farthestEdgeFrom(edges, nonStreetCandidates, edges.find((e) => e.idx === frontIdx)?.midpoint || [0, 0]);
    }
    if (rearEdgeIndex == null) {
      rearEstimated = true;
      warnings.push("Rear yard edge is estimated.");
    }
    sideEdgeIndices = allIndices.filter((idx) => !frontEdgeIndices.includes(idx) && idx !== rearEdgeIndex);
  }

  // Favor neighboring-lot boundaries as SIDE edges when available.
  const touchingSides = sideEdgeIndices.filter((idx) => edges.find((e) => e.idx === idx)?.touchesNeighbor);
  if (touchingSides.length) {
    const nonTouchingSides = sideEdgeIndices.filter((idx) => !touchingSides.includes(idx));
    sideEdgeIndices = [...touchingSides, ...nonTouchingSides];
  }
  if (!touchingSides.length && sideEdgeIndices.length) {
    warnings.push("Side lot line detection is approximate for this lot.");
  }

  console.log("[lot-edges] street edges found", streetEdgeIndices);
  console.log("[lot-edges] lot type", lotType);
  console.log("[lot-edges] front edge index", primaryFrontEdge?.idx ?? null);
  console.log("[lot-edges] rear edge index", rearEdgeIndex);
  console.log("[lot-edges] side edges", sideEdgeIndices);

  for (const edge of edges) {
    if (frontEdgeIndices.includes(edge.idx)) {
      edge.edgeType = "front";
    } else if (rearEdgeIndex === edge.idx) {
      edge.edgeType = "rear";
    } else {
      edge.edgeType = "side";
    }
  }

  return {
    edges,
    roads,
    lotType,
    isCornerLot: lotType === "Corner",
    isThroughLot: lotType === "Through",
    warnings,
    streetEdgeIndices,
    frontEdgeIndices,
    rearEdgeIndex,
    sideEdgeIndices,
    rearEstimated,
    primaryFrontEdgeIndex: primaryFrontEdge?.idx ?? null,
    frontEdgeDistanceM: Number.isFinite(primaryFrontEdge?.minRoadDistM) ? primaryFrontEdge.minRoadDistM : null,
    rearEdgeDistanceM: Number.isFinite(edges.find((e) => e.idx === rearEdgeIndex)?.minRoadDistM)
      ? edges.find((e) => e.idx === rearEdgeIndex).minRoadDistM
      : null,
    nearestRoadName: primaryFrontEdge?.nearestRoadName || "Unknown road",
    detectionMethod: "road centerline proximity",
  };
}

function _bufferInwardGeometry(geometry, insetFt) {
  if (!geometry || insetFt <= 0) return geometry;
  const insetMeters = feetToMeters(insetFt);
  try {
    const buffered = turf.buffer({ type: "Feature", geometry, properties: {} }, -insetMeters, { units: "meters" });
    if (buffered?.geometry?.coordinates?.length) {
      return buffered.geometry;
    }
  } catch (_err) {
    // handled by caller fallback
  }
  return null;
}

function _fallbackInsetGeometry(lotRing, insetFt) {
  const bboxRing = _bboxRing(lotRing);
  const bboxGeometry = { type: "Polygon", coordinates: [_closeRing(bboxRing)] };
  const inset = _bufferInwardGeometry(bboxGeometry, insetFt);
  if (inset) return { geometry: inset, usedFallback: true };
  return { geometry: bboxGeometry, usedFallback: true };
}

function _featureGeometryOnly(feature) {
  return feature ? { type: "Feature", geometry: feature.geometry, properties: {} } : null;
}

function _bufferEdgeInsideLot(edge, distanceFt, lotFeature, logLabel) {
  if (!edge || distanceFt <= 0) {
    console.log(logLabel, { distanceFt: 0, area_ft2: 0 });
    return null;
  }
  const distanceM = feetToMeters(distanceFt);
  try {
    const buffered = turf.buffer(edge.line, distanceM, { units: "meters" });
    const clipped = turf.intersect(_featureGeometryOnly(buffered), lotFeature);
    const geometry = clipped?.geometry ? _normalizeStudyGeometry(clipped.geometry) : null;
    const area = geometry ? _areaFt2FromGeometry(geometry) : 0;
    console.log(logLabel, { distanceFt, area_ft2: area });
    return geometry ? { ...clipped, geometry } : null;
  } catch (_err) {
    console.log(logLabel, { distanceFt, area_ft2: 0, failed: true });
    return null;
  }
}

function _unionFeatures(features) {
  const valid = (features || []).filter(Boolean);
  if (!valid.length) return null;
  let acc = valid[0];
  for (let i = 1; i < valid.length; i += 1) {
    try {
      acc = turf.union(_featureGeometryOnly(acc), _featureGeometryOnly(valid[i])) || acc;
    } catch (_err) {
      // keep current accumulator
    }
  }
  return acc;
}

function _shrinkGeometryToArea(geometry, targetAreaFt2) {
  const currentAreaFt2 = _areaFt2FromGeometry(geometry);
  if (!geometry || targetAreaFt2 <= 0 || currentAreaFt2 <= 0 || targetAreaFt2 >= currentAreaFt2) {
    return geometry;
  }

  const ratio = Math.max(0.01, Math.min(1, targetAreaFt2 / currentAreaFt2));
  const radiusM = Math.sqrt((currentAreaFt2 / 10.7639) / Math.PI);
  const insetM = Math.max(0.05, (1 - Math.sqrt(ratio)) * radiusM);

  try {
    const buffered = turf.buffer({ type: "Feature", geometry, properties: {} }, -insetM, { units: "meters" });
    if (buffered?.geometry?.coordinates?.length) {
      return _normalizeStudyGeometry(buffered.geometry);
    }
  } catch (_err) {
    // fallback below
  }
  return geometry;
}

function _edgeDebugFeatures(classification) {
  const features = [];
  if (!classification) return features;
  const pushEdge = (idx, kind, label, color) => {
    const edge = classification.edges.find((e) => e.idx === idx);
    if (!edge) return;
    features.push({
      type: "Feature",
      properties: { kind, color },
      geometry: edge.line.geometry,
    });
    features.push({
      type: "Feature",
      properties: { kind: "yard_edge_label", edge_label: label },
      geometry: { type: "Point", coordinates: edge.midpoint },
    });
  };
  for (const idx of classification.frontEdgeIndices) pushEdge(idx, "yard_edge_front", "FRONT", "#2563eb");
  if (classification.rearEdgeIndex != null) pushEdge(classification.rearEdgeIndex, "yard_edge_rear", "REAR", "#dc2626");
  for (const idx of classification.sideEdgeIndices) pushEdge(idx, "yard_edge_side", "SIDE", "#f97316");
  if (classification.isCornerLot) {
    for (const idx of classification.frontEdgeIndices) {
      pushEdge(idx, "yard_edge_corner", "CORNER", "#7c3aed");
    }
  }

  for (const edge of classification.edges || []) {
    if (!Array.isArray(edge.nearestRoadPoint)) continue;
    features.push({
      type: "Feature",
      properties: { kind: "edge_to_road_link", edge_idx: edge.idx },
      geometry: {
        type: "LineString",
        coordinates: [edge.midpoint, edge.nearestRoadPoint],
      },
    });
  }
  return features;
}

function _computeYardAdjustedGeometry(lotRing, edgeRuleEngine) {
  const {
    frontYardFt,
    sideYardFt,
    rearYardFt,
    appliedRule,
    appliedDistrict,
    mixedUseDetected,
  } = edgeRuleEngine;
  const lotGeometry = { type: "Polygon", coordinates: [_closeRing(lotRing)] };
  const lotFeature = { type: "Feature", geometry: lotGeometry, properties: {} };
  const classification = _classifyLotEdges(lotRing);
  const roadCenterlineFeatures = {
    type: "FeatureCollection",
    features: (classification.roads || []).map((road, idx) => ({
      type: "Feature",
      properties: {
        kind: "road_centerline",
        road_name: _roadName(road),
        road_idx: idx,
      },
      geometry: road.geometry,
    })),
  };
  const edgeRules = _buildEdgeRuleEngine(classification, {
    rule: appliedRule,
    appliedDistrict,
    mixedUseDetected,
    frontYardFt,
    sideYardFt,
    rearYardFt,
  });
  for (const edge of edgeRules.edgeRules) {
    console.log("[zoning-edge]", {
      edgeIndex: edge.edgeIndex,
      edgeType: edge.edgeType,
      lotLineType: edge.lotLineType,
      lotType: edge.lotType,
      corner: edge.isCorner,
      through: edge.isThrough,
      touchesNeighbor: edge.touchesNeighbor,
      streetType: edge.streetType,
      yardFt: edge.yardFt,
      zrReference: edge.zrReference,
    });
  }

  const frontRuleEdges = edgeRules.edgeRules.filter((edge) => edge.edgeType === "front");
  const rearRuleEdges = edgeRules.edgeRules.filter((edge) => edge.edgeType === "rear");
  const sideRuleEdges = edgeRules.edgeRules.filter((edge) => edge.edgeType === "side");

  const frontBuffers = frontRuleEdges
    .map((edgeRule) => _bufferEdgeInsideLot(classification.edges.find((e) => e.idx === edgeRule.edgeIndex), edgeRule.yardFt, lotFeature, "[yard-geometry] front yard buffer"))
    .filter(Boolean);

  const rearBuffers = rearRuleEdges
    .map((edgeRule) => _bufferEdgeInsideLot(classification.edges.find((e) => e.idx === edgeRule.edgeIndex), edgeRule.yardFt, lotFeature, "[yard-geometry] rear yard buffer"))
    .filter(Boolean);
  const rearBuffer = _unionFeatures(rearBuffers);

  if (!rearRuleEdges.length) {
    console.log("[yard-geometry] rear yard buffer", { distanceFt: 0, area_ft2: 0, skipped: true });
  }

  const sideBuffers = sideRuleEdges
    .map((edgeRule) => _bufferEdgeInsideLot(classification.edges.find((e) => e.idx === edgeRule.edgeIndex), edgeRule.yardFt, lotFeature, "[yard-geometry] side yard buffer"))
    .filter(Boolean);

  const frontBufferUnion = _unionFeatures(frontBuffers);
  const sideBufferUnion = _unionFeatures(sideBuffers);
  const combinedBuffer = _unionFeatures([frontBufferUnion, rearBuffer, sideBufferUnion]);
  console.log("[yard-geometry] buffers created", {
    front_count: frontBuffers.length,
    rear_count: rearBuffer ? 1 : 0,
    side_count: sideBuffers.length,
    has_union: !!combinedBuffer,
  });

  let yardAdjustedFeature = lotFeature;
  let geometryFallbackUsed = false;
  if (combinedBuffer?.geometry) {
    try {
      const diff = turf.difference(lotFeature, _featureGeometryOnly(combinedBuffer));
      if (diff?.geometry) {
        yardAdjustedFeature = { ...diff, geometry: _normalizeStudyGeometry(diff.geometry) };
      } else {
        geometryFallbackUsed = true;
      }
    } catch (_err) {
      geometryFallbackUsed = true;
    }
  }

  if (geometryFallbackUsed) {
    // Fallback uses box clipping only when geometric difference fails; primary path remains directional edge subtraction.
    const insetFt = Math.max(2, (Math.max(0, frontYardFt) + Math.max(0, rearYardFt) + (2 * Math.max(0, sideYardFt))) / 4);
    const fallback = _fallbackInsetGeometry(lotRing, insetFt).geometry;
    yardAdjustedFeature = { type: "Feature", geometry: _normalizeStudyGeometry(fallback), properties: {} };
  }

  const maxFootprintAreaFt2 = _areaFt2FromGeometry(yardAdjustedFeature.geometry);
  console.log("[buildability] yard-adjusted footprint", {
    maxFootprintAreaFt2,
    geometryFallbackUsed,
  });

  return {
    lotGeometry,
    yardAdjustedGeometry: yardAdjustedFeature.geometry,
    maxFootprintAreaFt2,
    geometryFallbackUsed,
    classification,
    frontBufferGeometry: frontBufferUnion?.geometry || null,
    rearBufferGeometry: rearBuffer?.geometry || null,
    sideBufferGeometry: sideBufferUnion?.geometry || null,
    usedSimplifiedFallback: false,
    edgeRules,
    roadCenterlineFeatures,
  };
}

// ─── Assumptions: recalculate zoning study values ───

function _recalcStudy() {
  if (!zoningStudyDefaults) return null;
  const {
    lotAreaFt2,
    far,
    defaultOsr,
    defaultRearYardFt,
    defaultFrontYardFt,
    defaultSideYardFt,
    defaultMaxHeightFt,
    baselineBuildableFootprintFt2,
    baselineEstimatedFloors,
    baselineEnvelopeHeightFt,
  } = zoningStudyDefaults;
  if (!activeLotPolygon || activeLotPolygon.length < 4) return null;

  const floorHeightFt = assumptionOverrides.floorHeightFt;
  const osr = assumptionOverrides.osrOverride ?? defaultOsr;
  const frontYardFt = assumptionOverrides.frontYardFtOverride ?? defaultFrontYardFt;
  const sideYardFt = assumptionOverrides.sideYardFtOverride ?? defaultSideYardFt;
  const rearYardFt = assumptionOverrides.rearYardFtOverride ?? defaultRearYardFt;
  const maxHeightFt = assumptionOverrides.maxHeightFtOverride ?? defaultMaxHeightFt ?? 120;

  const appliedDistrict = normalizeZoneToken(
    zoningStudyDefaults?.residentialEquivalent && zoningStudyDefaults.residentialEquivalent !== "n/a"
      ? zoningStudyDefaults.residentialEquivalent
      : zoningStudyDefaults?.primaryDistrict
  );
  const appliedRule = resolveZoneRule(appliedDistrict) || {};
  const usesOpenSpaceRatio =
    Boolean(appliedRule.usesOpenSpaceRatio)
    || /^R(6|7|8|9|10)/i.test(appliedDistrict || "")
    || Number(osr) > 0;
  const maxBaseHeightFt = coerceNumber(appliedRule.maximumBaseHeightFt)
    ?? coerceNumber(baselineEnvelopeResults?.zoning_analysis?.base_height_ft)
    ?? 0;

  const allowableFloorArea = lotAreaFt2 * far;
  console.log("[zoning] selected lot", {
    bbl: activeLotData?.bbl || "n/a",
    address: activeLotData?.address || "n/a",
    zone: zoningStudyDefaults?.primaryDistrict || activeLotData?.zonedist1 || activeLotData?.zone || "n/a",
  });
  console.log("[zoning] parsed district", zoningStudyDefaults?.parsedDistricts || []);
  if (zoningStudyDefaults?.mixedUseDetected) {
    console.log("[zoning] mixed district detected", true);
  }
  const {
    lotGeometry,
    yardAdjustedGeometry,
    maxFootprintAreaFt2,
    geometryFallbackUsed,
    classification,
    frontBufferGeometry,
    rearBufferGeometry,
    sideBufferGeometry,
    usedSimplifiedFallback,
    edgeRules,
    roadCenterlineFeatures,
  } = _computeYardAdjustedGeometry(
    activeLotPolygon,
    {
      frontYardFt,
      sideYardFt,
      rearYardFt,
      appliedRule,
      appliedDistrict,
      mixedUseDetected: zoningStudyDefaults?.mixedUseDetected,
    }
  );
  console.log("[zoning] lot type", classification?.lotType || "Irregular");
  console.log("[zoning] front edge", classification?.frontEdgeIndices || []);
  console.log("[zoning] side edges", classification?.sideEdgeIndices || []);
  console.log("[zoning] rear edge", classification?.rearEdgeIndex ?? null);

  const openSpaceRequired = usesOpenSpaceRatio ? Math.max(0, allowableFloorArea * osr / 100) : 0;
  const openSpaceProvided = Math.max(0, lotAreaFt2 - maxFootprintAreaFt2);
  const openSpaceDeficit = Math.max(0, openSpaceRequired - openSpaceProvided);
  let finalBuildableFootprintFt2 = Math.max(0, maxFootprintAreaFt2);
  let clampWarning = null;

  const minFootprintFt2 = lotAreaFt2 * 0.22;
  const tooConstrained = maxFootprintAreaFt2 <= minFootprintFt2;
  if (!tooConstrained && finalBuildableFootprintFt2 < minFootprintFt2) {
    finalBuildableFootprintFt2 = minFootprintFt2;
    clampWarning = "Footprint clamped for visualization because assumptions produced an unrealistic result.";
  }

  console.log("[buildability] open space required", openSpaceRequired);
  console.log("[buildability] open space provided", openSpaceProvided);
  console.log("[buildability] open space deficit", openSpaceDeficit);
  console.log("[buildability] final footprint", finalBuildableFootprintFt2);
  console.log("[zoning] required open space", openSpaceRequired);
  console.log("[zoning] provided open space", openSpaceProvided);
  console.log("[zoning] buildable footprint", finalBuildableFootprintFt2);
  console.log("[zoning] allowable floor area", allowableFloorArea);

  let finalBuildableGeometry = _normalizeStudyGeometry(yardAdjustedGeometry);
  if (_areaFt2FromGeometry(finalBuildableGeometry) < minFootprintFt2) {
    const fallbackScale = Math.sqrt(0.22);
    const fallbackRing = _closeRing(activeLotPolygon).map((point, _, ring) => {
      const centroid = turf.centroid({ type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: {} }).geometry.coordinates;
      return [centroid[0] + (point[0] - centroid[0]) * fallbackScale, centroid[1] + (point[1] - centroid[1]) * fallbackScale];
    });
    finalBuildableGeometry = { type: "Polygon", coordinates: [_normalizePolygonRing(fallbackRing)] };
    clampWarning = "Footprint expanded to a readable study minimum because edge constraints produced a very small geometry.";
  }
  console.log("[debug] lot area", lotAreaFt2);
  console.log("[debug] footprint", finalBuildableFootprintFt2);
  console.log("[debug] allowable floor area", allowableFloorArea);
  console.log("[yard-geometry] final buildable footprint", {
    area_ft2: _areaFt2FromGeometry(finalBuildableGeometry),
    target_area_ft2: finalBuildableFootprintFt2,
  });
  console.log("[yard-geometry] final footprint area", _areaFt2FromGeometry(finalBuildableGeometry));

  let estimatedFloors = null;
  let envelopeHeightFt = 0;
  let fullFarFits = false;
  let requiredHeightFt = 0;

  if (finalBuildableFootprintFt2 > 0) {
    estimatedFloors = allowableFloorArea / finalBuildableFootprintFt2;
    requiredHeightFt = estimatedFloors * floorHeightFt;
    envelopeHeightFt = Math.min(requiredHeightFt, maxHeightFt);
    fullFarFits = requiredHeightFt <= maxHeightFt + 1e-6;
  }

  console.log("[buildability] required height", requiredHeightFt);
  console.log("[buildability] final envelope height", envelopeHeightFt);
  console.log("[debug] required height", requiredHeightFt);
  console.log("[debug] final height", envelopeHeightFt);
  console.log("[zoning] required height", requiredHeightFt);
  console.log("[zoning] final envelope height", envelopeHeightFt);

  console.log("[assumptions] recalculated zoning study", {
    osr, rearYardFt, floorHeightFt, maxHeightFt,
    allowableFloorArea, openSpaceRequired, openSpaceProvided, openSpaceDeficit,
    finalBuildableFootprintFt2, estimatedFloors, requiredHeightFt, envelopeHeightFt, fullFarFits,
  });

  return {
    lotAreaFt2,
    far,
    osr,
    usesOpenSpaceRatio,
    frontYardFt,
    sideYardFt,
    rearYardFt,
    floorHeightFt,
    maxHeightFt,
    allowableFloorArea,
    yardAdjustedFootprintFt2: maxFootprintAreaFt2,
    openSpaceRequired,
    openSpaceProvided,
    openSpaceDeficit,
    finalBuildableFootprintFt2,
    estimatedFloors,
    requiredHeightFt,
    envelopeHeightFt,
    maxBaseHeightFt,
    fullFarFits,
    clampWarning,
    geometryFallbackUsed,
    lotType: classification?.lotType || "Irregular",
    lotWarnings: classification?.warnings || [],
    rearEstimated: !!classification?.rearEstimated,
    lotGeometry,
    yardAdjustedGeometry,
    finalBuildableGeometry,
    frontBufferGeometry,
    rearBufferGeometry,
    sideBufferGeometry,
    edgeDebugFeatures: _edgeDebugFeatures(classification),
    edgeRules,
    streetType: edgeRules?.streetType || "narrow",
    nearestRoadName: classification?.nearestRoadName || "Unknown road",
    frontEdgeDistanceFt: classification?.frontEdgeDistanceM != null ? classification.frontEdgeDistanceM * 3.28084 : null,
    rearEdgeDistanceFt: classification?.rearEdgeDistanceM != null ? classification.rearEdgeDistanceM * 3.28084 : null,
    edgeDetectionRoadName: classification?.nearestRoadName || "Unknown road",
    edgeDetectionMethod: classification?.detectionMethod || "road centerline proximity",
    roadCenterlineFeatures,
    appliedDistrict,
    mixedUseDetected: !!zoningStudyDefaults?.mixedUseDetected,
    usedSimplifiedFallback,
    deltaRearYardFt: rearYardFt - defaultRearYardFt,
    deltaBuildableFootprintFt2: finalBuildableFootprintFt2 - baselineBuildableFootprintFt2,
    deltaEstimatedFloors: (estimatedFloors ?? 0) - baselineEstimatedFloors,
    deltaEnvelopeHeightFt: envelopeHeightFt - baselineEnvelopeHeightFt,
  };
}

// ─── Assumptions: update study panel numbers in-place ───

function _updateStudyPanelNumbers(result) {
  if (!result) return;
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  set("study-val-afa", `${formatNumber(result.allowableFloorArea, 0)} sf`);
  set("study-val-yardfp", `${formatNumber(result.yardAdjustedFootprintFt2, 0)} sf`);
  set("study-val-ros", `${formatNumber(result.openSpaceRequired, 0)} sf`);
  set("study-val-pos", `${formatNumber(result.openSpaceProvided, 0)} sf`);
  set("study-val-osd", `${formatNumber(result.openSpaceDeficit, 0)} sf`);
  set("study-val-front-yard", `${formatNumber(result.frontYardFt, 0)} ft`);
  set("study-val-side-yard", `${formatNumber(result.sideYardFt, 0)} ft`);
  set("study-val-rear-yard", `${formatNumber(result.rearYardFt, 0)} ft`);
  set("study-val-bfp", result.finalBuildableFootprintFt2 > 0 ? `${formatNumber(result.finalBuildableFootprintFt2, 0)} sf` : "—");
  set("study-val-floors", result.estimatedFloors != null ? formatNumber(result.estimatedFloors, 2) : "—");
  set("study-val-reqheight", `${formatNumber(result.requiredHeightFt, 0)} ft`);
  set("study-val-maxheight", `${formatNumber(result.maxHeightFt, 0)} ft`);
  set("study-val-height", result.envelopeHeightFt > 0 ? `${formatNumber(result.envelopeHeightFt, 0)} ft` : "—");
  set("study-val-farfits", result.fullFarFits ? "Yes" : "No");
  set("study-val-lottype", result.lotType || "Irregular");
  set("study-edge-lot-type", result.lotType || "Irregular");
  set("study-edge-street-type", result.streetType ? String(result.streetType).toUpperCase() : "N/A");

  const edgeRules = result.edgeRules?.edgeRules || [];
  const frontRules = edgeRules.filter((edge) => edge.edgeType === "front");
  const rearRules = edgeRules.filter((edge) => edge.edgeType === "rear");
  const sideRules = edgeRules.filter((edge) => edge.edgeType === "side");
  const fmtEdge = (edge) => edge
    ? `${formatNumber(edge.yardFt, 0)} ft (${edge.zrReference})`
    : "—";
  set("study-edge-front", frontRules.length ? frontRules.map((edge) => fmtEdge(edge)).join(" | ") : "—");
  set("study-edge-rear", rearRules.length ? rearRules.map((edge) => fmtEdge(edge)).join(" | ") : "—");
  set("study-edge-side-1", fmtEdge(sideRules[0]));
  set("study-edge-side-2", fmtEdge(sideRules[1]));
  set("study-edge-zr", (result.edgeRules?.zrSections || []).join(", ") || "12-10, 23-45, 23-46, 23-47, 23-60");
  set("study-detect-road", result.edgeDetectionRoadName || "Unknown road");
  set("study-detect-front-dist", result.frontEdgeDistanceFt != null ? `${formatNumber(result.frontEdgeDistanceFt, 1)} ft` : "—");
  set("study-detect-rear-dist", result.rearEdgeDistanceFt != null ? `${formatNumber(result.rearEdgeDistanceFt, 1)} ft` : "—");
  set("study-detect-lot-type", result.lotType || "Irregular");
  set("study-detect-method", result.edgeDetectionMethod || "Road centerline proximity");

  const mixedRow = document.getElementById("study-row-mixed-note");
  if (mixedRow) mixedRow.style.display = result.mixedUseDetected ? "" : "none";
  const mixedVal = document.getElementById("study-val-mixed-note");
  if (mixedVal && result.mixedUseDetected) {
    mixedVal.textContent = `Mixed zoning district detected. Applying ${result.appliedDistrict || "residential equivalent"} rule set for residential envelope.`;
  }

  set("acurrent-floor-height", `${result.floorHeightFt} ft`);
  set("acurrent-transparency", `${Number(envelopeOpacitySlider.value)}%`);
  set("acurrent-osr", `${formatNumber(result.osr, 0)}`);
  set("acurrent-front-yard", `${formatNumber(result.frontYardFt, 0)} ft`);
  set("acurrent-side-yard", `${formatNumber(result.sideYardFt, 0)} ft`);
  set("acurrent-rear-yard", `${formatNumber(result.rearYardFt, 0)} ft`);
  set("acurrent-max-height", `${formatNumber(result.maxHeightFt, 0)} ft`);

  const warnRow = document.getElementById("study-row-farwarn");
  const warnVal = document.getElementById("study-val-farwarn");
  if (warnRow) warnRow.style.display = (result.fullFarFits && !result.clampWarning) ? "none" : "";
  if (warnVal) {
    if (result.clampWarning) {
      warnVal.textContent = result.clampWarning;
    } else if (result.finalBuildableFootprintFt2 <= 0) {
      warnVal.textContent = "Buildable footprint is too small under current assumptions.";
    } else if (!result.fullFarFits) {
      warnVal.textContent = "Full FAR may not fit inside this envelope under current assumptions.";
    } else {
      warnVal.textContent = "";
    }
  }

  const lotWarnRow = document.getElementById("study-row-lotwarn");
  const lotWarnVal = document.getElementById("study-val-lotwarn");
  const lotWarnings = [...(result.lotWarnings || [])];
  if (result.geometryFallbackUsed) {
    lotWarnings.push("Street edge detection fails or clipping fallback used. Yard geometry is approximate.");
  }
  if (lotWarnRow) {
    lotWarnRow.style.display = lotWarnings.length ? "" : "none";
  }
  if (lotWarnVal) {
    lotWarnVal.textContent = lotWarnings.join(" ");
  }

  const impact = document.getElementById("study-assumption-impact");
  if (impact) {
    const bySlider = {
      rearYard: "Increasing rear yard reduces buildable footprint.",
      frontYard: "Increasing street setback reduces frontage buildability.",
      sideYard: "Increasing side yard reduces footprint along side lot lines.",
      osr: "Increasing open space ratio may reduce footprint or prevent full FAR.",
      floorHeight: "Increasing floor height makes the envelope taller.",
      maxHeight: "Increasing max height only matters if FAR requires more height.",
      transparency: "Transparency changes visualization only; buildability metrics stay the same.",
    };
    impact.textContent = bySlider[lastAssumptionChanged] || "Move a slider to see live impact.";
  }

  const scenarioBox = document.getElementById("scenario-impact-box");
  if (scenarioBox) {
    const osrText = result.usesOpenSpaceRatio
      ? `Required open space is ${formatNumber(result.openSpaceRequired, 0)} sf and provided is ${formatNumber(result.openSpaceProvided, 0)} sf.`
      : "Open space ratio does not apply for this rule set.";
    scenarioBox.textContent = `With current assumptions, this lot allows ${formatNumber(result.allowableFloorArea, 0)} sf of floor area. The edge-rule footprint is ${formatNumber(result.finalBuildableFootprintFt2, 0)} sf, requiring about ${formatNumber(result.estimatedFloors, 1)} floors. ${osrText} Final envelope height is capped at ${formatNumber(result.maxHeightFt, 0)} ft, so ${result.fullFarFits ? "full FAR fits" : "full FAR may not fit"}.`;
  }
}

// ─── Assumptions: rebuild envelope + overlay features ───

function _buildStudyEnvelopeFeaturesFromAssumptions(result, color, variant) {
  if (!result || !result.finalBuildableGeometry || result.envelopeHeightFt <= 0) return [];
  const totalHeightFt = Math.max(0, result.envelopeHeightFt);
  const baseHeightFt = Math.max(0, Math.min(totalHeightFt, Number(result.maxBaseHeightFt || 0)));
  const hasTower = totalHeightFt - baseHeightFt > 0.5;
  const towerInsetFt = Math.max(0, Math.min(12, Number(result.frontYardFt || 0) * 0.35 + Number(result.sideYardFt || 0) * 0.35 + Number(result.rearYardFt || 0) * 0.3));
  const insetGeometry = hasTower && towerInsetFt > 0
    ? (_bufferInwardGeometry(result.finalBuildableGeometry, towerInsetFt) || result.finalBuildableGeometry)
    : result.finalBuildableGeometry;
  const towerGeometry = _normalizeStudyGeometry(insetGeometry);

  const baseArea = _areaFt2FromGeometry(result.finalBuildableGeometry);
  const towerArea = _areaFt2FromGeometry(towerGeometry);
  console.log("[envelope] base height", baseHeightFt);
  console.log("[envelope] tower height", Math.max(0, totalHeightFt - baseHeightFt));
  console.log("[envelope] base footprint area", baseArea);
  console.log("[envelope] tower footprint area", towerArea);

  const features = [];
  if (baseHeightFt > 0) {
    features.push({
      type: "Feature",
      properties: {
        kind: "zoning_envelope",
        compare_variant: variant,
        color: variant === "baseline" ? "#93c5fd" : "#1d4ed8",
        base_ft: 0,
        height_ft: Math.round(baseHeightFt * 100) / 100,
      },
      geometry: result.finalBuildableGeometry,
    });
  }

  if (hasTower) {
    features.push({
      type: "Feature",
      properties: {
        kind: "zoning_envelope",
        compare_variant: variant,
        color: variant === "baseline" ? "#bfdbfe" : (color || "#60a5fa"),
        base_ft: Math.round(baseHeightFt * 100) / 100,
        height_ft: Math.round(totalHeightFt * 100) / 100,
      },
      geometry: towerGeometry,
    });
  }

  if (!features.length) {
    features.push({
      type: "Feature",
      properties: {
        kind: "zoning_envelope",
        compare_variant: variant,
        color: color || "#2563eb",
        base_ft: 0,
        height_ft: Math.round(totalHeightFt * 100) / 100,
      },
      geometry: result.finalBuildableGeometry,
    });
  }
  return features;
}

function _buildStudyOverlayFeaturesFromAssumptions(result) {
  if (!result || !result.lotGeometry || !result.yardAdjustedGeometry || !result.finalBuildableGeometry) {
    return [];
  }
  const features = [
    {
      type: "Feature",
      properties: { kind: "selected_lot", height_ft: 0, base_ft: 0, color: "#115e59", opacity: 0.12 },
      geometry: result.lotGeometry,
    },
  ];

  if (result.frontBufferGeometry) {
    features.push({
      type: "Feature",
      properties: { kind: "front_yard_zone", color: "#2563eb" },
      geometry: result.frontBufferGeometry,
    });
  }

  if (result.sideBufferGeometry) {
    features.push({
      type: "Feature",
      properties: { kind: "side_yard_zone", color: "#f97316" },
      geometry: result.sideBufferGeometry,
    });
  }

  if (result.rearBufferGeometry) {
    features.push({
      type: "Feature",
      properties: { kind: "rear_yard_zone", area_ft2: Math.round(Math.max(0, result.lotAreaFt2 - result.yardAdjustedFootprintFt2)), color: "#dc2626" },
      geometry: result.rearBufferGeometry,
    });
  }

  if (result.openSpaceDeficit > 0) {
    try {
      const openDiff = turf.difference(
        { type: "Feature", geometry: result.yardAdjustedGeometry, properties: {} },
        { type: "Feature", geometry: result.finalBuildableGeometry, properties: {} }
      );
      if (openDiff?.geometry) {
        features.push({
          type: "Feature",
          properties: { kind: "open_space_zone", area_ft2: Math.round(result.openSpaceDeficit), color: "#10b981" },
          geometry: openDiff.geometry,
        });
      }
    } catch (_err) {
      // keep without diff overlay
    }
  }

  features.push({
    type: "Feature",
    properties: { kind: "buildable_footprint", area_ft2: Math.round(result.finalBuildableFootprintFt2), color: "#14b8a6" },
    geometry: result.finalBuildableGeometry,
  });

  try {
    const buildableCentroid = turf.centroid({ type: "Feature", geometry: result.finalBuildableGeometry, properties: {} });
    features.push({
      type: "Feature",
      properties: { kind: "buildable_label", edge_label: "BUILDABLE AREA" },
      geometry: buildableCentroid.geometry,
    });
  } catch (_err) {
    // keep without label if centroid fails
  }

  if (Array.isArray(result.edgeDebugFeatures)) {
    features.push(...result.edgeDebugFeatures);
  }

  return features;
}

function _redrawEnvelopeFromAssumptions(result) {
  if (!result || !activeLotPolygon) return;
  const activeGeojson = scenarioEnvelopeGeojson || baselineEnvelopeGeojson;
  if (!activeGeojson) return;

  const overlayFeatures = _buildStudyOverlayFeaturesFromAssumptions(result);
  let envelopeFeatures = [];
  if (result.finalBuildableFootprintFt2 > 0 && result.envelopeHeightFt > 0) {
    const baselineFeatures = _extractCompareEnvelopeFeatures(baselineEnvelopeGeojson, "#93c5fd", "baseline", false);
    const scenarioFeatures = _buildStudyEnvelopeFeaturesFromAssumptions(result, "#2563eb", "scenario");
    envelopeFeatures = [...baselineFeatures, ...scenarioFeatures];
  }

  updateStudyModel({ type: "FeatureCollection", features: [...overlayFeatures, ...envelopeFeatures] });
  if (map?.getSource("road-centerlines-debug")) {
    map.getSource("road-centerlines-debug").setData(result.roadCenterlineFeatures || EMPTY_FC);
  }
  console.log("[assumptions] redrew envelope", { envelopeHeightFt: result.envelopeHeightFt, buildableFootprintFt2: result.finalBuildableFootprintFt2 });
}

// ─── Assumptions: slider input handler ───

function _onAssumptionInput(event) {
  const target = event.target;
  if (!target) return;
  const id = target.id;
  const val = Number(target.value);

  if (id === "aslider-floor-height") {
    assumptionOverrides.floorHeightFt = val;
    lastAssumptionChanged = "floorHeight";
    const el = document.getElementById("aval-floor-height");
    if (el) el.textContent = `${val} ft`;
    const cur = document.getElementById("acurrent-floor-height");
    if (cur) cur.textContent = `${val} ft`;
    console.log("[assumptions] floor height changed", val);
  } else if (id === "aslider-transparency") {
    assumptionOverrides.transparencyPct = val;
    lastAssumptionChanged = "transparency";
    const el = document.getElementById("aval-transparency");
    if (el) el.textContent = `${val}%`;
    const cur = document.getElementById("acurrent-transparency");
    if (cur) cur.textContent = `${val}%`;
    envelopeOpacitySlider.value = val;
    envelopeOpacityVal.textContent = `${val}%`;
    applyEnvelopeOpacityToLayers();
    const impact = document.getElementById("study-assumption-impact");
    if (impact) impact.textContent = "Transparency changes visualization only; buildability metrics stay the same.";
    return; // transparency doesn't affect study numbers
  } else if (id === "aslider-osr") {
    assumptionOverrides.osrOverride = val;
    lastAssumptionChanged = "osr";
    const el = document.getElementById("aval-osr");
    if (el) el.textContent = String(val);
    const cur = document.getElementById("acurrent-osr");
    if (cur) cur.textContent = String(val);
    console.log("[assumptions] open space ratio changed", val);
  } else if (id === "aslider-front-yard") {
    assumptionOverrides.frontYardFtOverride = val;
    lastAssumptionChanged = "frontYard";
    const el = document.getElementById("aval-front-yard");
    if (el) el.textContent = `${val} ft`;
    const cur = document.getElementById("acurrent-front-yard");
    if (cur) cur.textContent = `${val} ft`;
    console.log("[assumptions] front yard changed", val);
  } else if (id === "aslider-side-yard") {
    assumptionOverrides.sideYardFtOverride = val;
    lastAssumptionChanged = "sideYard";
    const el = document.getElementById("aval-side-yard");
    if (el) el.textContent = `${val} ft`;
    const cur = document.getElementById("acurrent-side-yard");
    if (cur) cur.textContent = `${val} ft`;
    console.log("[assumptions] side yard changed", val);
  } else if (id === "aslider-rear-yard") {
    assumptionOverrides.rearYardFtOverride = val;
    lastAssumptionChanged = "rearYard";
    const el = document.getElementById("aval-rear-yard");
    if (el) el.textContent = `${val} ft`;
    const cur = document.getElementById("acurrent-rear-yard");
    if (cur) cur.textContent = `${val} ft`;
    console.log("[assumptions] rear yard changed", val);
  } else if (id === "aslider-max-height") {
    assumptionOverrides.maxHeightFtOverride = val;
    lastAssumptionChanged = "maxHeight";
    const el = document.getElementById("aval-max-height");
    if (el) el.textContent = `${val} ft`;
    const cur = document.getElementById("acurrent-max-height");
    if (cur) cur.textContent = `${val} ft`;
    console.log("[assumptions] max height changed", val);
  } else {
    return;
  }

  const result = _recalcStudy();
  if (!result) return;
  lastStudyResult = result;
  _updateStudyPanelNumbers(result);
  _redrawEnvelopeFromAssumptions(result);
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
  assumptionOverrides = _defaultAssumptionOverrides();
  zoningStudyDefaults = null;
  lastAssumptionChanged = null;
  lastStudyResult = null;
  updateSelectionVisual(null, false);
  refreshSelectedLotComparisonModel();
  if (map?.getSource("road-centerlines-debug")) {
    map.getSource("road-centerlines-debug").setData(EMPTY_FC);
  }
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

  zoningStudyDefaults = null;
  lastAssumptionChanged = null;
  lastStudyResult = null;
  assumptionOverrides = _defaultAssumptionOverrides();
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

  const data = await res.json();
  const zoning = data?.results?.zoning_analysis || {};
  const study = data?.results?.zoning_buildability_study || {};
  console.log("[zoning-study] selected lot", {
    bbl: activeLotData?.bbl || "n/a",
    address: activeLotData?.address || "n/a",
    zone: zoneCode,
  });
  console.log("[zoning-study] parsed district", zoning.parsed_districts || []);
  console.log("[zoning-study] lot area", study.lot_area_ft2 ?? data?.results?.lot_area_ft2 ?? null);
  console.log("[zoning-study] allowable floor area", study.allowable_floor_area_ft2 ?? zoning.allowable_floor_area_ft2 ?? null);
  console.log("[zoning-study] required open space", study.required_open_space_ft2 ?? zoning.open_space_required_ft2 ?? null);
  console.log("[zoning-study] buildable footprint", study.buildable_footprint_ft2 ?? null);
  console.log("[zoning-study] final envelope height", study.envelope_height_ft ?? data?.results?.full_envelope_height_ft ?? null);

  return data;
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
  activeOriginalZone = pickPrimaryZoneToken(data.zoning_analysis?.primary_zone, data.zonedist1, data.zonedist2);
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
  activeOriginalZone = pickPrimaryZoneToken(data.zoning_analysis?.primary_zone, data.zonedist1, data.zonedist2);
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
  if (!target) {
    return;
  }

  if (target.id === "showYardEdgeTypesToggle") {
    showYardEdgeTypes = !!target.checked;
    syncLayerVisibility();
    if (lastStudyResult) {
      _redrawEnvelopeFromAssumptions(lastStudyResult);
    }
    return;
  }

  if (target.id === "showRoadCenterlinesToggle") {
    showRoadCenterlines = !!target.checked;
    syncLayerVisibility();
    if (lastStudyResult) {
      _redrawEnvelopeFromAssumptions(lastStudyResult);
    }
    return;
  }

  if (target.id === "focusSelectedLotToggle") {
    focusSelectedLotMode = !!target.checked;
    syncLayerVisibility();
    return;
  }

  if (target.id !== "zoneOverrideSelect") {
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

// Assumption sliders
lotSummary.addEventListener("input", (event) => {
  _onAssumptionInput(event);
});

// Assumption reset button
lotSummary.addEventListener("click", (event) => {
  if (event.target?.id !== "assumption-reset-btn") return;
  assumptionOverrides = _defaultAssumptionOverrides();
  lastAssumptionChanged = null;
  lastStudyResult = null;
  const envelopeResults = scenarioEnvelopeResults || baselineEnvelopeResults;
  updateLotSummary(activeLotData, envelopeResults);
  const details = document.getElementById("assumptionsDetails");
  if (details) details.open = true;
  const result = _recalcStudy();
  if (result) {
    lastStudyResult = result;
    _updateStudyPanelNumbers(result);
    _redrawEnvelopeFromAssumptions(result);
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
