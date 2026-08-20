/* Clearing a new-arrival alert has to stick everywhere that person signs in. Clearing it on the
   phone at the gate and then meeting the same red badge on the laptop in the trailer is the
   complaint this suite exists to hold down.

   The merge is a union and never a replace, which is what makes it safe with no coordination:
   clearing is monotone, so two devices that cleared different things converge on both cleared, in
   either order. These cases check that, and the three ways it could go wrong -- a second device
   opening cold, a clear arriving live, and a shared phone leaking one person's alerts onto the
   next person's account. */
import { chromium } from "playwright";
import { startServer, routeCdn, CHROMIUM, report } from "./serve.mjs";
const { server, port: PORT } = await startServer();

const fails=[]; const chk=(c,m)=>{ if(!c) fails.push(m); };
const errs=[];
const browser=await chromium.launch({executablePath:CHROMIUM,args:["--no-sandbox"]});

const ME="p-jaren-eells";
const person=extra=>({[ME]:{first:"Jaren",last:"Eells",email:"jareneells@arctic.biz",
  nameNorm:"jaren eells",savedJobs:["25-0150","25-0200"],jobOrder:[],removedJobs:[],...extra}});
const arrivals={};
for(let i=0;i<6;i++) arrivals["a"+i]={dateReceived:`2026-08-0${i+1}`,jobNumber:i<4?"25-0150":"25-0200",
  jobName:"Alpha",description:"Item "+i,supplier:"Acme",seq:1};
const ALL_IDS=Object.keys(arrivals).map(id=>"a:"+id);
const seedWith=extra=>({people:person(extra),arrivals,rentals:{},toolRentals:{},shares:{},
  webductOrders:{},config:{lastImport:{emailDateMs:1,importedAt:"2026-08-05"}}});

async function device(seed,{who=null,seenLocal=null}={}){
  const ctx=await browser.newContext({viewport:{width:1280,height:1000}});
  await routeCdn(ctx);
  const page=await ctx.newPage();
  page.on("pageerror",e=>errs.push("pageerror: "+e.message));
  page.on("console",m=>{const t=m.text();
    if(m.type()==="error" && !/net::ERR_|Failed to load resource/.test(t)) errs.push("console: "+t);});
  page.on("dialog",d=>d.accept().catch(()=>{}));
  await page.addInitScript(({s,who,seenLocal})=>{ window.__SEED=s;
    localStorage.setItem("er_user",JSON.stringify(who||{first:"Jaren",last:"Eells",email:"jareneells@arctic.biz",id:"p-jaren-eells"}));
    if(seenLocal) localStorage.setItem("er_seen",JSON.stringify(seenLocal));
    localStorage.setItem("tut_done","1"); },{s:seed,who,seenLocal});
  await page.goto(`http://localhost:${PORT}/`,{waitUntil:"networkidle"});
  await page.waitForTimeout(900);
  // the banner and its Clear all button live inside the My Jobs view
  await page.locator("nav.tabs .tab[data-view='jobs']").click();
  await page.waitForTimeout(400);
  return { ctx, page };
}
const badge=page=>page.evaluate(()=>{
  const b=document.getElementById("jobsNotif");
  return b && b.classList.contains("show") ? Number(b.textContent)||0 : 0; });

/* ---- 1. clearing writes the acknowledgement to the person's record, not just the device ---- */
let clearedIds=[];
{
  // this device has seen nothing; all six arrivals are new
  const { ctx, page } = await device(seedWith({}), {seenLocal:{init:true,ids:[]}});
  const before=await badge(page);
  console.log("device A — alerts before clearing:", before);
  chk(before===6, `device A should start with 6 alerts, had ${before}`);

  await page.locator("#notifClear").click();
  await page.waitForTimeout(900);                       // past the 400ms write debounce
  const after=await badge(page);
  chk(after===0, `clearing left ${after} alerts on the device that did it`);

  const writes=await page.evaluate(()=>window.__WRITES||[]);
  const seenWrites=writes.filter(w=>w.coll==="people" && w.id==="p-jaren-eells" && w.data && Array.isArray(w.data.seenIds));
  const last=seenWrites[seenWrites.length-1];
  clearedIds=last?last.data.seenIds:[];
  console.log(`device A — writes carrying seenIds: ${seenWrites.length}, ids in the last one: ${clearedIds.length}`);
  chk(seenWrites.length>0, "clearing an alert never wrote it to the person's record — it stayed on the one device");
  chk(seenWrites.length<=2, `clearing wrote ${seenWrites.length} times; the debounce is not holding`);
  chk(ALL_IDS.every(id=>clearedIds.includes(id)), "the write did not cover every arrival that was cleared");
  await ctx.close();
}

