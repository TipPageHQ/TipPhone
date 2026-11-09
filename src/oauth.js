import crypto from "node:crypto";

export const CLIENT_ID = "oc_c8543207b2b1";

export const SCOPES = "tts:read tts:control";

const pending = new Map();

export function authorizeUrl(clientId, redirectUri) {
  const state = crypto.randomBytes(16).toString("base64url");
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");

  for (const [k, v] of pending) if (Date.now() - v.at > 600000) pending.delete(k);
  pending.set(state, { verifier, at: Date.now() });

  const url = new URL("https://auth.tippage.com/oauth/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export function takeVerifier(state) {
  const p = pending.get(state);
  pending.delete(state);
  return p && Date.now() - p.at < 600000 ? p.verifier : null;
}
