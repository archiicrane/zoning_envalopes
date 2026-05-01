/**
 * proposalUpload.js
 * Manages 3D proposal model upload, BBL assignment, and metadata.
 * Renders GLB/GLTF models as custom Mapbox layers using Three.js.
 */

/**
 * Default metadata for a new proposal
 */
export function defaultProposalMetadata() {
  return {
    projectName: "",
    applicant: "",
    description: "",
    proposedUse: "residential",
    proposedFar: null,
    proposedHeightFt: null,
    numUnits: null,
    publicNotes: "",
    bbls: [],
    modelFile: null,
    modelUrl: null,
    savedAt: null,
    id: null,
  };
}

/**
 * Validate proposal metadata before saving.
 * Returns { valid: boolean, errors: string[] }
 */
export function validateProposalMetadata(meta) {
  const errors = [];
  if (!meta.projectName || !meta.projectName.trim()) {
    errors.push("Project name is required.");
  }
  if (!meta.bbls || !meta.bbls.length) {
    errors.push("At least one BBL must be assigned.");
  }
  if (!meta.modelFile && !meta.modelUrl) {
    errors.push("A 3D model file (.glb or .gltf) is required.");
  }
  if (meta.modelFile) {
    const ext = meta.modelFile.name?.split(".").pop()?.toLowerCase();
    if (!["glb", "gltf"].includes(ext)) {
      errors.push("Model file must be .glb or .gltf format.");
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Creates a proposal object from form data and a file input.
 * Generates a local object URL for the model.
 */
export function createProposalFromForm(formData, modelFile) {
  const id = `proposal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let modelUrl = null;
  if (modelFile) {
    modelUrl = URL.createObjectURL(modelFile);
  }
  return {
    ...defaultProposalMetadata(),
    ...formData,
    modelFile,
    modelUrl,
    id,
    savedAt: new Date().toISOString(),
  };
}

/**
 * Saves a proposal to localStorage (client-side persistence).
 * Strips the model File object since it can't be serialized.
 */
export function saveProposalToLocal(proposal) {
  const key = "zoning_proposals";
  const existing = loadProposalsFromLocal();
  const serializable = { ...proposal, modelFile: null };
  const updated = [...existing.filter((p) => p.id !== proposal.id), serializable];
  try {
    localStorage.setItem(key, JSON.stringify(updated));
    return true;
  } catch (_err) {
    return false;
  }
}

/**
 * Loads all proposals from localStorage.
 */
export function loadProposalsFromLocal() {
  try {
    const raw = localStorage.getItem("zoning_proposals");
    return raw ? JSON.parse(raw) : [];
  } catch (_err) {
    return [];
  }
}

/**
 * Removes a proposal by id from localStorage.
 */
export function deleteProposalFromLocal(id) {
  const key = "zoning_proposals";
  const existing = loadProposalsFromLocal();
  localStorage.setItem(key, JSON.stringify(existing.filter((p) => p.id !== id)));
}

/**
 * Renders a proposal upload form HTML string.
 * The caller is responsible for wiring up event listeners.
 */
export function renderProposalUploadFormHTML() {
  return `
    <div class="proposal-form">
      <h3 class="proposal-form__title">Upload Proposed Building</h3>

      <div class="proposal-form__section">
        <label>BBLs (comma-separated)</label>
        <input type="text" id="pf-bbls" placeholder="e.g. 3009810001, 3009810002" />
      </div>

      <div class="proposal-form__section">
        <label>3D Model File (.glb or .gltf)</label>
        <input type="file" id="pf-model-file" accept=".glb,.gltf" />
        <span class="proposal-form__hint">Upload a GLB or GLTF file. Model should be positioned at origin (0,0,0).</span>
      </div>

      <div class="proposal-form__section">
        <label>Project Name *</label>
        <input type="text" id="pf-name" placeholder="e.g. 123 Main Street Residential" />
      </div>

      <div class="proposal-form__section">
        <label>Applicant / Designer</label>
        <input type="text" id="pf-applicant" placeholder="Architect or developer name" />
      </div>

      <div class="proposal-form__section">
        <label>Description</label>
        <textarea id="pf-description" rows="2" placeholder="Brief description of the proposal..."></textarea>
      </div>

      <div class="proposal-form__section proposal-form__grid-2">
        <div>
          <label>Proposed Use</label>
          <select id="pf-use">
            <option value="residential">Residential</option>
            <option value="commercial">Commercial</option>
            <option value="mixed">Mixed Use</option>
            <option value="community">Community Facility</option>
            <option value="industrial">Industrial</option>
          </select>
        </div>
        <div>
          <label>Proposed FAR</label>
          <input type="number" id="pf-far" min="0.1" max="25" step="0.1" placeholder="e.g. 3.5" />
        </div>
      </div>

      <div class="proposal-form__section proposal-form__grid-2">
        <div>
          <label>Proposed Height (ft)</label>
          <input type="number" id="pf-height" min="10" step="1" placeholder="e.g. 65" />
        </div>
        <div>
          <label>Number of Units</label>
          <input type="number" id="pf-units" min="0" step="1" placeholder="Residential units" />
        </div>
      </div>

      <div class="proposal-form__section">
        <label>Public Notes</label>
        <textarea id="pf-notes" rows="2" placeholder="Notes for public review..."></textarea>
      </div>

      <div class="proposal-form__errors" id="pf-errors" style="display:none;"></div>

      <div class="proposal-form__actions">
        <button type="button" id="pf-submit" class="bar-btn">Place Proposal on Map</button>
        <button type="button" id="pf-cancel" class="bar-btn bar-btn--secondary">Cancel</button>
      </div>
    </div>
  `;
}

/**
 * Reads form values from the upload form DOM elements.
 * Returns a partial metadata object.
 */
export function readProposalFormValues() {
  const bblsRaw = document.getElementById("pf-bbls")?.value || "";
  const bbls = bblsRaw
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean);

  return {
    projectName: document.getElementById("pf-name")?.value?.trim() || "",
    applicant: document.getElementById("pf-applicant")?.value?.trim() || "",
    description: document.getElementById("pf-description")?.value?.trim() || "",
    proposedUse: document.getElementById("pf-use")?.value || "residential",
    proposedFar: parseFloat(document.getElementById("pf-far")?.value) || null,
    proposedHeightFt: parseFloat(document.getElementById("pf-height")?.value) || null,
    numUnits: parseInt(document.getElementById("pf-units")?.value, 10) || null,
    publicNotes: document.getElementById("pf-notes")?.value?.trim() || "",
    bbls,
  };
}
