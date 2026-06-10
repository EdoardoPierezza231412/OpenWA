# WhatsApp AI bot with OpenWA + Ollama (100% free, local)

A tiny, **zero-dependency** Node service that turns an OpenWA session into an AI
assistant powered by a **local Ollama model** — no API keys, no per-message cost.

```
WhatsApp  ──▶  OpenWA  ──(message.received webhook)──▶  bot.mjs  ──▶  Ollama (local LLM)
   ▲                                                        │
   └───────────────  send-text API  ◀──────────────────────┘
```

Everything runs on your own hardware (a Quadro P2000 is plenty for a 3B model),
or you can point it at a bigger GPU on another machine by changing one URL.

> **Want it running 24/7 (e.g. on a server via Portainer)?** See
> [DEPLOY-PORTAINER.md](DEPLOY-PORTAINER.md) — it deploys OpenWA + Ollama + this bot
> as one always-on stack ([stack.yml](stack.yml)). The steps below are for running
> it locally against an OpenWA you already have.

---

## Prerequisites

- **OpenWA running** (this repo) with a connected WhatsApp session — API at `http://localhost:2785`.
- **Node.js 22+** (the bot uses built-in `fetch`/`crypto`/`--env-file`, so nothing to install).
- **Ollama** installed: https://ollama.com/download

---

## Setup

### 1. Pull a model

The Quadro P2000 has **5 GB VRAM** → run a **3B-class** model fully on the GPU:

```bash
ollama pull llama3.2:3b      # great default; also try qwen2.5:3b, phi3:mini, gemma2:2b
```

Quick test that Ollama works:

```bash
ollama run llama3.2:3b "say hi in one short sentence"
```

> Using your school server instead? Run `ollama pull` **there**, make sure it
> listens on the network (`OLLAMA_HOST=0.0.0.0 ollama serve`), and set
> `OLLAMA_URL=http://that-server:11434` in `.env`. A bigger GPU can run
> `qwen2.5:7b` or `llama3.1:8b` for noticeably better replies.

### 2. Make sure OpenWA has a connected session

Start OpenWA (`npm run dev` from the repo root), open the dashboard at
`http://localhost:2886`, create a session, and scan the QR with WhatsApp.
Note the **session ID** and grab an **API key** (Dashboard → API Keys, OPERATOR role).

### 3. Configure the bot

```bash
cd examples/ollama-bot
cp .env.example .env
```

Edit `.env`:
- `OPENWA_API_KEY` — your OpenWA API key
- `WEBHOOK_SECRET` — any long random string (you'll reuse it in step 5)
- `OLLAMA_MODEL` / `OLLAMA_URL` — model and host from step 1

### 4. Start the bot

```bash
npm start          # = node --env-file=.env bot.mjs
```

You should see it listening on `:3001` with `signature: verified`.

### 5. Tell OpenWA to send messages to the bot

Register a webhook on your session pointing at the bot, using the **same secret**
as `WEBHOOK_SECRET`:

```bash
curl -X POST http://localhost:2785/api/sessions/<SESSION_ID>/webhooks \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <YOUR_API_KEY>" \
  -d '{
    "url": "http://localhost:3001/",
    "events": ["message.received"],
    "secret": "<SAME_AS_WEBHOOK_SECRET>"
  }'
```

### 6. Try it

From **another phone**, message the WhatsApp number connected to OpenWA.
The bot logs `[in]` → `[out]` and the reply lands back in the chat. 🎉

---

## Notes & troubleshooting

- **`401 invalid signature` in the bot logs** → the webhook `secret` (step 5) and
  `WEBHOOK_SECRET` (`.env`) don't match exactly.
- **OpenWA runs in Docker?** `localhost` inside the container isn't your host. Use
  `http://host.docker.internal:3001/` as the webhook URL (step 5), or run the bot
  in the same Docker network.
- **No reply / Ollama errors** → confirm `ollama list` shows your model and
  `curl $OLLAMA_URL/api/tags` works from the bot's machine.
- **Replies are slow** → use a smaller model (`gemma2:2b`) on the P2000, or move
  Ollama to the school GPU. The bot serializes generations (one at a time) so a
  5 GB card never gets overloaded.
- **Groups**: ignored by default (`IGNORE_GROUPS=true`) so the bot doesn't reply
  to every group message. Set it to `false` to answer in groups too.
- **Memory**: the bot keeps the last `HISTORY_TURNS` exchanges per chat in RAM
  only (nothing is persisted); it resets when you restart it.

## How it stays safe

- Verifies OpenWA's `X-OpenWA-Signature` (HMAC-SHA256) on every webhook.
- Ignores its own messages (`fromMe`) so it can't talk to itself in a loop.
- Acknowledges the webhook immediately, then generates the reply asynchronously,
  so OpenWA never times out or double-delivers.
