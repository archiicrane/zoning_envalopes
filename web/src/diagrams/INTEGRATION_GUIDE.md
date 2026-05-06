# New Diagram System Integration Guide

## Quick Start

### 1. Verify Installation
The new diagram system consists of 6 modular JavaScript files:
```
web/src/diagrams/
├── ArchitecturalDiagramRenderer.js      (544 lines)
├── ArchitecturalIsometricRenderer.js    (531 lines)
├── StreetDetectionAndOrientation.js     (431 lines)
├── IntelligentDimensionPlacement.js     (298 lines)
├── HighResolutionExporter.js            (502 lines)
├── DiagramSystemIntegration.js          (367 lines)
└── SYSTEM_DOCUMENTATION.md              (800+ lines)
```

### 2. Initialization (in app.js)
```javascript
// Already implemented in app.js bootstrap function
diagramSystem = new DiagramSystemIntegration({
  mapboxMap: map,
  enableStreetDetection: true,
  enableHighResExport: true,
  defaultExportDpi: 300,
  // ... additional config
});
```

### 3. Basic Usage

#### Generate Diagrams
```javascript
const result = await diagramSystem.generateDiagrams(
  lotFeature,      // GeoJSON feature
  analysisData,    // Analysis metrics
  map              // Mapbox map instance
);

if (result.success) {
  // Render plan diagram
  diagramSystem.renderPlanDiagram(result.planSvg, planContainer);
  
  // Render isometric diagram
  diagramSystem.renderIsometricDiagram(result.isoSvg, isoContainer);
}
```

#### Export High-Resolution PNG
```javascript
const result = await diagramSystem.exportDiagrams({
  format: 'layout',
  filename: 'zoning-study.png',
  dpi: 300,
  layout: 'side-by-side',
});
```

## Output Examples

### Plan View Diagram
```
High-resolution SVG (2400×1560) containing:
✓ Property line (heavy dark stroke)
✓ Existing building (gray hatch pattern)
✓ Buildable area (subtle dashed line)
✓ FAR footprint (colored transparent fill)
✓ Intelligent dimensions (with offset collision detection)
✓ Orientation labels (FRONT YARD, REAR YARD, SIDE YARD)
✓ Street edge (dashed line if detected)
✓ Legend and info box
✓ North arrow and scale bar
```

### Isometric View Diagram
```
High-resolution SVG (2400×1560) containing:
✓ Existing building (gray with hatching, full opacity)
✓ FAR massing (green, medium opacity)
✓ Max envelope (blue, light opacity)
✓ Exploded spacing between layers (150px)
✓ Vertical dimension lines with labels
✓ Depth layering (hidden lines dashed)
✓ Legend with color-coded masses
✓ Metric annotations
```

## Export Quality Tiers

### Standard Print (Recommended)
```javascript
dpi: 300      // 300 dots per inch
size: 2400×1560 SVG → 8000×5200 PNG
file: 3-8 MB (depending on complexity)
quality: Professional presentation boards
```

### High Resolution (Archive)
```javascript
dpi: 600      // Maximum
size: 2400×1560 SVG → 16000×10400 PNG
file: 10-20 MB
quality: Archival, large format printing
```

### Web/Screen
```javascript
dpi: 96       // Web standard
size: 2400×1560 SVG → 1200×780 PNG
file: 500-800 KB
quality: Fast, suitable for web display
```

## Quality Verification

Before exporting, verify export quality:
```javascript
const quality = diagramSystem.verifyExportQuality(300);

// Returns:
{
  valid: true,
  warnings: [],
  info: [
    'Viewport: 2400×1560',
    'Export size (300 DPI): 8000×5200 px',
    'Total pixels: 41,600,000',
  ],
  exportWidth: 8000,
  exportHeight: 5200,
  dpi: 300,
  recommendations: ['Export quality looks good'],
}
```

## Troubleshooting

### Issue: Diagrams don't render
**Checks**:
1. Verify `diagramSystem` is initialized: `console.log(diagramSystem)`
2. Check lot feature has valid geometry: `console.log(lotFeature.geometry)`
3. Check browser console for errors
4. Ensure `map` object is available

**Solution**:
```javascript
if (!diagramSystem) {
  console.error('Diagram system not initialized');
  return;
}
```

### Issue: Dimensions overlap
**Checks**:
1. Verify IntelligentDimensionPlacement is working
2. Check dimension spacing configuration
3. Validate lot geometry is closed properly

**Solution**:
```javascript
const quality = diagramSystem.verifyExportQuality(300);
if (quality.warnings.length > 0) {
  console.warn('Export warnings:', quality.warnings);
}
```

### Issue: Export times out
**Causes**:
- DPI too high (> 300)
- SVG too complex (> 1000 vertices)
- Browser memory limitation

