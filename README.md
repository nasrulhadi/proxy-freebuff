# Proxy Freebuff

A transparent, zero-dependency **OpenAI- and Anthropic-compatible proxy** for [Freebuff](https://freebuff.com) — Codebuff's free-agent program. It lets you use Freebuff's free models from any OpenAI/Anthropic client: **9router, Cursor, Continue, Aider, opencode, Claude Code, or any custom OpenAI-compatible tool**.

Freebuff is only officially usable through its own CLI. This proxy speaks the same wire protocol the CLI uses, manages the free-session and agent-run lifecycle for you, and exposes a clean OpenAI/Anthropic API on your local machine.

```
Your tool → POST /v1/chat/completions (OpenAI)  ─┐
          → POST /v1/messages (Anthropic)        ├─ Proxy Freebuff
                                                  ┘
        ├─ free session lifecycle  (create / poll / end)
        ├─ agent run lifecycle     (START / reuse / rotate / FINISH)
        └─ chat request            (POST /api/v1/chat/completions)
                                                        │
                                                        ▼
                                              api.codebuff.com
```

## Why

Freebuff has two API surfaces:

| Surface | Works on any plan? |
|---|---|
| `/api/v1/chat/completions` (the CLI's endpoint) | **Yes** |
| `/provider/v1/*` (public provider API) | No — blocked for free agents |

Calling `/api/v1/chat/completions` directly gets you rejected with `403 free_mode_cli_required` — the backend fingerprints CLI traffic and refuses direct API calls. This proxy replicates the CLI's request envelope (headers + metadata shape), so it works like the official client does.

## Features

- **OpenAI-compatible** — `POST /v1/chat/completions` (streaming + non-streaming), `GET /v1/models`
- **Anthropic-compatible** — `POST /v1/messages` (streaming + non-streaming), `POST /v1/messages/count_tokens` with automatic format conversion (thinking blocks, tool use, images)
- **Free session management** — creates, polls, and rotates free sessions; surfaces the waiting room as `503 + Retry-After` so clients retry politely
- **Agent run lifecycle** — one run per agent, pre-warmed lazily, rotated every 6h, `FINISH`ed on rotation/shutdown so runs never dangle
- **Error recovery** — transparent refresh on `session_expired`/`session_superseded`/`waiting_room_*`, run rotation on `runId not found`, cooldown on auth rejection
- **Live model registry** — parses the current agent→model mapping straight from the upstream `CodebuffAI/codebuff` TypeScript sources (with a hardcoded fallback); refreshes every 6h
- **Tool schema normalization** — resolves `$ref`/`$defs` and simplifies nullable `anyOf`/`oneOf`/array types before forwarding
- **Outbound proxy support** — `FB_PROXY` (HTTP CONNECT or SOCKS5) for routing through a clean residential IP
- **Observability** — colorized terminal logs + `proxy.log`, optional debug dumps to `dump/`
- **Zero dependencies** — Node.js 18+ only

## Getting a token

Freebuff requires a `user_...` auth token. Two ways to get one:

1. **CLI (recommended)** — install and log in once:
   ```bash
   npm i -g freebuff
   freebuff
   ```
   The token is saved to your credentials file:

   | OS | Path |
   |---|---|
   | Windows | `C:\Users\<you>\.config\manicode\credentials.json` |
   | Linux / macOS | `~/.config/manicode/credentials.json` |

   The file contains a `default.authToken` value — that's your token.

2. **Web** — log in at [https://freebuff.llm.pm](https://freebuff.llm.pm) and copy the displayed token.

## Quick start

```bash
git clone https://github.com/nasrulhadi/proxy-freebuff.git
cd proxy-freebuff

# Windows PowerShell
$env:FB_TOKEN="user_xxxxxxxxxx"; node server.js

# Linux / macOS
FB_TOKEN=user_xxxxxxxxxx node server.js
```

```
┌─────────────────────────────────────────────────┐
│  Proxy Freebuff                                  │
│  OpenAI/Anthropic → codebuff.com free agents     │
├─────────────────────────────────────────────────┤
│  Listening    http://127.0.0.1:3457              │
│  OpenAI       POST /v1/chat/completions          │
│  Anthropic    POST /v1/messages, /v1/messages/count_tokens │
│  Upstream     https://codebuff.com               │
│  Proxy        none                               │
│  Token        configured                         │
└─────────────────────────────────────────────────┘
```

Smoke test:

```bash
curl http://127.0.0.1:3457/healthz
curl http://127.0.0.1:3457/v1/models
```

## Configuration

All configuration is via environment variables.

| Variable | Default | Description |
|---|---|---|
| `FB_TOKEN` | — | **Required.** Your Freebuff `user_...` auth token |
| `FB_PORT` | `3457` | Listen port (only `127.0.0.1` is bound by default) |
| `FB_HOST` | `127.0.0.1` | Listen host — keep `127.0.0.1` unless you know what you're doing |
| `FB_UPSTREAM` | `https://codebuff.com` | Upstream base URL (auto-follows the `www.` redirect) |
| `FB_TIMEOUT` | `900000` | Upstream request timeout in ms (15 min) |
| `FB_ROTATION` | `21600000` | Agent run rotation interval in ms (6 h) |
| `FB_PROXY` | — | Outbound proxy: `http://host:port`, `http://user:pass@host:port`, `socks5://host:port`, `socks5://user:pass@host:port` |
| `FB_API_KEYS` | — | Comma-separated keys required from proxy clients (`x-api-key` or `Bearer`). Empty = open on localhost |
| `FB_DEBUG` | — | Set `1` to dump raw upstream responses to `dump/` |
| `FB_AGENTS_URL` | — | Override the base URL used to fetch the model registry sources |

## API

### `GET /healthz`

Status, uptime, model count, and a snapshot of the token/session/run state.

### `GET /v1/models`

```json
{
  "object": "list",
  "data": [{ "id": "deepseek/deepseek-v4-flash", "object": "model", ... }]
}
```

Model list is resolved live from the upstream `CodebuffAI/codebuff` registry (agents like `base2-free-*`, `file-picker`, `basher`, …), with a hardcoded fallback if GitHub is unreachable.

### `POST /v1/chat/completions`

Standard OpenAI chat completions, streaming or not. Tool calls, reasoning, images, and `max_tokens` are passed through.

### `POST /v1/messages`

Standard Anthropic Messages API — converted to OpenAI, proxied, and converted back (including `thinking` blocks, `tool_use`, images, `stop_reason`, usage).

### `POST /v1/messages/count_tokens`

Returns an estimated input token count.

## Integrations

### 9router

```json
{
  "freebuff": {
    "base_url": "http://localhost:3457/v1",
    "api_key": "user_xxxxxxxxxx",
    "models": ["deepseek/deepseek-v4-flash", "minimax/minimax-m2.7"]
  }
}
```

### OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:3457/v1", api_key="user_xxxxxxxxxx")
resp = client.chat.completions.create(
    model="deepseek/deepseek-v4-flash",
    messages=[{"role": "user", "content": "Hello!"}],
)
```

### Cursor

Settings → OpenAI API Key → Override Base URL: `http://localhost:3457/v1`, API key: your token.

### Continue (VS Code)

```json
{
  "models": [{
    "title": "DeepSeek V4 Flash",
    "provider": "openai",
    "apiBase": "http://localhost:3457/v1",
    "apiKey": "user_xxxxxxxxxx",
    "model": "deepseek/deepseek-v4-flash"
  }]
}
```

### Claude Code / Anthropic clients

```bash
export ANTHROPIC_BASE_URL=http://localhost:3457
export ANTHROPIC_AUTH_TOKEN=user_xxxxxxxxxx
```

## Running through a clean IP (important)

Freebuff geo-gates its free mode:

| Situation | Result |
|---|---|
| IP in a blocked country (e.g. Indonesia) | `402 Out of credits` — the session is created but free entitlement is 0 |
| VPN / datacenter / proxy IP detected | `403 country_blocked` (`anonymous_network`) |

To use the proxy from a blocked region you must route upstream traffic through a **clean residential IP** (a home connection abroad, a residential proxy, or a VPS whose IP isn't flagged as hosting). Test any candidate IP with a free VPN/datacenter check (e.g. IPQualityScore) before committing to it.

```powershell
# SOCKS5 tunnel to a home machine abroad
ssh -D 1080 user@home-machine-abroad
$env:FB_PROXY="socks5://127.0.0.1:1080"
node server.js
```

## How it works

### Free session lifecycle

Freebuff gives each account a limited number of one-hour free sessions per day (Pacific time). Sessions are model-bound: the session's `model` field must match the request.

```
POST /api/v1/freebuff/session   → active | queued | ended | superseded | disabled
GET  /api/v1/freebuff/session   → poll (x-freebuff-instance-id header)
DELETE /api/v1/freebuff/session → end
```

- `queued` (waiting room) → the proxy responds `503` with `Retry-After` so the client backs off and retries.
- `ended` / `superseded` → transparently recreated.
- `disabled` → no session needed; requests proceed without an instance id.

### Agent run lifecycle

Each model maps to an *agent* (e.g. `base2-free-deepseek`). A run is created once per agent, reused across requests, rotated every 6 hours, and finished when rotated or on shutdown — mirroring the official CLI so runs never leak.

```
POST /api/v1/agent-runs  {action:"START", agentId}  → runId
POST /api/v1/agent-runs  {action:"FINISH", runId, status:"completed", totalSteps, ...}
```

### CLI-compatible request envelope

The backend rejects requests that don't look like the CLI. The proxy sends:

- **No `cost_mode` field** in `codebuff_metadata` — presence of `cost_mode` is what trips `free_mode_cli_required`
- `x-freebuff-model` and `x-freebuff-instance-id` headers
- `codebuff_metadata` with `run_id`, `client_id`, `freebuff_instance_id`

### Error recovery matrix

| Upstream error | Proxy behavior |
|---|---|
| `freebuff_update_required`, `waiting_room_required`, `session_superseded`, `session_expired` | Refresh session, retry once |
| `runId not found` / `runId not running` | Rotate run, retry once |
| `401` | Cooldown the token for 30 min |
| 429 / 503 / timeout | Surfaced to the client with `Retry-After` where available |

## Known limitations

- **Country / IP gating** — see [Running through a clean IP](#running-through-a-clean-ip-important). This is an upstream policy, not a proxy bug.
- **Daily session quota** — free sessions are limited per account per Pacific day; expect `402` once exhausted.
- **Model-bound sessions** — sessions are pinned to one model; switching models may require ending the session (`model_locked` / `session_model_mismatch`). Auto-switching is not implemented yet.
- **`count_tokens` is an estimate** — a zero-dependency heuristic (chars/4), not a real tokenizer.
- **Windows port auto-kill** — on Windows, the proxy kills any process already listening on `FB_PORT` at startup (`netstat`/`taskkill`); on other platforms you may need to free the port manually.

## Logs

All requests are logged to the terminal (colorized) and `proxy.log`:

```
[2026-08-09T11:47:22.366Z] [req] deepseek/deepseek-v4-flash | 127.0.0.1 | openai | sync
[2026-08-09T11:47:26.415Z] [upstream] 402 ERR | deepseek/deepseek-v4-flash | 4049ms | run b50547f6-…
[2026-08-09T11:47:26.415Z] [error] deepseek/deepseek-v4-flash | upstream 402: Out of credits
```

| Tag | Meaning |
|---|---|
| `[req]` | Incoming request: model, client IP, format, stream mode |
| `[upstream]` | Upstream status, model, latency, run id |
| `[done]` | Completion summary with text/tool counts and duration |
| `[error]` | Upstream or internal errors |

Set `FB_DEBUG=1` to dump raw upstream responses to `dump/` for troubleshooting.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `[error] FB_TOKEN is not set` | Set `FB_TOKEN` and restart |
| `401 upstream` | Token invalid — get a fresh one (see [Getting a token](#getting-a-token)) |
| `403 free_mode_cli_required` | The request carried `cost_mode` — check you're running the latest version of this repo |
| `402 Out of credits` | Blocked country (entitlement 0) **or** daily quota exhausted — check `GET /healthz` for session/rate details, and route through a clean IP |
| `403 country_blocked / anonymous_network` | Upstream IP is a VPN/datacenter — see [Running through a clean IP](#running-through-a-clean-ip-important) |
| `503 waiting room queued` | Upstream queue — client should retry after `Retry-After` |
| `EADDRINUSE` | Port busy (Windows auto-kills the stale process; elsewhere free it manually) |

## Disclaimer

This project is for educational and research purposes only. It uses Freebuff's internal `/api/v1/*` endpoints, which are undocumented, may change at any time, and may be restricted. **Using this proxy likely violates Freebuff/Codebuff's Terms of Service and may get your account banned.** Use at your own risk.

## License

MIT
