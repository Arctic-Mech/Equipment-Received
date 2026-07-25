import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getFirestore, collection, onSnapshot, doc, getDoc, setDoc, deleteDoc, writeBatch, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

/* Pure helpers, split out of this file. Relative paths so they resolve under the
   /Equipment-Received/ Pages subpath. idb.js has no callers left (photos moved to
   Firestore) but is imported so the module still loads with the rest. */
import { $ } from "./dom.js";
import { idbOpen, idbSet, idbGet, idbDel, idbKeys } from "./idb.js";
import { toast, copyToClipboard } from "./toast.js";
import { esc, normJob, isRealJob, makeId, fmtDateKey, MON, rowDate, longDate,
         todayIso, monthKey, monthLabel, rateChips, money } from "./format.js";

if(window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const firebaseConfig={apiKey:"AIzaSyBwf2lyLcJWz8qfuEHn76-tIbOm117Tltg",authDomain:"equipment-received.firebaseapp.com",projectId:"equipment-received",storageBucket:"equipment-received.firebasestorage.app",messagingSenderId:"164676400073",appId:"1:164676400073:web:552cc0e3dcc8e06951ae18"};
let db=null,fbReady=false;
try{ db=getFirestore(initializeApp(firebaseConfig)); fbReady=true; }catch(e){ console.error("FB",e); }

/* ---------- State ---------- */
let ARRIVALS=[],RENTALS=[],TOOLS=[];
let MY_JOBS=[];                     // solely Firebase-synced via people/{id} — never cached locally
const ADMIN_PIN="1977";
let adminUnlocked=sessionStorage.getItem("er_admin")==="1";
let editing=null;
let camTarget=null;                 // arrival id for camera add/replace
let PDF_META=null;                  // {pageMap, name, pages, uploadedAt}
let pdfRender={doc:null,page:1,pages:1,job:""};
let mjSeg="arrivals";
let USER=loadUser();                // {first,last,email,id} or null — editable
let PEOPLE=[];                      // people directory {id,first,last,nameNorm,email}
let SHARES=[];                      // pending shares addressed to me
let WD_EQUIP=[];                    // Webduct shop-equipment order items (synced) {docId, order#, job, dates, status, notes, label, arrivalId, matchState}
let WD_ORDERS=[];                   // Webduct orders (up to 2 months old) for the calendar {docId, number, job, dates, hasEquip, items[], orderedBy, po, ...}
let WD_NOTES={};                    // per-order notes keyed by order docId {deliveryTime, truck, extra, highlight}
let WD_LAST_SYNC=null;              // {by, at, summary} — who forced the last refresh and when
let LAST_IMPORT=null;               // {at, emailDateMs, sourceFile, count, rentals}
let LAST_TOOL_IMPORT=null;          // {at, emailDateMs, sourceFile, count, jobs}
// Absolute stamp like "7/15/26 5:42 AM" — clearer than "33 minutes ago" when you're
// trying to tell whether this morning's sheet actually landed.
function stampText(ms){
  const d=new Date(ms); if(isNaN(d)) return "";
  const date=(d.getMonth()+1)+"/"+d.getDate()+"/"+String(d.getFullYear()).slice(-2);
  let h=d.getHours(); const ap=h>=12?"PM":"AM"; h=h%12; if(h===0)h=12;
  return date+" "+h+":"+String(d.getMinutes()).padStart(2,"0")+" "+ap;
}
function timeText(d){ let h=d.getHours(); const ap=h>=12?"PM":"AM"; h=h%12; if(h===0)h=12;
  return h+":"+String(d.getMinutes()).padStart(2,"0")+" "+ap; }
function sameLocalDay(a,b){ const x=new Date(a),y=new Date(b);
  return x.getFullYear()===y.getFullYear() && x.getMonth()===y.getMonth() && x.getDate()===y.getDate(); }
// Mirrors the GitHub Actions cron (UTC): every 5 min 12:00-15:59, then :00/:30 16:00-17:59,
// Mon-Fri only. Returns the next scheduled attempt as a local Date, or null.
const DOW=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
function nextPollAt(fromMs){
  const start=new Date(fromMs||Date.now());
  for(let d=0; d<8; d++){
    const day=new Date(start.getTime()+d*86400000);
    const dow=day.getUTCDay();
    if(dow<1||dow>5) continue;                    // weekdays only
    const slots=[];
    for(let h=12; h<=15; h++) for(let m=0;m<60;m+=5) slots.push([h,m]);
    for(let h=16; h<=17; h++) for(const m of [0,30]) slots.push([h,m]);
    for(const [h,m] of slots){
      const t=new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, m, 0));
      if(t.getTime()>start.getTime()) return t;
    }
  }
  return null;
}
function nextPollText(){
  const t=nextPollAt(); if(!t) return "";
  const today=sameLocalDay(t, Date.now());
  return "Next check "+(today?"":DOW[t.getDay()]+" ")+timeText(t);
}
function importLine(el, info, label, showNext){
  if(!el) return;
  const nxt=showNext?nextPollText():"";
  if(!info || !info.at){
    if(!showNext){ el.style.display="none"; return; }   // nothing yet and not the one we chase
    el.innerHTML=`<b>Not updated yet</b>${nxt?`<span class="ai-next">${wdEsc(nxt)}</span>`:""}`;
    el.style.display="block"; return;
  }
  const from=info.emailDateMs?` · emailed ${stampText(info.emailDateMs)}`:"";
  const cnt=info.count?` · ${info.count.toLocaleString()} ${label}`:"";
  el.innerHTML=`<b>Last updated</b> ${wdEsc(stampText(info.at))}${wdEsc(from)}${wdEsc(cnt)}`
    +(nxt?`<span class="ai-next">${wdEsc(nxt)}</span>`:"");
  el.style.display="block";
}
function renderAutoImport(){
  // The arrivals sheet is the one we chase hard — the countdown only shows while THAT
  // is still missing for today. Once it lands, no "next check" anywhere, even if the
  // tool PDF hasn't arrived yet (we don't nag about the less critical files).
  const arrivalsToday = !!(LAST_IMPORT && LAST_IMPORT.at && sameLocalDay(LAST_IMPORT.at, Date.now()));
  const chase = !arrivalsToday;
  importLine($("autoImport"), LAST_IMPORT, "rows", chase);
  importLine($("rentImport"), LAST_IMPORT && LAST_IMPORT.rentals!=null
    ? {...LAST_IMPORT, count:LAST_IMPORT.rentals} : LAST_IMPORT, "rentals", chase);
  importLine($("toolImport"), LAST_TOOL_IMPORT, "tool lines", chase);
}
// Keep the "next check" time honest while the page sits open.
setInterval(()=>{ try{ renderAutoImport(); }catch(_){} }, 60000);
function wdRenderLastSync(){
  if(!WD_LAST_SYNC) return;
  const el=$("calLastSync"); if(!el) return;
  const ago=Math.max(0,Math.round((Date.now()-(WD_LAST_SYNC.at||0))/60000));
  const when=ago<1?"just now":ago<60?`${ago} min ago`:`${Math.round(ago/60)} hr ago`;
  el.textContent=`Last synced ${when} by ${WD_LAST_SYNC.by||"someone"}`;
}
let WD_EQNOTES={};                  // per-equipment notes keyed by equipment docId {text} — synced across pages
let calShipFilter="all";           // list filter: all | jobsite | pickup
const WD_ORDER_SCHEMA=2;           // bump to force a one-time re-sync of all orders (e.g. shipType change)
let calShowMine=false;             // calendar: false = everyone's orders, true = just mine
// User-adjustable order window (days back / days ahead from today), shared by the calendar sync
// AND the admin tester so both pull the same range. Persisted per-device. Tighter default.
let WD_WIN_BACK = parseInt(localStorage.getItem("wd_win_back")||"7",10);    // days before today
let WD_WIN_FWD  = parseInt(localStorage.getItem("wd_win_fwd") ||"30",10);   // days after today
function wdSaveWindow(back,fwd){
  WD_WIN_BACK=Math.max(0,Math.min(370,back|0)); WD_WIN_FWD=Math.max(0,Math.min(370,fwd|0));
  localStorage.setItem("wd_win_back",WD_WIN_BACK); localStorage.setItem("wd_win_fwd",WD_WIN_FWD);
}
// The ISO date range + the query string Webduct wants, from the current window.
function wdWindow(){
  const now=Date.now();
  const isoStart=new Date(now-1000*60*60*24*WD_WIN_BACK).toISOString();
  const isoEnd  =new Date(now+1000*60*60*24*WD_WIN_FWD).toISOString();
  return { isoStart, isoEnd, cutoff: now-1000*60*60*24*WD_WIN_BACK,
    qs:`?dateType=delivery&dateStart=${encodeURIComponent(isoStart)}&dateEnd=${encodeURIComponent(isoEnd)}` };
}
function wdWindowLabel(){
  const b=WD_WIN_BACK, f=WD_WIN_FWD;
  const part=(n,dir)=> n===0?"today": n%7===0?`${n/7} wk ${dir}`:`${n} day${n===1?"":"s"} ${dir}`;
  return `${part(b,"back")} → ${part(f,"ahead")}`;
}
// Push the current window values into whichever input boxes exist (calendar + tester).
function wdSyncWindowInputs(){
  [["calWinBack",WD_WIN_BACK],["wdWinBack",WD_WIN_BACK],["calWinFwd",WD_WIN_FWD],["wdWinFwd",WD_WIN_FWD]].forEach(([id,v])=>{ const el=$(id); if(el) el.value=v; });
}
const EXPANDED_WO=new Set();       // order cards left open — survives the constant Firebase re-renders
const EXPANDED_WO_CATS=new Set();  // per-order-per-group category chips that are open (key: docId|group)
const EXPANDED_WO_NOTES=new Set(); // order cards whose extra-note is expanded
const EXPANDED_WO_WT=new Set();    // order cards whose weight breakdown is shown
let shareJob=null, shareArrivalId=null, shareArrivalName="";
let VIEW_AS=null;                   // {id,first,last} — viewing someone else's My Jobs page read-only (null = viewing your own)
let PENDING_ARRIVAL=null;           // arrival id to scroll to + expand once the Arrivals tab is showing
let REMOVED_JOBS=new Set();         // jobs the user manually removed (auto-link won't re-add) — Firebase-synced
let userRecordLoaded=false;         // true once this user's people/{id} doc has been read at least once
let SEEN=loadSeen();                // {init:bool, ids:[...]} acknowledged arrival ids — per device
let JOB_ORDER=[];                   // custom My Jobs order — Firebase-synced
let reorderMode=false, dragJob=null, dragEl=null, MJ_VIEW=[];
let delivTarget=null;               // arrival id for the delivery modal
const EXPANDED_TOOLS=new Set();     // tool job cards currently open
const EXPANDED_RENTALS=new Set();   // equipment rental job cards currently open
const EXPANDED_ARR=new Set();       // arrival cards currently expanded
const EXPANDED_FOLDERS=new Set();   // My Jobs folders currently open

/* Reliable tap: fire on touchend (so a tap registers on the first try even while the
   keyboard is up) and on click for mouse, de-duplicated so it never double-fires. */
function onActivate(el,fn){ if(!el)return; let t=0; el.addEventListener("touchend",e=>{ e.preventDefault(); t=Date.now(); fn(e); },{passive:false}); el.addEventListener("click",e=>{ if(Date.now()-t<700)return; fn(e); }); }
/* Calendar-click-only date inputs: block manual typing, force the native picker open on tap/focus. */
function lockDateInputs(){
  document.querySelectorAll('input[type="date"]').forEach(el=>{
    if(el.dataset.dateLocked)return; el.dataset.dateLocked="1";
    el.setAttribute("inputmode","none");
    el.addEventListener("keydown",e=>{ if(e.key==="Tab"||e.key==="Escape")return; e.preventDefault(); });
    el.addEventListener("click",()=>{ try{ el.showPicker && el.showPicker(); }catch(err){} });
    el.addEventListener("focus",()=>{ try{ el.showPicker && el.showPicker(); }catch(err){} });
  });
}

/* ---------- Local storage (identity + notification read-state only — job lists are Firebase-only) ---------- */
function loadUser(){ try{const n=JSON.parse(localStorage.getItem("er_user")||localStorage.getItem("er_name")||"null"); return (n&&n.first)?n:null;}catch(e){return null;} }
function saveUser(){ try{localStorage.setItem("er_user",JSON.stringify(USER));}catch(e){} }
function nameNorm(first,last){ return (String(first||"")+" "+String(last||"")).toLowerCase().replace(/[^a-z0-9 ]/g,"").replace(/\s+/g," ").trim(); }
function personId(first,last){ const s=nameNorm(first,last).replace(/ /g,"-"); return "p-"+(s||Math.random().toString(36).slice(2)); }
function loadSeen(){ try{const s=JSON.parse(localStorage.getItem("er_seen")||"null"); return (s&&Array.isArray(s.ids))?{init:!!s.init,ids:new Set(s.ids)}:{init:false,ids:new Set()};}catch(e){return{init:false,ids:new Set()};} }
function saveSeen(){ try{localStorage.setItem("er_seen",JSON.stringify({init:SEEN.init,ids:[...SEEN.ids]}));}catch(e){} }

/* ---------- Name matching + auto-link ---------- */
function nameMatches(rb,first,last){
  if(!rb||!first||!last)return false;
  const norm=s=>String(s).toLowerCase().replace(/[^a-z\s.]/g," ").replace(/\s+/g," ").trim();
  const r=norm(rb),f=norm(first),l=norm(last); if(!f||!l)return false;
  const li=l[0]; const toks=r.split(" ").filter(Boolean);
  const fi=toks.indexOf(f); if(fi<0)return false;                 // full first name present
  const hasLast=toks.some((t,i)=>{ if(i===fi)return false; const tt=t.replace(/\./g,""); return tt===l||tt===li; });
  return hasLast;                                                 // last name OR last initial present
}
function autoLinkJobs(){
  if(!USER)return false;
  if(!userRecordLoaded)return false;   // wait until removedJobs has loaded from Firebase, or we'd re-add deleted jobs
  const{first,last}=USER; let added=false;
  for(const r of ARRIVALS){ const job=normJob(r.jobNumber); if(!isRealJob(job))continue; if(MY_JOBS.includes(job)||REMOVED_JOBS.has(job))continue; if(nameMatches(r.requestedBy,first,last)){ MY_JOBS.push(job); added=true; } }
  if(added){ syncUserJobs(); }
  return added;
}
// If I placed a Webduct order, that job auto-stars to My Jobs (like ordered-by does for arrivals).
function autoLinkOrderedJobs(){
  if(!USER || !userRecordLoaded) return false;
  const myEmail=(USER.email||"").toLowerCase(); if(!myEmail) return false;
  let added=false;
  for(const o of WD_ORDERS){
    const job=normJob(o.job); if(!isRealJob(job)) continue;
    if(MY_JOBS.includes(job)||REMOVED_JOBS.has(job)) continue;
    if((o.orderedByEmail||"").toLowerCase()===myEmail){ MY_JOBS.push(job); added=true; }
  }
  if(added) syncUserJobs();
  return added;
}

/* ---------- Notifications (new items on my jobs) ---------- */
function myJobItemIds(){ const ids=[]; const set=new Set(MY_JOBS); ARRIVALS.forEach(r=>{if(set.has(normJob(r.jobNumber)))ids.push("a:"+r.id);}); return ids; }
function newItemIds(){ if(!SEEN.init)return []; return myJobItemIds().filter(id=>!SEEN.ids.has(id)); }
function markSeenForJob(job){ ARRIVALS.forEach(r=>{if(normJob(r.jobNumber)===job)SEEN.ids.add("a:"+r.id);}); SEEN.init=true; saveSeen(); }
function clearJobNotif(job){ if(!confirm(`Clear the new-arrival alert for job ${job}?`))return; markSeenForJob(job); updateNotif(); renderJobs(); }
function clearOneNotif(id){ if(!confirm("Clear this new-arrival alert?"))return; SEEN.ids.add("a:"+id); SEEN.init=true; saveSeen(); updateNotif(); renderJobs(); }
function updateNotif(){
  if(!SEEN.init && ARRIVALS.length){ SEEN.ids=new Set(myJobItemIds()); SEEN.init=true; saveSeen(); }
  const news=new Set(newItemIds());
  const badge=$("jobsNotif"); if(badge){ badge.textContent=news.size>99?"99+":news.size; badge.classList.toggle("show",news.size>0); }
  const banner=$("notifBanner");
  if(banner){ if(news.size>0){ banner.classList.add("show"); $("notifTxt").textContent=`${news.size} new ${news.size===1?"arrival":"arrivals"} on your jobs. Open a job to clear it.`; } else banner.classList.remove("show"); }
  return news;
}
function clearNotif(){ if(!confirm("Clear all new-arrival alerts on My Jobs?"))return; SEEN.ids=new Set(myJobItemIds()); SEEN.init=true; saveSeen(); updateNotif(); renderJobs(); toast("All cleared"); }

/* ---------- Sync ---------- */
const APP_VERSION="7.5";
function setSync(s){ const d=$("syncDot"); d.className="sync-dot "+(s==="live"?"live":s==="err"?"err":""); $("syncTxt").textContent=s==="live"?("Live V"+APP_VERSION):s==="err"?"Offline":"Connecting"; }
function startSync(){
  if(!fbReady){ setSync("err"); showErr("feedList"); showErr("rentList"); showErr("toolList"); return; }
  onSnapshot(collection(db,"arrivals"),snap=>{ const l=[]; snap.forEach(d=>{const v=d.data(); const deliveredDate=v.deliveredDate||v.deliveryDate||""; l.push({id:d.id,dateReceived:v.dateReceived||"",po:v.po||"",jobNumber:v.jobNumber||"",jobName:v.jobName||"",description:v.description||"",supplier:v.supplier||"",reqDeliv:v.reqDeliv||"",delivered:(v.delivered!=null?!!v.delivered:!!deliveredDate),deliveredDate:deliveredDate,partial:!!v.partial,storageLocation:v.storageLocation||"",requestedBy:v.requestedBy||"",photoBy:v.photoBy||"",seq:v.seq||0});}); l.sort((a,b)=>a.dateReceived!==b.dateReceived?(a.dateReceived<b.dateReceived?1:-1):(b.seq||0)-(a.seq||0)); ARRIVALS=l; setSync("live"); autoLinkJobs(); renderAll(); }, e=>{console.error(e); setSync("err"); showErr("feedList",e.code);});
  onSnapshot(collection(db,"rentals"),snap=>{ const l=[]; snap.forEach(d=>{const v=d.data(); l.push({id:d.id,rentalId:v.rentalId||"",jobNumber:v.jobNumber||"",jobName:v.jobName||"",equipment:v.equipment||"",rate:v.rate||"",vendor:v.vendor||"",dateRented:v.dateRented||"",status:v.status||"Renting",dateReturned:v.dateReturned||"",orderedBy:v.orderedBy||"",po:v.po||"",seq:v.seq||0});}); l.sort((a,b)=>a.dateRented!==b.dateRented?(a.dateRented<b.dateRented?1:-1):(b.seq||0)-(a.seq||0)); RENTALS=l; renderRentals(); renderJobs(); renderEricStats(); }, e=>{console.error(e); showErr("rentList",e.code);});
  onSnapshot(collection(db,"toolRentals"),snap=>{ const l=[]; snap.forEach(d=>{const v=d.data(); l.push({id:d.id,jobNumber:v.jobNumber||"",jobName:v.jobName||"",jobClosed:!!v.jobClosed,toolType:v.toolType||"",toolId:v.toolId||"",rentalStarted:v.rentalStarted||"",rentalEnded:v.rentalEnded||"",billingDays:v.billingDays||0,dailyRate:v.dailyRate||0,billingTotal:v.billingTotal||"",discountedRate:v.discountedRate||"",status:v.status||(v.rentalEnded?"Returned":"Out"),seq:v.seq||0});}); l.sort((a,b)=>a.rentalStarted!==b.rentalStarted?(a.rentalStarted<b.rentalStarted?1:-1):(b.seq||0)-(a.seq||0)); TOOLS=l; renderTools(); renderJobs(); renderEricStats(); }, e=>{console.error(e); showErr("toolList",e.code);});
  onSnapshot(doc(db,"pdfStore","meta"),d=>{ PDF_META=d.exists()?d.data():null; pdfRender.doc=null; renderTools(); renderJobs(); }, e=>console.error("pdfmeta",e));
  onSnapshot(collection(db,"people"),snap=>{ const l=[]; snap.forEach(d=>{const v=d.data(); l.push({id:d.id,first:v.first||"",last:v.last||"",nameNorm:v.nameNorm||"",email:v.email||"",access:v.access||"",perms:v.perms||null,savedJobs:v.savedJobs||null,removedJobs:v.removedJobs||null,jobOrder:v.jobOrder||null});}); PEOPLE=l; onPeople(); resolvePendingHash(); if(typeof applyAccess==="function")applyAccess(); if(typeof renderPeople==="function" && $("peopleModal") && $("peopleModal").classList.contains("show")) renderPeople(); }, e=>console.error("people",e));
  onSnapshot(collection(db,"shares"),snap=>{ const l=[]; snap.forEach(d=>{const v=d.data(); l.push({id:d.id,toId:v.toId||"",toName:v.toName||"",fromName:v.fromName||"",jobNumber:v.jobNumber||"",jobName:v.jobName||"",status:v.status||"pending"});}); SHARES=l; renderJobs(); }, e=>console.error("shares",e));
  onSnapshot(collection(db,"webductEquip"),snap=>{ const l=[]; snap.forEach(d=>{const v=d.data(); l.push({docId:d.id, ...v});}); WD_EQUIP=l; renderDeliveries(); renderFeed(); }, e=>console.error("webductEquip",e));
  onSnapshot(collection(db,"webductOrders"),snap=>{ const l=[]; snap.forEach(d=>{const v=d.data(); l.push({docId:d.id, ...v});}); WD_ORDERS=l; if(typeof autoLinkOrderedJobs==="function") autoLinkOrderedJobs(); renderDeliveries(); }, e=>console.error("webductOrders",e));
  onSnapshot(doc(db,"config","lastSync"),snap=>{ if(snap.exists()){ WD_LAST_SYNC=snap.data(); wdRenderLastSync(); } }, e=>console.error("lastSync",e));
  onSnapshot(doc(db,"config","lastImport"),snap=>{ if(snap.exists()){ LAST_IMPORT=snap.data(); renderAutoImport(); } }, e=>console.error("lastImport",e));
  onSnapshot(doc(db,"config","lastToolImport"),snap=>{ if(snap.exists()){ LAST_TOOL_IMPORT=snap.data(); renderAutoImport(); } }, e=>console.error("lastToolImport",e));
  onSnapshot(doc(db,"config","ghActions"),snap=>{ GH_CFG=snap.exists()?snap.data():null; ghRenderBtn(); }, e=>console.error("ghActions",e));
  onSnapshot(collection(db,"webductOrderNotes"),snap=>{ WD_NOTES={}; snap.forEach(d=>{ WD_NOTES[d.id]=d.data(); }); renderDeliveries(); }, e=>console.error("webductOrderNotes",e));
  onSnapshot(collection(db,"webductEquipNotes"),snap=>{ WD_EQNOTES={}; snap.forEach(d=>{ WD_EQNOTES[d.id]=d.data(); }); renderDeliveries(); renderFeed(); if(typeof renderJobs==="function")renderJobs(); }, e=>console.error("webductEquipNotes",e));
  wdWatchAdminKey();
}
let lastJobEdit=0;
function onPeople(){
  if(!USER)return; const me=PEOPLE.find(p=>p.id===USER.id); if(!me)return;
  if(me.email && me.email!==USER.email){ USER.email=me.email; saveUser(); }
  if(Date.now()-lastJobEdit < 1800) return;   // don't clobber a fresh local edit before it round-trips
  let changed=false;
  const sj=Array.isArray(me.savedJobs)?me.savedJobs:[]; if(JSON.stringify(sj)!==JSON.stringify(MY_JOBS)){ MY_JOBS=sj.slice(); changed=true; }
  const rj=Array.isArray(me.removedJobs)?me.removedJobs:[]; if(JSON.stringify(rj)!==JSON.stringify([...REMOVED_JOBS])){ REMOVED_JOBS=new Set(rj); changed=true; }
  const jo=Array.isArray(me.jobOrder)?me.jobOrder:[]; if(JSON.stringify(jo)!==JSON.stringify(JOB_ORDER)){ JOB_ORDER=jo.slice(); changed=true; }
  const firstLoad=!userRecordLoaded; userRecordLoaded=true;
  if(firstLoad){ if(autoLinkJobs())changed=true; }   // now that removedJobs is known, it's safe to auto-link
  if(changed) renderJobs();
}
function syncUserJobs(){ lastJobEdit=Date.now(); if(!USER||!fbReady)return; try{ setDoc(doc(db,"people",USER.id),{savedJobs:MY_JOBS,removedJobs:[...REMOVED_JOBS],jobOrder:JOB_ORDER,updatedAt:serverTimestamp()},{merge:true}); }catch(e){console.error("syncjobs",e);} }
function showErr(id,code){ $(id).innerHTML=`<div class="empty"><div class="ico">📡</div><h3>Can't reach Firebase</h3><p>Live data couldn't load${code?` (${esc(code)})`:""}. Check your connection and Firestore rules, then reload.</p></div>`; }

/* ---------- Row builders ---------- */
function adminActs(type,id){ if(!adminUnlocked)return""; return `<button class="mini-btn edit" data-edit="${type}:${esc(id)}" title="Edit"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg></button><button class="mini-btn del" data-del="${type}:${esc(id)}" title="Delete"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6M14 11v6"></path></svg></button>`; }
function starBtn(job){ const saved=MY_JOBS.includes(normJob(job)); return isRealJob(job)?`<button class="star-btn ${saved?'saved':''}" data-savejob="${esc(normJob(job))}"><svg width="14" height="14" viewBox="0 0 24 24" fill="${saved?'currentColor':'none'}" stroke="currentColor" stroke-width="2"><path d="M12 2l2.9 6.3 6.9.7-5.2 4.6 1.5 6.8L12 17.8 5.9 20.4l1.5-6.8L2.2 9l6.9-.7z"/></svg></button>`:""; }
function starMini(job){ const saved=MY_JOBS.includes(normJob(job)); return isRealJob(job)?`<button class="mini-btn star ${saved?'saved':''}" data-savejob="${esc(normJob(job))}" title="${saved?'Saved to My Jobs':'Save to My Jobs'}"><svg width="18" height="18" viewBox="0 0 24 24" fill="${saved?'currentColor':'none'}" stroke="currentColor" stroke-width="2"><path d="M12 2l2.9 6.3 6.9.7-5.2 4.6 1.5 6.8L12 17.8 5.9 20.4l1.5-6.8L2.2 9l6.9-.7z"/></svg></button>`:""; }

function arrivalRow(r,opts={}){
  const job=normJob(r.jobNumber),d=rowDate(r.dateReceived),open=EXPANDED_ARR.has(r.id);
  const hasPhoto=!!r.photoBy;
  const cam=`<button class="mini-btn cam ${hasPhoto?'has':''}" data-cam="${esc(r.id)}" title="${hasPhoto?'Photo by '+esc(r.photoBy):'Add photo'}"><svg width="17" height="17" viewBox="0 0 24 24" fill="${hasPhoto?'currentColor':'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="3.5"></circle></svg></button>`;
  const deliv=`<button class="mini-btn deliv-btn ${r.delivered?'set':''}" data-deliv="${esc(r.id)}" title="${r.delivered?'Delivered '+esc(longDate(r.deliveredDate)):r.reqDeliv?'Requested '+esc(longDate(r.reqDeliv)):'Delivery'}"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="15" height="13"></rect><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"></polygon><circle cx="5.5" cy="18.5" r="2.5"></circle><circle cx="18.5" cy="18.5" r="2.5"></circle></svg></button>`;
  const place = r.delivered ? `<span class="m deliv">✓ Delivered${r.deliveredDate?" "+esc(longDate(r.deliveredDate).split(",")[0]):""}</span>`
    : r.reqDeliv ? `<span class="m reqd">Req ${esc(longDate(r.reqDeliv).split(",")[0])}</span>`
    : r.storageLocation ? `<span class="m loc">📍 ${esc(r.storageLocation)}</span>`
    : `<span class="m none">—</span>`;
  const partial = r.partial?'<span class="m partial">⚠ Partial</span>':"";
  const newTag = opts.isNew?`<span class="m new-tag">NEW<button class="newx" data-clearone="${esc(r.id)}" title="Clear this alert">✕</button></span>`:"";
  const wdInfo=(typeof wdEquipForArrival==="function")?wdEquipForArrival(r.id):[];
  const wdStrip = wdInfo.length ? `<div class="ac-wd">${wdInfo.map(e=>{
    const stat = r.delivered ? "Delivered" : (e.shipStatus||"");
    const statCls = r.delivered ? "ac-wd-stat delivered" : "ac-wd-stat";
    const partialTag = e.partial ? ` · <span class="ac-wd-stat partial">◑ PARTIAL</span>` : "";
    const noteBlock = (typeof wdEquipNoteBlock==="function") ? wdEquipNoteBlock(e) : "";
    return `<div class="ac-wd-wrap"><div class="ac-wd-row wo-jump" data-wojump="${esc(e.orderNumber)}" title="View in Deliveries"><span class="ac-wd-tag">WEBDUCT</span><div class="ac-wd-body"><b>Order ${esc(e.orderNumber)}</b>${e.orderedDate?` · ordered ${esc(wdDate(e.orderedDate))}`:""}${e.requestedDate?`<br>Field wants delivered: <b>${esc(wdDate(e.requestedDate))}</b>`:""}${stat?` · <span class="${statCls}">${esc(stat)}</span>`:""}${partialTag}</div><span class="wo-jump-arrow">→</span></div>${noteBlock}</div>`;
  }).join("")}</div>` : "";
  const extra=`<div class="acard-extra">
      <div class="extra-chips">${r.supplier?`<span class="m sup">${esc(r.supplier)}</span>`:""}${r.po?`<span class="m po">PO ${esc(r.po)}</span>`:""}${r.requestedBy?`<span class="m req">Req: ${esc(r.requestedBy)}</span>`:""}${r.photoBy?`<span class="m loc">📷 ${esc(r.photoBy)}</span>`:""}${!r.supplier&&!r.po&&!r.requestedBy?'<span class="m none">No extra details</span>':""}</div>
      ${wdStrip}
      <div class="act-row"><button class="share-btn" data-share="${esc(r.id)}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"></line><line x1="15.4" y1="6.5" x2="8.6" y2="10.5"></line></svg> Share</button>${adminActs("arrival",r.id)}</div>
    </div>`;
  return `<div class="acard ${open?'open':''} ${opts.compact?'compact':''}" data-type="arrival" data-id="${esc(r.id)}">
    <div class="acard-head" data-expand="${esc(r.id)}">
      <div class="ac-job"><span class="jobbadge ${isRealJob(job)?'':'na'}">${esc(isRealJob(job)?job:"—")}</span></div>
      <div class="ac-name">${esc(r.jobName)||'<span style="color:var(--steel-light)">No job name</span>'}</div>
      <div class="ac-icons"><button class="ac-copy" data-copyname="${esc(r.description||"")}" title="Copy arrival name">Copy Name</button>${opts.star!==false?starMini(job):""}${cam}${deliv}<span class="ac-chev"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><polyline points="6 9 12 15 18 9"></polyline></svg></span></div>
      <div class="ac-desc">${esc(r.description)||"<span style='color:var(--steel-light)'>No description</span>"}</div>
      <div class="ac-foot"><span class="ac-date"><b>${d.top}</b><span class="${d.rel?'rel':''}">${d.bot}</span></span>${place}${partial}${newTag}</div>
    </div>
    ${extra}
  </div>`;
}
function rentalRow(r,opts={}){
  const job=normJob(r.jobNumber),ret=/return/i.test(r.status);
  return `<div class="drow ${ret?'returned':''}" data-type="rental" data-id="${esc(r.id)}">
    <div class="dr-top"><span class="status ${ret?'returned':'renting'}">${esc(r.status||"Renting")}</span><span class="dr-title">${esc(r.jobName||"—")}</span>${isRealJob(job)?`<span class="jobbadge">${esc(job)}</span>`:""}<span class="dr-act">${adminActs("rental",r.id)}${opts.star!==false?starBtn(job):""}</span></div>
    <div class="dr-item">${esc(r.equipment)||"<span style='color:var(--steel-light)'>No equipment listed</span>"}</div>
    <div class="dr-grid">
      <div><span class="k">ID / Contract #</span><span class="v mono${r.rentalId?'':' empty'}">${esc(r.rentalId)||"—"}</span></div>
      <div><span class="k">PO #</span><span class="v mono${r.po?'':' empty'}">${esc(r.po)||"—"}</span></div>
      <div><span class="k">Date rented</span><span class="v${r.dateRented?'':' empty'}">${esc(longDate(r.dateRented))||"—"}</span></div>
      <div><span class="k">Date returned</span><span class="v${ret&&r.dateReturned?'':' empty'}">${ret&&r.dateReturned?esc(longDate(r.dateReturned)):"—"}</span></div>
      <div class="wide"><span class="k">Rate</span>${rateChips(r.rate)||'<span class="v empty">—</span>'}</div>
      <div><span class="k">Vendor</span><span class="v${r.vendor?'':' empty'}">${esc(r.vendor)||"—"}</span></div>
      <div><span class="k">Ordered by</span><span class="v${r.orderedBy?'':' empty'}">${esc(r.orderedBy)||"—"}</span></div>
    </div>
  </div>`;
}
function toolRow(r,opts={}){
  const job=normJob(r.jobNumber),ret=/return/i.test(r.status);
  return `<div class="drow tool ${ret?'returned':''}" data-type="tool" data-id="${esc(r.id)}">
    <div class="dr-top"><span class="status ${ret?'returned':'out'}">${ret?"Returned":"Out"}</span><span class="dr-title">${esc(r.jobName||"—")}</span>${r.jobClosed?'<span class="closedtag">Closed</span>':""}${isRealJob(job)?`<span class="jobbadge">${esc(job)}</span>`:""}<span class="dr-act">${adminActs("tool",r.id)}${opts.star!==false?starBtn(job):""}</span></div>
    <div class="dr-item">${esc(r.toolType||"Tool")} <span class="tid">#${esc(r.toolId)||"—"}</span></div>
    <div class="dr-grid">
      <div><span class="k">Date started</span><span class="v${r.rentalStarted?'':' empty'}">${esc(longDate(r.rentalStarted))||"—"}</span></div>
      <div><span class="k">Date ended</span><span class="v${ret&&r.rentalEnded?'':' empty'}">${ret&&r.rentalEnded?esc(longDate(r.rentalEnded)):"—"}</span></div>
      <div><span class="k">Billing days</span><span class="v">${esc(String(r.billingDays||0))}</span></div>
      <div><span class="k">Daily rate</span><span class="v money">$${esc(String(r.dailyRate||0))}</span></div>
      <div><span class="k">Billing total</span><span class="v money">${esc(money(r.billingTotal))}</span></div>
      <div><span class="k">Discounted rate</span><span class="v money">${esc(money(r.discountedRate))}</span></div>
    </div>
  </div>`;
}

/* ---------- Month dropdowns ---------- */
function refreshMonths(){
  const fill=(sel,keys)=>{ const cur=sel.value; sel.innerHTML=`<option value="">All months</option>`+keys.map(k=>`<option value="${k}">${monthLabel(k)}</option>`).join(""); if(keys.includes(cur))sel.value=cur; };
  fill($("monthSel"),[...new Set(ARRIVALS.map(r=>monthKey(r.dateReceived)).filter(Boolean))].sort().reverse());
  const mjKeys = mjSeg==="arrivals" ? ARRIVALS.map(r=>monthKey(r.dateReceived))
    : mjSeg==="rentals" ? RENTALS.map(r=>monthKey(r.dateRented))
    : TOOLS.map(r=>monthKey(r.rentalStarted));
  fill($("mjMonth"),[...new Set(mjKeys.filter(Boolean))].sort().reverse());
}

