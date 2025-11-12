import 'dotenv/config';
import Fastify from 'fastify';
import { WebSocket } from 'ws';
import { fetch } from 'undici';

const fastify = Fastify({ logger: true });

const PORT  = process.env.PORT || 8080;
const API_KEY = process.env.OPENAI_API_KEY;

if (!API_KEY) {
  console.error('Missing OPENAI_API_KEY in env');
  process.exit(1);
}

// --- Model & media config ---
const MODEL = 'gpt-4o-realtime-preview';
const VOICE = 'marin';
const ALAW  = 'g711_ulaw';

// --- Lines to speak first ---
const GDPR  = 'Informācijai — šis demo zvans var tikt ierakstīts un analizēts kvalitātes nolūkiem.';
const INTRO = 'Sveiki! Mani sauc Paula un es esmu Aivify asistente. Ar ko man ir gods runāt?';

// --- Strict instructions for speak-first phase (no improvisation) ---
const STRICT = [
  'Speak only when explicitly instructed via response.create.',
  'Read Latvian text verbatim. Do not improvise.',
  'No persona. No small talk.',
  'Stay silent unless instructed. Do not transcribe or react to background audio.'
].join(' ');

// Health
fastify.get('/health', async () => ({ ok: true }));

// Webhook: accept the call, then speak-first over WS
fastify.post('/webhooks/openai', async (request, reply) => {
  try {
    const eventType = request.body?.type;
    const callId =
      request.body?.data?.call_id ||
      request.body?.data?.id ||
      request.body?.data?.call?.id;

    if (eventType !== 'realtime.call.incoming' || !callId) {
      return reply.code(200).send({ ok: true, ignored: true });
    }

    // 1) ACCEPT the call with the strict speak-first settings
    const acceptUrl = `https://api.openai.com/v1/realtime/calls/${callId}/accept`;
    const acceptBody = {
      model: MODEL,
      voice: VOICE,
      input_audio_format: ALAW,
      output_audio_format: ALAW,
      instructions: STRICT
    };

    const acceptResp = await fetch(acceptUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'realtime=v1'
      },
      body: JSON.stringify(acceptBody)
    });

    if (!acceptResp.ok) {
      const txt = await acceptResp.text();
      request.log.error({ status: acceptResp.status, txt }, 'ACCEPT FAILED');
      // Acknowledge webhook so provider won’t retry; we still log failure
      return reply.code(200).send({ ok: false, stage: 'accept', status: acceptResp.status });
    }

    // Ack webhook quickly
    reply.code(200).send({ ok: true });

    // 2) Open WS bound to call_id
    const wsUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}&call_id=${encodeURIComponent(callId)}`;
    const ws = new WebSocket(wsUrl, {
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });

    // --- state machine ---
    const state = {
      phase: 'init',                 // init -> gdpr -> intro -> chat
      audioStartedFor: new Set(),    // response.id that actually started audio
      timers: new Map()              // response.id -> timeout
    };

    const log = (...a) => request.log.info({ callId }, a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    const delay = (ms) => new Promise(r => setTimeout(r, ms));
    const clearTimer = (id) => { const t = state.timers.get(id); if (t) { clearTimeout(t); state.timers.delete(id); } };

    const sendSessionUpdate = (session) => {
      ws.send(JSON.stringify({ type: 'session.update', session }));
    };

    const sendLine = (text) => {
      ws.send(JSON.stringify({
        type: 'response.create',
        response: {
          modalities: ['audio', 'text'],
          instructions: text,
          audio: { voice: VOICE, format: ALAW }
        }
      }));
      log('response.create:', text);
    };

    const armNoStartRetry = (responseId, text) => {
      const t = setTimeout(() => {
        if (!state.audioStartedFor.has(responseId)) {
          log(`No audio start for ${responseId} in 1200ms → retry line once`);
          sendLine(text);
        }
      }, 1200);
      state.timers.set(responseId, t);
    };

    ws.on('open', async () => {
      log('WS open');

      // 2a) Disable auto behaviors so model stays silent until we speak
      sendSessionUpdate({
        turn_detection: null,                 // disable VAD / auto-turns
        input_audio_transcription: null,     // no ambient ASR
        instructions: STRICT,                // keep strict instructions in-session
        temperature: 0,
        modalities: ['audio', 'text'],
        input_audio_format: ALAW,
        output_audio_format: ALAW,
        voice: VOICE
      });
      log('session.update (silent) sent');

      // 2b) Let PSTN/SIP bridge settle a bit
      await delay(800);

      // 3) GDPR first
      state.phase = 'gdpr';
      sendLine(GDPR);
    });

    ws.on('message', async (data) => {
      let evt;
      try { evt = JSON.parse(data.toString()); } catch { return; }

      const t = evt.type;

      // Mark actual audio start (prefer explicit, fallback to first delta)
      if (t === 'response.output_audio_buffer.started' && evt.response?.id) {
        state.audioStartedFor.add(evt.response.id);
        clearTimer(evt.response.id);
        log('audio STARTED:', evt.response.id);
      }
      if (t === 'response.output_audio.delta' && evt.response?.id && !state.audioStartedFor.has(evt.response.id)) {
        state.audioStartedFor.add(evt.response.id);
        clearTimer(evt.response.id);
        log('audio DELTA -> treat as started:', evt.response.id);
      }

      // Arm retry timer for GDPR once we see it's created
      if (t === 'response.created' && evt.response?.id && state.phase === 'gdpr') {
        armNoStartRetry(evt.response.id, GDPR);
      }

      // Advance on completion
      if (t === 'response.done' && evt.response?.id) {
        clearTimer(evt.response.id);

        if (state.phase === 'gdpr') {
          state.phase = 'intro';
          await delay(250); // tiny gap to avoid overlap on some trunks
          sendLine(INTRO);
        } else if (state.phase === 'intro') {
          // 4) Switch to normal conversation mode
          state.phase = 'chat';
          sendSessionUpdate({
            turn_detection: { type: 'server_vad' },                 // enable VAD
            input_audio_transcription: { model: 'whisper-1' },      // optional live ASR
            temperature: 0.6,
            // Lighter convo instructions (now that speak-first is done)
            instructions: 'Tu esi laipns latviešu balss asistents. Atbildi īsi un skaidri.'
          });
          log('session.update (chat mode) sent — Paula is now in normal convo mode');
        }
      }
    });

    ws.on('close', (code, reason) => log('WS close', code, reason?.toString() || ''));
    ws.on('error', (err) => log('WS error', err?.message || err));
  } catch (e) {
    request.log.error(e, 'Webhook handler exception');
    try { reply.code(200).send({ ok: false, error: 'handler_exception' }); } catch {}
  }
});

fastify.listen({ port: PORT, host: '0.0.0.0' })
  .then(() => fastify.log.info(`Listening on :${PORT}`))
  .catch(err => {
    fastify.log.error(err);
    process.exit(1);
  });
