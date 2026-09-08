# Codex Bridge

[![Mentioned in Awesome Codex CLI](https://awesome.re/mentioned-badge.svg)](https://github.com/RoggeOhta/awesome-codex-cli)

### Your live Claude Code and Codex CLI sessions talk to each other. One folder, one markdown file, no server.

You run `claude` in one pane and `codex` in another, in the same folder, each with its own context (say, frontend and backend). Tell either one to discuss something with the other. They exchange messages through `.codex-bridge/chat.md` and both panes show the conversation.

<p align="center"><img src="docs/screenshot.png" alt="Live: Codex (right) opens with @claude and waits in its Stop hook; Claude (left) receives the message through the channel and answers with a comparison table" width="900"></p>

<p align="center"><img src="docs/architecture.svg" alt="Two terminals, one shared file: each side's Stop hook appends its reply to chat.md; Claude's channel and Codex's waiting hook deliver the other side's message as the next prompt" width="800"></p>

## Install

Needs `node` on the PATH of a non-interactive shell.

**Claude Code**

```
/plugin marketplace add abhishekgahlot2/codex-claude-bridge
```
```
/plugin install codex-bridge@codex-claude-bridge
```

Then launch Claude with the channel enabled (Channels are a research preview; the flag is required):

```bash
claude --dangerously-load-development-channels plugin:codex-bridge@codex-claude-bridge
```

**Codex CLI**

```bash
codex plugin marketplace add abhishekgahlot2/codex-claude-bridge
codex plugin add codex-bridge@codex-claude-bridge
```

Run `codex`, open `/hooks`, trust its two hooks.

## Use

In the Codex pane:

```
discuss with claude bridge: redis vs memcached, keep going until you agree
```

Codex opens with `@claude ...`, then shows "Running hooks" while it waits. Claude's pane shows `← codex-bridge: ...` and its answer, Codex wakes with that answer, and they alternate until one ends a message with `[DONE]`. Claude's pane stays free the whole time.

From the Claude pane it is the same with `discuss with codex bridge: ...`, plus one keypress: type anything in the Codex pane once (nothing can push into an idle Codex) and it picks up Claude's message.

Watch the transcript from anywhere:

```bash
tail -f .codex-bridge/chat.md
```

## How it works

`bridge.mjs` does three jobs, all on the folder's `.codex-bridge/chat.md`:

1. **Prompt hook** (both tools). When a prompt mentions "claude bridge" or "codex bridge", or a bridge is open here, it tells the agent: start your reply with `@claude` / `@codex`, use no tool, `[DONE]` ends it.
2. **Stop hook** (both tools). Appends the agent's final reply. A reply starting with `@claude` or `@codex` opens the bridge (or reopens it after `[DONE]`). Then, on Codex, it watches the file (`fs.watch`) until Claude's block lands and returns `{"decision":"block","reason":"<that message>"}`, which becomes Codex's next prompt. On Claude it returns at once, because:
3. **Channel** (Claude only). A dependency-free MCP server the plugin starts inside Claude Code. It watches the file and pushes each new block into the live session, so Claude receives messages while idle. Without the launch flag it stays silent and Claude's Stop hook falls back to waiting like Codex.

Each side keeps a cursor in `.codex-bridge/<side>.json`, so nothing is dropped while an agent is mid-turn and nothing is shown twice. Conversations cap at 40 messages. The folder is gitignored automatically.

## File format

```
## codex @ 2026-09-08T14:15:01.957Z
Let's compare Redis and Memcached.

## claude @ 2026-09-08T14:16:30.079Z
Redis by default. [DONE]
```

| Marker | Meaning |
|--------|---------|
| `## <claude\|codex\|user\|bridge> @ <ISO-8601 UTC>` | Start of a message. `user` is you (`node bridge.mjs say "..."`), `bridge` is the cap notice. |
| `@claude` / `@codex` at the start of a reply | Open the bridge with this message. |
| `[WAITING]` at the start or end of a reply | Do not send this reply. Listen only. |
| `[DONE]` at the start or end of a reply | End the conversation after this reply. |

## Limitations

- Codex's pane is busy while it waits inside its Stop hook (up to 570s per reply). Esc abandons the wait. Typing into Codex during the wait interrupts it.
- Only the final message of a turn is sent. Drafts an agent writes mid-turn are not.
- Both agents must run in the same folder on the same machine.
- Anything appended to `chat.md` becomes a prompt for both agents.
- Claude needs the development-channels flag until custom channels leave preview.

## This vs v0.1

v0.1 was a blocking Codex MCP tool, a Claude channel, and an HTTP server with a web UI.

**Better now**
- No server, no port, no web UI. The markdown file is the transcript; `tail -f` is the viewer.
- Folder-scoped. Other projects and sessions are untouched.
- Nothing for the model to remember. The Stop hook captures the reply; v0.1 lost replies when Claude omitted `reply_to`.
- Claude → Codex works with one keypress. v0.1 queued it until Codex happened to poll.
- A cursor per side: nothing dropped while an agent is mid-turn, nothing shown twice.
- 570s per turn. v0.1 gave Codex 110s.

**Worse now**
- Codex's pane is busy while it waits inside its Stop hook. In v0.1 the wait was an MCP tool call.
- Two hooks to trust in Codex, and per-folder config without the plugins. v0.1 was one global config.
- Everything either agent says while the bridge is open is sent. v0.1 sent only what Codex passed to the tool.
- Typing into Codex mid-wait interrupts the wait.
- Only the final message of a turn is sent.

**Same in both:** Claude needs the channels launch flag, and an idle Codex cannot be pushed.

## Without the plugins

Clone the repo. Put the two hooks from `hooks/hooks.json` into `<folder>/.claude/settings.local.json` and `<folder>/.codex/hooks.json` with the clone path in place of `${CLAUDE_PLUGIN_ROOT}`, and launch Claude with `--dangerously-load-development-channels server:codex-bridge --mcp-config <a file declaring the codex-bridge server: node <clone>/bridge.mjs channel>`.

## Tests

```bash
node --test
```

## Earlier design

[v0.1.0](https://github.com/abhishekgahlot2/codex-claude-bridge/releases/tag/v0.1.0) used a blocking Codex MCP tool, a local HTTP server, and a web UI. One-directional in practice.

## License

MIT
