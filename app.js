import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
         collection, onSnapshot, doc, getDoc, setDoc, deleteDoc, writeBatch, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

/* Pure helpers, split out of this file. Relative paths so they resolve under the
   /Equipment-Received/ Pages subpath. idb.js has no callers left (photos moved to
   Firestore) but is imported so the module still loads with the rest. */
import { $ } from "./dom.js";
import { idbOpen, idbSet, idbGet, idbDel, idbKeys } from "./idb.js";
import { toast, copyToClipboard } from "./toast.js";
import { PTP_TEMPLATES, ptpBlank, ptpLoad, ptpSave, ptpWipe, ptpFormHTML, ptpCollect, ptpPdf, ptpFileName,
         ptpQuestions, ptpCircleItems, ptpAttList, ptpAttAdd, ptpAttDel, ptpAttClear, ptpMerge } from "./ptp.js";
import { esc, normJob, isRealJob, makeId, fmtDateKey, MON, rowDate, longDate,
         todayIso, monthKey, monthLabel, rateChips, money, lastSeenText } from "./format.js";

/* pdf.js now loads async, so it usually is NOT here yet when this module runs. Set the worker
   path at the moment of use instead, and let callers ask whether the library actually arrived. */
function pdfReady(){
  if(!window.pdfjsLib) return false;
  if(!pdfjsLib.GlobalWorkerOptions.workerSrc)
    pdfjsLib.GlobalWorkerOptions.workerSrc="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  return true;
}

const firebaseConfig={apiKey:"AIzaSyBwf2lyLcJWz8qfuEHn76-tIbOm117Tltg",authDomain:"equipment-received.firebaseapp.com",projectId:"equipment-received",storageBucket:"equipment-received.firebasestorage.app",messagingSenderId:"164676400073",appId:"1:164676400073:web:552cc0e3dcc8e06951ae18"};
let db=null,fbReady=false;
/* Offline cache. Crews open this on job sites with no signal; without it the app showed
   "Can't reach Firebase" and nothing else, even for data loaded minutes earlier. With the
   persistent cache the last synced arrivals/rentals still render, and edits queue locally
   and flush when signal returns. Multi-tab manager because people leave this open on a
   desktop as well as a phone. Falls back to the plain in-memory client if the browser
   refuses persistence (private browsing, storage full, an older engine) — losing offline
   is better than losing the app. */
