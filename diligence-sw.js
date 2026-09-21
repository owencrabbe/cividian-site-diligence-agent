// Network-only app. Never cache accounts, credentials, API responses or briefs.
globalThis.addEventListener('install', () => globalThis.skipWaiting());
globalThis.addEventListener('activate', (event) => event.waitUntil(globalThis.clients.claim()));
globalThis.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() => new Response('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Cividian is offline</title><body style="font:17px system-ui;padding:40px;max-width:480px;margin:auto;background:#f3f0e8;color:#111b1a"><h1>You are offline.</h1><p>Cividian needs a connection to load your sites and sources. Your saved briefs have not been changed.</p><a href="/app">Try again</a></body></html>', { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })));
});
