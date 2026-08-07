/* Longevity under growth. The app is a year old with ~1,800 arrivals; this seeds what five more
   years look like -- 12,000 arrivals, 220 people, 60 saved jobs, 400 rentals -- and measures the
   things that actually degrade: first paint, tab switches, the unbounded localStorage sets, and
   whether any render crosses the threshold where a phone feels broken.

   This is a measurement with budgets, not a pass/fail on style. The budgets are deliberately
   generous; they exist to catch an O(n^2) that only shows up at scale. */
import { chromium } from "playwright";
import fs from "node:fs"; import path from "node:path";
import { startServer, routeCdn, CHROMIUM, TESTS_DIR } from "./serve.mjs";

const { server, port: PORT } = await startServer();

const N_ARR=12000, N_PEOPLE=220, N_JOBS=90, N_SAVED=60, N_RENT=400, N_TOOL=300, N_TRAIN=2500;
const jobNo=i=>`2${5+Math.floor(i/40)}-${String(100+(i%40)*7).padStart(4,"0")}`;
const JOBS=Array.from({length:N_JOBS},(_,i)=>jobNo(i));
const SAVED=JOBS.slice(0,N_SAVED);

const arrivals={};
for(let i=0;i<N_ARR;i++){
  const d=new Date(2026,7,5); d.setDate(d.getDate()-Math.floor(i/8));
  arrivals["a"+i]={dateReceived:d.toISOString().slice(0,10),jobNumber:JOBS[i%N_JOBS],
    jobName:"Project "+JOBS[i%N_JOBS],description:`Item ${i} — galvanized spiral duct section, 24" x 12 ga`,
    supplier:["Ferguson","Grainger","Baker","Johnson Controls"][i%4],po:"PO-"+i,
    requestedBy:i%3?"Jaren Eells":"Bob Smith",seq:i%9,delivered:i%5===0,partial:i%11===0};
}
const people={"p-jaren-eells":{first:"Jaren",last:"Eells",email:"jareneells@arctic.biz",
  nameNorm:"jaren eells",savedJobs:SAVED,jobOrder:[],removedJobs:[]}};
for(let i=0;i<N_PEOPLE;i++) people["p-x"+i]={first:"First"+i,last:"Last"+i,email:`u${i}@arctic.biz`,
  nameNorm:`first${i} last${i}`,savedJobs:JOBS.slice(i%20,(i%20)+4),lastSeen:Date.now()-i*3600000};
const rentals={},toolRentals={},safetyTraining={};
for(let i=0;i<N_RENT;i++) rentals["r"+i]={rentalId:"RB"+i,jobNumber:JOBS[i%N_JOBS],jobName:"Project",
  equipment:"Genie S45",dateRented:"2026-05-01",status:i%3?"Renting":"Returned",rate:"250/1100/3200",seq:1};
for(let i=0;i<N_TOOL;i++) toolRentals["t"+i]={jobNumber:JOBS[i%N_JOBS],jobName:"Project",toolType:"Core drill",
  toolId:"CD-"+i,rentalStarted:"2026-06-01",billingDays:5,dailyRate:40,billingTotal:"200",discountedRate:"180",status:"Out",seq:1};
for(let i=0;i<N_TRAIN;i++) safetyTraining["tr"+i]={name:`First${i%N_PEOPLE} Last${i%N_PEOPLE}`,
  course:["Forklift","Scissor Lift","OSHA 30","Respirator","Fall Protection"][i%5],
  instructor:"Instructor",date:"2024-01-15",expires:i%4?"2027-01-15":"2025-01-15"};

const SEED={people,arrivals,rentals,toolRentals,safetyTraining,
  safetyPoints:Object.fromEntries(Array.from({length:200},(_,i)=>["p"+i,
    {name:`LAST${i}; FIRST${i}`,shirt:"xl",start:2500,awards:{"1/19":100},used:-500,extra:0,total:2100}])),
  safetySds:Object.fromEntries(Array.from({length:400},(_,i)=>["s"+i,
    {record:String(i),product:"Chemical "+i,use:"Use",vendor:"Vendor",issueDate:"2021-06-21",dept:"All",pages:"11"}])),
  safetyDrugCards:Object.fromEntries(Array.from({length:200},(_,i)=>["d"+i,
    {name:`First${i} Last${i}`,tested:"2025-09-09",expires:"2026-03-09"}])),
  shares:{},webductOrders:{},config:{lastImport:{emailDateMs:1,importedAt:"2026-08-05"}}};

/* Budgets are ~3x the measured numbers, so this catches a real regression (an accidental O(n^2),
   a lost render cap) without failing on a busy CI box. Measured at this seed size after the
   render caps landed: boot ~1.7s, every tab switch under 550ms, ~47k DOM nodes. */
const BUDGET_MS = { boot: 6000, tab: 1800 };
const fails=[]; const chk=(c,m)=>{ if(!c) fails.push(m); };
const browser=await chromium.launch({executablePath:CHROMIUM,args:["--no-sandbox"]});
const ctx=await browser.newContext({viewport:{width:440,height:956},isMobile:true,hasTouch:true});
await routeCdn(ctx);
const page=await ctx.newPage();
const errs=[];
page.on("pageerror",e=>errs.push("pageerror: "+e.message));
page.on("console",m=>{const t=m.text();
  if(m.type()==="error" && !/net::ERR_|Failed to load resource/.test(t)) errs.push("console: "+t);});