try{
  const fbApp=initializeApp(firebaseConfig);
  try{ db=initializeFirestore(fbApp,{localCache:persistentLocalCache({tabManager:persistentMultipleTabManager()})}); }
  catch(e){ console.warn("Offline cache unavailable, using memory-only Firestore",e); db=getFirestore(fbApp); }
  fbReady=true;
}catch(e){ console.error("FB",e); }

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
// ---- Safety tab. Uploaded whole from Admin; an import replaces what was there, except rows
//      pinned or hand-edited in the Safety tab — see sfConflicts/sfReplace. ----
let SF_POINTS=[];                   // {id, name, shirt, start, awards:{label:pts}, used, extra, total}
let SF_TRAINING=[];                 // {id, name, course, instructor, date, expires, notes}
let SF_SDS=[];                      // {id, record, product, use, vendor, issueDate, dept, pages}
let SF_DRUG=[];                     // {id, name, tested, expires} — same workbook as the training log
let SF_META={};                     // {points:{count,updatedAt,by}, training:{...}, sds:{...}}
let SF_TAB="points";                // which sub-pill is showing
let SF_TRAIN_FILTER="all";
let SF_DRUG_FILTER="all";
const SF_TRAIN_OPEN=new Set();      // which people are expanded on the training list
const SF_SDS_OPEN=new Set();
const SF_PTS_OPEN=new Set();        // which points entries are expanded
const SF_DRUG_OPEN=new Set();       // drug rows only expand for admins, to reach edit/delete        // which chemicals are expanded
// A rejected read leaves the pane empty, which reads as "nothing uploaded". Remember WHY so
// the pane can say so instead — a missing Firestore rule is the usual cause.
const SF_ERR={};
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
// "cache" means the offline cache answered — real rows, but as of the last time there was
// signal. Saying "Live" there would be a lie, and on a job site knowing your data is stale
// is the whole point.
function setSync(s){ const d=$("syncDot"); d.className="sync-dot "+(s==="live"?"live":s==="err"?"err":s==="cache"?"cache":""); $("syncTxt").textContent=s==="live"?("Live V"+APP_VERSION):s==="err"?"Offline":s==="cache"?"Saved data":"Connecting"; }
function startSync(){
  if(!fbReady){ setSync("err"); showErr("feedList"); showErr("rentList"); showErr("toolList"); return; }
  onSnapshot(collection(db,"arrivals"),snap=>{ const l=[]; snap.forEach(d=>{const v=d.data(); const deliveredDate=v.deliveredDate||v.deliveryDate||""; l.push({id:d.id,dateReceived:v.dateReceived||"",po:v.po||"",jobNumber:v.jobNumber||"",jobName:v.jobName||"",description:v.description||"",supplier:v.supplier||"",reqDeliv:v.reqDeliv||"",delivered:(v.delivered!=null?!!v.delivered:!!deliveredDate),deliveredDate:deliveredDate,partial:!!v.partial,storageLocation:v.storageLocation||"",requestedBy:v.requestedBy||"",photoBy:v.photoBy||"",deliveredBy:v.deliveredBy||"",deliveredMarkedOn:v.deliveredMarkedOn||"",seq:v.seq||0});}); l.sort((a,b)=>a.dateReceived!==b.dateReceived?(a.dateReceived<b.dateReceived?1:-1):(b.seq||0)-(a.seq||0)); ARRIVALS=l; autoLinkJobs(); renderAll(); }, e=>{console.error(e); setSync("err"); showErr("feedList",e.code);});

  /* ---- Connection badge ----
     This used to hang off the arrivals listener, which is why it could sit on "Saved data"
     forever while everything else synced fine. Two reasons it got stuck:

       1. onSnapshot does NOT fire for metadata-only changes unless includeMetadataChanges is
          set. On load the cache answers first (fromCache: true), and when the server then
          confirms the SAME arrivals, that's metadata-only — no callback, so the badge was
          never told it had gone live.
       2. Even with the flag, arrivals is the wrong source: it only speaks when arrivals
          change. Rentals, safety and Webduct data could all be streaming from the server
          while the badge still reported the stale answer from page load.

     So the badge now has its own listener on one small document, with the flag set, and it
     is the only thing that writes to it. config/lastImport is a good probe: the importer
     keeps it current, and one doc costs almost nothing to watch. */
  onSnapshot(doc(db,"config","lastImport"), {includeMetadataChanges:true},
    s=>setSync(s.metadata && s.metadata.fromCache ? "cache" : "live"),
    e=>{ console.error("sync probe", e); setSync("err"); });
  onSnapshot(collection(db,"rentals"),snap=>{ const l=[]; snap.forEach(d=>{const v=d.data(); l.push({id:d.id,rentalId:v.rentalId||"",jobNumber:v.jobNumber||"",jobName:v.jobName||"",equipment:v.equipment||"",rate:v.rate||"",vendor:v.vendor||"",dateRented:v.dateRented||"",status:v.status||"Renting",dateReturned:v.dateReturned||"",orderedBy:v.orderedBy||"",po:v.po||"",seq:v.seq||0});}); l.sort((a,b)=>a.dateRented!==b.dateRented?(a.dateRented<b.dateRented?1:-1):(b.seq||0)-(a.seq||0)); RENTALS=l; renderRentals(); renderJobs(); renderEricStats(); }, e=>{console.error(e); showErr("rentList",e.code);});
  onSnapshot(collection(db,"toolRentals"),snap=>{ const l=[]; snap.forEach(d=>{const v=d.data(); l.push({id:d.id,jobNumber:v.jobNumber||"",jobName:v.jobName||"",jobClosed:!!v.jobClosed,toolType:v.toolType||"",toolId:v.toolId||"",rentalStarted:v.rentalStarted||"",rentalEnded:v.rentalEnded||"",billingDays:v.billingDays||0,dailyRate:v.dailyRate||0,billingTotal:v.billingTotal||"",discountedRate:v.discountedRate||"",status:v.status||(v.rentalEnded?"Returned":"Out"),seq:v.seq||0});}); l.sort((a,b)=>a.rentalStarted!==b.rentalStarted?(a.rentalStarted<b.rentalStarted?1:-1):(b.seq||0)-(a.seq||0)); TOOLS=l; renderTools(); renderJobs(); renderEricStats(); }, e=>{console.error(e); showErr("toolList",e.code);});
  onSnapshot(doc(db,"config","ptpPool"),d=>{ PTP_POOL=d.exists()?(d.data()||{}):{};
    if(SF_TAB==="ptp" && $("ptpForm") && $("ptpForm").innerHTML) renderPtp(); },
    e=>console.error("ptpPool",e));
  onSnapshot(doc(db,"pdfStore","meta"),d=>{ PDF_META=d.exists()?d.data():null; pdfRender.doc=null; renderTools(); renderJobs(); }, e=>console.error("pdfmeta",e));
  onSnapshot(collection(db,"people"),snap=>{ const l=[]; snap.forEach(d=>{const v=d.data(); l.push({id:d.id,first:v.first||"",last:v.last||"",nameNorm:v.nameNorm||"",email:v.email||"",access:v.access||"",perms:v.perms||null,savedJobs:v.savedJobs||null,removedJobs:v.removedJobs||null,jobOrder:v.jobOrder||null,lastSeen:tsMs(v.lastSeen)});}); PEOPLE=l; onPeople(); resolvePendingHash(); if(typeof applyAccess==="function")applyAccess(); if(typeof renderPeople==="function" && $("peopleModal") && $("peopleModal").classList.contains("show")) renderPeople(); }, e=>console.error("people",e));
  onSnapshot(collection(db,"shares"),snap=>{ const l=[]; snap.forEach(d=>{const v=d.data(); l.push({id:d.id,toId:v.toId||"",toName:v.toName||"",fromName:v.fromName||"",jobNumber:v.jobNumber||"",jobName:v.jobName||"",status:v.status||"pending"});}); SHARES=l; renderJobs(); }, e=>console.error("shares",e));
  onSnapshot(collection(db,"webductEquip"),snap=>{ const l=[]; snap.forEach(d=>{const v=d.data(); l.push({docId:d.id, ...v});}); WD_EQUIP=l; renderDeliveries(); renderFeed(); }, e=>console.error("webductEquip",e));
  onSnapshot(collection(db,"webductOrders"),snap=>{ const l=[]; snap.forEach(d=>{const v=d.data(); l.push({docId:d.id, ...v});}); WD_ORDERS=l; if(typeof autoLinkOrderedJobs==="function") autoLinkOrderedJobs(); renderDeliveries(); }, e=>console.error("webductOrders",e));
  onSnapshot(doc(db,"config","lastSync"),snap=>{ if(snap.exists()){ WD_LAST_SYNC=snap.data(); wdRenderLastSync(); } }, e=>console.error("lastSync",e));
  onSnapshot(doc(db,"config","lastImport"),snap=>{ if(snap.exists()){ LAST_IMPORT=snap.data(); renderAutoImport(); } }, e=>console.error("lastImport",e));
  onSnapshot(doc(db,"config","lastToolImport"),snap=>{ if(snap.exists()){ LAST_TOOL_IMPORT=snap.data(); renderAutoImport(); } }, e=>console.error("lastToolImport",e));
  onSnapshot(doc(db,"config","ghActions"),snap=>{ GH_CFG=snap.exists()?snap.data():null; ghRenderBtn(); }, e=>console.error("ghActions",e));
  onSnapshot(collection(db,"webductOrderNotes"),snap=>{ WD_NOTES={}; snap.forEach(d=>{ WD_NOTES[d.id]=d.data(); }); renderDeliveries(); }, e=>console.error("webductOrderNotes",e));

  // ---- Safety collections. Read-only here; Admin uploads are what write them. ----
  onSnapshot(collection(db,"safetyPoints"),snap=>{ const l=[]; snap.forEach(d=>l.push({id:d.id,...d.data()})); SF_POINTS=l; renderSafety(); }, e=>{ console.error("safetyPoints",e); SF_ERR.points=e; renderSafety(); });
  onSnapshot(collection(db,"safetyTraining"),snap=>{ const l=[]; snap.forEach(d=>l.push({id:d.id,...d.data()})); SF_TRAINING=l; renderSafety(); }, e=>{ console.error("safetyTraining",e); SF_ERR.training=e; renderSafety(); });
  onSnapshot(collection(db,"safetySds"),snap=>{ const l=[]; snap.forEach(d=>l.push({id:d.id,...d.data()})); SF_SDS=l; renderSafety(); }, e=>{ console.error("safetySds",e); SF_ERR.sds=e; renderSafety(); });
  onSnapshot(collection(db,"safetyDrugCards"),snap=>{ const l=[]; snap.forEach(d=>l.push({id:d.id,...d.data()})); SF_DRUG=l; renderSafety(); }, e=>{ console.error("safetyDrugCards",e); SF_ERR.drug=e; renderSafety(); });
  onSnapshot(doc(db,"config","safetyMeta"),d=>{ SF_META=d.exists()?d.data():{}; renderSafety(); }, e=>console.error("safetyMeta",e));
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
/* Firestore hands back a Timestamp; a serverTimestamp() that hasn't round-tripped yet reads as
   null from the local cache. Normalise both to plain millis, 0 for "never". */
function tsMs(v){ if(!v)return 0; if(typeof v==="number")return v; if(typeof v.toMillis==="function")return v.toMillis(); if(v.seconds!=null)return v.seconds*1000; return 0; }

/* Record that this person opened the site. Throttled hard: the admin list only needs to know
   whether someone is using it at all, and an unthrottled write on every load and tab-focus would
   spend the free tier's daily write budget on nothing. Once per person per 15 minutes is plenty.
   The stamp is kept in localStorage too, so reloading the page repeatedly doesn't write each time. */
const SEEN_EVERY=15*60*1000;
let lastSeenWrite=0;
function touchLastSeen(){
  if(!USER||!fbReady) return;
  const now=Date.now();
  if(now-lastSeenWrite < SEEN_EVERY) return;
  try{ const prev=Number(localStorage.getItem("er_seen_at")||0); if(now-prev < SEEN_EVERY){ lastSeenWrite=prev; return; } }catch(e){}
  lastSeenWrite=now;
  try{ localStorage.setItem("er_seen_at",String(now)); }catch(e){}
  try{ setDoc(doc(db,"people",USER.id),{lastSeen:serverTimestamp()},{merge:true}); }
  catch(e){ console.error("lastSeen",e); }
}

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
  const place = r.delivered ? `<span class="m deliv">✓ Delivered${r.deliveredDate?" "+esc(longDate(r.deliveredDate).split(",")[0]):""}</span>`+markedByChip(r)
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
  return `<div class="acard ${open?'open':''} ${opts.compact?'compact':''} ${opts.isNew?'is-new':''}" data-type="arrival" data-id="${esc(r.id)}">
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

/* ---------- How much of a list to put in the DOM ----------
   These lists render straight into the document, so their length IS the app's performance
   ceiling. Measured at 12,000 arrivals: an uncapped merged My Jobs list produced 470,000 DOM
   nodes and a 12-second tab switch on a phone. The cap is what keeps a five-year-old database
   usable. Raising it is one tap and the total is always stated, so nothing is hidden silently.
   The counter resets itself when the filters change -- derived from a signature rather than
   from every handler remembering, because one day a new handler would forget. */
const PAGE_STEP=200;
let feedShown=PAGE_STEP, feedSig=null, mjShown=PAGE_STEP, mjSig=null, delShown=PAGE_STEP, delSig=null;
function pageBump(which){
  if(which==="feed"){ feedShown+=PAGE_STEP; renderFeed(); }
  else if(which==="del"){ delShown+=PAGE_STEP; renderDeliveries(); }
  else { mjShown+=PAGE_STEP; renderJobs(); }
}
function moreBtn(which,shown,total){
  if(total<=shown) return "";
  const left=total-shown;
  return `<button type="button" class="show-more" data-showmore="${which}">
    Show ${Math.min(PAGE_STEP,left)} more <i>${shown.toLocaleString()} of ${total.toLocaleString()}</i></button>`;
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
  const sig=q+"\u0000"+month;
  if(sig!==feedSig){ feedSig=sig; feedShown=PAGE_STEP; }   // a new filter starts from the top again
  list.innerHTML=rows.slice(0,feedShown).map(r=>arrivalRow(r)).join("")+moreBtn("feed",feedShown,rows.length);
}

/* ---------- Render: Rentals (grouped by job, collapsible) ---------- */
// opts.job adds the job number to the line. My Jobs' merged "all jobs" list needs it — inside a
// single job's list it would just repeat the header. Arrival cards carry their own job badge.
function rentalLine(r,opts={}){
  const ret=/return/i.test(r.status);
  return `<div class="tline ${ret?'returned':''}" data-type="rental" data-id="${esc(r.id)}">
    <div class="tl-tool">${opts.job?`<span class="tl-job">${esc(normJob(r.jobNumber))}</span>`:""}${esc(r.equipment)||"Equipment"}${r.rentalId?` <span class="tid">${esc(r.rentalId)}</span>`:""}</div>
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
function toolLine(r,opts={}){
  const ret=/return/i.test(r.status);
  return `<div class="tline ${ret?'returned':''}" data-type="tool" data-id="${esc(r.id)}">
    <div class="tl-tool">${opts.job?`<span class="tl-job">${esc(normJob(r.jobNumber))}</span>`:""}${esc(r.toolType||"Tool")} <span class="tid">#${esc(r.toolId)||"—"}</span></div>
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
  // Class, not inline style: an inline display beats every stylesheet rule, and the phone layout
  // has to hide this card -- the name is already in the header chip.
  if(VIEW_AS){ card.classList.add("on"); card.classList.add("viewing"); $("idAv").textContent=((VIEW_AS.first[0]||"")+(VIEW_AS.last[0]||"")).toUpperCase(); $("idName").textContent=VIEW_AS.first+" "+VIEW_AS.last; $("idSub").textContent="You're viewing this person's saved jobs"; return; }
  card.classList.remove("viewing");
  if(USER){ card.classList.add("on"); $("idAv").textContent=((USER.first[0]||"")+(USER.last[0]||"")).toUpperCase(); $("idName").textContent=USER.first+" "+USER.last; const n=new Set(ARRIVALS.filter(r=>nameMatches(r.requestedBy,USER.first,USER.last)).map(r=>normJob(r.jobNumber)).filter(isRealJob)).size; $("idSub").textContent=n?`${n} job${n===1?"":"s"} auto-linked from "Requested by"`:`Your requested jobs link automatically`; }
  else card.classList.remove("on");
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

/* ---------- My Jobs ----------
   Split layout: the left pane picks a job, the right pane is the items. With nothing picked the
   right pane merges every saved job into one newest-first list. ARRIVALS/RENTALS/TOOLS are already
   sorted newest-first when they load, so the merge is a filter over the source array — see the
   note in the right-pane section for why that matters. */
let MJ_SEL="";                      // selected job number; "" = all jobs
let MJ_SHEET="";                    // "", "jobs" or "show" -- which bottom sheet is open (phone only)
const MJ_SEG={
  arrivals:{arr:()=>ARRIVALS, date:r=>r.dateReceived,   tags:ARR_TAG_FIELDS,  demo:j=>demoArrivals(j), row:(r,o)=>arrivalRow(r,o), plural:"arrivals",     one:"arrival",     label:"Arrivals"},
  rentals :{arr:()=>RENTALS,  date:r=>r.dateRented,     tags:RENT_TAG_FIELDS, demo:j=>demoRentals(j),  row:(r,o)=>rentalLine(r,o),  plural:"rentals",      one:"rental",      label:"Equip rentals"},
  tools   :{arr:()=>TOOLS,    date:r=>r.rentalStarted,  tags:TOOL_TAG_FIELDS, demo:j=>demoTools(j),    row:(r,o)=>toolLine(r,o),    plural:"tool rentals", one:"tool rental", label:"Tool rentals"},
};
/* One open/close path for both sheets, and only one is ever open. Both close four ways -- the
   scrim, the X, Escape, and making a choice -- so nobody can get trapped behind one. */
let MJ_SHEET_RETURN=null;
function mjSheet(which,on,focusId){
  const b=document.body;
  if(!on||!which){
    if(!MJ_SHEET)return;
    b.classList.remove("mj-jobs","mj-show"); MJ_SHEET="";
    document.querySelectorAll("#mjBar [aria-expanded]").forEach(x=>x.setAttribute("aria-expanded","false"));
    // Don't unlock the page if a real modal is still up underneath this sheet.
    if(!document.querySelector(".modal-back.show")) b.style.overflow="";
    if(MJ_SHEET_RETURN&&document.contains(MJ_SHEET_RETURN)){ try{MJ_SHEET_RETURN.focus();}catch(_){} }
    MJ_SHEET_RETURN=null; return;
  }
  MJ_SHEET_RETURN=document.activeElement;
  b.classList.toggle("mj-jobs",which==="jobs");
  b.classList.toggle("mj-show", which==="show");
  MJ_SHEET=which; b.style.overflow="hidden";
  const panel=$(which==="jobs"?"mjJobsPanel":"mjShowPanel");
  panel.setAttribute("role","dialog"); panel.setAttribute("aria-modal","true");
  panel.setAttribute("aria-label",which==="jobs"?"Pick a job":"What to show");
  panel.scrollTop=0;
  const opener=document.querySelector(`#mjBar [data-mjopen="${which}"]`);
  if(opener)opener.setAttribute("aria-expanded","true");
  setTimeout(()=>{ const el=focusId?$(focusId):panel.querySelector(".mj-sheet-x"); if(el){try{el.focus();}catch(_){}} },60);
}

/* The bar sticks under the appbar, whose height moves with the notch (--safe-top) and with OS
   font scaling -- the whole appbar is text-driven. Publish the measured height rather than
   hardcoding a number that a bigger font size would silently break. */
function syncAppbarH(){ const a=document.querySelector(".appbar");
  if(a) document.documentElement.style.setProperty("--appbar-h", a.offsetHeight+"px"); }

/* On a phone the entire control stack collapses into this one bar. The contract that makes that
   safe rather than dangerous: a control may only be hidden behind a sheet if the bar states its
   own state OUT LOUD, in plain words, on its face. A month filter left on from last week must
   never look like "the app lost my stuff".
   Takes an explicit argument object -- renderJobs() returns early in two places where the locals
   this needs (visible/items/anyNew/seg) do not exist yet. */
function renderMjBar(s){
  const bar=$("mjBar"); if(!bar)return;
  bar.className="mj-bar";

  if(s.mode==="empty"){                       // no saved jobs: show the ONE thing to do, full width
    bar.innerHTML=`<button class="mjb mjb-wide" type="button" data-mjopen="show" data-mjfocus="jobSearch"
       aria-haspopup="dialog" aria-expanded="false">+ Save a job</button>`;
    return;
  }
  if(s.mode==="nomatch"){                     // a search matching nothing has to fix itself in one tap
    bar.innerHTML=`<button class="mjb mjb-wide alert" type="button" data-mjclearsearch="1">Nothing matches &ldquo;${esc(s.q)}&rdquo; &mdash; tap to clear</button>`;
    return;
  }
  if(s.reorder){                              // picking is disabled while reordering, so the bar
    bar.innerHTML=`<button class="mjb mjb-wide done" type="button" data-mjreorderdone="1">Done reordering</button>`;
    return;                                   // becomes the way out, with no sheet above it
  }

  // No tag in the all-jobs state: an "ALL" chip next to the words "All my jobs" says nothing
  // twice and costs ~57px, which was enough to clip the label to "ALL MY...".
  // The new-count is a total across every job, so it only belongs on the all-jobs face. Next to a
  // picked job it reads as that job's count, which it isn't -- and it squeezed the name to "T...".
  // Picked face leads with the NUMBER, not the name: it is what's on the paperwork and what people
  // say out loud, it can never overflow, and a long name on top clipped to "THE...". The name
  // still rides the sub-line, and the full one is one tap away in the picker.
  const filtered=!!(s.month||s.q||s.segKey!=="arrivals");
  const sub=[s.month?esc(s.monthLabel):"", s.q?`&ldquo;${esc(s.q)}&rdquo;`:"", String(s.itemCount)].filter(Boolean).join(" · ");
  bar.innerHTML=
    `<button class="mjb mjb-job ${s.selJob?"picked":""}" type="button" data-mjopen="jobs"
        aria-haspopup="dialog" aria-expanded="false">
       <span class="mjb-body"><b>${s.selJob?esc(s.selJob):"All my jobs"}</b>
         <i>${s.selJob?esc(s.selName):`${s.jobCount} job${s.jobCount===1?"":"s"}`}</i></span>
       ${(s.anyNew&&!s.selJob)?`<span class="mjb-new">${s.anyNew>99?"99+":s.anyNew} new</span>`:""}
       <span class="mjb-chev">&#9662;</span>
     </button>`
   + (s.selJob?`<button class="mjb-all" type="button" data-mjpick="">All</button>`:"")
   + `<button class="mjb mjb-show ${filtered?"on":""} seg-${esc(s.segKey)}" type="button" data-mjopen="show"
        aria-haspopup="dialog" aria-expanded="false">
       <span class="mjb-body"><b>${esc(s.segLabel)}</b><i>${sub}</i></span>
       <span class="mjb-chev">&#9662;</span>
     </button>`;
}

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
  const wrap=$("foldersList"), split=$("mjSplit");
  document.getElementById("reorderToggle").closest(".reorder-bar").classList.toggle("hidden",viewingOther);
  $("reorderToggle").classList.toggle("on",reorderMode);
  $("reorderHint").textContent=reorderMode?"Use the ▲▼ arrows to reorder":"";
  $("orderReset").style.display=(ordList.length&&!reorderMode&&!viewingOther)?"inline-block":"none";
  const isPhone=!matchMedia("(min-width:860px)").matches;
  // #foldersList is the empty-state slot; the split is hidden whenever it has something to say.
  // The picker must be emptied AND its sheet closed here: #jobPickList is only rebuilt further
  // down, past both early returns, so leaving it up would show stale, tappable job rows.
  const showEmpty=(html,mode,q)=>{
    split.style.display="none"; wrap.innerHTML=html;
    // Clear the picker, but only close the sheet if it IS the picker. These paths fire on every
    // keystroke in the search box, which lives in the SHOW sheet -- closing that would yank the
    // sheet and the keyboard out from under someone mid-word, exactly when they need it most.
    $("jobPickList").innerHTML=""; if(MJ_SHEET==="jobs") mjSheet(null,false);
    renderMjBar({mode,q:q||""});
  };
  if(!jobsList.length){ showEmpty(viewingOther?`<div class="empty"><div class="ico">📁</div><h3>No saved jobs</h3><p>${esc(viewName||"This person")} hasn't saved any jobs yet.</p></div>`:`<div class="empty"><div class="ico">📁</div><h3>No saved jobs</h3><p>${isPhone?"Tap <b>+ Save a job</b> below, type your job number, then tap <b>Save</b>":"Search a job number above and tap Save"}${USER?", or your requested jobs link automatically":""}. Arrivals, rentals, and tool rentals on it collect here.</p></div>`,"empty"); return; }
  const newCountFor=job=>{ if(viewingOther)return 0; let n=0; ARRIVALS.forEach(r=>{if(normJob(r.jobNumber)===job&&news.has("a:"+r.id))n++;}); return n; };
  const lastOf=j=>jobsMap.get(j)?.last||"";
  let sorted;
  if(ordList.length){ const known=ordList.filter(j=>jobsList.includes(j)); const extra=jobsList.filter(j=>!ordList.includes(j)).sort((a,b)=>lastOf(b)<lastOf(a)?-1:1); sorted=[...extra,...known]; }
  else sorted=[...jobsList].sort((a,b)=>{ const na=newCountFor(a),nb=newCountFor(b); if((nb>0)!==(na>0))return nb>0?1:-1; return lastOf(b)<lastOf(a)?-1:1; });
  MJ_VIEW=sorted.slice();

  const seg=MJ_SEG[mjSeg]||MJ_SEG.arrivals;
  // Each job's items for the segment on screen, after the month and search filters. The tutorial's
  // sample job is synthetic and skips both, so a leftover filter can't hide it mid-walkthrough.
  const byJob=new Map();
  for(const job of sorted){
    const isDemo = TUT_DEMO && job===TUT_JOB;
    let items = isDemo ? seg.demo(job) : seg.arr().filter(r=>normJob(r.jobNumber)===job);
    const total=items.length;
    if(!isDemo){
      if(month) items=items.filter(r=>monthKey(seg.date(r))===month);
      if(sq){
        const nm=jobsMap.get(job)?.jobName||items[0]?.jobName||"";
        // Naming the job in the search shows all of it; otherwise the search filters its items.
        if(!(job.toLowerCase().includes(sq)||nm.toLowerCase().includes(sq)))
          items=items.filter(r=>tagMatch(r,seg.tags,sq));
      }
    }
    byJob.set(job,{items,total,isDemo});
  }
  // A search drops jobs with nothing left. Without one every saved job stays listed, so an empty
  // job reads as "nothing this month" instead of silently disappearing.
  const visible = sq ? sorted.filter(j=>byJob.get(j).items.length) : sorted;
  if(sq && !visible.length){ showEmpty(`<div class="empty"><div class="ico">🔍</div><h3>No matches</h3><p>Nothing ${viewingOther?"in this list":"saved"} matches "${esc($("jobSearch").value.trim())}".${viewingOther?"":" Check the suggestions above to add a new job."}</p></div>`,"nomatch",$("jobSearch").value.trim()); return; }
  split.style.display=""; wrap.innerHTML="";
  if(MJ_SEL && !visible.includes(MJ_SEL)) MJ_SEL="";   // picked job was removed or filtered away

  /* ---- left pane: pick a job ---- */
  const withTools=new Set(TOOLS.map(r=>normJob(r.jobNumber)));
  const totalShown=visible.reduce((n,j)=>n+byJob.get(j).items.length,0);
  const anyNew=visible.reduce((n,j)=>n+newCountFor(j),0);
  // Two panes, one loop. `rows` is the desktop chip strip (unchanged); `picks` is the phone's
  // full-width picker, a separate class in a separate element so neither can style the other.
  // While reordering, the way out has to live INSIDE the sheet: the scrim (z-59) covers the bar
  // (z-29), so the bar's "Done reordering" is unreachable until the sheet is closed.
  const picks=(reorderMode&&!viewingOther)
    ? [`<button class="mjp-done" type="button" data-mjreorderdone="1">Done reordering</button>`] : [];
  picks.push(`<div class="mjp-row all ${MJ_SEL?"":"on"}" data-mjpick="" role="button" tabindex="0">
      <span class="mjp-tag all">ALL</span>
      <span class="mjp-name">All my jobs</span>
      <span class="mjp-count"><b>${visible.length}</b> job${visible.length===1?"":"s"} &middot; <b>${totalShown}</b> ${seg.plural}</span>
      <span class="mjp-acts">${anyNew?`<button class="mjp-clearall" type="button" data-clearall="1">${anyNew} new<br>clear all</button>`:""}</span>
    </div>`);
  const rows=[`<div class="mj-job all ${MJ_SEL?"":"on"}" data-mjpick="" role="button" tabindex="0">
      <span class="mj-jtag all">ALL</span>
      <span class="mj-jinfo"><span class="mj-jname">All my jobs${anyNew?'<span class="new-dot"></span>':""}</span>
        <span class="mj-jcount"><b>${visible.length}</b> job${visible.length===1?"":"s"} · <b>${totalShown}</b> ${seg.plural}</span></span>
    </div>`];
  visible.forEach((job,idx)=>{
    const d=byJob.get(job);
    const name=jobsMap.get(job)?.jobName||d.items[0]?.jobName||"Unknown job name";
    const nNew=newCountFor(job);
    const ctrl=(reorderMode&&!viewingOther)?`<span class="reorder-ctrl"><button class="ord-btn" data-moveup="${esc(job)}" ${idx===0?"disabled":""} title="Move up">▲</button><button class="ord-btn" data-movedown="${esc(job)}" ${idx===visible.length-1?"disabled":""} title="Move down">▼</button></span>`:"";
    const removeBtn=viewingOther?`<button class="icon-btn fstar ${MY_JOBS.includes(job)?'saved':''}" data-savejob="${esc(job)}" title="${MY_JOBS.includes(job)?'Saved to your jobs':'Save to your jobs'}"><svg width="18" height="18" viewBox="0 0 24 24" fill="${MY_JOBS.includes(job)?'currentColor':'none'}" stroke="currentColor" stroke-width="2"><path d="M12 2l2.9 6.3 6.9.7-5.2 4.6 1.5 6.8L12 17.8 5.9 20.4l1.5-6.8L2.2 9l6.9-.7z"/></svg></button>`:`<button class="icon-btn" data-removejob="${esc(job)}" title="Remove"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6M14 11v6"></path></svg></button>`;
    rows.push(`<div class="mj-job ${MJ_SEL===job?"on":""} ${nNew?"has-new":""} ${(reorderMode&&!viewingOther)?"reorderable":""}" data-mjpick="${esc(job)}" role="button" tabindex="0">
      <span class="mj-jtag">${esc(job)}</span>
      <span class="mj-jinfo"><span class="mj-jname">${esc(name)}${withTools.has(job)?pdfLinkFor(job):""}${nNew?'<span class="new-dot"></span>':""}</span>
        <span class="mj-jcount"><b>${d.items.length}</b>${d.items.length!==d.total?` of ${d.total}`:""} ${seg.plural}${nNew?`<button class="clearone" data-clearjob="${esc(job)}">${nNew} new · clear</button>`:""}</span></span>
      <span class="mj-jacts">${ctrl}${removeBtn}</span>
    </div>`);
    // Reorder arrows and the NEW badge are mutually exclusive, so .mjp-acts never holds more
    // than three 46px controls -- that is what keeps the trash out of the name column.
    picks.push(`<div class="mjp-row ${MJ_SEL===job?"on":""} ${nNew?"has-new":""} ${(reorderMode&&!viewingOther)?"reorderable":""}"
        ${(reorderMode&&!viewingOther)?"":`data-mjpick="${esc(job)}" role="button" tabindex="0"`}>
        <span class="mjp-tag">${esc(job)}</span>
        <span class="mjp-name">${esc(name)}</span>
        <span class="mjp-count"><b>${d.items.length}</b>${d.items.length!==d.total?` of ${d.total}`:""} ${esc(seg.plural)}${withTools.has(job)?pdfLinkFor(job):""}</span>
        <span class="mjp-acts">${(reorderMode&&!viewingOther)?ctrl:(nNew?`<button class="mjp-new" type="button" data-clearjob="${esc(job)}">${nNew} new<br>clear</button>`:"")}${removeBtn}</span>
      </div>`);
  });
  $("mjJobList").innerHTML=rows.join("");
  $("jobPickList").innerHTML=picks.join("");

  /* ---- right pane: the items themselves ----
     Filtering the already-newest-first source array keeps the merged list in true date order
     across jobs; concatenating each job's slice would have grouped it by job instead. */
  const shownJobs = MJ_SEL?[MJ_SEL]:visible;
  const demoJobs  = shownJobs.filter(j=>byJob.get(j).isDemo);
  const realJobs  = new Set(shownJobs.filter(j=>!byJob.get(j).isDemo));
  const survived  = new Set(); realJobs.forEach(j=>byJob.get(j).items.forEach(r=>survived.add(r.id)));
  const items = [...demoJobs.flatMap(j=>byJob.get(j).items),
                 ...seg.arr().filter(r=>realJobs.has(normJob(r.jobNumber))&&survived.has(r.id))];
  const selName = MJ_SEL?(jobsMap.get(MJ_SEL)?.jobName||byJob.get(MJ_SEL).items[0]?.jobName||"Unknown job name"):"";
  $("mjMainHead").innerHTML=
    `<div class="mj-mh-t">${MJ_SEL
      ? `<span class="mj-jtag">${esc(MJ_SEL)}</span><b>${esc(selName)}</b>`
      : `<b>All my jobs</b><span class="mj-mh-sub">newest first</span>`}</div>
     <div class="mj-mh-c"><span><b>${items.length}</b> ${items.length===1?seg.one:seg.plural}</span>${MJ_SEL?`<button class="mj-showall" data-mjpick="">← All jobs</button>`:""}</div>`;
  const mjKey=[MJ_SEL,mjSeg,month,sq].join("\u0000");
  if(mjKey!==mjSig){ mjSig=mjKey; mjShown=PAGE_STEP; }
  const shown=items.slice(0,mjShown);
  $("mjItems").innerHTML = items.length
    // compact hides an arrival card's job badge and name, which is right when one job is picked
    // and the header already says which — but in the merged list that's the thing you need most.
    ? `<div class="${mjSeg==="arrivals"?"rows":"tlines"}">${shown.map(r=>seg.row(r,{star:true,compact:!!MJ_SEL,job:!MJ_SEL,isNew:!viewingOther&&news.has("a:"+r.id)})).join("")}</div>`
      + moreBtn("jobs",mjShown,items.length)
    : `<div class="sub-empty">No ${seg.plural}${sq?" match your search":month?" this month":MJ_SEL?" on this job":" on your jobs"} yet.</div>`;
  renderMjBar({
    mode:"normal",
    reorder:reorderMode&&!viewingOther,
    selJob:MJ_SEL, selName, jobCount:visible.length, anyNew,
    segKey:MJ_SEG[mjSeg]?mjSeg:"arrivals", segLabel:seg.label,
    month, monthLabel:month?monthLabel(month):"",
    q:sq?$("jobSearch").value.trim():"", itemCount:items.length
  });
}