/* ---------- Render: Arrivals ---------- */
function renderFeed(){
  if(typeof renderAutoImport==="function") renderAutoImport();
  if(typeof ghRenderBtn==="function") ghRenderBtn();
  if(arrViewMode==="cal" && typeof renderArrCalendar==="function") renderArrCalendar();
  const q=$("feedSearch").value.trim().toLowerCase(),month=$("monthSel").value;
  $("feedClr").style.display=q?"block":"none";
  let rows=ARRIVALS;
  if(month) rows=rows.filter(r=>monthKey(r.dateReceived)===month);
  if(q) rows=rows.filter(r=>[r.jobNumber,r.jobName,r.description,r.supplier,r.po,r.requestedBy].some(v=>(v||"").toLowerCase().includes(q)));
  const list=$("feedList");
  if(!ARRIVALS.length){ list.innerHTML=`<div class="empty"><div class="ico">📦</div><h3>No arrivals yet</h3><p>Once Bobby logs equipment or imports the master sheet, it shows here.</p></div>`; $("feedMeta").textContent="0 arrivals"; return; }
  if(!rows.length){ list.innerHTML=`<div class="empty"><div class="ico">🔍</div><h3>No matches</h3><p>Nothing found${month?` in ${monthLabel(month)}`:""}${q?` for "${esc(q)}"`:""}.</p></div>`; $("feedMeta").textContent="0 shown"; return; }
  $("feedMeta").innerHTML=(q||month)?`<b>${rows.length}</b> of ${ARRIVALS.length.toLocaleString()} arrivals`:`<b>${ARRIVALS.length.toLocaleString()}</b> arrivals`;
  const LIMIT=600,slice=rows.slice(0,LIMIT);
  let html=slice.map(r=>arrivalRow(r)).join("");
  if(rows.length>LIMIT) html+=`<div class="empty" style="padding:24px"><p>Showing ${LIMIT} of ${rows.length.toLocaleString()}. Pick a month or search to narrow.</p></div>`;
  list.innerHTML=html;
}

/* ---------- Render: Rentals (grouped by job, collapsible) ---------- */
function rentalLine(r){
  const ret=/return/i.test(r.status);
  return `<div class="tline" data-type="rental" data-id="${esc(r.id)}">
    <div class="tl-tool">${esc(r.equipment)||"Equipment"}${r.rentalId?` <span class="tid">${esc(r.rentalId)}</span>`:""}</div>
    <div class="tl-status"><span class="status ${ret?'returned':'renting'}">${esc(r.status||"Renting")}</span></div>
    <div class="tl-meta"><span>Rented <b>${esc(longDate(r.dateRented).split(",")[0])||"—"}</b></span><span>Returned <b>${ret&&r.dateReturned?esc(longDate(r.dateReturned).split(",")[0]):"—"}</b></span>${r.rate?`<span class="tl-rate">Rate ${rateChips(r.rate)}</span>`:""}${r.vendor?`<span>Vendor <b>${esc(r.vendor)}</b></span>`:""}${r.po?`<span>PO <b>${esc(r.po)}</b></span>`:""}${r.orderedBy?`<span>By <b>${esc(r.orderedBy)}</b></span>`:""}</div>
    ${adminUnlocked?`<div class="tl-act">${adminActs("rental",r.id)}</div>`:""}
  </div>`;
}
function rentalJobCard(job,items){
  const info=items[0]||{}; const name=info.jobName||"Unknown job name";
  const out=items.filter(i=>!/return/i.test(i.status)).length; const open=EXPANDED_RENTALS.has(job);
  return `<div class="rcard ${open?'open':''}" data-rcard="${esc(job)}">
    <div class="tcard-head" data-rtoggle="${esc(job)}">
      <span class="ttag">${esc(isRealJob(job)?job:"—")}</span>
      <div class="tinfo"><div class="tn">${esc(name)}</div><div class="tc"><b>${items.length}</b> rentals · <b>${out}</b> out</div></div>
      <span class="tchev"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><polyline points="6 9 12 15 18 9"></polyline></svg></span>
    </div>
    <div class="tcard-body">${items.map(rentalLine).join("")}</div>
  </div>`;
}
function renderRentals(){ if(typeof renderAutoImport==="function")renderAutoImport();
  const q=$("rentSearch").value.trim().toLowerCase(),st=$("rentStatus").value;
  $("rentClr").style.display=q?"block":"none"; $("pillRent").textContent=(RENTALS.length+TOOLS.length)>999?(Math.floor((RENTALS.length+TOOLS.length)/100)/10)+"k":(RENTALS.length+TOOLS.length);
  let rows=RENTALS;
  if(st) rows=rows.filter(r=> st==="Returned"?/return/i.test(r.status):!/return/i.test(r.status));
  if(q) rows=rows.filter(r=>[r.rentalId,r.jobNumber,r.jobName,r.equipment,r.vendor,r.orderedBy,r.po].some(v=>(v||"").toLowerCase().includes(q)));
  const list=$("rentList");
  if(!RENTALS.length){ list.innerHTML=`<div class="empty"><div class="ico">🚜</div><h3>No rentals yet</h3><p>Bobby can log a rental from Admin, or import the master sheet.</p></div>`; $("rentMeta").textContent="0 rentals"; return; }
  if(!rows.length){ list.innerHTML=`<div class="empty"><div class="ico">🔍</div><h3>No matches</h3><p>No rentals match that filter.</p></div>`; $("rentMeta").textContent="0 shown"; return; }
  const groups=groupByJob(rows);
  const entries=[...groups.entries()].sort((a,b)=>{ const la=a[1][0]?.dateRented||"",lb=b[1][0]?.dateRented||""; return lb<la?-1:1; });
  $("rentMeta").innerHTML=`<b>${groups.size}</b> jobs · ${rows.length} rentals`;
  list.innerHTML=entries.map(([job,items])=>rentalJobCard(job,items)).join("");
}

/* ---------- Render: Tool rentals ---------- */
function pdfLinkFor(job){ if(!PDF_META||!PDF_META.pageMap)return""; const pg=PDF_META.pageMap[job]; if(!pg)return""; return `<button class="pdf-link" data-pdfjob="${esc(job)}" title="View this job in the tool report PDF"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg> PDF</button>`; }
function toolLine(r){
  const ret=/return/i.test(r.status);
  return `<div class="tline" data-type="tool" data-id="${esc(r.id)}">
    <div class="tl-tool">${esc(r.toolType||"Tool")} <span class="tid">#${esc(r.toolId)||"—"}</span></div>
    <div class="tl-status"><span class="status ${ret?'returned':'out'}">${ret?"Returned":"Out"}</span></div>
    <div class="tl-meta"><span>Started <b>${esc(longDate(r.rentalStarted).split(",")[0])||"—"}</b></span><span>Ended <b>${ret&&r.rentalEnded?esc(longDate(r.rentalEnded).split(",")[0]):"—"}</b></span><span><b>${esc(String(r.billingDays||0))}</b> days</span><span>Daily <b>$${esc(String(r.dailyRate||0))}</b></span><span>Total <b>${esc(money(r.billingTotal))}</b></span><span>Disc <b>${esc(money(r.discountedRate))}</b></span></div>
    ${adminUnlocked?`<div class="tl-act">${adminActs("tool",r.id)}</div>`:""}
  </div>`;
}
function toolJobCard(job,items,opts={}){
  const info=items[0]||{}; const name=info.jobName||"Unknown job name"; const closed=items.some(i=>i.jobClosed);
  const out=items.filter(i=>!/return/i.test(i.status)).length; const open=EXPANDED_TOOLS.has(job);
  return `<div class="tcard ${open?'open':''}" data-tcard="${esc(job)}">
    <div class="tcard-head" data-ttoggle="${esc(job)}">
      <span class="ttag">${esc(job)}</span>
      <div class="tinfo"><div class="tn">${esc(name)}${closed?' <span class="closedtag">Closed</span>':""}${pdfLinkFor(job)}</div><div class="tc"><b>${items.length}</b> tools · <b>${out}</b> out</div></div>
      <span class="tchev"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><polyline points="6 9 12 15 18 9"></polyline></svg></span>
    </div>
    <div class="tcard-body">${items.map(toolLine).join("")}</div>
  </div>`;
}
function groupByJob(items){ const m=new Map(); items.forEach(r=>{ const j=normJob(r.jobNumber); if(!m.has(j))m.set(j,[]); m.get(j).push(r); }); return m; }
function fmtTs(ts){ try{ const d=ts&&ts.toDate?ts.toDate():(ts?new Date(ts):null); if(!d||isNaN(d))return ""; return MON[d.getMonth()]+" "+d.getDate()+", "+d.getFullYear(); }catch(e){return "";} }
function renderTools(){ if(typeof renderAutoImport==="function")renderAutoImport();
  const q=$("toolSearch").value.trim().toLowerCase(),st=$("toolStatus").value;
  $("toolClr").style.display=q?"block":"none"; const pt=$("pillTool"); if(pt)pt.textContent=TOOLS.length>999?(Math.floor(TOOLS.length/100)/10)+"k":TOOLS.length; const pr=$("pillRent"); if(pr)pr.textContent=(RENTALS.length+TOOLS.length)>999?(Math.floor((RENTALS.length+TOOLS.length)/100)/10)+"k":(RENTALS.length+TOOLS.length);
  const asOf=$("toolAsOf"); if(asOf){ const when=PDF_META?fmtTs(PDF_META.uploadedAt):""; if(when){ asOf.style.display="block"; asOf.innerHTML=`As of <b>${esc(when)}</b>, this is the tool rental list${PDF_META.name?` (from ${esc(PDF_META.name)})`:""}.`; } else asOf.style.display="none"; }
  let rows=TOOLS;
  if(st) rows=rows.filter(r=> st==="Returned"?/return/i.test(r.status):!/return/i.test(r.status));
  if(q) rows=rows.filter(r=>[r.jobNumber,r.jobName,r.toolType,r.toolId].some(v=>(v||"").toLowerCase().includes(q)));
  const list=$("toolList");
  if(!TOOLS.length){ list.innerHTML=`<div class="empty"><div class="ico">🔧</div><h3>No tool rentals yet</h3><p>Upload the Webduct tool rental PDF from the Admin tab.</p></div>`; $("toolMeta").textContent="0 tools"; return; }
  if(!rows.length){ list.innerHTML=`<div class="empty"><div class="ico">🔍</div><h3>No matches</h3><p>No tools match that filter.</p></div>`; $("toolMeta").textContent="0 shown"; return; }
  const groups=groupByJob(rows);
  const entries=[...groups.entries()].sort((a,b)=>{ const la=a[1][0]?.rentalStarted||"",lb=b[1][0]?.rentalStarted||""; return lb<la?-1:1; });
  $("toolMeta").innerHTML=`<b>${groups.size}</b> jobs · ${rows.length} tools`;
  list.innerHTML=entries.map(([job,items])=>toolJobCard(job,items)).join("");
}

/* ---------- My Jobs ---------- */
function distinctJobs(){
  const map=new Map();
  const add=(j,name,date)=>{ if(!isRealJob(j))return; if(!map.has(j))map.set(j,{jobNumber:j,jobName:name||"",last:""}); const o=map.get(j); if(name&&!o.jobName)o.jobName=name; if(date&&date>o.last)o.last=date; };
  ARRIVALS.forEach(r=>add(normJob(r.jobNumber),r.jobName,r.dateReceived));
  RENTALS.forEach(r=>add(normJob(r.jobNumber),r.jobName,r.dateRented));
  TOOLS.forEach(r=>add(normJob(r.jobNumber),r.jobName,r.rentalStarted));
  return map;
}
function renderIdentity(){
  const card=$("identityCard"); if(!card)return;
  if(VIEW_AS){ card.style.display="flex"; card.classList.add("viewing"); $("idAv").textContent=((VIEW_AS.first[0]||"")+(VIEW_AS.last[0]||"")).toUpperCase(); $("idName").textContent=VIEW_AS.first+" "+VIEW_AS.last; $("idSub").textContent="You're viewing this person's saved jobs"; return; }
  card.classList.remove("viewing");
  if(USER){ card.style.display="flex"; $("idAv").textContent=((USER.first[0]||"")+(USER.last[0]||"")).toUpperCase(); $("idName").textContent=USER.first+" "+USER.last; const n=new Set(ARRIVALS.filter(r=>nameMatches(r.requestedBy,USER.first,USER.last)).map(r=>normJob(r.jobNumber)).filter(isRealJob)).size; $("idSub").textContent=n?`${n} job${n===1?"":"s"} auto-linked from "Requested by"`:`Your requested jobs link automatically`; }
  else card.style.display="none";
}
function renderSharePrompts(){
  const wrap=$("sharePrompts"); if(!wrap)return;
  const mine=USER?SHARES.filter(s=>s.toId===USER.id&&s.status==="pending"):[];
  wrap.innerHTML=mine.map(s=>`<div class="share-prompt"><span class="sp-ico">📨</span><span class="sp-txt"><b>${esc(s.fromName||"Someone")}</b> shared job <b>${esc(s.jobNumber)}</b>${s.jobName?` (${esc(s.jobName)})`:""}. Add it to My Jobs?</span><button class="sp-add" data-shareadd="${esc(s.id)}">Add</button><button class="sp-no" data-shareno="${esc(s.id)}">Dismiss</button></div>`).join("");
}
const ARR_TAG_FIELDS=["description","supplier","po","requestedBy","jobName","storageLocation"];
const RENT_TAG_FIELDS=["equipment","vendor","rentalId","po","orderedBy"];
const TOOL_TAG_FIELDS=["toolType","toolId"];
function tagMatch(r,fields,sq){ return fields.some(f=>(r[f]||"").toLowerCase().includes(sq)); }
function renderJobs(){
  if(dragEl) return;
  const news=updateNotif(); renderIdentity(); renderSharePrompts();
  const jobsMap=distinctJobs();
  const viewingOther=!!VIEW_AS;
  const vp=viewingOther?PEOPLE.find(p=>p.id===VIEW_AS.id):null;
  const viewName=viewingOther?((VIEW_AS.first||"")+" "+(VIEW_AS.last||"")).trim():"";
  const banner=$("viewAsBanner");
  if(viewingOther){ banner.style.display="flex"; $("vabName").textContent=viewName||"this person"; $("notifBanner").classList.remove("show"); }
  else { banner.style.display="none"; }
  let jobsList=viewingOther?(vp&&Array.isArray(vp.savedJobs)?vp.savedJobs:[]):MY_JOBS;
  // Tutorial: prepend a sample job so the walkthrough always has a folder to show —
  // even for someone with no saved jobs (who'd otherwise hit the empty state below).
  if(TUT_DEMO) jobsList=[TUT_JOB, ...jobsList.filter(j=>j!==TUT_JOB)];
  const ordList=viewingOther?(vp&&Array.isArray(vp.jobOrder)?vp.jobOrder:[]):JOB_ORDER;

  const sq=$("jobSearch").value.trim().toLowerCase(),sugWrap=$("jobSuggest");
  $("jobAddBtn").style.display=viewingOther?"none":"";
  if(sq && !viewingOther){ const matches=[...jobsMap.values()].filter(o=>o.jobNumber.toLowerCase().includes(sq)||(o.jobName||"").toLowerCase().includes(sq)).filter(o=>!jobsList.includes(o.jobNumber)).sort((a,b)=>b.last<a.last?-1:1).slice(0,8); sugWrap.innerHTML=matches.length?matches.map(o=>`<div class="s-item"><span class="sj">${esc(o.jobNumber)}</span><span class="sn">${esc(o.jobName||"—")}</span><button data-addjob="${esc(o.jobNumber)}">+ Save</button></div>`).join(""):`<div class="s-item" style="justify-content:center;color:var(--steel)">No match — tap Save to add "${esc($("jobSearch").value.trim())}" anyway</div>`; } else sugWrap.innerHTML="";

  const month=$("mjMonth").value;
  const wrap=$("foldersList");
  document.getElementById("reorderToggle").closest(".reorder-bar").style.display=viewingOther?"none":"flex";
  $("reorderToggle").classList.toggle("on",reorderMode);
  $("reorderHint").textContent=reorderMode?"Use the ▲▼ arrows to reorder":"";
  $("orderReset").style.display=(ordList.length&&!reorderMode&&!viewingOther)?"inline-block":"none";
  if(!jobsList.length){ wrap.innerHTML=viewingOther?`<div class="empty"><div class="ico">📁</div><h3>No saved jobs</h3><p>${esc(viewName||"This person")} hasn't saved any jobs yet.</p></div>`:`<div class="empty"><div class="ico">📁</div><h3>No saved jobs</h3><p>Search a job number above and tap Save${USER?", or your requested jobs link automatically":""}. Arrivals, rentals, and tool rentals on it collect here.</p></div>`; return; }
  const newCountFor=job=>{ if(viewingOther)return 0; let n=0; ARRIVALS.forEach(r=>{if(normJob(r.jobNumber)===job&&news.has("a:"+r.id))n++;}); return n; };
  const lastOf=j=>jobsMap.get(j)?.last||"";
  let sorted;
  if(ordList.length){ const known=ordList.filter(j=>jobsList.includes(j)); const extra=jobsList.filter(j=>!ordList.includes(j)).sort((a,b)=>lastOf(b)<lastOf(a)?-1:1); sorted=[...extra,...known]; }
  else sorted=[...jobsList].sort((a,b)=>{ const na=newCountFor(a),nb=newCountFor(b); if((nb>0)!==(na>0))return nb>0?1:-1; return lastOf(b)<lastOf(a)?-1:1; });
  MJ_VIEW=sorted.slice();
  let shown=0;
  const html=sorted.map(job=>{
    const idx=sorted.indexOf(job);
    const info=jobsMap.get(job);
    let arr=ARRIVALS.filter(r=>normJob(r.jobNumber)===job);
    let rnt=RENTALS.filter(r=>normJob(r.jobNumber)===job);
    let tls=TOOLS.filter(r=>normJob(r.jobNumber)===job);
    // The tutorial's sample job: fully synthetic, and it skips the month/search filters
    // below so a leftover filter can never hide it mid-walkthrough.
    const isDemo = TUT_DEMO && job===TUT_JOB;
    if(isDemo){ arr=demoArrivals(job); rnt=demoRentals(job); tls=demoTools(job); }
    const totalArr=arr.length,totalRnt=rnt.length,totalTls=tls.length;
    const nNew=newCountFor(job); const isOpen=EXPANDED_FOLDERS.has(job);
    if(month && !isDemo){ arr=arr.filter(r=>monthKey(r.dateReceived)===month); rnt=rnt.filter(r=>monthKey(r.dateRented)===month); tls=tls.filter(r=>monthKey(r.rentalStarted)===month); }
    const name=info?.jobName||arr[0]?.jobName||rnt[0]?.jobName||tls[0]?.jobName||"Unknown job name";
    const jobNameNumMatch = sq && (job.toLowerCase().includes(sq) || name.toLowerCase().includes(sq));
    if(sq && !jobNameNumMatch && !isDemo){
      // narrow this job's items down to ones whose tag info matches — only within saved jobs
      arr=arr.filter(r=>tagMatch(r,ARR_TAG_FIELDS,sq));
      rnt=rnt.filter(r=>tagMatch(r,RENT_TAG_FIELDS,sq));
      tls=tls.filter(r=>tagMatch(r,TOOL_TAG_FIELDS,sq));
      if(!arr.length && !rnt.length && !tls.length) return "";  // nothing in this job matches the search
    }
    shown++;
    let body="";
    if(mjSeg==="arrivals") body = arr.length?`<div class="rows">${arr.map(r=>arrivalRow(r,{star:true,compact:true,isNew:!viewingOther&&news.has("a:"+r.id)})).join("")}</div>`:`<div class="sub-empty">No arrivals${sq?" match your search":month?" this month":" yet"}.</div>`;
    else if(mjSeg==="rentals") body = rnt.length?`<div class="tlines">${rnt.map(rentalLine).join("")}</div>`:`<div class="sub-empty">No rentals${sq?" match your search":month?" this month":" on this job"}.</div>`;
    else body = tls.length?`<div class="tlines">${tls.map(toolLine).join("")}</div>`:`<div class="sub-empty">No tool rentals${sq?" match your search":month?" this month":" on this job"}.</div>`;
    const ctrl=(reorderMode&&!viewingOther)?`<span class="reorder-ctrl"><button class="ord-btn" data-moveup="${esc(job)}" ${idx===0?"disabled":""} title="Move up">▲</button><button class="ord-btn" data-movedown="${esc(job)}" ${idx===sorted.length-1?"disabled":""} title="Move down">▼</button></span>`:"";
    const removeBtn=viewingOther?`<button class="icon-btn fstar ${MY_JOBS.includes(job)?'saved':''}" data-savejob="${esc(job)}" title="${MY_JOBS.includes(job)?'Saved to your jobs':'Save to your jobs'}"><svg width="18" height="18" viewBox="0 0 24 24" fill="${MY_JOBS.includes(job)?'currentColor':'none'}" stroke="currentColor" stroke-width="2"><path d="M12 2l2.9 6.3 6.9.7-5.2 4.6 1.5 6.8L12 17.8 5.9 20.4l1.5-6.8L2.2 9l6.9-.7z"/></svg></button>`:`<button class="icon-btn" data-removejob="${esc(job)}" title="Remove"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6M14 11v6"></path></svg></button>`;
    return `<div class="folder ${nNew?'has-new':''} ${(reorderMode&&!viewingOther)?'reorderable':''} ${isOpen?'open':''}" data-folder="${esc(job)}">
      <div class="folder-head" data-toggle="${esc(job)}">
        <span class="folder-tag">${esc(job)}</span>
        <div class="folder-info"><div class="fn">${esc(name)}${totalTls>0?pdfLinkFor(job):""}${nNew?'<span class="new-dot"></span>':""}</div><div class="fc"><b>${totalArr}</b> arrivals · <b>${totalRnt}</b> rentals · <b>${totalTls}</b> tools${nNew?`<button class="clearone" data-clearjob="${esc(job)}">${nNew} new · clear</button>`:""}</div></div>
        <div class="folder-actions">${ctrl}${removeBtn}<span class="icon-btn chev"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><polyline points="6 9 12 15 18 9"></polyline></svg></span></div>
      </div>
      <div class="folder-body">${body}</div>
    </div>`;
  }).join("");
  if(sq && !shown){ wrap.innerHTML=`<div class="empty"><div class="ico">🔍</div><h3>No matches</h3><p>Nothing ${viewingOther?"in this list":"saved"} matches "${esc($("jobSearch").value.trim())}".${viewingOther?"":" Check the suggestions above to add a new job."}</p></div>`; return; }
  wrap.innerHTML=html;
}

/* ---------- Stats ---------- */
function renderAdminStats(){ if($("statTotal")){ $("statTotal").textContent=ARRIVALS.length.toLocaleString(); $("statRent").textContent=RENTALS.filter(r=>!/return/i.test(r.status)).length; $("statTool").textContent=TOOLS.length.toLocaleString(); } }
function renderEricStats(){ renderAdminStats(); }

/* ---------- Master render ---------- */
function renderAll(){ $("pillFeed").textContent=ARRIVALS.length>999?(Math.floor(ARRIVALS.length/100)/10)+"k":ARRIVALS.length; refreshMonths(); renderWho(); renderFeed(); renderRentals(); renderTools(); renderDeliveries(); renderJobs(); renderAdminStats(); if(PENDING_ARRIVAL && $("view-feed").classList.contains("active")) focusPendingArrival(); }

/* ---------- Save/remove job ---------- */
function addJob(job){ if(!USER){toast("Sign in to save jobs"); openName(); return;} const j=normJob(job); if(!isRealJob(j)){toast("Enter a valid job number");return;} if(MY_JOBS.includes(j)){toast(j+" is already saved");return;} MY_JOBS.push(j); REMOVED_JOBS.delete(j); markSeenForJob(j); syncUserJobs(); $("jobSearch").value=""; renderAll(); toast("Saved "+j+" to My Jobs"); }
function removeJob(job){ MY_JOBS=MY_JOBS.filter(j=>j!==job); REMOVED_JOBS.add(job); syncUserJobs(); renderAll(); toast("Removed "+job); }

/* ---------- Tabs ---------- */
const VALID_VIEWS=["feed","rentals","deliveries","jobs","admin"];
function personalHashFor(p){ if(!p)return ""; return ((p.first||"")+(p.last||"")).replace(/[^A-Za-z0-9]/g,""); }
function personalHash(){ return USER?(personalHashFor(USER)||"myjobs"):"myjobs"; }
function findPersonByHash(h){ if(!h)return null; const hl=h.toLowerCase(); return PEOPLE.find(p=>personalHashFor(p).toLowerCase()===hl); }
function hashForView(name){ if(name==="feed")return "arrivals"; if(name==="jobs")return VIEW_AS?personalHashFor(VIEW_AS):personalHash(); return name; }
function viewForHash(h){
  if(!h)return null;
  if(h.startsWith("arrival-")){ PENDING_ARRIVAL=decodeURIComponent(h.slice(8)); return "feed"; }
  if(h==="arrivals")return "feed";
  if(h==="jobs"||h==="myjobs"){ VIEW_AS=null; return "jobs"; }
  if(h===personalHash()){ VIEW_AS=null; return "jobs"; }
  if(VALID_VIEWS.includes(h))return h;
  const p=findPersonByHash(h);
  if(p){ VIEW_AS=(USER&&p.id===USER.id)?null:{id:p.id,first:p.first,last:p.last}; return "jobs"; }
  return null;
}
function focusPendingArrival(){
  if(!PENDING_ARRIVAL)return;
  const id=PENDING_ARRIVAL;
  if(!ARRIVALS.some(r=>r.id===id))return; // not loaded yet — retried from renderAll() once data arrives
  PENDING_ARRIVAL=null;
  EXPANDED_ARR.add(id);
  if($("feedSearch").value){ $("feedSearch").value=""; }
  if($("monthSel").value){ $("monthSel").value=""; }
  renderFeed();
  setTimeout(()=>{
    const el=[...document.querySelectorAll("#feedList .acard")].find(c=>c.dataset.id===id);
    if(el){ el.scrollIntoView({behavior:"smooth",block:"center"}); el.classList.add("flash"); setTimeout(()=>el.classList.remove("flash"),10000); }
  },80);
}
function setView(name,fromHash){
  if(!VALID_VIEWS.includes(name))name="feed";
  if(name==="jobs" && !fromHash) VIEW_AS=null;   // tapping the My Jobs tab always shows your own
  document.querySelectorAll(".tab").forEach(x=>x.classList.toggle("active",x.dataset.view===name));
  document.querySelectorAll(".view").forEach(x=>x.classList.remove("active"));
  $("view-"+name).classList.add("active");
  window.scrollTo(0,0);
  if(name==="admin")syncAdminView();
  if(name==="jobs")renderJobs();
  if(name==="deliveries")renderDeliveries();
  if(name==="feed")focusPendingArrival();
  if(!fromHash){ const h="#"+hashForView(name); if(location.hash!==h) history.replaceState(null,"",h); }
}
document.querySelectorAll(".tab").forEach(t=>t.addEventListener("click",()=>setView(t.dataset.view)));
// Jump from a WEBDUCT order strip (Arrivals / My Jobs) straight to that order in Deliveries.
function wdJumpToOrder(orderNumber){
  const o=WD_ORDERS.find(x=>String(x.number)===String(orderNumber));
  if(!o){ setView("deliveries"); toast("Order not on the calendar (outside the pull window)"); return; }
  const iso=o.requestedDate||o.deliveryDate||o.orderedDate||"";
  const key=iso?dateKeyLocal(iso):"";
  if(key){ const d=new Date(iso); calYear=d.getFullYear(); calMonth=d.getMonth(); calSelDay=key; calDayOpenJob="job|"+String(o.jobName||o.job||"").trim().toLowerCase(); }
  setView("deliveries");
  toast(`Order ${orderNumber} · ${o.jobName||o.job||""}`);
}
window.addEventListener("hashchange",()=>{
  const raw=location.hash.replace("#","");
  const v=viewForHash(raw);
  if(v){ setView(v,true); }
  // If the hash points at a person not yet loaded, remember it and resolve once PEOPLE arrives.
  else if(raw && raw!=="arrivals" && !VALID_VIEWS.includes(raw)){ PENDING_VIEWAS_HASH=raw; }
});
let PENDING_VIEWAS_HASH="";
function resolvePendingHash(){ const h=location.hash.replace("#",""); if(!h)return; const v=viewForHash(h); if(v)setView(v,true); }

/* ---------- Filters ---------- */
$("feedSearch").addEventListener("input",renderFeed); $("feedClr").addEventListener("click",()=>{$("feedSearch").value="";renderFeed();}); $("monthSel").addEventListener("change",renderFeed);
$("rentSearch").addEventListener("input",renderRentals); $("rentClr").addEventListener("click",()=>{$("rentSearch").value="";renderRentals();}); $("rentStatus").addEventListener("change",renderRentals);
$("toolSearch").addEventListener("input",renderTools); $("toolClr").addEventListener("click",()=>{$("toolSearch").value="";renderTools();}); $("toolStatus").addEventListener("change",renderTools);
$("mjMonth").addEventListener("change",renderJobs);
document.querySelectorAll("#mjSeg button").forEach(b=>b.addEventListener("click",()=>{ mjSeg=b.dataset.seg; document.querySelectorAll("#mjSeg button").forEach(x=>x.classList.toggle("on",x===b)); refreshMonths(); renderJobs(); }));
document.querySelectorAll("#rentSeg button").forEach(b=>b.addEventListener("click",()=>{ const seg=b.dataset.rentseg; document.querySelectorAll("#rentSeg button").forEach(x=>x.classList.toggle("on",x===b)); $("rentEquipPane").style.display=seg==="equip"?"block":"none"; $("rentToolPane").style.display=seg==="tool"?"block":"none"; }));

/* ---------- Delegated clicks ---------- */
document.addEventListener("click",e=>{
  const mu=e.target.closest("[data-moveup]"); if(mu){ e.stopPropagation(); moveJob(mu.dataset.moveup,-1); return; }
  const md=e.target.closest("[data-movedown]"); if(md){ e.stopPropagation(); moveJob(md.dataset.movedown,1); return; }
  const save=e.target.closest("[data-savejob]"); if(save){ const j=save.dataset.savejob; MY_JOBS.includes(j)?removeJob(j):addJob(j); return; }
  const addb=e.target.closest("[data-addjob]"); if(addb){ addJob(addb.dataset.addjob); return; }
  const rem=e.target.closest("[data-removejob]"); if(rem){ e.stopPropagation(); removeJob(rem.dataset.removejob); return; }
  const cam=e.target.closest("[data-cam]"); if(cam){ e.stopPropagation(); openCamera(cam.dataset.cam); return; }
  const dv=e.target.closest("[data-deliv]"); if(dv){ e.stopPropagation(); openDeliv(dv.dataset.deliv); return; }
  const pj=e.target.closest("[data-pdfjob]"); if(pj){ e.stopPropagation(); openPdfAt(pj.dataset.pdfjob); return; }
  const ed=e.target.closest("[data-edit]"); if(ed){ e.stopPropagation(); const i=ed.dataset.edit.indexOf(":"); openEdit(ed.dataset.edit.slice(0,i),ed.dataset.edit.slice(i+1)); return; }
  const dl=e.target.closest("[data-del]"); if(dl){ e.stopPropagation(); const i=dl.dataset.del.indexOf(":"); doDelete(dl.dataset.del.slice(0,i),dl.dataset.del.slice(i+1)); return; }
  const shA=e.target.closest("[data-shareadd]"); if(shA){ acceptShare(shA.dataset.shareadd); return; }
  const shN=e.target.closest("[data-shareno]"); if(shN){ dismissShare(shN.dataset.shareno); return; }
  const cpn=e.target.closest("[data-copyname]"); if(cpn){ e.stopPropagation(); e.preventDefault(); copyToClipboard(cpn.dataset.copyname||""); return; }
  const shr=e.target.closest("[data-share]"); if(shr){ e.stopPropagation(); openShare(shr.dataset.share); return; }
  const cj=e.target.closest("[data-clearjob]"); if(cj){ e.stopPropagation(); clearJobNotif(cj.dataset.clearjob); return; }
  const co=e.target.closest("[data-clearone]"); if(co){ e.stopPropagation(); clearOneNotif(co.dataset.clearone); return; }
  const exp=e.target.closest("[data-expand]"); if(exp){ const id=exp.dataset.expand; if(EXPANDED_ARR.has(id))EXPANDED_ARR.delete(id); else EXPANDED_ARR.add(id); exp.closest(".acard").classList.toggle("open"); return; }
  const tt=e.target.closest("[data-ttoggle]"); if(tt){ const j=tt.dataset.ttoggle; if(EXPANDED_TOOLS.has(j))EXPANDED_TOOLS.delete(j); else EXPANDED_TOOLS.add(j); tt.closest(".tcard").classList.toggle("open"); return; }
  const rtg=e.target.closest("[data-rtoggle]"); if(rtg){ const j=rtg.dataset.rtoggle; if(EXPANDED_RENTALS.has(j))EXPANDED_RENTALS.delete(j); else EXPANDED_RENTALS.add(j); rtg.closest(".rcard").classList.toggle("open"); return; }
  const tog=e.target.closest("[data-toggle]"); if(tog){ if(reorderMode)return; const job=tog.dataset.toggle; const wasOpen=EXPANDED_FOLDERS.has(job); EXPANDED_FOLDERS.clear(); document.querySelectorAll("#foldersList .folder.open").forEach(f=>f.classList.remove("open")); if(!wasOpen){ EXPANDED_FOLDERS.add(job); tog.closest(".folder").classList.add("open"); } return; }
});

/* ---------- My Jobs add ---------- */
$("jobSearch").addEventListener("input",renderJobs);
$("jobAddBtn").addEventListener("click",()=>{ const v=$("jobSearch").value.trim(); v?addJob(v):toast("Type a job number first"); });
$("jobSearch").addEventListener("keydown",e=>{ if(e.key==="Enter"){const v=$("jobSearch").value.trim(); if(v)addJob(v);} });
$("notifClear").addEventListener("click",clearNotif);

/* ---------- Reorder My Jobs (up/down) ---------- */
$("reorderToggle").addEventListener("click",()=>{ reorderMode=!reorderMode; renderJobs(); });
$("orderReset").addEventListener("click",()=>{ JOB_ORDER=[]; syncUserJobs(); renderJobs(); toast("Back to newest-first"); });
function moveJob(job,dir){ const order=MJ_VIEW.slice(); const i=order.indexOf(job); if(i<0)return; const j=i+dir; if(j<0||j>=order.length)return; const t=order[i]; order[i]=order[j]; order[j]=t; JOB_ORDER=order; syncUserJobs(); renderJobs(); }

/* ---------- Identity (Webduct login primary; name captured once per email) ---------- */
function renderWho(){ const av=$("whoAv"),nm=$("whoName"); if(!av)return; if(USER){ av.textContent=((USER.first[0]||"")+(USER.last[0]||"")).toUpperCase(); nm.textContent=USER.first; } else { av.textContent="?"; nm.textContent="Sign in"; } if(typeof applyAccess==="function")applyAccess(); }
function findPersonByName(f,l){ const nn=nameNorm(f,l); return PEOPLE.find(p=>p.nameNorm===nn); }
function findPersonByEmail(em){ const e=(em||"").trim().toLowerCase(); if(!e)return null; return PEOPLE.find(p=>(p.email||"").trim().toLowerCase()===e); }

function openName(){
  $("n_first").value=USER?.first||""; $("n_last").value=USER?.last||"";
  $("si_email").value=USER?.email||""; $("n_emailHint").textContent="";
  $("nameSug").className="people-sug"; $("nameSug").innerHTML="";
  $("nameTitle").textContent=USER?"Your account":"Who are you?";
  $("nameCancel").style.display=USER?"block":"none"; $("nameX").style.display=USER?"block":"none";
  openModal("nameModal"); setTimeout(()=>$("n_first").focus(),300);
}
function closeName(){ closeModal("nameModal"); }

