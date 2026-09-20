// lib/diligence/standalone-server.mjs
// A minimal Node HTTP server for the Site Diligence Agent on its own: the
// same api/diligence.js and api/guest.js handlers the product serves, the
// diligence.html workspace, and a health probe. It reproduces the small set
// of Vercel-style request and response helpers those handlers expect and
// nothing else. No database, no account system, no other pages.
//
//   node lib/diligence/standalone-server.mjs        (PORT, HOST, SITE_URL honored)
//
// SITE_URL must be the exact origin the browser uses (default
// http://localhost:3000); same-origin checks on POST compare against it.

import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAX_BODY = 1000000;
const REQUEST_TIMEOUT_MS = 30000;
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; worker-src 'self' blob: https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https://*.basemaps.cartocdn.com https://cdnjs.cloudflare.com; connect-src 'self' https://cdnjs.cloudflare.com https://basemaps.cartocdn.com https://*.basemaps.cartocdn.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'";

async function readRawBody(req, maximum = MAX_BODY) {
  return await new Promise((resolve) => {
    const chunks = []; let size = 0; let stopped = false;
    req.on("data", (c) => { if (stopped) return; size += c.length; if (size > maximum) { stopped = true; chunks.length = 0; resolve(null); return; } chunks.push(c); });
    req.on("end", () => { if (!stopped) resolve(Buffer.concat(chunks)); });
    req.on("error", () => resolve(null));
  });
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("="); if (i < 0) continue;
    const k = part.slice(0, i).trim(); if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

function decorate(res) {
  res.status = function (code) { res.statusCode = code; return res; };
  res.json = function (obj) { if (!res.getHeader("content-type")) res.setHeader("content-type", "application/json; charset=utf-8"); res.end(JSON.stringify(obj)); return res; };
  res.send = function (body) { if (body == null) { res.end(); return res; } if (Buffer.isBuffer(body)) { if (!res.getHeader("content-type")) res.setHeader("content-type", "application/octet-stream"); res.end(body); return res; } if (typeof body === "object") return res.json(body); if (!res.getHeader("content-type")) res.setHeader("content-type", "text/html; charset=utf-8"); res.end(String(body)); return res; };
  res.redirect = function (a, b) { const code = typeof a === "number" ? a : 307; const url = typeof a === "number" ? b : a; res.statusCode = code; res.setHeader("location", String(url)); res.end(); return res; };
}

const handlers = new Map();
function loadHandler(name) {
  if (!handlers.has(name)) handlers.set(name, (name === "diligence" ? import("../../api/diligence.js") : import("../../api/guest.js")).then((m) => m.default));
  return handlers.get(name);
}

async function servePage(res) {
  const file = ["public/diligence.html", "diligence.html"].map((p) => path.join(ROOT, p)).find((p) => existsSync(p));
  if (!file) { res.statusCode = 404; res.setHeader("content-type", "text/plain"); res.end("diligence.html is not in this package."); return; }
  res.statusCode = 200; res.setHeader("content-type", "text/html; charset=utf-8"); res.setHeader("cache-control", "no-cache"); res.end(await readFile(file));
}

export function createServer() {
  return http.createServer(async (req, res) => {
    decorate(res);
    res.setHeader("content-security-policy", CSP);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
    const timer = setTimeout(() => { if (!res.writableEnded) { res.statusCode = 504; res.end(); } }, REQUEST_TIMEOUT_MS);
    let phase = "route";
    try {
      const url = new URL(req.url || "/", "http://localhost");
      req.query = Object.fromEntries(url.searchParams.entries());
      req.cookies = parseCookies(req.headers.cookie);
      if (url.pathname === "/healthz") return res.status(200).json({ ok: true, ready: true, runtime: "standalone", agent: "site-diligence-agent" });
      if (url.pathname === "/" || url.pathname === "/diligence" || url.pathname === "/diligence.html") return await servePage(res);
      const m = /^\/api\/(diligence|guest)$/.exec(url.pathname);
      if (!m) { res.statusCode = 404; return res.json({ ok: false, error: "not_found" }); }
      if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
        const raw = await readRawBody(req);
        if (raw === null) { res.statusCode = 413; return res.json({ ok: false, error: "request_too_large" }); }
        const type = String(req.headers["content-type"] || "");
        if (/^application\/json/i.test(type)) { try { req.body = raw.length ? JSON.parse(raw.toString("utf8")) : {}; } catch { req.body = {}; } }
        else req.body = raw.toString("utf8");
      }
      phase = "load_handler";
      const handler = await loadHandler(m[1]);
      phase = "handler";
      return await handler(req, res);
    } catch (error) {
      const code = /^ERR_[A-Z_]+$/.test(error?.code || "") ? error.code : "internal_error";
      const type = ["Error", "TypeError", "SyntaxError", "ReferenceError"].includes(error?.name) ? error.name : "Error";
      let module;
      if (code === "ERR_MODULE_NOT_FOUND" && typeof error?.url === "string" && error.url.startsWith("file:")) {
        try {
          const relative = path.relative(ROOT, fileURLToPath(error.url));
          if (/^(api|lib|data|studio-runtime)\/[a-zA-Z0-9_./-]+$/.test(relative) && !relative.includes("..")) module = relative;
        } catch { /* No raw import exception is logged. */ }
      }
      // Deliberately exclude raw messages, stacks, request data and URLs.
      console.error(JSON.stringify({ level: "error", evt: "STANDALONE_ERR", err: code, type, phase, module }));
      if (!res.writableEnded) { res.statusCode = 500; res.json({ ok: false, error: "internal_error" }); }
    } finally { clearTimeout(timer); }
  });
}

export async function start(opts = {}) {
  const port = Number(opts.port ?? process.env.PORT ?? 3000);
  const host = opts.host || process.env.HOST || "127.0.0.1";
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.removeListener("error", reject); resolve(); });
  });
  const addr = server.address();
  console.log(JSON.stringify({ level: "info", evt: "STANDALONE_LISTENING", host, port: addr.port, siteUrl: process.env.SITE_URL || "http://localhost:" + addr.port, fixture: process.env.DILIGENCE_FIXTURE_MODE === "1" }));
  return { server, port: addr.port, close: () => new Promise((r) => server.close(r)) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.SITE_URL) process.env.SITE_URL = "http://localhost:" + (process.env.PORT || 3000);
  start().catch(() => { console.error("Standalone server could not start. Check the configured host and port."); process.exit(1); });
}