/* ---------- Stats ---------- */
function renderAdminStats(){ if($("statTotal")){ $("statTotal").textContent=ARRIVALS.length.toLocaleString(); $("statRent").textContent=RENTALS.filter(r=>!/return/i.test(r.status)).length; $("statTool").textContent=TOOLS.length.toLocaleString(); } }
function renderEricStats(){ renderAdminStats(); }

/* ---------- Master render ---------- */
function renderAll(){ $("pillFeed").textContent=ARRIVALS.length>999?(Math.floor(ARRIVALS.length/100)/10)+"k":ARRIVALS.length; refreshMonths(); renderWho(); renderFeed(); renderRentals(); renderTools(); renderDeliveries(); renderJobs(); renderAdminStats(); syncFeedGroupTab(); if(PENDING_ARRIVAL && $("view-feed").classList.contains("active")) focusPendingArrival(); }

/* ---------- Save/remove job ---------- */
function addJob(job){ if(!USER){toast("Sign in to save jobs"); openName(); return;} const j=normJob(job); if(!isRealJob(j)){toast("Enter a valid job number");return;} if(MY_JOBS.includes(j)){toast(j+" is already saved");return;} MY_JOBS.push(j); REMOVED_JOBS.delete(j); markSeenForJob(j); syncUserJobs(); $("jobSearch").value=""; renderAll(); toast("Saved "+j+" to My Jobs"); }
/* The confirm lives in here rather than at the three call sites — the folder's trash button, the
   star on someone else's job list, and the star on a Webduct delivery card. Un-starring is a
   removal too, and it was the easiest one to hit by accident. Keeping the question in one place
   means a fourth caller can't reintroduce a silent one. */
function removeJob(job){
  if(!confirm(`Remove job ${job} from My Jobs?\n\nIts arrivals, rentals and tool rentals aren't deleted — they just stop collecting here. You can save the job again any time.`)) return;
  MY_JOBS=MY_JOBS.filter(j=>j!==job); REMOVED_JOBS.add(job); syncUserJobs(); renderAll(); toast("Removed "+job);
}

/* ---------- Tabs ---------- */
const VALID_VIEWS=["feed","rentals","deliveries","jobs","safety","admin"];
// Arrivals, Rentals and Deliveries share one tab; the caret on it switches between them.
// They stay separate views with separate permissions — condensing the tabs was a UI change,
// not a permissions change, so nobody gains access to a page they were blocked from.
const FEED_GROUP=["feed","rentals","deliveries"];
// Views that still have a tab button of their own. Admin moved to the header.
const TAB_VIEWS=["feed","jobs","safety"];
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
// Which of the three grouped views the shared tab is currently pointed at.
let FEED_GROUP_VIEW="feed";

function setView(name,fromHash){
  if(!VALID_VIEWS.includes(name))name="feed";
  if(name==="jobs" && !fromHash) VIEW_AS=null;   // tapping the My Jobs tab always shows your own
  if(FEED_GROUP.includes(name)) FEED_GROUP_VIEW=name;
  // The grouped tab is "active" for any of its three views, so the bar still shows you where
  // you are when you're on Rentals or Deliveries.
  document.querySelectorAll(".tab[data-view]").forEach(x=>{
    const v=x.dataset.view;
    x.classList.toggle("active", v===name || (v==="feed" && FEED_GROUP.includes(name)));
  });
  syncFeedGroupTab();
  document.querySelectorAll(".view").forEach(x=>x.classList.remove("active"));
  $("view-"+name).classList.add("active");
  window.scrollTo(0,0);
  if(name==="admin")syncAdminView();
  if(name==="jobs")renderJobs();
  if(name==="deliveries")renderDeliveries();
  if(name==="feed")focusPendingArrival();
  if(name==="safety")renderSafety();
  if(!fromHash){ const h="#"+hashForView(name); if(location.hash!==h) history.replaceState(null,"",h); }
}

// Label, count and tick marks on the grouped tab follow whichever of the three you're on.
// The per-view counts (#pillFeed, #pillRent) live inside the dropdown now — that's where they
// are actually useful, since you can see how much is on the other views without switching —
// and the tab carries one pill that mirrors the view you're looking at.
function syncFeedGroupTab(){
  const lab=$("feedGroupLabel"); if(lab) lab.textContent=VIEW_LABELS[FEED_GROUP_VIEW]||"Arrivals";
  const pg=$("pillGroup");
  if(pg){
    // Deliveries is a calendar, not a list — a count there would be meaningless.
    const n=FEED_GROUP_VIEW==="feed"?ARRIVALS.length
      :FEED_GROUP_VIEW==="rentals"?(RENTALS.length+TOOLS.length):null;
    pg.style.display=n===null?"none":"";
    if(n!==null) pg.textContent=n>999?(Math.floor(n/100)/10)+"k":n;
  }
  document.querySelectorAll("[data-groupview]").forEach(b=>
    b.classList.toggle("on", b.dataset.groupview===FEED_GROUP_VIEW));
}

// .tabs scrolls sideways (overflow-x:auto), and a scroll container CLIPS absolutely-positioned
// children — so the menu has to un-clip the bar while it's open or it simply isn't visible.
// Same workaround the tutorial already uses via `body.tut-live .tabs{overflow:visible}`.
function setTabsClip(open){
  const nav=document.querySelector(".tabs");
  if(nav) nav.classList.toggle("menu-open",!!open);
}
function closeFeedGroupMenu(){
  const m=$("feedGroupMenu"), c=$("feedGroupCaret");
  if(m) m.classList.remove("show");
  if(c) c.setAttribute("aria-expanded","false");
  setTabsClip(false);
}
function toggleFeedGroupMenu(){
  const m=$("feedGroupMenu"), c=$("feedGroupCaret"); if(!m) return;
  const open=!m.classList.contains("show");
  m.classList.toggle("show",open);
  if(c) c.setAttribute("aria-expanded",open?"true":"false");
  setTabsClip(open);
}

document.querySelectorAll(".tab[data-view]").forEach(t=>t.addEventListener("click",()=>{
  closeFeedGroupMenu();
  // Tapping the grouped tab goes to whichever of the three you last used, not always Arrivals.
  setView(t.dataset.view==="feed"?FEED_GROUP_VIEW:t.dataset.view);
}));
if($("feedGroupCaret")) $("feedGroupCaret").addEventListener("click",e=>{ e.stopPropagation(); toggleFeedGroupMenu(); });
document.querySelectorAll("[data-groupview]").forEach(b=>b.addEventListener("click",e=>{
  e.stopPropagation(); closeFeedGroupMenu(); setView(b.dataset.groupview);
}));
document.addEventListener("click",e=>{ if(!e.target.closest("#feedGroup")) closeFeedGroupMenu(); });
document.addEventListener("keydown",e=>{ if(e.key==="Escape") closeFeedGroupMenu(); });
if($("btnAdminOpen")) $("btnAdminOpen").addEventListener("click",()=>{ closeFeedGroupMenu(); setView("admin"); });
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
$("mjMonth").addEventListener("change",()=>{ mjSheet(null,false); renderJobs(); });
document.querySelectorAll("#mjSeg button").forEach(b=>b.addEventListener("click",()=>{ mjSeg=b.dataset.seg; document.querySelectorAll("#mjSeg button").forEach(x=>x.classList.toggle("on",x===b)); mjSheet(null,false); refreshMonths(); renderJobs(); }));
document.querySelectorAll("#rentSeg button").forEach(b=>b.addEventListener("click",()=>{ const seg=b.dataset.rentseg; document.querySelectorAll("#rentSeg button").forEach(x=>x.classList.toggle("on",x===b)); $("rentEquipPane").style.display=seg==="equip"?"block":"none"; $("rentToolPane").style.display=seg==="tool"?"block":"none"; }));

/* ---------- Delegated clicks ---------- */
document.addEventListener("click",e=>{
  if(e.target.id==="mjScrim"){ mjSheet(null,false); return; }
  const mu=e.target.closest("[data-moveup]"); if(mu){ e.stopPropagation(); moveJob(mu.dataset.moveup,-1); return; }
  const md=e.target.closest("[data-movedown]"); if(md){ e.stopPropagation(); moveJob(md.dataset.movedown,1); return; }
  const save=e.target.closest("[data-savejob]"); if(save){ const j=save.dataset.savejob; MY_JOBS.includes(j)?removeJob(j):addJob(j); return; }
  const addb=e.target.closest("[data-addjob]"); if(addb){ addJob(addb.dataset.addjob); return; }
  const rem=e.target.closest("[data-removejob]"); if(rem){ e.stopPropagation(); removeJob(rem.dataset.removejob); return; }
  const more=e.target.closest("[data-showmore]"); if(more){ e.stopPropagation(); pageBump(more.dataset.showmore); return; }
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
  const ca=e.target.closest("[data-clearall]");      if(ca){ e.stopPropagation(); clearNotif(); return; }
  const mo=e.target.closest("[data-mjopen]");        if(mo){ e.stopPropagation(); mjSheet(mo.dataset.mjopen,true,mo.dataset.mjfocus||""); return; }
  const mc=e.target.closest("[data-mjclose]");       if(mc){ e.stopPropagation(); mjSheet(null,false); return; }
  const cs=e.target.closest("[data-mjclearsearch]"); if(cs){ $("jobSearch").value=""; renderJobs(); return; }
  const rd=e.target.closest("[data-mjreorderdone]"); if(rd){ reorderMode=false; mjSheet(null,false); renderJobs(); return; }
  // Last in the chain on purpose: the remove, clear and reorder buttons sit inside a job row and
  // are matched above, so they act instead of changing the selection.
  const pick=e.target.closest("[data-mjpick]");
  if(pick){
    if(reorderMode)return;                        // stays first: reorder taps must not close the sheet
    const j=pick.dataset.mjpick; MJ_SEL=(j&&j===MJ_SEL)?"":j;
    mjSheet(null,false); renderJobs();
    if(!matchMedia("(min-width:860px)").matches) window.scrollTo({top:0});
    return;
  }
});
// Keyboard equivalents for the job rows, which are divs so they can hold their own buttons.
document.addEventListener("keydown",e=>{
  const pa=e.key==="Enter"&&e.target.closest&&e.target.closest("[data-pooladd]");
  if(pa){ e.preventDefault(); const v=pa.value; pa.value=""; ptpPoolAdd(pa.dataset.pooladd,v); return; }
  if(e.key==="Escape"&&MJ_SHEET){ mjSheet(null,false); return; }
  if(e.key!=="Enter"&&e.key!==" ")return;
  const open=e.target.closest&&e.target.closest("[data-mjopen]");
  if(open&&open.tagName!=="BUTTON"){ e.preventDefault(); mjSheet(open.dataset.mjopen,true,open.dataset.mjfocus||""); return; }
  const pick=e.target.closest&&e.target.closest("[data-mjpick]");
  if(!pick||reorderMode||pick.tagName==="BUTTON")return;   // native buttons already fire click
  e.preventDefault(); const j=pick.dataset.mjpick; MJ_SEL=(j&&j===MJ_SEL)?"":j;
  mjSheet(null,false); renderJobs();
});

/* ---------- My Jobs add ---------- */
$("jobSearch").addEventListener("input",renderJobs);
$("jobAddBtn").addEventListener("click",()=>{ const v=$("jobSearch").value.trim(); v?addJob(v):toast("Type a job number first"); });
$("jobSearch").addEventListener("keydown",e=>{ if(e.key==="Enter"){const v=$("jobSearch").value.trim(); if(v)addJob(v);} });
$("notifClear").addEventListener("click",clearNotif);

