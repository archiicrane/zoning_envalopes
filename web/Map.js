// Map.js
// Handles Mapbox map initialization, layer management, and feature selection

let map = null;
let lotLayerId = 'selected-lot';
let envelopeLayerId = 'envelope-fill';
let neighborhoodLayerId = 'neighborhood-boundary';

export function initMap(containerId, onLotSelect, onNeighborhoodSelect) {
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
