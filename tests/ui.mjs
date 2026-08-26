/* Offline browser test of the condensed tabs + Safety tab.
   Firebase is stubbed via an import map; data comes from window.__SEED. */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { startServer, routeCdn, CHROMIUM, TESTS_DIR } from "./serve.mjs";

const { server, port: PORT } = await startServer();

const SEED = {
  people: { "p-jaren-eells": { first: "Jaren", last: "Eells", email: "jareneells@arctic.biz", nameNorm: "jaren eells" } },
  arrivals: { a1: { dateReceived: "2026-07-29", jobNumber: "25-0150", jobName: "Test Job", description: "Widget", supplier: "Acme", seq: 1 } },
  rentals: { r1: { rentalId: "RB1", jobNumber: "25-0150", equipment: "Genie S45", dateRented: "2026-07-01", status: "Renting", rate: "250/1100/3200", seq: 1 } },
  safetyPoints: {
    p1: { name: "ALEXANDER; JEREMY", shirt: "xl", start: 2500, awards: { "1/19": 100, "3/13": 100 }, used: 0, extra: 0, total: 2700 },
    p2: { name: "KING; JUDSON C.", shirt: "l", start: 2150, awards: { "1/19": 200 }, used: -4500, extra: 0, total: -2150 },
  },
  safetyTraining: {
    t1: { name: "Chris Brown", course: "Forklift", instructor: "Hailey Latherow", date: "2024-12-05", expires: "2027-12-05" },
    t2: { name: "Alex Garcia", course: "Scissor Lift", instructor: "Hailey Sorensen", date: "2026-03-13", expires: "2026-09-01" },
    t3: { name: "AJ Stansbury", course: "Respirator Fit Test", instructor: "Onsite Health", date: "2025-10-09", expires: "2025-11-01" },
    t4: { name: "Aaron Vanrheen", course: "OSHA 30", instructor: "OSHA", date: "2008-02-01", expires: "" },
    t5: { name: "Chris Brown", course: "Ladders", instructor: "Hailey Latherow", date: "2021-02-05", expires: "" },
    t6: { name: "Chris Brown", course: "MEWP", instructor: "Hailey Sorensen", date: "2024-12-05", expires: "2027-12-05" },
    t7: { name: "Andy Lee", course: "Fall Protection", instructor: "Hand Entered", date: "2020-01-01", expires: "2021-01-01", source: "admin-edit" },
  },
  safetyDrugCards: {
    d1: { name: "Ted Carr", tested: "2024-09-09", expires: "2025-03-09" },
    d2: { name: "Steven Duncan", tested: "2026-08-16", expires: "2027-02-16" },
    d3: { name: "Daniel Shamray", tested: "2026-05-10", expires: "2026-09-10" },
  },
  safetySds: { s1: { record: "1", product: "Acetylene", use: "Analytical Chemistry", vendor: "Airgas", issueDate: "2021-06-21", dept: "All", pages: "11" } },
  config: { safetyMeta: { points: { count: 2 }, training: { count: 7 }, sds: { count: 1 }, drug: { count: 3 } } },
};

