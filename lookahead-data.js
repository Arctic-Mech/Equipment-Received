/* Shared Look-Ahead data — the trade labels and the sample company — defined once and used from
   both sides: the standalone page (lookahead.js) reads the labels and auto-seeds the sample on a
   fresh database; the main app's Admin (app.js) loads or removes the sample from "Manage People".

   The sample uses its own clearly-fake job numbers and foreman ids (SMP- / smp-) so it can never
   collide with a real job or a real person's week, and it records exactly which documents it wrote
   in laMeta/seed, so removing it deletes precisely those and nothing else. */
import { doc, getDoc, setDoc, writeBatch, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

export const LA_TRADES = { sheet:"Sheet Metal", piping:"Piping" };

function isoD(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
function mondayOf(d){ const x=new Date(d); const off=(x.getDay()+6)%7; x.setDate(x.getDate()-off); x.setHours(0,0,0,0); return x; }
function addDays(iso,n){ const d=new Date(iso+"T00:00:00"); d.setDate(d.getDate()+n); return isoD(d); }
const rid=()=>"x"+Math.random().toString(36).slice(2,9);

/* Lay down a full sample company. Returns the ids written so the caller can report scale. */
export async function seedSampleCompany(db){
  const CUR=isoD(mondayOf(new Date()));
  const wid=(id,ws)=>`${id}__${ws}`;
  // id, first+last, trade
  const foremen=[
    ["smp-jaren","Jaren (sample)","sheet"],
    ["smp-marcus","Marcus (sample)","sheet"],
    ["smp-pete","Pete (sample)","piping"],
    ["smp-luis","Luis (sample)","piping"],
  ];
  const fname=id=>(foremen.find(f=>f[0]===id)||[,""])[1];
  // number, name, [[foremanId]]
  const jobs=[
    ["SMP-0150","Riverside Medical Center",  ["smp-jaren","smp-pete"]],
    ["SMP-0200","Cedar High School",         ["smp-marcus"]],
    ["SMP-0300","Summit Office Tower",        ["smp-jaren","smp-luis"]],
    ["SMP-0147","North Valley Data Center",   ["smp-marcus","smp-pete"]],
    ["SMP-0210","Harbor Logistics Warehouse", ["smp-luis"]],
    ["SMP-0255","Grandview Apartments",       ["smp-marcus"]],
    ["SMP-0312","Lakeside Clinic",            ["smp-pete"]],
    ["SMP-0355","Civic Center Renovation",    ["smp-jaren"]],
  ];
  const acts={ sheet:["Hang duct mains","Set VAV boxes","Install grilles & diffusers","Fab shop spool delivery","Seal & insulate duct"],
               piping:["Rough-in chilled water","Set pumps","Hydro test risers","Install hangers","Trim-out fixtures"] };
  const sampleReqs=trade=>({
    labor:trade==="sheet"?"2 sheet metal mechanics + 1 apprentice steady; add a 2-man crew for the mains in week 2."
                         :"3 pipefitters through the shutdown window; 1 welder on call for the risers.",
    fab:"Spools detailed and released; shop delivering in batches Tuesday and Thursday.",
    special:"Scissor lift certs current. Firestop special inspection to be scheduled before cover-up.",
    sub:"Coordinating ceiling grid with the drywall sub; need their layout before we set diffusers.",
    material:"Hangers and strut on site. Grilles arriving week 2 — follow up with vendor on the VAV boxes.",
    co:"RFI 214 (ceiling height at line D) may drive a change order — waiting on the GC's answer.",
  });
  // Build a per-day crew pattern (21 days): work Mon–Thu each week, ramping a little by week.
  const patternFor=(base)=>{ const d=new Array(21).fill(0);
    for(let wk=0;wk<3;wk++){ const crew=base+wk; for(let dd=0;dd<4;dd++) d[wk*7+dd]=crew; } return d; };

  const batch=writeBatch(db);
  const jobIds=[], weekIds=[];
  jobs.forEach(([num,name,fore])=>{
    batch.set(doc(db,"laJobs",num),{ jobNumber:num, jobName:name,
      foremen:fore.map(id=>({id,name:fname(id),trade:(foremen.find(f=>f[0]===id)||[])[2]})),
      sample:true, createdAt:serverTimestamp(), updatedAt:serverTimestamp() });
    jobIds.push(num);
  });
  foremen.forEach(([id,name,trade])=>{
    const theirJobs=jobs.filter(j=>j[2].includes(id)).map(j=>j[0]);
    [CUR, addDays(CUR,-7)].forEach((ws,wi)=>{
      const tasks=[];
      theirJobs.forEach((job,ji)=>{ for(let k=0;k<2;k++){
        tasks.push({id:rid(),job,text:acts[trade][(ji+k)%acts[trade].length],days:patternFor(2+((ji+k+wi)%3))}); } });
      const wi2=wid(id,ws);
      batch.set(doc(db,"laWeeks",wi2),{ foremanId:id, foremanName:name, trade, weekStart:ws, tasks,
        reqs:sampleReqs(trade), dateCompleted:wi===1?addDays(ws,4):"", sample:true, updatedAt:serverTimestamp() });
      weekIds.push(wi2);
    });
  });
  batch.set(doc(db,"laMeta","seed"),{ seeded:true, removed:false, jobIds, weekIds, at:serverTimestamp() });
  await batch.commit();
  return { jobs:jobIds.length, weeks:weekIds.length };
}

/* Remove exactly the documents the sample wrote, by the ids recorded in laMeta/seed. */
export async function removeSampleData(db){
  let meta={};
  try{ const s=await getDoc(doc(db,"laMeta","seed")); meta=s.exists()?s.data():{}; }catch(e){ meta={}; }
  const batch=writeBatch(db);
  (meta.jobIds||[]).forEach(id=>batch.delete(doc(db,"laJobs",id)));
  (meta.weekIds||[]).forEach(id=>batch.delete(doc(db,"laWeeks",id)));
  batch.set(doc(db,"laMeta","seed"),{ seeded:false, removed:true, jobIds:[], weekIds:[], at:serverTimestamp() });
  await batch.commit();
}
