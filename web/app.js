import { analyzeLot } from "./lotAnalyzer.js";
import { generateEnvelopeFromControls } from "./envelopeGenerator.js";
import {
  buildRulesIndex as buildRuleIndexModule,
  getControlsForLot,
  extractZoneTokens as extractZoneTokensModule,
} from "./zoningRuleEngine.js";
import { buildFarMassing } from "./src/zoning/farMassing.js";
import { DiagramSystemIntegration } from "./src/diagrams/DiagramSystemIntegration.js";
import { ArchitecturalDiagramRenderer } from "./src/diagrams/ArchitecturalDiagramRenderer.js";
import { ArchitecturalIsometricRenderer } from "./src/diagrams/ArchitecturalIsometricRenderer.js";
import { HighResolutionExporter } from "./src/diagrams/HighResolutionExporter.js";

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
const ZONING_RULES_URLS = ["/web/zoningRules.json", "/web/zoning-rules.jsonld"];

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
let ntaData = null; // loaded once from /nta.geojson
let zoningRuleIndex = new Map();
let diagramMode = false;
let presentationMode = false;
// Multi-lot selection state
let multiSelectedLots = [];       // array of lot GeoJSON features
let showMaxEnvelope = true;        // toggle: MAX zoning envelope (blue)
let showFarEnvelope = true;        // toggle: FAR buildable envelope (green)
let analysisPanelOpen = false;     // whether the analysis modal is open
let lastFarEnvelopeData = null;    // { numFloors, buildingHeightFt, warnings }
let lastMaxEnvelopeGeojson = EMPTY_FC;
let lastFarEnvelopeGeojson = EMPTY_FC;
let isoRenderer = null;
let isoScene = null;
let isoCamera = null;
let isoAnimationFrame = null;
let analysisModalLots = [];
let diagramSystem = null; // New: integrated diagram rendering system
let studyState = {
  floorHeight: 10,
  farUsed: 3.0,
  footprintCoverage: 80,
  envelopeOpacity: 0.35,
  massingType: "fullBlock",
  analysis: null,
  controls: null,
  maxEnvelope: null,
};

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
const diagramModeBtn = document.getElementById("diagramModeBtn");
const presentationModeBtn = document.getElementById("presentationModeBtn");
// New action buttons
const analyzeSelectionBtn = document.getElementById("analyzeSelectionBtn");
const clearSelectionBtn = document.getElementById("clearSelectionBtn");
const toggleMaxEnvelopeBtn = document.getElementById("toggleMaxEnvelopeBtn");
const toggleFarEnvelopeBtn = document.getElementById("toggleFarEnvelopeBtn");
const uploadProposalBtn = document.getElementById("uploadProposalBtn");
const analysisPanel = document.getElementById("analysisModalOverlay");
const closePanelBtn = document.getElementById("closePanelBtn");
const exportDiagramBtn = document.getElementById("exportDiagramBtn");
const exportReportBtn = document.getElementById("exportReportBtn");
const openFullAnalysisBtn = document.getElementById("openFullAnalysisBtn");

coverageInput.addEventListener("input", () => {
  covVal.textContent = `${coverageInput.value}%`;
  if (activeLotPolygon && activeLotData) {
    _rebuildFarEnvelope();
  }
});

// Bottom-bar floor height slider sync
const floorHeightBottomSlider = document.getElementById("floorHeightBottomSlider");
const floorHeightBottomVal = document.getElementById("floorHeightBottomVal");
if (floorHeightBottomSlider) {
  floorHeightBottomSlider.addEventListener("input", () => {
    if (floorHeightBottomVal) floorHeightBottomVal.textContent = `${floorHeightBottomSlider.value} ft`;
    // Sync to hidden floorHeight input
    const fh = document.getElementById("floorHeight");
    if (fh) fh.value = floorHeightBottomSlider.value;
    // Sync to analysis panel slider
    const apFh = document.getElementById("floorHeightSlider") || document.getElementById("amFloorHeight") || document.getElementById("apFloorHeight");
    if (apFh) {
      apFh.value = floorHeightBottomSlider.value;
      const disp = document.getElementById("floor-height-display") || document.getElementById("am-floor-display");
      if (disp) disp.textContent = `${floorHeightBottomSlider.value} ft`;
    }
    if (analysisPanelOpen) {
      updateStudySheetGeometry();
    } else if (activeLotPolygon && activeLotData) {
      _rebuildFarEnvelope();
    }
  });
}

