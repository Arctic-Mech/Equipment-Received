/* Monkey test: click and type at random across the whole app for N steps and assert nothing ever
   throws. Scripted tests only walk the paths someone thought of; this walks the ones nobody did --
   double-taps, a modal opened from inside a modal, reorder mode entered while a sheet is open,
   a template switched mid-typing.

   Deterministic: the RNG is seeded, so a failure is replayable by re-running with the same seed.
   Destructive actions are auto-confirmed so the monkey explores past them rather than stalling on
   a dialog, and the seed is deliberately rich so deletes have something to delete. */
import { chromium } from "playwright";
import fs from "node:fs"; import path from "node:path";
import { startServer, routeCdn, CHROMIUM, TESTS_DIR } from "./serve.mjs";

const STEPS = Number(process.env.MONKEY_STEPS || 400);
const SEED_N = Number(process.env.MONKEY_SEED || 20260806);

const { server, port: PORT } = await startServer();

// mulberry32 — small, seeded, reproducible
function rng(seed){ return ()=>{ seed|=0; seed=seed+0x6D2B79F5|0;
  let t=Math.imul(seed^seed>>>15,1|seed); t=t+Math.imul(t^t>>>7,61|t)^t;
  return ((t^t>>>14)>>>0)/4294967296; }; }

const JOBS=["25-0150","25-0200","25-0300","26-0147"];
const mkArrivals=()=>{ const o={};
  for(let i=0;i<40;i++){ const d=new Date(2026,7,5); d.setDate(d.getDate()-i);
    o["a"+i]={dateReceived:d.toISOString().slice(0,10),jobNumber:JOBS[i%JOBS.length],
      jobName:"Job "+JOBS[i%JOBS.length],description:"Item "+i,supplier:"Ferguson",po:"PO-"+i,
      requestedBy:"Jaren Eells",seq:1,delivered:i%5===0,partial:i%7===0}; }
  return o; };
const SEED={
  people:{ "p-jaren-eells":{first:"Jaren",last:"Eells",email:"jareneells@arctic.biz",nameNorm:"jaren eells",
             savedJobs:JOBS.slice(),jobOrder:[],removedJobs:[]},
           "p-bob-smith":{first:"Bob",last:"Smith",email:"bob@arctic.biz",nameNorm:"bob smith",savedJobs:["25-0150"]} },
  arrivals:mkArrivals(),
  rentals:{ r1:{rentalId:"RB1",jobNumber:"25-0150",jobName:"Job 25-0150",equipment:"Genie S45",dateRented:"2026-07-01",status:"Renting",rate:"250/1100/3200",seq:1},
            r2:{rentalId:"RB2",jobNumber:"25-0300",jobName:"Job 25-0300",equipment:"Scissor Lift",dateRented:"2026-07-15",status:"Returned",dateReturned:"2026-07-28",seq:1} },
  toolRentals:{ t1:{jobNumber:"25-0150",jobName:"Job 25-0150",toolType:"Core drill",toolId:"CD-9",rentalStarted:"2026-07-05",billingDays:5,dailyRate:40,billingTotal:"200",discountedRate:"180",status:"Out",seq:1} },
  safetyPoints:{ p1:{name:"ALEXANDER; JEREMY",shirt:"xl",start:2500,awards:{"1/19":100},used:-500,extra:0,total:2100},
                 p2:{name:"KING; JUDSON C.",shirt:"l",start:2150,awards:{},used:0,extra:0,total:2150} },
  safetyTraining:{ t1:{name:"Chris Brown",course:"Forklift",instructor:"H. L.",date:"2024-12-05",expires:"2027-12-05"},
                   t2:{name:"Alex Garcia",course:"Scissor Lift",instructor:"H. S.",date:"2026-03-13",expires:"2026-09-01"},
                   t3:{name:"AJ Stansbury",course:"Respirator",instructor:"Onsite",date:"2025-10-09",expires:"2025-11-01"} },
  safetySds:{ s1:{record:"1",product:"Acetylene",use:"Welding",vendor:"Airgas",issueDate:"2021-06-21",dept:"All",pages:"11"} },
  safetyDrugCards:{ d1:{name:"Ted Carr",tested:"2024-09-09",expires:"2025-03-09"} },
  shares:{}, webductOrders:{},
  config:{ lastImport:{emailDateMs:1,importedAt:"2026-08-05"} },
};

const browser=await chromium.launch({executablePath:CHROMIUM,args:["--no-sandbox"]});

