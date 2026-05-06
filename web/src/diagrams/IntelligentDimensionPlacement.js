/**
 * IntelligentDimensionPlacement.js
 * 
 * Advanced dimension placement system with:
 * - Collision detection between dimensions, geometry, and text
 * - Intelligent offset calculation
 * - Dimension hierarchy and prioritization
 * - Clean whitespace management
 */

class IntelligentDimensionPlacement {
  constructor(options = {}) {
    this.options = {
      minTextSpacing: options.minTextSpacing || 12,
      minOffsetFromGeometry: options.minOffsetFromGeometry || 80,
      incrementalOffsetStep: options.incrementalOffsetStep || 90,
      maxOffsetDistance: options.maxOffsetDistance || 600,
      textHeight: options.textHeight || 16,
      textWidth: options.textWidth || 120, // Approximate average
      ...options,
    };

    this.placedDimensions = [];
    this.geometryBounds = [];
  }

  /**
   * Compute intelligent placement for all dimensions
   */
  placeDimensions(dimensions, geometryRings, bounds) {
    this.placedDimensions = [];
    this.geometryBounds = this._computeGeometryBounds(geometryRings, bounds);

    // Prioritize dimensions: lot dims first, then secondary
    const sorted = [...dimensions].sort((a, b) => {
      const priorityA = a.priority || 0;
      const priorityB = b.priority || 0;
      if (priorityA !== priorityB) return priorityA - priorityB;
      return (a.order || 0) - (b.order || 0);
    });

    for (const dim of sorted) {
      const placement = this._computePlacement(dim, bounds);
      if (placement) {
        this.placedDimensions.push({
          ...dim,
          ...placement,
        });
      }
    }

    return this.placedDimensions;
  }

  /**
   * Find available offset for dimension without collision
   */
  _computePlacement(dimension, bounds) {
    const {
      start, end, label, offsetDirection = 'outward',
    } = dimension;

    if (!start || !end) return null;

    // Get dimension line direction
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const nx = -uy; // Normal perpendicular to line
    const ny = ux;

    // Try offsets incrementally outward from geometry
    for (let offsetIdx = 0; offsetIdx < 8; offsetIdx++) {
      const offset = this.options.minOffsetFromGeometry + 
                     (offsetIdx * this.options.incrementalOffsetStep);

      if (offset > this.options.maxOffsetDistance) break;

      const sx = start[0] + (nx * offset);
      const sy = start[1] + (ny * offset);
      const ex = end[0] + (nx * offset);
      const ey = end[1] + (ny * offset);

      const mx = (sx + ex) / 2;
      const my = (sy + ey) / 2;

      // Check for collisions
      const textBounds = this._getTextBounds(mx, my, label);
      const lineBounds = { x1: sx, y1: sy, x2: ex, y2: ey };

      const hasCollision = this._checkCollisions(textBounds, lineBounds);

      if (!hasCollision) {
        return {
          offset,
          sx, sy, ex, ey,
          mx, my,
          textBounds,
          lineBounds,
          offsetIdx,
        };
      }
    }

    // Fallback to minimal offset
    return {
      offset: this.options.minOffsetFromGeometry,
      sx: start[0] + (nx * this.options.minOffsetFromGeometry),
      sy: start[1] + (ny * this.options.minOffsetFromGeometry),
      ex: end[0] + (nx * this.options.minOffsetFromGeometry),
      ey: end[1] + (ny * this.options.minOffsetFromGeometry),
      mx: start[0] + ((end[0] - start[0]) / 2) + (nx * this.options.minOffsetFromGeometry),
      my: start[1] + ((end[1] - start[1]) / 2) + (ny * this.options.minOffsetFromGeometry),
    };
  }