/* ---------- Reorder My Jobs (up/down) ---------- */
$("reorderToggle").addEventListener("click",()=>{
  reorderMode=!reorderMode;
  // On a phone the up/down arrows live in the JOBS sheet, so take the worker straight there.
  if(!matchMedia("(min-width:860px)").matches) mjSheet(reorderMode?"jobs":null,!!reorderMode);
  renderJobs();
});
$("orderReset").addEventListener("click",()=>{ if(!confirm("Put your jobs back in newest-first order?\n\nThe order you arranged by hand is lost.")) return; JOB_ORDER=[]; syncUserJobs(); renderJobs(); toast("Back to newest-first"); });
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
  // The sign-in write below carries lastSeen, so start the throttle window here.
  lastSeenWrite=Date.now(); try{ localStorage.setItem("er_seen_at",String(lastSeenWrite)); }catch(e){}
  if(token){ WD_TOKEN=token; sessionStorage.setItem("wd_token",token); if(typeof wdRenderToken==="function")wdRenderToken(); }
  MY_JOBS=[]; REMOVED_JOBS=new Set(); JOB_ORDER=[]; MJ_SEL=""; userRecordLoaded=false;
  if(fbReady){
    try{
      await setDoc(doc(db,"people",id),{first,last,nameNorm:nameNorm(first,last),email,lastSeen:serverTimestamp(),updatedAt:serverTimestamp()},{merge:true});
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
  // The tutorial no longer opens itself on a first login. It is available any time from the
  // "? Tutorial" button in the header, which is where people looked for it anyway.
}

/* ---------- Access control (basic, not security — an honest gate) ---------- */
// Default rule stays: an @arctic.biz email gets everything, anyone else gets nothing.
// On top of that, each page can be allowed/blocked per person in Manage People.
const VIEW_LABELS={feed:"Arrivals",rentals:"Rentals",jobs:"My Jobs",deliveries:"Deliveries",safety:"Safety",admin:"Admin"};
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
    const grp=$("feedGroup"), adminBtn=$("btnAdminOpen");
    if(!USER){
      lock.style.display="none";
      document.querySelectorAll(".tab[data-view]").forEach(t=>t.style.display="");
      document.querySelectorAll("[data-groupview]").forEach(b=>b.style.display="");
      if(grp) grp.style.display=""; if(adminBtn) adminBtn.style.display="";
      if(nav)nav.style.display=""; return;
    }
    const pm=myPerms()||{};
    let any=false;

    // Admin is a header button now, not a tab.
    if(adminBtn) adminBtn.style.display=pm.admin?"":"none";
    if(pm.admin) any=true;

    // The grouped tab shows if ANY of its three views is allowed, and the menu lists only the
    // allowed ones — so a blocked Rentals stays blocked even though it lost its own tab.
    const groupOk=FEED_GROUP.filter(v=>pm[v]);
    document.querySelectorAll("[data-groupview]").forEach(b=>{
      b.style.display=pm[b.dataset.groupview]?"":"none";
    });
    const caret=$("feedGroupCaret");
    if(caret) caret.style.display=groupOk.length>1?"":"none";   // nothing to switch to
    if(grp) grp.style.display=groupOk.length?"":"none";
    if(groupOk.length){
      any=true;
      if(!pm[FEED_GROUP_VIEW]) FEED_GROUP_VIEW=groupOk[0];
      syncFeedGroupTab();
    }

    document.querySelectorAll(".tab[data-view]").forEach(t=>{
      if(t.dataset.view==="feed") return;                       // handled by the group above
      const ok=!!pm[t.dataset.view]; t.style.display=ok?"":"none"; if(ok)any=true;
    });

    if(nav) nav.style.display=(groupOk.length||pm.jobs||pm.safety)?"":"none";
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
 ["Start in Admin","Everything you log starts on the <b>Admin</b> button up in the header. It's PIN protected — <b>ask your supervisor for the PIN</b> if you don't have it. (We've unlocked it just for this walkthrough.)","#btnAdminOpen","admin",tutGrantAdmin],
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
 ["My Jobs — the one to use","<b>This is the most useful tab in the app.</b> Star ★ a job (or it auto-stars from your orders) and everything for it collects here — no scrolling the whole arrivals list. Everything received on your jobs is right here, newest first. Tap <b>JOBS</b> at the top to pick one job, or <b>ALL</b> to go back to everything. Tap <b>SHOW</b> to switch to Equipment Rentals or Tool Rentals, or to filter by month.","[data-view='jobs']","jobs",()=>tutOpenJobCard("arrivals")],
 ["What's on a card","Here's a card opened up: the photo, where it's stored, who logged it, delivery status, and the buttons — 📷 photo, Copy Name, share, and the 🚚 truck showing whether it's gone out.",".acard.open","jobs",()=>tutOpenJobCard("arrivals")],
 ["Equipment rentals","Flip to <b>Equipment Rentals</b> to see gear rented from a vendor for this job — what it is, the rate, the vendor, and whether it's still out.","#mjSeg","jobs",()=>tutOpenJobCard("rentals")],
 ["Tool rentals","<b>Tool Rentals</b> shows company tools charged to your job — tool #, days out, daily rate, and total. Handy for checking what's still billing to you.","#mjSeg","jobs",()=>tutOpenJobCard("tools")],
 ["The Deliveries calendar","Deliveries now lives under the ▾ on the first tab, next to Arrivals and Rentals. Days show 📦 equipment, 🚚 deliveries, 🆙 pickups. Tap a day, then a job name, to see what's coming and when.","#feedGroupCaret","feed"],
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
    MJ_SEL=TUT_JOB;                       // land on the sample job, not the merged list
    if(typeof EXPANDED_ARR!=="undefined") EXPANDED_ARR.add("demo-a1");
    // Clear filters — a leftover month/search would hide the sample job entirely.
    const ms=$("mjMonth"), ss=$("jobSearch"); if(ms) ms.value=""; if(ss) ss.value="";
    if(seg){ const b=document.querySelector(`#mjSeg button[data-seg='${seg}']`); if(b)b.click(); else mjSeg=seg; }
    if(typeof renderJobs==="function") renderJobs();
    // On a phone #mjSeg lives inside the "What to show" sheet. Open it for the two steps that
    // spotlight it -- and close both sheets for the open-card step, which they would cover.
    const phone=!matchMedia("(min-width:860px)").matches;
    if(phone&&(seg==="rentals"||seg==="tools")) mjSheet("show",true); else mjSheet(null,false);
  }catch(_){}
}
let TUT_LIST=null, TUT_I=0;
function tutClearSpot(){ document.querySelectorAll(".tut-spot").forEach(e=>e.classList.remove("tut-spot")); }
function tutClearDemo(){ const had=TUT_DEMO; TUT_DEMO=false; if(had){ try{ mjSheet(null,false); if(MJ_SEL===TUT_JOB)MJ_SEL=""; EXPANDED_ARR.delete("demo-a1"); }catch(_){} if(typeof renderJobs==="function"){ try{ renderJobs(); }catch(_){} } } }
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
// Re-running the import by hand is an escape hatch for whoever looks after the sheet, not
// something the whole crew needs staring at them. It stays hidden until someone taps the
// "Last updated … · emailed … · N rows" banner, which reveals it; tapping again hides it.
// Deliberately no cursor or hover hint — if you don't already know it's there, you won't
// find it by accident, which is the point.
let ghRevealed=false;
function ghRenderBtn(){
  const b=$("runImportBtn"); if(b) b.style.display=ghRevealed?"block":"none";
}
onActivate($("autoImport"),()=>{ ghRevealed=!ghRevealed; ghRenderBtn(); });
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
  const was=ARRIVALS.find(x=>x.id===delivTarget);
  if(clear) payload={reqDeliv:"",delivered:false,deliveredDate:"",partial:false,deliveryDate:"",deliveredBy:"",deliveredMarkedOn:""};
  else {
    const delivered=$("d_delivered").checked;
    payload={reqDeliv:$("d_req").value||"",delivered,deliveredDate:delivered?($("d_date").value||todayIso()):"",partial:$("d_partial").checked,deliveryDate:delivered?($("d_date").value||todayIso()):""};
    // Stamp only on the transition. Re-saving to fix a typo in the delivery date must not
    // rewrite who marked it -- that record is the point of keeping it.
    if(delivered && !(was&&was.delivered)) payload={...payload,deliveredBy:whoLabel(),deliveredMarkedOn:todayIso()};
    else if(!delivered) payload={...payload,deliveredBy:"",deliveredMarkedOn:""};
  }
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
    // Local calendar day, not UTC. toISOString() rolls over at 5pm Pacific, so anything
    // checked off in the evening was being dated tomorrow. fmtDateKey/todayIso read the
    // local day, matching what the manual delivery modal already writes.
    let schedDate=""; if(schedIso){ const d=new Date(schedIso); if(!isNaN(d)) schedDate=fmtDateKey(d); }
    if(!schedDate) schedDate=todayIso();
    try{ await setDoc(doc(db,"arrivals",arrivalId),{delivered:true,deliveredDate:schedDate,deliveredBy:whoLabel(),deliveredMarkedOn:todayIso(),updatedAt:serverTimestamp()},{merge:true}); }catch(e){ console.error(e); }
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
async function dismissShare(id){
  const s=SHARES.find(x=>x.id===id);
  if(!confirm(`Dismiss ${s&&s.fromName?s.fromName+"'s":"this"} shared job${s&&s.jobNumber?" "+s.jobNumber:""}?\n\nThe invite goes away for good — they'd have to share it again.`)) return;
  if(fbReady){ try{ await setDoc(doc(db,"shares",id),{status:"dismissed"},{merge:true}); }catch(e){console.error(e);} } renderJobs();
}

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
    // Green while they're around today, grey once it's been a week, plain if they never opened it.
    const days=p.lastSeen?(Date.now()-p.lastSeen)/86400000:null;
    const seenCls=days===null?"never":days<1?"today":days<7?"week":"stale";
    return `<div class="pr ${open?'open':''}">
      <div class="pr-head" data-popen="${esc(p.id)}">
        <span class="ps-av" style="background:var(--steel)">${esc(((p.first[0]||"")+(p.last[0]||"")).toUpperCase())}</span>
        <div style="flex:1;min-width:0">
          <div class="pr-name">${esc(p.first+" "+p.last)} ${tag}</div>
          <div class="pr-sub">${esc(sub)}${p.email?` · ${esc(p.email)}`:" · no email"}</div>
          <div class="pr-seen ${seenCls}"><i></i>${esc(lastSeenText(p.lastSeen))}</div>
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
        <div class="pr-lbl" style="margin-top:12px">Last opened the website</div>
        <div class="pr-seenfull">${p.lastSeen?esc(new Date(p.lastSeen).toLocaleString()):"Never — this person hasn't opened the site on any device."}</div>
        <div class="pr-hash">#${esc(personalHashFor(p))}</div>
      </div>`:""}
    </div>`;
  };
  const week=sorted.filter(p=>p.lastSeen && Date.now()-p.lastSeen < 7*86400000).length;
  const never=sorted.filter(p=>!p.lastSeen).length;
  list.innerHTML=`<div style="font-family:'Barlow Condensed';font-weight:700;letter-spacing:.04em;text-transform:uppercase;font-size:13px;color:var(--steel);margin:0 0 4px">${sorted.length} ${sorted.length===1?"person":"people"} · ${week} this week${never?` · ${never} never`:""}</div>
    <div style="font-size:11.5px;color:var(--steel);margin-bottom:10px">Tap a name to set which pages they can open. The line under each name is the last time they opened the website.</div>`
    + (sorted.length?sorted.map(row).join(""):`<div class="sub-empty">No people yet. Add someone above.</div>`);
}
onActivate($("pp_add"),async()=>{ const f=$("pp_first").value.trim(),l=$("pp_last").value.trim(),em=$("pp_email").value.trim(); if(!f||!l){toast("Enter first and last name");return;} if(em&&!/^\S+@\S+\.\S+$/.test(em)){toast("Enter a valid email");return;} if(!fbReady){toast("No connection");return;} const id=personId(f,l); try{ await setDoc(doc(db,"people",id),{first:f,last:l,nameNorm:nameNorm(f,l),email:em,updatedAt:serverTimestamp()},{merge:true}); $("pp_first").value="";$("pp_last").value="";$("pp_email").value=""; toast("Saved "+f); setTimeout(renderPeople,400); }catch(e){toast("Failed: "+(e.code||e.message));} });
document.addEventListener("click",async e=>{ const sv=e.target.closest("[data-psave]"); if(sv){ const id=sv.dataset.psave; const inp=document.querySelector(`[data-pemail="${id}"]`); const em=inp?inp.value.trim():""; if(em&&!/^\S+@\S+\.\S+$/.test(em)){toast("Enter a valid email");return;} if(!fbReady){toast("No connection");return;} try{ await setDoc(doc(db,"people",id),{email:em,updatedAt:serverTimestamp()},{merge:true}); toast("Email saved"); }catch(err){toast("Failed");} } });

/* ---------- Deliveries page ---------- */
$("delSearch").addEventListener("input",renderDeliveries); $("delClr").addEventListener("click",()=>{$("delSearch").value="";renderDeliveries();});
/* "Jaren E." -- enough to know who without a full name eating the row. Falls back to a plain
   marker rather than an empty string, so a stamp always says something. */
function whoLabel(){
  if(!USER) return "someone";
  const f=(USER.first||"").trim(), l=(USER.last||"").trim();
  return (f+(l?" "+l[0]+".":"")).trim()||"someone";
}
// "marked by Jaren E., 8/7/26" -- who pressed the button and when they pressed it, which is
// separate from the delivery date itself and is the part nobody can reconstruct afterwards.
function markedByChip(r){
  if(!r.delivered || !(r.deliveredBy||r.deliveredMarkedOn)) return "";
  const on=r.deliveredMarkedOn?shortDate(r.deliveredMarkedOn):"";
  return `<span class="m markedby">marked by ${esc(r.deliveredBy||"someone")}${on?", "+esc(on):""}</span>`;
}
function shortDate(iso){
  const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso||""));
  return m?`${+m[2]}/${+m[3]}/${m[1].slice(2)}`:String(iso||"");
}
function delivIconsFor(r){
  const hasPhoto=!!r.photoBy;
  const cam=`<button class="mini-btn cam ${hasPhoto?'has':''}" data-cam="${esc(r.id)}" title="${hasPhoto?'Photo by '+esc(r.photoBy):'Add photo'}"><svg width="17" height="17" viewBox="0 0 24 24" fill="${hasPhoto?'currentColor':'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="3.5"></circle></svg></button>`;
  const shr=`<button class="mini-btn" data-share="${esc(r.id)}" title="Share"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"></line><line x1="15.4" y1="6.5" x2="8.6" y2="10.5"></line></svg></button>`;
  const deliv=`<button class="mini-btn deliv-btn ${r.delivered?'set':''}" data-deliv="${esc(r.id)}" title="Edit delivery"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="15" height="13"></rect><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"></polygon><circle cx="5.5" cy="18.5" r="2.5"></circle><circle cx="18.5" cy="18.5" r="2.5"></circle></svg></button>`;
  const cpy=`<button class="mini-btn ac-copy" data-copyname="${esc(r.description||"")}" title="Copy arrival name">Copy Name</button>`;
  return cpy+cam+shr+deliv;
}
function deliveryRow(r){ const job=normJob(r.jobNumber); return `<div class="acard open" data-type="arrival" data-id="${esc(r.id)}"><div class="acard-head" style="cursor:default"><div class="ac-job"><span class="jobbadge ${isRealJob(job)?'':'na'}">${esc(isRealJob(job)?job:"—")}</span></div><div class="ac-name">${esc(r.jobName)||'<span style="color:var(--steel-light)">No job name</span>'}</div><div class="ac-icons">${delivIconsFor(r)}</div><div class="ac-desc">${esc(r.description)||""}</div><div class="ac-foot">${r.delivered?`<span class="m deliv">✓ Delivered${r.deliveredDate?" "+esc(longDate(r.deliveredDate).split(",")[0]):""}</span>`+markedByChip(r):`<span class="m reqd">Requested ${esc(longDate(r.reqDeliv).split(",")[0])}</span>`}${r.partial?'<span class="m partial">⚠ Partial</span>':""}${r.storageLocation?`<span class="m loc">📍 ${esc(r.storageLocation)}</span>`:""}${r.photoBy?`<span class="m loc">📷 ${esc(r.photoBy)}</span>`:""}</div></div></div>`; }

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
    // Local calendar day, not UTC. toISOString() rolls over at 5pm Pacific, so anything
    // checked off in the evening was being dated tomorrow. fmtDateKey/todayIso read the
    // local day, matching what the manual delivery modal already writes.
    let schedDate=""; if(schedIso){ const d=new Date(schedIso); if(!isNaN(d)) schedDate=fmtDateKey(d); }
    if(!schedDate) schedDate=todayIso();
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
  // Delivered is the one list here with no natural ceiling -- an arrival stays delivered forever,
  // so without a cap this section is the whole history of the company, rendered every time.
  const dsig=q+"\u0000"+calShipFilter;
  if(dsig!==delSig){ delSig=dsig; delShown=PAGE_STEP; }
  if(done.length) html+=`<div class="del-section"><h3>Delivered <span class="cnt">${done.length}</span></h3>`
    +done.slice(0,delShown).map(deliveryRow).join("")+moreBtn("del",delShown,done.length)+`</div>`;
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
function closeModal(id){ $(id).classList.remove("show"); document.body.style.overflow=MJ_SHEET?"hidden":""; }
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
/* ---------- Safety tab ---------- */
// Everything here is read-only for the crew; Admin uploads are the only writers. The lists are
// deliberately shown in full rather than filtered to the signed-in person — this is the same
// information as the training board on the shop wall.

