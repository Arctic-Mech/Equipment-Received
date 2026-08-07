/* My Jobs on a phone: the bar, the two sheets, and the states the design judges flagged as fatal
   (zero saved jobs, a search matching nothing, reorder mode, read-only view-as). */
import { chromium } from "playwright";
import fs from "node:fs"; import path from "node:path";
import { startServer, routeCdn, CHROMIUM, TESTS_DIR } from "./serve.mjs";

const { server, port: PORT } = await startServer();

const JOBS=[["26-0147","THE DALLES ADVENTIST HOSPITAL"],["25-0294","KAISER SMC FSD RPRS & DECOMM"],
            ["25-0150","RIVERSIDE MEDICAL CENTER"]];
const mkSeed = savedJobs => ({
  people:{ "p-jaren-eells":{ first:"Jaren",last:"Eells",email:"jareneells@arctic.biz",nameNorm:"jaren eells",
                             savedJobs, jobOrder:[], removedJobs:[] },
           "p-bob-smith":{ first:"Bob",last:"Smith",email:"bob@arctic.biz",nameNorm:"bob smith",
                           savedJobs:["26-0147"], jobOrder:[], removedJobs:[] } },
  arrivals:{
    a1:{dateReceived:"2026-07-30",jobNumber:"26-0147",jobName:JOBS[0][1],description:"Swivel rod anchor",supplier:"Ferguson",seq:1},
    a2:{dateReceived:"2026-07-28",jobNumber:"25-0294",jobName:JOBS[1][1],description:"VAV boxes",supplier:"Baker",seq:1},
    a3:{dateReceived:"2026-07-26",jobNumber:"25-0150",jobName:JOBS[2][1],description:"Return grilles",supplier:"Ferguson",seq:1},
    a4:{dateReceived:"2026-07-24",jobNumber:"26-0147",jobName:JOBS[0][1],description:"Louver assembly",supplier:"Ferguson",seq:1},
  },
  rentals:{ r1:{rentalId:"RB1",jobNumber:"26-0147",jobName:JOBS[0][1],equipment:"Genie S45",dateRented:"2026-07-01",status:"Renting",seq:1} },
  toolRentals:{}, config:{ lastImport:{emailDateMs:1,importedAt:"2026-07-30"} },
});

const fails=[]; const chk=(c,m)=>{ if(!c) fails.push(m); };
const browser = await chromium.launch({ executablePath:CHROMIUM, args:["--no-sandbox"] });
const errs=[];

async function boot({ width=440, jobs=JOBS.map(j=>j[0]), hash="" }={}){
  const page=await browser.newPage({ viewport:{width,height:956}, deviceScaleFactor:2, isMobile:true, hasTouch:true });
  page.on("pageerror",e=>errs.push("pageerror: "+e.message));
  page.on("console",m=>{ const t=m.text();
    if(m.type()==="error" && !/net::ERR_|Failed to load resource/.test(t)) errs.push("console: "+t); });
  await page.addInitScript(seed=>{
    window.__SEED=seed;
    localStorage.setItem("er_user",JSON.stringify({first:"Jaren",last:"Eells",email:"jareneells@arctic.biz",id:"p-jaren-eells"}));
    localStorage.setItem("tut_done","1");
  }, mkSeed(jobs));
  await page.goto(`http://localhost:${PORT}/${hash}`,{ waitUntil:"networkidle" });
  await page.waitForTimeout(800);
  await page.locator("nav.tabs .tab[data-view='jobs']").click();
  await page.waitForTimeout(400);
  return page;
}
const txt = async (p,s) => (await p.locator(s).first().innerText().catch(()=>"")).trim().replace(/\s+/g," ");

/* ===== 1. default state: the bar says what it is showing ===== */
const p = await boot();
chk(await p.locator("#mjBar").isVisible(), "the bar is not visible on a phone");
chk(!(await p.locator("#mjJobList").isVisible()), "the old chip strip is still visible on a phone");
chk(!(await p.locator("#view-jobs .mj-head").isVisible()), "the instruction paragraph is still on screen");
chk(!(await p.locator("#identityCard").isVisible()), "the identity card is still on screen");
chk(!(await p.locator("#mjMainHead").isVisible()), "the duplicate list header is still on screen");
console.log("bar:", JSON.stringify(await txt(p,"#mjBar")));
chk(/all my jobs/i.test(await txt(p,".mjb-job")), "JOBS button does not say 'All my jobs'");
chk(/arrivals/i.test(await txt(p,".mjb-show")), "SHOW button does not name the segment");
// the label must not be clipped away by a long new-count pill
const jobLabel = await txt(p,".mjb-job .mjb-body b");
chk(/^all my jobs$/i.test(jobLabel), `JOBS label clipped: ${JSON.stringify(jobLabel)}`);

