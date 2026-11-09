import fs from "node:fs";
import path from "node:path";
import { appDir, loadConfig, saveConfig } from "./config.js";
import { TipPage } from "./tippage.js";
import { startServer } from "./server.js";
import { initRing, ringInfo } from "./ring.js";
import { CLIENT_ID, authorizeUrl, takeVerifier } from "./oauth.js";
import pkg from "../package.json" with { type: "json" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...args) => console.log(new Date().toLocaleTimeString(), ...args);

// an alert that has come in but isn't on screen yet gets this long, counted from
// when it arrived or from when the phone last became free, whichever is later,
// for the alert box to put it up before the phone rings anyway. the box in "in
// order" timing reads the tip queue every 5s, so an alert it held behind our last
// call shows within that; one the box will never show (that type is off on it)
// costs one wait of this and no more
const ALERT_GRACE_MS = 8000;
// the stream's alert events. redemptions are left out on purpose: twitch sends
// one for every channel-point press and the alert box shows them only when told to
const ALERT_EVENT_RE = /^(twitch|kick)\.(?!channel_point_redemption$)/;

// the overlay's words for an alert, from a stream envelope type (twitch.sub) or the
// box's own event type (channel.subscribe), for the band and the log
function alertKind(type) {
  const t = String(type || "");
  if (/follow$/.test(t)) return "follow";
  if (/gift_sub$|subscription\.gift$/.test(t)) return "gift sub";
  if (/resub$|subscription\.message$/.test(t)) return "resub";
  if (/\.sub$|\.subscribe$/.test(t)) return "sub";
  if (/cheer$/.test(t)) return "cheer";
  if (/raid$/.test(t)) return "raid";
  if (/kicks$/.test(t)) return "Kicks gift";
  if (/channel_point/.test(t)) return "channel point redemption";
  return "alert";
}

const cfg = loadConfig();
const tp = new TipPage({ clientId: cfg.clientId || CLIENT_ID, tokenFile: path.join(appDir(), "tokens.json") });
const stateFile = path.join(appDir(), "state.json");
initRing(cfg);
const controlUrl = `http://127.0.0.1:${cfg.port}/`;
const redirectUri = `${controlUrl}callback`;

class Calls {
  hub = null;
  call = null;
  playing = null;
  phone = { connected: false, offHook: false, name: null };
  overlayState = { type: "overlay", state: "idle", color: cfg.overlay.color };
  status = "starting";
  paused = null;
  voices = null;
  symbol = "£";
  account = null;
  snoozed = new Map();
  ready = new Map();
  firstSeen = new Map();
  nextAt = 0;
  busy = false;
  lines = [];
  // the alert box's side of things, for cfg.waitForAlerts. what the box says is
  // on screen ({eventId, kind, name, since} - since = when we first saw it there),
  // the alerts that have come in and not finished (eventId -> {at, kind, name}),
  // the ones that just finished (a /alerts/now read can lag the alert.finished
  // event by a moment), and when the phone last became free
  alert = null;
  pending = new Map();
  finished = new Map();
  freeAt = Date.now();
  heldFor = null;
  holdTimer = null;

  snapshot() {
    return {
      status: this.status,
      signedIn: tp.signedIn,
      account: this.account,
      live: tp.live,
      phone: this.phone,
      call: this.call
        ? {
            state: this.call.state,
            name: this.call.tip.name,
            test: this.call.test,
            amount: this.money(this.call.tip.amount),
            message: this.call.tip.message || null,
            holding: this.call.holding || null,
          }
        : null,
      alert: this.alert ? { kind: this.alert.kind, name: this.alert.name } : null,
      paused: this.paused,
      controlUrl,
      overlayUrl: `http://127.0.0.1:${cfg.port}/overlay`,
      overlays: this.hub?.overlays() || { count: 0, obs: 0, browser: 0 },
      version: pkg.version,
      config: editableConfig(),
      voices: this.voices,
      ring: ringInfo(),
      lines: this.lines,
    };
  }

