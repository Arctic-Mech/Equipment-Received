/* An in-app import REPLACES what the sheet covers: rows that dropped off the newer file are
   deleted, not left behind — but only rows an import wrote. Hand-logged rows (source:"manual")
   and anything untagged survive, and an import that carries no rows for a category never wipes it.
   This drives the real handleExcel path with an .xlsx built in the page. */
import { chromium } from "playwright";
import { startServer, routeCdn, CHROMIUM, report } from "./serve.mjs";
const { server, port: PORT } = await startServer();

const fails=[]; const chk=(c,m)=>{ if(!c) fails.push(m); };
const errs=[];
const browser=await chromium.launch({executablePath:CHROMIUM,args:["--no-sandbox"]});

const BASE={
  people:{"p-jaren-eells":{first:"Jaren",last:"Eells",email:"jareneells@arctic.biz",
    nameNorm:"jaren eells",savedJobs:[],jobOrder:[],removedJobs:[]}},
  arrivals:{
    "imp-stale":{source:"import",  dateReceived:"2026-07-01",jobNumber:"25-0150",jobName:"Alpha",description:"OLD REMOVED DUCT",supplier:"Acme",seq:1},
    "man-keep": {source:"manual",  dateReceived:"2026-07-02",jobNumber:"25-0150",jobName:"Alpha",description:"HAND LOGGED DUCT",supplier:"Acme",seq:2},
    "legacy":   {                  dateReceived:"2026-07-03",jobNumber:"25-0150",jobName:"Alpha",description:"UNTAGGED LEGACY",supplier:"Acme",seq:3},
  },
  rentals:{
    "impr-stale":{source:"import", rentalId:"RB9",jobNumber:"25-0150",jobName:"Alpha",equipment:"Old Lift",dateRented:"2026-06-01",status:"Renting",seq:1},
    "manr-keep": {source:"manual", rentalId:"RB8",jobNumber:"25-0150",jobName:"Alpha",equipment:"Hand Lift",dateRented:"2026-06-02",status:"Renting",seq:2},
  },
  toolRentals:{}, shares:{}, webductOrders:{},
  config:{lastImport:{emailDateMs:1,importedAt:"2026-08-05"}},
};

async function boot(seed, {admin=true}={}){
  const ctx=await browser.newContext({viewport:{width:1280,height:1000}});
  await routeCdn(ctx);
  const page=await ctx.newPage();
  page.on("pageerror",e=>errs.push("pageerror: "+e.message));
  page.on("console",m=>{const t=m.text();
    if(m.type()==="error" && !/net::ERR_|Failed to load resource/.test(t)) errs.push("console: "+t);});
  page.on("dialog",d=>d.accept().catch(()=>{}));
  await page.addInitScript(({s,admin})=>{ window.__SEED=s;
    localStorage.setItem("er_user",JSON.stringify({first:"Jaren",last:"Eells",email:"jareneells@arctic.biz",id:"p-jaren-eells"}));
    localStorage.setItem("tut_done","1"); if(admin) sessionStorage.setItem("er_admin","1");
  },{s:seed,admin});
  await page.goto(`http://localhost:${PORT}/`,{waitUntil:"networkidle"});
  await page.waitForTimeout(700);
  return { ctx, page };
}

// Build a master workbook in the page (XLSX is loaded there) and return it as base64.
async function buildXlsx(page, {arrivals=[], rentals=[]}={}){
  return await page.evaluate(({arrivals,rentals})=>{
    const wb=XLSX.utils.book_new();
    if(arrivals.length){
      const head=["Date Received","P.O.","Job#","Job Name","Description","Supplier","Delivery","Requested By"];
      const ws=XLSX.utils.aoa_to_sheet([head,...arrivals]);
      XLSX.utils.book_append_sheet(wb,ws,"Aug 2026");
    }
    if(rentals.length){
      const head=["Rental ID","Job Name","Equipment","Rate","Vendor","Date Rented","Status","Returned","Ordered By","P.O."];
      const ws=XLSX.utils.aoa_to_sheet([head,...rentals]);
      XLSX.utils.book_append_sheet(wb,ws,"Equipment Rentals");
    }
    const out=XLSX.write(wb,{type:"base64",bookType:"xlsx"});
    return out;
  },{arrivals,rentals});
}

async function runImport(page, b64){
  await page.locator("#btnAdminOpen").click();   // the import button lives in the Admin view
  await page.waitForTimeout(200);
  await page.locator("#btnImport").click();
  await page.waitForTimeout(200);
  const buf=Buffer.from(b64,"base64");
  await page.setInputFiles("#fileInput",{name:"master.xlsx",
    mimeType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer:buf});
  // wait for the "Import complete" stage
  await page.waitForFunction(()=>/Import complete/.test(document.querySelector("#importBody")?.textContent||""),{timeout:20000});
}
const dels=(writes,coll)=>writes.filter(w=>w.op==="del"&&w.coll===coll).map(w=>w.id);

/* ---- 1. a full sheet removes the stale import rows, keeps manual + untagged ---- */
{
  const { ctx, page } = await boot(BASE);
  const b64=await buildXlsx(page,{
    arrivals:[
      ["2026-08-01","PO-N1","25-0150","Alpha","NEW DUCT A","Ferguson","",""],
      ["2026-08-02","PO-N2","25-0150","Alpha","NEW DUCT B","Grainger","",""],
    ],
    rentals:[
      ["RB100","Alpha","New Scissor Lift","250","United","2026-08-01","Renting","","Bob","PO-R1"],
    ],
  });
  await runImport(page,b64);
  await page.waitForTimeout(300);
  const writes=await page.evaluate(()=>window.__WRITES||[]);
  const aDel=dels(writes,"arrivals"), rDel=dels(writes,"rentals");
  console.log("arrivals deleted:", aDel, "| rentals deleted:", rDel);
  chk(aDel.includes("imp-stale"), "the stale import arrival was not removed");
  chk(!aDel.includes("man-keep"), "a hand-logged arrival was wrongly removed");
  chk(!aDel.includes("legacy"), "an untagged legacy arrival was wrongly removed");
  chk(rDel.includes("impr-stale"), "the stale import rental was not removed");
  chk(!rDel.includes("manr-keep"), "a hand-logged rental was wrongly removed");
  // the new rows were written
  const aSet=writes.filter(w=>w.op==="set"&&w.coll==="arrivals").map(w=>w.data.description);
  chk(aSet.includes("NEW DUCT A")&&aSet.includes("NEW DUCT B"), "the new arrivals weren't written");
  await ctx.close();
}

/* ---- 2. an arrivals-only sheet must NOT wipe the rentals category ---- */
{
  const { ctx, page } = await boot(BASE);
  const b64=await buildXlsx(page,{
    arrivals:[["2026-08-05","PO-Z","25-0150","Alpha","ONLY ARRIVAL","Acme","",""]],
    // no rentals tab at all
  });
  await runImport(page,b64);
  await page.waitForTimeout(300);
  const writes=await page.evaluate(()=>window.__WRITES||[]);
  const rDel=dels(writes,"rentals");
  console.log("rentals deleted on an arrivals-only import:", rDel);
  chk(rDel.length===0, `an arrivals-only sheet wiped ${rDel.length} rental(s) — the empty-category guard failed`);
  // arrivals still replaced normally
  chk(dels(writes,"arrivals").includes("imp-stale"), "arrivals weren't replaced on the arrivals-only import");
  await ctx.close();
}

process.exit(report("import replace", fails, errs) || (await browser.close(), server.close(), 0));
