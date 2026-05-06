export function coerceNumber(value) {
  if (value == null) return null;
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
    idx.set(zoneCode, {
      ...rule,
      zoneCode,
      variants: _normalizeRuleVariants(rule),
    });
  }
  return idx;
}

function _normalizeVariantKey(value) {
  const key = String(value || "").trim();
  if (!key) return "standardResidential";
  if (key === "standardResidential") return key;
  if (["qualifyingAffordableHousing", "qualifyingSeniorHousing", "qualifyingAffordableOrSenior"].includes(key)) {
    return "qualifyingAffordableOrSenior";
  }
  if (["nonResidential", "buildingsOrOtherStructures", "otherStructures"].includes(key)) {
    return "buildingsOrOtherStructures";
  }
  return key;
}

function _normalizeHousingType(value) {
  const text = String(value || "marketRate").trim();
  if (["qualifyingAffordable", "affordable", "inclusionary", "qualifyingSenior", "senior", "qualifyingAffordableOrSenior", "affordableOrSenior", "affordable_or_senior"].includes(text)) {
    return "qualifyingAffordableOrSenior";
  }
  return "marketRate";
}

function _normalizeBuildingUseType(value) {
  const text = String(value || "residential").trim();
  if (["communityFacility", "facility"].includes(text)) return "communityFacility";
  if (["commercial", "nonResidential", "non_residential"].includes(text)) return "nonResidential";
  if (["mixedUse", "mixed"].includes(text)) return "mixedUse";
  return "residential";
}

function _coalesceNumber(...values) {
  for (const value of values) {
    const n = coerceNumber(value);
    if (n != null) return n;
  }
  return null;
}

function _mergeVariantSources(...sources) {
  return Object.assign({}, ...sources.filter((source) => source && typeof source === "object"));
}

function _mergeSourceSections(...values) {
  return Array.from(
    new Set(
      values.flatMap((value) => Array.isArray(value) ? value : [])
    )
  );
}

function _buildResolvedVariant(label, farValue, variant, fallback) {
  const merged = _mergeVariantSources(fallback, variant);
  return {
    label,
    far: _coalesceNumber(variant?.far, farValue),
    minimumBaseHeightFt: _coalesceNumber(variant?.minimumBaseHeightFt, fallback?.minimumBaseHeightFt),
    maximumBaseHeightFt: _coalesceNumber(variant?.maximumBaseHeightFt, fallback?.maximumBaseHeightFt),
    maximumBuildingHeightFt: _coalesceNumber(variant?.maximumBuildingHeightFt, fallback?.maximumBuildingHeightFt),
    maximumFrontWallHeightFt: _coalesceNumber(variant?.maximumFrontWallHeightFt, fallback?.maximumFrontWallHeightFt),
    perimeterWallHeightFt: _coalesceNumber(variant?.perimeterWallHeightFt, fallback?.perimeterWallHeightFt),
    ridgeHeightFt: _coalesceNumber(variant?.ridgeHeightFt, fallback?.ridgeHeightFt),
    streetSetbackWideFt: _coalesceNumber(variant?.streetSetbackWideFt, fallback?.streetSetbackWideFt),
    streetSetbackNarrowFt: _coalesceNumber(variant?.streetSetbackNarrowFt, fallback?.streetSetbackNarrowFt),
    openSpaceRatio: _coalesceNumber(variant?.openSpaceRatio, fallback?.openSpaceRatio),
    usesOpenSpaceRatio:
      typeof merged.usesOpenSpaceRatio === "boolean"
        ? merged.usesOpenSpaceRatio
        : null,
    frontYardFt: _coalesceNumber(variant?.frontYardFt, fallback?.frontYardFt),
    sideYardEachFt: _coalesceNumber(variant?.sideYardEachFt, fallback?.sideYardEachFt),
    rearYardFt: _coalesceNumber(variant?.rearYardFt, fallback?.rearYardFt),
    bulkRegime: variant?.bulkRegime || fallback?.bulkRegime || null,
    sourceSections: _mergeSourceSections(fallback?.sourceSections, variant?.sourceSections),
    notes: variant?.notes || fallback?.notes || null,
  };
}

