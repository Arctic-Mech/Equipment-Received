/* My Jobs split layout + confirm-before-delete.
   Firebase is stubbed via an import map injected by the server (see test_ui.mjs for why). */
import { chromium } from "playwright";
import fs from "node:fs"; import path from "node:path";
import { startServer, routeCdn, CHROMIUM, TESTS_DIR } from "./serve.mjs";

const { server, port: PORT } = await startServer();

// Three jobs, arrivals deliberately interleaved by date so a merged list that just concatenated
// per-job slices would come out in the wrong order and this test would catch it.
const SEED = {
  // Saved jobs hang off the person's own people/{id} doc — there is no separate users collection.
  people:{ "p-jaren-eells":{ first:"Jaren", last:"Eells", email:"jareneells@arctic.biz", nameNorm:"jaren eells",
                             savedJobs:["25-0150","25-0200","25-0300"], jobOrder:[], removedJobs:[] } },
  arrivals:{
    a1:{dateReceived:"2026-07-20",jobNumber:"25-0150",jobName:"Alpha",description:"Ductwork",supplier:"Acme",seq:1},
    a2:{dateReceived:"2026-07-25",jobNumber:"25-0200",jobName:"Bravo",description:"Grilles",supplier:"Acme",seq:1},
    a3:{dateReceived:"2026-07-22",jobNumber:"25-0150",jobName:"Alpha",description:"Hangers",supplier:"Baker",seq:1},
    a4:{dateReceived:"2026-07-28",jobNumber:"25-0300",jobName:"Charlie",description:"Louvers",supplier:"Acme",seq:1},
    a5:{dateReceived:"2026-06-10",jobNumber:"25-0200",jobName:"Bravo",description:"Old part",supplier:"Acme",seq:1},
    a9:{dateReceived:"2026-07-27",jobNumber:"25-9999",jobName:"Not mine",description:"Other job",supplier:"Acme",seq:1},
  },
  rentals:{
    r1:{rentalId:"RB1",jobNumber:"25-0150",jobName:"Alpha",equipment:"Genie S45",dateRented:"2026-07-01",status:"Renting",seq:1},
    r2:{rentalId:"RB2",jobNumber:"25-0300",jobName:"Charlie",equipment:"Scissor Lift",dateRented:"2026-07-15",status:"Renting",seq:1},
  },
  toolRentals:{},
  config:{ lastImport:{ emailDateMs:1, importedAt:"2026-07-30" } },
};

const fails=[]; const chk=(c,m)=>{ if(!c) fails.push(m); };
const browser = await chromium.launch({ executablePath:CHROMIUM, args:["--no-sandbox"] });

async function boot(width){
  const page = await browser.newPage({ viewport:{ width, height:1000 } });
  const errs=[];
  page.on("pageerror",e=>errs.push("pageerror: "+e.message+"\n      "+String(e.stack||"").split("\n").slice(1,4).join("\n      ")));
  page.on("console",m=>{ const t=m.text();
    if(m.type()==="error" && !/net::ERR_|Failed to load resource/.test(t)) errs.push("console: "+t); });
  await page.addInitScript(seed=>{
    window.__SEED=seed;
    localStorage.setItem("er_user",JSON.stringify({first:"Jaren",last:"Eells",email:"jareneells@arctic.biz",id:"p-jaren-eells"}));
    localStorage.setItem("tut_done","1");
  },SEED);
  await page.goto(`http://localhost:${PORT}/`,{ waitUntil:"networkidle" });
  await page.waitForTimeout(700);
  await page.locator("nav.tabs .tab[data-view='jobs']").click();
  await page.waitForTimeout(300);
  return { page, errs };
}

/* ================= the split, at desktop width =================
   This suite covers the merged-list LOGIC (cross-job ordering, filtering, confirms), which is
   width-independent. It runs at desktop width because below 860px the chip strip is deliberately
   replaced by the bottom-sheet picker -- that path is covered by test_mobile_myjobs.mjs. */
const { page, errs } = await boot(1200);

