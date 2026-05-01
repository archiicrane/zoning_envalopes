export function coerceNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function normalizeZoneToken(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, "");
}

export function extractZoneTokens(...values) {
  const tokens = [];
  for (const value of values) {
    const raw = String(value || "").toUpperCase();
    if (!raw) continue;
    const normalized = raw
      .replace(/(?<=\d)-(?=[RCM])/g, " ")
      .replace(/[\/,;()]/g, " ");
    for (const part of normalized.split(/\s+/)) {
      const token = normalizeZoneToken(part);
      if (!token || !/^[RCM]/.test(token)) continue;
      if (!tokens.includes(token)) tokens.push(token);
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

export function pickPrimaryZoneToken(...values) {
  const tokens = extractZoneTokens(...values);
  if (!tokens.length) return "";
  return tokens.sort((a, b) => {
    const [pa, la] = zonePriority(a);
    const [pb, lb] = zonePriority(b);
    if (pa !== pb) return pb - pa;
    return lb - la;
  })[0];
}

export function buildRulesIndex(rules) {
  const idx = new Map();
  for (const rule of rules || []) {
    if (!rule?.zoneCode) continue;
    const zoneCode = normalizeZoneToken(rule.zoneCode);
    idx.set(zoneCode, { ...rule, zoneCode });
  }
  return idx;
}

export function resolveZoneRule(zoneToken, rulesIndex) {
  const token = normalizeZoneToken(zoneToken);
  if (!token || !rulesIndex?.has(token)) return null;
  const direct = rulesIndex.get(token);
  const equivalent = normalizeZoneToken(direct.residentialEquivalent);
  if (!equivalent || !rulesIndex.has(equivalent)) return direct;
  const base = rulesIndex.get(equivalent);
  return { ...base, ...direct, zoneCode: direct.zoneCode };
}

export function getStreetType(streetWidthFt) {
  return Number(streetWidthFt) >= 75 ? "wide" : "narrow";
}

export function chooseFAR(zoneRule, lotAnalysis) {
  const qualifying = coerceNumber(zoneRule?.qualifyingFar);
  const standard = coerceNumber(zoneRule?.standardFar);
  const maxFar = coerceNumber(zoneRule?.maxFar);
  const lotType = String(lotAnalysis?.lotType || "Interior");

  if (lotType === "Corner" && qualifying != null) return qualifying;
  return maxFar ?? qualifying ?? standard ?? null;
}

export function getSideYardRequirement(zoneRule, lotAnalysis) {
  const each = coerceNumber(zoneRule?.sideYardEachFt);
  if (each == null) return 0;
  // Through lots often treat side conditions differently; keep conservative baseline.
  if (lotAnalysis?.isThroughLot) return each;
  return each;
}

export function getRearYardRequirement(zoneRule, lotAnalysis) {
  if (lotAnalysis?.isThroughLot) return 0;
  return coerceNumber(zoneRule?.rearYardFt) ?? 0;
}

export function getApplicableControls(lotAnalysis, zoneRule) {
  const warnings = [];
  const streetWidthFt = coerceNumber(lotAnalysis?.primaryStreet?.widthFt) ?? 50;
  const streetType = getStreetType(streetWidthFt);

  const far = chooseFAR(zoneRule, lotAnalysis);
  if (far == null) warnings.push("FAR missing in zoning rule; envelope simplified.");

  const maxBuildingHeight = coerceNumber(zoneRule?.maximumBuildingHeightFt)
    ?? coerceNumber(zoneRule?.ridgeHeightFt)
    ?? null;
  if (maxBuildingHeight == null) {
    warnings.push("Maximum building height missing; using front-wall or fallback assumptions.");
  }
  if (!Array.isArray(zoneRule?.sourceSections) || !zoneRule.sourceSections.length) {
    warnings.push("Envelope simplified: missing special district / lot-specific zoning controls.");
  }

  const wide = coerceNumber(zoneRule?.streetSetbackWideFt);
  const narrow = coerceNumber(zoneRule?.streetSetbackNarrowFt);
  const streetSetback = streetType === "wide" ? (wide ?? narrow ?? 0) : (narrow ?? wide ?? 0);

  return {
    zoneCode: zoneRule?.zoneCode || lotAnalysis?.primaryZone || "",
    districtType: zoneRule?.districtType || lotAnalysis?.districtType || null,
    bulkRegime: zoneRule?.bulkRegime || "flat-roof",
    sourceSections: Array.isArray(zoneRule?.sourceSections) ? zoneRule.sourceSections : [],
    far,
    frontYard: coerceNumber(zoneRule?.frontYardFt) ?? 0,
    sideYard: getSideYardRequirement(zoneRule, lotAnalysis),
    rearYard: getRearYardRequirement(zoneRule, lotAnalysis),
    maxBaseHeight: coerceNumber(zoneRule?.maximumBaseHeightFt),
    minBaseHeight: coerceNumber(zoneRule?.minimumBaseHeightFt),
    maxBuildingHeight,
    frontWallHeight: coerceNumber(zoneRule?.maximumFrontWallHeightFt),
    perimeterWallHeight: coerceNumber(zoneRule?.perimeterWallHeightFt),
    ridgeHeight: coerceNumber(zoneRule?.ridgeHeightFt),
    streetSetback,
    streetType,
    streetWidthFt,
    openSpaceRatio: coerceNumber(zoneRule?.openSpaceRatio),
    lotType: lotAnalysis?.lotType || "Interior",
    warnings,
  };
}

export function getControlsForLot(lotAnalysis, rulesIndex) {
  const zoneTokens = Array.isArray(lotAnalysis?.zoneTokens) ? lotAnalysis.zoneTokens : [];
  const zones = zoneTokens.length ? zoneTokens : [lotAnalysis?.primaryZone].filter(Boolean);

  if (!zones.length) {
    return {
      mixedZoning: false,
      controlsByZone: [],
      warnings: ["Envelope simplified: missing zoning district for lot."],
    };
  }

  const controlsByZone = [];
  const warnings = [];

  for (const token of zones) {
    const rule = resolveZoneRule(token, rulesIndex);
    if (!rule) {
      warnings.push(`Envelope simplified: missing zoning controls for ${token}.`);
      continue;
    }
    controlsByZone.push({
      zone: token,
      overlapRatio: 1 / zones.length,
      controls: getApplicableControls(lotAnalysis, rule),
    });
  }

  const mixedZoning = controlsByZone.length > 1;
  if (mixedZoning) {
    warnings.push("Mixed zoning lot: district overlap ratios approximated from attributes; lot split is simplified.");
  }

  if (!controlsByZone.length) {
    warnings.push("Envelope simplified: missing special district / lot-specific zoning controls.");
    warnings.push("Envelope simplified: no applicable zoning controls resolved.");
  }

  return { mixedZoning, controlsByZone, warnings };
}