const SF_SOON_DAYS=90;   // "expiring soon" horizon

// `ignored` is set by hand in Admin to silence a warning that doesn't apply — someone who has
// left, a certification that was renewed off-system, a row the report gets wrong. Ignored rows
// keep their dates but stop counting as expired or due anywhere.
const sfSilenced=r=>!!(r&&(r.silenced||r.ignored));
function sfExpiryState(iso,rec){
  if(sfSilenced(rec)) return "silenced";
  if(!iso) return "none";
  const today=todayIso();
  if(iso<today) return "expired";
  const d=new Date(iso+"T00:00:00"), n=new Date(today+"T00:00:00");
  return Math.round((d-n)/86400000)<=SF_SOON_DAYS ? "soon" : "ok";
}
function sfBadge(r){
  const st=sfExpiryState(r.expires,r);
  if(st==="silenced") return `<span class="sf-badge none" title="Silenced in Admin — not counted as expired">Silenced</span>`;
  if(st==="expired") return `<span class="sf-badge bad">Expired ${esc(longDate(r.expires))}</span>`;
  if(st==="soon")    return `<span class="sf-badge warn">Expires ${esc(longDate(r.expires))}</span>`;
  if(st==="ok")      return `<span class="sf-badge ok">Valid to ${esc(longDate(r.expires))}</span>`;
  return `<span class="sf-badge none">No expiry</span>`;
}
function sfMetaLine(key,noun){
  const m=SF_META&&SF_META[key];
  if(!m||!m.count) return `Nothing uploaded yet — an admin can add it from the Admin tab.`;
  const when=m.updatedAt&&m.updatedAt.toDate?m.updatedAt.toDate():null;
  const by=m.by?` by ${esc(m.by)}`:"";
  return `${m.count.toLocaleString()} ${noun}${when?` · updated ${longDate(fmtDateKey(when))}`:""}${by}`;
}
function sfEmpty(ico,title,msg){ return `<div class="empty"><div class="ico">${ico}</div><h3>${esc(title)}</h3><p>${esc(msg)}</p></div>`; }
function sfErrBox(what,coll,e){
  const denied=/permission|insufficient/i.test(String((e&&e.code)||(e&&e.message)||e));
  return `<div class="empty"><div class="ico">${denied?"\uD83D\uDD12":"\u26A0\uFE0F"}</div><h3>Couldn't load ${esc(what)}</h3>`
    +`<p>${denied
      ? `Firestore refused the read. Add a rule for <code>${esc(coll)}</code>, then reload.`
      : `${esc(String((e&&e.message)||e))}`}</p></div>`;
}
function sfQuery(id){ const el=$(id); return el?el.value.trim().toLowerCase():""; }

/* ---------- Safety: editing by hand (admin) ----------
   The uploads are a bulk starting point, not the only way in. Everything the spreadsheet can
   express is editable here: add or correct a row, ignore an expiry warning that doesn't apply,
   or remove a person outright. Edits live in the same collections as the imports, and an
   import still replaces a category wholesale — but not over a hand edit without asking. Rows
   saved here are stamped source:"admin-edit", and sfConflicts flags them before any write, so
   the next upload that would change or delete one stops for an answer (replace / keep once /
   keep permanently / cancel). "Keep permanently" sets `pinned`, which sfReplace skips outright
   from then on. Silenced flags need none of this: the parsers never emit the field and every
   import write is {merge:true}, so silence survives on its own. */

const SF_FIELDS={
  points:[
    {k:"name", l:"Name", t:"text", req:true},
    {k:"shirt",l:"Shirt size", t:"text"},
    {k:"start",l:"Starting points", t:"number"},
    {k:"used", l:"Points used", t:"number", hint:"Stored negative, the way the report does it (-4500)."},
    {k:"extra",l:"Extra points", t:"number"},
    {k:"total",l:"Total", t:"number", hint:"This is the number the list shows."},
  ],
  training:[
    {k:"name",      l:"Name", t:"text", req:true},
    {k:"course",    l:"Course", t:"text", req:true},
    {k:"instructor",l:"Instructor", t:"text"},
    {k:"date",      l:"Date of training", t:"date"},
    {k:"expires",   l:"Expires", t:"date", hint:"Leave blank if it doesn't expire."},
    {k:"notes",     l:"Notes", t:"text"},
    {k:"silenced",  l:"Silence the expiry warning for this row", t:"check"},
  ],
  drug:[
    {k:"name",   l:"Name", t:"text", req:true},
    {k:"tested", l:"Test date", t:"date"},
    {k:"expires",l:"Expiration date", t:"date"},
    {k:"silenced",l:"Silence the expiry warning for this card", t:"check"},
  ],
  sds:[
    {k:"product",  l:"Chemical / product name", t:"text", req:true},
    {k:"use",      l:"Product use", t:"text"},
    {k:"vendor",   l:"Vendor / MFG", t:"text"},
    {k:"issueDate",l:"Issue date", t:"date"},
    {k:"dept",     l:"Arctic dept", t:"text"},
    {k:"pages",    l:"# of pages", t:"text"},
    {k:"record",   l:"Record #", t:"text"},
  ],
};
const SF_PIN_FIELD={k:"pinned",l:"Keep this row through future uploads",t:"check",hint:"Pinned rows are skipped by imports without asking."};
const SF_KIND_LABEL={points:"points entry",training:"training record",drug:"drug card",sds:"SDS sheet"};
let SF_EDIT={kind:null,id:null};

function sfAdminActs(kind,id,rec){
  if(!adminUnlocked) return "";
  // Silencing is the light-touch alternative to editing dates or deleting somebody: the row
  // stays exactly as imported, it just stops being counted as expired.
  const canSilence=(kind==="training"||kind==="drug");
  const on=canSilence&&sfSilenced(rec);
  return `<div class="sf-acts">
    ${canSilence?`<button class="mini-btn ${on?"unsilence":"silence"}" data-sfsilence="${kind}:${esc(id)}:${on?0:1}">${on?"🔔 Unsilence":"🔕 Silence warning"}</button>`:""}
    <button class="mini-btn edit" data-sfedit="${kind}:${esc(id)}" title="Edit">✎ Edit</button>
    <button class="mini-btn del" data-sfdel="${kind}:${esc(id)}" title="Delete">🗑 Delete</button>
  </div>`;
}

async function sfSetSilenced(kind,id,on){
  if(!fbReady){ toast("No Firebase connection"); return; }
  try{
    // source stays whatever it was; silencing alone shouldn't make a row look hand-authored.
    await setDoc(doc(db,sfColl(kind),id),{silenced:on,ignored:on,updatedAt:serverTimestamp()},{merge:true});
    toast(on?"Warning silenced":"Warning back on");
  }catch(e){ console.error(e); toast("Couldn't save: "+(e.code||e.message)); }
}
function sfAddBtn(kind){
  if(!adminUnlocked) return "";
  return `<button class="sf-add" data-sfadd="${kind}">+ Add ${esc(SF_KIND_LABEL[kind])}</button>`;
}
function sfRecord(kind,id){
  const src={points:SF_POINTS,training:SF_TRAINING,drug:SF_DRUG,sds:SF_SDS}[kind]||[];
  return src.find(x=>x.id===id)||null;
}
function sfColl(kind){ return SF_UPLOADS[kind].coll; }

function sfOpenEdit(kind,id){
  SF_EDIT={kind,id:id||null};
  const rec=id?sfRecord(kind,id):{};
  $("sfEditTitle").textContent=(id?"Edit ":"Add ")+SF_KIND_LABEL[kind];
  $("sfEditFields").innerHTML=SF_FIELDS[kind].concat([SF_PIN_FIELD]).map(f=>{
    const v=rec&&rec[f.k]!=null?rec[f.k]:"";
    if(f.t==="check") return `<label class="sf-check"><input type="checkbox" id="sfF_${f.k}" ${v?"checked":""}><span>${esc(f.l)}</span></label>`;
    return `<div class="field"><label>${esc(f.l)}${f.req?" *":""}</label>
      <input id="sfF_${f.k}" type="${f.t}" value="${esc(String(v))}" autocomplete="off">
      ${f.hint?`<div class="hint">${esc(f.hint)}</div>`:""}</div>`;
  }).join("");
  $("sfEditDelete").style.display=id?"block":"none";
  $("sfEditHint").innerHTML="Saved by hand, this row is protected: an upload that would change or remove it asks you first. Tick <b>Keep this row through future uploads</b> to skip the question and never let an import touch it.";
  openModal("sfEditModal");
}

async function sfSaveEdit(){
  const {kind,id}=SF_EDIT; if(!kind) return;
  if(!fbReady){ toast("No Firebase connection"); return; }
  const data={};
  for(const f of SF_FIELDS[kind].concat([SF_PIN_FIELD])){
    const el=$("sfF_"+f.k); if(!el) continue;
    if(f.t==="check") data[f.k]=el.checked;
    else if(f.t==="number") data[f.k]=el.value===""?0:Number(el.value);
    else data[f.k]=el.value.trim();
    if(f.req && !String(data[f.k]||"").trim()){ toast(f.l+" is required"); el.focus(); return; }
  }
  // Same id scheme as the importers, so a hand-added row and the imported one for the same
  // person/course collapse together instead of both showing.
  if("silenced" in data) data.ignored=data.silenced;
  const newId = kind==="points" ? makeId(["sfp",data.name])
    : kind==="training" ? makeId(["sft",data.name,data.course,data.date])
    : kind==="drug" ? makeId(["sfd",data.name.toLowerCase().replace(/\s+/g," ")])
    : makeId(["sds",data.record||data.product,data.product]);
  try{
    await setDoc(doc(db,sfColl(kind),newId),{...data,source:"admin-edit",updatedAt:serverTimestamp()},{merge:true});
    // A rename changes the id, so drop the row it replaced rather than leaving a twin.
    if(id && id!==newId) await deleteDoc(doc(db,sfColl(kind),id));
    closeModal("sfEditModal"); toast(id?"Saved":"Added");
  }catch(e){ console.error(e); toast("Couldn't save: "+(e.code||e.message)); }
}

async function sfDeleteEdit(fromModal){
  const {kind,id}=SF_EDIT; if(!kind||!id) return;
  const rec=sfRecord(kind,id);
  const label=rec?(rec.name||rec.product||id):id;
  if(!confirm(`Delete this ${SF_KIND_LABEL[kind]}:\n\n${String(label).slice(0,120)}\n\nThis can't be undone.`)) return;
  try{
    await deleteDoc(doc(db,sfColl(kind),id));
    if(fromModal) closeModal("sfEditModal");
    toast("Deleted");
  }catch(e){ console.error(e); toast("Delete failed: "+(e.code||e.message)); }
}

// Remove a person from the training list entirely — every course they hold, and their drug
// card. Used when somebody leaves; otherwise their expired rows nag forever.
async function sfDeletePerson(name){
  const recs=SF_TRAINING.filter(r=>String(r.name||"").trim()===name);
  const card=SF_DRUG.find(r=>String(r.name||"").trim().toLowerCase()===name.toLowerCase());
  const bits=[`${recs.length} training record${recs.length===1?"":"s"}`];
  if(card) bits.push("their drug card");
  if(!confirm(`Remove ${name} completely?\n\nThis deletes ${bits.join(" and ")}.\n\nThis can't be undone.`)) return;
  try{
    let batch=writeBatch(db),n=0;
    for(const r of recs){ batch.delete(doc(db,"safetyTraining",r.id)); if(++n>=400){ await batch.commit(); batch=writeBatch(db); n=0; } }
    if(card){ batch.delete(doc(db,"safetyDrugCards",card.id)); n++; }
    if(n) await batch.commit();
    SF_TRAIN_OPEN.delete(name);
    toast(`Removed ${name}`);
  }catch(e){ console.error(e); toast("Couldn't remove: "+(e.code||e.message)); }
}

document.addEventListener("click",e=>{
  const a=e.target.closest("[data-sfadd]");
  if(a){ e.stopPropagation(); sfOpenEdit(a.dataset.sfadd,null); return; }
  const ed=e.target.closest("[data-sfedit]");
  if(ed){ e.stopPropagation(); const i=ed.dataset.sfedit.indexOf(":"); sfOpenEdit(ed.dataset.sfedit.slice(0,i),ed.dataset.sfedit.slice(i+1)); return; }
  const dl=e.target.closest("[data-sfdel]");
  if(dl){ e.stopPropagation(); const i=dl.dataset.sfdel.indexOf(":"); SF_EDIT={kind:dl.dataset.sfdel.slice(0,i),id:dl.dataset.sfdel.slice(i+1)}; sfDeleteEdit(false); return; }
  const sl=e.target.closest("[data-sfsilence]");
  if(sl){ e.stopPropagation(); const [k,i,v]=sl.dataset.sfsilence.split(":"); sfSetSilenced(k,i,v==="1"); return; }
  const rp=e.target.closest("[data-sfdelperson]");
  if(rp){ e.stopPropagation(); sfDeletePerson(rp.dataset.sfdelperson); return; }
});
if($("sfEditSave")) $("sfEditSave").addEventListener("click",sfSaveEdit);
if($("sfEditDelete")) $("sfEditDelete").addEventListener("click",()=>sfDeleteEdit(true));

function renderSafety(){
  if(!document.getElementById("view-safety")) return;
  renderSfPoints(); renderSfTraining(); renderSfSds(); renderSfDrug();
}

function renderSfDrug(){
  const list=$("sfDrugList"), meta=$("sfDrugMeta"); if(!list) return;
  if(meta) meta.textContent=sfMetaLine("drug","current cards");
  if(SF_ERR.drug){ list.innerHTML=sfErrBox("drug cards","safetyDrugCards",SF_ERR.drug); return; }
  if(!SF_DRUG.length){ list.innerHTML=sfEmpty("🪪","No drug cards loaded","They come in on the Arctic Training Matrix workbook — upload it from the Admin tab."); return; }
  const q=sfQuery("sfDrugSearch");
  let rows=SF_DRUG.filter(r=>{
    if(q && !String(r.name||"").toLowerCase().includes(q)) return false;
    const st=sfExpiryState(r.expires,r);
    if(SF_DRUG_FILTER==="expiring") return st==="soon";
    if(SF_DRUG_FILTER==="expired")  return st==="expired";
    if(SF_DRUG_FILTER==="silenced") return st==="silenced";
    return true;
  });
  const rank={expired:0,soon:1,ok:2,none:3,silenced:4};
  rows.sort((a,b)=>(rank[sfExpiryState(a.expires,a)]-rank[sfExpiryState(b.expires,b)])
    || String(a.expires||"").localeCompare(String(b.expires||""))
    || String(a.name||"").localeCompare(String(b.name||"")));
  const counts={expired:0,soon:0,silenced:0};
  SF_DRUG.forEach(r=>{ const s=sfExpiryState(r.expires,r); if(counts[s]!==undefined) counts[s]++; });
  document.querySelectorAll("[data-drugfilter]").forEach(b=>{
    const k=b.dataset.drugfilter;
    b.classList.toggle("active",k===SF_DRUG_FILTER);
    const n=k==="expiring"?counts.soon:k==="expired"?counts.expired:k==="silenced"?counts.silenced:0;
    b.textContent=(k==="all"?"All":k==="expiring"?"Expiring soon":k==="expired"?"Expired":"Silenced")+(n?` (${n})`:"");
  });
  if(!rows.length){ list.innerHTML=sfEmpty("🔍","Nothing here","No drug cards match that filter."); return; }
  // One line per person, matching Training and SDS — the tested date rides on the same row.
  list.innerHTML=sfAddBtn("drug")+`<div class="sf-list">`+rows.map(r=>{
    const badge=sfBadge(r);
    const open=SF_DRUG_OPEN.has(r.id);
    return `<div class="sf-grp${open?" open":""}">
      <button class="sf-lrow${adminUnlocked?"":" static"}" ${adminUnlocked?`data-sfdrug="${esc(r.id)}"`:""}>
        ${adminUnlocked?`<span class="sf-chev">›</span>`:""}
        <span class="sf-lname">${esc(r.name||"—")}</span>
        ${r.tested?`<span class="sf-ltested">${esc(longDate(r.tested))}</span>`:""}
        ${badge}
      </button>
      ${open?`<div class="sf-body"><div class="sf-crs">${sfAdminActs("drug",r.id,r)}</div></div>`:""}
    </div>`;
  }).join("")+`</div>`;
}