/* ---- 2. the other device opens cold and the alerts are already gone ---- */
{
  const { ctx, page } = await device(seedWith({seenInit:true,seenIds:clearedIds}), {seenLocal:null});
  const n=await badge(page);
  console.log("device B — alerts on first open after A cleared:", n);
  chk(n===0, `device B still showed ${n} alerts that were cleared on device A`);
  await ctx.close();
}

/* ---- 3. a clear made elsewhere lands on a device that is already open ---- */
{
  const { ctx, page } = await device(seedWith({}), {seenLocal:{init:true,ids:[]}});
  chk(await badge(page)===6, "device C did not start with the 6 alerts it needs for this case");
  // device A clears them while C is sitting open
  await page.evaluate(ids=>window.__echoDoc("people","p-jaren-eells",{seenInit:true,seenIds:ids}),ALL_IDS);
  await page.waitForTimeout(700);
  const n=await badge(page);
  console.log("device C — alerts after another device cleared them, no reload:", n);
  chk(n===0, `a clear from another device did not reach an open one (${n} alerts still showing)`);
  await ctx.close();
}

/* ---- 4. it is per person, not per device ----
   The shop phone gets passed around. Whoever signs in next must not inherit the last person's
   cleared alerts -- and now that the set is written back to the server, must not push them onto
   that person's other devices either. */
{
  const seed=seedWith({});
  seed.people["p-bob-smith"]={first:"Bob",last:"Smith",email:"bob@arctic.biz",nameNorm:"bob smith",
    savedJobs:["25-0150"],jobOrder:[],removedJobs:[]};
  // arrive with Jaren's cleared set already on the device
  const { ctx, page } = await device(seed, {seenLocal:{init:true,ids:ALL_IDS}});
  chk(await badge(page)===0, "device D should start clear — it is holding Jaren's acknowledged set");

  await page.locator("#whoChip").click();
  await page.waitForTimeout(400);
  await page.fill("#n_first","Bob");
  await page.fill("#n_last","Smith");
  await page.fill("#si_email","bob@arctic.biz");
  await page.locator("#nameSubmit").click();
  await page.waitForTimeout(1200);

  /* Bob starts at zero, and that is correct: signing in takes everything already on the board as
     already seen, rather than opening with a stack of alerts for deliveries from before he was
     here. What must NOT happen is Jaren's set being adopted as Bob's. */
  const n=await badge(page);
  console.log("device D — Bob's alerts right after signing in:", n);
  chk(n===0, `signing in fresh should not open with a backlog of alerts, showed ${n}`);

  const writes=await page.evaluate(()=>window.__WRITES||[]);
  const ontoBob=[...new Set(writes.filter(w=>w.coll==="people" && w.id==="p-bob-smith" && w.data && Array.isArray(w.data.seenIds))
                                  .flatMap(w=>w.data.seenIds))];
  // a:a4 and a:a5 are on 25-0200, which is Jaren's job and not Bob's. Their presence would mean
  // the device handed Bob the set it was holding for the last person.
  const foreign=ontoBob.filter(id=>id==="a:a4"||id==="a:a5");
  console.log(`device D — ids written to Bob's record: ${ontoBob.length}, of them on jobs he does not have: ${foreign.length}`);
  chk(foreign.length===0, `Jaren's acknowledged arrivals were written onto Bob's record: ${foreign.join(", ")}`);

  // and Bob's own tracking works from here: a delivery landing now is new to him
  await page.evaluate(()=>window.__echoDoc("arrivals","a99",
    {dateReceived:"2026-08-09",jobNumber:"25-0150",jobName:"Alpha",description:"Landed after Bob signed in",supplier:"Acme",seq:1}));
  await page.waitForTimeout(700);
  const after=await badge(page);
  console.log("device D — Bob's alerts after a new arrival on his job:", after);
  chk(after===1, `a new arrival on Bob's job should alert him once, badge showed ${after}`);
  await ctx.close();
}

process.exit(report("cross-device alerts", fails, errs) || (await browser.close(), server.close(), 0));