  push() {
    this.hub?.toPlayer("status", this.snapshot());
  }

  note(msg) {
    log(msg);
    this.lines = [...this.lines.slice(-29), `${new Date().toLocaleTimeString()}  ${msg}`];
    this.push();
  }

  setStatus(s) {
    if (s === this.status) return;
    this.status = s;
    this.push();
  }

  money(amount) {
    if (amount == null || Number(amount) === 0) return null;
    return `${this.symbol}${Number(amount).toFixed(2)}`;
  }

  show(state, tip = this.call?.tip) {
    const name = tip?.name || "Someone";
    const amount = tip ? this.money(tip.amount) : null;
    const fill = (s) => s.replaceAll("{name}", name).replaceAll("{amount}", amount || "");
    const titles = {
      ringing: fill(cfg.overlay.ringing),
      "on-call": fill(cfg.overlay.onCall),
      ended: "Call ended.",
      missed: "Nobody picked up.",
    };
    this.overlayState = {
      type: "overlay",
      state,
      title: titles[state] || "",
      name,
      amount: cfg.overlay.showAmount ? amount : null,
      message: cfg.overlay.showMessage && state === "on-call" ? tip?.message || null : null,
      holdMs: cfg.overlay.endedHoldMs,
      color: cfg.overlay.color,
    };
    this.hub.toOverlays(this.overlayState);
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.check();
    } catch (err) {
      log("tick failed:", err);
    } finally {
      this.busy = false;
    }
  }

  async check() {
    const c = this.call;
    if (c) {
      if (c.state !== "ringing" || c.test) return;
      if (cfg.ringTimeoutSec > 0 && Date.now() - c.since > cfg.ringTimeoutSec * 1000) {
        this.snoozed.set(c.id, Date.now() + cfg.missedRetrySec * 1000);
        this.note(`nobody picked up for ${c.tip.name}, trying again in ${cfg.missedRetrySec}s`);
        return this.end("missed");
      }
      const q = await tp.queue();
      if (q.ok) this.paused = !!q.data.is_paused;
      if (q.ok && (q.data.is_paused || !q.data.items.some((t) => t.order_id === c.id))) {
        this.note(`${c.tip.name}'s tip isn't waiting any more, hanging up`);
        this.end("gone");
      }
      return;
    }

    if (!tp.signedIn) return this.setStatus("signed-out");
    if (!this.hub.playerReady()) return this.setStatus("no-player");

    // the queue is read before the phone checks so a pause always shows as paused
    const q = await tp.queue();
    if (!q.ok) return this.setStatus(q.status === 401 || q.status === 403 ? "no-access" : "api-down");
    if (this.paused !== !!q.data.is_paused) {
      this.paused = !!q.data.is_paused;
      this.push();
    }
    if (q.data.is_paused) return this.setStatus("paused");
    if (!this.phone.connected) return this.setStatus("no-phone");
    if (this.phone.offHook) return this.setStatus("off-hook");
    if (Date.now() < this.nextAt) return this.setStatus("waiting");
    if (q.data.playing) return this.setStatus("busy-elsewhere");

    const tip = q.data.items.find(
      (t) => (cfg.includeReplays || !t.is_replay) && !(this.snoozed.get(t.order_id) > Date.now())
    );
    if (!tip) return this.setStatus("waiting");

    // get the audio before ringing. standard tips are made here on demand, ai tips were
    // made at payment or are still being made, in which case we wait
    if (!tip.tts_url && !this.ready.get(tip.order_id)) {
      const a = await tp.audio(tip.order_id, voiceParams());
      if (a.ok && a.data?.url) {
        this.ready.set(tip.order_id, a.data.url);
      } else if (a.ok && a.data?.pending) {
        if (!this.firstSeen.has(tip.order_id)) this.firstSeen.set(tip.order_id, Date.now());
        if (Date.now() - this.firstSeen.get(tip.order_id) < cfg.waitForAudioSec * 1000) return this.setStatus("rendering");
        this.note(`${tip.name}'s AI voice still isn't ready after ${cfg.waitForAudioSec}s, letting the next one ring first`);
        this.firstSeen.delete(tip.order_id);
        this.snoozed.set(tip.order_id, Date.now() + cfg.missedRetrySec * 1000);
        return;
      } else if (a.ok && a.data?.silent) {
        return this.playSilently(tip);
      } else {
        const why = a.data?.code || a.data?.error || a.error || a.status;
        this.note(`couldn't get audio for ${tip.name}'s tip (${why}), trying again in 30s`);
        this.snoozed.set(tip.order_id, Date.now() + 30000);
        return this.setStatus("waiting");
      }
    }
    // the audio is in hand. an alert on the overlay gets to finish first
    if (cfg.waitForAlerts) {
      const hold = await this.alertHold();
      if (hold) return this.setStatus(hold);
    }
    this.firstSeen.delete(tip.order_id);
    this.ring(tip);
  }

  // The alert box is on its own clock: it plays subs, raids and the rest as they
  // come and nothing outside the overlay can hold one back. What the phone can do
  // is not ring into one. An alert the box reports as on screen = wait for it to
  // finish (bounded by waitForAlertsSec); one that has come in and isn't on screen
  // yet = ALERT_GRACE_MS for the box to put it up, then ring regardless, because a
  // box in "in order" timing may be holding it for the very tip we're about to ring.
  // Returns the status to show while holding, or null to ring now.
  async alertHold() {
    const now = Date.now();
    const maxMs = cfg.waitForAlertsSec * 1000;
    for (const [id, a] of this.pending) if (now - a.at > maxMs) this.pending.delete(id);
    for (const [id, at] of this.finished) if (now - at > 60000) this.finished.delete(id);

    const r = await tp.alertNow();
    const on = r.ok && r.data?.alert && !this.finished.has(r.data.alert.event_id) ? r.data.alert : null;
    if (on) {
      const since = this.alert?.eventId === on.event_id ? this.alert.since : now;
      this.alert = { eventId: on.event_id, kind: alertKind(on.type), name: on.name || null, since };
      const who = `${on.name ? on.name + "'s" : "a"} ${this.alert.kind}`;
      if (now - since < maxMs) {
        if (this.heldFor !== on.event_id) {
          this.heldFor = on.event_id;
          this.note(`${who} is on the overlay, ringing after it`);
        }
        this.push();
        this.rearm(2000);
        return "alert-on-screen";
      }
      if (this.heldFor !== `gave-up:${on.event_id}`) {
        this.heldFor = `gave-up:${on.event_id}`;
        this.note(`${who} is still on the overlay after ${cfg.waitForAlertsSec}s, ringing anyway`);
      }
      this.alert = null;
      return null;
    }
    if (this.alert) {
      this.alert = null;
      this.push();
    }
    const coming = [...this.pending.values()].some((a) => now - Math.max(a.at, this.freeAt) < ALERT_GRACE_MS);
    if (coming) {
      this.rearm(1000);
      return "alert-coming";
    }
    return null;
  }

  // re-check sooner than the 5s tick while holding for an alert
  rearm(ms) {
    clearTimeout(this.holdTimer);
    this.holdTimer = setTimeout(() => this.tick(), ms);
  }

  // Picked up while an alert is on the overlay: hold the voice until the box is
  // done with it, so the two never play over each other. The streamer hears the
  // gap down the handset; the band says why.
  async holdCall(c) {
    const until = Date.now() + cfg.waitForAlertsSec * 1000;
    while (Date.now() < until && !c.hungUp && !c.skipped) {
      const r = await tp.alertNow();
      const on = r.ok && r.data?.alert && !this.finished.has(r.data.alert.event_id) ? r.data.alert : null;
      if (!on) break;
      const kind = alertKind(on.type);
      if (c.holding !== kind) {
        c.holding = kind;
        this.note(`holding ${c.tip.name}'s call while ${on.name ? on.name + "'s" : "a"} ${kind} finishes on the overlay`);
        this.push();
      }
      await sleep(1000);
    }
    if (c.holding) {
      c.holding = null;
      this.push();
    }
  }

  // an alert has come in (the stream's twitch.* / kick.* envelope, or a replay
  // pressed on the dashboard). remembered until alert.finished says it played
  noteAlert(id, type, name) {
    if (!id) return;
    if (this.pending.size > 100) this.pending.delete(this.pending.keys().next().value);
    this.pending.set(id, { at: Date.now(), kind: alertKind(type), name: name || null });
  }

  // nothing to read out, but it still has to leave the queue
  async playSilently(tip) {
    this.snoozed.set(tip.order_id, Date.now() + 60000);
    const r = await tp.start(tip.order_id);
    if (r.ok) await tp.finish(tip.order_id);
    this.note(`nothing to read out for ${tip.name} (name, amount and message are all off), marked it played`);
    this.nextAt = Date.now() + cfg.betweenCallsMs;
  }

  ring(tip, test = false) {
    this.sample = null;
    this.call = {
      id: tip.order_id,
      tip,
      test,
      state: "ringing",
      since: Date.now(),
      url: tip.tts_url || this.ready.get(tip.order_id) || null,
      claimed: false,
      played: false,
      hungUp: false,
      skipped: false,
    };
    this.note(`${test ? "test call" : "ringing"} - ${tip.name}${this.money(tip.amount) ? ` (${this.money(tip.amount)})` : ""}`);
    this.hub.toPlayer("ring", { on: true });
    // the screen gets the number alone, its font has no currency signs to count on
    this.hub.toPlayer("display", { top: tip.name || "Someone", bottom: Number(tip.amount) ? Number(tip.amount).toFixed(2) : "" });
    this.show("ringing");
    this.setStatus("ringing");
    this.push();
  }

  setPhone(body) {
    const was = this.phone;
    this.phone = { connected: !!body.connected, offHook: !!body.connected && !!body.offHook, name: body.name || null };
    if (was.connected === this.phone.connected && was.offHook === this.phone.offHook && was.name === this.phone.name) return;
    if (was.connected !== this.phone.connected) this.note(this.phone.connected ? `phone connected (${this.phone.name})` : "phone unplugged");
    this.push();

    if (!this.phone.connected && this.call?.state === "ringing") this.end("gone");
    if (this.phone.offHook && !was.offHook) this.pickUp();
    else if (!this.phone.offHook && was.offHook) {
      this.hangUp();
      // the gap between calls starts when the handset goes down, not when the voice ends
      this.nextAt = Math.max(this.nextAt, Date.now() + cfg.betweenCallsMs);
      setTimeout(() => this.tick(), cfg.betweenCallsMs + 50);
    }
    if (!this.call) this.tick();
  }

  playerChanged() {
    if (!this.hub.playerReady()) {
      if (this.call?.state === "ringing") this.end("gone");
      this.stopPlayback("error");
    }
    this.push();
    this.tick();
  }

  async pickUp() {
    const c = this.call;
    if (!c || c.state !== "ringing") return;
    c.state = "answering";
    this.hub.toPlayer("ring", { on: false });
    this.show("on-call");
    this.push();
    this.note(`picked up - ${c.tip.name}`);

    if (!c.test) {
      const r = await tp.start(c.id);
      const ours = r.ok || (r.status === 409 && r.data?.current_order_id === c.id);
      if (!ours) {
        this.note(`couldn't take ${c.tip.name}'s tip (${r.data?.code || r.error || r.status})`);
        return this.end("ended");
      }
      c.claimed = true;
      this.saveState(c.id);
    }

    await sleep(cfg.answerDelayMs);
    if (c.hungUp || c.skipped) return this.wrapUp(c, c.skipped ? "skipped" : "hungup");
    if (cfg.waitForAlerts && !c.test) await this.holdCall(c);
    if (c.hungUp || c.skipped) return this.wrapUp(c, c.skipped ? "skipped" : "hungup");

    const url = await this.audioFor(c);
    if (c.hungUp || c.skipped) return this.wrapUp(c, c.skipped ? "skipped" : "hungup");
    if (!url) {
      this.note(`no audio for ${c.tip.name} after ${cfg.waitForAudioSec}s, putting it back`);
      this.snoozed.set(c.id, Date.now() + 60000);
      return this.wrapUp(c, "error");
    }

    c.state = "playing";
    this.push();
    this.wrapUp(c, await this.play(c, url));
  }

  hangUp() {
    const c = this.call;
    if (!c || c.state === "ringing") return;
    c.hungUp = true;
    this.stopPlayback("hungup");
  }

  async audioFor(c) {
    if (c.url) return c.url;
    const until = Date.now() + cfg.waitForAudioSec * 1000;
    let polled = 0;
    while (Date.now() < until && !c.hungUp && !c.skipped) {
      const url = this.ready.get(c.id);
      if (url) return url;
      if (Date.now() - polled > 3000) {
        polled = Date.now();
        const r = await tp.audio(c.id, voiceParams());
        if (r.ok && r.data?.url) return r.data.url;
      }
      await sleep(250);
    }
    return null;
  }

  play(c, url) {
    const playId = `${c.id}:${Date.now()}`;
    return new Promise((resolve) => {
      this.playing = { playId, resolve };
      if (!this.hub.toPlayer("play", { playId, url })) this.stopPlayback("error");
    });
  }

  report({ playId, status, error }) {
    const p = this.playing;
    if (!p || p.playId !== playId) return;
    if (status === "started") {
      if (this.call) this.call.played = true;
      return;
    }
    if (status === "error") this.note(`audio failed: ${error || "unknown"}`);
    this.playing = null;
    p.resolve(status);
  }

  stopPlayback(why) {
    const p = this.playing;
    if (!p) return;
    this.playing = null;
    this.hub.toPlayer("stop");
    p.resolve(why);
  }

  async wrapUp(c, how) {
    if (this.call !== c) return;
    let action = "release";
    if (how === "ended") action = "finish";
    if (how === "hungup") action = c.played ? cfg.hangUpDuringAudio : cfg.hangUpBeforeAudio;
    if (how === "skipped") action = null; // tippage already moved it on
    if (how === "error") this.snoozed.set(c.id, Math.max(this.snoozed.get(c.id) || 0, Date.now() + 30000));

    if (c.claimed && action) {
      const r = action === "finish" ? await tp.finish(c.id) : await tp.release(c.id);
      if (!r.ok) this.note(`couldn't ${action} ${c.tip.name}'s tip (${r.status})`);
    }
    if (c.claimed) this.clearState();
    this.note(`call over - ${c.tip.name} (${how})`);
    this.end("ended");
  }

  end(outcome) {
    this.hub.toPlayer("ring", { on: false });
    this.hub.toPlayer("display", { clear: true });
    this.stopPlayback("stopped");
    this.show(outcome === "gone" ? "idle" : outcome);
    this.call = null;
    this.freeAt = Date.now();
    this.nextAt = Date.now() + cfg.betweenCallsMs;
    this.setStatus("waiting");
    this.push();
    setTimeout(() => this.tick(), cfg.betweenCallsMs + 50);
  }

  async testCall() {
    if (this.call) return { error: "Already on a call" };
    if (!tp.signedIn) return { error: "Connect your TipPage first" };
    if (!this.hub.playerReady()) return { error: "Click Start on the control page first" };
    if (!this.phone.connected) return { error: "Connect the phone first" };
    const h = await tp.history();
    const tip = h.data?.tips?.find((t) => t.tts_url);
    if (!tip) return { error: "No played tip with audio to test with yet" };
    this.ring(tip, true);
    return { ok: true, name: tip.name };
  }

  // same pause as the dashboard and !pause
  async setPaused(on) {
    if (!tp.signedIn) return { error: "Connect your TipPage first" };
    const r = on ? await tp.pause() : await tp.resume();
    if (!r.ok) return { error: `TipPage wouldn't ${on ? "pause" : "resume"} the queue (${r.data?.error || r.data?.code || r.error || r.status})` };
    this.paused = on;
    if (!this.call) this.setStatus(on ? "paused" : "waiting");
    this.note(on ? "paused the queue" : "resumed the queue");
    this.tick();
    return { ok: true };
  }

  // fake call on the overlay only, for lining it up in obs
  testOverlay() {
    if (this.call) return { error: "A call is going on, try after it" };
    if (!this.hub.overlays().count) return { error: "Nothing is showing the overlay yet. Add it in OBS first, or open it in a tab" };
    if (this.sample) return { ok: true };
    const tip = { name: "Test call", amount: 5, message: "This is what a call looks like on stream." };
    const token = Date.now();
    const step = (state, after) => setTimeout(() => {
      if (this.sample !== token) return;
      this.show(state, tip);
      if (state === "ended") this.sample = null;
    }, after);
    this.sample = token;
    this.show("ringing", tip);
    step("on-call", 2500);
    step("ended", 6500);
    return { ok: true };
  }

  onEvent(e) {
    const d = e.data || {};
    const c = this.call;
    switch (e.type) {
      case "queue.tts.resumed":
        this.paused = false;
        if (!c) this.setStatus("waiting");
        this.tick();
        break;
      case "tip.created":
      case "queue.tts.finished":
      case "queue.tts.released":
        this.tick();
        break;
      case "tip.tts_ready":
        if (this.ready.size > 200) this.ready.clear();
        this.ready.set(d.order_id, d.tts_url);
        if (c?.id === d.order_id && !c.url) c.url = d.tts_url;
        this.tick();
        break;
      case "queue.tts.skipped":
        if (c?.claimed && (!d.order_id || d.order_id === c.id)) {
          c.skipped = true;
          this.stopPlayback("skipped");
        }
        break;
      case "queue.tts.removed":
        if (c?.state === "ringing" && !c.test && d.tip?.order_id === c.id) this.end("gone");
        break;
      case "queue.tts.paused":
        this.paused = true;
        if (c?.state === "ringing" && !c.test) this.end("gone");
        if (!this.call) this.setStatus("paused");
        this.push();
        break;
      case "queue.tts.cleared":
        if (c?.state === "ringing" && !c.test) this.end("gone");
        break;
      // the alert box's side: an alert came in, a replay was pressed, one finished
      case "alert.replayed":
        this.noteAlert(d.event_id, d.alert?.type, d.alert?.name);
        break;
      case "alert.finished":
        this.pending.delete(d.event_id);
        this.finished.set(d.event_id, Date.now());
        if (this.alert?.eventId === d.event_id) {
          this.alert = null;
          this.push();
        }
        this.tick();
        break;
      default:
        if (ALERT_EVENT_RE.test(e.type)) this.noteAlert(d.event_id, e.type, d.user_name);
    }
  }

  async loadMe() {
    if (!tp.signedIn) {
      this.account = null;
      return this.push();
    }
    const r = await tp.me();
    if (!r.ok) return this.note(`couldn't read the tippage account (${r.status || r.error})`);
    this.symbol = r.data.tenant.currency_symbol || "£";
    this.account = r.data.tenant.name;
    const scopes = r.data.credential?.scopes || [];
    const missing = ["tts:read", "tts:control"].filter((s) => !scopes.includes(s));
    if (missing.length) this.note(`tippage didn't grant ${missing.join(" and ")}, connect again and allow them`);
    else this.note(`connected to ${this.account}`);
    const v = await tp.voices();
    this.voices = v.ok && v.data?.standard ? v.data : null;
    this.push();
  }

  // a claim we never finished means we crashed mid call, give it back
  async recover() {
    let id;
    try {
      id = JSON.parse(fs.readFileSync(stateFile, "utf8")).claimed;
    } catch {
      return;
    }
    if (id && tp.signedIn) {
      const r = await tp.release(id);
      if (r.ok) this.note("put back a tip from last time that never finished");
    }
    this.clearState();
  }

  saveState(id) {
    fs.writeFileSync(stateFile, JSON.stringify({ claimed: id }));
  }

  clearState() {
    try { fs.unlinkSync(stateFile); } catch {}
  }

  async shutdown() {
    const c = this.call;
    this.hub?.toPlayer("ring", { on: false });
    this.hub?.toPlayer("stop");
    this.hub?.toPlayer("display", { clear: true });
    if (c?.claimed) {
      await (c.played ? tp.finish(c.id) : tp.release(c.id));
      this.clearState();
    }
  }
}

