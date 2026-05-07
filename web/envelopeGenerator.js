import { coerceNumber } from "./zoningRuleEngine.js";

const FT_TO_M = 0.3048;
const EPSILON = 1e-9;

function closeRing(ring) {
  if (!Array.isArray(ring) || !ring.length) return [];
  const out = ring.map((p) => [p[0], p[1]]);
  const first = out[0];
  const last = out[out.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) out.push([first[0], first[1]]);
  return out;
}

// Straight-line polygon inset using Sutherland-Hodgman half-plane clipping.
// Does NOT use turf.buffer — that produces rounded/arc corners which are wrong
// for zoning diagrams that require strict architectural straight lines.
function uniformInsetGeometry(geometry, insetFt) {
  if (!geometry || !Number.isFinite(insetFt) || insetFt <= 0) return geometry;
  const polygon = largestPolygonGeometry(geometry);
  if (!polygon) return geometry;
  let ring = closeRing(polygon.coordinates?.[0] || []);
  if (ring.length < 4) return geometry;
  const isCcw = signedRingArea(ring) > 0;
  const insetM = insetFt * FT_TO_M;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const workRing = closeRing(ring);
    const a = workRing[i];
    const b = workRing[i + 1];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len <= EPSILON) continue;
    const nx = isCcw ? (-dy / len) : (dy / len);
    const ny = isCcw ? (dx / len) : (-dx / len);
    const lineA = [a[0] + nx * insetM, a[1] + ny * insetM];
    const lineB = [b[0] + nx * insetM, b[1] + ny * insetM];
    const clipped = clipRingByDirectedLine(ring, lineA, lineB, isCcw);
    if (clipped.length >= 4) ring = clipped;
  }
  return { type: "Polygon", coordinates: [closeRing(ring)] };
}

function largestPolygonGeometry(geometry) {
  if (!geometry) return null;
  if (geometry.type === "Polygon") return geometry;
  if (geometry.type !== "MultiPolygon") return null;
  let best = null;
  let bestArea = -1;
  for (const coords of geometry.coordinates || []) {
    const candidate = { type: "Polygon", coordinates: coords };
    try {
      const area = turf.area({ type: "Feature", geometry: candidate, properties: {} });
      if (area > bestArea) {
        bestArea = area;
        best = candidate;
      }
    } catch (_err) {
      // skip malformed polygon candidate
    }
  }
  return best;
}

function signedRingArea(ring) {
  let area = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return area / 2;
}

function cross2(ax, ay, bx, by) {
  return (ax * by) - (ay * bx);
}

function lineIntersection(a, b, c, d) {
  const r = [b[0] - a[0], b[1] - a[1]];
  const s = [d[0] - c[0], d[1] - c[1]];
  const denom = cross2(r[0], r[1], s[0], s[1]);
  if (Math.abs(denom) < EPSILON) {
    return [b[0], b[1]];
  }
  const t = cross2(c[0] - a[0], c[1] - a[1], s[0], s[1]) / denom;
  return [a[0] + (t * r[0]), a[1] + (t * r[1])];
}

function clipRingByDirectedLine(ring, lineA, lineB, keepLeft) {
  if (!Array.isArray(ring) || ring.length < 4) return [];
  const output = [];
  const input = closeRing(ring);
  const side = (point) => cross2(
    lineB[0] - lineA[0],
    lineB[1] - lineA[1],
    point[0] - lineA[0],
    point[1] - lineA[1]
  );
  const inside = (point) => {
    const val = side(point);
    return keepLeft ? (val >= -EPSILON) : (val <= EPSILON);
  };

  for (let i = 0; i < input.length - 1; i += 1) {
    const current = input[i];
    const next = input[i + 1];
    const currentInside = inside(current);
    const nextInside = inside(next);

    if (currentInside && nextInside) {
      output.push(next);
    } else if (currentInside && !nextInside) {
      output.push(lineIntersection(current, next, lineA, lineB));
    } else if (!currentInside && nextInside) {
      output.push(lineIntersection(current, next, lineA, lineB));
      output.push(next);
    }
  }

  if (!output.length) return [];
  return closeRing(output);
}

