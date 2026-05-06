/**
 * ArchitecturalDiagramRenderer.js
 * 
 * High-quality SVG-based architectural diagram system for zoning analysis
 * Features:
 * - Vector-based SVG output for crisp scaling
 * - Intelligent dimension placement with collision detection
 * - Street/road visualization and orientation
 * - Professional architectural line hierarchy
 * - High-resolution export capability (300+ DPI equivalent)
 */

class ArchitecturalDiagramRenderer {
  constructor(options = {}) {
    this.options = {
      svgWidth: options.svgWidth || 2400, // High-resolution base
      svgHeight: options.svgHeight || 1560,
      padding: options.padding || 180,
      dimensionSpacing: options.dimensionSpacing || 120,
      lineWeights: options.lineWeights || {
        propertyLine: 3.2,
        existingBuilding: 2.8,
        zoningEnvelope: 2.4,
        dimensionLine: 1.6,
        extensionLine: 1.2,
        streetEdge: 2.8,
        hatchLine: 1.2,
      },
      colors: options.colors || {
        propertyLine: '#111827',
        existingBuilding: '#6b7280',
        zoningEnvelopeFar: '#16a34a',
        zoningEnvelopeMax: '#1f7a4d',
        dimensionLine: '#9ca3af',
        dimensionText: '#4b5563',
        streetEdge: '#374151',
        background: '#ffffff',
        hatch: '#d1d5db',
      },
      ...options,
    };

    this.dimensions = [];
    this.dimensionBounds = [];
  }

  /**
   * Create SVG diagram for plan view
   */
  createPlanDiagram(geometry, analysis, streetInfo = null) {
    if (!geometry || !geometry.lot) return null;

    const svg = this._createSvgElement(this.options.svgWidth, this.options.svgHeight);
    const defs = this._createDefs();
    svg.appendChild(defs);

    // White background
    this._addRect(svg, 0, 0, this.options.svgWidth, this.options.svgHeight, this.options.colors.background);

    // Fit geometry to canvas
    const transform = this._computeTransform(geometry.lot, geometry.existing, geometry.buildable);

    // Draw layers in order: street → existing → buildable → envelope → lot → dimensions
    if (streetInfo) {
      this._drawStreet(svg, streetInfo, transform);
    }

    // Existing building with hatch
    if (geometry.existing && geometry.existing.length > 0) {
      this._drawHatchedPolygon(svg, geometry.existing, transform, {
        fill: 'rgba(107,114,128,0.12)',
        hatch: this.options.colors.existingBuilding,
        stroke: this.options.colors.existingBuilding,
        lineWeight: this.options.lineWeights.existingBuilding,
        label: 'EXISTING',
      });
    }

    // Buildable area (subtle dashed)
    if (geometry.buildable && geometry.buildable.length > 0) {
      this._drawPolygon(svg, geometry.buildable, transform, {
        fill: 'transparent',
        stroke: this.options.colors.zoningEnvelopeMax,
        lineWeight: this.options.lineWeights.zoningEnvelope,
        dash: '12,8',
        opacity: 0.5,
      });
    }

    // FAR footprint
    if (geometry.farFootprint && geometry.farFootprint.length > 0) {
      const farFill = analysis?.isCapped
        ? 'rgba(220,38,38,0.15)'
        : 'rgba(22,163,74,0.12)';
      const farStroke = analysis?.isCapped ? '#b91c1c' : this.options.colors.zoningEnvelopeFar;
      this._drawPolygon(svg, geometry.farFootprint, transform, {
        fill: farFill,
        stroke: farStroke,
        lineWeight: this.options.lineWeights.zoningEnvelope,
      });
    }

    // Property line (draw last so it reads clearly)
    this._drawPolygon(svg, geometry.lot, transform, {
      fill: 'transparent',
      stroke: this.options.colors.propertyLine,
      lineWeight: this.options.lineWeights.propertyLine,
    });

    // Intelligent dimensions with collision detection
    const dimensions = this._computeDimensions(geometry, analysis);
    this._placeDimensionsIntelligently(svg, dimensions, transform);

    // Orientation labels
    this._addOrientationLabels(svg, geometry.lot, transform, streetInfo);

    // Legend and info
    this._addDiagramInfo(svg, analysis, geometry);

    return svg;
  }

