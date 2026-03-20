# Codex Bridge

### Make Claude Code and OpenAI Codex talk to each other.

Built on [Claude Code Channels](https://code.claude.com/docs/en/channels) (just launched) — the first project to use channels for agent-to-agent communication instead of just chat UIs.

Two AI coding agents. One bridge. Real-time conversation you can watch from your browser.

![Codex Bridge UI showing Claude and Codex discussing Redis vs Memcached](screenshot.png)

## The problem

Claude Code and Codex CLI are both great coding agents, but they can't talk to each other. MCP is request-response only — no back-and-forth. A2A (Google's agent protocol) isn't supported by either tool. There's no standard way to make two coding agents have an actual conversation.

## The solution

Claude Code recently shipped [Channels](https://code.claude.com/docs/en/channels), a way to push messages into a running session from an MCP server. This project uses that as the push mechanism on Claude's side, and a blocking MCP tool call on Codex's side, to create a full duplex bridge between the two.

<p align="center">
  <img src="architecture.svg" alt="Codex Bridge architecture diagram" width="800"/>
</p>

When Codex calls `send_to_claude()`, the bridge holds the connection open until Claude replies. From Codex's perspective it's a tool call that takes a bit to return. From Claude's perspective it's a channel notification. The bridge sits in between, routing messages and showing them in a web UI.

## What you need

- [Bun](https://bun.sh) (check with `bun --version`, install from bun.sh if missing)
- [Claude Code](https://code.claude.com) v2.1.80+ with a claude.ai account
- [Codex CLI](https://github.com/openai/codex) with an OpenAI API key or ChatGPT login

## Setup

### 1. Clone and install

```bash
git clone https://github.com/abhishekgahlot2/codex-claude-bridge.git
cd codex-claude-bridge
bun install
```

### 2. Register the bridge with Claude Code

Add `codex-bridge` to your Claude Code MCP config. Open `~/.mcp.json` (create it if it doesn't exist) and add:

```json
{
  "mcpServers": {
    "codex-bridge": {
      "type": "stdio",
      "command": "bun",
      "args": ["/full/path/to/codex-claude-bridge/server.ts"]
    }
  }
}
```

Replace `/full/path/to` with wherever you cloned the repo.

### 3. Register the bridge with Codex CLI

Add the Codex-side MCP server to `~/.codex/config.toml`:

```toml
[mcp_servers.codex-bridge]
command = "bun"
args = ["/full/path/to/codex-claude-bridge/codex-mcp.ts"]
tool_timeout_sec = 120
```

The `tool_timeout_sec = 120` is needed because `send_to_claude` blocks while waiting for Claude's reply. The default 60s timeout will kill the connection too early.

### 4. Start Claude Code with the channel

```bash
claude --dangerously-load-development-channels server:codex-bridge
```

You should see `Listening for channel messages from: server:codex-bridge` in the output.

### 5. Start Codex CLI

In a separate terminal:

```bash
codex
```

Codex will auto-load the `codex-bridge` MCP server from your config. Verify by running `/mcp` inside Codex — you should see `codex-bridge` listed with `send_to_claude` and `check_claude_messages` tools.

### 6. Open the web UI

Go to [http://localhost:8788](http://localhost:8788) in your browser. This is where you watch the conversation happen.

## Usage

Start the conversation from Codex's side. Tell Codex something like:

```
Use send_to_claude to discuss whether we should use Redis or Memcached for caching. Keep going until you agree.
```

Codex calls `send_to_claude()`, the bridge pushes it to Claude via a channel notification, Claude processes it and replies, and the bridge returns Claude's reply to Codex. Codex can keep calling `send_to_claude()` to continue the discussion.

You can also type in the web UI as a human observer — your messages go straight to Claude's session.

### Web UI

The web UI at localhost:8788 shows all messages in real time:
- Purple bubbles on the left = Claude
- Green bubbles on the right = Codex
- Gray bubbles = you (human observer)

### Starting from Claude's side

Claude has a `send_to_codex` tool, but since Codex can't receive push notifications, the message sits in a queue until Codex polls for it. The Codex-initiated flow is smoother.

## Files

| File | What it does |
|------|------|
| `server.ts` | Claude Code channel plugin. MCP server over stdio, web UI, and HTTP API endpoints for the Codex side. |
| `codex-mcp.ts` | Codex CLI MCP server. Exposes `send_to_claude()` and `check_claude_messages()`. Talks to `server.ts` over HTTP. |
| `.mcp.json` | Plugin config for Claude Code's plugin system. |
| `.claude-plugin/plugin.json` | Plugin metadata. |

## Configuration

| Env var | Default | What it does |
|---------|---------|------|
| `CODEX_BRIDGE_PORT` | `8788` | Port for the web UI and internal API |
| `CODEX_BRIDGE_URL` | `http://localhost:8788` | URL the Codex-side MCP server uses to reach the bridge |

## Why not MCP or A2A?

**MCP** is request-response only. One agent can call the other as a tool, but there's no push, no notifications, no way to have an actual back-and-forth conversation.

**A2A** (Google's Agent-to-Agent protocol) would solve this properly, but neither Claude Code nor Codex supports it. The community bridges that exist wrap A2A in MCP anyway.

**Claude Code Channels** are the only push mechanism either tool supports. This bridge uses channels on Claude's side and a blocking tool call on Codex's side to simulate full duplex communication. It's the simplest thing that actually works.

## Known limitations

- Codex can't receive push notifications — conversation flows best when Codex initiates.
- Both agents need to be on the same machine (localhost bridge).
- Channels are a Claude Code research preview feature — `--dangerously-load-development-channels` flag is required.
- Claude sometimes skips `reply_to` — the bridge falls back to resolving the oldest pending request.

## License

MIT
