/* Resilience: every Firestore document in this seed is malformed in a way the importer or a
   hand-edit could plausibly produce -- missing fields, a number where a string is expected, null
   where an array is expected, empty strings, absurd lengths, unicode. Nothing here is an attack;
   it is what a renamed spreadsheet column or a half-written doc actually looks like.

   The bar: every tab renders, no uncaught page error, no "undefined"/"NaN"/"[object Object]"
   leaking into what a worker reads. */
import { chromium } from "playwright";
import fs from "node:fs"; import path from "node:path";
import { startServer, routeCdn, CHROMIUM, TESTS_DIR } from "./serve.mjs";

const { server, port: PORT } = await startServer();

const LONG = "Galvanized spiral duct ".repeat(300);           // ~6.6k chars in one description
const WEIRD = "O'Brien \"Bob\" <Ed> & Sons — ½\" 45° ell ✓ 😀"; // quotes, angle brackets, emoji

const SEED = {
  people: {
    "p-jaren-eells": { first:"Jaren", last:"Eells", email:"jareneells@arctic.biz", nameNorm:"jaren eells",
                       savedJobs:["25-0150","25-0200","BAD JOB","","25-0300"], jobOrder:null, removedJobs:null },
    "p-no-name":     { email:"nobody@arctic.biz" },                       // no first/last at all
    "p-num-name":    { first:12345, last:678, email:99, nameNorm:null },  // numbers where strings go
    "p-null-fields": { first:null, last:null, email:null, savedJobs:"not-an-array",
                       perms:"not-an-object", lastSeen:"not-a-timestamp" },
    "p-weird":       { first:WEIRD, last:"Q\"uote", email:"w@arctic.biz", savedJobs:[] },
  },
  arrivals: {
    a_ok:      { dateReceived:"2026-08-04", jobNumber:"25-0150", jobName:"Alpha", description:"Widget", supplier:"Acme", seq:1 },
    a_nodate:  { jobNumber:"25-0150", jobName:"Alpha", description:"No date at all", supplier:"Acme" },
    a_baddate: { dateReceived:"not a date", jobNumber:"25-0200", jobName:"Bravo", description:"Bad date", seq:1 },
    a_excel:   { dateReceived:45678, jobNumber:"25-0200", jobName:"Bravo", description:"Excel serial date", seq:1 },
    a_numjob:  { dateReceived:"2026-08-03", jobNumber:250150, jobName:777, description:888, supplier:999, seq:1 },
    a_nulls:   { dateReceived:null, jobNumber:null, jobName:null, description:null, supplier:null,
                 po:null, requestedBy:null, storageLocation:null, photoBy:null, seq:null },
    a_empty:   {},                                                        // a completely empty doc
    a_long:    { dateReceived:"2026-08-02", jobNumber:"25-0150", jobName:LONG.slice(0,400), description:LONG, seq:1 },
    a_weird:   { dateReceived:"2026-08-01", jobNumber:"25-0300", jobName:WEIRD, description:WEIRD, supplier:WEIRD, seq:1 },
    a_future:  { dateReceived:"2099-12-31", jobNumber:"25-0150", jobName:"Future", description:"Dated in 2099", seq:1 },
    a_bool:    { dateReceived:"2026-07-30", jobNumber:"25-0150", description:"Booleans", delivered:"yes", partial:"no", seq:"1" },
  },
  rentals: {
    r_ok:    { rentalId:"RB1", jobNumber:"25-0150", jobName:"Alpha", equipment:"Genie S45", dateRented:"2026-07-01", status:"Renting", rate:"250/1100/3200", seq:1 },
    r_junk:  { rentalId:null, jobNumber:"25-0150", equipment:null, dateRented:"", status:null, rate:"$310/wk", vendor:12, po:null, orderedBy:null },
    r_nums:  { rentalId:5, jobNumber:250200, equipment:42, dateRented:20260701, status:7, rate:99 },
    r_empty: {},
  },
  toolRentals: {
    t_ok:    { jobNumber:"25-0150", jobName:"Alpha", toolType:"Core drill", toolId:"CD-9", rentalStarted:"2026-07-05",
               billingDays:5, dailyRate:40, billingTotal:"200", discountedRate:"180", status:"Out", seq:1 },
    t_junk:  { jobNumber:"25-0150", toolType:null, toolId:null, rentalStarted:"", billingDays:"five",
               dailyRate:"$40", billingTotal:null, discountedRate:undefined, status:null },
    t_neg:   { jobNumber:"25-0300", toolType:"Neg", toolId:"N-1", rentalStarted:"2026-07-05", billingDays:-3,
               dailyRate:-40, billingTotal:"-120", status:"Returned", rentalEnded:"2026-07-01" },  // ends before it starts
    t_empty: {},
  },
  safetyPoints: {
    sp_ok:    { name:"ALEXANDER; JEREMY", shirt:"xl", start:2500, awards:{"1/19":100}, used:-500, extra:0, total:2100 },
    sp_junk:  { name:null, shirt:null, start:"lots", awards:"not-an-object", used:null, extra:"x", total:"" },
    sp_nomap: { name:"NO AWARDS", start:100 },
    sp_empty: {},
  },
  safetyTraining: {
    st_ok:    { name:"Chris Brown", course:"Forklift", instructor:"H. L.", date:"2024-12-05", expires:"2027-12-05" },
    st_junk:  { name:null, course:null, instructor:null, date:"garbage", expires:"garbage" },
    st_num:   { name:5, course:6, date:20241205, expires:20271205 },
    st_empty: {},
  },
  safetySds: {
    sd_ok:    { record:"1", product:"Acetylene", use:"Welding", vendor:"Airgas", issueDate:"2021-06-21", dept:"All", pages:"11" },
    sd_junk:  { record:null, product:null, vendor:null, issueDate:"", pages:null },
    sd_empty: {},
  },
  safetyDrugCards: {
    dc_ok:    { name:"Ted Carr", tested:"2024-09-09", expires:"2025-03-09" },
    dc_junk:  { name:null, tested:"", expires:null },
    dc_empty: {},
  },
  shares: { sh_junk: { toId:null, toName:null, fromName:null, jobNumber:null, status:null } },
  webductOrders: { wo_junk: { number:null, job:null, orderedBy:null, items:null } },
  config: {
    lastImport: { emailDateMs:"not-a-number", importedAt:null },
    safetyMeta: { points:null, training:"nope", sds:{count:"x"}, drug:undefined },
    pdfStore: {},
  },
  pdfStore: { meta: { pageMap:"not-an-object" } },
};