  /**
   * Check for collisions with geometry and other dimensions
   */
  _checkCollisions(textBounds, lineBounds) {
    // Check collision with geometry
    for (const geomBounds of this.geometryBounds) {
      if (this._boundsIntersect(textBounds, geomBounds)) {
        return true;
      }
    }

    // Check collision with other placed dimensions
    for (const placed of this.placedDimensions) {
      if (placed.textBounds && this._boundsIntersect(textBounds, placed.textBounds)) {
        return true;
      }
      if (placed.lineBounds && this._boundsIntersect(lineBounds, placed.lineBounds)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get text bounding box
   */
  _getTextBounds(x, y, text) {
    // Rough estimate: measure text
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.font = "13px 'Segoe UI', sans-serif";
    const metrics = ctx.measureText(text);
    const width = metrics.width || (text.length * 8);
    const height = this.options.textHeight;

    return {
      x1: x - (width / 2) - 6,
      y1: y - (height / 2) - 6,
      x2: x + (width / 2) + 6,
      y2: y + (height / 2) + 6,
    };
  }

  /**
   * Get line segment bounding box
   */
  _getLineBounds(sx, sy, ex, ey, width = 10) {
    return {
      x1: Math.min(sx, ex) - width,
      y1: Math.min(sy, ey) - width,
      x2: Math.max(sx, ex) + width,
      y2: Math.max(sy, ey) + width,
    };
  }

  /**
   * Check if two bounds intersect (with padding)
   */
  _boundsIntersect(b1, b2, padding = 8) {
    return !(
      b1.x2 + padding < b2.x1 ||
      b1.x1 - padding > b2.x2 ||
      b1.y2 + padding < b2.y1 ||
      b1.y1 - padding > b2.y2
    );
  }

  /**
   * Compute bounding boxes for geometry polygons
   */
  _computeGeometryBounds(rings, parentBounds) {
    const bounds = [];

    for (const ring of rings || []) {
      if (!ring || ring.length < 3) continue;

      let minX = Infinity, maxX = -Infinity;
      let minY = Infinity, maxY = -Infinity;

      for (const [x, y] of ring) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }

      // Apply parent transform if needed
      if (parentBounds && parentBounds.scale) {
        const transform = parentBounds.project || ((pt) => pt);
        const [px1, py1] = transform([minX, minY]);
        const [px2, py2] = transform([maxX, maxY]);

        bounds.push({
          x1: Math.min(px1, px2),
          y1: Math.min(py1, py2),
          x2: Math.max(px1, px2),
          y2: Math.max(py1, py2),
        });
      } else {
        bounds.push({ x1: minX, y1: minY, x2: maxX, y2: maxY });
      }
    }

    return bounds;
  }

  /**
   * Create dimension drawing instructions for SVG
   */
  getDimensionDrawInstructions(placement) {
    if (!placement) return null;

    const { sx, sy, ex, ey, mx, my, label } = placement;
    const dx = ex - sx;
    const dy = ey - sy;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;

    const tickLen = 8;
    const tickOffsetLen = 5;

    return {
      extensionLines: [
        { x1: placement.start?.[0], y1: placement.start?.[1], x2: sx, y2: sy },
        { x1: placement.end?.[0], y1: placement.end?.[1], x2: ex, y2: ey },
      ].filter(l => l.x1 !== undefined),
      dimensionLine: { x1: sx, y1: sy, x2: ex, y2: ey },
      ticks: [
        {
          x1: sx - (ux * tickLen) - (tickOffsetLen * 0.5),
          y1: sy - (uy * tickLen) - (tickOffsetLen * 0.5),
          x2: sx + (ux * tickLen) + (tickOffsetLen * 0.5),
          y2: sy + (uy * tickLen) + (tickOffsetLen * 0.5),
        },
        {
          x1: ex - (ux * tickLen) - (tickOffsetLen * 0.5),
          y1: ey - (uy * tickLen) - (tickOffsetLen * 0.5),
          x2: ex + (ux * tickLen) + (tickOffsetLen * 0.5),
          y2: ey + (uy * tickLen) + (tickOffsetLen * 0.5),
        },
      ],
      label: {
        text: label,
        x: mx,
        y: my,
        bounds: placement.textBounds,
      },
    };
  }
}

export { IntelligentDimensionPlacement };
