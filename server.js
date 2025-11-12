import http from "http";
import dotenv from "dotenv";
import WebSocket from "ws";
import { instructionsPaulaLV } from "./prompts/paula_lv.js";

dotenv.config();

const PORT  = process.env.PORT || 8080;
const MODEL = process.env.MODEL || "gpt-4o-realtime-preview";
const VOICE = process.env.VOICE || "marin";
const CODEC = "g711_ulaw";

// === EDIT IF NEEDED ===
const GDPR_LINE = "Informācijai — šis demo zvans var tikt ierakstīts un analizēts kvalitātes nolūkiem.";

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

// ---- idempotency (in-memory) ----
const accepted = new Set();   // call_ids we have accepted
const speaking = new Set();   // call_ids we already started speakFirst

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
    // Paula's persona for *after* GDPR
    instructions: instructionsPaulaLV
  };
  log("→ Accept", callId);
  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const txt = await r.text();
  log("← Accept", callId, r.status, r.ok ? "OK" : "FAIL", txt.slice(0, 200));
  return r.ok;
}

function speakFirst(callId) {
  if (speaking.has(callId)) return;
  speaking.add(callId);

  const qs = new URLSearchParams({
    model: MODEL,
    voice: VOICE,
    input_audio_format: CODEC,
    output_audio_format: CODEC,
    call_id: callId
  });

  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?${qs.toString()}`, {
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
      ...(process.env.OPENAI_PROJECT && { "OpenAI-Project": process.env.OPENAI_PROJECT }),
    }
  });

  let phase = "init";                       // init -> primer -> gdpr -> chat
  let keepAlive;                            // ping timer
  const send = (m) => ws.send(JSON.stringify(m));
  const say  = (text) => send({
    type: "response.create",
    response: {
      modalities: ["audio","text"],
      instructions: text,
      audio: { voice: VOICE, format: CODEC }
    }
  });

  ws.on("open", () => {
    log(`[${callId}] WS open`);

    // --- keepalive to avoid 1006 while model is preparing ---
    keepAlive = setInterval(() => { try { ws.ping(); } catch {} }, 10000);

    // deterministic during scripted part
    send({
      type: "session.update",
      session: {
        turn_detection: null,
        input_audio_transcription: null,
        temperature: 0,
        modalities: ["audio","text"],
        input_audio_format: CODEC,
        output_audio_format: CODEC,
        voice: VOICE
      }
    });
    log(`[${callId}] session.update (silent)`);

    // PRIMER first (opens RTP path)
    phase = "primer";
    say("Sveiki.");
    log(`[${callId}] primer sent`);
  });

  ws.on("message", (buf) => {
    let evt; try { evt = JSON.parse(buf.toString()); } catch { return; }
    const t = evt.type;
    // --- verbose tracing: see EVERYTHING the model emits ---
    if (t !== "response.output_audio.delta") {
      log(`[${callId}] EVT`, t, evt?.response?.id ? `rid=${evt.response.id}` : "");
    }

    if (t === "response.output_audio_buffer.started") {
      log(`[${callId}] audio STARTED rid=${evt.response?.id || "-"}`);
    }
    if (t === "response.error") {
      log(`[${callId}] response.error`, JSON.stringify(evt, null, 2));
    }
    if (t === "response.failed") {
      log(`[${callId}] response.failed`, JSON.stringify(evt, null, 2));
    }

    if (t === "response.done") {
      if (phase === "primer") {
        phase = "gdpr";
        say(GDPR_LINE);
        log(`[${callId}] GDPR sent`);
      } else if (phase === "gdpr") {
        phase = "chat";
        log(`[${callId}] GDPR done -> enabling chat mode`);
        send({
          type: "session.update",
          session: {
            turn_detection: { type: "server_vad" },
            input_audio_transcription: { model: "whisper-1" }, // optional
            instructions: instructionsPaulaLV,
            temperature: 0.6
          }
        });
        log(`[${callId}] session.update (chat mode)`);
        // IMPORTANT: do NOT close; keep the WS for conversation
      }
    }
  });

  ws.on("ping", () => { try { ws.pong(); } catch {} });
  ws.on("close", (c, r) => {
    if (keepAlive) clearInterval(keepAlive);
    log(`[${callId}] WS close`, c, r?.toString() || "");
  });
  ws.on("error", (e) => {
    if (keepAlive) clearInterval(keepAlive);
    log(`[${callId}] WS error`, e?.message || e);
  });
}


// ---- tiny HTTP server: /, /health, /webhooks/openai ----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://local");

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("Paula (LV) realtime agent running.\n");
  }
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (req.method === "POST" && url.pathname === "/webhooks/openai") {
    try {
      const chunks = [];
      for await (const ch of req) chunks.push(ch);
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      const type = body?.type;
      const callId = body?.data?.call_id || body?.data?.id || body?.data?.call?.id;

      log("➡️ webhook", type, callId);

      if (type === "realtime.call.incoming" && callId) {
        // idempotent accept
        if (accepted.has(callId)) {
          log("… already accepted, ignoring duplicate", callId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, duplicate: true }));
          // ensure speak-first is running
          speakFirst(callId);
          return;
        }

        const ok = await acceptCall(callId);
        if (ok) {
          accepted.add(callId);
          // reply 200 immediately to prevent webhook retries
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          // then start WS asynchronously
          speakFirst(callId);
          return;
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ ok: false, stage: "accept_failed" }));
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, ignored: type || "unknown" }));
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
