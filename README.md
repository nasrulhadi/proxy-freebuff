# Proxy Freebuff

A transparent, zero-dependency **OpenAI- and Anthropic-compatible proxy** for [Freebuff](https://freebuff.com) — Codebuff's free-agent program. It lets you use Freebuff's free models from any OpenAI/Anthropic client: **9router, Cursor, Continue, Aider, opencode, Claude Code, or any custom OpenAI-compatible tool**.

Freebuff is only officially usable through its own CLI. This proxy speaks the same wire protocol the CLI uses, manages the free-session and agent-run lifecycle for you, and exposes a clean OpenAI/Anthropic API on your local machine.

```mermaid
flowchart LR
    T[Your tool] -->|POST /v1/chat/completions - OpenAI| P[Proxy Freebuff]
    T -->|POST /v1/messages - Anthropic| P
    P --> S[Free session<br/>create / poll / end]
    P --> R[Agent run<br/>START / rotate / FINISH]
    P --> C[POST /api/v1/chat/completions]
    S --> U[api.codebuff.com]
    R --> U
    C --> U
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
- **Free session management** — creates (only when the CLI is not running), polls, and rotates free sessions; surfaces the waiting room as `503 + Retry-After` so clients retry politely
- **Agent run lifecycle** — one run per agent, pre-warmed lazily, rotated every 6h, `FINISH`ed on rotation/shutdown so runs never dangle
- **Error recovery** — transparent refresh on `session_expired`/`session_superseded`/`waiting_room_*`, run rotation on `runId not found`, cooldown on auth rejection
- **Live model registry** — parses the current agent→model mapping straight from the upstream `CodebuffAI/codebuff` TypeScript sources (with a hardcoded fallback); refreshes every 6h
- **Tool schema normalization** — resolves `$ref`/`$defs` and simplifies nullable `anyOf`/`oneOf`/array types before forwarding
- **Outbound proxy support** — `FB_PROXY` (HTTP CONNECT or SOCKS5) for routing through a clean residential IP
- **Observability** — colorized terminal logs + `proxy.log`, optional debug dumps to `dump/`
- **CLI identity reuse** — `--credentials` uses the Freebuff CLI's own token and adopts its active session (via `~/.config/manicode/freebuff-instance-owner.json`) so the proxy and CLI share the account's single free session instead of fighting over it. **While the CLI process is running the proxy never creates or deletes a session**: it only adopts/refreshes the CLI's instance (re-reading the owner file on every refresh so a CLI restart is picked up) and refuses with a clear message if the session can't be verified — so running the proxy can never log the CLI out. Stop the CLI first if you need a different model
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

   The file contains a `default.authToken` value — that's your token (a UUID, not a `user_…` string).

   **Easiest: just pass `--credentials`** — the proxy reads the CLI's own `credentials.json` (token + account id) and even adopts the CLI's active free session, so it never competes with the CLI for your single session slot:
   ```bash
   node server.js --credentials
   ```

2. **Web** — log in at [https://freebuff.llm.pm](https://freebuff.llm.pm) and copy the displayed token.

## Quick start

```bash
git clone https://github.com/nasrulhadi/proxy-freebuff.git
cd proxy-freebuff

# Windows PowerShell
$env:FB_TOKEN="user_xxxxxxxxxx"; node server.js

# Linux / macOS
FB_TOKEN=user_xxxxxxxxxx node server.js

# or pass config as CLI flags (they override env vars)
node server.js --token=user_xxxxxxxxxx --port=3457
```

```text
Proxy Freebuff
  OpenAI       POST /v1/chat/completions
  Anthropic    POST /v1/messages, /v1/messages/count_tokens
  Upstream     https://codebuff.com
  Listening    http://127.0.0.1:3457
  Token        configured
```

Smoke test:

```bash
curl http://127.0.0.1:3457/healthz
curl http://127.0.0.1:3457/v1/models
```

## Configuration

All configuration is via environment variables, and every variable can also be passed as a CLI flag (`--token=...`, `--port=...`, `--debug`, …) — run `node server.js --help` for the full list. CLI args take precedence over env vars.

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
| `FB_DEBUG` | — | Set `1` to dump raw upstream responses **and the exact outbound request** (headers minus `Authorization`, truncated body) to `dump/req-*.json` — use this to verify the wire shape |
| `FB_AGENTS_URL` | — | Override the base URL used to fetch the model registry sources |
| `FB_CREDENTIALS` | — | Set `1` (or pass `--credentials`) to use the Freebuff CLI identity from `~/.config/manicode/credentials.json` and adopt its active session |
| `FB_USER_AGENT` | `ai-sdk/openai-compatible/0.10.7/codebuff` | Pin a single outbound `User-Agent`. The default is the exact UA the CLI SDK pins (`model-provider.ts`) — the free-mode gate expects it (`403 free_mode_cli_required` otherwise) |
| `FB_USER_ID` | — | Freebuff account id (auto-filled from the CLI credentials with `--credentials`; sent on every chat call as `x-freebuff-acting-user-id` — the real CLI sends it and the gate expects it) |
| `FB_HTTP2` | `1` | Upstream transport. The real CLI runs on **Bun**, whose `fetch` negotiates **HTTP/2** with the server — and the known-working reference (trefeon on 9router/Cloudflare Workers) also speaks HTTP/2. Node's `https` module is HTTP/1.1, which the free-mode gate treats as a direct API caller. Default `1` = try HTTP/2 first and fall back to HTTP/1.1 automatically if the server can't ALPN it; set `0` to force HTTP/1.1 |
| `FB_COST_MODE` | `free` | Billing mode sent as `codebuff_metadata.cost_mode`. `free` = **0 credits** on free-allowlisted agent+model combos (what the CLI's LITE mode sends). Use `normal`/`lite`/`max` if you buy credits |

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

The backend rejects requests that don't look like the CLI (`403 free_mode_cli_required`). The proxy replicates the CLI's wire identity exactly (verified against the public `CodebuffAI/codebuff` source):

- **Chat requests** carry exactly what the real CLI sends: the pinned `ai-sdk/openai-compatible/0.10.7/codebuff` `User-Agent` and `x-freebuff-acting-user-id` (the account id). No `x-freebuff-model` / `x-freebuff-instance-id` headers on the chat call — the session instance travels in the body's `codebuff_metadata.freebuff_instance_id` instead
- **Session calls** send `x-freebuff-model` (POST) and `x-freebuff-instance-id` (GET), exactly like the CLI
- **Body envelope** — `provider: { allow_fallbacks: true }` (the CLI's routing options for non-allowlisted models: `{ order: providerOrder[model], allow_fallbacks: !isExplicitlyDefined }` from `sdk/src/impl/llm.ts`, with `order` absent for models outside the statically defined set). No `stop` list on plain chat — the CLI wires none (the `cb_easp` sentinel is an internal agent step param, not a model stop sequence), and caller-supplied stops pass through untouched
- **`stream: true` is always forced upstream** — the CLI never sends sync chat, and the free-mode gate rejects sync chat calls as "calling the API directly". The proxy forces `stream: true` on every upstream request and **accumulates the SSE back into a JSON completion for sync clients** (OpenAI and Anthropic alike), so client behavior is unchanged
- `codebuff_metadata` with `run_id`, `client_id` (a fresh 13-char base36 id per request, the shape the CLI mints via `Math.random().toString(36).substring(2, 15)` — the gate validates this format), `trace_session_id` (a UUID, sent by the CLI on every request), `cost_mode`, `freebuff_instance_id`
- `cost_mode: 'free'` in `codebuff_metadata` — this is the CLI's billing switch. Free mode gets **0 credits** on allowlisted agent+model combos (see `FREE_MODE_AGENT_MODELS` in the upstream `free-agents.ts`); without it the server bills the account as paid and a credit-less account gets `402 Out of credits` (the CLI SDK defaults to `normal` when absent). Override with `FB_COST_MODE` if you pay for credits

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
- **Windows stale-process cleanup** — on Windows, if `FB_PORT` is held by a leftover `node` process, the proxy kills **only that process** at startup (verified via `netstat`/`tasklist`/`taskkill`). Anything else holding the port is left alone; free it manually or change `FB_PORT`.

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
| `403 free_mode_cli_required` | The request didn't carry the CLI envelope — make sure you're running the latest version of this repo (pinned `ai-sdk/openai-compatible/0.10.7/codebuff` UA, `x-freebuff-acting-user-id` header, `provider: { allow_fallbacks: true }` (no `data_collection`), no `stop` list on plain chat, 13-char base36 `client_id`, `trace_session_id`, `cost_mode: free`, **forced `stream: true`**, no `x-freebuff-*` headers on chat, and **HTTP/2 upstream** (the CLI runs on Bun and speaks HTTP/2 — the proxy uses it by default with HTTP/1.1 fallback). If it persists, capture `dump/req-*.json` (`FB_DEBUG=1`) and compare against the envelope above |
| `402 Out of credits` | The proxy now sends `cost_mode: 'free'` by default; with an allowlisted model + adopted session this should clear. If you still see 402, it's the country/quota gate (entitlement 0 or daily quota exhausted) — check `GET /healthz` and route through a clean IP |
| `403 country_blocked / anonymous_network` | Upstream IP is a VPN/datacenter — see [Running through a clean IP](#running-through-a-clean-ip-important) |
| `503 waiting room queued` | Upstream queue — client should retry after `Retry-After` |
| `EADDRINUSE` | Port busy (Windows auto-kills the stale process; elsewhere free it manually) |
| CLI gets logged out when the proxy runs | Older proxy versions created a competing session while the CLI was alive (or DELETEd the adopted session on shutdown), which the server treats as session supersession → CLI logout. The current proxy never creates/deletes a session while the CLI runs — update and restart the proxy |

## Disclaimer

This project is for educational and research purposes only. It uses Freebuff's internal `/api/v1/*` endpoints, which are undocumented, may change at any time, and may be restricted. **Using this proxy likely violates Freebuff/Codebuff's Terms of Service and may get your account banned.** Use at your own risk.

## License

MIT
