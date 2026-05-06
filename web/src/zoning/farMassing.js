/**
 * farMassing.js
 * FAR morphology engine that creates compact architectural floorplates from target floor area,
 * instead of a single uniform inward offset.
 */

const FT_TO_M = 0.3048;
const M2_TO_FT2 = 10.7639104167;

function _asFeature(geometry) {
  return { type: "Feature", geometry, properties: {} };
}

function _areaFt2(geometry) {
  try {
    return turf.area(_asFeature(geometry)) * M2_TO_FT2;
  } catch (_err) {
    return 0;
  }
}

function _simplifyGeometry(geometry) {
  if (!geometry) return null;
  try {
    const simplified = turf.simplify(_asFeature(geometry), {
      tolerance: 0.5 * FT_TO_M,
      highQuality: true,
      mutate: false,
    });
    if (simplified?.geometry?.coordinates?.length) return simplified.geometry;
  } catch (_err) {
    // keep original
  }
  return geometry;
}

function _safeBufferInward(geometry, insetFt) {
  if (!geometry || !Number.isFinite(insetFt) || insetFt <= 0) return geometry;
  try {
    const buffered = turf.buffer(_asFeature(geometry), -(insetFt * FT_TO_M), { units: "meters" });
    if (buffered?.geometry?.coordinates?.length) return buffered.geometry;
  } catch (_err) {
    // ignore
  }
  return geometry;
}

function _bboxMetrics(geometry) {
  try {
    const [minX, minY, maxX, maxY] = turf.bbox(_asFeature(geometry));
    const widthFt = Math.max(1, (maxX - minX) / FT_TO_M);
    const depthFt = Math.max(1, (maxY - minY) / FT_TO_M);
    const frontageFt = Math.max(widthFt, depthFt);
    const lotDepthFt = Math.min(widthFt, depthFt);
    const aspect = frontageFt / Math.max(1, lotDepthFt);
    return {
      minX,
      minY,
      maxX,
      maxY,
      widthFt,
      depthFt,
      frontageFt,
      lotDepthFt,
      aspect,
    };
  } catch (_err) {
    return {
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0,
      widthFt: 1,
      depthFt: 1,
      frontageFt: 1,
      lotDepthFt: 1,
      aspect: 1,
    };
  }
}

function _rectGeometry(minX, minY, maxX, maxY) {
  if (!(maxX > minX) || !(maxY > minY)) return null;
  return {
    type: "Polygon",
    coordinates: [[
      [minX, minY],
      [maxX, minY],
      [maxX, maxY],
      [minX, maxY],
      [minX, minY],
    ]],
  };
}

function _centroidCoord(geometry) {
  try {
    return turf.centroid(_asFeature(geometry))?.geometry?.coordinates || null;
  } catch (_err) {
    return null;
  }
}

function _rotateGeometry(geometry, angleDeg, pivot) {
  if (!geometry || !Number.isFinite(angleDeg) || Math.abs(angleDeg) < 1e-6) return geometry;
  try {
    const rotated = turf.transformRotate(_asFeature(geometry), angleDeg, {
      pivot,
      mutate: false,
    });
    if (rotated?.geometry?.coordinates?.length) return rotated.geometry;
  } catch (_err) {
    // keep original
  }
  return geometry;
}

function _isPointInside(pointCoord, geometry) {
  if (!Array.isArray(pointCoord) || !geometry) return false;
  try {
    return turf.booleanPointInPolygon(turf.point(pointCoord), _asFeature(geometry));
  } catch (_err) {
    return false;
  }
}

function _isWithin(innerGeom, outerGeom) {
  if (!innerGeom || !outerGeom) return false;
  try {
    return turf.booleanWithin(_asFeature(innerGeom), _asFeature(outerGeom));
  } catch (_err) {
    return false;
  }
}

function _scaleFromCentroid(geometry, factor) {
  if (!geometry || !(factor > 0)) return geometry;
  try {
    const scaled = turf.transformScale(_asFeature(geometry), factor, {
      origin: "centroid",
      mutate: false,
    });
    if (scaled?.geometry?.coordinates?.length) return scaled.geometry;
  } catch (_err) {
    // keep original
  }
  return geometry;
}

