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
chk(await page.locator(".ptp-tab").count()===2, "expected two template choices");
console.log("templates:", (await page.locator(".ptp-tab b").allInnerTexts()).map(s=>s.trim()));

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
chk(std.checks.length===19, `standard should have 19 circle/check items, got ${std.checks.length}`);
chk(std.questions[0]==="Have you personally walked your work area?", "first standard question wrong");
chk(std.questions.includes("Does this task require disassembly of systems or equipment?"), "missing a standard question");
chk(std.checks.some(c=>/SIPP/.test(c)) && std.checks.some(c=>/LOTO/.test(c)), "standard is missing SIPP/LOTO");
chk(std.near.some(s=>/Phone/i.test(s)), "standard 'location of nearest' should include Phone");
chk(!std.ident.some(s=>/date today/i.test(s)), "standard should not have the arch-only 'date today' field");

await page.locator("[data-ptpkind='arch']").click(); await page.waitForTimeout(400);
const arch=await shape();
console.log("architectural: questions",arch.questions.length,"checks",arch.checks.length);
chk(arch.questions.length===14, `architectural should have 14 questions, got ${arch.questions.length}`);
chk(arch.checks.length===15, `architectural should have 15 circle/check items, got ${arch.checks.length}`);
chk(arch.titles.some(t=>/architectural sheet metal/i.test(t)), "architectural title missing");
chk(arch.checks.some(c=>/Scissorslift/i.test(c)), "architectural is missing Scissorslift/Boomlift");
chk(!arch.checks.some(c=>/SIPP/.test(c)), "SIPP is a standard-only item and leaked into architectural");
chk(arch.ident.some(s=>/date today/i.test(s)), "architectural is missing 'the date today is'");
chk(!arch.near.some(s=>/Phone/i.test(s)), "architectural 'location of nearest' should not include Phone");
// the two forms order their sections differently, exactly as the Word files do
const archNearIdx=arch.secOrder.findIndex(s=>/location of nearest/i.test(s));
const archCrewIdx=arch.secOrder.findIndex(s=>/print your name/i.test(s));
console.log("arch section order:", arch.secOrder);
chk(archNearIdx>-1 && archCrewIdx>-1 && archNearIdx<archCrewIdx,
   "architectural puts 'location of nearest' before the crew names in the Word template");

/* ---- fill it in ---- */
await page.locator("[data-ptpkind='standard']").click(); await page.waitForTimeout(400);
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
await page.locator('[data-yn="0|yes"]').click(); await page.waitForTimeout(220);
await page.locator('[data-yn="1|no"]').click();  await page.waitForTimeout(220);
await page.locator('[data-chk="0"]').click();    await page.waitForTimeout(220);
await page.locator('[data-chk="4"]').click();    await page.waitForTimeout(220);
await page.waitForTimeout(600);
chk(await page.locator('[data-yn="0|yes"].on').count()===1, "Yes did not stick");
chk(await page.locator('[data-yn="1|no"].on').count()===1, "No did not stick");
chk(await page.locator('[data-chk="0"].on').count()===1, "the checkbox did not stick");

/* ---- it survives a reload ---- */
const p2=await boot();
chk(await p2.inputValue('[data-ptp="top.project"]')==="Riverside Medical Center", "project did not survive a reload");
chk(await p2.inputValue('[data-ptp="ident.foreman"]')==="Jaren Eells", "foreman did not survive a reload");
chk(await p2.inputValue('[data-ptp="seq.0.1"]')==="Overhead work, dropped tools", "the sequence row did not survive a reload");
chk(await p2.locator('[data-yn="0|yes"].on').count()===1, "the Yes answer did not survive a reload");
chk(await p2.locator('[data-chk="4"].on').count()===1, "the checkbox did not survive a reload");
console.log("reload: everything came back");
// the two templates keep separate saved copies
await p2.locator("[data-ptpkind='arch']").click(); await p2.waitForTimeout(400);
chk(await p2.inputValue('[data-ptp="top.project"]')==="", "the architectural form is sharing the standard form's saved copy");
await p2.locator("[data-ptpkind='standard']").click(); await p2.waitForTimeout(400);
chk(await p2.inputValue('[data-ptp="top.project"]')==="Riverside Medical Center", "switching back lost the standard form");
await p2.close();

/* ---- the PDF ---- */
const [dl]=await Promise.all([
  page.waitForEvent("download",{timeout:30000}),
  page.locator("#ptpPdf").click(),
]);
const out=path.join(TESTS_DIR,"ptp-out.pdf");
await dl.saveAs(out);
const size=fs.statSync(out).size;
console.log("PDF:",dl.suggestedFilename(),size,"bytes");
chk(/^PTP_Standard_Riverside-Medical-Center_2026-08-10\.pdf$/.test(dl.suggestedFilename()),
    `PDF filename wrong: ${dl.suggestedFilename()}`);
chk(size>4000, `PDF looks empty (${size} bytes)`);

