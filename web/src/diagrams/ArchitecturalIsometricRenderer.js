/**
 * ArchitecturalIsometricRenderer.js
 * 
 * Enhanced isometric 3D diagram rendering with:
 * - Proper depth layering (existing, FAR, max envelope)
 * - Exploded spacing for clarity
 * - Architectural line hierarchy
 * - High-quality SVG output (can also use Three.js for WebGL)
 */

class ArchitecturalIsometricRenderer {
  constructor(options = {}) {
    this.options = {
      svgWidth: options.svgWidth || 2400,
      svgHeight: options.svgHeight || 1560,
      isometricAngle: options.isometricAngle || 30, // degrees
      explodedSpacing: options.explodedSpacing || 150, // pixels between layers
      lineWeights: options.lineWeights || {
        existing: 2.4,
        far: 2.8,
        maxEnvelope: 2.0,
        edge: 1.6,
        dimensionLine: 1.2,
      },
      colors: options.colors || {
        existingBuilding: '#6b7280',
        existingEdge: '#4b5563',
        farMassing: '#16a34a',
        farEdge: '#166534',
        maxEnvelope: '#60a5fa',
        maxEnvelopeEdge: '#1d4ed8',
        background: '#ffffff',
        dimensionLine: '#9ca3af',
        dimensionText: '#4b5563',
        hidden: '#d1d5db',
      },
      ...options,
    };
  }

  /**
   * Create isometric diagram as SVG
   */
  createIsometricDiagram(geometry, analysis, streetInfo = null) {
    if (!geometry || !geometry.lot) return null;

    const svg = this._createSvgElement(this.options.svgWidth, this.options.svgHeight);

    // White background
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('width', this.options.svgWidth);
    bg.setAttribute('height', this.options.svgHeight);
    bg.setAttribute('fill', this.options.colors.background);
    svg.appendChild(bg);

    // Create isometric projector
    const projector = this._createIsometricProjector(geometry.lot);

    // Calculate center point for explosion
    const center = this._calculateLotCenter(geometry.lot);
    const centerProj = projector({ lng: center[0], lat: center[1], z: 0 });

    // Draw layers with exploded spacing: existing → FAR → max envelope
    const layers = [
      {
        name: 'existing',
        geometry: geometry.existing,
        height: geometry.existingHeight || 30,
        color: this.options.colors.existingBuilding,
        edgeColor: this.options.colors.existingEdge,
        opacity: 0.95,
        spacing: 0,
      },
      {
        name: 'far',
        geometry: geometry.farFootprint,
        height: geometry.farHeight || 80,
        color: this.options.colors.farMassing,
        edgeColor: this.options.colors.farEdge,
        opacity: 0.7,
        spacing: this.options.explodedSpacing,
      },
      {
        name: 'max',
        geometry: geometry.buildable,
        height: geometry.maxHeight || 0,
        color: this.options.colors.maxEnvelope,
        edgeColor: this.options.colors.maxEnvelopeEdge,
        opacity: 0.4,
        spacing: this.options.explodedSpacing * 2,
      },
    ];

    for (const layer of layers) {
      if (layer.geometry && layer.geometry.length > 0) {
        this._drawIsometricMass(svg, layer, projector, centerProj);
      }
    }

    // Draw vertical dimension lines
    this._drawIsometricDimensions(svg, geometry, analysis, projector);

    // Add labels
    this._addIsometricLabels(svg, geometry, analysis);

    // Add legend
    this._addIsometricLegend(svg, geometry, analysis);

    return svg;
  }

