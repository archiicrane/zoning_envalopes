// LotInfoCard.js
// Floating card for selected lot info and controls

export function renderLotInfoCard({ lot, onFarChange, onUseTypeChange, onApplyToLot, onApplyToNeighborhood }) {
  const container = document.getElementById('lot-info-card');
  if (!container) return;
  container.innerHTML = '';
  container.style.position = 'fixed';
  container.style.top = '80px';
  container.style.right = '30px';
  container.style.minWidth = '260px';
  container.style.background = 'white';
  container.style.border = '1px solid #ddd';
  container.style.borderRadius = '8px';
  container.style.boxShadow = '0 2px 8px rgba(0,0,0,0.08)';
  container.style.padding = '1em';
  container.style.zIndex = '20';
  container.style.display = lot ? 'block' : 'none';

  if (!lot) return;

  // Lot info
  const title = document.createElement('div');
  title.textContent = `Selected Lot`;
  title.style.fontWeight = 'bold';
  title.style.marginBottom = '0.5em';

  const info = document.createElement('div');
  info.innerHTML = `
    <div><b>Zoning District:</b> ${lot.zoning || 'N/A'}</div>
    <div><b>Current FAR:</b> ${lot.far || 'N/A'}</div>
    <div><b>Lot Area:</b> ${lot.lot_area ? lot.lot_area.toLocaleString() + ' sq ft' : 'N/A'}</div>
  `;
  info.style.marginBottom = '0.5em';

  // Local FAR slider
  const farLabel = document.createElement('label');
  farLabel.textContent = 'Adjust FAR:';
  farLabel.style.marginRight = '0.5em';

  const farInput = document.createElement('input');
  farInput.type = 'range';
  farInput.min = 0;
  farInput.max = lot.max_far || 10;
  farInput.step = 0.01;
  farInput.value = lot.far || 3.0;
  farInput.style.width = '120px';

  const farVal = document.createElement('span');
  farVal.textContent = farInput.value;
  farInput.oninput = (e) => {
    farVal.textContent = Number(e.target.value).toFixed(2);
    if (onFarChange) onFarChange(Number(e.target.value));
  };

  // Use type toggle
  const useTypeLabel = document.createElement('label');
  useTypeLabel.textContent = 'Type:';
  useTypeLabel.style.margin = '0 0.5em 0 1em';

  const useTypeToggle = document.createElement('select');
  useTypeToggle.innerHTML = `
    <option value="market_rate">Market Rate</option>
    <option value="affordable">Affordable</option>
  `;
  useTypeToggle.value = lot.use_type || 'market_rate';
  useTypeToggle.onchange = (e) => {
    if (onUseTypeChange) onUseTypeChange(e.target.value);
  };

  // Apply buttons
  const btnApplyLot = document.createElement('button');
  btnApplyLot.textContent = 'Apply to Selected Lot';
  btnApplyLot.style.margin = '1em 0.5em 0 0';
  btnApplyLot.onclick = () => { if (onApplyToLot) onApplyToLot(); };

  const btnApplyNeighborhood = document.createElement('button');
  btnApplyNeighborhood.textContent = 'Apply to Entire Neighborhood';
  btnApplyNeighborhood.onclick = () => { if (onApplyToNeighborhood) onApplyToNeighborhood(); };

  // Assemble
  container.appendChild(title);
  container.appendChild(info);
  container.appendChild(farLabel);
  container.appendChild(farInput);
  container.appendChild(farVal);
  container.appendChild(useTypeLabel);
  container.appendChild(useTypeToggle);
  container.appendChild(document.createElement('br'));
  container.appendChild(btnApplyLot);
  container.appendChild(btnApplyNeighborhood);
}
