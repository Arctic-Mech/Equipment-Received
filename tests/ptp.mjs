/* PTP tab: both templates render, fill, persist across a reload, clear, and export a PDF whose
   text is read back with pdf.js -- a PDF that "downloads" but is blank would otherwise pass. */
import { chromium } from "playwright";
import fs from "node:fs"; import path from "node:path";
import { startServer, routeCdn, CHROMIUM, TESTS_DIR } from "./serve.mjs";

const { server, port: PORT } = await startServer();

const SEED={ people:{"p-jaren-eells":{first:"Jaren",last:"Eells",email:"jareneells@arctic.biz",nameNorm:"jaren eells",savedJobs:[],jobOrder:[],removedJobs:[]}},
  arrivals:{}, rentals:{}, toolRentals:{}, config:{lastImport:{emailDateMs:1,importedAt:"2026-08-05"}} };

const fails=[]; const chk=(c,m)=>{ if(!c) fails.push(m); };
const browser=await chromium.launch({executablePath:CHROMIUM,args:["--no-sandbox"]});
const ctx=await browser.newContext({viewport:{width:900,height:1100},acceptDownloads:true});
await routeCdn(ctx);
const errs=[];
async function boot(){
  const page=await ctx.newPage();
  page.on("pageerror",e=>errs.push("pageerror: "+e.message));
  page.on("console",m=>{const t=m.text();
    if(m.type()==="error" && !/net::ERR_|Failed to load resource/.test(t)) errs.push("console: "+t);});
  await page.addInitScript(seed=>{ window.__SEED=seed;
    localStorage.setItem("er_user",JSON.stringify({first:"Jaren",last:"Eells",email:"jareneells@arctic.biz",id:"p-jaren-eells"}));
    localStorage.setItem("tut_done","1"); },SEED);
  await page.goto(`http://localhost:${PORT}/`,{waitUntil:"networkidle"});
  await page.waitForTimeout(700);
  await page.locator("nav.tabs .tab[data-view='safety']").click(); await page.waitForTimeout(250);
  await page.locator("[data-safety='ptp']").click(); await page.waitForTimeout(400);
  return page;
}

const page=await boot();
chk(await page.locator("#safety-ptp").isVisible(), "the PTP pane did not open");


/* ---- both templates match their Word source ---- */
async function shape(){
  return page.evaluate(()=>({
    questions:[...document.querySelectorAll("#ptpForm .ptp-q .qt")].map(e=>e.textContent.trim()),
    checks:[...document.querySelectorAll("#ptpForm .ptp-chk")].map(e=>e.textContent.trim()),
    titles:[...document.querySelectorAll("#ptpForm .ptp-title")].map(e=>e.textContent.trim()),
    near:[...document.querySelectorAll("#ptpForm .ptp-near .ptp-f>span")].map(e=>e.textContent.trim()),
    ident:[...document.querySelectorAll("#ptpForm .ptp-idents .ptp-f>span")].map(e=>e.textContent.trim()),
    secOrder:[...document.querySelectorAll("#ptpForm .ptp-sec")].map(s=>{
      const h=s.querySelector(".ptp-h,.ptp-title,.ptp-note,.ptp-attest,.ptp-stop");
      return h?h.textContent.trim().slice(0,28):"(top)"; }),
  }));
}
const std=await shape();
console.log("standard: questions",std.questions.length,"checks",std.checks.length);
chk(std.questions.length===18, `standard should have 18 checklist questions, got ${std.questions.length}`);
// 19 from the old standard form + Scissorslift/Boomlift, folded in from the architectural one.
chk(std.checks.length===20, `standard should have 20 circle/check items, got ${std.checks.length}`);
chk(std.questions[0]==="Have you personally walked your work area?", "first standard question wrong");
chk(std.questions.includes("Does this task require disassembly of systems or equipment?"), "missing a standard question");
chk(std.checks.some(c=>/SIPP/.test(c)) && std.checks.some(c=>/LOTO/.test(c)), "standard is missing SIPP/LOTO");
chk(std.near.some(s=>/Phone/i.test(s)), "standard 'location of nearest' should include Phone");

/* The Architectural template was folded into this one. Everything it had that the standard did
   not must now be here, and nothing may have been lost in the merge. */