function makeEnvelopeFeature(geometry, envelopeBase, envelopeHeight, envelopeColor, zoneCode, controls, pieceLabel) {
  return {
    type: "Feature",
    geometry,
    properties: {
      envelopeBase,
      envelopeHeight,
      envelopeColor,
      zoneCode,
      bulkRegime: controls.bulkRegime,
      streetType: controls.streetType,
      pieceLabel,
    },
  };
}

// Returns: number (including 0) for a valid rule, null for an absent rule.
// 0 = district explicitly requires no setback (valid — do NOT warn).
// null = rule is genuinely absent from the zoning data (callers should warn).
function resolveYardValueFt(name, value, warnings) {
  if (value === undefined || value === null) {
    return null;   // absent rule — caller decides the warning
  }
  const numeric = coerceNumber(value);
  if (!Number.isFinite(numeric)) {
    warnings.push(`Invalid ${name} rule '${value}'; treating as no setback.`);
    return null;
  }
  if (numeric < 0) {
    warnings.push(`${name} rule is negative (${numeric} ft); clamping to 0 ft.`);
    return 0;
  }
  return numeric;
}

function resolveHeightValueFt(name, value, warnings) {
  if (value === undefined || value === null) return null;
  const numeric = coerceNumber(value);
  if (!Number.isFinite(numeric)) {
    warnings.push(`Invalid ${name} value '${value}'; ignoring.`);
    return null;
  }
  if (numeric < 0) {
    warnings.push(`${name} is negative (${numeric} ft); clamping to 0 ft.`);
    return 0;
  }
  return numeric;
}

export function getApplicableYards(controls = {}, lotAnalysis = null, warnings = []) {
  const lotType = String(lotAnalysis?.lotType || "Interior");
  const hasRearEdge = Number.isInteger(lotAnalysis?.rearEdgeIndex);

  const rawFrontYardFt = resolveYardValueFt("front yard", controls?.frontYard, warnings);
  const rawSideYardEachFt = resolveYardValueFt("side yard", controls?.sideYard, warnings);
  const rawRearYardFt = resolveYardValueFt("rear yard", controls?.rearYard, warnings);

  const explicitRearRequired = Number.isFinite(rawRearYardFt) && rawRearYardFt > 0;
  const shouldSuppressRear = (lotType === "Through" || lotType === "Island" || lotType === "Multi-Frontage")
    && !hasRearEdge
    && !explicitRearRequired;
  if (explicitRearRequired && !hasRearEdge) {
    warnings.push("Rear yard rule exists but lot has no unique rear edge; rear setback cannot be directionally assigned.");
  }

  const frontYardFt = Math.max(0, rawFrontYardFt ?? 0);
  const sideYardEachFt = Math.max(0, rawSideYardEachFt ?? 0);
  const rearYardFt = shouldSuppressRear ? 0 : Math.max(0, rawRearYardFt ?? 0);

  const fullLotCoverageAllowed = frontYardFt <= 0 && sideYardEachFt <= 0 && rearYardFt <= 0;

  return {
    frontYardFt,
    sideYardEachFt,
    rearYardFt,
    frontYardMissing: rawFrontYardFt === null,
    sideYardMissing: rawSideYardEachFt === null,
    rearYardMissing: rawRearYardFt === null,
    fullLotCoverageAllowed,
    lotType,
  };
}

