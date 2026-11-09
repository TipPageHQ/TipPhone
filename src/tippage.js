import { EventEmitter } from "node:events";
import fs from "node:fs";

const API = "https://api.tippage.com/v1";
const AUTH = "https://auth.tippage.com";
const WS = "wss://ws.tippage.com";

export class TipPage extends EventEmitter {
  constructor({ clientId, tokenFile }) {
    super();
    this.clientId = clientId;
    this.tokenFile = tokenFile;
    this.tokens = this.load();
    this.ws = null;
    this.live = false;
    this.backoff = 1000;
    this.refreshing = null;
  }

  get signedIn() {
    return !!this.tokens?.refresh_token;
  }

  load() {
    try {
      return JSON.parse(fs.readFileSync(this.tokenFile, "utf8"));
    } catch {
      return null;
    }
  }

  store(tokens) {
    this.tokens = tokens;
    if (tokens) fs.writeFileSync(this.tokenFile, JSON.stringify(tokens, null, 2));
    else fs.rmSync(this.tokenFile, { force: true });
  }

  async tokenRequest(params) {
    const res = await fetch(`${AUTH}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...params, client_id: this.clientId }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error_description || data.error || `token request failed (${res.status})`);
      err.code = data.error;
      throw err;
    }
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + (data.expires_in || 3600) * 1000,
      scope: data.scope,
    };
  }

  async signIn(code, verifier, redirectUri) {
    this.store(await this.tokenRequest({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }));
    if (this.ws) this.ws.close();
    else this.connect();
  }

  async signOut() {
    const refresh = this.tokens?.refresh_token;
    this.store(null);
    this.ws?.close();
    if (!refresh) return;
    await fetch(`${AUTH}/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refresh, client_id: this.clientId }),
      signal: AbortSignal.timeout(10000),
    }).catch(() => {});
  }

  // one at a time - a used refresh token is dead, and using it twice
  // makes tippage revoke the whole connection
  refresh() {
    if (!this.refreshing) {
      this.refreshing = this.tokenRequest({ grant_type: "refresh_token", refresh_token: this.tokens.refresh_token })
        .then((tokens) => {
          this.store(tokens);
          return tokens.access_token;
        })
        .catch((err) => {
          if (err.code === "invalid_grant") {
            this.store(null);
            this.ws?.close();
            this.emit("signedOut");
          }
          throw err;
        })
        .finally(() => {
          this.refreshing = null;
        });
    }
    return this.refreshing;
  }

  async access() {
    if (!this.signedIn) return null;
    if (Date.now() < this.tokens.expires_at - 60000) return this.tokens.access_token;
    return this.refresh().catch(() => null);
  }

  async req(method, path, body, retried = false) {
    const token = await this.access();
    if (!token) return { status: this.signedIn ? 0 : 401, ok: false, data: null };
    try {
      const res = await fetch(API + path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10000),
      });
      if (res.status === 401 && !retried && this.signedIn) {
        await this.refresh().catch(() => {});
        return this.req(method, path, body, true);
      }
      const data = await res.json().catch(() => null);
      return { status: res.status, ok: res.ok, data };
    } catch (err) {
      return { status: 0, ok: false, data: null, error: err.message };
    }
  }

  me = () => this.req("GET", "/me");
  queue = () => this.req("GET", "/tts/queue");
  now = () => this.req("GET", "/tts/now");
  alertNow = () => this.req("GET", "/alerts/now");
  history = () => this.req("GET", "/tts/history?limit=25");
  start = (id) => this.req("POST", `/tts/${encodeURIComponent(id)}/start`);
  finish = (id) => this.req("POST", `/tts/${encodeURIComponent(id)}/finish`);
  release = (id) => this.req("POST", `/tts/${encodeURIComponent(id)}/release`);
  voices = () => this.req("GET", "/tts/voices");
  audio = (id, params = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
    const qs = q.toString();
    return this.req("GET", `/tts/${encodeURIComponent(id)}/audio${qs ? "?" + qs : ""}`);
  };
  pause = () => this.req("POST", "/tts/pause");
  resume = () => this.req("POST", "/tts/resume");

  async connect() {
    if (!this.signedIn || this.ws) return;
    const token = await this.access();
    if (!token) {
      if (this.signedIn) setTimeout(() => this.connect(), this.backoff);
      return;
    }
    if (this.ws) return;

    // the socket outlives the hour the access token lasts, tippage keeps it
    // open while the connection itself is alive
    const ws = new WebSocket(WS);
    this.ws = ws;
    let quiet;
    const watchdog = () => {
      clearTimeout(quiet);
      quiet = setTimeout(() => ws.close(), 60000);
    };

    ws.onopen = () => {
      ws.send(JSON.stringify({ data: { apiKey: token } }));
      watchdog();
    };
    ws.onmessage = (e) => {
      watchdog();
      let frame;
      try { frame = JSON.parse(e.data); } catch { return; }
      if (frame.connect) {
        this.live = true;
        this.backoff = 1000;
        this.emit("live", true);
      }
      if (frame.pub?.data?.type) this.emit("event", frame.pub.data);
    };
    ws.onclose = (e) => {
      clearTimeout(quiet);
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.live) this.emit("live", false);
      this.live = false;
      if (!this.signedIn) return;
      this.emit("closed", e.code, e.reason);
      // 45xx = the credential was refused, a refresh tells us if we're still connected
      const refused = e.code >= 4500 && e.code < 5000;
      if (refused) this.refresh().catch(() => {});
      this.backoff = Math.min(this.backoff * 2, 30000);
      setTimeout(() => this.connect(), refused ? 10000 : this.backoff);
    };
    ws.onerror = () => {};
  }
}
