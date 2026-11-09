import controlHtml from "./control.html" with { type: "text" };
import overlayHtml from "./overlay.html" with { type: "text" };
import { currentRing, saveRing, resetRing } from "./ring.js";

const enc = new TextEncoder();

export function startServer({ port, calls, auth, applyConfig }) {
  const players = new Map();
  const overlays = new Map();
  let active = null;
  let nextId = 1;

  // obs and streamlabs put their name in the browser source's user agent (i think)
  const isObs = (ua) => /\bOBS\/|Streamlabs/i.test(ua || "");

  const hub = {
    toPlayer(type, data = {}) {
      const p = players.get(active);
      if (p) p.send({ type, ...data });
      return !!p;
    },
    toOverlays(msg) {
      for (const o of overlays.values()) o.send(msg);
    },
    playerReady: () => !!players.get(active)?.ready,
    overlays() {
      let obs = 0;
      for (const o of overlays.values()) if (o.obs) obs++;
      return { count: overlays.size, obs, browser: overlays.size - obs };
    },
  };

  const okHost = (req) => {
    const host = req.headers.get("host");
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  };
  // helps stop random shit touching the local api
  const okOrigin = (req) => {
    const origin = req.headers.get("origin");
    return !origin || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
  };

  function events(req, role) {
    let ping;
    let id;
    let send;
    const stream = new ReadableStream({
      start(ctrl) {
        send = (msg) => {
          try { ctrl.enqueue(enc.encode(`data: ${JSON.stringify(msg)}\n\n`)); } catch {}
        };
        ping = setInterval(() => {
          try { ctrl.enqueue(enc.encode(": ping\n\n")); } catch {}
        }, 20000);

        if (role === "overlay") {
          overlays.set(send, { send, obs: isObs(req.headers.get("user-agent")) });
          send(calls.overlayState);
          calls.push();
          return;
        }
        id = String(nextId++);
        const old = players.get(active);
        if (old) old.send({ type: "replaced" });
        players.set(id, { send, ready: false });
        active = id;
        send({ type: "hello", id, ...calls.snapshot() });
        calls.playerChanged();
      },
      cancel() { cleanup(); },
    });
    const cleanup = () => {
      clearInterval(ping);
      if (role === "overlay") {
        overlays.delete(send);
        calls.push();
        return;
      }
      players.delete(id);
      if (active === id) {
        active = null;
        calls.playerChanged();
      }
    };
    req.signal.addEventListener("abort", cleanup);
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
    });
  }

  const json = (data, status = 200) => Response.json(data, { status });
  const html = (body) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });

  Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 0,
    async fetch(req) {
      if (!okHost(req)) return new Response("nope", { status: 403 });
      const url = new URL(req.url);
      const p = url.pathname;

      if (req.method === "GET") {
        if (p === "/") return html(controlHtml);
        if (p === "/overlay") return html(overlayHtml);
        if (p === "/ring") {
          const ring = currentRing();
          return new Response(Bun.file(ring.path), { headers: { "content-type": ring.type, "cache-control": "no-store" } });
        }
        if (p === "/events") return events(req, url.searchParams.get("role") === "overlay" ? "overlay" : "player");
        if (p === "/api/status") return json(calls.snapshot());
        if (p === "/connect") {
          const to = auth.connectUrl();
          return to ? Response.redirect(to, 302) : html("TipPhone has no OAuth client id set. See the README.");
        }
        if (p === "/callback") return Response.redirect(await auth.callback(url.searchParams), 302);
        return new Response("not found", { status: 404 });
      }

      if (req.method !== "POST" || !okOrigin(req)) return new Response("nope", { status: 403 });

      // the ring upload is the file itself, not json
      if (p === "/api/ring") {
        if (Number(req.headers.get("content-length")) > 8 * 1024 * 1024) return json({ error: "That file is over 8 MB, pick a shorter one" });
        let name = "";
        try { name = decodeURIComponent(req.headers.get("x-file-name") || ""); } catch {}
        const result = saveRing(name, new Uint8Array(await req.arrayBuffer()));
        calls.push();
        return json(result);
      }
      if (p === "/api/ring/reset") {
        const result = resetRing();
        calls.push();
        return json(result);
      }

      const body = await req.json().catch(() => ({}));

      if (p === "/api/sign-out") return json(await auth.signOut());
      if (p === "/api/test-call") return json(await calls.testCall());
      if (p === "/api/test-overlay") return json(calls.testOverlay());
      if (p === "/api/queue") return json(await calls.setPaused(!!body.paused));
      if (p === "/api/config") return json(applyConfig(body));

      const m = p.match(/^\/player\/(\d+)\/(ready|phone|report)$/);
      if (m) {
        const player = players.get(m[1]);
        if (!player || m[1] !== active) return json({ error: "not the active control page" }, 409);
        if (m[2] === "ready") {
          player.ready = !!body.ready;
          calls.playerChanged();
        }
        if (m[2] === "phone") calls.setPhone(body);
        if (m[2] === "report") calls.report(body);
        return json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  });

  return hub;
}
