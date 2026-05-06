/**
 * DiagramSystemIntegration.js
 * 
 * Integrates all diagram rendering modules into a unified system
 * Provides high-level API for rendering, exporting, and managing diagrams
 */

import { ArchitecturalDiagramRenderer } from './ArchitecturalDiagramRenderer.js';
import { ArchitecturalIsometricRenderer } from './ArchitecturalIsometricRenderer.js';
import { StreetDetectionAndOrientation } from './StreetDetectionAndOrientation.js';
import { IntelligentDimensionPlacement } from './IntelligentDimensionPlacement.js';
import { HighResolutionExporter } from './HighResolutionExporter.js';

class DiagramSystemIntegration {
  constructor(options = {}) {
    this.planRenderer = new ArchitecturalDiagramRenderer(options.planRendererOptions);
    this.isoRenderer = new ArchitecturalIsometricRenderer(options.isoRendererOptions);
    this.streetDetector = new StreetDetectionAndOrientation(options.mapboxMap);
    this.dimensionPlacer = new IntelligentDimensionPlacement(options.dimensionOptions);
    this.exporter = new HighResolutionExporter(options.exporterOptions);

    this.options = {
      enableStreetDetection: options.enableStreetDetection !== false,
      enableHighResExport: options.enableHighResExport !== false,
      defaultExportDpi: options.defaultExportDpi || 300,
      ...options,
    };

    this.lastGeneratedDiagrams = {
      planSvg: null,
      isoSvg: null,
    };
  }