// The single path everything funnels through once we know name+email (+ optional token).
async function signInAs(first,last,email,token){
  const existing=findPersonByEmail(email)||findPersonByName(first,last);
  const id=existing?existing.id:personId(first,last);
  USER={first,last,email,id}; saveUser();
  if(token){ WD_TOKEN=token; sessionStorage.setItem("wd_token",token); if(typeof wdRenderToken==="function")wdRenderToken(); }
  MY_JOBS=[]; REMOVED_JOBS=new Set(); JOB_ORDER=[]; EXPANDED_FOLDERS.clear(); userRecordLoaded=false;
  if(fbReady){
    try{
      await setDoc(doc(db,"people",id),{first,last,nameNorm:nameNorm(first,last),email,updatedAt:serverTimestamp()},{merge:true});
      const snap=await getDoc(doc(db,"people",id));
      if(snap.exists()){ const me=snap.data();
        MY_JOBS=Array.isArray(me.savedJobs)?me.savedJobs.slice():[];
        REMOVED_JOBS=new Set(Array.isArray(me.removedJobs)?me.removedJobs:[]);
        JOB_ORDER=Array.isArray(me.jobOrder)?me.jobOrder.slice():[];
      }
      userRecordLoaded=true;
    }catch(e){console.error(e); toast("Signed in, but couldn't load your saved jobs");}
  } else { toast("No connection — your saved jobs can't load right now"); }
  const added=autoLinkJobs(); syncUserJobs();
  closeName(); renderWho(); renderAll();
  if($("view-jobs").classList.contains("active")) setView("jobs");
  toast(added?"Signed in — matching jobs linked":"Signed in");
  // Every login triggers an order pull using the shared admin key (loaded from Firebase).
  if(typeof wdAutoSync==="function") setTimeout(()=>wdAutoSync(), 1500);
  applyAccess();
  // First login on this device: offer the tutorial (only if they can actually see the app).
  if(!localStorage.getItem("tut_done") && userAccessAllowed()) setTimeout(()=>openTutorial(), 600);
}

/* ---------- Access control (basic, not security — an honest gate) ---------- */
// Default rule stays: an @arctic.biz email gets everything, anyone else gets nothing.
// On top of that, each page can be allowed/blocked per person in Manage People.
const VIEW_LABELS={feed:"Arrivals",rentals:"Rentals",jobs:"My Jobs",deliveries:"Deliveries",admin:"Admin"};
function isCompanyEmail(em){ return String(em||"").trim().toLowerCase().endsWith("@arctic.biz"); }
// Resolve a person's per-page permissions: explicit setting wins, else the email default.
function permsFor(p){
  const base=isCompanyEmail(p&&p.email);
  const set=(p&&p.perms)||{};
  const out={};
  VALID_VIEWS.forEach(v=>{ out[v] = (set[v]===undefined ? base : !!set[v]); });
  return out;
}
function myPerms(){
  if(!USER) return null;
  const p=PEOPLE.find(x=>x.id===USER.id);
  const rec = p ? {...p, email:(p.email||USER.email||"")} : {email:(USER.email||""), perms:null};
  return permsFor(rec);
}
function userCan(v){ const pm=myPerms(); return pm?!!pm[v]:false; }
function userAccessAllowed(){ const pm=myPerms(); return pm?VALID_VIEWS.some(v=>pm[v]):false; }
let applyingAccess=false;
function applyAccess(){
  const lock=$("lockScreen"); if(!lock || applyingAccess) return;
  applyingAccess=true;
  try{
    const nav=document.querySelector(".tabs");
    if(!USER){ lock.style.display="none"; document.querySelectorAll(".tab").forEach(t=>t.style.display=""); if(nav)nav.style.display=""; return; }
    const pm=myPerms()||{};
    let any=false;
    document.querySelectorAll(".tab").forEach(t=>{ const ok=!!pm[t.dataset.view]; t.style.display=ok?"":"none"; if(ok)any=true; });
    if(nav) nav.style.display=any?"":"none";
    lock.style.display=any?"none":"block";
    if(!any){ document.querySelectorAll(".view").forEach(v=>v.classList.remove("active")); return; }
    // If they're sitting on a page they're no longer allowed, move them to the first one they can see.
    const cur=document.querySelector(".view.active");
    const curName=cur?cur.id.replace("view-",""):null;
    if(!curName || !pm[curName]){ const first=VALID_VIEWS.find(v=>pm[v]); if(first) setView(first); }
  } finally { applyingAccess=false; }
}

/* ---------- Tutorial ---------- */
// [title, body, selector-to-highlight, tab-to-switch-to, setupFn]

// iPadOS 13+ reports itself as "MacIntel", so the platform string alone can't tell an iPad
// from a desktop Mac — the touch-point count is what separates them.
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform==="MacIntel" && navigator.maxTouchPoints>1);

// Step 1 for both tracks: keep the app somewhere you can find it again. index.html already
// sets apple-touch-icon and apple-mobile-web-app-title, so iOS offers the right icon and the
// name "Equipment Received" on its own — this step just tells people the option is there.
// Written to be read now and done after: you can't reach Safari's Share button while the
// tutorial sheet is open. Both bodies stay short so the step fits the sheet on a phone —
// it spotlights nothing, so tutRender gives it the taller .tut-nospot layout.
const TUT_SAVE_IOS=`Put it on your Home Screen — it opens full screen, like an app.
<ol class="tut-how">
  <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/><path d="M8.5 6.5 12 3l3.5 3.5"/><path d="M20 13v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-6"/></svg><span>Tap <b>Share</b> in Safari's toolbar.</span></li>
  <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="8 10.5 12 14.5 16 10.5"/></svg><span>Tap <b>View More</b> if you need to.</span></li>
  <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/></svg><span>Tap <b>Add to Home Screen</b>, then <b>Add</b>.</span></li>
</ol>
Leave <b>Open as Web App</b> on.`;
const TUT_SAVE_DESKTOP=`Save this page so it's always one click away.
<ol class="tut-how">
  <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.9 6.3 6.9.7-5.2 4.6 1.5 6.8L12 17.8 5.9 20.4l1.5-6.8L2.2 9l6.9-.7z"/></svg><span>Press <b>Ctrl + D</b> (<b>⌘ D</b> on a Mac), or click the ☆ in the address bar.</span></li>
</ol>
Use it daily? Drag the tab onto your bookmarks bar.`;
const TUT_SAVE = IS_IOS
  ? ["Keep it on your Home Screen", TUT_SAVE_IOS, "", ""]
  : ["Bookmark this page", TUT_SAVE_DESKTOP, "", ""];

// Shipping's job is logging what shows up: the entry, the photo, and where it's stored.
// Deliberately does NOT cover deliveries/pairing/rentals — that's not their workflow.
const TUT_SHIP=[
 TUT_SAVE,
 ["Start in Admin","Everything you log starts on the <b>Admin</b> tab. It's PIN protected — <b>ask your supervisor for the PIN</b> if you don't have it. (We've unlocked it just for this walkthrough.)","[data-view='admin']","admin",tutGrantAdmin],
 ["Log Arrival","Once you're in, this is the button. Material shows up → tap <b>Log Arrival</b>. That's the whole job — logging it is what makes it findable for everyone else.","#btnLog","admin",tutGrantAdmin],
 ["This is the form","Here's the real card, filled in as an example. Job # and description are the only required ones — but the more you fill in, the less anyone has to come ask you.","#f_desc","admin",tutOpenLogForm],
 ["Where you stored it","<b>Stored at</b> is the field people rely on most. \"Building 3\", \"Rack B-4\", \"back of the yard\" — whatever tells someone where to walk. Leave it blank and they're calling you.","#f_location","admin",tutOpenLogForm],
 ["Take a photo","Snap a picture as you log it. A photo answers questions no description can: is it the right part, is it damaged, how many pallets came.","#f_photoBtn","admin",tutOpenLogForm],
 ["Adding a photo later","Missed it? The 📷 button on any arrival card adds one anytime. Your name gets attached so people know who shot it.","[data-cam]","feed"],
 ["Fixing a log entry","Tap a card to open it — edit anything, add photos, or delete it if it was a mistake. Everyone sees the change instantly.",".acard","feed"],
 ["Finding what you stored","Search by job #, item, or supplier. Each card shows 📍 where it's stored and who logged it — so you can answer \"where's my stuff\" without walking the yard.","#feedSearch","feed"],
 ["Copy Name","Copies the item's name exactly. Handy when someone asks what came in — and if they paste it into their Webduct order word-for-word, it auto-links to what you logged.",".ac-copy","feed"],
 ["That's it","Log it, photo it, say where it is. Retake this anytime with the <b>? Tutorial</b> button up here.","#btnTutorial","feed"],
];
const TUT_FIELD=[
 TUT_SAVE,
 ["Finding material","The <b>Arrivals</b> tab lists everything the shop has received, newest first. Search by job #, item, or supplier.","#feedSearch","feed"],
 ["Order with the right name","Sign in with the same name you order under in Webduct — that's how the app matches orders to you and links your jobs automatically.","#whoChip","feed"],
 ["Arrival cards","Tap any card to see everything — details, photo, and who logged it.",".acard","feed"],
 ["Copy Name","It copies the arrival's name exactly. Paste that <i>word-for-word</i> into your Webduct order and the app links your order to the physical item automatically. Retype it your own way and someone has to pair it by hand.",".ac-copy","feed"],
 ["My Jobs — the one to use","<b>This is the most useful tab in the app.</b> Star ★ a job (or it auto-stars from your orders) and everything for it collects here — no scrolling the whole arrivals list. Split into <b>Arrivals</b>, <b>Equipment Rentals</b>, and <b>Tool Rentals</b>.","[data-view='jobs']","jobs",()=>tutOpenJobCard("arrivals")],
 ["What's on a card","Here's a card opened up: the photo, where it's stored, who logged it, delivery status, and the buttons — 📷 photo, Copy Name, share, and the 🚚 truck showing whether it's gone out.",".acard.open","jobs",()=>tutOpenJobCard("arrivals")],
 ["Equipment rentals","Flip to <b>Equipment Rentals</b> to see gear rented from a vendor for this job — what it is, the rate, the vendor, and whether it's still out.","#mjSeg","jobs",()=>tutOpenJobCard("rentals")],
 ["Tool rentals","<b>Tool Rentals</b> shows company tools charged to your job — tool #, days out, daily rate, and total. Handy for checking what's still billing to you.","#mjSeg","jobs",()=>tutOpenJobCard("tools")],
 ["The Deliveries calendar","See when everything's going out. Days show 📦 equipment, 🚚 deliveries, 🆙 pickups. Tap a day, then a job name, to see what's coming and when.","[data-view='deliveries']","feed"],
 ["That's it","Retake this anytime with the <b>? Tutorial</b> button up here.","#btnTutorial","feed"],
];
// Open a job folder + expand an arrival card so the My Jobs steps show a real, full card.
// Also picks the job the demo rental/tool rows attach to.
let TUT_DEMO=false;
const TUT_JOB="26-0000";   // the sample job folder shown only during the tutorial
function dIso(daysAgo){ const d=new Date(Date.now()-daysAgo*86400000); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); }
// Sample rows shown ONLY during the tutorial. Display-only objects — never written to
// Firebase, never added to the real arrays, gone the moment the tutorial ends.
const DEMO_NAME="Sample Job (tutorial only)";
function demoArrivals(job){ return [
  {id:"demo-a1", jobNumber:job, jobName:DEMO_NAME, description:'2) 4" butterfly valves w/ handles (SAMPLE)',
   dateReceived:dIso(1), supplier:"Ferguson", po:"PO-90210", storageLocation:"Rack B-4",
   requestedBy:"Sample data", photoBy:"", delivered:false, deliveredDate:"", reqDeliv:dIso(-2), partial:false},
  {id:"demo-a2", jobNumber:job, jobName:DEMO_NAME, description:"40 ft) 6\" spiral duct (SAMPLE)",
   dateReceived:dIso(4), supplier:"Acme", po:"PO-90188", storageLocation:"Yard",
   requestedBy:"Sample data", photoBy:"", delivered:true, deliveredDate:dIso(1), reqDeliv:dIso(2), partial:false},
]; }
function demoRentals(job){ return [
  {id:"demo-r1", jobNumber:job, jobName:DEMO_NAME, equipment:"Scissor Lift 26' (SAMPLE)", rentalId:"SL-4471", status:"Renting",
   dateRented:dIso(9), dateReturned:"", rate:"$310/wk", vendor:"United Rentals", po:"PO-88421", orderedBy:"Sample data"},
  {id:"demo-r2", jobNumber:job, jobName:DEMO_NAME, equipment:"Towable Air Compressor (SAMPLE)", rentalId:"AC-1180", status:"Returned",
   dateRented:dIso(24), dateReturned:dIso(3), rate:"$145/day", vendor:"Sunbelt", po:"PO-88190", orderedBy:"Sample data"},
]; }
function demoTools(job){ return [
  {id:"demo-t1", jobNumber:job, jobName:DEMO_NAME, toolType:"Cordless 20 V SawZall (SAMPLE)", toolId:"3490", status:"Out",
   rentalStarted:dIso(31), rentalEnded:"", billingDays:31, dailyRate:1.54, billingTotal:"47.74", discountedRate:"26.26"},
  {id:"demo-t2", jobNumber:job, jobName:DEMO_NAME, toolType:"Medium Gang Box (SAMPLE)", toolId:"GB6", status:"Out",
   rentalStarted:dIso(18), rentalEnded:"", billingDays:18, dailyRate:2.18, billingTotal:"39.24", discountedRate:"21.58"},
  {id:"demo-t3", jobNumber:job, jobName:DEMO_NAME, toolType:"Step Ladder 8' (SAMPLE)", toolId:"1882", status:"Returned",
   rentalStarted:dIso(40), rentalEnded:dIso(6), billingDays:34, dailyRate:1.78, billingTotal:"60.52", discountedRate:"33.29"},
]; }
// Logging lives behind the admin PIN, so the logging steps would spotlight a hidden
// button. Unlock it just for the walkthrough and put it back exactly as we found it.
// Deliberately NOT written to sessionStorage — a refresh returns to locked.
let TUT_ADMIN_WAS=null;
function tutGrantAdmin(){
  if(TUT_ADMIN_WAS===null) TUT_ADMIN_WAS=adminUnlocked;
  if(!adminUnlocked){ adminUnlocked=true; try{ syncAdminView(); }catch(_){} }
}
function tutRestoreAdmin(){
  if(TUT_ADMIN_WAS===null) return;
  const was=TUT_ADMIN_WAS; TUT_ADMIN_WAS=null;
  if(adminUnlocked!==was){ adminUnlocked=was; try{ syncAdminView(); }catch(_){} try{ renderAll(); }catch(_){} }
}
// The logging steps open the REAL log form with a realistic example filled in, so the
// crew sees the actual card rather than a button. Cleared + closed when they move on;
// Save is disabled while the tutorial runs so a sample can't become a real arrival.
function tutOpenLogForm(){
  tutGrantAdmin();
  try{
    editing=null;
    $("logTitle").textContent="Log Arrival — example";
    $("logDelete").style.display="none";
    $("f_date").value=todayIso();
    $("f_job").value="26-0093";
    $("f_jobname").value="PCC Rock Creek";
    $("f_po").value="112989";
    $("f_desc").value='6) L212 - 2" bend 1/8"';
    $("f_supplier").value="Ferguson";
    $("f_location").value="Rack B-4";
    $("f_req").value="";
    $("jobnameHint").textContent="";
    if(typeof logPhotoReset==="function") logPhotoReset();
    openModal("logModal");
  }catch(_){}
}
function tutCloseLogForm(){
  try{
    closeModal("logModal");
    ["f_po","f_job","f_req","f_jobname","f_desc","f_supplier","f_location"].forEach(i=>{ const el=$(i); if(el) el.value=""; });
    $("logTitle").textContent="Log Arrival";
    if(typeof logPhotoReset==="function") logPhotoReset();
  }catch(_){}
}
function tutOpenJobCard(seg){
  try{
    TUT_DEMO=true;
    if(typeof EXPANDED_FOLDERS!=="undefined") EXPANDED_FOLDERS.add(TUT_JOB);
    if(typeof EXPANDED_ARR!=="undefined") EXPANDED_ARR.add("demo-a1");
    // Clear filters — a leftover month/search would hide the sample job entirely.
    const ms=$("mjMonth"), ss=$("jobSearch"); if(ms) ms.value=""; if(ss) ss.value="";
    if(seg){ const b=document.querySelector(`#mjSeg button[data-seg='${seg}']`); if(b){ b.click(); return; } mjSeg=seg; }
    if(typeof renderJobs==="function") renderJobs();
  }catch(_){}
}
let TUT_LIST=null, TUT_I=0;
function tutClearSpot(){ document.querySelectorAll(".tut-spot").forEach(e=>e.classList.remove("tut-spot")); }
function tutClearDemo(){ const had=TUT_DEMO; TUT_DEMO=false; if(had){ try{ EXPANDED_FOLDERS.delete(TUT_JOB); EXPANDED_ARR.delete("demo-a1"); }catch(_){} if(typeof renderJobs==="function"){ try{ renderJobs(); }catch(_){} } } }
function openTutorial(){ $("tutChoose").style.display="block"; $("tutSteps").style.display="none"; $("tutTitle").textContent="Welcome!"; document.body.classList.remove("tut-live"); tutClearSpot(); tutClearDemo(); tutRestoreAdmin(); openModal("tutModal"); }
function tutStart(list, label){ TUT_LIST=list; TUT_I=0; $("tutTitle").textContent=label; $("tutChoose").style.display="none"; $("tutSteps").style.display="block"; document.body.classList.add("tut-live"); tutRender(); }
function tutRender(){
  const [t,b,sel,tab,setup]=TUT_LIST[TUT_I];
  $("tutProg").textContent=`Step ${TUT_I+1} of ${TUT_LIST.length}`;
  $("tutStepTitle").textContent=t; $("tutStepBody").innerHTML=b;
  $("tutBack").style.visibility=TUT_I===0?"hidden":"visible";
  $("tutNext").textContent=TUT_I===TUT_LIST.length-1?"Done ✓":"Next ›";
  // Switch to the tab this step lives on, run any setup (open the log form, open a card,
  // flip a segment), then spotlight the element it describes.
  // The sheet is normally capped short so the spotlighted element stays visible above it.
  // A step with nothing to spotlight has no such constraint, so let it use the full height
  // rather than cramming its content into a sheet sized for a page it isn't pointing at.
  $("tutModal").classList.toggle("tut-nospot", !sel);
  if(setup!==tutOpenLogForm) tutCloseLogForm();
  if(tab && typeof setView==="function"){ try{ setView(tab); }catch(_){} }
  if(typeof setup==="function"){ try{ setup(); }catch(_){} }
  tutClearSpot();
  if(sel){
    setTimeout(()=>{
      let el=null; try{ el=document.querySelector(sel); }catch(_){}
      if(el){
        el.classList.add("tut-spot");
        const r=el.getBoundingClientRect();
        // Only scroll if it's off-screen or hidden behind the sheet (which covers the lower half).
        if(r.top<70 || r.bottom>window.innerHeight*0.45) el.scrollIntoView({block:"center",behavior:"smooth"});
      }
    },90);
  }
}
function tutFinish(){ localStorage.setItem("tut_done","1"); document.body.classList.remove("tut-live"); tutClearSpot(); tutClearDemo(); tutCloseLogForm(); tutRestoreAdmin(); closeModal("tutModal"); }

