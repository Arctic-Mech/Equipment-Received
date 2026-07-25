/* Moved verbatim out of app.js.

   Device-only photo storage. The photo feature it backed now lives in Firestore
   (see the "Photos (Firebase, 1 per arrival, anyone can add)" section of app.js), so
   nothing calls idbSet/idbGet/idbDel/idbKeys today. Kept intact rather than deleted:
   it is a working, self-contained IndexedDB wrapper with no dependencies, and this
   change is a move, not a cleanup. */

/* ---------- IndexedDB (photos, device-only) ---------- */
function idbOpen(){ return new Promise((res,rej)=>{ const r=indexedDB.open("erPhotos",1); r.onupgradeneeded=()=>r.result.createObjectStore("photos"); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }
async function idbSet(k,v){ const d=await idbOpen(); return new Promise((res,rej)=>{ const t=d.transaction("photos","readwrite"); t.objectStore("photos").put(v,k); t.oncomplete=()=>res(); t.onerror=()=>rej(t.error); }); }
async function idbGet(k){ const d=await idbOpen(); return new Promise((res)=>{ const t=d.transaction("photos","readonly"); const q=t.objectStore("photos").get(k); q.onsuccess=()=>res(q.result||null); q.onerror=()=>res(null); }); }
async function idbDel(k){ const d=await idbOpen(); return new Promise((res)=>{ const t=d.transaction("photos","readwrite"); t.objectStore("photos").delete(k); t.oncomplete=()=>res(); }); }
async function idbKeys(){ const d=await idbOpen(); return new Promise((res)=>{ const t=d.transaction("photos","readonly"); const q=t.objectStore("photos").getAllKeys(); q.onsuccess=()=>res(q.result||[]); q.onerror=()=>res([]); }); }

export { idbOpen, idbSet, idbGet, idbDel, idbKeys };