// settings the control page can change live. all of these are read when needed,
// nothing is cached, so no restart
const EDITABLE = {
  betweenCallsMs: { min: 0, max: 120000 },
  answerDelayMs: { min: 0, max: 10000 },
  ringTimeoutSec: { min: 0, max: 300 },
  missedRetrySec: { min: 5, max: 3600 },
  waitForAudioSec: { min: 5, max: 600 },
  hangUpBeforeAudio: ["release", "finish"],
  hangUpDuringAudio: ["release", "finish"],
  includeReplays: "bool",
  waitForAlerts: "bool",
  waitForAlertsSec: { min: 5, max: 600 },
  "overlay.showAmount": "bool",
  "overlay.showMessage": "bool",
  "overlay.endedHoldMs": { min: 0, max: 60000 },
  "overlay.color": "color",
  "voice.voice": "voice",
  "voice.rate": { min: 0.5, max: 2, decimals: 2 },
  "voice.pitch": { min: 0.7, max: 1.5, decimals: 2 },
  "voice.readNames": "bool",
  "voice.readAmounts": "bool",
  "voice.readMessages": "bool",
};

// voice params for the audio request. blank voice = the main alert box's voice
function voiceParams() {
  const v = cfg.voice;
  return {
    ...(v.voice ? { voice: v.voice, rate: v.rate, pitch: v.pitch } : {}),
    readNames: v.readNames,
    readAmounts: v.readAmounts,
    readMessages: v.readMessages,
  };
}