chk(std.checks.some(c=>/Scissorslift\/Boomlift/i.test(c)), "Scissorslift/Boomlift did not carry over from the architectural form");
chk(std.ident.some(s=>/date today/i.test(s)), "'THE DATE TODAY IS' did not carry over");
chk(await page.locator(".ptp-tab").count()===0, "the template picker should be gone with only one template");
// every architectural question already existed here; spot-check the ones unique to its list
for(const q of ["Have employees been trained in the proper usage of PPE?",
                "Has the work been coordinated with other crafts in the area?",
                "Are shop drawings and as-builds on hand?"])
  chk(std.questions.includes(q), `architectural question missing after the merge: ${q}`);
chk(await page.locator("#ptpForm .ptp-row3").count()>=6+1, "the six changing-conditions rows did not carry over");

/* ---- fill it in ---- */
await page.fill('[data-ptp="top.project"]',"Riverside Medical Center");
await page.fill('[data-ptp="top.building"]',"B — East Wing");
await page.fill('[data-ptp="top.level"]',"3");
await page.fill('[data-ptp="top.columns"]',"C4–C9");
await page.fill('[data-ptp="top.startDate"]',"2026-08-10");
await page.fill('[data-ptp="top.endDate"]',"2026-08-14");
await page.fill('[data-ptp="ident.foreman"]',"Jaren Eells");
await page.fill('[data-ptp="ident.contact"]',"541-555-0134");
await page.fill('[data-ptp="crew.0"]',"Chris Brown");
await page.fill('[data-ptp="crew.1"]',"Alex Garcia");
await page.fill('[data-ptp="task"]',"Set VAV boxes and hang duct mains on level 3 east.");
await page.fill('[data-ptp="ergonomic"]',"Use lift for anything over 40 lb; rotate crew every 2 hours.");
await page.fill('[data-ptp="author"]',"Jaren Eells");
await page.fill('[data-ptp="housekeeping"]',"Sweep and bag scrap at each break.");
await page.fill('[data-ptp="seq.0.0"]',"Lay out hangers from column lines");
await page.fill('[data-ptp="seq.0.1"]',"Overhead work, dropped tools");
await page.fill('[data-ptp="seq.0.2"]',"Tool lanyards, hard hats, barricade below");
await page.fill('[data-ptp="nearest.shower"]',"Level 1 mech room");
await page.fill('[data-ptp="nearest.fireExt"]',"Column C6");
const q = n => page.locator("#ptpForm .ptp-q").nth(n);
const chkBox = n => page.locator("#ptpForm .ptp-chk").nth(n);
await q(0).locator(".yn.y").click(); await page.waitForTimeout(220);
await q(1).locator(".yn.n").click(); await page.waitForTimeout(220);
// Remember which question this actually is: the flattened order is not the row order, and
// hard-coding the text here once asserted against a question that was never marked N/A.
const naText=(await q(2).locator(".qt").innerText()).trim();
await q(2).locator(".yn.a").click(); await page.waitForTimeout(220);   // N/A -- must not be exported
console.log("marked N/A:", JSON.stringify(naText));
await chkBox(0).click(); await page.waitForTimeout(220);
await chkBox(4).click(); await page.waitForTimeout(220);
await page.waitForTimeout(600);
chk(await q(0).locator(".yn.y.on").count()===1, "Yes did not stick");
chk(await q(1).locator(".yn.n.on").count()===1, "No did not stick");
chk(await q(2).locator(".yn.a.on").count()===1, "N/A did not stick");
chk(await chkBox(0).locator(".bx").innerText()!=="", "the checkbox did not stick");

/* ---- it survives a reload ---- */
const p2=await boot();
chk(await p2.inputValue('[data-ptp="top.project"]')==="Riverside Medical Center", "project did not survive a reload");
chk(await p2.inputValue('[data-ptp="ident.foreman"]')==="Jaren Eells", "foreman did not survive a reload");
chk(await p2.inputValue('[data-ptp="seq.0.1"]')==="Overhead work, dropped tools", "the sequence row did not survive a reload");
chk(await p2.locator("#ptpForm .ptp-q").nth(0).locator(".yn.y.on").count()===1, "the Yes answer did not survive a reload");
chk(await p2.locator("#ptpForm .ptp-q").nth(2).locator(".yn.a.on").count()===1, "the N/A answer did not survive a reload");
chk(await p2.locator("#ptpForm .ptp-chk.on").count()===2, "the checkboxes did not survive a reload");
console.log("reload: everything came back");

/* ---- the PDF ---- */
const [dl]=await Promise.all([
  page.waitForEvent("download",{timeout:30000}),
  page.locator("#ptpPdf").click(),
]);
const out=path.join(TESTS_DIR,"ptp-out.pdf");
await dl.saveAs(out);
const size=fs.statSync(out).size;
console.log("PDF:",dl.suggestedFilename(),size,"bytes");
// No template token in the name any more -- there is only one form.
chk(/^PTP_Riverside-Medical-Center_2026-08-10\.pdf$/.test(dl.suggestedFilename()),
    `PDF filename wrong: ${dl.suggestedFilename()}`);
