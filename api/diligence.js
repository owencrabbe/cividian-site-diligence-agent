// api/diligence.js
// HTTP surface of the Site Diligence Agent. Session-gated (guest or account),
// same-origin on writes, rate limited per action, size limited, and always
// answering in the house envelope: business refusals are 200 with ok:false
// and a note; 401 only for anonymous callers. The work lives in
// lib/diligence/brief.js; this file is the skin.

import { readBody, methodGuard, query, rateLimit, sameOrigin, tooMany, forbidden, getSession, withStorageBoundary } from "../lib/diligence/host.js";
import { capabilities, startRun, reasonRun, refreshRun, loadBrief, listBriefs, ownerKey } from "../lib/diligence/brief.js";
import { resolveSite } from "../lib/diligence/site.js";
import { renderBriefHtml } from "../lib/diligence/render.js";

export const config = { maxDuration: 30 };
const MAX_BODY_BYTES = 65536;
const RATES = { status: [60, 60], site: [30, 60], evidence: [12, 60], reason: [6, 60], refresh: [6, 60], get: [60, 60], list: [30, 60], export: [30, 60] };

function publicBrief(b) {
  if (!b) return b;
  const { owner, ...rest } = b;
  return { ...rest, owner: owner ? { kind: owner.kind } : null };
}

async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  if (!methodGuard(req, res, ["GET", "POST"])) return;
  const q = query(req);
  const action = String(q.action || (req.method === "GET" ? "status" : "")).toLowerCase();
  if (!RATES[action]) return res.status(200).json({ ok: false, error: "unknown_action", note: "Actions: status, site, evidence, reason, refresh, get, list, export." });
  if (req.method === "POST" && !["site", "evidence", "reason", "refresh"].includes(action)) return res.status(200).json({ ok: false, error: "method_action_mismatch", note: "Use GET for " + action + "." });
  if (req.method === "GET" && ["site", "evidence", "reason", "refresh"].includes(action)) return res.status(200).json({ ok: false, error: "method_action_mismatch", note: "Use POST for " + action + "." });
  if (req.method === "POST" && !sameOrigin(req)) return forbidden(res);
  // Read-only capabilities must explain a storage outage; all workflow
  // actions retain the shared, fail-closed limiter.
  const rl = await rateLimit(req, "diligence-" + action, RATES[action][0], RATES[action][1], { failOpen: action === "status" });
  if (!rl.ok) return tooMany(res, rl);

  const session = await getSession(req);
  const owner = ownerKey(session);
  if (action === "status") {
    const caps = await capabilities(process.env);
    return res.status(200).json({ ok: true, ...caps, session: { kind: owner ? owner.kind : "none", verified: !!(session && session.verified === true) } });
  }
  if (!owner) return res.status(401).json({ ok: false, error: "auth_required", note: "Start a guest session or sign in to use the Site Diligence Agent." });

  let body = {};
  if (req.method === "POST") {
    body = await readBody(req);
    if (!body || typeof body !== "object" || Array.isArray(body)) body = {};
    if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) return res.status(413).json({ ok: false, error: "request_too_large" });
  }

  const ctl = new AbortController();
  const abort = () => ctl.abort();
  req.on?.("aborted", abort);
  const close = () => { if (!res.writableEnded) abort(); };
  res.on?.("close", close);
  try {
    if (action === "site") {
      const t = Date.now();
      const out = await resolveSite({ query: body.query, lat: body.lat, lon: body.lon, city: body.city, state: body.state, parcelIndex: Number.isInteger(body.parcelIndex) ? body.parcelIndex : undefined });
      return res.status(200).json({ ...out, stage: { name: "site", ms: Date.now() - t } });
    }
    if (action === "evidence") {
      const t = Date.now();
      const out = await startRun({ site: body.site, objective: body.objective, assumptions: body.assumptions }, owner);
      if (!out.ok) return res.status(200).json(out);
      return res.status(200).json({ ok: true, id: out.brief.id, brief: publicBrief(out.brief), stage: { name: "evidence", ms: Date.now() - t } });
    }
    if (action === "reason") {
      const t = Date.now();
      const out = await reasonRun(String(body.id || ""), owner, {}, { signal: ctl.signal });
      if (res.destroyed) return;
      if (!out.ok) return res.status(200).json(out);
      return res.status(200).json({ ok: true, id: out.brief.id, brief: publicBrief(out.brief), stage: { name: "reason", ms: Date.now() - t } });
    }
    if (action === "refresh") {
      const t = Date.now();
      const out = await refreshRun(String(body.id || ""), owner, {}, { signal: ctl.signal, reason: body.reason === true });
      if (res.destroyed) return;
      if (!out.ok) return res.status(200).json(out);
      return res.status(200).json({ ok: true, id: out.brief.id, brief: publicBrief(out.brief), changes: out.brief.changes, stage: { name: "refresh", ms: Date.now() - t } });
    }
    if (action === "list") return res.status(200).json({ ok: true, briefs: await listBriefs(owner) });
    const brief = await loadBrief(owner, String(q.id || ""));
    if (!brief) return res.status(200).json({ ok: false, error: "not_found", note: "No saved brief with that id belongs to this session." });
    if (action === "get") return res.status(200).json({ ok: true, brief: publicBrief(brief) });
    const format = String(q.format || "json").toLowerCase();
    if (format === "html") {
      const html = renderBriefHtml(publicBrief(brief));
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Content-Disposition", "inline; filename=\"" + brief.id + ".html\"");
      return res.status(200).end(html);
    }
    res.setHeader("Content-Disposition", "attachment; filename=\"" + brief.id + ".json\"");
    return res.status(200).json(publicBrief(brief));
  } finally { req.off?.("aborted", abort); res.off?.("close", close); }
}

export default withStorageBoundary(handler);
