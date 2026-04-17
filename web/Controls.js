// Controls.js
// Top control bar: neighborhood selection, toggle buttons

export function renderControls({ neighborhoods, onNeighborhoodChange, onToggleBuildings, onToggleEnvelope }) {
  const container = document.getElementById('top-controls');
  if (!container) return;
  container.innerHTML = '';

  // Neighborhood dropdown
  const select = document.createElement('select');
  select.id = 'neighborhood-select';
  select.style.marginRight = '1em';
  neighborhoods.forEach(n => {
    const opt = document.createElement('option');
    opt.value = n.name;
    opt.textContent = n.name;
    select.appendChild(opt);
  });
  select.addEventListener('change', e => {
    if (onNeighborhoodChange) onNeighborhoodChange(e.target.value);
  });

  // Toggle buttons
  const btnBuildings = document.createElement('button');
  btnBuildings.textContent = 'Show Existing Buildings';
  btnBuildings.id = 'btn-buildings';
  btnBuildings.style.marginRight = '0.5em';
  btnBuildings.onclick = () => {
    btnBuildings.classList.toggle('active');
    if (onToggleBuildings) onToggleBuildings(btnBuildings.classList.contains('active'));
  };

  const btnEnvelope = document.createElement('button');
  btnEnvelope.textContent = 'Show Zoning Envelope';
  btnEnvelope.id = 'btn-envelope';
  btnEnvelope.onclick = () => {
    btnEnvelope.classList.toggle('active');
    if (onToggleEnvelope) onToggleEnvelope(btnEnvelope.classList.contains('active'));
  };

  // Title
  const title = document.createElement('span');
  title.textContent = 'NYC Zoning Envelope Explorer';
  title.style.fontWeight = 'bold';
  title.style.marginRight = '2em';

  container.appendChild(title);
  container.appendChild(select);
  container.appendChild(btnBuildings);
  container.appendChild(btnEnvelope);
}
