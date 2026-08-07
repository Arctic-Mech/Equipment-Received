/* Minimal Firestore stub: enough surface for app.js, backed by window.__SEED. */
const seed = () => (window.__SEED || {});
export function getFirestore(){ return {stub:true}; }
export function initializeFirestore(){ return {stub:true}; }
export function persistentLocalCache(){ return {}; }
export function persistentMultipleTabManager(){ return {}; }
export function collection(_db, name){ return {__coll:name}; }
export function doc(_db, a, b){ return typeof a==="string" ? {__coll:a,__id:b} : {__coll:a.__coll,__id:b}; }
export function serverTimestamp(){ return new Date(); }
export async function getDoc(ref){
  const v=(seed()[ref.__coll]||{})[ref.__id];
  return { exists:()=>!!v, data:()=>v||{}, id:ref.__id, metadata:{fromCache:false} };
}
export async function setDoc(ref, data){
  window.__WRITES = window.__WRITES || [];
  window.__WRITES.push({op:"set", coll:ref.__coll, id:ref.__id, data});
  return;
}
export async function deleteDoc(ref){
  window.__WRITES = window.__WRITES || [];
  window.__WRITES.push({op:"del", coll:ref.__coll, id:ref.__id});
  return;
}
export function writeBatch(){ return {
  set(ref,data){ (window.__WRITES=window.__WRITES||[]).push({op:"set",coll:ref.__coll,id:ref.__id,data}); },
  delete(ref){ (window.__WRITES=window.__WRITES||[]).push({op:"del",coll:ref.__coll,id:ref.__id}); },
  async commit(){} }; }
export function onSnapshot(ref, a, b, c){
  // Real signature: (ref, [options], onNext, [onError]). The connection-badge listener passes
  // options, so the stub has to accept both shapes.
  const hasOpts = a && typeof a === "object" && !("call" in a);
  const opts = hasOpts ? a : {};
  const cb   = hasOpts ? b : a;
  setTimeout(()=>{
    if(ref.__id!==undefined){                       // single doc
      const v=(seed()[ref.__coll]||{})[ref.__id];
      const emit = fromCache => cb({ exists:()=>!!v, data:()=>v||{}, id:ref.__id,
                                     metadata:{fromCache} });
      // With includeMetadataChanges the cache answers first, then the server confirms —
      // that second callback is exactly what the badge was never receiving before.
      if(opts.includeMetadataChanges){
        emit(true);
        setTimeout(()=>emit(window.__PROBE_OFFLINE === true), 120);
      } else {
        emit(false);
      }
    } else {                                        // collection
      const rows=seed()[ref.__coll]||{};
      const docs=Object.entries(rows).map(([id,data])=>({id,data:()=>data}));
      // Collections deliberately answer from CACHE only — reproducing the situation where
      // arrivals never reports a server snapshot, which used to strand the badge.
      cb({ forEach:f=>docs.forEach(f), metadata:{fromCache:true}, size:docs.length });
    }
  },0);
  return ()=>{};
}