function _fitRectInsideBuildable(rectGeom, buildableGeom) {
  if (!rectGeom || !buildableGeom) return null;
  let candidate = rectGeom;
  for (let i = 0; i < 16; i += 1) {
    if (_isWithin(candidate, buildableGeom)) return candidate;
    candidate = _scaleFromCentroid(candidate, 0.9);
  }
  return _isWithin(candidate, buildableGeom) ? candidate : null;
}

function _fallbackRectInsideBuildable(buildableGeom, orientationDeg = null) {
  const candidates = [
    [0.88, 0.52],
    [0.78, 0.48],
    [0.68, 0.42],
    [0.58, 0.36],
    [0.46, 0.32],
  ];
  for (const [w, d] of candidates) {
    const rect = _rectInsideBuildable(buildableGeom, w, d, "center", orientationDeg);
    if (rect && _areaFt2(rect) > 40) return rect;
  }
  return null;
}

function _intersection(aGeom, bGeom) {
  if (!aGeom || !bGeom) return null;
  try {
    const out = turf.intersect(_asFeature(aGeom), _asFeature(bGeom));
    if (out?.geometry?.coordinates?.length) return out.geometry;
  } catch (_err) {
    // ignore
  }
  return null;
}

function _difference(aGeom, bGeom) {
  if (!aGeom || !bGeom) return null;
  try {
    const out = turf.difference(_asFeature(aGeom), _asFeature(bGeom));
    if (out?.geometry?.coordinates?.length) return out.geometry;
  } catch (_err) {
    // ignore
  }
  return null;
}

function _union(geoms) {
  const valid = (geoms || []).filter((g) => g && _areaFt2(g) > 1);
  if (!valid.length) return null;
  let acc = valid[0];
  for (let i = 1; i < valid.length; i += 1) {
    try {
      const merged = turf.union(_asFeature(acc), _asFeature(valid[i]));
      if (merged?.geometry) {
        acc = merged.geometry;
      }
    } catch (_err) {
      // ignore individual union failures
    }
  }
  return acc;
}

function _rectInsideBuildableAxis(buildableGeom, widthFrac, depthFrac, anchor = "center") {
  const box = _bboxMetrics(buildableGeom);
  const boxWidth = Math.max(2 * FT_TO_M, (box.maxX - box.minX));
  const boxDepth = Math.max(2 * FT_TO_M, (box.maxY - box.minY));
  const w = boxWidth * Math.max(0.15, Math.min(0.98, widthFrac));
  const d = boxDepth * Math.max(0.15, Math.min(0.98, depthFrac));

  let cx = (box.minX + box.maxX) / 2;
  let cy = (box.minY + box.maxY) / 2;
  if (anchor === "north") cy = box.maxY - (d / 2);
  if (anchor === "south") cy = box.minY + (d / 2);
  if (anchor === "east") cx = box.maxX - (w / 2);
  if (anchor === "west") cx = box.minX + (w / 2);

  if (!_isPointInside([cx, cy], buildableGeom)) {
    const centroid = _centroidCoord(buildableGeom);
    if (centroid) {
      cx = centroid[0];
      cy = centroid[1];
    }
  }

  const rect = _rectGeometry(cx - (w / 2), cy - (d / 2), cx + (w / 2), cy + (d / 2));
  return _fitRectInsideBuildable(rect, buildableGeom);
}

function _rectInsideBuildable(buildableGeom, widthFrac, depthFrac, anchor = "center", orientationDeg = null) {
  if (!Number.isFinite(orientationDeg)) {
    return _rectInsideBuildableAxis(buildableGeom, widthFrac, depthFrac, anchor);
  }

  const pivot = _centroidCoord(buildableGeom);
  if (!pivot) {
    return _rectInsideBuildableAxis(buildableGeom, widthFrac, depthFrac, anchor);
  }

  const localGeom = _rotateGeometry(buildableGeom, -orientationDeg, pivot);
  const localRect = _rectInsideBuildableAxis(localGeom, widthFrac, depthFrac, anchor);
  if (!localRect) return null;
  const worldRect = _rotateGeometry(localRect, orientationDeg, pivot);
  return _fitRectInsideBuildable(worldRect, buildableGeom);
}