/* ---------- Manual import trigger (GitHub workflow_dispatch) ---------- */
// Repo details are fixed — no reason to make anyone type them. Only the token is
// stored (config/ghActions), pasted once by one person, then it just works for everyone.
const GH_OWNER="Arctic-Mech", GH_REPO="Equipment-Received", GH_BRANCH="main";
const GH_WORKFLOW="email-arrivals.yml";
let GH_CFG=null;   // {token} from config/ghActions — shared with the team
let ghCooldown=0;
function ghRenderBtn(){
  const b=$("runImportBtn"); if(b) b.style.display="block";   // always there for everyone
}
async function ghSaveCfg(){
  const token=$("ghToken").value.trim();
  if(!token){ $("ghHint").textContent="Paste the token to save."; return; }
  if(!fbReady){ toast("No connection"); return; }
  try{
    await setDoc(doc(db,"config","ghActions"),{token,updatedAt:serverTimestamp()},{merge:true});
    $("ghToken").value="";
    closeModal("ghModal");
    toast("Saved — tap Run import now again to start it");
  }catch(e){ console.error(e); $("ghHint").textContent="Couldn't save — check the config Firestore rule."; }
}
async function ghRunImport(){
  if(!GH_CFG||!GH_CFG.token){ openModal("ghModal"); return; }   // first use: set it up right here
  if(Date.now()<ghCooldown){ toast("Already triggered — give it a minute"); return; }
  // If today's sheet is already in, a plain run would no-op; offer force instead.
  const alreadyToday=!!(LAST_IMPORT&&LAST_IMPORT.at&&sameLocalDay(LAST_IMPORT.at,Date.now()));
  const force=alreadyToday?confirm("Today's sheet is already imported. Force a re-import of the newest email?"):false;
  if(alreadyToday&&!force) return;
  const b=$("runImportBtn"); b.disabled=true; b.textContent="Starting…";
  try{
    const r=await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/actions/workflows/${GH_WORKFLOW}/dispatches`,{
      method:"POST",
      headers:{ "Accept":"application/vnd.github+json", "Authorization":"Bearer "+GH_CFG.token, "X-GitHub-Api-Version":"2022-11-28" },
      body:JSON.stringify({ ref:GH_BRANCH, inputs:{ dry_run:"false", force:force?"true":"false" } })
    });
    if(r.status===204){ ghCooldown=Date.now()+60000; toast("Import started — results in ~1-2 min"); b.textContent="Running…"; setTimeout(()=>{ b.disabled=false; b.textContent="▶ Run import now"; },60000); }
    else if(r.status===401||r.status===403){ toast("GitHub rejected the token — re-save it in Admin"); b.disabled=false; b.textContent="▶ Run import now"; }
    else if(r.status===404){ toast("Repo/workflow not found — check owner + repo in Admin"); b.disabled=false; b.textContent="▶ Run import now"; }
    else { toast("GitHub said "+r.status); b.disabled=false; b.textContent="▶ Run import now"; }
  }catch(e){ console.error(e); toast("Couldn't reach GitHub"); b.disabled=false; b.textContent="▶ Run import now"; }
}

// (Legacy Webduct-login handlers removed — sign-in is now name + email only.
//  Webduct order pulls use the shared admin key, loaded from Firebase.)

function pickPerson(p){ $("n_first").value=p.first; $("n_last").value=p.last; if(p.email && !$("si_email").value) $("si_email").value=p.email; $("nameSug").className="people-sug"; $("nameSug").innerHTML=""; }
function renderNameSug(){
  const sug=$("nameSug"); const f=$("n_first").value.trim().toLowerCase(),l=$("n_last").value.trim().toLowerCase();
  if(!f && !l){ sug.className="people-sug"; sug.innerHTML=""; return; }
  const list=PEOPLE.filter(p=>(p.first||"").toLowerCase().startsWith(f) || (f+" "+l).trim() && (p.first+" "+p.last).toLowerCase().includes((f+" "+l).trim())).slice(0,6);
  if(!list.length){ sug.className="people-sug"; sug.innerHTML=""; return; }
  sug.innerHTML=list.map(p=>`<div class="ps-item" data-namepick="${esc(p.id)}"><span class="ps-av">${esc(((p.first[0]||"")+(p.last[0]||"")).toUpperCase())}</span><div><div class="ps-name">${esc(p.first+" "+p.last)}</div><div class="ps-email">${esc(p.email||"No email on file")}</div></div></div>`).join("");
  sug.className="people-sug show";
}
$("n_first").addEventListener("input",renderNameSug); $("n_last").addEventListener("input",renderNameSug);
document.addEventListener("click",e=>{ const np=e.target.closest("[data-namepick]"); if(np){ const p=PEOPLE.find(x=>x.id===np.dataset.namepick); if(p)pickPerson(p); } });
onActivate($("nameCancel"),closeName); onActivate($("nameX"),closeName);
document.querySelectorAll("[data-changename]").forEach(b=>b.addEventListener("click",openName));
onActivate($("whoChip"),openName);
onActivate($("vabBack"),()=>{ VIEW_AS=null; setView("jobs"); });

// Single sign-in: name + email.
onActivate($("nameSubmit"),async()=>{
  const f=$("n_first").value.trim(),l=$("n_last").value.trim(),em=$("si_email").value.trim();
  if(!f||!l){toast("Enter first and last name");return;}
  // Email is optional, but if provided it must be valid.
  if(em&&!/^\S+@\S+\.\S+$/.test(em)){toast("That email doesn't look right");$("si_email").focus();return;}
  await signInAs(f,l,em,"");
});

/* ---------- Delivery ---------- */
function openDeliv(id){ const r=ARRIVALS.find(x=>x.id===id); if(!r)return; delivTarget=id; $("delivItem").textContent=(r.description||"This arrival")+(isRealJob(r.jobNumber)?"  ·  "+normJob(r.jobNumber):""); $("d_req").value=r.reqDeliv||""; $("d_delivered").checked=!!r.delivered; $("d_date").value=r.deliveredDate||""; $("d_partial").checked=!!r.partial; $("d_dateWrap").style.display=r.delivered?"block":"none"; openModal("delivModal"); }
$("d_delivered").addEventListener("change",()=>{ const on=$("d_delivered").checked; $("d_dateWrap").style.display=on?"block":"none"; if(on){ if(!$("d_date").value)$("d_date").value=todayIso(); setTimeout(()=>$("d_date").focus(),60); } });
async function saveDeliv(clear){
  if(!delivTarget)return; if(!fbReady){toast("No Firebase connection");return;}
  const btn=$("delivSubmit"); btn.disabled=true; btn.textContent="Saving…";
  let payload;
  if(clear) payload={reqDeliv:"",delivered:false,deliveredDate:"",partial:false,deliveryDate:""};
  else { const delivered=$("d_delivered").checked; payload={reqDeliv:$("d_req").value||"",delivered,deliveredDate:delivered?($("d_date").value||todayIso()):"",partial:$("d_partial").checked,deliveryDate:delivered?($("d_date").value||todayIso()):""}; }
  try{ await setDoc(doc(db,"arrivals",delivTarget),{...payload,updatedAt:serverTimestamp()},{merge:true}); closeModal("delivModal"); toast(clear?"Delivery info cleared":"Delivery saved"); delivTarget=clear?null:delivTarget; }
  catch(e){ console.error(e); toast("Save failed: "+(e.code||e.message)); }
  finally{ btn.disabled=false; btn.textContent="Save"; }
}
onActivate($("delivSubmit"),()=>saveDeliv(false));
onActivate($("delivClear"),()=>saveDeliv(true));

/* ---------- Share arrivals ---------- */
function buildArrivalLink(id){ return location.origin+location.pathname+"#arrival-"+id; }
function openShare(arrivalId){
  const r=ARRIVALS.find(x=>x.id===arrivalId); if(!r){toast("Arrival not found");return;}
  shareArrivalId=arrivalId; shareJob=isRealJob(r.jobNumber)?normJob(r.jobNumber):null;
  shareArrivalName=r.description||"";
  $("shareItem").innerHTML=`${shareJob?`Sharing job <b>${esc(shareJob)}</b>${r.jobName?" · "+esc(r.jobName):""}<br>`:""}${esc(r.description||"")}`;
  $("shareTo").value=""; $("shareHint").textContent=""; $("shareSug").className="people-sug";
  const canShareToPerson=!!(shareJob && USER);
  $("shareTo").closest(".field").style.display=canShareToPerson?"block":"none";
  document.querySelector(".share-divider").style.display=canShareToPerson?"flex":"none";
  $("shareLinkUrl").value=buildArrivalLink(arrivalId);
  $("shareLinkCopy").textContent="Copy"; $("shareLinkCopy").classList.remove("copied");
  openModal("shareModal");
  if(canShareToPerson) setTimeout(()=>$("shareTo").focus(),300);
}
onActivate($("shareCopyName"),async()=>{
  const name=shareArrivalName||"";
  if(!name){ toast("No name to copy"); return; }
  copyToClipboard(name);
  const b=$("shareCopyName"); b.textContent="Copied ✓"; setTimeout(()=>{ b.textContent="📋 Copy arrival name"; },1600);
});
let WD_PAIR_TARGET={docId:"",arrivalId:"",order:null,thenDeliver:false};
function wdOpenPairKind(docId, arrivalId){ WD_PAIR_TARGET={docId,arrivalId,order:null,thenDeliver:false}; openModal("pairModal"); }
// From the item checkmark on an auto-linked arrival: ask full/partial, then set it AND mark delivered.
function wdOpenPairKindThenDeliver(docId, arrivalId, order){ WD_PAIR_TARGET={docId,arrivalId,order,thenDeliver:true}; openModal("pairModal"); }
async function wdDoPair(partial){
  const {docId,arrivalId,order,thenDeliver}=WD_PAIR_TARGET; if(!docId){ closeModal("pairModal"); return; }
  WD_PICK_OPEN[docId]="";
  await wdSetMatch(docId,"confirmed",arrivalId,partial);
  closeModal("pairModal");
  if(thenDeliver && order){
    // Mark the arrival delivered using the order's scheduled date.
    const schedIso=order.requestedDate||order.deliveryDate||order.orderedDate||"";
    let schedDate=""; if(schedIso){ const d=new Date(schedIso); if(!isNaN(d)) schedDate=d.toISOString().slice(0,10); }
    if(!schedDate) schedDate=(new Date()).toISOString().slice(0,10);
    try{ await setDoc(doc(db,"arrivals",arrivalId),{delivered:true,deliveredDate:schedDate,updatedAt:serverTimestamp()},{merge:true}); }catch(e){ console.error(e); }
    toast(partial?"Delivered (partial)":"Marked delivered");
  } else {
    toast(partial?"Paired (partial)":"Paired with arrival");
  }
}
onActivate($("shareLinkCopy"),async()=>{
  const url=$("shareLinkUrl").value;
  try{
    await navigator.clipboard.writeText(url);
    toast("Link copied");
    const b=$("shareLinkCopy"); b.textContent="Copied ✓"; b.classList.add("copied"); setTimeout(()=>{ b.textContent="Copy"; b.classList.remove("copied"); },1800);
  }catch(e){
    const inp=$("shareLinkUrl"); inp.removeAttribute("readonly"); inp.focus(); inp.select(); try{inp.setSelectionRange(0,url.length);}catch(_){}
    toast("Tap and hold the link, then Copy");
  }
});
$("shareTo").addEventListener("input",()=>{ const q=$("shareTo").value.trim().toLowerCase(); const sug=$("shareSug"); if(!q){ sug.className="people-sug"; sug.innerHTML=""; return; } const list=PEOPLE.filter(p=>p.id!==USER?.id).filter(p=>(p.first+" "+p.last).toLowerCase().includes(q)||(p.email||"").toLowerCase().includes(q)).slice(0,6); sug.innerHTML=list.length?list.map(p=>`<div class="ps-item" data-sharepick="${esc(p.id)}"><span class="ps-av">${esc(((p.first[0]||"")+(p.last[0]||"")).toUpperCase())}</span><div><div class="ps-name">${esc(p.first+" "+p.last)}</div><div class="ps-email">${esc(p.email||"")}</div></div></div>`).join(""):`<div class="ps-item" style="color:var(--steel)">No one found by that name. Bobby can add people in Admin → Manage People.</div>`; sug.className="people-sug show"; });
document.addEventListener("click",e=>{ const pick=e.target.closest("[data-sharepick]"); if(pick){ createShare(pick.dataset.sharepick); } });
async function createShare(toId){ const p=PEOPLE.find(x=>x.id===toId); if(!p||!USER||!shareJob){return;} if(!fbReady){toast("No connection");return;} const r=ARRIVALS.find(x=>x.id===shareArrivalId); try{ await setDoc(doc(db,"shares","s-"+Date.now().toString(36)+Math.random().toString(36).slice(2,6)),{toId,toName:p.first+" "+p.last,fromId:USER.id,fromName:USER.first+" "+USER.last,jobNumber:shareJob,jobName:r?.jobName||"",arrivalId:shareArrivalId,status:"pending",createdAt:serverTimestamp()}); closeModal("shareModal"); toast("Shared with "+p.first); }catch(e){ console.error(e); toast("Share failed: "+(e.code||e.message)); } }
async function acceptShare(id){ const s=SHARES.find(x=>x.id===id); if(!s)return; addJob(s.jobNumber); if(fbReady){ try{ await setDoc(doc(db,"shares",id),{status:"accepted"},{merge:true}); }catch(e){console.error(e);} } }
async function dismissShare(id){ if(fbReady){ try{ await setDoc(doc(db,"shares",id),{status:"dismissed"},{merge:true}); }catch(e){console.error(e);} } renderJobs(); }

/* ---------- People management ---------- */
$("btnPeople").addEventListener("click",()=>{ renderPeople(); openModal("peopleModal"); });
const PERM_OPEN=new Set();   // people whose permission panel is expanded
function renderPeople(){
  const list=$("peopleList");
  const sorted=[...PEOPLE].sort((a,b)=>(a.first+a.last).toLowerCase()<(b.first+b.last).toLowerCase()?-1:1);
  const row=p=>{
    const pm=permsFor(p);
    const open=PERM_OPEN.has(p.id);
    const n=VALID_VIEWS.filter(v=>pm[v]).length;
    const auto=isCompanyEmail(p.email);
    const custom=!!(p.perms && Object.keys(p.perms).length);
    const sub = n===0 ? "No access" : (n===VALID_VIEWS.length ? "All pages" : `${n} of ${VALID_VIEWS.length} pages`);
    const tag = custom ? `<span class="acc-chip acc-custom">Custom</span>`
                       : `<span class="acc-chip ${auto?'acc-auto-in':'acc-auto-out'}">${auto?"Auto · @arctic.biz":"Auto · no access"}</span>`;
    return `<div class="pr ${open?'open':''}">
      <div class="pr-head" data-popen="${esc(p.id)}">
        <span class="ps-av" style="background:var(--steel)">${esc(((p.first[0]||"")+(p.last[0]||"")).toUpperCase())}</span>
        <div style="flex:1;min-width:0">
          <div class="pr-name">${esc(p.first+" "+p.last)} ${tag}</div>
          <div class="pr-sub">${esc(sub)}${p.email?` · ${esc(p.email)}`:" · no email"}</div>
        </div>
        <span class="pr-chev">${open?"▾":"▸"}</span>
      </div>
      ${open?`<div class="pr-body">
        <div class="pr-lbl">Pages this person can open</div>
        <div class="pr-perms">${VALID_VIEWS.map(v=>`<button class="perm-btn ${pm[v]?'on':'off'}" data-perm="${esc(p.id)}|||${v}">${pm[v]?"✓":"✕"} ${VIEW_LABELS[v]}</button>`).join("")}</div>
        <div class="pr-lbl" style="margin-top:12px">Email</div>
        <div style="display:flex;gap:6px">
          <input type="email" value="${esc(p.email||"")}" data-pemail="${esc(p.id)}" placeholder="[email protected]" style="flex:1;border:1px solid var(--line);border-radius:8px;padding:8px 9px;font-size:13px">
          <button class="share-btn" data-psave="${esc(p.id)}" style="margin:0">Save</button>
        </div>
        <div class="pr-note">An <b>@arctic.biz</b> email allows every page by default. Tapping a page above sets it explicitly and overrides that.${custom?` <button class="perm-reset" data-permreset="${esc(p.id)}">Reset to default</button>`:""}</div>
        <div class="pr-hash">#${esc(personalHashFor(p))}</div>
      </div>`:""}
    </div>`;
  };
  list.innerHTML=`<div style="font-family:'Barlow Condensed';font-weight:700;letter-spacing:.04em;text-transform:uppercase;font-size:13px;color:var(--steel);margin:0 0 4px">${sorted.length} ${sorted.length===1?"person":"people"}</div>
    <div style="font-size:11.5px;color:var(--steel);margin-bottom:10px">Tap a name to set which pages they can open.</div>`
    + (sorted.length?sorted.map(row).join(""):`<div class="sub-empty">No people yet. Add someone above.</div>`);
}
onActivate($("pp_add"),async()=>{ const f=$("pp_first").value.trim(),l=$("pp_last").value.trim(),em=$("pp_email").value.trim(); if(!f||!l){toast("Enter first and last name");return;} if(em&&!/^\S+@\S+\.\S+$/.test(em)){toast("Enter a valid email");return;} if(!fbReady){toast("No connection");return;} const id=personId(f,l); try{ await setDoc(doc(db,"people",id),{first:f,last:l,nameNorm:nameNorm(f,l),email:em,updatedAt:serverTimestamp()},{merge:true}); $("pp_first").value="";$("pp_last").value="";$("pp_email").value=""; toast("Saved "+f); setTimeout(renderPeople,400); }catch(e){toast("Failed: "+(e.code||e.message));} });
document.addEventListener("click",async e=>{ const sv=e.target.closest("[data-psave]"); if(sv){ const id=sv.dataset.psave; const inp=document.querySelector(`[data-pemail="${id}"]`); const em=inp?inp.value.trim():""; if(em&&!/^\S+@\S+\.\S+$/.test(em)){toast("Enter a valid email");return;} if(!fbReady){toast("No connection");return;} try{ await setDoc(doc(db,"people",id),{email:em,updatedAt:serverTimestamp()},{merge:true}); toast("Email saved"); }catch(err){toast("Failed");} } });

/* ---------- Deliveries page ---------- */
$("delSearch").addEventListener("input",renderDeliveries); $("delClr").addEventListener("click",()=>{$("delSearch").value="";renderDeliveries();});
function delivIconsFor(r){
  const hasPhoto=!!r.photoBy;
  const cam=`<button class="mini-btn cam ${hasPhoto?'has':''}" data-cam="${esc(r.id)}" title="${hasPhoto?'Photo by '+esc(r.photoBy):'Add photo'}"><svg width="17" height="17" viewBox="0 0 24 24" fill="${hasPhoto?'currentColor':'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="3.5"></circle></svg></button>`;
  const shr=`<button class="mini-btn" data-share="${esc(r.id)}" title="Share"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"></line><line x1="15.4" y1="6.5" x2="8.6" y2="10.5"></line></svg></button>`;
  const deliv=`<button class="mini-btn deliv-btn ${r.delivered?'set':''}" data-deliv="${esc(r.id)}" title="Edit delivery"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="15" height="13"></rect><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"></polygon><circle cx="5.5" cy="18.5" r="2.5"></circle><circle cx="18.5" cy="18.5" r="2.5"></circle></svg></button>`;
  const cpy=`<button class="mini-btn ac-copy" data-copyname="${esc(r.description||"")}" title="Copy arrival name">Copy Name</button>`;
  return cpy+cam+shr+deliv;
}
function deliveryRow(r){ const job=normJob(r.jobNumber); return `<div class="acard open" data-type="arrival" data-id="${esc(r.id)}"><div class="acard-head" style="cursor:default"><div class="ac-job"><span class="jobbadge ${isRealJob(job)?'':'na'}">${esc(isRealJob(job)?job:"—")}</span></div><div class="ac-name">${esc(r.jobName)||'<span style="color:var(--steel-light)">No job name</span>'}</div><div class="ac-icons">${delivIconsFor(r)}</div><div class="ac-desc">${esc(r.description)||""}</div><div class="ac-foot">${r.delivered?`<span class="m deliv">✓ Delivered${r.deliveredDate?" "+esc(longDate(r.deliveredDate).split(",")[0]):""}</span>`:`<span class="m reqd">Requested ${esc(longDate(r.reqDeliv).split(",")[0])}</span>`}${r.partial?'<span class="m partial">⚠ Partial</span>':""}${r.storageLocation?`<span class="m loc">📍 ${esc(r.storageLocation)}</span>`:""}${r.photoBy?`<span class="m loc">📷 ${esc(r.photoBy)}</span>`:""}</div></div></div>`; }

/* ---------- Deliveries calendar ---------- */
let arrCalYear, arrCalMonth, arrCalSelDay=null, arrViewMode="list";
// Build & render the Arrivals-tab calendar (arrivals by requested-delivery date).
function renderArrCalendar(){
  const grid=$("arrGrid"); if(!grid) return;
  if(arrCalYear===undefined){ const n=new Date(); arrCalYear=n.getFullYear(); arrCalMonth=n.getMonth(); }
  const MONTHS=["January","February","March","April","May","June","July","August","September","October","November","December"];
  $("arrTitle").textContent=MONTHS[arrCalMonth]+" "+arrCalYear;
  const first=new Date(arrCalYear,arrCalMonth,1), startDow=first.getDay(), daysIn=new Date(arrCalYear,arrCalMonth+1,0).getDate();
  const _t=new Date(); const todayKey=_t.getFullYear()+"-"+String(_t.getMonth()+1).padStart(2,"0")+"-"+String(_t.getDate()).padStart(2,"0");
  // Map arrivals to the day they were LOGGED (received). dateReceived is already "YYYY-MM-DD",
  // so use it directly as the key — converting through Date shifts it a day in western timezones.
  const dayKeyOf=r=>{ const s=r.dateReceived||""; if(/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0,10); return s?dateKeyLocal(s):""; };
  const map={};
  ARRIVALS.forEach(r=>{ const key=dayKeyOf(r); if(key){ (map[key]=map[key]||{items:[]}).items.push(r); } });
  let html=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(d=>`<div class="cal-dow">${d}</div>`).join("");
  for(let i=0;i<startDow;i++) html+=`<div class="cal-cell blank"></div>`;
  for(let day=1;day<=daysIn;day++){
    const key=arrCalYear+"-"+String(arrCalMonth+1).padStart(2,"0")+"-"+String(day).padStart(2,"0");
    const m=map[key];
    const n=m?m.items.length:0;
    const has=n>0;
    const isSel=key===arrCalSelDay;
    const marks=n?`<span class="cal-mk"><span class="cal-dot req"></span><span class="cal-mkn">${n}</span></span>`:"";
    if(isSel){
      const rows=(m?m.items:[]).map(r=>arrivalRow(r,{compact:true,star:true})).join("");
      html+=`<div class="cal-cell has sel" data-arrday="${key}"><div class="cal-day-head"><span class="cal-num">${day}</span><button class="cal-day-close" data-arrclose="1">✕ Close</button></div><div class="cal-daycount">${n} arrival${n===1?"":"s"} logged</div><div class="cal-jobnames" style="gap:8px">${rows||'<div class="cal-day-empty">No arrivals this day.</div>'}</div></div>`;
    } else {
      html+=`<div class="cal-cell ${key===todayKey?'today':''} ${has?'has':''}" ${has?`data-arrday="${key}"`:""}><span class="cal-num">${day}</span><span class="cal-dots">${marks}</span></div>`;
    }
  }
  grid.innerHTML=html;
}
function setArrView(mode){
  arrViewMode=mode;
  document.querySelectorAll("#arrViewSeg button").forEach(b=>b.classList.toggle("on",b.dataset.arrview===mode));
  $("arrListWrap").style.display=mode==="list"?"block":"none";
  $("arrCalWrap").style.display=mode==="cal"?"block":"none";
  if(mode==="cal") renderArrCalendar();
}

/* ---------- Deliveries calendar (main) ---------- */
let calYear, calMonth, calSelDay=null;   // selected day = "YYYY-MM-DD"
let calDayOpenJob=null;                  // docId of the one order expanded inside the day cell (only one at a time)
let calSortByTime=false;                 // day view: sort deliveries by earliest delivery time
function dateKeyLocal(iso){ if(!iso)return ""; const d=new Date(iso); if(isNaN(d))return ""; return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); }
// Build a map of day-key → {req:[arrivals], done:[arrivals], wd:[equip]} for the visible month.
// Is this order/job "mine"? (ordered by my email, or on a job I've starred.)
function wdOrderIsMine(o){
  // "Just mine" = orders on jobs I've starred in My Jobs. Nothing else — not even
  // orders I placed myself, unless that job is starred.
  return !!(o.job && MY_JOBS.some(j=>normJob(j)===normJob(o.job)));
}
function buildDeliveryMap(){
  const map={};
  const put=(k,bucket,item)=>{ if(!k)return; (map[k]=map[k]||{req:[],done:[],wd:[],orders:[]})[bucket].push(item); };
  ARRIVALS.forEach(r=>{
    if(r.reqDeliv && !r.delivered) put(dateKeyLocal(r.reqDeliv),"req",r);
    if(r.delivered && r.deliveredDate) put(dateKeyLocal(r.deliveredDate),"done",r);
  });
  // Webduct orders → calendar. Filtered to mine when the toggle says so.
  WD_ORDERS.forEach(o=>{
    if(calShowMine && !wdOrderIsMine(o)) return;
    const k=dateKeyLocal(o.requestedDate||o.deliveryDate||o.orderedDate); if(k) put(k,"orders",o);
  });
  return map;
}
function renderCalendar(){
  const grid=$("calGrid"); if(!grid)return;
  const now=new Date();
  if(calYear==null){ calYear=now.getFullYear(); calMonth=now.getMonth(); }
  const MONTHS=["January","February","March","April","May","June","July","August","September","October","November","December"];
  $("calTitle").textContent=MONTHS[calMonth]+" "+calYear;
  const map=buildDeliveryMap();
  const first=new Date(calYear,calMonth,1); const startDow=first.getDay();
  const daysIn=new Date(calYear,calMonth+1,0).getDate();
  const todayKey=dateKeyLocal(now.toISOString());
  let html=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(d=>`<div class="cal-dow">${d}</div>`).join("");
  for(let i=0;i<startDow;i++) html+=`<div class="cal-cell blank"></div>`;
  for(let day=1;day<=daysIn;day++){
    const key=calYear+"-"+String(calMonth+1).padStart(2,"0")+"-"+String(day).padStart(2,"0");
    const m=map[key];
    const orders=m?m.orders:[];
    const equipN=orders.filter(o=>o.hasEquip).length;
    const jobsiteN=orders.filter(o=>!o.hasEquip && o.shipType==="jobsite").length;
    const pickupN=orders.filter(o=>!o.hasEquip && o.shipType!=="jobsite").length;
    const hasArrReq=m&&m.req.length, hasDone=m&&m.done.length;
    const has=orders.length||hasArrReq||hasDone;
    const isSel=key===calSelDay;
    // Each icon carries its own count. Numbers show next to the icon.
    let marks="";
    if(equipN)   marks+=`<span class="cal-mk"><span class="cal-emoji">📦</span><span class="cal-mkn">${equipN}</span></span>`;
    if(jobsiteN) marks+=`<span class="cal-mk"><span class="cal-emoji">🚚</span><span class="cal-mkn">${jobsiteN}</span></span>`;
    if(pickupN)  marks+=`<span class="cal-mk"><span class="cal-emoji">🆙</span><span class="cal-mkn">${pickupN}</span></span>`;
    if(hasArrReq) marks+=`<span class="cal-mk"><span class="cal-dot req"></span><span class="cal-mkn">${hasArrReq}</span></span>`;
    if(hasDone) marks+='<span class="cal-dot done"></span>';
    // Job names only render on the currently-selected day, in the SAME order as the list below
    // (equipment first, then job-site deliveries, then pickups). Each row has editable time + truck,
    // and clicking the name expands the full order card inline (one open at a time).
    let dayInner="";
    if(isSel){
      const cleanName=o=>String(o.orderedBy||"").replace(/\s*\(?\d[\d\s().-]{6,}\)?/g,"").trim();
      // Group orders by job name (each job shows once; its orders open together).
      const byJob=new Map();
      orders.forEach(o=>{ const nm=(o.jobName||o.job||"").trim(); if(!nm)return; if(!byJob.has(nm))byJob.set(nm,[]); byJob.get(nm).push(o); });
      // A job goes on the DELIVERIES side if ANY of its orders is a delivery (equipment or job-site).
      // Its pickups ride along on the deliveries side too. Pickup-only jobs go on the PICKUP side.
      const jobIsDelivery=nm=>byJob.get(nm).some(o=>o.hasEquip||o.shipType==="jobsite");
      const delJobs=[...byJob.keys()].filter(jobIsDelivery);
      const pickJobs=[...byJob.keys()].filter(nm=>!jobIsDelivery(nm));
      // Order a set of job names: by time if the toggle is on, else alphabetical-by-orderer with
      // co-orderer clustering (people who share a job stay adjacent).
      function orderJobs(keys){
        keys=keys.slice();
        if(calSortByTime){
          const jobTime=nm=>{ const times=byJob.get(nm).map(o=>wdParseTime(wdNotesFor(o.docId).deliveryTime)).filter(t=>t!=null); return times.length?Math.min(...times):null; };
          keys.sort((a,b)=>{ const ta=jobTime(a),tb=jobTime(b); if(ta==null&&tb==null) return a.localeCompare(b); if(ta==null)return 1; if(tb==null)return -1; return ta-tb; });
          return keys;
        }
        const parent={}; const find=x=>{ while(parent[x]!==x){ parent[x]=parent[parent[x]]; x=parent[x]; } return x; };
        const union=(a,b)=>{ parent[a]=parent[a]||a; parent[b]=parent[b]||b; const ra=find(a),rb=find(b); if(ra!==rb)parent[ra]=rb; };
        const jobOrderers={};
        keys.forEach(nm=>{ const names=[...new Set(byJob.get(nm).map(cleanName).filter(Boolean))]; jobOrderers[nm]=names; names.forEach(n=>{ parent[n]=parent[n]||n; }); for(let i=1;i<names.length;i++) union(names[0],names[i]); });
        const jobKeyName=nm=>{ const names=(jobOrderers[nm]||[]).slice().sort((a,b)=>a.localeCompare(b)); return names[0]||"zzz"; };
        const clusterOf=nm=>{ const kn=jobKeyName(nm); return (parent[kn]?find(kn):kn); };
        const clusterMin={}; keys.forEach(nm=>{ const c=clusterOf(nm); const kn=jobKeyName(nm); if(clusterMin[c]===undefined||kn.localeCompare(clusterMin[c])<0) clusterMin[c]=kn; });
        keys.sort((a,b)=>{ const ca=clusterOf(a),cb=clusterOf(b); if(ca!==cb){ const cmp=(clusterMin[ca]||"").localeCompare(clusterMin[cb]||""); if(cmp!==0)return cmp; } return jobKeyName(a).localeCompare(jobKeyName(b))||a.localeCompare(b); });
        return keys;
      }
      // Build one job's row. On the deliveries side, order that job's own cards equipment→jobsite→pickup.
      function jobRow(nm){
        const raw=byJob.get(nm).slice();
        raw.sort((a,b)=>{ const ta=a.hasEquip?0:(a.shipType==="jobsite"?1:2), tb=b.hasEquip?0:(b.shipType==="jobsite"?1:2); return ta-tb; });
        const first=raw[0];
        const nn=wdNotesFor(first.docId); const t=nn.deliveryTime||""; const tk=nn.truck||"";
        const isPickup=!first.hasEquip && first.shipType!=="jobsite";
        const ic=first.hasEquip?"📦":(first.shipType==="jobsite"?"🚚":"🆙");
        const jobKey="job|"+nm.toLowerCase();
        const isOpen=calDayOpenJob===jobKey;
        const orderers=[...new Set(raw.map(cleanName).filter(Boolean))];
        const countTag=raw.length>1?`<span class="cal-jn-count">${raw.length} orders</span>`:"";
        let btns="";
        if(!isPickup){
          const timeBtn=t?`<button class="cal-jn-time" data-caltime="${wdEsc(first.docId)}">⏱ ${wdEsc(t)}</button>`:`<button class="cal-jn-add" data-caltime="${wdEsc(first.docId)}" title="Add delivery time">⏰</button>`;
          const truckBtn=tk?`<button class="cal-jn-truck" data-caltruck="${wdEsc(first.docId)}">🚚 ${wdEsc(tk)}</button>`:`<button class="cal-jn-add" data-caltruck="${wdEsc(first.docId)}" title="Add truck #">🚚</button>`;
          btns=timeBtn+truckBtn;
        }
        return `<div class="cal-jobrow ${isOpen?'open':''}">
          <div class="cal-jobline">
            <span class="cal-jn-name" data-caljob="${wdEsc(jobKey)}">${ic} ${wdEsc(nm)}${countTag} <span class="cal-jn-chev">${isOpen?"▾":"▸"}</span>${orderers.length?`<span class="cal-jn-by">${wdEsc(orderers.join(", "))}</span>`:""}</span>
            <span class="cal-jn-btns">${btns}</span>
          </div>
          ${isOpen?`<div class="cal-jobcard" data-caljobclose="${wdEsc(jobKey)}">${raw.map(o=>wdOrderCard(o,true)).join("")}</div>`:""}
        </div>`;
      }
      const delRows=orderJobs(delJobs).map(jobRow).join("");
      const pickRows=orderJobs(pickJobs).map(jobRow).join("");
      const sortToggle=`<button class="cal-sort ${calSortByTime?'on':''}" data-calsort="1">${calSortByTime?"✓ ":""}Sort deliveries by time</button>`;
      dayInner=`<div class="cal-day-head"><span class="cal-num">${day}</span><button class="cal-day-close" data-calclose="1">✕ Close</button></div>
        <span class="cal-dots">${marks}</span>
        ${sortToggle}
        ${delRows?`<div class="cal-sec-lbl">🚚 Deliveries</div><div class="cal-jobnames">${delRows}</div>`:""}
        ${pickRows?`<div class="cal-sec-lbl">🆙 Pickups</div><div class="cal-jobnames">${pickRows}</div>`:""}
        ${(!delRows&&!pickRows)?`<div class="cal-day-empty">No orders this day.</div>`:""}`;
    }
    if(isSel){
      html+=`<div class="cal-cell today-${key===todayKey?'1':'0'} has sel" data-calday="${key}">${dayInner}</div>`;
    } else {
      html+=`<div class="cal-cell ${key===todayKey?'today':''} ${has?'has':''}" ${has?`data-calday="${key}"`:""}>
        <span class="cal-num">${day}</span>
        <span class="cal-dots">${marks}</span>
      </div>`;
    }
  }
  grid.innerHTML=html;
  renderDayDetail();
}
function renderDayDetail(){
  const box=$("dayDetail"); if(!box)return;
  if(!calSelDay){ box.style.display="none"; box.innerHTML=""; return; }
  const map=buildDeliveryMap(); const m=map[calSelDay]||{req:[],done:[],wd:[],orders:[]};
  const d=new Date(calSelDay+"T12:00:00");
  const label=d.toLocaleDateString(undefined,{weekday:"long",month:"long",day:"numeric"});
  let html=`<div class="dd-head">${esc(label)}<button class="dd-close" id="ddClose">Close</button></div>`;
  const orders=m.orders||[];
  if(!orders.length && !m.req.length && !m.done.length){ html+=`<div class="dd-empty">Nothing scheduled this day.</div>`; }
  // 1) equipment to deliver, 2) job-site deliveries (no equipment), 3) shop pickups.
  const equipOrders=orders.filter(o=>o.hasEquip);
  const deliverOrders=orders.filter(o=>!o.hasEquip && o.shipType==="jobsite");
  const pickupOrders=orders.filter(o=>!o.hasEquip && o.shipType!=="jobsite");
  if(equipOrders.length){ html+=`<div class="we-sec">📦 Orders with equipment to deliver (${equipOrders.length})</div>`+equipOrders.map(wdOrderCard).join(""); }
  if(deliverOrders.length){ html+=`<div class="we-sec">🚚 Orders to deliver (${deliverOrders.length})</div>`+deliverOrders.map(wdOrderCard).join(""); }
  if(pickupOrders.length){ html+=`<div class="we-sec">🆙 Orders for pick up (${pickupOrders.length})</div>`+pickupOrders.map(wdOrderCard).join(""); }
  if(m.req.length){ html+=`<div class="we-sec">🚚 Arrival deliveries wanted (${m.req.length})</div>`+m.req.map(deliveryRow).join(""); }
  if(m.done.length){ html+=`<div class="we-sec">✓ Delivered (${m.done.length})</div>`+m.done.map(deliveryRow).join(""); }
  box.innerHTML=html; box.style.display="block";
  if(typeof wdLoadArrivalThumbs==="function") wdLoadArrivalThumbs();
}
// Detect whether an order is going to the job site vs shop pickup. Webduct's exact labels vary,
// so we scan every plausible field for job-site / delivery keywords, falling back to pickup.
function wdDetectShipType(src){
  const d=src.delivery||{};
  const hay=[d.shipping?.label, d.shipping?.value, d.option, d.method, d.type,
    d.shipping?.type, d.shipping?.code].filter(Boolean).join(" ").toLowerCase();
  if(/job\s*site|jobsite|deliver|delivery|field|site|truck|ship/.test(hay)) return "jobsite";
  if(/pick\s*up|pickup|shop|will\s*call|warehouse|counter/.test(hay)) return "pickup";
  return "pickup";
}
function wdNotesFor(docId){ return WD_NOTES[docId]||{}; }
// Parse a display time like "7:30 AM" into minutes-since-midnight for sorting. null if unparseable.
function wdParseTime(s){ if(!s)return null; const m=String(s).match(/(\d{1,2}):(\d{2})\s*([ap]m)?/i); if(!m)return null; let h=+m[1]; const min=+m[2]; const ap=(m[3]||"").toLowerCase(); if(ap==="pm"&&h<12)h+=12; if(ap==="am"&&h===12)h=0; return h*60+min; }
// Convert a display time to <input type=time> 24h "HH:MM", and back to a friendly "H:MM AM/PM".
function wdTo24(s){ const mins=wdParseTime(s); if(mins==null)return""; return String(Math.floor(mins/60)).padStart(2,"0")+":"+String(mins%60).padStart(2,"0"); }
function wdFromInput(v){ if(!v)return""; const [h,m]=v.split(":").map(Number); const ap=h>=12?"PM":"AM"; let hh=h%12; if(hh===0)hh=12; return hh+":"+String(m).padStart(2,"0")+" "+ap; }
// Quick inline edit of a single note field (truck) via prompt. Writes to the shared notes doc.
async function wdQuickNote(docId, field, label){
  if(!fbReady){ toast("No connection — can't save"); return; }
  const cur=wdNotesFor(docId)[field]||"";
  const val=prompt(label, cur);
  if(val===null) return;
  try{ await setDoc(doc(db,"webductOrderNotes",docId),{[field]:val.trim(),updatedAt:serverTimestamp()},{merge:true}); toast(val.trim()?"Saved":"Cleared"); }
  catch(e){ console.error("quicknote save",e); toast("Couldn't save — add the webductOrderNotes Firestore rule"); }
}
// Delivery-time picker (proper time chooser with AM/PM).
let WD_TIME_TARGET="";
function wdOpenTimePicker(docId){
  WD_TIME_TARGET=docId; const cur=wdNotesFor(docId).deliveryTime||"";
  $("tp_input").value=wdTo24(cur)||"";
  const o=WD_ORDERS.find(x=>x.docId===docId);
  $("tp_title").textContent=o?`Delivery time — ${o.job||""} #${o.number||""}`:"Delivery time";
  openModal("timeModal"); setTimeout(()=>{ try{$("tp_input").showPicker&&$("tp_input").showPicker();}catch(_){} },150);
}
async function wdSaveTime(clear){
  if(!WD_TIME_TARGET){ closeModal("timeModal"); return; }
  if(!fbReady){ toast("No connection"); return; }
  const val=clear?"":wdFromInput($("tp_input").value);
  try{ await setDoc(doc(db,"webductOrderNotes",WD_TIME_TARGET),{deliveryTime:val,updatedAt:serverTimestamp()},{merge:true}); closeModal("timeModal"); toast(val?"Time saved":"Cleared"); }
  catch(e){ console.error("time save",e); toast("Couldn't save — add the webductOrderNotes Firestore rule"); }
}
// Find the synced WD_EQUIP entry that corresponds to a given order line item (same order #, same label).
function wdEquipEntryFor(orderNumber, it){
  const num=String(orderNumber);
  const lbl=(it.label||"").toLowerCase().trim();
  return WD_EQUIP.find(e=>String(e.orderNumber)===num && (e.label||"").toLowerCase().trim()===lbl)
      || WD_EQUIP.find(e=>String(e.orderNumber)===num && lbl && (e.notes||"").toLowerCase().includes(lbl));
}
// Render the arrival-link state for a single equipment/buyout item: linked → full arrival info + photo;
// unlinked → a button that opens the same searchable picker used in the equipment list.
function wdItemArrivalBlock(o, it){
  const e=wdEquipEntryFor(o.number, it);
  if(!e) return "";   // this item isn't a tracked shop-equipment line
  const arr=e.arrivalId?ARRIVALS.find(a=>a.id===e.arrivalId):null;
  if(arr && (e.matchState==="exact"||e.matchState==="confirmed")){
    const delivered=arr.delivered;
    const statusBadge=delivered?`<span class="wia-badge green">✓ Delivered${arr.deliveredDate?" "+wdEsc(longDate(arr.deliveredDate).split(",")[0]):""}</span>`:`<span class="wia-badge amber">On site · not delivered</span>`;
    const partialBadge=e.partial?`<button class="wia-badge partial ptoggle" data-wepartial="${wdEsc(e.docId)}" title="Tap to mark complete">◑ PARTIAL</button>`:`<button class="wia-badge complete ptoggle" data-wepartial="${wdEsc(e.docId)}" title="Tap to mark partial">✓ COMPLETE</button>`;
    const hasPhoto=!!arr.photoBy;
    return `<div class="wia linked">
      <div class="wia-head">🔗 Paired arrival ${statusBadge}${partialBadge}<button class="wia-unlink" data-weunlink="${wdEsc(e.docId)}">Unlink</button></div>
      <div class="wia-desc">${wdEsc(arr.description||"Arrival")}</div>
      <div class="wia-meta">${arr.supplier?`Supplier: ${wdEsc(arr.supplier)}`:""}${arr.storageLocation?`${arr.supplier?" · ":""}📍 ${wdEsc(arr.storageLocation)}`:""}${arr.dateReceived?` · received ${wdDate(arr.dateReceived)}`:""}</div>
      ${hasPhoto?`<img class="wia-photo" data-wiaphoto="${wdEsc(arr.id)}" alt="arrival photo" loading="lazy">`:`<button class="wia-addphoto" data-wiaddphoto="${wdEsc(arr.id)}">📷 Add photo</button>`}
      ${wdEquipNoteBlock(e)}
    </div>`;
  }
  // Not linked → offer to pair, with the searchable same-job picker.
  return `<div class="wia unlinked">
    <button class="we-linkbtn" data-welinkopen="${wdEsc(e.docId)}">🔗 Pair with an arrival →</button>
    <div class="we-linkwrap" id="welink-${wdEsc(e.docId)}" style="display:none">
      <input class="we-linksearch" data-welinksearch="${wdEsc(e.docId)}" type="search" placeholder="Search arrivals on job ${wdEsc(e.job||o.job||"")}…" autocomplete="off">
      <div class="we-linkresults" id="welinkres-${wdEsc(e.docId)}">${wdArrivalPickList(e,"")}</div>
    </div>
  </div>`;
}
// Equipment-level note (syncs across all pages), shown in the paired-arrival view.
function wdEqNoteFor(docId){ return (WD_EQNOTES[docId]&&WD_EQNOTES[docId].text)||""; }
function wdEquipNoteBlock(e){
  const note=wdEqNoteFor(e.docId);
  return `<div class="wia-note">
    <button class="wia-notebtn ${note?'on':''}" data-weqnote="${wdEsc(e.docId)}">📝 ${note?"Note":"Add note"}</button>
    ${note?`<div class="wia-notetext">${wdEsc(note)}</div>`:""}
  </div>`;
}
async function wdSaveEqNote(docId){
  if(!fbReady){ toast("No connection"); return; }
  const cur=wdEqNoteFor(docId);
  const val=prompt("Note for this equipment (syncs everywhere)", cur);
  if(val===null) return;
  try{ await setDoc(doc(db,"webductEquipNotes",docId),{text:val.trim(),updatedAt:serverTimestamp()},{merge:true}); toast(val.trim()?"Note saved":"Note cleared"); }
  catch(e){ console.error("eqnote save",e); toast("Couldn't save — add the webductEquipNotes Firestore rule"); }
}
async function wdToggleHighlight(docId){
  if(!fbReady){ toast("No connection — can't save"); return; }
  const n=wdNotesFor(docId);
  try{ await setDoc(doc(db,"webductOrderNotes",docId),{highlight:!n.highlight,updatedAt:serverTimestamp()},{merge:true}); }
  catch(e){ console.error("highlight save failed",e); toast("Couldn't save — add the webductOrderNotes Firestore rule"); }
}
async function wdToggleItemGathered(docId, ik){
  if(!fbReady){ toast("No connection — can't save"); return; }
  const n=wdNotesFor(docId); const g=Object.assign({}, n.gathered||{}); const nowChecked=!g[ik]; g[ik]=nowChecked;
  try{ await setDoc(doc(db,"webductOrderNotes",docId),{gathered:g,updatedAt:serverTimestamp()},{merge:true}); }
  catch(e){ console.error("gathered save failed",e); toast("Couldn't save — add the webductOrderNotes Firestore rule"); }
  // If this item is equipment linked to an arrival, checking it also marks that arrival delivered
  // (and unchecking un-delivers it), so the truck turns green on My Jobs / Arrivals too.
  const o=WD_ORDERS.find(x=>x.docId===docId); if(!o) return;
  const it=(o.items||[]).find(x=>wdSlug((x.label||"")+"|"+(x.sku||"")+"|"+(x.quantity!=null?x.quantity:""))===ik);
  if(!it||!it.isEquip) return;
  const eq=wdEquipEntryFor(o.number, it); if(!eq||!eq.arrivalId) return;
  const arr=ARRIVALS.find(a=>a.id===eq.arrivalId); if(!arr) return;
  // If this arrival was AUTO-matched (we never asked full vs partial), ask now on first check.
  if(nowChecked && eq.partial===undefined){
    wdOpenPairKindThenDeliver(eq.docId, eq.arrivalId, o);
    return;
  }
  try{
    // Use the order's SCHEDULED delivery date (requested/delivery), not today — deliveries are often
    // checked off the day before while prepping. Fall back to today only if the order has no date.
    const schedIso=o.requestedDate||o.deliveryDate||o.orderedDate||"";
    let schedDate=""; if(schedIso){ const d=new Date(schedIso); if(!isNaN(d)) schedDate=d.toISOString().slice(0,10); }
    if(!schedDate) schedDate=(new Date()).toISOString().slice(0,10);
    const patch=nowChecked?{delivered:true, deliveredDate:schedDate}:{delivered:false, deliveredDate:""};
    await setDoc(doc(db,"arrivals",eq.arrivalId),{...patch,updatedAt:serverTimestamp()},{merge:true});
    toast(nowChecked?"Marked delivered":"Delivery cleared");
  }catch(e){ console.error("arrival delivered propagate",e); }
}
let WD_NOTES_TARGET="";
function wdOpenNotes(docId){
  WD_NOTES_TARGET=docId; const n=wdNotesFor(docId);
  $("wn_time").value=n.deliveryTime||""; $("wn_truck").value=n.truck||""; $("wn_extra").value=n.extra||"";
  const o=WD_ORDERS.find(x=>x.docId===docId);
  $("wn_title").textContent=o?`Notes — ${o.job||""} #${o.number||""}`:"Delivery notes";
  openModal("notesModal"); setTimeout(()=>$("wn_time").focus(),200);
}
function wdHasDisplayNotes(n){ return !!(n && (n.deliveryTime||n.truck)); }
function wdHasExtraNotes(n){ return !!(n && n.extra && n.extra.trim()); }

