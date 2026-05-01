/**
 * proposalAnalysis.js
 * Computes comparison metrics between an uploaded proposal,
 * the existing building, max zoning envelope, and FAR envelope.
 */

/**
 * Status codes for proposal compliance.
 */
export const COMPLIANCE = {
  EXCEEDS_ENVELOPE: "exceeds_envelope",  // red
  EXCEEDS_FAR: "exceeds_far",           // orange
  FITS: "fits",                          // green
  UNKNOWN: "unknown",                    // no data
};

/**
 * Compute a compliance status given the proposed values vs allowed.
 * @param {{ proposedHeightFt, proposedFar, maxAllowedHeightFt, maxAllowedFar }} params
 * @returns {{ heightStatus, farStatus, overallStatus, color }}
 */
export function computeComplianceStatus({ proposedHeightFt, proposedFar, maxAllowedHeightFt, maxAllowedFar }) {
  let heightStatus = COMPLIANCE.UNKNOWN;
  let farStatus = COMPLIANCE.UNKNOWN;

  if (proposedHeightFt != null && maxAllowedHeightFt != null) {
    heightStatus = proposedHeightFt > maxAllowedHeightFt ? COMPLIANCE.EXCEEDS_ENVELOPE : COMPLIANCE.FITS;
  }
  if (proposedFar != null && maxAllowedFar != null) {
    farStatus = proposedFar > maxAllowedFar ? COMPLIANCE.EXCEEDS_FAR : COMPLIANCE.FITS;
  }

  let overallStatus = COMPLIANCE.UNKNOWN;
  if (heightStatus === COMPLIANCE.EXCEEDS_ENVELOPE) {
    overallStatus = COMPLIANCE.EXCEEDS_ENVELOPE;
  } else if (farStatus === COMPLIANCE.EXCEEDS_FAR) {
    overallStatus = COMPLIANCE.EXCEEDS_FAR;
  } else if (heightStatus === COMPLIANCE.FITS || farStatus === COMPLIANCE.FITS) {
    overallStatus = COMPLIANCE.FITS;
  }

  const colorMap = {
    [COMPLIANCE.EXCEEDS_ENVELOPE]: "#dc2626",
    [COMPLIANCE.EXCEEDS_FAR]: "#f97316",
    [COMPLIANCE.FITS]: "#16a34a",
    [COMPLIANCE.UNKNOWN]: "#94a3b8",
  };

  return { heightStatus, farStatus, overallStatus, color: colorMap[overallStatus] };
}

/**
 * Compute full comparison metrics between proposal and existing/envelope data.
 *
 * @param {object} params
 * @param {object} params.proposal - Proposal metadata from proposalUpload
 * @param {object} params.lotData - Lot analysis data (from buildClientLotData)
 * @param {object} params.envelopeResults - Results from /api/envelope
 * @param {object} params.zoningControls - Controls from getControlsForLot
 * @returns {object} Full metrics object
 */
export function computeProposalMetrics({ proposal, lotData, envelopeResults, zoningControls }) {
  const study = envelopeResults?.zoning_buildability_study || {};
  const zoning = envelopeResults?.zoning_analysis || lotData?.zoning_analysis || {};

  const lotAreaFt2 = study.lot_area_ft2 || 0;
  const maxAllowedFar = zoning.base_far || zoningControls?.far || null;
  const maxAllowedHeightFt = study.envelope_height_ft || zoningControls?.maxBuildingHeight || null;
  const maxAllowedFloorAreaFt2 = study.allowable_floor_area_ft2 || (maxAllowedFar && lotAreaFt2 ? maxAllowedFar * lotAreaFt2 : null);
  const existingHeightFt = (lotData?.numfloors || 1) * 10;
  const existingFar = lotData?.built_far || 0;

  const proposedFar = proposal.proposedFar;
  const proposedHeightFt = proposal.proposedHeightFt;
  const proposedFloorAreaFt2 = proposedFar && lotAreaFt2 ? proposedFar * lotAreaFt2 : null;

  const floorAreaDiffFt2 =
    proposedFloorAreaFt2 != null && maxAllowedFloorAreaFt2 != null
      ? proposedFloorAreaFt2 - maxAllowedFloorAreaFt2
      : null;

  const pctOfMaxEnvelope =
    proposedHeightFt != null && maxAllowedHeightFt != null && maxAllowedHeightFt > 0
      ? Math.round((proposedHeightFt / maxAllowedHeightFt) * 100)
      : null;

  const compliance = computeComplianceStatus({ proposedHeightFt, proposedFar, maxAllowedHeightFt, maxAllowedFar });

  // Estimated added units (rough: assume 850 sf avg per unit for residential)
  const avgUnitSizeFt2 = 850;
  const estimatedAddedUnits =
    proposal.numUnits != null
      ? proposal.numUnits
      : proposedFloorAreaFt2 != null && proposal.proposedUse === "residential"
        ? Math.round(proposedFloorAreaFt2 / avgUnitSizeFt2)
        : null;

  return {
    lotAreaFt2,
    maxAllowedFar,
    maxAllowedHeightFt,
    maxAllowedFloorAreaFt2,
    existingHeightFt,
    existingFar,
    proposedFar,
    proposedHeightFt,
    proposedFloorAreaFt2,
    floorAreaDiffFt2,
    pctOfMaxEnvelope,
    estimatedAddedUnits,
    compliance,
  };
}

