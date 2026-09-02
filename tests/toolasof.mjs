/* The tool rental list is a snapshot of one day, and that day is in the PDF's file name. This
   makes sure the app reads the day out of the name (not just when it was uploaded) and shows it
   obviously — a prominent "accurate as of <day>" banner plus a per-job tag. */
import { chromium } from "playwright";
import { startServer, routeCdn, CHROMIUM, report } from "./serve.mjs";
const { server, port: PORT } = await startServer();

const fails=[]; const chk=(c,m)=>{ if(!c) fails.push(m); };
const errs=[];
const browser=await chromium.launch({executablePath:CHROMIUM,args:["--no-sandbox"]});

const seed={
  people:{"p-jaren-eells":{first:"Jaren",last:"Eells",email:"jareneells@arctic.biz",
    nameNorm:"jaren eells",savedJobs:["25-0150"],jobOrder:[],removedJobs:[]}},
  arrivals:{}, rentals:{},
  toolRentals:{ t1:{jobNumber:"25-0150",jobName:"Alpha",toolType:"Core drill",toolId:"CD-9",
    rentalStarted:"2026-07-05",billingDays:5,dailyRate:40,billingTotal:"200",discountedRate:"180",status:"Out",seq:1} },
  // The real report is monthly; its name carries a year + month, no day.
  pdfStore:{ meta:{ name:"Webduct Tool Rental_2026-7 July.pdf", pages:3, pageMap:{"25-0150":1}, uploadedAt:Date.now() } },
  shares:{}, webductOrders:{},
  config:{lastImport:{emailDateMs:1,importedAt:"2026-08-05"}},
};

const ctx=await browser.newContext({viewport:{width:1280,height:1000}});
await routeCdn(ctx);
const page=await ctx.newPage();
page.on("pageerror",e=>errs.push("pageerror: "+e.message));
page.on("console",m=>{const t=m.text();
  if(m.type()==="error" && !/net::ERR_|Failed to load resource/.test(t)) errs.push("console: "+t);});
await page.addInitScript(s=>{ window.__SEED=s;
  localStorage.setItem("er_user",JSON.stringify({first:"Jaren",last:"Eells",email:"jareneells@arctic.biz",id:"p-jaren-eells"}));
  localStorage.setItem("tut_done","1"); },seed);
await page.goto(`http://localhost:${PORT}/`,{waitUntil:"networkidle"});
await page.waitForTimeout(700);

// Navigate to Rentals → Tool Rentals so the pane (and its banner) are visible.
await page.locator("#feedGroupCaret").click();
await page.locator('[data-groupview="rentals"]').click();
await page.waitForTimeout(200);
await page.locator('#rentSeg button[data-rentseg="tool"]').click();
await page.waitForTimeout(250);

const banner=()=>page.locator("#toolAsOf").innerText();

/* ---- the month comes from the real monthly file name, shown obviously ---- */
{
  const t=await banner();
  console.log("banner (2026-7 July):", JSON.stringify(t));
  chk(/Accurate as of/.test(t), "the banner doesn't say it's accurate as of a period");
  chk(t.includes("July 2026"), `the banner didn't read the month from the file name: "${t}"`);
  chk(/month this report covers/i.test(t), "a monthly report should say it's the month it covers");
  chk(/changed since/i.test(t), "the banner doesn't warn the snapshot may be stale");
  chk(t.includes("Webduct Tool Rental_2026-7 July.pdf"), "the file name isn't shown");
  chk(await page.locator("#toolAsOf.tool-asof").count()===1, "the prominent (amber) banner style isn't applied");
  // per-job tag reflects the month
  const card=await page.locator("#toolList .tc").first().innerText();
  chk(/as of Jul/.test(card), `the tool job card doesn't carry an as-of tag: "${card}"`);
}

/* ---- month-level and day-level file-name shapes all parse ---- */
async function reMeta(name){
  await page.evaluate(n=>window.__echoDoc("pdfStore","meta",{name:n}), name);
  await page.waitForTimeout(200);
  return banner();
}
for(const [name,want] of [
  // month-level (the report is monthly)
  ["Webduct Tool Rental_2026-7 July.pdf","July 2026"],
  ["Tool Rental July 2026.pdf","July 2026"],
  ["Tool Rental 2026-07.pdf","July 2026"],
  ["Tool Rental 07-2026.pdf","July 2026"],
  ["Webduct Tool Rental_2026-12 December.pdf","December 2026"],
  // day-level (older/other exports)
  ["Tool Rental Report 2026-12-01.pdf","Dec 1, 2026"],
  ["Webduct Tool Rental Aug 5 2026.pdf","Aug 5, 2026"],
  ["Tool Rental 1-3-26.pdf","Jan 3, 2026"],
  ["ToolRental_20260704.pdf","Jul 4, 2026"],
]){
  const t=await reMeta(name);
  console.log(`  ${name} -> ${JSON.stringify(t.split("—")[0].trim())}`);
  chk(t.includes(want), `"${name}" should read as ${want}, banner was "${t}"`);
}

/* ---- a name with no date falls back to the upload day, still shown ---- */
{
  const t=await reMeta("Tool Rental Report.pdf");
  console.log("no-date fallback:", JSON.stringify(t));
  chk(/uploaded/i.test(t), "a nameless-date report should fall back to the upload day");
  chk(t.includes("Tool Rental Report.pdf"), "the file name should still be shown on the fallback");
  chk(await page.locator("#toolAsOf").isVisible(), "the banner should still show on the fallback");
}

/* ---- the SAME warning shows in My Jobs on the Tool Rentals segment ---- */
{
  await reMeta("Webduct Tool Rental_2026-7 July.pdf");   // the real monthly report
  await page.locator("nav.tabs .tab[data-view='jobs']").click();
  await page.waitForTimeout(300);
  await page.locator('#mjSeg button[data-seg="tools"]').click();
  await page.waitForTimeout(300);
  const mjBanner=page.locator("#mjItems .tool-asof");
  chk(await mjBanner.count()===1, "the snapshot warning is missing from My Jobs' tool rentals");
  const t=await mjBanner.innerText();
  console.log("My Jobs tool banner:", JSON.stringify(t));
  chk(/Accurate as of/.test(t) && t.includes("July 2026"),
      `My Jobs should carry the same as-of warning, got "${t}"`);
  // and it's NOT shown on the arrivals segment
  await page.locator('#mjSeg button[data-seg="arrivals"]').click();
  await page.waitForTimeout(250);
  chk(await page.locator("#mjItems .tool-asof").count()===0, "the tool snapshot warning leaked onto the arrivals segment");
  console.log("My Jobs tool warning matches the Tool Rentals tab: ok");
}

await ctx.close();
process.exit(report("tool as-of", fails, errs) || (await browser.close(), server.close(), 0));
