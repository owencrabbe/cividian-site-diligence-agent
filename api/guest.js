// api/guest.js
// "Continue as guest": issues a signed 24-hour guest session so a visitor can
// use the entire terminal without creating an account. The token carries
// guest:true and no email, so nothing a guest does can persist or publish;
// write endpoints refuse guest sessions with an honest sentence instead of a
// generic 401. This exists so the front door is never the demo's bottleneck.
import { methodGuard } from '../lib/http.js';
import { rateLimit, tooMany, sameOrigin, forbidden, validRequestHost } from '../lib/security.js';
import { issueGuestToken, setSessionCookie } from '../lib/auth.js';

async function handler(req, res, auth = { issueGuestToken, setSessionCookie }) {
  if (!methodGuard(req, res, ['POST'])) return;
  if (!validRequestHost(req)) return res.status(400).json({ ok: false, error: 'invalid_request_host' });
  const rl = await rateLimit(req, 'guest', 20, 60);
  if (!rl.ok) return tooMany(res, rl);
  // Session-minting is browser-originated only, same rule as login/signup.
  if (!sameOrigin(req)) return forbidden(res);
  try {
    const token = await auth.issueGuestToken();
    auth.setSessionCookie(res, token, 24 * 3600);
    return res.status(200).json({ ok: true, guest: true, expiresInHours: 24 });
  } catch (e) {
    console.log('PAGO_GUEST_ERR ' + String((e && e.message) || e));
    return res.status(200).json({ ok: false, error: 'Set AUTH_SECRET in Vercel before issuing sessions.' });
  }
}

export function createGuestHandler(auth) { return (req, res) => handler(req, res, auth); }
export default handler;