  /**
   * Draw a single isometric mass with proper depth and styling
   */
  _drawIsometricMass(svg, layer, projector, centerProj) {
    const { geometry, height, color, edgeColor, opacity, spacing, name } = layer;

    if (!geometry || geometry.length < 3) return;

    // Explode away from center
    const offsetVec = this._calculateExplosionOffset(centerProj, spacing);

    // Draw base polygon (footprint on ground)
    const basePoints = geometry.map(pt => {
      const projected = projector({ lng: pt[0], lat: pt[1], z: 0 });
      return [projected.x + offsetVec.x, projected.y + offsetVec.y];
    });

    // Draw top polygon (at height)
    const topPoints = geometry.map(pt => {
      const projected = projector({ lng: pt[0], lat: pt[1], z: height });
      return [projected.x + offsetVec.x, projected.y + offsetVec.y];
    });

    // Draw base (ground plane)
    this._drawIsometricPolygon(svg, basePoints, {
      fill: this._shadeColor(color, 0.8),
      stroke: edgeColor,
      opacity: opacity * 0.5,
      lineWeight: this.options.lineWeights[name] || 2.0,
    });

    // Draw top face
    this._drawIsometricPolygon(svg, topPoints, {
      fill: color,
      stroke: edgeColor,
      opacity: opacity,
      lineWeight: this.options.lineWeights[name] || 2.0,
    });

    // Draw vertical edges (ribs)
    for (let i = 0; i < basePoints.length - 1; i++) {
      this._drawIsometricEdge(svg, basePoints[i], topPoints[i], {
        stroke: edgeColor,
        opacity: opacity,
        lineWeight: this.options.lineWeights.edge,
        hidden: i % 2 === 0, // Alternate hidden/visible for depth effect
      });
    }

    // Draw hatch or pattern on top for texture
    if (name === 'existing') {
      this._addHatchToIsometricPolygon(svg, topPoints, {
        hatchColor: this.options.colors.hidden,
        opacity: 0.3,
        angle: 45,
      });
    }
  }

  /**
   * Draw vertical dimension lines
   */
  _drawIsometricDimensions(svg, geometry, analysis, projector) {
    const dimens = [];

    // Existing height
    if (geometry.existingHeight) {
      dimens.push({
        label: `Existing: ${Math.round(geometry.existingHeight)} ft`,
        height: geometry.existingHeight,
        color: this.options.colors.existingEdge,
        z: 0,
      });
    }

    // FAR height
    if (geometry.farHeight) {
      dimens.push({
        label: `FAR massing: ${Math.round(geometry.farHeight)} ft`,
        height: geometry.farHeight,
        color: this.options.colors.farEdge,
        z: 1,
      });
    }

    // Max height
    if (geometry.maxHeight) {
      dimens.push({
        label: `Max envelope: ${Math.round(geometry.maxHeight)} ft`,
        height: geometry.maxHeight,
        color: this.options.colors.maxEnvelopeEdge,
        z: 2,
      });
    }

    // Draw dimension lines on the right side
    const dimX = this.options.svgWidth - 280;
    const dimBaseY = this.options.svgHeight - 200;

    for (let i = 0; i < dimens.length; i++) {
      const dim = dimens[i];
      const ySpacing = i * 160;

      this._drawVerticalDimensionLine(svg, dimX, dimBaseY + ySpacing, dim, projector);
    }
  }

  _drawVerticalDimensionLine(svg, x, y, dimension, projector) {
    const { label, height, color } = dimension;

    // Base point
    const baseLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    baseLine.setAttribute('x1', x - 20);
    baseLine.setAttribute('y1', y);
    baseLine.setAttribute('x2', x + 20);
    baseLine.setAttribute('y2', y);
    baseLine.setAttribute('stroke', color);
    baseLine.setAttribute('stroke-width', this.options.lineWeights.dimensionLine);
    svg.appendChild(baseLine);

    // Vertical dimension line
    const heightScale = 1.2; // Exaggerate height for visibility
    const topY = y - (height * heightScale);

    const dimLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    dimLine.setAttribute('x1', x);
    dimLine.setAttribute('y1', y);
    dimLine.setAttribute('x2', x);
    dimLine.setAttribute('y2', topY);
    dimLine.setAttribute('stroke', color);
    dimLine.setAttribute('stroke-width', this.options.lineWeights.dimensionLine);
    svg.appendChild(dimLine);

    // Top tick
    const topTick = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    topTick.setAttribute('x1', x - 20);
    topTick.setAttribute('y1', topY);
    topTick.setAttribute('x2', x + 20);
    topTick.setAttribute('y2', topY);
    topTick.setAttribute('stroke', color);
    topTick.setAttribute('stroke-width', this.options.lineWeights.dimensionLine);
    svg.appendChild(topTick);

    // Label
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', x + 40);
    text.setAttribute('y', (y + topY) / 2);
    text.setAttribute('fill', this.options.colors.dimensionText);
    text.setAttribute('font-size', '13px');
    text.setAttribute('font-family', "'Segoe UI', sans-serif");
    text.setAttribute('font-weight', 'bold');
    text.textContent = label;
    svg.appendChild(text);
  }

