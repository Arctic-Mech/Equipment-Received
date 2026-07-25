/* Moved verbatim out of app.js. Depends on $ for the #toast element in index.html. */

import { $ } from "./dom.js";

/* ---------- Toast ---------- */
let toastT; function toast(m){ const t=$("toast"); t.textContent=m; void t.offsetWidth; t.classList.add("show"); clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove("show"),2600); }
// Copy text to clipboard with a fallback for browsers where navigator.clipboard is unavailable
// or blocked (older iOS Safari, non-secure contexts). Returns nothing; shows a toast.
function copyToClipboard(text){
  if(!text){ toast("No name to copy"); return; }
  const done=()=>toast("Name copied");
  const fail=()=>{
    // Fallback: temporary textarea + execCommand("copy")
    try{
      const ta=document.createElement("textarea");
      ta.value=text; ta.setAttribute("readonly",""); ta.style.position="fixed"; ta.style.top="-1000px"; ta.style.opacity="0";
      document.body.appendChild(ta);
      ta.focus(); ta.select(); ta.setSelectionRange(0, text.length);
      const ok=document.execCommand("copy");
      document.body.removeChild(ta);
      toast(ok?"Name copied":"Couldn't copy — long-press to select");
    }catch(_){ toast("Couldn't copy — long-press to select"); }
  };
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(done).catch(fail);
  } else { fail(); }
}

export { toast, copyToClipboard };