function _clipToBuildable(feature, buildableGeom) {
  if (!feature?.geometry || !buildableGeom) return null;
  const clipped = _intersection(buildableGeom, feature.geometry);
  if (!clipped || _areaFt2(clipped) <= 1) return null;
  return {
    ...feature,
    geometry: clipped,
  };
}

function _scorePlan({
  buildingGeom,
  buildableGeom,
  targetOpenSpaceFt2,
  frontageFt,
  lotDepthFt,
  warnings,
}) {
  const bArea = _areaFt2(buildingGeom);
  const totalArea = Math.max(1, _areaFt2(buildableGeom));
  if (bArea <= 0) {
    return {
      total: -1e9,
      compactness: 0,
      frontageBonus: 0,
      openPenalty: 1,
      depthPenalty: 1,
      awkwardnessPenalty: 1,
      lotDepthPenalty: 1,
      warnPenalty: 0,
      openAreaFt2: 0,
      coverage: 0,
    };
  }

  const coverage = bArea / totalArea;
  const compactness = Math.min(1, Math.max(0, coverage));

  const openGeom = _difference(buildableGeom, buildingGeom);
  const openArea = _areaFt2(openGeom);
  const openPenalty = targetOpenSpaceFt2 > 0
    ? Math.abs(openArea - targetOpenSpaceFt2) / Math.max(1, targetOpenSpaceFt2)
    : 0;

  const shape = _bboxMetrics(buildingGeom);
  const plateDepth = Math.min(shape.widthFt, shape.depthFt);
  const plateFrontage = Math.max(shape.widthFt, shape.depthFt);
  const depthPenalty = plateDepth < 26 ? (26 - plateDepth) / 26 : 0;
  const frontageBonus = Math.min(1, plateFrontage / Math.max(60, frontageFt * 0.7));

  const awkwardnessPenalty = (shape.aspect > 6 ? (shape.aspect - 6) / 6 : 0);
  const lotDepthPenalty = (lotDepthFt < 55 && plateDepth > lotDepthFt * 0.95) ? 0.3 : 0;

  const warnPenalty = Math.min(0.4, (warnings?.length || 0) * 0.05);
  const total = (
    (compactness * 1.0)
    + (frontageBonus * 0.55)
    - (openPenalty * 0.8)
    - (depthPenalty * 0.9)
    - (awkwardnessPenalty * 0.5)
    - lotDepthPenalty
    - warnPenalty
  );

  return {
    total,
    compactness,
    frontageBonus,
    openPenalty,
    depthPenalty,
    awkwardnessPenalty,
    lotDepthPenalty,
    warnPenalty,
    openAreaFt2: openArea,
    coverage,
  };
}

function _floorplateFromTypology(buildableGeom, typology, coverageTarget, orientationDeg = null) {
  const shape = _bboxMetrics(buildableGeom);
  const widthMajor = Math.max(shape.widthFt, shape.depthFt);
  const depthMinor = Math.min(shape.widthFt, shape.depthFt);
  const coverage = Math.max(0.22, Math.min(0.97, coverageTarget));

  if (typology === "box") {
    const frac = Math.max(0.28, Math.min(0.92, Math.sqrt(coverage) * 0.98));
    return _rectInsideBuildable(buildableGeom, frac, frac, "center", orientationDeg)
      || _fallbackRectInsideBuildable(buildableGeom, orientationDeg);
  }

  if (typology === "bar") {
    const depthFrac = Math.max(0.28, Math.min(0.55, (coverage * 0.9)));
    return _rectInsideBuildable(buildableGeom, 0.94, depthFrac, "center", orientationDeg);
  }

  if (typology === "slab") {
    const depthFrac = Math.max(0.22, Math.min(0.42, coverage * 0.72));
    return _rectInsideBuildable(
      buildableGeom,
      0.98,
      depthFrac,
      depthMinor > widthMajor ? "north" : "east",
      orientationDeg
    );
  }

  if (typology === "tower") {
    const towerCov = Math.max(0.14, Math.min(0.34, coverage * 0.55));
    const podiumCov = Math.max(towerCov + 0.18, Math.min(0.8, coverage * 1.25));
    const podium = _rectInsideBuildable(buildableGeom, 0.96, Math.min(0.95, podiumCov / 0.96), "center", orientationDeg)
      || _fallbackRectInsideBuildable(buildableGeom, orientationDeg);
    if (!podium) return null;
    const tower = _rectInsideBuildable(podium, 0.55, 0.55, "center", orientationDeg)
      || _fallbackRectInsideBuildable(podium, orientationDeg);
    if (!tower) return podium;
    return { podium, tower };
  }

  if (typology === "courtyard" || typology === "perimeter") {
    const depthFrac = Math.max(0.3, Math.min(0.56, coverage * 0.78));
    return _rectInsideBuildable(buildableGeom, 0.96, depthFrac, "center", orientationDeg);
  }

  if (typology === "tower-podium") {
    const podium = _rectInsideBuildable(buildableGeom, 0.96, 0.86, "center", orientationDeg)
      || _fallbackRectInsideBuildable(buildableGeom, orientationDeg);
    if (!podium) return null;
    const tower = _rectInsideBuildable(podium, 0.52, 0.52, "center", orientationDeg)
      || _fallbackRectInsideBuildable(podium, orientationDeg);
    if (!tower) return podium;
    return { podium, tower };
  }

  return _rectInsideBuildable(buildableGeom, 0.96, Math.max(0.35, coverage * 0.75), "center", orientationDeg)
    || _fallbackRectInsideBuildable(buildableGeom, orientationDeg);
}

