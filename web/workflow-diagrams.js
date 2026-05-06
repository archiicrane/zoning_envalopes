/**
 * Workflow Diagrams — Educational pages explaining zoning envelope generation
 * DATA → RULES → GEOMETRY → ENVELOPE
 */

/**
 * DATA PAGE: Show what datasets the app uses
 */
function renderDataDiagram(lotData, lotGeometry) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 800 400");
  svg.setAttribute("class", "workflow-diagram");

  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  defs.innerHTML = `
    <marker id="arrowhead" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto">
      <polygon points="0 0, 10 3, 0 6" fill="#666" />
    </marker>
  `;
  svg.appendChild(defs);

  // Title
  const title = document.createElementNS("http://www.w3.org/2000/svg", "text");
  title.setAttribute("x", "400");
  title.setAttribute("y", "30");
  title.setAttribute("text-anchor", "middle");
  title.setAttribute("class", "workflow-title");
  title.textContent = "DATA: Input Datasets";
  svg.appendChild(title);

  // Input boxes
  const inputs = [
    { label: "PLUTO Lot Data", x: 50, items: ["Lot Area", "Address", "Block/Lot"] },
    { label: "Zoning Info", x: 200, items: ["Zone Code", "ZR Rules", "Footnotes"] },
    { label: "Geometry", x: 350, items: ["Lot Boundary", "Roads Adjacent", "Buildings"] },
    { label: "BBL Selected", x: 500, items: ["Coordinates", "Attributes", "Neighbors"] },
  ];

  inputs.forEach((input) => {
    // Box
    const box = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    box.setAttribute("x", input.x);
    box.setAttribute("y", "80");
    box.setAttribute("width", "130");
    box.setAttribute("height", "140");
    box.setAttribute("fill", "none");
    box.setAttribute("stroke", "#0066cc");
    box.setAttribute("stroke-width", "1.5");
    svg.appendChild(box);

    // Label
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", input.x + 65);
    label.setAttribute("y", "105");
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("class", "workflow-label");
    label.textContent = input.label;
    svg.appendChild(label);

    // Items
    input.items.forEach((item, idx) => {
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("x", input.x + 65);
      text.setAttribute("y", 130 + idx * 20);
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("class", "workflow-item");
      text.setAttribute("font-size", "11");
      text.textContent = item;
      svg.appendChild(text);
    });
  });

  // Arrow to result
  const arrow = document.createElementNS("http://www.w3.org/2000/svg", "line");
  arrow.setAttribute("x1", "400");
  arrow.setAttribute("y1", "230");
  arrow.setAttribute("x2", "400");
  arrow.setAttribute("y2", "270");
  arrow.setAttribute("stroke", "#666");
  arrow.setAttribute("stroke-width", "2");
  arrow.setAttribute("marker-end", "url(#arrowhead)");
  svg.appendChild(arrow);

  // Result
  const resultBox = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  resultBox.setAttribute("x", "250");
  resultBox.setAttribute("y", "280");
  resultBox.setAttribute("width", "300");
  resultBox.setAttribute("height", "90");
  resultBox.setAttribute("fill", "#f0f4ff");
  resultBox.setAttribute("stroke", "#0066cc");
  resultBox.setAttribute("stroke-width", "2");
  svg.appendChild(resultBox);

  const resultTitle = document.createElementNS("http://www.w3.org/2000/svg", "text");
  resultTitle.setAttribute("x", "400");
  resultTitle.setAttribute("y", "305");
  resultTitle.setAttribute("text-anchor", "middle");
  resultTitle.setAttribute("class", "workflow-result-label");
  resultTitle.textContent = "SELECTED LOT";
  svg.appendChild(resultTitle);

  let dataStr = "";
  if (lotData) {
    const address = lotData.address || "Unknown";
    const zone = lotData.zonedist1 || "Unknown";
    const area = lotData.lot_area
      ? `${Math.round(lotData.lot_area).toLocaleString()} SF`
      : "Unknown";
    dataStr = `${address} • ${zone} • ${area}`;
  } else {
    dataStr = "Click a lot to see its data";
  }

  const resultData = document.createElementNS("http://www.w3.org/2000/svg", "text");
  resultData.setAttribute("x", "400");
  resultData.setAttribute("y", "335");
  resultData.setAttribute("text-anchor", "middle");
  resultData.setAttribute("font-size", "12");
  resultData.setAttribute("fill", "#333");
  resultData.textContent = dataStr;
  svg.appendChild(resultData);

  return svg;
}