**Solutions**:
```javascript
// Reduce DPI for faster export
await diagramSystem.exportDiagrams({
  dpi: 200,  // Instead of 300
});

// Or export as SVG (faster, lossless)
await diagramSystem.exportDiagrams({
  format: 'svg',
});
```

### Issue: Street edge not detected
**Checks**:
1. Verify Mapbox token is valid
2. Check lot is near roads
3. Enable street detection: `enableStreetDetection: true`

**Debug**:
```javascript
const streetInfo = await diagramSystem.streetDetector.detectStreetEdge(
  lotFeature,
  map
);
console.log('Street detection result:', streetInfo);
```

## Performance Tips

### Optimize for Speed
```javascript
// Caching: Diagrams are cached after generation
diagramSystem.lastGeneratedDiagrams;

// Multi-export: Reuse generated diagrams
await diagramSystem.exportDiagrams({ format: 'png', dpi: 300 });
await diagramSystem.exportDiagrams({ format: 'svg' });  // Reuses same generation
```

### Memory Efficiency
```javascript
// Export in lower DPI first, then high-res if needed
const draft = await diagramSystem.exportDiagrams({ dpi: 150 });
// ... user review ...
const final = await diagramSystem.exportDiagrams({ dpi: 300 });
```

### Browser Compatibility
```javascript
// Check browser canvas limits before export
const quality = diagramSystem.verifyExportQuality(600);
if (!quality.valid) {
  // Use lower DPI or split export
  console.warn('Export may fail at 600 DPI, trying 300...');
  const result = await diagramSystem.exportDiagrams({ dpi: 300 });
}
```

## Configuration Options

### Renderer Options
```javascript
// Plan diagram configuration
planRendererOptions: {
  svgWidth: 2400,              // Base width
  svgHeight: 1560,             // Base height
  padding: 180,                // Margin around diagram
  dimensionSpacing: 120,       // Between offset bands
  lineWeights: { ... },        // Custom line weights
  colors: { ... },             // Custom color palette
}

// Isometric diagram configuration
isoRendererOptions: {
  svgWidth: 2400,
  svgHeight: 1560,
  isometricAngle: 30,          // Degrees (typically 30)
  explodedSpacing: 150,        // Pixels between layers
  lineWeights: { ... },
  colors: { ... },
}
```

### Exporter Options
```javascript
exporterOptions: {
  defaultDpi: 300,             // Default export resolution
  maxCanvasSize: 16384,        // Browser canvas size limit
  paperSizes: { ... },         // Custom paper sizes
}
```

## Advanced Usage

### Custom Rendering
```javascript
// Use renderer directly for custom workflows
const renderer = new ArchitecturalDiagramRenderer(options);
const svg = renderer.createPlanDiagram(geometry, analysis, streetInfo);

// Modify SVG before export
svg.appendChild(myCustomElements);

// Export modified diagram
await renderer.exportToPNG(svg, 'custom-diagram.png', 300);
```

### Batch Export
```javascript
// Export multiple lots
for (const lot of lots) {
  const result = await diagramSystem.generateDiagrams(lot, analysis, map);
  await diagramSystem.exportDiagrams({
    format: 'layout',
    filename: `zoning-${lot.properties.bbl}.png`,
    dpi: 300,
  });
}
```

### Quality Reporting
```javascript
// Get detailed quality info
const metrics = diagramSystem.getDiagramMetrics();
const quality = diagramSystem.verifyExportQuality(300);

console.log('Export Metrics:');
console.log(`- Lot Area: ${metrics.lotArea} sq ft`);
console.log(`- FAR Height: ${metrics.farHeight} ft`);
console.log(`- Export Size: ${quality.exportWidth}×${quality.exportHeight}`);
console.log(`- DPI: ${quality.dpi}`);
```

## API Quick Reference

### Generate
```javascript
await diagramSystem.generateDiagrams(lotFeature, analysis, map)
```

### Render
```javascript
diagramSystem.renderPlanDiagram(svgElement, container)
diagramSystem.renderIsometricDiagram(svgElement, container)
```

### Export
```javascript
await diagramSystem.exportDiagrams({ format, filename, dpi, layout })
```

### Verify
```javascript
diagramSystem.verifyExportQuality(dpi)
diagramSystem.getDiagramMetrics()
```

## Support & Resources

- **Documentation**: `web/src/diagrams/SYSTEM_DOCUMENTATION.md`
- **Module API**: See JSDoc comments in each module
- **Source Code**: `web/src/diagrams/*.js`
- **Integration**: See `app.js` for usage examples

---

**Version**: 1.0  
**Status**: Production-ready  
**Last Updated**: 2026-05-05
