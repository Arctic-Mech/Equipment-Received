/* Look-Ahead — the standalone 3-week lookahead page, modeled on Arctic's paper form.

   Serves the real repo (serve.mjs injects the firebase stub import map into every .html).
   Seeds the la* collections through window.__SEED and drives the page as each role sees it.
   Roles live on the person's record (laRole/laTrade); PM + Superintendent are one "management". */
import { chromium } from "playwright";
import fs from "node:fs"; import path from "node:path";
import { startServer, routeCdn, CHROMIUM, TESTS_DIR } from "./serve.mjs";

const { server, port: PORT } = await startServer();
const fails=[]; const chk=(c,m)=>{ if(!c) fails.push(m); };
const b=await chromium.launch({executablePath:CHROMIUM,args:["--no-sandbox"]});

function isoD(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
function mondayOf(d){ const x=new Date(d); const off=(x.getDay()+6)%7; x.setDate(x.getDate()-off); x.setHours(0,0,0,0); return x; }
const CUR=isoD(mondayOf(new Date()));
const wk=id=>`${id}__${CUR}`;
const days=(...pairs)=>{ const a=new Array(21).fill(0); pairs.forEach(([i,v])=>a[i]=v); return a; };

function seed(){
  return {
    people:{
      "p-jaren-eells":{first:"Jaren",last:"Eells",email:"jareneells@arctic.biz",laRole:"foreman",laTrade:"sheet"},
      "p-mgr":{first:"Morgan",last:"Reed",email:"morgan@arctic.biz",laRole:"management"},
      "p-nobody":{first:"No",last:"Body",email:"nobody@arctic.biz"},
    },
    laJobs:{
      "25-0150":{jobNumber:"25-0150",jobName:"Riverside Medical",foremen:[{id:"p-jaren-eells",name:"Jaren Eells",trade:"sheet"}]},
    },
    // The main app's equipment data — job numbers + names Look-Ahead should pull from.
    arrivals:{ a1:{jobNumber:"26-0147",jobName:"Adventist Health",dateReceived:"2026-01-02"} },
    laWeeks:{
      [wk("p-jaren-eells")]:{foremanId:"p-jaren-eells",foremanName:"Jaren Eells",trade:"sheet",weekStart:CUR,
        tasks:[
          {id:"t1",job:"25-0150",text:"Hang duct mains",days:days([0,2],[1,2],[2,2],[3,2])},   // 2 men Mon–Thu wk1
          {id:"t2",job:"25-0150",text:"Set VAV boxes",  days:days([7,3],[8,3],[9,3])},          // 3 men Mon–Wed wk2
        ],
        reqs:{labor:"2 mechanics steady",co:"RFI 214 pending"}, dateCompleted:""},
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
const JAREN ={first:"Jaren",last:"Eells",email:"jareneells@arctic.biz",id:"p-jaren-eells"};
const MGR   ={first:"Morgan",last:"Reed",email:"morgan@arctic.biz",id:"p-mgr"};
const NOBODY={first:"No",last:"Body",email:"nobody@arctic.biz",id:"p-nobody"};

// --- 1. No role -> the access message, never a stuck spinner. ---
{
  const {p,errs}=await boot(NOBODY);
  chk(await p.locator(".la-skel").count()===0,"page stuck on the loading skeleton for a no-access user");
  const notice=(await p.locator(".la-notice").innerText().catch(()=>"")).trim();
  console.log("no-role notice:", JSON.stringify(notice));
  chk(notice.includes("You need Look-Ahead access set up to use this"),`no-access message wrong: ${JSON.stringify(notice)}`);
  chk(!/bobby/i.test(notice),"no-access message must not name Bobby");
  chk(errs.length===0,"page errors: "+errs.join(" | "));
  await p.close();
}

// --- 2. Foreman sees their day-by-day manpower sheet and can edit it. ---
{
  const {p,errs}=await boot(JAREN);
  const nav0=(await p.locator("#laNav button").first().innerText()).trim();
  chk(nav0==="My Look-Ahead",`foreman's first tab should be "My Look-Ahead", got ${JSON.stringify(nav0)}`);
  chk(await p.locator(".la-tcard").count()>=2,"task cards missing");
  // each task is a card; the seeded task text lives in its row field
  chk(await p.locator('[data-rowtext="t1"]').inputValue()==="Hang duct mains","seeded task not shown in its card");
  chk(await p.locator("[data-rowjob]").count()===2,"expected 2 seeded task cards");
  // 21 day inputs for task t1 (Mon–Sun x3, laid out as 3 week rows of 7)
  chk(await p.locator('[data-mp^="t1|"]').count()===21,"task should have 21 day boxes (3 weeks x 7)");
  // the six requirement boxes
  chk(await p.locator(".la-reqs textarea").count()===6,"the six requirement boxes are missing");

  // edit a manpower cell: change the first day of task 1 from 2 to 5
  const cell=p.locator('[data-mp="t1|0"]');
  chk(await cell.count()===1,"editable day cell missing");
  await cell.fill("5"); await cell.press("Tab"); await p.waitForTimeout(350);
  const mpWrote=await p.evaluate(()=> (window.__WRITES||[]).some(w=>w.op==="set"&&w.coll==="laWeeks"
     && (w.data.tasks||[]).some(t=>t.id==="t1" && Array.isArray(t.days) && t.days[0]===5)));
  chk(mpWrote,"editing a day's crew count did not save");

  // add a blank row, then type a known job number — the project name fills in and the job is saved
  await p.locator("#laAddRow").click(); await p.waitForTimeout(350);
  chk(await p.locator("[data-rowjob]").count()===3,"Add row did not add a row");
  const newId=await p.locator("[data-rowjob]").last().getAttribute("data-rowjob");
  const jobField=p.locator(`[data-rowjob="${newId}"]`);
  await jobField.fill("25-0150"); await jobField.press("Tab"); await p.waitForTimeout(350);
  const nameVal=await p.locator(`[data-rowname="${newId}"]`).inputValue();
  chk(nameVal==="Riverside Medical",`typing a known job number did not fill the project name (got ${JSON.stringify(nameVal)})`);
  const jobWrote=await p.evaluate(()=> (window.__WRITES||[]).some(w=>w.op==="set"&&w.coll==="laJobs"&&w.id==="25-0150"));
  chk(jobWrote,"typing a job number into a row did not save the job");

  // a job known only from the equipment-received data (arrivals) fills its name too
  await p.locator("#laAddRow").click(); await p.waitForTimeout(350);
  const id2=await p.locator("[data-rowjob]").last().getAttribute("data-rowjob");
  const jf2=p.locator(`[data-rowjob="${id2}"]`);
  await jf2.fill("26-0147"); await jf2.press("Tab"); await p.waitForTimeout(350);
  chk(await p.locator(`[data-rowname="${id2}"]`).inputValue()==="Adventist Health",
    "job name did not populate from the equipment-received data");

  // the foreman can enter a PM for a job — saved on the job record
  const pmInput=p.locator('[data-pmjob="25-0150"]');
  chk(await pmInput.count()>=1,"no PM entry field for the job");
  await pmInput.fill("Dana Fox"); await pmInput.press("Tab"); await p.waitForTimeout(350);
  const pmWrote=await p.evaluate(()=> (window.__WRITES||[]).some(w=>w.op==="set"&&w.coll==="laJobs"&&w.id==="25-0150"
     && Array.isArray(w.data.pms) && w.data.pms.includes("Dana Fox")));
  chk(pmWrote,"entering a PM for a job did not save");

  // mark the week done
  await p.locator("#laMarkDone").click(); await p.waitForTimeout(300);
  const doneWrote=await p.evaluate(()=> (window.__WRITES||[]).some(w=>w.op==="set"&&w.coll==="laWeeks"&&w.data.dateCompleted));
  chk(doneWrote,"Mark done did not save a completion date");
  chk(errs.length===0,"page errors: "+errs.join(" | "));
  await p.close();
}

// --- 3. Management VIEWS a foreman's sheet (read-only) and can pin a foreman to the top. ---
{
  const {p,errs}=await boot(MGR);
  const nav0=(await p.locator("#laNav button").first().innerText()).trim();
  chk(nav0==="Foremen",`management's first tab should be "Foremen", got ${JSON.stringify(nav0)}`);
  chk(await p.locator('[data-laopenforeman="p-jaren-eells"]').count()===1,"foreman not listed for management");
  // favorite (pin) the foreman -> saved on the manager's own record
  await p.locator('[data-lafavforeman="p-jaren-eells"]').click(); await p.waitForTimeout(300);
  const favWrote=await p.evaluate(()=> (window.__WRITES||[]).some(w=>w.op==="set"&&w.coll==="people"&&w.id==="p-mgr"
     && Array.isArray(w.data.laFavForemen) && w.data.laFavForemen.includes("p-jaren-eells")));
  chk(favWrote,"pinning a foreman did not save");
  // open the foreman's sheet — must be view only
  await p.locator('[data-laopenforeman="p-jaren-eells"]').click(); await p.waitForTimeout(350);
  chk(await p.locator("#laBack").count()===1,"no back button on the opened foreman sheet");
  chk(await p.locator(".la-tcard").count()>=1,"foreman's sheet not shown to management");
  chk(await p.locator(".la-tcard .tc-txt", {hasText:"Hang duct mains"}).count()>=1,"task not shown in the read-only sheet");
  chk(await p.locator("[data-mp]").count()===0,"management view must be read-only — no editable day cells");
  chk(await p.locator("#laAddRow").count()===0,"management must not see Add row");
  chk(errs.length===0,"page errors: "+errs.join(" | "));
  await p.close();
}

// --- 4. Management labor roll-up, sortable by trade. ---
{
  const {p,errs}=await boot(MGR);
  await p.locator('#laNav button', {hasText:"Labor"}).click(); await p.waitForTimeout(300);
  chk(await p.locator("table.la-table").count()===1,"labor roll-up table missing");
  const body=await p.locator("table.la-table").innerText();
  chk(/25-0150/.test(body),"labor table missing the job");
  chk(/\b2\b/.test(body) && /\b3\b/.test(body),"labor table missing the weekly peak crews (2 and 3)");
  // sort by trade still renders
  await p.locator('[data-lasort="trade"]').click(); await p.waitForTimeout(250);
  chk(await p.locator("table.la-table").count()===1,"labor table gone after sorting by trade");
  chk(errs.length===0,"page errors: "+errs.join(" | "));
  await p.close();
}

// --- 5. Jobs tab: per-job 3-week lookahead, pinnable, no delete. ---
{
  const {p,errs}=await boot(MGR);
  await p.locator('#laNav button', {hasText:"Jobs"}).click(); await p.waitForTimeout(300);
  chk(await p.locator("[data-lajobdel]").count()===0,"management should not be able to delete jobs");
  chk(await p.locator('[data-laopenjob="25-0150"]').count()===1,"job not listed on the Jobs tab");
  // pin a job
  await p.locator('[data-lafavjob="25-0150"]').click(); await p.waitForTimeout(300);
  const favJob=await p.evaluate(()=> (window.__WRITES||[]).some(w=>w.op==="set"&&w.coll==="people"&&w.id==="p-mgr"
     && Array.isArray(w.data.laFavJobs) && w.data.laFavJobs.includes("25-0150")));
  chk(favJob,"pinning a job did not save");
  // open the job's combined 3-week lookahead
  await p.locator('[data-laopenjob="25-0150"]').click(); await p.waitForTimeout(350);
  chk(await p.locator("#laBackJob").count()===1,"no back button on the per-job sheet");
  chk(await p.locator(".la-tcard").count()>=1,"per-job sheet missing");
  chk(/Hang duct mains|Set VAV/.test(await p.locator("#laMain").innerText()),"per-job sheet missing the job's tasks");
  chk(errs.length===0,"page errors: "+errs.join(" | "));
  await p.close();
}

// --- 6. Roles are assigned from the MAIN APP's admin (Manage People), with Foreman + Management only. ---
{
  const SEED=JSON.parse(fs.readFileSync(path.join(TESTS_DIR,"seed.json"),"utf8"));
  const p=await b.newPage({viewport:{width:420,height:900}});
  const errs=[];
  p.on("pageerror",e=>errs.push("pageerror: "+e.message));
  p.on("console",m=>{const t=m.text(); if(m.type()==="error" && !/net::ERR_|Failed to load resource/.test(t)) errs.push("console: "+t);});
  await routeCdn(p);
  await p.addInitScript(sd=>{ window.__SEED=sd;
    localStorage.setItem("er_user",JSON.stringify({first:"Jaren",last:"Eells",email:"jareneells@arctic.biz",id:"p-jaren-eells"}));
    localStorage.setItem("tut_done","1"); },SEED);
  await p.goto(`http://localhost:${PORT}/`,{waitUntil:"networkidle"});
  await p.waitForTimeout(500);
  await p.locator("#btnAdminOpen").click(); await p.waitForTimeout(200);
  await p.locator("#pinInput").fill("1977"); await p.waitForTimeout(400);
  await p.locator("#btnPeople").click(); await p.waitForTimeout(400);
  chk(await p.locator("#peopleList", {hasText:"Look-Ahead"}).count()>=1,"main admin Manage People has no Look-Ahead controls");
  const someone=await p.locator("#peopleList [data-popen]").first().getAttribute("data-popen");
  await p.locator(`[data-popen="${someone}"]`).click(); await p.waitForTimeout(250);
  // Management option exists (PM/Superintendent were merged away)
  chk(await p.locator(`[data-larole="${someone}|||management"]`).count()===1,"Management role option missing in admin");
  await p.locator(`[data-larole="${someone}|||foreman"]`).click(); await p.waitForTimeout(350);
  const roleWrote=await p.evaluate(id=> (window.__WRITES||[]).some(w=>w.op==="set"&&w.coll==="people"&&w.id===id&&w.data.laRole==="foreman"),someone);
  chk(roleWrote,"assigning a Look-Ahead role from the admin did not save to the person's record");
  chk(await p.locator("#laSampleLoad").count()===1,"Look-Ahead sample load/remove is not in the main admin");
  chk(errs.length===0,"page errors: "+errs.join(" | "));
  await p.close();
}

await b.close(); server.close();
console.log("\n"+"=".repeat(58));
if(fails.length){ console.log("FAILURES:"); fails.forEach(f=>console.log("  -",f)); process.exit(1); }
console.log("PASS  lookahead");