// Read the PDF back with pdf.js and check the typed values are really in it.
const reader=await ctx.newPage();
reader.on("pageerror",e=>errs.push("reader: "+e.message));
await reader.goto(`http://localhost:${PORT}/`,{waitUntil:"networkidle"});
const b64=fs.readFileSync(out).toString("base64");
const read=await reader.evaluate(async data=>{
  const raw=atob(data), arr=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++) arr[i]=raw.charCodeAt(i);
  const doc=await window.pdfjsLib.getDocument({data:arr}).promise;
  const pages=[];
  for(let i=1;i<=doc.numPages;i++){
    const c=await (await doc.getPage(i)).getTextContent();
    pages.push(c.items.map(t=>t.str).join(" "));
  }
  return {n:doc.numPages, text:pages.join("\n")};
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
chk(read.text.includes("SIPP") && read.text.includes("Fall Protection PPE"), "the circle/check list is not in the PDF");
chk(read.text.includes("[X]"), "no ticked box in the PDF even though two items were checked");
chk(read.text.includes("B \u2014 East Wing") || read.text.includes("East Wing"), "the Building value is missing from the PDF");
chk(!/[\u2610\u2612\uFFFD]/.test(read.text), "an un-encodable glyph reached the PDF");
chk(/Page 1 of \d/.test(read.text), "no page numbering in the PDF");
// the architectural PDF must not carry standard-only content
await page.locator("[data-ptpkind='arch']").click(); await page.waitForTimeout(400);
await page.fill('[data-ptp="top.project"]',"Cedar High School"); await page.waitForTimeout(600);
const [dl2]=await Promise.all([ page.waitForEvent("download",{timeout:30000}), page.locator("#ptpPdf").click() ]);
const out2=path.join(TESTS_DIR,"ptp-arch.pdf"); await dl2.saveAs(out2);
const b64b=fs.readFileSync(out2).toString("base64");
const read2=await reader.evaluate(async data=>{
  const raw=atob(data), arr=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++) arr[i]=raw.charCodeAt(i);
  const doc=await window.pdfjsLib.getDocument({data:arr}).promise;
  let s=""; for(let i=1;i<=doc.numPages;i++){ const c=await (await doc.getPage(i)).getTextContent(); s+=c.items.map(t=>t.str).join(" ")+"\n"; }
  return {n:doc.numPages,text:s};
},b64b);
console.log("architectural PDF pages:",read2.n);
/* The repeat-header guard used to fire even when the row that tripped the page break WAS the
   header, drawing it once at the top of the new page and again as the ordinary row. It reproduced
   on the plainest architectural export, and every substring assertion above still passed. */
const seqCount=(read2.text.match(/SEQUENCE OF CONSTRUCTION ACTIVITIES/g)||[]).length;
const chgCount=(read2.text.match(/CHANGING CONDITIONS/g)||[]).length;
console.log("arch header bands — sequence:",seqCount,"changing:",chgCount);
chk(seqCount===1, `the SEQUENCE header is drawn ${seqCount} times in the architectural PDF`);
chk(chgCount===1, `the CHANGING CONDITIONS header is drawn ${chgCount} times`);
const seqStd=(read.text.match(/SEQUENCE OF CONSTRUCTION ACTIVITIES/g)||[]).length;
chk(seqStd===1, `the SEQUENCE header is drawn ${seqStd} times in the standard PDF`);
// Titles come out in source order: the architectural form leads with its trade line.
const iArch=read2.text.indexOf("ARCHITECTURAL SHEET METAL"), iChk=read2.text.indexOf("PRE-TASK PLAN CHECK LIST");
console.log("title order — arch@",iArch,"checklist@",iChk);
chk(iArch>-1 && iChk>-1 && iArch<iChk, "the architectural PDF prints its two title lines out of source order");
// An unanswered question still offers Yes/No to circle by hand, like the paper form.
chk(/Yes \/ No/.test(read2.text), "an unanswered question prints an empty cell instead of 'Yes / No'");
// Dates are printed the way a person writes them, not the way <input type=date> stores them.
chk(read.text.includes("Aug 10, 2026"), "the start date is printed as a raw YYYY-MM-DD");
chk(!/\b2026-08-10\b/.test(read.text), "a raw YYYY-MM-DD date reached the PDF");
chk(/architectural sheet metal/i.test(read2.text), "the architectural PDF is missing its trade line");
chk(read2.text.includes("Cedar High School"), "the architectural PDF is missing the project");
chk(!read2.text.includes("SIPP"), "a standard-only item leaked into the architectural PDF");
await reader.close();

/* ---- removing a filled row asks first ---- */
await page.locator("[data-ptpkind='standard']").click(); await page.waitForTimeout(400);
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
await page.locator("[data-ptpkind='standard']").click(); await page.waitForTimeout(400);
page.once("dialog",d=>{ console.log("clear dialog:",JSON.stringify(d.message().split("\n")[0])); d.dismiss(); });
await page.locator("#ptpClear").click(); await page.waitForTimeout(400);
chk(await page.inputValue('[data-ptp="top.project"]')==="Riverside Medical Center", "cancelling Clear all still wiped the form");
page.once("dialog",d=>d.accept());
await page.locator("#ptpClear").click(); await page.waitForTimeout(500);
chk(await page.inputValue('[data-ptp="top.project"]')==="", "Clear all did not empty the form");
chk(await page.locator('[data-yn="0|yes"].on').count()===0, "Clear all left the Yes/No answers behind");
chk(await page.locator('[data-chk="0"].on').count()===0, "Clear all left the checkboxes behind");
const p3=await boot();
chk(await p3.inputValue('[data-ptp="top.project"]')==="", "Clear all did not erase the saved copy on this device");
// ...and it only cleared the one template
await p3.locator("[data-ptpkind='arch']").click(); await p3.waitForTimeout(400);
chk(await p3.inputValue('[data-ptp="top.project"]')==="Cedar High School", "clearing the standard form also wiped the architectural one");
await p3.close();

console.log("\n"+"=".repeat(58));
if(errs.length){ console.log("PAGE ERRORS:"); errs.forEach(e=>console.log("  - "+e)); }
if(fails.length){ console.log("FAILURES:"); fails.forEach(f=>console.log("  - "+f)); }
if(!fails.length && !errs.length) console.log("PTP: all checks passed");
await browser.close(); server.close();
process.exit(fails.length||errs.length?1:0);
