(function () {
  const HTML2CANVAS_LOCAL = "/vendor/html2canvas.min.js";
  const HTML2CANVAS_CDN = "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js";

  async function ensureHtml2Canvas() {
    if (window.html2canvas) return window.html2canvas;

    const loadScript = (src) => new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Failed to load html2canvas from ${src}`));
      document.head.appendChild(script);
    });

    try {
      await loadScript(HTML2CANVAS_LOCAL);
    } catch (_err) {
      await loadScript(HTML2CANVAS_CDN);
    }

    return window.html2canvas;
  }

  function clamp01(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(1, n));
  }

  async function captureRegion(selector, crop = { x: 0, y: 0, w: 1, h: 1 }) {
    const target = document.querySelector(selector);
    if (!target) return null;

    const h2c = await ensureHtml2Canvas();
    const baseCanvas = await h2c(target, {
      useCORS: true,
      allowTaint: true,
      backgroundColor: "#f3f3f1",
      logging: false,
      scale: Math.min(window.devicePixelRatio || 1, 2),
    });

    const cx = Math.floor(baseCanvas.width * clamp01(crop.x, 0));
    const cy = Math.floor(baseCanvas.height * clamp01(crop.y, 0));
    const cw = Math.max(20, Math.floor(baseCanvas.width * clamp01(crop.w, 1)));
    const ch = Math.max(20, Math.floor(baseCanvas.height * clamp01(crop.h, 1)));

    const out = document.createElement("canvas");
    out.width = cw;
    out.height = ch;
    const ctx = out.getContext("2d");
    ctx.drawImage(baseCanvas, cx, cy, cw, ch, 0, 0, cw, ch);
    return out.toDataURL("image/png");
  }

  function mkSvgEl(tag, attrs = {}, text) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, String(v)));
    if (text != null) el.textContent = text;
    return el;
  }

  function addDefs(svg) {
    const defs = mkSvgEl("defs");
    const marker = mkSvgEl("marker", {
      id: "wfArrow",
      markerWidth: 8,
      markerHeight: 8,
      refX: 7,
      refY: 3,
      orient: "auto",
    });
    marker.appendChild(mkSvgEl("path", { d: "M0,0 L8,3 L0,6 Z", fill: "#3b4047" }));
    defs.appendChild(marker);

    const soft = mkSvgEl("filter", { id: "wfSoft" });
    soft.appendChild(mkSvgEl("feGaussianBlur", { stdDeviation: 0.75 }));
    defs.appendChild(soft);

    svg.appendChild(defs);
  }

  function addGrid(svg, width, height) {
    const group = mkSvgEl("g", { class: "wf-grid" });
    for (let x = 0; x <= width; x += 80) {
      group.appendChild(mkSvgEl("line", { x1: x, y1: 0, x2: x, y2: height, class: "wf-grid-line" }));
    }
    for (let y = 0; y <= height; y += 80) {
      group.appendChild(mkSvgEl("line", { x1: 0, y1: y, x2: width, y2: y, class: "wf-grid-line" }));
    }
    svg.appendChild(group);
  }

  function addArrow(svg, x1, y1, x2, y2, cls = "wf-arrow") {
    svg.appendChild(
      mkSvgEl("line", {
        x1,
        y1,
        x2,
        y2,
        class: cls,
        "marker-end": "url(#wfArrow)",
      })
    );
  }

  function addLabel(svg, x, y, text, cls = "wf-label") {
    svg.appendChild(mkSvgEl("text", { x, y, class: cls }, text));
  }

  function addDim(svg, x1, y1, x2, y2, text) {
    addArrow(svg, x1, y1, x2, y2, "wf-dim");
    addLabel(svg, (x1 + x2) / 2 + 4, (y1 + y2) / 2 - 4, text, "wf-dim-text");
  }

  function createBoard(title, subtitle, step) {
    const board = document.createElement("section");
    board.className = "workflow-board workflow-board--enter";
    board.dataset.workflowStep = step;

    const header = document.createElement("header");
    header.className = "workflow-board-head";

    const titleEl = document.createElement("h3");
    titleEl.className = "workflow-board-title";
    titleEl.textContent = title;

    const subtitleEl = document.createElement("p");
    subtitleEl.className = "workflow-board-subtitle";
    subtitleEl.textContent = subtitle;

    header.appendChild(titleEl);
    header.appendChild(subtitleEl);

    const canvasWrap = document.createElement("div");
    canvasWrap.className = "workflow-canvas";

    const baseImage = document.createElement("img");
    baseImage.className = "workflow-base-image";
    baseImage.alt = `${title} screenshot`;

    const overlay = mkSvgEl("svg", {
      class: "workflow-overlay",
      viewBox: "0 0 1200 720",
      preserveAspectRatio: "xMidYMid slice",
    });

    canvasWrap.appendChild(baseImage);
    canvasWrap.appendChild(overlay);
    board.appendChild(header);
    board.appendChild(canvasWrap);

    return { board, baseImage, overlay };
  }

  function addCommonLegend(board) {
    const legend = document.createElement("div");
    legend.className = "workflow-board-legend";
    legend.innerHTML = [
      '<span><i class="sw sw-max"></i>Max Envelope</span>',
      '<span><i class="sw sw-far"></i>FAR / Buildable</span>',
      '<span><i class="sw sw-side"></i>Side/Setback</span>',
      '<span><i class="sw sw-rear"></i>Rear/Critical</span>',
    ].join("");
    board.appendChild(legend);
  }

  function overlayData(svg, lotData) {
    addDefs(svg);
    addGrid(svg, 1200, 720);

    svg.appendChild(mkSvgEl("rect", { x: 130, y: 130, width: 380, height: 270, class: "wf-outline" }));
    svg.appendChild(mkSvgEl("polygon", { points: "180,190 460,210 420,370 160,345", class: "wf-lot" }));

    addArrow(svg, 520, 180, 690, 130);
    addLabel(svg, 705, 126, "PLUTO lot attributes", "wf-callout");

    addArrow(svg, 510, 240, 730, 240);
    addLabel(svg, 744, 236, `Zone ${lotData?.zonedist1 || "Unknown"}`, "wf-callout");

    addArrow(svg, 480, 330, 695, 388);
    addLabel(svg, 712, 388, `Lot area ${Math.round(Number(lotData?.lot_area || lotData?.lotarea || 0)).toLocaleString() || "--"} sf`, "wf-callout");

    svg.appendChild(mkSvgEl("line", { x1: 120, y1: 460, x2: 1080, y2: 460, class: "wf-section" }));
    addLabel(svg, 1088, 456, "A-A", "wf-section-label");

    addDim(svg, 190, 390, 450, 390, "parcel frontage");
    addDim(svg, 142, 204, 142, 340, "parcel depth");
  }

  function overlayRules(svg, controls, zoneCode) {
    addDefs(svg);
    addGrid(svg, 1200, 720);

    const rules = [
      `FAR ${controls?.far ?? "--"}`,
      `Max H ${controls?.maximumBuildingHeightFt ?? "--"} ft`,
      `Front ${controls?.frontYardFt ?? "--"} ft`,
      `Side ${controls?.sideYardEachFt ?? "--"} ft`,
      `Rear ${controls?.rearYardFt ?? "--"} ft`,
      `OSR ${controls?.openSpaceRatio ?? "--"}`,
    ];

    svg.appendChild(mkSvgEl("rect", { x: 120, y: 90, width: 350, height: 510, class: "wf-panel" }));
    addLabel(svg, 150, 130, `Rule Extraction - ${zoneCode || "Zone"}`, "wf-header");

    rules.forEach((rule, i) => addLabel(svg, 150, 180 + i * 56, rule, "wf-row"));

    svg.appendChild(mkSvgEl("polygon", { points: "640,200 930,220 900,430 610,410", class: "wf-lot" }));
    svg.appendChild(mkSvgEl("line", { x1: 640, y1: 200, x2: 930, y2: 220, class: "wf-front" }));
    svg.appendChild(mkSvgEl("line", { x1: 930, y1: 220, x2: 900, y2: 430, class: "wf-side" }));
    svg.appendChild(mkSvgEl("line", { x1: 900, y1: 430, x2: 610, y2: 410, class: "wf-rear" }));

    addArrow(svg, 470, 200, 598, 208);
    addArrow(svg, 470, 258, 592, 250);
    addArrow(svg, 470, 318, 597, 332);
    addArrow(svg, 470, 374, 605, 410);

    addLabel(svg, 936, 216, "front", "wf-tag-front");
    addLabel(svg, 910, 326, "side", "wf-tag-side");
    addLabel(svg, 742, 448, "rear", "wf-tag-rear");
  }

  function overlayGeometry(svg, controls) {
    addDefs(svg);
    addGrid(svg, 1200, 720);

    svg.appendChild(mkSvgEl("polygon", { points: "180,170 530,200 500,520 140,490", class: "wf-lot" }));
    svg.appendChild(mkSvgEl("polygon", { points: "230,230 470,250 452,462 215,444", class: "wf-buildable" }));

    svg.appendChild(mkSvgEl("line", { x1: 180, y1: 170, x2: 530, y2: 200, class: "wf-front" }));
    svg.appendChild(mkSvgEl("line", { x1: 530, y1: 200, x2: 500, y2: 520, class: "wf-side" }));
    svg.appendChild(mkSvgEl("line", { x1: 500, y1: 520, x2: 140, y2: 490, class: "wf-rear" }));

    svg.appendChild(mkSvgEl("polygon", { points: "230,230 470,250 452,462 215,444", class: "wf-dashed" }));

    addDim(svg, 180, 552, 530, 582, `front setback ${controls?.frontYardFt ?? "--"} ft`);
    addDim(svg, 538, 206, 505, 515, `side ${controls?.sideYardEachFt ?? "--"} ft`);
    addDim(svg, 140, 506, 500, 532, `rear ${controls?.rearYardFt ?? "--"} ft`);

    addArrow(svg, 610, 290, 760, 220);
    addLabel(svg, 772, 218, "Construction lines", "wf-callout");

    addArrow(svg, 610, 360, 790, 360);
    addLabel(svg, 806, 358, "Sequential straight-line offsets", "wf-callout");

    addArrow(svg, 610, 438, 760, 510);
    addLabel(svg, 772, 516, "Resulting buildable polygon", "wf-callout");
  }

  function overlayEnvelope(svg, controls, farData) {
    addDefs(svg);
    addGrid(svg, 1200, 720);

    const maxH = Number(controls?.maximumBuildingHeightFt || controls?.max_height_ft || 75);
    const farH = Number(farData?.buildingHeightFt || Math.max(30, Math.round(maxH * 0.68)));

    // Isometric ghost
    svg.appendChild(mkSvgEl("polygon", { points: "710,430 910,460 790,560 590,530", class: "wf-iso-base" }));

    // MAX envelope
    svg.appendChild(mkSvgEl("polygon", { points: "710,280 910,310 910,460 710,430", class: "wf-max-face" }));
    svg.appendChild(mkSvgEl("polygon", { points: "710,280 790,380 790,560 710,430", class: "wf-max-side" }));

    // FAR envelope
    svg.appendChild(mkSvgEl("polygon", { points: "640,355 840,385 840,500 640,470", class: "wf-far-face" }));
    svg.appendChild(mkSvgEl("polygon", { points: "640,355 720,445 720,585 640,470", class: "wf-far-side" }));

    addDim(svg, 942, 308, 942, 460, `MAX ${maxH} ft`);
    addDim(svg, 868, 384, 868, 501, `FAR ${farH} ft`);

    addArrow(svg, 932, 300, 1050, 254);
    addLabel(svg, 1060, 252, "Maximum zoning envelope", "wf-callout");

    addArrow(svg, 840, 398, 1058, 358);
    addLabel(svg, 1068, 356, "FAR-constrained mass", "wf-callout");

    svg.appendChild(mkSvgEl("line", { x1: 560, y1: 558, x2: 1030, y2: 558, class: "wf-section" }));
    addLabel(svg, 1038, 554, "Section B-B", "wf-section-label");

    addLabel(svg, 130, 130, "Orthographic + Isometric relationship", "wf-callout");
    addArrow(svg, 380, 140, 590, 420);
  }

  function workflowMeta(step, controls) {
    if (step === "rules") {
      return `FAR ${controls?.far ?? "--"} | Max H ${controls?.maximumBuildingHeightFt ?? "--"} ft | Setbacks F/S/R ${controls?.frontYardFt ?? "--"}/${controls?.sideYardEachFt ?? "--"}/${controls?.rearYardFt ?? "--"} ft`;
    }
    if (step === "geometry") {
      return "Offset construction uses linear clipping only; no curved buffers.";
    }
    if (step === "envelope") {
      return "MAX and FAR envelopes are layered to compare zoning limit vs area-constrained mass.";
    }
    return "Live application capture with analytical overlays from active lot context.";
  }

  async function renderBoard(config) {
    const { title, subtitle, step, captureSelector, crop, controls, lotData, farData } = config;
    const { board, baseImage, overlay } = createBoard(title, subtitle, step);

    let screenshot = null;
    try {
      screenshot = await captureRegion(captureSelector, crop);
    } catch (err) {
      console.warn("Workflow screenshot capture failed:", err);
    }

    if (!screenshot) {
      // Fallback to app shell capture before giving up.
      screenshot = await captureRegion(".app-shell", { x: 0.02, y: 0.08, w: 0.96, h: 0.84 });
    }

    if (screenshot) {
      baseImage.src = screenshot;
    } else {
      baseImage.remove();
      overlay.classList.add("workflow-overlay--no-base");
    }

    if (step === "data") overlayData(overlay, lotData);
    if (step === "rules") overlayRules(overlay, controls, lotData?.zonedist1 || lotData?.zoning_analysis?.primary_zone);
    if (step === "geometry") overlayGeometry(overlay, controls);
    if (step === "envelope") overlayEnvelope(overlay, controls, farData);

    const meta = document.createElement("p");
    meta.className = "workflow-board-meta";
    meta.textContent = workflowMeta(step, controls);
    board.appendChild(meta);

    addCommonLegend(board);
    return board;
  }

  async function renderDataDiagram(lotData) {
    return renderBoard({
      title: "DATA",
      subtitle: "Live lot-selection capture with parcel and metadata extraction overlays",
      step: "data",
      captureSelector: "#map",
      crop: { x: 0.03, y: 0.05, w: 0.74, h: 0.78 },
      lotData,
      controls: {},
    });
  }

  async function renderRulesDiagram(controls, zoneCode) {
    const lotData = { zonedist1: zoneCode };
    return renderBoard({
      title: "RULES",
      subtitle: "Zoning parameters traced directly from the live controls interface",
      step: "rules",
      captureSelector: "#lotSheet",
      crop: { x: 0, y: 0, w: 1, h: 1 },
      lotData,
      controls,
    });
  }

  async function renderGeometryDiagram(lotData, lotAnalysis, controls = {}) {
    return renderBoard({
      title: "GEOMETRY",
      subtitle: "Setback construction lines diagrammed over captured map geometry",
      step: "geometry",
      captureSelector: "#map",
      crop: { x: 0.08, y: 0.12, w: 0.7, h: 0.74 },
      lotData: Object.assign({}, lotData, { lotAnalysis }),
      controls,
    });
  }

  async function renderEnvelopeDiagram(controls, baselineEnvelopeResults, farEnvelopeData) {
    return renderBoard({
      title: "ENVELOPE",
      subtitle: "MAX and FAR massing overlays composed from live rendered interface",
      step: "envelope",
      captureSelector: ".app-shell",
      crop: { x: 0.02, y: 0.08, w: 0.96, h: 0.84 },
      lotData: baselineEnvelopeResults?.lot_data || {},
      controls,
      farData: farEnvelopeData,
    });
  }

  window.workflowDiagrams = {
    renderDataDiagram,
    renderRulesDiagram,
    renderGeometryDiagram,
    renderEnvelopeDiagram,
  };
})();