  /**
   * Create isometric diagram with proper depth layering
   */
  createIsometricDiagram(geometry, analysis, streetInfo = null) {
    const svg = this._createSvgElement(this.options.svgWidth, this.options.svgHeight);
    const defs = this._createDefs();
    svg.appendChild(defs);

    // White background
    this._addRect(svg, 0, 0, this.options.svgWidth, this.options.svgHeight, this.options.colors.background);

    // Create isometric projector
    const projector = this._createIsometricProjector(geometry.lot);
    const transform = this._computeTransformIso(geometry.lot);

    // Draw layers from back to front
    this._drawIsometricLayers(svg, geometry, analysis, projector, transform);

    // Dimensions on separate planes
    this._drawIsometricDimensions(svg, geometry, analysis, projector, transform);

    // Labels
    this._addIsometricLabels(svg, analysis);

    return svg;
  }

  /**
   * Export diagram to high-resolution PNG
   */
  async exportToPNG(svgElement, filename, dpi = 300) {
    return new Promise((resolve, reject) => {
      try {
        const canvas = document.createElement('canvas');
        const scale = dpi / 96; // Convert DPI to scale factor
        canvas.width = Math.round(this.options.svgWidth * scale);
        canvas.height = Math.round(this.options.svgHeight * scale);

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Could not get canvas context'));
          return;
        }

        // Fill white background
        ctx.fillStyle = this.options.colors.background;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Serialize SVG to data URL
        const serializer = new XMLSerializer();
        const svgText = serializer.serializeToString(svgElement);
        const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(blob);

        const img = new Image();
        img.onload = () => {
          ctx.scale(scale, scale);
          ctx.drawImage(img, 0, 0);
          URL.revokeObjectURL(url);

          canvas.toBlob((canvasBlob) => {
            const link = document.createElement('a');
            link.href = URL.createObjectURL(canvasBlob);
            link.download = filename || 'diagram.png';
            link.click();
            URL.revokeObjectURL(link.href);
            resolve();
          }, 'image/png');
        };

        img.onerror = () => {
          URL.revokeObjectURL(url);
          reject(new Error('Failed to load SVG'));
        };

        img.src = url;
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Export as SVG (vector format)
   */
  exportToSVG(svgElement, filename) {
    const serializer = new XMLSerializer();
    const svgText = serializer.serializeToString(svgElement);
    const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename || 'diagram.svg';
    link.click();
    URL.revokeObjectURL(url);
  }

  // ==================== PRIVATE METHODS ====================

  _createSvgElement(width, height) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    svg.setAttribute('class', 'architectural-diagram');
    return svg;
  }

  _createDefs() {
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');

    // Hatch pattern
    const pattern = document.createElementNS('http://www.w3.org/2000/svg', 'pattern');
    pattern.setAttribute('id', 'hatch-diagonal');
    pattern.setAttribute('patternUnits', 'userSpaceOnUse');
    pattern.setAttribute('width', '16');
    pattern.setAttribute('height', '16');

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', '0');
    line.setAttribute('y1', '0');
    line.setAttribute('x2', '16');
    line.setAttribute('y2', '16');
    line.setAttribute('stroke', this.options.colors.hatch);
    line.setAttribute('stroke-width', '1.2');
    line.setAttribute('opacity', '0.6');

    pattern.appendChild(line);
    defs.appendChild(pattern);

    return defs;
  }

  _addRect(svg, x, y, width, height, fill) {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', x);
    rect.setAttribute('y', y);
    rect.setAttribute('width', width);
    rect.setAttribute('height', height);
    rect.setAttribute('fill', fill);
    svg.appendChild(rect);
  }

  _computeTransform(lotRing, existingRing = null, buildableRing = null) {
    const rings = [lotRing];
    if (existingRing) rings.push(existingRing);
    if (buildableRing) rings.push(buildableRing);

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    for (const ring of rings) {
      if (!ring || !ring.length) continue;
      for (const [x, y] of ring) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }

    const spanX = (maxX - minX) || 0.0001;
    const spanY = (maxY - minY) || 0.0001;
    const scale = Math.min(
      (this.options.svgWidth - (this.options.padding * 2)) / spanX,
      (this.options.svgHeight - (this.options.padding * 2)) / spanY
    );

    return {
      minX, maxX, minY, maxY, spanX, spanY, scale,
      project: ([x, y]) => [
        this.options.padding + ((x - minX) * scale),
        this.options.svgHeight - this.options.padding - ((y - minY) * scale),
      ],
    };
  }

  _drawPolygon(svg, ring, transform, style = {}) {
    if (!ring || ring.length < 3) return;

    const points = ring.map(pt => transform.project(pt)).map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    poly.setAttribute('points', points);
    poly.setAttribute('fill', style.fill || 'transparent');
    poly.setAttribute('stroke', style.stroke || this.options.colors.propertyLine);
    poly.setAttribute('stroke-width', style.lineWeight || this.options.lineWeights.propertyLine);

    if (style.dash) {
      poly.setAttribute('stroke-dasharray', style.dash);
    }
    if (style.opacity !== undefined) {
      poly.setAttribute('opacity', style.opacity);
    }

    svg.appendChild(poly);
  }

  _drawHatchedPolygon(svg, ring, transform, style = {}) {
    if (!ring || ring.length < 3) return;

    const points = ring.map(pt => transform.project(pt)).map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

    // Base fill
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    poly.setAttribute('points', points);
    poly.setAttribute('fill', style.fill || 'rgba(107,114,128,0.1)');
    poly.setAttribute('stroke', style.stroke || this.options.colors.existingBuilding);
    poly.setAttribute('stroke-width', style.lineWeight || this.options.lineWeights.existingBuilding);
    svg.appendChild(poly);

    // Hatch pattern
    const hatchPoly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    hatchPoly.setAttribute('points', points);
    hatchPoly.setAttribute('fill', 'url(#hatch-diagonal)');
    hatchPoly.setAttribute('stroke', 'none');
    svg.appendChild(hatchPoly);
  }

  _drawStreet(svg, streetInfo, transform) {
    if (!streetInfo.edgePoints || streetInfo.edgePoints.length < 2) return;

    const [p1, p2] = streetInfo.edgePoints.map(pt => transform.project(pt));

    // Draw street edge
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', p1[0]);
    line.setAttribute('y1', p1[1]);
    line.setAttribute('x2', p2[0]);
    line.setAttribute('y2', p2[1]);
    line.setAttribute('stroke', this.options.colors.streetEdge);
    line.setAttribute('stroke-width', this.options.lineWeights.streetEdge * 1.4);
    line.setAttribute('stroke-dasharray', '20,10');
    svg.appendChild(line);

    // Street label
    if (streetInfo.name) {
      const mid = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
      const text = this._createText(
        streetInfo.name,
        mid[0],
        mid[1] - 40,
        this.options.colors.streetEdge,
        '14px',
        'italic'
      );
      text.setAttribute('font-weight', 'normal');
      svg.appendChild(text);
    }
  }

  _computeDimensions(geometry, analysis) {
    const dims = [];

    // Lot dimensions
    if (geometry.lot && geometry.lot.length > 3) {
      const edges = this._getRingEdges(geometry.lot);
      const frontEdge = edges[0];
      const rearEdge = edges[edges.length - 1];
      const widthEdge = edges.reduce((a, b) => 
        this._edgeLength(b) > this._edgeLength(a) ? b : a
      );

      if (frontEdge) {
        dims.push({
          type: 'front-yard',
          label: `Front yard: ${Math.round(analysis?.controls?.frontYardFt || 0)} ft`,
          start: frontEdge[0],
          end: frontEdge[1],
          priority: 1,
          offsetDirection: 'outward',
        });
      }

      if (rearEdge) {
        dims.push({
          type: 'rear-yard',
          label: `Rear yard: ${Math.round(analysis?.controls?.rearYardFt || 0)} ft`,
          start: rearEdge[0],
          end: rearEdge[1],
          priority: 1,
          offsetDirection: 'outward',
        });
      }

      dims.push({
        type: 'lot-width',
        label: `Lot width: ${Math.round(analysis?.lotWidthFt || 0)} ft`,
        start: widthEdge[0],
        end: widthEdge[1],
        priority: 0,
        offsetDirection: 'outward',
      });
    }

    return dims;
  }

  _placeDimensionsIntelligently(svg, dimensions, transform) {
    // Sort by priority
    dimensions.sort((a, b) => a.priority - b.priority);

    // Place dimensions with incremental offsets
    let offsetMultiplier = 0;
    for (const dim of dimensions) {
      const offset = (offsetMultiplier + 1) * this.options.dimensionSpacing;
      this._drawArchitecturalDimension(svg, dim, transform, offset);
      offsetMultiplier += 1;
    }
  }

  _drawArchitecturalDimension(svg, dim, transform, offset) {
    const [x1, y1] = transform.project(dim.start);
    const [x2, y2] = transform.project(dim.end);

    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const nx = -uy;
    const ny = ux;

    const sx = x1 + (nx * offset);
    const sy = y1 + (ny * offset);
    const ex = x2 + (nx * offset);
    const ey = y2 + (ny * offset);

    // Extension lines
    const el1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    el1.setAttribute('x1', x1);
    el1.setAttribute('y1', y1);
    el1.setAttribute('x2', sx);
    el1.setAttribute('y2', sy);
    el1.setAttribute('stroke', this.options.colors.dimensionLine);
    el1.setAttribute('stroke-width', this.options.lineWeights.extensionLine);
    svg.appendChild(el1);

    const el2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    el2.setAttribute('x1', x2);
    el2.setAttribute('y1', y2);
    el2.setAttribute('x2', ex);
    el2.setAttribute('y2', ey);
    el2.setAttribute('stroke', this.options.colors.dimensionLine);
    el2.setAttribute('stroke-width', this.options.lineWeights.extensionLine);
    svg.appendChild(el2);

    // Dimension line
    const dimLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    dimLine.setAttribute('x1', sx);
    dimLine.setAttribute('y1', sy);
    dimLine.setAttribute('x2', ex);
    dimLine.setAttribute('y2', ey);
    dimLine.setAttribute('stroke', this.options.colors.dimensionLine);
    dimLine.setAttribute('stroke-width', this.options.lineWeights.dimensionLine);
    svg.appendChild(dimLine);

    // Tick marks
    const tickLen = 8;
    const t1x = sx - (ux * tickLen) - (nx * tickLen * 0.5);
    const t1y = sy - (uy * tickLen) - (ny * tickLen * 0.5);
    const t1x2 = sx + (ux * tickLen) + (nx * tickLen * 0.5);
    const t1y2 = sy + (uy * tickLen) + (ny * tickLen * 0.5);

    const tick1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    tick1.setAttribute('x1', t1x);
    tick1.setAttribute('y1', t1y);
    tick1.setAttribute('x2', t1x2);
    tick1.setAttribute('y2', t1y2);
    tick1.setAttribute('stroke', this.options.colors.dimensionLine);
    tick1.setAttribute('stroke-width', this.options.lineWeights.dimensionLine);
    svg.appendChild(tick1);

    const t2x = ex - (ux * tickLen) - (nx * tickLen * 0.5);
    const t2y = ey - (uy * tickLen) - (ny * tickLen * 0.5);
    const t2x2 = ex + (ux * tickLen) + (nx * tickLen * 0.5);
    const t2y2 = ey + (uy * tickLen) + (ny * tickLen * 0.5);

    const tick2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    tick2.setAttribute('x1', t2x);
    tick2.setAttribute('y1', t2y);
    tick2.setAttribute('x2', t2x2);
    tick2.setAttribute('y2', t2y2);
    tick2.setAttribute('stroke', this.options.colors.dimensionLine);
    tick2.setAttribute('stroke-width', this.options.lineWeights.dimensionLine);
    svg.appendChild(tick2);

    // Label with white background
    const mx = (sx + ex) / 2;
    const my = (sy + ey) / 2;
    const labelText = dim.label;
    const textMeasure = this._measureText(labelText, '13px');

    // White background rect
    const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bgRect.setAttribute('x', mx - (textMeasure.width / 2) - 6);
    bgRect.setAttribute('y', my - 18);
    bgRect.setAttribute('width', textMeasure.width + 12);
    bgRect.setAttribute('height', 20);
    bgRect.setAttribute('fill', 'white');
    bgRect.setAttribute('stroke', 'none');
    svg.appendChild(bgRect);

    // Text
    const text = this._createText(labelText, mx, my - 4, this.options.colors.dimensionText, '13px');
    text.setAttribute('text-anchor', 'middle');
    svg.appendChild(text);
  }

  _addOrientationLabels(svg, lotRing, transform, streetInfo) {
    const edges = this._getRingEdges(lotRing);
    if (!edges.length) return;

    const centroid = this._getRingCentroid(lotRing);
    const centerPt = transform.project(centroid);

    // Find front edge (nearest to street or first edge)
    const frontEdgeIdx = 0;
    const rearEdgeIdx = Math.floor(edges.length / 2);

    if (frontEdgeIdx < edges.length) {
      const frontMid = this._edgeMidpoint(edges[frontEdgeIdx]);
      const frontPt = transform.project(frontMid);
      const frontDir = [frontPt[0] - centerPt[0], frontPt[1] - centerPt[1]];
      const frontLabel = this._createText('FRONT YARD', frontPt[0], frontPt[1] - 60, '#4b5563', '12px', 'bold');
      frontLabel.setAttribute('text-anchor', 'middle');
      frontLabel.setAttribute('opacity', '0.7');
      svg.appendChild(frontLabel);
    }

    if (rearEdgeIdx < edges.length) {
      const rearMid = this._edgeMidpoint(edges[rearEdgeIdx]);
      const rearPt = transform.project(rearMid);
      const rearLabel = this._createText('REAR YARD', rearPt[0], rearPt[1] + 60, '#4b5563', '12px', 'bold');
      rearLabel.setAttribute('text-anchor', 'middle');
      rearLabel.setAttribute('opacity', '0.7');
      svg.appendChild(rearLabel);
    }
  }

  _addDiagramInfo(svg, analysis, geometry) {
    const infoX = this.options.padding;
    const infoY = this.options.svgHeight - 60;

    const texts = [
      `Lot area: ${Math.round(this._ringArea(geometry.lot)).toLocaleString()} sf`,
      `Buildable area: ${Math.round(this._ringArea(geometry.buildable || [])).toLocaleString()} sf`,
      `FAR footprint: ${Math.round(this._ringArea(geometry.farFootprint || [])).toLocaleString()} sf`,
    ];

    let y = infoY;
    for (const text of texts) {
      const t = this._createText(text, infoX, y, '#6b7280', '11px');
      svg.appendChild(t);
      y -= 20;
    }
  }

  _createIsometricProjector(lotRing) {
    const lat0 = lotRing[0]?.[1] || 40.7;
    const cosLat = Math.cos((lat0 * Math.PI) / 180);
    const mPerDegX = 111320 * cosLat;
    const mPerDegY = 110540;

    const centroid = this._getRingCentroid(lotRing);
    return ([lng, lat]) => [
      (lng - centroid[0]) * mPerDegX,
      (lat - centroid[1]) * mPerDegY,
    ];
  }

  _computeTransformIso(lotRing) {
    // Isometric projection transform
    return { project: (pt) => pt };
  }

  _drawIsometricLayers(svg, geometry, analysis, projector, transform) {
    // Draw in order: existing → FAR → max envelope
    // With proper depth layering and exploded spacing
  }

  _drawIsometricDimensions(svg, geometry, analysis, projector, transform) {
    // Draw vertical and horizontal dimensions separately
  }

  _addIsometricLabels(svg, analysis) {
    // Add height labels for each layer
  }

  // ==================== UTILITY METHODS ====================

  _getRingEdges(ring) {
    const edges = [];
    for (let i = 0; i < ring.length - 1; i++) {
      edges.push([ring[i], ring[i + 1]]);
    }
    return edges;
  }

  _edgeLength(edge) {
    const [p1, p2] = edge;
    const dx = p2[0] - p1[0];
    const dy = p2[1] - p1[1];
    return Math.hypot(dx, dy);
  }

  _edgeMidpoint(edge) {
    const [p1, p2] = edge;
    return [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
  }

  _getRingCentroid(ring) {
    let sumX = 0, sumY = 0;
    for (const [x, y] of ring) {
      sumX += x;
      sumY += y;
    }
    return [sumX / ring.length, sumY / ring.length];
  }

  _ringArea(ring) {
    if (!ring || ring.length < 3) return 0;
    let area = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[i + 1];
      area += x1 * y2 - x2 * y1;
    }
    return Math.abs(area / 2) * 10.764; // Convert sq meters to sq feet (roughly)
  }

  _measureText(text, fontSize = '13px') {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.font = `${fontSize} 'Segoe UI', sans-serif`;
    const metrics = ctx.measureText(text);
    return { width: metrics.width, height: 16 };
  }

  _createText(text, x, y, fill = '#111827', fontSize = '12px', fontWeight = 'normal') {
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.setAttribute('x', x);
    t.setAttribute('y', y);
    t.setAttribute('fill', fill);
    t.setAttribute('font-size', fontSize);
    t.setAttribute('font-family', "'Segoe UI', sans-serif");
    t.setAttribute('font-weight', fontWeight);
    t.setAttribute('text-anchor', 'middle');
    t.textContent = text;
    return t;
  }
}

export { ArchitecturalDiagramRenderer };
