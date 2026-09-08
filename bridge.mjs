#!/usr/bin/env node
/**
 * Codex Bridge — Claude Code <-> Codex CLI over one shared file, driven by hooks. No server.
 *
 * Hooks (both tools, one command):  node bridge.mjs hook            (Stop + UserPromptSubmit)
 * Human:                            node bridge.mjs start | stop | say <text>
 *
 * Scope: the folder the agents run in. The chat lives in ./.codex-bridge/chat.md of that
 * folder, so sessions in other folders are untouched. One block per message:
 *
 *   ## codex @ 2026-09-08T10:15:02.113Z
 *   text...
 *
 * On Stop, the hook appends the agent's final message, then waits until a block from the
 * other side lands and prints {"decision":"block","reason":...}, which the agent receives
 * as its next prompt. On UserPromptSubmit it tells the agent the bridge is active and that
 * no tool is needed. A message that starts or ends with [WAITING] is not sent (listen only);
 * one that starts or ends with [DONE] ends the exchange.
 *
 * Per-side state in ./.codex-bridge/<side>.json: the session bound to this side and how
 * many blocks it has been shown, so nothing is dropped or delivered twice.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const WAIT_MS = Number(process.env.CODEX_BRIDGE_WAIT_MS ?? 570_000) // stay under the 600s hook timeout
const MAX_MSGS = 40
const MARK = /^## (claude|codex|user|bridge) @ \d{4}-\d\d-\d\dT[\d:.]+Z$/
const SIDES = ['claude', 'codex']

let DIR, CHAT
function setDir(cwd) {
  DIR = join(cwd, '.codex-bridge')
  CHAT = join(DIR, 'chat.md')
}

/** Blocks in the file, or null while another writer's block is still landing (every complete block ends with a blank line). */
function parse() {
  const raw = readFileSync(CHAT, 'utf8')
  if (raw && !raw.endsWith('\n\n')) return null // ponytail: a chunk boundary right after a blank line would still slip through
  const blocks = []
  for (const line of raw.split('\n')) {
    const m = MARK.exec(line)
    if (m) blocks.push({ from: m[1], head: line, text: '' })
    else if (blocks.length) blocks.at(-1).text += line + '\n'
  }
  for (const b of blocks) b.text = b.text.trim()
  return blocks
}

