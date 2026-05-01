import { coerceNumber, extractZoneTokens, pickPrimaryZoneToken, getStreetType } from "./zoningRuleEngine.js";

const FT_TO_M = 0.3048;

function closeRing(ring) {
  if (!Array.isArray(ring) || !ring.length) return [];
  const out = ring.map((p) => [p[0], p[1]]);
  const first = out[0];
  const last = out[out.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) out.push([first[0], first[1]]);
  return out;
}

function ringEdges(ring) {
  const closed = closeRing(ring);
  const edges = [];
  for (let i = 0; i < closed.length - 1; i += 1) {
    const a = closed[i];
    const b = closed[i + 1];
    const line = turf.lineString([a, b]);
    const midpoint = turf.midpoint(turf.point(a), turf.point(b)).geometry.coordinates;
    const lengthFt = turf.distance(turf.point(a), turf.point(b), { units: "meters" }) / FT_TO_M;
    edges.push({ idx: i, a, b, line, midpoint, lengthFt });
  }
  return edges;
}

function roadWidthFtFromRoad(road) {
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
    if (numeric < 30) return numeric * 3.28084;
    return numeric;
  }

  const klass = String(props.class || props.road_class || props.type || "").toLowerCase();
  if (/(motorway|trunk)/.test(klass)) return 120;
  if (/(primary|arterial)/.test(klass)) return 90;
  if (/(secondary|boulevard|avenue)/.test(klass)) return 75;
  if (/(tertiary)/.test(klass)) return 65;
  if (/(residential|street|service|link|local)/.test(klass)) return 50;
  return 50;
}

function roadName(road) {
  const props = road?.properties || {};
  return props.name || props.ref || props.class || props.type || "Unknown road";
}

function toRoadLineFeatures(rawRoadFeatures) {
  const out = [];
  for (const feature of rawRoadFeatures || []) {
    const geom = feature?.geometry;
    if (!geom) continue;
    if (geom.type === "LineString") {
      out.push({ type: "Feature", geometry: geom, properties: feature.properties || {} });
    } else if (geom.type === "MultiLineString") {
      for (const coords of geom.coordinates || []) {
        if (coords?.length >= 2) {
          out.push({ type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: feature.properties || {} });
        }
      }
    }
  }
  return out;
}

function toLotBoundaryLines(features) {
  const lines = [];
  for (const feature of features || []) {
    const geom = feature?.geometry;
    if (!geom) continue;
    const polygons = geom.type === "Polygon" ? [geom.coordinates] : (geom.type === "MultiPolygon" ? geom.coordinates : []);
    for (const poly of polygons) {
      for (const ring of poly || []) {
        if (ring?.length >= 2) {
          lines.push(turf.lineString(closeRing(ring)));
        }
      }
    }
  }
  return lines;
}

function bboxWidthDepthFt(lotRing) {
  const ring = closeRing(lotRing);
  const [minX, minY, maxX, maxY] = turf.bbox(turf.polygon([ring]));
  const wM = turf.distance([minX, minY], [maxX, minY], { units: "meters" });
  const dM = turf.distance([minX, minY], [minX, maxY], { units: "meters" });
  const widthFt = Math.min(wM, dM) / FT_TO_M;
  const depthFt = Math.max(wM, dM) / FT_TO_M;
  return { widthFt, depthFt };
}

