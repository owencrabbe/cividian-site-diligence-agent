import { createServer, start } from "./lib/diligence/standalone-server.mjs";
if (!process.env.SITE_URL && !process.env.VERCEL) process.env.SITE_URL = "http://localhost:" + (process.env.PORT || 3000);
const server = process.env.VERCEL ? createServer() : (await start()).server;
export default server;
