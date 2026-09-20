import { start } from "./lib/diligence/standalone-server.mjs";
if (!process.env.SITE_URL && !process.env.VERCEL) process.env.SITE_URL = "http://localhost:" + (process.env.PORT || 3000);
await start({ host: process.env.VERCEL ? "0.0.0.0" : undefined });
