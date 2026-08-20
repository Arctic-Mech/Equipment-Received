/* Minimal Firestore stub: enough surface for app.js, backed by window.__SEED. */
const seed = () => (window.__SEED || {});
export function getFirestore(){ return {stub:true}; }
export function initializeFirestore(){ return {stub:true}; }
export function persistentLocalCache(){ return {}; }
export function persistentMultipleTabManager(){ return {}; }
export function collection(_db, name){ return {__coll:name}; }
export function doc(_db, a, b){ return typeof a==="string" ? {__coll:a,__id:b} : {__coll:a.__coll,__id:b}; }
/* Timestamp-shaped, not a bare Date. Firestore hands back an object with toMillis(); returning a
   Date meant the app's tsMs() fell through to 0 and a just-recorded visit read as "never". */
export function serverTimestamp(){
  const ms = Date.now();
  return { toMillis: () => ms, toDate: () => new Date(ms), seconds: Math.floor(ms / 1000), nanoseconds: 0 };
}
export async function getDoc(ref){
  /* Lets a suite reproduce the read failing while the write succeeded -- which is what a phone
     on one bar in a basement actually does, and the case where the app used to overwrite the
     server's saved-jobs list with the empty array it had not finished loading into. */
  if(typeof window!=="undefined" && window.__GET_FAIL){
    const e=new Error("Failed to get document because the client is offline.");
    e.code="unavailable"; throw e;
  }
  const v=(seed()[ref.__coll]||{})[ref.__id];
  return { exists:()=>!!v, data:()=>v||{}, id:ref.__id, metadata:{fromCache:false} };
}
/* Live doc listeners, so a write echoes back the way Firestore's does. Without this a feature
   that renders from its own snapshot (the shared PTP pool) looks broken in tests while working
   in production -- the write was recorded but nothing ever told the UI about it. */
const docWatchers = [], collWatchers = [];
/* Collections deliberately answer from CACHE only — reproducing the situation where arrivals
   never reports a server snapshot, which used to strand the badge. */
function emitColl(coll, cb){
  const rows = seed()[coll] || {};
  const docs = Object.entries(rows).map(([id,data])=>({ id, data:()=>data }));
  try{ cb({ forEach:f=>docs.forEach(f), metadata:{fromCache:true}, size:docs.length }); }catch(e){}
}
// Lets a suite push a document change the way another device would.
if(typeof window!=="undefined") window.__echoDoc=(coll,id,data)=>echo(coll,id,data);
function echo(coll, id, data){
  const s = (window.__SEED = window.__SEED || {});
  const c = (s[coll] = s[coll] || {});
  c[id] = { ...(c[id] || {}), ...data };            // {merge:true} is what the app always uses
  docWatchers.filter(w => w.coll === coll && w.id === id)
    .forEach(w => { try{ w.cb({ exists:()=>true, data:()=>c[id], id, metadata:{fromCache:false} }); }catch(e){} });
  // ...and everyone listening to the collection that document lives in
  collWatchers.filter(w => w.coll === coll).forEach(w => emitColl(coll, w.cb));
}

/* Lets a suite reproduce a Firestore client the SDK has terminated. Both wordings are real:
   the JS SDK reports "failed-precondition" from some entry points and "The client has already
   been terminated." from others, which is why the app had to recognise both. */
function killIfAsked(){
  const m = window.__FB_KILL;
  if(!m) return;
  const e = new Error(m === "precondition" ? "The operation could not be completed"
                                           : "The client has already been terminated.");
  e.code = m === "precondition" ? "failed-precondition" : "failed-precondition";
  throw e;
}

export async function setDoc(ref, data){
  killIfAsked();
  window.__WRITES = window.__WRITES || [];
  window.__WRITES.push({op:"set", coll:ref.__coll, id:ref.__id, data});
  echo(ref.__coll, ref.__id, data);
  return;
}
export async function deleteDoc(ref){
  window.__WRITES = window.__WRITES || [];
  window.__WRITES.push({op:"del", coll:ref.__coll, id:ref.__id});
  return;
}
export function writeBatch(){ killIfAsked(); return {
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
      docWatchers.push({ coll: ref.__coll, id: ref.__id, cb });
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
      // A collection listener re-fires whenever a document inside it changes, which is how one
      // device hears what another device just wrote. Emitting once and never again made anything
      // driven by that -- cleared alerts arriving from another phone -- untestable.
      collWatchers.push({ coll: ref.__coll, cb });
      emitColl(ref.__coll, cb);
    }
  },0);
  return ()=>{};
}
