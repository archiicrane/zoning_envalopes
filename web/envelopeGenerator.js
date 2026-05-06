import { coerceNumber } from "./zoningRuleEngine.js";

const FT_TO_M = 0.3048;

function closeRing(ring) {
  if (!Array.isArray(ring) || !ring.length) return [];
  const out = ring.map((p) => [p[0], p[1]]);
  const first = out[0];
  const last = out[out.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) out.push([first[0], first[1]]);
  return out;
}

function bufferInward(geometry, insetFt) {
  if (!geometry || !Number.isFinite(insetFt) || insetFt <= 0) return geometry;
  try {
    const buffered = turf.buffer({ type: "Feature", geometry, properties: {} }, -(insetFt * FT_TO_M), { units: "meters" });
    if (buffered?.geometry?.coordinates?.length) return buffered.geometry;
  } catch (_err) {
    // fallback to original geometry
  }
  return geometry;
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

function yardInsetFromControls(controls) {
  const candidates = [controls.frontYard, controls.sideYard, controls.rearYard].filter((n) => Number.isFinite(n));
  return candidates.length ? Math.max(...candidates) : 0;
}

function generatePitchedEnvelope(lotGeometry, controls, envelopeColor, zoneCode) {
  const maxHeight = coerceNumber(controls.maxBuildingHeight) ?? coerceNumber(controls.ridgeHeight);
  if (maxHeight == null) return [];
  const perimeterHeight = coerceNumber(controls.perimeterWallHeight) ?? Math.max(20, maxHeight - 10);
  const ridgeHeight = coerceNumber(controls.ridgeHeight) ?? maxHeight;

  const yardInset = yardInsetFromControls(controls);
  const baseGeometry = bufferInward(lotGeometry, yardInset);
  const roofGeometry = bufferInward(baseGeometry, Math.max(2, controls.streetSetback / 2));

  return [
    makeEnvelopeFeature(baseGeometry, 0, perimeterHeight, envelopeColor, zoneCode, controls, "perimeter"),
    makeEnvelopeFeature(roofGeometry, perimeterHeight, ridgeHeight, envelopeColor, zoneCode, controls, "ridge"),
  ];
}

function generateFlatEnvelope(lotGeometry, controls, envelopeColor, zoneCode) {
  const maxHeight = coerceNumber(controls.maxBuildingHeight)
    ?? coerceNumber(controls.frontWallHeight);
  if (maxHeight == null) return [];
  const yardInset = yardInsetFromControls(controls);
  const geometry = bufferInward(lotGeometry, yardInset);
  return [makeEnvelopeFeature(geometry, 0, maxHeight, envelopeColor, zoneCode, controls, "flat")];
}

function generateBaseAndSetbackEnvelope(lotGeometry, controls, envelopeColor, zoneCode) {
  const maxHeight = coerceNumber(controls.maxBuildingHeight)
    ?? coerceNumber(controls.frontWallHeight);
  if (maxHeight == null) return [];
  const baseHeight = coerceNumber(controls.maxBaseHeight)
    ?? coerceNumber(controls.frontWallHeight)
    ?? Math.max(35, maxHeight - 20);
  const yardInset = yardInsetFromControls(controls);

  const baseGeometry = bufferInward(lotGeometry, yardInset);
  const upperGeometry = bufferInward(baseGeometry, controls.streetSetback || 0);

  return [
    makeEnvelopeFeature(baseGeometry, 0, baseHeight, envelopeColor, zoneCode, controls, "base"),
    makeEnvelopeFeature(upperGeometry, baseHeight, maxHeight, envelopeColor, zoneCode, controls, "upper"),
  ];
}

function generateSkyExposureEnvelope(lotGeometry, controls, envelopeColor, zoneCode) {
  const frontWall = coerceNumber(controls.frontWallHeight)
    ?? coerceNumber(controls.maxBaseHeight)
    ?? 60;
  const maxHeight = coerceNumber(controls.maxBuildingHeight)
    ?? coerceNumber(controls.ridgeHeight);
  if (maxHeight == null) {
    return {
      features: [],
      warnings: ["Missing full rule data for this condition."],
    };
  }
  const yardInset = yardInsetFromControls(controls);

  const baseGeometry = bufferInward(lotGeometry, yardInset);
  // Simplified sky exposure plane proxy: additional inset for upper segment.
  const skyPlaneInset = Math.max(controls.streetSetback || 0, 8);
  const upperGeometry = bufferInward(baseGeometry, skyPlaneInset);

  const warnings = [
    "Envelope simplified: sky exposure plane rendered as stepped setback proxy.",
  ];

  return {
    features: [
      makeEnvelopeFeature(baseGeometry, 0, frontWall, envelopeColor, zoneCode, controls, "front-wall"),
      makeEnvelopeFeature(upperGeometry, frontWall, maxHeight, envelopeColor, zoneCode, controls, "sky-plane"),
    ],
    warnings,
  };
}

export function generateEnvelopeFromControls({ lotGeometry, controls, envelopeColor = "#7DB7FF", zoneCode = "" }) {
  const regime = String(controls?.bulkRegime || "flat-roof").toLowerCase();
  const warnings = [];
  const maxHeight = coerceNumber(controls?.maxBuildingHeight) ?? coerceNumber(controls?.ridgeHeight) ?? coerceNumber(controls?.frontWallHeight);
  if (maxHeight == null) {
    warnings.push("Missing full rule data for this condition.");
    const yardInset = yardInsetFromControls(controls || {});
    const buildableGeometry = bufferInward(lotGeometry, yardInset);
    return {
      envelopeFeatures: [],
      buildableFootprintFeature: {
        type: "Feature",
        geometry: buildableGeometry,
        properties: {
          kind: "buildable_footprint_engine",
          zoneCode,
        },
      },
      warnings,
    };
  }
  let features = [];

  if (regime === "pitched-envelope") {
    features = generatePitchedEnvelope(lotGeometry, controls, envelopeColor, zoneCode);
  } else if (regime === "flat-roof") {
    features = generateFlatEnvelope(lotGeometry, controls, envelopeColor, zoneCode);
  } else if (["base-and-setback", "contextual", "contextual-variant"].includes(regime)) {
    features = generateBaseAndSetbackEnvelope(lotGeometry, controls, envelopeColor, zoneCode);
  } else if (["sky-exposure-plane", "sky-exposure-plane-or-tower", "manufacturing-sky-exposure"].includes(regime)) {
    const generated = generateSkyExposureEnvelope(lotGeometry, controls, envelopeColor, zoneCode);
    features = generated.features;
    warnings.push(...generated.warnings);
  } else {
    features = generateFlatEnvelope(lotGeometry, controls, envelopeColor, zoneCode);
    warnings.push(`Envelope simplified: unknown bulk regime '${regime}', defaulting to flat extrusion.`);
  }

  const yardInset = yardInsetFromControls(controls);
  const buildableGeometry = bufferInward(lotGeometry, yardInset);

  return {
    envelopeFeatures: features,
    buildableFootprintFeature: {
      type: "Feature",
      geometry: buildableGeometry,
      properties: {
        kind: "buildable_footprint_engine",
        zoneCode,
      },
    },
    warnings,
  };
}
