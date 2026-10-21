/* Look-Ahead — the standalone 3-week lookahead page (lookahead.html + lookahead.js).

   Serves the real repo (serve.mjs injects the firebase stub import map into every .html, so
   lookahead.html gets it too). Seeds the la* collections through window.__SEED and drives the
   page as each role would see it. The week math has to line up with the module, so the current
   Monday is computed here exactly the way lookahead.js computes it. */
import { chromium } from "playwright";
import fs from "node:fs"; import path from "node:path";
import { startServer, routeCdn, CHROMIUM, TESTS_DIR } from "./serve.mjs";

const { server, port: PORT } = await startServer();
const fails=[]; const chk=(c,m)=>{ if(!c) fails.push(m); };
const b=await chromium.launch({executablePath:CHROMIUM,args:["--no-sandbox"]});

/* same Mon–Sun week start the module derives */
function isoD(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
function mondayOf(d){ const x=new Date(d); const off=(x.getDay()+6)%7; x.setDate(x.getDate()-off); x.setHours(0,0,0,0); return x; }
const CUR=isoD(mondayOf(new Date()));
const wk=(id)=>`${id}__${CUR}`;

function seed(){
  return {
    // Look-Ahead roles live on the person's record (laRole/laTrade), set from the main app's admin.
    people:{
      "p-jaren-eells":{first:"Jaren",last:"Eells",email:"jareneells@arctic.biz",laRole:"foreman",laTrade:"sheet"},
      "p-dana-fox":{first:"Dana",last:"Fox",email:"danafox@arctic.biz",laRole:"pm"},
      "p-sam-odell":{first:"Sam",last:"Odell",email:"samodell@arctic.biz",laRole:"super"},
      "p-nobody":{first:"No",last:"Body",email:"nobody@arctic.biz"},
    },
    laJobs:{
      "25-0150":{jobNumber:"25-0150",jobName:"Riverside Medical",
        pms:[{id:"p-dana-fox",name:"Dana Fox"}],
        foremen:[{id:"p-jaren-eells",name:"Jaren Eells",trade:"sheet"}]},
    },
    laWeeks:{
      [wk("p-jaren-eells")]:{foremanId:"p-jaren-eells",foremanName:"Jaren Eells",trade:"sheet",weekStart:CUR,
        tasks:[
          {id:"t1",job:"25-0150",week:1,text:"Hang duct mains",headcount:4},
          {id:"t2",job:"25-0150",week:2,text:"Set VAV boxes",headcount:3},
        ],
        conflicts:[
          {id:"c1",scope:"current",job:"25-0150",type:"GC",what:"GC overhead work blocked our bay",
           where:"Level 3 east",when:"Tue",impMan:true,impHours:true,impProd:false,impSched:true,hours:16,days:1,resolved:false,pmStatus:""},
          {id:"c2",scope:"upcoming",job:"25-0150",type:"Design / RFI",what:"Ceiling height conflict at column line D",
           where:"Area D",when:"Week 2",need:"RFI 214 answered",resolved:false,pmStatus:""},
        ]},
    },
    laMeta:{ seed:{seeded:true,removed:false} },   // disable auto-seed in tests
  };
}

async function boot(user){
  const p=await b.newPage({viewport:{width:420,height:900}});
  const errs=[];
  p.on("pageerror",e=>errs.push("pageerror: "+e.message));
  p.on("console",m=>{const t=m.text(); if(m.type()==="error" && !/net::ERR_|Failed to load resource/.test(t)) errs.push("console: "+t);});
  await routeCdn(p);
  await p.addInitScript(([s,u])=>{ window.__SEED=s; localStorage.setItem("er_user",JSON.stringify(u)); },[seed(),user]);
  await p.goto(`http://localhost:${PORT}/lookahead.html`,{waitUntil:"networkidle"});
  await p.waitForTimeout(700);
  return {p,errs};
}
const JAREN={first:"Jaren",last:"Eells",email:"jareneells@arctic.biz",id:"p-jaren-eells"};
const DANA ={first:"Dana",last:"Fox",email:"danafox@arctic.biz",id:"p-dana-fox"};
const SAM  ={first:"Sam",last:"Odell",email:"samodell@arctic.biz",id:"p-sam-odell"};
const NOBODY={first:"No",last:"Body",email:"nobody@arctic.biz",id:"p-nobody"};

// --- 1. A signed-in person with no role gets the exact no-access message, not a stuck spinner. ---
{
  const {p,errs}=await boot(NOBODY);
  // The skeleton must be gone — the page must resolve to the access message, never hang loading.
  const skel=await p.locator(".la-skel").count();
  chk(skel===0,"page stuck on the loading skeleton for a no-access user");
  const notice=(await p.locator(".la-notice").innerText().catch(()=>"")).trim();
  console.log("no-role notice:", JSON.stringify(notice));
  chk(notice.includes("You need Look-Ahead access set up to use this"),
    `no-access message wrong: ${JSON.stringify(notice)}`);
  // It must NOT name Bobby or tell them to ask him.
  chk(!/bobby/i.test(notice),"no-access message must not name Bobby");
  chk(errs.length===0,"page errors: "+errs.join(" | "));
  await p.close();
}

// --- 2. Foreman sees their own single weekly lookahead: jobs, 3 weeks, tasks, CO flag. ---
{
  const {p,errs}=await boot(JAREN);
  const nav0=(await p.locator("#laNav button").first().innerText()).trim();
  console.log("foreman first tab:", JSON.stringify(nav0));
  chk(nav0==="My Look-Ahead",`foreman's first tab should be "My Look-Ahead", got ${JSON.stringify(nav0)}`);

  const chipTxt=await p.locator(".la-chip").first().innerText().catch(()=>"");
  chk(/25-0150/.test(chipTxt),"foreman's job chip (25-0150) missing");

  const weeks=await p.locator(".la-week").count();
  chk(weeks===3,`expected 3 week columns, got ${weeks}`);

  const task=await p.locator(".la-task .t-text", {hasText:"Hang duct mains"}).count();
  chk(task===1,"seeded Week-1 task not shown");

  // A conflict that cost manpower/hours/schedule is auto-flagged a possible change order.
  const co=await p.locator(".la-badge.co", {hasText:"possible change order"}).count();
  chk(co>=1,"conflict with impact was not flagged as a possible change order");

  // Add a task and confirm it round-trips (write recorded + shows in the week column).
  await p.locator('[data-lataskadd="1"]').click();
  await p.waitForTimeout(250);
  await p.locator("#tkText").fill("Pull permits for riser");
  await p.locator("#tkMen").fill("2");
  await p.locator("#tkSave").click();
  await p.waitForTimeout(350);
  const added=await p.locator(".la-task .t-text", {hasText:"Pull permits for riser"}).count();
  chk(added===1,"newly added task did not appear in the lookahead");
  const wrote=await p.evaluate(()=> (window.__WRITES||[]).some(w=>w.op==="set" && w.coll==="laWeeks"
     && (w.data.tasks||[]).some(t=>t.text==="Pull permits for riser")));
  chk(wrote,"adding a task did not write to laWeeks");
  chk(errs.length===0,"page errors: "+errs.join(" | "));
  await p.close();
}

// --- 3. PM sees conflicts on their jobs and can triage toward a change order. ---
{
  const {p,errs}=await boot(DANA);
  const hasConf=await p.locator('#laNav button', {hasText:"Conflicts"}).count();
  chk(hasConf===1,"PM has no Conflicts tab");
  // default view is Conflicts
  const conf=await p.locator(".la-conf").count();
  chk(conf>=1,"PM sees no conflicts for their own job");
  const co=await p.locator(".la-badge.co", {hasText:"possible change order"}).count();
  chk(co>=1,"PM view missing the possible-change-order flag");
  const triage=await p.locator('[data-lapmtag]').count();
  chk(triage>=1,"PM has no triage buttons");
  // tag one as a change order → it writes back to the foreman's week doc
  await p.locator('[data-lapmtag*="|co"]').first().click();
  await p.waitForTimeout(300);
  const wrote=await p.evaluate(()=> (window.__WRITES||[]).some(w=>w.op==="set" && w.coll==="laWeeks"
     && (w.data.conflicts||[]).some(c=>c.pmStatus==="co")));
  chk(wrote,"PM triage did not persist pmStatus");
  chk(errs.length===0,"page errors: "+errs.join(" | "));
  await p.close();
}

// --- 4. Superintendent gets the labor roll-up by job × week. ---
{
  const {p,errs}=await boot(SAM);
  const nav0=(await p.locator("#laNav button").first().innerText()).trim();
  chk(nav0==="Labor Needs",`super's first tab should be "Labor Needs", got ${JSON.stringify(nav0)}`);
  const table=await p.locator("table.la-table").count();
  chk(table===1,"labor roll-up table missing");
  const body=await p.locator("table.la-table").innerText();
  chk(/25-0150/.test(body),"labor table missing the job");
  chk(/\b4\b/.test(body),"labor table missing the Week-1 headcount (4)");
  chk(errs.length===0,"page errors: "+errs.join(" | "));
  await p.close();
}

// --- 5. Deleting something that isn't yours demands the PIN. ---
{
  const {p,errs}=await boot(SAM);
  await p.locator('#laNav button', {hasText:"Jobs"}).click();
  await p.waitForTimeout(300);
  await p.locator('[data-lajobdel]').first().click();
  await p.waitForTimeout(250);
  const title=(await p.locator("#laModalTitle").innerText().catch(()=>"")).trim();
  console.log("delete-guard modal title:", JSON.stringify(title));
  chk(/Enter PIN to delete/i.test(title),"deleting another's job did not require the PIN");
  // wrong PIN is refused, no delete write
  await p.locator("#laPin").fill("0000");
  await p.locator("#laPinGo").click();
  await p.waitForTimeout(200);
  const delWrote=await p.evaluate(()=> (window.__WRITES||[]).some(w=>w.op==="del" && w.coll==="laJobs"));
  chk(!delWrote,"a wrong PIN still deleted the job");
  chk(errs.length===0,"page errors: "+errs.join(" | "));
  await p.close();
}

// --- 6. Roles are assigned from the MAIN APP's admin (Manage People), not a Look-Ahead settings tab. ---
{
  const SEED=JSON.parse(fs.readFileSync(path.join(TESTS_DIR,"seed.json"),"utf8"));
  const p=await b.newPage({viewport:{width:420,height:900}});
  const errs=[];
  p.on("pageerror",e=>errs.push("pageerror: "+e.message));
  p.on("console",m=>{const t=m.text(); if(m.type()==="error" && !/net::ERR_|Failed to load resource/.test(t)) errs.push("console: "+t);});
  await routeCdn(p);
  await p.addInitScript(seed=>{ window.__SEED=seed;
    localStorage.setItem("er_user",JSON.stringify({first:"Jaren",last:"Eells",email:"jareneells@arctic.biz",id:"p-jaren-eells"}));
    localStorage.setItem("tut_done","1"); },SEED);
  await p.goto(`http://localhost:${PORT}/`,{waitUntil:"networkidle"});
  await p.waitForTimeout(500);
  // unlock admin with the PIN, open Manage People
  await p.locator("#btnAdminOpen").click(); await p.waitForTimeout(200);
  await p.locator("#pinInput").fill("1977"); await p.waitForTimeout(400);
  await p.locator("#btnPeople").click(); await p.waitForTimeout(400);
  // the Look-Ahead controls must live here in the main admin
  const laLbl=await p.locator("#peopleList", {hasText:"Look-Ahead"}).count();
  chk(laLbl>=1,"main admin Manage People has no Look-Ahead controls");
  // expand a person and make them a Foreman
  const someone=await p.locator("#peopleList [data-popen]").first().getAttribute("data-popen");
  await p.locator(`[data-popen="${someone}"]`).click(); await p.waitForTimeout(250);
  await p.locator(`[data-larole="${someone}|||foreman"]`).click(); await p.waitForTimeout(350);
  const roleWrote=await p.evaluate(id=> (window.__WRITES||[]).some(w=>w.op==="set" && w.coll==="people" && w.id===id && w.data.laRole==="foreman"),someone);
  chk(roleWrote,"assigning a Look-Ahead role from the admin did not save to the person's record");
  // the sample-data load/remove also lives in the main admin
  const sample=await p.locator("#laSampleLoad").count();
  chk(sample===1,"Look-Ahead sample load/remove is not in the main admin");
  chk(errs.length===0,"page errors: "+errs.join(" | "));
  await p.close();
}

await b.close(); server.close();
console.log("\n"+"=".repeat(58));
if(fails.length){ console.log("FAILURES:"); fails.forEach(f=>console.log("  -",f)); process.exit(1); }
console.log("PASS  lookahead");
