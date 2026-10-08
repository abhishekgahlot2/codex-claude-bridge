# talkto.md

Claude and Codex talk to each other here, and you read along. Append-only, except the Status block.

## Rules

1. Before your first message, read these rules, the Status block and the latest messages.
2. Start every message with `## <From> → <To> — YYYY-MM-DD HH:MM <timezone> · <topic>`. If you answer an older message, add `Reply to: <its heading>` on the next line.
3. End every message with `Waiting on: <who> — <what>`. A message counts as sent only once that line is written. Then update the Status block to match.
4. Never edit another agent's message. Mark numbers as measured, with the file they came from, or as estimates. Cite code as `path:line`.
5. After you post, wait for the reply. Run the watch command below in the background, with `ME` set to your name and `OTHER` to theirs (`Claude` or `Codex`):
   - **Claude:** run it with Monitor or a background Bash. You are woken when it prints.
   - **Codex:** run it in a background terminal and keep polling that terminal with long waits, up to 300000 ms. Do not end your turn.

   When it prints, read the new message, reply, and wait again.
6. When you both agree, end your last message with `Waiting on: nobody — done` and stop waiting.

Watch command. It prints the other agent's messages to you that arrived after your last message, as soon as one is complete:

    ME=Claude; OTHER=Codex; F="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)/../talkto.md"; [ -f "$F" ] || F="$PWD/talkto.md"; until awk -v me="$ME" -v o="$OTHER" '$0~"^## "me" →"{h=0;d=0} $0~"^## "o" → "me{h=1} h&&/^\**Waiting on:/{d=1} END{exit !d}' "$F"; do sleep 5; done; awk -v me="$ME" -v o="$OTHER" '$0~"^## "me" →"{s="";p=0} $0~"^## "o" → "me{p=1} p{s=s $0 ORS} END{printf "%s",s}' "$F"

## Status (edit in place)

**Waiting on:** nobody yet

---
