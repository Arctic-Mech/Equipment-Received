/* Moved verbatim out of app.js: the Utils section, plus esc, which rateChips calls.

   normJob, makeId and fmtDateKey are re-implemented in Python in email_import.py as
   norm_job, make_id and fmt_date_key, under a header that reads "Helpers that MUST
   match the website exactly". The importer builds each arrival's Firestore document
   ID from makeId([...normJob(job), fmtDateKey(date)...]) — so if these three drift
   from their Python mirrors the IDs stop matching, and the daily email import writes
   duplicate arrivals instead of updating the existing ones. Change any of the three
   here and change email_import.py in the same commit.

   This is enforced now, not just documented: contract_check.py runs both real
   implementations over a shared corpus and fails CI on any disagreement. It was added
   after the two had already drifted — see the notes on fmtDateKey and on make_id. */

const esc=s=>String(s==null?"":s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/* ---------- Utils ---------- */
function normJob(j){ return String(j==null?"":j).trim().toUpperCase(); }
function isRealJob(j){ const n=normJob(j); return n&&n!=="NA"&&n!=="N/A"&&n!=="-"; }
function makeId(parts){ const key=parts.join("|").toLowerCase(); let h=5381; for(let i=0;i<key.length;i++){h=((h<<5)+h)^key.charCodeAt(i);} return "a"+(h>>>0).toString(36)+key.length.toString(36); }
// The written-out forms below are spelled out rather than handed to new Date(), because
// new Date() also accepts things fmt_date_key() in email_import.py rejects — "2026/07/09",
// "7-9-26", and any bare number ("12345" parsed as the year 12345). Those produced a real
// date key here and "" in the importer, so the same spreadsheet row got two different
// document IDs and imported as a duplicate arrival. Keep these rules in lockstep with
// fmt_date_key(); contract_check.py fails the build if they drift.
const monIdx=n=>MON.findIndex(m=>m.toLowerCase()===String(n).slice(0,3).toLowerCase())+1;
function fmtDateKey(d){ if(!d)return""; if(d instanceof Date&&!isNaN(d))return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); const s=String(d).trim(); let m=s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if(m)return m[1]+"-"+m[2].padStart(2,"0")+"-"+m[3].padStart(2,"0"); m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); if(m){let y=m[3];if(y.length===2)y="20"+y;return y+"-"+m[1].padStart(2,"0")+"-"+m[2].padStart(2,"0");} m=s.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{4})/); if(m&&monIdx(m[1]))return String(Number(m[3])).padStart(4,"0")+"-"+String(monIdx(m[1])).padStart(2,"0")+"-"+String(Number(m[2])).padStart(2,"0"); m=s.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?\s*,?\s*(\d{4})/); if(m&&monIdx(m[2]))return String(Number(m[3])).padStart(4,"0")+"-"+String(monIdx(m[2])).padStart(2,"0")+"-"+String(Number(m[1])).padStart(2,"0"); return""; }
const MON=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function rowDate(iso){ if(!iso)return{top:"—",bot:""}; const[y,mo,da]=iso.split("-").map(Number); const d=new Date(y,mo-1,da); if(isNaN(d))return{top:iso,bot:""}; const today=new Date(); today.setHours(0,0,0,0); const diff=Math.round((today-d)/86400000); const top=MON[mo-1]+" "+da; if(diff===0)return{top,bot:"Today",rel:true}; if(diff===1)return{top,bot:"Yesterday",rel:true}; if(diff>=2&&diff<=6)return{top,bot:diff+" days ago",rel:true}; return{top,bot:String(y)}; }
function longDate(iso){ if(!iso)return""; const[y,mo,da]=iso.split("-").map(Number); if(!mo)return iso; return MON[mo-1]+" "+da+", "+y; }
function todayIso(){ return fmtDateKey(new Date()); }
function monthKey(iso){ return iso?iso.slice(0,7):""; }
function monthLabel(k){ const[y,m]=k.split("-").map(Number); return MON[m-1]+" "+y; }
// Daily/Weekly/Monthly are assigned by POSITION, so only label a split rate when every part is
// actually a number. The Rate column is free text, and "$310/wk" would otherwise render as
// Daily $310 / Weekly "wk". Anything that isn't a clean 2-3 number split falls through to the
// rate printed as-is, which is always correct if less pretty.
const rateNum=p=>/^\$?\s*\d[\d,]*(\.\d+)?$/.test(p);
function rateChips(rate){ if(!rate)return""; const parts=String(rate).split("/").map(s=>s.replace(/,+$/,"").trim()).filter(Boolean); const labels=["Daily","Weekly","Monthly"]; if(parts.length>=2&&parts.length<=3&&parts.every(rateNum)) return `<div class="rate-line">${parts.map((p,i)=>`<span class="rate-chip"><span class="rl">${labels[i]}</span><b>${esc(p)}</b></span>`).join("")}</div>`; return `<span class="v">${esc(rate)}</span>`; }
/* "Last seen" for the admin people list. Coarse on purpose: the question an admin is asking is
   "is this person actually using it", not "what minute did they open it". Anything inside the
   last five minutes reads as right now, because that is usually the admin's own row. */
function lastSeenText(ms,now){
  if(!ms) return "Never opened it";
  const n=now||Date.now(), diff=n-ms;
  if(diff<0) return "Just now";                       // clock skew between a phone and the server
  const mins=Math.floor(diff/60000);
  if(mins<5) return "Just now";
  if(mins<60) return mins+" min ago";
  const hrs=Math.floor(mins/60);
  if(hrs<24) return hrs===1?"1 hour ago":hrs+" hours ago";
  const days=Math.floor(hrs/24);
  if(days===1) return "Yesterday";
  if(days<7) return days+" days ago";
  if(days<14) return "Last week";
  if(days<60) return Math.floor(days/7)+" weeks ago";
  const d=new Date(ms);
  return MON[d.getMonth()]+" "+d.getDate()+", "+d.getFullYear();
}
function money(v){ if(v===""||v==null)return"—"; const s=String(v).trim(); if(s==="-"||s==="")return"—"; return s.startsWith("$")?s:"$"+s; }

export {
  esc,
  normJob, isRealJob, makeId, fmtDateKey, MON, rowDate, longDate,
  todayIso, monthKey, monthLabel, rateChips, money, lastSeenText,
};
