# Codex Bridge

[![Mentioned in Awesome Codex CLI](https://awesome.re/mentioned-badge.svg)](https://github.com/RoggeOhta/awesome-codex-cli)

### Let Claude Code and OpenAI Codex CLI talk to each other. No server.

Two terminals, one shared file, a Stop hook on each side. Both agents keep their normal interactive sessions. You watch the file and can interject.

## How it works

<p align="center"><img src="docs/architecture.svg" alt="Two terminals, one shared file: each side's Stop hook appends its reply to chat.md, waits for the other side's block, and injects it as the next prompt" width="800"></p>

Claude Code and Codex CLI expose the same Stop hook contract. The hook gets the agent's final message as `last_assistant_message` on stdin. If it prints `{"decision":"block","reason":"..."}`, the agent does not stop: the reason becomes its next prompt. `bridge.ts` runs as that hook on both sides:

1. Append `last_assistant_message` to `chat.md` as a block from `claude` or `codex`.
2. Wait until a block from the other side lands after it (`fs.watch`, plus a 2s fallback tick).
3. Print the block decision with that message as the reason. The agent replies, its Stop hook fires, repeat.

<p align="center"><img src="docs/turn-loop.svg" alt="Turn sequence: Claude's turn ends, its hook appends a block, Codex's waiting hook wakes and prints the block decision, Codex replies, its hook appends, Claude's hook wakes" width="800"></p>

A message that starts or ends with `[DONE]` ends the exchange. One that starts or ends with `[WAITING]` is not sent, so an agent can listen without saying anything. Markers in the middle of a sentence are ignored, so an agent can talk about them safely. Conversations are capped at 40 messages.

## What you need

- [Bun](https://bun.sh)
- [Claude Code](https://code.claude.com) 2.1.x or newer (Stop hooks with `last_assistant_message`)
- [Codex CLI](https://github.com/openai/codex) with hooks enabled: `codex features list | grep hooks` should say `stable true` (0.150+)

## Setup

### 1. Clone

```bash
git clone https://github.com/abhishekgahlot2/codex-claude-bridge.git
```

No install step. `bridge.ts` has no dependencies.

### 2. Claude Code hook

Either add this to `~/.claude/settings.json` (or the project's `.claude/settings.json`), or install the repo as a Claude Code plugin, whose `hooks/hooks.json` registers the same hook. Not both, or every message is appended twice.

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun /full/path/to/codex-claude-bridge/bridge.ts claude",
            "timeout": 600
          }
        ]
      }
    ]
  }
}
```

### 3. Codex CLI hook

Create `~/.codex/hooks.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun /full/path/to/codex-claude-bridge/bridge.ts codex",
            "timeout": 600
          }
        ]
      }
    ]
  }
}
```

Then run `/hooks` inside Codex and trust the hook. Codex refuses to run a hook until you do.

If `bun` is not on the PATH the hooks see, use the full path from `which bun`.

## Usage

1. Open the bridge. Until you close it, everything each agent says goes to the other. Each side binds to the first Claude or Codex session whose turn ends after this, so other sessions on the machine are left alone.

   ```bash
   bun bridge.ts start        # creates or empties ~/.codex-bridge/chat.md
   ```

2. In the Codex terminal, start the listener:

   ```
   You are talking to Claude Code through codex-bridge. Reply with just [WAITING] now. Then answer whatever Claude sends and keep the discussion going until you both agree. End your reply with [DONE] when you do.
   ```

3. In the Claude terminal, start the conversation:

   ```
   Discuss whether we should use Redis or Memcached for caching with Codex through codex-bridge. Keep going until you agree. End your reply with [DONE] when you do.
   ```

4. Watch and interject from any shell:

   ```bash
   tail -f ~/.codex-bridge/chat.md
   bun bridge.ts say "Human here: cost matters more than latency."
   ```

5. Close the bridge:

   ```bash
   bun bridge.ts stop
   ```

## File format

```
## codex @ 2026-09-08T10:15:02.113Z
Redis or Memcached?

## claude @ 2026-09-08T10:15:41.902Z
Redis. It has persistence and we already run it. [DONE]
```

| Marker | Meaning |
|--------|---------|
| `## <claude\|codex\|user\|bridge> @ <ISO-8601 UTC>` | Start of a message block. `user` is you (`say`), `bridge` is the cap notice. |
| `[WAITING]` at the start or end of a message | Do not send this message. Listen only. |
| `[DONE]` at the start or end of a message | End the conversation after this message. |

Delivered messages look like `New message via codex-bridge:` followed by `[codex] ...` (or `[user] ...`). Each side keeps `~/.codex-bridge/<side>.json` with the session it is bound to and how many blocks it has been shown, so nothing is dropped while an agent is mid-turn and nothing is shown twice. `start` and `stop` reset it.

## How real-time is it

The waiting hook wakes on `fs.watch`, so a reply is injected within milliseconds of being written. A 2s tick covers a missed event. The model's own turn time dominates everything else. Each side waits up to 570s for a reply (the hook timeout is 600s). If the other side stays silent longer, the agent stops with a `codex-bridge: no reply` note and you prompt it again.

## Limitations

- While a side is waiting, that terminal is inside a hook and you cannot type there. Esc or Ctrl-C abandons the wait.
- Start the listener with `[WAITING]` before the initiator speaks. If the listener greets with words after the initiator already spoke, the initiator gets that greeting as one extra turn before the real exchange starts.
- One conversation per machine (`~/.codex-bridge/chat.md`). Set `CODEX_BRIDGE_DIR` to run another.
- Both agents must be on the same machine.
- Anything appended to `chat.md` becomes a prompt for both agents. Any local process that can write the file can steer them, the same way the v0.1 web UI could.
- Compare with v0.1: the old design could push into an idle Claude session via Channels. Here an idle agent is only woken while its hook is waiting.

## v0.1

The previous design (Claude Channels, a blocking Codex MCP tool, a local web server) is preserved at tag [v0.1.0](https://github.com/abhishekgahlot2/codex-claude-bridge/releases/tag/v0.1.0). It needed a running server and was one-directional in practice: Claude-initiated messages waited until Codex polled.

## Tests

```bash
bun test
```

## License

MIT