function renderSfPoints(){
  const list=$("sfPointsList"), meta=$("sfPointsMeta"); if(!list) return;
  if(meta) meta.textContent=sfMetaLine("points","people");
  if(SF_ERR.points){ list.innerHTML=sfErrBox("safety points","safetyPoints",SF_ERR.points); return; }
  if(!SF_POINTS.length){ list.innerHTML=sfEmpty("📊","No safety points loaded","Upload the Safety Point Program totals PDF from the Admin tab."); return; }
  const q=sfQuery("sfPointsSearch");
  const rows=SF_POINTS.filter(r=>!q||String(r.name||"").toLowerCase().includes(q))
    .sort((a,b)=>(b.total||0)-(a.total||0));
  if(!rows.length){ list.innerHTML=sfEmpty("🔍","No match",`Nobody matches “${sfQuery("sfPointsSearch")}”.`); return; }
  list.innerHTML=sfAddBtn("points")+`<div class="sf-list">`+rows.map(r=>{
    const open=SF_PTS_OPEN.has(r.id);
    const awards=r.awards&&typeof r.awards==="object"?Object.entries(r.awards).filter(([,v])=>v):[];
    return `<div class="sf-grp${open?" open":""}">
      <button class="sf-lrow" data-sfpoint="${esc(r.id)}">
        <span class="sf-chev">›</span>
        <span class="sf-lname">${esc(r.name||"—")}</span>
        ${r.shirt?`<span class="sf-shirt">${esc(String(r.shirt).toUpperCase())}</span>`:""}
        <span class="sf-lpts">${(r.total||0).toLocaleString()}</span>
      </button>
      ${open?`<div class="sf-body"><div class="sf-crs">
        <div class="sf-sub">
          <span>Start <b>${(r.start||0).toLocaleString()}</b></span>
          ${awards.length?`<span>Earned <b>${awards.reduce((s,[,v])=>s+(Number(v)||0),0).toLocaleString()}</b> over ${awards.length} award${awards.length===1?"":"s"}</span>`:""}
          ${r.used?`<span class="sf-neg">Used <b>${Math.abs(Number(r.used)).toLocaleString()}</b></span>`:""}
          ${r.extra?`<span>Extra <b>${Number(r.extra).toLocaleString()}</b></span>`:""}
        </div>
        ${awards.length?`<div class="sf-awards">${awards.map(([k,v])=>`<span class="sf-award"><i>${esc(k)}</i>${Number(v).toLocaleString()}</span>`).join("")}</div>`:""}
        ${sfAdminActs("points",r.id,r)}
      </div></div>`:""}
    </div>`;
  }).join("")+`</div>`;
}

// Grouped by person, one dense line each, so a 160-name roster is scannable on a phone.
// Tapping a name opens that person's courses.
function renderSfTraining(){
  const list=$("sfTrainList"), meta=$("sfTrainMeta"); if(!list) return;
  if(meta) meta.textContent=sfMetaLine("training","records");
  if(SF_ERR.training){ list.innerHTML=sfErrBox("training records","safetyTraining",SF_ERR.training); return; }
  if(!SF_TRAINING.length){ list.innerHTML=sfEmpty("🎓","No training records loaded","Upload the Arctic Training Matrix workbook from the Admin tab."); return; }
  const q=sfQuery("sfTrainSearch");

  const people=new Map();
  for(const r of SF_TRAINING){
    const key=String(r.name||"—").trim();
    if(!people.has(key)) people.set(key,[]);
    people.get(key).push(r);
  }
  const rank={expired:0,soon:1,ok:2,none:3,silenced:4};
  let groups=[...people.entries()].map(([name,recs])=>{
    const counts={expired:0,soon:0,ok:0,none:0,silenced:0};
    recs.forEach(r=>counts[sfExpiryState(r.expires,r)]++);
    const worst=counts.expired?"expired":counts.soon?"soon":counts.ok?"ok":"none";
    recs.sort((a,b)=>rank[sfExpiryState(a.expires,a)]-rank[sfExpiryState(b.expires,b)]
      || String(b.date||"").localeCompare(String(a.date||"")));
    return {name,recs,counts,worst};
  });

  // Chip counts are per-PERSON here, matching what the list shows.
  const pc={expired:0,soon:0,silenced:0};
  groups.forEach(g=>{ if(g.counts.expired)pc.expired++; else if(g.counts.soon)pc.soon++; if(g.counts.silenced)pc.silenced++; });
  document.querySelectorAll("[data-trainfilter]").forEach(b=>{
    const k=b.dataset.trainfilter;
    b.classList.toggle("active",k===SF_TRAIN_FILTER);
    const n=k==="expiring"?pc.soon:k==="expired"?pc.expired:k==="silenced"?pc.silenced:0;
    b.textContent=(k==="all"?"All":k==="expiring"?"Expiring soon":k==="expired"?"Expired":"Silenced")+(n?` (${n})`:"");
  });

  groups=groups.filter(g=>{
    if(SF_TRAIN_FILTER==="expiring" && !g.counts.soon) return false;
    if(SF_TRAIN_FILTER==="expired"  && !g.counts.expired) return false;
    if(SF_TRAIN_FILTER==="silenced" && !g.counts.silenced) return false;
    if(!q) return true;
    return g.name.toLowerCase().includes(q)
      || g.recs.some(r=>[r.course,r.instructor,r.notes].some(v=>String(v||"").toLowerCase().includes(q)));
  });
  groups.sort((a,b)=>rank[a.worst]-rank[b.worst] || a.name.localeCompare(b.name));
  if(!groups.length){ list.innerHTML=sfEmpty("🔍","Nothing here","Nobody matches that search or filter."); return; }

  list.innerHTML=sfAddBtn("training")+`<div class="sf-list">`+groups.map(g=>{
    const open=SF_TRAIN_OPEN.has(g.name);
    const tag=g.counts.expired?`<span class="sf-tag bad">${g.counts.expired} expired</span>`
      :g.counts.soon?`<span class="sf-tag warn">${g.counts.soon} due</span>`:"";
    return `<div class="sf-grp${open?" open":""}">
      <button class="sf-lrow" data-sfperson="${esc(g.name)}">
        <span class="sf-chev">›</span>
        <span class="sf-lname">${esc(g.name)}</span>
        ${tag}
        <span class="sf-lcount">${g.recs.length}</span>
      </button>
      ${open?`<div class="sf-body">${g.recs.map(r=>{
        const badge=sfBadge(r);
        return `<div class="sf-crs">
          <div class="sf-crs-top"><span class="sf-crs-name">${esc(r.course||"—")}</span>${badge}</div>
          <div class="sf-sub">${r.date?`<span>Trained <b>${esc(longDate(r.date))}</b></span>`:""}${r.instructor?`<span>By <b>${esc(r.instructor)}</b></span>`:""}${r.notes?`<span>${esc(r.notes)}</span>`:""}</div>
          ${sfAdminActs("training",r.id,r)}
        </div>`;
      }).join("")}${adminUnlocked?`<div class="sf-acts person"><button class="mini-btn del" data-sfdelperson="${esc(g.name)}">🗑 Remove ${esc(g.name)} completely</button></div>`:""}</div>`:""}
    </div>`;
  }).join("")+`</div>`;
}

// Dense alphabetical list; tap a chemical for its vendor, use, issue date and page count.
function renderSfSds(){
  const list=$("sfSdsList"), meta=$("sfSdsMeta"); if(!list) return;
  if(meta) meta.textContent=sfMetaLine("sds","sheets");
  if(SF_ERR.sds){ list.innerHTML=sfErrBox("SDS inventory","safetySds",SF_ERR.sds); return; }
  if(!SF_SDS.length){ list.innerHTML=sfEmpty("🧪","No SDS inventory loaded","Upload the Safety Data Sheet inventory workbook from the Admin tab."); return; }
  const q=sfQuery("sfSdsSearch");
  const rows=SF_SDS.filter(r=>!q||[r.product,r.vendor,r.use,r.dept].some(v=>String(v||"").toLowerCase().includes(q)))
    .sort((a,b)=>String(a.product||"").localeCompare(String(b.product||"")));
  if(!rows.length){ list.innerHTML=sfEmpty("🔍","No match",`Nothing matches “${sfQuery("sfSdsSearch")}”.`); return; }
  list.innerHTML=sfAddBtn("sds")+`<div class="sf-list">`+rows.map(r=>{
    const open=SF_SDS_OPEN.has(r.id);
    return `<div class="sf-grp${open?" open":""}">
      <button class="sf-lrow" data-sfsds="${esc(r.id)}">
        <span class="sf-chev">›</span>
        <span class="sf-lname">${esc(r.product||"—")}</span>
        ${r.dept?`<span class="sf-dept">${esc(r.dept)}</span>`:""}
      </button>
      ${open?`<div class="sf-body"><div class="sf-crs"><div class="sf-sub">
        ${r.use?`<span>${esc(r.use)}</span>`:""}
        ${r.vendor?`<span>Vendor <b>${esc(r.vendor)}</b></span>`:""}
        ${r.issueDate?`<span>Issued <b>${esc(longDate(r.issueDate))}</b></span>`:""}
        ${r.pages?`<span>${esc(String(r.pages))} pages</span>`:""}
        ${r.record?`<span>Record <b>#${esc(String(r.record))}</b></span>`:""}
      </div>${sfAdminActs("sds",r.id,r)}</div></div>`:""}
    </div>`;
  }).join("")+`</div>`;
}

/* ---------- Pre-Task Plans ----------
   Two templates behind one renderer; see ptp.js for the specs and the PDF. Everything here is
   wiring: pick a template, keep what was typed, hand it to the PDF writer. */
let PTP_KIND=(()=>{ try{ return localStorage.getItem("ptp_kind")==="arch"?"arch":"standard"; }catch(e){ return "standard"; } })();
let PTP_DATA=null, ptpSaveTimer=null;
/* The shared pool of extra questions and checklist items, in one Firestore document so that
   adding one on a phone in the field puts it on everyone else's form too. Shape:
   { standard:{questions:[..],circle:[..]}, arch:{...} } */
let PTP_POOL={}, PTP_ATTS=[];

function ptpTpl(){ return PTP_TEMPLATES[PTP_KIND]||PTP_TEMPLATES.standard; }
function ptpSavedNote(msg,bad){ const el=$("ptpSaved"); if(!el)return; el.textContent=msg||""; el.classList.toggle("bad",!!bad); }
// One place that both persists and reports, so a failed write can never be reported as "Saved"
// (private browsing and a full quota both throw, and losing a plan silently is the worst outcome).
function ptpPersist(note){
  const ok=ptpSave(ptpTpl(),PTP_DATA);
  ptpSavedNote(ok?(note||"Saved"):"NOT saved — this device is out of storage",!ok);
  return ok;
}

function renderPtp(){
  const wrap=$("ptpForm"); if(!wrap) return;
  const t=ptpTpl();
  if(!PTP_DATA || PTP_DATA.tpl!==t.key) PTP_DATA=ptpLoad(t);
  $("ptpPick").innerHTML=Object.values(PTP_TEMPLATES).map(x=>
    `<button type="button" class="ptp-tab ${x.key===t.key?"on":""}" data-ptpkind="${esc(x.key)}">
       <b>${esc(x.label)}</b><i>${esc(x.blurb)}</i></button>`).join("");
  $("ptpMeta").textContent=`${t.label} · saved on this device`;
  wrap.innerHTML=ptpFormHTML(t,PTP_DATA,PTP_POOL);
  renderPtpAtts();
  // lockDateInputs() runs once at boot; this form is built long after, so its date fields would
  // otherwise be the only ones in the app that accept typed-in text.
  if(typeof lockDateInputs==="function") lockDateInputs();
}

/* ---- attachments ---- */
const attSize=n=>n>1048576?(n/1048576).toFixed(1)+" MB":Math.max(1,Math.round(n/1024))+" KB";
async function renderPtpAtts(){
  const box=$("ptpAtts"); if(!box) return;
  PTP_ATTS=await ptpAttList(ptpTpl());
  box.innerHTML=`<div class="ptp-h">Files to send with the plan</div>
    <div class="ptp-attlist">${PTP_ATTS.length?PTP_ATTS.map(a=>
      `<div class="ptp-att"><span class="ico">${/pdf/i.test(a.type)||/\.pdf$/i.test(a.name)?"📄":"🖼"}</span>
        <span class="nm">${esc(a.name)}</span><span class="sz">${attSize(a.size)}</span>
        <button type="button" class="ptp-del" data-attdel="${esc(a.id)}" title="Remove this file">✕</button></div>`).join("")
      :`<div class="ptp-attempty">Nothing attached. Drawings, SDS sheets or photos added here are printed after the plan, in one PDF.</div>`}</div>
    <label class="ptp-add as-label">+ Add a file<input type="file" id="ptpAttFile" accept="application/pdf,image/png,image/jpeg" multiple hidden></label>`;
  const inp=$("ptpAttFile");
  if(inp) inp.addEventListener("change",async e=>{
    const files=[...(e.target.files||[])];
    for(const f of files){
      // A phone photo is a few MB and IndexedDB copes; a 200MB scan is a mistake, not a plan.
      if(f.size>40*1048576){ toast(`${f.name} is too big (${attSize(f.size)}). 40 MB max.`); continue; }
      try{ await ptpAttAdd(ptpTpl(),f); }catch(err){ console.error("ptp att",err); toast("Couldn't save "+f.name); }
    }
    e.target.value=""; renderPtpAtts();
  });
}

/* ---- the shared pool ---- */
async function ptpPoolAdd(which,text){
  const t=ptpTpl(), v=String(text||"").trim();
  if(!v) return;
  if(v.length>200){ toast("That's too long for a checklist line"); return; }
  const list=which==="questions"?ptpQuestions(t,PTP_POOL):ptpCircleItems(t,PTP_POOL);
  if(list.some(i=>i.text.toLowerCase()===v.toLowerCase())){ toast("That's already on the list"); return; }
  if(!fbReady){ toast("No connection — can't share that with everyone yet"); return; }
  const cur=(PTP_POOL[t.key]&&PTP_POOL[t.key][which])||[];
  try{
    await setDoc(doc(db,"config","ptpPool"),{[t.key]:{...(PTP_POOL[t.key]||{}),[which]:[...cur,v]}},{merge:true});
    toast("Added for everyone");
  }catch(e){ console.error("ptpPool",e); toast("Couldn't save that: "+(e.code||e.message)); }
}
async function ptpPoolRemove(which,text){
  const t=ptpTpl();
  if(!confirm(`Remove "${text}" from the ${which==="questions"?"question":"checklist"} list?\n\nIt disappears for everyone, on every future plan. Built-in items from the company form can't be removed.`)) return;
  const cur=(PTP_POOL[t.key]&&PTP_POOL[t.key][which])||[];
  try{
    await setDoc(doc(db,"config","ptpPool"),
      {[t.key]:{...(PTP_POOL[t.key]||{}),[which]:cur.filter(x=>String(x).trim()!==text)}},{merge:true});
    toast("Removed");
  }catch(e){ console.error("ptpPool",e); toast("Couldn't remove that"); }
}

// Typing saves, but not on every keystroke -- localStorage writes are synchronous and would
// stutter a cheap phone mid-sentence.
function ptpTouch(){
  clearTimeout(ptpSaveTimer);
  ptpSaveTimer=setTimeout(()=>{
    ptpSaveTimer=null;
    ptpCollect($("ptpForm"),PTP_DATA);
    ptpPersist();
  },400);
}
/* The debounce means the last few hundred milliseconds of typing live only in the DOM. A phone
   backgrounded mid-sentence would drop them, so write immediately when the page goes away. */