export function computeOpenSpaceLimit({ lotAreaFt2, far, openSpaceRatio }) {
  const safeLotArea = coerceNumber(lotAreaFt2);
  const safeFar = coerceNumber(far);
  const safeOsr = coerceNumber(openSpaceRatio);
  if (!(safeLotArea > 0) || !(safeFar > 0) || !(safeOsr > 0)) {
    return {
      applicable: false,
      requiredOpenSpaceFt2: 0,
      maxFootprintByOpenSpaceFt2: null,
      allowedFloorAreaFt2: safeLotArea > 0 && safeFar > 0 ? safeLotArea * safeFar : null,
    };
  }

  const allowedFloorAreaFt2 = safeLotArea * safeFar;
  const requiredOpenSpaceFt2 = allowedFloorAreaFt2 * (safeOsr / 100);
  const maxFootprintByOpenSpaceFt2 = Math.max(0, safeLotArea - requiredOpenSpaceFt2);

  return {
    applicable: true,
    lotAreaFt2: safeLotArea,
    far: safeFar,
    openSpaceRatio: safeOsr,
    allowedFloorAreaFt2,
    requiredOpenSpaceFt2,
    maxFootprintByOpenSpaceFt2,
  };
}

// Compute open space ratio compliance.
// openSpaceRatio is a percentage (e.g. 20 = 20% of residential floor area must remain open).
function computeOpenSpaceCheck(lotAreaFt2, controls, buildableFootprintFt2) {
  const limit = computeOpenSpaceLimit({
    lotAreaFt2,
    far: controls?.far,
    openSpaceRatio: controls?.openSpaceRatio,
  });
  if (!limit.applicable) {
    return { applicable: false };
  }

  const actualBuildableFt2 = buildableFootprintFt2 ?? 0;
  const providedOpenSpaceFt2 = Math.max(0, limit.lotAreaFt2 - actualBuildableFt2);
  const pass = providedOpenSpaceFt2 >= limit.requiredOpenSpaceFt2;
  return {
    applicable: true,
    openSpaceRatio: limit.openSpaceRatio,
    far: limit.far,
    lotAreaFt2: Math.round(limit.lotAreaFt2),
    residentialFloorAreaFt2: Math.round(limit.allowedFloorAreaFt2),
    requiredOpenSpaceFt2: Math.round(limit.requiredOpenSpaceFt2),
    maxCoverageFt2: Math.round(limit.maxFootprintByOpenSpaceFt2),
    buildableFootprintFt2: Math.round(actualBuildableFt2),
    providedOpenSpaceFt2: Math.round(providedOpenSpaceFt2),
    pass,
  };
}

function edgeRoleMapFromLotAnalysis(lotAnalysis) {
  const roles = new Map();
  const frontIndices = Array.isArray(lotAnalysis?.frontEdgeIndices) ? lotAnalysis.frontEdgeIndices : [];
  for (const idx of frontIndices) roles.set(idx, "front");
  if (Number.isInteger(lotAnalysis?.rearEdgeIndex)) roles.set(lotAnalysis.rearEdgeIndex, "rear");
  const sideIndices = Array.isArray(lotAnalysis?.sideEdgeIndices) ? lotAnalysis.sideEdgeIndices : [];
  for (const idx of sideIndices) {
    if (!roles.has(idx)) roles.set(idx, "side");
  }
  return roles;
}

