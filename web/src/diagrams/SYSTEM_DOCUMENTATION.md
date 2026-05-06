# Architectural Diagram System - Technical Documentation

## Overview

The refactored diagram system provides professional-quality architectural drawings for zoning analysis with high-resolution export capabilities. The system is modular, extensible, and produces crisp, presentation-ready output.

## Architecture

### Core Modules

#### 1. **ArchitecturalDiagramRenderer.js**
- **Purpose**: SVG-based plan view diagram rendering
- **Features**:
  - High-resolution base rendering (2400×1560px SVG)
  - Professional architectural line hierarchy
  - Intelligent hatch patterns for existing buildings
  - Transparent color fills for zoning envelopes
  - Smart dimension placement with white background masks
  - Orientation labels and property information
- **Key Classes**: `ArchitecturalDiagramRenderer`
- **Methods**:
  - `createPlanDiagram(geometry, analysis, streetInfo)` - Generate plan SVG
  - `exportToPNG(svgElement, filename, dpi)` - Export to high-DPI PNG
  - `exportToSVG(svgElement, filename)` - Export vector SVG

#### 2. **ArchitecturalIsometricRenderer.js**
- **Purpose**: 3D isometric diagram rendering
- **Features**:
  - Exploded layer spacing for clarity (existing, FAR, max envelope)
  - Proper depth layering with hidden line treatment
  - Vertical dimension lines with labels
  - Architectural legend and annotations
  - Hatch patterns on top faces
- **Key Classes**: `ArchitecturalIsometricRenderer`
- **Methods**:
  - `createIsometricDiagram(geometry, analysis, streetInfo)` - Generate isometric SVG

#### 3. **StreetDetectionAndOrientation.js**
- **Purpose**: Automatic street edge detection and orientation labeling
- **Features**:
  - Multiple detection strategies (property-based, Mapbox roads, centroid-based)
  - Automatic front/rear/side yard labeling
  - North arrow generation
  - Scale bar rendering
  - Confidence scoring for detected edges
- **Key Classes**: `StreetDetectionAndOrientation`
- **Detection Strategies**:
  1. Property-based: Uses `front_direction` property
  2. Mapbox roads: Query nearby roads via Mapbox API
  3. Centroid-based: Find edge farthest from lot centroid
  4. Fallback: Use first/longest edge

#### 4. **IntelligentDimensionPlacement.js**
- **Purpose**: Collision detection and intelligent dimension offset calculation
- **Features**:
  - Automatic dimension offset incrementation
  - Collision detection with:
    - Geometry polygons
    - Other dimensions
    - Text bounds
  - Text bounding box calculation
  - Dimension hierarchy support
  - Configurable minimum spacing
- **Key Classes**: `IntelligentDimensionPlacement`
- **Methods**:
  - `placeDimensions(dimensions, geometryRings, bounds)` - Place all dimensions
  - `getDimensionDrawInstructions(placement)` - Get SVG drawing specs

#### 5. **HighResolutionExporter.js**
- **Purpose**: Multi-format, high-DPI export system
- **Features**:
  - DPI presets: screen (96), draft (150), standard (200), high (300), archival (600)
  - PNG export with configurable DPI
  - Vector SVG export with metadata
  - Multi-diagram layout sheets (side-by-side, stacked, grid)
  - HTML report generation
  - Quality verification and recommendations
  - Browser canvas size limit handling (16384px)
- **Key Classes**: `HighResolutionExporter`
- **Export Formats**:
  - `png`: High-DPI raster (default 300 DPI)
  - `svg`: Vector format (lossless)
  - `layout`: Combined plan + isometric
  - `report`: HTML + diagrams with metrics

#### 6. **DiagramSystemIntegration.js**
- **Purpose**: Unified API for all diagram operations
- **Features**:
  - Single-point initialization
  - Coordinated module management
  - Consistent API for generation, rendering, export
  - Metric calculation and reporting
  - State caching for performance
- **Key Classes**: `DiagramSystemIntegration`
- **Key Methods**:
  - `generateDiagrams(lotFeature, analysis, map)` - Create both diagrams
  - `renderPlanDiagram(svgElement, container)` - Display in DOM
  - `renderIsometricDiagram(svgElement, container)` - Display in DOM
  - `exportDiagrams(options)` - Export in multiple formats
  - `verifyExportQuality(dpi)` - Quality check
  - `getDiagramMetrics()` - Get analysis metrics

## Integration with app.js

### Initialization
```javascript
diagramSystem = new DiagramSystemIntegration({
  mapboxMap: map,
  enableStreetDetection: true,
  enableHighResExport: true,
  defaultExportDpi: 300,
  planRendererOptions: { ... },
  isoRendererOptions: { ... },
  exporterOptions: { ... },
});
```

