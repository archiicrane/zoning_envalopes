/**
 * StreetDetectionAndOrientation.js
 * 
 * Detects street-facing edges and provides orientation information
 * Uses Mapbox road adjacency data and lot geometry analysis
 */

class StreetDetectionAndOrientation {
  constructor(mapboxMap = null) {
    this.map = mapboxMap;
  }

  /**
   * Detect street-facing edge from lot geometry
   * Returns { edgePoints, edgeName, direction, confidence }
   */
  async detectStreetEdge(lotFeature, map = null) {
    if (!lotFeature || !lotFeature.geometry) return null;

    const geometry = lotFeature.geometry;
    const properties = lotFeature.properties || {};

    // Try multiple detection strategies
    let streetEdge = null;

    // Strategy 1: Use address/direction from properties
    if (properties.front_direction) {
      streetEdge = this._getEdgeByDirection(geometry, properties.front_direction);
      if (streetEdge) return { ...streetEdge, strategy: 'property-based', confidence: 0.9 };
    }

    // Strategy 2: Use Mapbox road data if available
    if (map || this.map) {
      streetEdge = await this._detectFromMapboxRoads(geometry, map || this.map);
      if (streetEdge) return { ...streetEdge, strategy: 'mapbox-roads', confidence: 0.85 };
    }

    // Strategy 3: Use lot centroid and nearest feature
    streetEdge = await this._detectFromCentroid(geometry);
    if (streetEdge) return { ...streetEdge, strategy: 'centroid-based', confidence: 0.7 };

    // Fallback: Use first/longest edge
    return this._getFallbackEdge(geometry);
  }

  /**
   * Get orientation markers for the lot
   */
  getOrientationLabels(lotFeature, streetEdge = null) {
    if (!lotFeature || !lotFeature.geometry) return [];

    const coords = this._getRingCoordinates(lotFeature.geometry);
    if (!coords || coords.length < 4) return [];

    const labels = [];

    // Determine which edge is front
    let frontIdx = 0;
    if (streetEdge) {
      // Find which edge matches the street edge
      for (let i = 0; i < coords.length - 1; i++) {
        const edgeStart = coords[i];
        const edgeEnd = coords[i + 1];
        if (this._edgesMatch(edgeStart, edgeEnd, streetEdge.edgePoints)) {
          frontIdx = i;
          break;
        }
      }
    }

    // Calculate orientation points
    const midpoint = Math.floor(coords.length / 2);
    const rearIdx = (frontIdx + midpoint) % (coords.length - 1);

    labels.push({
      type: 'FRONT YARD',
      edgeIndex: frontIdx,
      position: this._getEdgeMidpoint(coords[frontIdx], coords[frontIdx + 1]),
    });

    labels.push({
      type: 'REAR YARD',
      edgeIndex: rearIdx,
      position: this._getEdgeMidpoint(coords[rearIdx], coords[rearIdx + 1]),
    });

    // Side yard labels
    const leftIdx = Math.floor((frontIdx + midpoint / 2) % (coords.length - 1));
    const rightIdx = Math.floor((frontIdx + (midpoint * 1.5)) % (coords.length - 1));

    labels.push({
      type: 'SIDE YARD',
      edgeIndex: leftIdx,
      position: this._getEdgeMidpoint(coords[leftIdx], coords[leftIdx + 1]),
    });

    labels.push({
      type: 'SIDE YARD',
      edgeIndex: rightIdx,
      position: this._getEdgeMidpoint(coords[rightIdx], coords[rightIdx + 1]),
    });

    return labels;
  }

  /**
   * Generate street line graphic (for diagram)
   */
  generateStreetGraphic(streetEdge) {
    if (!streetEdge || !streetEdge.edgePoints) return null;

    const [p1, p2] = streetEdge.edgePoints;
    const dx = p2[0] - p1[0];
    const dy = p2[1] - p1[1];
    const len = Math.hypot(dx, dy);

    return {
      edgePoints: streetEdge.edgePoints,
      edgeName: streetEdge.edgeName || 'Street',
      edgeLength: len,
      direction: { x: dx / len, y: dy / len },
      representation: 'dashed-line-with-hatch',
    };
  }