function _normalizeRuleVariants(rule) {
  const base = rule || {};
  const standardFar = _coalesceNumber(base.standardFar, base.maxFar, base.qualifyingFar);
  const qualifyingFar = _coalesceNumber(base.qualifyingFar, standardFar);
  const baseVariant = {
    minimumBaseHeightFt: _coalesceNumber(base.minimumBaseHeightFt),
    maximumBaseHeightFt: _coalesceNumber(base.maximumBaseHeightFt),
    maximumBuildingHeightFt: _coalesceNumber(base.maximumBuildingHeightFt),
    maximumFrontWallHeightFt: _coalesceNumber(base.maximumFrontWallHeightFt),
    perimeterWallHeightFt: _coalesceNumber(base.perimeterWallHeightFt),
    ridgeHeightFt: _coalesceNumber(base.ridgeHeightFt),
    streetSetbackWideFt: _coalesceNumber(base.streetSetbackWideFt),
    streetSetbackNarrowFt: _coalesceNumber(base.streetSetbackNarrowFt),
    openSpaceRatio: _coalesceNumber(base.openSpaceRatio),
    usesOpenSpaceRatio: typeof base.usesOpenSpaceRatio === "boolean" ? base.usesOpenSpaceRatio : null,
    frontYardFt: _coalesceNumber(base.frontYardFt),
    sideYardEachFt: _coalesceNumber(base.sideYardEachFt),
    rearYardFt: _coalesceNumber(base.rearYardFt),
    bulkRegime: base.bulkRegime || null,
    sourceSections: Array.isArray(base.sourceSections) ? base.sourceSections : [],
    notes: base.notes || null,
  };

  const existing = base.variants && typeof base.variants === "object" ? base.variants : {};
  const standardSource = existing.standardResidential || {};
  const qualifyingSource = _mergeVariantSources(
    existing.qualifyingAffordableOrSenior,
    existing.qualifyingAffordableHousing,
    existing.qualifyingSeniorHousing
  );
  const buildingsSource = _mergeVariantSources(
    existing.buildingsOrOtherStructures,
    existing.nonResidential
  );

  const standardVariant = _buildResolvedVariant(
    "Market Rate / Standard Residential",
    standardFar,
    standardSource,
    baseVariant
  );
  const qualifyingVariant = _buildResolvedVariant(
    "Qualifying Affordable or Senior Housing",
    qualifyingFar,
    qualifyingSource,
    standardVariant
  );
  const buildingsVariant = _buildResolvedVariant(
    "Buildings or Other Structures",
    _coalesceNumber(buildingsSource?.far),
    buildingsSource,
    standardVariant
  );

  return {
    standardResidential: standardVariant,
    qualifyingAffordableOrSenior: qualifyingVariant,
    buildingsOrOtherStructures: buildingsVariant,
  };
}

function _zoneCandidates(zoneCode, footnoteVariant) {
  const candidates = [];
  const base = normalizeZoneToken(zoneCode);
  if (base) candidates.push(base);

  const footnote = normalizeZoneToken(footnoteVariant);
  if (footnote) {
    if (footnote.includes("-2")) {
      candidates.unshift(footnote.replace("-2", "^2"));
      if (base) candidates.unshift(`${base}^2`);
    }
    candidates.unshift(footnote);
  }

  return Array.from(new Set(candidates.filter(Boolean)));
}

function _variantKeyFromOptions(options) {
  const explicit = _normalizeVariantKey(options?.variantKey || options?.selectedVariant || "");
  if (explicit && explicit !== "standardResidential") {
    return explicit;
  }

  const buildingUseType = _normalizeBuildingUseType(options?.buildingUseType);
  if (buildingUseType === "communityFacility" || buildingUseType === "nonResidential") {
    return "buildingsOrOtherStructures";
  }

  const housingType = _normalizeHousingType(options?.housingType);
  if (housingType === "qualifyingAffordableOrSenior") return "qualifyingAffordableOrSenior";
  return "standardResidential";
}