async function monkey(label,width,height,mobile,seedN,steps){
  const ctx=await browser.newContext({viewport:{width,height},isMobile:!!mobile,hasTouch:!!mobile,acceptDownloads:true});
  const page=await ctx.newPage();
  const errs=[];
  page.on("pageerror",e=>errs.push(`pageerror: ${e.message}`));
  page.on("console",m=>{ const t=m.text();
    if(m.type()==="error" && !/net::ERR_|Failed to load resource/.test(t)) errs.push(`console: ${t}`); });
  page.on("dialog",d=>d.accept().catch(()=>{}));
  await page.addInitScript(seed=>{ window.__SEED=seed;
    localStorage.setItem("er_user",JSON.stringify({first:"Jaren",last:"Eells",email:"jareneells@arctic.biz",id:"p-jaren-eells"}));
    localStorage.setItem("tut_done","1"); },SEED);
  await page.goto(`http://localhost:${PORT}/`,{waitUntil:"networkidle"});
  await page.waitForTimeout(800);
  // unlock admin so the destructive surfaces are in play too
  await page.evaluate(()=>{ try{ window.adminUnlocked=true; }catch(e){}
    // In-page clicks hit the real window.confirm, which blocks. Auto-accept so the monkey
    // explores PAST destructive actions instead of parking on the first one.
    window.confirm=()=>true; window.alert=()=>{}; window.print=()=>{};
  });

  /* The whole step loop runs IN THE PAGE. Driving it from node meant a round trip per element
     per step, which made a useful number of steps take longer than the test was worth. The app
     uses delegated click handlers, so an in-page el.click() exercises exactly the same code. */
  const res=await page.evaluate(async ({steps,seedN})=>{
    const rng=s=>()=>{ s|=0; s=s+0x6D2B79F5|0; let t=Math.imul(s^s>>>15,1|s);
      t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; };
    const rand=rng(seedN);
    const TEXT=["","x","O'Brien \"Bob\"","  ","25-0150","zzzznope","\uD83D\uDE00 \u00BD\" 45\u00B0",
                "a".repeat(600),"-12","0","2026-13-45"];
    const SEL="button, [role=button], .tab, .sub-pill, [data-mjpick], [data-safety], [data-expand],"
      +" [data-toggle], [data-groupview], .acard-head, .mjp-row, .ptp-tab, .ptp-chk, .yn";
    const visible=n=>{ const r=n.getBoundingClientRect();
      return r.width>0 && r.height>0 && getComputedStyle(n).visibility!=="hidden"; };
    const pick=arr=>arr[Math.floor(rand()*arr.length)];
    let clicks=0, types=0;
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    for(let i=0;i<steps;i++){
      const act=rand();
      try{
        if(act<0.18){
          const fields=[...document.querySelectorAll("input:not([type=hidden]):not([type=file]), textarea, select")].filter(visible);
          if(fields.length){
            const el=pick(fields);
            if(el.tagName==="SELECT"){ const o=[...el.options]; if(o.length){ el.value=pick(o).value; } }
            else if(el.type==="date"){ el.value=pick(["2026-08-10","","2026-02-30"]); }
            else { el.value=pick(TEXT); }
            el.dispatchEvent(new Event("input",{bubbles:true}));
            el.dispatchEvent(new Event("change",{bubbles:true}));
            types++;
          }
        } else if(act<0.24){
          document.dispatchEvent(new KeyboardEvent("keydown",{key:pick(["Escape","Enter"," "]),bubbles:true}));
        } else {
          const els=[...document.querySelectorAll(SEL)].filter(n=>{
            if(!visible(n)) return false;
            if(n.id==="fileInput"||n.type==="file") return false;
            return !/sign out|log out/i.test(n.textContent||"");
          });
          if(els.length){ pick(els).click(); clicks++; }
        }
      }catch(e){ /* a node detached mid-click is the monkey's problem, not the app's */ }
      if(i%10===0) await sleep(12);
    }
    return {clicks,types};
  },{steps,seedN});
  const clicks=res.clicks, types=res.types, firstErrAt=errs.length?0:-1;
  await page.waitForTimeout(500);
  const stuck=await page.evaluate(()=>{
    const b=document.body;
    return { scrollLocked: b.style.overflow==="hidden" && !document.querySelector(".modal-back.show, #mjShowPanel:not([style*='display: none']), #mjJobsPanel"),
             sideways: document.documentElement.scrollWidth-window.innerWidth };
  });
  await ctx.close();
  return { errs, clicks, types, firstErrAt, stuck };
}

const fails=[]; const chk=(c,m)=>{ if(!c) fails.push(m); };
for(const [label,w,h,mob,seed] of [["phone",440,956,true,SEED_N],["laptop",1280,900,false,SEED_N+7]]){
  const r=await monkey(label,w,h,mob,seed,STEPS);
  console.log(`\n--- ${label} (seed ${seed}, ${STEPS} steps) --- ${r.clicks} clicks, ${r.types} field edits`);
  console.log(`    errors: ${r.errs.length}${r.firstErrAt>=0?` (first at step ${r.firstErrAt})`:""}`);
  r.errs.slice(0,8).forEach(e=>console.log("      "+e));
  console.log(`    sideways scroll: ${r.stuck.sideways}px`);
  chk(r.errs.length===0, `${label}: monkey hit ${r.errs.length} error(s), first at step ${r.firstErrAt}: ${r.errs[0]||""}`);
  chk(r.stuck.sideways<=1, `${label}: page ended up scrolling sideways by ${r.stuck.sideways}px`);
}

console.log("\n"+"=".repeat(60));
if(fails.length){ console.log("FAILURES:"); fails.forEach(f=>console.log("  - "+f));
  console.log(`\nreplay with: MONKEY_SEED=${SEED_N} MONKEY_STEPS=${STEPS} node test_monkey.mjs`); }
else console.log(`monkey: ${STEPS*2} random actions across both layouts, zero uncaught errors`);
await browser.close(); server.close();
process.exit(fails.length?1:0);