farInput.addEventListener("input", () => {
  farVal.textContent = Number(farInput.value).toFixed(2);
  if (activeLotPolygon && activeLotData) {
    _rebuildFarEnvelope();
  }
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
  // Also apply (scaled down) to the neighborhood ghost-volume envelope
  if (map.getLayer("zoning-envelope-layer")) {
    // Envelope opacity: higher base for visibility
    const baseOpacity = presentationMode ? 0.12 : 0.40;
    // Opacity scales with slider across full range
    const opacity = baseOpacity + scenarioOpacity * 0.15;
    map.setPaintProperty("zoning-envelope-layer", "fill-extrusion-opacity", opacity);
  }
  if (map.getLayer("zoning-envelope-outline")) {
    const outlineOpacity = presentationMode ? 0.0 : (0.5 + scenarioOpacity * 0.15);
    map.setPaintProperty("zoning-envelope-outline", "line-opacity", outlineOpacity);
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

// Diagram mode: desaturates basemap via CSS + lightens buildings for a clean arch diagram look
function applyDiagramMode() {
  document.body.classList.toggle("diagram-mode", diagramMode);
  if (diagramModeBtn) {
    diagramModeBtn.classList.toggle("active", diagramMode);
  }
  if (presentationModeBtn) {
    presentationModeBtn.classList.toggle("active", presentationMode);
  }
  if (!map) return;
  if (map.getLayer("existing-buildings-mapbox")) {
    map.setPaintProperty(
      "existing-buildings-mapbox",
      "fill-extrusion-color",
      presentationMode ? "#f5f5f5" : diagramMode ? "#eeeeee" : "#d8d8d8"
    );
    map.setPaintProperty(
      "existing-buildings-mapbox",
      "fill-extrusion-opacity",
      presentationMode ? 0.55 : diagramMode ? (focusSelectedLotMode ? 0.15 : 0.4) : (focusSelectedLotMode ? 0.2 : 0.68)
    );
  }
  if (map.getLayer("zoning-envelope-layer")) {
    const fillOpacity = presentationMode ? 0.12 : 0.40;
    map.setPaintProperty("zoning-envelope-layer", "fill-extrusion-opacity", fillOpacity);
  }
}

function applyPresentationMode() {
  document.body.classList.toggle("presentation-mode", presentationMode);
  if (presentationModeBtn) {
    presentationModeBtn.classList.toggle("active", presentationMode);
  }
  if (!map) return;
  // Update opacity layers to reflect presentation mode
  applyEnvelopeOpacityToLayers();
  // Fade buildings in presentation mode
  if (map.getLayer("existing-buildings-mapbox")) {
    map.setPaintProperty(
      "existing-buildings-mapbox",
      "fill-extrusion-color",
      presentationMode ? "#f5f5f5" : "#d8d8d8"
    );
    map.setPaintProperty(
      "existing-buildings-mapbox",
      "fill-extrusion-opacity",
      presentationMode ? 0.55 : 0.68
    );
  }
  if (map.getLayer("zoning-envelope-layer")) {
    const fillOpacity = presentationMode ? 0.12 : 0.40;
    map.setPaintProperty("zoning-envelope-layer", "fill-extrusion-opacity", fillOpacity);
  }
}

if (diagramModeBtn) {
  diagramModeBtn.addEventListener("click", () => {
    diagramMode = !diagramMode;
    applyDiagramMode();
  });
}

if (presentationModeBtn) {
  presentationModeBtn.addEventListener("click", () => {
    presentationMode = !presentationMode;
    applyPresentationMode();
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
    let payload = null;
    let loadedFrom = null;
    for (const url of ZONING_RULES_URLS) {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        payload = await res.json();
        loadedFrom = url;
        break;
      } catch (_err) {
        // Keep trying fallback URLs.
      }
    }

    if (!payload) {
      throw new Error("Failed to load zoning rules from all configured URLs.");
    }
    const rules = Array.isArray(payload?.rules) ? payload.rules : [];
    const normalizedRules = rules
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
        return {
          ...rule,
          zoneCode,
          districtType,
          maxFar,
          usesOpenSpaceRatio,
          notes: rule.notes || (Array.isArray(rule.sourceSections) ? `ZR ${rule.sourceSections.join(", ")}` : ""),
        };
      });

    zoningRuleIndex = buildRuleIndexModule(normalizedRules);

    console.log("[zoning-rules] loaded", zoningRuleIndex.size, "rules from", loadedFrom);
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

function buildExistingBuildingsFromSplitLots(geojson) {
  const features = [];
  for (const feature of geojson.features || []) {
    const geometry = feature?.geometry;
    if (!geometry || (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")) {
      continue;
    }
    const props = extractProps(feature);
    const height = coerceNumber(props.existing_height_ft) || estimateExistingHeightFt(props) || 10;
    features.push({
      type: "Feature",
      geometry,
      properties: {
        height,
        min_height: 0,
      },
    });
  }
  return features;
}

function ruleMaxHeightFt(rule) {
  return coerceNumber(
    rule?.maximumBuildingHeightFt
      ?? rule?.ridgeHeightFt
  );
}

function computeEnvelopeHeight(props) {
  const zoneRule = resolveZoneRule(props);
  const ruleHeight = ruleMaxHeightFt(zoneRule);
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
    return "#3b82f6";  // Residential: bright blue
  }
  if (zone.startsWith("C")) {
    return "#14b8a6";  // Commercial: teal
  }
  if (zone.startsWith("M")) {
    return "#f59e0b";  // Manufacturing: orange
  }

  return "#6b7280";  // Default: gray
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
  const wide = coerceNumber(zoneRule?.streetSetbackWideFt);
  const narrow = coerceNumber(zoneRule?.streetSetbackNarrowFt);
  const insetFt = coerceNumber(
    (Number.isFinite(wide) ? wide : null)
      ?? (Number.isFinite(narrow) ? narrow : null)
      ?? zoneRule?.simplifiedPlanInsetFt
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

function _buildLightweightLotAnalysisFromProps(props) {
  const zoneTokens = extractZoneTokensModule(
    props?.zonedist1,
    props?.ZoneDist1,
    props?.zonedist2,
    props?.ZoneDist2,
    props?.zone,
    props?.ZoningDist
  );
  const primaryZone = pickPrimaryZoneToken(
    props?.zonedist1,
    props?.ZoneDist1,
    props?.zonedist2,
    props?.ZoneDist2,
    props?.zone,
    props?.ZoningDist
  );

  // Fast-path for neighborhood rendering: avoid map road/neighbor queries per lot.
  return {
    zoneTokens,
    primaryZone,
    lotType: "Interior",
    isCornerLot: false,
    isThroughLot: false,
    streetType: "narrow",
    primaryStreet: {
      name: "Unknown road",
      widthFt: 50,
      type: "narrow",
    },
    warnings: [],
  };
}
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

    const lotRing = featureGeometryToLotPolygon(feature);
    if (!lotRing || lotRing.length < 4) {
      continue;
    }

    const lotAnalysis = _buildLightweightLotAnalysisFromProps(props);

    const controlResult = getControlsForLot(
      {
        ...lotAnalysis,
        zoneTokens: lotAnalysis.zoneTokens,
      },
      zoningRuleIndex
    );

    const controlEntries = controlResult.controlsByZone || [];
    const splitGeometries = controlEntries.length > 1
      ? _splitGeometryByRatios(geometry, controlEntries.map((entry) => entry.overlapRatio || 1))
      : [geometry];

    for (let i = 0; i < controlEntries.length; i += 1) {
      const entry = controlEntries[i];
      const controls = entry.controls;
      const envelopeColor = pickZoneColor({ zone: entry.zone });
      const lotGeometry = splitGeometries[i] || geometry;
      const generated = generateEnvelopeFromControls({
        lotGeometry,
        controls,
        envelopeColor,
        zoneCode: entry.zone,
      });
      for (const piece of generated.envelopeFeatures || []) {
        features.push(piece);
      }

      if (samples.length < 5) {
        samples.push({
          bbl: props.bbl || props.BBL || "n/a",
          zone: entry.zone || props.zonedist1 || props.ZoneDist1 || "n/a",
          lotType: lotAnalysis.lotType,
          streetType: controls.streetType,
          bulkRegime: controls.bulkRegime,
          far: controls.far,
          maxHeight: controls.maxBuildingHeight,
        });
      }
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

  // Update Three.js wireframe edges to match new envelope geometry
  updateEnvelopeEdges(built.features, []);
}

function findNtaPolygon(neighborhoodName) {
  if (!ntaData || !neighborhoodName) return null;
  // Normalize: underscores → spaces, lowercase for fuzzy compare.
  const normalize = (s) => String(s).replace(/_/g, " ").toLowerCase().trim();
  const target = normalize(neighborhoodName);
  let best = null;
  for (const feature of ntaData.features || []) {
    const ntaname = normalize(feature.properties?.ntaname || "");
    if (ntaname === target) return feature; // exact match
    // Partial match fallback (target starts with NTA name or vice-versa)
    if (!best && (ntaname.includes(target) || target.includes(ntaname))) {
      best = feature;
    }
  }
  if (best) return best;

  // Geometric fallback: choose the NTA containing the neighborhood center.
  const bounds = computeNeighborhoodBounds(activeNeighborhoodData || EMPTY_FC);
  if (!bounds || bounds.isEmpty()) return null;
  const center = bounds.getCenter();
  const centerPoint = turf.point([center.lng, center.lat]);

  for (const feature of ntaData.features || []) {
    try {
      const contains = typeof turf.booleanPointInPolygon === "function"
        ? turf.booleanPointInPolygon(centerPoint, feature)
        : Boolean(turf.intersect(centerPoint, feature));
      if (contains) return feature;
    } catch (_err) {
      // Continue scanning if one feature is malformed.
    }
  }

  return null;
}

function buildNeighborhoodMaskGeometry(geojson) {
  const multiPolygonCoords = [];
  for (const feature of geojson?.features || []) {
    const geometry = feature?.geometry;
    if (!geometry) continue;
    if (geometry.type === "Polygon") {
      multiPolygonCoords.push(geometry.coordinates);
    } else if (geometry.type === "MultiPolygon") {
      for (const poly of geometry.coordinates) {
        multiPolygonCoords.push(poly);
      }
    }
  }
  if (!multiPolygonCoords.length) return null;
  return { type: "MultiPolygon", coordinates: multiPolygonCoords };
}

function refreshExistingBuildingsForNeighborhood() {
  if (!map || !map.getLayer("existing-buildings-mapbox")) return;
  map.setFilter("existing-buildings-mapbox", ["==", "$type", "Polygon"]);
  syncLayerVisibility();
  console.log("[existing-buildings] global mode: rendering all buildings");
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

// Call this whenever the neighborhood envelope features change.
function updateEnvelopeEdges(features, selectedLotFeatures) {
  // No-op: wireframe layer disabled, using fill-extrusion + outline only
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
    const layers = map.getStyle().layers || [];
    const labelLayerId = layers.find(
      (layer) => layer.type === "symbol" && layer.layout && layer.layout["text-field"]
    )?.id;

    map.addLayer(
      {
        id: "existing-buildings-mapbox",
        type: "fill-extrusion",
        source: "composite",
        "source-layer": "building",
        minzoom: 10,
        filter: ["==", "$type", "Polygon"],
        paint: {
          "fill-extrusion-color": "#d8d8d8",
          "fill-extrusion-height": ["coalesce", ["get", "height"], ["get", "render_height"], 10],
          "fill-extrusion-base": ["coalesce", ["get", "min_height"], 0],
          "fill-extrusion-opacity": 0.65,
          "fill-extrusion-vertical-gradient": true,
        },
      },
      labelLayerId
    );
    console.log("[existing-buildings] added composite/building layer");
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
        // Subtle ghost volumes for surrounding neighborhood lots
        "fill-extrusion-color": ["coalesce", ["get", "envelopeColor"], "#3b82f6"],
        "fill-extrusion-opacity": 0.15,  // deliberately subtle — selected lots use dedicated layers
        "fill-extrusion-base": ["coalesce", ["get", "envelopeBase"], 0],
        "fill-extrusion-height": ["coalesce", ["get", "envelopeHeight"], 30],
        "fill-extrusion-vertical-gradient": false,
      },
    });
    console.log("[zoning-envelope] neighborhood ghost envelope layer added");
  }

  // 2D outline layer: only show at high zoom or for selected lot
  if (!map.getLayer("zoning-envelope-outline")) {
    map.addLayer({
      id: "zoning-envelope-outline",
      type: "line",
      source: "zoning-envelope-source",
      minzoom: 15,  // only visible when zoomed in
      paint: {
        "line-color": [
          "case",
          ["boolean", ["feature-state", "isSelected"], false],
          "#007C70",  // selected lot: dark teal
          "#1E5AA8"   // non-selected: dark blue
        ],
        "line-width": [
          "case",
          ["boolean", ["feature-state", "isSelected"], false],
          2.5,
          1.2
        ],
        "line-opacity": 0.5,  // dynamically updated by applyEnvelopeOpacityToLayers
      },
    });
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

  // ── MAX ZONING ENVELOPE (blue, selected lot only) ──────────────────
  if (!map.getSource("selected-max-envelope")) {
    map.addSource("selected-max-envelope", { type: "geojson", data: EMPTY_FC });

    map.addLayer({
      id: "selected-max-envelope-fill",
      type: "fill-extrusion",
      source: "selected-max-envelope",
      paint: {
        "fill-extrusion-color": "#3b82f6",
        "fill-extrusion-opacity": 0.18,
        "fill-extrusion-base": ["coalesce", ["get", "envelopeBase"], 0],
        "fill-extrusion-height": ["coalesce", ["get", "envelopeHeight"], 30],
        "fill-extrusion-vertical-gradient": false,
      },
    });

    map.addLayer({
      id: "selected-max-envelope-outline",
      type: "line",
      source: "selected-max-envelope",
      minzoom: 14,
      paint: {
        "line-color": "#1d4ed8",
        "line-width": 1.8,
        "line-opacity": 0.7,
      },
    });
  }

  // ── FAR BUILDABLE ENVELOPE (green, selected lot only) ─────────────
  if (!map.getSource("selected-far-envelope")) {
    map.addSource("selected-far-envelope", { type: "geojson", data: EMPTY_FC });

    map.addLayer({
      id: "selected-far-envelope-fill",
      type: "fill-extrusion",
      source: "selected-far-envelope",
      paint: {
        "fill-extrusion-color": ["coalesce", ["get", "envelopeColor"], "#22c55e"],
        "fill-extrusion-opacity": 0.35,
        "fill-extrusion-base": ["coalesce", ["get", "envelopeBase"], 0],
        "fill-extrusion-height": ["coalesce", ["get", "envelopeHeight"], 30],
        "fill-extrusion-vertical-gradient": true,
      },
    });

    map.addLayer({
      id: "selected-far-envelope-outline",
      type: "line",
      source: "selected-far-envelope",
      minzoom: 14,
      paint: {
        "line-color": "#15803d",
        "line-width": 1.5,
        "line-opacity": 0.7,
      },
    });
  }

  // ── MULTI-SELECTED LOTS HIGHLIGHT ──────────────────────────────────
  if (!map.getSource("multi-selected-lots")) {
    map.addSource("multi-selected-lots", { type: "geojson", data: EMPTY_FC });

    map.addLayer({
      id: "multi-selected-lots-fill",
      type: "fill",
      source: "multi-selected-lots",
      paint: {
        "fill-color": "#f59e0b",
        "fill-opacity": 0.2,
      },
    });

    map.addLayer({
      id: "multi-selected-lots-outline",
      type: "line",
      source: "multi-selected-lots",
      paint: {
        "line-color": "#d97706",
        "line-width": 2.5,
        "line-opacity": 0.9,
      },
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
    map.setPaintProperty("existing-buildings-mapbox", "fill-extrusion-opacity", focusSelectedLotMode ? 0.2 : 0.65);
  }
}

function syncLayerVisibility() {
  if (!map) {
    return;
  }
  const existingBuildingsLayerExists = !!map.getLayer("existing-buildings-mapbox");
  if (existingBuildingsLayerExists) {
    map.setLayoutProperty(
      "existing-buildings-mapbox",
      "visibility",
      showBuildingToggle.checked ? "visible" : "none"
    );
  }
  const envelopeLayerExists = !!map.getLayer("zoning-envelope-layer");
  if (envelopeLayerExists) {
    map.setLayoutProperty("zoning-envelope-layer", "visibility", showEnvelopeToggle.checked ? "visible" : "none");
  }
  if (map.getLayer("zoning-envelope-layer")) {
    map.setLayoutProperty("zoning-envelope-layer", "visibility", showEnvelopeToggle.checked ? "visible" : "none");
  }
  if (map.getLayer("zoning-envelope-outline")) {
    map.setLayoutProperty("zoning-envelope-outline", "visibility", showEnvelopeToggle.checked ? "visible" : "none");
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
  // MAX envelope (selected lot only — toggled by showMaxEnvelope)
  for (const id of ["selected-max-envelope-fill", "selected-max-envelope-outline"]) {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, "visibility", showMaxEnvelope && showEnvelopeToggle.checked ? "visible" : "none");
    }
  }
  // FAR envelope (selected lot only — toggled by showFarEnvelope)
  for (const id of ["selected-far-envelope-fill", "selected-far-envelope-outline"]) {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, "visibility", showFarEnvelope && showEnvelopeToggle.checked ? "visible" : "none");
    }
  }
  // Multi-selected lots always visible
  for (const id of ["multi-selected-lots-fill", "multi-selected-lots-outline"]) {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, "visibility", "visible");
    }
  }
  applyFocusModeVisuals();
  if (showBuildingsBtn) {
    showBuildingsBtn.classList.toggle("active", showBuildingToggle.checked);
  }
  if (showEnvelopeBtn) {
    showEnvelopeBtn.classList.toggle("active", showEnvelopeToggle.checked);
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
  const maxHeight = ruleMaxHeightFt(rule);
  const frontWall = rule.maximumFrontWallHeightFt ?? null;
  if (minBase != null) rows.push(`<div class="summary-row"><span>Min Base Height</span><strong>${_ft(minBase)}</strong></div>`);
  if (maxBase != null) rows.push(`<div class="summary-row"><span>Max Base Height</span><strong>${_ft(maxBase)}</strong></div>`);
  if (maxHeight != null) rows.push(`<div class="summary-row"><span>Max Building Height</span><strong>${_ft(maxHeight)}</strong></div>`);
  if (frontWall != null && maxHeight == null) rows.push(`<div class="summary-row"><span>Max Front Wall</span><strong>${_ft(frontWall)}</strong></div>`);

  const frontYard = rule.frontYardFt ?? null;
  const sideYard = rule.sideYardEachFt ?? null;
  const rearYard = rule.rearYardFt ?? zoning.rear_yard_ft_required ?? null;
  const streetSetbackWide = rule.streetSetbackWideFt ?? null;
  const streetSetbackNarrow = rule.streetSetbackNarrowFt ?? null;
  const openSpaceRatio = zoning.open_space_ratio_required ?? coerceNumber(rule.openSpaceRatio ?? rule.openSpaceRatioRequired);
  const openSpaceRequiredFt2 = zoning.open_space_required_ft2 ?? null;
  if (frontYard != null) rows.push(`<div class="summary-row"><span>Front Yard</span><strong>${_ft(frontYard)}</strong></div>`);
  if (sideYard != null) rows.push(`<div class="summary-row"><span>Side Yard (each)</span><strong>${_ft(sideYard)}</strong></div>`);
  if (rearYard != null) rows.push(`<div class="summary-row"><span>Rear Yard</span><strong>${_ft(rearYard)}</strong></div>`);
  if (streetSetbackWide != null) rows.push(`<div class="summary-row"><span>Street Setback (Wide)</span><strong>${_ft(streetSetbackWide)}</strong></div>`);
  if (streetSetbackNarrow != null) rows.push(`<div class="summary-row"><span>Street Setback (Narrow)</span><strong>${_ft(streetSetbackNarrow)}</strong></div>`);
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

function _buildRuleEngineSnapshot(data) {
  if (!data?.lot_polygon || !Array.isArray(data.lot_polygon) || data.lot_polygon.length < 4) {
    return null;
  }

  const activeFeature = (activeNeighborhoodData?.features || []).find((feature) => {
    const props = extractProps(feature);
    if (data.bbl && props.bbl && String(props.bbl) === String(data.bbl)) return true;
    return String(props.borough || "") === String(data.borough || "")
      && String(props.block || "") === String(data.block || "")
      && String(props.lot || "") === String(data.lot || "");
  });

  const lotFeature = activeFeature || {
    type: "Feature",
    properties: { ...data },
    geometry: { type: "Polygon", coordinates: [_closeRing(data.lot_polygon)] },
  };

  const lotAnalysis = analyzeLot({
    lotFeature,
    lotRing: data.lot_polygon,
    map,
    neighborhoodFeatures: activeNeighborhoodData?.features || [],
  });

  const zoneTokens = extractZoneTokensModule(
    data.zonedist1,
    data.ZoneDist1,
    data.zonedist2,
    data.ZoneDist2,
    data.zone,
    data.ZoningDist
  );

  const controlsResult = getControlsForLot(
    {
      ...lotAnalysis,
      zoneTokens: zoneTokens.length ? zoneTokens : lotAnalysis.zoneTokens,
      primaryZone: pickPrimaryZoneToken(data.zonedist1, data.ZoneDist1, data.zonedist2, data.ZoneDist2, data.zone),
    },
    zoningRuleIndex
  );

  return {
    lotAnalysis,
    controlsResult,
    warnings: [
      ...(lotAnalysis?.warnings || []),
      ...(controlsResult?.warnings || []),
    ],
  };
}

function _buildRuleEngineRows(snapshot) {
  if (!snapshot?.lotAnalysis || !snapshot?.controlsResult) return "";
  const lot = snapshot.lotAnalysis;
  const controls = snapshot.controlsResult.controlsByZone || [];
  const primary = controls[0]?.controls || null;
  const sourceSections = controls
    .flatMap((entry) => Array.isArray(entry.controls?.sourceSections) ? entry.controls.sourceSections : [])
    .filter((v, i, arr) => arr.indexOf(v) === i);

  const warningRows = (snapshot.warnings || [])
    .map((warning) => `<div class="summary-row summary-row--warning"><span>Warning</span><strong>${warning}</strong></div>`)
    .join("");

  const mixedNote = snapshot.controlsResult.mixedZoning
    ? `<div class="summary-row summary-row--warning"><span>Mixed Zoning</span><strong>Yes - controls shown per district token; geometric split is simplified.</strong></div>`
    : "";

  const zones = controls.map((entry) => entry.zone).join(", ") || lot.primaryZone || "n/a";

  return `
    <div class="summary-section-head">Rule Engine Analysis</div>
    ${warningRows}
    ${mixedNote}
    <div class="summary-row"><span>Zoning District(s)</span><strong>${zones}</strong></div>
    <div class="summary-row"><span>Lot Type</span><strong>${lot.lotType || "n/a"}</strong></div>
    <div class="summary-row"><span>Street Type</span><strong>${String(lot.streetType || "narrow").toUpperCase()}</strong></div>
    <div class="summary-row"><span>Primary Street</span><strong>${lot.primaryStreet?.name || "Unknown"}</strong></div>
    <div class="summary-row"><span>Primary Street Width</span><strong>${formatNumber(lot.primaryStreet?.widthFt, 0)} ft</strong></div>
    <div class="summary-row"><span>Lot Area</span><strong>${formatNumber(lot.lotAreaFt2, 0)} sf</strong></div>
    <div class="summary-row"><span>Lot Width / Depth</span><strong>${formatNumber(lot.lotWidthFt, 0)} ft / ${formatNumber(lot.lotDepthFt, 0)} ft</strong></div>
    <div class="summary-row"><span>Front / Side / Rear Edges</span><strong>${lot.frontEdgeIndices?.length || 0} / ${lot.sideEdgeIndices?.length || 0} / ${lot.rearEdgeIndex != null ? 1 : 0}</strong></div>
    <div class="summary-row"><span>Bulk Regime</span><strong>${primary?.bulkRegime || "n/a"}</strong></div>
    <div class="summary-row"><span>FAR Used</span><strong>${formatNumber(primary?.far, 2)}</strong></div>
    <div class="summary-row"><span>Front Yard</span><strong>${formatNumber(primary?.frontYard, 0)} ft</strong></div>
    <div class="summary-row"><span>Side Yard</span><strong>${formatNumber(primary?.sideYard, 0)} ft x ${formatNumber(primary?.sideYardSidesRequired, 0)} side(s)</strong></div>
    <div class="summary-row"><span>Total Side Yard</span><strong>${formatNumber(primary?.totalSideYardRequiredFt, 0)} ft</strong></div>
    <div class="summary-row"><span>Rear Yard</span><strong>${formatNumber(primary?.rearYard, 0)} ft</strong></div>
    <div class="summary-row"><span>Street Setback Applied</span><strong>${formatNumber(primary?.streetSetback, 0)} ft (${String(primary?.streetType || "narrow").toUpperCase()})</strong></div>
    <div class="summary-row"><span>Base Height</span><strong>${formatNumber(primary?.maxBaseHeight, 0)} ft</strong></div>
    <div class="summary-row"><span>Max Height</span><strong>${formatNumber(primary?.maxBuildingHeight, 0)} ft</strong></div>
    <div class="summary-row"><span>Open Space Ratio</span><strong>${formatNumber(primary?.openSpaceRatio, 2)}</strong></div>
    <div class="summary-row summary-row--source"><span>ZR Sections</span><span>${sourceSections.join(", ") || "n/a"}</span></div>
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
  const ruleEngineSnapshot = _buildRuleEngineSnapshot(data);
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
    ${_buildRuleEngineRows(ruleEngineSnapshot)}
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
  const lotPolygon = featureGeometryToLotPolygon(feature);
  const lotAnalysis = analyzeLot({
    lotFeature: feature,
    lotRing: lotPolygon,
    map,
    neighborhoodFeatures: activeNeighborhoodData?.features || [],
  });
  const controlsResult = getControlsForLot(
    {
      ...lotAnalysis,
      primaryZone,
      zoneTokens: extractZoneTokensModule(props.zonedist1, props.zonedist2, props.zone),
    },
    zoningRuleIndex
  );
  const primaryControls = controlsResult.controlsByZone?.[0]?.controls || {};

  return {
    ...props,
    zone: primaryZone || props.zonedist1 || props.zonedist2 || null,
    lot_polygon: lotPolygon,
    zoning_analysis: {
      primary_zone: primaryZone || null,
      base_far: primaryControls.far ?? props.resid_far ?? props.comm_far ?? props.facil_far ?? 0,
      scenario_far: primaryControls.far ?? props.resid_far ?? props.comm_far ?? props.facil_far ?? 0,
      max_height_ft: primaryControls.maxBuildingHeight ?? 120,
      base_height_ft: primaryControls.maxBaseHeight ?? null,
      bulk_regime: primaryControls.bulkRegime ?? null,
      street_type: primaryControls.streetType ?? lotAnalysis.streetType ?? "narrow",
      coverage_ratio: 0.8,
      warnings: controlsResult.warnings || [],
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

function _roadWidthFtFromRoad(road) {
  const props = road?.properties || {};
  const candidates = [
    props.street_width,
    props.streetWidth,
    props.road_width,
    props.roadWidth,
    props.width_ft,
    props.width,
  ];

  for (const candidate of candidates) {
    const numeric = coerceNumber(candidate);
    if (!numeric || numeric <= 0) continue;
    // If a width-like value is small, it's likely meters; convert to feet.
    if (numeric < 30) return numeric * 3.28084;
    return numeric;
  }

  // Class-based fallback width estimate (feet) for Mapbox road classes.
  const klass = String(
    props.class
      || props.road_class
      || props.type
      || ""
  ).toLowerCase();

  if (/(motorway|trunk)/.test(klass)) return 120;
  if (/(primary|arterial)/.test(klass)) return 90;
  if (/(secondary|boulevard|avenue)/.test(klass)) return 75;
  if (/(tertiary)/.test(klass)) return 65;
  if (/(residential|street|service|link|local)/.test(klass)) return 50;
  return 50;
}

function _streetClassFromRoad(road) {
  // NYC ZR 12-10: "wide street" is generally 75 ft or wider.
  const widthFt = _roadWidthFtFromRoad(road);
  if (!Number.isFinite(widthFt) || widthFt <= 0) return "unknown";
  return widthFt >= 75 ? "wide" : "narrow";
}

function _sideYardSidesRequiredForLot(rule, classification, appliedDistrict) {
  const sideEachFt = coerceNumber(rule?.sideYardEachFt);
  if (!Number.isFinite(sideEachFt) || sideEachFt <= 0) return 0;

  const lotType = classification?.lotType || "Interior";
  const zoneCode = normalizeZoneToken(appliedDistrict || rule?.zoneCode || "");
  const isLowDensityResidence = /^R([1-5]|2X|3-1|3A|3X|4-1|4A|5A)/.test(zoneCode);

  if (lotType === "Corner") return 1;
  if (lotType === "Through") return 2;
  if (isLowDensityResidence) return 2;
  return 1;
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

  const sideEdges = (classification?.edges || [])
    .filter((edge) => classification?.sideEdgeIndices?.includes(edge.idx))
    .slice()
    .sort((a, b) => {
      const touchDelta = Number(!!b.touchesNeighbor) - Number(!!a.touchesNeighbor);
      if (touchDelta !== 0) return touchDelta;
      return (b.lengthFt || 0) - (a.lengthFt || 0);
    });
  const sideYardSidesRequired = _sideYardSidesRequiredForLot(rule, classification, appliedDistrict);
  const sideYardEdgeSet = new Set(sideEdges.slice(0, sideYardSidesRequired).map((edge) => edge.idx));

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
      const narrowStreetSetback = coerceNumber(rule?.streetSetbackNarrowFt);
      let adjustedFront = frontBase;
      if (streetType === "wide" && Number.isFinite(wideStreetSetback)) {
        adjustedFront = Math.max(frontBase, wideStreetSetback);
      } else if (streetType === "narrow" && Number.isFinite(narrowStreetSetback)) {
        adjustedFront = Math.max(frontBase, narrowStreetSetback);
      }
      yardFt = adjustedFront;
      zrReference = "ZR 23-45";
      notes = `Front/street edge setback (${streetType || "unknown"} street, ${formatNumber(edge.streetWidthFt, 0)} ft est. width).`;
    } else if (edgeType === "rear") {
      yardFt = isThrough ? 0 : Math.max(0, rearYardFt);
      zrReference = "ZR 23-47";
      notes = isThrough
        ? "Through-lot condition: rear lot line is not uniquely assigned in this approximation."
        : "Rear yard measured from rear lot line.";
    } else {
      const baseSide = Math.max(0, sideYardFt);
      yardFt = sideYardEdgeSet.has(edge.idx) ? baseSide : 0;
      zrReference = "ZR 23-46";
      notes = edge.touchesNeighbor
        ? "Side lot line touching another zoning lot."
        : "Side lot line not touching a zoning lot boundary (approximation).";
      if (!sideYardEdgeSet.has(edge.idx)) {
        notes += " Side-yard setback not applied on this edge under lot-type side-yard interpretation.";
      }
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
      streetWidthFt: coerceNumber(edge.streetWidthFt),
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
      yardFt: Math.max(0, ...edgeRules.filter((edge) => edge.edgeType === "front").map((edge) => edge.yardFt), frontYardFt),
      notes: "Approx. ZR 23-45 front yard/street setback by street condition",
    },
    side: {
      appliesTo: "side lot line",
      yardFt: Math.max(0, sideYardFt),
      notes: `Approx. ZR 23-46 side yard conditions (applied on ${sideYardSidesRequired} side lot line${sideYardSidesRequired === 1 ? "" : "s"}).`,
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
    sideYardSidesRequired,
    edgeRules,
  };
}

function _classifyLotEdges(lotRing, toleranceFt = 30) {
  const edges = _ringEdges(lotRing);
  const roads = _getNearbyRoadLines();
  const neighborLines = _getNeighborLotBoundaryLines(lotRing);

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
    edge.streetWidthFt = _roadWidthFtFromRoad(nearestRoad);
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
  const baseToleranceFt = Math.max(35, toleranceFt);
  const isStreetFacing = (edge) => {
    const widthFt = Number.isFinite(edge?.streetWidthFt) ? edge.streetWidthFt : 50;
    // Edge midpoint should be near the centerline at roughly half street width (+ frontage slack).
    const thresholdFt = Math.max(baseToleranceFt, (widthFt / 2) + 18);
    return Number.isFinite(edge?.minRoadDistM) && edge.minRoadDistM <= feetToMeters(thresholdFt);
  };

  if (primaryFrontEdge) {
    streetEdgeIndices.push(primaryFrontEdge.idx);
  }

  for (const edge of edgesByRoadDistance) {
    if (streetEdgeIndices.includes(edge.idx)) continue;
    if (isStreetFacing(edge)) {
      streetEdgeIndices.push(edge.idx);
    }
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

function _splitGeometryByRatios(geometry, ratios) {
  if (!geometry || !Array.isArray(ratios) || !ratios.length) {
    return [geometry];
  }

  let bbox;
  try {
    bbox = turf.bbox({ type: "Feature", geometry, properties: {} });
  } catch (_err) {
    return [geometry];
  }

  const [minX, minY, maxX, maxY] = bbox;
  const width = maxX - minX;
  const height = maxY - minY;
  const splitAlongX = width >= height;
  const axisStart = splitAlongX ? minX : minY;
  const axisEnd = splitAlongX ? maxX : maxY;
  const axisLength = axisEnd - axisStart;
  if (!Number.isFinite(axisLength) || axisLength <= 0) {
    return [geometry];
  }

  const sum = ratios.reduce((acc, r) => acc + Math.max(0, Number(r) || 0), 0) || ratios.length;
  const normalized = ratios.map((r) => {
    const n = Math.max(0, Number(r) || 0);
    return (n || (1 / ratios.length)) / sum;
  });

  let cursor = axisStart;
  const out = [];
  for (let i = 0; i < normalized.length; i += 1) {
    const isLast = i === normalized.length - 1;
    const next = isLast ? axisEnd : (cursor + (axisLength * normalized[i]));
    const clipBbox = splitAlongX
      ? [cursor, minY, next, maxY]
      : [minX, cursor, maxX, next];
    try {
      const clipped = turf.intersect(
        { type: "Feature", geometry, properties: {} },
        turf.bboxPolygon(clipBbox)
      );
      out.push(clipped?.geometry || null);
    } catch (_err) {
      out.push(null);
    }
    cursor = next;
  }
  return out;
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
  lastMaxEnvelopeGeojson = EMPTY_FC;
  lastFarEnvelopeGeojson = EMPTY_FC;
  assumptionOverrides = _defaultAssumptionOverrides();
  zoningStudyDefaults = null;
  lastAssumptionChanged = null;
  lastStudyResult = null;
  lastFarEnvelopeData = null;
  updateSelectionVisual(null, false);
  refreshSelectedLotComparisonModel();
  if (map?.getSource("road-centerlines-debug")) {
    map.getSource("road-centerlines-debug").setData(EMPTY_FC);
  }
  if (map?.getSource("selected-max-envelope")) {
    map.getSource("selected-max-envelope").setData(EMPTY_FC);
  }
  if (map?.getSource("selected-far-envelope")) {
    map.getSource("selected-far-envelope").setData(EMPTY_FC);
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
  const maxHeightFt = ruleMaxHeightFt(rule);
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

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select a neighborhood...";
  neighborhoodSelect.appendChild(placeholder);

  for (const item of availableNeighborhoods) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.name;
    neighborhoodSelect.appendChild(option);
  }

  neighborhoodSelect.value = "";
  setDataStatus(`Loaded ${availableNeighborhoods.length} neighborhood files. Select one to render buildings and envelope.`);
  refreshExistingBuildingsForNeighborhood();
}

async function loadNtaBoundaries() {
  // Try both paths to be resilient across local and deployed routing setups.
  for (const url of ["/web/nta.geojson"]) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      if (data && Array.isArray(data.features) && data.features.length) {
        ntaData = data;
        console.log("[existing-buildings] loaded NTA boundaries:", data.features.length, "from", url);
        if (activeNeighborhood && map?.getLayer("existing-buildings-mapbox")) {
          refreshExistingBuildingsForNeighborhood();
        }
        return;
      }
    } catch (_err) {
      // Continue trying fallback URLs.
    }
  }
  console.warn("[existing-buildings] failed to load NTA boundaries");
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
    .then(() => {
      updateLotSummary(activeLotData, baselineEnvelopeResults);
      // Build both envelope layers for the selected lot
      buildMaxEnvelopeForSelectedLot();
      buildFarEnvelopeForSelectedLot();
    })
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

  _updateSelectionButtonStates();

  generateBaselineEnvelope()
    .then(() => {
      updateLotSummary(activeLotData, baselineEnvelopeResults);
      buildMaxEnvelopeForSelectedLot();
      buildFarEnvelopeForSelectedLot();
    })
    .catch((err) => setReport(String(err)));

  return data;
}

async function handleMapClick(ev) {
  const features = map.queryRenderedFeatures(ev.point, { layers: ["neighborhood-lot-fill"] });
  if (!features.length) {
    return;
  }

  const isShiftClick = ev.originalEvent && ev.originalEvent.shiftKey;

  if (isShiftClick) {
    // Shift+click: add/remove from multi-selection
    const feature = features[0];
    const bbl = feature?.properties?.bbl || feature?.properties?.BBL || "";
    const existingIdx = multiSelectedLots.findIndex(
      (f) => (f?.properties?.bbl || f?.properties?.BBL || "") === bbl && bbl !== ""
    );
    if (existingIdx >= 0) {
      multiSelectedLots.splice(existingIdx, 1);
    } else {
      multiSelectedLots.push(feature);
    }
    _updateMultiSelectHighlight();
    _updateSelectionButtonStates();
    return;
  }

  try {
    selectLotFeature(features[0]);
  } catch (err) {
    setReport(String(err));
  }
}

// ── Multi-selection helpers ───────────────────────────────────────────────────

function _updateMultiSelectHighlight() {
  if (!map?.getSource("multi-selected-lots")) return;
  map.getSource("multi-selected-lots").setData({
    type: "FeatureCollection",
    features: multiSelectedLots,
  });
}

function _clearMultiSelection() {
  multiSelectedLots = [];
  _updateMultiSelectHighlight();
  _updateSelectionButtonStates();
}

function _updateSelectionButtonStates() {
  const hasMulti = multiSelectedLots.length > 0;
  if (analyzeSelectionBtn) {
    analyzeSelectionBtn.classList.toggle("active", hasMulti);
    analyzeSelectionBtn.disabled = !hasMulti && !activeLotData;
  }
  if (clearSelectionBtn) {
    clearSelectionBtn.disabled = !hasMulti;
  }
}

// ── MAX ZONING ENVELOPE (selected lot) ───────────────────────────────────────

function buildMaxEnvelopeForSelectedLot() {
  if (!activeLotPolygon || !activeLotData) return;
  if (!map?.getSource("selected-max-envelope")) return;

  try {
    const lotGeometry = { type: "Polygon", coordinates: [activeLotPolygon] };
    const lotFeature = { type: "Feature", geometry: lotGeometry, properties: activeLotData };

    const controlsArray = getControlsForLot(lotFeature, zoningRuleIndex);
    if (!controlsArray?.length) {
      map.getSource("selected-max-envelope").setData(EMPTY_FC);
      return;
    }

    const allFeatures = [];
    for (const { controls, zoneCode } of controlsArray) {
      const { envelopeFeatures } = generateEnvelopeFromControls({
        lotGeometry,
        controls,
        envelopeColor: "#3b82f6",
        zoneCode,
      });
      allFeatures.push(...envelopeFeatures);
    }

    map.getSource("selected-max-envelope").setData({
      type: "FeatureCollection",
      features: allFeatures,
    });
    lastMaxEnvelopeGeojson = {
      type: "FeatureCollection",
      features: allFeatures,
    };
  } catch (err) {
    console.warn("[max-envelope] build error:", err);
  }
}

// ── FAR BUILDABLE ENVELOPE (selected lot) ────────────────────────────────────

function _rebuildFarEnvelope() {
  buildFarEnvelopeForSelectedLot();
}

function buildFarEnvelopeForSelectedLot() {
  if (!activeLotPolygon || !activeLotData) return;
  if (!map?.getSource("selected-far-envelope")) return;

  try {
    const lotGeometry = { type: "Polygon", coordinates: [activeLotPolygon] };
    const lotFeature = { type: "Feature", geometry: lotGeometry, properties: activeLotData };

    const controlsArray = getControlsForLot(lotFeature, zoningRuleIndex);
    if (!controlsArray?.length) {
      map.getSource("selected-far-envelope").setData(EMPTY_FC);
      lastFarEnvelopeGeojson = EMPTY_FC;
      return;
    }

    const controls = controlsArray[0].controls;
    const zoneCode = controlsArray[0].zoneCode;

    // Get buildable footprint (with yards applied)
    const { buildableFootprintFeature } = generateEnvelopeFromControls({
      lotGeometry,
      controls,
      envelopeColor: "#22c55e",
      zoneCode,
    });

    const lotAreaFt2 = activeLotData?.lotarea ? Number(activeLotData.lotarea) : 0;
    const far = Number(farInput.value) || controls.far || 1;
    const allowedFarFloorArea = lotAreaFt2 * far;

    const floorHeightFt = Number(
      document.getElementById("amFloorHeight")?.value
      || document.getElementById("apFloorHeight")?.value
      || document.getElementById("floorHeight")?.value
      || 10
    );
    const coveragePct = Number(coverageInput.value || 80);
    const maxHeightFt = coerceNumber(controls.maxBuildingHeight) ?? 120;
    const rawMassingOption = document.getElementById("massingTypeSelect")?.value || document.getElementById("apMassingSelect")?.value || "fullBlock";
    const massingOption = rawMassingOption === "fullBlock" ? "full-block" : rawMassingOption;

    const { features, warnings, numFloors, buildingHeightFt } = buildFarMassing({
      buildableFootprintGeometry: buildableFootprintFeature?.geometry || lotGeometry,
      allowedFarFloorArea,
      floorHeightFt,
      coveragePct,
      maxHeightFt,
      massingOption,
      color: "#22c55e",
    });

    lastFarEnvelopeData = { numFloors, buildingHeightFt, warnings };

    map.getSource("selected-far-envelope").setData({
      type: "FeatureCollection",
      features,
    });
    lastFarEnvelopeGeojson = {
      type: "FeatureCollection",
      features,
    };

    // Sync analysis panel live stats if open
    if (analysisPanelOpen) {
      _updateAnalysisPanelFarStats();
    }
  } catch (err) {
    console.warn("[far-envelope] build error:", err);
  }
}

// ── ANALYSIS MODAL (centered drawing sheet) ─────────────────────────────────

function _makeAnalysisFeatureFromActive() {
  if (!activeLotPolygon || !activeLotData) return null;
  return {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [_closeRing(activeLotPolygon)] },
    properties: activeLotData,
  };
}

function _shapeRingFromGeometry(geometry) {
  const polygon = _largestPolygonGeometry(geometry);
  const ring = polygon?.coordinates?.[0] || [];
  return ring.length > 3 ? ring : [];
}

function _scaleGeometryFromCenter(geometry, ratio) {
  const clamped = Math.max(0.05, Math.min(1, Number(ratio) || 1));
  const polygon = _largestPolygonGeometry(geometry);
  const ring = polygon?.coordinates?.[0] || [];
  if (ring.length < 4 || clamped === 1) return polygon || geometry;
  let cx = 0;
  let cy = 0;
  const n = ring.length - 1;
  for (let i = 0; i < n; i += 1) {
    cx += ring[i][0];
    cy += ring[i][1];
  }
  cx /= n;
  cy /= n;
  const scaled = ring.map(([x, y]) => [cx + ((x - cx) * clamped), cy + ((y - cy) * clamped)]);
  return { type: "Polygon", coordinates: [_closeRing(scaled)] };
}

function _analysisPlanContext() {
  const selectedFeatures = (analysisModalLots || [])
    .filter((f) => f?.geometry && (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon"));
  const fallback = _makeAnalysisFeatureFromActive();
  if (!selectedFeatures.length && fallback?.geometry) {
    selectedFeatures.push(fallback);
  }

  const primary = selectedFeatures[0] || fallback;
  const props = primary?.properties || activeLotData || {};
  const lotGeometry = primary?.geometry || { type: "Polygon", coordinates: [_closeRing(activeLotPolygon || [])] };
  const lotRing = _shapeRingFromGeometry(lotGeometry);
  const selectedRings = selectedFeatures
    .map((f) => _shapeRingFromGeometry(f.geometry))
    .filter((r) => r.length > 3);
  const zoning = props.zoning_analysis || {};
  const study = baselineEnvelopeResults?.zoning_buildability_study || {};
  const lotAreaFromSelectionFt2 = selectedFeatures.reduce((sum, feature) => {
    const p = feature?.properties || {};
    const area = coerceNumber(p.lotarea ?? p.lot_area ?? p.LotArea);
    if (area && area > 0) return sum + area;
    const ring = _shapeRingFromGeometry(feature?.geometry);
    return sum + _polygonAreaFt2(ring);
  }, 0);
  const lotAreaFt2 = Number(lotAreaFromSelectionFt2 || props.lotarea || props.lot_area || study.lot_area_ft2 || 0);
  const far = Number(document.getElementById("amFarSlider")?.value || farInput.value || zoning.base_far || study.far || 1);
  const coveragePct = Number(document.getElementById("amCoverageSlider")?.value || coverageInput.value || 80);
  const frontYard = coerceNumber(study.front_yard_requirement_ft) ?? coerceNumber(zoning.front_yard_ft) ?? 10;
  const rearYard = coerceNumber(study.rear_yard_requirement_ft) ?? coerceNumber(zoning.rear_yard_ft) ?? 20;
  const sideYard = coerceNumber(study.side_yard_requirement_ft) ?? coerceNumber(zoning.side_yard_ft) ?? 8;
  const streetType = String(zoning.street_type || study.street_type || "narrow").toLowerCase();
  const streetSetback = streetType.includes("wide") ? 15 : 10;
  const maxBuildableAreaFt2 = coerceNumber(study.buildable_footprint_ft2) ?? lotAreaFt2;
  const maxBuildableFillRatio = lotAreaFt2 > 0 ? Math.sqrt(maxBuildableAreaFt2 / lotAreaFt2) : 0.9;
  const maxBuildableGeometry = _scaleGeometryFromCenter(lotGeometry, maxBuildableFillRatio);

  const farFootprintAreaFt2 = maxBuildableAreaFt2 * (coveragePct / 100);
  const farFootprintScaleWithinBuildable = Math.sqrt(Math.max(0.05, coveragePct / 100));
  const farFootprintGeometry = _scaleGeometryFromCenter(maxBuildableGeometry, farFootprintScaleWithinBuildable);

  const builtFar = coerceNumber(props.built_far ?? props.BuiltFAR) ?? 0.85;
  const existingHeightFt = coerceNumber(props.existing_height_ft) ?? estimateExistingHeightFt(props) ?? 10;
  const existingFootprintRatio = Math.max(0.2, Math.min(0.95, Math.sqrt(Math.max(0.05, builtFar / Math.max(far, 0.25)))));
  const existingGeometry = _scaleGeometryFromCenter(lotGeometry, existingFootprintRatio);

  const lotWidthFt = coerceNumber(props.lotwidth ?? props.lot_width ?? props.LotWidth) ?? coerceNumber(study.lot_width_ft) ?? null;
  const lotDepthFt = coerceNumber(props.lotdepth ?? props.lot_depth ?? props.LotDepth) ?? coerceNumber(study.lot_depth_ft) ?? null;

  return {
    selectedFeatures,
    selectedRings,
    props,
    zoning,
    study,
    lotGeometry,
    lotRing,
    maxBuildableGeometry,
    farFootprintGeometry,
    existingGeometry,
    existingHeightFt,
    lotAreaFt2,
    maxBuildableAreaFt2,
    farFootprintAreaFt2,
    frontYard,
    rearYard,
    sideYard,
    streetSetback,
    lotWidthFt,
    lotDepthFt,
    far,
    coveragePct,
  };
}

function drawArchitecturalDimension(ctx, start, end, offset, label) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;
  const sx = start.x + (nx * offset);
  const sy = start.y + (ny * offset);
  const ex = end.x + (nx * offset);
  const ey = end.y + (ny * offset);

  ctx.save();
  ctx.strokeStyle = "#111827";
  ctx.fillStyle = "#111827";
  ctx.lineWidth = 1;

  // Extension lines
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(sx, sy);
  ctx.moveTo(end.x, end.y);
  ctx.lineTo(ex, ey);
  ctx.stroke();

  // Dimension line
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(ex, ey);
  ctx.stroke();

  // Tick marks
  const t = 5;
  const tx1a = sx - (ux * t) - (nx * t * 0.6);
  const ty1a = sy - (uy * t) - (ny * t * 0.6);
  const tx1b = sx + (ux * t) + (nx * t * 0.6);
  const ty1b = sy + (uy * t) + (ny * t * 0.6);
  const tx2a = ex - (ux * t) - (nx * t * 0.6);
  const ty2a = ey - (uy * t) - (ny * t * 0.6);
  const tx2b = ex + (ux * t) + (nx * t * 0.6);
  const ty2b = ey + (uy * t) + (ny * t * 0.6);

  ctx.beginPath();
  ctx.moveTo(tx1a, ty1a);
  ctx.lineTo(tx1b, ty1b);
  ctx.moveTo(tx2a, ty2a);
  ctx.lineTo(tx2b, ty2b);
  ctx.stroke();

  // Label
  const mx = (sx + ex) / 2;
  const my = (sy + ey) / 2;
  ctx.font = "11px 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText(label, mx, my - 3);
  ctx.restore();
}

function _buildPlanDiagramSvg() {
  const ctx = _analysisPlanContext();
  const ring = ctx.lotRing;
  if (!ring.length) {
    return `<svg class="analysis-plan-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 520"><text x="400" y="260" text-anchor="middle" fill="#6b7280">No lot geometry available</text></svg>`;
  }

  const W = 800;
  const H = 520;
  const pad = 46;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const r of (ctx.selectedRings.length ? ctx.selectedRings : [ring])) {
    for (const [x, y] of r) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  const spanX = maxX - minX || 0.0001;
  const spanY = maxY - minY || 0.0001;
  const scale = Math.min((W - (pad * 2)) / spanX, (H - (pad * 2)) / spanY);

  const project = ([x, y]) => {
    const px = pad + ((x - minX) * scale);
    const py = H - pad - ((y - minY) * scale);
    return [px, py];
  };

  const lotPts = ring.map(project);
  const lotPoly = lotPts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const secondaryPolys = ctx.selectedRings
    .slice(1)
    .map((r) => r.map(project).map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" "));
  const buildPts = _shapeRingFromGeometry(ctx.maxBuildableGeometry).map(project);
  const farPts = _shapeRingFromGeometry(ctx.farFootprintGeometry).map(project);
  const existingPts = _shapeRingFromGeometry(ctx.existingGeometry).map(project);
  const buildPoly = buildPts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const farPoly = farPts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const existingPoly = existingPts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");

  const frontIndices = ctx.zoning.front_edge_indices || [];
  const rearIdx = Number.isInteger(ctx.zoning.rear_edge_index) ? ctx.zoning.rear_edge_index : -1;
  const sideIndices = ctx.zoning.side_edge_indices || [];

  const edgeSvg = [];
  const labelSvg = [];
  const centroid = lotPts.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0]);
  centroid[0] /= lotPts.length;
  centroid[1] /= lotPts.length;

  for (let i = 0; i < lotPts.length - 1; i += 1) {
    const [x1, y1] = lotPts[i];
    const [x2, y2] = lotPts[i + 1];
    let stroke = "#4b5563";
    let text = "SIDE";
    if (frontIndices.includes(i)) {
      stroke = "#0f172a";
      text = "FRONT";
    } else if (i === rearIdx) {
      stroke = "#334155";
      text = "REAR";
    } else if (sideIndices.includes(i)) {
      text = "SIDE";
    }
    edgeSvg.push(`<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="${stroke}" stroke-width="2.4"/>`);
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const vx = mx - centroid[0];
    const vy = my - centroid[1];
    const len = Math.hypot(vx, vy) || 1;
    const tx = mx + ((vx / len) * 16);
    const ty = my + ((vy / len) * 16);
    labelSvg.push(`<text x="${tx.toFixed(2)}" y="${ty.toFixed(2)}" text-anchor="middle" class="analysis-plan-edge-label">${text}</text>`);
  }

  const dims = [
    `Front yard setback: ${Math.round(ctx.frontYard)} ft`,
    `Rear yard setback: ${Math.round(ctx.rearYard)} ft`,
    `Side yard setback: ${Math.round(ctx.sideYard)} ft`,
    `Street setback: ${Math.round(ctx.streetSetback)} ft`,
  ];
  const dimSvg = dims.map((d, idx) => {
    const y = H - 18 - (idx * 18);
    return `
      <line x1="34" y1="${y}" x2="260" y2="${y}" class="analysis-dim-line" marker-start="url(#arrowhead)" marker-end="url(#arrowhead)"/>
      <text x="272" y="${y + 4}" class="analysis-dim-text">${d}</text>
    `;
  }).join("");

  return `
    <svg class="analysis-plan-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">
      <defs>
        <pattern id="buildableHatch" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="8" stroke="#0f766e" stroke-width="1" opacity="0.55"/>
        </pattern>
        <marker id="arrowhead" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto">
          <path d="M0,4 L8,0 L8,8 Z" fill="#111827"/>
        </marker>
      </defs>
      <rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>
      ${secondaryPolys.map((p) => `<polygon points="${p}" fill="none" stroke="#94a3b8" stroke-width="1.2"/>`).join("")}
      ${buildPoly ? `<polygon points="${buildPoly}" fill="none" stroke="#0f766e" stroke-dasharray="5 4" stroke-width="2"/>` : ""}
      ${farPoly ? `<polygon points="${farPoly}" fill="rgba(22,163,74,0.24)" stroke="#166534" stroke-width="2"/>` : ""}
      ${existingPoly ? `<polygon points="${existingPoly}" fill="rgba(107,114,128,0.45)" stroke="#4b5563" stroke-width="1.8"/>` : ""}
      <polygon points="${lotPoly}" fill="none" stroke="#111827" stroke-width="2.8"/>
      ${edgeSvg.join("")}
      ${labelSvg.join("")}
      ${dimSvg}
      <text x="${W - 12}" y="20" text-anchor="end" class="analysis-plan-label">Buildable area: ${Math.round(ctx.maxBuildableAreaFt2).toLocaleString()} sf</text>
      <text x="${W - 12}" y="40" text-anchor="end" class="analysis-plan-label">FAR footprint: ${Math.round(ctx.farFootprintAreaFt2).toLocaleString()} sf</text>
    </svg>
  `;
}

function _updateTopPlanDiagram() {
  const el = document.getElementById("amPlanDiagram");
  if (!el || !analysisPanelOpen || !diagramSystem) return;

  try {
    // Get the analysis state
    const state = window.__studySheetState || _analysisPlanContext();
    
    // Prepare lot feature for diagram system
    const lotFeature = {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [_closeRing(state.lotRing || [])],
      },
      properties: activeLotData || {},
    };

    // Prepare analysis data
    const analysisData = {
      lotGeometry: lotFeature.geometry,
      existingGeometry: state.existingGeometry,
      buildableGeometry: state.maxBuildableGeometry,
      farFootprintGeometry: state.farFootprintGeometry,
      lotArea: state.maxBuildableAreaFt2 || 0,
      buildableArea: state.maxBuildableAreaFt2 || 0,
      farFootprintArea: state.farFootprintAreaFt2 || 0,
      existingHeightFt: state.existingHeightFt || 10,
      farHeight: state.farHeightFt || 80,
      maxHeight: state.maxHeightFt || 120,
      coverage: state.footprintCoveragePct || 80,
      isCapped: state.isCapped || false,
      controls: {
        frontYardFt: state.frontYard || 0,
        rearYardFt: state.rearYard || 0,
        sideYardFt: state.sideYard || 0,
      },
    };

    // Generate diagrams
    diagramSystem.generateDiagrams(lotFeature, analysisData, map).then(result => {
      if (result.success && result.planSvg) {
        el.innerHTML = '';
        diagramSystem.renderPlanDiagram(result.planSvg, el);
      } else {
        el.innerHTML = `<div style="padding:20px; color:#6b7280;">Failed to render diagram: ${result.error || 'Unknown error'}</div>`;
      }
    }).catch(err => {
      console.error('Diagram rendering error:', err);
      el.innerHTML = `<div style="padding:20px; color:#dc2626;">Diagram error: ${err.message}</div>`;
    });
  } catch (err) {
    console.error('Plan diagram update error:', err);
    el.innerHTML = `<div style="padding:20px; color:#dc2626;">Error: ${err.message}</div>`;
  }
}

function updateStudySheetGeometry() {
  if (!analysisPanelOpen || !studyState.analysis) return;

  const floorHeightSlider = document.getElementById("floorHeightSlider");
  const farSlider = document.getElementById("farSliderModal");
  const coverageSlider = document.getElementById("coverageSliderModal");
  const opacitySlider = document.getElementById("opacitySliderModal");
  const massingTypeSelect = document.getElementById("massingTypeSelect");

  if (floorHeightSlider) studyState.floorHeight = Number(floorHeightSlider.value);
  if (farSlider) studyState.farUsed = Number(farSlider.value);
  if (coverageSlider) studyState.footprintCoverage = Number(coverageSlider.value);
  if (opacitySlider) studyState.envelopeOpacity = Number(opacitySlider.value) / 100;
  if (massingTypeSelect) studyState.massingType = String(massingTypeSelect.value || "fullBlock");

  renderStudySheet();
}

function _disposeIsometricRenderer() {
  if (isoAnimationFrame) {
    cancelAnimationFrame(isoAnimationFrame);
    isoAnimationFrame = null;
  }
  if (isoRenderer) {
    isoRenderer.dispose();
    isoRenderer = null;
  }
  isoScene = null;
  isoCamera = null;
}

function _ensureThreeLoaded() {
  if (window.THREE) return Promise.resolve(window.THREE);
  if (!window.__threeModulePromise) {
    window.__threeModulePromise = import("/web/vendor/three.module.js")
      .then((mod) => {
        window.THREE = mod;
        return mod;
      })
      .catch((err) => {
        window.__threeModulePromise = null;
        throw new Error(`Three.js failed to load from local bundle: ${String(err)}`);
      });
  }
  return window.__threeModulePromise;
}

function _lotToLocalProjectorFromRings(rings) {
  const baseRing = rings?.find((r) => Array.isArray(r) && r.length > 1) || [];
  const lat0 = baseRing[0]?.[1] || 40.7;
  const cosLat = Math.cos((lat0 * Math.PI) / 180);
  const mPerDegX = 111320 * cosLat;
  const mPerDegY = 110540;
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (const ring of rings || []) {
    for (const p of ring || []) {
      sumX += p[0];
      sumY += p[1];
      count += 1;
    }
  }
  const centroid = count ? [sumX / count, sumY / count] : [0, 0];
  return ([lng, lat]) => {
    const x = (lng - centroid[0]) * mPerDegX;
    const z = (lat - centroid[1]) * mPerDegY;
    return [x, z];
  };
}

function _shapeFromRingLocal(ring, projector, THREE) {
  const shape = new THREE.Shape();
  for (let i = 0; i < ring.length - 1; i += 1) {
    const [x, z] = projector(ring[i]);
    if (i === 0) shape.moveTo(x, z);
    else shape.lineTo(x, z);
  }
  return shape;
}

function _addExtrusion(scene, ring, projector, heightFt, color, opacity, edgeColor, THREE) {
  if (!ring || ring.length < 4 || !heightFt || heightFt <= 0) return;
  const shape = _shapeFromRingLocal(ring, projector, THREE);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: heightFt * 0.3048, bevelEnabled: false });
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshPhongMaterial({ color, transparent: opacity < 1, opacity })
  );
  scene.add(mesh);

  const edgeGeom = new THREE.EdgesGeometry(geometry);
  const edge = new THREE.LineSegments(edgeGeom, new THREE.LineBasicMaterial({ color: edgeColor, linewidth: 2 }));
  scene.add(edge);
}

function _addHeightDimension(scene, opts, THREE) {
  const x = opts.x;
  const z = opts.z;
  const heightFt = opts.heightFt || 0;
  const color = opts.color;
  const anchorX = opts.anchorX;
  const anchorZ = opts.anchorZ;
  const y2 = heightFt * 0.3048;

  const material = new THREE.LineBasicMaterial({ color });
  const mkLine = (pts) => {
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    scene.add(new THREE.Line(g, material));
  };

  // Vertical dimension line
  mkLine([
    new THREE.Vector3(x, 0, z),
    new THREE.Vector3(x, y2, z),
  ]);

  // Top/bottom ticks
  const tick = 1.4;
  mkLine([
    new THREE.Vector3(x - tick, 0, z),
    new THREE.Vector3(x + tick, 0, z),
  ]);
  mkLine([
    new THREE.Vector3(x - tick, y2, z),
    new THREE.Vector3(x + tick, y2, z),
  ]);

  // Witness lines from envelope to dimension line
  if (Number.isFinite(anchorX) && Number.isFinite(anchorZ)) {
    mkLine([
      new THREE.Vector3(anchorX, 0, anchorZ),
      new THREE.Vector3(x, 0, z),
    ]);
    mkLine([
      new THREE.Vector3(anchorX, y2, anchorZ),
      new THREE.Vector3(x, y2, z),
    ]);
  }
}

function _updateIsometricLabels(maxHeightFt, farHeightFt, existingHeightFt) {
  const set = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  set("amLabelExisting", `Existing: ${Math.round(existingHeightFt)} ft`);
  set("amLabelFar", `FAR massing: ${Math.round(farHeightFt)} ft`);
  set("amLabelMax", `Max envelope: ${Math.round(maxHeightFt)} ft`);
  set("amHeightMax", `${Math.round(maxHeightFt)} ft max height`);
  set("amHeightFar", `${Math.round(farHeightFt)} ft FAR massing`);
}

async function _updateIsometricDiagram() {
  if (!analysisPanelOpen || !diagramSystem) return;
  const viewport = document.getElementById("amIsoViewport");
  if (!viewport) return;

  try {
    const ctx = _analysisPlanContext();
    
    // Prepare lot feature for diagram system
    const lotFeature = {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [_closeRing(ctx.lotRing || [])],
      },
      properties: activeLotData || {},
    };

    // Prepare analysis data
    const analysisData = {
      lotGeometry: lotFeature.geometry,
      existingGeometry: ctx.existingGeometry,
      buildableGeometry: ctx.maxBuildableGeometry,
      farFootprintGeometry: ctx.farFootprintGeometry,
      lotArea: ctx.maxBuildableAreaFt2 || 0,
      buildableArea: ctx.maxBuildableAreaFt2 || 0,
      farFootprintArea: ctx.farFootprintAreaFt2 || 0,
      existingHeightFt: ctx.existingHeightFt || 10,
      farHeight: ctx.farHeightFt || 80,
      maxHeight: ctx.maxHeightFt || 120,
      coverage: ctx.footprintCoveragePct || 80,
      isCapped: ctx.isCapped || false,
    };

    // Generate diagrams (includes isometric)
    const result = await diagramSystem.generateDiagrams(lotFeature, analysisData, map);
    
    if (result.success && result.isoSvg) {
      viewport.innerHTML = '';
      diagramSystem.renderIsometricDiagram(result.isoSvg, viewport);
    } else {
      viewport.innerHTML = `<div class="ap-empty">Isometric rendering failed: ${result.error || 'Unknown error'}</div>`;
    }
  } catch (err) {
    console.error('Isometric diagram error:', err);
    viewport.innerHTML = `<div class="ap-empty">Isometric error: ${err.message}</div>`;
  }
}

function _ringToPolygonGeometry(ring) {
  return { type: "Polygon", coordinates: [_closeRing(ring)] };
}

function polygonArea(ring) {
  return _polygonAreaFt2(ring);
}

function scalePolygonInside(ring, ratio) {
  const scaled = _scaleGeometryFromCenter(_ringToPolygonGeometry(ring), ratio);
  return _shapeRingFromGeometry(scaled);
}

function extrudePolygon(ring, heightFt) {
  return {
    footprint: _closeRing(ring || []),
    heightFt: Math.max(0, Number(heightFt || 0)),
  };
}

function analyzeSelectedLots(selectedLots) {
  const features = (selectedLots || []).filter((f) => f?.geometry);
  const primaryFeature = features[0] || _makeAnalysisFeatureFromActive();
  if (!primaryFeature) return null;

  const lotPolygon = _shapeRingFromGeometry(primaryFeature.geometry);
  const props = primaryFeature.properties || activeLotData || {};
  const lotAnalysis = analyzeLot({
    lotFeature: primaryFeature,
    lotRing: lotPolygon,
    map,
    neighborhoodFeatures: activeNeighborhoodData?.features || [],
  });

  const primaryZone = pickPrimaryZoneToken(props.zonedist1, props.zonedist2, props.zone);
  const controlsResult = getControlsForLot(
    {
      ...lotAnalysis,
      primaryZone,
      zoneTokens: extractZoneTokensModule(props.zonedist1, props.zonedist2, props.zone),
    },
    zoningRuleIndex
  );
  const controlsByZone = controlsResult?.controlsByZone || [];
  const primaryControls = controlsByZone[0]?.controls || {};
  const zoneCode = controlsByZone[0]?.zoneCode || primaryZone || "";

  const lotGeometry = _ringToPolygonGeometry(lotPolygon);
  const generated = generateEnvelopeFromControls({
    lotGeometry,
    controls: primaryControls,
    envelopeColor: "#3b82f6",
    zoneCode,
  });
  const buildablePolygon = _shapeRingFromGeometry(generated?.buildableFootprintFeature?.geometry || lotGeometry);

  const builtFar = coerceNumber(props.built_far ?? props.BuiltFAR) ?? 0.9;
  const baseFar = coerceNumber(primaryControls.far) ?? coerceNumber(props.resid_far ?? props.comm_far ?? props.facil_far) ?? 3;
  const existingScale = Math.max(0.2, Math.min(0.95, Math.sqrt(Math.max(0.05, builtFar / Math.max(0.25, baseFar)))));
  const existingFootprint = scalePolygonInside(buildablePolygon.length ? buildablePolygon : lotPolygon, existingScale);
  const existingHeightFt = coerceNumber(props.existing_height_ft) ?? estimateExistingHeightFt(props) ?? 10;

  const ringEdges = _ringEdges(lotPolygon);
  const frontIndices = lotAnalysis?.frontEdgeIndices || [];
  const rearIndex = Number.isInteger(lotAnalysis?.rearEdgeIndex) ? lotAnalysis.rearEdgeIndex : -1;
  const edges = ringEdges.map((edge) => {
    let type = "SIDE";
    if (frontIndices.includes(edge.idx)) type = "FRONT";
    else if (edge.idx === rearIndex) type = "REAR";
    return {
      start: edge.start,
      end: edge.end,
      idx: edge.idx,
      type,
      lengthFt: edge.lengthM * 3.28084,
    };
  });

  const primaryFrontEdge = edges.find((e) => e.type === "FRONT") || edges[0];
  const rearEdge = edges.find((e) => e.type === "REAR") || edges[edges.length - 1];
  const widthLine = edges.slice().sort((a, b) => b.lengthFt - a.lengthFt)[0] || primaryFrontEdge;
  const depthLine = edges.slice().sort((a, b) => b.lengthFt - a.lengthFt)[1] || rearEdge;

  const lotWidthFt = coerceNumber(props.lotwidth ?? props.lot_width ?? props.LotWidth) ?? widthLine?.lengthFt ?? 0;
  const lotDepthFt = coerceNumber(props.lotdepth ?? props.lot_depth ?? props.LotDepth) ?? depthLine?.lengthFt ?? 0;

  return {
    lotPolygon,
    buildablePolygon,
    existingFootprint,
    existingHeightFt,
    edges,
    primaryFrontEdge,
    rearEdge,
    widthLine,
    depthLine,
    lotWidthFt,
    lotDepthFt,
    controlsRaw: primaryControls,
    zoneCode,
    selectedFeatures: features,
  };
}

function getApplicableControls(analysis) {
  const c = analysis?.controlsRaw || {};
  const zoning = activeLotData?.zoning_analysis || {};
  return {
    maximumBuildingHeightFt: coerceNumber(c.maxBuildingHeight) ?? coerceNumber(zoning.max_height_ft) ?? 120,
    streetSetbackFt: coerceNumber(c.streetWallInset) ?? coerceNumber(c.streetSetbackFt) ?? (String(zoning.street_type || "narrow").toLowerCase().includes("wide") ? 15 : 10),
    frontYardFt: coerceNumber(c.frontYard) ?? 0,
    rearYardFt: coerceNumber(c.rearYard) ?? 0,
    sideYardFt: coerceNumber(c.sideYardEach) ?? coerceNumber(c.sideYardTotal) ?? 0,
    setbacks: {
      street: coerceNumber(c.streetWallInset) ?? 0,
      front: coerceNumber(c.frontYard) ?? 0,
      rear: coerceNumber(c.rearYard) ?? 0,
      side: coerceNumber(c.sideYardEach) ?? 0,
    },
  };
}

function generateMaxEnvelope(analysis, controls) {
  const footprint = analysis?.buildablePolygon?.length ? analysis.buildablePolygon : analysis.lotPolygon;
  return extrudePolygon(footprint, controls.maximumBuildingHeightFt);
}

function computeDimensions(analysis, controls) {
  return {
    edges: (analysis.edges || []).map((edge) => ({
      start: edge.start,
      end: edge.end,
      type: edge.type,
      label: edge.type,
    })),
    dimensionLines: [
      {
        type: "street-setback",
        label: `Street setback: ${Math.round(controls.streetSetbackFt)} ft`,
        start: analysis.primaryFrontEdge?.start,
        end: analysis.primaryFrontEdge?.end,
        offsetPx: 58,
        labelOffsetPx: 9,
      },
      {
        type: "front-yard",
        label: `Front yard setback: ${Math.round(controls.frontYardFt)} ft`,
        start: analysis.primaryFrontEdge?.start,
        end: analysis.primaryFrontEdge?.end,
        offsetPx: 34,
        labelOffsetPx: 9,
      },
      {
        type: "rear-yard",
        label: `Rear yard setback: ${Math.round(controls.rearYardFt)} ft`,
        start: analysis.rearEdge?.start,
        end: analysis.rearEdge?.end,
        offsetPx: 104,
        labelOffsetPx: 9,
      },
      {
        type: "side-yard",
        label: `Side yard setback: ${Math.round(controls.sideYardFt)} ft`,
        start: analysis.widthLine?.start,
        end: analysis.widthLine?.end,
        offsetPx: 84,
        labelOffsetPx: 9,
      },
      {
        type: "lot-width",
        label: `Lot width: ${Math.round(analysis.lotWidthFt)} ft`,
        start: analysis.widthLine?.start,
        end: analysis.widthLine?.end,
        offsetPx: 130,
        labelOffsetPx: 9,
      },
      {
        type: "lot-depth",
        label: `Lot depth: ${Math.round(analysis.lotDepthFt)} ft`,
        start: analysis.depthLine?.start,
        end: analysis.depthLine?.end,
        offsetPx: 72,
        sidePreference: "opposite",
        labelOffsetPx: 9,
      },
    ].filter((d) => d.start && d.end),
  };
}

function computeStudyGeometry(state) {
  const lot = state.analysis.lotPolygon;
  const buildable = state.analysis.buildablePolygon;
  const existing = state.analysis.existingFootprint;

  const lotArea = polygonArea(lot);
  const buildableArea = polygonArea(buildable);

  const allowedFloorArea = lotArea * state.farUsed;
  const farFootprintArea = buildableArea * (state.footprintCoverage / 100);

  const rawFloorCount = farFootprintArea > 0 ? (allowedFloorArea / farFootprintArea) : 0;
  const floorCount = Math.max(1, Math.floor(rawFloorCount));

  const rawFarHeight = floorCount * state.floorHeight;
  const maxHeight = state.controls.maximumBuildingHeightFt;
  const farHeight = Math.min(rawFarHeight, maxHeight);

  const farFootprint = scalePolygonInside(buildable, state.footprintCoverage / 100);

  const farEnvelope = extrudePolygon(farFootprint, farHeight);
  const maxEnvelope = state.maxEnvelope;
  const existingMass = extrudePolygon(existing, state.analysis.existingHeightFt);

  return {
    analysis: state.analysis,
    lot,
    buildable,
    existing,
    existingMass,
    farFootprint,
    farEnvelope,
    maxEnvelope,
    lotArea,
    buildableArea,
    allowedFloorArea,
    farFootprintArea,
    floorCount,
    farHeight,
    maxHeight,
    floorHeight: state.floorHeight,
    farUsed: state.farUsed,
    coverage: state.footprintCoverage,
    opacity: state.envelopeOpacity,
    setbacks: state.controls.setbacks,
    dimensions: computeDimensions(state.analysis, state.controls),
    isCapped: rawFarHeight > maxHeight,
  };
}

function fitGeometryToCanvas(lot, canvas, padding = 80) {
  const ring = _closeRing(lot || []);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const spanX = maxX - minX || 0.0001;
  const spanY = maxY - minY || 0.0001;
  const scale = Math.min((canvas.width - (padding * 2)) / spanX, (canvas.height - (padding * 2)) / spanY);

  const transformPoint = (pt) => ({
    x: padding + ((pt[0] - minX) * scale),
    y: canvas.height - padding - ((pt[1] - minY) * scale),
  });

  return (input) => {
    if (!Array.isArray(input) || !input.length) return [];
    if (Array.isArray(input[0])) {
      return input.map((p) => transformPoint(p));
    }
    return transformPoint(input);
  };
}

function drawPolygon(ctx, points, style = {}) {
  if (!points || points.length < 3) return;
  drawPolygonPath(ctx, points);
  if (style.fill && style.fill !== "transparent") {
    ctx.fillStyle = style.fill;
    ctx.fill();
  }
  if (style.hatch) {
    ctx.save();
    const hatchCanvas = document.createElement("canvas");
    hatchCanvas.width = 12;
    hatchCanvas.height = 12;
    const hatchCtx = hatchCanvas.getContext("2d");
    if (hatchCtx) {
      hatchCtx.strokeStyle = style.hatchColor || style.stroke || "#4b5563";
      hatchCtx.lineWidth = 1;
      hatchCtx.globalAlpha = 0.45;
      hatchCtx.beginPath();
      hatchCtx.moveTo(0, 12);
      hatchCtx.lineTo(12, 0);
      hatchCtx.stroke();
      hatchCtx.beginPath();
      hatchCtx.moveTo(-3, 9);
      hatchCtx.lineTo(3, 3);
      hatchCtx.moveTo(9, 15);
      hatchCtx.lineTo(15, 9);
      hatchCtx.stroke();
      const pattern = ctx.createPattern(hatchCanvas, "repeat");
      if (pattern) {
        ctx.fillStyle = pattern;
        ctx.fill();
      }
    }
    ctx.restore();
  }
  ctx.lineWidth = style.lineWidth || 1.5;
  ctx.strokeStyle = style.stroke || "#111827";
  if (style.dash) ctx.setLineDash(style.dash);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawPolygonPath(ctx, points) {
  if (!points || points.length < 3) return;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i += 1) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.closePath();
}

function drawHatchedPolygon(ctx, points, options = {}) {
  const {
    fill = "rgba(120,120,120,0.15)",
    stroke = "#6b7280",
    hatch = "#8a8f98",
    spacing = 8,
    angle = -45,
    lineWidth = 1.25,
    dash = null,
  } = options;

  if (!points || points.length < 3) return;

  ctx.save();
  drawPolygonPath(ctx, points);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.clip();

  ctx.strokeStyle = hatch;
  ctx.lineWidth = 0.75;

  const bounds = getBounds(points);
  const rad = (angle * Math.PI) / 180;
  const run = bounds.width + bounds.height;
  for (let i = -bounds.height; i < bounds.width + bounds.height; i += spacing) {
    const x1 = bounds.minX + i;
    const y1 = bounds.minY;
    const x2 = x1 + (Math.cos(rad) * run);
    const y2 = y1 + (Math.sin(rad) * run);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  ctx.restore();

  drawPolygon(ctx, points, {
    fill: "transparent",
    stroke,
    lineWidth,
    dash,
  });
}

function drawLine(ctx, a, b, color = "#111827", width = 1) {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

function add(a, b) { return { x: a.x + b.x, y: a.y + b.y }; }
function subtract(a, b) { return { x: a.x - b.x, y: a.y - b.y }; }
function multiply(a, k) { return { x: a.x * k, y: a.y * k }; }
function midpoint(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
function normalize(v) { const m = Math.hypot(v.x, v.y) || 1; return { x: v.x / m, y: v.y / m }; }
function perpendicular(v) { return { x: -v.y, y: v.x }; }
function rotate(v, r) { return { x: (v.x * Math.cos(r)) - (v.y * Math.sin(r)), y: (v.x * Math.sin(r)) + (v.y * Math.cos(r)) }; }

function drawTextCentered(ctx, text, x, y, color = "#111827") {
  ctx.fillStyle = color;
  ctx.font = "10px 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText(text, x, y);
}

function drawAlignedDimensionLabel(ctx, label, p1, p2, offsetPx = 10) {
  const mid = midpoint(p1, p2);
  let angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);

  if (angle > Math.PI / 2 || angle < -Math.PI / 2) {
    angle += Math.PI;
  }

  const normal = {
    x: -Math.sin(angle),
    y: Math.cos(angle),
  };

  ctx.save();
  ctx.translate(mid.x + (normal.x * offsetPx), mid.y + (normal.y * offsetPx));
  ctx.rotate(angle);
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillStyle = "#374151";
  ctx.font = "10px Arial";
  ctx.fillText(label, 0, 0);
  ctx.restore();
}

function polygonCentroid(points) {
  if (!points || !points.length) return { x: 0, y: 0 };
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / points.length, y: sy / points.length };
}

function drawTick(ctx, point, dir, color = "#111827", width = 1.2) {
  const tickDir = rotate(dir, Math.PI / 4);
  const p1 = add(point, multiply(tickDir, -6));
  const p2 = add(point, multiply(tickDir, 6));
  drawLine(ctx, p1, p2, color, width);
}

function resolveDimensionNormal(a, b, centroid, sidePreference = "outward") {
  const dir = normalize(subtract(b, a));
  let normal = perpendicular(dir);
  if (centroid) {
    const edgeMid = midpoint(a, b);
    const candidateA = add(edgeMid, normal);
    const candidateB = add(edgeMid, multiply(normal, -1));
    const distA = Math.hypot(candidateA.x - centroid.x, candidateA.y - centroid.y);
    const distB = Math.hypot(candidateB.x - centroid.x, candidateB.y - centroid.y);
    if (distA < distB) {
      normal = multiply(normal, -1);
    }
  }
  if (sidePreference === "opposite") {
    normal = multiply(normal, -1);
  }
  return normal;
}

function drawDimensionLine(ctx, dim) {
  const a = dim.start;
  const b = dim.end;

  const dir = normalize(subtract(b, a));
  const normal = resolveDimensionNormal(a, b, dim.centroid, dim.sidePreference);
  const color = dim.color || "#374151";

  const a2 = add(a, multiply(normal, dim.offsetPx));
  const b2 = add(b, multiply(normal, dim.offsetPx));

  drawLine(ctx, a, a2, color, 0.9);
  drawLine(ctx, b, b2, color, 0.9);
  drawLine(ctx, a2, b2, color, 0.9);

  drawTick(ctx, a2, dir, color, 1.1);
  drawTick(ctx, b2, dir, color, 1.1);

  drawAlignedDimensionLabel(ctx, dim.label, a2, b2, dim.labelOffsetPx ?? 10);
}

function drawArchitecturalDimensions(ctx, transform, dimensions) {
  const transformedEdges = (dimensions.edges || []).map((edge) => transform(edge.start));
  const centroid = polygonCentroid(transformedEdges);
  dimensions.dimensionLines.forEach((dim) => {
    drawDimensionLine(ctx, {
      start: transform(dim.start),
      end: transform(dim.end),
      offsetPx: dim.offsetPx,
      label: dim.label,
      centroid,
      sidePreference: dim.sidePreference,
      labelOffsetPx: dim.labelOffsetPx,
    });
  });
}

function drawLotEdgeLabels(ctx, transform, edges) {
  const pts = (edges || []).flatMap((edge) => [transform(edge.start), transform(edge.end)]);
  const centroid = polygonCentroid(pts);
  for (const edge of edges || []) {
    const a = transform(edge.start);
    const b = transform(edge.end);
    const m = midpoint(a, b);
    const dir = normalize(subtract(b, a));
    let normal = perpendicular(dir);
    const aOut = add(m, multiply(normal, 18));
    const bOut = add(m, multiply(normal, -18));
    const distA = Math.hypot(aOut.x - centroid.x, aOut.y - centroid.y);
    const distB = Math.hypot(bOut.x - centroid.x, bOut.y - centroid.y);
    if (distA < distB) normal = multiply(normal, -1);
    const labelPt = add(m, multiply(normal, 18));
    drawTextCentered(ctx, edge.label, labelPt.x, labelPt.y);
  }
}

function clearCanvas(canvas) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function drawPlan(canvas, g) {
  const ctx = canvas.getContext("2d");
  const transform = fitGeometryToCanvas(g.lot, canvas, 105);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // QUATERNARY: max zoning envelope — subtle dashed guide
  drawPolygon(ctx, transform(g.buildable), {
    fill: "transparent",
    stroke: "rgba(36,92,66,0.4)",
    lineWidth: 1,
    dash: [6, 5],
  });

  // SECONDARY: existing building footprint — gray hatch
  drawHatchedPolygon(ctx, transform(g.existing), {
    fill: "rgba(200,200,200,0.18)",
    stroke: "#6b7280",
    hatch: "#9ca3af",
    spacing: 8,
    angle: -45,
    lineWidth: 1.25,
  });

  // PRIMARY: FAR / proposed massing — green fill, reads first
  drawPolygon(ctx, transform(g.farFootprint), {
    fill: g.isCapped ? "rgba(220,38,38,0.30)" : "rgba(80,180,120,0.42)",
    stroke: g.isCapped ? "#b91c1c" : "#1f7a4d",
    lineWidth: 1.75,
  });

  // Lot boundary drawn last so it reads cleanly over all fills
  drawPolygon(ctx, transform(g.lot), {
    fill: "transparent",
    stroke: "#111827",
    lineWidth: 1.8,
  });

  // Keep plan legible by avoiding extra edge-type labels.
  drawArchitecturalDimensions(ctx, transform, g.dimensions);
}

function isoProject(x, y, z, scale, origin) {
  const angle = Math.PI / 6;
  return {
    x: origin.x + ((x - y) * Math.cos(angle) * scale),
    y: origin.y + ((x + y) * Math.sin(angle) * scale) - (z * scale),
  };
}

function getBounds(points) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  return {
    minX,
    maxX,
    minY,
    maxY,
    width,
    height,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
  };
}

function fitProjectedIsoToPanel(points, canvas, dimensionReservePx = 170) {
  const bounds = getBounds(points);
  const padding = 80;
  const panelWidth = Math.max(1, canvas.width - dimensionReservePx);
  const widthScale = (panelWidth - (padding * 2)) / bounds.width;
  const heightScale = (canvas.height - (padding * 2)) / bounds.height;
  const maxScale = Math.min(widthScale, heightScale);
  const targetScale = ((canvas.height * 0.7) / bounds.height);
  const scale = Math.max(0.01, Math.min(maxScale, targetScale));

  return {
    scale,
    offsetX: (panelWidth / 2) - (bounds.centerX * scale),
    offsetY: (canvas.height / 2) - (bounds.centerY * scale),
  };
}

function createIsoTransform(lot, canvas, opts = {}) {
  const maxHeightM = feetToMeters(opts.maxHeightFt || 0);
  const dimOffsetPx = Number(opts.dimOffsetPx || 170);

  const projector = _lotToLocalProjectorFromRings([lot]);
  const local = lot.map((pt) => projector(pt));
  const projectRaw = (x, y, zM = 0) => ({
    x: (x - y) * Math.cos(Math.PI / 6),
    y: (x + y) * Math.sin(Math.PI / 6) - zM,
  });
  const rawPoints = [];
  for (const [x, y] of local) {
    rawPoints.push(projectRaw(x, y, 0));
    rawPoints.push(projectRaw(x, y, maxHeightM));
  }
  const fit = fitProjectedIsoToPanel(rawPoints, canvas, dimOffsetPx);
  const projectScreen = (x, y, zM = 0) => {
    const raw = projectRaw(x, y, zM);
    return {
      x: (raw.x * fit.scale) + fit.offsetX,
      y: (raw.y * fit.scale) + fit.offsetY,
    };
  };
  const projectedAll = local.flatMap(([x, y]) => [projectScreen(x, y, 0), projectScreen(x, y, maxHeightM)]);
  const frameBounds = getBounds(projectedAll);
  const frame = {
    left: frameBounds.minX,
    right: frameBounds.maxX,
    top: frameBounds.minY,
    bottom: frameBounds.maxY,
  };

  return {
    frame,
    project(lng, lat, hFt = 0) {
      const [lx, ly] = projector([lng, lat]);
      return projectScreen(lx, ly, feetToMeters(hFt));
    },
  };
}

function drawIsoBase(ctx, iso, lot) {
  const slabHeightFt = 2;
  const base = lot.map((pt) => iso.project(pt[0], pt[1], 0));
  const top = lot.map((pt) => iso.project(pt[0], pt[1], slabHeightFt));
  for (let i = 0; i < base.length - 1; i += 1) {
    drawPolygon(ctx, [base[i], base[i + 1], top[i + 1], top[i]], {
      fill: "rgba(248,250,252,0.95)",
      stroke: "#6b7280",
      lineWidth: 1,
    });
  }
  drawPolygon(ctx, top, {
    fill: "rgba(255,255,255,0.99)",
    stroke: "#111827",
    lineWidth: 1.1,
  });
}

function drawIsoExtrusion(ctx, iso, mass, style) {
  const ring = mass?.footprint || [];
  const h = Number(mass?.heightFt || 0);
  if (!ring.length || h <= 0) return;
  const base = ring.map((pt) => iso.project(pt[0], pt[1], 0));
  const top = ring.map((pt) => iso.project(pt[0], pt[1], h));

  for (let i = 0; i < base.length - 1; i += 1) {
    const quad = [base[i], base[i + 1], top[i + 1], top[i]];
    if (style.hatched) {
      drawHatchedPolygon(ctx, quad, {
        fill: style.sideFill || style.fill,
        stroke: style.stroke,
        hatch: style.hatchColor || "#8a8f98",
        spacing: style.hatchSpacing || 8,
        angle: style.hatchAngle || -45,
        lineWidth: style.edgeWidth || 1,
      });
    } else {
      drawPolygon(ctx, quad, {
        fill: style.sideFill || style.fill,
        stroke: style.stroke,
        lineWidth: style.edgeWidth || 1,
        hatch: style.hatch,
        hatchColor: style.hatchColor,
      });
    }
  }
  if (style.hatched) {
    drawHatchedPolygon(ctx, top, {
      fill: style.topFill || style.fill,
      stroke: style.stroke,
      hatch: style.hatchColor || "#8a8f98",
      spacing: style.hatchSpacing || 8,
      angle: style.hatchAngle || -45,
      lineWidth: style.lineWidth || 1.25,
    });
  } else {
    drawPolygon(ctx, top, {
      fill: style.topFill || style.fill,
      stroke: style.stroke,
      lineWidth: style.lineWidth || 2,
      hatch: style.hatch,
      hatchColor: style.hatchColor,
    });
  }
}

function drawIsoOutline(ctx, iso, mass, color = "#111827", lineWidth = 1.5) {
  const ring = mass?.footprint || [];
  const h = Number(mass?.heightFt || 0);
  if (!ring.length || h <= 0) return;
  const base = ring.map((pt) => iso.project(pt[0], pt[1], 0));
  const top = ring.map((pt) => iso.project(pt[0], pt[1], h));
  drawPolygon(ctx, top, { fill: "transparent", stroke: color, lineWidth });
  for (let i = 0; i < base.length - 1; i += 1) {
    drawLine(ctx, base[i], top[i], color, 1);
  }
}

function getRightSideAnchor(ring) {
  const closed = _closeRing(ring || []);
  return closed.reduce((best, p) => (p[0] > best[0] ? p : best), closed[0] || [0, 0]);
}

function drawRotatedText(ctx, text, point, angle, color = "#111827") {
  ctx.save();
  ctx.translate(point.x, point.y);
  ctx.rotate(angle);
  ctx.fillStyle = color;
  ctx.font = "10px 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

function drawRotatedLabelWithBackground(ctx, text, point, angle, color) {
  ctx.save();
  ctx.translate(point.x, point.y);
  ctx.rotate(angle);

  ctx.font = "11px Arial";
  const metrics = ctx.measureText(text);
  const w = metrics.width + 6;
  const h = 14;

  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fillRect((-w / 2), (-h / 2), w, h);

  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 0, 0);

  ctx.restore();
}

function computeIsoVerticalDimensionLine(iso, dim) {
  const bottom = iso.project(dim.basePoint[0], dim.basePoint[1], 0);
  const top = iso.project(dim.basePoint[0], dim.basePoint[1], dim.heightFt);
  const lineX = iso.frame.right + dim.xOffset;
  return {
    bottom,
    top,
    lineBottom: { x: lineX, y: bottom.y },
    lineTop: { x: lineX, y: top.y },
  };
}

function drawWitnessLines(ctx, line, color) {
  drawLine(ctx, line.bottom, line.lineBottom, color, 0.9);
  drawLine(ctx, line.top, line.lineTop, color, 0.9);
}

function drawIsoHeightDimension(ctx, iso, dim) {
  const line = computeIsoVerticalDimensionLine(iso, dim);
  drawLine(ctx, line.lineBottom, line.lineTop, dim.color, 1);
  drawWitnessLines(ctx, line, dim.color);
  drawTick(ctx, line.lineBottom, { x: 1, y: 0 }, dim.color, 1);
  drawTick(ctx, line.lineTop, { x: 1, y: 0 }, dim.color, 1);

  const labelPoint = midpoint(line.lineBottom, line.lineTop);
  labelPoint.x += dim.labelOffset;
  drawRotatedLabelWithBackground(ctx, dim.label, labelPoint, -Math.PI / 2, dim.color);
}

function drawIsoHeightDimensions(ctx, iso, g) {
  const isoHeightDims = [
    {
      label: `Existing: ${Math.round(g.analysis.existingHeightFt)} ft`,
      heightFt: g.analysis.existingHeightFt,
      color: "#6b7280",
      xOffset: 25,
      labelOffset: -14,
      basePoint: getRightSideAnchor(g.existingMass.footprint || g.lot),
    },
    {
      label: `FAR massing: ${Math.round(g.farHeight)} ft`,
      heightFt: g.farHeight,
      color: "#1f7a4d",
      xOffset: 50,
      labelOffset: 14,
      basePoint: getRightSideAnchor(g.farEnvelope.footprint || g.lot),
    },
    {
      label: `Max envelope: ${Math.round(g.maxHeight)} ft`,
      heightFt: g.maxHeight,
      color: "rgba(36,92,66,0.65)",
      xOffset: 75,
      labelOffset: 18,
      basePoint: getRightSideAnchor(g.maxEnvelope.footprint || g.lot),
    },
  ];

  for (const dim of isoHeightDims) {
    drawIsoHeightDimension(ctx, iso, dim);
  }
}

function drawIso(canvas, g) {
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const iso = createIsoTransform(g.lot, canvas, {
    maxHeightFt: g.maxHeight,
    dimOffsetPx: 170,
  });

  drawIsoBase(ctx, iso, g.lot);

  // TERTIARY: max zoning envelope — very light ghost cage
  drawIsoExtrusion(ctx, iso, g.maxEnvelope, {
    fill: "rgba(140,190,160,0.12)",
    sideFill: "rgba(140,190,160,0.08)",
    topFill: "rgba(140,190,160,0.15)",
    stroke: "rgba(36,92,66,0.45)",
    lineWidth: 1,
  });

  // PRIMARY: existing building — solid white/gray, visually pops forward
  drawIsoExtrusion(ctx, iso, g.existingMass, {
    fill: "#f3f4f6",
    sideFill: "#e5e7eb",
    topFill: "#f3f4f6",
    stroke: "#111827",
    lineWidth: 1.6,
  });

  // PRIMARY: FAR / proposed massing — clear green, primary object
  drawIsoExtrusion(ctx, iso, g.farEnvelope, {
    fill: g.isCapped ? "rgba(220,38,38,0.30)" : "rgba(80,180,120,0.38)",
    sideFill: g.isCapped ? "rgba(220,38,38,0.24)" : "rgba(80,180,120,0.30)",
    topFill: g.isCapped ? "rgba(220,38,38,0.36)" : "rgba(80,180,120,0.45)",
    stroke: g.isCapped ? "#b91c1c" : "#1f7a4d",
    lineWidth: 1.6,
  });

  // Crisp outlines drawn last — envelope subtle, masses sharp
  drawIsoOutline(ctx, iso, g.maxEnvelope, "rgba(36,92,66,0.40)", 0.8);
  drawIsoOutline(ctx, iso, g.existingMass, "#111827", 1.6);
  drawIsoOutline(ctx, iso, g.farEnvelope, g.isCapped ? "#991b1b" : "#1f7a4d", 1.6);

  drawIsoHeightDimensions(ctx, iso, g);
}

function setText(selector, value) {
  const node = document.querySelector(selector);
  if (node) node.textContent = String(value);
}

function updateStudyLabels(g) {
  setText("#floor-count", g.floorCount);
  setText("#far-displayed", g.farUsed.toFixed(2));
  setText("#buildable-area", `${Math.round(g.buildableArea).toLocaleString()} sf`);
  setText("#far-footprint-area", `${Math.round(g.farFootprintArea).toLocaleString()} sf`);
  setText("#far-envelope-height", `${Math.round(g.farHeight)} ft`);
  setText("#max-zoning-height", `${Math.round(g.maxHeight)} ft`);
  setText("#floor-height-display", `${g.floorHeight} ft`);
  setText("#far-used-display", g.farUsed.toFixed(2));
  setText("#coverage-display", `${Math.round(g.coverage)}%`);
  setText("#opacity-display", `${Math.round(g.opacity * 100)}%`);
  const capNote = document.getElementById("ap-cap-note");
  if (capNote) {
    capNote.textContent = g.isCapped ? "FAR massing capped by max zoning height." : "";
    capNote.style.display = g.isCapped ? "block" : "none";
  }
}

function bindStudySheetSliders() {
  const floorHeightSlider = document.getElementById("floorHeightSlider");
  const farSlider = document.getElementById("farSliderModal");
  const coverageSlider = document.getElementById("coverageSliderModal");
  const opacitySlider = document.getElementById("opacitySliderModal");
  const massingTypeSelect = document.getElementById("massingTypeSelect");

  if (floorHeightSlider) {
    floorHeightSlider.oninput = (e) => {
      studyState.floorHeight = Number(e.target.value);
      renderStudySheet();
    };
  }

  if (farSlider) {
    farSlider.oninput = (e) => {
      studyState.farUsed = Number(e.target.value);
      renderStudySheet();
    };
  }

  if (coverageSlider) {
    coverageSlider.oninput = (e) => {
      studyState.footprintCoverage = Number(e.target.value);
      renderStudySheet();
    };
  }

  if (opacitySlider) {
    opacitySlider.oninput = (e) => {
      studyState.envelopeOpacity = Number(e.target.value) / 100;
      renderStudySheet();
    };
  }

  if (massingTypeSelect) {
    massingTypeSelect.onchange = (e) => {
      studyState.massingType = String(e.target.value || "fullBlock");
      renderStudySheet();
    };
  }
}

function renderStudySheet() {
  if (!studyState.analysis || !analysisPanelOpen) return;
  const geometry = computeStudyGeometry(studyState);

  const planCanvas = document.getElementById("planCanvas");
  const isoCanvas = document.getElementById("isoCanvas");
  if (!planCanvas || !isoCanvas) return;

  planCanvas.width = Math.max(520, planCanvas.clientWidth || 620);
  planCanvas.height = Math.max(360, planCanvas.clientHeight || 420);
  isoCanvas.width = Math.max(520, isoCanvas.clientWidth || 620);
  isoCanvas.height = Math.max(360, isoCanvas.clientHeight || 420);

  clearCanvas(planCanvas);
  clearCanvas(isoCanvas);

  drawPlan(planCanvas, geometry);
  drawIso(isoCanvas, geometry);
  updateStudyLabels(geometry);

  // Keep map-side FAR layer synced with sheet sliders.
  farInput.value = geometry.farUsed;
  farVal.textContent = Number(geometry.farUsed).toFixed(2);
  coverageInput.value = geometry.coverage;
  covVal.textContent = `${Math.round(geometry.coverage)}%`;
  const floorHeightHidden = document.getElementById("floorHeight");
  if (floorHeightHidden) floorHeightHidden.value = String(geometry.floorHeight);
  _rebuildFarEnvelope();

  console.log({
    floorHeight: geometry.floorHeight,
    farUsed: geometry.farUsed,
    footprintCoverage: geometry.coverage,
    allowedFloorArea: geometry.allowedFloorArea,
    farFootprintArea: geometry.farFootprintArea,
    floorCount: geometry.floorCount,
    farHeight: geometry.farHeight,
    maxHeight: geometry.maxHeight,
  });
}

function openStudySheet(selectedLots) {
  const analysis = analyzeSelectedLots(selectedLots);
  if (!analysis) return;

  studyState.analysis = analysis;
  studyState.controls = getApplicableControls(analysis);
  studyState.maxEnvelope = generateMaxEnvelope(analysis, studyState.controls);

  const farSlider = document.getElementById("farSliderModal");
  const floorHeightSlider = document.getElementById("floorHeightSlider");
  const coverageSlider = document.getElementById("coverageSliderModal");
  const opacitySlider = document.getElementById("opacitySliderModal");
  const massingTypeSelect = document.getElementById("massingTypeSelect");

  if (farSlider) farSlider.value = String(studyState.farUsed);
  if (floorHeightSlider) floorHeightSlider.value = String(studyState.floorHeight);
  if (coverageSlider) coverageSlider.value = String(studyState.footprintCoverage);
  if (opacitySlider) opacitySlider.value = String(Math.round(studyState.envelopeOpacity * 100));
  if (massingTypeSelect) massingTypeSelect.value = studyState.massingType;

  bindStudySheetSliders();
  renderStudySheet();
}

function openAnalysisPanel(lots) {
  if (!analysisPanel) return;
  const normalizedLots = (lots || []).map((lot) => {
    if (lot?.type === "Feature") return lot;
    if (lot?.properties && lot?.geometry) return lot;
    return null;
  }).filter(Boolean);
  if (!normalizedLots.length) {
    const activeFeature = _makeAnalysisFeatureFromActive();
    if (activeFeature) normalizedLots.push(activeFeature);
  }
  analysisModalLots = normalizedLots;
  analysisPanelOpen = true;
  analysisPanel.setAttribute("aria-hidden", "false");
  document.body.classList.add("analysis-modal-open");
  _renderAnalysisPanelContent(normalizedLots);
  analysisPanel.classList.add("open");
}

function closeAnalysisPanel() {
  if (!analysisPanel) return;
  analysisPanelOpen = false;
  analysisPanel.setAttribute("aria-hidden", "true");
  document.body.classList.remove("analysis-modal-open");
  analysisPanel.classList.remove("open");
  _disposeIsometricRenderer();
}

function _renderAnalysisPanelContent(lots) {
  const container = document.getElementById("analysisModalContent");
  if (!container) return;
  analysisModalLots = (lots || []).length ? lots : analysisModalLots;

  const primaryLot = activeLotData || analysisModalLots[0]?.properties;
  if (!primaryLot) {
    container.innerHTML = `<p class="ap-empty">Select a lot to begin analysis.</p>`;
    return;
  }

  const zoning = primaryLot.zoning_analysis || {};
  const study = baselineEnvelopeResults?.zoning_buildability_study || {};
  const maxFar = Number(zoning.base_far || study.far || 3);
  const currentFar = Number(farInput.value || maxFar || 3);
  const lotCount = analysisModalLots.length || 1;
  const selectedBbls = analysisModalLots
    .map((f) => f?.properties?.bbl)
    .filter(Boolean)
    .join(", ");

  container.innerHTML = `
    <div class="analysis-sheet">
      <div class="analysis-sheet__meta">
        <div><strong>Address:</strong> ${primaryLot.address || "n/a"}</div>
        <div><strong>BBL(s):</strong> ${selectedBbls || primaryLot.bbl || "n/a"}</div>
        <div><strong>Zoning:</strong> ${primaryLot.zonedist1 || zoning.primary_zone || "n/a"}</div>
        <div><strong>Lots Selected:</strong> ${lotCount}</div>
      </div>

      <div class="analysis-sheet__grid">
        <section class="analysis-sheet__pane">
          <div class="analysis-sheet__pane-title">Top View Plan Diagram</div>
          <div class="analysis-plan-wrap" id="amPlanDiagram">
            <canvas id="planCanvas" class="analysis-plan-canvas"></canvas>
          </div>
        </section>

        <section class="analysis-sheet__pane">
          <div class="analysis-sheet__pane-title">Isometric Massing Diagram</div>
          <div class="analysis-iso-wrap" id="amIsoViewport">
            <canvas id="isoCanvas" class="analysis-plan-canvas"></canvas>
          </div>
          <div class="analysis-iso-labels">
            <div id="amLabelExisting">Existing Building</div>
            <div id="amLabelFar">FAR Envelope</div>
            <div id="amLabelMax">Max Zoning Envelope</div>
            <div id="amHeightMax">120 ft max height</div>
            <div id="amHeightFar">90 ft FAR massing</div>
            <div id="amRearLabel">${Math.round(coerceNumber(study.rear_yard_requirement_ft) ?? 20)} ft rear yard</div>
          </div>
        </section>
      </div>

      <div class="analysis-sheet__controls">
        <div class="analysis-control">
          <label for="floorHeightSlider">Floor height <span id="floor-height-display">10 ft</span></label>
          <input id="floorHeightSlider" type="range" min="8" max="20" step="0.5" value="${studyState.floorHeight}" />
        </div>
        <div class="analysis-control">
          <label for="farSliderModal">FAR used <span id="far-used-display">${currentFar.toFixed(2)}</span></label>
          <input id="farSliderModal" type="range" min="0" max="${Math.max(1, maxFar).toFixed(2)}" step="0.05" value="${Math.min(currentFar, Math.max(1, maxFar)).toFixed(2)}" />
        </div>
        <div class="analysis-control">
          <label for="coverageSliderModal">Footprint coverage <span id="coverage-display">${Number(coverageInput.value || 80)}%</span></label>
          <input id="coverageSliderModal" type="range" min="20" max="100" step="5" value="${Number(coverageInput.value || 80)}" />
        </div>
        <div class="analysis-control">
          <label for="opacitySliderModal">Envelope opacity <span id="opacity-display">${Math.round(studyState.envelopeOpacity * 100)}%</span></label>
          <input id="opacitySliderModal" type="range" min="10" max="70" step="1" value="${Math.round(studyState.envelopeOpacity * 100)}" />
        </div>
        <div class="analysis-control analysis-control--select">
          <label for="massingTypeSelect">Massing type</label>
          <select id="massingTypeSelect">
            <option value="fullBlock">Full Block</option>
            <option value="tower">Tower</option>
            <option value="slab">Slab</option>
            <option value="courtyard">Courtyard</option>
            <option value="stepped">Stepped</option>
          </select>
        </div>
      </div>

      <div class="analysis-sheet__stats">
        <div>Floor count: <strong id="floor-count">—</strong></div>
        <div>FAR displayed: <strong id="far-displayed">${currentFar.toFixed(2)}</strong></div>
        <div>Buildable area: <strong id="buildable-area">—</strong></div>
        <div>FAR footprint area: <strong id="far-footprint-area">—</strong></div>
        <div>FAR envelope height: <strong id="far-envelope-height">—</strong></div>
        <div>Max zoning height: <strong id="max-zoning-height">${Math.round(coerceNumber(study.envelope_height_ft) ?? 120)} ft</strong></div>
      </div>
      <div class="analysis-sheet__cap-note" id="ap-cap-note" style="display:none;"></div>
    </div>
  `;

  studyState.farUsed = Number(currentFar || studyState.farUsed || 3);
  studyState.floorHeight = Number(document.getElementById("floorHeight")?.value || studyState.floorHeight || 10);
  studyState.footprintCoverage = Number(coverageInput.value || studyState.footprintCoverage || 80);

  openStudySheet(analysisModalLots);
}

function _updateAnalysisPanelFarStats() {
  if (!analysisPanelOpen) return;
  const state = window.__studySheetState || _analysisPlanContext();
  const totalAreaFt2 = Number(state.allowedFloorArea || 0);
  const footprintAreaFt2 = Number(state.footprintArea || state.farFootprintAreaFt2 || 0);
  const floorCount = Number(state.roundedFloorCount || lastFarEnvelopeData?.numFloors || 1);
  const farEnvelopeHeight = Number(state.farEnvelopeHeight || lastFarEnvelopeData?.buildingHeightFt || 0);

  const set = (id, text) => {
    const node = document.getElementById(id);
    if (node) node.textContent = text;
  };
  set("floor-count", floorCount > 0 ? `${floorCount}` : "1");
  set("far-envelope-height", farEnvelopeHeight > 0 ? `${Math.round(farEnvelopeHeight)} ft` : "0 ft");
  set("far-footprint-area", footprintAreaFt2 > 0 ? `${Math.round(footprintAreaFt2).toLocaleString()} sf` : "0 sf");
  set("buildable-area", totalAreaFt2 > 0 ? `${Math.round(totalAreaFt2).toLocaleString()} sf` : "0 sf");
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
    if (!neighborhoodSelect.value) {
      activeNeighborhood = null;
      activeNeighborhoodData = EMPTY_FC;
      clearActiveEnvelope();
      if (map?.getSource("neighborhood-lots")) {
        map.getSource("neighborhood-lots").setData(EMPTY_FC);
      }
      if (map?.getSource("zoning-envelope-source")) {
        map.getSource("zoning-envelope-source").setData(EMPTY_FC);
      }
      refreshExistingBuildingsForNeighborhood();
      syncLayerVisibility();
      setDataStatus("Select a neighborhood to load existing buildings and zoning envelope.");
      setReport("Pick a neighborhood from the dropdown, then click a lot.");
      return;
    }
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

// ── New action button handlers ────────────────────────────────────────────────

if (analyzeSelectionBtn) {
  analyzeSelectionBtn.addEventListener("click", () => {
    const lots = multiSelectedLots.length ? multiSelectedLots : (activeLotData ? [{ properties: activeLotData }] : []);
    openAnalysisPanel(lots);
  });
}

if (clearSelectionBtn) {
  clearSelectionBtn.addEventListener("click", () => {
    _clearMultiSelection();
  });
}

if (toggleMaxEnvelopeBtn) {
  toggleMaxEnvelopeBtn.addEventListener("click", () => {
    showMaxEnvelope = !showMaxEnvelope;
    toggleMaxEnvelopeBtn.classList.toggle("active", showMaxEnvelope);
    syncLayerVisibility();
  });
}

if (toggleFarEnvelopeBtn) {
  toggleFarEnvelopeBtn.addEventListener("click", () => {
    showFarEnvelope = !showFarEnvelope;
    toggleFarEnvelopeBtn.classList.toggle("active", showFarEnvelope);
    syncLayerVisibility();
  });
}

if (uploadProposalBtn) {
  uploadProposalBtn.addEventListener("click", () => {
    openAnalysisPanel(multiSelectedLots.length ? multiSelectedLots : (activeLotData ? [{ properties: activeLotData }] : []));
  });
}

if (closePanelBtn) {
  closePanelBtn.addEventListener("click", closeAnalysisPanel);
}

if (analysisPanel) {
  analysisPanel.addEventListener("click", (event) => {
    if (event.target === analysisPanel) {
      closeAnalysisPanel();
    }
  });
}

if (exportDiagramBtn) {
  exportDiagramBtn.addEventListener("click", async () => {
    if (!diagramSystem || !diagramSystem.lastGeneratedDiagrams.planSvg) {
      setReport("Open Analyze Selection with a selected lot before exporting PNG.");
      return;
    }

    try {
      // Verify export quality first
      const qualityCheck = diagramSystem.verifyExportQuality(300); // 300 DPI
      if (!qualityCheck.valid && qualityCheck.warnings.length > 0) {
        console.warn('Export warnings:', qualityCheck.warnings);
      }

      // Export as high-resolution PNG (300 DPI)
      const filename = `zoning-study-${activeLotData?.bbl || "lot"}.png`;
      setReport(`Exporting diagram at 300 DPI (${qualityCheck.exportWidth}×${qualityCheck.exportHeight}px)...`);

      const result = await diagramSystem.exportDiagrams({
        format: 'layout',
        filename,
        dpi: 300,
        layout: 'side-by-side',
      });

      if (result.success) {
        setReport(`✓ Exported ${filename} - ${result.result.size} at 300 DPI`);
      } else {
        setReport(`✗ Export failed: ${result.error}`);
      }
    } catch (err) {
      setReport(`Export error: ${String(err)}`);
    }
  });
}

if (exportReportBtn) {
  exportReportBtn.addEventListener("click", () => {
    const study = baselineEnvelopeResults?.zoning_buildability_study || {};
    const payload = {
      generated_at: new Date().toISOString(),
      lot: {
        bbl: activeLotData?.bbl || null,
        address: activeLotData?.address || null,
        zoning: activeLotData?.zonedist1 || activeLotData?.zoning_analysis?.primary_zone || null,
      },
      controls: {
        floor_height_ft: Number(document.getElementById("floorHeightSlider")?.value || 10),
        far_used: Number(document.getElementById("farSliderModal")?.value || farInput.value || 0),
        coverage_pct: Number(document.getElementById("coverageSliderModal")?.value || coverageInput.value || 80),
        massing_type: document.getElementById("massingTypeSelect")?.value || "fullBlock",
      },
      metrics: {
        far_floors: lastFarEnvelopeData?.numFloors || null,
        far_height_ft: lastFarEnvelopeData?.buildingHeightFt || null,
        max_height_ft: study.envelope_height_ft || null,
        lot_area_ft2: activeLotData?.lotarea || activeLotData?.lot_area || null,
      },
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `zoning-report-${activeLotData?.bbl || "lot"}.json`;
    link.click();
    URL.revokeObjectURL(url);
  });
}

if (openFullAnalysisBtn) {
  openFullAnalysisBtn.addEventListener("click", () => {
    window.open("/web/comparison.html", "_blank", "noopener");
  });
}

(async function bootstrap() {
  try {
    await loadZoningRules();
    const token = await resolveMapboxToken();
    await initMap(token);
    // Ensure NTA boundaries are ready before first neighborhood render.
    await loadNtaBoundaries();
    await loadNeighborhoodOptions();
    
    // Initialize new high-quality diagram system
    diagramSystem = new DiagramSystemIntegration({
      mapboxMap: map,
      enableStreetDetection: true,
      enableHighResExport: true,
      defaultExportDpi: 300,
      planRendererOptions: {
        svgWidth: 2400,
        svgHeight: 1560,
        padding: 180,
      },
      isoRendererOptions: {
        svgWidth: 2400,
        svgHeight: 1560,
        isometricAngle: 30,
        explodedSpacing: 150,
      },
      exporterOptions: {
        defaultDpi: 300,
        maxCanvasSize: 16384,
      },
    });
  } catch (err) {
    setReport(String(err));
  }
})();