// Breakdown of an order's total weight: each item's weight × qty, summed. Falls back to just the
// total if per-item weights didn't come through from Webduct.
function wdWeightMath(o){
  const items=(o.items||[]).filter(it=>typeof it.weight==="number" && it.weight>0);
  const total=Math.round(o.totalWeight||0);
  if(!items.length){ return `<div class="wtm-row"><span>Order total</span><b>${total.toLocaleString()} lb</b></div><div class="wtm-note">Per-item weights weren't provided by Webduct for this order.</div>`; }
  const rows=items.map(it=>{ const q=it.quantity!=null?it.quantity:1; const line=it.weight*q; return `<div class="wtm-row"><span>${wdEsc((it.label||"Item").slice(0,40))} ${q>1?`(${it.weight}×${q})`:""}</span><b>${Math.round(line).toLocaleString()} lb</b></div>`; }).join("");
  return `<div class="wtm-title">Weight breakdown</div>${rows}<div class="wtm-row total"><span>Total</span><b>${total.toLocaleString()} lb</b></div>`;
}
// Full order card — whole header is tappable to expand. Collapsed by default.
// compact=true (day view): no expandable body, no header toggle — just header + pills, so the
// only dropdowns are the category pills and clicking the card elsewhere closes it.
function wdOrderCard(o, compact){
  const starred=o.job && MY_JOBS.some(j=>normJob(j)===normJob(o.job));
  const open=EXPANDED_WO.has(o.docId), catsOpen=EXPANDED_WO_CATS.has(o.docId);
  const notesOpen=EXPANDED_WO_NOTES.has(o.docId);
  const n=wdNotesFor(o.docId);
  const highlighted=!!n.highlight;
  const dateStr=wdDate(o.requestedDate||o.deliveryDate||o.orderedDate);
  const equipItems=(o.items||[]).filter(it=>it.isEquip);
  const groups={}; (o.items||[]).forEach(it=>{ (groups[it.group]=groups[it.group]||[]).push(it); });
  const groupNames=Object.keys(groups);
  const jobsite=o.shipType==="jobsite";
  const gathered=n.gathered||{};
  const wt=(typeof o.totalWeight==="number"&&o.totalWeight>0)?o.totalWeight:0;
  const tog=compact?"":`data-wotoggle="${wdEsc(o.docId)}"`;
  const itemKey=it=>wdSlug((it.label||"")+"|"+(it.sku||"")+"|"+(it.quantity!=null?it.quantity:""));
  const itemLine=it=>{ const ik=itemKey(it); let got=!!gathered[ik]; if(it.isEquip && !got){ const eq=wdEquipEntryFor(o.number,it); if(eq&&eq.arrivalId){ const ar=ARRIVALS.find(a=>a.id===eq.arrivalId); if(ar&&ar.delivered) got=true; } } return `<div class="wo-item ${got?'got':''}"><button class="wo-item-chk ${got?'on':''}" data-woitemchk="${wdEsc(o.docId)}|||${wdEsc(ik)}" title="${got?'Delivered/gathered':'Mark gathered'}">${got?'✅':'⬜'}</button><div class="wo-item-main2"><div class="wo-item-top"><span class="wo-item-name">${wdEsc(it.label||"Item")}</span>${it.quantity!=null?`<span class="wo-item-qty">×${wdEsc(it.quantity)}</span>`:""}</div>${it.notes?`<div class="wo-item-notes">${wdEsc(it.notes)}</div>`:""}${it.build?`<div class="wo-item-build">🔧 Laser/CAD: ${wdEsc(it.build)}</div>`:(it.dims?`<div class="wo-item-build">${wdEsc(it.dims)}</div>`:"")}${it.shipStatus?`<span class="wo-item-ship">${wdEsc(it.shipStatus)}</span>`:""}</div></div>`; };
  const orderedByClean=o.orderedBy?String(o.orderedBy).replace(/\s*\(?\d[\d\s().-]{6,}\)?/g,"").trim():"";
  // Whole-order "gathered" indicator: checked only when EVERY item on the order is checked off
  // (an equipment item counts as checked if its linked arrival is delivered). Not clickable.
  const allItems=(o.items||[]);
  const itemGathered=it=>{ const ik=itemKey(it); if(gathered[ik])return true; if(it.isEquip){ const eq=wdEquipEntryFor(o.number,it); if(eq&&eq.arrivalId){ const ar=ARRIVALS.find(a=>a.id===eq.arrivalId); if(ar&&ar.delivered)return true; } } return false; };
  // Equipment lines tracked for this order that are linked to a delivered arrival.
  const orderEquip=WD_EQUIP.filter(x=>String(x.orderNumber)===String(o.number));
  const equipAllDelivered = orderEquip.length>0 && orderEquip.every(x=>{ const ar=x.arrivalId?ARRIVALS.find(a=>a.id===x.arrivalId):null; return ar&&ar.delivered; });
  // Order counts as done when every listed item is gathered, OR (when there are no line items but
  // there are tracked equipment entries) when all of those equipment arrivals are delivered.
  const allGathered = (allItems.length>0 && allItems.every(itemGathered)) || (allItems.length===0 && equipAllDelivered) || (allItems.length>0 && allItems.every(itemGathered) && equipAllDelivered);
  return `<div class="wo-card ${highlighted?'hl':''} ${compact?'compact':''}" data-wocard="${wdEsc(o.docId)}">
    <div class="wo-head" ${tog}>
      ${compact?"":`<span class="wo-chev" id="wo-chev-${wdEsc(o.docId)}">${open?"▾":"▸"}</span>`}
      <span class="wo-job">${wdEsc(o.job||"—")}</span>
      <span class="wo-num">#${wdEsc(o.number)}</span>
      <span class="wo-ship" title="${jobsite?'Send to job site':'Shop pickup'}">${jobsite?'🚚':'🆙'}</span>
      ${o.hasEquip?`<span class="wo-tag equip">📦 EQUIP</span>`:""}
      <span class="wo-head-btns">
        <button class="wo-ibtn ${wdHasDisplayNotes(n)||wdHasExtraNotes(n)?'on':''}" data-wonotes="${wdEsc(o.docId)}" title="Delivery notes">📝</button>
        <span class="wo-donechk ${allGathered?'on':''}" title="${allGathered?'All items gathered':'Not all items gathered yet'}">${allGathered?'✅':'⬜'}</span>
        <button class="wo-star ${starred?'on':''}" data-wostar="${wdEsc(o.job||"")}" title="${starred?'In My Jobs':'Add to My Jobs'}">${starred?'★':'☆'}</button>
      </span>
    </div>
    <div class="wo-sub" ${tog}>${wdEsc(o.jobName||"")}${dateStr?` · wants ${dateStr}`:""}${orderedByClean?` · by ${wdEsc(orderedByClean)}`:""}${o.orderedDate?` · placed ${wdEsc(wdDate(o.orderedDate))}`:""}</div>
    ${groupNames.length?`<div class="wo-catprev">${groupNames.map(g=>`<button class="wo-catprev-pill ${EXPANDED_WO_CATS.has(o.docId+"|"+g)?'on':''}" data-wocatchip="${wdEsc(o.docId)}|||${wdEsc(g)}">${wdEsc(g)} <b>${groups[g].length}</b></button>`).join("")}${wt?`<button class="wo-wtpill" data-wowt="${wdEsc(o.docId)}">${Math.round(wt).toLocaleString()} lb</button>`:""}</div>
    ${wt?`<div class="wo-wtmath" data-wowtbox="${wdEsc(o.docId)}" style="display:${EXPANDED_WO_WT.has(o.docId)?'block':'none'}">${wdWeightMath(o)}</div>`:""}
    ${groupNames.map(g=>`<div class="wo-cat" data-wocatbox="${wdEsc(o.docId)}|||${wdEsc(g)}" style="display:${EXPANDED_WO_CATS.has(o.docId+"|"+g)?'block':'none'}">${groups[g].map(it=>itemLine(it)+(it.isEquip?wdItemArrivalBlock(o,it):"")).join("")}</div>`).join("")}`:""}
    ${wdHasDisplayNotes(n)?`<div class="wo-notechips">${n.deliveryTime?`<span class="wo-notechip">🕒 ${wdEsc(n.deliveryTime)}</span>`:""}${n.truck?`<span class="wo-notechip">🚚 ${wdEsc(n.truck)}</span>`:""}</div>`:""}
    ${wdHasExtraNotes(n)?`<div class="wo-extranote" id="wo-extra-${wdEsc(o.docId)}" style="display:${notesOpen?'block':'none'}">📝 ${wdEsc(n.extra)}</div>`:""}
    ${compact?"":`<div class="wo-body" id="wo-body-${wdEsc(o.docId)}" style="display:${open?"block":"none"}">
      ${orderedByClean?`<div class="wo-row"><b>Ordered by</b> ${wdEsc(orderedByClean)}</div>`:""}
      ${o.orderedDate?`<div class="wo-row"><b>Ordered</b> ${wdEsc(wdDate(o.orderedDate))}</div>`:""}
      ${o.requestedDate?`<div class="wo-row"><b>Field wants</b> ${wdEsc(wdDate(o.requestedDate))}</div>`:""}
      ${o.po?`<div class="wo-row"><b>PO #</b> ${wdEsc(o.po)}</div>`:""}
      ${o.shipLabel?`<div class="wo-row"><b>Ship</b> ${wdEsc(o.shipLabel)}</div>`:""}
      ${o.orderStatus?`<div class="wo-row"><b>Order status</b> ${wdEsc(o.orderStatus)}</div>`:""}
      ${o.instructions?`<div class="wo-row"><b>Instructions</b> ${wdEsc(o.instructions)}</div>`:""}
      ${wt?`<div class="wo-row"><b>Total weight</b> ${wt.toLocaleString()} lb</div>`:""}
      ${(typeof o.totalPrice==="number"&&o.totalPrice>0)?`<div class="wo-row"><b>Total</b> $${o.totalPrice.toFixed(2)}</div>`:""}
      ${o.detailUnavailable?`<div class="wo-row" style="color:var(--steel-light)">⚠ Item-level detail unavailable for this order</div>`:""}
      ${equipItems.length?`<div class="wo-equip-head">📦 Equipment to deliver</div>`+equipItems.map(itemLine).join(""):""}
    </div>`}
  </div>`;
}
function renderDeliveries(){
  if(typeof renderWdEquip==="function") renderWdEquip();
  renderCalendar();
  if(typeof wdSyncWindowInputs==="function") wdSyncWindowInputs();
  if(typeof wdRenderLastSync==="function") wdRenderLastSync();
  // List view (inside the collapsible)
  const q=$("delSearch").value.trim().toLowerCase(); $("delClr").style.display=q?"block":"none";
  const list=$("delList"); if(!list) return;
  // Webduct orders, filtered by ship type + search, newest delivery first.
  let orders=WD_ORDERS.slice();
  if(calShipFilter==="jobsite") orders=orders.filter(o=>o.shipType==="jobsite");
  else if(calShipFilter==="pickup") orders=orders.filter(o=>o.shipType!=="jobsite");
  if(q) orders=orders.filter(o=>[o.job,o.jobName,o.number,o.orderedBy,o.po].some(v=>(v||"").toString().toLowerCase().includes(q)));
  orders.sort((a,b)=>{ const da=new Date(a.requestedDate||a.deliveryDate||a.orderedDate||0).getTime(); const db2=new Date(b.requestedDate||b.deliveryDate||b.orderedDate||0).getTime(); return db2-da; });
  // Arrivals (requested / delivered) still shown below, filtered by search.
  let req=ARRIVALS.filter(r=>r.reqDeliv && !r.delivered);
  let done=ARRIVALS.filter(r=>r.delivered);
  if(q){ const f=r=>[r.jobNumber,r.jobName,r.description,r.supplier].some(v=>(v||"").toLowerCase().includes(q)); req=req.filter(f); done=done.filter(f); }
  req.sort((a,b)=>a.reqDeliv<b.reqDeliv?-1:1);
  done.sort((a,b)=>(b.deliveredDate||"")<(a.deliveredDate||"")?-1:1);
  let html="";
  html+=`<div class="del-section"><h3>Orders <span class="cnt">${orders.length}</span></h3>${orders.length?orders.map(wdOrderCard).join(""):`<div class="sub-empty">No orders match this filter.</div>`}</div>`;
  if(req.length) html+=`<div class="del-section"><h3>Arrival deliveries requested <span class="cnt">${req.length}</span></h3>${req.map(deliveryRow).join("")}</div>`;
  if(done.length) html+=`<div class="del-section"><h3>Delivered <span class="cnt">${done.length}</span></h3>${done.map(deliveryRow).join("")}</div>`;
  list.innerHTML=html;
  wdLoadArrivalThumbs();
}
// Fill in inline arrival photo thumbnails (stored in Firestore) after render.
const WD_THUMB_CACHE={};
async function wdLoadArrivalThumbs(){
  const imgs=document.querySelectorAll("img[data-wiaphoto]:not([data-loaded])");
  for(const img of imgs){
    const id=img.getAttribute("data-wiaphoto"); img.setAttribute("data-loaded","1");
    if(WD_THUMB_CACHE[id]){ img.src=WD_THUMB_CACHE[id]; continue; }
    try{ const snap=await getDoc(doc(db,"arrivalPhotos",id)); if(snap.exists()){ const d=snap.data(); WD_THUMB_CACHE[id]=d.photo; img.src=d.photo; } }catch(_){}
  }
}
// Calendar controls
document.addEventListener("click",e=>{
  if(e.target.closest("#calPrev")){ calMonth--; if(calMonth<0){calMonth=11;calYear--;} renderCalendar(); return; }
  if(e.target.closest("#calNext")){ calMonth++; if(calMonth>11){calMonth=0;calYear++;} renderCalendar(); return; }
  if(e.target.closest("#calToday")){ const n=new Date(); calYear=n.getFullYear(); calMonth=n.getMonth(); calSelDay=dateKeyLocal(n.toISOString()); calDayOpenJob=null; renderCalendar(); return; }
  if(e.target.closest("[data-calclose]")){ calSelDay=null; calDayOpenJob=null; renderCalendar(); return; }
  if(e.target.closest("[data-calsort]")){ calSortByTime=!calSortByTime; renderCalendar(); return; }
  const caltime=e.target.closest("[data-caltime]"); if(caltime){ e.stopPropagation(); wdOpenTimePicker(caltime.dataset.caltime); return; }
  const caltruck=e.target.closest("[data-caltruck]"); if(caltruck){ e.stopPropagation(); wdQuickNote(caltruck.dataset.caltruck,"truck","Truck # / name"); return; }
  const caljob=e.target.closest("[data-caljob]"); if(caljob){ e.stopPropagation(); const id=caljob.dataset.caljob; calDayOpenJob=(calDayOpenJob===id)?null:id; renderCalendar(); return; }
  const cseg=e.target.closest("[data-calseg]"); if(cseg){ calShowMine=cseg.dataset.calseg==="mine"; document.querySelectorAll("#calSeg button").forEach(b=>b.classList.toggle("on",b===cseg)); renderCalendar(); return; }
  const wstar=e.target.closest("[data-wostar]"); if(wstar){ e.stopPropagation(); const job=wstar.dataset.wostar; if(job){ if(MY_JOBS.some(j=>normJob(j)===normJob(job))) removeJob(normJob(job)); else addJob(job); renderDeliveries(); } return; }
  const whl=e.target.closest("[data-wohl]"); if(whl){ e.stopPropagation(); wdToggleHighlight(whl.dataset.wohl); return; }
  const wnotes=e.target.closest("[data-wonotes]"); if(wnotes){ e.stopPropagation(); const id=wnotes.dataset.wonotes; const n=wdNotesFor(id); if(wdHasExtraNotes(n) && !e.target.closest("[data-wonotes-edit]")){ /* toggle extra note display */ const open=!EXPANDED_WO_NOTES.has(id); if(open)EXPANDED_WO_NOTES.add(id); else EXPANDED_WO_NOTES.delete(id); const b=$("wo-extra-"+id); if(b)b.style.display=open?"block":"none"; } else { wdOpenNotes(id); } return; }
  const wowt=e.target.closest("[data-wowt]"); if(wowt){ e.stopPropagation(); const id=wowt.dataset.wowt; const open=!EXPANDED_WO_WT.has(id); if(open)EXPANDED_WO_WT.add(id); else EXPANDED_WO_WT.delete(id); document.querySelectorAll(`[data-wowtbox="${CSS.escape(id)}"]`).forEach(b=>b.style.display=open?"block":"none"); return; }
  const wcatchip=e.target.closest("[data-wocatchip]"); if(wcatchip){ e.stopPropagation(); const combo=wcatchip.dataset.wocatchip; const [docId,g]=combo.split("|||"); const key=docId+"|"+g; const open=!EXPANDED_WO_CATS.has(key); if(open)EXPANDED_WO_CATS.add(key); else EXPANDED_WO_CATS.delete(key); document.querySelectorAll(`[data-wocatbox="${CSS.escape(combo)}"]`).forEach(b=>b.style.display=open?"block":"none"); document.querySelectorAll(`[data-wocatchip="${CSS.escape(combo)}"]`).forEach(p=>p.classList.toggle("on",open)); return; }
  const witemchk=e.target.closest("[data-woitemchk]"); if(witemchk){ e.stopPropagation(); const [docId,ik]=witemchk.dataset.woitemchk.split("|||"); wdToggleItemGathered(docId,ik); return; }
  const weunlink=e.target.closest("[data-weunlink]"); if(weunlink){ e.stopPropagation(); if(confirm("Unlink this arrival from the equipment?")) wdSetMatch(weunlink.dataset.weunlink,"none",""); return; }
  const wiadd=e.target.closest("[data-wiaddphoto]"); if(wiadd){ e.stopPropagation(); startCapture(wiadd.dataset.wiaddphoto); return; }
  const wiaphoto=e.target.closest("[data-wiaphoto]"); if(wiaphoto){ e.stopPropagation(); openPhotoViewer(wiaphoto.dataset.wiaphoto); return; }
  const wtog=e.target.closest("[data-wotoggle]"); if(wtog){ const id=wtog.dataset.wotoggle; const open=!EXPANDED_WO.has(id); if(open)EXPANDED_WO.add(id); else EXPANDED_WO.delete(id); const b=$("wo-body-"+id),c=$("wo-chev-"+id); if(b)b.style.display=open?"block":"none"; if(c)c.textContent=open?"▾":"▸"; return; }
  if(e.target.closest("#dlToggle")){ const w=$("dlListWrap"),c=$("dlChev"); const open=w.style.display==="none"; w.style.display=open?"block":"none"; c.classList.toggle("open",open); return; }
  const sf=e.target.closest("[data-shipfilter]"); if(sf){ calShipFilter=sf.dataset.shipfilter; document.querySelectorAll(".dl-sf").forEach(b=>b.classList.toggle("on",b===sf)); renderDeliveries(); return; }
  if(e.target.closest("#delFbToggle")){ const w=$("delFbWrap"),c=$("delFbChev"); const open=w.style.display==="none"; w.style.display=open?"block":"none"; c.classList.toggle("open",open); return; }
  if(e.target.closest("#wdTestToggle")){ const w=$("wdTestWrap"),c=$("wdTestChev"); const open=w.style.display==="none"; w.style.display=open?"block":"none"; c.classList.toggle("open",open); if(open&&typeof wdRenderToken==="function")wdRenderToken(); return; }
  if(e.target.closest("#wdKeyReveal")){ const b=$("wdKeyRevealBox"); const show=b.style.display==="none"; b.style.display=show?"block":"none"; if(show)$("wdKeyValue").textContent=wdHasAdmin()?("Connected as "+WD_ADMIN_CREDS.email+" (password stored, token minted fresh each sync)"):"(no company login saved)"; $("wdKeyReveal").textContent=show?"Hide":"Show details"; return; }
  if(e.target.closest("#ddClose")){ calSelDay=null; calDayOpenJob=null; renderCalendar(); return; }
  // Clicking anywhere on an expanded day-view card (that wasn't an interactive control handled
  // above) collapses it. Runs after all card-internal handlers, before the day catch-all.
  const cjc=e.target.closest("[data-caljobclose]"); if(cjc){
    // Only close on a click of the card's dead space — never when a button/input/link or any
    // element carrying an action attribute was clicked (those are handled by other listeners).
    const interactive=e.target.closest("button, input, textarea, select, a, [data-wocatchip], [data-wowt], [data-woitemchk], [data-wostar], [data-wohl], [data-wonotes], [data-welinkopen], [data-wepick], [data-wepickopen], [data-welinksearch], [data-weunlink], [data-weqnote], [data-wepartial], [data-wiaddphoto], [data-wiaphoto], [data-caltime], [data-caltruck]");
    if(interactive) return;   // let the other handler deal with it; don't close
    e.stopPropagation(); if(calDayOpenJob===cjc.dataset.caljobclose){ calDayOpenJob=null; renderCalendar(); } return;
  }
  // Catch-all LAST: clicking an empty part of a day cell selects it. Card-internal controls above
  // (pills, checkmarks, star, time/truck, job expand) are handled first and return before this.
  const cd=e.target.closest("[data-calday]"); if(cd){ if(calSelDay===cd.dataset.calday){ return; } calSelDay=cd.dataset.calday; calDayOpenJob=null; renderCalendar(); return; }
  // If a day is expanded and the click landed OUTSIDE the black day box and not on any day cell,
  // close the expanded day. (Clicks on another day are handled by the branch above.)
  if(calSelDay && !e.target.closest(".cal-cell.sel") && !e.target.closest(".modal-back") && !e.target.closest("[data-caltime],[data-caltruck]")){
    calSelDay=null; calDayOpenJob=null; renderCalendar(); return;
  }
});

// Connect a Webduct company login → save the key to Firebase for everyone.
onActivate($("wdKeyLogin"),async()=>{
  const em=$("wdKeyEmail").value.trim(), pw=$("wdKeyPass").value;
  if(!em||!/^\S+@\S+\.\S+$/.test(em)){toast("Enter the Webduct email");$("wdKeyEmail").focus();return;}
  if(!pw){toast("Enter the password");$("wdKeyPass").focus();return;}
  const btn=$("wdKeyLogin"); btn.disabled=true; btn.textContent="Connecting…"; $("wdKeyHint").textContent="Verifying login with Webduct…";
  // Verify the credentials work by minting a token once.
  const r=await wdFetch("POST",WD_BASE+"/oauth/authorize/password",{headers:{"Content-Type":"application/x-www-form-urlencoded","Accept":"application/json"},body:new URLSearchParams({username:em,password:pw}).toString()});
  btn.disabled=false; btn.textContent="Connect & save login";
  let tok="";
  if(r.json){ const d=r.json.data||{}; tok=d.accessToken||d.access_token||d.token||r.json.accessToken||r.json.token||""; }
  if(r.threw){ $("wdKeyHint").innerHTML="<span style='color:#c0341a'>Couldn't reach Webduct (network/CORS).</span>"; return; }
  if(!tok){ $("wdKeyHint").innerHTML="<span style='color:#c0341a'>Login failed — check the email/password.</span>"; return; }
  if(!fbReady){ $("wdKeyHint").innerHTML="<span style='color:#c0341a'>No Firebase connection — can't save the login.</span>"; return; }
  try{
    // Store the LOGIN (not the token). The app mints a fresh token from this before every sync,
    // so it never goes stale the way a saved token would.
    await setDoc(doc(db,"config","webductKey"),{email:em, password:pw, token:"", savedBy:(USER?USER.first+" "+USER.last:""), savedAt:serverTimestamp()},{merge:true});
    WD_ADMIN_CREDS={email:em,password:pw}; WD_ADMIN_TOKEN=tok; WD_ADMIN_TOKEN_TS=Date.now(); wdUpdateLights();
    $("wdKeyPass").value=""; $("wdKeyHint").innerHTML="<span style='color:#0d7a73'>✓ Connected. The app now mints a fresh token before each sync — no more stale keys.</span>";
    toast("Webduct connected for everyone");
    setTimeout(()=>wdAutoSync({manual:true}),400);
  }catch(err){ console.error(err); $("wdKeyHint").innerHTML="<span style='color:#c0341a'>Couldn't save the login to Firebase.</span>"; }
});
onActivate($("wdKeyClear"),async()=>{
  if(!fbReady)return; if(!confirm("Disconnect Webduct for the whole team? Everyone's live order sync will stop until someone reconnects."))return;
  try{ await setDoc(doc(db,"config","webductKey"),{email:"",password:"",token:"",clearedBy:(USER?USER.first+" "+USER.last:""),clearedAt:serverTimestamp()},{merge:true}); WD_ADMIN_CREDS=null; WD_ADMIN_TOKEN=""; wdUpdateLights(); toast("Webduct disconnected"); $("wdKeyRevealBox").style.display="none"; $("wdKeyReveal").textContent="Show key"; }catch(err){ console.error(err); }
});
// Deliveries personal-login fallback: sets WD_TOKEN (personal) and pulls orders using it.
onActivate($("delFbLogin"),async()=>{
  const em=$("delFbEmail").value.trim(), pw=$("delFbPass").value;
  if(!em||!/^\S+@\S+\.\S+$/.test(em)){toast("Enter your Webduct email");$("delFbEmail").focus();return;}
  if(!pw){toast("Enter your password");$("delFbPass").focus();return;}
  const btn=$("delFbLogin"); btn.disabled=true; btn.textContent="Signing in…"; $("delFbHint").textContent="Contacting Webduct…";
  const r=await wdFetch("POST",WD_BASE+"/oauth/authorize/password",{headers:{"Content-Type":"application/x-www-form-urlencoded","Accept":"application/json"},body:new URLSearchParams({username:em,password:pw}).toString()});
  btn.disabled=false; btn.textContent="Sign in & pull my orders";
  let tok=""; if(r.json){ const d=r.json.data||{}; tok=d.accessToken||d.access_token||d.token||r.json.accessToken||r.json.token||""; }
  if(r.threw){ $("delFbHint").innerHTML="<span style='color:#c0341a'>Couldn't reach Webduct.</span>"; return; }
  if(!tok){ $("delFbHint").innerHTML="<span style='color:#c0341a'>Login failed — check email/password.</span>"; return; }
  WD_TOKEN=tok; sessionStorage.setItem("wd_token",tok);
  $("delFbPass").value=""; $("delFbHint").innerHTML="<span style='color:#0d7a73'>✓ Signed in — pulling your orders…</span>";
  wdAutoSync({manual:true});
});

/* ---------- Admin PIN + roles ---------- */
const pin=$("pinInput");
function syncAdminView(){
  $("adminLocked").style.display=adminUnlocked?"none":"block";
  $("adminPanel").style.display=adminUnlocked?"block":"none";
  if(adminUnlocked){ renderAdminStats(); } else { pin.value=""; $("pinMsg").textContent=""; pin.classList.remove("bad"); }
}
pin.addEventListener("input",()=>{ pin.value=pin.value.replace(/\D/g,"").slice(0,4); $("pinMsg").className="pin-msg"; $("pinMsg").textContent=""; pin.classList.remove("bad");
  if(pin.value.length===4){ if(pin.value===ADMIN_PIN){ adminUnlocked=true; sessionStorage.setItem("er_admin","1"); syncAdminView(); renderAll(); } else { pin.classList.add("bad"); $("pinMsg").className="pin-msg bad"; $("pinMsg").textContent="Incorrect PIN — try again"; setTimeout(()=>{pin.value="";pin.classList.remove("bad");pin.focus();},600); } }
});
function lockAdmin(){ adminUnlocked=false; sessionStorage.removeItem("er_admin"); syncAdminView(); renderAll(); toast("Admin locked"); }
$("btnLock").addEventListener("click",lockAdmin);

/* ---------- Modals ---------- */
function openModal(id){ $(id).classList.add("show"); document.body.style.overflow="hidden"; }
function closeModal(id){ $(id).classList.remove("show"); document.body.style.overflow=""; }
document.querySelectorAll("[data-close]").forEach(b=>b.addEventListener("click",()=>closeModal(b.dataset.close)));
document.querySelectorAll(".modal-back").forEach(m=>m.addEventListener("click",e=>{ if(e.target===m && m.id!=="nameModal")closeModal(m.id); }));

/* ---------- Photos (Firebase, 1 per arrival, anyone can add) ---------- */
function compressPhoto(file){ return new Promise((res,rej)=>{ const fr=new FileReader(); fr.onerror=()=>rej(); fr.onload=()=>{ const img=new Image(); img.onerror=()=>rej(); img.onload=()=>{ let max=1100,q=0.6,out=""; for(let attempt=0;attempt<6;attempt++){ let w=img.width,h=img.height; if(w>h&&w>max){h=Math.round(h*max/w);w=max;} else if(h>max){w=Math.round(w*max/h);h=max;} const c=document.createElement("canvas"); c.width=w;c.height=h; c.getContext("2d").drawImage(img,0,0,w,h); out=c.toDataURL("image/jpeg",q); if(out.length<900000)break; if(q>0.4)q-=0.1; else max=Math.round(max*0.82); } res(out); }; img.src=fr.result; }; fr.readAsDataURL(file); }); }
function openCamera(id){ const r=ARRIVALS.find(x=>x.id===id); if(!r)return; if(r.photoBy) openPhotoViewer(id); else startCapture(id); }
function startCapture(id){ if(!USER){ toast("Add your name first"); openName(); return; } camTarget=id; $("camInput").value=""; $("camInput").click(); }
$("camInput").addEventListener("change",async()=>{ const f=$("camInput").files[0]; if(!f||!camTarget)return; if(!fbReady){toast("No connection");return;} const id=camTarget; toast("Uploading photo…"); try{ const data=await compressPhoto(f); const by=USER.first+" "+USER.last; await setDoc(doc(db,"arrivalPhotos",id),{photo:data,addedBy:by,addedAt:serverTimestamp()}); await setDoc(doc(db,"arrivals",id),{photoBy:by,updatedAt:serverTimestamp()},{merge:true}); toast("Photo added"); if($("photoModal").classList.contains("show"))openPhotoViewer(id); }catch(e){ console.error(e); toast("Photo failed: "+(e.code||e.message)); } });
async function openPhotoViewer(id){ camTarget=id; const view=$("photoView"); view.innerHTML=`<div class="sub-empty">Loading…</div>`; $("photoRemove").style.display=adminUnlocked?"block":"none"; openModal("photoModal");
  try{ const snap=await getDoc(doc(db,"arrivalPhotos",id)); if(snap.exists()){ const d=snap.data(); view.innerHTML=`<img src="${d.photo}"><div class="pv-by">Added by <b>${esc(d.addedBy||"—")}</b></div>`; } else view.innerHTML=`<div class="sub-empty">Photo not found.</div>`; }
  catch(e){ view.innerHTML=`<div class="sub-empty">Couldn't load photo.</div>`; } }
onActivate($("photoReplace"),()=>{ if(camTarget)startCapture(camTarget); });
onActivate($("photoRemove"),async()=>{ if(!camTarget||!adminUnlocked)return; const id=camTarget; if(!confirm("Remove this photo?"))return; try{ await deleteDoc(doc(db,"arrivalPhotos",id)); await setDoc(doc(db,"arrivals",id),{photoBy:"",updatedAt:serverTimestamp()},{merge:true}); closeModal("photoModal"); toast("Photo removed"); }catch(e){ toast("Remove failed: "+(e.code||e.message)); } });

/* ---------- Arrival new/edit ---------- */
$("btnLog").addEventListener("click",()=>{ editing=null; $("logTitle").textContent="Log Arrival"; $("logSubmit").textContent="Save arrival"; $("logDelete").style.display="none"; $("f_date").value=todayIso(); ["f_po","f_job","f_req","f_jobname","f_desc","f_supplier","f_location"].forEach(i=>$(i).value=""); $("jobnameHint").textContent=""; logPhotoReset();openModal("logModal"); setTimeout(()=>$("f_job").focus(),300); });
$("f_job").addEventListener("input",()=>{ const j=normJob($("f_job").value),h=$("jobnameHint"); if(!isRealJob(j)){h.textContent="";return;} const f=distinctJobs().get(j); if(f&&f.jobName){h.textContent="Known job: "+f.jobName; if(!$("f_jobname").value)$("f_jobname").value=f.jobName;} else h.textContent=""; });
/* Photo attached while logging an arrival — same compression + storage as the camera button. */
let LOG_PHOTO="";
function logPhotoReset(){ LOG_PHOTO=""; const p=$("f_photoPrev"); if(p)p.style.display="none"; const f=$("f_photoFile"); if(f)f.value=""; const b=$("f_photoBtn"); if(b)b.textContent="📷 Add photo"; }
onActivate($("f_photoBtn"),()=>{ $("f_photoFile").value=""; $("f_photoFile").click(); });
$("f_photoFile").addEventListener("change",async()=>{ const f=$("f_photoFile").files[0]; if(!f)return; try{ LOG_PHOTO=await compressPhoto(f); $("f_photoImg").src=LOG_PHOTO; $("f_photoPrev").style.display="block"; $("f_photoBtn").textContent="📷 Change photo"; }catch(e){ console.error(e); toast("Couldn't read that photo"); } });
onActivate($("f_photoClear"),()=>logPhotoReset());
onActivate($("logSubmit"),saveArrival);
onActivate($("wn_save"),async()=>{
  if(!WD_NOTES_TARGET){ closeModal("notesModal"); return; }
  if(!fbReady){ toast("No connection"); return; }
  const data={ deliveryTime:$("wn_time").value.trim(), truck:$("wn_truck").value.trim(), extra:$("wn_extra").value.trim(), updatedAt:serverTimestamp() };
  try{ await setDoc(doc(db,"webductOrderNotes",WD_NOTES_TARGET), data, {merge:true}); closeModal("notesModal"); toast("Notes saved"); }catch(e){ console.error(e); toast("Couldn't save notes"); }
});
onActivate($("logDelete"),()=>{ if(editing&&editing.type==="arrival")doDelete("arrival",editing.id,true); });
async function saveArrival(){
  const rec={dateReceived:$("f_date").value||todayIso(),po:$("f_po").value.trim(),jobNumber:$("f_job").value.trim(),jobName:$("f_jobname").value.trim(),description:$("f_desc").value.trim(),supplier:$("f_supplier").value.trim(),storageLocation:$("f_location").value.trim(),requestedBy:$("f_req").value.trim()};
  if(!rec.jobNumber){toast("Job # is required");$("f_job").focus();return;}
  if(!rec.description){toast("Description is required");$("f_desc").focus();return;}
  if(!fbReady){toast("No Firebase connection");return;}
  const btn=$("logSubmit"); btn.disabled=true; btn.textContent="Saving…";
  try{
    let id;
    if(editing&&editing.type==="arrival"){ id=editing.id; await setDoc(doc(db,"arrivals",id),{...rec,seq:editing.seq,updatedAt:serverTimestamp()},{merge:true}); }
    else{ id=makeId([rec.dateReceived,rec.po,normJob(rec.jobNumber),rec.description.slice(0,80)])+"-"+Date.now().toString(36); await setDoc(doc(db,"arrivals",id),{...rec,seq:Date.now(),createdAt:serverTimestamp(),source:"manual"}); }
    if(LOG_PHOTO){
      const by=USER?(USER.first+" "+USER.last):"";
      await setDoc(doc(db,"arrivalPhotos",id),{photo:LOG_PHOTO,addedBy:by,addedAt:serverTimestamp()});
      await setDoc(doc(db,"arrivals",id),{photoBy:by,updatedAt:serverTimestamp()},{merge:true});
      logPhotoReset();
    }
    closeModal("logModal"); renderFeed(); renderJobs();
    toast(editing?"Arrival updated":"Arrival logged");
  }catch(e){ console.error(e); toast("Save failed: "+(e.code||e.message)); }
  finally{ btn.disabled=false; btn.textContent=editing?"Save changes":"Save arrival"; }
}

/* ---------- Rental new/edit ---------- */
$("btnRental").addEventListener("click",()=>{ editing=null; $("rentTitle").textContent="Log Rental"; $("rentSubmit").textContent="Save rental"; $("rentDelete").style.display="none"; $("r_date").value=todayIso(); ["r_id","r_job","r_by","r_jobname","r_equip","r_rate","r_vendor","r_po","r_returned"].forEach(i=>$(i).value=""); $("r_status").value="Renting"; $("rJobnameHint").textContent=""; openModal("rentalModal"); setTimeout(()=>$("r_job").focus(),300); });
$("r_job").addEventListener("input",()=>{ const j=normJob($("r_job").value),h=$("rJobnameHint"); if(!isRealJob(j)){h.textContent="";return;} const f=distinctJobs().get(j); if(f&&f.jobName){h.textContent="Known job: "+f.jobName; if(!$("r_jobname").value)$("r_jobname").value=f.jobName;} else h.textContent=""; });
onActivate($("rentSubmit"),saveRental);
onActivate($("rentDelete"),()=>{ if(editing&&editing.type==="rental")doDelete("rental",editing.id,true); });
async function saveRental(){
  const rec={dateRented:$("r_date").value||todayIso(),rentalId:$("r_id").value.trim(),jobNumber:$("r_job").value.trim(),orderedBy:$("r_by").value.trim(),jobName:$("r_jobname").value.trim(),equipment:$("r_equip").value.trim(),rate:$("r_rate").value.trim(),vendor:$("r_vendor").value.trim(),status:$("r_status").value,dateReturned:$("r_returned").value||"",po:$("r_po").value.trim()};
  if(!rec.jobNumber){toast("Job # is required");$("r_job").focus();return;}
  if(!rec.equipment){toast("Equipment is required");$("r_equip").focus();return;}
  if(!fbReady){toast("No Firebase connection");return;}
  const btn=$("rentSubmit"); btn.disabled=true; btn.textContent="Saving…";
  try{ if(editing&&editing.type==="rental"){ await setDoc(doc(db,"rentals",editing.id),{...rec,seq:editing.seq,updatedAt:serverTimestamp()},{merge:true}); } else { const id=makeId([rec.rentalId,normJob(rec.jobNumber),rec.equipment.slice(0,60),rec.dateRented])+"-"+Date.now().toString(36); await setDoc(doc(db,"rentals",id),{...rec,seq:Date.now(),createdAt:serverTimestamp(),source:"manual"}); } closeModal("rentalModal"); toast(editing?"Rental updated":"Rental logged"); }
  catch(e){ console.error(e); toast("Save failed: "+(e.code||e.message)); }
  finally{ btn.disabled=false; btn.textContent=editing?"Save changes":"Save rental"; }
}

/* ---------- Tool rental new/edit ---------- */
$("btnTool").addEventListener("click",()=>{ editing=null; $("toolTitle").textContent="Add Tool Rental"; $("toolSubmit").textContent="Save tool rental"; $("toolDelete").style.display="none"; $("t_start").value=todayIso(); ["t_job","t_jobname","t_type","t_id","t_end","t_days","t_daily","t_total","t_disc"].forEach(i=>$(i).value=""); $("t_closed").checked=false; $("tJobnameHint").textContent=""; openModal("toolModal"); setTimeout(()=>$("t_job").focus(),300); });
$("t_job").addEventListener("input",()=>{ const j=normJob($("t_job").value),h=$("tJobnameHint"); if(!isRealJob(j)){h.textContent="";return;} const f=distinctJobs().get(j); if(f&&f.jobName){h.textContent="Known job: "+f.jobName; if(!$("t_jobname").value)$("t_jobname").value=f.jobName;} else h.textContent=""; });
onActivate($("toolSubmit"),saveTool);
onActivate($("toolDelete"),()=>{ if(editing&&editing.type==="tool")doDelete("tool",editing.id,true); });
async function saveTool(){
  const end=$("t_end").value||"";
  const rec={jobNumber:$("t_job").value.trim(),jobName:$("t_jobname").value.trim(),jobClosed:$("t_closed").checked,toolType:$("t_type").value.trim(),toolId:$("t_id").value.trim(),rentalStarted:$("t_start").value||todayIso(),rentalEnded:end,billingDays:Number($("t_days").value)||0,dailyRate:Number($("t_daily").value)||0,billingTotal:$("t_total").value.trim(),discountedRate:$("t_disc").value.trim(),status:end?"Returned":"Out"};
  if(!rec.jobNumber){toast("Job # is required");$("t_job").focus();return;}
  if(!rec.toolType){toast("Tool type is required");$("t_type").focus();return;}
  if(!rec.toolId){toast("Tool ID is required");$("t_id").focus();return;}
  if(!fbReady){toast("No Firebase connection");return;}
  const btn=$("toolSubmit"); btn.disabled=true; btn.textContent="Saving…";
  try{ if(editing&&editing.type==="tool"){ await setDoc(doc(db,"toolRentals",editing.id),{...rec,seq:editing.seq,updatedAt:serverTimestamp()},{merge:true}); } else { const id=makeId([normJob(rec.jobNumber),rec.toolType,rec.toolId,rec.rentalStarted])+"-"+Date.now().toString(36); await setDoc(doc(db,"toolRentals",id),{...rec,seq:Date.now(),createdAt:serverTimestamp(),source:"manual"}); } closeModal("toolModal"); toast(editing?"Tool rental updated":"Tool rental added"); }
  catch(e){ console.error(e); toast("Save failed: "+(e.code||e.message)); }
  finally{ btn.disabled=false; btn.textContent=editing?"Save changes":"Save tool rental"; }
}

