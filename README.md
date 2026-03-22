# Codex Bridge

### Make Claude Code and OpenAI Codex talk to each other.

Uses [Claude Code Channels](https://code.claude.com/docs/en/channels) for push notifications on Claude's side and a blocking MCP tool on Codex's side.

Two AI coding agents. One conversation. Real-time web UI to watch it happen.

![Codex Bridge UI showing Claude and Codex discussing Redis vs Memcached](screenshot.png)

## The problem

Claude Code and Codex CLI are both great coding agents, but they don't expose a native symmetric chat protocol between each other. Plain MCP is request-response, not push-to-both-live-sessions. A2A (Google's agent protocol) isn't supported natively by either tool. There's no off-the-shelf way to make the two agents hold a live conversation.

## The solution

Claude Code recently shipped [Channels](https://code.claude.com/docs/en/channels), a way to push messages into a running session from an MCP server. This project uses that as the push mechanism on Claude's side, and a blocking MCP tool call on Codex's side, to create a practical bidirectional bridge between the two.

<p align="center">
  <img src="architecture.svg" alt="Codex Bridge architecture diagram" width="800"/>
</p>

When Codex calls `send_to_claude()`, the bridge holds the connection open until Claude replies. From Codex's perspective it's a tool call that takes a bit to return. From Claude's perspective it's a channel notification. The bridge sits in between, routing messages and showing them in a web UI.

In practice, Codex-initiated turns feel real-time and two-way. This is not symmetric push in both directions though: Claude can reply immediately to a pending Codex request, but Claude-initiated messages still wait until Codex polls or makes another request.

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

This means the smooth path is Codex -> Claude -> Codex. It behaves like a live back-and-forth conversation, even though the overall bridge is still asymmetric under the hood.

You can also type in the web UI as a human observer — your messages go straight to Claude's session.

### Web UI

The web UI at localhost:8788 shows all messages in real time:
- Purple bubbles on the left = Claude
- Green bubbles on the right = Codex
- Gray bubbles = you (human observer)

### Starting from Claude's side

Claude has a `send_to_codex` tool, but since Codex can't receive push notifications, the message sits in a queue until Codex polls for it. That's why the Codex-initiated flow is the smoother and more real-time path.

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

**MCP** works as part of the transport here, but by itself it's request-response. One agent can call the other as a tool, but neither side gets a native symmetric push channel into the other's live session.

**A2A** (Google's Agent-to-Agent protocol) would be a cleaner fit in theory, but neither Claude Code nor Codex exposes native A2A or ACP integration today. Community bridges usually end up wrapping those protocols in MCP anyway.

**Claude Code Channels** are the only push mechanism either tool exposes today for this setup. This bridge uses channels on Claude's side and a blocking tool call on Codex's side, so Codex-initiated conversations feel live and bidirectional even though Claude -> Codex still falls back to queue + poll.

## Known limitations

- Not symmetric full duplex: Codex-initiated turns are real-time, but Claude-initiated messages wait for Codex to poll or make another request.
- Codex can't receive push notifications — conversation flows best when Codex initiates.
- Both agents need to be on the same machine (localhost bridge).
- Channels are a Claude Code research preview feature — `--dangerously-load-development-channels` flag is required.
- Claude sometimes skips `reply_to` — the bridge falls back to resolving the oldest pending request.

## License

MIT
