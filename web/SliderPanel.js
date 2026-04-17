// SliderPanel.js
// Bottom slider panel for FAR and use type

export function renderSliderPanel({ far, maxFar, useType, onFarChange, onUseTypeChange }) {
  const container = document.getElementById('slider-panel');
  if (!container) return;
  container.innerHTML = '';
  container.style.display = 'flex';
  container.style.alignItems = 'center';
  container.style.justifyContent = 'center';
  container.style.padding = '1em';
  container.style.background = 'rgba(255,255,255,0.95)';
  container.style.position = 'fixed';
  container.style.bottom = '0';
  container.style.left = '0';
  container.style.width = '100vw';
  container.style.zIndex = '10';

  // FAR slider
  const farLabel = document.createElement('label');
  farLabel.textContent = 'Density (Floor Area Ratio)';
  farLabel.title = 'This controls how much total building area is allowed';
  farLabel.style.marginRight = '0.5em';

  const farValue = document.createElement('span');
  farValue.textContent = far.toFixed(2);
  farValue.style.margin = '0 0.5em';

  const farSlider = document.createElement('input');
  farSlider.type = 'range';
  farSlider.min = 0;
  farSlider.max = maxFar;
  farSlider.step = 0.01;
  farSlider.value = far;
  farSlider.style.width = '200px';
  farSlider.oninput = (e) => {
    farValue.textContent = Number(e.target.value).toFixed(2);
    if (onFarChange) onFarChange(Number(e.target.value));
  };

  // Use type toggle
  const useTypeLabel = document.createElement('label');
  useTypeLabel.textContent = 'Housing Type:';
  useTypeLabel.style.margin = '0 1em 0 2em';

  const useTypeToggle = document.createElement('select');
  useTypeToggle.innerHTML = `
    <option value="market_rate">Market Rate</option>
    <option value="affordable">Affordable</option>
  `;
  useTypeToggle.value = useType;
  useTypeToggle.onchange = (e) => {
    if (onUseTypeChange) onUseTypeChange(e.target.value);
  };

  container.appendChild(farLabel);
  container.appendChild(farSlider);
  container.appendChild(farValue);
  container.appendChild(useTypeLabel);
  container.appendChild(useTypeToggle);
}
