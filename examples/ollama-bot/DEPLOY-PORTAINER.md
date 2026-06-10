# Deploy the always-on WhatsApp AI bot to Portainer

Runs **OpenWA + Ollama + the bot** as one self-contained, always-on stack. Once
deployed and the QR is scanned **once**, it survives container restarts and host
reboots (the WhatsApp session, DB and models live in named volumes).

> ⚠️ **Before you deploy on shared school infrastructure**
> - **Get the OK.** An always-on personal service that logs into *your* WhatsApp
>   account on a shared cluster is worth clearing with whoever runs it. The
>   compute footprint is tiny, but a **GPU is a shared resource** — keep Ollama on
>   CPU (the default here) until GPU use is approved.
> - **WhatsApp ban risk.** Running 24/7 from a datacenter IP can get a number
>   flagged. Use a **secondary number**, and consider OpenWA's per-session
>   **proxy** to route the session through an IP near the number's home region.

---

## 0. Prerequisites
- Your fork of this repo pushed to GitHub (the stack is built from it).
- Access to the school's Portainer with permission to add a stack on a
  **standalone Docker** environment.
- SSH access to that host (only for the one-time QR scan).

## 1. Push your fork
Commit the `examples/ollama-bot/` folder (and the `concurrently` fix) and push your
branch to GitHub so Portainer can reach it.

## 2. Add the stack in Portainer
**Stacks → Add stack → Repository**:
| Field | Value |
|---|---|
| Repository URL | your fork, e.g. `https://github.com/<you>/OpenWA` |
| Repository reference | `refs/heads/Test_edoardo` (your branch) |
| Compose path | `examples/ollama-bot/stack.yml` |

> **Host can't build images?** If Deploy fails with a BuildKit error
> (`http2: frame too large … looked like an HTTP/1.1 header`), switch the
> **Compose path** to `examples/ollama-bot/stack.images.yml` — a no-build variant
> that pulls prebuilt images and fetches the bot script at runtime. Everything else
> below is identical.

## 3. Set environment variables
In the stack's **Environment variables** (values from [stack.env.example](stack.env.example)):
- `WEBHOOK_SECRET` — a long random string (set now)
- `OLLAMA_MODEL` — `llama3.2:3b` (default)
- `OPENWA_API_KEY` — **leave blank for now** (you'll fill it in step 5)

## 4. Deploy
Click **Deploy**. First time, Portainer builds the OpenWA and bot images and pulls
Ollama + the model — give it a few minutes. The `bot` will start but log
`OPENWA_API_KEY not set` — expected; it stays up and healthy.

## 5. Get the OpenWA API key, then redeploy
OpenWA generates a random admin key on first boot. Open **openwa-api → Logs** in
Portainer and copy the key from the welcome banner:
```
  🔑 API Key (newly created):
     owa_k1_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```
Put it in the stack's `OPENWA_API_KEY` variable → **Update the stack**. The `bot`
restarts and is now able to reply.

## 6. Connect WhatsApp (one-time QR scan)
The API is bound to localhost on the server, so tunnel in from your machine:
```bash
ssh -L 2785:127.0.0.1:2785 <you>@<server>
```
Then in your browser open **http://localhost:2785/api/docs** (Swagger), click
**Authorize**, paste the API key, and:
1. `POST /api/sessions` → note the returned **session id**
2. `POST /api/sessions/{id}/start`
3. `GET /api/sessions/{id}/qr` → copy the `qrCode` value (a `data:image/png;base64,…`
   string), paste it into a new browser tab to render it, and **scan with WhatsApp**
   (Linked devices → Link a device).

The session is now saved in the `openwa-data` volume — you won't scan again.

## 7. Point OpenWA at the bot (register the webhook)
Because everything is in one stack, OpenWA reaches the bot by service name:
```bash
curl -X POST http://localhost:2785/api/sessions/<SESSION_ID>/webhooks \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <OPENWA_API_KEY>" \
  -d '{
    "url": "http://bot:3001/",
    "events": ["message.received"],
    "secret": "<SAME AS WEBHOOK_SECRET>"
  }'
```
(Run this through the SSH tunnel, or from a shell on the server.)

## 8. Try it
Message the connected number from another phone. Watch **bot → Logs** for
`[in]` → `[out]`. 🎉

---

## Operating notes
- **Always-on**: every service uses `restart: unless-stopped`; the bot/OpenWA come
  back after reboots and re-use the saved session — no re-scan.
- **Change the model**: update `OLLAMA_MODEL` and redeploy — `ollama-pull` fetches
  it automatically.
- **Enable GPU** (after approval): uncomment the `deploy.resources` block on the
  `ollama` service in [stack.yml](stack.yml). Needs the NVIDIA Container Toolkit on
  the host.
- **Security**: the API stays on `127.0.0.1` of the server; the bot and Ollama have
  no host ports at all. Keep the API key and webhook secret out of git.
- **Networking**: all inter-service URLs use Docker service names
  (`openwa-api`, `ollama`, `bot`) — no `host.docker.internal` needed since they
  share the `openwa-ollama-net` network.