  /**
   * Add north arrow and scale bar to diagram
   */
  addOrientationGraphics(svgElement, bearing = 0, scale = 1) {
    const svgWidth = parseInt(svgElement.getAttribute('width')) || 2400;
    const svgHeight = parseInt(svgElement.getAttribute('height')) || 1560;

    // North arrow (top-right corner)
    const arrowGroup = this._createNorthArrow(
      svgWidth - 140,
      80,
      bearing
    );
    svgElement.appendChild(arrowGroup);

    // Scale bar (bottom-left corner)
    const scaleGroup = this._createScaleBar(
      140,
      svgHeight - 60,
      scale
    );
    svgElement.appendChild(scaleGroup);
  }

  // ==================== PRIVATE METHODS ====================

  async _detectFromMapboxRoads(geometry, map) {
    if (!map) return null;

    try {
      const coords = this._getRingCoordinates(geometry);
      if (!coords || coords.length < 3) return null;

      const centroid = this._calculateCentroid(coords);

      // Query Mapbox for nearby roads
      const features = map.querySourceFeatures('composite', {
        sourceLayer: 'road',
        filter: ['!=', 'class', 'transit'],
      });

      if (!features.length) return null;

      // Find closest road to lot
      let closestRoad = null;
      let minDist = Infinity;

      for (const road of features) {
        const roadCoords = road.geometry?.coordinates || [];
        for (const coord of roadCoords) {
          const dist = this._pointDistance(centroid, coord);
          if (dist < minDist) {
            minDist = dist;
            closestRoad = { coord, road };
          }
        }
      }

      if (closestRoad && minDist < 0.001) {
        // Find edge of lot closest to road
        let closestEdge = null;
        let minEdgeDist = Infinity;

        for (let i = 0; i < coords.length - 1; i++) {
          const edgeDist = this._pointToLineDistance(
            closestRoad.coord,
            coords[i],
            coords[i + 1]
          );

          if (edgeDist < minEdgeDist) {
            minEdgeDist = edgeDist;
            closestEdge = [coords[i], coords[i + 1]];
          }
        }

        if (closestEdge) {
          return {
            edgePoints: closestEdge,
            edgeName: closestRoad.road.properties?.name || 'Street',
            confidence: 1 - Math.min(minEdgeDist / 0.0005, 1),
          };
        }
      }

      return null;
    } catch (err) {
      console.warn('Mapbox road detection failed:', err);
      return null;
    }
  }

  async _detectFromCentroid(geometry) {
    const coords = this._getRingCoordinates(geometry);
    if (!coords || coords.length < 3) return null;

    const centroid = this._calculateCentroid(coords);

    // Find edge farthest from centroid (most likely front)
    let maxDist = 0;
    let frontEdge = null;

    for (let i = 0; i < coords.length - 1; i++) {
      const midpoint = this._getEdgeMidpoint(coords[i], coords[i + 1]);
      const dist = this._pointDistance(centroid, midpoint);

      if (dist > maxDist) {
        maxDist = dist;
        frontEdge = [coords[i], coords[i + 1]];
      }
    }

    return frontEdge ? {
      edgePoints: frontEdge,
      edgeName: 'Front Edge',
      confidence: 0.6,
    } : null;
  }

  _getEdgeByDirection(geometry, direction) {
    const coords = this._getRingCoordinates(geometry);
    if (!coords || coords.length < 2) return null;

    const dirNorm = direction.toLowerCase().trim();
    const indices = {
      'n': 0,
      'north': 0,
      's': Math.floor(coords.length / 2),
      'south': Math.floor(coords.length / 2),
      'e': Math.floor(coords.length * 0.25),
      'east': Math.floor(coords.length * 0.25),
      'w': Math.floor(coords.length * 0.75),
      'west': Math.floor(coords.length * 0.75),
    };

    const idx = indices[dirNorm] || 0;
    const nextIdx = (idx + 1) % (coords.length - 1);

    return {
      edgePoints: [coords[idx], coords[nextIdx]],
      edgeName: `${direction.toUpperCase()} Edge`,
      confidence: 0.8,
    };
  }

  _getFallbackEdge(geometry) {
    const coords = this._getRingCoordinates(geometry);
    if (!coords || coords.length < 2) return null;

    // Use first edge as fallback
    return {
      edgePoints: [coords[0], coords[1]],
      edgeName: 'Primary Edge',
      confidence: 0.5,
    };
  }

  _getRingCoordinates(geometry) {
    if (!geometry) return null;

    if (geometry.type === 'Polygon' && geometry.coordinates?.[0]) {
      return geometry.coordinates[0];
    }
    if (geometry.type === 'LineString' && geometry.coordinates) {
      return geometry.coordinates;
    }
    if (Array.isArray(geometry)) {
      return geometry;
    }

    return null;
  }

