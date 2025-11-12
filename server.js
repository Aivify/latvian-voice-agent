import http from "http";
import dotenv from "dotenv";
import WebSocket from "ws";
import { instructionsPaulaLV } from "./prompts/paula_lv.js";

dotenv.config();

const PORT = process.env.PORT || 8080;
const MODEL = process.env.MODEL || "gpt-4o-realtime-preview";
const VOICE = process.env.VOICE || "marin";
const CODEC = "g711_ulaw";

// EDIT THE GDPR LINE HERE
const GDPR_LINE = "Lai jūs zinātu — šis zvans var tikt ierakstīts un analizēts kvalitātes nolūkos.";

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

// --- Accept helper ---
async function acceptCall(callId) {
  const url = `https://api.openai.com/v1/realtime/calls/${callId}/accept`;
  const headers = {
    "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
    "Content-Type": "application/json",
    "OpenAI-Beta": "realtime=v1",
    ...(process.env.OPENAI_PROJECT && { "OpenAI-Project": process.env.OPENAI_PROJECT }),
  };
  const body = {
    model: MODEL,
    voice: VOICE,
    input_audio_format: CODEC,
    output_audio_format: CODEC,
    // Keep default persona *for after* GDPR; we’ll enforce silence over WS first
    instructions: instructionsPaulaLV
  };
  log("→ Accept", callId);
  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const txt = await r.text();
  log("← Accept status", r.status, r.ok ? "OK" : "FAIL", txt.slice(0, 300));
  return r.ok;
}

// --- Speak-first (GDPR → then normal convo) ---
async function speakFirst(callId) {
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

    let phase = "init";   // init -> primer -> gdpr -> chat
    let deltaCount = 0;

    const send = (msg) => ws.send(JSON.stringify(msg));
    const say  = (text) => send({
      type: "response.create",
      response: {
        modalities: ["audio","text"],
        instructions: text,
        audio: { voice: (process.env.VOICE || "marin"), format: "g711_ulaw" }
      }
    });

    ws.on("open", () => {
      // Keep model silent/deterministic during scripted part
      send({
        type: "session.update",
        session: {
          turn_detection: null,
          input_audio_transcription: null,
          temperature: 0,
          modalities: ["audio","text"],
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          voice: (process.env.VOICE || "marin")
        }
      });

      // 1) PRIMER — wakes up the PSTN path so GDPR won’t get swallowed
      phase = "primer";
      say("Sveiki.");
    });

    ws.on("message", async (buf) => {
      let evt; try { evt = JSON.parse(buf.toString()); } catch { return; }
      const t = evt.type;

      if (t === "response.output_audio_buffer.started") {
        // good: media actually began streaming
        // (this is the event you were missing in logs)
        // optional: console.log("audio STARTED");
      }
      if (t === "response.output_audio.delta") {
        // fallback marker in case 'started' doesn't arrive on some routes
        deltaCount++;
      }

      if (t === "response.done") {
        if (phase === "primer") {
          // 2) Now say GDPR, with path already open
          phase = "gdpr";
          say("Informācijai — šis demo zvans var tikt ierakstīts un analizēts kvalitātes nolūkiem.");
        } else if (phase === "gdpr") {
          // 3) Switch to normal conversation (your Paula prompt), keep WS open
          phase = "chat";
          send({
            type: "session.update",
            session: {
              turn_detection: { type: "server_vad" },
              input_audio_transcription: { model: "whisper-1" }, // optional
              instructions: instructionsPaulaLV,
              temperature: 0.6
            }
          });
          return resolve();
        }
      }
    });

    ws.on("error", (e) => { /* console.log("WS error", e?.message||e); */ resolve(); });
    ws.on("close", () => { resolve(); });
  });
}


// --- Tiny HTTP server: /, /health, /webhooks/openai only ---
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://local");
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("Paula (LV) realtime voice agent is running. Try /health or POST /webhooks/openai\n");
  }
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (req.method === "POST" && url.pathname === "/webhooks/openai") {
    try {
      const chunks = [];
      for await (const ch of req) chunks.push(ch);
      const bodyText = Buffer.concat(chunks).toString();
      const event = JSON.parse(bodyText || "{}");
      const type = event?.type;
      const callId = event?.data?.call_id || event?.data?.id || event?.data?.call?.id;

      log("➡️ webhook", type, callId);

      // Only react to incoming calls
      if (type === "realtime.call.incoming" && callId) {
        const ok = await acceptCall(callId);
        if (ok) await speakFirst(callId);
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: true, ignored: type || "unknown" }));
      }
    } catch (e) {
      log("webhook error", e?.message || e);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false }));
    }
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(PORT, () => log(`listening on :${PORT}`));
