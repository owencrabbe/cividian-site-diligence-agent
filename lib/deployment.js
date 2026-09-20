// @ts-check
// Shared deployment classification and first-party email link configuration.
export function productionLike(source = process.env) {
  return (
    source.NODE_ENV === "production" ||
    source.VERCEL_ENV === "production" ||
    source.VERCEL_ENV === "preview" ||
    source.VERCEL === "1"
  );
}

// No request header, deployment hostname, or legacy URL alias is trusted here.
// Local development has a fixed loopback default. Deployments require SITE_URL.
/** @param {unknown} [_request] Ignored for compatibility with existing callers. */
export function siteOrigin(_request) { return siteOriginFromEnv(process.env); }

/** @param {NodeJS.ProcessEnv} source */
export function siteOriginFromEnv(source) {
  const configured = source.SITE_URL;
  const raw = configured === undefined && !productionLike(source) ? "http://localhost:3000" : configured;
  try {
    if (typeof raw !== "string" || !raw || raw !== raw.trim() || /[\\\s<>"']/.test(raw)) throw new Error();
    const url = new URL(raw);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
        !/^https?:\/\//.test(raw) ||
        (url.protocol !== "https:" && (productionLike(source) || !loopback)) ||
        (productionLike(source) && loopback)) throw new Error();
    return url.origin;
  } catch {
    throw new Error("SITE_URL must be an absolute HTTPS origin in deployed environments.");
  }
}

export function emailLinksConfigured() {
  try { siteOrigin(); return true; } catch { return false; }
}