  /**
   * Generate complete diagram set (plan + isometric)
   */
  async generateDiagrams(lotFeature, analysis, map = null) {
    try {
      // Detect street orientation if enabled
      let streetInfo = null;
      if (this.options.enableStreetDetection && map) {
        streetInfo = await this.streetDetector.detectStreetEdge(lotFeature, map);
      }

      // Prepare geometry for rendering
      const geometry = this._prepareGeometry(lotFeature, analysis);

      // Generate plan diagram
      const planSvg = this.planRenderer.createPlanDiagram(geometry, analysis, streetInfo);

      // Generate isometric diagram
      const isoSvg = this.isoRenderer.createIsometricDiagram(geometry, analysis, streetInfo);

      // Cache for export
      this.lastGeneratedDiagrams = {
        planSvg,
        isoSvg,
        geometry,
        analysis,
        streetInfo,
        lotFeature,
      };

      return {
        success: true,
        planSvg,
        isoSvg,
        geometry,
      };
    } catch (err) {
      console.error('Diagram generation failed:', err);
      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Render plan diagram to DOM element
   */
  renderPlanDiagram(planSvg, containerElement) {
    if (!containerElement || !planSvg) return false;

    // Clear container
    containerElement.innerHTML = '';

    // Create wrapper for responsive SVG
    const wrapper = document.createElement('div');
    wrapper.style.width = '100%';
    wrapper.style.aspectRatio = '2400 / 1560';
    wrapper.style.display = 'flex';
    wrapper.style.alignItems = 'center';
    wrapper.style.justifyContent = 'center';

    planSvg.style.width = '100%';
    planSvg.style.height = '100%';

    wrapper.appendChild(planSvg);
    containerElement.appendChild(wrapper);

    return true;
  }

  /**
   * Render isometric diagram to DOM element
   */
  renderIsometricDiagram(isoSvg, containerElement) {
    if (!containerElement || !isoSvg) return false;

    containerElement.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.style.width = '100%';
    wrapper.style.aspectRatio = '2400 / 1560';
    wrapper.style.display = 'flex';
    wrapper.style.alignItems = 'center';
    wrapper.style.justifyContent = 'center';

    isoSvg.style.width = '100%';
    isoSvg.style.height = '100%';

    wrapper.appendChild(isoSvg);
    containerElement.appendChild(wrapper);

    return true;
  }

  /**
   * Export diagrams with high resolution
   */
  async exportDiagrams(options = {}) {
    const {
      format = 'png', // 'png', 'svg', 'layout', 'report'
      filename,
      dpi = this.options.defaultExportDpi,
      layout = 'side-by-side',
    } = options;

    const { planSvg, isoSvg } = this.lastGeneratedDiagrams;

    if (!planSvg && !isoSvg) {
      throw new Error('No diagrams to export. Generate diagrams first.');
    }

    try {
      let result;

      if (format === 'png' && planSvg) {
        result = await this.exporter.exportDiagramPNG(planSvg, {
          filename: filename || 'plan-diagram.png',
          dpi,
        });
      } else if (format === 'svg' && planSvg) {
        result = this.exporter.exportDiagramSVG(planSvg, {
          filename: filename || 'plan-diagram.svg',
          includeMetadata: true,
        });
      } else if (format === 'layout' && planSvg && isoSvg) {
        result = await this.exporter.exportDiagramLayout(
          [
            { svg: planSvg, label: 'Plan View' },
            { svg: isoSvg, label: 'Isometric View' },
          ],
          {
            filename: filename || 'zoning-study.png',
            layout,
            dpi,
            title: 'Zoning Analysis Study',
            showLegend: true,
            showNorthArrow: true,
          }
        );
      } else if (format === 'report' && planSvg && isoSvg) {
        const { analysis } = this.lastGeneratedDiagrams;
        result = await this.exporter.exportAnalysisReport(
          planSvg,
          isoSvg,
          analysis,
          {
            filename: filename || 'zoning-report.png',
            format: 'png',
            dpi,
            includeMetrics: true,
          }
        );
      }

      return {
        success: true,
        format,
        result,
      };
    } catch (err) {
      console.error(`Export failed (${format}):`, err);
      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Verify export quality
   */
  verifyExportQuality(dpi = this.options.defaultExportDpi) {
    const { planSvg } = this.lastGeneratedDiagrams;
    if (!planSvg) return { valid: false, message: 'No diagram generated' };

    return this.exporter.verifyExportQuality(planSvg, dpi);
  }

  /**
   * Get diagram metrics for display/reporting
   */
  getDiagramMetrics() {
    const { geometry, analysis } = this.lastGeneratedDiagrams;
    if (!geometry || !analysis) return null;

    return {
      lotArea: geometry.lotArea || 0,
      buildableArea: geometry.buildableArea || 0,
      farFootprintArea: geometry.farFootprintArea || 0,
      farHeight: analysis.farHeight || 0,
      maxHeight: analysis.maxHeight || 0,
      existingHeight: analysis.existingHeightFt || 0,
      floorCount: analysis.floorCount || 0,
      coverage: geometry.coverage || 0,
      isCapped: analysis.isCapped || false,
    };
  }

  // ==================== PRIVATE METHODS ====================

  _prepareGeometry(lotFeature, analysis) {
    if (!lotFeature || !lotFeature.geometry) {
      throw new Error('Invalid lot feature');
    }

    const lotCoords = this._extractRingFromGeometry(lotFeature.geometry);
    if (!lotCoords || lotCoords.length < 3) {
      throw new Error('Invalid lot geometry');
    }

    return {
      lot: lotCoords,
      existing: analysis?.existingGeometry ? 
        this._extractRingFromGeometry(analysis.existingGeometry) : [],
      buildable: analysis?.buildableGeometry ? 
        this._extractRingFromGeometry(analysis.buildableGeometry) : [],
      farFootprint: analysis?.farFootprintGeometry ? 
        this._extractRingFromGeometry(analysis.farFootprintGeometry) : [],
      maxBuildable: analysis?.maxBuildableGeometry ? 
        this._extractRingFromGeometry(analysis.maxBuildableGeometry) : [],
      lotArea: analysis?.lotArea || this._calculateRingArea(lotCoords),
      buildableArea: analysis?.buildableArea || 0,
      farFootprintArea: analysis?.farFootprintArea || 0,
      existingHeight: analysis?.existingHeightFt || 10,
      farHeight: analysis?.farHeight || 80,
      maxHeight: analysis?.maxHeight || 120,
      coverage: analysis?.coverage || 80,
    };
  }

  _extractRingFromGeometry(geometry) {
    if (!geometry) return [];

    if (geometry.type === 'Polygon' && geometry.coordinates?.[0]) {
      return geometry.coordinates[0];
    }
    if (geometry.type === 'LineString' && geometry.coordinates) {
      return geometry.coordinates;
    }
    if (Array.isArray(geometry)) {
      return geometry;
    }

    return [];
  }

  _calculateRingArea(ring) {
    if (!ring || ring.length < 3) return 0;

    let area = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[i + 1];
      area += x1 * y2 - x2 * y1;
    }

    // Square feet conversion (rough approximation for lat/lng)
    return Math.abs(area / 2) * 10.764;
  }
}

export { DiagramSystemIntegration };