/* ---------- Edit / delete ---------- */
async function openEdit(type,id){
  if(type==="arrival"){ const r=ARRIVALS.find(x=>x.id===id); if(!r)return; editing={type,id:r.id,seq:r.seq}; $("logTitle").textContent="Edit Arrival"; $("logSubmit").textContent="Save changes"; $("logDelete").style.display="block"; $("f_date").value=r.dateReceived||todayIso(); $("f_po").value=r.po; $("f_job").value=r.jobNumber; $("f_req").value=r.requestedBy; $("f_jobname").value=r.jobName; $("f_desc").value=r.description; $("f_supplier").value=r.supplier; $("f_location").value=r.storageLocation||""; $("jobnameHint").textContent=""; logPhotoReset();openModal("logModal"); }
  else if(type==="rental"){ const r=RENTALS.find(x=>x.id===id); if(!r)return; editing={type,id:r.id,seq:r.seq}; $("rentTitle").textContent="Edit Rental"; $("rentSubmit").textContent="Save changes"; $("rentDelete").style.display="block"; $("r_date").value=r.dateRented||todayIso(); $("r_id").value=r.rentalId; $("r_job").value=r.jobNumber; $("r_by").value=r.orderedBy; $("r_jobname").value=r.jobName; $("r_equip").value=r.equipment; $("r_rate").value=r.rate; $("r_vendor").value=r.vendor; $("r_status").value=/return/i.test(r.status)?"Returned":"Renting"; $("r_returned").value=r.dateReturned||""; $("r_po").value=r.po; $("rJobnameHint").textContent=""; openModal("rentalModal"); }
  else { const r=TOOLS.find(x=>x.id===id); if(!r)return; editing={type,id:r.id,seq:r.seq}; $("toolTitle").textContent="Edit Tool Rental"; $("toolSubmit").textContent="Save changes"; $("toolDelete").style.display="block"; $("t_job").value=r.jobNumber; $("t_jobname").value=r.jobName; $("t_type").value=r.toolType; $("t_id").value=r.toolId; $("t_start").value=r.rentalStarted||todayIso(); $("t_end").value=r.rentalEnded||""; $("t_days").value=r.billingDays||""; $("t_daily").value=r.dailyRate||""; $("t_total").value=r.billingTotal||""; $("t_disc").value=r.discountedRate||""; $("t_closed").checked=!!r.jobClosed; $("tJobnameHint").textContent=""; openModal("toolModal"); }
}
async function doDelete(type,id,fromModal){
  const coll=type==="arrival"?"arrivals":type==="rental"?"rentals":"toolRentals";
  const item=(type==="arrival"?ARRIVALS:type==="rental"?RENTALS:TOOLS).find(x=>x.id===id);
  const label=type==="arrival"?(item?.description||"this arrival"):type==="rental"?(item?.equipment||"this rental"):((item?.toolType||"")+" #"+(item?.toolId||""));
  if(!confirm(`Delete this ${type}:\n\n${(label||"").slice(0,120)}\n\nThis can't be undone.`))return;
  try{ await deleteDoc(doc(db,coll,id)); if(type==="arrival"&&item?.photoBy){ try{await deleteDoc(doc(db,"arrivalPhotos",id));}catch(_){} } toast("Deleted"); if(fromModal)closeModal(type==="arrival"?"logModal":type==="rental"?"rentalModal":"toolModal"); }
  catch(e){ console.error(e); toast("Delete failed: "+(e.code||e.message)); }
}

/* ---------- Import: Excel (arrivals + rentals) ---------- */
$("btnImport").addEventListener("click",()=>{ $("importTitle").textContent="Import Excel"; $("importBody").innerHTML=dropHTML("excel"); wireDrop("excel"); openModal("importModal"); });
$("btnToolImport").addEventListener("click",()=>{ $("importTitle").textContent="Upload Tool Report"; $("importBody").innerHTML=dropHTML("pdf"); wireDrop("pdf"); openModal("importModal"); });
function dropHTML(kind){ const isPdf=kind==="pdf"; return `<div class="dropzone" id="dropzone"><div class="dz-ico">${isPdf?"🧰":"📄"}</div><h4>${isPdf?"Upload tool report":"Upload master sheet"}</h4><p>${isPdf?'Drop the <b>Webduct Tool Rental</b> PDF here, or pick it from your device.':'Drop your <b>Equipment Received &amp; Rentals</b> file here, or pick it.'} Re-importing is safe — duplicates merge.</p><label class="dz-btn">Choose file<input id="fileInput" type="file" accept="${isPdf?'.pdf':'.xlsx,.xlsm,.xls'}" hidden></label></div><div class="field" style="margin-top:16px"><div class="hint">${isPdf?'Reads every job and tool line. Job numbers, dates, days, and rates are pulled automatically.':'Loads every monthly tab into Arrivals, plus the Equipment Rentals tab into Rentals.'}</div></div>`; }
function wireDrop(kind){ const dz=$("dropzone"),input=$("fileInput"); if(!dz)return; const go=f=>{ if(kind==="pdf")handlePdf(f); else handleExcel(f); }; input.addEventListener("change",()=>{if(input.files[0])go(input.files[0]);}); ["dragenter","dragover"].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.add("drag");})); ["dragleave","drop"].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.remove("drag");})); dz.addEventListener("drop",e=>{const f=e.dataTransfer.files[0];if(f)go(f);}); }

function parseArrivalSheet(ws,name){ if(/rental/i.test(name))return[]; const rows=XLSX.utils.sheet_to_json(ws,{header:1,raw:true,defval:"",cellDates:true}); if(!rows.length)return[]; let hIdx=-1; for(let i=0;i<Math.min(rows.length,6);i++){const j=rows[i].map(c=>String(c).toLowerCase()).join("|"); if(j.includes("date received")||(j.includes("job")&&j.includes("description"))){hIdx=i;break;}} if(hIdx<0)hIdx=1; const H=rows[hIdx].map(c=>String(c).toLowerCase()); const col=(...k)=>{for(const x of k){const i=H.findIndex(h=>h.includes(x));if(i>=0)return i;}return -1;}; const cD=col("date received","received"),cP=col("p.o","po","p o"),cJ=col("job#","job #","job num"),cN=col("job name"),cDe=col("description"),cS=col("supplier"),cDl=col("delivery"),cR=col("requested"); const out=[]; for(let i=hIdx+1;i<rows.length;i++){const row=rows[i];const g=x=>x>=0?row[x]:"";const desc=String(g(cDe)||"").trim();const dk=fmtDateKey(g(cD));if(!desc&&!dk)continue;if(!desc&&!String(g(cJ)||"").trim())continue; out.push({dateReceived:dk,po:String(g(cP)||"").trim(),jobNumber:String(g(cJ)||"").trim(),jobName:String(g(cN)||"").trim(),description:desc,supplier:String(g(cS)||"").trim(),deliveryDate:fmtDateKey(g(cDl)),requestedBy:String(g(cR)||"").trim()});} return out; }
function parseRentalSheet(ws){ const rows=XLSX.utils.sheet_to_json(ws,{header:1,raw:true,defval:"",cellDates:true}); let hIdx=0; for(let i=0;i<Math.min(rows.length,4);i++){if(rows[i].map(c=>String(c).toLowerCase()).join("|").includes("rental")){hIdx=i;break;}} const out=[]; for(let i=hIdx+1;i<rows.length;i++){const r=rows[i];const rid=String(r[0]||"").trim(),jn=String(r[1]||"").trim(),eq=String(r[2]||"").trim();if(!rid&&!jn&&!eq)continue;const po=String(r[9]||"").trim();const jm=po.match(/(\d{2}-\d{4})/)||jn.match(/(\d{2}-\d{4})/); out.push({rentalId:rid,jobName:jn,equipment:eq,rate:String(r[3]||"").trim(),vendor:String(r[4]||"").trim(),dateRented:fmtDateKey(r[5]),status:/return/i.test(String(r[6]))?"Returned":(String(r[6]||"").trim()||"Renting"),dateReturned:fmtDateKey(r[7]),orderedBy:String(r[8]||"").trim(),po,jobNumber:jm?jm[1]:""});} return out; }

async function handleExcel(file){
  const body=$("importBody"); body.innerHTML=`<div class="imp-stage"><div class="ring"></div><h4>Reading file…</h4><p>${esc(file.name)}</p></div>`;
  if(!fbReady){ body.innerHTML=stageErr("No Firebase connection."); return; }
  try{
    const wb=XLSX.read(await file.arrayBuffer(),{cellDates:true});
    let arr=[],rnt=[];
    for(const name of wb.SheetNames){ if(/rental/i.test(name))rnt=rnt.concat(parseRentalSheet(wb.Sheets[name])); else arr=arr.concat(parseArrivalSheet(wb.Sheets[name],name)); }
    if(!arr.length&&!rnt.length){ body.innerHTML=stageErr("No rows found. Make sure this is the master sheet."); return; }
    const aMap=new Map(); arr.forEach(r=>aMap.set(makeId([r.dateReceived,r.po,normJob(r.jobNumber),r.description.slice(0,80)]),r));
    const rMap=new Map(); rnt.forEach(r=>rMap.set(makeId([r.rentalId,normJob(r.jobNumber),r.equipment.slice(0,60),r.dateRented]),r));
    const aAll=[...aMap.entries()],rAll=[...rMap.entries()],total=aAll.length+rAll.length;
    body.innerHTML=`<div class="imp-stage"><div class="ring"></div><h4>Importing ${total.toLocaleString()}…</h4><p id="impCount">${aAll.length} arrivals · ${rAll.length} rentals</p><div class="imp-bar"><i id="impBar"></i></div></div>`;
    let done=0; const CHUNK=400,base=Date.now()-total;
    for(let i=0;i<aAll.length;i+=CHUNK){ const b=writeBatch(db); aAll.slice(i,i+CHUNK).forEach(([id,r],k)=>b.set(doc(db,"arrivals",id),{...r,seq:base+i+k,source:"import"},{merge:true})); await b.commit(); done+=Math.min(CHUNK,aAll.length-i); upd(done,total); }
    for(let i=0;i<rAll.length;i+=CHUNK){ const b=writeBatch(db); rAll.slice(i,i+CHUNK).forEach(([id,r],k)=>b.set(doc(db,"rentals",id),{...r,seq:base+aAll.length+i+k,source:"import"},{merge:true})); await b.commit(); done+=Math.min(CHUNK,rAll.length-i); upd(done,total); }
    body.innerHTML=`<div class="imp-stage"><div style="font-size:46px;margin-bottom:10px">✅</div><h4>Import complete</h4><p><b>${aAll.length.toLocaleString()}</b> arrivals and <b>${rAll.length}</b> rentals synced.</p><button class="submit" style="margin-top:20px" id="impClose">Done</button></div>`;
    $("impClose").addEventListener("click",()=>closeModal("importModal")); toast(total.toLocaleString()+" imported");
  }catch(e){ console.error(e); body.innerHTML=stageErr("Import failed: "+(e.code||e.message)); }
}

async function handlePdf(file){
  const body=$("importBody"); body.innerHTML=`<div class="imp-stage"><div class="ring"></div><h4>Reading PDF…</h4><p>${esc(file.name)}</p></div>`;
  if(!fbReady){ body.innerHTML=stageErr("No Firebase connection."); return; }
  if(!window.pdfjsLib){ body.innerHTML=stageErr("PDF reader didn't load. Check your connection and retry."); return; }
  try{
    const buf=await file.arrayBuffer();
    const {items,pageMap,pages}=await parseToolPdf(buf.slice(0));
    if(!items.length){ body.innerHTML=stageErr("No tool lines found. Make sure this is the Webduct tool rental PDF."); return; }
    const map=new Map(); items.forEach(r=>map.set(makeId([normJob(r.jobNumber),r.toolType,r.toolId,r.rentalStarted]),r));
    const all=[...map.entries()],total=all.length;
    body.innerHTML=`<div class="imp-stage"><div class="ring"></div><h4>Importing ${total} tool lines…</h4><p id="impCount">Syncing</p><div class="imp-bar"><i id="impBar"></i></div></div>`;
    let done=0; const CHUNK=400,base=Date.now()-total;
    for(let i=0;i<all.length;i+=CHUNK){ const b=writeBatch(db); all.slice(i,i+CHUNK).forEach(([id,r],k)=>b.set(doc(db,"toolRentals",id),{...r,seq:base+i+k,source:"import"},{merge:true})); await b.commit(); done+=Math.min(CHUNK,all.length-i); upd(done,total); }
    // store the PDF itself so jobs can be verified against it
    body.innerHTML=`<div class="imp-stage"><div class="ring"></div><h4>Saving report…</h4><p>Storing the PDF so you can view each job in it.</p></div>`;
    try{ const b64=abToB64(buf); if(b64.length<1040000){ await setDoc(doc(db,"pdfStore","data"),{data:b64}); await setDoc(doc(db,"pdfStore","meta"),{name:file.name,pages,pageMap,uploadedAt:serverTimestamp()}); } else { await setDoc(doc(db,"pdfStore","meta"),{name:file.name,pages,pageMap,uploadedAt:serverTimestamp(),tooBig:true}); } }catch(pe){ console.error("pdf store",pe); }
    body.innerHTML=`<div class="imp-stage"><div style="font-size:46px;margin-bottom:10px">✅</div><h4>Import complete</h4><p><b>${total}</b> tool lines across ${new Set(items.map(i=>i.jobNumber)).size} jobs. The report PDF is saved — tap “PDF” on any job to verify.</p><button class="submit teal" style="margin-top:20px" id="impClose">Done</button></div>`;
    $("impClose").addEventListener("click",()=>closeModal("importModal")); toast(total+" tool lines imported");
  }catch(e){ console.error(e); body.innerHTML=stageErr("Import failed: "+(e.message||e)); }
}
function abToB64(buf){ let bin=""; const bytes=new Uint8Array(buf),chunk=0x8000; for(let i=0;i<bytes.length;i+=chunk){ bin+=String.fromCharCode.apply(null,bytes.subarray(i,i+chunk)); } return btoa(bin); }

/* ---------- PDF viewer (verify a job in the tool report) ---------- */
async function openPdfAt(job){
  if(!window.pdfjsLib){ toast("PDF reader didn't load"); return; }
  if(!PDF_META){ toast("No tool report uploaded yet"); return; }
  if(PDF_META.tooBig){ toast("PDF too large to store"); return; }
  const page=(PDF_META.pageMap&&PDF_META.pageMap[job])||1;
  pdfRender.job=job; pdfRender.page=page;
  const nm=distinctJobs().get(job)?.jobName;
  $("pdfJobLabel").textContent=job+(nm?" · "+nm:"");
  $("pdfLoading").style.display="block"; $("pdfLoading").textContent="Loading…";
  $("pdfWrap").querySelectorAll("canvas").forEach(c=>c.remove());
  $("pdfPageLabel").textContent="—"; $("pdfPrev").disabled=true; $("pdfNext").disabled=true;
  openModal("pdfModal");
  try{
    if(!pdfRender.doc){
      const snap=await getDoc(doc(db,"pdfStore","data"));
      if(!snap.exists()||!snap.data().data){ $("pdfLoading").textContent="PDF data not found — re-upload the report."; return; }
      const bytes=Uint8Array.from(atob(snap.data().data),c=>c.charCodeAt(0));
      pdfRender.doc=await pdfjsLib.getDocument({data:bytes}).promise;
    }
    pdfRender.pages=pdfRender.doc.numPages;
    await renderPdfPage(page);
  }catch(e){ console.error(e); $("pdfLoading").textContent="Couldn't open the PDF."; }
}
async function renderPdfPage(n){
  if(!pdfRender.doc)return;
  n=Math.max(1,Math.min(n,pdfRender.doc.numPages)); pdfRender.page=n;
  const page=await pdfRender.doc.getPage(n);
  const wrap=$("pdfWrap"), vw=Math.max(280,wrap.clientWidth-28);
  const base=page.getViewport({scale:1}), scale=Math.min(3,Math.max(0.5,vw/base.width));
  const vp=page.getViewport({scale});
  let canvas=wrap.querySelector("canvas"); if(!canvas){ canvas=document.createElement("canvas"); wrap.appendChild(canvas); }
  canvas.width=vp.width; canvas.height=vp.height;
  await page.render({canvasContext:canvas.getContext("2d"),viewport:vp}).promise;
  $("pdfLoading").style.display="none"; wrap.scrollTop=0;
  $("pdfPageLabel").textContent="Pg "+n+" / "+pdfRender.doc.numPages;
  $("pdfPrev").disabled=n<=1; $("pdfNext").disabled=n>=pdfRender.doc.numPages;
}
$("pdfPrev").addEventListener("click",()=>renderPdfPage(pdfRender.page-1));
$("pdfNext").addEventListener("click",()=>renderPdfPage(pdfRender.page+1));

async function parseToolPdf(buf){
  const pdf=await pdfjsLib.getDocument({data:buf}).promise;
  const JOBHDR=/^(CLOSED\s+)?(\d{2}-\d{4})$/;
  let lines=[]; const pageMap={};
  for(let p=1;p<=pdf.numPages;p++){
    const page=await pdf.getPage(p); const tc=await page.getTextContent(); const buckets=[];
    for(const it of tc.items){ if(!it.str||!it.str.trim())continue; const y=it.transform[5],x=it.transform[4],w=it.width||0; let b=buckets.find(bk=>Math.abs(bk.y-y)<=2.5); if(!b){b={y,items:[]};buckets.push(b);} b.items.push({x,end:x+w,s:it.str}); }
    buckets.sort((a,b)=>b.y-a.y);
    for(const b of buckets){ b.items.sort((p,q)=>p.x-q.x); let line="",prev=null; for(const it of b.items){ if(prev!==null)line+=(it.x-prev>1.2?" ":"")+it.s; else line=it.s; prev=it.end; } line=line.replace(/\s+/g," ").trim(); lines.push(line); const jh=JOBHDR.exec(line); if(jh && !(jh[2] in pageMap)) pageMap[jh[2]]=p; }
  }
  return {items:parseToolLines(lines), pageMap, pages:pdf.numPages};
}
function parseToolLines(lines){
  const LINEITEM=/^(.*?)\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\(blank\)|\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d+)\s+([\d.]+)\s+\$\s*([\d.,]+|-)\s+\$\s*([\d.,]+|-)$/;
  const JOBHDR=/^(CLOSED\s+)?(\d{2}-\d{4})$/;
  const skip=l=>!l.trim()||/^Webduct Tool Rental/.test(l)||/^Rates are based/.test(l)||/^Row Labels/.test(l)||/^Page /.test(l)||/^Grand Total/.test(l)||/\bTotal\b\s*\$/.test(l);
  const out=[]; let job=null,name=null,tool=null,closed=false,expectName=false;
  for(const raw of lines){ const l=raw.trim(); if(skip(l))continue;
    const jh=JOBHDR.exec(l); if(jh){ closed=!!jh[1]; job=jh[2]; expectName=true; tool=null; name=null; continue; }
    if(expectName){ name=l; expectName=false; continue; }
    const mi=LINEITEM.exec(l);
    if(mi){ const end=mi[3]==="(blank)"?"":fmtDateKey(mi[3]); out.push({jobNumber:job,jobName:name,jobClosed:closed,toolType:tool||"",toolId:mi[1].trim(),rentalStarted:fmtDateKey(mi[2]),rentalEnded:end,billingDays:Number(mi[4])||0,dailyRate:Number(mi[5])||0,billingTotal:mi[6],discountedRate:mi[7],status:end?"Returned":"Out"}); }
    else { tool=l; }
  }
  return out;
}

function upd(done,total){ const p=Math.round(done/total*100); const bar=$("impBar"); if(bar)bar.style.width=p+"%"; const c=$("impCount"); if(c)c.textContent=done.toLocaleString()+" of "+total.toLocaleString(); }
function stageErr(msg){ return `<div class="imp-stage"><div style="font-size:42px;margin-bottom:10px">⚠️</div><h4>Couldn't import</h4><p>${esc(msg)}</p><button class="submit" style="margin-top:20px" id="impErrClose">Close</button></div>`; }
document.addEventListener("click",e=>{ if(e.target&&e.target.id==="impErrClose")closeModal("importModal"); });

/* ---------- Export to Excel ---------- */
function exportExcel(){
  if(!window.XLSX){ toast("Excel library didn't load"); return; }
  const btn=$("btnExport"); btn.disabled=true;
  try{
    const wb=XLSX.utils.book_new();
    const dt=iso=>{ if(!iso)return ""; const p=String(iso).split("-").map(Number); if(p.length<3||!p[0])return iso; const d=new Date(p[0],p[1]-1,p[2]); return isNaN(d)?iso:d; };
    const sheet=(rows,blank,cols,name)=>{ const ws=XLSX.utils.json_to_sheet(rows.length?rows:[blank]); ws['!cols']=cols.map(w=>({wch:w})); if(ws['!ref'])ws['!autofilter']={ref:ws['!ref']}; XLSX.utils.book_append_sheet(wb,ws,name); };

    // 1) Equipment Received (Arrivals) — newest first like the site
    const arr=[...ARRIVALS].sort((a,b)=>a.dateReceived!==b.dateReceived?(a.dateReceived<b.dateReceived?1:-1):(b.seq||0)-(a.seq||0))
      .map(r=>({"Date Received":dt(r.dateReceived),"Job #":r.jobNumber||"","Job Name":r.jobName||"","Description":r.description||"","Stored At":r.storageLocation||"","Requested Delivery":dt(r.reqDeliv),"Delivered":r.delivered?"Yes":"","Date Delivered":dt(r.deliveredDate),"Partial":r.partial?"PARTIAL":"","Supplier":r.supplier||"","PO":r.po||"","Requested By":r.requestedBy||"","Photo By":r.photoBy||""}));
    sheet(arr,{"Date Received":"","Job #":"","Job Name":"","Description":"","Stored At":"","Requested Delivery":"","Delivered":"","Date Delivered":"","Partial":"","Supplier":"","PO":"","Requested By":"","Photo By":""},[13,10,26,40,14,15,10,14,9,15,16,16,14],"Equipment Received");

    // 2) Equipment Rentals — rate split into Daily / Weekly / Monthly
    const sr=rate=>{const p=String(rate||"").split("/").map(s=>s.replace(/,+$/,"").trim());return{d:p[0]||"",w:p[1]||"",m:p[2]||""};};
    const rnt=[...RENTALS].sort((a,b)=>a.dateRented!==b.dateRented?(a.dateRented<b.dateRented?1:-1):(b.seq||0)-(a.seq||0))
      .map(r=>{const rt=sr(r.rate);return{"Contract / Rental ID":r.rentalId||"","Job #":r.jobNumber||"","Job Name":r.jobName||"","Equipment":r.equipment||"","Daily":rt.d,"Weekly":rt.w,"Monthly":rt.m,"Status":/return/i.test(r.status)?"Returned":(r.status||"Renting"),"Date Rented":dt(r.dateRented),"Date Returned":dt(r.dateReturned),"Vendor":r.vendor||"","Ordered By":r.orderedBy||"","PO":r.po||""};});
    sheet(rnt,{"Contract / Rental ID":"","Job #":"","Job Name":"","Equipment":"","Daily":"","Weekly":"","Monthly":"","Status":"","Date Rented":"","Date Returned":"","Vendor":"","Ordered By":"","PO":""},[20,10,26,34,11,11,11,11,13,13,16,16,16],"Equipment Rentals");

    // 3) Tool Rentals — grouped by job (job# then start date)
    const tls=[...TOOLS].sort((a,b)=>{const ja=normJob(a.jobNumber),jb=normJob(b.jobNumber);return ja!==jb?(ja<jb?-1:1):(a.rentalStarted<b.rentalStarted?1:-1);})
      .map(r=>({"Job #":r.jobNumber||"","Job Name":r.jobName||"","Job Closed":r.jobClosed?"Yes":"","Tool Type":r.toolType||"","Tool ID":r.toolId||"","Started":dt(r.rentalStarted),"Ended":dt(r.rentalEnded),"Status":/return/i.test(r.status)?"Returned":"Out","Billing Days":r.billingDays||0,"Daily Rate":r.dailyRate||0,"Billing Total":r.billingTotal||"","Discounted Rate":r.discountedRate||""}));
    sheet(tls,{"Job #":"","Job Name":"","Job Closed":"","Tool Type":"","Tool ID":"","Started":"","Ended":"","Status":"","Billing Days":"","Daily Rate":"","Billing Total":"","Discounted Rate":""},[10,26,11,22,12,12,12,10,12,11,13,14],"Tool Rentals");

    // 4) My Jobs summary
    if(MY_JOBS.length){ const jm=distinctJobs(); const order=MJ_VIEW.length?MJ_VIEW:MY_JOBS;
      const mj=order.filter(j=>MY_JOBS.includes(j)).map(j=>({"Job #":j,"Job Name":jm.get(j)?.jobName||"","Arrivals":ARRIVALS.filter(r=>normJob(r.jobNumber)===j).length,"Equipment Rentals":RENTALS.filter(r=>normJob(r.jobNumber)===j).length,"Tool Rentals":TOOLS.filter(r=>normJob(r.jobNumber)===j).length,"Last Activity":dt(jm.get(j)?.last||"")}));
      sheet(mj,{"Job #":"","Job Name":"","Arrivals":"","Equipment Rentals":"","Tool Rentals":"","Last Activity":""},[10,28,10,16,12,14],"My Jobs"); }

    const today=todayIso();
    XLSX.writeFile(wb,`Arctic Equipment Export ${today}.xlsx`);
    toast("Exported to Excel");
  }catch(e){ console.error(e); toast("Export failed: "+(e.message||e)); }
  finally{ btn.disabled=false; }
}
$("btnExport").addEventListener("click",exportExcel);

/* ============================================================
   WEBDUCT API TEST — diagnostic harness
   Runs real fetch() calls from the browser so we can see, with
   certainty, whether GitHub Pages → api.webduct.com is possible,
   and if not, exactly why (CORS vs auth vs 404 vs network/DNS).
   ============================================================ */
let WD_TOKEN=sessionStorage.getItem("wd_token")||"";   // personal token (Deliveries fallback only)
let WD_TEST_TOKEN=sessionStorage.getItem("wd_test_token")||"";  // manual override used ONLY by the admin tester
let WD_ADMIN_CREDS=null;                                // shared company login {email,password} from Firebase
let WD_ADMIN_TOKEN="";                                  // freshly-minted token from those creds (cached in-memory this session)
let WD_ADMIN_TOKEN_TS=0;                                // when it was minted
const WD_TOKEN_TTL=1000*60*45;                          // treat a minted token as good for 45 min, then re-mint
const WD_BASE="https://api.webduct.com/public";

// Mint a fresh token from the stored company creds. Cached briefly so we don't hammer the auth endpoint.
async function wdMintAdminToken(force){
  if(!WD_ADMIN_CREDS || !WD_ADMIN_CREDS.email || !WD_ADMIN_CREDS.password) return "";
  if(!force && WD_ADMIN_TOKEN && (Date.now()-WD_ADMIN_TOKEN_TS)<WD_TOKEN_TTL) return WD_ADMIN_TOKEN;
  const r=await wdFetch("POST",WD_BASE+"/oauth/authorize/password",{headers:{"Content-Type":"application/x-www-form-urlencoded","Accept":"application/json"},body:new URLSearchParams({username:WD_ADMIN_CREDS.email,password:WD_ADMIN_CREDS.password}).toString()});
  let tok=""; if(r.json){ const d=r.json.data||{}; tok=d.accessToken||d.access_token||d.token||r.json.accessToken||r.json.token||""; }
  if(tok){ WD_ADMIN_TOKEN=tok; WD_ADMIN_TOKEN_TS=Date.now(); }
  return tok;
}
// Do we have a working company connection (creds on file)?
function wdHasAdmin(){ return !!(WD_ADMIN_CREDS && WD_ADMIN_CREDS.email && WD_ADMIN_CREDS.password); }
// Any usable connection at all (company creds or a personal fallback token).
function wdConnected(){ return wdHasAdmin() || !!WD_TOKEN; }
// Best token available right now WITHOUT minting. If the company account is connected, ONLY ever
// use its token — never fall back to a personal token (prevents showing one person's data).
function wdSyncToken(){ if(wdHasAdmin()) return WD_ADMIN_TOKEN; return WD_TOKEN; }
// The token the SYNC should use — mints fresh from company creds; personal only if no company login.
async function wdActiveSyncToken(){ if(wdHasAdmin()){ return await wdMintAdminToken(false); } return WD_TOKEN; }

