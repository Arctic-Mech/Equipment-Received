/* Med gas certifications: a Safety section with no spreadsheet behind it, entered from the site.
   The three things worth pinning down: the expiry date is always renewed + 6 months and is never
   typed by hand; the warning lead time is configurable and drives what counts as "expiring soon";
   and the assigned watcher (Pete Messner) gets the whole list as a popup the first time he opens
   the site each day, wherever he is in it, while everyone else reads the Safety tab. */
import { chromium } from "playwright";
import { startServer, routeCdn, CHROMIUM, report } from "./serve.mjs";
const { server, port: PORT } = await startServer();

const fails=[]; const chk=(c,m)=>{ if(!c) fails.push(m); };
const errs=[];
const browser=await chromium.launch({executablePath:CHROMIUM,args:["--no-sandbox"]});

// Dates relative to whatever "today" the browser sees, so the expiry states are deterministic.
const iso=d=>d.toISOString().slice(0,10);
const shift=n=>{ const d=new Date(); d.setDate(d.getDate()+n); return iso(d); };
const TODAY=iso(new Date());

const CERTS={
  // expired last year
  "mgc-anna":  {name:"Anna Fields",  renewed:"2025-01-10", expires:"2025-07-10"},
  // expires in 20 days -> "soon" under any sane warning window
  "mgc-ben":   {name:"Ben Ortiz",    renewed:shift(20-182), expires:shift(20)},
  // expires in ~5 months -> "ok" under a 60-day window, "soon" under a 200-day one
  "mgc-cara":  {name:"Cara Lin",     renewed:shift(-30),    expires:shift(150)},
};

function seedBase(extra){
  return {
    people:{"p-jaren-eells":{first:"Jaren",last:"Eells",email:"jareneells@arctic.biz",
      nameNorm:"jaren eells",savedJobs:[],jobOrder:[],removedJobs:[]}},
    arrivals:{}, rentals:{}, toolRentals:{}, shares:{}, webductOrders:{},
    medGasCerts:{...CERTS},
    config:{ medGasSettings:{warnDays:60}, lastImport:{emailDateMs:1,importedAt:"2026-08-05"} },
    ...extra,
  };
}

async function open(seed,{admin=false,user=null,dayFlag=null}={}){
  const ctx=await browser.newContext({viewport:{width:1280,height:1000}});
  await routeCdn(ctx);
  const page=await ctx.newPage();
  page.on("pageerror",e=>errs.push("pageerror: "+e.message));
  page.on("console",m=>{const t=m.text();
    if(m.type()==="error" && !/net::ERR_|Failed to load resource/.test(t)) errs.push("console: "+t);});
  page.on("dialog",d=>d.accept().catch(()=>{}));
  const who=user||{first:"Jaren",last:"Eells",email:"jareneells@arctic.biz",id:"p-jaren-eells"};
  await page.addInitScript(({s,admin,who,dayFlag})=>{ window.__SEED=s;
    localStorage.setItem("er_user",JSON.stringify(who));
    localStorage.setItem("tut_done","1");
    if(admin) sessionStorage.setItem("er_admin","1");
    if(dayFlag) localStorage.setItem("medgas_alert_day",dayFlag);
  },{s:seed,admin,who,dayFlag});
  await page.goto(`http://localhost:${PORT}/`,{waitUntil:"networkidle"});
  await page.waitForTimeout(700);
  return { ctx, page };
}
const gotoMedgas=async page=>{ await page.locator("nav.tabs .tab[data-view='safety']").click();
  await page.locator('[data-safety="medgas"]').click(); await page.waitForTimeout(250); };

/* ---- 1. everyone sees the list; only admin can add/edit ---- */
{
  const { ctx, page } = await open(seedBase());        // ordinary signed-in worker
  await gotoMedgas(page);
  const names=await page.locator("#sfMedgasList .sf-lname").allInnerTexts();
  console.log("med gas rows (worker):", names.join(", "));
  chk(names.length===3, `worker should see all 3 certs, saw ${names.length}`);
  // urgency order: expired first, then soon, then ok
  chk(names[0]==="Anna Fields", `expired cert should sort first, got ${names[0]}`);
  chk(await page.locator("#sfMedgasList .sf-add").count()===0, "a non-admin was shown the Add button");
  chk(await page.locator("#sfMedgasSettings .mg-set").count()===0, "a non-admin was shown the warn-days control");
  chk(await page.locator('#sfMedgasList [data-sfmedgas]').count()===0, "a non-admin's rows were editable");
  // badges reflect state
  const anna=page.locator('#sfMedgasList .sf-grp', {hasText:"Anna Fields"});
  chk(/Expired/.test(await anna.locator(".sf-badge").innerText()), "expired cert not badged Expired");
  const ben=page.locator('#sfMedgasList .sf-grp', {hasText:"Ben Ortiz"});
  chk(/Expires/.test(await ben.locator(".sf-badge").innerText()), "soon cert not badged Expires");
  await ctx.close();
}