export function generateSetbackBuildableArea(lotGeometry, controls, lotAnalysis, warnings) {
  const yards = getApplicableYards(controls, lotAnalysis, warnings);
  const effectiveFrontYard = yards.frontYardFt;
  const effectiveSideYard = yards.sideYardEachFt;
  const effectiveRearYard = yards.rearYardFt;

  const polygon = largestPolygonGeometry(lotGeometry);
  if (!polygon) {
    warnings.push("Lot geometry missing polygon; using original geometry for envelope.");
    return {
      geometry: lotGeometry,
      yards,
      edgeRoles: {},
    };
  }

  let ring = closeRing(polygon.coordinates?.[0] || []);
  if (ring.length < 4) {
    warnings.push("Lot geometry ring invalid; using original geometry for envelope.");
    return {
      geometry: polygon,
      yards,
      edgeRoles: {},
    };
  }

  if (yards.fullLotCoverageAllowed) {
    return {
      geometry: polygon,
      yards,
      edgeRoles: {},
    };
  }

  const isCcw = signedRingArea(ring) > 0;
  const roleMap = edgeRoleMapFromLotAnalysis(lotAnalysis);
  if (!roleMap.size) {
    warnings.push("Missing lot edge classification; applying no directional yard offsets.");
    return {
      geometry: polygon,
      yards,
      edgeRoles: {},
    };
  }

  const workingEdges = closeRing(ring);
  const edgeRoles = {};
  const warnedOverConstraintRoles = new Set();
  for (let i = 0; i < workingEdges.length - 1; i += 1) {
    const role = roleMap.get(i) || "side";
    edgeRoles[i] = role;
    let insetFt = 0;
    if (role === "front") insetFt = effectiveFrontYard;
    else if (role === "rear") insetFt = effectiveRearYard;
    else insetFt = effectiveSideYard;
    if (!Number.isFinite(insetFt) || insetFt <= 0) continue;

    const a = workingEdges[i];
    const b = workingEdges[i + 1];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len <= EPSILON) continue;

    const insetM = insetFt * FT_TO_M;
    const nx = isCcw ? (-dy / len) : (dy / len);
    const ny = isCcw ? (dx / len) : (-dx / len);
    const lineA = [a[0] + (nx * insetM), a[1] + (ny * insetM)];
    const lineB = [b[0] + (nx * insetM), b[1] + (ny * insetM)];

    const clipped = clipRingByDirectedLine(ring, lineA, lineB, isCcw);
    if (clipped.length < 4) {
      const roleKey = String(role || "").toLowerCase();
      if (!warnedOverConstraintRoles.has(roleKey)) {
        warnings.push(`Yard offsets over-constrained lot on ${role.toUpperCase()} edge; keeping previous valid footprint.`);
        warnedOverConstraintRoles.add(roleKey);
      }
      continue;
    }
    ring = clipped;
  }

  return {
    geometry: {
      type: "Polygon",
      coordinates: [closeRing(ring)],
    },
    yards: {
      frontYardFt: effectiveFrontYard,
      sideYardEachFt: effectiveSideYard,
      rearYardFt: effectiveRearYard,
      frontYardMissing: yards.frontYardMissing,
      sideYardMissing: yards.sideYardMissing,
      rearYardMissing: yards.rearYardMissing,
      fullLotCoverageAllowed: yards.fullLotCoverageAllowed,
    },
    edgeRoles,
  };
}

function generatePitchedEnvelope(baseGeometry, controls, envelopeColor, zoneCode, warnings) {
  const maxHeight = resolveHeightValueFt("maximum building height", controls.maxBuildingHeight, warnings)
    ?? resolveHeightValueFt("ridge height", controls.ridgeHeight, warnings);
  if (maxHeight == null) return [];
  const perimeterHeight = resolveHeightValueFt("perimeter wall height", controls.perimeterWallHeight, warnings) ?? Math.max(20, maxHeight - 10);
  const ridgeHeight = resolveHeightValueFt("ridge height", controls.ridgeHeight, warnings) ?? maxHeight;

  const roofGeometry = uniformInsetGeometry(baseGeometry, Math.max(2, controls.streetSetback / 2));

  return [
    makeEnvelopeFeature(baseGeometry, 0, perimeterHeight, envelopeColor, zoneCode, controls, "perimeter"),
    makeEnvelopeFeature(roofGeometry, perimeterHeight, ridgeHeight, envelopeColor, zoneCode, controls, "ridge"),
  ];
}

function generateFlatEnvelope(baseGeometry, controls, envelopeColor, zoneCode, warnings) {
  const maxHeight = resolveHeightValueFt("maximum building height", controls.maxBuildingHeight, warnings)
    ?? resolveHeightValueFt("maximum front wall height", controls.frontWallHeight, warnings);
  if (maxHeight == null) return [];
  return [makeEnvelopeFeature(baseGeometry, 0, maxHeight, envelopeColor, zoneCode, controls, "flat")];
}

