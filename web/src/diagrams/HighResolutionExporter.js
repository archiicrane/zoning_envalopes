/**
 * HighResolutionExporter.js
 * 
 * Professional diagram export system supporting:
 * - High-DPI PNG export (300+ DPI equivalent)
 * - Vector SVG export
 * - Multi-diagram layout sheets
 * - Proper scaling and quality preservation
 */

class HighResolutionExporter {
  constructor(options = {}) {
    this.options = {
      dpiPresets: {
        'screen': 96,
        'print-draft': 150,
        'print-standard': 200,
        'print-high': 300,
        'archival': 600,
      },
      defaultDpi: options.defaultDpi || 300,
      maxCanvasSize: options.maxCanvasSize || 16384, // Browser limit
      paperSizes: {
        'letter': { width: 8.5, height: 11, unit: 'in' },
        'tabloid': { width: 11, height: 17, unit: 'in' },
        'a4': { width: 210, height: 297, unit: 'mm' },
        'a3': { width: 297, height: 420, unit: 'mm' },
      },
      ...options,
    };
  }

  /**
   * Export single diagram to PNG with high resolution
   */
  async exportDiagramPNG(svgElement, options = {}) {
    const {
      filename = 'diagram.png',
      dpi = this.options.defaultDpi,
      paperSize = null,
      margins = 0.5, // inches
    } = options;

    try {
      return await this._svgToPNG(svgElement, {
        filename,
        dpi,
        paperSize,
        margins,
      });
    } catch (err) {
      console.error('PNG export failed:', err);
      throw err;
    }
  }

  /**
   * Export as SVG vector format (lossless)
   */
  exportDiagramSVG(svgElement, options = {}) {
    const {
      filename = 'diagram.svg',
      includeMetadata = true,
    } = options;

    try {
      let svg = svgElement.cloneNode(true);

      if (includeMetadata) {
        svg = this._addMetadata(svg);
      }

      this._downloadSVG(svg, filename);
      return { success: true, filename };
    } catch (err) {
      console.error('SVG export failed:', err);
      throw err;
    }
  }

  /**
   * Export multi-diagram layout sheet
   */
  async exportDiagramLayout(diagrams, options = {}) {
    const {
      filename = 'zoning-study.png',
      layout = 'side-by-side', // 'side-by-side', 'stacked', 'grid'
      dpi = this.options.defaultDpi,
      title = 'Zoning Analysis Study',
      showLegend = true,
      showNorthArrow = true,
    } = options;

    try {
      // Combine diagrams into layout
      const layoutSvg = this._createLayout(diagrams, {
        layout,
        title,
        showLegend,
        showNorthArrow,
      });

      return await this._svgToPNG(layoutSvg, {
        filename,
        dpi,
      });
    } catch (err) {
      console.error('Layout export failed:', err);
      throw err;
    }
  }

  /**
   * Export analysis report with diagrams and metrics
   */
  async exportAnalysisReport(planDiagram, isoDiagram, analysis, options = {}) {
    const {
      filename = 'zoning-report.pdf',
      format = 'pdf', // 'pdf', 'html', 'png'
      dpi = this.options.defaultDpi,
      includeMetrics = true,
      includeHistory = false,
    } = options;

    try {
      if (format === 'png') {
        const diagrams = [
          { svg: planDiagram, label: 'Plan' },
          { svg: isoDiagram, label: 'Isometric' },
        ];
        return await this.exportDiagramLayout(diagrams, {
          filename,
          dpi,
          layout: 'side-by-side',
        });
      } else if (format === 'html') {
        return this._exportHTML(planDiagram, isoDiagram, analysis, {
          filename,
          includeMetrics,
        });
      }
    } catch (err) {
      console.error('Report export failed:', err);
      throw err;
    }
  }

