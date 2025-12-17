# Antigravity Claude Proxy

A proxy server that exposes an **Anthropic-compatible API** backed by **Antigravity's Cloud Code**, letting you use Claude models like `claude-sonnet-4-5` with any Anthropic client including Claude Code CLI.

## How It Works

```
┌──────────────────┐     ┌─────────────────────┐     ┌────────────────────────────┐
│   Claude Code    │────▶│  This Proxy Server  │────▶│  Antigravity Cloud Code    │
│   (Anthropic     │     │  (Anthropic → Google│     │  (daily-cloudcode-pa.      │
│    API format)   │     │   Generative AI)    │     │   sandbox.googleapis.com)  │
└──────────────────┘     └─────────────────────┘     └────────────────────────────┘
```

1. Receives requests in **Anthropic Messages API format**
2. Extracts OAuth token from Antigravity's local database
3. Transforms to **Google Generative AI format** with Cloud Code wrapping
4. Sends to Antigravity's Cloud Code API (`v1internal:streamGenerateContent`)
5. Converts responses back to **Anthropic format**

## Prerequisites

- **Antigravity** installed and running (you must be logged in)
- **Node.js** 18 or later

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Start the Proxy Server

```bash
npm start
```

The server runs on `http://localhost:8080` by default.

### 3. Test It

```bash
# Health check
curl http://localhost:8080/health

# Simple message (non-streaming)
curl http://localhost:8080/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "messages": [{"role": "user", "content": "Say hello!"}],
    "max_tokens": 100
  }'

# Streaming
curl http://localhost:8080/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "messages": [{"role": "user", "content": "Say hello!"}],
    "max_tokens": 100,
    "stream": true
  }'
```

## Using with Claude Code CLI

Configure Claude Code to use this proxy:

```bash
# Set the API base URL
export ANTHROPIC_BASE_URL=http://localhost:8080

# Use any API key (it's not actually used - auth comes from Antigravity)
export ANTHROPIC_API_KEY=dummy-key

# Run Claude Code
claude
```

Or in your Claude Code config:

```json
{
  "apiBaseUrl": "http://localhost:8080",
  "apiKey": "dummy-key"
}
```

## Available Models

| Model ID | Description |
|----------|-------------|
| `claude-sonnet-4-5` | Claude Sonnet 4.5 via Antigravity |
| `claude-sonnet-4-5-thinking` | Claude Sonnet 4.5 with extended thinking |
| `claude-opus-4-5-thinking` | Claude Opus 4.5 with extended thinking |

You can also use standard Anthropic model names - they'll be automatically mapped:
- `claude-3-5-sonnet-20241022` → `claude-sonnet-4-5`
- `claude-3-opus-20240229` → `claude-opus-4-5-thinking`

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check and token status |
| `/v1/messages` | POST | Anthropic Messages API |
| `/v1/models` | GET | List available models |
| `/refresh-token` | POST | Force token refresh |

## Files

```
src/
├── index.js            # Entry point
├── server.js           # Express server with Anthropic API endpoints
├── cloudcode-client.js # Cloud Code API client with proper wrapping
├── format-converter.js # Anthropic ↔ Google format conversion
├── constants.js        # Endpoints, headers, model mappings
└── token-extractor.js  # Extracts OAuth token from Antigravity
```

## Troubleshooting

### "Could not extract token from Antigravity"

Make sure:
1. Antigravity app is running
2. You're logged in to Antigravity

### 401 Authentication Errors

The token might have expired. Try:
```bash
curl -X POST http://localhost:8080/refresh-token
```

### Rate Limiting (429)

Antigravity enforces rate limits on Cloud Code requests. Wait and retry, or switch to a different model.

## Credits

Based on insights from:
- [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth) - Antigravity OAuth plugin for OpenCode
- [claude-code-proxy](https://github.com/1rgs/claude-code-proxy) - Anthropic API proxy using LiteLLM

## License

MIT
