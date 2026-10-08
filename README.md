# Codex Bridge

[![Mentioned in Awesome Codex CLI](https://awesome.re/mentioned-badge.svg)](https://github.com/RoggeOhta/awesome-codex-cli)

**Claude Code and Codex CLI talk to each other through one markdown file in your project.**
No server, no hooks, no plugin. You read along.

![Claude Code and Codex CLI take turns appending messages to talkto.md. After posting, each agent runs a watch command that wakes it when the other agent's reply is complete.](docs/architecture.svg)

## Quick start

1. Add `talkto.md` to your project root:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/abhishekgahlot2/codex-claude-bridge/main/talkto.md -o talkto.md
   ```

2. Open `claude` and `codex` in that project, or in any of its git worktrees.

3. Tell one of them what to discuss:

   ```text
   discuss redis vs memcached with codex via talkto.md, keep going until you agree
   ```

4. Tell the other one `check talkto.md`. From then on they keep going on their own.

## How it works

The rules sit at the top of `talkto.md`, so each agent learns the protocol by reading the file. There is nothing to install.

1. An agent appends a message that ends with `Waiting on: <who> — <what>`.
2. It runs the watch command from the file in the background.
   - **Claude Code** runs it with Monitor and is woken when it prints.
   - **Codex CLI** runs it in a background terminal and keeps polling, so its turn stays open.
3. The watch exits when a complete message addressed to that agent appears. The agent reads it, replies, and waits again.
4. `Waiting on: nobody — done` ends the conversation.

The watch compares against the agent's own last message, not a line count. A reply that lands before the watch starts is still caught, and a half-written one waits until its `Waiting on:` line exists. Every git worktree resolves to the main checkout's `talkto.md`.

## Message format

```markdown
## Codex → Claude — 2026-10-08 15:55 IST · round 1
Redis by default. Memcached only for a huge, multi-threaded cache of small blobs.

Waiting on: Claude — counterpoint or agreement

## Claude → Codex — 2026-10-08 15:57 IST · round 2
Reply to: Codex → Claude — 2026-10-08 15:55 IST · round 1
Agreed. Confirm in one line and close.

Waiting on: Codex — confirm and close
```

| Part | Rule |
| --- | --- |
| Heading | `## <From> → <To> — <date time zone> · <topic>`. The watch looks for the arrow. |
| `Reply to:` | Optional. The heading you are answering. |
| Last line | `Waiting on: <who> — <what>`. Hands over the turn. A message counts as sent only once this line exists. |
| Status | One block at the top of the file, edited in place: whose turn it is. |
| Append-only | Nobody edits another agent's message. |

## Optional: skip naming the file

Add one line to `AGENTS.md`, which Codex reads, and to `CLAUDE.md`, which Claude reads:

```markdown
To talk to the other agent (Claude or Codex), use talkto.md at the repo root and follow the rules at its top.
```

Then `discuss this with codex` is enough.

## Limits

- An agent waits only while its turn is running. If Esc, an error or a usage limit cuts a turn short, say `check talkto.md`.
- Both agents must run on the same machine.
- Anything appended to `talkto.md` reaches both agents as a message.
- Agents read only the latest messages, but a long file still costs context. Start a fresh file when a topic is done.

## Tested

| Test | Result |
| --- | --- |
| Codex CLI 0.161, live | From one plain prompt: posted, ran the watch in a background terminal, waited through a 100-second gap, and replied 39 seconds after Claude wrote. Checked 6 times, 30 to 50 seconds each. |
| Claude Code with Sonnet 5, live | From one plain prompt: posted, ran the watch with Monitor, and replied 59 and then 10 seconds after each Codex message, the second of which came 90 seconds later. Closed with `Waiting on: nobody — done`. |
| Watch command, bash and zsh | Reply before the watch starts, half-written reply, bold `**Waiting on:**` line, message to someone else (ignored), worktree subfolder, repo subfolder, folder outside git. |

## Why not A2A or MCP

There is no standard for agents sharing a conversation file. A2A is a JSON-RPC protocol between agent servers, and neither CLI speaks it. MCP gives one agent tools, not a conversation with another live session. A markdown file needs nothing from either CLI: you can read it, and both agents read and write it with tools they already have.

## Versions

| Version | Design |
| --- | --- |
| **v0.3.0** | One markdown file. The rules and the watch command live in the file. |
| [v0.2.0](https://github.com/abhishekgahlot2/codex-claude-bridge/releases/tag/v0.2.0) | Markdown file, Stop hooks, and a Claude channel. Codex waited inside its Stop hook. |
| [v0.1.0](https://github.com/abhishekgahlot2/codex-claude-bridge/releases/tag/v0.1.0) | Blocking Codex MCP tool, Claude channel, and an HTTP server with a web UI. |

## License

MIT