  _calculateCentroid(coords) {
    let sumX = 0, sumY = 0;
    for (const [x, y] of coords) {
      sumX += x;
      sumY += y;
    }
    return [sumX / coords.length, sumY / coords.length];
  }

  _getEdgeMidpoint(p1, p2) {
    return [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
  }

  _pointDistance(p1, p2) {
    const dx = p2[0] - p1[0];
    const dy = p2[1] - p1[1];
    return Math.hypot(dx, dy);
  }

  _pointToLineDistance(point, lineStart, lineEnd) {
    const [px, py] = point;
    const [x1, y1] = lineStart;
    const [x2, y2] = lineEnd;

    const A = px - x1;
    const B = py - y1;
    const C = x2 - x1;
    const D = y2 - y1;

    const dot = A * C + B * D;
    const lenSq = C * C + D * D;
    let param = -1;
    if (lenSq !== 0) param = dot / lenSq;

    let xx, yy;
    if (param < 0) {
      xx = x1;
      yy = y1;
    } else if (param > 1) {
      xx = x2;
      yy = y2;
    } else {
      xx = x1 + param * C;
      yy = y1 + param * D;
    }

    const dx = px - xx;
    const dy = py - yy;
    return Math.hypot(dx, dy);
  }

  _edgesMatch(e1Start, e1End, e2) {
    const eps = 0.00001;
    return (
      (Math.abs(e1Start[0] - e2[0][0]) < eps && Math.abs(e1Start[1] - e2[0][1]) < eps &&
       Math.abs(e1End[0] - e2[1][0]) < eps && Math.abs(e1End[1] - e2[1][1]) < eps) ||
      (Math.abs(e1Start[0] - e2[1][0]) < eps && Math.abs(e1Start[1] - e2[1][1]) < eps &&
       Math.abs(e1End[0] - e2[0][0]) < eps && Math.abs(e1End[1] - e2[0][1]) < eps)
    );
  }

  _createNorthArrow(x, y, bearing = 0) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('transform', `translate(${x},${y}) rotate(${bearing})`);

    // Arrow shaft
    const shaft = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    shaft.setAttribute('x1', '0');
    shaft.setAttribute('y1', '0');
    shaft.setAttribute('x2', '0');
    shaft.setAttribute('y2', '30');
    shaft.setAttribute('stroke', '#4b5563');
    shaft.setAttribute('stroke-width', '1.5');
    g.appendChild(shaft);

    // Arrow head
    const head = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    head.setAttribute('points', '0,32 -3,26 3,26');
    head.setAttribute('fill', '#4b5563');
    g.appendChild(head);

    // Label
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', '0');
    label.setAttribute('y', '46');
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('font-size', '10px');
    label.setAttribute('font-family', "'Segoe UI', sans-serif");
    label.setAttribute('fill', '#4b5563');
    label.textContent = 'N';
    g.appendChild(label);

    return g;
  }

  _createScaleBar(x, y, scale = 1) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('transform', `translate(${x},${y})`);

    // Scale reference: 100 feet at screen resolution
    const scaleLen = 80; // pixels
    const featureDistance = 100; // feet
    const actualLen = (scaleLen / scale) * (featureDistance / 328.084); // Convert to feet scale

    // Line
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', '0');
    line.setAttribute('y1', '0');
    line.setAttribute('x2', scaleLen);
    line.setAttribute('y2', '0');
    line.setAttribute('stroke', '#4b5563');
    line.setAttribute('stroke-width', '1.5');
    g.appendChild(line);

    // Ticks
    for (const x of [0, scaleLen / 2, scaleLen]) {
      const tick = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      tick.setAttribute('x1', x);
      tick.setAttribute('y1', '-4');
      tick.setAttribute('x2', x);
      tick.setAttribute('y2', '4');
      tick.setAttribute('stroke', '#4b5563');
      tick.setAttribute('stroke-width', '1');
      g.appendChild(tick);
    }

    // Label
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', scaleLen / 2);
    label.setAttribute('y', '16');
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('font-size', '10px');
    label.setAttribute('font-family', "'Segoe UI', sans-serif");
    label.setAttribute('fill', '#4b5563');
    label.textContent = `${Math.round(featureDistance)} ft`;
    g.appendChild(label);

    return g;
  }
}

export { StreetDetectionAndOrientation };