chk(size>4000, `PDF looks empty (${size} bytes)`);

// Read the PDF back with pdf.js and check the typed values are really in it.
let reader=await ctx.newPage();
/* Re-opens itself if it has been closed. The reader used to be a single page closed partway
   through the file, so any assertion added below that point died on a closed target. */
async function readerPage(){
  if(!reader || reader.isClosed()){
    reader=await ctx.newPage();
    reader.on("pageerror",e=>errs.push("reader: "+e.message));
    await reader.goto(`http://localhost:${PORT}/`,{waitUntil:"networkidle"});
  }
  return reader;
}
const reader2=async b64=>(await readerPage()).evaluate(async data=>{
  const raw=atob(data), arr=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++) arr[i]=raw.charCodeAt(i);
  const doc=await window.pdfjsLib.getDocument({data:arr}).promise;
  const pages=[]; for(let i=1;i<=doc.numPages;i++){ const c=await (await doc.getPage(i)).getTextContent();
    pages.push(c.items.map(t=>t.str).join(" ")); }
  return {n:doc.numPages,text:pages.join("\n"),pages};
},b64);
reader.on("pageerror",e=>errs.push("reader: "+e.message));
await reader.goto(`http://localhost:${PORT}/`,{waitUntil:"networkidle"});
const b64=fs.readFileSync(out).toString("base64");
const read=await (await readerPage()).evaluate(async data=>{
  const raw=atob(data), arr=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++) arr[i]=raw.charCodeAt(i);
  const doc=await window.pdfjsLib.getDocument({data:arr}).promise;
  const pages=[];
  for(let i=1;i<=doc.numPages;i++){
    const c=await (await doc.getPage(i)).getTextContent();
    pages.push(c.items.map(t=>t.str).join(" "));
  }
  return {n:doc.numPages, text:pages.join("\n"), pages};
},b64);
console.log("PDF pages:",read.n,"| characters of text:",read.text.length);
chk(read.n>=1, "the PDF has no pages");
const must=["Riverside Medical Center","Jaren Eells","541-555-0134","Chris Brown","Alex Garcia",
            "Set VAV boxes","Overhead work","Level 1 mech room","PRE-TASK PLAN CHECK LIST",
            "Have you personally walked your work area?","CHANGING CONDITIONS","Column C6"];
const missing=must.filter(s=>!read.text.includes(s));
console.log("missing from the PDF:",missing);
chk(missing.length===0, `the PDF is missing typed content: ${JSON.stringify(missing)}`);
chk(/YES/.test(read.text)&&/NO/.test(read.text), "Yes/No answers are not in the PDF");
// jsPDF's built-in fonts are WinAnsi; a glyph outside that set silently mangles the whole cell,
// so assert on the real label text and on the tick marker actually used.
// Only the ticked items print. SIPP and Hand/Arm PPE were ticked; the rest must be absent.
chk(read.text.includes("SIPP"), "a ticked circle item is missing from the PDF");
chk(read.text.includes("[X]"), "no ticked box in the PDF even though two items were checked");
chk(!read.text.includes("Flush/Discharge"), "an unticked circle item was printed anyway");
chk(!read.text.includes("Hearing PPE"), "an unticked circle item was printed anyway");
// an N/A answer drops its whole question off the printed form
chk(!read.text.includes(naText.slice(0,40)), `a question answered N/A was still printed: ${naText}`);
// ...while its neighbours, which were answered normally, are still there
chk(read.text.includes("Have you personally walked your work area?"), "an answered question went missing from the PDF");
chk(read.text.includes("B \u2014 East Wing") || read.text.includes("East Wing"), "the Building value is missing from the PDF");
chk(!/[\u2610\u2612\uFFFD]/.test(read.text), "an un-encodable glyph reached the PDF");
chk(/Plan page 1 of \d/.test(read.text), "no page numbering in the PDF");
/* A table continuing onto the next page SHOULD repeat its header there. The bug was two identical
   bands stacked on the SAME page, so count per page, not across the document. */
