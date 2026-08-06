/* ---------- Pre-Task Plans ----------
   Two fillable forms that mirror the company's Word templates: the Standard PTP and the
   Architectural Sheet Metal PTP. They share most of their structure, so one renderer is driven by
   a spec per template rather than two hand-built forms that would drift apart.

   Three things this has to do, in the order they matter to a crew in the field:
     1. fill it out on a phone,
     2. save what was typed so tomorrow's plan is "change the date and go",
     3. come out as a PDF that looks like the paper form the GC expects.

   The saved copy is per-device (localStorage), not Firestore: a PTP is one crew's working
   document for one day, and syncing it would mean one foreman's draft overwriting another's.

   Answer keys are positional (q0, q1, c0 ...). That is fine while the question lists are fixed,
   which they are -- they come from a controlled company template. If a question is ever inserted
   in the middle, bump SCHEMA and old saves are dropped rather than silently shifted by one. */

const SCHEMA = 1;

// Column proportions and shading below are lifted from the .docx tblGrid/shd values so the PDF
// lines up with the paper form: 75/25 header, 42/8/42/8 checklist, 33/25/42 circle-check.
const STD_CHECKLIST = [
  ["Have you personally walked your work area?", "Does this task require disassembly of systems or equipment?"],
  ["Are enough personnel assigned to this task to complete it safely?", "Does this work require flushing or discharging of fluids?"],
  ["Will weather conditions affect the safe completion of your task?", "Have all portable electric equipment and tools been inspected prior to use?"],
  ["Does this task require special training?", "Should the safety department be involved in planning?"],
  ["Dust/fume/odor/exhaust control devices in place and operating?", "Has the work been coordinated with other crafts in the area?"],
  ["Does this task require any permits / procedures?", "Are you familiar with the evacuation routes?"],
  ["Are hazardous chemicals in use? MSDS reviewed?", "Have you identified all emergency equipment?"],
  ["Will your work impact existing buildings/occupants?", "Are you working around live systems or equipment?"],
  ["Have employees been trained in the proper usage of PPE?", "Are shop drawings and as-builds on hand?"],
];
const STD_CIRCLE = [
  ["SIPP", "Eye/Face PPE", "Flush/Discharge"],
  ["LOTO (Lock-out/tag-out)", "Hand/Arm PPE", "Dropped Tool and Material Prevention Plan"],
  ["PVC/CPVC Gluing", "Full Body PPE", "Emergency spill-kits/Response tools"],
  ["Barricades/Control Zones/Signage", "Hazard Communication", "Task Lighting Equipment"],
  ["Fall Protection PPE", "Dust Control", "Hearing PPE"],
  ["Electrical-Hot Work", "Scaffolds", "Respirator/Dust Mask"],
  ["Welding, Soldering Hot Work", "", ""],
];
const ARCH_CHECKLIST = [
  ["Have you personally walked your work area?", "Have employees been trained in the proper usage of PPE?"],
  ["Will weather conditions affect the safe completion of your task?", "Have all portable electric equipment and tools been inspected prior to use?"],
  ["Does this task require special training?", "Should the safety department be involved in planning?"],
  ["Does this task require any permits / procedures?", "Are you familiar with the evacuation routes?"],
  ["Are hazardous chemicals in use? MSDS reviewed?", "Have you identified all emergency equipment?"],
  ["Will your work impact existing buildings/occupants?", "Are you working around live systems or equipment?"],
  ["Has the work been coordinated with other crafts in the area?", "Are shop drawings and as-builds on hand?"],
];
const ARCH_CIRCLE = [
  ["Welding, Soldering Hot Work", "Eye/Face PPE", "Respirator/Dust Mask"],
  ["Scaffolds", "Hand/Arm PPE", "Dropped Tool and Material Prevention Plan"],
  ["Scissorslift/Boomlift", "Full Body PPE", "Emergency spill-kits/Response tools"],
  ["Barricades/Control Zones/Signage", "Hazard Communication", "Task Lighting Equipment"],
  ["Fall Protection PPE", "Dust Control", "Hearing PPE"],
];

const ATTEST = "The tasks for this PTP have been reviewed in the work area, as they will be performed, "
  + "and the workers on this crew have been through the required training.";
const ASK = "Ask the following during evaluation of your work and check “Yes” or “No” as it applies to the task:";
const CIRCLE_NOTE = "Circle/Check if any of the following apply to the task being planned here (attach additional information needed):";
const STOP = "If conditions change, the work must STOP and the Pre Task Plan must be updated.";