await page.addInitScript(seed=>{ window.__SEED=seed;
  localStorage.setItem("er_user",JSON.stringify({first:"Jaren",last:"Eells",email:"jareneells@arctic.biz",id:"p-jaren-eells"}));
  localStorage.setItem("tut_done","1"); },SEED);

console.log(`seeded: ${N_ARR} arrivals, ${N_PEOPLE+1} people, ${N_JOBS} jobs (${N_SAVED} saved), `
  +`${N_RENT} rentals, ${N_TOOL} tools, ${N_TRAIN} training rows`);
const t0=Date.now();
await page.goto(`http://localhost:${PORT}/`,{waitUntil:"networkidle"});
await page.waitForFunction(()=>document.querySelectorAll("#feedList .acard").length>0,{timeout:30000}).catch(()=>{});
const boot=Date.now()-t0;
console.log(`boot to first arrivals painted: ${boot} ms`);
chk(boot<BUDGET_MS.boot, `boot took ${boot}ms, over the ${BUDGET_MS.boot}ms budget`);

async function timeTab(label,fn){
  const s=Date.now(); await fn(); await page.waitForTimeout(120);
  const ms=Date.now()-s; console.log(`  ${label.padEnd(26)} ${ms} ms`);
  chk(ms<BUDGET_MS.tab, `${label} took ${ms}ms, over the ${BUDGET_MS.tab}ms budget`);
  return ms;
}
console.log("tab switches:");
await timeTab("My Jobs (60 saved jobs)",()=>page.locator("nav.tabs .tab[data-view='jobs']").click());
await timeTab("open the job picker",async()=>{ const b=page.locator('[data-mjopen="jobs"]');
  if(await b.count()) await b.click(); });
await timeTab("pick one job",async()=>{ const r=page.locator("#jobPickList .mjp-row[data-mjpick]").first();
  if(await r.count()) await r.click(); });
await timeTab("Safety",()=>page.locator("nav.tabs .tab[data-view='safety']").click());
await timeTab("Safety > Training (2500)",()=>page.locator("[data-safety='training']").click());
await timeTab("Safety > SDS (400)",()=>page.locator("[data-safety='sds']").click());
await timeTab("Safety > PTP",()=>page.locator("[data-safety='ptp']").click());
await timeTab("back to Arrivals",()=>page.locator("nav.tabs .tab[data-view='feed']").click());

// search is the operation most likely to go quadratic
await timeTab("search the arrivals feed",async()=>{ const s=page.locator("#feedSearch, #searchInput").first();
  if(await s.count()) await s.fill("galvanized"); });

// A cap that could not be lifted would just be hiding data. Prove the button works.
await page.locator("nav.tabs .tab[data-view='feed']").click(); await page.waitForTimeout(300);
const before=await page.locator("#feedList .acard").count();
const more=page.locator('[data-showmore="feed"]');
chk(await more.count()===1, "no Show-more button on a 12,000-row feed");
if(await more.count()){ await more.click(); await page.waitForTimeout(600);
  const after=await page.locator("#feedList .acard").count();
  console.log(`show more: ${before} -> ${after} cards`);
  chk(after>before, `Show more did not reveal any further rows (${before} -> ${after})`); }

const store=await page.evaluate(()=>{
  const out={}; let total=0;
  for(let i=0;i<localStorage.length;i++){ const k=localStorage.key(i);
    const v=localStorage.getItem(k)||""; out[k]=v.length; total+=k.length+v.length; }
  return {keys:out,total};
});
console.log("localStorage after a full walk:");
Object.entries(store.keys).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(`  ${k.padEnd(16)} ${v} chars`));
console.log(`  ${"TOTAL".padEnd(16)} ${store.total} chars (~${(store.total/1024).toFixed(0)} KB of a ~5 MB cap)`);
// er_seen holds one id per arrival on a saved job and is never pruned; at this size it is the
// single biggest thing the app stores, so it is the one worth watching.
chk(store.total < 2_000_000, `localStorage reached ${store.total} chars, within sight of the 5MB cap`);

const dom=await page.evaluate(()=>document.getElementsByTagName("*").length);
console.log(`DOM nodes on screen: ${dom}`);
chk(dom<150000, `${dom} DOM nodes — a render cap has gone missing; this was 585,694 before they existed`);

console.log(`\npage errors: ${errs.length}`);
errs.slice(0,8).forEach(e=>console.log("  "+e));
chk(errs.length===0, `${errs.length} error(s) at scale — first: ${errs[0]||""}`);

console.log("\n"+"=".repeat(60));
if(fails.length){ console.log("FAILURES:"); fails.forEach(f=>console.log("  - "+f)); }
else console.log("growth: five years of data, every tab inside budget, nothing crashed");
await browser.close(); server.close();
process.exit(fails.length?1:0);
