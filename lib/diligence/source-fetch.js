// Narrow public-source reader. Only the caller's reviewed host directory is
// admitted. Pin a validated public IPv4 address to the TLS connection; do not
// follow redirects, use proxies, send credentials, or reuse an ambient socket.
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
const denied = new BlockList();
for (const [ip, prefix] of [["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.88.99.0",24],["192.168.0.0",16],["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4]]) denied.addSubnet(ip,prefix,"ipv4");
export const publicIpv4 = (ip) => isIP(ip) === 4 && !denied.check(ip,"ipv4");

export async function sourceBytes(url, hosts, limit, deps = {}) {
  const u = new URL(url);
  if (u.protocol !== "https:" || u.username || u.password || u.port || u.hash || !hosts.includes(u.hostname)) throw new Error("source_url_refused");
  const signal = deps.signal ? AbortSignal.any([deps.signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000);
  signal.throwIfAborted();
  let onAbort, addresses;
  try { addresses = await Promise.race([
    (deps.lookup || lookup)(u.hostname, { all: true, family: 4 }),
    new Promise((_, reject) => { onAbort = () => reject(new Error("source_timeout")); signal.addEventListener("abort", onAbort, { once: true }); }),
  ]); } finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
  signal.throwIfAborted();
  if (!addresses.length || addresses.some((a) => !publicIpv4(a.address) || a.family !== 4)) throw new Error("source_address_refused");
  return new Promise((resolve, reject) => {
    const req = (deps.request || request)(u, { agent: false, servername: u.hostname, maxHeaderSize: 16384, signal,
      headers: { accept: "application/json, text/plain, text/html, application/pdf, image/*", "accept-encoding": "identity", "user-agent": "Cividian public ordinance research" },
      lookup: (_host, options, callback) => options.all ? callback(null, [addresses[0]]) : callback(null, addresses[0].address, 4),
    }, (res) => {
      if (res.statusCode !== 200 || (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity")) { res.destroy(); reject(new Error("source_response_refused")); return; }
      if (Number(res.headers["content-length"]) > limit) { res.destroy(); reject(new Error("source_too_large")); return; }
      const chunks = []; let size = 0;
      res.on("data", (chunk) => { size += chunk.length; if (size > limit) { res.destroy(new Error("source_too_large")); } else chunks.push(chunk); });
      res.on("error", reject);
      res.on("end", () => resolve({ bytes: Buffer.concat(chunks), contentType: String(res.headers["content-type"] || "") }));
    });
    req.on("error", reject); req.end();
  });
}