function ptpFlush(){
  if(!ptpSaveTimer) return;
  clearTimeout(ptpSaveTimer); ptpSaveTimer=null;
  if(!PTP_DATA||!$("ptpForm")) return;
  ptpCollect($("ptpForm"),PTP_DATA); ptpSave(ptpTpl(),PTP_DATA);
}
document.addEventListener("visibilitychange",()=>{ if(document.hidden) ptpFlush(); });
window.addEventListener("pagehide",ptpFlush);

// Document-level, so it fires for typing anywhere in the app. Both guards matter: the closest()
// check keeps it off other forms, and PTP_DATA is null until the pane has been opened once.
document.addEventListener("input",e=>{ if(PTP_DATA && e.target.closest && e.target.closest("#ptpForm")) ptpTouch(); });

document.addEventListener("click",e=>{
  if(!$("ptpForm")) return;
  const pick=e.target.closest("[data-ptpkind]");
  if(pick){
    // Collect before switching or the half-typed form is lost with no undo.
    clearTimeout(ptpSaveTimer); ptpSaveTimer=null;   // a queued save would fire against the NEW template
    if(PTP_DATA){ ptpCollect($("ptpForm"),PTP_DATA); ptpSave(ptpTpl(),PTP_DATA); }
    PTP_KIND=pick.dataset.ptpkind; try{ localStorage.setItem("ptp_kind",PTP_KIND); }catch(err){}
    PTP_DATA=null; renderPtp(); ptpSavedNote(""); return;
  }
  if(!PTP_DATA) return;                      // nothing below is reachable before the pane renders
  const pgo=e.target.closest("[data-poolgo]");
  if(pgo){
    const which=pgo.dataset.poolgo;
    const box=$("ptpForm").querySelector(`[data-pooladd="${which}"]`);
    if(box){ const v=box.value; box.value=""; ptpPoolAdd(which,v); }
    return;
  }
  const prm=e.target.closest("[data-poolrm]");
  if(prm){ const [which,txt]=prm.dataset.poolrm.split("|"); ptpPoolRemove(which,txt); return; }
  const adel=e.target.closest("[data-attdel]");
  if(adel){ ptpAttDel(ptpTpl(),adel.dataset.attdel).then(renderPtpAtts); return; }
  const yn=e.target.closest("[data-yn]");
  if(yn){
    const [i,v]=yn.dataset.yn.split("|");
    ptpCollect($("ptpForm"),PTP_DATA);
    const now=PTP_DATA.answers[i]===v?"":v;                     // tapping the same answer clears it
    PTP_DATA.answers[i]=now;
    // Patch in place rather than re-rendering: a full rebuild of a form this long loses the
    // caret, the scroll position and any textarea that had been dragged taller.
    yn.parentElement.querySelectorAll(".yn").forEach(b=>
      b.classList.toggle("on", b.dataset.yn.split("|")[1]===now));
    ptpPersist(); return;
  }
  const chk=e.target.closest("[data-chk]");
  if(chk){
    ptpCollect($("ptpForm"),PTP_DATA);
    const k=chk.dataset.chk, on=!PTP_DATA.checks[k];
    PTP_DATA.checks[k]=on;
    chk.classList.toggle("on",on);
    const bx=chk.querySelector(".bx"); if(bx) bx.textContent=on?"\u2713":"";
    ptpPersist(); return;
  }
  const add=e.target.closest("[data-add]");
  if(add){
    ptpCollect($("ptpForm"),PTP_DATA);
    const w=add.dataset.add;
    if(w==="crew") PTP_DATA.crew.push("","","");
    else PTP_DATA[w].push(["","",""]);
    ptpPersist(); renderPtp(); return;
  }
  const del=e.target.closest("[data-delrow]");
  if(del){
    const [w,i]=del.dataset.delrow.split("|");
    ptpCollect($("ptpForm"),PTP_DATA);
    const row=PTP_DATA[w][Number(i)]||[];
    if(row.some(x=>String(x||"").trim()) && !confirm("Remove this row?\n\nWhat you typed in it is deleted.")) return;
    if(PTP_DATA[w].length>1) PTP_DATA[w].splice(Number(i),1); else PTP_DATA[w][0]=["","",""];
    ptpPersist(); renderPtp(); return;
  }
});

$("ptpClear").addEventListener("click",()=>{
  if(!PTP_DATA) return;
  const t=ptpTpl();
  if(!confirm(`Clear the whole ${t.label}?\n\nEverything typed into this form is erased, including the saved copy on this device. This can't be undone.`)) return;
  clearTimeout(ptpSaveTimer); ptpSaveTimer=null;   // else a queued save puts it all straight back
  ptpWipe(t); PTP_DATA=ptpBlank(t);
  // "Clear all" has to mean all of it, attachments included -- otherwise last week's drawings
  // ride along on next week's plan.
  ptpAttClear(t).catch(()=>{}).then(()=>{ renderPtp(); ptpSavedNote("Cleared"); });
  toast(t.label+" cleared");
});

$("ptpPdf").addEventListener("click",()=>{
  if(!PTP_DATA) return;
  const t=ptpTpl();
  const lib=window.jspdf&&window.jspdf.jsPDF;
  if(!lib){ toast("PDF writer didn't load. Check your connection and retry."); return; }
  clearTimeout(ptpSaveTimer); ptpSaveTimer=null;
  ptpCollect($("ptpForm"),PTP_DATA); ptpSave(t,PTP_DATA);
  const btn=$("ptpPdf"); const label=btn.textContent;
  btn.disabled=true; btn.textContent="Building…";
  (async()=>{
    try{
      const logo=document.querySelector(".brand img");
      const doc=ptpPdf(lib,t,PTP_DATA,logo?logo.src:null,PTP_POOL);
      const atts=await ptpAttList(t);
      if(!atts.length){ doc.save(ptpFileName(t,PTP_DATA)); toast("PDF saved"); return; }
      // Attachments are merged, not appended by hand: pdf-lib copies the pages so a drawing
      // stays vector and searchable instead of becoming a screenshot of itself.
      const PDFLib=window.PDFLib;
      if(!PDFLib){ doc.save(ptpFileName(t,PTP_DATA));
        toast("Saved the plan, but the merge tool didn't load — attachments left out"); return; }
      const { bytes, skipped }=await ptpMerge(PDFLib,doc.output("arraybuffer"),atts);
      const url=URL.createObjectURL(new Blob([bytes],{type:"application/pdf"}));
      const a=document.createElement("a"); a.href=url; a.download=ptpFileName(t,PTP_DATA);
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),4000);
      toast(skipped.length?`PDF saved — couldn't read ${skipped.join(", ")}`
                          :`PDF saved with ${atts.length} attached file${atts.length===1?"":"s"}`);
    }catch(err){ console.error("ptp pdf",err); toast("Couldn't build the PDF: "+(err.message||err)); }
    finally{ btn.disabled=false; btn.textContent=label; }
  })();
});

// Sub-tab pills + searches
document.querySelectorAll("[data-safety]").forEach(b=>b.addEventListener("click",()=>{
  SF_TAB=b.dataset.safety;
  document.querySelectorAll("[data-safety]").forEach(x=>x.classList.toggle("active",x===b));
  document.querySelectorAll(".safety-pane").forEach(p=>p.classList.toggle("active",p.id==="safety-"+SF_TAB));
  if(SF_TAB==="ptp") renderPtp();
  window.scrollTo(0,0);
}));
document.querySelectorAll("[data-trainfilter]").forEach(b=>b.addEventListener("click",()=>{
  SF_TRAIN_FILTER=b.dataset.trainfilter; renderSfTraining();
}));
// Delegated so the rows can be re-rendered freely without re-binding.
document.addEventListener("click",e=>{
  const pr=e.target.closest("[data-sfperson]");
  if(pr){ const n=pr.dataset.sfperson; SF_TRAIN_OPEN.has(n)?SF_TRAIN_OPEN.delete(n):SF_TRAIN_OPEN.add(n); renderSfTraining(); return; }
  const pt=e.target.closest("[data-sfpoint]");
  if(pt){ const i=pt.dataset.sfpoint; SF_PTS_OPEN.has(i)?SF_PTS_OPEN.delete(i):SF_PTS_OPEN.add(i); renderSfPoints(); return; }
  const dr=e.target.closest("[data-sfdrug]");
  if(dr){ const i=dr.dataset.sfdrug; SF_DRUG_OPEN.has(i)?SF_DRUG_OPEN.delete(i):SF_DRUG_OPEN.add(i); renderSfDrug(); return; }
  const sr=e.target.closest("[data-sfsds]");
  if(sr){ const i=sr.dataset.sfsds; SF_SDS_OPEN.has(i)?SF_SDS_OPEN.delete(i):SF_SDS_OPEN.add(i); renderSfSds(); return; }
});
document.querySelectorAll("[data-drugfilter]").forEach(b=>b.addEventListener("click",()=>{
  SF_DRUG_FILTER=b.dataset.drugfilter; renderSfDrug();
}));
["sfPointsSearch","sfTrainSearch","sfSdsSearch","sfDrugSearch"].forEach(id=>{
  const el=$(id); if(el) el.addEventListener("input",()=>{
    if(id==="sfPointsSearch")renderSfPoints();
    else if(id==="sfTrainSearch")renderSfTraining();
    else if(id==="sfDrugSearch")renderSfDrug();
    else renderSfSds();
  });
});

$("btnImport").addEventListener("click",()=>{ $("importTitle").textContent="Import Excel"; $("importBody").innerHTML=dropHTML("excel"); wireDrop("excel"); openModal("importModal"); });
$("btnToolImport").addEventListener("click",()=>{ $("importTitle").textContent="Upload Tool Report"; $("importBody").innerHTML=dropHTML("pdf"); wireDrop("pdf"); openModal("importModal"); });
/* ---------- Safety uploads (Admin) ---------- */
// Each upload replaces its category. Doc ids are derived from the row content with makeId, so
// re-uploading the same report rewrites the same docs instead of duplicating them, and anything
// that vanished from the report gets deleted. Two exceptions, both in sfReplace: pinned rows are
// skipped silently, and hand-edited rows are held back for the sfConflicts prompt first.

const SF_UPLOADS={
  points  :{coll:"safetyPoints",  state:()=>SF_POINTS,  title:"Upload Safety Points",   ico:"📊", accept:".pdf",             what:"Safety Point Program totals PDF"},
  // One workbook, two tabs, two collections — see parseTrainingWorkbook/parseDrugCards.
  training:{coll:"safetyTraining",state:()=>SF_TRAINING,title:"Upload Training & Drug Cards", ico:"🎓", accept:".xlsx,.xlsm,.xls", what:"Arctic Training Matrix workbook"},
  drug    :{coll:"safetyDrugCards",state:()=>SF_DRUG,   title:"Drug Cards",             ico:"🪪", accept:".xlsx,.xlsm,.xls", what:"Arctic Training Matrix workbook", viaTraining:true},
  sds     :{coll:"safetySds",     state:()=>SF_SDS,     title:"Upload SDS Inventory",   ico:"🧪", accept:".xlsx,.xlsm,.xls", what:"Safety Data Sheet inventory workbook"},
};

function sfDropHTML(kind){
  const c=SF_UPLOADS[kind];
  return `<div class="dropzone" id="dropzone"><div class="dz-ico">${c.ico}</div><h4>${esc(c.title)}</h4>
    <p>Drop the <b>${esc(c.what)}</b> here, or pick it from your device. This replaces that category — rows missing from the file are removed. Rows you edited by hand are asked about first; pinned rows are left alone.</p>
    <label class="dz-btn">Choose file<input id="fileInput" type="file" accept="${c.accept}" hidden></label></div>`;
}

// Rows of positioned cells, one array per page. Same y-bucketing as parseToolPdf, but the x of
// every cell is kept so values can be matched to columns instead of guessed from word order —
// which matters here because blank cells are common and would otherwise shift everything left.
//
// Coordinates go through the VIEWPORT transform rather than being read straight off
// item.transform. Both of these reports are landscape (/Rotate 90), and on a rotated page the
// raw matrix puts what you see as a row along the y axis — bucketing the raw values groups
// each COLUMN together and the parse finds nothing at all.
async function sfPdfRows(buf){
  const pdf=await pdfjsLib.getDocument({data:buf}).promise;
  const out=[];
  for(let p=1;p<=pdf.numPages;p++){
    const page=await pdf.getPage(p);
    const vp=page.getViewport({scale:1});
    const tc=await page.getTextContent();
    const buckets=[];
    for(const it of tc.items){
      if(!it.str||!it.str.trim())continue;
      const m=pdfjsLib.Util.transform(vp.transform,it.transform);
      const x=m[4], y=m[5];
      let b=buckets.find(bk=>Math.abs(bk.y-y)<=2.5);
      if(!b){ b={y,cells:[]}; buckets.push(b); }
      b.cells.push({x,s:it.str.trim()});
    }
    buckets.sort((a,b)=>a.y-b.y);                 // screen coords run top-down
    buckets.forEach(b=>b.cells.sort((m,n)=>m.x-n.x));
    out.push(buckets);
  }
  return out;
}
const sfNum=s=>{ const t=String(s).replace(/[,$]/g,"").trim(); return /^-?\d+(\.\d+)?$/.test(t)?Number(t):null; };
// Which column does a cell belong to? The LAST header starting at or before it, with a little
// slack. Values sit slightly right of their header (numbers are right-aligned in the export),
// so nearest-header matching picks the wrong neighbour — an award lands one column over and
// every date is off by one. "Last header at or before" is stable under that shift.
const SF_COL_SLACK=10;
function sfColAt(x,cols){
  let idx=-1;
  for(let i=0;i<cols.length;i++){ if(cols[i].x-SF_COL_SLACK<=x) idx=i; else break; }
  return idx;
}

function parseSafetyPointsPdf(pages){
  const flat=[].concat(...pages);
  // Header carries the award dates, and its cell positions define the columns.
  const hi=flat.findIndex(r=>r.cells.some(c=>/employee\s*name/i.test(c.s)) || (r.cells.some(c=>/^total$/i.test(c.s))&&r.cells.some(c=>/shirt/i.test(c.s))));
  if(hi<0) throw new Error("Couldn't find the header row (expected “Employee Name … Total”). Is this the Safety Point Program totals PDF?");
  // The year sits in the same cell as "Employee Name" ("2026 Employee Name"), so strip it.
  const cols=flat[hi].cells.map(c=>({label:c.s.replace(/^\d{4}\s+/,"").trim(),x:c.x}));
  const iOf=re=>cols.findIndex(c=>re.test(c.label));
  const iStart=iOf(/start/i), iUsed=iOf(/used/i), iExtra=iOf(/extra/i), iTotal=iOf(/^total$/i);
  const dateCols=cols.map((c,i)=>({i,label:c.label})).filter(c=>/^\d{1,2}\/\d{1,2}$/.test(c.label));
  const out=[];
  for(let r=hi+1;r<flat.length;r++){
    const cells=flat[r].cells;
    const nameCell=cells.find(c=>/[A-Za-z].*;/.test(c.s));
    if(!nameCell) continue;                                  // filter artefacts, page furniture
    const name=nameCell.s.replace(/\s+/g," ").trim();
    const rec={name,shirt:"",start:0,awards:{},used:0,extra:0,total:0};
    for(const c of cells){
      if(c===nameCell) continue;
      if(/^(xs|s|m|l|xl|xxl|xxxl|2xl|3xl)$/i.test(c.s)){ rec.shirt=c.s; continue; }
      const n=sfNum(c.s); if(n===null) continue;
      const ci=sfColAt(c.x,cols);
      if(ci===iStart) rec.start=n;
      else if(ci===iUsed) rec.used=n;
      else if(ci===iExtra) rec.extra=n;
      else if(ci===iTotal) rec.total=n;
      else { const dc=dateCols.find(d=>d.i===ci); if(dc) rec.awards[dc.label]=n; }
    }
    if(!rec.total && !rec.start && !Object.keys(rec.awards).length) continue;
    out.push(rec);
  }
  if(!out.length) throw new Error("No employee rows found in that PDF.");
  return out;
}