function generateBaseAndSetbackEnvelope(baseGeometry, controls, envelopeColor, zoneCode, warnings) {
  const maxHeight = resolveHeightValueFt("maximum building height", controls.maxBuildingHeight, warnings)
    ?? resolveHeightValueFt("maximum front wall height", controls.frontWallHeight, warnings);
  if (maxHeight == null) return [];
  const baseHeight = resolveHeightValueFt("maximum base height", controls.maxBaseHeight, warnings)
    ?? resolveHeightValueFt("maximum front wall height", controls.frontWallHeight, warnings)
    ?? Math.max(35, maxHeight - 20);

  const upperGeometry = uniformInsetGeometry(baseGeometry, controls.streetSetback || 0);

  return [
    makeEnvelopeFeature(baseGeometry, 0, baseHeight, envelopeColor, zoneCode, controls, "base"),
    makeEnvelopeFeature(upperGeometry, baseHeight, maxHeight, envelopeColor, zoneCode, controls, "upper"),
  ];
}

function generateSkyExposureEnvelope(baseGeometry, controls, envelopeColor, zoneCode, warnings) {
  const frontWall = resolveHeightValueFt("maximum front wall height", controls.frontWallHeight, warnings)
    ?? resolveHeightValueFt("maximum base height", controls.maxBaseHeight, warnings)
    ?? 60;
  const maxHeight = resolveHeightValueFt("maximum building height", controls.maxBuildingHeight, warnings)
    ?? resolveHeightValueFt("ridge height", controls.ridgeHeight, warnings);
  if (maxHeight == null) {
    warnings.push("Missing maximum building height; drawing front-wall/base envelope only.");
    return {
      features: [
        makeEnvelopeFeature(baseGeometry, 0, frontWall, envelopeColor, zoneCode, controls, "front-wall-only"),
      ],
    };
  }

  // Simplified sky exposure plane proxy: additional inset for upper segment.
  const skyPlaneInset = Math.max(controls.streetSetback || 0, 8);
  const upperGeometry = uniformInsetGeometry(baseGeometry, skyPlaneInset);
  warnings.push("Envelope simplified: sky exposure plane rendered as stepped setback proxy.");

  return {
    features: [
      makeEnvelopeFeature(baseGeometry, 0, frontWall, envelopeColor, zoneCode, controls, "front-wall"),
      makeEnvelopeFeature(upperGeometry, frontWall, maxHeight, envelopeColor, zoneCode, controls, "sky-plane"),
    ],
  };
}

