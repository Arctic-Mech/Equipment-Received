/* ============================================================================
   Look-Ahead — a standalone 3-week lookahead app, modeled on Arctic's own
   "3 Week Look Ahead" spreadsheet.

   Independent of the main equipment/safety app: its own page, its own Firestore
   collections (all prefixed `la`), its own styles. It reuses only the shared
   Firebase project + the signed-in identity (er_user).

   Model:
     - One lookahead PER FOREMAN per week. Each task is tagged to a job, and
       carries a crew count for each of the 21 days (Mon–Sun × 3 weeks), exactly
       like the paper form. Daily totals roll up at the bottom.
     - Six requirement boxes match the form: Labor, Fabrication/Detailing,
       Special Inspections/Permits/Tools, Sub Coordination, Material/Delivery,
       and Change Order Approval.
     - Weeks run Mon–Sun; the current week rolls forward each week.
   Roles (set in the main app's Admin → Manage People → Look-Ahead, stored on the
   person's record): FOREMAN (fills their own), MANAGEMENT (sees every foreman
   and can adjust what they entered, plus the labor roll-up). Visibility is soft.
============================================================================ */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
         collection, onSnapshot, doc, setDoc, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { esc, normJob, isRealJob, MON } from "./format.js";
import { LA_TRADES as TRADES, seedSampleCompany } from "./lookahead-data.js";

const DAY_LBL = ["M","T","W","T","F","S","S"];
// The six requirement/notes boxes from the paper form, in order.
const REQS = [["labor","Labor Requirements"],["fab","Fabrication / Detailing"],
  ["special","Special Inspections, Permits, Tools or Equipment"],["sub","Sub Coordination"],
  ["material","Material or Delivery Requirements"],["co","Change Order Approval"]];

/* ---------- tiny DOM helpers ---------- */
const $ = id => document.getElementById(id);
function toast(msg){ const h=$("laToastHost"); if(!h) return; const d=document.createElement("div"); d.textContent=msg;
  h.appendChild(d); setTimeout(()=>d.remove(), 2600); }
const rid = () => "x"+Math.random().toString(36).slice(2,9);

/* ---------- Firebase (same config + offline cache + dead-client recovery as the main app) ---------- */
const firebaseConfig={apiKey:"AIzaSyBwf2lyLcJWz8qfuEHn76-tIbOm117Tltg",authDomain:"equipment-received.firebaseapp.com",projectId:"equipment-received",storageBucket:"equipment-received.firebasestorage.app",messagingSenderId:"164676400073",appId:"1:164676400073:web:552cc0e3dcc8e06951ae18"};
let db=null, fbReady=false;
try{
  const app=initializeApp(firebaseConfig);
  try{ db=initializeFirestore(app,{localCache:persistentLocalCache({tabManager:persistentMultipleTabManager()})}); }
  catch(e){ db=getFirestore(app); }
  fbReady=true;
}catch(e){ console.error("FB",e); }

let fbDead=false;
const DEAD_RE=/terminated|failed-precondition|INTERNAL ASSERTION|persistence/i;
function fbIsDead(e){ return !!e && (e.code==="failed-precondition" || DEAD_RE.test(String(e.message||e.code||e))); }
function fbNote(e,where){ console.error("firestore",where||"",e);
  if(fbDead||!fbIsDead(e)) return; fbDead=true;
  const bar=document.createElement("div"); bar.className="fb-dead";
  bar.innerHTML=`<span>The connection to the database stopped. Nothing you saved is lost — it just can't reach the server until this page is reloaded.</span>`;
  const b=document.createElement("button"); b.textContent="Reload now"; b.onclick=()=>location.reload();
  bar.appendChild(b); document.body.appendChild(bar);
}
function saveMsg(e){ if(fbIsDead(e)) return "the database connection dropped — reload and try again";
  if(e&&e.code==="permission-denied") return "you don't have permission to change that";
  if(e&&e.code==="unavailable") return "no connection right now — it'll save when you're back online";
  return (e&&(e.code||e.message))||String(e); }

/* ---------- identity (shared with the main app via er_user) ---------- */
function loadUser(){ try{ const n=JSON.parse(localStorage.getItem("er_user")||localStorage.getItem("er_name")||"null"); return (n&&n.first)?n:null; }catch(e){ return null; } }
let USER=loadUser();
const nameNorm=(f,l)=>(String(f||"")+" "+String(l||"")).toLowerCase().replace(/[^a-z0-9 ]/g,"").replace(/\s+/g," ").trim();
const personId=(f,l)=>{ const s=nameNorm(f,l).replace(/ /g,"-"); return "p-"+(s||Math.random().toString(36).slice(2)); };