### Rendering
```javascript
// Generate both diagrams
const result = await diagramSystem.generateDiagrams(
  lotFeature,
  analysisData,
  map
);

// Render to DOM
diagramSystem.renderPlanDiagram(result.planSvg, containerElement);
diagramSystem.renderIsometricDiagram(result.isoSvg, containerElement);
```

### Export
```javascript
// Export as high-resolution PNG
const result = await diagramSystem.exportDiagrams({
  format: 'layout',  // 'png', 'svg', 'layout', 'report'
  filename: 'zoning-study.png',
  dpi: 300,
  layout: 'side-by-side',
});
```

## Visual Design

### Line Hierarchy (Design System)
```
Property line:        2.8-3.2 pt (primary boundary)
Existing building:    2.4-2.8 pt + hatch
Zoning envelope:      2.0-2.8 pt (color-coded)
Dimension line:       1.2-1.6 pt
Extension line:       1.2 pt
Street edge:          2.8 pt + dash pattern
Hidden lines:         1.2 pt + dash + lower opacity
```

### Color Palette
```
Property line:        #111827 (dark gray)
Existing building:    #6b7280 (medium gray)
FAR massing:          #16a34a (green)
FAR capped:           #b91c1c (red warning)
Max envelope:         #1f7a4d (dark green)
Dimensions:           #9ca3af (light gray)
Dimension text:       #4b5563 (medium gray)
Street edge:          #374151 (dark gray dashed)
Hatch lines:          #d1d5db (light gray)
Background:           #ffffff (white)
```

### Spacing & Layout
```
SVG canvas:           2400×1560 px (16:10 aspect)
Padding:              180 px margins
Dimension spacing:    120 px between offset bands
Exploded spacing:     150 px between isometric layers
Min geometry offset:  80 px from geometry
Max offset distance:  600 px from geometry
```

## Dimension System

### Placement Algorithm
1. **Prioritization**: Sort dimensions by priority (0 = highest)
2. **Offset Calculation**: Start with minimum offset from geometry
3. **Collision Detection**: Check for intersections with:
   - Geometry bounding boxes
   - Previously placed dimension text
   - Previously placed dimension lines
4. **Incremental Offset**: If collision detected, increment offset by step
5. **Label Rendering**: Draw dimension with:
   - Extension lines (thin)
   - Dimension line (medium)
   - Ticks at endpoints
   - White-background text label
   - Centered alignment

### Dimension Hierarchy
```
Tier 0 (Primary):    Lot width, lot depth
Tier 1 (Secondary):  Front yard, rear yard, side yard
Tier 2 (Tertiary):   Street setback, special dimensions
```

## Street Detection

### Detection Strategies (in order of preference)
1. **Property-based** (0.9 confidence)
   - Uses `front_direction` property from feature
   - Most reliable if data is available

2. **Mapbox Roads** (0.85 confidence)
   - Query Mapbox for nearby road centerlines
   - Find lot edge closest to road
   - Requires Mapbox API access

3. **Centroid-based** (0.7 confidence)
   - Calculate lot centroid
   - Find edge farthest from centroid
   - Assumes front edge faces outward

4. **Fallback** (0.5 confidence)
   - Use first edge of lot ring
   - Least reliable but always available

### Orientation Labels
- **FRONT YARD**: Edge nearest to street (or first edge)
- **REAR YARD**: Opposite edge (~180° from front)
- **SIDE YARD**: Perpendicular edges (left/right)

## Export Quality Guidelines

### Recommended Export Settings

| Use Case | Format | DPI | Canvas Max | Notes |
|----------|--------|-----|-----------|-------|
| Screen preview | PNG | 96 | Small | Fast, lower quality |
| Print draft | PNG | 150 | Medium | Good for review |
| Print standard | PNG | 200-300 | Large | Professional output |
| Archive/Archival | PNG | 600 | Maximum | High file size |
| Vector (lossless) | SVG | N/A | Unlimited | Best for CAD import |
| Report | HTML+PNG | 300 | Large | Multi-page capable |

### Quality Verification
```javascript
const quality = diagramSystem.verifyExportQuality(300);
// Returns: { valid, warnings[], info[], recommendations[] }
```

Common warnings:
- DPI < 150: May appear pixelated
- DPI > 600: File size very large
- Export size > browser limit: Split into multiple files

## Geometry Requirements

### Input Geometry Format
```javascript
{
  lot: [[lng, lat], [lng, lat], ...],              // Closed ring
  existing: [[lng, lat], [lng, lat], ...] || [],   // Optional
  buildable: [[lng, lat], [lng, lat], ...] || [],  // Optional
  farFootprint: [[lng, lat], [lng, lat], ...] || [], // Optional
  maxBuildable: [[lng, lat], [lng, lat], ...] || [], // Optional
}
```