const perPage=(r,re_)=>r.pages.map(p=>(p.match(re_)||[]).length);
const seqPP=perPage(read,/SEQUENCE OF CONSTRUCTION ACTIVITIES/g);
const chgPP=perPage(read,/CHANGING CONDITIONS/g);
console.log("header bands per page — sequence:",seqPP,"changing:",chgPP);
chk(Math.max(0,...seqPP)<=1, `the SEQUENCE header is stacked twice on one page: ${seqPP}`);
chk(Math.max(0,...chgPP)<=1, `the CHANGING CONDITIONS header is stacked twice on one page: ${chgPP}`);

/* ---- typing survives a pool update landing mid-sentence ----
   Another phone adding a checklist item pushes a snapshot that rebuilds this form. That used to
   discard everything typed since the last debounce flush. */
await page.click('[data-ptp="nearest.eyewash"]');
await page.keyboard.type("Level 2 by the stair",{delay:5});
await page.evaluate(()=>{                       // a pool change arriving from someone else
  const s=window.__SEED; s.config=s.config||{};
  s.config.ptpPool={standard:{circle:["Pushed from another phone"]}};
  window.__echoDoc && window.__echoDoc("config","ptpPool",s.config.ptpPool);
});
await page.waitForTimeout(700);
const survived=await page.inputValue('[data-ptp="nearest.eyewash"]');
console.log("mid-typing value after an external re-render:",JSON.stringify(survived));
chk(survived==="Level 2 by the stair", `typing was discarded by a re-render: ${JSON.stringify(survived)}`);

/* ---- adding to the shared pool ---- */
const qBefore=await page.locator("#ptpForm .ptp-q").count();
const cBefore=await page.locator("#ptpForm .ptp-chk").count();
await page.fill('[data-pooladd="questions"]',"Is the roof hatch access clear?");
await page.locator('[data-poolgo="questions"]').click(); await page.waitForTimeout(600);
await page.fill('[data-pooladd="circle"]',"Roof anchor points inspected");
await page.locator('[data-poolgo="circle"]').click(); await page.waitForTimeout(600);
chk(await page.locator("#ptpForm .ptp-q").count()===qBefore+1, "the added question did not appear");
chk(await page.locator("#ptpForm .ptp-chk").count()===cBefore+1, "the added checklist item did not appear");
// it goes to Firestore, not this device -- that is what makes it everyone's list
const poolWrites=await page.evaluate(()=>(window.__WRITES||[])
  .filter(w=>w.coll==="config"&&w.id==="ptpPool").length);
console.log("pool writes to Firestore:",poolWrites);
chk(poolWrites>=2, "adding to the pool did not write to Firestore");
// added items are marked as such and are removable; built-ins are not
chk(await page.locator("#ptpForm .ptp-q .ptp-own").count()===1, "the added question is not marked as added");
chk(await page.locator("#ptpForm .ptp-q [data-poolrm]").count()===1, "only the added question should be removable");
// answering the new one and ticking the new item must reach the PDF
await page.locator("#ptpForm .ptp-q").nth(qBefore).locator(".yn.y").click(); await page.waitForTimeout(250);
await page.locator("#ptpForm .ptp-chk").nth(cBefore).click(); await page.waitForTimeout(400);
const [dl3]=await Promise.all([ page.waitForEvent("download",{timeout:30000}), page.locator("#ptpPdf").click() ]);
const out3=path.join(TESTS_DIR,"ptp-pool.pdf"); await dl3.saveAs(out3);
const read3=await reader2(fs.readFileSync(out3).toString("base64"));
chk(read3.text.includes("Is the roof hatch access clear?"), "an added question is missing from the PDF");
chk(read3.text.includes("Roof anchor points inspected"), "an added checklist item is missing from the PDF");
console.log("added items reach the PDF: ok");

/* ---- attachments are merged into one file ---- */
const planPages=read3.n;
const mini=await page.evaluate(async()=>{
  // a tiny two-page PDF made with the jsPDF already on the page, used as a stand-in for a drawing
  const {jsPDF}=window.jspdf; const d=new jsPDF({unit:"pt",format:"letter"});
  d.text("ATTACHED DRAWING ONE",60,80); d.addPage(); d.text("ATTACHED DRAWING TWO",60,80);
  const b=new Uint8Array(d.output("arraybuffer")); return Array.from(b);
});
// If pdf-lib never arrives the export silently falls back to plan-only, which once let this
// whole block pass while merging nothing.
chk(await page.evaluate(()=>!!window.PDFLib), "pdf-lib did not load, so the merge was never exercised");
await page.setInputFiles("#ptpAttFile",{name:"drawing.pdf",mimeType:"application/pdf",buffer:Buffer.from(mini)});
await page.waitForTimeout(800);
chk(await page.locator("#ptpAtts .ptp-att").count()===1, "the attached file is not listed");
const [dl4]=await Promise.all([ page.waitForEvent("download",{timeout:40000}), page.locator("#ptpPdf").click() ]);
const out4=path.join(TESTS_DIR,"ptp-merged.pdf"); await dl4.saveAs(out4);
const read4=await reader2(fs.readFileSync(out4).toString("base64"));
console.log(`merged: plan ${planPages} pages + 2 attached = ${read4.n}`);
chk(read4.n===planPages+2, `expected ${planPages+2} pages in the merged PDF, got ${read4.n}`);
chk(read4.text.includes("ATTACHED DRAWING ONE")&&read4.text.includes("ATTACHED DRAWING TWO"),
    "the attachment's pages are not in the merged PDF");
