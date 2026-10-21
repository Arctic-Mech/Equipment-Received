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
  // number, name, [pm names], [[foremanId]]
  const jobs=[
    ["SMP-0150","Riverside Medical Center",["Dana Fox"],["smp-jaren","smp-pete"]],
    ["SMP-0200","Cedar High School",        ["Dana Fox"],["smp-marcus"]],
    ["SMP-0300","Summit Office Tower",       ["Priya Rao"],["smp-jaren","smp-luis"]],
    ["SMP-0147","North Valley Data Center",  ["Priya Rao","Dana Fox"],["smp-marcus","smp-pete"]],
    ["SMP-0210","Harbor Logistics Warehouse",["Priya Rao"],["smp-luis"]],
    ["SMP-0255","Grandview Apartments",      ["Dana Fox"],["smp-marcus"]],
    ["SMP-0312","Lakeside Clinic",           ["Priya Rao"],["smp-pete"]],
    ["SMP-0355","Civic Center Renovation",   ["Dana Fox","Priya Rao"],["smp-jaren"]],
  ];
  const acts={ sheet:["Hang duct mains","Set VAV boxes","Install grilles & diffusers","Fab shop spool delivery","Seal & insulate duct"],
               piping:["Rough-in chilled water","Set pumps","Hydro test risers","Install hangers","Trim-out fixtures"] };

  const batch=writeBatch(db);
  const jobIds=[], weekIds=[];
  jobs.forEach(([num,name,pms,fore])=>{
    batch.set(doc(db,"laJobs",num),{ jobNumber:num, jobName:name,
      pms:pms.map(n=>({id:"",name:n})),
      foremen:fore.map(id=>({id,name:fname(id),trade:(foremen.find(f=>f[0]===id)||[])[2]})),
      sample:true, createdAt:serverTimestamp(), updatedAt:serverTimestamp() });
    jobIds.push(num);
  });
  foremen.forEach(([id,name,trade])=>{
    const theirJobs=jobs.filter(j=>j[3].includes(id)).map(j=>j[0]);
    [CUR, addDays(CUR,-7)].forEach((ws,wi)=>{
      const tasks=[];
      theirJobs.forEach((job,ji)=>{ for(let wk=1;wk<=3;wk++){
        tasks.push({id:rid(),job,week:wk,text:acts[trade][(ji+wk)%acts[trade].length],headcount:3+((ji+wk+wi)%4)}); } });
      const conflicts=[];
      if(wi===0 && theirJobs[0]){
        conflicts.push({id:rid(),scope:"current",job:theirJobs[0],type:"GC",
          what:"GC overhead work blocked our bay Tue–Wed; crew reassigned.",where:"Level 3 east",when:"Tue",
          impMan:true,impHours:true,impProd:false,impSched:true,hours:16,days:1,resolved:false,pmStatus:""});
        conflicts.push({id:rid(),scope:"upcoming",job:theirJobs[0],type:"Design / RFI",
          what:"Ceiling height conflict with structural steel at column line D.",where:"Area D",when:"Week 2",
          need:"RFI 214 answered by GC before we can set mains.",resolved:false,pmStatus:""});
      }
      const wi2=wid(id,ws);
      batch.set(doc(db,"laWeeks",wi2),{ foremanId:id, foremanName:name, trade, weekStart:ws, tasks, conflicts, sample:true, updatedAt:serverTimestamp() });
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