function append(from, text) {
  if (!existsSync(join(DIR, '.gitignore'))) writeFileSync(join(DIR, '.gitignore'), '*\n') // keep the chat out of the repo
  // A quoted header line inside a message must not start a new block: indent it so it no longer matches MARK.
  const body = text.trim().replace(/^(?=## (?:claude|codex|user|bridge) @ )/gm, ' ')
  appendFileSync(CHAT, `## ${from} @ ${new Date().toISOString()}\n${body}\n\n`)
}

// Markers count only at the start or end of a message, so "I'll say [DONE] later" does not end it.
const tagged = (text, tag) => text.startsWith(tag) || text.endsWith(tag)
const done = all => all.some(b => tagged(b.text, '[DONE]'))
const fmt = b => `[${b.from}] ${b.text}`

const stateFile = me => join(DIR, `${me}.json`)
function loadState(me, first) {
  let s = { first: '', session: '', seen: 0 } // conversation key, bound session, blocks shown
  try { s = JSON.parse(readFileSync(stateFile(me), 'utf8')) } catch {}
  if (s.first && s.first !== first) s = { first: '', session: '', seen: 0 } // a different conversation: forget the old one
  s.first = first
  return s
}
const saveState = (me, s) => writeFileSync(stateFile(me), JSON.stringify(s))

function changed() {
  // wake on file change; 2s fallback tick in case an event is missed
  return new Promise(resolve => {
    let w
    const finish = () => { w?.close(); clearTimeout(t); resolve() }
    const t = setTimeout(finish, 2000)
    try { w = watch(CHAT, finish) } catch { finish() }
  })
}

function side(arg, input) {
  if (SIDES.includes(arg)) return arg
  // Codex sets PLUGIN_DATA for plugin hooks and puts turn_id in hook input; Claude Code does neither.
  return process.env.PLUGIN_DATA || 'turn_id' in input ? 'codex' : 'claude'
}

const context = (me, other) =>
  `codex-bridge is active in this folder (.codex-bridge/chat.md): you are in a conversation with ${other}. ` +
  `Do not call any tool, MCP server, or CLI to send messages. Whatever you write as your reply is appended to the chat ` +
  `and delivered to ${other} by a Stop hook, and ${other}'s reply arrives as your next prompt. ` +
  `Reply with just [WAITING] to listen without sending anything. End your reply with [DONE] when the conversation should end.`

async function hook(arg) {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}')
  setDir(input.cwd ?? process.cwd())
  if (!existsSync(CHAT)) return // no bridge in this folder: normal turn, do nothing
  const me = side(arg, input)
  const other = me === 'claude' ? 'codex' : 'claude'

  let all = parse() ?? []
  const state = loadState(me, all[0]?.head ?? '')
  // Bind this side to the first session that runs a hook here after the bridge opens; other sessions are ignored.
  const session = input.session_id ?? ''
  if (state.session && session && state.session !== session) return
  state.session ||= session
  saveState(me, state)

  if (input.hook_event_name === 'UserPromptSubmit') {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context(me, other) } }))
    return
  }

  const unread = () => all.slice(state.seen).filter(b => b.from !== me)
  if (done(all) && !unread().length) return // conversation over: later chatter is not logged
  const mine = input.last_assistant_message?.trim()
  if (mine && !tagged(mine, '[WAITING]')) append(me, mine)

  const deadline = Date.now() + WAIT_MS
  while (existsSync(CHAT)) {
    let parsed
    try { parsed = parse() } catch { return } // removed mid-wait
    if (parsed) {
      all = parsed
      const fresh = unread()
      if (fresh.length) {
        state.seen = all.length
        saveState(me, state)
        const reason =
          `New message${fresh.length > 1 ? 's' : ''} via codex-bridge:\n\n${fresh.map(fmt).join('\n\n')}` +
          `\n\n(Reply as usual; your reply is delivered to ${other} automatically. End your message with [DONE] when the conversation should end.)`
        console.log(JSON.stringify({ decision: 'block', reason }))
        return
      }
      if (done(all)) return
      if (all.length >= MAX_MSGS) {
        append('bridge', `Message cap (${MAX_MSGS}) reached. [DONE]`)
        return
      }
    }
    if (Date.now() > deadline) {
      console.log(JSON.stringify({ systemMessage: `codex-bridge: no reply from ${other} in ${WAIT_MS / 1000}s` }))
      return
    }
    await changed()
  }
}

const [cmd, ...rest] = process.argv.slice(2)
if (cmd !== 'hook') setDir(process.cwd())
switch (cmd) {
  case 'hook':
    await hook(rest[0])
    break
  case 'start':
    mkdirSync(DIR, { recursive: true })
    writeFileSync(CHAT, '')
    writeFileSync(join(DIR, '.gitignore'), '*\n')
    for (const s of SIDES) rmSync(stateFile(s), { force: true })
    console.log(`bridge open: ${CHAT}`)
    break
  case 'stop':
    rmSync(DIR, { recursive: true, force: true })
    console.log('bridge closed')
    break
  case 'say':
    if (!existsSync(CHAT) || !rest.join(' ').trim()) {
      console.error('usage: bridge.mjs say <text>   (run `bridge.mjs start` in this folder first)')
      process.exit(1)
    }
    append('user', rest.join(' '))
    break
  default:
    console.error('usage: bridge.mjs hook [claude|codex]  |  bridge.mjs start|stop|say <text>')
    process.exit(1)
}