/* ---- 2. admin adds a cert; expiry auto-fills to renewed + 6 months ---- */
{
  const { ctx, page } = await open(seedBase({medGasCerts:{}}), {admin:true});
  await gotoMedgas(page);
  chk(await page.locator("#sfMedgasList .sf-add").count()===1, "admin didn't see the Add button on an empty list");
  await page.locator('[data-sfadd="medgas"]').click();
  await page.waitForTimeout(200);
  await page.fill("#sfF_name","Dwight Reed");
  await page.fill("#sfF_renewed","2026-08-31");         // short-month overflow: Feb has no 31st
  await page.waitForTimeout(80);
  const autoExp=await page.inputValue("#sfF_expires");
  console.log("2026-08-31 renewed -> expires auto:", autoExp);
  chk(autoExp==="2027-02-28", `expiry should clamp to 2027-02-28, got ${autoExp}`);
  chk(await page.getAttribute("#sfF_expires","readonly")!==null, "the expiry field should be read-only");
  await page.locator("#sfEditSave").click();
  await page.waitForTimeout(400);
  const writes=await page.evaluate(()=>window.__WRITES||[]);
  const w=writes.filter(x=>x.coll==="medGasCerts").pop();
  console.log("write:", w && JSON.stringify({name:w.data.name,renewed:w.data.renewed,expires:w.data.expires}));
  chk(!!w && w.data.name==="Dwight Reed", "the cert wasn't written");
  chk(!!w && w.data.expires==="2027-02-28", `stored expiry wrong: ${w&&w.data.expires}`);
  await ctx.close();
}

/* ---- 3. the lead time auto-saves (no Save button) and re-adjusts the alerts live ---- */
{
  const { ctx, page } = await open(seedBase(), {admin:true});
  await gotoMedgas(page);
  chk(await page.locator("#mgWarnSave").count()===0, "the warn-days Save button should be gone (auto-save)");
  const caraBadge=()=>page.locator('#sfMedgasList .sf-grp',{hasText:"Cara Lin"}).locator(".sf-badge").innerText();
  chk(/Valid to/.test(await caraBadge()), "Cara should read Valid-to under a 60-day window");
  // Type the new window; no click. Badges re-adjust immediately (optimistic), the write follows.
  await page.fill("#mgWarnDays","200");
  await page.waitForTimeout(150);
  chk(/Expires/.test(await caraBadge()), "widening the window didn't re-adjust Cara's badge live");
  await page.locator("#mgWarnDays").blur();               // flush the debounced save
  await page.waitForTimeout(400);
  const cfg=(await page.evaluate(()=>window.__WRITES||[])).filter(w=>w.coll==="config"&&w.id==="medGasSettings").pop();
  chk(!!cfg && Number(cfg.data.warnDays)===200, `auto-save wrote the wrong warn-days: ${cfg&&cfg.data.warnDays}`);
  console.log("warn-days auto-saves and re-adjusts live: ok");
  await ctx.close();
}

/* ---- 3b. the watcher (Pete) can edit certs and the lead time WITHOUT unlocking Admin ---- */
{
  const seed=seedBase();
  seed.people["p-pete-messner"]={first:"Pete",last:"Messner",email:"pete@arctic.biz",
    nameNorm:"pete messner",savedJobs:[],jobOrder:[],removedJobs:[]};
  // Pete, not admin, and already alerted today so the popup doesn't sit over the pane.
  const { ctx, page } = await open(seed, {user:{first:"Pete",last:"Messner",email:"pete@arctic.biz",id:"p-pete-messner"}, dayFlag:TODAY});
  await gotoMedgas(page);
  chk(await page.locator("#sfMedgasList .sf-add").count()===1, "the watcher couldn't see the Add button without admin");
  chk(await page.locator("#mgWarnDays").count()===1, "the watcher couldn't see the lead-time control");
  chk(await page.locator('#sfMedgasList [data-sfmedgas]').count()===3, "the watcher's rows weren't editable");
  // ...but managing WHO gets alerted stays admin-only
  chk(await page.locator("#mgWatchAdd").count()===0, "a non-admin watcher was allowed to manage the alert list");
  // and he can actually add a cert
  await page.locator('[data-sfadd="medgas"]').click(); await page.waitForTimeout(200);
  await page.fill("#sfF_name","New Tech"); await page.fill("#sfF_renewed","2026-03-15"); await page.waitForTimeout(80);
  await page.locator("#sfEditSave").click(); await page.waitForTimeout(300);
  const w=(await page.evaluate(()=>window.__WRITES||[])).filter(x=>x.coll==="medGasCerts").pop();
  chk(!!w && w.data.name==="New Tech" && w.data.expires==="2026-09-15", "the watcher's cert didn't save with the auto expiry");
  console.log("watcher edits certs + lead time without admin; can't manage the list: ok");
  await ctx.close();
}

