import http from "http";
import dotenv from "dotenv";
dotenv.config();

const PORT = process.env.PORT || 8080;

// Helper: timestamped log
function log(...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}]`, ...args);
}

// Helper: call accept endpoint
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

// HTTP server
const server = http.createServer(async (req, res) => {
  const { method, url } = req;

  // Root sanity check
  if (method === "GET" && url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("Latvian Voice Agent backend is running.\nTry /health or POST /webhooks/openai");
  }

  // Health route
  if (method === "GET" && url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  // Webhook route
  if (method === "POST" && url === "/webhooks/openai") {
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
      try {
        event = JSON.parse(bodyText || "{}");
      } catch (e) {
        log("JSON parse error:", e.message);
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "invalid_json" }));
      }

      const type = event?.type || "unknown";
      const callId = event?.data?.call_id;

      // Handle incoming call
      if (type === "realtime.call.incoming") {
        if (!callId) {
          log("Missing call_id in incoming event");
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "missing_call_id" }));
        }

        const payload = {
          type: "realtime",
          model: "gpt-4o-realtime-preview",
          // Optional configuration for later:
          // voice: "verse",
          // input_audio_format: "g711_ulaw",
          instructions: "Tu esi laipns latviešu balss aģents. Runā īsi, skaidri un draudzīgi. Tavs vārds ir Paula, tu pirmā sāc sarunu un pasaki savu vārdu"
        };

        const accept = await acceptCall(callId, payload);
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ received: true, accept_status: accept.status }));
      }

      // Log other realtime lifecycle events
      if (type.startsWith?.("realtime.call.")) {
        log("Lifecycle event:", type, { call_id: callId, data: event?.data });
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: true }));
      }

      log("Ignored event type:", type);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, ignored: type }));
    } catch (err) {
      log("Webhook handler error:", err?.stack || err?.message || err);
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "internal_error" }));
    }
  }

  // 404 fallback
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(PORT, () => log(`🚀 Server running on http://localhost:${PORT}`));
