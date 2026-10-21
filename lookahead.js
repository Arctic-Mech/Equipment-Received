/* ============================================================================
   Look-Ahead — a standalone 3-week lookahead app.

   Deliberately independent of the main equipment/safety app: its own page, its
   own Firestore collections (all prefixed `la`), its own styles. It reuses only
   the shared Firebase project + the signed-in identity (er_user) so a foreman
   doesn't learn a second login. Nothing here writes to the main app's data.

   Model (see the design agreed with Arctic):
     - One weekly lookahead PER FOREMAN (not per job). Each task/conflict is
       tagged with a job number, so data stays separated by job underneath.
     - Trade (sheet / piping) is a property of the foreman; every task they
       enter counts under that trade automatically.
     - A job (keyed by job #) can have MANY foremen and MANY PMs. A second
       foreman joining a job inherits its PMs and may add more.
     - Weeks run Mon–Sun. The current week's lookahead is editable any day;
       when a new week begins it archives to history and rolls forward.
   Roles: foreman (own only), pm (their jobs' conflicts, toggle all), super
   (labor roll-up + read all), plus a PIN-gated settings area for Bobby.
   Visibility is soft (client-side), matching the rest of the app.
============================================================================ */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
         collection, onSnapshot, doc, setDoc, deleteDoc, writeBatch, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { esc, normJob, MON } from "./format.js";
import { LA_TRADES as TRADES, seedSampleCompany } from "./lookahead-data.js";

const ADMIN_PIN = "1977";                 // same guard the main app uses
const CONFLICT_TYPES = ["GC", "Access", "Other trade", "Material", "Equipment", "Design / RFI", "Other"];

/* ---------- tiny DOM helpers (kept local so this page needs nothing from the main app) ---------- */
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