  /**
   * Verify export quality and provide feedback
   */
  verifyExportQuality(svgElement, dpi = this.options.defaultDpi) {
    const viewBox = svgElement.getAttribute('viewBox');
    const [, , vbWidth, vbHeight] = viewBox?.split(' ').map(Number) || [];

    if (!vbWidth || !vbHeight) {
      return { valid: false, message: 'Invalid viewBox' };
    }

    const scale = dpi / 96; // 96 is standard screen DPI
    const exportWidth = Math.round(vbWidth * scale);
    const exportHeight = Math.round(vbHeight * scale);

    const pixelCount = exportWidth * exportHeight;
    const warnings = [];
    const info = [];

    info.push(`Viewport: ${vbWidth}×${vbHeight}`);
    info.push(`Export size (${dpi} DPI): ${exportWidth}×${exportHeight} px`);
    info.push(`Total pixels: ${pixelCount.toLocaleString()}`);

    // Check for issues
    if (exportWidth > this.options.maxCanvasSize || 
        exportHeight > this.options.maxCanvasSize) {
      warnings.push(
        `Export dimensions exceed maximum canvas size. ` +
        `Consider using lower DPI or splitting into multiple exports.`
      );
    }

    if (dpi < 150) {
      warnings.push('DPI is below print standard (150+). Output may appear pixelated.');
    }

    if (dpi > 600) {
      warnings.push('DPI above archival standard. File size will be very large.');
    }

    return {
      valid: warnings.length === 0,
      warnings,
      info,
      exportWidth,
      exportHeight,
      dpi,
      recommendations: this._getRecommendations(exportWidth, exportHeight, dpi),
    };
  }

  // ==================== PRIVATE METHODS ====================

