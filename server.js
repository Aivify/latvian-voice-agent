import http from "http";
import dotenv from "dotenv";
dotenv.config();

const PORT = process.env.PORT || 8080;

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (req.method === "POST" && req.url === "/webhooks/openai") {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bodyText = Buffer.concat(chunks).toString();
      console.log("➡️  Incoming POST /webhooks/openai");
      console.log("Headers:", req.headers);
      console.log("Body:", bodyText);

      let body;
      try { body = JSON.parse(bodyText); }
      catch (e) {
        console.error("❌ JSON parse error:", e.message);
        res.writeHead(400);
        return res.end("bad json");
      }

      if (body?.type === "realtime.call.incoming") {
        const callId = body?.data?.call_id;
        if (!callId) {
          console.error("❌ Missing call_id");
        } else {
          console.log("📞 Call ID:", callId, "- accepting…");
          const r = await fetch(`https://api.openai.com/v1/realtime/calls/${callId}/accept`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              type: "realtime",
              model: "gpt-realtime",
              instructions: "Tu esi laipns latviešu balss aģents. Runā īsi, skaidri un draudzīgi.",
              // voice: "verse", // optional
              // input_audio_format: "g711_ulaw" // optional
            }),
          });
          console.log("✅ Accept status:", r.status);
          if (r.status !== 200) console.log("❌ Accept error body:", await r.text());
        }
      } else {
        console.log(`ℹ️  Ignored event type: ${body?.type}`);
      }

      res.writeHead(200);
      return res.end();
    } catch (err) {
      console.error("Webhook handler error:", err);
      res.writeHead(500);
      return res.end();
    }
  }
if (req.method === "GET" && req.url === "/") {
  res.writeHead(200, { "Content-Type": "text/plain" });
  return res.end("✅ Latvian Voice Agent backend is running.\nTry /health or POST /webhooks/openai");
}

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
