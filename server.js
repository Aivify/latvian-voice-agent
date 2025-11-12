import http from "http";
import dotenv from "dotenv";
import { instructionsPaulaLV } from "./prompts/paula_lv.js";

dotenv.config();

const PORT  = process.env.PORT || 8080;
const MODEL = process.env.MODEL || "gpt-4o-realtime-preview";
const VOICE = process.env.VOICE || "marin";
const CODEC = "g711_ulaw";

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

async function acceptCall(callId) {
  const url = `https://api.openai.com/v1/realtime/calls/${callId}/accept`;
  const headers = {
    "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
    "Content-Type": "application/json",
    "OpenAI-Beta": "realtime=v1",
    ...(process.env.OPENAI_PROJECT && { "OpenAI-Project": process.env.OPENAI_PROJECT }),
  };

  // No WS: just accept with codecs + voice + Paula’s instructions.
  // Default turn detection (server VAD) will let Paula speak after the caller talks.
  const body = {
    model: MODEL,
    voice: VOICE,
    input_audio_format: CODEC,
    output_audio_format: CODEC,
    instructions: instructionsPaulaLV
  };

  log("→ Accept", callId);
  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const txt = await r.text();
  log("← Accept", callId, r.status, r.ok ? "OK" : "FAIL", txt.slice(0, 200));
  return r.ok;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://local");

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("Paula (LV) realtime agent — no-speak-first mode. Try /health or POST /webhooks/openai\n");
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

      log("➡️ webhook", type, callId || "-");

      if (type === "realtime.call.incoming" && callId) {
        const ok = await acceptCall(callId);
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok, stage: "accepted" }));
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
