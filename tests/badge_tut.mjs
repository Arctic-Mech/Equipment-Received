/* Two fixes: no auto-tutorial on first login, and the connection badge reaching "Live". */
import { chromium } from "playwright";
import fs from "node:fs"; import path from "node:path";
import { startServer, routeCdn, CHROMIUM, TESTS_DIR } from "./serve.mjs";
const { server, port: PORT } = await startServer();
const SEED=JSON.parse(fs.readFileSync(path.join(TESTS_DIR,"seed.json"),"utf8"));
SEED.config = SEED.config || {};
SEED.config.lastImport = { emailDateMs: 1, importedAt: "2026-07-30" };

const fails=[]; const chk=(c,m)=>{ if(!c) fails.push(m); };
const b=await chromium.launch({executablePath:CHROMIUM,args:["--no-sandbox"]});

async function boot(opts={}){
  const p=await b.newPage({viewport:{width:420,height:900}});
  const errs=[];
  p.on("pageerror",e=>errs.push("pageerror: "+e.message));
  p.on("console",m=>{const t=m.text(); if(m.type()==="error" && !/net::ERR_|Failed to load resource/.test(t)) errs.push("console: "+t);});
  await p.addInitScript(([seed,o])=>{
    window.__SEED=seed;
    if(o.offline) window.__PROBE_OFFLINE=true;
    localStorage.setItem("er_user",JSON.stringify({first:"Jaren",last:"Eells",email:"jareneells@arctic.biz",id:"p-jaren-eells"}));
    if(o.tutDone) localStorage.setItem("tut_done","1");
  },[SEED,opts]);
  await p.goto(`http://localhost:${PORT}/`,{waitUntil:"networkidle"});
  await p.waitForTimeout(900);
  return {p,errs};
}

// --- 1. A brand-new user (no tut_done) must NOT get the tutorial pushed at them.
{
  const {p,errs}=await boot();
  const open=await p.locator("#tutModal.show").count();
  console.log("first login, tutorial auto-opened?", open ? "YES" : "no");
  chk(open===0,"the tutorial still opens itself on first login");
  // ...but the button must still work.
  await p.locator("#btnTutorial").click(); await p.waitForTimeout(400);
  const afterClick=await p.locator("#tutModal.show").count();
  console.log("tutorial opens from the button?", afterClick ? "yes" : "NO");
  chk(afterClick===1,"the ? Tutorial button no longer opens the tutorial");
  chk(errs.length===0,"page errors: "+errs.join(" | "));
  await p.close();
}

// --- 2. The badge must reach "Live" even though every COLLECTION answers from cache.
{
  const {p,errs}=await boot();
  const txt=(await p.locator("#syncTxt").innerText()).trim();
  const cls=await p.locator("#syncDot").getAttribute("class");
  console.log(`badge with collections cache-only: ${JSON.stringify(txt)}  class=${JSON.stringify(cls)}`);
  chk(/^Live/.test(txt), `badge stuck on ${JSON.stringify(txt)} — should read Live`);
  chk((cls||"").includes("live"), "badge dot is not in the live state");
  chk(errs.length===0,"page errors: "+errs.join(" | "));
  await p.close();
}

// --- 3. Genuinely offline must still say "Saved data" — the fix must not force Live.
{
  const {p,errs}=await boot({offline:true});
  const txt=(await p.locator("#syncTxt").innerText()).trim();
  const cls=await p.locator("#syncDot").getAttribute("class");
  console.log(`badge when the probe stays on cache: ${JSON.stringify(txt)}  class=${JSON.stringify(cls)}`);
  chk(txt==="Saved data", `offline badge reads ${JSON.stringify(txt)} — should be "Saved data"`);
  chk((cls||"").includes("cache"), "badge dot is not in the cache state");
  chk(errs.length===0,"page errors: "+errs.join(" | "));
  await p.close();
}

await b.close(); server.close();
console.log("\n"+"=".repeat(58));
if(fails.length){ console.log("FAILURES:"); fails.forEach(f=>console.log("  -",f)); process.exit(1); }
console.log("badge + tutorial checks passed");
