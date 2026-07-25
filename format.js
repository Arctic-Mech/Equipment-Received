/* Moved verbatim out of app.js: the Utils section, plus esc, which rateChips calls.

   normJob, makeId and fmtDateKey are re-implemented in Python in email_import.py as
   norm_job, make_id and fmt_date_key, under a header that reads "Helpers that MUST
   match the website exactly". The importer builds each arrival's Firestore document
   ID from makeId([...normJob(job), fmtDateKey(date)...]) — so if these three drift
   from their Python mirrors the IDs stop matching, and the daily email import writes
   duplicate arrivals instead of updating the existing ones. Change any of the three
   here and change email_import.py in the same commit. */

const esc=s=>String(s==null?"":s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/* ---------- Utils ---------- */
function normJob(j){ return String(j==null?"":j).trim().toUpperCase(); }
function isRealJob(j){ const n=normJob(j); return n&&n!=="NA"&&n!=="N/A"&&n!=="-"; }
function makeId(parts){ const key=parts.join("|").toLowerCase(); let h=5381; for(let i=0;i<key.length;i++){h=((h<<5)+h)^key.charCodeAt(i);} return "a"+(h>>>0).toString(36)+key.length.toString(36); }
function fmtDateKey(d){ if(!d)return""; if(d instanceof Date&&!isNaN(d))return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); const s=String(d).trim(); let m=s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if(m)return m[1]+"-"+m[2].padStart(2,"0")+"-"+m[3].padStart(2,"0"); m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); if(m){let y=m[3];if(y.length===2)y="20"+y;return y+"-"+m[1].padStart(2,"0")+"-"+m[2].padStart(2,"0");} const p=new Date(s); if(!isNaN(p))return p.getFullYear()+"-"+String(p.getMonth()+1).padStart(2,"0")+"-"+String(p.getDate()).padStart(2,"0"); return""; }
const MON=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function rowDate(iso){ if(!iso)return{top:"—",bot:""}; const[y,mo,da]=iso.split("-").map(Number); const d=new Date(y,mo-1,da); if(isNaN(d))return{top:iso,bot:""}; const today=new Date(); today.setHours(0,0,0,0); const diff=Math.round((today-d)/86400000); const top=MON[mo-1]+" "+da; if(diff===0)return{top,bot:"Today",rel:true}; if(diff===1)return{top,bot:"Yesterday",rel:true}; return{top,bot:String(y)}; }
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
function money(v){ if(v===""||v==null)return"—"; const s=String(v).trim(); if(s==="-"||s==="")return"—"; return s.startsWith("$")?s:"$"+s; }

export {
  esc,
  normJob, isRealJob, makeId, fmtDateKey, MON, rowDate, longDate,
  todayIso, monthKey, monthLabel, rateChips, money,
};