// The training log and the drug cards are two tabs of ONE workbook, so a single upload fills
// both. Sheet names are matched loosely — the tabs really are called "Training Log- ALL" and
// "Drug Cards", with the spacing and capitalisation that implies — and the exact match is tried
// first so "Training Log-Architectural" and the other per-department tabs can't win by prefix.
function sfFindSheet(wb,...wanted){
  const norm=s=>String(s).toLowerCase().replace(/[^a-z]/g,"");
  for(const w of wanted){
    const want=norm(w);
    const hit=wb.SheetNames.find(n=>norm(n)===want) || wb.SheetNames.find(n=>norm(n).includes(want));
    if(hit) return hit;
  }
  return null;
}
function sfRows(wb,sheet){
  return XLSX.utils.sheet_to_json(wb.Sheets[sheet],{header:1,raw:true,defval:"",cellDates:true});
}
// Header text is matched per column rather than assumed by position: this log starts in column
// C with two blank columns to its left, and a title block above it.
function sfHeaderCols(rows,must,label){
  const hi=rows.findIndex(r=>r.map(c=>String(c).toLowerCase()).join("|").includes(must));
  if(hi<0) throw new Error(`Couldn't find the ${label} header (expected “${must}”).`);
  const H=rows[hi].map(c=>String(c).trim().toLowerCase());
  return {hi,col:(...keys)=>{ for(const k of keys){ const i=H.findIndex(h=>h.includes(k)); if(i>=0) return i; } return -1; }};
}

function parseTrainingWorkbook(buf){
  const wb=XLSX.read(buf,{cellDates:true});
  const sheet=sfFindSheet(wb,"training log all","training log");
  if(!sheet) throw new Error(`No “Training Log- ALL” tab in this workbook. Found: ${wb.SheetNames.join(", ")}`);
  const rows=sfRows(wb,sheet);
  const {hi,col}=sfHeaderCols(rows,"date of training","training log");
  const cD=col("date of training"),cN=col("name"),cC=col("course"),
        cI=col("instructor"),cE=col("expires"),cX=col("notes");
  const out=[];
  for(let i=hi+1;i<rows.length;i++){
    const r=rows[i], g=x=>x>=0?r[x]:"";
    const name=String(g(cN)||"").trim(), date=fmtDateKey(g(cD));
    if(!name||!date) continue;
    out.push({name,course:String(g(cC)||"").trim(),instructor:String(g(cI)||"").trim(),
      date,expires:fmtDateKey(g(cE)),notes:String(g(cX)||"").trim()});
  }
  if(!out.length) throw new Error("No dated rows found on the training log tab.");
  return {sheet,rows:out};
}

function parseDrugCards(buf){
  const wb=XLSX.read(buf,{cellDates:true});
  const sheet=sfFindSheet(wb,"drug cards","drug card","drug");
  if(!sheet) return {sheet:null,rows:[]};      // optional — the log alone is still a valid upload
  const rows=sfRows(wb,sheet);
  const {hi,col}=sfHeaderCols(rows,"name","drug cards");
  const cN=col("name"),cT=col("test date","test"),cE=col("expiration","expires");
  const all=[];
  for(let i=hi+1;i<rows.length;i++){
    const r=rows[i], g=x=>x>=0?r[x]:"";
    const name=String(g(cN)||"").trim();
    if(!name) continue;
    all.push({name,tested:fmtDateKey(g(cT)),expires:fmtDateKey(g(cE))});
  }
  // People appear once per test they have ever taken, so the sheet lists the same person
  // several times — an expired card AND a current one. Only the newest test is a real card;
  // keep that and drop the history, or the list shows one person as both expired and valid.
  // Keyed case-insensitively so "Jaren Eells" and "jaren eells" can't both survive.
  const newest=new Map();
  for(const r of all){
    const key=r.name.toLowerCase().replace(/\s+/g," ");
    const prev=newest.get(key);
    // Newest TEST wins. Tie-break on the later expiry, which only matters if a test date is
    // missing or duplicated — in this workbook the two agree on all 8 duplicated people.
    if(!prev || r.tested>prev.tested || (r.tested===prev.tested && r.expires>prev.expires)) newest.set(key,r);
  }
  const out=[...newest.values()];
  return {sheet,rows:out,merged:all.length-out.length};
}

function parseSdsWorkbook(buf){
  const wb=XLSX.read(buf,{cellDates:true});
  const ws=wb.Sheets[wb.SheetNames[0]];
  const rows=XLSX.utils.sheet_to_json(ws,{header:1,raw:true,defval:"",cellDates:true});
  // The title sits above the header, so find the header row rather than assuming row 3.
  let hi=rows.findIndex(r=>r.map(c=>String(c).toLowerCase()).join("|").includes("chemical/product"));
  if(hi<0) hi=rows.findIndex(r=>r.map(c=>String(c).toLowerCase()).join("|").includes("record"));
  if(hi<0) throw new Error("Couldn't find the header row (expected “Chemical/Product Name”).");
  const H=rows[hi].map(c=>String(c).toLowerCase());
  const col=(...keys)=>{ for(const k of keys){ const i=H.findIndex(h=>h.includes(k)); if(i>=0) return i; } return -1; };
  const cR=col("record"),cP=col("chemical","product name"),cU=col("product use","use"),
        cV=col("vendor","mfg"),cI=col("issue"),cD=col("dept"),cG=col("# of pages","pages");
  const out=[];
  for(let i=hi+1;i<rows.length;i++){
    const r=rows[i], g=x=>x>=0?r[x]:"";
    const product=String(g(cP)||"").trim();
    if(!product) continue;                                   // trailing notes column is not a row
    out.push({record:String(g(cR)||"").trim(),product,use:String(g(cU)||"").trim(),
      vendor:String(g(cV)||"").trim(),issueDate:fmtDateKey(g(cI)),dept:String(g(cD)||"").trim(),
      pages:String(g(cG)||"").trim()});
  }
  if(!out.length) throw new Error("No chemical rows found in that workbook.");
  return out;
}

/* Which existing rows would this upload trample?

   Only rows saved through the Admin form (source "admin-edit") count. Silencing on its own
   is safe without asking: the parsers never emit a `silenced` field and every write is
   {merge:true}, so a silenced flag survives an import untouched. Rows already pinned have
   had this question answered permanently and are skipped in silence. */
function sfConflicts(kind,docs){
  const incoming=new Map(docs.map(d=>[d.id,d]));
  const keys=SF_FIELDS[kind].map(f=>f.k).filter(k=>k!=="silenced");
  const out=[];
  for(const cur of SF_UPLOADS[kind].state()){
    if(cur.pinned) continue;
    if(cur.source!=="admin-edit") continue;
    const inc=incoming.get(cur.id);
    if(!inc){ out.push({id:cur.id,cur,what:"would be deleted — it isn't in this file"}); continue; }
    const changed=keys.filter(k=>String(inc[k]??"")!==String(cur[k]??""));
    if(changed.length) out.push({id:cur.id,cur,inc,what:"would change "+changed.slice(0,3).join(", ")});
  }
  return out;
}

if(typeof window!=="undefined") window.__sfTestConflicts=sfConflicts;   // offline test harness
// Resolves to "replace" | "once" | "always" | "cancel".
function sfAskConflicts(kind,conflicts){
  return new Promise(resolve=>{
    const label=r=>esc(r.name||r.product||r.id)+(r.course?` — ${esc(r.course)}`:"");
    $("sfConflictIntro").textContent=
      `${conflicts.length} row${conflicts.length===1?"":"s"} you edited by hand ${conflicts.length===1?"is":"are"} about to be overwritten by this ${SF_KIND_LABEL[kind]} upload.`;
    $("sfConflictList").innerHTML=conflicts.slice(0,12).map(c=>
      `<div class="sf-conflict"><b>${label(c.cur)}</b><i>${esc(c.what)}</i></div>`).join("")
      +(conflicts.length>12?`<div class="sf-conflict more">…and ${conflicts.length-12} more</div>`:"");
    const done=v=>{ closeModal("sfConflictModal"); cleanup(); resolve(v); };
    const h={sfConflictReplace:()=>done("replace"),sfConflictKeepOnce:()=>done("once"),
             sfConflictKeepAlways:()=>done("always"),sfConflictCancel:()=>done("cancel")};
    function cleanup(){ Object.entries(h).forEach(([id,fn])=>{ const el=$(id); if(el) el.removeEventListener("click",fn); }); }
    Object.entries(h).forEach(([id,fn])=>{ const el=$(id); if(el) el.addEventListener("click",fn); });
    openModal("sfConflictModal");
  });
}

// Write the new set and delete whatever is no longer in the report.
// `protect` holds ids the upload must not touch at all — neither overwrite nor delete.
async function sfReplace(kind,docs,protect){
  const cfg=SF_UPLOADS[kind];
  const guard=new Set(protect||[]);
  cfg.state().forEach(r=>{ if(r.pinned) guard.add(r.id); });   // "keep permanently"
  const keep=new Set(docs.map(d=>d.id));
  const stale=cfg.state().filter(r=>!keep.has(r.id)&&!guard.has(r.id));
  let batch=writeBatch(db), n=0;
  const flush=async()=>{ if(n){ await batch.commit(); batch=writeBatch(db); n=0; } };
  let skipped=0;
  for(const d of docs){
    const {id,...rest}=d;
    if(guard.has(id)){ skipped++; continue; }
    batch.set(doc(db,cfg.coll,id),{...rest,source:"admin-upload",updatedAt:serverTimestamp()},{merge:true});
    if(++n>=400) await flush();
  }
  for(const s of stale){ batch.delete(doc(db,cfg.coll,s.id)); if(++n>=400) await flush(); }
  await flush();
  await setDoc(doc(db,"config","safetyMeta"),
    {[kind]:{count:docs.length,updatedAt:serverTimestamp(),by:USER?`${USER.first} ${USER.last}`.trim():""}},{merge:true});
  return {written:docs.length-skipped,removed:stale.length,skipped};
}

function wireSfDrop(kind){
  const dz=$("dropzone"), input=$("fileInput"); if(!dz||!input) return;
  const go=f=>f&&handleSfFile(kind,f);
  dz.addEventListener("dragover",e=>{e.preventDefault();dz.classList.add("over");});
  dz.addEventListener("dragleave",()=>dz.classList.remove("over"));
  dz.addEventListener("drop",e=>{e.preventDefault();dz.classList.remove("over");go(e.dataTransfer.files[0]);});
  input.addEventListener("change",e=>go(e.target.files[0]));
}

async function handleSfFile(kind,file){
  const body=$("importBody");
  if(!fbReady){ body.innerHTML=stageErr("No Firebase connection."); return; }
  const cfg=SF_UPLOADS[kind];
  body.innerHTML=`<div class="imp-stage"><div class="imp-spin"></div><h4>Reading ${esc(file.name)}…</h4><div class="imp-bar"><i id="impBar"></i></div><div class="hint" id="impCount"></div></div>`;
  try{
    const buf=await file.arrayBuffer();
    const mkId=(k,r)=> k==="points" ? makeId(["sfp",r.name])
      : k==="training" ? makeId(["sft",r.name,r.course,r.date])
      : k==="drug" ? makeId(["sfd",r.name.toLowerCase().replace(/\s+/g," ")])
      : makeId(["sds",r.record||r.product,r.product]);
    // Two rows that collapse to one id would silently drop one, so de-duplicate deliberately
    // and report how many merged rather than quietly losing them.
    const prep=(k,recs)=>{
      const seen=new Map();
      recs.forEach(r=>seen.set(mkId(k,r),{...r,id:mkId(k,r)}));
      return {docs:[...seen.values()],dropped:recs.length-seen.size};
    };

    const parts=[];        // [{kind, label, docs, dropped}]
    if(kind==="sds") parts.push({kind:"sds",label:"SDS sheets",...prep("sds",parseSdsWorkbook(buf))});
    else if(kind==="points"){
      if(!pdfReady()) throw new Error("PDF reader didn't load. Check your connection and retry.");
      parts.push({kind:"points",label:"employees",...prep("points",parseSafetyPointsPdf(await sfPdfRows(buf)))});
    } else {
      // The training log and the drug cards ride in the same workbook, so one drop fills both.
      const t=parseTrainingWorkbook(buf);
      parts.push({kind:"training",label:"training records",...prep("training",t.rows)});
      const d=parseDrugCards(buf);
      if(d.sheet) parts.push({kind:"drug",label:"drug cards",note:d.merged?`${d.merged} older card${d.merged===1?"":"s"} superseded`:"",...prep("drug",d.rows)});
    }

    // Resolve conflicts for every part BEFORE writing anything, so "Cancel" leaves all
    // categories untouched rather than half-importing.
    for(const p of parts){
      const conf=sfConflicts(p.kind,p.docs);
      if(!conf.length) continue;
      const choice=await sfAskConflicts(p.kind,conf);
      if(choice==="cancel"){ closeModal("importModal"); toast("Upload cancelled — nothing changed"); return; }
      if(choice==="replace") continue;
      p.protect=conf.map(c=>c.id);
      if(choice==="always") p.pin=p.protect.slice();
    }

    const total=parts.reduce((s,p)=>s+p.docs.length,0);
    upd(0,total||1);
    let done=0; const lines=[];
    for(const p of parts){
      if(p.pin&&p.pin.length){
        let b=writeBatch(db);
        p.pin.forEach(id=>b.set(doc(db,sfColl(p.kind),id),{pinned:true,updatedAt:serverTimestamp()},{merge:true}));
        await b.commit();
      }
      const res=await sfReplace(p.kind,p.docs,p.protect);
      done+=p.docs.length; upd(done,total||1);
      lines.push(`<b>${res.written.toLocaleString()}</b> ${p.label}${res.removed?` · ${res.removed.toLocaleString()} removed`:""}${res.skipped?` · ${res.skipped} hand-edited row${res.skipped===1?"":"s"} kept`:""}${p.note?` · ${p.note}`:""}${p.dropped?` · ${p.dropped} duplicate row${p.dropped===1?"":"s"} merged`:""}`);
    }
    body.innerHTML=`<div class="imp-stage"><div style="font-size:42px;margin-bottom:10px">✅</div>
      <h4>${esc(cfg.title.replace("Upload ",""))} updated</h4>
      <p>${lines.join("<br>")}</p>
      ${parts.length===1&&kind==="training"?`<p class="hint">No “Drug Cards” tab in that workbook, so drug cards were left as they were.</p>`:""}
      <button class="submit" style="margin-top:20px" id="impErrClose">Done</button></div>`;
    const c=$("impErrClose"); if(c) c.addEventListener("click",()=>closeModal("importModal"));
    toast(parts.map(p=>`${p.docs.length.toLocaleString()} ${p.label}`).join(" · "));
  }catch(e){
    console.error(e);
    body.innerHTML=stageErr((e&&e.message)||String(e));
    const c=$("impErrClose"); if(c) c.addEventListener("click",()=>closeModal("importModal"));
  }
}

function sfOpenUpload(kind){
  $("importTitle").textContent=SF_UPLOADS[kind].title;
  $("importBody").innerHTML=sfDropHTML(kind);
  wireSfDrop(kind);
  openModal("importModal");
}
Object.keys(SF_UPLOADS).forEach(kind=>{
  const btn=$("btnSf"+kind.charAt(0).toUpperCase()+kind.slice(1));
  // Drug cards have no upload of their own — they arrive on the training workbook, so that
  // button opens the same drop zone rather than pretending to be a separate import.
  if(btn) btn.addEventListener("click",()=>sfOpenUpload(SF_UPLOADS[kind].viaTraining?"training":kind));
});

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
  if(!pdfReady()){ body.innerHTML=stageErr("PDF reader didn't load. Check your connection and retry."); return; }
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
  if(!pdfReady()){ toast("PDF reader didn't load"); return; }
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
syncAppbarH();
// Record the visit on open, and again when the tab is brought back after a while. Both go through
// the 15-minute throttle, so tabbing in and out costs nothing.
touchLastSeen();
document.addEventListener("visibilitychange",()=>{ if(!document.hidden) touchLastSeen(); });
window.addEventListener("resize",syncAppbarH);
if(window.ResizeObserver){ const _ab=document.querySelector(".appbar"); if(_ab) new ResizeObserver(syncAppbarH).observe(_ab); }
if(typeof wdUpdateLights==="function") wdUpdateLights();
if(typeof wdSyncWindowInputs==="function") wdSyncWindowInputs();
lockDateInputs();
const initView=viewForHash(location.hash.replace("#","")); if(initView)setView(initView,true);
syncAdminView(); startSync();
if(!USER){ setTimeout(()=>{ if(!USER) openName(); },600); }
// Returning user whose Webduct token survived the session → refresh equipment in the background.
if(USER){ setTimeout(()=>{ if(typeof wdAutoSync==="function") wdAutoSync(); }, 2500); }
window.addEventListener("pageshow",()=>{ if($("view-admin").classList.contains("active"))syncAdminView(); });
