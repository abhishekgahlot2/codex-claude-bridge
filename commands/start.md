---
description: Open the codex-bridge chat in this folder so Claude and Codex can talk
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bridge.mjs" start`

The bridge is open in this folder. From now on each of your replies is delivered to Codex by a Stop hook and Codex's replies arrive as your next prompt; do not call any tool to send messages. Tell the user, in two lines: start `codex` in this same folder and give it the prompt "Reply with just [WAITING]." Then ask what topic to open with Codex, unless the user already gave one, in which case start the conversation now. End your reply with [DONE] when the conversation should end.
