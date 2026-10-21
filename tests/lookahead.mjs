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
  chk(await p.locator("table.la-mp").count()===1,"the manpower grid is missing");
  chk(await p.locator(".la-mp .tc-txt", {hasText:"Hang duct mains"}).count()===1,"seeded task not shown in the grid");
  // 21 day columns in the header
  chk(await p.locator(".la-mp thead .dh").count()===21,"grid should have 21 day columns (Mon–Sun x3)");
  // the six requirement boxes
  chk(await p.locator(".la-reqs textarea").count()===6,"the six requirement boxes are missing");

  // edit a manpower cell: change the first day of task 1 from 2 to 5
  const cell=p.locator('[data-mp="t1|0"]');
  chk(await cell.count()===1,"editable day cell missing");
  await cell.fill("5"); await cell.press("Tab"); await p.waitForTimeout(350);
  const mpWrote=await p.evaluate(()=> (window.__WRITES||[]).some(w=>w.op==="set"&&w.coll==="laWeeks"
     && (w.data.tasks||[]).some(t=>t.id==="t1" && Array.isArray(t.days) && t.days[0]===5)));
  chk(mpWrote,"editing a day's crew count did not save");

  // add a task
  await p.locator("#laAddTask").click(); await p.waitForTimeout(250);
  await p.locator("#tkText").fill("Pull permits for riser"); await p.locator("#tkSave").click(); await p.waitForTimeout(350);
  chk(await p.locator(".la-mp .tc-txt", {hasText:"Pull permits for riser"}).count()===1,"new task did not appear in the grid");

  // mark the week done
  await p.locator("#laMarkDone").click(); await p.waitForTimeout(300);
  const doneWrote=await p.evaluate(()=> (window.__WRITES||[]).some(w=>w.op==="set"&&w.coll==="laWeeks"&&w.data.dateCompleted));
  chk(doneWrote,"Mark done did not save a completion date");
  chk(errs.length===0,"page errors: "+errs.join(" | "));
  await p.close();
}

// --- 3. Management sees every foreman and can adjust what they entered. ---
{
  const {p,errs}=await boot(MGR);
  const nav0=(await p.locator("#laNav button").first().innerText()).trim();
  chk(nav0==="Foremen",`management's first tab should be "Foremen", got ${JSON.stringify(nav0)}`);
  chk(await p.locator('[data-laopenforeman="p-jaren-eells"]').count()===1,"foreman not listed for management");
  // open the foreman's sheet and edit a cell
  await p.locator('[data-laopenforeman="p-jaren-eells"]').click(); await p.waitForTimeout(350);
  chk(await p.locator("#laBack").count()===1,"no back button on the opened foreman sheet");
  chk(await p.locator("table.la-mp").count()===1,"foreman's grid not shown to management");
  const cell=p.locator('[data-mp="t1|1"]');
  await cell.fill("7"); await cell.press("Tab"); await p.waitForTimeout(350);
  const adj=await p.evaluate(cur=> (window.__WRITES||[]).some(w=>w.op==="set"&&w.coll==="laWeeks"&&w.id===("p-jaren-eells__"+cur)
     && (w.data.tasks||[]).some(t=>t.id==="t1"&&t.days[1]===7)),CUR);
  chk(adj,"management's adjustment to a foreman's grid did not save to that foreman's week");
  chk(errs.length===0,"page errors: "+errs.join(" | "));
  await p.close();
}

// --- 4. Management labor roll-up. ---
{
  const {p,errs}=await boot(MGR);
  await p.locator('#laNav button', {hasText:"Labor"}).click(); await p.waitForTimeout(300);
  chk(await p.locator("table.la-table").count()===1,"labor roll-up table missing");
  const body=await p.locator("table.la-table").innerText();
  chk(/25-0150/.test(body),"labor table missing the job");
  chk(/\b2\b/.test(body) && /\b3\b/.test(body),"labor table missing the weekly peak crews (2 and 3)");
  chk(errs.length===0,"page errors: "+errs.join(" | "));
  await p.close();
}

// --- 5. Deleting a job that isn't yours needs the PIN. ---
{
  const {p,errs}=await boot(MGR);
  await p.locator('#laNav button', {hasText:"Jobs"}).click(); await p.waitForTimeout(300);
  await p.locator('[data-lajobdel]').first().click(); await p.waitForTimeout(250);
  const title=(await p.locator("#laModalTitle").innerText().catch(()=>"")).trim();
  chk(/Enter PIN to delete/i.test(title),"deleting another's job did not require the PIN");
  await p.locator("#laPin").fill("0000"); await p.locator("#laPinGo").click(); await p.waitForTimeout(200);
  const delWrote=await p.evaluate(()=> (window.__WRITES||[]).some(w=>w.op==="del" && w.coll==="laJobs"));
  chk(!delWrote,"a wrong PIN still deleted the job");
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