function _autoTypology({ requested, shape, farIntensity, coverageTarget, districtType }) {
  if (requested && requested !== "full-block" && requested !== "fullBlock") return requested;

  const narrow = shape.aspect >= 2.35 || shape.lotDepthFt < 70;
  const deep = shape.lotDepthFt >= 120 && shape.frontageFt >= 90;
  const highFar = farIntensity >= 6.5;
  const medFar = farIntensity >= 3.6;
  const lowCoverage = coverageTarget <= 0.45;
  const nonRes = /commercial|industrial|manufacturing|nonresidential/i.test(String(districtType || ""));

  if (highFar && lowCoverage) return "tower-podium";
  if (highFar && deep) return "tower-podium";
  if (narrow) return "bar";
  if (medFar && deep) return "slab";
  if (nonRes) return "slab";
  if (medFar) return "slab";
  return "bar";
}

function _makeMassFeature(geometry, baseFt, topFt, color, typology, floors, label) {
  if (!geometry || topFt <= baseFt) return null;
  return {
    type: "Feature",
    geometry,
    properties: {
      kind: "far_volume",
      envelopeBase: baseFt,
      envelopeHeight: topFt,
      base_ft: baseFt,
      height_ft: topFt,
      render_height: topFt,
      envelopeColor: color,
      massingOption: typology,
      numFloors: floors,
      label,
    },
  };
}

function _makePlanFeature(geometry, kind, color, typology, label, areaFt2 = null) {
  if (!geometry) return null;
  return {
    type: "Feature",
    geometry,
    properties: {
      kind,
      envelopeColor: color,
      massingOption: typology,
      label,
      area_ft2: areaFt2 == null ? null : Math.round(areaFt2),
    },
  };
}

/**
 * Build FAR massing GeoJSON features from buildable footprint and zoning controls.
 *
 * @param {object} params
 * @param {object} params.buildableFootprintGeometry - GeoJSON Polygon/MultiPolygon (yards already removed)
 * @param {number} params.allowedFarFloorArea       - lot area × FAR (sq ft)
 * @param {number} params.floorHeightFt             - floor height in feet (default 10)
 * @param {number} params.coveragePct               - buildable footprint coverage 0–100
 * @param {number} params.maxHeightFt               - hard ceiling from zoning (optional)
 * @param {boolean} params.enforceMaxHeight         - when true, clamp FAR massing to maxHeightFt
 * @param {string} params.massingOption             - "auto"|"bar"|"courtyard"|"tower"|"slab"|"perimeter"|"tower-podium"
 * @param {string} params.color                     - fill-extrusion color
 * @param {number} params.openSpaceTargetFt2        - required usable open space target (sq ft)
 * @param {string} params.districtType              - zoning district type hint
 * @param {number} params.frontageOrientationDeg     - detected front street edge direction in degrees
 * @returns {{ features: GeoJSON.Feature[], warnings: string[], numFloors: number, buildingHeightFt: number, footprintAreaFt2: number, selectedTypology: string, scoreBreakdown: object }}
 */