export const PTP_TEMPLATES = {
  standard: {
    key: "standard",
    label: "Standard PTP",
    blurb: "The general Pre-Task Plan.",
    titles: ["Pre-Task Plan Check List"],
    idLines: [["foreman", "Crew Foreman:"], ["contact", "Contact #"], ["ehs", "EHS Review (if applicable)"]],
    checklist: STD_CHECKLIST,
    circle: STD_CIRCLE,
    crewHeading: "Print Crew Member’s Names Below",
    nearest: [["shower", "Shower:"], ["fireExt", "Fire Extinguisher:"], ["eyewash", "Eyewash:"], ["phone", "Phone:"]],
    changingRows: 4,
    // The two forms put "Location of nearest" in different places; the order is the paper order.
    order: ["top", "ident", "checklist", "circle", "attest", "crew", "task", "nearest", "changing"],
  },
  arch: {
    key: "arch",
    label: "Architectural PTP",
    blurb: "Architectural Sheet Metal.",
    titles: ["Architectural Sheet Metal", "Pre-Task Plan Check List"],
    idLines: [["foreman", "Crew Foreman:"], ["contact", "Contact #"], ["ehs", "EHS Review (if applicable)"], ["today", "THE DATE TODAY IS:"]],
    checklist: ARCH_CHECKLIST,
    circle: ARCH_CIRCLE,
    crewHeading: "Crew Members Print Your Name Below",
    nearest: [["shower", "Emg. Shower:"], ["fireExt", "Fire Extinguisher:"], ["eyewash", "Eyewash:"]],
    changingRows: 6,
    order: ["top", "ident", "checklist", "circle", "nearest", "attest", "crew", "task", "changing"],
  },
};

const TOP_LEFT = [["project", "PROJECT:"], ["building", "Building:"], ["level", "Level:"], ["columns", "Column Lines:"]];
const SEQ_HEADS = ["SEQUENCE OF CONSTRUCTION ACTIVITIES",
                   "HAZARD ANALYSIS (Hazards Involved. Include Ergonomic Issues)",
                   "METHOD/S TO ELIMINATE/CONTROL HAZARDS AND ERGONOMIC ISSUES\nWhat specific PPE"];
const CHANGE_HEADS = ["What Changed", "Hazards Associated", "Control New Hazard"];

const CREW_ROWS = 3, SEQ_MIN = 4;
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ---------- the saved answers ---------- */
export function ptpBlank(t) {
  return {
    schema: SCHEMA, tpl: t.key,
    top: { project: "", building: "", level: "", columns: "", startDate: "", endDate: "" },
    ident: Object.fromEntries(t.idLines.map(([k]) => [k, ""])),
    answers: {}, checks: {},
    crew: Array(CREW_ROWS * 3).fill(""),
    task: "", ergonomic: "", author: "", prepared: "", housekeeping: "",
    seq: Array.from({ length: SEQ_MIN }, () => ["", "", ""]),
    nearest: Object.fromEntries(t.nearest.map(([k]) => [k, ""])),
    changes: Array.from({ length: t.changingRows }, () => ["", "", ""]),
  };
}
const keyFor = t => "ptp_" + t.key;
export function ptpLoad(t) {
  try {
    const raw = JSON.parse(localStorage.getItem(keyFor(t)) || "null");
    // A schema bump means the question list moved, so positional answers can no longer be trusted.
    if (!raw || raw.schema !== SCHEMA || raw.tpl !== t.key) return ptpBlank(t);
    const b = ptpBlank(t);
    return { ...b, ...raw,
      top: { ...b.top, ...(raw.top || {}) }, ident: { ...b.ident, ...(raw.ident || {}) },
      nearest: { ...b.nearest, ...(raw.nearest || {}) },
      answers: raw.answers || {}, checks: raw.checks || {},
      crew: Array.isArray(raw.crew) && raw.crew.length ? raw.crew : b.crew,
      seq: Array.isArray(raw.seq) && raw.seq.length ? raw.seq : b.seq,
      changes: Array.isArray(raw.changes) && raw.changes.length ? raw.changes : b.changes };
  } catch (e) { return ptpBlank(t); }
}
export function ptpSave(t, d) { try { localStorage.setItem(keyFor(t), JSON.stringify({ ...d, schema: SCHEMA, tpl: t.key })); return true; } catch (e) { return false; } }
export function ptpWipe(t) { try { localStorage.removeItem(keyFor(t)); } catch (e) { /* private mode */ } }

