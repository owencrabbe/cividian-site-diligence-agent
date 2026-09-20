// scripts/demo-diligence.mjs
// The core demo from the shell: mint a guest session against a running
// server, resolve the Muncie address, run the agent, print the brief summary,
// the plan, and the run metadata, and save the JSON and HTML exports next to
// this script's output directory. Reads BASE (default http://localhost:3000).
//
//   npm start &   then   node scripts/demo-diligence.mjs
import { writeFile, mkdir } from "node:fs/promises";

const BASE = (process.env.BASE || "http://localhost:3000").replace(/\/+$/, "");
const QUERY = process.env.QUERY || "300 N High St, Muncie, IN";
const OBJECTIVE = process.env.OBJECTIVE || "residential_infill";
const ASSUMPTIONS = { hardCostPerSqft: 210, rentPerSqftMonth: 1.6, capRatePct: 7 };
const OUT = new URL("../build/demo/", import.meta.url);

let cookie = "";
async function call(action, body, format) {
  const url = BASE + "/api/diligence?action=" + action + (format ? "&" + format : "");
  const r = await fetch(url, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", origin: BASE, cookie }, body: body ? JSON.stringify(body) : undefined });
  return format && /format=html/.test(format) ? { status: r.status, text: await r.text() } : { status: r.status, json: await r.json() };
}

const guest = await fetch(BASE + "/api/guest", { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: "{}" });
cookie = (guest.headers.get("set-cookie") || "").split(";")[0];
if (!/^pago_session=/.test(cookie)) { console.error("Could not mint a guest session at " + BASE + " (HTTP " + guest.status + "). Is the server running with SITE_URL=" + BASE + "?"); process.exit(1); }
const status = (await call("status")).json;
console.log("Reasoning mode: " + status.inference.mode + (status.inference.mode === "live" ? " (" + status.inference.model + " on Nebius Token Factory)" : "") + (status.inference.reasons.length ? "\n  unmet: " + status.inference.reasons.join("; ") : ""));

const site = (await call("site", { query: QUERY })).json;
if (!site.ok) { console.error("Site: " + site.error + " " + (site.note || "")); process.exit(1); }
console.log("Site: " + (site.site.parcel.address || site.site.query) + " · parcel " + site.site.parcel.status + (site.site.parcel.lotSqft != null ? " · " + site.site.parcel.lotSqft.toLocaleString("en-US") + " sq ft" : "") + " · " + site.stage.ms + " ms");

const ev = (await call("evidence", { site: site.site, objective: OBJECTIVE, assumptions: ASSUMPTIONS })).json;
if (!ev.ok) { console.error("Evidence: " + ev.error + " " + (ev.note || "")); process.exit(1); }
const answered = ev.brief.evidence.filter((r) => r.status !== "unavailable").length;
console.log("Evidence: " + answered + " of " + ev.brief.evidence.length + " rows answered · " + ev.stage.ms + " ms · brief " + ev.id);
const p = ev.brief.scenarios[0];
console.log("Scenario: " + p.label + " · " + p.readiness.category + " · units " + p.outputs.units + " · gross " + p.outputs.grossSqft + " sq ft · NOI " + p.outputs.noi + " · yield " + p.outputs.yieldOnCost);

const rs = (await call("reason", { id: ev.id })).json;
if (!rs.ok || !rs.brief) { console.error("Reasoning request failed: " + (rs.error || "missing_brief")); process.exit(1); }
const b = rs.brief;
console.log("Reasoning: " + b.run.inference.mode + " · " + b.run.inference.outcome + (b.reasoning ? " · basis " + b.reasoning.basis : "") + (b.reasoning && b.reasoning.model && b.reasoning.model.requestId ? " · request " + b.reasoning.model.requestId + " · " + b.reasoning.model.latencyMs + " ms · " + JSON.stringify(b.reasoning.model.usage) + " · est $" + (b.reasoning.model.costEstimate && b.reasoning.model.costEstimate.usd) : ""));
console.log("\n" + b.summary + "\n");
if (b.reasoning && b.reasoning.output.executive_assessment) console.log("Executive assessment (" + b.reasoning.basis + "):\n" + b.reasoning.output.executive_assessment + "\n");
const plan = b.reasoning && b.reasoning.output.investigation_plan.length ? b.reasoning.output.investigation_plan.map((x) => ({ q: b.questionLibrary.find((q) => q.id === x.question_id), impact: x.impact, method: x.verification_method })) : b.baselinePlan.map((x) => ({ q: { text: x.question }, impact: x.impact, method: x.method }));
console.log("Investigation plan:");
plan.slice(0, 8).forEach((x, i) => console.log("  " + (i + 1) + ". [" + x.impact + "] " + (x.q ? x.q.text : "?") + "\n     " + x.method));

await mkdir(OUT, { recursive: true });
const json = (await call("export", null, "id=" + b.id + "&format=json")).json;
await writeFile(new URL(b.id + ".json", OUT), JSON.stringify(json, null, 2));
const html = (await call("export", null, "id=" + b.id + "&format=html")).text;
await writeFile(new URL(b.id + ".html", OUT), html);
console.log("\nSaved " + b.id + ".json and " + b.id + ".html under build/demo/");