const browser = await chromium.launch({ executablePath: CHROMIUM, args:["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
const errors = [];
page.on("pageerror", e => errors.push("pageerror: " + e.message + "\n      " + String(e.stack||"").split("\n").slice(1,4).join("\n      ")));
// The Google-Fonts CDN is deliberately unreachable in this offline harness; that noise is
// not an app error, so it is filtered rather than allowed to mask real ones.
page.on("console", m => { const t = m.text();
  if (m.type() === "error" && !/net::ERR_|Failed to load resource/.test(t)) errors.push("console: " + t); });

await page.addInitScript(seed => {
  window.__SEED = seed;
  localStorage.setItem("er_user", JSON.stringify({ first: "Jaren", last: "Eells", email: "jareneells@arctic.biz", id: "p-jaren-eells" }));
}, SEED);
await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(600);

const fails = [];
const chk = (cond, msg) => { if (!cond) fails.push(msg); };
const txt = async sel => (await page.locator(sel).first().innerText().catch(() => "")).trim();

// 1. Exactly three tab targets, and Admin is a header button.
const tabsVisible = await page.locator("nav.tabs .tab[data-view]:visible").allInnerTexts();
console.log("visible tabs:", JSON.stringify(tabsVisible.map(t => t.split("\n")[0].trim())));
chk(tabsVisible.length === 3, `expected 3 tabs, got ${tabsVisible.length}`);
chk(await page.locator("#btnAdminOpen").isVisible(), "Admin header button not visible");
chk(await page.locator("nav.tabs .tab[data-view='admin']").count() === 0, "Admin still present as a tab");
chk(await page.locator("nav.tabs .tab[data-view='rentals']").count() === 0, "Rentals still present as a tab");

// 2. Safety tab exists and opens.
chk(tabsVisible.some(t => /safety/i.test(t)), "no Safety tab");
await page.locator("nav.tabs .tab[data-view='safety']").click();
await page.waitForTimeout(250);
chk(await page.locator("#view-safety").isVisible(), "Safety view did not open");
chk(await page.locator(".sub-pill").count() === 6, "expected 6 Safety sub-pills (Points/Training/SDS/Drug Cards/Med Gas/PTP)");

// 3. Safety data rendered.
const ptsRows = await page.locator("#sfPointsList .sf-grp").count();
console.log("points rows:", ptsRows, "| meta:", await txt("#sfPointsMeta"));
chk(ptsRows === 2, `expected 2 points rows, got ${ptsRows}`);
chk(await page.locator("#sfPointsList .sf-crs").count() === 0, "points details visible before expanding");
await page.locator("#sfPointsList [data-sfpoint]").nth(1).click();
await page.waitForTimeout(200);
const usedTxt = await page.locator("#sfPointsList .sf-neg").first().innerText().catch(() => "");
console.log("used chip after expanding:", JSON.stringify(usedTxt));
chk(!usedTxt.includes("-"), `negative 'used' leaked to the UI: ${usedTxt}`);
await page.locator("#sfPointsList [data-sfpoint]").nth(1).click();
await page.waitForTimeout(150);

await page.locator("[data-safety='training']").click();
await page.waitForTimeout(200);
// Training is grouped by PERSON now: 6 records across 4 people => 4 rows.
const trPeople = await page.locator("#sfTrainList .sf-grp").count();
const trNames = await page.locator("#sfTrainList .sf-lname").allInnerTexts();
console.log("training people rows:", trPeople, JSON.stringify(trNames));
chk(trPeople === 5, `expected 5 grouped people, got ${trPeople}`);
chk(await page.locator("#sfTrainList .sf-crs").count() === 0, "courses visible before expanding");
chk(/expired/i.test(await txt("#sfTrainList .sf-tag")), "person with an expired course did not sort first");
// Expanding one person shows only their courses.
await page.locator("#sfTrainList [data-sfperson='Chris Brown']").click();
await page.waitForTimeout(200);
const crs = await page.locator("#sfTrainList .sf-grp.open .sf-crs").count();
console.log("Chris Brown courses after expanding:", crs);
chk(crs === 3, `expected Chris Brown to have 3 courses, got ${crs}`);
await page.locator("#sfTrainList [data-sfperson='Chris Brown']").click();
await page.waitForTimeout(150);
chk(await page.locator("#sfTrainList .sf-crs").count() === 0, "collapse did not close the person");
// Filters operate on people.
await page.locator("[data-trainfilter='expired']").click();
await page.waitForTimeout(200);
chk(await page.locator("#sfTrainList .sf-grp").count() === 2, "Expired filter should show the 2 people with expired courses");
await page.locator("[data-trainfilter='all']").click();
await page.waitForTimeout(150);
// A course search finds the person who has it.
await page.locator("#sfTrainSearch").fill("forklift");
await page.waitForTimeout(250);
const hit = await page.locator("#sfTrainList .sf-lname").allInnerTexts();
console.log("search 'forklift' ->", JSON.stringify(hit));
chk(hit.length === 1 && hit[0] === "Chris Brown", `course search returned ${JSON.stringify(hit)}`);
chk(await page.locator("#sfTrainList .sf-grp.open").count() === 0, "search auto-expanded a row — nothing should open unless clicked");
chk(await page.locator("#sfTrainList .sf-crs").count() === 0, "search auto-expanded courses");
await page.locator("#sfTrainSearch").fill("");
await page.waitForTimeout(200);

await page.locator("[data-safety='sds']").click();
await page.waitForTimeout(200);
chk(await page.locator("#sfSdsList .sf-grp").count() === 1, "SDS row missing");
chk(await page.locator("#sfSdsList .sf-lname").first().innerText() === "Acetylene", "SDS name row wrong");
await page.locator("[data-safety='drug']").click();
await page.waitForTimeout(250);
const drugRows = await page.locator("#sfDrugList .sf-grp").count();
console.log("drug rows:", drugRows, "| first badge:", JSON.stringify(await txt("#sfDrugList .sf-badge")));
chk(drugRows === 3, `expected 3 drug cards, got ${drugRows}`);
chk(/expired/i.test(await txt("#sfDrugList .sf-badge")), "expired drug card did not sort to the top");
await page.locator("[data-drugfilter='expired']").click();
await page.waitForTimeout(200);
chk(await page.locator("#sfDrugList .sf-grp").count() === 1, "Expired drug filter did not narrow to 1");
await page.locator("[data-drugfilter='expiring']").click();
await page.waitForTimeout(200);
chk(await page.locator("#sfDrugList .sf-grp").count() === 1, "Expiring-soon drug filter did not narrow to 1");
await page.locator("[data-drugfilter='all']").click();
await page.waitForTimeout(150);

// 4. The Arrivals/Rentals/Deliveries switcher.
await page.locator("nav.tabs .tab[data-view='feed']").click();
await page.waitForTimeout(200);
chk(await page.locator("#feedGroupMenu").isVisible() === false, "menu open before the caret was tapped");
await page.locator("#feedGroupCaret").click();
await page.waitForTimeout(200);
chk(await page.locator("#feedGroupMenu").isVisible(), "caret did not open the menu");
const items = await page.locator("#feedGroupMenu .tab-menu-item:visible").count();
console.log("switcher items:", items);
chk(items === 3, `expected 3 switcher items, got ${items}`);
await page.locator("[data-groupview='rentals']").click();
await page.waitForTimeout(250);
chk(await page.locator("#view-rentals").isVisible(), "Rentals view did not open");
console.log("tab label after picking Rentals:", JSON.stringify(await txt("#feedGroupLabel")));
chk((await txt("#feedGroupLabel")).toLowerCase() === "rentals", "grouped tab label did not follow the view");
chk(await page.locator("nav.tabs .tab[data-view='feed']").getAttribute("class").then(c => c.includes("active")), "grouped tab lost its active state on Rentals");
chk(await page.locator("#feedGroupMenu").isVisible() === false, "menu stayed open after choosing");
chk(location => true, "");
await page.locator("nav.tabs .tab[data-view='jobs']").click();
await page.waitForTimeout(150);
await page.locator("nav.tabs .tab[data-view='feed']").click();
await page.waitForTimeout(200);
chk(await page.locator("#view-rentals").isVisible(), "grouped tab did not return to the last-used view (Rentals)");

// 5. Admin button opens Admin.
await page.locator("#btnAdminOpen").click();
await page.waitForTimeout(250);
chk(await page.locator("#view-admin").isVisible(), "Admin view did not open from the header button");
chk(await page.locator("#btnSfPoints").count() === 1, "Safety upload buttons missing from Admin");
chk(await page.locator("#btnSfDrug").count() === 0, "Drug Cards still has its own Admin upload button");

// 6. Permissions still gate the hidden views.
// addInitScript re-runs on reload and would reset __SEED, so register the new perms as a
// LATER init script (they run in order, so this one wins).
SEED.people["p-jaren-eells"].perms = { feed: true, rentals: false, deliveries: false, jobs: true, safety: false, admin: true };
await page.addInitScript(seed => { window.__SEED = seed; }, SEED);
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(700);
const items2 = await page.locator("#feedGroupMenu .tab-menu-item").evaluateAll(els => els.filter(e => e.style.display !== "none").length);
console.log("switcher items with rentals+deliveries blocked:", items2);
chk(items2 === 1, `expected 1 allowed switcher item, got ${items2}`);
chk(await page.locator("nav.tabs .tab[data-view='safety']").isVisible() === false, "Safety tab shown despite being blocked");
chk(await page.locator("#feedGroupCaret").isVisible() === false, "caret shown when there is nothing to switch to");

// 7. Admin editing on the Safety panes.
// Section 6 deliberately blocked Safety; give the permissions back before testing the editor.
delete SEED.people["p-jaren-eells"].perms;
await page.addInitScript(seed => { window.__SEED = seed; }, SEED);
await page.evaluate(() => sessionStorage.setItem("er_admin", "1"));
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(700);
await page.locator("nav.tabs .tab[data-view='safety']").click();
await page.waitForTimeout(300);
chk(await page.locator("[data-sfadd='points']").isVisible(), "no Add button on Points when admin is unlocked");
await page.locator("[data-safety='training']").click(); await page.waitForTimeout(250);
chk(await page.locator("[data-sfadd='training']").isVisible(), "no Add button on Training");
// Edit buttons live inside the expanded row, not on the collapsed line.
chk(await page.locator("[data-sfedit]").count() === 0, "edit buttons visible while everything is collapsed");
await page.locator("#sfTrainList [data-sfperson='Chris Brown']").click();
await page.waitForTimeout(250);
chk(await page.locator("#sfTrainList [data-sfedit]").count() === 3, "expected an Edit button per course");
chk(await page.locator("[data-sfdelperson='Chris Brown']").count() === 1, "no remove-person action");
// Round-trip an edit: tick "ignore" and save.
await page.locator("#sfTrainList [data-sfedit]").first().click();
await page.waitForTimeout(300);
chk(await page.locator("#sfEditModal.show").count() === 1, "editor modal did not open");
chk(await page.locator("#sfF_silenced").count() === 1, "no silence checkbox on a training record");
chk(await page.locator("#sfF_pinned").count() === 1, "no pin checkbox in the editor");
await page.locator("#sfF_silenced").check();
await page.locator("#sfEditSave").click();
await page.waitForTimeout(300);
const writes = await page.evaluate(() => window.__WRITES || []);
const lastSet = [...writes].reverse().find(w => w.op === "set" && w.coll === "safetyTraining");
console.log("write on save:", JSON.stringify(lastSet && { coll: lastSet.coll, silenced: lastSet.data.silenced, name: lastSet.data.name }));
chk(!!lastSet, "saving wrote nothing to safetyTraining");
chk(lastSet && lastSet.data.silenced === true, "the silence flag was not persisted");
chk(await page.locator("#sfEditModal.show").count() === 0, "editor stayed open after saving");
// Add a brand-new SDS sheet.
await page.locator("[data-safety='sds']").click(); await page.waitForTimeout(250);
await page.locator("[data-sfadd='sds']").click();
await page.waitForTimeout(300);
await page.locator("#sfF_product").fill("Test Chemical");
await page.locator("#sfEditSave").click();
await page.waitForTimeout(300);
const sdsWrite = [...(await page.evaluate(() => window.__WRITES || []))].reverse().find(w => w.op === "set" && w.coll === "safetySds");
console.log("new SDS write:", JSON.stringify(sdsWrite && sdsWrite.data.product));
chk(sdsWrite && sdsWrite.data.product === "Test Chemical", "adding an SDS sheet did not write");

// 8. Silencing: one click, drops out of Expired, lands in Silenced, no tag on the name.
await page.locator("[data-safety='training']").click(); await page.waitForTimeout(250);
await page.locator("#sfTrainList [data-sfperson='AJ Stansbury']").click();
await page.waitForTimeout(250);
// Chris Brown is still open from section 7, so scope this to AJ Stansbury's own group.
const ajGrp = page.locator("#sfTrainList .sf-grp", { has: page.locator("[data-sfperson='AJ Stansbury']") });
chk(await ajGrp.locator("[data-sfsilence]").count() === 1, "no Silence button on AJ Stansbury's course");
const silBtn = ajGrp.locator("[data-sfsilence]").first();
console.log("silence button:", JSON.stringify((await silBtn.innerText()).trim()));
await silBtn.click();
await page.waitForTimeout(300);
const silWrite = [...(await page.evaluate(() => window.__WRITES || []))].reverse().find(w => w.op === "set" && w.coll === "safetyTraining");
console.log("silence write:", JSON.stringify(silWrite && silWrite.data));
chk(silWrite && silWrite.data.silenced === true, "silencing did not persist");
chk(silWrite && silWrite.data.source === undefined, "silencing should not mark the row hand-edited");
// Reflect it in the seed and reload to see the rendered effect.
SEED.safetyTraining.t3.silenced = true;
await page.addInitScript(seed => { window.__SEED = seed; }, SEED);
await page.reload({ waitUntil: "networkidle" }); await page.waitForTimeout(700);
await page.locator("nav.tabs .tab[data-view='safety']").click(); await page.waitForTimeout(200);
await page.locator("[data-safety='training']").click(); await page.waitForTimeout(300);
const chips = await page.locator("[data-trainfilter]").allInnerTexts();
console.log("training chips after silencing:", JSON.stringify(chips.map(c => c.trim())));
chk(chips.some(c => /^Silenced \(1\)/.test(c.trim())), "Silenced chip did not pick it up");
chk(chips.some(c => /^Expired \(1\)/.test(c.trim())), "Expired count did not drop after silencing");
// AJ Stansbury's row must carry no tag now, but the course stays inside his card.
const ajTag = await page.locator("#sfTrainList .sf-grp", { hasText: "AJ Stansbury" }).locator(".sf-tag").count();
console.log("AJ Stansbury name-row tags after silencing:", ajTag);
chk(ajTag === 0, "a silenced course still tags the person's name");
await page.locator("[data-trainfilter='silenced']").click(); await page.waitForTimeout(250);
const silNames = await page.locator("#sfTrainList .sf-lname").allInnerTexts();
console.log("Silenced filter ->", JSON.stringify(silNames));
chk(silNames.length === 1 && silNames[0] === "AJ Stansbury", "Silenced filter wrong");
await page.locator("#sfTrainList [data-sfperson='AJ Stansbury']").click(); await page.waitForTimeout(250);
chk(await page.locator("#sfTrainList .sf-grp.open .sf-crs").count() === 1, "the silenced course vanished from the person's card");
chk(/silenced/i.test(await txt("#sfTrainList .sf-grp.open .sf-badge")), "silenced course lost its badge inside the card");
await page.locator("[data-trainfilter='all']").click(); await page.waitForTimeout(200);

// 9. Upload conflict: a hand-edited row triggers the 3-way prompt.
const conflicts = await page.evaluate(() => {
  const docs = [{ id: Object.keys(window.__SEED.safetyTraining).find(k => window.__SEED.safetyTraining[k].source === "admin-edit"),
                  name: "Andy Lee", course: "Fall Protection", instructor: "From The Report", date: "2020-01-01", expires: "2021-01-01" }];
  return window.__sfTestConflicts ? window.__sfTestConflicts("training", docs).length : -1;
});
console.log("conflicts detected for a changed hand-edited row:", conflicts);
chk(conflicts === 1, `expected 1 conflict, got ${conflicts}`);
const noConf = await page.evaluate(() => {
  const id = Object.keys(window.__SEED.safetyTraining).find(k => window.__SEED.safetyTraining[k].source === "admin-edit");
  const r = window.__SEED.safetyTraining[id];
  return window.__sfTestConflicts("training", [{ id, name: r.name, course: r.course, instructor: r.instructor, date: r.date, expires: r.expires, notes: "" }]).length;
});
console.log("conflicts when the report matches the hand edit:", noConf);
chk(noConf === 0, "an identical row should not prompt");

await browser.close(); server.close();
console.log("\n" + "=".repeat(60));
if (errors.length) { console.log("PAGE ERRORS:"); errors.slice(0, 8).forEach(e => console.log("  -", e)); }
if (fails.length) { console.log("FAILURES:"); fails.forEach(f => console.log("  -", f)); }
if (errors.length || fails.length) process.exit(1);
console.log("all UI checks passed, zero console/page errors");
