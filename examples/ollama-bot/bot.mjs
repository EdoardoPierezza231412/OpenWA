// OpenWA + Ollama WhatsApp bot — zero dependencies (Node 22+).
//
// Flow:  WhatsApp message  ->  OpenWA fires "message.received" webhook  ->  this
//        server verifies the HMAC signature  ->  asks a local Ollama model  ->
//        sends the reply back through OpenWA's send-text API.
//
// Run:   node --env-file=.env bot.mjs      (or: npm start)
//
// Everything is configured via environment variables — see .env.example.

import http from 'node:http';
import crypto from 'node:crypto';

const trimSlash = (s) => s.replace(/\/+$/, '');

const CONFIG = {
  // Where this bot listens for OpenWA webhooks (the URL you register with OpenWA).
  port: Number(process.env.BOT_PORT ?? 3001),

  // OpenWA API (to send replies). API key must have OPERATOR role.
  openwaUrl: trimSlash(process.env.OPENWA_URL ?? 'http://localhost:2785'),
  apiKey: process.env.OPENWA_API_KEY ?? '',

  // Must match the `secret` you set when creating the webhook in OpenWA.
  // If empty, signature verification is DISABLED (fine for a quick local test,
  // but anyone who can reach this port could trigger the bot — set it).
  webhookSecret: process.env.WEBHOOK_SECRET ?? '',

  // Ollama: local Quadro P2000, or e.g. http://your-school-server:11434
  ollamaUrl: trimSlash(process.env.OLLAMA_URL ?? 'http://localhost:11434'),
  model: process.env.OLLAMA_MODEL ?? 'llama3.2:3b',

  // Behaviour
  systemPrompt:
    process.env.SYSTEM_PROMPT ??
    'You are a friendly WhatsApp assistant. Reply concisely (a few sentences max) in the language the user writes in.',
  ignoreGroups: (process.env.IGNORE_GROUPS ?? 'true') !== 'false',
  historyTurns: Number(process.env.HISTORY_TURNS ?? 6), // user+assistant pairs kept per chat
  maxChats: Number(process.env.MAX_CHATS ?? 500), // cap memory across conversations
  ollamaTimeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS ?? 60000),
};

if (!CONFIG.apiKey) {
  // Don't crash — on a fresh deploy the OpenWA admin key doesn't exist until its
  // first boot. Stay up (so /health passes and webhooks are received) and just
  // skip replying until the key is set and the stack is redeployed.
  console.warn('WARNING: OPENWA_API_KEY not set — bot will receive messages but cannot reply until you set it.');
}
if (!CONFIG.webhookSecret) {
  console.warn('WARNING: WEBHOOK_SECRET is not set — webhook signature verification is OFF.');
}

// --- short rolling memory per chat, so replies have context -------------------
/** @type {Map<string, {role: string, content: string}[]>} */
const history = new Map();

function remember(chatId, role, content) {
  let turns = history.get(chatId);
  if (!turns) {
    if (history.size >= CONFIG.maxChats) {
      history.delete(history.keys().next().value); // evict oldest conversation
    }
    turns = [];
    history.set(chatId, turns);
  }
  turns.push({ role, content });
  const max = CONFIG.historyTurns * 2;
  if (turns.length > max) turns.splice(0, turns.length - max);
}

// --- serialize Ollama calls -- one generation at a time protects a 5GB GPU ----
let chain = Promise.resolve();
function enqueue(task) {
  const run = chain.then(task, task);
  chain = run.catch(() => {}); // never let a rejection break the chain
  return run;
}

// --- HMAC verification, matching OpenWA's WebhookService.generateSignature -----
function verifySignature(rawBody, signatureHeader) {
  if (!CONFIG.webhookSecret) return true; // verification disabled
  if (!signatureHeader) return false;
  const expected =
    'sha256=' + crypto.createHmac('sha256', CONFIG.webhookSecret).update(rawBody).digest('hex');
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// --- talk to Ollama -----------------------------------------------------------
async function askOllama(chatId, userText) {
  const messages = [
    { role: 'system', content: CONFIG.systemPrompt },
    ...(history.get(chatId) ?? []),
    { role: 'user', content: userText },
  ];
  const res = await fetch(`${CONFIG.ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: CONFIG.model, messages, stream: false }),
    signal: AbortSignal.timeout(CONFIG.ollamaTimeoutMs),
  });
  if (!res.ok) {
    throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return (data.message?.content ?? '').trim();
}

// --- send a reply back through OpenWA -----------------------------------------
async function sendText(sessionId, chatId, text) {
  const res = await fetch(`${CONFIG.openwaUrl}/api/sessions/${sessionId}/messages/send-text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': CONFIG.apiKey },
    body: JSON.stringify({ chatId, text: text.slice(0, 4096) }), // send-text caps at 4096
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(`OpenWA send-text HTTP ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

// --- handle one inbound message ----------------------------------------------
async function handleMessage(sessionId, msg) {
  if (msg.fromMe) return; // never reply to our own messages (loop guard)
  if (msg.type !== 'chat') return; // text only for this example
  if (CONFIG.ignoreGroups && msg.isGroup) return; // don't barge into groups
  const text = (msg.body ?? '').trim();
  if (!text) return;
  if (!CONFIG.apiKey) {
    console.warn('[skip] OPENWA_API_KEY not set yet — set it and redeploy to enable replies.');
    return;
  }

  const chatId = msg.chatId || msg.from;
  console.log(`[in ] ${chatId}: ${text}`);

  try {
    const reply = await enqueue(() => askOllama(chatId, text));
    if (!reply) return;
    remember(chatId, 'user', text);
    remember(chatId, 'assistant', reply);
    await sendText(sessionId, chatId, reply);
    console.log(`[out] ${chatId}: ${reply.replace(/\n/g, ' ⏎ ')}`);
  } catch (err) {
    console.error(`[err] ${chatId}: ${err.message}`);
  }
}

// --- HTTP server: receives OpenWA webhooks ------------------------------------
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  if (req.method !== 'POST') {
    res.writeHead(405);
    return res.end();
  }

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);

    if (!verifySignature(raw, req.headers['x-openwa-signature'])) {
      console.warn('[reject] invalid webhook signature');
      res.writeHead(401);
      return res.end('invalid signature');
    }

    // Acknowledge immediately so OpenWA marks the delivery done and does not
    // retry while the (slower) model generates a reply.
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');

    let payload;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      console.warn('[skip] body was not valid JSON');
      return;
    }
    if (payload.event !== 'message.received') return; // ignore other events
    handleMessage(payload.sessionId, payload.data ?? {});
  });
});

server.listen(CONFIG.port, () => {
  console.log('OpenWA + Ollama WhatsApp bot');
  console.log(`  listening   : http://localhost:${CONFIG.port}/  (register /  as the webhook URL)`);
  console.log(`  OpenWA      : ${CONFIG.openwaUrl}`);
  console.log(`  Ollama      : ${CONFIG.ollamaUrl}  (model: ${CONFIG.model})`);
  console.log(`  signature   : ${CONFIG.webhookSecret ? 'verified' : 'OFF — set WEBHOOK_SECRET'}`);
  console.log(`  groups      : ${CONFIG.ignoreGroups ? 'ignored' : 'answered'}`);
});
