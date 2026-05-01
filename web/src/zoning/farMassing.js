/**
 * farMassing.js
 * Converts FAR and lot controls into 3D massing geometry options.
 * Keeps FAR massing constrained inside the max zoning envelope height.
 */

const FT_TO_M = 0.3048;

function _area(geometry) {
  try {
    return turf.area({ type: "Feature", geometry, properties: {} }) / (FT_TO_M * FT_TO_M);
  } catch (_err) {
    return 0;
  }
}

function _bufferInward(geometry, insetFt) {
  if (!geometry || !Number.isFinite(insetFt) || insetFt <= 0) return geometry;
  try {
    const buffered = turf.buffer(
      { type: "Feature", geometry, properties: {} },
      -(insetFt * FT_TO_M),
      { units: "meters" }
    );
    if (buffered?.geometry?.coordinates?.length) return buffered.geometry;
  } catch (_err) {
    // ignore
  }
  return geometry;
}

function _makeFeature(geometry, base, height, color, massingOption, numFloors, label) {
  if (!geometry) return null;
  return {
    type: "Feature",
    geometry,
    properties: {
      envelopeBase: base,
      envelopeHeight: height,
      envelopeColor: color,
      massingOption,
      numFloors,
      label: label || massingOption,
      kind: "far_envelope",
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
 * @param {number} params.coveragePct               - buildable footprint coverage 20–100 (default 80)
 * @param {number} params.maxHeightFt               - hard ceiling from zoning (default 120)
 * @param {string} params.massingOption             - "full-block"|"courtyard"|"tower"|"slab"|"stepped"
 * @param {string} params.color                     - fill-extrusion color (default green)
 * @returns {{ features: GeoJSON.Feature[], warnings: string[], numFloors: number, buildingHeightFt: number }}
 */
export function buildFarMassing({
  buildableFootprintGeometry,
  allowedFarFloorArea,
  floorHeightFt = 10,
  coveragePct = 80,
  maxHeightFt = 120,
  massingOption = "full-block",
  color = "#22c55e",
}) {
  const features = [];
  const warnings = [];

  if (!buildableFootprintGeometry || !(allowedFarFloorArea > 0)) {
    return { features, warnings: ["No buildable footprint or FAR floor area available."], numFloors: 0, buildingHeightFt: 0 };
  }

  const footprintAreaFt2 = _area(buildableFootprintGeometry);
  if (footprintAreaFt2 <= 0) {
    return { features, warnings: ["Buildable footprint area is zero."], numFloors: 0, buildingHeightFt: 0 };
  }

  const safeCoverage = Math.max(0.2, Math.min(1.0, (coveragePct || 80) / 100));
  const usableFootprintFt2 = footprintAreaFt2 * safeCoverage;
  const safeFloorHeight = Math.max(8, floorHeightFt || 10);

  let numFloors = Math.max(1, Math.ceil(allowedFarFloorArea / usableFootprintFt2));
  let buildingHeightFt = numFloors * safeFloorHeight;

  // Clamp to max height from zoning
  const safeMaxHeight = Math.max(safeFloorHeight, maxHeightFt || 120);
  if (buildingHeightFt > safeMaxHeight) {
    buildingHeightFt = safeMaxHeight;
    numFloors = Math.max(1, Math.floor(buildingHeightFt / safeFloorHeight));
    warnings.push(`FAR massing height clamped to max allowed ${safeMaxHeight} ft.`);
  }

  const footprintGeom = buildableFootprintGeometry;

  switch (massingOption) {
    case "courtyard": {
      // Hollow courtyard: outer ring uses less height; inner courtyard is open air
      const courtyardInsetFt = Math.max(15, Math.sqrt(footprintAreaFt2) * 0.2);
      const innerGeom = _bufferInward(footprintGeom, courtyardInsetFt);
      features.push(_makeFeature(footprintGeom, 0, buildingHeightFt, color, massingOption, numFloors, "courtyard-shell"));
      if (innerGeom && innerGeom !== footprintGeom) {
        // "punch" the courtyard by rendering inner as transparent (same base/height, different color)
        features.push(_makeFeature(innerGeom, 0, buildingHeightFt, "rgba(0,0,0,0)", massingOption, 0, "courtyard-void"));
      }
      break;
    }
    case "tower": {
      // Small tower plate on a podium base
      const podiumHeight = Math.min(buildingHeightFt * 0.35, 40);
      const towerInsetFt = Math.max(10, Math.sqrt(footprintAreaFt2) * 0.2);
      const towerGeom = _bufferInward(footprintGeom, towerInsetFt);
      features.push(_makeFeature(footprintGeom, 0, podiumHeight, color, massingOption, numFloors, "podium"));
      if (towerGeom && towerGeom !== footprintGeom) {
        features.push(_makeFeature(towerGeom, podiumHeight, buildingHeightFt, color, massingOption, numFloors, "tower"));
      } else {
        features.push(_makeFeature(footprintGeom, podiumHeight, buildingHeightFt, color, massingOption, numFloors, "tower"));
      }
      break;
    }
    case "slab": {
      // Linear slab: use an inset footprint and push height a bit higher
      const slabInsetFt = Math.max(5, Math.sqrt(footprintAreaFt2) * 0.15);
      const slabGeom = _bufferInward(footprintGeom, slabInsetFt) || footprintGeom;
      const slabArea = _area(slabGeom);
      const slabFloors = slabArea > 0 ? Math.max(1, Math.ceil(allowedFarFloorArea / slabArea)) : numFloors;
      const slabHeight = Math.min(slabFloors * safeFloorHeight, safeMaxHeight);
      features.push(_makeFeature(slabGeom, 0, slabHeight, color, massingOption, slabFloors, "slab"));
      break;
    }
    case "stepped": {
      // 3-tier stepped massing
      const insets = [0, 12, 24];
      const tierRatios = [0.45, 0.72, 1.0];
      for (let i = 0; i < 3; i++) {
        const tierGeom = i === 0 ? footprintGeom : (_bufferInward(footprintGeom, insets[i]) || footprintGeom);
        const tierBase = i === 0 ? 0 : buildingHeightFt * tierRatios[i - 1];
        const tierTop = buildingHeightFt * tierRatios[i];
        const feat = _makeFeature(tierGeom, tierBase, tierTop, color, massingOption, numFloors, `step-${i + 1}`);
        if (feat) features.push(feat);
      }
      break;
    }
    default: {
      // "full-block" or any other option
      let activeGeom = footprintGeom;
      if (safeCoverage < 0.99) {
        const coverInset = (1 - safeCoverage) * Math.sqrt(footprintAreaFt2) * 0.25;
        activeGeom = _bufferInward(footprintGeom, coverInset) || footprintGeom;
      }
      features.push(_makeFeature(activeGeom, 0, buildingHeightFt, color, massingOption, numFloors, "full-block"));
      break;
    }
  }

  return {
    features: features.filter(Boolean),
    warnings,
    numFloors,
    buildingHeightFt,
  };
}