function editableConfig() {
  const out = {};
  for (const key of Object.keys(EDITABLE)) {
    const [a, b] = key.split(".");
    out[key] = b ? cfg[a][b] : cfg[a];
  }
  return out;
}

function applyConfig(patch) {
  const bad = [];
  const next = {};
  for (const [key, raw] of Object.entries(patch || {})) {
    const rule = EDITABLE[key];
    if (!rule) { bad.push(key); continue; }
    let v = raw;
    if (rule === "bool") v = !!raw;
    else if (rule === "color") {
      v = String(raw || "").trim().toLowerCase();
      if (!/^#[0-9a-f]{6}$/.test(v)) { bad.push(key); continue; }
    } else if (rule === "voice") {
      v = String(raw || "");
      const known = calls.voices?.standard?.some((x) => x.id === v);
      if (v && !/^[A-Za-z]{1,32}$/.test(v)) { bad.push(key); continue; }
      if (v && calls.voices && !known) { bad.push(key); continue; }
    } else if (Array.isArray(rule)) { if (!rule.includes(raw)) { bad.push(key); continue; } }
    else {
      v = Number(raw);
      if (!Number.isFinite(v)) { bad.push(key); continue; }
      v = Math.min(rule.max, Math.max(rule.min, v));
      v = rule.decimals ? Math.round(v * 10 ** rule.decimals) / 10 ** rule.decimals : Math.round(v);
    }
    next[key] = v;
  }
  if (bad.length) return { error: `Can't set ${bad.join(", ")}` };
  let overlayChanged = false;
  let colorChanged = false;
  for (const [key, v] of Object.entries(next)) {
    const [a, b] = key.split(".");
    if (key === "overlay.color") { colorChanged = cfg.overlay.color !== v; cfg.overlay.color = v; continue; }
    if (b) { cfg[a][b] = v; if (a === "overlay") overlayChanged = true; } else cfg[a] = v;
  }
  try {
    saveConfig(cfg);
  } catch (err) {
    return { error: `Saved for now, but couldn't write config.json (${err.message})`, config: editableConfig() };
  }
  // the colour goes out on its own so a card that is up recolours without being
  // redrawn (a redraw restarts the on-call clock)
  if (colorChanged) {
    calls.overlayState.color = cfg.overlay.color;
    calls.hub.toOverlays({ type: "color", color: cfg.overlay.color });
  }
  if (overlayChanged && calls.call) calls.show(calls.overlayState.state);
  calls.push();
  return { ok: true, config: editableConfig() };
}

const calls = new Calls();

const auth = {
  connectUrl: () => (tp.clientId ? authorizeUrl(tp.clientId, redirectUri) : null),

  async callback(params) {
    if (params.get("error")) return `/?auth_error=${encodeURIComponent(params.get("error_description") || params.get("error"))}`;
    const verifier = takeVerifier(params.get("state"));
    if (!verifier) return "/?auth_error=" + encodeURIComponent("That sign-in link was old, try again");
    try {
      await tp.signIn(params.get("code"), verifier, redirectUri);
    } catch (err) {
      calls.note(`tippage sign-in failed: ${err.message}`);
      return `/?auth_error=${encodeURIComponent(err.message)}`;
    }
    await calls.recover();
    await calls.loadMe();
    calls.tick();
    return "/";
  },

  async signOut() {
    await calls.shutdown();
    calls.end("gone");
    await tp.signOut();
    calls.note("disconnected from tippage");
    await calls.loadMe();
    calls.setStatus("signed-out");
    return { ok: true };
  },
};

// default browser. "edge" for anyone whose default can't do webhid
function openBrowser() {
  if (process.platform !== "win32" || cfg.browser === "none") return;
  const cmd = cfg.browser === "edge" ? ["cmd", "/c", "start", "", "msedge", controlUrl] : ["cmd", "/c", "start", "", controlUrl];
  Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
}

try {
  calls.hub = startServer({ port: cfg.port, calls, auth, applyConfig });
} catch (err) {
  console.log(`couldn't start on port ${cfg.port} - is TipPhone already running? (${err.message})`);
  openBrowser();
  await sleep(5000);
  process.exit(1);
}

tp.on("event", (e) => calls.onEvent(e));
tp.on("closed", (code, reason) => {
  const why = reason ? `${reason} (${code})` : `code ${code}`;
  const bad = code >= 4500 && code < 5000 ? ", check the api key" : "";
  calls.note(`tippage closed the connection: ${why}${bad}`);
});
tp.on("signedOut", () => {
  calls.note("tippage ended this app's connection, connect again on the control page");
  calls.loadMe();
  calls.tick();
});
tp.on("live", (up) => {
  if (up) calls.note("connected to tippage");
  if (up) calls.tick();
});

console.log(`\n  TipPhone is running. Control page: ${controlUrl}\n  Keep this window open. Close it to stop.\n`);
await calls.recover();
await calls.loadMe();
tp.connect();
setInterval(() => calls.tick(), 5000);
openBrowser();

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    await Promise.race([calls.shutdown(), sleep(3000)]);
    process.exit(0);
  });
}
