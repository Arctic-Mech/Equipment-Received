/* Shared plumbing for the browser suites.

   The one rule that matters here: these tests serve THE REPO ITSELF. An earlier version of this
   harness kept its own copies of app.js/index.html and copied them in before each run, and more
   than once a suite passed green against a stale copy while the real file was broken. Serving
   ../ directly makes that failure impossible. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_DIR = path.resolve(TESTS_DIR, "..");
export const VENDOR_DIR = path.join(TESTS_DIR, "vendor");

const MIME = { ".html":"text/html", ".js":"text/javascript", ".mjs":"text/javascript",
               ".css":"text/css", ".json":"application/json", ".png":"image/png" };

/* Firebase is swapped for a stub via an import map injected into <head>. The app imports it by
   absolute CDN URL, which a plain file server never sees, so the mapping has to be in the page. */
const IMPORT_MAP = `<script type="importmap">{"imports":{
  "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js":"/tests/stubs/fb-app.js",
  "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js":"/tests/stubs/fb-store.js"}}</scr`+`ipt>`;

export async function startServer(){
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    const rel = url === "/" ? "index.html" : url.replace(/^\/+/, "");
    const file = path.join(REPO_DIR, rel);
    // stay inside the repo; a suite asking for ../../etc/passwd is a bug in the suite
    if(!file.startsWith(REPO_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()){
      res.writeHead(404); return res.end("not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "text/plain" });
    let body = fs.readFileSync(file);
    if(path.extname(file) === ".html"){
      const s = body.toString();
      if(!/<head[^>]*>/i.test(s)) throw new Error("index.html has no <head> to inject the import map into");
      body = s.replace(/<head([^>]*)>/i, `<head$1>${IMPORT_MAP}`);
    }
    res.end(body);
  });
  await new Promise(r => server.listen(0, r));
  return { server, port: server.address().port, url: `http://localhost:${server.address().port}/` };
}

/* xlsx, pdf.js and jsPDF load from a CDN with absolute URLs. Serve them from tests/vendor when it
   has been populated (npm run test:setup) so the suites are hermetic and work offline; otherwise
   let the request go to the real CDN so a fresh clone still runs.

   Leaving them UNROUTED and offline is the trap: they do not fail fast, they hang until the
   connection resets, which once showed up as ~12 seconds of idle and looked like a slow app. */
export async function routeCdn(ctx){
  const local = u =>
    u.includes("jspdf")      ? "jspdf.umd.min.js" :
    u.includes("pdf.worker") ? "pdf.worker.min.js" :
    u.includes("pdf.min.js") ? "pdf.min.js" :
    u.includes("xlsx")       ? "xlsx.full.min.js" : null;
  await ctx.route(/cdnjs\.cloudflare\.com|cdn\.sheetjs\.com|fonts\.googleapis\.com|fonts\.gstatic\.com/, route => {
    const u = route.request().url();
    if(/fonts\./.test(u)) return route.fulfill({ status:200, contentType:"text/css", body:"" });
    const name = local(u);
    const file = name && path.join(VENDOR_DIR, name);
    if(file && fs.existsSync(file))
      return route.fulfill({ status:200, contentType:"text/javascript", body: fs.readFileSync(file) });
    return route.continue();
  });
}

export const CHROMIUM = process.env.CHROMIUM_PATH
  || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

/* Every suite reports the same way, so run.sh can tell pass from fail without parsing prose. */
export function report(name, fails, errs){
  console.log("\n" + "=".repeat(60));
  if(errs && errs.length){ console.log("PAGE ERRORS:"); errs.slice(0,15).forEach(e => console.log("  - " + e)); }
  if(fails.length){ console.log("FAILURES:"); fails.forEach(f => console.log("  - " + f)); }
  const ok = !fails.length && !(errs && errs.length);
  console.log(ok ? `PASS  ${name}` : `FAIL  ${name}`);
  return ok ? 0 : 1;
}