/* ---------- the on-screen form ----------
   Inputs carry data-ptp="path" and are read back generically, so adding a field to a template
   spec never needs a matching change in the collector. */
const inp = (path, val, ph, type) =>
  `<input class="ptp-in" type="${type || "text"}" data-ptp="${esc(path)}" value="${esc(val)}" placeholder="${esc(ph || "")}" autocomplete="off">`;
const area = (path, val, ph) =>
  `<textarea class="ptp-ta" data-ptp="${esc(path)}" rows="2" placeholder="${esc(ph || "")}">${esc(val)}</textarea>`;

function yesNo(i, cur) {
  return `<span class="ptp-yn" role="group">
    <button type="button" class="yn y ${cur === "yes" ? "on" : ""}" data-yn="${i}|yes">Yes</button>
    <button type="button" class="yn n ${cur === "no" ? "on" : ""}" data-yn="${i}|no">No</button>
  </span>`;
}

export function ptpFormHTML(t, d) {
  const S = {};
  S.top = `<div class="ptp-sec"><div class="ptp-grid2">
      <div class="ptp-col">${TOP_LEFT.map(([k, l]) =>
        `<label class="ptp-f"><span>${esc(l)}</span>${inp("top." + k, d.top[k])}</label>`).join("")}</div>
      <div class="ptp-col">
        <label class="ptp-f"><span class="sh">Start Date</span>${inp("top.startDate", d.top.startDate, "", "date")}</label>
        <label class="ptp-f"><span class="sh">End Date</span>${inp("top.endDate", d.top.endDate, "", "date")}</label>
      </div></div></div>`;

  S.ident = `<div class="ptp-sec">${t.titles.map((x, i) =>
      `<div class="ptp-title ${i ? "sub" : ""}">${esc(x)}</div>`).join("")}
    <div class="ptp-idents">${t.idLines.map(([k, l]) =>
      `<label class="ptp-f"><span>${esc(l)}</span>${inp("ident." + k, d.ident[k], "", k === "today" ? "date" : "text")}</label>`).join("")}</div></div>`;

  let qi = 0;
  const qRows = t.checklist.map(pair => pair.map(q => { const i = qi++; return { q, i }; }));
  S.checklist = `<div class="ptp-sec"><p class="ptp-note">${esc(ASK)}</p>
    <div class="ptp-qs">${qRows.flat().map(({ q, i }) =>
      `<div class="ptp-q"><span class="qt">${esc(q)}</span>${yesNo(i, d.answers["q" + i] || "")}</div>`).join("")}</div></div>`;

  let ci = 0;
  const items = [];
  t.circle.forEach(row => row.forEach(x => { if (x) items.push({ x, i: ci++ }); else ci++; }));
  S.circle = `<div class="ptp-sec"><p class="ptp-note">${esc(CIRCLE_NOTE)}</p>
    <div class="ptp-checks">${items.map(({ x, i }) =>
      `<button type="button" class="ptp-chk ${d.checks["c" + i] ? "on" : ""}" data-chk="${i}">
         <span class="bx">${d.checks["c" + i] ? "✓" : ""}</span><span>${esc(x)}</span></button>`).join("")}</div></div>`;

  S.attest = `<div class="ptp-sec"><p class="ptp-attest">${esc(ATTEST)}</p></div>`;

  S.crew = `<div class="ptp-sec"><div class="ptp-h">${esc(t.crewHeading)}</div>
    <div class="ptp-crew">${d.crew.map((v, i) => inp("crew." + i, v, "Name")).join("")}</div>
    <button type="button" class="ptp-add" data-add="crew">+ Add 3 more</button></div>`;

  S.task = `<div class="ptp-sec">
      <label class="ptp-f col"><span>Task to be accomplished</span>${area("task", d.task)}</label>
      <label class="ptp-f col"><span>Ergonomic plan (make the work fit the people)</span>${area("ergonomic", d.ergonomic)}</label>
      <div class="ptp-grid2">
        <div class="ptp-col">
          <label class="ptp-f"><span>Author/Planner</span>${inp("author", d.author)}</label>
          <label class="ptp-f"><span>Date plan prepared</span>${inp("prepared", d.prepared, "", "date")}</label>
        </div>
        <label class="ptp-f col"><span>Housekeeping plan (daily cleanup required)</span>${area("housekeeping", d.housekeeping)}</label>
      </div>
      <div class="ptp-h">Sequence of construction activities</div>
      <div class="ptp-rows">${d.seq.map((r, i) => `<div class="ptp-row3">
        <div class="r3n">${i + 1}</div>
        ${area("seq." + i + ".0", r[0], "Step / activity")}
        ${area("seq." + i + ".1", r[1], "Hazards (incl. ergonomic)")}
        ${area("seq." + i + ".2", r[2], "Controls / PPE")}
        <button type="button" class="ptp-del" data-delrow="seq|${i}" title="Remove this step">✕</button>
      </div>`).join("")}</div>
      <button type="button" class="ptp-add" data-add="seq">+ Add step</button></div>`;

  S.nearest = `<div class="ptp-sec"><div class="ptp-h">Location of nearest</div>
    <div class="ptp-near">${t.nearest.map(([k, l]) =>
      `<label class="ptp-f"><span>${esc(l)}</span>${inp("nearest." + k, d.nearest[k])}</label>`).join("")}</div></div>`;

  S.changing = `<div class="ptp-sec"><p class="ptp-stop">${esc(STOP)}</p>
    <div class="ptp-h">Changing conditions</div>
    <div class="ptp-rows">${d.changes.map((r, i) => `<div class="ptp-row3">
      <div class="r3n">${i + 1}</div>
      ${area("changes." + i + ".0", r[0], CHANGE_HEADS[0])}
      ${area("changes." + i + ".1", r[1], CHANGE_HEADS[1])}
      ${area("changes." + i + ".2", r[2], CHANGE_HEADS[2])}
      <button type="button" class="ptp-del" data-delrow="changes|${i}" title="Remove this row">✕</button>
    </div>`).join("")}</div>
    <button type="button" class="ptp-add" data-add="changes">+ Add row</button></div>`;

  return t.order.map(k => S[k]).join("");
}