// Red/green light everywhere + the admin box status.
function wdUpdateLights(){
  const on=wdHasAdmin();
  const hd=$("wdHdrDot"), ht=$("wdHdrTxt");
  if(hd){ hd.className="wd-hdr-dot "+(on?"on":"off"); }
  if(ht){ ht.textContent=on?"Webduct on":"Webduct off"; }
  const kd=$("wdKeyDot"), ks=$("wdKeyStatusTxt"), ka=$("wdKeyActions");
  if(kd){ kd.className="wd-key-dot "+(on?"on":"off"); }
  if(ks){ ks.textContent=on?("Connected as "+WD_ADMIN_CREDS.email+" — active for the whole team"):"Not connected — no company login saved"; }
  if(ka){ ka.style.display=on?"flex":"none"; }
}
// Listen for the shared company login in Firebase (config/webductKey).
function wdWatchAdminKey(){
  if(!fbReady) return;
  try{
    onSnapshot(doc(db,"config","webductKey"), d=>{
      const v=d.exists()?d.data():null;
      if(v && v.email && v.password){ WD_ADMIN_CREDS={email:v.email,password:v.password}; }
      else { WD_ADMIN_CREDS=null; WD_ADMIN_TOKEN=""; WD_ADMIN_TOKEN_TS=0; }
      wdUpdateLights();
    }, e=>console.error("adminKey",e));
  }catch(e){ console.error(e); }
}
// Full endpoint catalog from the Webduct public API (Swagger). {group?, m, p, b?(has body), note?}
const WD_ENDPOINTS=[
  {m:"GET",p:"/jobs",note:"list of jobs (job # + name)"},
  {m:"GET",p:"/orders",note:"orders — same date-window filter the calendar uses"},
  {m:"GET",p:"/orders/fulfillment/statuses",note:"fulfillment statuses"},
  {m:"GET",p:"/orders/fulfillment/groups",note:"fulfillment groups (departments)"},
  {m:"GET",p:"/orders/shipping/statuses",note:"shipping statuses"},
  {m:"GET",p:"/products/scripts",note:"product scripts"}
];
function wdBase(){ return WD_BASE; }
function wdActiveToken(){ return wdSyncToken(); }
function wdAuthHeaders(){ const tok=wdActiveToken(); return tok?{"Bearer":tok}:{}; }   // API's apiKey header is literally named "Bearer"
// Which token the TESTER should use: manual override first, else the company key.
function wdTesterToken(){ return WD_TEST_TOKEN || WD_ADMIN_TOKEN; }
function wdRenderToken(){
  // Show what the tester will actually use.
  const el=$("wd_tokActive"); if(!el) return;
  if(WD_TEST_TOKEN){ el.innerHTML=`<span class="wd-tok-badge override">MANUAL TOKEN</span> Testing with your pasted token`; }
  else if(wdHasAdmin()){ el.innerHTML=`<span class="wd-tok-badge company">COMPANY</span> Testing with the shared company login${WD_ADMIN_TOKEN?"":" (will sign in when you send)"}`; }
  else { el.innerHTML=`<span class="wd-tok-badge none">NONE</span> No token — paste one below or connect the company login above`; }
  const w=$("wd_tokenWrap");
  if(w){ const show=WD_TEST_TOKEN||WD_ADMIN_TOKEN; if(show){ w.style.display="flex"; $("wd_token").textContent=show; } else { w.style.display="none"; } }
  const mt=$("wd_manualTok"); if(mt && !mt.value && WD_TEST_TOKEN) mt.value=WD_TEST_TOKEN;
}
function wdRenderPresetSel(){
  const sel=$("wd_presetSel"); let html='<option value="">— pick an endpoint —</option>';
  WD_ENDPOINTS.forEach((e,i)=>{ if(e.group){ html+=`<option disabled>${esc(e.group)}</option>`; } else { html+=`<option value="${i}">${e.m}  ${esc(e.p)}${e.note?"  — "+esc(e.note):""}</option>`; } });
  sel.innerHTML=html;
}
wdRenderPresetSel(); wdRenderToken();
// Scan the current path for {placeholders} and render a labeled input for each.
function wdRenderParams(){
  const path=$("wd_path").value; const names=[...path.matchAll(/\{([^}]+)\}/g)].map(m=>m[1]);
  const box=$("wd_params");
  if(!names.length){ box.innerHTML=""; return; }
  const prev={}; box.querySelectorAll("[data-wdparam]").forEach(inp=>prev[inp.dataset.wdparam]=inp.value);
  box.innerHTML=`<div class="wd-param-note">This endpoint needs a specific value — fill it in:</div>`+names.map(n=>`<div class="field"><label>${esc(n)}</label><input data-wdparam="${esc(n)}" type="text" value="${esc(prev[n]||"")}" autocomplete="off" spellcheck="false" placeholder="e.g. ${esc(n==="orderNumber"?"263308":n==="id"?"a record id":"value")}"></div>`).join("");
}
function wdResolvePath(){
  let path=$("wd_path").value.trim(); if(!/^\//.test(path)) path="/"+path;
  const inputs=$("wd_params").querySelectorAll("[data-wdparam]");
  for(const inp of inputs){ const v=inp.value.trim(); if(v) path=path.replace("{"+inp.dataset.wdparam+"}", encodeURIComponent(v)); }
  return path;
}
$("wd_presetSel").addEventListener("change",()=>{
  const i=$("wd_presetSel").value; if(i==="")return; const e=WD_ENDPOINTS[+i]; if(!e||e.group)return;
  $("wd_method").value=e.m; $("wd_path").value=e.p;
  $("wd_bodyWrap").style.display=e.b?"block":"none";
  $("wd_presetHint").innerHTML = e.note?esc(e.note):"";
  wdRenderParams();
});
$("wd_path").addEventListener("input",wdRenderParams);
$("wd_method").addEventListener("change",()=>{ $("wd_bodyWrap").style.display=/POST|PUT/.test($("wd_method").value)?"block":"none"; });
onActivate($("wd_tokenClear"),()=>{ WD_TEST_TOKEN=""; sessionStorage.removeItem("wd_test_token"); $("wd_manualTok").value=""; wdRenderToken(); $("wd_tokenHint").textContent="Override cleared — back to the company login."; });
onActivate($("wd_manualSet"),()=>{ const t=$("wd_manualTok").value.trim(); if(!t){ toast("Paste a token first"); return; } WD_TEST_TOKEN=t; sessionStorage.setItem("wd_test_token",t); wdRenderToken(); $("wd_tokenHint").innerHTML="<span style='color:#0d7a73'>✓ Now testing with your pasted token.</span>"; toast("Manual token set"); });
onActivate($("wd_manualClear"),()=>{ WD_TEST_TOKEN=""; sessionStorage.removeItem("wd_test_token"); $("wd_manualTok").value=""; wdRenderToken(); $("wd_tokenHint").textContent="Override cleared — back to the company login."; });
onActivate($("wd_pwToggle"),()=>{ const b=$("wd_pwBox"),t=$("wd_pwToggle"); const open=b.style.display==="none"; b.style.display=open?"block":"none"; t.textContent=(open?"▾":"▸")+" Or sign in with a username/password to get a token"; });

// Distinguish a network/CORS failure from a real HTTP response.
async function wdFetch(method,url,{headers={},body=null,timeout=20000}={}){
  const t0=performance.now();
  let res;
  // Abort a request that takes too long, so a single hung call can't freeze the whole sync.
  const ctrl=new AbortController();
  const timer=setTimeout(()=>ctrl.abort(), timeout);
  try{
    res=await fetch(url,{method,headers,body,mode:"cors",credentials:"omit",signal:ctrl.signal});
  }catch(err){
    clearTimeout(timer);
    // fetch() rejects for network-level failures (CORS, DNS, offline) OR an abort (timeout).
    const timedOut=(err&&err.name==="AbortError");
    return {ok:false,threw:true,error:err,timedOut,ms:Math.round(performance.now()-t0)};
  }
  clearTimeout(timer);
  const ms=Math.round(performance.now()-t0);
  const ct=res.headers.get("content-type")||"";
  const isBinary=/pdf|octet-stream|zip|image|excel|spreadsheet|word|msword/i.test(ct);
  if(isBinary){
    // Binary payload (e.g. a generated PDF). Grab it as a blob so we can offer a download.
    let blob=null,size=0,url2="";
    try{ blob=await res.blob(); size=blob.size; url2=URL.createObjectURL(blob); }catch(_){}
    return {ok:res.ok,threw:false,status:res.status,statusText:res.statusText,ct,binary:true,blobUrl:url2,blobSize:size,ms};
  }
  let text="",json=null;
  try{ text=await res.text(); }catch(_){}
  if(/json/i.test(ct)||/^[\s]*[[{]/.test(text)){ try{ json=JSON.parse(text); }catch(_){} }
  return {ok:res.ok,threw:false,status:res.status,statusText:res.statusText,ct,text,json,ms};
}

function wdShowResult(label,r,{isLogin=false}={}){
  $("wd_resultCard").style.display="block";
  const pill=$("wd_statusPill"), diag=$("wd_diag"), out=$("wd_out");
  const online=navigator.onLine;
  let cls,heading,points=[],pretty;

  if(r.threw){
    // Network-level rejection — classify the likely cause.
    cls="bad"; pill.className="wd-status bad"; pill.textContent="BLOCKED";
    const msg=(r.error&&r.error.message)||String(r.error);
    heading="The request never completed — the browser blocked it or couldn't reach the server.";
    if(!online){ points.push("Your device reports it's <b>offline</b>. Check the connection and retry."); }
    else {
      points.push("This is a <b>network-level failure</b>, which almost always means one of these:");
      points.push("<b>CORS</b> — most likely. The server answered, but didn't send an <code>Access-Control-Allow-Origin</code> header permitting this website's origin (<code>"+esc(location.origin)+"</code>), so the browser threw the response away before our code could read it. This is the exact wall we were testing for. Fix = a small server-side relay (Firebase Cloud Function) that holds credentials and calls Webduct; the app then reads results from Firestore.");
      points.push("<b>Bad base URL / DNS</b> — if the host is wrong or unreachable. Double-check <code>"+esc(wdBase())+"</code>.");
      points.push("<b>Mixed content</b> — only if the URL were <code>http://</code> on an <code>https://</code> page. Yours is https, so unlikely.");
      points.push("Raw error the browser gave: <code>"+esc(msg)+"</code>");
      points.push("<b>How to be 100% sure it's CORS:</b> open your browser's DevTools → Console right after this. A CORS block prints a message like “<i>Access to fetch at 'api.webduct.com…' from origin '"+esc(location.origin)+"' has been blocked by CORS policy</i>.” If you see that line, it's confirmed CORS and we move to the Cloud Function.");
    }
    pretty=`// No HTTP response was received (fetch rejected).\n// Elapsed: ${r.ms} ms\n// navigator.onLine: ${online}\n// Error: ${msg}`;
    toast("❌ Blocked — no response (likely CORS). See details.");
  } else {
    const good = isLogin ? (r.ok && (r.json||r.text)) : r.ok;
    if(good){
      cls="ok"; pill.className="wd-status ok"; pill.textContent=r.status+" OK";
      if(r.binary){
        heading="Success — this endpoint returned a FILE (not JSON). This is very likely the report you're after.";
        const kb=(r.blobSize/1024).toFixed(1);
        points.push("Content-Type: <code>"+esc(r.ct)+"</code> · Size: "+kb+" KB. That's a binary document — almost certainly a generated PDF.");
        points.push("If this is the tool-rental report, we can pull it automatically and store it, replacing the manual upload. 🎯");
      } else {
        heading=isLogin?"Success — the server responded and we got a token back.":"Success — the server responded with data.";
        points.push("The browser <b>can</b> reach <code>"+esc(wdBase())+"</code> from this app's origin (<code>"+esc(location.origin)+"</code>) and read the response. Cross-origin is working — no server relay needed. 🎉");
      }
      points.push("Response time: "+r.ms+" ms"+(r.binary?"":" · Content-Type: <code>"+esc(r.ct||"(none)")+"</code>"));
      toast(isLogin?"✅ Token received":r.binary?"✅ Got a file! See Result.":"✅ "+r.status+" — it works!");
    } else {
      cls="bad"; pill.className="wd-status bad"; pill.textContent=r.status+" "+(r.statusText||"");
      heading="The server responded, but with an error status. (Good news: this means CORS is NOT the problem — the browser reached Webduct fine.)";
      if(r.status===401||r.status===403){ points.push("<b>"+r.status+" — authentication/permission.</b> "+(isLogin?"The username/password were rejected, or the token grant path differs.":"Likely the token header. This API declares its key as a header literally named <code>Bearer</code> — if you're on 'Authorization: Bearer', switch the <b>Auth header style</b> to the first option and resend. Otherwise the token may be wrong/expired, or your Webduct user lacks the <b>Public API</b> permission (plus job-admin/timecard) your rep mentioned enabling in BCX.")); }
      else if(r.status===404){ points.push("<b>404 — path not found.</b> The endpoint or the base URL's version segment is off. Try toggling <code>/public</code> or <code>/v1</code> in the Base URL, or adjust the path."); }
      else if(r.status===400||r.status===422){ points.push("<b>"+r.status+" — bad request.</b> The endpoint was found but didn't like the input (method or JSON body). For GETs this usually means a required query parameter is missing."); }
      else if(r.status>=500){ points.push("<b>"+r.status+" — server-side error at Webduct.</b> The path is reachable; their end hit a problem. Worth retrying or asking your rep."); }
      else { points.push("HTTP <b>"+r.status+"</b> "+esc(r.statusText||"")+"."); }
      points.push("Because a real status came back, a browser-to-Webduct integration is technically possible — we just need to get the request shape/credentials right.");
      toast("⚠️ "+r.status+" "+(r.statusText||"")+" — server reached, see details.");
    }
    pretty = r.binary ? `// Binary file response (${(r.blobSize/1024).toFixed(1)} KB, ${r.ct}).\n// Not text — use the download button in the Readable tab.` : (r.json ? JSON.stringify(r.json,null,2) : (r.text||"(empty response body)"));
    if(pretty.length>20000) pretty=pretty.slice(0,20000)+"\n… (truncated)";
  }

  diag.className="wd-diag "+cls;
  diag.innerHTML=`<b>${esc(heading)}</b><ul>${points.map(p=>"<li>"+p+"</li>").join("")}</ul>`;
  out.textContent=pretty;
  // Record count, if the payload is a list (Webduct wraps lists in { data: [...] }).
  const cnt=$("wd_count"); const arr = r.json && Array.isArray(r.json.data) ? r.json.data : (Array.isArray(r.json)?r.json:null);
  cnt.textContent = arr ? `· ${arr.length} record${arr.length===1?"":"s"}` : "";
  // Build the plain-English readable view.
  $("wd_readable").innerHTML = wdReadable(r, label);
  wdShowView("readable");
  wdLog(label, r.threw?"ERR":(r.ok?"ok":"bad"), r.threw?"blocked":r.status);
}

function wdShowView(which){
  const rd=which==="readable";
  $("wd_readable").style.display=rd?"flex":"none";
  $("wd_rawWrap").style.display=rd?"none":"block";
  $("wd_tabReadable").classList.toggle("active",rd);
  $("wd_tabRaw").classList.toggle("active",!rd);
}
onActivate($("wd_tabReadable"),()=>wdShowView("readable"));
onActivate($("wd_tabRaw"),()=>wdShowView("raw"));

function wdEsc(x){ return esc(x==null?"":String(x)); }function wdDate(s){ if(!s)return""; const d=new Date(s); if(isNaN(d))return String(s); return (d.getMonth()+1)+"/"+d.getDate(); }
function wdRow(k,v){ if(v==null||v==="")return ""; return `<div class="wd-kv"><span class="k">${wdEsc(k)}</span><span class="v">${v}</span></div>`; }
function wdBadge(txt,tone){ return `<span class="wd-rec-badge ${tone||""}">${wdEsc(txt)}</span>`; }

// Turn a status label into a color tone.
function wdTone(label){ const l=(label||"").toLowerCase(); if(/deliver|complete|done|success|active|shipped/.test(l))return"green"; if(/progress|production|partial|started/.test(l))return"amber"; if(/not started|pending|hold|cancel/.test(l))return""; return"blue"; }

function wdReadable(r, label){
  if(r.threw) return `<div class="sub-empty">No response to show — the request was blocked. See the Raw tab / diagnosis above.</div>`;
  if(r.binary){
    const kb=(r.blobSize/1024).toFixed(1);
    const isPdf=/pdf/i.test(r.ct);
    const fname=(label||"webduct-file").replace(/[^A-Za-z0-9]+/g,"-").replace(/^-|-$/g,"")+(isPdf?".pdf":"");
    return `<div class="wd-rec"><div class="wd-rec-head"><span class="wd-rec-title">📄 File returned</span>${wdBadge(isPdf?"PDF":"FILE","green")}</div><div class="wd-rec-body">
      ${wdRow("Type", wdEsc(r.ct))}
      ${wdRow("Size", kb+" KB")}
      <div style="margin-top:10px"><a href="${r.blobUrl}" download="${wdEsc(fname)}" class="wd-dl">⬇ Download file</a> ${isPdf?`<a href="${r.blobUrl}" target="_blank" class="wd-dl" style="background:var(--surface);color:var(--ink);border:1px solid var(--line)">Open in new tab</a>`:""}</div>
      <div class="wd-more">If this is the tool-rental report, tell me and I'll wire it to pull + store automatically.</div>
    </div></div>`;
  }
  const j=r.json;
  if(!j) return `<div class="sub-empty">Response wasn't JSON. Here it is as text:</div><pre class="wd-out" style="margin-top:8px">${wdEsc(r.text||"(empty)")}</pre>`;
  const status=j.status||{};
  if(status && (status.id==="error"||status.code>=400||status.id==="invalid_token")){
    return `<div class="wd-rec"><div class="wd-rec-head">${wdBadge("Error "+(status.code||""),"amber")}<span class="wd-rec-title">${wdEsc(status.id||"Request failed")}</span></div><div class="wd-rec-body">${wdRow("Message", wdEsc(j.message||status.message||"The server returned an error."))}</div></div>`;
  }
  const data = ("data" in j) ? j.data : j;
  if(data==null) return `<div class="sub-empty">The call succeeded but returned no data.</div>`;
  const list = Array.isArray(data) ? data : [data];
  if(!list.length) return `<div class="sub-empty">The call succeeded but the list is empty.</div>`;

  const kind = wdGuessKind(label, list[0]);
  // Show most-recent data first. Find a date-ish field on the sample and sort descending by it.
  const sorted = list.slice();
  try{
    const dateOf=rec=>{ if(!rec||typeof rec!=="object")return 0;
      const cand=rec.ordered||rec.requested||rec.dateCreated||rec.dateModified||rec.created||rec.modified||rec.date||(rec.delivery&&rec.delivery.date)||"";
      const t=new Date(cand).getTime(); return isNaN(t)?0:t; };
    if(sorted.some(r=>dateOf(r)>0)) sorted.sort((a,b)=>dateOf(b)-dateOf(a));
  }catch(_){}
  const shown = sorted.slice(0,50);
  let html = shown.map(rec=>wdRenderRecord(rec, kind)).join("");
  if(sorted.length>shown.length) html += `<div class="wd-more">Showing the ${shown.length} most recent of ${sorted.length}. Use Raw JSON to see all, or filter the endpoint.</div>`;
  return html;
}

function wdGuessKind(label, sample){
  const p=(label||"").toLowerCase();
  if(/\/orders/.test(p) && sample && (sample.delivery||sample.production||sample.orderedFor)) return "order";
  if(/\/jobs/.test(p) && sample && sample.number!=null && sample.name!=null && !sample.delivery) return "job";
  return "generic";
}

function wdRenderRecord(rec, kind){
  if(kind==="order"){
    const st=rec.status?.label||rec.status?.id;
    const del=rec.delivery?.status?.label;
    const prod=rec.production?.status?.label;
    const who=[rec.orderedFor?.name?.first, (rec.orderedFor?.name?.last||"").replace(/\s*\(.*\)/,"")].filter(Boolean).join(" ");
    const ship=rec.delivery?.shipping?.label;
    const totalPrice=rec.calculations?.totals?.current?.price?.value;
    const totalWeight=rec.calculations?.totals?.current?.weight?.value;
    // Count line items per fulfillment group so you can see the mix of categories.
    const groups={};
    if(Array.isArray(rec.items)) rec.items.forEach(it=>{ const g=it.order?.fulfillmentGroup?.label||"Other"; groups[g]=(groups[g]||0)+1; });
    const groupSummary=Object.keys(groups).map(g=>`${g} (${groups[g]})`).join(", ");
    return `<div class="wd-rec">
      <div class="wd-rec-head">
        <span class="wd-rec-title">Order ${wdEsc(rec.number||rec.index||"")}</span>
        ${st?wdBadge(st,wdTone(st)):""}
        ${rec.number?`<button class="wd-fetch" data-wdorder="${wdEsc(rec.number)}">View full order →</button>`:""}
      </div>
      <div class="wd-rec-body">
        ${wdRow("Job", rec.job?`${wdEsc(rec.job.number||"")} · ${wdEsc(rec.job.name||"")}`:"")}
        ${wdRow("Job desc", wdEsc(rec.job?.description))}
        ${wdRow("Ordered by", wdEsc(who))}
        ${wdRow("Measured by", wdEsc(rec.measuredBy))}
        ${wdRow("Ordered", wdDate(rec.ordered))}
        ${wdRow("Requested", wdDate(rec.requested))}
        ${wdRow("Delivery date", wdDate(rec.delivery?.date))}
        ${wdRow("Delivery", del?wdBadge(del,wdTone(del)):"")}
        ${wdRow("Production", prod?wdBadge(prod,wdTone(prod)):"")}
        ${wdRow("Ship to", wdEsc(ship))}
        ${wdRow("PO #", wdEsc(rec.poNumber))}
        ${wdRow("Tag", wdEsc(rec.tag))}
        ${wdRow("Instructions", (rec.specialInstructions&&rec.specialInstructions!=="n/a")?wdEsc(rec.specialInstructions):"")}
        ${wdRow("Total", (typeof totalPrice==="number"&&totalPrice>0)?"$"+totalPrice.toFixed(2):"")}
        ${wdRow("Total weight", (typeof totalWeight==="number"&&totalWeight>0)?totalWeight.toFixed(1)+" lb":"")}
        ${wdRow("Items", rec.numItems!=null?wdEsc(rec.numItems)+(rec.numItems===0?" (list view shows none — tap “View full order”)":""):"")}
        ${wdRow("Categories", wdEsc(groupSummary))}
        ${wdRenderItems(rec.items)}
      </div>
    </div>`;
  }
  if(kind==="job"){
    return `<div class="wd-rec">
      <div class="wd-rec-head">
        <span class="wd-rec-title">${wdEsc(rec.number||"")}</span>
        <span class="wd-rec-badge">${wdEsc(rec.name||"")}</span>
        ${rec.state?wdBadge(rec.state, rec.state==="active"?"green":""):""}
      </div>
      <div class="wd-rec-body">
        ${wdRow("Name", wdEsc(rec.name))}
        ${wdRow("Number", wdEsc(rec.number))}
        ${wdRow("Type", wdEsc(rec.type))}
        ${wdRow("Description", wdEsc(rec.description))}
        ${wdRow("Created", wdDate(rec.dateCreated))}
      </div>
    </div>`;
  }
  // Generic: show top-level scalar fields.
  const title = rec.number||rec.name||rec.label||rec.id||rec.index||"Record";
  const rows = Object.keys(rec).filter(k=>{ const v=rec[k]; return v!=null && typeof v!=="object"; }).slice(0,14)
    .map(k=>wdRow(k, wdEsc(rec[k]))).join("");
  const objCount = Object.keys(rec).filter(k=>rec[k]&&typeof rec[k]==="object").length;
  return `<div class="wd-rec"><div class="wd-rec-head"><span class="wd-rec-title">${wdEsc(title)}</span></div><div class="wd-rec-body">${rows}${objCount?`<div class="wd-more">+ ${objCount} nested field${objCount===1?"":"s"} — see Raw JSON</div>`:""}</div></div>`;
}

// Render an order's line items (ALL categories, full detail). Product info lives in item.order;
// computed material specs live in item.engine.output.
function wdItemPrice(it){
  const p=it.engine?.output?.calculations?.totals?.current?.price?.value ?? it.order?.calculations?.totals?.current?.price?.value;
  return (typeof p==="number"&&p>0)?("$"+p.toFixed(2)):"";
}
function wdItemWeight(it){
  const w=it.engine?.output?.calculations?.totals?.current?.weight?.value;
  return (typeof w==="number"&&w>0)?(w.toFixed(1)+" lb"):"";
}
function wdItemSpecs(it){
  // Pull any human-readable dimension/spec strings from the engine material rows.
  const mats=it.engine?.output?.materials; if(!Array.isArray(mats)) return [];
  const out=[];
  mats.forEach(m=>{ const lbl=m.label||m.name||m.description; if(lbl) out.push(String(lbl)); });
  return out.filter(Boolean);
}
function wdRenderItems(items){
  if(!Array.isArray(items)||!items.length) return "";
  const rows=items.slice(0,200).map((it,i)=>{
    const o=it.order||it;
    const name=o.label||o.name||o.description||"Item";
    const qty=o.quantity;
    const sku=(o.sku && o.sku!=="___")?o.sku:"";
    const grp=o.fulfillmentGroup?.label||"";
    const notes=o.notes;
    const tag=o.tag;
    const shipStat=o.shipping?.status?.label;
    const tone=shipStat?wdTone(shipStat):"";
    const price=wdItemPrice(it), weight=wdItemWeight(it);
    const specs=wdItemSpecs(it);
    const engineType=it.engine?.type||"";
    const chips=[];
    if(grp) chips.push(`<span class="wd-chip">${wdEsc(grp)}</span>`);
    if(sku) chips.push(`<span class="wd-chip">SKU ${wdEsc(sku)}</span>`);
    if(tag) chips.push(`<span class="wd-chip">Tag ${wdEsc(tag)}</span>`);
    if(price) chips.push(`<span class="wd-chip">${wdEsc(price)}</span>`);
    if(weight) chips.push(`<span class="wd-chip">${wdEsc(weight)}</span>`);
    if(engineType) chips.push(`<span class="wd-chip">${wdEsc(engineType)}</span>`);
    if(shipStat) chips.push(`<span class="wd-chip ${tone}">${wdEsc(shipStat)}</span>`);
    return `<div class="wd-item">
      <div class="wd-item-main">
        <span class="wd-item-num">${i+1}.</span>
        <span class="wd-item-desc">${wdEsc(name)}</span>
        ${qty!=null?`<span class="wd-item-qty">×${wdEsc(qty)}</span>`:""}
      </div>
      ${notes?`<div class="wd-item-notes">${wdEsc(notes)}</div>`:""}
      ${specs.length?`<div class="wd-item-specs">${specs.map(s=>wdEsc(s)).join(" · ")}</div>`:""}
      <div class="wd-item-meta">${chips.join("")}</div>
    </div>`;
  }).join("");
  return `<div class="wd-items-h">Line items (${items.length})</div><div class="wd-items">${rows}</div>`;
}

// Tap "View full order" → fill the path with the single-order endpoint and fire it.
document.addEventListener("click",async e=>{
  const b=e.target.closest("[data-wdorder]"); if(!b)return;
  const num=b.dataset.wdorder;
  $("wd_method").value="GET"; $("wd_path").value="/orders/"+num; $("wd_params").innerHTML=""; $("wd_bodyWrap").style.display="none";
  const url=wdBase()+"/orders/"+encodeURIComponent(num);
  b.disabled=true; b.textContent="Loading…";
  const r=await wdFetch("GET",url,{headers:{"Accept":"application/json", ...wdAuthHeaders()}});
  wdShowResult("GET /orders/"+num, r);
  $("view-webduct").querySelector("#wd_resultCard").scrollIntoView({behavior:"smooth",block:"start"});
});

function wdLog(path,kind,status){
  const box=$("wd_log"); if(box.querySelector(".sub-empty"))box.innerHTML="";
  const time=new Date().toLocaleTimeString();
  const badge = kind==="ok"?"ok":"bad";
  const label = kind==="ERR"?"BLOCK":status;
  const el=document.createElement("div"); el.className="wd-log-item";
  el.innerHTML=`<span class="wd-log-badge ${badge}">${esc(String(label))}</span><span class="wd-log-path">${esc(path)}</span><span class="wd-log-time">${esc(time)}</span>`;
  box.prepend(el);
}
onActivate($("wd_clearLog"),()=>{ $("wd_log").innerHTML='<div class="sub-empty">No requests yet.</div>'; });
onActivate($("wd_copyOut"),async()=>{ try{ await navigator.clipboard.writeText($("wd_out").textContent); toast("Copied"); }catch(_){ toast("Copy failed"); } });

// --- Login (OAuth password grant) ---
onActivate($("wd_login"),async()=>{
  const base=wdBase(), u=$("wd_user").value.trim(), p=$("wd_pass").value;
  if(!u||!p){ toast("Enter username and password"); return; }
  const btn=$("wd_login"); btn.disabled=true; btn.textContent="Signing in…";
  $("wd_tokenHint").textContent="Calling POST /oauth/authorize/password …";
  // We don't know the exact body shape, so send the common OAuth password-grant form.
  const url=base+"/oauth/authorize/password";
  const form=new URLSearchParams({username:u,password:p});
  const r=await wdFetch("POST",url,{headers:{"Content-Type":"application/x-www-form-urlencoded","Accept":"application/json"},body:form.toString()});
  // Try to auto-extract a token from whatever came back.
  let tok="";
  if(r.json){ const d=r.json.data||{}; tok=d.accessToken||d.access_token||d.token||r.json.accessToken||r.json.access_token||r.json.token||r.json.bearer||""; }
  if(tok){ WD_TEST_TOKEN=tok; sessionStorage.setItem("wd_test_token",tok); wdRenderToken(); $("wd_tokenHint").innerHTML="Token captured — the tester will now use it (overrides the company login)."; }
  else if(!r.threw && r.ok){ $("wd_tokenHint").innerHTML="Server responded OK but no token field was auto-found — check the Response below and paste the token manually if needed."; }
  else { $("wd_tokenHint").textContent=""; }
  wdShowResult("POST /oauth/authorize/password", r, {isLogin:true});
  btn.disabled=false; btn.textContent="Sign in & use that token";
});

// --- Fire an arbitrary endpoint ---
onActivate($("wd_send"),async()=>{
  const base=wdBase(), method=$("wd_method").value; let path=wdResolvePath();
  if(!path){ toast("Enter a path like /jobs"); return; }
  if(/\{[^}]+\}/.test(path)){ toast("Fill in the highlighted value first"); const f=$("wd_params").querySelector("[data-wdparam]"); if(f)f.focus(); return; }
  // For /orders, apply the SAME user-set delivery-date window the calendar sync uses.
  if(path==="/orders"){ path="/orders"+wdWindow().qs; }
  const url=base+path;
  const btn=$("wd_send"); btn.disabled=true; btn.textContent="Sending…";
  // Manual pasted token wins (test as that user). Otherwise mint the shared company token fresh.
  let tok=WD_TEST_TOKEN;
  if(!tok && wdHasAdmin()){ tok=await wdMintAdminToken(true); }
  if(!tok){ btn.disabled=false; btn.textContent="Send request"; $("wd_tokenHint").innerHTML="<span style='color:#c0341a'>No token. Paste one above, or connect the company login in the Connection box.</span>"; toast("No token to send with"); return; }
  const headers={"Accept":"application/json", "Bearer":tok};
  let body=null;
  if(/POST|PUT/.test(method)){ const raw=$("wd_body").value.trim(); if(raw){ try{ JSON.parse(raw); }catch(e){ btn.disabled=false; btn.textContent="Send request"; toast("Body isn't valid JSON"); return; } headers["Content-Type"]="application/json"; body=raw; } }
  const r=await wdFetch(method,url,{headers,body});
  wdShowResult(method+" "+path, r);
  btn.disabled=false; btn.textContent="Send request";
});

/* ============================================================
   FULL SCAN — fire every GET endpoint automatically (read-only).
   Never touches POST/PUT/DELETE. For {id}-style paths, harvest a
   sample id from an earlier list result and substitute it.
   ============================================================ */
let wdScanning=false, WD_SCAN_RESULTS=[];
const WD_SCAN_NOPARAM=[
  "/jobs","/jobs/codes","/jobs/phases","/jobs/phases/codes",
  "/orders","/orders/adjustments","/orders/attachments","/orders/fulfillment/groups","/orders/fulfillment/statuses","/orders/shipping/statuses",
  "/catalogs","/environments","/integrations/exports","/integrations/exports/orders","/integrations/mappings",
  "/materials","/materials/factors/costweight","/materials/factors/costweight/categories",
  "/organizations","/products/lookups","/products/scripts",
  "/reimbursements","/reimbursements/codes","/reimbursements/codes/jobs","/reimbursements/statuses",
  "/roles","/seats/types","/seats/users","/users","/users/groups",
  "/spools/packages","/spools/settings","/spools/statuses","/timecards","/timecards/statuses"
];
const WD_SCAN_BYID=[
  {list:"/jobs", idFields:["index","id"], make:id=>"/jobs/"+id},
  {list:"/jobs/codes", idFields:["id","index"], make:id=>"/jobs/codes/"+id},
  {list:"/jobs/phases", idFields:["id","index"], make:id=>"/jobs/phases/"+id},
  {list:"/catalogs", idFields:["id","index"], make:id=>"/catalogs/"+id},
  {list:"/environments", idFields:["id","index"], make:id=>"/environments/"+id},
  {list:"/materials", idFields:["id","index"], make:id=>"/materials/"+id},
  {list:"/organizations", idFields:["index","id"], make:id=>"/organizations/"+id},
  {list:"/products/lookups", idFields:["id","product_id","index"], make:id=>"/products/lookups/"+id},
  {list:"/reimbursements", idFields:["id","index"], make:id=>"/reimbursements/"+id},
  {list:"/reimbursements/codes", idFields:["id","index"], make:id=>"/reimbursements/codes/"+id},
  {list:"/seats/types", idFields:["id","index"], make:id=>"/seats/types/"+id},
  {list:"/users", idFields:["id","index"], make:id=>"/users/"+id},
  {list:"/users/groups", idFields:["id","index"], make:id=>"/users/groups/"+id},
  {list:"/timecards", idFields:["id","index"], make:id=>"/timecards/"+id},
  {list:"/orders", idFields:["number"], make:id=>"/orders/"+id},
  {list:"/orders", idFields:["id","index"], make:id=>"/orders/exports/"+id}
];
function wdScanStatus(msg,cls){ const el=$("wd_scanMsg"); if(el){ el.textContent=msg; el.className="wd-sync-msg"+(cls?" "+cls:""); } }
function wdFirstId(listResult, idFields){
  const arr = listResult && listResult.json && Array.isArray(listResult.json.data) ? listResult.json.data : null;
  if(!arr||!arr.length) return null;
  for(const rec of arr){ for(const f of idFields){ if(rec[f]!=null && rec[f]!=="") return rec[f]; } }
  return null;
}
function wdClassify(path, r){
  if(r.threw) return {ok:false, tag:"blocked", note:"No response"};
  if(r.binary) return {ok:true, tag:"file", note:(r.blobSize/1024).toFixed(0)+" KB "+(/pdf/i.test(r.ct)?"PDF":"file")};
  if(!r.ok) return {ok:false, tag:"err", note:r.status+" "+(r.statusText||"")};
  const arr = r.json && Array.isArray(r.json.data) ? r.json.data : (Array.isArray(r.json)?r.json:null);
  const cnt = arr?arr.length:(r.json&&r.json.data?1:0);
  const toolish=/spool|tool|rental|package|timecard/i.test(path);
  return {ok:true, tag: toolish&&cnt>0?"tool":"data", note: arr?(arr.length+" records"):(r.json&&r.json.data?"1 object":"empty")};
}
onActivate($("wd_scan"),async()=>{
  if(wdScanning) return;
  if(!WD_TOKEN){ toast("Sign in first (top of tester)"); return; }
  wdScanning=true; WD_SCAN_RESULTS=[]; $("wd_scanResults").style.display="block"; $("wd_scanSummary").innerHTML=""; $("wd_scanDetail").innerHTML="";
  const btn=$("wd_scan"); btn.disabled=true; btn.textContent="Scanning…";
  const H=()=>({"Accept":"application/json", ...wdAuthHeaders()});
  const listCache={};
  const total=WD_SCAN_NOPARAM.length+WD_SCAN_BYID.length; let done=0;
  // Cap huge list payloads so 50 endpoints don't exhaust mobile memory.
  const trim=(r)=>{ try{ if(r&&r.json&&Array.isArray(r.json.data)&&r.json.data.length>300){ const full=r.json.data.length; r=Object.assign({},r,{json:Object.assign({},r.json,{data:r.json.data.slice(0,300)}), _trimmed:full, text:""}); } else if(r&&r.text&&r.text.length>200000){ r=Object.assign({},r,{text:r.text.slice(0,200000)}); } }catch(_){} return r; };
  for(const p of WD_SCAN_NOPARAM){
    done++; wdScanStatus(`Scanning ${done}/${total} — GET ${p}`);
    let r=await wdFetch("GET", WD_BASE+p, {headers:H()});
    listCache[p]=r; r=trim(r); WD_SCAN_RESULTS.push({path:"GET "+p, r, cls:wdClassify(p,r)});
    wdRenderScan();
  }
  for(const spec of WD_SCAN_BYID){
    done++;
    const src=listCache[spec.list]||await wdFetch("GET",WD_BASE+spec.list,{headers:H()});
    const id=wdFirstId(src, spec.idFields);
    if(id==null){ WD_SCAN_RESULTS.push({path:"GET "+spec.make("{id}"), r:{threw:false,ok:false,status:0,statusText:"skipped — no sample id"}, cls:{ok:false,tag:"skip",note:"no id to try"}}); wdScanStatus(`Scanning ${done}/${total} — skipped ${spec.make("{id}")}`); wdRenderScan(); continue; }
    const path=spec.make(encodeURIComponent(id));
    wdScanStatus(`Scanning ${done}/${total} — GET ${path}`);
    let r=await wdFetch("GET", WD_BASE+path, {headers:H()}); r=trim(r);
    WD_SCAN_RESULTS.push({path:"GET "+path, r, cls:wdClassify(path,r)});
    wdRenderScan();
  }
  wdScanStatus(`Scan complete — ${WD_SCAN_RESULTS.length} endpoints. Files & tool-data are pinned at the top.`, "ok");
  wdRenderScan(true);
  btn.disabled=false; btn.textContent="Run full scan"; wdScanning=false;
});
function wdScanRaw(r){
  if(r.threw) return "// Blocked — no response";
  if(r.binary) return `// Binary file (${(r.blobSize/1024).toFixed(1)} KB, ${r.ct}) — use the download button in Readable`;
  if(r.status===0) return "// "+(r.statusText||"skipped");
  return r.json ? JSON.stringify(r.json,null,2) : (r.text||"(empty response body)");
}
function wdRenderScan(final){
  const rank=r=>({file:0,tool:1,data:2,err:3,blocked:3,skip:4}[r.cls.tag]??5);
  const sorted=WD_SCAN_RESULTS.slice().sort((a,b)=>rank(a)-rank(b));
  const badge=c=>{ const map={file:"green",tool:"green",data:"",err:"amber",blocked:"amber",skip:""}; const lbl={file:"FILE",tool:"TOOL DATA",data:"OK",err:"ERR",blocked:"BLOCKED",skip:"SKIP"}; return `<span class="wd-chip ${map[c.tag]||""}">${lbl[c.tag]||c.tag}</span>`; };
  $("wd_scanSummary").innerHTML=`<div class="wd-scan-sumhead">Summary (${WD_SCAN_RESULTS.length})${final?" — tap a row to jump":" — scanning…"}</div>`+sorted.map(x=>`<div class="wd-scan-sumrow" data-scanjump="${WD_SCAN_RESULTS.indexOf(x)}">${badge(x.cls)}<span class="wd-scan-path">${wdEsc(x.path)}</span><span class="wd-scan-note">${wdEsc(x.cls.note||"")}</span></div>`).join("");
  if(!final){ return; }
  // Render ONLY the collapsed headers (tiny). Each body is built lazily on first expand,
  // so we never construct megabytes of HTML in one write (that's what crashed Safari).
  $("wd_scanDetail").innerHTML=`<div class="wd-scan-dethead">Details — tap any endpoint to expand</div>`+WD_SCAN_RESULTS.map((x,i)=>
    `<div class="wd-scan-block" id="wd-scan-${i}">
      <div class="wd-scan-blockhead" data-scantoggle="${i}"><span class="wd-scan-chev" id="wd-scan-chev-${i}">▸</span>${badge(x.cls)} <span class="wd-scan-hpath">${wdEsc(x.path)}</span><span class="wd-scan-hnote">${wdEsc(x.cls.note||"")}</span></div>
      <div class="wd-scan-bodywrap" id="wd-scan-body-${i}" style="display:none" data-built="0"></div>
    </div>`).join("");
}
// Build one endpoint's body HTML only when needed.
function wdScanBuildBody(i){
  const x=WD_SCAN_RESULTS[i]; if(!x) return "";
  if(x.r.status===0) return `<div class="dd-empty">${wdEsc(x.r.statusText||"skipped")}</div>`;
  let readable;
  try{ readable=wdReadable(x.r, x.path); }catch(err){ readable=`<div class="dd-empty">Couldn't format this one — use Raw JSON below.</div>`; }
  let raw=wdScanRaw(x.r); if(raw.length>60000) raw=raw.slice(0,60000)+"\n… (truncated — full data still copies)";
  return `<div class="wd-viewtabs"><button class="wd-vtab active" data-scantab="rd" data-si="${i}">Readable</button><button class="wd-vtab" data-scantab="raw" data-si="${i}">Raw JSON</button></div>
    <div class="wd-scan-rd" id="wd-scan-rd-${i}">${readable}</div>
    <div class="wd-scan-raw" id="wd-scan-raw-${i}" style="display:none"><div class="wd-out-head"><span>Raw</span><button class="wd-mini" data-scancopy="${i}">Copy</button></div><pre class="wd-out">${wdEsc(raw)}</pre></div>`;
}
document.addEventListener("click",e=>{
  const j=e.target.closest("[data-scanjump]"); if(j){ const i=j.dataset.scanjump; wdScanExpand(i,true); const el=$("wd-scan-"+i); if(el)el.scrollIntoView({behavior:"smooth",block:"start"}); return; }
  const tg=e.target.closest("[data-scantoggle]"); if(tg){ wdScanToggle(tg.dataset.scantoggle); return; }
  const tab=e.target.closest("[data-scantab]"); if(tab){ const i=tab.dataset.si, rd=tab.dataset.scantab==="rd"; $("wd-scan-rd-"+i).style.display=rd?"block":"none"; $("wd-scan-raw-"+i).style.display=rd?"none":"block"; tab.parentElement.querySelectorAll(".wd-vtab").forEach(b=>b.classList.toggle("active",b===tab)); return; }
  const cp=e.target.closest("[data-scancopy]"); if(cp){ const i=+cp.dataset.scancopy; navigator.clipboard.writeText(wdScanRaw(WD_SCAN_RESULTS[i].r)).then(()=>toast("Copied")).catch(()=>toast("Copy failed")); return; }
  if(e.target.closest("#wd_scanClear")){ WD_SCAN_RESULTS=[]; $("wd_scanResults").style.display="none"; $("wd_scanSummary").innerHTML=""; $("wd_scanDetail").innerHTML=""; wdScanStatus(""); return; }
});
function wdScanEnsureBody(i){ const b=$("wd-scan-body-"+i); if(b && b.dataset.built==="0"){ b.innerHTML=wdScanBuildBody(i); b.dataset.built="1"; } }
function wdScanToggle(i){ const b=$("wd-scan-body-"+i),c=$("wd-scan-chev-"+i); if(!b)return; const open=b.style.display==="none"; if(open) wdScanEnsureBody(i); b.style.display=open?"block":"none"; if(c)c.textContent=open?"▾":"▸"; }
function wdScanExpand(i,open){ const b=$("wd-scan-body-"+i),c=$("wd-scan-chev-"+i); if(!b)return; if(open) wdScanEnsureBody(i); b.style.display=open?"block":"none"; if(c)c.textContent=open?"▾":"▸"; }

/* ============================================================
   WEBDUCT AUTO-SYNC — shop-equipment orders → Deliveries
   Runs on sign-in (when a token exists). Pulls orders, keeps
   only "Equipment stored at the shop" line items, matches each
   to an arrival by job#, and writes results to Firestore so the
   whole shop sees them without their own Webduct pull.
   ============================================================ */
const WD_EQUIP_PREFIX="wd_product_job_equipment";   // product id prefix that means "equipment stored at the shop"
let wdSyncing=false;

// Normalize text for matching (lowercase, strip punctuation, collapse spaces).
function wdNorm(s){ return String(s||"").toLowerCase().replace(/[^a-z0-9 ]+/g," ").replace(/\s+/g," ").trim(); }
// Token overlap score 0..1 between two strings.
function wdSimilarity(a,b){
  const A=wdNorm(a).split(" ").filter(w=>w.length>2), B=new Set(wdNorm(b).split(" ").filter(w=>w.length>2));
  if(!A.length||!B.size)return 0; let hit=0; A.forEach(w=>{if(B.has(w))hit++;}); return hit/Math.max(A.length,B.size);
}

// Given an equipment item + its job#, find the best arrival match on the SAME job.
function wdMatchArrival(job, itemText){
  const cands=ARRIVALS.filter(a=>normJob(a.jobNumber)===normJob(job));
  if(!cands.length) return {arrivalId:"", state:"none", score:0};
  let best=null, bestScore=0;
  for(const a of cands){ const s=wdSimilarity(itemText, a.description||""); if(s>bestScore){ bestScore=s; best=a; } }
  if(best && wdNorm(itemText)===wdNorm(best.description)) return {arrivalId:best.id, state:"exact", score:1};
  if(best && bestScore>=0.5) return {arrivalId:best.id, state:"exact", score:bestScore};      // strong → auto-link
  if(best && bestScore>=0.2) return {arrivalId:best.id, state:"guess", score:bestScore};       // weak → needs confirm
  return {arrivalId:"", state:"none", score:0};
}

// Fire the whole sync. Runs on sign-in / page load and from the Refresh buttons.
async function wdAutoSync(opts={}){
  // A manual refresh can break a stuck lock from a prior run; auto-syncs still yield if one's active.
  if(wdSyncing){ if(!opts.manual) return; wdSyncing=false; }
  // FRESHNESS GATE: if anyone on the team synced within the last 10 minutes, auto-syncs skip —
  // the calendar already shows that data instantly from Firebase. Manual Refresh always runs.
  if(!opts.manual && WD_ORDERS.length){
    const newest=WD_ORDERS.reduce((m,o)=>Math.max(m,o.syncedAt||0),0);
    if(newest && (Date.now()-newest)<10*60*1000){ wdSyncStatus("Orders up to date — synced "+Math.max(1,Math.round((Date.now()-newest)/60000))+" min ago", false, true); return; }
  }
  // Mint a FRESH token right now (from stored company creds), so we never use a stale saved token.
  wdSyncStatus("Signing in to Webduct…");
  let tok="";
  if(wdHasAdmin()){ tok=await wdMintAdminToken(true); if(!tok){ wdSyncStatus("Webduct login failed — check the company login in Admin", true); if(opts.manual)toast("Webduct login failed — re-check Admin"); return; } }
  else { tok=WD_TOKEN; }   // personal fallback (Deliveries)
  if(!tok){ if(opts.manual)toast("Connect Webduct in Admin first"); wdSyncStatus("No Webduct connection — set it up in Admin", true); return; }
  wdSyncing=true; wdSyncStatus("Pulling orders…");
  const watchdog=setTimeout(()=>{ if(wdSyncing){ wdSyncing=false; wdSyncStatus("Sync timed out — tap Refresh to try again", true); } }, 180000);
  try{
    const H={"Accept":"application/json", "Bearer":tok};
    async function tryList(qs){ const r=await wdFetch("GET",WD_BASE+"/orders"+qs,{headers:H}); const arr=(r.json&&Array.isArray(r.json.data))?r.json.data:null; return {r,arr,qs}; }
    // Ask Webduct for ONLY the orders whose DELIVERY date falls in the user-set window.
    // This turns "1821 orders" into a small set — one fast request instead of hundreds.
    const win=wdWindow();
    let best=await tryList(win.qs);
    // Fallbacks if the delivery-date filter isn't accepted: try production date, then plain.
    if(best.r.threw || !best.r.ok || !best.arr){
      const prodQS=`?dateType=production&dateStart=${encodeURIComponent(win.isoStart)}&dateEnd=${encodeURIComponent(win.isoEnd)}`;
      let t=await tryList(prodQS);
      if(t.arr) best=t; else { t=await tryList(""); if(t.arr) best=t; }
    }
    if(best.r.threw){ clearTimeout(watchdog); wdSyncStatus(best.r.timedOut?"Webduct didn't respond in time — tap Refresh":"Couldn't reach Webduct (network/CORS)", true); wdSyncing=false; return; }
    if(!best.r.ok){ clearTimeout(watchdog); wdSyncStatus("Webduct rejected the request ("+(best.r.status||"?")+") — check the company login", true); wdSyncing=false; return; }
    let orders=(best.arr||[]).slice();
    const listPeople=new Set(orders.map(o=>{ const nm=(o.orderedBy?.name||o.orderedFor?.name||{}); return (o.orderedBy?.email||o.orderedFor?.email||((nm.first||"")+" "+(nm.last||""))).toLowerCase(); }).filter(Boolean));
    // Client-side safety net: keep the chosen look-back window, newest first.
    const cutoff=win.cutoff;
    const orderDate=o=>{ const d=new Date(o.delivery?.date||o.requested||o.ordered||0).getTime(); return isNaN(d)?0:d; };
    orders=orders.filter(o=>orderDate(o)>=cutoff);
    orders.sort((a,b)=> orderDate(b)-orderDate(a));
    // INCREMENTAL: skip any order we already hold whose dateModified hasn't changed —
    // no detail fetch, no writes. This is what makes day-to-day refreshes near-instant.
    const held=new Map(WD_ORDERS.map(o=>[o.docId,o]));
    const seenOrderDocs=new Set(); const todo=[]; let skipped=0;
    for(const o of orders){
      if(!o.number) continue;
      const oDocId="wo-"+wdSlug(o.number);
      seenOrderDocs.add(oDocId);
      const ex=held.get(oDocId);
      if(ex && ex.dateModified && o.dateModified && ex.dateModified===o.dateModified && !ex.detailUnavailable && ex.schema===WD_ORDER_SCHEMA){ skipped++; continue; }
      todo.push({o,oDocId});
    }
    const run=todo.slice(0,150);
    const capNote=todo.length>run.length?` (+${todo.length-run.length} more next refresh)`:"";
    let equipCount=0, detailFail=0; const failCodes={};
    function wdOrderBaseFields(src, withItems){
      const ob=src.orderedBy?.name||src.orderedFor?.name||{};
      const orderedByName=[ob.first, (ob.last||"").replace(/\s*\(?\d[\d\s().-]{6,}\)?/g,"").trim()].filter(Boolean).join(" ");
      const orderedByEmail=(src.orderedBy?.email||src.orderedFor?.email||"").toLowerCase();
      const items=withItems&&Array.isArray(src.items)?src.items:[];
      let hasEquip=false;
      const liteItems=items.map(it=>{
        const io=it.order||{}; const pid=io.id||"";
        const isEquip=pid.startsWith(WD_EQUIP_PREFIX); if(isEquip)hasEquip=true;
        const iwt=(io.weight?.value ?? io.weight ?? it.weight?.value ?? it.weight ?? io.calculations?.weight?.value);
        return { label:io.label||"", notes:io.notes||"", quantity:io.quantity!=null?io.quantity:null,
          sku:(io.sku&&io.sku!=="___")?io.sku:"", type:io.type||"", productId:pid,
          weight:(typeof iwt==="number"?iwt:null),
          group:io.fulfillmentGroup?.label||"Other", groupCode:io.fulfillmentGroup?.code||"",
          shipStatus:io.shipping?.status?.label||"", isEquip, dims:wdFittingDims(it), build:wdFittingBuild(it) };
      });
      return {
        number:String(src.number), job:src.job?.number||"", jobName:src.job?.name||"", jobDesc:src.job?.description||"",
        orderedBy:orderedByName, orderedByEmail, dateModified:src.dateModified||"",
        orderedDate:src.ordered||"", requestedDate:src.requested||"", deliveryDate:src.delivery?.date||"",
        shipLabel:src.delivery?.shipping?.label||"", shipStatus:src.delivery?.status?.label||"",
        shipRaw:JSON.stringify({label:src.delivery?.shipping?.label||"", value:src.delivery?.shipping?.value||"", option:src.delivery?.option||"", method:src.delivery?.method||""}),
        shipType:wdDetectShipType(src),
        prodStatus:src.production?.status?.label||"", orderStatus:src.status?.label||"",
        po:src.poNumber||"", tag:src.tag||"", instructions:(src.specialInstructions&&src.specialInstructions!=="n/a")?src.specialInstructions:"",
        totalPrice:src.calculations?.totals?.current?.price?.value ?? null,
        totalWeight:src.calculations?.totals?.current?.weight?.value ?? null,
        hasEquip, items:liteItems, itemCount:liteItems.length, detailUnavailable:!withItems,
        schema:WD_ORDER_SCHEMA,
        syncedAt:Date.now()
      };
    }
    // PHASE 1 — batch-write header baselines for everything new/changed. One network round trip
    // per 400 docs, so every calendar dot appears almost immediately.
    if(fbReady && run.length){
      wdSyncStatus(`Saving ${run.length} order headers…`);
      for(let i=0;i<run.length;i+=400){
        const b=writeBatch(db);
        run.slice(i,i+400).forEach(({o,oDocId})=>{ b.set(doc(db,"webductOrders",oDocId), wdOrderBaseFields(o,false), {merge:true}); });
        try{ await b.commit(); }catch(e){ console.error("batch",e); }
      }
    }
    // PHASE 2 — pull full line-item detail, 6 orders at a time in parallel (was one-by-one).
    for(let i=0;i<run.length;i+=6){
      const chunk=run.slice(i,i+6);
      wdSyncStatus(`Reading orders ${Math.min(i+chunk.length,run.length)}/${run.length}…`);
      await Promise.all(chunk.map(async({o,oDocId})=>{
        const num=o.number;
        const detR=await wdFetch("GET",WD_BASE+"/orders/"+encodeURIComponent(num),{headers:H});
        if(detR.threw||!detR.ok||!detR.json){ detailFail++; const code=detR.status||"blocked"; failCodes[code]=(failCodes[code]||0)+1; return; }
        const ord=detR.json.data||{};
        await wdWriteOrder(oDocId, wdOrderBaseFields(ord,true));
        const items=Array.isArray(ord.items)?ord.items:[];
        const ob=ord.orderedBy?.name||ord.orderedFor?.name||{};
        const orderedByName=[ob.first, (ob.last||"").replace(/\s*\(?\d[\d\s().-]{6,}\)?/g,"").trim()].filter(Boolean).join(" ");
        for(const it of items){
          const io=it.order||{}; const pid=io.id||""; if(!pid.startsWith(WD_EQUIP_PREFIX)) continue;
          equipCount++;
          const job=ord.job?.number||"";
          const m=wdMatchArrival(job, io.notes||"");
          const docId="we-"+wdSlug(num)+"-"+wdSlug(io.ddoIndex||io.id||equipCount);
          await wdWriteEquip(docId, {
            orderNumber:String(num), job, jobName:ord.job?.name||"",
            label:io.label||"", notes:io.notes||"", quantity:io.quantity!=null?io.quantity:null,
            orderedBy:orderedByName,
            orderedDate:ord.ordered||"", requestedDate:ord.requested||"", deliveryDate:ord.delivery?.date||"",
            shipStatus:io.shipping?.status?.label||ord.delivery?.status?.label||"", orderStatus:ord.status?.label||"",
            arrivalId:m.arrivalId, matchState:m.state, matchScore:Math.round(m.score*100)/100,
            syncedAt:Date.now(), syncedBy:(USER?USER.first+" "+USER.last:"")
          });
        }
      }));
    }
    await wdPruneOrders(seenOrderDocs, cutoff);
    // Auto-add jobs to My Jobs when the current user placed the order (mirrors ordered-by),
    // respecting jobs they've deliberately removed.
    if(USER && USER.email){
      const myEmail=USER.email.toLowerCase(); let added=false;
      const myJobs=new Set();
      orders.forEach(o=>{ const em=(o.orderedBy?.email||o.orderedFor?.email||"").toLowerCase(); const jb=o.job?.number||""; if(em===myEmail && jb) myJobs.add(jb); });
      myJobs.forEach(jb=>{ const j=normJob(jb); if(isRealJob(j) && !MY_JOBS.includes(j) && !REMOVED_JOBS.has(j)){ MY_JOBS.push(j); markSeenForJob(j); added=true; } });
      if(added){ syncUserJobs(); renderJobs(); }
    }
    clearTimeout(watchdog);
    const codeStr=Object.keys(failCodes).length?(" · detail blocked: "+Object.entries(failCodes).map(([c,n])=>c+"×"+n).join(", ")):"";
    const summary=`Synced ${run.length} new/changed of ${orders.length} orders · ${listPeople.size} people · ${skipped} unchanged skipped${capNote}${codeStr} · ${equipCount} equipment items`;
    wdSyncStatus(summary, false, true);
    // Record who forced this refresh + when, shared with everyone (the person's app login — NOT the
    // company API account we used to pull).
    if(fbReady){ try{ await setDoc(doc(db,"config","lastSync"),{ by:(USER?(USER.first+" "+USER.last):"someone"), at:Date.now(), summary }, {merge:true}); }catch(_){} }
    if(opts.manual) toast(`Synced ${run.length} orders · ${listPeople.size} people`);
  }catch(e){ console.error("wdAutoSync",e); clearTimeout(watchdog); wdSyncStatus("Sync error: "+(e&&e.message?e.message:"see console"), true); }
  wdSyncing=false;
}
// Extract fitting dimensions as a readable string (e.g. "W 12 × H 8 × L 48").
function wdFittingDims(it){
  const eng=it.engine||{}; const inp=eng.inputs?.user||{};
  // HVAC fittings expose an explicit dimensions array.
  const dims=inp.dimensions;
  if(Array.isArray(dims)&&dims.length){
    return dims.map(d=>{ const lbl=d.label||d.id||d.key||""; const v=d.value; return (lbl&&v!=null&&v!=="")?`${lbl} ${v}`:""; }).filter(Boolean).join(" × ");
  }
  // Otherwise scan the user inputs for size-like fields (diameter, length, size, gauge) — covers
  // spiral pipe / round duct and similar stock products that don't use the dimensions array.
  const parts=[];
  Object.keys(inp).forEach(k=>{
    if(k==="dimensions") return;
    const val=inp[k];
    const v=(val&&typeof val==="object")?(val.value ?? val.label ?? "") : val;
    if(v==null||v==="") return;
    if(/diam|dia\b|length|len\b|size|width|height|depth|gauge|ga\b|round|spiral/i.test(k)){
      const lbl=k.replace(/([A-Z])/g," $1").replace(/_/g," ").trim();
      parts.push(`${lbl.charAt(0).toUpperCase()+lbl.slice(1)} ${v}`);
    }
  });
  return parts.join(" × ");
}
// Build a short "what to tell the laser/CAD" string from a fitting item.
function wdFittingBuild(it){
  if(it.engine?.type!=="hvac.fitting") return "";
  const io=it.order||{}; const name=io.label||"Fitting"; const dims=wdFittingDims(it);
  const gauge=it.engine?.output?.materials?.[0]?.label||"";
  const parts=[name]; if(dims)parts.push(dims); if(gauge)parts.push(gauge);
  return parts.join(" · ");
}
async function wdWriteOrder(docId, data){ if(!fbReady)return; try{ await setDoc(doc(db,"webductOrders",docId), data, {merge:true}); }catch(e){ console.error("wdWriteOrder",e); } }
async function wdPruneOrders(keepSet, cutoff){
  if(!fbReady) return;
  // Delete any stored order not seen this sync AND older than cutoff (keeps writes minimal).
  for(const o of WD_ORDERS){
    if(keepSet.has(o.docId)) continue;
    const d=new Date(o.requestedDate||o.deliveryDate||o.orderedDate||0).getTime();
    if(isNaN(d) || d<cutoff){ try{ await deleteDoc(doc(db,"webductOrders",o.docId)); }catch(_){} }
  }
}
function wdSlug(x){ return String(x).replace(/[^A-Za-z0-9]+/g,"").slice(0,40); }

// Write one equipment link doc, preserving any human decision already made.
async function wdWriteEquip(docId, data){
  if(!fbReady) return;
  try{
    const existing=WD_EQUIP.find(e=>e.docId===docId);
    if(existing && existing.userSet){
      // A person has confirmed/rejected/linked this — keep their match decision, don't re-guess.
      data.matchState=existing.matchState;
      data.arrivalId=existing.arrivalId||"";
      data.userSet=true;
    }
    // Dismissed / delivered flags are per-person actions and must survive a re-sync.
    if(existing && existing.dismissed) data.dismissed=true;
    if(existing && existing.deliveredMark) data.deliveredMark=true;
    await setDoc(doc(db,"webductEquip",docId), data, {merge:true});
  }catch(e){ console.error("wdWriteEquip",e); }
}

function wdSyncStatus(msg, isErr, ok){
  const cls="wd-sync-msg"+(isErr?" err":ok?" ok":"");
  const el=$("wdSyncMsg"); if(el){ el.textContent=msg; el.className=cls; }
  const el2=$("calSyncMsg"); if(el2){ el2.textContent=msg; el2.className=cls; }
}

// Confirm / reject a guessed match, or manually detach.
async function wdSetMatch(docId, state, arrivalId, partial){
  if(!fbReady) return;
  const patch={matchState:state, userSet:true}; if(arrivalId!==undefined) patch.arrivalId=arrivalId;
  if(partial!==undefined) patch.partial=!!partial;
  if(state==="none") patch.partial=false;   // clearing a link clears partial too
  try{ await setDoc(doc(db,"webductEquip",docId), patch, {merge:true}); }catch(e){ console.error(e); }
}

/* ---------- Deliveries: Webduct equipment section ---------- */
function wdEquipForArrival(arrivalId){ return WD_EQUIP.filter(e=>e.arrivalId===arrivalId && (e.matchState==="exact"||e.matchState==="confirmed") && !e.dismissed && !e.deliveredMark); }
function wdLinkOptions(e){
  const same=ARRIVALS.filter(a=>normJob(a.jobNumber)===normJob(e.job));
  const rest=ARRIVALS.filter(a=>normJob(a.jobNumber)!==normJob(e.job));
  const opt=a=>`<option value="${wdEsc(a.id)}">${wdEsc((isRealJob(a.jobNumber)?normJob(a.jobNumber)+" · ":"")+(a.description||"No description").slice(0,60))}</option>`;
  return `<option value="">— pick an arrival to link —</option>`+
    (same.length?`<optgroup label="On job ${wdEsc(e.job||"?")}">${same.map(opt).join("")}</optgroup>`:"")+
    (rest.length?`<optgroup label="Other jobs">${rest.slice(0,200).map(opt).join("")}</optgroup>`:"");
}
// Searchable pick list, restricted to the SAME job, suggested (best text match) first.
let WD_PICK_OPEN={};   // { equipDocId: arrivalId } — which arrival is expanded in a picker
function wdArrivalPickList(e, query){
  const q=(query||"").trim().toLowerCase();
  let cands=ARRIVALS.filter(a=>normJob(a.jobNumber)===normJob(e.job));
  if(!cands.length) return `<div class="we-pick-empty">No arrivals logged on job ${wdEsc(e.job||"?")} yet.</div>`;
  if(q) cands=cands.filter(a=>[a.description,a.supplier,a.storageLocation].some(v=>(v||"").toLowerCase().includes(q)));
  if(!cands.length) return `<div class="we-pick-empty">No matches — clear the search to see all arrivals on this job.</div>`;
  const target=(e.notes||e.label||"");
  const recency=a=>{ const d=new Date(a.dateReceived||a.createdAt||0).getTime(); return isNaN(d)?0:d; };
  const scored=cands.map(a=>({a,score:wdSimilarity(target, a.description||"")}));
  const best=Math.max(0,...scored.map(s=>s.score));
  // If nothing matches closely, order by most-recent arrival. If there IS a strong match, rank by score.
  const STRONG=0.35;
  if(best>=STRONG){ scored.sort((x,y)=> (y.score-x.score) || (recency(y.a)-recency(x.a))); }
  else { scored.sort((x,y)=> recency(y.a)-recency(x.a)); }
  cands=scored.map(x=>x.a);
  // Default-open the top (suggested/most-recent) pick so its Pair button is immediately visible.
  let openId=WD_PICK_OPEN[e.docId];
  if(openId===undefined && cands.length){ openId=cands[0].id; }
  openId=openId||"";
  return cands.slice(0,25).map((a,i)=>{
    const arrivedDate=a.dateReceived?wdDate(a.dateReceived):"";
    const isOpen=openId===a.id;
    const hasPhoto=!!a.photoBy;
    const suggested=(i===0 && !q && best>=STRONG && wdSimilarity(target,a.description||"")>=STRONG);
    const isPartial=WD_EQUIP.some(x=>x.arrivalId===a.id && x.partial);
    const head=`<div class="we-pick-headrow">
      <button class="we-pick-head" data-wepickopen="${wdEsc(e.docId)}|||${wdEsc(a.id)}">
        ${suggested?'<span class="we-pick-sug">SUGGESTED</span>':""}
        <span class="we-pick-desc">${wdEsc(a.description||"No description")}</span>
        <span class="we-pick-sub">${arrivedDate?`📅 arrived ${wdEsc(arrivedDate)}`:""}${isPartial?`<span class="we-pick-partial">◑ PARTIAL</span>`:""}${a.storageLocation?`${arrivedDate?" · ":""}📍 ${wdEsc(a.storageLocation)}`:""}</span>
      </button>
      <button class="we-pick-pairmini" data-wepick="${wdEsc(e.docId)}|||${wdEsc(a.id)}" title="Pair this arrival">🔗 Pair</button>
    </div>`;
    const body=isOpen?`<div class="we-pick-body">
      <div class="we-pick-meta">${a.supplier?`Supplier: ${wdEsc(a.supplier)}<br>`:""}${a.po?`PO: ${wdEsc(a.po)}<br>`:""}${arrivedDate?`Received: ${wdEsc(arrivedDate)}`:""}${a.delivered?" · ✓ delivered":""}</div>
      ${hasPhoto?`<img class="we-pick-photo" data-wiaphoto="${wdEsc(a.id)}" alt="arrival photo" loading="lazy">`:`<div class="we-pick-nophoto">No photo on this arrival</div>`}
      <button class="we-pick-pair" data-wepick="${wdEsc(e.docId)}|||${wdEsc(a.id)}">🔗 Pair this arrival</button>
    </div>`:"";
    return `<div class="we-pick ${isOpen?'open':''}">${head}${body}</div>`;
  }).join("");
}

function renderWdEquip(){
  const box=$("wdEquip"); if(!box) return;
  if(!WD_EQUIP.length){ box.innerHTML=""; return; }
  // Hide dismissed + delivered from the main list; sort newest order first.
  const active=WD_EQUIP.filter(e=>e.matchState!=="rejected" && !e.dismissed && !e.deliveredMark)
    .sort((a,b)=>(b.orderedDate||"")<(a.orderedDate||"")?-1:1);
  const guesses=active.filter(e=>e.matchState==="guess");
  const linked=active.filter(e=>e.matchState==="exact"||e.matchState==="confirmed");
  const unmatched=active.filter(e=>e.matchState==="none");
  const arrName=id=>{ const a=ARRIVALS.find(x=>x.id===id); return a?(a.description||"arrival"):"arrival"; };
  // Options for the manual-link dropdown: arrivals on the same job first, then all.
  const linkOptions=wdLinkOptions;
  const card=(e,extra)=>{
    const q=e.quantity!=null?` ×${wdEsc(e.quantity)}`:"";
    const arr=ARRIVALS.find(a=>a.id===e.arrivalId);
    const isDelivered=arr&&arr.delivered;
    const badge = arr ? (isDelivered?`<span class="we-stat green">✓ Delivered${arr.deliveredDate?" "+wdEsc(longDate(arr.deliveredDate).split(",")[0]):""}</span>`:`<span class="we-stat amber">Not delivered</span>`) : "";
    const partBadge = e.partial ? `<button class="we-stat partial ptoggle" data-wepartial="${wdEsc(e.docId)}" title="Tap to mark complete">◑ PARTIAL</button>` : (e.arrivalId?`<button class="we-stat complete ptoggle" data-wepartial="${wdEsc(e.docId)}" title="Tap to mark partial">✓ COMPLETE</button>`:"");
    // Linked → same camera / share / delivery icons as every arrival, all wired together.
    // Unmatched → just a way to clear it from the list.
    const actBtn = arr
      ? `<div class="we-icons">${delivIconsFor(arr)}</div>`
      : `<button class="we-act" data-wedelivered="${wdEsc(e.docId)}">Got it (remove)</button>`;
    return `<div class="we-row" data-werow="${wdEsc(e.docId)}">
      <div class="we-top"><span class="we-job">${wdEsc(e.job||"—")}</span><span class="we-ord">Order ${wdEsc(e.orderNumber)}</span>${badge}${partBadge}</div>
      <div class="we-label">${wdEsc(e.label||"Equipment")}${q}</div>
      ${e.notes?`<div class="we-notes">${wdEsc(e.notes)}</div>`:""}
      ${wdEqNoteFor(e.docId)?`<div class="we-usernote">📝 ${wdEsc(wdEqNoteFor(e.docId))}</div>`:""}
      <div class="we-dates">${e.orderedBy?`By ${wdEsc(String(e.orderedBy).replace(/\s*\(?\d[\d\s().-]{6,}\)?/g,"").trim())}`:""}${e.orderedDate?` · ordered ${wdDate(e.orderedDate)}`:""}${e.requestedDate?` · field wants ${wdDate(e.requestedDate)}`:""}</div>
      ${extra||""}
      <div class="we-actions">${actBtn}<button class="we-act dismiss" data-wedismiss="${wdEsc(e.docId)}">Dismiss</button></div>
    </div>`;
  };
  let html=`<div class="we-head">🏭 Equipment from Webduct <button class="we-refresh" id="wdSyncBtn">${wdConnected()?"Refresh":"Connect Webduct in Admin"}</button></div><div class="wd-sync-msg" id="wdSyncMsg"></div>`;
  if(!active.length){ html+=`<div class="sub-empty" style="margin:0 14px">All caught up — nothing pending.</div>`; box.innerHTML=html; return; }
  if(guesses.length){
    html+=`<div class="we-sec">⚠️ Possible matches — confirm these</div>`;
    html+=guesses.map(e=>card(e, `<div class="we-guess">Looks like arrival: <b>${wdEsc(arrName(e.arrivalId))}</b><div class="we-btns"><button class="we-yes" data-weconfirm="${wdEsc(e.docId)}">✓ Correct match</button><button class="we-no" data-wereject="${wdEsc(e.docId)}">✕ Not a match</button></div></div>`)).join("");
  }
  if(unmatched.length){
    html+=`<div class="we-sec">📦 Wanted — no arrival matched</div>`;
    html+=unmatched.map(e=>card(e, `<div class="we-unmatched"><b>Not paired with an arrival.</b> <button class="we-linkbtn" data-welinkopen="${wdEsc(e.docId)}">Pair with an arrival →</button><div class="we-linkwrap" id="welink-${wdEsc(e.docId)}" style="display:none"><input class="we-linksearch" data-welinksearch="${wdEsc(e.docId)}" type="search" placeholder="Search arrivals on job ${wdEsc(e.job||"")}…" autocomplete="off"><div class="we-linkresults" id="welinkres-${wdEsc(e.docId)}">${wdArrivalPickList(e,"")}</div></div></div>`)).join("");
  }
  if(linked.length){
    html+=`<div class="we-sec">✓ Linked to arrivals</div>`;
    html+=linked.map(e=>card(e, `<div class="we-linked">On arrival: <b>${wdEsc(arrName(e.arrivalId))}</b>${e.matchState==="exact"?"":' <span class="we-confd">confirmed</span>'} <button class="we-detach" data-wedetach="${wdEsc(e.docId)}">Unlink</button></div>`)).join("");
  }
  box.innerHTML=html;
}
document.addEventListener("click",e=>{
  const c=e.target.closest("[data-weconfirm]"); if(c){ wdSetMatch(c.dataset.weconfirm,"confirmed"); return; }
  const r=e.target.closest("[data-wereject]"); if(r){ wdSetMatch(r.dataset.wereject,"none",""); return; }
  const d=e.target.closest("[data-wedetach]"); if(d){ wdSetMatch(d.dataset.wedetach,"none",""); return; }
  const lo=e.target.closest("[data-welinkopen]"); if(lo){ const w=$("welink-"+lo.dataset.welinkopen); if(w){ w.style.display=w.style.display==="none"?"block":"none"; if(w.style.display==="block"){ const s=w.querySelector("[data-welinksearch]"); if(s)setTimeout(()=>s.focus(),100); } } return; }
  const po=e.target.closest("[data-wepickopen]"); if(po){ e.stopPropagation(); const [docId,arrivalId]=po.dataset.wepickopen.split("|||"); WD_PICK_OPEN[docId]=(WD_PICK_OPEN[docId]===arrivalId)?"":arrivalId; const e2=WD_EQUIP.find(x=>x.docId===docId); const res=$("welinkres-"+docId); if(e2&&res){ const sInput=document.querySelector(`[data-welinksearch="${CSS.escape(docId)}"]`); res.innerHTML=wdArrivalPickList(e2, sInput?sInput.value:""); wdLoadArrivalThumbs(); } return; }
  const woj=e.target.closest("[data-wojump]"); if(woj){ e.stopPropagation(); wdJumpToOrder(woj.dataset.wojump); return; }
  const av=e.target.closest("[data-arrview]"); if(av){ setArrView(av.dataset.arrview); return; }
  if(e.target.closest("#arrPrev")){ arrCalMonth--; if(arrCalMonth<0){arrCalMonth=11;arrCalYear--;} arrCalSelDay=null; renderArrCalendar(); return; }
  if(e.target.closest("#arrNext")){ arrCalMonth++; if(arrCalMonth>11){arrCalMonth=0;arrCalYear++;} arrCalSelDay=null; renderArrCalendar(); return; }
  if(e.target.closest("#arrToday")){ const n=new Date(); arrCalYear=n.getFullYear(); arrCalMonth=n.getMonth(); arrCalSelDay=dateKeyLocal(n.toISOString()); renderArrCalendar(); return; }
  if(e.target.closest("[data-arrclose]")){ arrCalSelDay=null; renderArrCalendar(); return; }
  const ad=e.target.closest("[data-arrday]"); if(ad){ if(arrCalSelDay===ad.dataset.arrday){ if(!e.target.closest(".cal-day-head")){} return; } arrCalSelDay=ad.dataset.arrday; renderArrCalendar(); return; }
  const eqn=e.target.closest("[data-weqnote]"); if(eqn){ e.stopPropagation(); wdSaveEqNote(eqn.dataset.weqnote); return; }
  const wpart=e.target.closest("[data-wepartial]"); if(wpart){ e.stopPropagation(); const id=wpart.dataset.wepartial; const eq=WD_EQUIP.find(x=>x.docId===id); if(eq&&fbReady){ setDoc(doc(db,"webductEquip",id),{partial:!eq.partial,updatedAt:serverTimestamp()},{merge:true}).then(()=>toast(!eq.partial?"Marked partial":"Marked complete")).catch(()=>toast("Couldn't update")); } return; }
  const pick=e.target.closest("[data-wepick]"); if(pick){ e.stopPropagation(); const [docId,arrivalId]=pick.dataset.wepick.split("|||"); wdOpenPairKind(docId,arrivalId); return; }
  const del=e.target.closest("[data-wedelivered]"); if(del){ wdMarkEquip(del.dataset.wedelivered,{deliveredMark:true}); toast("Marked delivered"); return; }
  const dis=e.target.closest("[data-wedismiss]"); if(dis){ wdMarkEquip(dis.dataset.wedismiss,{dismissed:true}); toast("Dismissed"); return; }
  const s=e.target.closest("#wdSyncBtn"); if(s){ if(wdConnected()){ wdAutoSync({manual:true}); } else { toast("Connect Webduct in Admin first"); } return; }
  const cr=e.target.closest("#calRefreshBtn"); if(cr){ if(!wdConnected()){ toast("Connect Webduct in Admin first"); return; } cr.disabled=true; cr.textContent="⟳ Syncing…"; wdAutoSync({manual:true}).finally(()=>{ cr.disabled=false; cr.textContent="⟳ Refresh"; }); return; }
  if(e.target.closest("#calWinApply")){ wdSaveWindow(parseInt($("calWinBack").value||"0",10), parseInt($("calWinFwd").value||"0",10)); wdSyncWindowInputs(); toast("Window set: "+wdWindowLabel()+" — refreshing"); if(wdConnected()) wdAutoSync({manual:true}); return; }
  if(e.target.closest("#wn_x")){ closeModal("notesModal"); return; }
  if(e.target.closest("#btnTutorial")){ openTutorial(); return; }
  if(e.target.closest("#runImportBtn")){ ghRunImport(); return; }
  if(e.target.closest("#ghX")){ closeModal("ghModal"); return; }
  if(e.target.closest("#ghSave")){ ghSaveCfg(); return; }
  if(e.target.closest("#lockSignIn")){ openName(); return; }
  if(e.target.closest("#tutX")||e.target.closest("#tutSkip1")||e.target.closest("#tutSkip2")){ tutFinish(); return; }
  if(e.target.closest("#tutPickShip")){ tutStart(TUT_SHIP,"Shipping Dept"); return; }
  if(e.target.closest("#tutPickField")){ tutStart(TUT_FIELD,"Field / Office"); return; }
  if(e.target.closest("#tutBack")){ if(TUT_I>0){TUT_I--; tutRender();} return; }
  if(e.target.closest("#tutNext")){ if(TUT_I<TUT_LIST.length-1){TUT_I++; tutRender();} else tutFinish(); return; }
  const popen=e.target.closest("[data-popen]"); if(popen){ const id=popen.dataset.popen; if(PERM_OPEN.has(id))PERM_OPEN.delete(id); else PERM_OPEN.add(id); renderPeople(); return; }
  const pperm=e.target.closest("[data-perm]"); if(pperm){ e.stopPropagation(); const [id,v]=pperm.dataset.perm.split("|||"); const p=PEOPLE.find(x=>x.id===id); if(!p||!fbReady)return; const cur=permsFor(p); const next=Object.assign({}, p.perms||{}); next[v]=!cur[v]; setDoc(doc(db,"people",id),{perms:next,updatedAt:serverTimestamp()},{merge:true}).then(()=>toast(`${p.first}: ${VIEW_LABELS[v]} ${next[v]?"allowed":"blocked"}`)).catch(()=>toast("Couldn't save")); return; }
  const preset=e.target.closest("[data-permreset]"); if(preset){ e.stopPropagation(); const id=preset.dataset.permreset; const p=PEOPLE.find(x=>x.id===id); if(!p||!fbReady)return; setDoc(doc(db,"people",id),{perms:null,updatedAt:serverTimestamp()},{merge:true}).then(()=>toast("Back to the email default")).catch(()=>toast("Couldn't save")); return; }
  if(e.target.closest("#tp_x")){ closeModal("timeModal"); return; }
  if(e.target.closest("#pk_x")){ closeModal("pairModal"); return; }
  if(e.target.closest("#pk_full")){ wdDoPair(false); return; }
  if(e.target.closest("#pk_partial")){ wdDoPair(true); return; }
  if(e.target.closest("#tp_save")){ wdSaveTime(false); return; }
  if(e.target.closest("#tp_clear")){ wdSaveTime(true); return; }
  if(e.target.closest("#wdWinApply")){ wdSaveWindow(parseInt($("wdWinBack").value||"0",10), parseInt($("wdWinFwd").value||"0",10)); wdSyncWindowInputs(); toast("/orders window set: "+wdWindowLabel()); return; }
});
document.addEventListener("change",e=>{
  const sel=e.target.closest("[data-welinksel]"); if(sel){ const arrivalId=sel.value; if(arrivalId){ wdSetMatch(sel.dataset.welinksel,"confirmed",arrivalId); toast("Linked to arrival"); } }
});
document.addEventListener("input",e=>{
  const s=e.target.closest("[data-welinksearch]"); if(s){ const docId=s.dataset.welinksearch; const e2=WD_EQUIP.find(x=>x.docId===docId); const res=$("welinkres-"+docId); if(e2&&res){ res.innerHTML=wdArrivalPickList(e2, s.value); } return; }
});
// Set dismissed/delivered flags on an equipment link.
async function wdMarkEquip(docId, patch){ if(!fbReady)return; try{ await setDoc(doc(db,"webductEquip",docId), patch, {merge:true}); }catch(err){ console.error(err); } }

/* ---------- Init ---------- */
renderWho(); renderFeed(); renderJobs(); renderDeliveries();
if(typeof wdUpdateLights==="function") wdUpdateLights();
if(typeof wdSyncWindowInputs==="function") wdSyncWindowInputs();
lockDateInputs();
const initView=viewForHash(location.hash.replace("#","")); if(initView)setView(initView,true);
syncAdminView(); startSync();
if(!USER){ setTimeout(()=>{ if(!USER) openName(); },600); }
// Returning user whose Webduct token survived the session → refresh equipment in the background.
if(USER){ setTimeout(()=>{ if(typeof wdAutoSync==="function") wdAutoSync(); }, 2500); }
window.addEventListener("pageshow",()=>{ if($("view-admin").classList.contains("active"))syncAdminView(); });
