// Public edition shim so api/guest.js runs unchanged.
export { issueGuestToken, getSession, setSessionCookie, clearSessionCookie, verifyToken, sessionGuest, sessionVerified, sessionSensitiveAllowed, authSecretStatus } from "./diligence/standalone-host.mjs";
