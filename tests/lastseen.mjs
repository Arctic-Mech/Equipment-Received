/* Admin > Manage People shows when each person last opened the site, and the visit is recorded
   without burning the Firestore write budget. lastSeenText is sliced out of the real format.js
   rather than copied, so this can't pass against a stale duplicate. */
import { chromium } from "playwright";
import fs from "node:fs"; import path from "node:path";
import { startServer, routeCdn, CHROMIUM, TESTS_DIR, REPO_DIR } from "./serve.mjs";

/* ---------- 1. the formatter, exercised directly out of format.js ---------- */
const src = fs.readFileSync(path.join(REPO_DIR,"format.js"),"utf8");
const start = src.indexOf("function lastSeenText");
if(start<0) throw new Error("lastSeenText not found in format.js");
const end = src.indexOf("\nfunction money", start);
const MON=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const lastSeenText = new Function("MON", src.slice(start,end)+"; return lastSeenText;")(MON);

const NOW = Date.UTC(2026,7,5,12,0,0);
const MIN=60000, HR=3600000, DAY=86400000;
const cases = [
  [0,            "Never opened it"],
  [NOW+5*MIN,    "Just now"],          // a phone clock running ahead of the server
  [NOW-30000,    "Just now"],
  [NOW-4*MIN,    "Just now"],
  [NOW-20*MIN,   "20 min ago"],
  [NOW-HR,       "1 hour ago"],
  [NOW-5*HR,     "5 hours ago"],
  [NOW-26*HR,    "Yesterday"],
  [NOW-3*DAY,    "3 days ago"],
  [NOW-9*DAY,    "Last week"],
  [NOW-30*DAY,   "4 weeks ago"],
];
const fails=[]; const chk=(c,m)=>{ if(!c) fails.push(m); };
for(const [ms,want] of cases){
  const got = lastSeenText(ms, NOW);
  chk(got===want, `lastSeenText(${ms}) => ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
}
console.log(`formatter: ${cases.length} cases checked`);
// far past falls back to an absolute date
const far = lastSeenText(Date.UTC(2025,2,14,9,0,0), NOW);
console.log("90+ days ago =>", JSON.stringify(far));
chk(/^Mar 1[34], 2025$/.test(far), `old date should read as an absolute date, got ${JSON.stringify(far)}`);


const { server, port: PORT } = await startServer();

const now=Date.now();
const SEED={
  people:{
    "p-jaren-eells":{first:"Jaren",last:"Eells",email:"jareneells@arctic.biz",nameNorm:"jaren eells",
                     savedJobs:["25-0150"],jobOrder:[],removedJobs:[],lastSeen:now-2*HR},
    "p-bob-smith":  {first:"Bob",last:"Smith",email:"bob@arctic.biz",nameNorm:"bob smith",
                     savedJobs:[],jobOrder:[],removedJobs:[],lastSeen:now-3*DAY},
    "p-carl-jones": {first:"Carl",last:"Jones",email:"carl@arctic.biz",nameNorm:"carl jones",
                     savedJobs:[],jobOrder:[],removedJobs:[],lastSeen:now-40*DAY},
    "p-dana-lee":   {first:"Dana",last:"Lee",email:"dana@arctic.biz",nameNorm:"dana lee",
                     savedJobs:[],jobOrder:[],removedJobs:[]},          // never opened it
  },
  arrivals:{ a1:{dateReceived:"2026-08-04",jobNumber:"25-0150",jobName:"Alpha",description:"Widget",supplier:"Acme",seq:1} },
  rentals:{}, toolRentals:{}, config:{ lastImport:{emailDateMs:1,importedAt:"2026-08-04"} },
};

const browser=await chromium.launch({executablePath:CHROMIUM,args:["--no-sandbox"]});
async function boot(seenAt){
  const page=await browser.newPage({viewport:{width:1280,height:1000}});
  const errs=[];
  page.on("pageerror",e=>errs.push("pageerror: "+e.message));
  page.on("console",m=>{ const t=m.text();
    if(m.type()==="error" && !/net::ERR_|Failed to load resource/.test(t)) errs.push("console: "+t); });
  await page.addInitScript(([seed,prev])=>{
    window.__SEED=seed;
    localStorage.setItem("er_user",JSON.stringify({first:"Jaren",last:"Eells",email:"jareneells@arctic.biz",id:"p-jaren-eells"}));
    localStorage.setItem("tut_done","1");
    if(prev) localStorage.setItem("er_seen_at",String(prev)); else localStorage.removeItem("er_seen_at");
  },[SEED,seenAt||0]);
  await page.goto(`http://localhost:${PORT}/`,{waitUntil:"networkidle"});
  await page.waitForTimeout(900);
  return {page,errs};
}

// --- a fresh visit is recorded
let {page,errs} = await boot(0);
const seenWrites = await page.evaluate(()=>(window.__WRITES||[])
  .filter(w=>w.coll==="people" && w.data && "lastSeen" in w.data).length);
console.log("lastSeen writes on a fresh open:", seenWrites);
chk(seenWrites>=1, "opening the site did not record the visit");
const stamped = await page.evaluate(()=>Number(localStorage.getItem("er_seen_at")||0));
chk(stamped>0, "the throttle stamp was not saved");

// --- the throttle: a reload inside the window must NOT write again
const {page:p2} = await boot(Date.now()-60000);   // seen a minute ago
const again = await p2.evaluate(()=>(window.__WRITES||[])
  .filter(w=>w.coll==="people" && w.data && "lastSeen" in w.data).length);
console.log("lastSeen writes when seen a minute ago:", again);
chk(again===0, `throttle failed: ${again} extra write(s) inside the 15-minute window`);
// ...but a visit older than the window does write
const {page:p3} = await boot(Date.now()-20*60000);
const after = await p3.evaluate(()=>(window.__WRITES||[])
  .filter(w=>w.coll==="people" && w.data && "lastSeen" in w.data).length);
console.log("lastSeen writes when seen 20 minutes ago:", after);
chk(after>=1, "a visit past the throttle window was not recorded");
await p2.close(); await p3.close();

/* --- Manage People shows it ---
   On a fresh page the app records THIS visit, which correctly overwrites Jaren's seeded
   "2 hours ago". Boot inside the throttle window so nothing is written and the seeded times are
   what the list renders. */
await page.close();
const { page: page4 } = await boot(Date.now()-60000);
page = page4;
await page.locator("#btnAdminOpen").click(); await page.waitForTimeout(400);
if(await page.locator("#adminPin, .pin-input").count()){
  await page.locator(".pin-input").first().fill("1234").catch(()=>{});
  await page.waitForTimeout(300);
}
const peopleBtn = page.locator("#btnPeople");
if(!(await peopleBtn.isVisible())){
  await page.evaluate(()=>{ window.adminUnlocked=true; const b=document.getElementById("btnPeople"); if(b)b.click(); });
  await page.waitForTimeout(300);
} else { await peopleBtn.click(); await page.waitForTimeout(400); }

const rows = await page.locator("#peopleList .pr").count();
console.log("people rows:", rows);
chk(rows===4, `expected 4 people, got ${rows}`);
const seenLines = (await page.locator("#peopleList .pr-seen").allInnerTexts()).map(s=>s.trim());
console.log("last-seen lines:", seenLines);
chk(seenLines.length===4, `expected a last-seen line on every row, got ${seenLines.length}`);
chk(seenLines.some(s=>/hours? ago/.test(s)), "the 2-hours-ago person does not read in hours");
chk(seenLines.some(s=>/3 days ago/.test(s)), "the 3-days-ago person is wrong");
chk(seenLines.some(s=>/weeks ago/.test(s)), "the 40-days-ago person is wrong");
chk(seenLines.some(s=>/never/i.test(s)), "the person who never opened it is not called out");
// the dot colours differ, so the column can be scanned without reading it
const classes = await page.evaluate(()=>[...document.querySelectorAll("#peopleList .pr-seen")]
  .map(e=>[...e.classList].filter(c=>c!=="pr-seen")[0]));
console.log("dot states:", classes);
chk(new Set(classes).size>=3, `expected several dot states, got ${JSON.stringify(classes)}`);
chk(classes.includes("never"), "no hollow dot for the person who never opened it");
// the summary line counts them
const head = (await page.locator("#peopleList > div").first().innerText()).trim();
console.log("summary:", JSON.stringify(head));
chk(/4 people/i.test(head) && /1 never/i.test(head), `summary line wrong: ${head}`);
// opening a row shows the exact time
await page.locator("#peopleList .pr-head").first().click(); await page.waitForTimeout(300);
const full = (await page.locator("#peopleList .pr-seenfull").first().innerText()).trim();
console.log("exact time on the open row:", JSON.stringify(full));
chk(full.length>0, "no exact timestamp on the expanded row");

console.log("\n"+"=".repeat(58));
if(errs.length){ console.log("PAGE ERRORS:"); errs.forEach(e=>console.log("  - "+e)); }
if(fails.length){ console.log("FAILURES:"); fails.forEach(f=>console.log("  - "+f)); }
if(!fails.length && !errs.length) console.log("last-seen: all checks passed");
await browser.close(); server.close();
process.exit(fails.length||errs.length?1:0);
