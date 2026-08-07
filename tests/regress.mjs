/* Regressions for the faults a 13-lens review turned up. Each one had already shipped and each
   one is silent -- nothing throws, nothing shows an error, the app just quietly tells you the
   wrong thing or throws your data away. That is exactly the class a test suite has to hold down,
   because nobody reports what they never notice. */
import { chromium } from "playwright";
import { startServer, routeCdn, CHROMIUM, report } from "./serve.mjs";
const { server, port: PORT } = await startServer();

const fails=[]; const chk=(c,m)=>{ if(!c) fails.push(m); };
const errs=[];
/* Case 4 makes a read fail on purpose, and the app is supposed to log that -- console.error is
   the correct response to it, so it must not count as a page error. Only the induced one is
   forgiven, and only while it is being induced. */
let EXPECT_OFFLINE=false;
const forgiven=t=>EXPECT_OFFLINE && /client is offline/i.test(t);
const browser=await chromium.launch({executablePath:CHROMIUM,args:["--no-sandbox"]});

/* Every US timezone is behind UTC, so a bare "YYYY-MM-DD" run through new Date() lands on the
   day before. Arctic Mechanical is in Utah; run this suite there, where the bug was real. */
const TZ="America/Denver";

async function open(seed,{user=true,tz=TZ}={}){
  const ctx=await browser.newContext({viewport:{width:1280,height:1000},timezoneId:tz});
  await routeCdn(ctx);
  const page=await ctx.newPage();
  page.on("pageerror",e=>errs.push("pageerror: "+e.message));
  page.on("console",m=>{const t=m.text();
    if(m.type()==="error" && !/net::ERR_|Failed to load resource/.test(t) && !forgiven(t)) errs.push("console: "+t);});
  await page.addInitScript(({s,user})=>{ window.__SEED=s;
    if(user) localStorage.setItem("er_user",JSON.stringify({first:"Jaren",last:"Eells",email:"jareneells@arctic.biz",id:"p-jaren-eells"}));
    localStorage.setItem("tut_done","1"); },{s:seed,user});
  await page.goto(`http://localhost:${PORT}/`,{waitUntil:"networkidle"});
  await page.waitForTimeout(700);
  return { ctx, page };
}
const PERSON={"p-jaren-eells":{first:"Jaren",last:"Eells",email:"jareneells@arctic.biz",
  nameNorm:"jaren eells",savedJobs:["25-0150"],jobOrder:[],removedJobs:[]}};
const BASE={people:PERSON,rentals:{},toolRentals:{},shares:{},webductOrders:{},
  config:{lastImport:{emailDateMs:1,importedAt:"2026-08-05"}}};

/* ---- 1. the Deliveries calendar filed everything one day early ---- */
{
  const seed={...BASE, arrivals:{
    a1:{dateReceived:"2026-08-01",jobNumber:"25-0150",jobName:"Alpha",description:"VAV boxes",
        supplier:"Acme",reqDeliv:"2026-08-10",seq:1},
    a2:{dateReceived:"2026-08-02",jobNumber:"25-0150",jobName:"Alpha",description:"Grilles",
        supplier:"Acme",delivered:true,deliveredDate:"2026-08-20",seq:1},
  }};
  const { ctx, page } = await open(seed);
  // Deliveries lives behind the Arrivals tab's caret menu, not its own tab
  await page.locator("#feedGroupCaret").click();
  await page.locator('[data-groupview="deliveries"]').click();
  await page.waitForTimeout(700);
  // walk to August 2026 whichever way the month happens to start
  for(let i=0;i<36 && !(await page.locator('[data-calday^="2026-08"]').count());i++){
    const back=page.locator("#calPrev, [data-calnav='prev']").first();
    if(await back.count()) await back.click(); else break;
    await page.waitForTimeout(90);
  }
  const days=await page.evaluate(()=>[...document.querySelectorAll("[data-calday]")].map(n=>n.dataset.calday));
  const has=k=>days.includes(k);
  console.log(`calendar (${TZ}) marked days in view:`, days.filter(d=>d.startsWith("2026-08")).join(", ")||"(none)");
  chk(has("2026-08-10"), "a delivery wanted on 8/10 is not on 8/10 — the calendar is off by a day again");
  chk(!has("2026-08-09"), "a delivery wanted on 8/10 also lit up 8/9 — off-by-one is back");
  chk(has("2026-08-20"), "a delivery completed on 8/20 is not on 8/20");
  chk(!has("2026-08-19"), "a delivery completed on 8/20 also lit up 8/19 — off-by-one is back");
  await ctx.close();
}