/* ---- 3c. scheduling a re-cert captures the date it's booked for ---- */
{
  const { ctx, page } = await open(seedBase(), {admin:true});
  await gotoMedgas(page);
  const anna=page.locator('#sfMedgasList .sf-grp',{hasText:"Anna Fields"});
  await anna.locator("[data-sfmedgas]").click(); await page.waitForTimeout(150);
  const btn=anna.locator("[data-mgrecert]");
  chk(/Schedule re-cert/.test(await btn.innerText()), `med gas action should offer to schedule a re-cert, got "${await btn.innerText()}"`);
  await btn.click(); await page.waitForTimeout(200);
  chk(await page.locator("#medGasRecertModal.show").count()===1, "the re-cert date modal didn't open");
  await page.fill("#mgRecertDate","2025-09-15");
  await page.locator("#mgRecertSave").click(); await page.waitForTimeout(300);
  const w=(await page.evaluate(()=>window.__WRITES||[])).filter(x=>x.coll==="medGasCerts"&&x.id).pop();
  console.log("re-cert write:", w && JSON.stringify({recert:w.data.recert,silenced:w.data.silenced}));
  chk(!!w && w.data.recert==="2025-09-15", `the booked date wasn't saved: ${w&&w.data.recert}`);
  chk(!!w && w.data.silenced===true, "scheduling a re-cert didn't stop the warning");
  await page.waitForTimeout(150);
  chk(/Re-cert scheduled 9\/15\/25/.test(await anna.locator(".sf-badge").innerText()),
      `a scheduled cert should badge the booked date, got "${await anna.locator(".sf-badge").innerText()}"`);
  // Undo clears it
  await anna.locator("[data-mgunschedule]").click(); await page.waitForTimeout(300);
  const w2=(await page.evaluate(()=>window.__WRITES||[])).filter(x=>x.coll==="medGasCerts"&&x.id).pop();
  chk(!!w2 && !w2.data.recert && w2.data.silenced===false, "Undo didn't clear the scheduled re-cert");
  console.log("Re-cert scheduling with a date + undo: ok");
  await ctx.close();
}

/* ---- 3d. admin manages who gets the first-login alert ---- */
{
  const seed=seedBase();
  seed.people["p-dana-fox"]={first:"Dana",last:"Fox",email:"dana@arctic.biz",
    nameNorm:"dana fox",savedJobs:[],jobOrder:[],removedJobs:[]};
  const { ctx, page } = await open(seed, {admin:true});
  await gotoMedgas(page);
  // default shows the built-in watcher as a chip
  chk(/Pete Messner|pete messner/i.test(await page.locator("#sfMedgasSettings .mg-wchips").innerText()),
      "the default watcher chip wasn't shown");
  // add Dana
  await page.selectOption("#mgWatchAdd","p-dana-fox"); await page.waitForTimeout(300);
  const cfg=(await page.evaluate(()=>window.__WRITES||[])).filter(w=>w.coll==="config"&&w.id==="medGasSettings"&&Array.isArray(w.data.watchers)).pop();
  const wl=cfg?cfg.data.watchers:[];
  console.log("watchers after adding Dana:", JSON.stringify(wl.map(x=>x.name)));
  chk(wl.some(x=>x.id==="p-dana-fox"), "adding a watcher didn't write them to the list");
  chk(wl.some(x=>/pete/i.test(x.name)), "adding a watcher dropped the existing one");
  // remove Pete via his chip
  const peteChip=page.locator("#sfMedgasSettings .mg-wchip",{hasText:"Pete"});
  await peteChip.locator("button").click(); await page.waitForTimeout(300);
  const cfg2=(await page.evaluate(()=>window.__WRITES||[])).filter(w=>w.coll==="config"&&w.id==="medGasSettings"&&Array.isArray(w.data.watchers)).pop();
  chk(!cfg2.data.watchers.some(x=>/pete/i.test(x.name)), "removing Pete's chip didn't take him off the list");
  console.log("admin adds/removes watchers: ok");
  await ctx.close();
}