export function generateEnvelopeFromControls({ lotGeometry, controls, envelopeColor = "#7DB7FF", zoneCode = "", lotAnalysis = null }) {
  const regime = String(controls?.bulkRegime || "flat-roof").toLowerCase();
  const warnings = [];

  const directional = generateSetbackBuildableArea(lotGeometry, controls || {}, lotAnalysis, warnings);
  const baseGeometry = directional.geometry || lotGeometry;

  const maxBuildingHeight = resolveHeightValueFt("maximum building height", controls?.maxBuildingHeight, warnings);
  const frontWallHeight = resolveHeightValueFt("maximum front wall height", controls?.frontWallHeight, warnings);
  const maxBaseHeight = resolveHeightValueFt("maximum base height", controls?.maxBaseHeight, warnings);

  let features = [];

  if (regime === "pitched-envelope") {
    features = generatePitchedEnvelope(baseGeometry, controls, envelopeColor, zoneCode, warnings);
  } else if (regime === "flat-roof") {
    features = generateFlatEnvelope(baseGeometry, controls, envelopeColor, zoneCode, warnings);
  } else if (["base-and-setback", "contextual", "contextual-variant"].includes(regime)) {
    features = generateBaseAndSetbackEnvelope(baseGeometry, controls, envelopeColor, zoneCode, warnings);
  } else if (["sky-exposure-plane", "sky-exposure-plane-or-tower", "manufacturing-sky-exposure"].includes(regime)) {
    const generated = generateSkyExposureEnvelope(baseGeometry, controls, envelopeColor, zoneCode, warnings);
    features = generated.features;
  } else {
    features = generateFlatEnvelope(baseGeometry, controls, envelopeColor, zoneCode, warnings);
    warnings.push(`Envelope simplified: unknown bulk regime '${regime}', defaulting to flat extrusion.`);
  }

  if (!features.length) {
    if (maxBuildingHeight == null && frontWallHeight != null) {
      warnings.push("Missing maximum building height; using front-wall-only envelope.");
      features = [makeEnvelopeFeature(baseGeometry, 0, frontWallHeight, envelopeColor, zoneCode, controls, "front-wall-only")];
    } else if (maxBuildingHeight == null && frontWallHeight == null && maxBaseHeight != null) {
      warnings.push("Missing upper height; using base-only envelope.");
      features = [makeEnvelopeFeature(baseGeometry, 0, maxBaseHeight, envelopeColor, zoneCode, controls, "base-only")];
    }
  }

  if (!features.length) {
    warnings.push("Envelope could not be generated: no usable height controls resolved from zoning rules.");
  }

  // Compute buildable footprint area for open space ratio compliance check
  let buildableFootprintFt2 = null;
  try {
    buildableFootprintFt2 = turf.area({ type: "Feature", geometry: baseGeometry, properties: {} }) * 10.7639;
  } catch (_err) { /* ignore */ }

  const openSpaceCheck = computeOpenSpaceCheck(lotAnalysis?.lotAreaFt2, controls, buildableFootprintFt2);
  if (openSpaceCheck.applicable && !openSpaceCheck.pass) {
    warnings.push(
      `Open space ratio violation: required ${openSpaceCheck.requiredOpenSpaceFt2} sf open space, ` +
      `provided ${openSpaceCheck.providedOpenSpaceFt2} sf. ` +
      `Reduce buildable footprint to ≤ ${openSpaceCheck.maxCoverageFt2} sf.`
    );
  }

  return {
    envelopeFeatures: features,
    buildableFootprintFeature: {
      type: "Feature",
      geometry: baseGeometry,
      properties: {
        kind: "buildable_footprint_engine",
        zoneCode,
      },
    },
    warnings,
    openSpaceCheck,
    debug: {
      zoneCode,
      bulkRegime: regime,
      lotType: lotAnalysis?.lotType || controls?.lotType || null,
      isIslandLot: lotAnalysis?.isIslandLot || false,
      streetEdgesCount: lotAnalysis?.frontEdgeIndices?.length ?? 0,
      frontEdgeIndices: Array.isArray(lotAnalysis?.frontEdgeIndices) ? lotAnalysis.frontEdgeIndices : [],
      sideEdgeIndices: Array.isArray(lotAnalysis?.sideEdgeIndices) ? lotAnalysis.sideEdgeIndices : [],
      rearEdgeIndex: lotAnalysis?.rearEdgeIndex ?? null,
      frontYardFt: directional.yards.frontYardFt,
      frontYardMissing: directional.yards.frontYardMissing || false,
      sideYardEachFt: directional.yards.sideYardEachFt,
      rearYardFt: directional.yards.rearYardFt,
      rearYardMissing: directional.yards.rearYardMissing || false,
      openSpaceRatio: controls?.openSpaceRatio ?? null,
      openSpaceCheck,
      maximumBuildingHeightFt: maxBuildingHeight,
      maximumFrontWallHeightFt: frontWallHeight,
      maximumBaseHeightFt: maxBaseHeight,
      edgeRoles: directional.edgeRoles,
      generatedEnvelope: features.length > 0,
      warnings,
    },
  };
}