export function buildFarMassing({
  buildableFootprintGeometry,
  allowedFarFloorArea,
  floorHeightFt = 10,
  coveragePct = 80,
  maxHeightFt = null,
  enforceMaxHeight = false,
  massingOption = "auto",
  color = "#22c55e",
  openSpaceTargetFt2 = 0,
  districtType = "",
  frontageOrientationDeg = null,
}) {
  const features = [];
  const warnings = [];

  if (!buildableFootprintGeometry || !(allowedFarFloorArea > 0)) {
    return {
      features,
      warnings: ["No buildable footprint or FAR floor area available."],
      numFloors: 0,
      buildingHeightFt: 0,
      footprintAreaFt2: 0,
      selectedTypology: "none",
      scoreBreakdown: null,
    };
  }

  const simplifiedBuildable = _simplifyGeometry(buildableFootprintGeometry);
  const buildableAreaFt2 = _areaFt2(simplifiedBuildable);
  if (buildableAreaFt2 <= 0) {
    return {
      features,
      warnings: ["Buildable footprint area is zero."],
      numFloors: 0,
      buildingHeightFt: 0,
      footprintAreaFt2: 0,
      selectedTypology: "none",
      scoreBreakdown: null,
    };
  }

  const safeFloorHeight = Math.max(8, Number(floorHeightFt) || 10);
  const safeCoverage = Math.max(0.18, Math.min(0.98, (Number(coveragePct) || 80) / 100));
  const targetCoverageArea = buildableAreaFt2 * safeCoverage;

  const shape = _bboxMetrics(simplifiedBuildable);
  const farIntensity = allowedFarFloorArea / Math.max(1, buildableAreaFt2);
  const typology = "box";

  let primaryFootprint = null;
  let podiumGeom = null;
  let towerGeom = null;
  let courtyardGeom = null;

  const scheme = _floorplateFromTypology(
    simplifiedBuildable,
    typology,
    safeCoverage,
    Number.isFinite(frontageOrientationDeg) ? frontageOrientationDeg : null
  );
  if (scheme?.type) {
    primaryFootprint = scheme;
  } else if (scheme?.podium || scheme?.tower) {
    podiumGeom = scheme.podium || null;
    towerGeom = scheme.tower || null;
    primaryFootprint = _union([podiumGeom, towerGeom]);
  } else if (scheme?.ring || scheme?.courtyard) {
    primaryFootprint = scheme.ring || null;
    courtyardGeom = scheme.courtyard || null;
  }

  if (!primaryFootprint || _areaFt2(primaryFootprint) < 80) {
    warnings.push("FAR morphology fallback used due to constrained lot geometry.");
    primaryFootprint = _rectInsideBuildable(
      simplifiedBuildable,
      0.7,
      0.7,
      "center",
      Number.isFinite(frontageOrientationDeg) ? frontageOrientationDeg : null
    ) || _fallbackRectInsideBuildable(
      simplifiedBuildable,
      Number.isFinite(frontageOrientationDeg) ? frontageOrientationDeg : null
    );
    podiumGeom = null;
    towerGeom = null;
    courtyardGeom = null;
  }

  let primaryAreaFt2 = _areaFt2(primaryFootprint);
  if (primaryAreaFt2 <= 0) {
    warnings.push("No valid FAR footprint could be generated from typology; using compact box fallback footprint.");
    primaryFootprint = _rectInsideBuildable(
      simplifiedBuildable,
      0.58,
      0.58,
      "center",
      Number.isFinite(frontageOrientationDeg) ? frontageOrientationDeg : null
    ) || _fallbackRectInsideBuildable(
      simplifiedBuildable,
      Number.isFinite(frontageOrientationDeg) ? frontageOrientationDeg : null
    );
    primaryAreaFt2 = _areaFt2(primaryFootprint);
    podiumGeom = null;
    towerGeom = null;
    courtyardGeom = null;
  }

  if (primaryAreaFt2 <= 0) {
    return {
      features,
      warnings: [...warnings, "No valid FAR footprint could be generated."],
      numFloors: 0,
      buildingHeightFt: 0,
      footprintAreaFt2: 0,
      selectedTypology: typology,
      scoreBreakdown: null,
    };
  }

  // Score and optional adjustment toward compact, usable floorplates.
  const score = _scorePlan({
    buildingGeom: primaryFootprint,
    buildableGeom: simplifiedBuildable,
    targetOpenSpaceFt2: Math.max(0, Number(openSpaceTargetFt2) || 0),
    frontageFt: shape.frontageFt,
    lotDepthFt: shape.lotDepthFt,
    warnings,
  });
  if (score.total < -0.1) {
    const tightened = _safeBufferInward(primaryFootprint, 4);
    if (_areaFt2(tightened) > 120) {
      primaryFootprint = tightened;
      warnings.push("Footprint tightened to remove awkward perimeter slivers.");
    }
  }

  let footprintAreaFt2 = Math.min(_areaFt2(primaryFootprint), targetCoverageArea > 0 ? targetCoverageArea : _areaFt2(primaryFootprint));
  if (footprintAreaFt2 < 120) {
    footprintAreaFt2 = Math.max(120, _areaFt2(primaryFootprint));
  }

  let numFloors = Math.max(1, Math.ceil(allowedFarFloorArea / Math.max(1, footprintAreaFt2)));
  let buildingHeightFt = numFloors * safeFloorHeight;

  const safeMaxHeight = Number.isFinite(maxHeightFt) && maxHeightFt > 0
    ? Math.max(safeFloorHeight, maxHeightFt)
    : null;
  if (safeMaxHeight != null && buildingHeightFt > safeMaxHeight) {
    warnings.push(`FAR massing exceeds max-height control (${safeMaxHeight} ft): computed ${buildingHeightFt.toFixed(2)} ft from FAR and floorplate.`);
    if (enforceMaxHeight) {
      buildingHeightFt = safeMaxHeight;
      numFloors = Math.max(1, Math.floor(buildingHeightFt / safeFloorHeight));
      warnings.push(`FAR massing height clamped to max allowed ${safeMaxHeight} ft.`);
    }
  }

  // Generate volume pieces by morphology strategy.
  if ((typology === "tower" || typology === "tower-podium") && towerGeom && _areaFt2(towerGeom) > 60) {
    const podium = podiumGeom || primaryFootprint;
    const podiumArea = Math.max(1, _areaFt2(podium));
    const towerArea = Math.max(1, _areaFt2(towerGeom));
    const podiumFloors = Math.max(2, Math.min(6, Math.round(numFloors * 0.28)));
    const podiumAreaServed = podiumArea * podiumFloors;
    const remainingArea = Math.max(0, allowedFarFloorArea - podiumAreaServed);
    const towerFloors = Math.max(1, Math.ceil(remainingArea / towerArea));
    const podiumTop = Math.min(buildingHeightFt, podiumFloors * safeFloorHeight);
    const towerTop = Math.min(
      buildingHeightFt,
      podiumTop + (towerFloors * safeFloorHeight)
    );

    const podiumMass = _makeMassFeature(podium, 0, podiumTop, color, typology, podiumFloors, "podium");
    const towerMass = _makeMassFeature(towerGeom, podiumTop, Math.max(podiumTop + safeFloorHeight, towerTop), color, typology, towerFloors, "tower");
    if (podiumMass) features.push(podiumMass);
    if (towerMass) features.push(towerMass);

    features.push(_makePlanFeature(podium, "far_footprint", "#1a7f54", typology, "footprint", _areaFt2(podium)));
  } else {
    features.push(_makeMassFeature(primaryFootprint, 0, buildingHeightFt, color, typology, numFloors, typology));
    features.push(_makePlanFeature(primaryFootprint, "far_footprint", "#1a7f54", typology, "footprint", _areaFt2(primaryFootprint)));
  }

  if (courtyardGeom && _areaFt2(courtyardGeom) > 40) {
    features.push(_makePlanFeature(courtyardGeom, "far_open_space", "#98d8bb", typology, "courtyard", _areaFt2(courtyardGeom)));
  }

  const computedOpenSpace = _difference(simplifiedBuildable, primaryFootprint);
  const computedOpenAreaFt2 = _areaFt2(computedOpenSpace);
  if (computedOpenSpace && computedOpenAreaFt2 > 60) {
    features.push(_makePlanFeature(computedOpenSpace, "far_open_space", "#98d8bb", typology, "open-space", computedOpenAreaFt2));
  }

  if ((Number(openSpaceTargetFt2) || 0) > 0 && computedOpenAreaFt2 < Number(openSpaceTargetFt2)) {
    warnings.push(`Open space shortfall: ${Math.round(Number(openSpaceTargetFt2) - computedOpenAreaFt2)} sf below target.`);
  }

  let rawFeatures = features.filter(Boolean);

  // Last-resort guard: never return zero FAR features when buildable geometry exists.
  if (!rawFeatures.length && _areaFt2(simplifiedBuildable) > 1) {
    const strictFallbackFootprint = _rectInsideBuildable(
      simplifiedBuildable,
      0.5,
      0.5,
      "center",
      Number.isFinite(frontageOrientationDeg) ? frontageOrientationDeg : null
    ) || _fallbackRectInsideBuildable(
      simplifiedBuildable,
      Number.isFinite(frontageOrientationDeg) ? frontageOrientationDeg : null
    );
    const strictFallbackHeightFt = Math.max(safeFloorHeight, Number(buildingHeightFt) || safeFloorHeight);
    const fallbackMass = _makeMassFeature(strictFallbackFootprint, 0, strictFallbackHeightFt, color, typology || "fallback", Math.max(1, numFloors || 1), "fallback");
    const fallbackFootprint = _makePlanFeature(strictFallbackFootprint, "far_footprint", "#1a7f54", typology || "fallback", "fallback-footprint", _areaFt2(strictFallbackFootprint));
    rawFeatures = [fallbackMass, fallbackFootprint].filter(Boolean);
    warnings.push("FAR last-resort fallback applied: generated compact box volume/footprint.");
  }

  const clippedFeatures = rawFeatures
    .filter(Boolean)
    .map((feature) => _clipToBuildable(feature, simplifiedBuildable))
    .filter(Boolean);

  // Keep output strictly in-bounds. If clipping fails, synthesize a compact in-bounds box.
  let finalFeatures = clippedFeatures;
  if (!finalFeatures.length && _areaFt2(simplifiedBuildable) > 1) {
    const inBoundsFootprint = _rectInsideBuildable(
      simplifiedBuildable,
      0.45,
      0.45,
      "center",
      Number.isFinite(frontageOrientationDeg) ? frontageOrientationDeg : null
    ) || _fallbackRectInsideBuildable(
      simplifiedBuildable,
      Number.isFinite(frontageOrientationDeg) ? frontageOrientationDeg : null
    );
    const inBoundsHeightFt = Math.max(safeFloorHeight, Number(buildingHeightFt) || safeFloorHeight);
    finalFeatures = [
      _makeMassFeature(inBoundsFootprint, 0, inBoundsHeightFt, color, typology || "fallback", Math.max(1, numFloors || 1), "in-bounds-fallback"),
      _makePlanFeature(inBoundsFootprint, "far_footprint", "#1a7f54", typology || "fallback", "in-bounds-fallback-footprint", _areaFt2(inBoundsFootprint)),
    ].filter(Boolean);
    warnings.push("FAR clipping fallback applied: synthesized compact in-bounds box massing.");
  }

  return {
    features: finalFeatures,
    warnings,
    numFloors,
    buildingHeightFt,
    footprintAreaFt2: _areaFt2(primaryFootprint),
    selectedTypology: typology,
    scoreBreakdown: {
      ...score,
      targetOpenSpaceFt2: Math.max(0, Number(openSpaceTargetFt2) || 0),
      requestedMassingOption: massingOption,
      farIntensity,
      buildableAreaFt2,
      targetCoverage: safeCoverage,
      frontageOrientationDeg: Number.isFinite(frontageOrientationDeg) ? frontageOrientationDeg : null,
    },
  };
}