/**
 * RULES PAGE: Show how zoning rules are extracted and applied
 */
function renderRulesDiagram(controls, zoneCode) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 800 480");
  svg.setAttribute("class", "workflow-diagram");

  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  defs.innerHTML = `
    <marker id="arrowhead2" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto">
      <polygon points="0 0, 10 3, 0 6" fill="#666" />
    </marker>
  `;
  svg.appendChild(defs);

  // Title
  const title = document.createElementNS("http://www.w3.org/2000/svg", "text");
  title.setAttribute("x", "400");
  title.setAttribute("y", "30");
  title.setAttribute("text-anchor", "middle");
  title.setAttribute("class", "workflow-title");
  title.textContent = "RULES: NYC Zoning Resolution Parameters";
  svg.appendChild(title);

  // Left: Zone input
  const zoneBox = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  zoneBox.setAttribute("x", "50");
  zoneBox.setAttribute("y", "80");
  zoneBox.setAttribute("width", "120");
  zoneBox.setAttribute("height", "80");
  zoneBox.setAttribute("fill", "none");
  zoneBox.setAttribute("stroke", "#0066cc");
  zoneBox.setAttribute("stroke-width", "2");
  svg.appendChild(zoneBox);

  const zoneLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
  zoneLabel.setAttribute("x", "110");
  zoneLabel.setAttribute("y", "110");
  zoneLabel.setAttribute("text-anchor", "middle");
  zoneLabel.setAttribute("class", "workflow-label");
  zoneLabel.textContent = "ZONE CODE";
  svg.appendChild(zoneLabel);

  const zoneVal = document.createElementNS("http://www.w3.org/2000/svg", "text");
  zoneVal.setAttribute("x", "110");
  zoneVal.setAttribute("y", "145");
  zoneVal.setAttribute("text-anchor", "middle");
  zoneVal.setAttribute("font-size", "16");
  zoneVal.setAttribute("font-weight", "bold");
  zoneVal.setAttribute("fill", "#0066cc");
  zoneVal.textContent = zoneCode || "R6";
  svg.appendChild(zoneVal);

  // Arrow
  const arrow1 = document.createElementNS("http://www.w3.org/2000/svg", "line");
  arrow1.setAttribute("x1", "170");
  arrow1.setAttribute("y1", "120");
  arrow1.setAttribute("x2", "230");
  arrow1.setAttribute("y2", "120");
  arrow1.setAttribute("stroke", "#666");
  arrow1.setAttribute("stroke-width", "2");
  arrow1.setAttribute("marker-end", "url(#arrowhead2)");
  svg.appendChild(arrow1);

  // Middle: Rules extracted
  const rulesBox = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rulesBox.setAttribute("x", "230");
  rulesBox.setAttribute("y", "60");
  rulesBox.setAttribute("width", "300");
  rulesBox.setAttribute("height", "120");
  rulesBox.setAttribute("fill", "#fffef0");
  rulesBox.setAttribute("stroke", "#666");
  rulesBox.setAttribute("stroke-width", "1.5");
  svg.appendChild(rulesBox);

  const rulesTitle = document.createElementNS("http://www.w3.org/2000/svg", "text");
  rulesTitle.setAttribute("x", "380");
  rulesTitle.setAttribute("y", "82");
  rulesTitle.setAttribute("text-anchor", "middle");
  rulesTitle.setAttribute("class", "workflow-label");
  rulesTitle.textContent = "ZONING RULES (NYC ZR)";
  svg.appendChild(rulesTitle);

  const rulesList = [
    `FAR: ${controls?.far ?? "—"}`,
    `Max Height: ${controls?.maximumBuildingHeightFt ?? "—"} ft`,
    `Front Yard: ${controls?.frontYardFt ?? "—"} ft`,
    `Rear Yard: ${controls?.rearYardFt ?? "—"} ft`,
    `Side Yard (each): ${controls?.sideYardEachFt ?? "—"} ft`,
    `Open Space Ratio: ${controls?.openSpaceRatio ?? "—"}%`,
  ];

  rulesList.forEach((rule, idx) => {
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", "245");
    text.setAttribute("y", 100 + idx * 16);
    text.setAttribute("font-size", "11");
    text.setAttribute("fill", "#333");
    text.textContent = rule;
    svg.appendChild(text);
  });

  // Arrow to numeric
  const arrow2 = document.createElementNS("http://www.w3.org/2000/svg", "line");
  arrow2.setAttribute("x1", "530");
  arrow2.setAttribute("y1", "120");
  arrow2.setAttribute("x2", "590");
  arrow2.setAttribute("y2", "120");
  arrow2.setAttribute("stroke", "#666");
  arrow2.setAttribute("stroke-width", "2");
  arrow2.setAttribute("marker-end", "url(#arrowhead2)");
  svg.appendChild(arrow2);

  // Right: Numeric parameters
  const numBox = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  numBox.setAttribute("x", "590");
  numBox.setAttribute("y", "60");
  numBox.setAttribute("width", "150");
  numBox.setAttribute("height", "120");
  numBox.setAttribute("fill", "none");
  numBox.setAttribute("stroke", "#0066cc");
  numBox.setAttribute("stroke-width", "2");
  svg.appendChild(numBox);

  const numTitle = document.createElementNS("http://www.w3.org/2000/svg", "text");
  numTitle.setAttribute("x", "665");
  numTitle.setAttribute("y", "82");
  numTitle.setAttribute("text-anchor", "middle");
  numTitle.setAttribute("class", "workflow-label");
  numTitle.textContent = "PARAMETERS";
  svg.appendChild(numTitle);

  const params = [
    `FAR → Floor\nArea`,
    `Height → Extrusion`,
    `Yards → Offsets`,
  ];

  params.forEach((param, idx) => {
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", "665");
    text.setAttribute("y", 105 + idx * 25);
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("font-size", "10");
    text.setAttribute("fill", "#333");
    text.textContent = param;
    svg.appendChild(text);
  });

  // Bottom note
  const note = document.createElementNS("http://www.w3.org/2000/svg", "text");
  note.setAttribute("x", "400");
  note.setAttribute("y", "220");
  note.setAttribute("text-anchor", "middle");
  note.setAttribute("font-size", "10");
  note.setAttribute("fill", "#666");
  note.setAttribute("font-style", "italic");
  note.textContent = "Source: NYC Zoning Resolution (ZR)";
  svg.appendChild(note);

  // Flow diagram for rule application
  const flowTitle = document.createElementNS("http://www.w3.org/2000/svg", "text");
  flowTitle.setAttribute("x", "400");
  flowTitle.setAttribute("y", "270");
  flowTitle.setAttribute("text-anchor", "middle");
  flowTitle.setAttribute("class", "workflow-label");
  flowTitle.textContent = "How Rules Become Constraints";
  svg.appendChild(flowTitle);

  const steps = [
    { x: 80, label: "Read ZR\nFor Zone", icon: "📖" },
    { x: 200, label: "Extract\nNumerics", icon: "🔢" },
    { x: 320, label: "Apply to\nLot", icon: "📐" },
    { x: 440, label: "Generate\nBuildable\nArea", icon: "📦" },
    { x: 560, label: "Extrude to\nHeight", icon: "🏢" },
    { x: 680, label: "Final\nEnvelope", icon: "✓" },
  ];

  steps.forEach((step, idx) => {
    const box = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    box.setAttribute("x", step.x - 35);
    box.setAttribute("y", "310");
    box.setAttribute("width", "70");
    box.setAttribute("height", "60");
    box.setAttribute("fill", idx === 0 ? "#e3f2fd" : idx === steps.length - 1 ? "#e8f5e9" : "#fafafa");
    box.setAttribute("stroke", idx === 0 ? "#0066cc" : idx === steps.length - 1 ? "#4caf50" : "#ccc");
    box.setAttribute("stroke-width", "1");
    svg.appendChild(box);

    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", step.x);
    text.setAttribute("y", "340");
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("font-size", "9");
    text.setAttribute("fill", "#333");
    text.textContent = step.label;
    svg.appendChild(text);

    if (idx < steps.length - 1) {
      const arrow = document.createElementNS("http://www.w3.org/2000/svg", "line");
      arrow.setAttribute("x1", step.x + 35);
      arrow.setAttribute("y1", "340");
      arrow.setAttribute("x2", steps[idx + 1].x - 35);
      arrow.setAttribute("y2", "340");
      arrow.setAttribute("stroke", "#999");
      arrow.setAttribute("stroke-width", "1");
      arrow.setAttribute("marker-end", "url(#arrowhead2)");
      svg.appendChild(arrow);
    }
  });

  return svg;
}