const jobRows = await page.locator("#mjJobList .mj-job").count();
console.log("job rows (incl. All):", jobRows);
chk(jobRows === 4, `expected All + 3 jobs = 4 rows, got ${jobRows}`);
chk(await page.locator("#mjJobList .mj-job.all.on").count() === 1, "All jobs is not selected by default");

// Merged list: every saved job's arrivals, newest first, and nothing from an unsaved job.
const descs = async () => page.locator("#mjItems .acard .ac-desc").allInnerTexts();
let list = (await descs()).map(s=>s.trim());
console.log("all-jobs list:", list);
chk(JSON.stringify(list) === JSON.stringify(["Louvers","Grilles","Hangers","Ductwork","Old part"]),
    `merged list not newest-first across jobs: ${JSON.stringify(list)}`);
chk(!list.includes("Other job"), "an unsaved job's arrival leaked into My Jobs");

// In the merged list every card must say which job it belongs to — .compact hides that badge,
// so it has to be off here even though it's right for a single-job list.
const badges = (await page.locator("#mjItems .acard .ac-job .jobbadge").allInnerTexts()).map(s=>s.trim());
console.log("job badges in all-jobs mode:", badges);
chk(badges.length === 5, `expected a job badge on all 5 merged cards, got ${badges.length}`);
chk(badges.join(",") === "25-0300,25-0200,25-0150,25-0150,25-0200", `badges wrong: ${badges}`);
chk(await page.locator("#mjItems .acard .ac-job").first().isVisible(), "job badge is hidden in the merged list");

const headCount = (await page.locator("#mjMainHead .mj-mh-c").innerText()).trim();
console.log("header:", (await page.locator("#mjMainHead .mj-mh-t").innerText()).trim(), "|", headCount);
chk(/^5 arrivals/.test(headCount), `header count wrong: ${headCount}`);

// Clicking a job filters the list.
await page.locator("#mjJobList .mj-job[data-mjpick='25-0150']").click();
await page.waitForTimeout(250);
list = (await descs()).map(s=>s.trim());
console.log("after picking 25-0150:", list);
chk(JSON.stringify(list) === JSON.stringify(["Hangers","Ductwork"]), `filter by job failed: ${JSON.stringify(list)}`);
chk(await page.locator("#mjJobList .mj-job[data-mjpick='25-0150'].on").count() === 1, "picked job not highlighted");
chk((await page.locator("#mjMainHead .mj-mh-t").innerText()).includes("25-0150"), "header doesn't name the picked job");

// "All jobs" button in the header goes back.
await page.locator("#mjMainHead .mj-showall").click();
await page.waitForTimeout(250);
chk((await descs()).length === 5, "Show-all button did not restore the merged list");

// Clicking the same job twice toggles back to all.
await page.locator("#mjJobList .mj-job[data-mjpick='25-0200']").click();
await page.waitForTimeout(200);
chk((await descs()).length === 2, "second job filter failed");
await page.locator("#mjJobList .mj-job[data-mjpick='25-0200']").click();
await page.waitForTimeout(200);
chk((await descs()).length === 5, "re-clicking the picked job did not go back to all");

// Segment switch carries the selection and re-counts.
await page.locator("#mjSeg button[data-seg='rentals']").click();
await page.waitForTimeout(250);
const rentJobTags = await page.locator("#mjItems .tline .tl-job").allInnerTexts();
console.log("rental job tags in all-jobs mode:", rentJobTags);
chk(rentJobTags.length === 2, `expected 2 rentals across jobs, got ${rentJobTags.length}`);
chk(rentJobTags.join(",") === "25-0300,25-0150", `rentals not newest-first: ${rentJobTags}`);
await page.locator("#mjJobList .mj-job[data-mjpick='25-0150']").click();
await page.waitForTimeout(250);
chk(await page.locator("#mjItems .tline").count() === 1, "rental filter by job failed");
chk(await page.locator("#mjItems .tline .tl-job").count() === 0, "job tag still shown inside a single-job list");
await page.locator("#mjSeg button[data-seg='arrivals']").click();
await page.waitForTimeout(250);

