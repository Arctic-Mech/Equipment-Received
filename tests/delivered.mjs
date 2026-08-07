/* Marking an arrival delivered records WHO pressed the button and WHEN they pressed it -- which
   is not the same as the delivery date they type, and is the part nobody can reconstruct later. */
import { chromium } from "playwright";
import fs from "node:fs"; import path from "node:path";
import { startServer, routeCdn, CHROMIUM } from "./serve.mjs";
const { server, port: PORT } = await startServer();

const SEED={
  people:{"p-jaren-eells":{first:"Jaren",last:"Eells",email:"jareneells@arctic.biz",nameNorm:"jaren eells",savedJobs:["25-0150"],jobOrder:[],removedJobs:[]}},
  arrivals:{
    a1:{dateReceived:"2026-08-04",jobNumber:"25-0150",jobName:"Alpha",description:"VAV boxes",supplier:"Acme",seq:1},
    a2:{dateReceived:"2026-08-03",jobNumber:"25-0150",jobName:"Alpha",description:"Already delivered",supplier:"Acme",
        delivered:true,deliveredDate:"2026-08-01",deliveredBy:"Bob S.",deliveredMarkedOn:"2026-08-02",seq:1},
  },
  rentals:{},toolRentals:{},config:{lastImport:{emailDateMs:1,importedAt:"2026-08-05"}} };

const fails=[]; const chk=(c,m)=>{ if(!c) fails.push(m); };
const browser=await chromium.launch({executablePath:CHROMIUM,args:["--no-sandbox"]});
const ctx=await browser.newContext({viewport:{width:1280,height:1000}});
await routeCdn(ctx);
const errs=[];
async function boot(){
  const page=await ctx.newPage();
  page.on("pageerror",e=>errs.push("pageerror: "+e.message));
  page.on("console",m=>{const t=m.text();
    if(m.type()==="error" && !/net::ERR_|Failed to load resource/.test(t)) errs.push("console: "+t);});
  await page.addInitScript(s=>{window.__SEED=s;
    localStorage.setItem("er_user",JSON.stringify({first:"Jaren",last:"Eells",email:"jareneells@arctic.biz",id:"p-jaren-eells"}));
    localStorage.setItem("tut_done","1");},SEED);
  await page.goto(`http://localhost:${PORT}/`,{waitUntil:"networkidle"});
  await page.waitForTimeout(800);
  return page;
}
const page=await boot();

// an existing stamp renders
const seeded=await page.locator('#feedList .acard[data-id="a2"] .markedby').innerText().catch(()=>"");
console.log("seeded stamp:", JSON.stringify(seeded.trim()));
chk(/marked by Bob S\./.test(seeded), "an existing marked-by stamp is not shown");
chk(/8\/2\/26/.test(seeded), `the marked-on date is wrong: ${seeded}`);

// mark a fresh one delivered
await page.locator('#feedList .acard[data-id="a1"] [data-deliv]').click(); await page.waitForTimeout(400);
await page.check("#d_delivered"); await page.waitForTimeout(250);
await page.fill("#d_date","2026-08-01");            // delivered a week ago, marked today
await page.locator("#delivSubmit").click(); await page.waitForTimeout(700);

const w=await page.evaluate(()=>(window.__WRITES||[]).filter(x=>x.coll==="arrivals"&&x.id==="a1").pop());
console.log("write:", JSON.stringify({by:w&&w.data.deliveredBy, on:w&&w.data.deliveredMarkedOn, date:w&&w.data.deliveredDate}));
chk(w&&w.data.deliveredBy==="Jaren E.", `expected "Jaren E." as the marker, got ${w&&w.data.deliveredBy}`);
chk(w&&/^\d{4}-\d{2}-\d{2}$/.test(w.data.deliveredMarkedOn||""), "no marked-on date recorded");
// the two dates are independent: the delivery happened before it was marked
chk(w&&w.data.deliveredDate==="2026-08-01", "the typed delivery date was overwritten");
chk(w&&w.data.deliveredMarkedOn!==w.data.deliveredDate,
    "marked-on should be today, not a copy of the delivery date");

// re-saving to fix a typo must NOT rewrite who marked it
await page.locator('#feedList .acard[data-id="a2"] [data-deliv]').click(); await page.waitForTimeout(400);
await page.fill("#d_date","2026-08-05");
await page.locator("#delivSubmit").click(); await page.waitForTimeout(700);
const w2=await page.evaluate(()=>(window.__WRITES||[]).filter(x=>x.coll==="arrivals"&&x.id==="a2").pop());
console.log("re-save keeps the original marker:", JSON.stringify(w2&&w2.data.deliveredBy));
chk(!w2||w2.data.deliveredBy===undefined||w2.data.deliveredBy==="Bob S.",
    `re-saving rewrote the marker to ${w2&&w2.data.deliveredBy}`);

// un-delivering clears the stamp
await page.locator('#feedList .acard[data-id="a1"] [data-deliv]').click(); await page.waitForTimeout(400);
await page.uncheck("#d_delivered"); await page.waitForTimeout(200);
await page.locator("#delivSubmit").click(); await page.waitForTimeout(700);
const w3=await page.evaluate(()=>(window.__WRITES||[]).filter(x=>x.coll==="arrivals"&&x.id==="a1").pop());
chk(w3&&w3.data.deliveredBy==="", "un-marking left the old marker behind");

console.log("\n"+"=".repeat(60));
if(errs.length){ console.log("PAGE ERRORS:"); errs.forEach(e=>console.log("  - "+e)); }
if(fails.length){ console.log("FAILURES:"); fails.forEach(f=>console.log("  - "+f)); }
else console.log("delivered-by: all checks passed");
await browser.close(); server.close();
process.exit(fails.length||errs.length?1:0);