/**
 * GEOMETRY PAGE: Show how edges are classified and setbacks are applied
 */
function renderGeometryDiagram(lotData, lotAnalysis) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 800 500");
  svg.setAttribute("class", "workflow-diagram");

  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  defs.innerHTML = `
    <marker id="arrowhead3" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto">
      <polygon points="0 0, 10 3, 0 6" fill="#666" />
    </marker>
  `;
  svg.appendChild(defs);

  // Title
  const title = document.createElementNS("http://www.w3.org/2000/svg", "text");
  title.setAttribute("x", "400");
  title.setAttribute("y", "30");
  title.setAttribute("text-anchor", "middle");
  title.setAttribute("class", "workflow-title");
  title.textContent = "GEOMETRY: From Lot Boundary to Buildable Area";
  svg.appendChild(title);

  // Step 1: Lot polygon
  const step1Box = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  step1Box.setAttribute("x", "50");
  step1Box.setAttribute("y", "80");
  step1Box.setAttribute("width", "140");
  step1Box.setAttribute("height", "140");
  step1Box.setAttribute("fill", "none");
  step1Box.setAttribute("stroke", "#666");
  step1Box.setAttribute("stroke-width", "1.5");
  svg.appendChild(step1Box);

  // Draw simple lot polygon
  const lotPoly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  lotPoly.setAttribute("points", "70,100 180,110 170,200 60,190");
  lotPoly.setAttribute("fill", "#f5f5f5");
  lotPoly.setAttribute("stroke", "#333");
  lotPoly.setAttribute("stroke-width", "2");
  svg.appendChild(lotPoly);

  const step1Label = document.createElementNS("http://www.w3.org/2000/svg", "text");
  step1Label.setAttribute("x", "120");
  step1Label.setAttribute("y", "235");
  step1Label.setAttribute("text-anchor", "middle");
  step1Label.setAttribute("class", "workflow-label");
  step1Label.textContent = "LOT POLYGON";
  svg.appendChild(step1Label);

  // Arrow 1
  const arrow1 = document.createElementNS("http://www.w3.org/2000/svg", "line");
  arrow1.setAttribute("x1", "190");
  arrow1.setAttribute("y1", "150");
  arrow1.setAttribute("x2", "250");
  arrow1.setAttribute("y2", "150");
  arrow1.setAttribute("stroke", "#666");
  arrow1.setAttribute("stroke-width", "2");
  arrow1.setAttribute("marker-end", "url(#arrowhead3)");
  svg.appendChild(arrow1);

  // Step 2: Edge classification
  const step2Box = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  step2Box.setAttribute("x", "250");
  step2Box.setAttribute("y", "80");
  step2Box.setAttribute("width", "140");
  step2Box.setAttribute("height", "140");
  step2Box.setAttribute("fill", "none");
  step2Box.setAttribute("stroke", "#666");
  step2Box.setAttribute("stroke-width", "1.5");
  svg.appendChild(step2Box);

  // Draw classified edges
  const frontEdge = document.createElementNS("http://www.w3.org/2000/svg", "line");
  frontEdge.setAttribute("x1", "265");
  frontEdge.setAttribute("y1", "100");
  frontEdge.setAttribute("x2", "375");
  frontEdge.setAttribute("y2", "110");
  frontEdge.setAttribute("stroke", "#0066cc");
  frontEdge.setAttribute("stroke-width", "3");
  svg.appendChild(frontEdge);

  const frontLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
  frontLabel.setAttribute("x", "320");
  frontLabel.setAttribute("y", "95");
  frontLabel.setAttribute("font-size", "10");
  frontLabel.setAttribute("fill", "#0066cc");
  frontLabel.setAttribute("font-weight", "bold");
  frontLabel.textContent = "FRONT";
  svg.appendChild(frontLabel);

  const sideEdge1 = document.createElementNS("http://www.w3.org/2000/svg", "line");
  sideEdge1.setAttribute("x1", "375");
  sideEdge1.setAttribute("y1", "110");
  sideEdge1.setAttribute("x2", "365");
  sideEdge1.setAttribute("y2", "200");
  sideEdge1.setAttribute("stroke", "#ff9800");
  sideEdge1.setAttribute("stroke-width", "3");
  svg.appendChild(sideEdge1);

  const sideLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
  sideLabel.setAttribute("x", "385");
  sideLabel.setAttribute("y", "155");
  sideLabel.setAttribute("font-size", "10");
  sideLabel.setAttribute("fill", "#ff9800");
  sideLabel.setAttribute("font-weight", "bold");
  sideLabel.textContent = "SIDE";
  svg.appendChild(sideLabel);

  const rearEdge = document.createElementNS("http://www.w3.org/2000/svg", "line");
  rearEdge.setAttribute("x1", "365");
  rearEdge.setAttribute("y1", "200");
  rearEdge.setAttribute("x2", "255");
  rearEdge.setAttribute("y2", "190");
  rearEdge.setAttribute("stroke", "#d32f2f");
  rearEdge.setAttribute("stroke-width", "3");
  svg.appendChild(rearEdge);

  const rearLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
  rearLabel.setAttribute("x", "310");
  rearLabel.setAttribute("y", "210");
  rearLabel.setAttribute("font-size", "10");
  rearLabel.setAttribute("fill", "#d32f2f");
  rearLabel.setAttribute("font-weight", "bold");
  rearLabel.textContent = "REAR";
  svg.appendChild(rearLabel);

  const step2Label = document.createElementNS("http://www.w3.org/2000/svg", "text");
  step2Label.setAttribute("x", "320");
  step2Label.setAttribute("y", "235");
  step2Label.setAttribute("text-anchor", "middle");
  step2Label.setAttribute("class", "workflow-label");
  step2Label.textContent = "EDGE ROLES";
  svg.appendChild(step2Label);

  // Arrow 2
  const arrow2 = document.createElementNS("http://www.w3.org/2000/svg", "line");
  arrow2.setAttribute("x1", "390");
  arrow2.setAttribute("y1", "150");
  arrow2.setAttribute("x2", "450");
  arrow2.setAttribute("y2", "150");
  arrow2.setAttribute("stroke", "#666");
  arrow2.setAttribute("stroke-width", "2");
  arrow2.setAttribute("marker-end", "url(#arrowhead3)");
  svg.appendChild(arrow2);

  // Step 3: Setback clips (simplified)
  const step3Box = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  step3Box.setAttribute("x", "450");
  step3Box.setAttribute("y", "80");
  step3Box.setAttribute("width", "140");
  step3Box.setAttribute("height", "140");
  step3Box.setAttribute("fill", "none");
  step3Box.setAttribute("stroke", "#666");
  step3Box.setAttribute("stroke-width", "1.5");
  svg.appendChild(step3Box);

  // Draw inset area
  const insetPoly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  insetPoly.setAttribute("points", "480,120 560,125 555,180 475,175");
  insetPoly.setAttribute("fill", "#e8f5e9");
  insetPoly.setAttribute("stroke", "#4caf50");
  insetPoly.setAttribute("stroke-width", "2");
  svg.appendChild(insetPoly);

  // Show setback arrows
  const setbackArrow = document.createElementNS("http://www.w3.org/2000/svg", "path");
  setbackArrow.setAttribute("d", "M 560 125 L 555 125");
  setbackArrow.setAttribute("stroke", "#4caf50");
  setbackArrow.setAttribute("stroke-width", "1");
  setbackArrow.setAttribute("marker-end", "url(#arrowhead3)");
  svg.appendChild(setbackArrow);

  const setbackLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
  setbackLabel.setAttribute("x", "565");
  setbackLabel.setAttribute("y", "122");
  setbackLabel.setAttribute("font-size", "9");
  setbackLabel.setAttribute("fill", "#4caf50");
  setbackLabel.textContent = "setback";
  svg.appendChild(setbackLabel);

  const step3Label = document.createElementNS("http://www.w3.org/2000/svg", "text");
  step3Label.setAttribute("x", "520");
  step3Label.setAttribute("y", "235");
  step3Label.setAttribute("text-anchor", "middle");
  step3Label.setAttribute("class", "workflow-label");
  step3Label.textContent = "APPLY SETBACKS";
  svg.appendChild(step3Label);

  // Arrow 3
  const arrow3 = document.createElementNS("http://www.w3.org/2000/svg", "line");
  arrow3.setAttribute("x1", "590");
  arrow3.setAttribute("y1", "150");
  arrow3.setAttribute("x2", "650");
  arrow3.setAttribute("y2", "150");
  arrow3.setAttribute("stroke", "#666");
  arrow3.setAttribute("stroke-width", "2");
  arrow3.setAttribute("marker-end", "url(#arrowhead3)");
  svg.appendChild(arrow3);

  // Step 4: Buildable area
  const step4Box = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  step4Box.setAttribute("x", "650");
  step4Box.setAttribute("y", "80");
  step4Box.setAttribute("width", "120");
  step4Box.setAttribute("height", "140");
  step4Box.setAttribute("fill", "none");
  step4Box.setAttribute("stroke", "#4caf50");
  step4Box.setAttribute("stroke-width", "2");
  svg.appendChild(step4Box);

  const buildablePoly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  buildablePoly.setAttribute("points", "670,110 750,115 745,185 665,180");
  buildablePoly.setAttribute("fill", "#c8e6c9");
  buildablePoly.setAttribute("stroke", "#2e7d32");
  buildablePoly.setAttribute("stroke-width", "2");
  svg.appendChild(buildablePoly);

  const step4Label = document.createElementNS("http://www.w3.org/2000/svg", "text");
  step4Label.setAttribute("x", "710");
  step4Label.setAttribute("y", "235");
  step4Label.setAttribute("text-anchor", "middle");
  step4Label.setAttribute("class", "workflow-label");
  step4Label.textContent = "BUILDABLE AREA";
  svg.appendChild(step4Label);

  // Key principles
  const principlesTitle = document.createElementNS("http://www.w3.org/2000/svg", "text");
  principlesTitle.setAttribute("x", "400");
  principlesTitle.setAttribute("y", "290");
  principlesTitle.setAttribute("text-anchor", "middle");
  principlesTitle.setAttribute("font-size", "12");
  principlesTitle.setAttribute("font-weight", "bold");
  principlesTitle.textContent = "Key Principles";
  svg.appendChild(principlesTitle);

  const principles = [
    "✓ Straight-line clipping only (no curves)",
    "✓ Street-facing = FRONT",
    "✓ Other edges = SIDE or REAR",
    "✓ Setbacks create linear insets",
  ];

  principles.forEach((principle, idx) => {
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", "50");
    text.setAttribute("y", 320 + idx * 22);
    text.setAttribute("font-size", "11");
    text.setAttribute("fill", "#333");
    text.textContent = principle;
    svg.appendChild(text);
  });

  return svg;
}