/* ---- 2. one numeric cell used to freeze every list on the page ----
   Firestore does not promise types. A PO of "0012" typed into a spreadsheet arrives as the
   number 12, and (12||"").toLowerCase() throws -- inside renderFeed, which aborted renderAll(),
   so every list stopped updating. Only while a search term was present, which made it look
   random rather than reproducible. */
{
  const seed={...BASE, arrivals:{
    a1:{dateReceived:"2026-08-01",jobNumber:"25-0150",jobName:"Alpha",description:"Copper fittings",
        supplier:"Acme",po:"PO-1",seq:1},
    a2:{dateReceived:"2026-08-02",jobNumber:250150,jobName:"Alpha",description:9876,
        supplier:null,po:12345,requestedBy:{bad:"object"},seq:1},
  }};
  const { ctx, page } = await open(seed);
  const before=errs.length;
  await page.fill("#feedSearch","copper");
  await page.waitForTimeout(500);
  const shown=await page.locator("#feedList .acard").count();
  console.log(`search across a numeric PO and a numeric description: ${shown} card(s), ${errs.length-before} new error(s)`);
  chk(errs.length===before, `searching with a numeric field on a record threw: ${errs[before]||""}`);
  chk(shown===1, `search should have matched the one copper row, matched ${shown}`);

  // and the numbers are still findable as text
  await page.fill("#feedSearch","9876");
  await page.waitForTimeout(400);
  chk(await page.locator("#feedList .acard").count()===1, "a numeric description is not searchable as text");
  await ctx.close();
}

/* ---- 3. signing in with the optional email box blank wiped the stored address ----
   Permissions come from that address, so filling the form in the way the form invites locked
   the person out of the app. */
{
  const { ctx, page } = await open({...BASE, arrivals:{}}, {user:false});
  await page.fill("#n_first","Jaren");
  await page.fill("#n_last","Eells");
  const emailBox=page.locator("#si_email");
  if(await emailBox.count()) await emailBox.fill("");     // leave it blank, as it is optional
  await page.locator("#nameSubmit").click();
  await page.waitForTimeout(700);
  const writes=await page.evaluate(()=>window.__WRITES||[]);
  const mine=writes.filter(w=>w.coll==="people" && w.id==="p-jaren-eells");
  const wiped=mine.some(w=>w.data && Object.prototype.hasOwnProperty.call(w.data,"email") && !String(w.data.email||"").trim());
  console.log(`sign-in writes to people/p-jaren-eells: ${mine.length}, any that blank the email: ${wiped}`);
  chk(mine.length>0, "signing in wrote nothing to the person record at all");
  chk(!wiped, "signing in with the email box blank overwrote the stored address with an empty one");
  const stillCompany=await page.evaluate(()=>{ try{ return JSON.parse(localStorage.getItem("er_user")||"{}").email||""; }catch(e){ return ""; } });
  console.log("email carried into this session:", JSON.stringify(stillCompany));
  chk(/@arctic\.biz$/.test(stillCompany), `the session lost the company email, so it lost its permissions: ${stillCompany}`);
  await ctx.close();
}

/* ---- 4. a failed read of people/{id} used to delete every saved job ----
   merge:true merges FIELDS, not the contents of an array: savedJobs is replaced wholesale by
   whatever MY_JOBS holds. Before the read finishes -- or after it fails, which is what a weak
   signal in a basement looks like -- MY_JOBS is still []. */
{
  const { ctx, page } = await open({...BASE, arrivals:{}}, {user:false});
  // make the read of the person doc fail, the way it does with no signal
  EXPECT_OFFLINE=true;
  await page.evaluate(()=>{ window.__GET_FAIL=true; });
  await page.fill("#n_first","Jaren");
  await page.fill("#n_last","Eells");
  const emailBox=page.locator("#si_email");
  if(await emailBox.count()) await emailBox.fill("jareneells@arctic.biz");
  await page.locator("#nameSubmit").click();
  await page.waitForTimeout(900);
  const writes=await page.evaluate(()=>window.__WRITES||[]);
  const emptied=writes.filter(w=>w.coll==="people" && w.data && Array.isArray(w.data.savedJobs) && w.data.savedJobs.length===0);
  console.log(`writes that would empty savedJobs: ${emptied.length}`);
  chk(emptied.length===0, `a sign-in wrote savedJobs:[] to the server, deleting every saved job (${emptied.length} write(s))`);
  // the person still has to be told, rather than silently carrying on with an empty list
  const said=await page.evaluate(()=>document.body.innerText);
  chk(/saved jobs/i.test(said), "a failed load of the saved-job list said nothing to the user");
  EXPECT_OFFLINE=false;
  await ctx.close();
}

process.exit(report("regressions", fails, errs) || (await browser.close(), server.close(), 0));
