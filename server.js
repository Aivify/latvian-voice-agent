import http from "http";
import dotenv from "dotenv";
import WebSocket from "ws";
dotenv.config();

const PORT = process.env.PORT || 8080;

// ---------- helpers ----------
function log(...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}]`, ...args);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function acceptCall(callId) {
  const url = `https://api.openai.com/v1/realtime/calls/${callId}/accept`;
  const headers = {
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    "Content-Type": "application/json",
    "OpenAI-Beta": "realtime=v1",
    ...(process.env.OPENAI_PROJECT && { "OpenAI-Project": process.env.OPENAI_PROJECT }),
  };

  const payload = {
    model: process.env.MODEL || "gpt-4o-realtime-preview",
    voice: process.env.VOICE || "marin",
    input_audio_format: "g711_ulaw",
    output_audio_format: "g711_ulaw",
    // strict behavior: speak only when we send response.create, read verbatim
    instructions: [
      "Speak only when instructed via response.create.",
      "When instructed, read the Latvian text VERBATIM — no extra words, no reformulation.",
      "If not instructed, stay silent."
    ].join(" ")
  };

  log("→ Accepting call", callId);
  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
  const body = await r.text().catch(() => "");
  log("← Accept response", { status: r.status, ok: r.ok, body });
  return r.ok;
}

function speakFirst(callId, lines) {
  return new Promise((resolve) => {
    // open a WS bound to the same call
    const params = new URLSearchParams({
      model: process.env.MODEL || "gpt-4o-realtime-preview",
      voice: process.env.VOICE || "marin",
      input_audio_format: "g711_ulaw",
      output_audio_format: "g711_ulaw",
      call_id: callId,
    });

    const ws = new WebSocket(`wss://api.openai.com/v1/realtime?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
        ...(process.env.OPENAI_PROJECT && { "OpenAI-Project": process.env.OPENAI_PROJECT }),
      }
    });

    let stage = 0; // 0 idle, 1=GDPR playing, 2=intro playing, 3=done

    function sendResponse(text) {
      ws.send(JSON.stringify({
        type: "response.create",
        response: { instructions: text, modalities: ["audio", "text"] }
      }));
    }

    ws.on("open", async () => {
      // lock the session: no automatic VAD responses or transcriptions
      ws.send(JSON.stringify({
        type: "session.update",
        session: {
          turn_detection: null,                // disable auto speak
          input_audio_transcription: null,     // don't transcribe ambient audio
          instructions: "Speak only when instructed via response.create. Read Latvian text verbatim. Stay silent otherwise."
        }
      }));

      // small buffer for PSTN bridge to be fully ready
      await sleep(700);
      stage = 1;
      sendResponse(lines[0]); // GDPR first
    });

    ws.on("message", (buf) => {
      try {
        const evt = JSON.parse(buf.toString());
        if (evt.type === "error") log("WS error:", evt);
        if (evt.type === "response.created") log("WS evt:", evt.type);
        if (evt.type === "response.done") {
          if (stage === 1) {
            stage = 2;
            sendResponse(lines[1]); // Intro AFTER GDPR finishes
          } else if (stage === 2) {
            stage = 3;
            setTimeout(() => { try { ws.close(); } catch {} resolve(); }, 250);
          }
        }
      } catch {}
    });

    ws.on("error", (e) => { log("WS error:", e?.message || e); resolve(); });
    ws.on("close", () => { log("WS closed"); resolve(); });
  });
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (req.method === "POST" && req.url === "/webhooks/openai") {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const bodyText = Buffer.concat(chunks).toString();
      log("➡️  Incoming POST /webhooks/openai");
      log("Headers:", req.headers);
      log("Body:", bodyText.slice(0, 2000));

      let body;
      try { body = JSON.parse(bodyText || "{}"); }
      catch (e) {
        log("❌ JSON parse error:", e.message);
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "bad_json" }));
      }

      const type = body?.type || "unknown";
      if (type === "realtime.call.incoming") {
        const callId = body?.data?.call_id;
        if (!callId) {
          log("❌ Missing call_id");
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "missing_call_id" }));
        }

        const ok = await acceptCall(callId);
        if (ok) {
          await speakFirst(callId, [
            "Informācijai — šis demo zvans var tikt ierakstīts un analizēts kvalitātes nolūkiem.",
            "Labdien! Te Paula no Aivify. Ar ko man ir gods runāt?"
          ]);
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ received: true, accept_ok: ok }));
      }

      log(`ℹ️  Ignored event type: ${type}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, ignored: type }));
    } catch (err) {
      log("❌ Webhook handler error:", err?.stack || err?.message || err);
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "internal_error" }));
    }
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
