import http from "http";
import dotenv from "dotenv";
import { instructionsPaulaLV } from "./prompts/paula_lv.js";
import WebSocket from "ws";

dotenv.config();

const PORT = process.env.PORT || 8080;

// ---------- helpers ----------
function log(...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}]`, ...args);
}

async function acceptCall(callId, payload) {
  const url = `https://api.openai.com/v1/realtime/calls/${callId}/accept`;
  const headers = {
    "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
    "Content-Type": "application/json",
    "OpenAI-Beta": "realtime=v1",
    ...(process.env.OPENAI_PROJECT && { "OpenAI-Project": process.env.OPENAI_PROJECT }),
  };

  log("→ Accepting call", callId, "with payload:", payload);
  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
  const text = await r.text();
  log("← Accept response", { status: r.status, ok: r.ok, body: text });
  return { status: r.status, ok: r.ok, body: text };
}

// small buffer after accept to avoid race conditions
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Open a short-lived Realtime WebSocket bound to this call
 * and queue 3 responses: GDPR → intro → tiny comfort ping.
 */
async function speakFirst(callId, lines) {
  return new Promise((resolve) => {
    const params = new URLSearchParams({
      model: process.env.MODEL || "gpt-4o-realtime-preview",
      voice: process.env.VOICE || "marin",
      input_audio_format: "g711_ulaw",
      output_audio_format: "g711_ulaw",
      call_id: callId,
    });

    const ws = new WebSocket(`wss://api.openai.com/v1/realtime?${params.toString()}`, {
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
        ...(process.env.OPENAI_PROJECT && { "OpenAI-Project": process.env.OPENAI_PROJECT }),
      }
    });

    ws.on("open", () => {
      // small delay so PSTN/SIP bridge is fully ready
      setTimeout(() => {
        // 1) GDPR line
        ws.send(JSON.stringify({
          type: "response.create",
          response: { instructions: lines[0], modalities: ["audio", "text"] }
        }));

        // 2) Intro after a short gap
        setTimeout(() => {
          ws.send(JSON.stringify({
            type: "response.create",
            response: { instructions: lines[1], modalities: ["audio", "text"] }
          }));

          // 3) Comfort ping ~1s later (helps if the first packet gets swallowed)
          setTimeout(() => {
            ws.send(JSON.stringify({
              type: "response.create",
              response: { instructions: "Sveiki.", modalities: ["audio", "text"] }
            }));

            // close shortly after queuing messages
            setTimeout(() => { try { ws.close(); } catch {} resolve(); }, 400);
          }, 1000);
        }, 300);
      }, 700);
    });

    ws.on("message", (buf) => {
      try {
        const evt = JSON.parse(buf.toString());
        if (evt.type?.startsWith("response.") || evt.type === "error") {
          log("WS evt:", evt.type);
          if (evt.type === "error") log("WS error:", evt);
        }
      } catch {}
    });

    ws.on("error", (e) => { log("WS error:", e?.message || e); resolve(); });
    ws.on("close", () => { log("WS closed"); resolve(); });
  });
}

// ---------- mock calendar config ----------
const TZ = process.env.TZ || "Europe/Riga";
const MEETING_MINUTES = Number(process.env.MEETING_MINUTES || 30);
const WORK_START = 10; // 10:00
const WORK_END = 17;   // 17:00

// persist for the life of the process (demo only)
const bookings = [];

function toISO(dt) { return new Date(dt).toISOString(); }
function roundUpToNextHalfHour(date = new Date()) {
  const d = new Date(date);
  d.setSeconds(0, 0);
  const m = d.getMinutes();
  d.setMinutes(m <= 30 ? 30 : 60);
  if (m > 30) d.setHours(d.getHours() + 1);
  return d;
}
function isSameISO(a, b) { return new Date(a).getTime() === new Date(b).getTime(); }

// ---------- single server ----------
const server = http.createServer(async (req, res) => {
  const { method } = req;
  const parsed = new URL(req.url, "http://local");
  const pathname = parsed.pathname;

  // root
  if (method === "GET" && pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("Latvian Voice Agent backend is running.\nTry /health or POST /webhooks/openai");
  }

  // health
  if (method === "GET" && pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  // webhook
  if (method === "POST" && pathname === "/webhooks/openai") {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bodyText = Buffer.concat(chunks).toString();

      log("➡️  Incoming POST /webhooks/openai", {
        ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
        ua: req.headers["user-agent"],
        len: req.headers["content-length"],
      });
      log("Body:", bodyText.slice(0, 2000));

      let event;
      try { event = JSON.parse(bodyText || "{}"); }
      catch (e) {
        log("❌ JSON parse error:", e.message);
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "invalid_json" }));
      }

      const type = event?.type || "unknown";
      const callId = event?.data?.call_id;

      if (type === "realtime.call.incoming") {
        if (!callId) {
          log("❌ Missing call_id");
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "missing_call_id" }));
        }

        const payload = {
          model: process.env.MODEL || "gpt-4o-realtime-preview",
          voice: process.env.VOICE || "marin",

          // Make PSTN/SIP bridges happy on both directions
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",

          instructions: instructionsPaulaLV,
        };

        const accept = await acceptCall(callId, payload);

        if (accept.ok) {
          await speakFirst(callId, [
            "Informācijai — šis demo zvans var tikt ierakstīts un analizēts kvalitātes nolūkiem.",
            "Labdien! Te Paula no Aivify. Ar ko man ir gods runāt?"
          ]);
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ received: true, accept_status: accept.status }));
      }

      if (type.startsWith?.("realtime.call.")) {
        log("ℹ️  Lifecycle event:", type, { call_id: callId, data: event?.data });
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: true }));
      }

      log("ℹ️  Ignored event type:", type);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, ignored: type }));
    } catch (err) {
      log("❌ Webhook handler error:", err?.stack || err?.message || err);
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "internal_error" }));
    }
  }

  // calendar: GET slots
  if (method === "GET" && pathname === "/calendar/slots") {
    const days = Number(parsed.searchParams.get("days") || 2);
    const now = new Date();
    const start = roundUpToNextHalfHour(now);

    const out = [];
    for (let d = 0; d <= days; d++) {
      const day = new Date(now);
      day.setDate(day.getDate() + d);
      for (let h = WORK_START; h < WORK_END; h++) {
        for (const m of [0, 30]) {
          const slot = new Date(day);
          slot.setHours(h, m, 0, 0);
          if (slot < start && d === 0) continue;
          const taken = bookings.some(b => isSameISO(b.slot, slot.toISOString()));
          if (!taken) out.push({ slot: toISO(slot), duration_min: MEETING_MINUTES, tz: TZ });
        }
      }
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ slots: out.slice(0, 8) }));
  }

  // calendar: POST book
  if (method === "POST" && pathname === "/calendar/book") {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      const { slotISO, name = "Unknown", phone = "" } = body;

      if (!slotISO) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "slotISO_required" }));
      }
      const already = bookings.some(b => isSameISO(b.slot, slotISO));
      if (already) {
        res.writeHead(409, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "slot_taken" }));
      }

      const eventId = "demo_" + Math.random().toString(36).slice(2, 10);
      bookings.push({ id: eventId, slot: slotISO, name, phone, created_at: new Date().toISOString() });

      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, eventId, slotISO, name }));
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "bad_json" }));
    }
  }

  // not found
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(PORT, () => log(`🚀 Server running on http://localhost:${PORT}`));