/**
 * Renders an HTML comparison table for a proposal.
 * @param {object} metrics - Output from computeProposalMetrics
 * @param {object} proposal - Proposal metadata
 * @returns {string} HTML string
 */
export function renderComparisonTableHTML(metrics, proposal) {
  const { compliance } = metrics;
  const fmt = (v, suffix = "") => (v != null ? `${Number(v).toLocaleString()}${suffix}` : "—");

  const statusBadge = (status, label) => {
    const colors = {
      exceeds_envelope: "#dc2626",
      exceeds_far: "#f97316",
      fits: "#16a34a",
      unknown: "#94a3b8",
    };
    const bg = colors[status] || "#94a3b8";
    return `<span style="background:${bg};color:#fff;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:700;">${label}</span>`;
  };

  const rows = [
    ["Project", proposal.projectName || "—", ""],
    ["Applicant", proposal.applicant || "—", ""],
    ["Proposed Use", proposal.proposedUse || "—", ""],
    ["Lot Area", fmt(metrics.lotAreaFt2, " sf"), ""],
    ["Max Allowed FAR", fmt(metrics.maxAllowedFar), ""],
    ["Proposed FAR", fmt(metrics.proposedFar), statusBadge(compliance.farStatus, compliance.farStatus === "exceeds_far" ? "Over FAR" : compliance.farStatus === "fits" ? "OK" : "—")],
    ["Max Allowed Height", fmt(metrics.maxAllowedHeightFt, " ft"), ""],
    ["Proposed Height", fmt(metrics.proposedHeightFt, " ft"), statusBadge(compliance.heightStatus, compliance.heightStatus === "exceeds_envelope" ? "Exceeds Envelope" : compliance.heightStatus === "fits" ? "OK" : "—")],
    ["Max Floor Area", fmt(metrics.maxAllowedFloorAreaFt2, " sf"), ""],
    ["Proposed Floor Area", fmt(metrics.proposedFloorAreaFt2, " sf"), ""],
    ["Floor Area Diff", metrics.floorAreaDiffFt2 != null ? `${metrics.floorAreaDiffFt2 > 0 ? "+" : ""}${fmt(metrics.floorAreaDiffFt2, " sf")}` : "—", ""],
    ["% of Max Envelope Used", fmt(metrics.pctOfMaxEnvelope, "%"), ""],
    ["Existing Height (est.)", fmt(metrics.existingHeightFt, " ft"), ""],
    ["Existing FAR", fmt(metrics.existingFar), ""],
    ["Estimated Added Units", fmt(metrics.estimatedAddedUnits), ""],
    ["Overall Compliance", statusBadge(compliance.overallStatus, { exceeds_envelope: "Exceeds Zoning Envelope", exceeds_far: "Exceeds FAR", fits: "Fits within Envelope & FAR", unknown: "Insufficient Data" }[compliance.overallStatus] || "—"), ""],
  ];

  const rowHtml = rows
    .map(
      ([label, value, badge]) =>
        `<div class="summary-row"><span>${label}</span><strong>${value} ${badge}</strong></div>`
    )
    .join("");

  return `
    <div class="summary-section-head">Proposal Analysis: ${proposal.projectName || "Unnamed"}</div>
    ${rowHtml}
    ${proposal.publicNotes ? `<div class="summary-row summary-row--source"><span>Notes</span><span>${proposal.publicNotes}</span></div>` : ""}
  `;
}