chk(read4.text.includes("Riverside Medical Center"), "the plan itself is missing from the merged PDF");
// the attachment survives a reload -- it is part of "everything saves"
const p4=await boot();
chk(await p4.locator("#ptpAtts .ptp-att").count()===1, "the attachment did not survive a reload");
await p4.close();

/* ---- removing a filled row asks first ---- */
let askedRow=false;
page.once("dialog",d=>{ askedRow=true; console.log("row dialog:",JSON.stringify(d.message().split("\n")[0])); d.dismiss(); });
await page.locator('[data-delrow="seq|0"]').click(); await page.waitForTimeout(400);
chk(askedRow, "removing a row with writing in it did not ask first");
chk(await page.inputValue('[data-ptp="seq.0.1"]')==="Overhead work, dropped tools", "the row went despite cancelling");
// an empty row goes without nagging
const before=await page.locator(".ptp-row3").count();
await page.locator('[data-delrow="seq|3"]').click(); await page.waitForTimeout(400);
chk(await page.locator(".ptp-row3").count()===before-1, "an empty row should delete without a prompt");

/* ---- typing is not lost when the phone is backgrounded mid-word ---- */
await page.fill('[data-ptp="nearest.eyewash"]',"Level 2 by the stair");
await page.evaluate(()=>{
  Object.defineProperty(document,"hidden",{configurable:true,get:()=>true});
  document.dispatchEvent(new Event("visibilitychange"));
});
await page.waitForTimeout(80);
const flushed=await page.evaluate(()=>JSON.parse(localStorage.getItem("ptp_standard")||"{}"));
chk(flushed.nearest && flushed.nearest.eyewash==="Level 2 by the stair",
    "text typed inside the debounce window was lost when the page went away");
await page.evaluate(()=>{ Object.defineProperty(document,"hidden",{configurable:true,get:()=>false}); });
await page.fill('[data-ptp="nearest.phone"]',"Trailer radio");
await page.evaluate(()=>window.dispatchEvent(new Event("pagehide")));
await page.waitForTimeout(80);
const flushed2=await page.evaluate(()=>JSON.parse(localStorage.getItem("ptp_standard")||"{}"));
chk(flushed2.nearest && flushed2.nearest.phone==="Trailer radio", "pagehide did not flush pending typing");
console.log("debounce flush on hide + pagehide: ok");

/* ---- clear all ---- */
page.once("dialog",d=>{ console.log("clear dialog:",JSON.stringify(d.message().split("\n")[0])); d.dismiss(); });
await page.locator("#ptpClear").click(); await page.waitForTimeout(400);
chk(await page.inputValue('[data-ptp="top.project"]')==="Riverside Medical Center", "cancelling Clear all still wiped the form");
page.once("dialog",d=>d.accept());
await page.locator("#ptpClear").click(); await page.waitForTimeout(500);
chk(await page.inputValue('[data-ptp="top.project"]')==="", "Clear all did not empty the form");
chk(await page.locator("#ptpForm .ptp-q .yn.on").count()===0, "Clear all left the Yes/No answers behind");
chk(await page.locator("#ptpForm .ptp-chk.on").count()===0, "Clear all left the checkboxes behind");
const p3=await boot();
chk(await p3.inputValue('[data-ptp="top.project"]')==="", "Clear all did not erase the saved copy on this device");
await p3.close();

console.log("\n"+"=".repeat(58));
if(errs.length){ console.log("PAGE ERRORS:"); errs.forEach(e=>console.log("  - "+e)); }
if(fails.length){ console.log("FAILURES:"); fails.forEach(f=>console.log("  - "+f)); }
if(!fails.length && !errs.length) console.log("PTP: all checks passed");
await browser.close(); server.close();
process.exit(fails.length||errs.length?1:0);