  /**
   * Add labels to diagram
   */
  _addIsometricLabels(svg, geometry, analysis) {
    const infoX = 80;
    const infoY = this.options.svgHeight - 100;

    const infoTexts = [
      `Lot area: ${Math.round((geometry.lotArea || 0)).toLocaleString()} sf`,
      `Buildable area: ${Math.round((geometry.buildableArea || 0)).toLocaleString()} sf`,
    ];

    let y = infoY;
    for (const text of infoTexts) {
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('x', infoX);
      t.setAttribute('y', y);
      t.setAttribute('fill', this.options.colors.dimensionText);
      t.setAttribute('font-size', '11px');
      t.setAttribute('font-family', "'Segoe UI', sans-serif");
      t.textContent = text;
      svg.appendChild(t);
      y -= 20;
    }
  }

  /**
   * Add legend showing mass types
   */
  _addIsometricLegend(svg, geometry, analysis) {
    const legendX = 80;
    const legendY = 80;
    const boxSize = 16;
    const spacing = 28;

    const items = [
      { label: 'Existing Building', color: this.options.colors.existingBuilding },
      { label: 'FAR Massing', color: this.options.colors.farMassing },
      { label: 'Max Envelope', color: this.options.colors.maxEnvelope },
    ];

    // Title
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    title.setAttribute('x', legendX);
    title.setAttribute('y', legendY);
    title.setAttribute('font-size', '12px');
    title.setAttribute('font-family', "'Segoe UI', sans-serif");
    title.setAttribute('font-weight', 'bold');
    title.setAttribute('fill', '#111827');
    title.textContent = 'Legend';
    svg.appendChild(title);

    // Items
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const y = legendY + 28 + (i * spacing);

      // Color box
      const box = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      box.setAttribute('x', legendX);
      box.setAttribute('y', y - 12);
      box.setAttribute('width', boxSize);
      box.setAttribute('height', boxSize);
      box.setAttribute('fill', item.color);
      box.setAttribute('stroke', '#111827');
      box.setAttribute('stroke-width', '1');
      svg.appendChild(box);

      // Label
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', legendX + boxSize + 12);
      label.setAttribute('y', y);
      label.setAttribute('font-size', '11px');
      label.setAttribute('font-family', "'Segoe UI', sans-serif");
      label.setAttribute('fill', '#4b5563');
      label.textContent = item.label;
      svg.appendChild(label);
    }
  }

  // ==================== PRIVATE METHODS ====================

  _createSvgElement(width, height) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    return svg;
  }

  _createIsometricProjector(lotRing) {
    // Calculate centroid for local coordinate system
    let sumX = 0, sumY = 0;
    for (const [x, y] of lotRing) {
      sumX += x;
      sumY += y;
    }
    const centroid = [sumX / lotRing.length, sumY / lotRing.length];

    // Convert lat/lng to local meters
    const lat0 = centroid[1];
    const cosLat = Math.cos((lat0 * Math.PI) / 180);
    const mPerDegX = 111320 * cosLat;
    const mPerDegY = 110540;

    // Isometric projection parameters
    const angleRad = (this.options.isometricAngle * Math.PI) / 180;
    const centerScreenX = this.options.svgWidth / 2;
    const centerScreenY = this.options.svgHeight * 0.6;

    return ({ lng, lat, z = 0 }) => {
      // Convert to local meters
      const localX = (lng - centroid[0]) * mPerDegX;
      const localY = (lat - centroid[1]) * mPerDegY;
      const localZ = z * 0.3048; // Convert feet to meters

      // Isometric projection
      const isoX = (localX - localY) * Math.cos(angleRad);
      const isoY = (localX + localY) * Math.sin(angleRad) - localZ;

      // Scale to screen
      const scale = 40; // pixels per meter
      return {
        x: centerScreenX + (isoX * scale),
        y: centerScreenY + (isoY * scale),
      };
    };
  }

  _calculateLotCenter(ring) {
    let sumX = 0, sumY = 0;
    for (const [x, y] of ring) {
      sumX += x;
      sumY += y;
    }
    return [sumX / ring.length, sumY / ring.length];
  }

  _calculateExplosionOffset(centerProj, spacing) {
    const distance = Math.hypot(spacing, spacing);
    const angle = Math.atan2(spacing, spacing);
    return {
      x: Math.cos(angle) * distance,
      y: Math.sin(angle) * distance,
    };
  }

  _drawIsometricPolygon(svg, points, style = {}) {
    if (!points || points.length < 3) return;

    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    const pointsStr = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

    poly.setAttribute('points', pointsStr);
    poly.setAttribute('fill', style.fill || '#e0e7ff');
    poly.setAttribute('stroke', style.stroke || '#4b5563');
    poly.setAttribute('stroke-width', style.lineWeight || 2);

    if (style.opacity !== undefined) {
      poly.setAttribute('opacity', style.opacity);
    }

    svg.appendChild(poly);
  }

  _drawIsometricEdge(svg, p1, p2, style = {}) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', p1[0]);
    line.setAttribute('y1', p1[1]);
    line.setAttribute('x2', p2[0]);
    line.setAttribute('y2', p2[1]);
    line.setAttribute('stroke', style.stroke || '#4b5563');
    line.setAttribute('stroke-width', style.lineWeight || 1.5);

    if (style.hidden) {
      line.setAttribute('stroke-dasharray', '4,4');
      line.setAttribute('opacity', '0.4');
    }
    if (style.opacity !== undefined) {
      line.setAttribute('opacity', style.opacity);
    }

    svg.appendChild(line);
  }

  _addHatchToIsometricPolygon(svg, points, style = {}) {
    // Simple diagonal hatch
    if (!points || points.length < 3) return;

    const bounds = this._getBounds(points);
    const spacing = 12;
    const angle = (style.angle || 45) * Math.PI / 180;

    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    group.setAttribute('opacity', style.opacity || 0.3);

    for (let i = -bounds.width; i < bounds.width; i += spacing) {
      const x1 = bounds.minX + i;
      const y1 = bounds.minY;
      const x2 = x1 + (Math.cos(angle) * bounds.height * 2);
      const y2 = y1 + (Math.sin(angle) * bounds.height * 2);

      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', x1);
      line.setAttribute('y1', y1);
      line.setAttribute('x2', x2);
      line.setAttribute('y2', y2);
      line.setAttribute('stroke', style.hatchColor || '#999');
      line.setAttribute('stroke-width', '0.8');

      group.appendChild(line);
    }

    svg.appendChild(group);
  }

  _getBounds(points) {
    const xs = points.map(p => p[0]);
    const ys = points.map(p => p[1]);
    return {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    };
  }

  _shadeColor(color, factor = 0.8) {
    // Simple color shading (darken or lighten)
    const hex = color.replace('#', '');
    const r = Math.round(parseInt(hex.slice(0, 2), 16) * factor);
    const g = Math.round(parseInt(hex.slice(2, 4), 16) * factor);
    const b = Math.round(parseInt(hex.slice(4, 6), 16) * factor);
    return `#${[r, g, b].map(x => x.toString(16).padStart(2, '0')).join('')}`;
  }
}

export { ArchitecturalIsometricRenderer };