function classifyLotEdges(edges, roads, neighborLines) {
  const edgesByRoadDistance = [];

  for (const edge of edges) {
    const pt = turf.point(edge.midpoint);
    let minDistM = Number.POSITIVE_INFINITY;
    let nearestRoad = null;
    for (const road of roads || []) {
      try {
        const nearestOnLine = turf.nearestPointOnLine(road, pt, { units: "meters" });
        const d = nearestOnLine?.properties?.dist ?? turf.pointToLineDistance(pt, road, { units: "meters" });
        if (d < minDistM) {
          minDistM = d;
          nearestRoad = road;
        }
      } catch (_err) {
        // skip malformed road
      }
    }

    edge.minRoadDistM = minDistM;
    edge.streetWidthFt = roadWidthFtFromRoad(nearestRoad);
    edge.streetType = getStreetType(edge.streetWidthFt);
    edge.nearestRoadName = roadName(nearestRoad);

    // Neighbor-touch test for side-lot-likeness
    edge.touchesNeighbor = false;
    if (neighborLines?.length) {
      const ptMid = turf.point(edge.midpoint);
      for (const line of neighborLines) {
        try {
          const d = turf.pointToLineDistance(ptMid, line, { units: "meters" });
          if (d <= 3 * FT_TO_M) {
            edge.touchesNeighbor = true;
            break;
          }
        } catch (_err) {
          // skip malformed line
        }
      }
    }

    edgesByRoadDistance.push(edge);
  }

  edgesByRoadDistance.sort((a, b) => a.minRoadDistM - b.minRoadDistM);

  const frontEdgeIndices = [];
  const primaryFront = edgesByRoadDistance[0] || edges[0] || null;
  if (primaryFront) frontEdgeIndices.push(primaryFront.idx);

  for (const edge of edgesByRoadDistance) {
    if (frontEdgeIndices.includes(edge.idx)) continue;
    const thresholdFt = Math.max(35, (edge.streetWidthFt / 2) + 18);
    if (Number.isFinite(edge.minRoadDistM) && edge.minRoadDistM <= thresholdFt * FT_TO_M) {
      frontEdgeIndices.push(edge.idx);
    }
  }

  const all = edges.map((e) => e.idx);
  let lotType = "Interior";
  if (frontEdgeIndices.length > 1) {
    const sorted = [...frontEdgeIndices].sort((a, b) => a - b);
    const first = sorted[0];
    const second = sorted[1];
    const adjacent = Math.abs(first - second) === 1 || Math.abs(first - second) === edges.length - 1;
    lotType = adjacent ? "Corner" : "Through";
  }

  // Rear edge: farthest from primary front midpoint among non-front edges
  let rearEdgeIndex = null;
  if (lotType !== "Through") {
    const frontEdge = edges.find((e) => e.idx === (primaryFront?.idx ?? frontEdgeIndices[0] ?? 0)) || edges[0];
    let bestDist = -1;
    for (const edge of edges) {
      if (frontEdgeIndices.includes(edge.idx)) continue;
      const d = turf.distance(turf.point(frontEdge.midpoint), turf.point(edge.midpoint), { units: "meters" });
      if (d > bestDist) {
        bestDist = d;
        rearEdgeIndex = edge.idx;
      }
    }
  }

  const sideEdgeIndices = all.filter((idx) => !frontEdgeIndices.includes(idx) && idx !== rearEdgeIndex);
  const frontStreetNames = frontEdgeIndices
    .map((idx) => edges.find((e) => e.idx === idx)?.nearestRoadName)
    .filter(Boolean);
  const frontStreetWidths = frontEdgeIndices
    .map((idx) => edges.find((e) => e.idx === idx)?.streetWidthFt)
    .filter((n) => Number.isFinite(n));
  const primaryStreetWidth = frontStreetWidths.length ? Math.max(...frontStreetWidths) : 50;

  return {
    edges,
    frontEdgeIndices,
    rearEdgeIndex,
    sideEdgeIndices,
    lotType,
    isCornerLot: lotType === "Corner",
    isThroughLot: lotType === "Through",
    frontStreetNames,
    primaryStreetWidthFt: primaryStreetWidth,
  };
}

export function analyzeLot({ lotFeature, lotRing, map, neighborhoodFeatures = [] }) {
  const ring = closeRing(lotRing || lotFeature?.geometry?.coordinates?.[0] || []);
  if (!ring.length) {
    return {
      warnings: ["Missing lot geometry for analysis."],
      lotType: "Unknown",
      streetType: "narrow",
      zoneTokens: [],
    };
  }

  const lotPolygon = turf.polygon([ring]);
  const lotAreaFt2 = turf.area(lotPolygon) * 10.7639;
  const { widthFt, depthFt } = bboxWidthDepthFt(ring);

  let rawRoads = [];
  if (map) {
    try {
      rawRoads = map.querySourceFeatures("composite", { sourceLayer: "road" }) || [];
    } catch (_err) {
      rawRoads = [];
    }
  }
  const roads = toRoadLineFeatures(rawRoads);

  const neighborLines = toLotBoundaryLines((neighborhoodFeatures || []).filter((f) => f !== lotFeature));
  const edges = ringEdges(ring);
  const edgeClass = classifyLotEdges(edges, roads, neighborLines);

  const props = lotFeature?.properties || {};
  const zoneTokens = extractZoneTokens(props.zonedist1, props.ZoneDist1, props.zonedist2, props.ZoneDist2, props.zone, props.ZoningDist);
  const primaryZone = pickPrimaryZoneToken(props.zonedist1, props.ZoneDist1, props.zonedist2, props.ZoneDist2, props.zone, props.ZoningDist);

  const existingBuildingHeightFt = coerceNumber(props.existing_height_ft)
    ?? coerceNumber(props.height)
    ?? coerceNumber(props.render_height)
    ?? coerceNumber(props.NumFloors) * 10
    ?? null;
  const existingBuildingFootprintFt2 = coerceNumber(props.BldgArea ?? props.bldgarea) ?? null;

  const streetType = getStreetType(edgeClass.primaryStreetWidthFt);
  const adjacentStreets = [...new Set(edgeClass.frontStreetNames)];

  const warnings = [];
  if (zoneTokens.length > 1) {
    warnings.push("Mixed zoning lot detected from lot attributes; district split geometry may be simplified.");
  }

  return {
    lotPolygon: { type: "Polygon", coordinates: [ring] },
    lotAreaFt2,
    lotWidthFt: widthFt,
    lotDepthFt: depthFt,
    edges: edgeClass.edges,
    frontEdgeIndices: edgeClass.frontEdgeIndices,
    rearEdgeIndex: edgeClass.rearEdgeIndex,
    sideEdgeIndices: edgeClass.sideEdgeIndices,
    lotType: edgeClass.lotType,
    isCornerLot: edgeClass.isCornerLot,
    isThroughLot: edgeClass.isThroughLot,
    primaryStreet: {
      name: adjacentStreets[0] || "Unknown road",
      widthFt: edgeClass.primaryStreetWidthFt,
      type: streetType,
    },
    adjacentStreets,
    streetType,
    zoneTokens,
    primaryZone,
    existingBuilding: {
      footprintFt2: existingBuildingFootprintFt2,
      heightFt: existingBuildingHeightFt,
    },
    warnings,
  };
}