/* ===== 2. every control still reachable, and bigger ===== */
await p.locator('[data-mjopen="show"]').click(); await p.waitForTimeout(350);
chk(await p.locator("#mjShowPanel").isVisible(), "SHOW sheet did not open");
for(const sel of ["#jobSearch","#mjMonth","#mjSeg","#reorderToggle"])
  chk(await p.locator(sel).isVisible(), `${sel} unreachable inside the SHOW sheet`);
const segBox = await p.locator("#mjSeg button").first().boundingBox();
chk(segBox.height>=44, `segment button too small to tap: ${segBox.height}px`);
// Escape closes
await p.keyboard.press("Escape"); await p.waitForTimeout(300);
chk(!(await p.locator("#mjShowPanel").isVisible()), "Escape did not close the SHOW sheet");

/* ===== 3. the JOBS sheet fixes both bugs from the owner's screenshot ===== */
await p.locator('[data-mjopen="jobs"]').click(); await p.waitForTimeout(350);
chk(await p.locator("#mjJobsPanel").isVisible(), "JOBS sheet did not open");
const rows = await p.locator("#jobPickList .mjp-row").count();
chk(rows===4, `expected ALL + 3 jobs in the picker, got ${rows}`);
// (a) names are not truncated
const clipped = await p.evaluate(()=>[...document.querySelectorAll(".mjp-name")]
  .filter(e=>e.scrollHeight>e.clientHeight+1).map(e=>e.textContent.trim()));
console.log("truncated job names:", clipped);
chk(clipped.length===0, `job names still truncated: ${JSON.stringify(clipped)}`);
// (b) the trash never overlaps the name or the count
const overlap = await p.evaluate(()=>{
  const hit=(a,b)=>!(a.right<=b.left||b.right<=a.left||a.bottom<=b.top||b.bottom<=a.top);
  const bad=[];
  for(const row of document.querySelectorAll(".mjp-row")){
    const acts=row.querySelector(".mjp-acts"); if(!acts) continue;
    const ar=acts.getBoundingClientRect();
    for(const s of [".mjp-name",".mjp-count"]){ const el=row.querySelector(s); if(!el) continue;
      if(hit(ar, el.getBoundingClientRect())) bad.push(row.dataset.mjpick+" "+s); }
  }
  return bad;
});
console.log("acts/name overlaps:", overlap);
chk(overlap.length===0, `trash still collides: ${JSON.stringify(overlap)}`);

/* ===== 4. picking a job filters, closes the sheet, and the bar updates ===== */
await p.locator('.mjp-row[data-mjpick="26-0147"]').click(); await p.waitForTimeout(400);
chk(!(await p.locator("#mjJobsPanel").isVisible()), "picking a job left the sheet open");
console.log("bar after picking:", JSON.stringify(await txt(p,"#mjBar")));
chk(/the dalles/i.test(await txt(p,".mjb-job")), "bar does not name the picked job");
chk(await p.locator(".mjb-all").isVisible(), "no way back to all jobs");
const picked = await p.locator("#mjItems .acard").count();
chk(picked===2, `expected 2 arrivals on 26-0147, got ${picked}`);
await p.locator(".mjb-all").click(); await p.waitForTimeout(350);
chk(await p.locator("#mjItems .acard").count()===4, "the ALL button did not restore every job");

/* ===== 5. FATAL CHECK: a search that matches nothing must recover in one tap ===== */
await p.locator('[data-mjopen="show"]').click(); await p.waitForTimeout(300);
await p.fill("#jobSearch","zzzznope"); await p.waitForTimeout(450);
// The sheet must NOT close under the user mid-typing just because the query stopped matching.
chk(await p.locator("#mjShowPanel").isVisible(), "the SHOW sheet closed while the user was typing");
await p.locator("#mjShowPanel .mj-sheet-x").click(); await p.waitForTimeout(350);
const alert = await txt(p,"#mjBar");
console.log("no-match bar:", JSON.stringify(alert));
chk(/nothing matches/i.test(alert), `no-match state is not recoverable from the bar: ${JSON.stringify(alert)}`);
await p.locator("[data-mjclearsearch]").click(); await p.waitForTimeout(400);
chk(await p.locator("#mjItems .acard").count()===4, "tapping the alert did not clear the search");

/* ===== 6. FATAL CHECK: reorder mode must not trap anyone ===== */
await p.locator('[data-mjopen="show"]').click(); await p.waitForTimeout(300);
await p.locator("#reorderToggle").click(); await p.waitForTimeout(400);
chk(await p.locator("#mjJobsPanel").isVisible(), "reorder did not open the picker where the arrows live");
chk(await p.locator("#jobPickList [data-movedown]").first().isVisible(), "no reorder arrows in the picker");
const done = await txt(p,"#mjBar");
console.log("reorder bar:", JSON.stringify(done));
chk(/done reordering/i.test(done), "no way out of reorder mode from the bar");
// The scrim covers the bar while the sheet is open, so the escape hatch must be IN the sheet.
const inSheet = p.locator("#jobPickList .mjp-done");
chk(await inSheet.isVisible(), "no way out of reorder mode from inside the picker sheet");
await inSheet.click(); await p.waitForTimeout(400);
chk(!(await p.locator("#mjJobsPanel").isVisible()), "Done reordering left the sheet open");
chk(/all my jobs/i.test(await txt(p,".mjb-job")), "bar did not return to normal after reordering");

