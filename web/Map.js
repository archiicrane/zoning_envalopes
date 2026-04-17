// Add PLUTO source and extrusion layers
export function addPlutoLayers(far) {
  if (!map.getSource('pluto')) {
    map.addSource('pluto', {
      type: 'geojson',
      data: '/pluto.geojson', // Now served from public directory
    });
  }
  // Existing buildings extrusion
  if (!map.getLayer('pluto-buildings')) {
    map.addLayer({
      id: 'pluto-buildings',
      type: 'fill-extrusion',
      source: 'pluto',
      paint: {
        'fill-extrusion-color': [
          'case',
          ['boolean', ['feature-state', 'active'], false], '#22c55e', // green highlight
          '#888'
        ],
        'fill-extrusion-height': [
          '*',
          ['coalesce', ['get', 'numfloors'], 3],
          3.2
        ],
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': 0.7,
      },
      layout: { visibility: 'none' },
    });
  }
  // Zoning envelope extrusion
  if (!map.getLayer('pluto-envelope')) {
    map.addLayer({
      id: 'pluto-envelope',
      type: 'fill-extrusion',
      source: 'pluto',
      paint: {
        'fill-extrusion-color': [
          'case',
          ['boolean', ['feature-state', 'active'], false], '#a21caf', // purple highlight
          '#6366f1'
        ],
        'fill-extrusion-height': [
          'coalesce',
          ['*', ['coalesce', ['get', 'maxfar'], 3], ['get', 'lotarea'], 0.1],
          30
        ],
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': 0.5,
      },
      layout: { visibility: 'none' },
    });
  }
  // Set initial FAR for envelope
  updatePlutoEnvelopeFAR(far);
}

// Update zoning envelope extrusion height with new FAR
export function updatePlutoEnvelopeFAR(far) {
  if (!map || !map.getLayer('pluto-envelope')) return;
  map.setPaintProperty(
    'pluto-envelope',
    'fill-extrusion-height',
    [
      'coalesce',
      ['*', far, ['get', 'lotarea'], 0.1],
      30
    ]
  );
}
// Utility to show/hide a layer by id
export function setLayerVisibility(layerId, visible) {
  if (!map) return;
  if (!map.getLayer(layerId)) return;
  map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
}
// Map.js
// Handles Mapbox map initialization, layer management, and feature selection

let map = null;
let lotLayerId = 'selected-lot';
let envelopeLayerId = 'envelope-fill';
let neighborhoodLayerId = 'neighborhood-boundary';

export function initMap(containerId, token, onLotSelect, onNeighborhoodSelect) {
  mapboxgl.accessToken = token;
  map = new mapboxgl.Map({
    container: containerId,
    style: 'mapbox://styles/mapbox/light-v11',
    center: [-73.989358, 40.678785],
    zoom: 12,
    pitch: 50,
    bearing: -17,
    antialias: true,
  });

  map.on('load', () => {
    // Add PLUTO layers
    addPlutoLayers(3.0);
    // Add empty sources for lots, envelopes, neighborhoods
    if (!map.getSource(lotLayerId)) {
      map.addSource(lotLayerId, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: lotLayerId,
        type: 'fill',
        source: lotLayerId,
        paint: {
          'fill-color': '#ffe066',
          'fill-opacity': 0.5,
        },
      });
    }
    if (!map.getSource(envelopeLayerId)) {
      map.addSource(envelopeLayerId, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: envelopeLayerId,
        type: 'fill-extrusion',
        source: envelopeLayerId,
        paint: {
          'fill-extrusion-color': '#6366f1',
          'fill-extrusion-opacity': 0.4,
          'fill-extrusion-height': ['get', 'height'],
        },
      });
    }
    if (!map.getSource(neighborhoodLayerId)) {
      map.addSource(neighborhoodLayerId, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: neighborhoodLayerId,
        type: 'line',
        source: neighborhoodLayerId,
        paint: {
          'line-color': '#0ea5e9',
          'line-width': 3,
        },
      });
    }

    // Add Mapbox 3D buildings layer if not present
    if (!map.getLayer('3d-buildings')) {
      map.addLayer(
        {
          id: '3d-buildings',
          source: 'composite',
          'source-layer': 'building',
          filter: ['==', 'extrude', 'true'],
          type: 'fill-extrusion',
          minzoom: 15,
          paint: {
            'fill-extrusion-color': '#aaa',
            'fill-extrusion-height': [
              'interpolate',
              ['linear'],
              ['zoom'],
              15,
              0,
              15.05,
              ['get', 'height']
            ],
            'fill-extrusion-base': [
              'interpolate',
              ['linear'],
              ['zoom'],
              15,
              0,
              15.05,
              ['get', 'min_height']
            ],
            'fill-extrusion-opacity': 0.6
          }
        },
        'waterway-label'
      );
    }

    // Click to select lot (placeholder: emits null)
    map.on('click', (ev) => {
      // TODO: Query rendered features for lot selection
      if (onLotSelect) onLotSelect(null);
    });
  });

  return map;
}

export function updateNeighborhood(neighborhoodGeoJSON) {
  if (map && map.getSource(neighborhoodLayerId)) {
    map.getSource(neighborhoodLayerId).setData(neighborhoodGeoJSON);
    // Zoom to neighborhood
    const features = neighborhoodGeoJSON.features || [];
    if (features.length > 0) {
      const bbox = turf.bbox(neighborhoodGeoJSON);
      map.fitBounds(bbox, { padding: 40, duration: 800 });
    }
  }
}

export function updateEnvelopeHeight(lotId, height) {
  // This would update the height property for a given lot in the envelope source
  // (Assumes envelope GeoJSON has a unique lotId property)
  if (!map || !map.getSource(envelopeLayerId)) return;
  const src = map.getSource(envelopeLayerId);
  const data = src._data || src._options?.data;
  if (!data) return;
  const updated = {
    ...data,
    features: data.features.map(f =>
      f.properties.lotId === lotId ? { ...f, properties: { ...f.properties, height } } : f
    ),
  };
  src.setData(updated);
}