export function resolveZoningVariant(zoneCode, options = {}, rulesIndex) {
  const idx = rulesIndex;
  const warnings = [];
  if (!idx || !(idx instanceof Map)) {
    return {
      zoneCode: normalizeZoneToken(zoneCode),
      selectedVariant: "standardResidential",
      warnings: ["Missing zoning rules index."],
      resolved: null,
    };
  }

  const zoneCandidates = _zoneCandidates(zoneCode, options.footnoteVariant);
  const matchedZoneCode = zoneCandidates.find((candidate) => idx.has(candidate));
  if (!matchedZoneCode) {
    return {
      zoneCode: normalizeZoneToken(zoneCode),
      selectedVariant: _variantKeyFromOptions(options),
      warnings: [`Missing zoning controls for ${normalizeZoneToken(zoneCode) || "(unknown zone)"}.`],
      resolved: null,
    };
  }

  const direct = idx.get(matchedZoneCode);
  const equivalent = normalizeZoneToken(direct?.residentialEquivalent);
  const base = equivalent && idx.has(equivalent) ? idx.get(equivalent) : null;
  const merged = { ...(base || {}), ...(direct || {}), zoneCode: matchedZoneCode };
  const variants = _normalizeRuleVariants(merged);
  const requestedVariant = _variantKeyFromOptions(options);

  const selectedVariant = variants[requestedVariant]
    ? requestedVariant
    : variants.standardResidential
      ? "standardResidential"
      : Object.keys(variants)[0];

  if (!variants[requestedVariant]) {
    warnings.push(`Requested variant '${requestedVariant}' not found for ${matchedZoneCode}; using '${selectedVariant}'.`);
  }

  const variant = variants[selectedVariant] || {};
  const sourceSections = Array.from(
    new Set([
      ...(Array.isArray(merged.sourceSections) ? merged.sourceSections : []),
      ...(Array.isArray(variant.sourceSections) ? variant.sourceSections : []),
    ])
  );

  const resolved = {
    zoneCode: matchedZoneCode,
    requestedZoneCode: normalizeZoneToken(zoneCode),
    selectedVariant,
    variantLabel: variant.label || selectedVariant,
    buildingUseType: _normalizeBuildingUseType(options.buildingUseType),
    housingType: _normalizeHousingType(options.housingType),
    lotType: String(options.lotType || "interior"),
    streetType: String(options.streetType || "narrow"),
    districtType: merged.districtType || merged.zoneType || null,
    bulkRegime: variant.bulkRegime || merged.bulkRegime || "flat-roof",
    far: _coalesceNumber(variant.far),
    standardFar: _coalesceNumber(variant.far, merged.standardFar, merged.maxFar),
    qualifyingFar: _coalesceNumber(variant.far, merged.qualifyingFar, merged.standardFar, merged.maxFar),
    maxFar: _coalesceNumber(variant.far, merged.maxFar, merged.qualifyingFar, merged.standardFar),
    frontYardFt: _coalesceNumber(variant.frontYardFt, merged.frontYardFt),
    sideYardEachFt: _coalesceNumber(variant.sideYardEachFt, merged.sideYardEachFt),
    rearYardFt: _coalesceNumber(variant.rearYardFt, merged.rearYardFt),
    minimumBaseHeightFt: _coalesceNumber(variant.minimumBaseHeightFt, merged.minimumBaseHeightFt),
    maximumBaseHeightFt: _coalesceNumber(variant.maximumBaseHeightFt, merged.maximumBaseHeightFt),
    maximumBuildingHeightFt: _coalesceNumber(variant.maximumBuildingHeightFt, merged.maximumBuildingHeightFt),
    maximumFrontWallHeightFt: _coalesceNumber(variant.maximumFrontWallHeightFt, merged.maximumFrontWallHeightFt),
    perimeterWallHeightFt: _coalesceNumber(variant.perimeterWallHeightFt, merged.perimeterWallHeightFt),
    ridgeHeightFt: _coalesceNumber(variant.ridgeHeightFt, merged.ridgeHeightFt),
    streetSetbackWideFt: _coalesceNumber(variant.streetSetbackWideFt, merged.streetSetbackWideFt),
    streetSetbackNarrowFt: _coalesceNumber(variant.streetSetbackNarrowFt, merged.streetSetbackNarrowFt),
    openSpaceRatio: _coalesceNumber(variant.openSpaceRatio, merged.openSpaceRatio),
    usesOpenSpaceRatio:
      typeof merged.usesOpenSpaceRatio === "boolean"
        ? merged.usesOpenSpaceRatio
        : Boolean(_coalesceNumber(variant.openSpaceRatio, merged.openSpaceRatio) > 0),
    sourceSections,
    notes: variant.notes || merged.notes || "",
    warnings,
    variants,
  };

  if (resolved.far == null && selectedVariant !== "buildingsOrOtherStructures") {
    warnings.push("Missing FAR for resolved variant.");
  }
  if (resolved.maximumBuildingHeightFt == null) {
    warnings.push("Missing full rule data for this condition.");
  }

  return { zoneCode: matchedZoneCode, selectedVariant, warnings, resolved };
}

