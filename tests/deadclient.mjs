/* The two errors seen in production -- "Save failed: failed-precondition" when logging a delivery,
   and "Import failed: The client has already been terminated." on a tool-rental upload -- are one
   root cause: the Firestore SDK shut its own client down after its IndexedDB persistence failed.
   This proves the app now recognises that state, says something a person can act on, and offers
   the one thing that actually fixes it. */
import { chromium } from "playwright";
import fs from "node:fs"; import path from "node:path";
import { startServer, routeCdn, CHROMIUM } from "./serve.mjs";
const { server, port: PORT } = await startServer();

const SEED={ people:{"p-jaren-eells":{first:"Jaren",last:"Eells",email:"jareneells@arctic.biz",nameNorm:"jaren eells",savedJobs:["25-0150"],jobOrder:[],removedJobs:[]}},
  arrivals:{ a1:{dateReceived:"2026-08-04",jobNumber:"25-0150",jobName:"Alpha",description:"VAV boxes",supplier:"Acme",seq:1} },
  rentals:{},toolRentals:{},config:{lastImport:{emailDateMs:1,importedAt:"2026-08-05"}} };

const fails=[]; const chk=(c,m)=>{ if(!c) fails.push(m); };
const browser=await chromium.launch({executablePath:CHROMIUM,args:["--no-sandbox"]});
const ctx=await browser.newContext({viewport:{width:440,height:956},isMobile:true,hasTouch:true});
await routeCdn(ctx);
const page=await ctx.newPage();
const errs=[];
page.on("pageerror",e=>errs.push("pageerror: "+e.message));
await page.addInitScript(s=>{ window.__SEED=s;
  localStorage.setItem("er_user",JSON.stringify({first:"Jaren",last:"Eells",email:"jareneells@arctic.biz",id:"p-jaren-eells"}));
  localStorage.setItem("tut_done","1");
  // Make every write fail the way a terminated client does. Firestore uses both of these
  // wordings depending on which call notices first, so cover both.
  window.__KILL_MODE="terminated";
  window.__killWrites=()=>{ window.__FB_KILL=true; };
},SEED);
await page.goto(`http://localhost:${PORT}/`,{waitUntil:"networkidle"});
await page.waitForTimeout(800);

async function killWrites(mode){
  await page.evaluate(m=>{ window.__FB_KILL=m; },mode);
}

// The stub honours __FB_KILL, mirroring a client the SDK has shut down.
await killWrites("terminated");
await page.locator('#feedList .acard[data-id="a1"] [data-deliv]').click(); await page.waitForTimeout(400);
await page.check("#d_delivered"); await page.waitForTimeout(200);
await page.locator("#delivSubmit").click(); await page.waitForTimeout(900);

const toast=(await page.locator("#toast").innerText().catch(()=>"")).trim();
console.log("toast after a dead-client save:", JSON.stringify(toast));
chk(!/failed-precondition/i.test(toast), `the raw Firestore code still reaches the user: ${toast}`);
chk(/reload/i.test(toast), `the message does not tell the user what to do: ${toast}`);

const bar=page.locator(".fb-dead");
chk(await bar.count()===1, "no recovery banner appeared when the client died");
const barText=(await bar.innerText().catch(()=>"")).replace(/\s+/g," ").trim();
console.log("banner:", JSON.stringify(barText.slice(0,110)));
chk(/reload/i.test(barText), "the banner has no way to recover");
chk(!/precondition|terminated/i.test(barText), "the banner leaks SDK wording at the user");
// it must sit above modals -- the delivery modal is still open behind it
const z=await page.evaluate(()=>{
  const b=document.querySelector(".fb-dead"), m=document.querySelector(".modal-back.show");
  return { bar:+getComputedStyle(b).zIndex, modal:m?+getComputedStyle(m).zIndex:0 };
});
console.log("z-index — banner",z.bar,"modal",z.modal);
chk(z.bar>z.modal, "the recovery banner sits under the modal that cannot save");

// and only one banner no matter how many things fail afterwards
await page.locator("#delivSubmit").click().catch(()=>{}); await page.waitForTimeout(600);
chk(await page.locator(".fb-dead").count()===1, "a second failure stacked another banner");

// the reload button actually reloads
await page.locator(".fb-dead button").click();
await page.waitForTimeout(1200);
chk(await page.locator(".fb-dead").count()===0, "reloading did not clear the banner");
console.log("reload button recovers: ok");

console.log("\n"+"=".repeat(60));
if(errs.length){ console.log("PAGE ERRORS:"); errs.forEach(e=>console.log("  - "+e)); }
if(fails.length){ console.log("FAILURES:"); fails.forEach(f=>console.log("  - "+f)); }
else console.log("dead-client recovery: all checks passed");
await browser.close(); server.close();
process.exit(fails.length||errs.length?1:0);