### Analysis Data Requirements
```javascript
{
  lotArea: number,                // in square feet
  buildableArea: number,          // in square feet
  farFootprintArea: number,       // in square feet
  existingHeightFt: number,       // in feet
  farHeight: number,              // in feet
  maxHeight: number,              // in feet
  coverage: number,               // percentage (0-100)
  isCapped: boolean,              // Is FAR height capped by max height?
  controls: {
    frontYardFt: number,
    rearYardFt: number,
    sideYardFt: number,
  }
}
```

## Performance Considerations

### Rendering Performance
- SVG rendering is CPU-bound (native browser rendering)
- Typical diagram generation: < 100ms
- Export to PNG (300 DPI): 500-1000ms depending on browser
- Complex geometries (100+ vertices): May need optimization

### Memory Usage
- SVG diagrams: ~1-5 MB (DOM nodes)
- Canvas rendering buffer (300 DPI, 2400×1560): ~20-30 MB
- Exported PNG files: 2-10 MB depending on complexity

### Optimization Tips
1. Cache geometry transformations
2. Reuse SVG patterns instead of duplicating
3. Use requestAnimationFrame for animation
4. Dispose unused Three.js resources
5. Limit precision to 1-2 decimal places in SVG paths

## Troubleshooting

### Common Issues

**Issue**: Diagrams appear blurry or pixelated
- **Solution**: Check SVG viewBox is correct, verify DPI export setting

**Issue**: Dimensions overlap geometry or each other
- **Solution**: Verify collision detection is enabled, increase dimension spacing

**Issue**: Export fails with "canvas size exceeds maximum"
- **Solution**: Reduce DPI or reduce SVG size, split export into multiple files

**Issue**: Street edge not detected correctly
- **Solution**: Check Mapbox token, verify lot geometry is valid, try property-based detection

**Issue**: Text appears upside-down or rotated incorrectly
- **Solution**: Check SVG coordinate system, verify text-anchor attributes

## Future Enhancements

1. **3D WebGL Rendering**: Replace SVG isometric with Three.js for interactivity
2. **Advanced Hatching**: Configurable patterns, angle, density
3. **Dimension Annotations**: Notes, references, leader lines
4. **Multi-lot Comparisons**: Side-by-side zoning analysis
5. **PDF Export**: Direct PDF generation without browser
6. **Animation**: Stepped construction sequences, phasing plans
7. **Building Information**: Link to BIM/LOD models
8. **Performance**: GPU-accelerated rendering for large datasets

## API Reference Summary

### ArchitecturalDiagramRenderer
```javascript
const renderer = new ArchitecturalDiagramRenderer(options);
renderer.createPlanDiagram(geometry, analysis, streetInfo) → SVGElement
renderer.exportToPNG(svgElement, filename, dpi) → Promise
renderer.exportToSVG(svgElement, filename) → void
```

### ArchitecturalIsometricRenderer
```javascript
const renderer = new ArchitecturalIsometricRenderer(options);
renderer.createIsometricDiagram(geometry, analysis, streetInfo) → SVGElement
```

### StreetDetectionAndOrientation
```javascript
const detector = new StreetDetectionAndOrientation(mapboxMap);
await detector.detectStreetEdge(lotFeature, map) → {edgePoints, edgeName, confidence}
detector.getOrientationLabels(lotFeature, streetEdge) → [{type, position}]
detector.generateStreetGraphic(streetEdge) → {edgePoints, edgeName, direction}
detector.addOrientationGraphics(svgElement, bearing, scale) → void
```

### IntelligentDimensionPlacement
```javascript
const placer = new IntelligentDimensionPlacement(options);
placer.placeDimensions(dimensions, geometryRings, bounds) → [{...offset...}]
placer.getDimensionDrawInstructions(placement) → {extensionLines, dimensionLine, ticks, label}
```

### HighResolutionExporter
```javascript
const exporter = new HighResolutionExporter(options);
await exporter.exportDiagramPNG(svgElement, options) → Promise
exporter.exportDiagramSVG(svgElement, options) → void
await exporter.exportDiagramLayout(diagrams, options) → Promise
await exporter.exportAnalysisReport(planSvg, isoSvg, analysis, options) → Promise
exporter.verifyExportQuality(dpi) → {valid, warnings[], info[], recommendations[]}
```

### DiagramSystemIntegration
```javascript
const system = new DiagramSystemIntegration(options);
await system.generateDiagrams(lotFeature, analysis, map) → {success, planSvg, isoSvg}
system.renderPlanDiagram(svg, containerElement) → boolean
system.renderIsometricDiagram(svg, containerElement) → boolean
await system.exportDiagrams(options) → {success, result}
system.verifyExportQuality(dpi) → {valid, warnings[], recommendations[]}
system.getDiagramMetrics() → {area, height, coverage, ...}
```

---

**Version**: 1.0  
**Last Updated**: 2026-05-05  
**Status**: Production-ready
