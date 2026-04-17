
// main.js
// Entry point for modular NYC Zoning Envelope Explorer
import { initMap, updateNeighborhood, updateEnvelopeHeight, setLayerVisibility } from './Map.js';
import { renderControls } from './Controls.js';
import { renderSliderPanel } from './SliderPanel.js';
import { renderLotInfoCard } from './LotInfoCard.js';

// --- App State ---
let neighborhoods = [];
let selectedNeighborhood = null;
let selectedLot = null;
let far = 3.0;
let maxFar = 10.0;
let useType = 'market_rate';

async function fetchNeighborhoods() {
  // Placeholder: Replace with real API or static GeoJSON fetch
  // Example: [{ name: 'Bensonhurst, Brooklyn', geojson: {...} }, ...]
  return [
    { name: 'Bensonhurst, Brooklyn', geojson: { type: 'FeatureCollection', features: [] } },
    { name: 'Astoria, Queens', geojson: { type: 'FeatureCollection', features: [] } },
    { name: 'Harlem, Manhattan', geojson: { type: 'FeatureCollection', features: [] } },
  ];
}

async function bootstrap() {
  // 1. Resolve Mapbox token
  let token;
  try {
    token = await (async function resolveMapboxToken() {
      const local = (window.APP_CONFIG && window.APP_CONFIG.mapboxToken) || "";
      if (local && !local.includes("YOUR_MAPBOX")) return local;
      try {
        const res = await fetch("/api/config");
        if (res.ok) {
          const cfg = await res.json();
          const token = (cfg && cfg.mapboxToken) || "";
          if (token) return token;
        }
      } catch {}
      // Fallback for local dev: put your token here if needed
      return "YOUR_MAPBOX_TOKEN_HERE";
    })();
  } catch (err) {
    alert(String(err));
    return;
  }
  console.log("Mapbox token:", token);

  // 2. Load neighborhoods
  neighborhoods = await fetchNeighborhoods();
  selectedNeighborhood = neighborhoods[0];

  // 3. Initialize Map
  const map = initMap('map', token, onLotSelect, onNeighborhoodSelect);

  // 4. Render Controls
  renderControls({
    neighborhoods,
    onNeighborhoodChange: (name) => {
      selectedNeighborhood = neighborhoods.find(n => n.name === name);
      updateNeighborhood(selectedNeighborhood.geojson);
    },
    onToggleBuildings: (show) => {
      setLayerVisibility('3d-buildings', show);
    },
    onToggleEnvelope: (show) => {
      setLayerVisibility('envelope-fill', show);
    },
  });

  // 5. Render Slider Panel
  renderSliderPanel({
    far,
    maxFar,
    useType,
    onFarChange: (val) => {
      far = val;
      // TODO: update envelope height for all lots in view
      if (selectedLot) updateEnvelopeHeight(selectedLot.id, computeEnvelopeHeight(far, selectedLot.lot_area, selectedLot.coverage));
    },
    onUseTypeChange: (val) => {
      useType = val;
      // TODO: update envelope color/type
    },
  });

  // 6. Render Lot Info Card (hidden by default)
  renderLotInfoCard({
    lot: selectedLot,
    onFarChange: (val) => {
      far = val;
      if (selectedLot) updateEnvelopeHeight(selectedLot.id, computeEnvelopeHeight(far, selectedLot.lot_area, selectedLot.coverage));
    },
    onUseTypeChange: (val) => {
      useType = val;
    },
    onApplyToLot: () => {
      // TODO: Apply current FAR/useType to selected lot only
    },
    onApplyToNeighborhood: () => {
      // TODO: Apply current FAR/useType to all lots in neighborhood
    },
  });

  // --- Event Handlers ---
  function onLotSelect(lot) {
    selectedLot = lot;
    renderLotInfoCard({
      lot: selectedLot,
      onFarChange: (val) => {
        far = val;
        if (selectedLot) updateEnvelopeHeight(selectedLot.id, computeEnvelopeHeight(far, selectedLot.lot_area, selectedLot.coverage));
      },
      onUseTypeChange: (val) => {
        useType = val;
      },
      onApplyToLot: () => {
        // TODO: Apply current FAR/useType to selected lot only
      },
      onApplyToNeighborhood: () => {
        // TODO: Apply current FAR/useType to all lots in neighborhood
      },
    });
  }
  function onNeighborhoodSelect(name) {
    selectedNeighborhood = neighborhoods.find(n => n.name === name);
    updateNeighborhood(selectedNeighborhood.geojson);
  }
}

function computeEnvelopeHeight(FAR, lotArea, coverage) {
  // height = (FAR * lot_area) / lot_coverage
  if (!FAR || !lotArea || !coverage) return 0;
  return (FAR * lotArea) / coverage;
}

bootstrap();