/* ---- month filter narrows the list and the counts ---- */
await page.selectOption("#mjMonth","2026-07");
await page.waitForTimeout(250);
list = (await descs()).map(s=>s.trim());
chk(!list.includes("Old part"), "month filter did not drop the June arrival");
await page.selectOption("#mjMonth","");
await page.waitForTimeout(200);

/* ---- search filters items across jobs ---- */
await page.fill("#jobSearch","baker");
await page.waitForTimeout(300);
list = (await descs()).map(s=>s.trim());
console.log("search 'baker':", list);
chk(JSON.stringify(list) === JSON.stringify(["Hangers"]), `search across jobs failed: ${JSON.stringify(list)}`);
chk(await page.locator("#mjJobList .mj-job[data-mjpick]").count() === 2, "search should leave All + the one matching job");
await page.fill("#jobSearch","");
await page.waitForTimeout(300);

/* ================= confirm before deleting ================= */
// Cancel: the job stays.
page.once("dialog", d => { console.log("remove dialog:", JSON.stringify(d.message().split("\n")[0])); d.dismiss(); });
await page.locator("#mjJobList .mj-job[data-mjpick='25-0300'] [data-removejob]").click();
await page.waitForTimeout(300);
chk(await page.locator("#mjJobList .mj-job[data-mjpick='25-0300']").count() === 1,
    "job was removed even though the confirm was cancelled");
const writesAfterCancel = await page.evaluate(()=> (window.__WRITES||[]).length);

// Accept: it goes.
page.once("dialog", d => d.accept());
await page.locator("#mjJobList .mj-job[data-mjpick='25-0300'] [data-removejob]").click();
await page.waitForTimeout(400);
chk(await page.locator("#mjJobList .mj-job[data-mjpick='25-0300']").count() === 0,
    "job survived a confirmed remove");
const writesAfterAccept = await page.evaluate(()=> (window.__WRITES||[]).length);
console.log("writes — after cancel:", writesAfterCancel, "after accept:", writesAfterAccept);
chk(writesAfterAccept > writesAfterCancel, "confirmed remove did not persist");

// The removed job's arrivals leave the merged list too.
list = (await descs()).map(s=>s.trim());
chk(!list.includes("Louvers"), "removed job's arrivals still in the list");

/* ---- reset-order also asks ---- */
await page.locator("#reorderToggle").click(); await page.waitForTimeout(200);
await page.locator("#mjJobList [data-movedown]").first().click(); await page.waitForTimeout(300);
await page.locator("#reorderToggle").click(); await page.waitForTimeout(200);
const resetVisible = await page.locator("#orderReset").isVisible();
chk(resetVisible, "Reset-to-newest never appeared after reordering");
if(resetVisible){
  let asked=false;
  page.once("dialog", d => { asked=true; console.log("reset dialog:", JSON.stringify(d.message().split("\n")[0])); d.dismiss(); });
  await page.locator("#orderReset").click();
  await page.waitForTimeout(300);
  chk(asked, "Reset to newest did not ask for confirmation");
  chk(await page.locator("#orderReset").isVisible(), "order was reset despite cancelling");
}

/* ================= two-column layout ================= */
const wide = await boot(1200);
const cols = await wide.page.evaluate(()=>getComputedStyle(document.getElementById("mjSplit")).gridTemplateColumns);
console.log("split grid columns at 1200px:", cols);
chk(/\d/.test(cols) && cols.split(" ").length === 2, `split is not two columns on a wide screen: ${cols}`);
const sideBox = await wide.page.locator("#mjSide, #mjJobList").first().boundingBox();
const mainBox = await wide.page.locator(".mj-main").first().boundingBox();
chk(sideBox && mainBox && mainBox.x > sideBox.x + sideBox.width - 5,
    "panes are not side by side on a wide screen");
errs.push(...wide.errs);

console.log("\n"+"=".repeat(58));
if(errs.length){ console.log("PAGE ERRORS:"); errs.forEach(e=>console.log("  - "+e)); }
if(fails.length){ console.log("FAILURES:"); fails.forEach(f=>console.log("  - "+f)); }
if(!fails.length && !errs.length) console.log("My Jobs split + delete confirms all passed");
await browser.close(); server.close();
process.exit(fails.length||errs.length?1:0);