  async _svgToPNG(svgElement, options) {
    const {
      filename,
      dpi,
      paperSize,
      margins,
    } = options;

    return new Promise((resolve, reject) => {
      try {
        const viewBox = svgElement.getAttribute('viewBox');
        const [, , vbWidth, vbHeight] = viewBox?.split(' ').map(Number) || [];

        if (!vbWidth || !vbHeight) {
          reject(new Error('Invalid SVG viewBox'));
          return;
        }

        const scale = dpi / 96; // 96 is standard screen DPI
        let canvasWidth = Math.round(vbWidth * scale);
        let canvasHeight = Math.round(vbHeight * scale);

        // Check canvas size limits
        if (canvasWidth > this.options.maxCanvasSize || 
            canvasHeight > this.options.maxCanvasSize) {
          reject(new Error(
            `Export size (${canvasWidth}×${canvasHeight}) exceeds maximum. ` +
            `Reduce DPI or SVG size.`
          ));
          return;
        }

        const canvas = document.createElement('canvas');
        canvas.width = canvasWidth;
        canvas.height = canvasHeight;

        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) {
          reject(new Error('Could not get canvas context'));
          return;
        }

        // White background
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);

        // Serialize SVG
        const serializer = new XMLSerializer();
        const svgString = serializer.serializeToString(svgElement);
        const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
        const svgUrl = URL.createObjectURL(svgBlob);

        const img = new Image();
        img.onload = () => {
          // Draw with scaling for high DPI
          ctx.scale(scale, scale);
          ctx.drawImage(img, 0, 0, vbWidth, vbHeight);

          URL.revokeObjectURL(svgUrl);

          // Convert to PNG blob
          canvas.toBlob(
            (blob) => {
              this._downloadBlob(blob, filename);
              resolve({ success: true, filename, size: `${canvasWidth}×${canvasHeight}`, dpi });
            },
            'image/png',
            1.0 // PNG quality (always lossless)
          );
        };

        img.onerror = () => {
          URL.revokeObjectURL(svgUrl);
          reject(new Error('Failed to load SVG for rendering'));
        };

        img.src = svgUrl;
      } catch (err) {
        reject(err);
      }
    });
  }

  _createLayout(diagrams, options) {
    const {
      layout = 'side-by-side',
      title,
      showLegend,
      showNorthArrow,
    } = options;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');

    let width, height;
    if (layout === 'side-by-side') {
      width = 4800;
      height = 1560 + (title ? 160 : 0);
    } else if (layout === 'stacked') {
      width = 2400;
      height = 3120 + (title ? 160 : 0);
    } else {
      width = 4800;
      height = 3120 + (title ? 160 : 0);
    }

    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);

    // White background
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('width', width);
    bg.setAttribute('height', height);
    bg.setAttribute('fill', '#ffffff');
    svg.appendChild(bg);

    // Title
    if (title) {
      const titleText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      titleText.setAttribute('x', width / 2);
      titleText.setAttribute('y', 80);
      titleText.setAttribute('font-size', '48px');
      titleText.setAttribute('font-weight', 'bold');
      titleText.setAttribute('text-anchor', 'middle');
      titleText.setAttribute('fill', '#111827');
      titleText.textContent = title;
      svg.appendChild(titleText);
    }

    // Add diagrams
    let offsetX = 40;
    let offsetY = title ? 160 : 40;

    for (const diagram of diagrams) {
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('transform', `translate(${offsetX},${offsetY})`);

      // Clone diagram content
      if (diagram.svg) {
        for (const child of diagram.svg.children) {
          g.appendChild(child.cloneNode(true));
        }
      }

      svg.appendChild(g);

      if (layout === 'side-by-side') {
        offsetX += 2400 + 80;
      } else if (layout === 'stacked') {
        offsetY += 1560 + 80;
      }
    }

    return svg;
  }

  _exportHTML(planDiagram, isoDiagram, analysis, options) {
    const { filename, includeMetrics } = options;

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Zoning Analysis Report</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; }
        .page { max-width: 1200px; margin: 40px auto; padding: 40px; page-break-after: always; }
        h1 { text-align: center; margin-bottom: 40px; }
        .diagrams { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin-bottom: 40px; }
        .diagram-container { border: 1px solid #ddd; padding: 20px; }
        .diagram-container h3 { margin-top: 0; }
        .diagram-container svg { width: 100%; height: auto; }
        .metrics { background: #f3f4f6; padding: 20px; border-radius: 8px; margin-top: 40px; }
        .metric { margin: 12px 0; }
        .metric-label { font-weight: bold; }
        @media print {
          .page { page-break-inside: avoid; }
          .diagrams { page-break-inside: avoid; }
        }
      </style>
    </head>
    <body>
      <div class="page">
        <h1>Zoning Analysis Report</h1>
        
        <div class="diagrams">
          <div class="diagram-container">
            <h3>Plan View</h3>
            ${planDiagram ? new XMLSerializer().serializeToString(planDiagram) : ''}
          </div>
          
          <div class="diagram-container">
            <h3>Isometric View</h3>
            ${isoDiagram ? new XMLSerializer().serializeToString(isoDiagram) : ''}
          </div>
        </div>
        
        ${includeMetrics ? this._getMetricsHTML(analysis) : ''}
      </div>
    </body>
    </html>
    `;

    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    this._downloadBlob(blob, filename);
    return { success: true, filename };
  }

  _getMetricsHTML(analysis) {
    if (!analysis) return '';

    const metrics = [
      { label: 'Lot Area', value: `${Math.round(analysis.lotArea || 0).toLocaleString()} sf` },
      { label: 'Buildable Area', value: `${Math.round(analysis.buildableArea || 0).toLocaleString()} sf` },
      { label: 'FAR Used', value: `${(analysis.farUsed || 0).toFixed(2)}` },
      { label: 'FAR Footprint', value: `${Math.round(analysis.farFootprintArea || 0).toLocaleString()} sf` },
      { label: 'Building Height', value: `${Math.round(analysis.farHeight || 0)} ft` },
      { label: 'Maximum Height', value: `${Math.round(analysis.maxHeight || 0)} ft` },
    ];

    return `
      <div class="metrics">
        <h3>Key Metrics</h3>
        ${metrics.map(m => `
          <div class="metric">
            <span class="metric-label">${m.label}:</span> ${m.value}
          </div>
        `).join('')}
      </div>
    `;
  }

  _addMetadata(svgElement) {
    const svg = svgElement.cloneNode(true);
    const metadata = document.createElementNS('http://www.w3.org/2000/svg', 'metadata');
    
    const rdf = document.createElementNS('http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'RDF');
    const work = document.createElementNS('http://purl.org/dc/elements/1.1/', 'Work');
    
    const format = document.createElementNS('http://purl.org/dc/elements/1.1/', 'format');
    format.textContent = 'image/svg+xml';
    work.appendChild(format);
    
    const created = document.createElementNS('http://purl.org/dc/elements/1.1/', 'created');
    created.textContent = new Date().toISOString();
    work.appendChild(created);
    
    rdf.appendChild(work);
    metadata.appendChild(rdf);
    svg.insertBefore(metadata, svg.firstChild);
    
    return svg;
  }

  _downloadSVG(svgElement, filename) {
    const serializer = new XMLSerializer();
    const svgString = serializer.serializeToString(svgElement);
    const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    this._downloadBlob(blob, filename);
  }

  _downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  _getRecommendations(width, height, dpi) {
    const recommendations = [];

    if (dpi < 200) {
      recommendations.push('Increase DPI to 300+ for print-quality output');
    }
    if (width < 1200) {
      recommendations.push('Consider higher SVG resolution for better detail');
    }
    if (width * height > 30000000) {
      recommendations.push('Large export size; consider splitting into multiple files');
    }

    return recommendations.length > 0 ? recommendations : ['Export quality looks good'];
  }
}

export { HighResolutionExporter };