/* ---- 3e. the configured list actually governs the popup ---- */
{
  // Dana is configured as the sole watcher -> Dana gets it, Pete no longer does
  const seed=seedBase();
  for(const p of [["p-dana-fox","Dana","Fox"],["p-pete-messner","Pete","Messner"]])
    seed.people[p[0]]={first:p[1],last:p[2],email:p[1].toLowerCase()+"@arctic.biz",nameNorm:`${p[1].toLowerCase()} ${p[2].toLowerCase()}`,savedJobs:[],jobOrder:[],removedJobs:[]};
  seed.config.medGasSettings={warnDays:60,watchers:[{id:"p-dana-fox",name:"Dana Fox"}]};
  const dana=await open(seed,{user:{first:"Dana",last:"Fox",email:"dana@arctic.biz",id:"p-dana-fox"}});
  await dana.page.waitForTimeout(600);
  chk(await dana.page.locator("#medGasAlertModal.show").count()===1, "the configured watcher (Dana) didn't get the popup");
  await dana.ctx.close();
  const pete=await open(seed,{user:{first:"Pete",last:"Messner",email:"pete@arctic.biz",id:"p-pete-messner"}});
  await pete.page.waitForTimeout(600);
  chk(await pete.page.locator("#medGasAlertModal.show").count()===0, "Pete still got the popup after being removed from the list");
  console.log("configured watcher list governs the popup: ok");
  await pete.ctx.close();
}

/* ---- 4. Pete gets the morning popup; nobody else does ---- */
const PETE={first:"Pete",last:"Messner",email:"pete@arctic.biz",id:"p-pete-messner"};
{
  // fresh device (no day flag) -> popup on first open, on whatever page he lands on
  const seed=seedBase();
  seed.people["p-pete-messner"]={first:"Pete",last:"Messner",email:"pete@arctic.biz",
    nameNorm:"pete messner",savedJobs:[],jobOrder:[],removedJobs:[]};
  const { ctx, page } = await open(seed, {user:PETE});
  await page.waitForTimeout(600);
  const shown=await page.locator("#medGasAlertModal.show").count();
  console.log("Pete, first open of the day — popup shown:", shown);
  chk(shown===1, "Pete didn't get the morning popup on his first open");
  const listed=await page.locator("#medGasAlertBody .mg-aname").allInnerTexts();
  chk(listed.length===3, `popup should list all 3 certs, listed ${listed.length}`);
  chk(/need/.test(await page.locator("#medGasAlertBody .mg-alert-head").innerText()),
      "popup should call out that certs need a renewal booked");
  // and the day flag is now set so it won't nag again today
  const flag=await page.evaluate(()=>{try{return localStorage.getItem("medgas_alert_day");}catch(e){return null;}});
  chk(flag===TODAY, `the once-a-day flag wasn't stored (${flag})`);
  await ctx.close();
}
{
  // already shown today -> no popup
  const seed=seedBase();
  seed.people["p-pete-messner"]={first:"Pete",last:"Messner",email:"pete@arctic.biz",
    nameNorm:"pete messner",savedJobs:[],jobOrder:[],removedJobs:[]};
  const { ctx, page } = await open(seed, {user:PETE, dayFlag:TODAY});
  await page.waitForTimeout(600);
  chk(await page.locator("#medGasAlertModal.show").count()===0, "Pete got the popup twice in one day");
  console.log("Pete, second open same day — no popup: ok");
  await ctx.close();
}
{
  // a different person never gets the popup
  const { ctx, page } = await open(seedBase());        // Jaren
  await page.waitForTimeout(600);
  chk(await page.locator("#medGasAlertModal.show").count()===0, "a non-watcher got Pete's popup");
  console.log("non-watcher — no popup: ok");
  await ctx.close();
}
{
  // Pete, but every cert current -> popup still appears, reassuringly
  const seed=seedBase({medGasCerts:{ ok1:{name:"Cara Lin",renewed:shift(-30),expires:shift(150)} }});
  seed.people["p-pete-messner"]={first:"Pete",last:"Messner",email:"pete@arctic.biz",
    nameNorm:"pete messner",savedJobs:[],jobOrder:[],removedJobs:[]};
  const { ctx, page } = await open(seed, {user:PETE});
  await page.waitForTimeout(600);
  chk(await page.locator("#medGasAlertModal.show").count()===1, "Pete should still see the daily list when all current");
  chk(/current/.test(await page.locator("#medGasAlertBody .mg-alert-head").innerText()),
      "the all-current popup should say everything is current");
  console.log("Pete, all current — reassuring popup: ok");
  await ctx.close();
}

process.exit(report("med gas certs", fails, errs) || (await browser.close(), server.close(), 0));