/* Read every data-ptp input back into the model by its dotted path, so a new field in a template
   spec is picked up without touching this function. */
export function ptpCollect(root, d) {
  root.querySelectorAll("[data-ptp]").forEach(el => {
    const parts = el.dataset.ptp.split(".");
    let o = d;
    for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
    o[parts[parts.length - 1]] = el.value;
  });
  return d;
}

/* ---------- PDF ----------
   Drawn with jsPDF's text/line primitives rather than a screenshot: the result is real selectable
   text at any zoom, a fraction of the size, and it paginates on row boundaries instead of slicing
   a row in half. Units are points; US Letter is 612x792 with the template's 0.5" margins. */
const PW = 612, PH = 792, M = 36, CW = PW - M * 2;
// <input type="date"> always yields YYYY-MM-DD. Nobody writes that on a jobsite form.
const MONS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function pdate(v){
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ""));
  return m ? MONS[Number(m[2]) - 1] + " " + Number(m[3]) + ", " + m[1] : String(v || "");
}

function mkDoc(jsPDF) { return new jsPDF({ unit: "pt", format: "letter", compress: true }); }

export function ptpPdf(jsPDF, t, d, logoDataUrl) {
  const doc = mkDoc(jsPDF);
  let y = M;
  const bottom = PH - M;
  const need = h => { if (y + h > bottom) { doc.addPage(); y = M; return true; } return false; };
  const setF = (sz, style) => doc.setFontSize(sz).setFont("helvetica", style || "normal");

  /* one paginating table primitive: cols are point widths, rows are arrays of cell specs */
  function table(cols, rows, opt) {
    opt = opt || {};
    const pad = 4, lh = opt.lh || 10.5, fs = opt.fs || 8.5;
    rows.forEach(row => {
      // measure first so a row is never split across a page boundary
      const wrapped = row.cells.map((c, i) => {
        setF(c.fs || fs, c.bold ? "bold" : "normal");
        return doc.splitTextToSize(String(c.t == null ? "" : c.t), cols[i] - pad * 2);
      });
      const h = Math.max(row.minH || opt.minH || 0, ...wrapped.map(w => w.length * lh + pad * 2));
      // `row !== opt.repeat` is load-bearing: the header is passed BOTH as the first row and as
      // opt.repeat (the same object). Without this, a break triggered by the header itself drew it
      // once here and again as the ordinary row -- two stacked identical bands on the new page.
      const broke = need(h);
      if (broke && opt.repeat && row !== opt.repeat) {
        table(cols, [opt.repeat], { ...opt, repeat: null });
        need(h);                       // the repeated header just advanced y; re-check the bounds
      }
      let x = M;
      row.cells.forEach((c, i) => {
        if (c.fill) { doc.setFillColor(c.fill); doc.rect(x, y, cols[i], h, "F"); }
        doc.setDrawColor(0).setLineWidth(0.6).rect(x, y, cols[i], h);
        setF(c.fs || fs, c.bold ? "bold" : "normal");
        doc.setTextColor(c.dim ? 130 : 0);
        const tx = c.center ? x + cols[i] / 2 : x + pad;
        doc.text(wrapped[i], tx, y + pad + lh - 2.5, c.center ? { align: "center" } : undefined);
        x += cols[i];
      });
      y += h;
    });
  }
  const gap = n => { y += (n == null ? 8 : n); };
  // Centred variant: the STOP warning is centred and larger in both source templates.
  function paraC(text, sz, style, extra) {
    setF(sz || 9, style);
    const lines = doc.splitTextToSize(text, CW);
    need(lines.length * (sz || 9) * 1.25);
    doc.setTextColor(0);
    doc.text(lines, PW / 2, y + (sz || 9), { align: "center" });
    y += lines.length * (sz || 9) * 1.25 + (extra || 0);
  }
  function para(text, sz, style, extra) {
    setF(sz || 9, style);
    const lines = doc.splitTextToSize(text, CW);
    need(lines.length * (sz || 9) * 1.25);
    doc.setTextColor(0);
    doc.text(lines, M, y + (sz || 9));
    y += lines.length * (sz || 9) * 1.25 + (extra || 0);
  }
  // A blank underlined field, the paper form's "Foreman: ______" with the answer sitting on it.
  function ruleRow(pairs) {
    const colW = CW / pairs.length;
    need(24);
    pairs.forEach(([label, val], i) => {
      const x = M + colW * i;
      setF(8.5, "bold"); doc.text(label, x, y + 10);
      const lw = doc.getTextWidth(label) + 4;
      setF(9, "normal");
      doc.text(String(val || ""), x + lw + 2, y + 10);
      doc.setLineWidth(0.5).line(x + lw, y + 12, x + colW - 8, y + 12);
    });
    y += 22;
  }

  /* --- masthead --- */
  if (logoDataUrl) { try { doc.addImage(logoDataUrl, "PNG", M, y, 96, 17); } catch (e) { /* logo is decoration */ } }
  // Source order, equal weight. Both title paragraphs are bold 18pt in the .docx -- neither is a
  // subtitle of the other, and the architectural form leads with "Architectural Sheet Metal".
  setF(13, "bold");
  t.titles.forEach((line, i) => doc.text(line.toUpperCase(), PW - M, y + 13 + i * 15, { align: "right" }));
  y += 13 + (t.titles.length - 1) * 15 + 11;

  const S = {};
  S.top = () => {
    const c = [CW * 0.75, CW * 0.25];
    table(c, [
      { cells: [{ t: "PROJECT:  " + (d.top.project || ""), bold: true }, { t: "Start Date", fill: "#BFBFBF", bold: true, center: true }] },
      { cells: [{ t: "Building:  " + (d.top.building || "") }, { t: pdate(d.top.startDate), center: true }] },
      { cells: [{ t: "Level:  " + (d.top.level || "") }, { t: "End Date", fill: "#BFBFBF", bold: true, center: true }] },
      { cells: [{ t: "Column Lines:  " + (d.top.columns || "") }, { t: pdate(d.top.endDate), center: true }] },
    ], { minH: 16 });
    gap();
  };
  S.ident = () => { const v = k => k === "today" ? pdate(d.ident[k]) : d.ident[k];
                    ruleRow(t.idLines.slice(0, 2).map(([k, l]) => [l, v(k)]));
                    ruleRow(t.idLines.slice(2).map(([k, l]) => [l, v(k)])); gap(2); };
  S.checklist = () => {
    para(ASK, 8.5, "bold", 3);
    const c = [CW * 0.42, CW * 0.08, CW * 0.42, CW * 0.08];
    let i = 0;
    table(c, t.checklist.map(pair => {
      const a = i++, b = i++;
      // Unanswered prints "Yes / No" like the paper form, so a half-finished plan can still be
      // taken out and circled by hand rather than coming out with two blank columns.
      return { cells: [{ t: pair[0] }, { t: ans(d, a), center: true, bold: !!d.answers["q" + a], dim: !d.answers["q" + a] },
                       { t: pair[1] }, { t: ans(d, b), center: true, bold: !!d.answers["q" + b], dim: !d.answers["q" + b] }] };
    }), { minH: 15 });
    gap();
  };
  S.circle = () => {
    para(CIRCLE_NOTE, 8.5, "bold", 3);
    const c = [CW * 0.33, CW * 0.25, CW * 0.42];
    let i = 0;
    table(c, t.circle.map(row => ({
      // ASCII markers, not the ballot-box glyphs: jsPDF's built-in Helvetica is WinAnsi-encoded,
      // and a character outside that set mangles the whole cell rather than just that character.
      cells: row.map(x => { const k = i++; return { t: x ? (d.checks["c" + k] ? "[X]  " : "[  ]  ") + x : "", bold: true }; }),
    })), { minH: 15 });
    gap();
  };
  S.attest = () => { para(ATTEST, 8.5, "italic", 4); };
  S.crew = () => {
    para(t.crewHeading, 9, "bold", 3);
    const c = [CW / 3, CW / 3, CW / 3];
    const rows = [];
    for (let i = 0; i < d.crew.length; i += 3) rows.push({ cells: [0, 1, 2].map(k => ({ t: d.crew[i + k] || "" })), minH: 20 });
    table(c, rows);
    gap();
  };
  S.task = () => {
    const c = [CW * 0.34, CW * 0.30, CW * 0.36];
    table([CW], [{ cells: [{ t: "Task to be accomplished:  " + (d.task || ""), bold: true }], minH: 26 },
                 { cells: [{ t: "ERGONOMIC PLAN (make the work fit the people):  " + (d.ergonomic || ""), bold: true }], minH: 26 }]);
    table([c[0], c[1] + c[2]], [
      { cells: [{ t: "Author/Planner:  " + (d.author || "") }, { t: "Housekeeping plan: (daily cleanup required)  " + (d.housekeeping || "") }], minH: 18 },
      { cells: [{ t: "Date plan prepared:  " + pdate(d.prepared) }, { t: "" }], minH: 16 },
    ]);
    const head = { cells: SEQ_HEADS.map(h => ({ t: h, bold: true, center: true, fs: 7.5 })), minH: 26 };
    const body = d.seq.map(r => ({ cells: r.map(x => ({ t: x || "" })), minH: 24 }));
    // Pad so the printed sheet keeps some room to write by hand. The paper form carries 20 blank
    // rows; a filled-in digital copy does not need that much dead space, so this is a floor.
    while (body.length < 6) body.push({ cells: [{ t: "" }, { t: "" }, { t: "" }], minH: 24 });
    table(c, [head, ...body], { repeat: head });
    gap();
  };
  S.nearest = () => {
    para("Location of nearest:", 9, "bold", 2);
    ruleRow(t.nearest.slice(0, 2).map(([k, l]) => [l, d.nearest[k]]));
    if (t.nearest.length > 2) ruleRow(t.nearest.slice(2).map(([k, l]) => [l, d.nearest[k]]));
    gap(2);
  };
  S.changing = () => {
    paraC(STOP, 11, "bold", 5);
    const c = [CW / 3, CW / 3, CW / 3];
    table([CW], [{ cells: [{ t: "CHANGING CONDITIONS", bold: true, center: true }], minH: 16 }]);
    const head = { cells: CHANGE_HEADS.map(h => ({ t: h, bold: true, center: true })), minH: 16 };
    const body = d.changes.map(r => ({ cells: r.map(x => ({ t: x || "" })), minH: 22 }));
    table(c, [head, ...body], { repeat: head });
  };

  t.order.forEach(k => S[k]());

  const n = doc.getNumberOfPages();
  for (let p = 1; p <= n; p++) {
    doc.setPage(p); setF(7.5, "normal"); doc.setTextColor(110);
    doc.text(`${t.label}${d.top.project ? " — " + d.top.project : ""}`, M, PH - 20);
    doc.text(`Page ${p} of ${n}`, PW - M, PH - 20, { align: "right" });
  }
  return doc;
}
const ans = (d, i) => d.answers["q" + i] === "yes" ? "YES" : d.answers["q" + i] === "no" ? "NO" : "Yes / No";

export function ptpFileName(t, d) {
  const bits = ["PTP", t.key === "arch" ? "Architectural" : "Standard",
                (d.top.project || "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, ""),
                (d.top.startDate || new Date().toISOString().slice(0, 10))];
  return bits.filter(Boolean).join("_") + ".pdf";
}