export function resolveZoneRule(zoneToken, rulesIndex) {
  const variant = resolveZoningVariant(
    zoneToken,
    { buildingUseType: "residential", housingType: "marketRate" },
    rulesIndex
  );
  const resolved = variant?.resolved;
  if (!resolved) return null;
  return {
    zoneCode: resolved.zoneCode,
    districtType: resolved.districtType,
    bulkRegime: resolved.bulkRegime,
    standardFar: resolved.standardFar,
    qualifyingFar: resolved.qualifyingFar,
    maxFar: resolved.maxFar,
    frontYardFt: resolved.frontYardFt,
    sideYardEachFt: resolved.sideYardEachFt,
    rearYardFt: resolved.rearYardFt,
    minimumBaseHeightFt: resolved.minimumBaseHeightFt,
    maximumBaseHeightFt: resolved.maximumBaseHeightFt,
    maximumBuildingHeightFt: resolved.maximumBuildingHeightFt,
    maximumFrontWallHeightFt: resolved.maximumFrontWallHeightFt,
    perimeterWallHeightFt: resolved.perimeterWallHeightFt,
    ridgeHeightFt: resolved.ridgeHeightFt,
    streetSetbackWideFt: resolved.streetSetbackWideFt,
    streetSetbackNarrowFt: resolved.streetSetbackNarrowFt,
    openSpaceRatio: resolved.openSpaceRatio,
    usesOpenSpaceRatio: resolved.usesOpenSpaceRatio,
    sourceSections: resolved.sourceSections,
    notes: resolved.notes,
    selectedVariant: resolved.selectedVariant,
    variants: resolved.variants,
  };
}

export function getStreetType(streetWidthFt) {
  return Number(streetWidthFt) >= 75 ? "wide" : "narrow";
}

function sideYardSidesRequired(zoneRule, lotAnalysis) {
  const each = coerceNumber(zoneRule?.sideYardEachFt);
  if (!Number.isFinite(each) || each <= 0) return 0;

  const lotType = String(lotAnalysis?.lotType || "Interior");
  const zoneCode = String(zoneRule?.zoneCode || "").toUpperCase();
  const isLowDensityResidence = /^R([1-5]|2X|3-1|3A|3X|4-1|4A|5A)/.test(zoneCode);

  // Corner lots generally have a single interior side-lot line; through/interior lots
  // in low-density detached/semi-detached contexts usually need both sides considered.
  if (lotType === "Corner") return 1;
  if (lotType === "Through") return 2;
  if (isLowDensityResidence) return 2;

  // Default conservative assumption when only sideYardEachFt is known.
  return 1;
}

export function chooseFAR(zoneRule, lotAnalysis) {
  const qualifying = coerceNumber(zoneRule?.qualifyingFar);
  const standard = coerceNumber(zoneRule?.standardFar ?? zoneRule?.far);
  const maxFar = coerceNumber(zoneRule?.maxFar ?? zoneRule?.far);
  const lotType = String(lotAnalysis?.lotType || "Interior");

  if (lotType === "Corner" && qualifying != null) return qualifying;
  return maxFar ?? qualifying ?? standard ?? null;
}

export function getSideYardRequirement(zoneRule, lotAnalysis) {
  const each = coerceNumber(zoneRule?.sideYardEachFt);
  if (each == null) {
    return {
      eachFt: 0,
      sidesRequired: 0,
      totalFt: 0,
    };
  }
  const sidesRequired = sideYardSidesRequired(zoneRule, lotAnalysis);
  return {
    eachFt: each,
    sidesRequired,
    totalFt: each * sidesRequired,
  };
}