/**
 * ENVELOPE PAGE: Show how FAR and height create the final zoning envelope
 */
function renderEnvelopeDiagram(controls, baselineEnvelopeResults, farEnvelopeData) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 800 500");
  svg.setAttribute("class", "workflow-diagram");

  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  defs.innerHTML = `
    <marker id="arrowhead4" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto">
      <polygon points="0 0, 10 3, 0 6" fill="#666" />
    </marker>
  `;
  svg.appendChild(defs);

  // Title
  const title = document.createElementNS("http://www.w3.org/2000/svg", "text");
  title.setAttribute("x", "400");
  title.setAttribute("y", "30");
  title.setAttribute("text-anchor", "middle");
  title.setAttribute("class", "workflow-title");
  title.textContent = "ENVELOPE: Zoning Massing Model";
  svg.appendChild(title);

  // Step 1: Buildable area
  const buildableBox = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  buildableBox.setAttribute("x", "40");
  buildableBox.setAttribute("y", "80");
  buildableBox.setAttribute("width", "130");
  buildableBox.setAttribute("height", "130");
  buildableBox.setAttribute("fill", "none");
  buildableBox.setAttribute("stroke", "#4caf50");
  buildableBox.setAttribute("stroke-width", "1.5");
  svg.appendChild(buildableBox);

  const buildablePlan = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  buildablePlan.setAttribute("points", "60,100 150,105 145,180 55,175");
  buildablePlan.setAttribute("fill", "#c8e6c9");
  buildablePlan.setAttribute("stroke", "#2e7d32");
  buildablePlan.setAttribute("stroke-width", "2");
  svg.appendChild(buildablePlan);

  const buildableLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
  buildableLabel.setAttribute("x", "105");
  buildableLabel.setAttribute("y", "230");
  buildableLabel.setAttribute("text-anchor", "middle");
  buildableLabel.setAttribute("class", "workflow-label");
  buildableLabel.textContent = "BUILDABLE\nAREA";
  svg.appendChild(buildableLabel);

  // Arrow 1
  const arrow1 = document.createElementNS("http://www.w3.org/2000/svg", "line");
  arrow1.setAttribute("x1", "170");
  arrow1.setAttribute("y1", "145");
  arrow1.setAttribute("x2", "230");
  arrow1.setAttribute("y2", "145");
  arrow1.setAttribute("stroke", "#666");
  arrow1.setAttribute("stroke-width", "2");
  arrow1.setAttribute("marker-end", "url(#arrowhead4)");
  svg.appendChild(arrow1);

  // Step 2: Parameters
  const paramBox = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  paramBox.setAttribute("x", "230");
  paramBox.setAttribute("y", "80");
  paramBox.setAttribute("width", "140");
  paramBox.setAttribute("height", "130");
  paramBox.setAttribute("fill", "#fffef0");
  paramBox.setAttribute("stroke", "#666");
  paramBox.setAttribute("stroke-width", "1.5");
  svg.appendChild(paramBox);

  const paramTitle = document.createElementNS("http://www.w3.org/2000/svg", "text");
  paramTitle.setAttribute("x", "300");
  paramTitle.setAttribute("y", "105");
  paramTitle.setAttribute("text-anchor", "middle");
  paramTitle.setAttribute("class", "workflow-label");
  paramTitle.setAttribute("font-size", "11");
  paramTitle.textContent = "ENVELOPE RULES";
  svg.appendChild(paramTitle);

  const params = [
    `FAR: ${controls?.far ?? "—"}`,
    `Max Height: ${controls?.maximumBuildingHeightFt ?? "—"} ft`,
    `Allowed Floors:\n${Math.ceil((controls?.maximumBuildingHeightFt ?? 65) / 10)} (@ 10 ft/floor)`,
  ];

  params.forEach((param, idx) => {
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", "300");
    text.setAttribute("y", 130 + idx * 25);
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("font-size", "10");
    text.setAttribute("fill", "#333");
    text.textContent = param;
    svg.appendChild(text);
  });

  // Arrow 2
  const arrow2 = document.createElementNS("http://www.w3.org/2000/svg", "line");
  arrow2.setAttribute("x1", "370");
  arrow2.setAttribute("y1", "145");
  arrow2.setAttribute("x2", "430");
  arrow2.setAttribute("y2", "145");
  arrow2.setAttribute("stroke", "#666");
  arrow2.setAttribute("stroke-width", "2");
  arrow2.setAttribute("marker-end", "url(#arrowhead4)");
  svg.appendChild(arrow2);

  // Step 3: MAX envelope
  const maxBox = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  maxBox.setAttribute("x", "430");
  maxBox.setAttribute("y", "80");
  maxBox.setAttribute("width", "140");
  maxBox.setAttribute("height", "130");
  maxBox.setAttribute("fill", "none");
  maxBox.setAttribute("stroke", "#0066cc");
  maxBox.setAttribute("stroke-width", "1.5");
  svg.appendChild(maxBox);

  // Simple 3D extrusion
  const maxBase = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  maxBase.setAttribute("points", "450,160 510,165 510,185 450,180");
  maxBase.setAttribute("fill", "#bbdefb");
  maxBase.setAttribute("stroke", "#0066cc");
  maxBase.setAttribute("stroke-width", "1");
  svg.appendChild(maxBase);

  const maxExtrude = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  maxExtrude.setAttribute("points", "450,100 510,105 510,165 450,160");
  maxExtrude.setAttribute("fill", "#90caf9");
  maxExtrude.setAttribute("stroke", "#0066cc");
  maxExtrude.setAttribute("stroke-width", "1");
  svg.appendChild(maxExtrude);

  const maxLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
  maxLabel.setAttribute("x", "500");
  maxLabel.setAttribute("y", "230");
  maxLabel.setAttribute("text-anchor", "middle");
  maxLabel.setAttribute("class", "workflow-label");
  maxLabel.textContent = "MAX\nENVELOPE";
  svg.appendChild(maxLabel);

  // Arrow 3
  const arrow3 = document.createElementNS("http://www.w3.org/2000/svg", "line");
  arrow3.setAttribute("x1", "570");
  arrow3.setAttribute("y1", "145");
  arrow3.setAttribute("x2", "630");
  arrow3.setAttribute("y2", "145");
  arrow3.setAttribute("stroke", "#666");
  arrow3.setAttribute("stroke-width", "2");
  arrow3.setAttribute("marker-end", "url(#arrowhead4)");
  svg.appendChild(arrow3);

  // Step 4: FAR massing
  const farBox = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  farBox.setAttribute("x", "630");
  farBox.setAttribute("y", "80");
  farBox.setAttribute("width", "140");
  farBox.setAttribute("height", "130");
  farBox.setAttribute("fill", "none");
  farBox.setAttribute("stroke", "#4caf50");
  farBox.setAttribute("stroke-width", "1.5");
  svg.appendChild(farBox);

  // Simple FAR extrusion (shorter)
  const farBase = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  farBase.setAttribute("points", "650,155 710,160 710,180 650,175");
  farBase.setAttribute("fill", "#a5d6a7");
  farBase.setAttribute("stroke", "#2e7d32");
  farBase.setAttribute("stroke-width", "1");
  svg.appendChild(farBase);

  const farExtrude = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  farExtrude.setAttribute("points", "650,125 710,130 710,160 650,155");
  farExtrude.setAttribute("fill", "#81c784");
  farExtrude.setAttribute("stroke", "#2e7d32");
  farExtrude.setAttribute("stroke-width", "1");
  svg.appendChild(farExtrude);

  const farLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
  farLabel.setAttribute("x", "700");
  farLabel.setAttribute("y", "230");
  farLabel.setAttribute("text-anchor", "middle");
  farLabel.setAttribute("class", "workflow-label");
  farLabel.textContent = "FAR\nMASS";
  svg.appendChild(farLabel);

  // Bottom: Workflow summary
  const summaryTitle = document.createElementNS("http://www.w3.org/2000/svg", "text");
  summaryTitle.setAttribute("x", "400");
  summaryTitle.setAttribute("y", "290");
  summaryTitle.setAttribute("text-anchor", "middle");
  summaryTitle.setAttribute("font-size", "12");
  summaryTitle.setAttribute("font-weight", "bold");
  summaryTitle.textContent = "How It Works";
  svg.appendChild(summaryTitle);

  const workflow = [
    "1. Buildable footprint is defined by yard setbacks",
    "2. MAX envelope: extrude footprint to max height allowed by zoning",
    "3. FAR massing: extrude to height that uses full FAR floor area target",
    "4. Use sliders to adjust FAR, floor height, coverage — envelope updates in real time",
    "5. Compare MAX vs FAR in 3D view to understand zoning potential",
  ];

  workflow.forEach((step, idx) => {
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", "50");
    text.setAttribute("y", 320 + idx * 20);
    text.setAttribute("font-size", "11");
    text.setAttribute("fill", "#333");
    text.textContent = step;
    svg.appendChild(text);
  });

  return svg;
}

/**
 * Export all diagram renderers
 */
window.workflowDiagrams = {
  renderDataDiagram,
  renderRulesDiagram,
  renderGeometryDiagram,
  renderEnvelopeDiagram,
};