/* ---------- week math (Mon–Sun) ---------- */
function isoD(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
function mondayOf(d){ const x=new Date(d); const off=(x.getDay()+6)%7; x.setDate(x.getDate()-off); x.setHours(0,0,0,0); return x; }
function addDays(iso,n){ const d=new Date(iso+"T00:00:00"); d.setDate(d.getDate()+n); return isoD(d); }
const CUR_WEEK = isoD(mondayOf(new Date()));
const weekStartN = n => addDays(CUR_WEEK, n*7);                 // n = 0,1,2 → this week, +1, +2
function weekRangeLabel(monIso){ const m=new Date(monIso+"T00:00:00"), s=new Date(m); s.setDate(s.getDate()+6);
  const f=d=>MON[d.getMonth()]+" "+d.getDate(); return f(m)+" – "+f(s); }

/* ---------- live state ---------- */
let LA_JOBS=[], LA_WEEKS=[], PEOPLE=[], META={seeded:false,removed:false};
let TAB="", pmShowAll=false, histWeek=null, seeding=false, ensuringWeek=false, peopleLoaded=false, weeksLoaded=false;

// Roles live on the person's record in the main app (people/{id}.laRole / .laTrade), set in
// Admin → Manage People → Look-Ahead. This page only reads them.
function myPerson(){ return (USER && PEOPLE.find(p=>p.id===USER.id)) || null; }
function myRole(){ const p=myPerson(); return p?(p.laRole||""):""; }
function myTrade(){ const p=myPerson(); return p?(p.laTrade||""):""; }
function personName(id){ const p=PEOPLE.find(x=>x.id===id); return p?(p.first+" "+p.last).trim():id; }

/* ---------- data listeners ---------- */
function startSync(){
  if(!fbReady){ peopleLoaded=true; weeksLoaded=true; render(); return; }
  // Every handler re-renders on success AND on error, so a slow or denied read can never leave
  // the page stuck on the loading skeleton — it falls through to the sign-in or access message.
  onSnapshot(collection(db,"laJobs"),  s=>{ const l=[]; s.forEach(d=>l.push({id:d.id,...d.data()})); LA_JOBS=l; render(); }, e=>{ fbNote(e,"laJobs"); render(); });
  onSnapshot(collection(db,"laWeeks"), s=>{ const l=[]; s.forEach(d=>l.push({id:d.id,...d.data()})); LA_WEEKS=l; weeksLoaded=true; render(); }, e=>{ weeksLoaded=true; fbNote(e,"laWeeks"); render(); });
  onSnapshot(collection(db,"people"),  s=>{ const l=[]; s.forEach(d=>{const v=d.data(); l.push({id:d.id,first:v.first||"",last:v.last||"",email:v.email||"",laRole:v.laRole||"",laTrade:v.laTrade||""});}); PEOPLE=l; peopleLoaded=true; render(); }, e=>{ peopleLoaded=true; fbNote(e,"people"); render(); });
  onSnapshot(doc(db,"laMeta","seed"), d=>{ META=d.exists()?{seeded:!!d.data().seeded,removed:!!d.data().removed}:{seeded:false,removed:false};
    maybeSeed(); render(); }, e=>{ fbNote(e,"laMeta"); render(); });
  // Last-resort guard: if the people read never calls back at all, show the page anyway.
  setTimeout(()=>{ if(!peopleLoaded){ peopleLoaded=true; render(); } }, 4000);
}

/* ---------- jobs the signed-in person is tied to ---------- */
const jobsForForeman = id => LA_JOBS.filter(j=>(j.foremen||[]).some(f=>f.id===id));
function isPmOf(job){ if(!USER) return false; const my=nameNorm(USER.first,USER.last);
  return (job.pms||[]).some(p=>(p.id&&p.id===USER.id)||nameNorm2(p.name)===my); }
const nameNorm2 = s => String(s||"").toLowerCase().replace(/[^a-z0-9 ]/g,"").replace(/\s+/g," ").trim();

/* ---------- my weekly lookahead doc ---------- */
const weekDocId = (foremanId,ws) => `${foremanId}__${ws}`;
const myWeek = ws => LA_WEEKS.find(w=>w.foremanId===USER.id && w.weekStart===ws) || null;
function priorWeekFor(foremanId, before){
  return LA_WEEKS.filter(w=>w.foremanId===foremanId && w.weekStart<before)
    .sort((a,b)=>b.weekStart<a.weekStart?-1:1)[0] || null;
}
async function ensureCurrentWeek(){
  // Must not run until laWeeks has loaded at least once: otherwise a page load that hears the
  // roles snapshot before the weeks snapshot would see "no current week" and overwrite the
  // foreman's real week with a fresh empty one.
  if(!USER || myRole()!=="foreman" || ensuringWeek || !weeksLoaded) return;
  if(myWeek(CUR_WEEK)) return;
  ensuringWeek=true;
  const prior=priorWeekFor(USER.id, CUR_WEEK);
  // Roll forward: last week's Week-2 becomes this week's Week-1, Week-3 → Week-2; unresolved upcoming
  // conflicts carry over; current-week actuals start fresh (they belong to the week they happened).
  let tasks=[], conflicts=[];
  if(prior){
    tasks=(prior.tasks||[]).filter(t=>t.week>=2).map(t=>({...t,id:rid(),week:t.week-1}));
    conflicts=(prior.conflicts||[]).filter(c=>c.scope==="upcoming" && !c.resolved).map(c=>({...c,id:rid()}));
  }
  const rec={ foremanId:USER.id, foremanName:(USER.first+" "+USER.last).trim(), trade:myTrade(),
    weekStart:CUR_WEEK, tasks, conflicts, updatedAt:serverTimestamp() };
  try{ await setDoc(doc(db,"laWeeks",weekDocId(USER.id,CUR_WEEK)), rec); }
  catch(e){ fbNote(e,"ensureWeek"); }
  finally{ ensuringWeek=false; }
}
async function writeWeek(w, note){
  try{ await setDoc(doc(db,"laWeeks",weekDocId(w.foremanId,w.weekStart)), {...w, updatedAt:serverTimestamp()}, {merge:true});
       if(note) toast(note); }
  catch(e){ fbNote(e,"writeWeek"); toast("Couldn't save: "+saveMsg(e)); }
}

/* ---------- delete guard: your own is free, anything else needs the PIN ---------- */
function canDelete(ownerId, then){
  if(ownerId===USER?.id){ then(); return; }
  openModal("Enter PIN to delete", `<p class="la-sub">This isn't yours to delete. Enter the admin PIN to remove it.</p>
    <input class="la-in" id="laPin" type="password" inputmode="numeric" placeholder="PIN" autocomplete="off">
    <button class="la-btn wide danger" id="laPinGo" style="margin-top:12px">Delete</button>`, ()=>{
      $("laPinGo").onclick=()=>{ if($("laPin").value===ADMIN_PIN){ closeModal(); then(); } else toast("Wrong PIN"); };
      setTimeout(()=>$("laPin").focus(),60);
    });
}

/* ========================================================================== *
   RENDER
 * ========================================================================== */
function navFor(role){
  if(role==="foreman") return [["mine","My Look-Ahead"],["history","History"]];
  if(role==="pm")      return [["conflicts","Conflicts"],["jobs","Jobs"]];
  if(role==="super")   return [["labor","Labor Needs"],["conflicts","Conflicts"],["jobs","Jobs"]];
  return [["locked","Look-Ahead"]];
}
function render(){
  // header identity
  if($("laWhoName")){ if(USER){ $("laWhoAv").textContent=((USER.first[0]||"")+(USER.last[0]||"")).toUpperCase(); $("laWhoName").textContent=USER.first; }
    else { $("laWhoAv").textContent="?"; $("laWhoName").textContent="Sign in"; } }
  $("laWeekLabel").textContent = "Week of "+weekRangeLabel(CUR_WEEK);

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
  if(TAB==="mine"){ ensureCurrentWeek(); renderForeman(); }
  else if(TAB==="history") renderHistory();
  else if(TAB==="conflicts") renderConflicts();
  else if(TAB==="labor") renderLabor();
  else if(TAB==="jobs") renderJobs();
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

/* ---------------- FOREMAN ---------------- */
function renderForeman(){
  const w=myWeek(CUR_WEEK) || {foremanId:USER.id,foremanName:(USER.first+" "+USER.last).trim(),trade:myTrade(),weekStart:CUR_WEEK,tasks:[],conflicts:[]};
  const my=jobsForForeman(USER.id);
  const tradeLbl=TRADES[myTrade()]||"—";
  let h=`<div class="la-card"><div class="la-h">My Jobs <span class="la-badge">${tradeLbl}</span></div>
    <div class="la-chips">${my.map(j=>`<span class="la-chip">${esc(j.jobNumber)} · ${esc(j.jobName||"")}
        <button data-lajobleave="${esc(j.id)}" title="Remove this job from my list">✕</button></span>`).join("")||`<span class="la-sub">No jobs yet — add one.</span>`}</div>
    <button class="la-btn ghost" id="laAddJob" style="margin-top:10px">+ Add a job</button></div>`;

  // three week columns
  h+=`<div class="la-card"><div class="la-h">3-Week Lookahead</div>
    <div class="la-sub">This week is Week 1. Tag each task with its job and how many people it needs.</div><div class="la-weeks">`;
  for(let n=1;n<=3;n++){
    const ws=weekStartN(n-1);
    const tasks=(w.tasks||[]).filter(t=>t.week===n);
    const men=tasks.reduce((s,t)=>s+(Number(t.headcount)||0),0);
    h+=`<div class="la-week w${n}"><div class="la-week-h"><span>Week ${n} <span class="tag">${n===1?"this week":weekRangeLabel(ws)}</span></span><span>${men} 👷</span></div>
      <div class="la-week-body">${tasks.map(t=>taskCard(t)).join("")||`<div class="la-sub">No tasks.</div>`}
      <button class="la-btn soft wide" data-lataskadd="${n}" style="margin-top:4px">+ Task</button></div></div>`;
  }
  h+=`</div></div>`;

  // current-week conflicts (actuals)
  const cur=(w.conflicts||[]).filter(c=>c.scope==="current");
  const up=(w.conflicts||[]).filter(c=>c.scope==="upcoming");
  h+=`<div class="la-card"><div class="la-h">This Week — Problems / Conflicts</div>
    <div class="la-sub">What went wrong this week, where/when, and whether it cost manpower, hours, production or schedule.</div>
    ${cur.map(c=>conflictCard(c,true)).join("")||`<div class="la-sub">Nothing logged.</div>`}
    <button class="la-btn ghost wide" data-laconfadd="current" style="margin-top:8px">+ Log a problem</button></div>`;

  h+=`<div class="la-card"><div class="la-h">Upcoming GC Conflicts</div>
    <div class="la-sub">Conflicts expected in the next 3 weeks — the area/task, when, and what you need from the GC or another party. They stay until marked resolved.</div>
    ${up.map(c=>conflictCard(c,true)).join("")||`<div class="la-sub">None flagged.</div>`}
    <button class="la-btn ghost wide" data-laconfadd="upcoming" style="margin-top:8px">+ Add upcoming conflict</button></div>`;

  h+=`<div class="la-card"><button class="la-btn wide" id="laExportMine">⬇ Export my lookahead (PDF)</button></div>`;
  $("laMain").innerHTML=h;
}
function taskCard(t){
  return `<div class="la-task"><div class="t-top"><span class="t-job">${esc(t.job||"—")}</span><span class="t-men">${Number(t.headcount)||0} 👷</span></div>
    <div class="t-text">${esc(t.text||"")}</div>
    <div class="t-acts"><button class="mini" data-lataskedit="${esc(t.id)}">Edit</button>
      <button class="mini del" data-lataskdel="${esc(t.id)}">Delete</button></div></div>`;
}
function conflictCard(c, own){
  const co=isPotentialCO(c);
  const flags=[c.impMan&&"Manpower",c.impHours&&"Hours",c.impProd&&"Production",c.impSched&&"Schedule"].filter(Boolean);
  return `<div class="la-conf ${c.scope==="upcoming"?"upcoming":""} ${co?"co":""}">
    <div class="c-head"><span class="c-type">${esc(c.type||"Other")}</span><span class="c-job">${esc(c.job||"")}</span></div>
    <div class="c-meta">${esc(c.where||"")}${c.when?` · ${esc(c.when)}`:""}${c.scope==="upcoming"&&c.resolved?` · <b style="color:var(--green)">resolved</b>`:""}</div>
    <div class="c-what">${esc(c.what||"")}</div>
    ${c.scope==="upcoming"&&c.need?`<div class="c-what"><b>Needs:</b> ${esc(c.need)}</div>`:""}
    <div class="c-flags">${flags.map(f=>`<span class="la-badge">${f}</span>`).join("")}
      ${(c.hours>0)?`<span class="la-badge">${c.hours} hrs lost</span>`:""}${(c.days>0)?`<span class="la-badge">${c.days} days</span>`:""}
      ${co?`<span class="la-badge co">possible change order</span>`:""}
      ${c.pmStatus==="co"?`<span class="la-badge co">PM: change order</span>`:c.pmStatus==="notco"?`<span class="la-badge ok">PM: not a CO</span>`:c.pmStatus==="review"?`<span class="la-badge">PM: reviewing</span>`:""}</div>
    ${own?`<div class="t-acts" style="margin-top:7px">${c.scope==="upcoming"?`<button class="mini" data-laconfresolve="${esc(c.id)}">${c.resolved?"Reopen":"Mark resolved"}</button>`:""}
      <button class="mini" data-laconfedit="${esc(c.id)}">Edit</button><button class="mini del" data-laconfdel="${esc(c.id)}">Delete</button></div>`:""}</div>`;
}
// A conflict is a possible change order when it cost labor, time or schedule.
function isPotentialCO(c){ return !!(c.impMan||c.impHours||c.impSched||Number(c.hours)>0||Number(c.days)>0); }

/* ---------------- HISTORY (foreman) ---------------- */
function renderHistory(){
  const weeks=LA_WEEKS.filter(w=>w.foremanId===USER.id && w.weekStart<CUR_WEEK).sort((a,b)=>b.weekStart<a.weekStart?-1:1);
  if(!weeks.length){ $("laMain").innerHTML=`<div class="la-empty"><div class="ico">🗂️</div><h3>No history yet</h3><p>Your past weeks show up here once a new week begins.</p></div>`; return; }
  const sel=histWeek||weeks[0].weekStart;
  const w=weeks.find(x=>x.weekStart===sel)||weeks[0];
  let h=`<div class="la-card"><div class="la-h">Previous Weeks</div>
    <select class="la-sel" id="laHistPick">${weeks.map(x=>`<option value="${x.weekStart}" ${x.weekStart===sel?"selected":""}>Week of ${esc(weekRangeLabel(x.weekStart))}</option>`).join("")}</select></div>`;
  h+=`<div class="la-card"><div class="la-h">Tasks</div><div class="la-weeks">`;
  for(let n=1;n<=3;n++){ const ts=(w.tasks||[]).filter(t=>t.week===n);
    h+=`<div class="la-week w${n}"><div class="la-week-h"><span>Week ${n}</span></div><div class="la-week-body">${ts.map(t=>taskCard(t).replace(/data-latask(edit|del)="[^"]*"/g,"disabled")).join("")||`<div class="la-sub">—</div>`}</div></div>`; }
  h+=`</div></div>`;
  const cs=(w.conflicts||[]);
  h+=`<div class="la-card"><div class="la-h">Problems & Conflicts that week</div>${cs.map(c=>conflictCard(c,false)).join("")||`<div class="la-sub">None.</div>`}</div>`;
  $("laMain").innerHTML=h;
  $("laHistPick").onchange=()=>{ histWeek=$("laHistPick").value; renderHistory(); };
}

/* ---------------- CONFLICTS (PM / super) ---------------- */
function renderConflicts(){
  const role=myRole();
  const canAll = role==="super";
  const showAll = role==="super" ? true : pmShowAll;
  // Latest info = current-week docs; plus any week carrying unresolved upcoming conflicts.
  const rows=[];
  LA_WEEKS.forEach(w=>{ (w.conflicts||[]).forEach(c=>{
    if(c.scope==="upcoming" && c.resolved) return;
    // only the live week for "current" actuals; upcoming can live on the current week (they roll)
    if(c.scope==="current" && w.weekStart!==CUR_WEEK) return;
    if(c.scope==="upcoming" && w.weekStart!==CUR_WEEK) return;
    rows.push({w,c});
  }); });
  const mine = rows.filter(({c})=>{ const j=LA_JOBS.find(x=>x.jobNumber===c.job); return j?isPmOf(j):false; });
  const shown = showAll ? rows : mine;
  let h=`<div class="la-card"><div class="la-h">Conflicts & Potential Change Orders</div>
    <div class="la-sub">${role==="super"?"Every job.":"Your jobs."} Problems reported this week and upcoming conflicts. Foreman's wording is kept as the record.</div>`;
  if(role==="pm") h+=`<div class="la-row"><button class="mini ${!pmShowAll?"on":""}" data-lapm="mine">My jobs</button><button class="mini ${pmShowAll?"on":""}" data-lapm="all">All jobs</button></div>`;
  h+=`<button class="la-btn soft" id="laExportConf" style="margin-top:10px">⬇ Export conflict log (Excel)</button></div>`;
  const cur=shown.filter(r=>r.c.scope==="current"), up=shown.filter(r=>r.c.scope==="upcoming");
  h+=`<div class="la-card"><div class="la-h">This Week's Problems</div>${cur.map(r=>pmConflict(r)).join("")||`<div class="la-sub">Nothing reported.</div>`}</div>`;
  h+=`<div class="la-card"><div class="la-h">Upcoming Conflicts</div>${up.map(r=>pmConflict(r)).join("")||`<div class="la-sub">None.</div>`}</div>`;
  $("laMain").innerHTML=h;
}
function pmConflict({w,c}){
  const co=isPotentialCO(c);
  const canTriage = myRole()==="pm" || myRole()==="super";
  const flags=[c.impMan&&"Manpower",c.impHours&&"Hours",c.impProd&&"Production",c.impSched&&"Schedule"].filter(Boolean);
  const pms=(LA_JOBS.find(j=>j.jobNumber===c.job)?.pms||[]).map(p=>p.name).join(", ");
  return `<div class="la-conf ${c.scope==="upcoming"?"upcoming":""} ${co?"co":""}">
    <div class="c-head"><span class="c-type">${esc(c.type||"Other")} <span class="c-job">${esc(c.job||"")}</span></span>
      <span class="c-meta">${esc(w.foremanName||"")} · ${esc(TRADES[w.trade]||"")}</span></div>
    <div class="c-meta">${esc(c.where||"")}${c.when?` · ${esc(c.when)}`:""}${pms?` · PM: ${esc(pms)}`:""}</div>
    <div class="c-what">${esc(c.what||"")}</div>
    ${c.scope==="upcoming"&&c.need?`<div class="c-what"><b>Needs:</b> ${esc(c.need)}</div>`:""}
    <div class="c-flags">${flags.map(f=>`<span class="la-badge">${f}</span>`).join("")}
      ${(c.hours>0)?`<span class="la-badge">${c.hours} hrs</span>`:""}${(c.days>0)?`<span class="la-badge">${c.days} days</span>`:""}
      ${co?`<span class="la-badge co">possible change order</span>`:""}</div>
    ${canTriage?`<div class="t-acts" style="margin-top:8px">
      <button class="mini ${c.pmStatus==="review"?"on":""}" data-lapmtag="${w.id}|${c.id}|review">Reviewing</button>
      <button class="mini ${c.pmStatus==="co"?"on":""}" data-lapmtag="${w.id}|${c.id}|co">Change order</button>
      <button class="mini ${c.pmStatus==="notco"?"on":""}" data-lapmtag="${w.id}|${c.id}|notco">Not a CO</button>
      ${c.scope==="upcoming"?`<button class="mini" data-lapmresolve="${w.id}|${c.id}">${c.resolved?"Reopen":"Resolved"}</button>`:""}</div>`:""}</div>`;
}

/* ---------------- LABOR (super) ---------------- */
function laborMatrix(){
  // job → trade → [w1,w2,w3] headcount, from every foreman's CURRENT week doc.
  const m={};
  LA_WEEKS.filter(w=>w.weekStart===CUR_WEEK).forEach(w=>{
    (w.tasks||[]).forEach(t=>{ const job=t.job||"—", tr=w.trade||"—", k=job+"|"+tr;
      (m[k]=m[k]||{job,trade:tr,wk:[0,0,0]}).wk[(t.week||1)-1]+=Number(t.headcount)||0; });
  });
  return Object.values(m).sort((a,b)=>a.job<b.job?-1:a.job>b.job?1:(a.trade<b.trade?-1:1));
}
function renderLabor(){
  const rows=laborMatrix();
  const totals=[0,0,0]; rows.forEach(r=>r.wk.forEach((v,i)=>totals[i]+=v));
  const cell=(r,i)=>{ const v=r.wk[i], prev=i>0?r.wk[i-1]:v, jump=v>=prev+3 && v>0, big=v>=8;
    return `<td class="num ${jump?"la-jump":""} ${big?"la-big":""}">${v||""}</td>`; };
  let h=`<div class="la-card"><div class="la-h">Upcoming Labor Needs</div>
    <div class="la-sub">Headcount needed by job, trade and week, from every foreman's current lookahead. Amber = a jump from the week before or an unusually big crew.</div>
    <button class="la-btn soft" id="laExportLabor" style="margin-top:4px">⬇ Export labor report (Excel)</button></div>`;
  if(!rows.length){ h+=`<div class="la-empty"><div class="ico">👷</div><h3>No labor planned yet</h3><p>It fills in as foremen complete their lookaheads.</p></div>`; $("laMain").innerHTML=h; return; }
  h+=`<div class="la-card" style="overflow-x:auto"><table class="la-table"><thead><tr><th>Job</th><th>Trade</th>
    <th>Wk1<br><span style="font-weight:400">${esc(weekRangeLabel(weekStartN(0)))}</span></th>
    <th>Wk2<br><span style="font-weight:400">${esc(weekRangeLabel(weekStartN(1)))}</span></th>
    <th>Wk3<br><span style="font-weight:400">${esc(weekRangeLabel(weekStartN(2)))}</span></th></tr></thead><tbody>`;
  rows.forEach(r=>{ h+=`<tr><td>${esc(r.job)}</td><td>${esc(TRADES[r.trade]||r.trade)}</td>${cell(r,0)}${cell(r,1)}${cell(r,2)}</tr>`; });
  h+=`<tr><td colspan="2"><b>All trades</b></td><td class="num">${totals[0]}</td><td class="num">${totals[1]}</td><td class="num">${totals[2]}</td></tr>`;
  h+=`</tbody></table></div>`;
  $("laMain").innerHTML=h;
}

/* ---------------- JOBS (pm / super) ---------------- */
function renderJobs(){
  const role=myRole();
  const jobs=(role==="pm" && !pmShowAll) ? LA_JOBS.filter(isPmOf) : LA_JOBS.slice();
  jobs.sort((a,b)=>a.jobNumber<b.jobNumber?-1:1);
  let h=`<div class="la-card"><div class="la-h">Jobs</div>
    ${role==="pm"?`<div class="la-row"><button class="mini ${!pmShowAll?"on":""}" data-lapm="mine">My jobs</button><button class="mini ${pmShowAll?"on":""}" data-lapm="all">All jobs</button></div>`:""}</div>`;
  if(!jobs.length){ h+=`<div class="la-empty"><div class="ico">📁</div><h3>No jobs</h3></div>`; $("laMain").innerHTML=h; return; }
  jobs.forEach(j=>{ h+=`<div class="la-card"><div class="c-head"><span class="c-type">${esc(j.jobNumber)} <span class="la-sub">${esc(j.jobName||"")}</span></span>${j.sample?`<span class="la-badge sample">sample</span>`:""}</div>
    <div class="la-sub" style="margin-top:6px"><b>PMs:</b> ${esc((j.pms||[]).map(p=>p.name).join(", ")||"—")}</div>
    <div class="la-sub"><b>Foremen:</b> ${esc((j.foremen||[]).map(f=>`${f.name} (${TRADES[f.trade]||"?"})`).join(", ")||"—")}</div>
    <div class="t-acts" style="margin-top:8px"><button class="mini del" data-lajobdel="${esc(j.id)}">Delete job</button></div></div>`; });
  $("laMain").innerHTML=h;
}

/* ========================================================================== *
   MODALS for task / conflict / job entry
 * ========================================================================== */
function openModal(title, bodyHTML, after){ $("laModalTitle").textContent=title; $("laModalBody").innerHTML=bodyHTML;
  $("laModal").classList.add("show"); document.body.style.overflow="hidden"; if(after) after(); }
function closeModal(){ $("laModal").classList.remove("show"); document.body.style.overflow=""; }

function jobOptions(sel){ return jobsForForeman(USER.id).map(j=>`<option value="${esc(j.jobNumber)}" ${j.jobNumber===sel?"selected":""}>${esc(j.jobNumber)} · ${esc(j.jobName||"")}</option>`).join(""); }

function taskModal(week, existing){
  const t=existing||{week,job:(jobsForForeman(USER.id)[0]||{}).jobNumber||"",text:"",headcount:1};
  openModal(existing?"Edit task":"Add task", `
    <div class="la-field"><label>Job</label><select class="la-sel" id="tkJob">${jobOptions(t.job)}</select></div>
    <div class="la-field"><label>Week</label><select class="la-sel" id="tkWeek">
      <option value="1" ${t.week===1?"selected":""}>Week 1 (this week)</option>
      <option value="2" ${t.week===2?"selected":""}>Week 2</option>
      <option value="3" ${t.week===3?"selected":""}>Week 3</option></select></div>
    <div class="la-field"><label>Task / activity</label><textarea class="la-ta" id="tkText" placeholder="What needs to happen">${esc(t.text||"")}</textarea></div>
    <div class="la-field"><label>Manpower (headcount)</label><input class="la-in" id="tkMen" type="number" min="0" value="${Number(t.headcount)||0}"></div>
    <button class="la-btn wide" id="tkSave">Save task</button>`, ()=>{
    if(!jobsForForeman(USER.id).length){ $("laModalBody").innerHTML=`<div class="la-notice">Add a job first, then add tasks to it.</div>`; return; }
    $("tkSave").onclick=async()=>{ const w=myWeek(CUR_WEEK); if(!w){ toast("Loading…"); return; }
      const row={id:existing?existing.id:rid(), job:$("tkJob").value, week:Number($("tkWeek").value), text:$("tkText").value.trim(), headcount:Number($("tkMen").value)||0};
      if(!row.text){ toast("Enter the task"); return; }
      w.tasks=w.tasks||[]; const i=w.tasks.findIndex(x=>x.id===row.id); if(i>=0) w.tasks[i]=row; else w.tasks.push(row);
      await writeWeek(w); closeModal(); render(); };
  });
}
function conflictModal(scope, existing){
  const c=existing||{scope,job:(jobsForForeman(USER.id)[0]||{}).jobNumber||"",type:"GC",what:"",where:"",when:"",need:"",impMan:false,impHours:false,impProd:false,impSched:false,hours:0,days:0,resolved:false};
  const up=scope==="upcoming";
  openModal(existing?"Edit conflict":(up?"Upcoming GC conflict":"Log a problem"), `
    <div class="la-field"><label>Job</label><select class="la-sel" id="cfJob">${jobOptions(c.job)}</select></div>
    <div class="la-field"><label>Type</label><select class="la-sel" id="cfType">${CONFLICT_TYPES.map(x=>`<option ${x===c.type?"selected":""}>${esc(x)}</option>`).join("")}</select></div>
    <div class="la-field"><label>What happened / is expected</label><textarea class="la-ta" id="cfWhat">${esc(c.what||"")}</textarea></div>
    <div class="la-row"><div class="la-field" style="flex:1"><label>Where (area)</label><input class="la-in" id="cfWhere" value="${esc(c.where||"")}"></div>
      <div class="la-field" style="flex:1"><label>When</label><input class="la-in" id="cfWhen" value="${esc(c.when||"")}" placeholder="${up?"e.g. Week 2":"e.g. Tue"}"></div></div>
    ${up?`<div class="la-field"><label>What's needed from GC / others to proceed</label><textarea class="la-ta" id="cfNeed">${esc(c.need||"")}</textarea></div>`:`
    <div class="la-field"><label>Impact</label><div class="la-chips">
      ${[["impMan","Manpower"],["impHours","Labor hours"],["impProd","Production"],["impSched","Schedule"]].map(([k,l])=>`<button type="button" class="mini ${c[k]?"on":""}" data-cfflag="${k}">${l}</button>`).join("")}</div></div>
    <div class="la-row"><div class="la-field" style="flex:1"><label>Hours lost</label><input class="la-in" id="cfHours" type="number" min="0" value="${Number(c.hours)||0}"></div>
      <div class="la-field" style="flex:1"><label>Days impacted</label><input class="la-in" id="cfDays" type="number" min="0" value="${Number(c.days)||0}"></div></div>`}
    <button class="la-btn wide" id="cfSave">Save</button>`, ()=>{
    if(!jobsForForeman(USER.id).length){ $("laModalBody").innerHTML=`<div class="la-notice">Add a job first.</div>`; return; }
    const flags={...c};
    $("laModalBody").querySelectorAll("[data-cfflag]").forEach(b=>b.onclick=()=>{ const k=b.dataset.cfflag; flags[k]=!flags[k]; b.classList.toggle("on",flags[k]); });
    $("cfSave").onclick=async()=>{ const w=myWeek(CUR_WEEK); if(!w) return;
      const row={ id:existing?existing.id:rid(), scope, job:$("cfJob").value, type:$("cfType").value,
        what:$("cfWhat").value.trim(), where:$("cfWhere").value.trim(), when:$("cfWhen").value.trim(),
        resolved:!!c.resolved, pmStatus:c.pmStatus||"", createdAt:c.createdAt||Date.now() };
      if(up){ row.need=($("cfNeed").value||"").trim(); }
      else { row.impMan=!!flags.impMan; row.impHours=!!flags.impHours; row.impProd=!!flags.impProd; row.impSched=!!flags.impSched;
             row.hours=Number($("cfHours").value)||0; row.days=Number($("cfDays").value)||0; }
      if(!row.what){ toast("Describe it"); return; }
      w.conflicts=w.conflicts||[]; const i=w.conflicts.findIndex(x=>x.id===row.id); if(i>=0) w.conflicts[i]=row; else w.conflicts.push(row);
      await writeWeek(w); closeModal(); render(); };
  });
}
function addJobModal(){
  const pmPeople=PEOPLE.filter(p=>p.laRole==="pm").map(p=>({id:p.id,name:(p.first+" "+p.last).trim()}));
  const existing=LA_JOBS.map(j=>`<option value="${esc(j.jobNumber)}">`).join("");
  openModal("Add a job", `
    <div class="la-field"><label>Job number</label><input class="la-in" id="jbNum" list="jbList" placeholder="e.g. 25-0150"><datalist id="jbList">${existing}</datalist></div>
    <div class="la-field"><label>Job name</label><input class="la-in" id="jbName" placeholder="e.g. Riverside Medical"></div>
    <div class="la-field"><label>Project Manager(s)</label>
      <select class="la-sel" id="jbPmPick"><option value="">Choose a PM…</option>${pmPeople.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</select>
      <div class="la-row" style="margin-top:6px"><input class="la-in" id="jbPmNew" placeholder="…or type a new PM name" style="flex:1"><button class="la-btn soft" id="jbPmAdd" type="button">Add</button></div>
      <div class="la-chips" id="jbPmChips" style="margin-top:8px"></div></div>
    <div class="la-sub">If this job already exists, you'll join it and keep its current PMs. You can add more — a job can have several.</div>
    <button class="la-btn wide" id="jbSave" style="margin-top:10px">Save job</button>`, ()=>{
    let pms=[];
    const draw=()=>{ $("jbPmChips").innerHTML=pms.map((p,i)=>`<span class="la-chip">${esc(p.name)}<button data-rmpm="${i}">✕</button></span>`).join("");
      $("jbPmChips").querySelectorAll("[data-rmpm]").forEach(b=>b.onclick=()=>{ pms.splice(Number(b.dataset.rmpm),1); draw(); }); };
    const addPm=(id,name)=>{ name=(name||"").trim(); if(!name) return; const key=nameNorm2(name);
      if(pms.some(p=>nameNorm2(p.name)===key)) return; pms.push({id:id||"",name}); draw(); };
    $("jbNum").onchange=()=>{ const ex=LA_JOBS.find(j=>j.jobNumber===normJob($("jbNum").value)); if(ex){ $("jbName").value=ex.jobName||""; pms=(ex.pms||[]).map(p=>({...p})); draw(); } };
    $("jbPmPick").onchange=()=>{ const p=pmPeople.find(x=>x.id===$("jbPmPick").value); if(p){ addPm(p.id,p.name); $("jbPmPick").value=""; } };
    $("jbPmAdd").onclick=()=>{ addPm("", $("jbPmNew").value); $("jbPmNew").value=""; };
    $("jbSave").onclick=async()=>{ const num=normJob($("jbNum").value); if(!num){ toast("Enter a job number"); return; }
      const ex=LA_JOBS.find(j=>j.jobNumber===num);
      const me={id:USER.id,name:(USER.first+" "+USER.last).trim(),trade:myTrade()};
      const foremen=[...((ex&&ex.foremen)||[])]; if(!foremen.some(f=>f.id===me.id)) foremen.push(me);
      // merge PMs (inherited + any added), dedup by name
      const merged=[...((ex&&ex.pms)||[])]; pms.forEach(p=>{ if(!merged.some(m=>nameNorm2(m.name)===nameNorm2(p.name))) merged.push(p); });
      const rec={ jobNumber:num, jobName:$("jbName").value.trim()||(ex&&ex.jobName)||"", pms:merged, foremen,
        updatedAt:serverTimestamp(), createdAt:(ex&&ex.createdAt)||serverTimestamp() };
      try{ await setDoc(doc(db,"laJobs",num), rec, {merge:true}); closeModal(); render(); toast("Job saved"); }
      catch(e){ fbNote(e,"saveJob"); toast("Couldn't save: "+saveMsg(e)); } };
  });
}

/* ========================================================================== *
   DELEGATED EVENTS
 * ========================================================================== */
document.addEventListener("click", e=>{
  const tabBtn=e.target.closest("[data-latab]"); if(tabBtn){ TAB=tabBtn.dataset.latab; render(); return; }
  if(e.target.closest("[data-laclose]")){ closeModal(); return; }
  if(e.target===$("laModal")){ closeModal(); return; }

  const w=myWeek(CUR_WEEK);
  const ta=e.target.closest("[data-lataskadd]"); if(ta){ taskModal(Number(ta.dataset.lataskadd)); return; }
  const te=e.target.closest("[data-lataskedit]"); if(te && w){ taskModal(null, (w.tasks||[]).find(t=>t.id===te.dataset.lataskedit)); return; }
  const td=e.target.closest("[data-lataskdel]"); if(td && w){ const t=(w.tasks||[]).find(x=>x.id===td.dataset.lataskdel);
    if(t && confirm("Delete this task?")){ w.tasks=w.tasks.filter(x=>x.id!==t.id); writeWeek(w).then(render); } return; }

  const ca=e.target.closest("[data-laconfadd]"); if(ca){ conflictModal(ca.dataset.laconfadd); return; }
  const ce=e.target.closest("[data-laconfedit]"); if(ce && w){ const c=(w.conflicts||[]).find(x=>x.id===ce.dataset.laconfedit); conflictModal(c.scope,c); return; }
  const cd=e.target.closest("[data-laconfdel]"); if(cd && w){ const c=(w.conflicts||[]).find(x=>x.id===cd.dataset.laconfdel);
    if(c && confirm("Delete this conflict?")){ w.conflicts=w.conflicts.filter(x=>x.id!==c.id); writeWeek(w).then(render); } return; }
  const cr=e.target.closest("[data-laconfresolve]"); if(cr && w){ const c=(w.conflicts||[]).find(x=>x.id===cr.dataset.laconfresolve);
    if(c){ c.resolved=!c.resolved; writeWeek(w).then(render); } return; }

  if(e.target.closest("#laAddJob")){ addJobModal(); return; }
  const jl=e.target.closest("[data-lajobleave]"); if(jl){ leaveJob(jl.dataset.lajobleave); return; }
  const jd=e.target.closest("[data-lajobdel]"); if(jd){ const j=LA_JOBS.find(x=>x.id===jd.dataset.lajobdel);
    if(j) canDelete(j.sample?"__sample__":( (j.foremen||[]).every(f=>f.id===USER.id)?USER.id:"__other__"), ()=>{
      if(!confirm(`Delete job ${j.jobNumber}? This removes it for everyone.`)) return;
      deleteDoc(doc(db,"laJobs",j.id)).then(()=>toast("Job deleted")).catch(er=>toast("Couldn't: "+saveMsg(er))); }); return; }

  const pm=e.target.closest("[data-lapm]"); if(pm){ pmShowAll=pm.dataset.lapm==="all"; render(); return; }
  const tag=e.target.closest("[data-lapmtag]"); if(tag){ pmTag(tag.dataset.lapmtag); return; }
  const pr=e.target.closest("[data-lapmresolve]"); if(pr){ pmResolve(pr.dataset.lapmresolve); return; }

  if(e.target.closest("#laExportLabor")) exportLabor();
  if(e.target.closest("#laExportConf")) exportConflicts();
  if(e.target.closest("#laExportMine")) exportLookaheadPdf(USER.id);
});

/* ---------- foreman leaves a job (own membership — free) ---------- */
async function leaveJob(jobId){
  const j=LA_JOBS.find(x=>x.id===jobId); if(!j) return;
  if(!confirm(`Remove ${j.jobNumber} from your jobs?`)) return;
  const foremen=(j.foremen||[]).filter(f=>f.id!==USER.id);
  try{ await setDoc(doc(db,"laJobs",j.id),{foremen,updatedAt:serverTimestamp()},{merge:true}); render(); }catch(e){ fbNote(e,"leaveJob"); }
}
/* ---------- PM triage (annotation only — never edits the foreman's words) ---------- */
async function pmTag(combo){ const [wid,cid,status]=combo.split("|"); const w=LA_WEEKS.find(x=>x.id===wid); if(!w) return;
  const c=(w.conflicts||[]).find(x=>x.id===cid); if(!c) return; c.pmStatus=c.pmStatus===status?"":status;
  try{ await setDoc(doc(db,"laWeeks",w.id),{conflicts:w.conflicts,updatedAt:serverTimestamp()},{merge:true}); render(); }catch(e){ fbNote(e,"pmTag"); } }
async function pmResolve(combo){ const [wid,cid]=combo.split("|"); const w=LA_WEEKS.find(x=>x.id===wid); if(!w) return;
  const c=(w.conflicts||[]).find(x=>x.id===cid); if(!c) return; c.resolved=!c.resolved;
  try{ await setDoc(doc(db,"laWeeks",w.id),{conflicts:w.conflicts,updatedAt:serverTimestamp()},{merge:true}); render(); }catch(e){ fbNote(e,"pmResolve"); } }

/* ========================================================================== *
   SAMPLE COMPANY
   Auto-seeded once on a fresh database so the full scale is visible from day one. Loading and
   removing it is done from the main app's Admin (Manage People → Look-Ahead) via lookahead-data.js;
   here we only kick off that first auto-seed.
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
  const aoa=[["Job","Trade",`Week 1 (${weekRangeLabel(weekStartN(0))})`,`Week 2 (${weekRangeLabel(weekStartN(1))})`,`Week 3 (${weekRangeLabel(weekStartN(2))})`]];
  rows.forEach(r=>aoa.push([r.job,TRADES[r.trade]||r.trade,r.wk[0],r.wk[1],r.wk[2]]));
  const tot=[0,0,0]; rows.forEach(r=>r.wk.forEach((v,i)=>tot[i]+=v)); aoa.push(["TOTAL","",tot[0],tot[1],tot[2]]);
  const ws=XLSX.utils.aoa_to_sheet(aoa), wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,ws,"Labor Needs");
  XLSX.writeFile(wb,`Labor_Needs_${CUR_WEEK}.xlsx`);
}
function exportConflicts(){
  if(!xlsxReady()){ toast("Report tools still loading — try again"); return; }
  const aoa=[["Week of","Job","Trade","Foreman","Scope","Type","What","Where","When","Manpower","Hours","Production","Schedule","Hrs lost","Days","Needs","Possible CO","PM status","Resolved"]];
  LA_WEEKS.filter(w=>w.weekStart===CUR_WEEK).forEach(w=>(w.conflicts||[]).forEach(c=>{
    aoa.push([w.weekStart,c.job,TRADES[w.trade]||w.trade,w.foremanName,c.scope,c.type,c.what,c.where,c.when,
      c.impMan?"Y":"",c.impHours?"Y":"",c.impProd?"Y":"",c.impSched?"Y":"",c.hours||"",c.days||"",c.need||"",
      isPotentialCO(c)?"YES":"",c.pmStatus||"",c.resolved?"Y":""]);
  }));
  const ws=XLSX.utils.aoa_to_sheet(aoa), wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,ws,"Conflicts");
  XLSX.writeFile(wb,`Conflicts_${CUR_WEEK}.xlsx`);
}
function exportLookaheadPdf(foremanId){
  if(!jspdfReady()){ toast("Report tools still loading — try again"); return; }
  const w=LA_WEEKS.find(x=>x.foremanId===foremanId && x.weekStart===CUR_WEEK); if(!w){ toast("Nothing to export yet"); return; }
  const { jsPDF }=window.jspdf; const d=new jsPDF({unit:"pt",format:"letter"}); const M=40; let y=M; const PW=d.internal.pageSize.getWidth();
  const need=h=>{ if(y+h>d.internal.pageSize.getHeight()-M){ d.addPage(); y=M; } };
  d.setFont("helvetica","bold").setFontSize(15); d.text("3-Week Look-Ahead",M,y+6);
  d.setFontSize(10).setFont("helvetica","normal"); d.text(`${w.foremanName} · ${TRADES[w.trade]||""} · Week of ${weekRangeLabel(CUR_WEEK)}`,M,y+22); y+=40;
  for(let n=1;n<=3;n++){ need(30); d.setFont("helvetica","bold").setFontSize(12); d.text(`Week ${n}${n===1?" (this week)":""} — ${weekRangeLabel(weekStartN(n-1))}`,M,y); y+=16;
    d.setFontSize(9).setFont("helvetica","normal");
    const ts=(w.tasks||[]).filter(t=>t.week===n); if(!ts.length){ d.setTextColor(130); d.text("— no tasks —",M,y); d.setTextColor(0); y+=14; }
    ts.forEach(t=>{ const lines=d.splitTextToSize(`[${t.job}]  ${t.text}  (${t.headcount} 👷)`.replace(/👷/g,"ppl"),PW-M*2); need(lines.length*12+4); d.text(lines,M,y); y+=lines.length*12+4; }); y+=8; }
  const cs=(w.conflicts||[]); if(cs.length){ need(24); d.setFont("helvetica","bold").setFontSize(12); d.text("Conflicts",M,y); y+=16; d.setFontSize(9).setFont("helvetica","normal");
    cs.forEach(c=>{ const tag=c.scope==="upcoming"?"UPCOMING":"THIS WEEK"; const lines=d.splitTextToSize(`[${tag} · ${c.job} · ${c.type}] ${c.what} ${c.where?("("+c.where+")"):""}${isPotentialCO(c)?"  **possible CO**":""}`,PW-M*2); need(lines.length*12+4); d.text(lines,M,y); y+=lines.length*12+4; }); }
  d.save(`Lookahead_${w.foremanName.replace(/[^A-Za-z0-9]+/g,"-")}_${CUR_WEEK}.pdf`);
}

/* ---------- boot ---------- */
render(); startSync();
window.__laDebug={ get people(){return PEOPLE;}, get jobs(){return LA_JOBS;}, get weeks(){return LA_WEEKS;} };