export function getRearYardRequirement(zoneRule, lotAnalysis) {
  if (lotAnalysis?.isThroughLot) return 0;
  return coerceNumber(zoneRule?.rearYardFt) ?? 0;
}

export function getApplicableControls(lotAnalysis, zoneRule) {
  const warnings = [];
  const streetWidthFt = coerceNumber(lotAnalysis?.primaryStreet?.widthFt) ?? 50;
  const streetType = getStreetType(streetWidthFt);
  const sideYardReq = getSideYardRequirement(zoneRule, lotAnalysis);

  const far = chooseFAR(zoneRule, lotAnalysis);
  if (far == null) warnings.push("FAR missing in zoning rule; envelope simplified.");

  const maxBuildingHeight = coerceNumber(zoneRule?.maximumBuildingHeightFt)
    ?? coerceNumber(zoneRule?.ridgeHeightFt)
    ?? coerceNumber(zoneRule?.maximumFrontWallHeightFt)
    ?? null;
  if (maxBuildingHeight == null) {
    warnings.push("Missing full rule data for this condition.");
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
    sideYard: sideYardReq.eachFt,
    sideYardSidesRequired: sideYardReq.sidesRequired,
    totalSideYardRequiredFt: sideYardReq.totalFt,
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
  const options = {
    buildingUseType: lotAnalysis?.buildingUseType || "residential",
    housingType: lotAnalysis?.housingType || "marketRate",
    footnoteVariant: lotAnalysis?.footnoteVariant || null,
  };

  const rawAnalysis = lotAnalysis?.type === "Feature"
    ? {
      zoneTokens: extractZoneTokens(
        lotAnalysis?.properties?.zonedist1,
        lotAnalysis?.properties?.ZoneDist1,
        lotAnalysis?.properties?.zonedist2,
        lotAnalysis?.properties?.ZoneDist2,
        lotAnalysis?.properties?.zone,
        lotAnalysis?.properties?.ZoningDist
      ),
      primaryZone: pickPrimaryZoneToken(
        lotAnalysis?.properties?.zonedist1,
        lotAnalysis?.properties?.ZoneDist1,
        lotAnalysis?.properties?.zonedist2,
        lotAnalysis?.properties?.ZoneDist2,
        lotAnalysis?.properties?.zone,
        lotAnalysis?.properties?.ZoningDist
      ),
      lotType: "Interior",
      isThroughLot: false,
      primaryStreet: { widthFt: 50 },
      buildingUseType: options.buildingUseType,
      housingType: options.housingType,
      footnoteVariant: options.footnoteVariant,
    }
    : lotAnalysis;

  const zoneTokens = Array.isArray(rawAnalysis?.zoneTokens) ? rawAnalysis.zoneTokens : [];
  const zones = zoneTokens.length ? zoneTokens : [rawAnalysis?.primaryZone].filter(Boolean);

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
    const streetWidthFt = coerceNumber(rawAnalysis?.primaryStreet?.widthFt) ?? 50;
    const streetType = getStreetType(streetWidthFt);
    const lotType = String(rawAnalysis?.lotType || "Interior").toLowerCase();
    const resolved = resolveZoningVariant(
      token,
      {
        ...options,
        streetType,
        lotType,
      },
      rulesIndex
    );
    if (!resolved?.resolved) {
      warnings.push(`Envelope simplified: missing zoning controls for ${token}.`);
      continue;
    }

    const resolvedRule = resolved.resolved;
    warnings.push(...(resolved.warnings || []));

    controlsByZone.push({
      zone: token,
      zoneCode: resolvedRule.zoneCode || token,
      resolvedZoneCode: resolvedRule.zoneCode || token,
      ruleFound: true,
      residentialEquivalent: normalizeZoneToken((rulesIndex?.get(resolvedRule.zoneCode || token)?.residentialEquivalent) || "") || null,
      selectedVariant: resolvedRule.selectedVariant,
      overlapRatio: 1 / zones.length,
      controls: getApplicableControls(rawAnalysis, {
        ...resolvedRule,
        maximumBuildingHeightFt: resolvedRule.maximumBuildingHeightFt,
      }),
      resolvedRule,
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