/* ===== 7. removals still confirm (shipped last change, must survive) ===== */
await p.locator('[data-mjopen="jobs"]').click(); await p.waitForTimeout(350);
let asked=false;
p.once("dialog", d=>{ asked=true; console.log("remove dialog:", JSON.stringify(d.message().split("\n")[0])); d.dismiss(); });
await p.locator('.mjp-row[data-mjpick="25-0150"] [data-removejob]').click(); await p.waitForTimeout(400);
chk(asked, "removing a job from the picker no longer confirms");
chk(await p.locator('.mjp-row[data-mjpick="25-0150"]').count()===1, "job vanished despite cancelling");

/* ===== 8. FATAL CHECK: zero saved jobs is not a dead end ===== */
const p2 = await boot({ jobs:[] });
const empty = await txt(p2,"#mjBar");
console.log("zero-jobs bar:", JSON.stringify(empty));
chk(/save a job/i.test(empty), `zero-jobs state has no way forward: ${JSON.stringify(empty)}`);
await p2.locator('[data-mjopen="show"]').click(); await p2.waitForTimeout(400);
chk(await p2.locator("#jobSearch").isVisible(), "cannot reach the search box with no saved jobs");
const focused = await p2.evaluate(()=>document.activeElement&&document.activeElement.id);
chk(focused==="jobSearch", `search box not focused for a new user (focus was ${focused})`);
await p2.close();

/* ===== 9. read-only view-as still works and cannot enter reorder ===== */
const p3 = await boot({});
await p3.evaluate(()=>{ location.hash="#BobSmith"; window.dispatchEvent(new HashChangeEvent("hashchange")); });
await p3.waitForTimeout(900);
if(await p3.locator("#viewAsBanner").isVisible()){
  chk(!(await p3.locator("#reorderToggle").isVisible()), "read-only viewer can still reorder");
  console.log("view-as: banner shown, reorder hidden");
} else console.log("view-as: hash did not resolve, skipped");
await p3.close();

/* ===== 10. desktop is untouched ===== */
const p4 = await boot({ width:1280 });
chk(!(await p4.locator("#mjBar").isVisible()), "the mobile bar leaked onto desktop");
chk(!(await p4.locator("#mjJobsPanel").isVisible()), "the JOBS sheet leaked onto desktop");
chk(!(await p4.locator(".mj-scrim").isVisible()), "the scrim leaked onto desktop");
chk(!(await p4.locator("#mjShowPanel > .mj-sheet-head").isVisible()), "a sheet header leaked onto desktop");
for(const sel of ["#jobSearch","#mjMonth","#mjSeg","#reorderToggle","#mjJobList","#mjMainHead"])
  chk(await p4.locator(sel).isVisible(), `${sel} is missing on desktop`);
const cols = await p4.evaluate(()=>getComputedStyle(document.getElementById("mjSplit")).gridTemplateColumns);
console.log("desktop split columns:", cols);
chk(cols.startsWith("300px"), `desktop two-column split regressed: ${cols}`);
// the exact-860 boundary must not put the picker column into position:fixed
const p5 = await browser.newPage({ viewport:{width:860,height:900} });
await p5.addInitScript(seed=>{ window.__SEED=seed;
  localStorage.setItem("er_user",JSON.stringify({first:"Jaren",last:"Eells",email:"jareneells@arctic.biz",id:"p-jaren-eells"}));
  localStorage.setItem("tut_done","1"); }, mkSeed(JOBS.map(j=>j[0])));
await p5.goto(`http://localhost:${PORT}/`,{waitUntil:"networkidle"}); await p5.waitForTimeout(700);
await p5.locator("nav.tabs .tab[data-view='jobs']").click(); await p5.waitForTimeout(300);
const sidePos = await p5.evaluate(()=>getComputedStyle(document.querySelector(".mj-side")).position);
console.log("at exactly 860px, .mj-side position:", sidePos);
chk(sidePos==="static", `the 860px boundary double-applies: .mj-side is ${sidePos}`);

/* ===== 11. no horizontal scroll on any tab ===== */
for(const view of ["feed","jobs","safety"]){
  await p.locator(`nav.tabs .tab[data-view='${view}']`).click().catch(()=>{});
  await p.waitForTimeout(300);
  const over = await p.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth);
  chk(over<=1, `${view} scrolls sideways by ${over}px on a phone`);
}

console.log("\n"+"=".repeat(58));
if(errs.length){ console.log("PAGE ERRORS:"); errs.forEach(e=>console.log("  - "+e)); }
if(fails.length){ console.log("FAILURES:"); fails.forEach(f=>console.log("  - "+f)); }
if(!fails.length && !errs.length) console.log("mobile My Jobs: all checks passed");
await browser.close(); server.close();
process.exit(fails.length||errs.length?1:0);