/* ---------- week + day math (Mon–Sun) ---------- */
function isoD(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
function mondayOf(d){ const x=new Date(d); const off=(x.getDay()+6)%7; x.setDate(x.getDate()-off); x.setHours(0,0,0,0); return x; }
function addDays(iso,n){ const d=new Date(iso+"T00:00:00"); d.setDate(d.getDate()+n); return isoD(d); }
const CUR_WEEK = isoD(mondayOf(new Date()));
const weekStartN = n => addDays(CUR_WEEK, n*7);                 // n = 0,1,2
const dayIso = i => addDays(CUR_WEEK, i);                       // i = 0..20
function weekRangeLabel(monIso){ const m=new Date(monIso+"T00:00:00"), s=new Date(m); s.setDate(s.getDate()+6);
  const f=d=>MON[d.getMonth()]+" "+d.getDate(); return f(m)+" – "+f(s); }
function dayDM(i){ const d=new Date(dayIso(i)+"T00:00:00"); return (d.getMonth()+1)+"/"+d.getDate(); }
// Always hand back a 21-length crew-per-day array for a task.
function taskDays(t){ const a=Array.isArray(t.days)?t.days.slice(0,21):[]; while(a.length<21) a.push(0); return a.map(n=>Number(n)||0); }

/* ---------- live state ---------- */
// JOBDIR maps job number -> job name, built from the main app's equipment data (arrivals,
// rentals, tool rentals) so a job number a foreman types fills in the same name the main site shows.
let LA_JOBS=[], LA_WEEKS=[], PEOPLE=[], META={seeded:false,removed:false};
let JOBDIR={}, JOBDIR_SRC={arrivals:{},rentals:{},toolRentals:{}};
function rebuildJobDir(){ const m={}; ["arrivals","rentals","toolRentals"].forEach(k=>{
  Object.entries(JOBDIR_SRC[k]).forEach(([n,name])=>{ if(name) m[n]=name; else if(!(n in m)) m[n]=""; }); }); JOBDIR=m; }
function ingestJobs(into, snap){ const m={}; snap.forEach(d=>{ const v=d.data(); const num=normJob(v.jobNumber||"");
  if(!num || !isRealJob(num)) return; const name=(v.jobName||"").trim(); if(name) m[num]=name; else if(!(num in m)) m[num]=""; });
  JOBDIR_SRC[into]=m; rebuildJobDir(); render(); }
// All known job numbers -> names: the equipment directory plus any Look-Ahead-only jobs.
function jobDirectory(){ const m={...JOBDIR}; LA_JOBS.forEach(j=>{ if(j.jobName) m[j.jobNumber]=j.jobName; else if(!(j.jobNumber in m)) m[j.jobNumber]=""; }); return m; }
let TAB="", histWeek=null, viewForemanId=null, viewJobNumber=null, laborSort="job", seeding=false, ensuringWeek=false, peopleLoaded=false, weeksLoaded=false;
const OPEN=new Set();                              // which collapsible "other" sections are expanded
let SHEET_DOC_ID=null, SHEET_FALLBACK=null;   // the week doc currently shown as an editable sheet (+ a fallback for one not yet created)

// Roles live on the person's record in the main app (people/{id}.laRole / .laTrade).
// PM + Superintendent were merged into "management"; old records are read as management.
function myPerson(){ return (USER && PEOPLE.find(p=>p.id===USER.id)) || null; }
function roleOf(p){ const r=p&&p.laRole; return (r==="pm"||r==="super")?"management":(r||""); }
// Being named as a PM on any job is itself access to the (read-only) management view — no admin
// role needed. Matched by person id, else by name (so a name typed before someone is a member
// links up once they are), which is why naming a PM must make them see the job.
function amNamedPm(){ if(!USER) return false; return LA_JOBS.some(j=>managingJob(j.jobNumber)); }
function myRole(){ const r=roleOf(myPerson()); if(r) return r; return amNamedPm()?"management":""; }
function myTrade(){ const p=myPerson(); return p?(p.laTrade||""):""; }
function personName(id){ const p=PEOPLE.find(x=>x.id===id); return p?(p.first+" "+p.last).trim():id; }
// Favorites (management pins a job or foreman to the top of their own view). Stored on the person.
const myFavJobs = () => { const p=myPerson(); return (p&&p.laFavJobs)||[]; };
const myFavForemen = () => { const p=myPerson(); return (p&&p.laFavForemen)||[]; };
async function toggleFav(field, val){ if(!USER) return; const p=myPerson()||{}; const cur=Array.isArray(p[field])?p[field].slice():[];
  const i=cur.indexOf(val); if(i>=0) cur.splice(i,1); else cur.unshift(val);
  try{ await setDoc(doc(db,"people",USER.id),{[field]:cur,updatedAt:serverTimestamp()},{merge:true}); }catch(e){ fbNote(e,"fav"); toast("Couldn't save"); } }
const normName = s => String(s||"").toLowerCase().replace(/[^a-z0-9 ]/g,"").replace(/\s+/g," ").trim();
const myFullName = () => normName(USER?USER.first+" "+USER.last:"");
// PM name(s) the foreman assigned to a job, stored on the job record (normalized to plain names).
function pmsForJob(num){ return ((LA_JOBS.find(j=>j.jobNumber===num)||{}).pms||[]).map(pm=>typeof pm==="object"?pm.name:pm); }
// Jobs this signed-in person is the PM on (matched by their name).
function managingJob(num){ const me=myFullName(); return pmsForJob(num).some(n=>normName(n)===me); }

/* ---------- data listeners ---------- */
function startSync(){
  if(!fbReady){ peopleLoaded=true; weeksLoaded=true; render(); return; }
  // Every handler re-renders on success AND error, so a slow or denied read can never leave the
  // page stuck on the loading skeleton — it falls through to the sign-in or access message.
  onSnapshot(collection(db,"laJobs"),  s=>{ const l=[]; s.forEach(d=>l.push({id:d.id,...d.data()})); LA_JOBS=l; render(); }, e=>{ fbNote(e,"laJobs"); render(); });
  onSnapshot(collection(db,"laWeeks"), s=>{ const l=[]; s.forEach(d=>l.push({id:d.id,...d.data()})); LA_WEEKS=l; weeksLoaded=true; render(); }, e=>{ weeksLoaded=true; fbNote(e,"laWeeks"); render(); });
  onSnapshot(collection(db,"people"),  s=>{ const l=[]; s.forEach(d=>{const v=d.data(); l.push({id:d.id,first:v.first||"",last:v.last||"",email:v.email||"",laRole:v.laRole||"",laTrade:v.laTrade||"",laFavJobs:Array.isArray(v.laFavJobs)?v.laFavJobs:[],laFavForemen:Array.isArray(v.laFavForemen)?v.laFavForemen:[]});}); PEOPLE=l; peopleLoaded=true; render(); }, e=>{ peopleLoaded=true; fbNote(e,"people"); render(); });
  onSnapshot(doc(db,"laMeta","seed"), d=>{ META=d.exists()?{seeded:!!d.data().seeded,removed:!!d.data().removed}:{seeded:false,removed:false}; maybeSeed(); render(); }, e=>{ fbNote(e,"laMeta"); render(); });
  // The main app's equipment data is the source of job numbers + names.
  onSnapshot(collection(db,"arrivals"),    s=>ingestJobs("arrivals",s),    e=>fbNote(e,"arrivals"));
  onSnapshot(collection(db,"rentals"),     s=>ingestJobs("rentals",s),     e=>fbNote(e,"rentals"));
  onSnapshot(collection(db,"toolRentals"), s=>ingestJobs("toolRentals",s), e=>fbNote(e,"toolRentals"));
  setTimeout(()=>{ if(!peopleLoaded){ peopleLoaded=true; render(); } }, 4000);
}

/* ---------- week docs ---------- */
const weekDocId = (foremanId,ws) => `${foremanId}__${ws}`;
const myWeek = ws => LA_WEEKS.find(w=>w.foremanId===USER.id && w.weekStart===ws) || null;
const weekFor = (foremanId,ws) => LA_WEEKS.find(w=>w.foremanId===foremanId && w.weekStart===ws) || null;
function priorWeekFor(foremanId, before){
  return LA_WEEKS.filter(w=>w.foremanId===foremanId && w.weekStart<before).sort((a,b)=>b.weekStart<a.weekStart?-1:1)[0] || null;
}
async function writeWeek(w, note){
  try{ await setDoc(doc(db,"laWeeks",weekDocId(w.foremanId,w.weekStart)), {...w, updatedAt:serverTimestamp()}, {merge:true});
       if(note) toast(note); }
  catch(e){ fbNote(e,"writeWeek"); toast("Couldn't save: "+saveMsg(e)); }
}
// The doc backing the open sheet: the live loaded doc, or the fallback object the sheet was
// rendered from (writing it creates the doc the first time anyone fills this foreman's week).
function sheetDoc(){ return (SHEET_DOC_ID && LA_WEEKS.find(w=>w.id===SHEET_DOC_ID)) || SHEET_FALLBACK; }
// Prefer the live equipment-received name; fall back to a Look-Ahead-only job's stored name.
const jobNameFor = num => JOBDIR[num] || (LA_JOBS.find(x=>x.jobNumber===num)||{}).jobName || "";
// Jobs are created just by typing their number into a row; keep the shared job record in step.
function upsertJob(w, num, name){ if(!num) return; const ex=LA_JOBS.find(j=>j.jobNumber===num);
  const fm={id:w.foremanId,name:w.foremanName||"",trade:w.trade||""};
  const foremen=[...((ex&&ex.foremen)||[])]; if(!foremen.some(f=>f.id===fm.id)) foremen.push(fm);
  const rec={ jobNumber:num, jobName:(name||(ex&&ex.jobName)||""), foremen, updatedAt:serverTimestamp(), createdAt:(ex&&ex.createdAt)||serverTimestamp() };
  setDoc(doc(db,"laJobs",num),rec,{merge:true}).catch(e=>fbNote(e,"upsertJob")); }

/* ========================================================================== *
   RENDER
 * ========================================================================== */
function navFor(role){
  if(role==="foreman")    return [["mine","My Look-Ahead"],["history","History"]];
  if(role==="management") return [["foremen","Foremen"],["labor","Labor"],["jobs","Jobs"]];
  return [["locked","Look-Ahead"]];
}
function render(){
  // While the user is typing in a grid cell, a row field, or a notes box, don't rebuild under them.
  const ae=document.activeElement;
  if(ae && ae.closest && ae.closest("#laMain [data-mp], #laMain [data-req], #laMain [data-rowjob], #laMain [data-rowname], #laMain [data-rowtext], #laMain [data-pmjob]")) return;

  if($("laWhoName")){ if(USER){ $("laWhoAv").textContent=((USER.first[0]||"")+(USER.last[0]||"")).toUpperCase(); $("laWhoName").textContent=USER.first; }
    else { $("laWhoAv").textContent="?"; $("laWhoName").textContent="Sign in"; } }
  $("laWeekLabel").textContent = "Week of "+weekRangeLabel(CUR_WEEK);
  SHEET_DOC_ID=null;

  if(!USER){ renderSignIn(); return; }
  if(!peopleLoaded){ $("laMain").innerHTML=`<div class="la-skel"></div>`; return; }
  const role=myRole();
  const tabs=navFor(role);
  if(!tabs.some(t=>t[0]===TAB)) TAB=tabs[0][0];
  $("laNav").innerHTML=tabs.map(([k,l])=>`<button data-latab="${k}" class="${k===TAB?"on":""}">${esc(l)}</button>`).join("");

  if(!role){
    $("laMain").innerHTML=`<div class="la-notice">You need Look-Ahead access set up to use this.</div>
      <div class="la-card"><div class="la-sub">Whoever manages the crew sets this up in the main app: <b>Admin → Manage People → Look-Ahead</b>.</div></div>`;
    return;
  }
  if(TAB==="mine") renderMine();
  else if(TAB==="history") renderHistory();
  else if(TAB==="foremen"){ if(viewForemanId) renderForemanSheet(viewForemanId); else renderForemenList(); }
  else if(TAB==="labor") renderLabor();
  else if(TAB==="jobs"){ if(viewJobNumber) renderJobSheet(viewJobNumber); else renderJobs(); }
}

function renderSignIn(){
  const opts=PEOPLE.slice().sort((a,b)=>nameNorm(a.first,a.last)<nameNorm(b.first,b.last)?-1:1)
    .map(p=>`<option value="${esc(p.id)}">${esc((p.first+" "+p.last).trim())}</option>`).join("");
  $("laMain").innerHTML=`<div class="la-card"><div class="la-h">Who are you?</div>
    <div class="la-sub">Pick your name (same as the main app). Not listed? Type it in.</div>
    <div class="la-field"><label>Choose your name</label><select class="la-sel" id="siPick"><option value="">—</option>${opts}</select></div>
    <div class="la-row"><div class="la-field" style="flex:1"><label>First</label><input class="la-in" id="siFirst"></div>
      <div class="la-field" style="flex:1"><label>Last</label><input class="la-in" id="siLast"></div></div>
    <button class="la-btn wide" id="siGo">Continue</button></div>`;
  $("siPick").onchange=()=>{ const p=PEOPLE.find(x=>x.id===$("siPick").value); if(p){ $("siFirst").value=p.first; $("siLast").value=p.last; } };
  $("siGo").onclick=()=>{ const f=$("siFirst").value.trim(), l=$("siLast").value.trim(); if(!f||!l){ toast("Enter your name"); return; }
    const picked=PEOPLE.find(x=>x.id===$("siPick").value);
    USER={first:f,last:l,email:picked?picked.email:"",id:picked?picked.id:personId(f,l)};
    try{ localStorage.setItem("er_user",JSON.stringify(USER)); }catch(e){}
    render(); };
}

/* ---------------- THE SHEET: an Excel-style day-by-day grid (all three weeks across) ---------- */
async function ensureCurrentWeek(){
  // Wait for laWeeks to load, or a fast roles-first snapshot would overwrite a real week empty.
  if(!USER || myRole()!=="foreman" || ensuringWeek || !weeksLoaded) return;
  if(myWeek(CUR_WEEK)) return;
  ensuringWeek=true;
  const prior=priorWeekFor(USER.id, CUR_WEEK);
  let tasks=[], reqs={};
  if(prior){
    // Roll the grid forward one week: each task's days shift left by 7; keep tasks with work left.
    tasks=(prior.tasks||[]).map(t=>{ const d=taskDays(t), nd=new Array(21).fill(0);
      for(let i=0;i<14;i++) nd[i]=d[i+7]; return {id:rid(),job:t.job,text:t.text,days:nd}; })
      .filter(t=>t.days.some(n=>n>0));
    reqs={...(prior.reqs||{})};
  }
  const rec={ foremanId:USER.id, foremanName:(USER.first+" "+USER.last).trim(), trade:myTrade(),
    weekStart:CUR_WEEK, tasks, reqs, dateCompleted:"", updatedAt:serverTimestamp() };
  try{ await setDoc(doc(db,"laWeeks",weekDocId(USER.id,CUR_WEEK)), rec); }
  catch(e){ fbNote(e,"ensureWeek"); }
  finally{ ensuringWeek=false; }
}
// The spreadsheet grid: task/job column (sticky) + 21 day columns (M–S x3) + a Men total, and a
// TOTAL/day row. editable=true shows inline inputs; false shows plain numbers. Scrolls sideways.
function mpGrid(w, editable){
  const tasks=w.tasks||[];
  let head=`<tr><th class="tcol" rowspan="2">Task / Job</th>`;
  for(let wk=0;wk<3;wk++) head+=`<th colspan="7" class="wkh w${wk+1}">Week ${wk+1}</th>`;
  head+=`<th class="men" rowspan="2">Men</th></tr><tr>`;
  for(let i=0;i<21;i++) head+=`<th class="dh w${Math.floor(i/7)+1}">${DAY_LBL[i%7]}<span>${dayDM(i)}</span></th>`;
  head+=`</tr>`;
  let body="";
  tasks.forEach(t=>{ const days=taskDays(t), men=days.reduce((a,b)=>a+b,0);
    const left = editable
      ? `<div class="rrow">`
        +`<input class="rin rin-job" data-rowjob="${esc(t.id)}" list="laJobList" value="${esc(t.job||"")}" placeholder="Job #" autocomplete="off">`
        +`<input class="rin rin-name" data-rowname="${esc(t.id)}" value="${esc(jobNameFor(t.job))}" placeholder="Project">`
        +`<input class="rin rin-txt" data-rowtext="${esc(t.id)}" value="${esc(t.text||"")}" placeholder="Task">`
        +`<button class="rin-del" data-lataskdel="${esc(t.id)}" title="Delete this row">✕</button>`
        +`</div>`
      : `<div class="rrow ro"><span class="tc-job">${esc(t.job||"—")}</span>`
        +(jobNameFor(t.job)?`<span class="tc-name">${esc(jobNameFor(t.job))}</span>`:"")
        +`<span class="tc-txt">${esc(t.text||"")}</span></div>`;
    body+=`<tr><td class="tcol">${left}</td>`;
    for(let i=0;i<21;i++){ const v=days[i];
      body+= editable
        ? `<td class="day w${Math.floor(i/7)+1}"><input inputmode="numeric" maxlength="2" data-mp="${esc(t.id)}|${i}" value="${v||""}"></td>`
        : `<td class="day w${Math.floor(i/7)+1}">${v||""}</td>`; }
    body+=`<td class="men num">${men||""}</td></tr>`;
  });
  const tot=new Array(21).fill(0); tasks.forEach(t=>{ const d=taskDays(t); for(let i=0;i<21;i++) tot[i]+=d[i]; });
  let totrow=`<tr class="totr"><td class="tcol">TOTAL / day</td>`;
  for(let i=0;i<21;i++) totrow+=`<td class="day num w${Math.floor(i/7)+1}">${tot[i]||""}</td>`;
  totrow+=`<td class="men num">${tot.reduce((a,b)=>a+b,0)||""}</td></tr>`;
  const dir = editable ? jobDirectory() : {};
  const dl = editable ? `<datalist id="laJobList">${Object.keys(dir).sort().map(n=>`<option value="${esc(n)}">${esc(dir[n]||"")}</option>`).join("")}</datalist>` : "";
  const empty = `<tr><td class="tcol">${editable?"No rows yet — tap “Add row”.":"No rows."}</td><td colspan="22"></td></tr>`;
  return `${dl}<div class="la-grid"><table class="la-mp"><thead>${head}</thead><tbody>${body||empty}${totrow}</tbody></table></div>`;
}
// The crew total for each of the 21 days, summed across every task.
function dayCrewTotals(w){ const tot=new Array(21).fill(0); (w.tasks||[]).forEach(t=>{ const d=taskDays(t); for(let i=0;i<21;i++) tot[i]+=d[i]; }); return tot; }
// A big 3-week calendar (like the delivery calendar): one large box per day, with that day's
// crew count and any detail note shown right inside the box. Tap a day to add/read detail.
function dayCalendar(w, editable){
  const notes=w.dayNotes||[], crew=dayCrewTotals(w), todayIso=isoD(new Date());
  let h=`<div class="la-cal">`;
  h+=DAY_FULL.map(d=>`<div class="cdow">${d}</div>`).join("");
  for(let wk=0;wk<3;wk++){
    h+=`<div class="cwk w${wk+1}">Week ${wk+1} · ${esc(weekRangeLabel(weekStartN(wk)))}</div>`;
    for(let d=0;d<7;d++){ const i=wk*7+d, n=notes[i]||"", c=crew[i]||0, iso=dayIso(i);
      const num=new Date(iso+"T00:00:00").getDate();
      const cls=`cday w${wk+1}${iso===todayIso?" today":""}${n?" has":""}`;
      const inner=`<div class="cday-top"><span class="cnum">${num}</span>${c?`<span class="ccrew">👷 ${c}</span>`:""}</div>`
        +`<div class="cnote">${n?esc(n):(editable?`<span class="cadd">＋</span>`:"")}</div>`;
      h+= editable ? `<button class="${cls}" data-daynote="${i}">${inner}</button>`
        : (n ? `<button class="${cls}" data-daynoteview="${i}">${inner}</button>`
             : `<div class="${cls} flat">${inner}</div>`);
    }
  }
  return h+`</div>`;
}
// Read-only per-job grid; the left column shows the foreman + trade instead of the job.
function jobGrid(rows){
  let head=`<tr><th class="tcol" rowspan="2">Foreman / Task</th>`;
  for(let wk=0;wk<3;wk++) head+=`<th colspan="7" class="wkh w${wk+1}">Week ${wk+1}</th>`;
  head+=`<th class="men" rowspan="2">Men</th></tr><tr>`;
  for(let i=0;i<21;i++) head+=`<th class="dh w${Math.floor(i/7)+1}">${DAY_LBL[i%7]}<span>${dayDM(i)}</span></th>`;
  head+=`</tr>`;
  let body="";
  rows.forEach(r=>{ const men=r.days.reduce((a,b)=>a+b,0);
    body+=`<tr><td class="tcol"><div class="rrow ro"><span class="tc-job">${esc(r.who)}</span><span class="tc-name">${esc(TRADES[r.trade]||"")}</span><span class="tc-txt">${esc(r.text)}</span></div></td>`;
    for(let i=0;i<21;i++) body+=`<td class="day w${Math.floor(i/7)+1}">${r.days[i]||""}</td>`;
    body+=`<td class="men num">${men||""}</td></tr>`; });
  const tot=new Array(21).fill(0); rows.forEach(r=>{ for(let i=0;i<21;i++) tot[i]+=r.days[i]; });
  let totrow=`<tr class="totr"><td class="tcol">TOTAL / day</td>`;
  for(let i=0;i<21;i++) totrow+=`<td class="day num w${Math.floor(i/7)+1}">${tot[i]||""}</td>`;
  totrow+=`<td class="men num">${tot.reduce((a,b)=>a+b,0)||""}</td></tr>`;
  const empty=`<tr><td class="tcol">No tasks on this job yet.</td><td colspan="22"></td></tr>`;
  return `<div class="la-grid"><table class="la-mp"><thead>${head}</thead><tbody>${body||empty}${totrow}</tbody></table></div>`;
}
function jobDatalist(){ const dir=jobDirectory(); return `<datalist id="laJobList">${Object.keys(dir).sort().map(n=>`<option value="${esc(n)}">${esc(dir[n]||"")}</option>`).join("")}</datalist>`; }
// Member-name suggestions for PM fields, from the main site's people list.
function peopleDatalist(){ return `<datalist id="laPeopleList">${PEOPLE.slice()
  .sort((a,b)=>nameNorm(a.first,a.last)<nameNorm(b.first,b.last)?-1:1)
  .map(p=>`<option value="${esc((p.first+" "+p.last).trim())}"></option>`).join("")}</datalist>`; }
// The foreman enters a job's PM(s); those PMs see the lookahead at the top of their list.
function pmSection(w){
  const jobs=[...new Set((w.tasks||[]).map(t=>t.job).filter(Boolean))];
  if(!jobs.length) return "";
  return `<div class="la-card"><div class="la-h">Project Managers</div>
    <div class="la-sub">Add the PM on each job — start typing to pick from the member list, or type a new name and it links up when they're added. They'll see this lookahead at the top of their list. Separate names with commas.</div>
    ${peopleDatalist()}
    ${jobs.map(num=>`<div class="la-pmrow"><span class="pm-job">${esc(num)}</span><input class="la-in pm-in" list="laPeopleList" data-pmjob="${esc(num)}" value="${esc((pmsForJob(num)||[]).join(", "))}" placeholder="PM name(s)"></div>`).join("")}</div>`;
}
function reqBoxes(w, editable){
  const r=w.reqs||{};
  return `<div class="la-reqs">`+REQS.map(([k,lab])=>`<div class="la-field"><label>${lab}</label>`
    +(editable?`<textarea class="la-ta" data-req="${k}" placeholder="—">${esc(r[k]||"")}</textarea>`:`<div class="la-ro">${esc(r[k]||"—")}</div>`)
    +`</div>`).join("")+`</div>`;
}
function renderSheet(w, opts){
  opts=opts||{}; SHEET_DOC_ID=w.id||null; SHEET_FALLBACK=w; const editable=!!opts.editable;
  let h="";
  if(opts.back) h+=`<button class="la-btn soft" id="laBack" style="margin-bottom:12px">${esc(opts.back)}</button>`;
  h+=`<div class="la-card"><div class="la-sheet-head">
      <div><label>Foreman</label><b>${esc(w.foremanName||"—")}</b></div>
      <div><label>Trade</label><b>${esc(TRADES[w.trade]||"—")}</b></div>
      <div><label>3 weeks</label><b>${esc(weekRangeLabel(weekStartN(0)))} → ${esc(weekRangeLabel(weekStartN(2)))}</b></div>
      <div><label>Date completed</label>${w.dateCompleted?`<b>${esc(w.dateCompleted)}</b> ${editable?`<button class="mini" id="laUndone">clear</button>`:""}`:(editable?`<button class="mini" id="laMarkDone">Mark done</button>`:`<b>—</b>`)}</div>
    </div></div>`;
  h+=`<div class="la-card gridcard"><div class="la-h">Tasks & Manpower</div>
    <div class="la-sub">${editable?"Fill it in like a spreadsheet. Type the job number in a row — the project name fills in if we know it. Then put how many people work it each day (Mon–Sun, three weeks across). Swipe the grid sideways to reach weeks 2 and 3.":"Crew planned each day, Mon–Sun across three weeks. Swipe sideways for weeks 2 and 3."}</div>
    ${mpGrid(w,editable)}
    ${editable?`<button class="la-btn soft wide" id="laAddRow" style="margin-top:10px">+ Add row</button>`:""}</div>`;
  h+=`<div class="la-card"><div class="la-h">Day Detail</div>
    <div class="la-sub">${editable?"Tap any day to add detail — shutdowns, deliveries, inspections, start times. It shows right on the day.":"Detail noted on specific days. Tap a day to read it."}</div>
    ${dayCalendar(w,editable)}</div>`;
  if(editable && opts.own) h+=pmSection(w);
  h+=`<div class="la-card"><div class="la-h">Requirements & Notes</div>${reqBoxes(w,editable)}</div>`;
  h+=`<div class="la-card"><button class="la-btn wide" id="laExportMine">⬇ Export this lookahead (PDF)</button></div>`;
  $("laMain").innerHTML=h;
  if($("laBack")) $("laBack").onclick=()=>{ viewForemanId=null; render(); };
}

/* FOREMAN'S OWN TAB: the editable spreadsheet grid (auto-created, carrying last week forward). */
function renderMine(){
  ensureCurrentWeek();
  const w=myWeek(CUR_WEEK) || {id:weekDocId(USER.id,CUR_WEEK),foremanId:USER.id,foremanName:(USER.first+" "+USER.last).trim(),trade:myTrade(),weekStart:CUR_WEEK,tasks:[],reqs:{}};
  renderSheet(w,{editable:true,own:true});
}

/* management opening one foreman's current week — view only */
function renderForemanSheet(foremanId){
  const p=PEOPLE.find(x=>x.id===foremanId);
  const name=p?(p.first+" "+p.last).trim():foremanId;
  const trade=p?(p.laTrade||""):"";
  const w=weekFor(foremanId,CUR_WEEK) || {id:weekDocId(foremanId,CUR_WEEK),foremanId,foremanName:name,trade,weekStart:CUR_WEEK,tasks:[],reqs:{}};
  renderSheet(w,{editable:false,back:"‹ All foremen"});
}

/* ---------------- HISTORY (foreman, read-only) ---------------- */
function renderHistory(){
  const weeks=LA_WEEKS.filter(w=>w.foremanId===USER.id && w.weekStart<CUR_WEEK).sort((a,b)=>b.weekStart<a.weekStart?-1:1);
  if(!weeks.length){ $("laMain").innerHTML=`<div class="la-empty"><div class="ico">🗂️</div><h3>No history yet</h3><p>Your past weeks show up here once a new week begins.</p></div>`; return; }
  const sel=histWeek||weeks[0].weekStart;
  const w=weeks.find(x=>x.weekStart===sel)||weeks[0];
  SHEET_DOC_ID=w.id||null; SHEET_FALLBACK=w;
  let h=`<div class="la-card"><div class="la-h">Previous Weeks</div>
    <select class="la-sel" id="laHistPick">${weeks.map(x=>`<option value="${x.weekStart}" ${x.weekStart===sel?"selected":""}>Week of ${esc(weekRangeLabel(x.weekStart))}</option>`).join("")}</select></div>`;
  h+=`<div class="la-card"><div class="la-h">Tasks & Manpower</div>${mpGrid(w,false)}</div>`;
  h+=`<div class="la-card"><div class="la-h">Requirements & Notes</div>${reqBoxes(w,false)}</div>`;
  $("laMain").innerHTML=h;
  $("laHistPick").onchange=()=>{ histWeek=$("laHistPick").value; renderHistory(); };
}

// A collapsed section ("not mine") the manager can expand. State kept in OPEN across renders.
function collapsible(key, title, innerHTML){
  const open=OPEN.has(key);
  return `<button class="la-collap ${open?"open":""}" data-lacollap="${esc(key)}"><span>${esc(title)}</span><span class="chev">${open?"▾":"▸"}</span></button>${open?innerHTML:""}`;
}
// Jobs this manager is the PM on (what counts as "theirs").
function myManagedSet(){ return new Set(jobsInPlay().filter(managingJob)); }

/* ---------------- FOREMEN LIST (management, view only) ---------------- */
function foremanRow(p){ const w=weekFor(p.id,CUR_WEEK);
  const men=w?(w.tasks||[]).reduce((s,t)=>s+taskDays(t).reduce((a,b)=>a+b,0),0):0;
  const tasks=w?(w.tasks||[]).length:0;
  const done=w&&w.dateCompleted; const on=myFavForemen().includes(p.id);
  return `<div class="la-card la-forow" data-laopenforeman="${esc(p.id)}">
    <div class="c-head"><span class="c-type"><button class="la-star ${on?"on":""}" data-lafavforeman="${esc(p.id)}" title="Pin to top">${on?"★":"☆"}</button> ${esc((p.first+" "+p.last).trim())} <span class="la-badge">${esc(TRADES[p.laTrade]||"trade?")}</span></span>
      ${done?`<span class="la-badge ok">done ${esc(w.dateCompleted)}</span>`:`<span class="la-badge">in progress</span>`}</div>
    <div class="la-sub" style="margin-top:6px">${tasks} task${tasks===1?"":"s"} · ${men} man-day${men===1?"":"s"} planned · tap to open ›</div></div>`;
}
function renderForemenList(){
  const fav=myFavForemen();
  const sortF=(a,b)=>{ const fa=fav.includes(a.id),fb=fav.includes(b.id); if(fa!==fb) return fa?-1:1; return nameNorm(a.first,a.last)<nameNorm(b.first,b.last)?-1:1; };
  const foremen=PEOPLE.filter(p=>roleOf(p)==="foreman");
  if(!foremen.length){ $("laMain").innerHTML=`<div class="la-card"><div class="la-h">Foremen — This Week</div></div><div class="la-empty"><div class="ico">👷</div><h3>No foremen yet</h3><p>Set someone to Foreman in the main app: Admin → Manage People → Look-Ahead.</p></div>`; return; }
  const managed=myManagedSet();
  const onMine=p=>{ const w=weekFor(p.id,CUR_WEEK); return w && (w.tasks||[]).some(t=>managed.has(t.job)); };
  const mine=foremen.filter(onMine).sort(sortF);
  const others=foremen.filter(p=>!onMine(p)).sort(sortF);
  let h=`<div class="la-card"><div class="la-h">Foremen — This Week</div>
    <div class="la-sub">${managed.size?"Foremen running your jobs are shown; the rest are collapsed. ":""}Tap a foreman to view what they entered; tap the star to pin.</div></div>`;
  if(!managed.size){ h+=foremen.slice().sort(sortF).map(foremanRow).join(""); $("laMain").innerHTML=h; return; }
  h+= mine.length ? mine.map(foremanRow).join("") : `<div class="la-card"><div class="la-sub">No foremen are working your jobs this week.</div></div>`;
  if(others.length) h+=collapsible("foremen-others", `Other foremen (${others.length})`, others.map(foremanRow).join(""));
  $("laMain").innerHTML=h;
}

/* ---------------- LABOR ROLL-UP (management) ---------------- */
function laborMatrix(){
  // job|trade → peak daily crew for each of the 3 weeks, across every foreman's current week.
  const m={};
  LA_WEEKS.filter(w=>w.weekStart===CUR_WEEK).forEach(w=>{ const tr=w.trade||"—";
    (w.tasks||[]).forEach(t=>{ const job=t.job||"—", k=job+"|"+tr;
      const e=m[k]=m[k]||{job,trade:tr,day:new Array(21).fill(0)};
      const d=taskDays(t); for(let i=0;i<21;i++) e.day[i]+=d[i]; }); });
  const rows=Object.values(m).map(e=>({job:e.job,trade:e.trade,
      wk:[0,1,2].map(wi=>Math.max(0,...e.day.slice(wi*7,wi*7+7)))}));
  const byJob=(a,b)=>a.job<b.job?-1:a.job>b.job?1:(a.trade<b.trade?-1:1);
  const byTrade=(a,b)=>a.trade<b.trade?-1:a.trade>b.trade?1:(a.job<b.job?-1:a.job>b.job?1:0);
  return rows.sort(laborSort==="trade"?byTrade:byJob);
}
function laborTable(rows){
  const cell=(r,i)=>{ const v=r.wk[i], prev=i>0?r.wk[i-1]:v, jump=v>=prev+3 && v>0, big=v>=8;
    return `<td class="num ${jump?"la-jump":""} ${big?"la-big":""}">${v||""}</td>`; };
  let t=`<div class="la-card" style="overflow-x:auto"><table class="la-table"><thead><tr><th>Job</th><th>Trade</th>
    <th>Wk1<br><span style="font-weight:400">${esc(weekRangeLabel(weekStartN(0)))}</span></th>
    <th>Wk2<br><span style="font-weight:400">${esc(weekRangeLabel(weekStartN(1)))}</span></th>
    <th>Wk3<br><span style="font-weight:400">${esc(weekRangeLabel(weekStartN(2)))}</span></th></tr></thead><tbody>`;
  rows.forEach(r=>{ t+=`<tr><td>${esc(r.job)}</td><td>${esc(TRADES[r.trade]||r.trade)}</td>${cell(r,0)}${cell(r,1)}${cell(r,2)}</tr>`; });
  const tot=[0,0,0]; rows.forEach(r=>r.wk.forEach((v,i)=>tot[i]+=v));
  t+=`<tr><td colspan="2"><b>Peak</b></td><td class="num">${tot[0]}</td><td class="num">${tot[1]}</td><td class="num">${tot[2]}</td></tr>`;
  return t+`</tbody></table></div>`;
}
function renderLabor(){
  const rows=laborMatrix();
  let h=`<div class="la-card"><div class="la-h">Upcoming Labor Needs</div>
    <div class="la-sub">Biggest crew needed each week, by job and trade. Amber = a jump from the week before, or an unusually big crew.</div>
    <div class="la-row" style="margin-bottom:8px">Sort: <button class="mini ${laborSort==="job"?"on":""}" data-lasort="job">By job</button><button class="mini ${laborSort==="trade"?"on":""}" data-lasort="trade">By trade</button></div>
    <button class="la-btn soft" id="laExportLabor">⬇ Export labor report (Excel)</button></div>`;
  if(!rows.length){ h+=`<div class="la-empty"><div class="ico">👷</div><h3>No labor planned yet</h3><p>It fills in as foremen fill out their lookaheads.</p></div>`; $("laMain").innerHTML=h; return; }
  const managed=myManagedSet();
  if(!managed.size){ h+=laborTable(rows); $("laMain").innerHTML=h; return; }
  const mine=rows.filter(r=>managed.has(r.job));
  const others=rows.filter(r=>!managed.has(r.job));
  h+= mine.length ? laborTable(mine) : `<div class="la-card"><div class="la-sub">No labor on your jobs yet.</div></div>`;
  if(others.length) h+=collapsible("labor-others", `All other jobs (${others.length})`, laborTable(others));
  $("laMain").innerHTML=h;
}

/* ---------------- JOBS (management, view only) ---------------- */
// Every job number that shows up on a current-week lookahead (plus any laJobs record).
function jobsInPlay(){ const nums=new Set();
  LA_WEEKS.filter(w=>w.weekStart===CUR_WEEK).forEach(w=>(w.tasks||[]).forEach(t=>{ if(t.job) nums.add(t.job); }));
  LA_JOBS.forEach(j=>nums.add(j.jobNumber));
  return [...nums]; }
function jobCardHTML(num){
  const on=myFavJobs().includes(num);
  const foremen=[...new Set(LA_WEEKS.filter(w=>w.weekStart===CUR_WEEK && (w.tasks||[]).some(t=>t.job===num)).map(w=>w.foremanName))];
  const pms=pmsForJob(num);
  return `<div class="la-card la-forow" data-laopenjob="${esc(num)}">
    <div class="c-head"><span class="c-type"><button class="la-star ${on?"on":""}" data-lafavjob="${esc(num)}" title="Pin to top">${on?"★":"☆"}</button> ${esc(num)} <span class="la-sub">${esc(jobNameFor(num)||"")}</span></span></div>
    <div class="la-sub" style="margin-top:6px"><b>Foremen:</b> ${esc(foremen.join(", ")||"—")}${pms.length?` · <b>PM:</b> ${esc(pms.join(", "))}`:""} · tap to open ›</div></div>`;
}
function renderJobs(){
  const fav=myFavJobs();
  const all=jobsInPlay();
  if(!all.length){ $("laMain").innerHTML=`<div class="la-card"><div class="la-h">Jobs</div></div><div class="la-empty"><div class="ico">📁</div><h3>No jobs yet</h3></div>`; return; }
  const managed=all.filter(managingJob).sort((a,b)=>a<b?-1:1);
  const mset=new Set(managed);
  const others=all.filter(n=>!mset.has(n)).sort((a,b)=>{ const fa=fav.includes(a), fb=fav.includes(b); if(fa!==fb) return fa?-1:1; return a<b?-1:1; });
  let h="";
  if(!managed.length){
    h+=`<div class="la-card"><div class="la-h">Jobs</div><div class="la-sub">Tap a job to view its 3-week lookahead (every foreman on that job together). Tap the star to pin one to the top.</div></div>`;
    h+=others.map(jobCardHTML).join(""); $("laMain").innerHTML=h; return;
  }
  h+=`<div class="la-card"><div class="la-h">Jobs You're Managing</div><div class="la-sub">You're the PM on these — the rest are collapsed below. Tap to view the lookahead.</div></div>`;
  h+=managed.map(jobCardHTML).join("");
  if(others.length) h+=collapsible("jobs-others", `All other jobs (${others.length})`, others.map(jobCardHTML).join(""));
  $("laMain").innerHTML=h;
}
/* ---------------- ONE JOB'S 3-WEEK LOOKAHEAD (management, view only) ---------------- */
function renderJobSheet(num){
  const rows=[];
  LA_WEEKS.filter(w=>w.weekStart===CUR_WEEK).forEach(w=>{ (w.tasks||[]).filter(t=>t.job===num).forEach(t=>{
    rows.push({who:w.foremanName||"", trade:w.trade||"", text:t.text||"", days:taskDays(t)}); }); });
  const pms=pmsForJob(num);
  let h=`<button class="la-btn soft" id="laBackJob" style="margin-bottom:12px">‹ All jobs</button>`;
  h+=`<div class="la-card"><div class="la-sheet-head">
      <div><label>Job</label><b>${esc(num)}</b></div>
      <div><label>Project</label><b>${esc(jobNameFor(num)||"—")}</b></div>
      <div><label>3 weeks</label><b>${esc(weekRangeLabel(weekStartN(0)))} → ${esc(weekRangeLabel(weekStartN(2)))}</b></div>
      <div><label>PM</label><b>${esc(pms.join(", ")||"—")}</b></div>
    </div></div>`;
  h+=`<div class="la-card"><div class="la-h">3-Week Lookahead — all foremen on this job</div>
    <div class="la-sub">Crew per day across every foreman working ${esc(num)}. Swipe sideways for weeks 2 and 3.</div>
    ${jobGrid(rows)}</div>`;
  $("laMain").innerHTML=h;
  $("laBackJob").onclick=()=>{ viewJobNumber=null; render(); };
}

/* ========================================================================== *
   EVENTS
 * ========================================================================== */
function openModal(title, bodyHTML, after){ $("laModalTitle").textContent=title; $("laModalBody").innerHTML=bodyHTML;
  $("laModal").classList.add("show"); document.body.style.overflow="hidden"; if(after) after(); }
function closeModal(){ $("laModal").classList.remove("show"); document.body.style.overflow=""; }
const DAY_FULL=["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
const dayLabel=i=>DAY_FULL[i%7]+" "+dayDM(i);
// Add/edit a note for one calendar day on the open sheet.
function dayNoteModal(i){
  const w=sheetDoc(); if(!w) return;
  const cur=(w.dayNotes||[])[i]||"";
  openModal("Day detail — "+dayLabel(i), `
    <textarea class="la-ta" id="dnText" placeholder="What's happening this day? (shutdown, delivery, inspection, time, etc.)" style="min-height:120px">${esc(cur)}</textarea>
    <button class="la-btn wide" id="dnSave" style="margin-top:10px">Save</button>`, ()=>{
    setTimeout(()=>{ const t=$("dnText"); if(t){ t.focus(); } },60);
    $("dnSave").onclick=()=>{ const d=sheetDoc(); if(!d) return;
      const arr=Array.isArray(d.dayNotes)?d.dayNotes.slice():new Array(21).fill(""); while(arr.length<21) arr.push("");
      arr[i]=$("dnText").value.trim(); d.dayNotes=arr; writeWeek(d); closeModal(); render(); };
  });
}
function dayNoteView(i){ const w=sheetDoc(); const n=(w&&w.dayNotes||[])[i]||""; if(!n) return;
  openModal("Day detail — "+dayLabel(i), `<div class="la-ro" style="white-space:pre-wrap;min-height:40px">${esc(n)}</div>`); }
document.addEventListener("click", e=>{
  // If a field had focus and the user tapped a control (not another field), blur it first so its
  // change saves AND render() isn't blocked by the "don't rebuild while typing" guard.
  const ae=document.activeElement;
  if(ae && /INPUT|TEXTAREA|SELECT/.test(ae.tagName) && ae.blur && !e.target.closest("input,textarea,select")) ae.blur();

  const tabBtn=e.target.closest("[data-latab]"); if(tabBtn){ TAB=tabBtn.dataset.latab; viewForemanId=null; viewJobNumber=null; render(); return; }
  if(e.target.closest("[data-laclose]")){ closeModal(); return; }
  if(e.target===$("laModal")){ closeModal(); return; }

  const col=e.target.closest("[data-lacollap]"); if(col){ const k=col.dataset.lacollap; if(OPEN.has(k)) OPEN.delete(k); else OPEN.add(k); render(); return; }

  // favorites (pin to top) — handle before the open handlers so the star doesn't also open the row
  const ff=e.target.closest("[data-lafavforeman]"); if(ff){ e.stopPropagation(); toggleFav("laFavForemen", ff.dataset.lafavforeman); return; }
  const fj=e.target.closest("[data-lafavjob]"); if(fj){ e.stopPropagation(); toggleFav("laFavJobs", fj.dataset.lafavjob); return; }
  const sortBtn=e.target.closest("[data-lasort]"); if(sortBtn){ laborSort=sortBtn.dataset.lasort; render(); return; }

  const open=e.target.closest("[data-laopenforeman]"); if(open){ viewForemanId=open.dataset.laopenforeman; render(); return; }
  const openJ=e.target.closest("[data-laopenjob]"); if(openJ){ viewJobNumber=openJ.dataset.laopenjob; render(); return; }

  if(e.target.closest("#laAddRow")){ const w=sheetDoc(); if(!w){ toast("Loading…"); return; } w.tasks=(w.tasks||[]).concat({id:rid(),job:"",text:"",days:new Array(21).fill(0)}); writeWeek(w).then(render); return; }
  const td=e.target.closest("[data-lataskdel]"); if(td){ const w=sheetDoc(); if(!w) return; const t=(w.tasks||[]).find(x=>x.id===td.dataset.lataskdel);
    if(t && confirm("Delete this row?")){ w.tasks=w.tasks.filter(x=>x.id!==t.id); writeWeek(w).then(render); } return; }
  const dn=e.target.closest("[data-daynote]"); if(dn){ dayNoteModal(Number(dn.dataset.daynote)); return; }
  const dnv=e.target.closest("[data-daynoteview]"); if(dnv){ dayNoteView(Number(dnv.dataset.daynoteview)); return; }

  if(e.target.closest("#laMarkDone")){ const w=sheetDoc(); if(w){ w.dateCompleted=isoD(new Date()); writeWeek(w).then(render); } return; }
  if(e.target.closest("#laUndone")){ const w=sheetDoc(); if(w){ w.dateCompleted=""; writeWeek(w).then(render); } return; }

  if(e.target.closest("#laExportMine")) exportSheetPdf(SHEET_DOC_ID);
  if(e.target.closest("#laExportLabor")) exportLabor();
});
// Grid cells and notes boxes save on change (blur). render() won't rebuild while one is focused.
document.addEventListener("change", e=>{
  const mp=e.target.closest("[data-mp]"); if(mp){ const [tid,di]=mp.dataset.mp.split("|"); const w=sheetDoc(); if(!w) return;
    const t=(w.tasks||[]).find(x=>x.id===tid); if(!t) return; const days=taskDays(t); days[+di]=Math.max(0,Math.min(99,Number(mp.value)||0));
    t.days=days; mp.value=days[+di]||""; writeWeek(w); return; }
  const rq=e.target.closest("[data-req]"); if(rq){ const w=sheetDoc(); if(!w) return; w.reqs={...(w.reqs||{})}; w.reqs[rq.dataset.req]=rq.value; writeWeek(w); return; }
  // Type the job number in a row; if it's a known job, fill its name into the row's name field.
  const rj=e.target.closest("[data-rowjob]"); if(rj){ const w=sheetDoc(); if(!w) return; const t=(w.tasks||[]).find(x=>x.id===rj.dataset.rowjob); if(!t) return;
    const num=normJob(rj.value); t.job=num; rj.value=num;
    const nameInp=document.querySelector(`[data-rowname="${t.id}"]`); const known=jobNameFor(num);
    if(nameInp && known && !nameInp.value.trim()) nameInp.value=known;
    const name=(nameInp?nameInp.value:"").trim();
    upsertJob(w, num, name); writeWeek(w); return; }
  const rn=e.target.closest("[data-rowname]"); if(rn){ const w=sheetDoc(); if(!w) return; const t=(w.tasks||[]).find(x=>x.id===rn.dataset.rowname); if(!t) return;
    if(t.job) upsertJob(w, t.job, rn.value.trim()); return; }
  const rt=e.target.closest("[data-rowtext]"); if(rt){ const w=sheetDoc(); if(!w) return; const t=(w.tasks||[]).find(x=>x.id===rt.dataset.rowtext); if(!t) return; t.text=rt.value; writeWeek(w); return; }
  // Foreman types the PM name(s) for a job — stored on the shared job record.
  const pm=e.target.closest("[data-pmjob]"); if(pm){ const num=pm.dataset.pmjob; const names=pm.value.split(",").map(s=>s.trim()).filter(Boolean);
    const ex=LA_JOBS.find(j=>j.jobNumber===num);
    setDoc(doc(db,"laJobs",num),{jobNumber:num,jobName:(ex&&ex.jobName)||jobNameFor(num)||"",pms:names,updatedAt:serverTimestamp(),createdAt:(ex&&ex.createdAt)||serverTimestamp()},{merge:true}).catch(er=>fbNote(er,"pm")); return; }
});

/* ========================================================================== *
   SAMPLE COMPANY — auto-seeded once on a fresh database so the full scale is
   visible from day one. Loaded/removed from the main app's Admin.
 * ========================================================================== */
function maybeSeed(){ if(META.seeded||META.removed||seeding||!fbReady||LA_JOBS.length) return;
  seeding=true; seedSampleCompany(db).catch(e=>fbNote(e,"seed")).finally(()=>{ seeding=false; }); }

/* ========================================================================== *
   EXPORTS
 * ========================================================================== */
function xlsxReady(){ return !!window.XLSX; }
function jspdfReady(){ return !!(window.jspdf&&window.jspdf.jsPDF); }

function exportLabor(){
  if(!xlsxReady()){ toast("Report tools still loading — try again"); return; }
  const rows=laborMatrix();
  const aoa=[["Job","Trade",`Week 1 peak (${weekRangeLabel(weekStartN(0))})`,`Week 2 peak (${weekRangeLabel(weekStartN(1))})`,`Week 3 peak (${weekRangeLabel(weekStartN(2))})`]];
  rows.forEach(r=>aoa.push([r.job,TRADES[r.trade]||r.trade,r.wk[0],r.wk[1],r.wk[2]]));
  const tot=[0,0,0]; rows.forEach(r=>r.wk.forEach((v,i)=>tot[i]+=v)); aoa.push(["TOTAL (peak)","",tot[0],tot[1],tot[2]]);
  const ws=XLSX.utils.aoa_to_sheet(aoa), wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,ws,"Labor Needs");
  XLSX.writeFile(wb,`Labor_Needs_${CUR_WEEK}.xlsx`);
}
function exportSheetPdf(docId){
  if(!jspdfReady()){ toast("Report tools still loading — try again"); return; }
  const w=(docId && LA_WEEKS.find(x=>x.id===docId)); if(!w || !(w.tasks||[]).length){ toast("Nothing to export yet"); return; }
  const { jsPDF }=window.jspdf; const d=new jsPDF({unit:"pt",format:"letter",orientation:"landscape"});
  const M=28, PW=d.internal.pageSize.getWidth(), PH=d.internal.pageSize.getHeight();
  d.setFont("helvetica","bold").setFontSize(14); d.text("3-Week Look-Ahead",M,M+4);
  d.setFont("helvetica","normal").setFontSize(9);
  d.text(`${w.foremanName||""}   ·   ${TRADES[w.trade]||""}   ·   ${weekRangeLabel(weekStartN(0))} → ${weekRangeLabel(weekStartN(2))}${w.dateCompleted?"   ·   completed "+w.dateCompleted:""}`,M,M+20);
  // grid geometry
  const taskW=150, menW=28, dayW=(PW-M*2-taskW-menW)/21;
  let y=M+34; const rowH=16;
  const dayX=i=>M+taskW+i*dayW;
  const line=(yy)=>{ d.setDrawColor(200); d.line(M,yy,PW-M,yy); };
  // header
  d.setFont("helvetica","bold").setFontSize(7.5);
  d.text("TASK / JOB",M+2,y+11);
  for(let wk=0;wk<3;wk++) d.text("WEEK "+(wk+1), dayX(wk*7)+2, y+5);
  for(let i=0;i<21;i++){ d.text(DAY_LBL[i%7], dayX(i)+dayW/2-2, y+11); d.setFontSize(5).text(dayDM(i), dayX(i)+1, y+16); d.setFontSize(7.5); }
  d.text("MEN", PW-M-menW+2, y+11);
  y+=18; line(y);
  // rows
  d.setFont("helvetica","normal").setFontSize(7);
  const tot=new Array(21).fill(0);
  (w.tasks||[]).forEach(t=>{ const days=taskDays(t); const men=days.reduce((a,b)=>a+b,0);
    if(y+rowH>PH-120){ d.addPage(); y=M; }
    const label=`[${t.job||"—"}] ${t.text||""}`;
    const lines=d.splitTextToSize(label, taskW-4); const rh=Math.max(rowH, lines.length*8+4);
    d.text(lines, M+2, y+9);
    for(let i=0;i<21;i++){ tot[i]+=days[i]; if(days[i]) d.text(String(days[i]), dayX(i)+dayW/2-2, y+9); }
    if(men) d.text(String(men), PW-M-menW+2, y+9);
    y+=rh; line(y);
  });
  d.setFont("helvetica","bold");
  d.text("TOTAL / day", M+2, y+9);
  for(let i=0;i<21;i++){ if(tot[i]) d.text(String(tot[i]), dayX(i)+dayW/2-2, y+9); }
  d.text(String(tot.reduce((a,b)=>a+b,0)||""), PW-M-menW+2, y+9);
  y+=rowH+8;
  // requirement boxes
  d.setFontSize(8);
  REQS.forEach(([k,lab])=>{ if(y>PH-40){ d.addPage(); y=M; }
    d.setFont("helvetica","bold").text(lab+":", M, y);
    const body=(w.reqs&&w.reqs[k])?w.reqs[k]:"—";
    const lines=d.splitTextToSize(body, PW-M*2-10); d.setFont("helvetica","normal");
    d.text(lines, M+10, y+11); y+=11+lines.length*10+6;
  });
  d.save(`Lookahead_${String(w.foremanName||"").replace(/[^A-Za-z0-9]+/g,"-")||"foreman"}_${CUR_WEEK}.pdf`);
}

/* ---------- boot ---------- */
render(); startSync();
window.__laDebug={ get people(){return PEOPLE;}, get jobs(){return LA_JOBS;}, get weeks(){return LA_WEEKS;} };