const fails=[]; const chk=(c,m)=>{ if(!c) fails.push(m); };
const browser=await chromium.launch({executablePath:CHROMIUM,args:["--no-sandbox"]});

async function run(label, width, height, mobile){
  const ctx=await browser.newContext({viewport:{width,height},isMobile:!!mobile,hasTouch:!!mobile});
  const page=await ctx.newPage();
  const errs=[];
  page.on("pageerror",e=>errs.push(`${label} pageerror: ${e.message}`));
  page.on("console",m=>{ const t=m.text();
    if(m.type()==="error" && !/net::ERR_|Failed to load resource/.test(t)) errs.push(`${label} console: ${t}`); });
  await page.addInitScript(seed=>{ window.__SEED=seed;
    localStorage.setItem("er_user",JSON.stringify({first:"Jaren",last:"Eells",email:"jareneells@arctic.biz",id:"p-jaren-eells"}));
    localStorage.setItem("tut_done","1"); },SEED);
  await page.goto(`http://localhost:${PORT}/`,{waitUntil:"networkidle"});
  await page.waitForTimeout(900);

  // walk every tab, every safety sub-tab, and both feed-group members
  const stops=[];
  for(const v of ["feed","jobs","safety"]){
    const tab=page.locator(`nav.tabs .tab[data-view='${v}']`);
    if(await tab.count() && await tab.isVisible()){ await tab.click(); await page.waitForTimeout(400); stops.push(v); }
  }
  for(const s of ["points","training","sds","drug","ptp"]){
    const pill=page.locator(`[data-safety='${s}']`);
    if(await pill.count()){ await pill.click(); await page.waitForTimeout(350); stops.push("safety:"+s); }
  }
  for(const g of ["rentals","deliveries"]){
    await page.evaluate(v=>{ const b=document.querySelector(`[data-groupview='${v}']`); if(b)b.click(); },g);
    await page.waitForTimeout(400); stops.push(g);
  }
  // and the merged My Jobs list with a job picked
  await page.locator("nav.tabs .tab[data-view='jobs']").click().catch(()=>{});
  await page.waitForTimeout(300);

  // Nothing a worker reads should say undefined / NaN / [object Object] / null.
  const leaked=await page.evaluate(()=>{
    const out=[];
    for(const el of document.querySelectorAll(".view, .safety-pane")){
      if(!el.offsetParent && !el.classList.contains("active")) continue;
      const t=el.innerText||"";
      for(const bad of ["undefined","NaN","[object Object]","Invalid Date"]){
        if(t.includes(bad)){
          const line=(t.split("\n").find(l=>l.includes(bad))||"").trim().slice(0,90);
          out.push(`${el.id}: ${bad} in "${line}"`);
        }
      }
    }
    return [...new Set(out)];
  });
  await ctx.close();
  return { errs, leaked, stops };
}

for(const [label,w,h,mob] of [["phone",440,956,true],["laptop",1280,900,false]]){
  const { errs, leaked, stops } = await run(label,w,h,mob);
  console.log(`\n--- ${label} --- visited: ${stops.join(", ")}`);
  console.log(`    page errors: ${errs.length}`);
  errs.slice(0,12).forEach(e=>console.log("      "+e));
  console.log(`    leaked placeholders: ${leaked.length}`);
  leaked.slice(0,12).forEach(e=>console.log("      "+e));
  chk(errs.length===0, `${label}: ${errs.length} uncaught error(s) on malformed data — first: ${errs[0]||""}`);
  chk(leaked.length===0, `${label}: placeholder text reached the UI — ${JSON.stringify(leaked.slice(0,4))}`);
}

console.log("\n"+"=".repeat(60));
if(fails.length){ console.log("FAILURES:"); fails.forEach(f=>console.log("  - "+f)); }
else console.log("bad-data resilience: every tab rendered clean on deliberately malformed documents");
await browser.close(); server.close();
process.exit(fails.length?1:0);
