#!/usr/bin/env bun
/**
 * Codex Bridge v0.2 — Claude Code <-> Codex CLI over one shared file, driven by Stop hooks.
 *
 * Hook (both sides):  bun bridge.ts claude   |   bun bridge.ts codex
 * Human:              bun bridge.ts start | stop | say <text>
 *
 * Protocol: ~/.codex-bridge/chat.md, append-only. One block per message:
 *
 *   ## codex @ 2026-09-08T10:15:02.113Z
 *   text...
 *
 * Each agent's Stop hook appends the agent's final message, then waits until a block
 * from the other side lands and prints {"decision":"block","reason":...}, which the
 * agent receives as its next prompt. A message that starts or ends with [WAITING] is
 * not sent (listen only); one that starts or ends with [DONE] ends the exchange.
 *
 * Per-side state in ~/.codex-bridge/<side>.json: the session bound to this side and
 * how many blocks it has been shown, so nothing is dropped or delivered twice.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const DIR = process.env.CODEX_BRIDGE_DIR ?? join(homedir(), '.codex-bridge')
const CHAT = join(DIR, 'chat.md')
const WAIT_MS = Number(process.env.CODEX_BRIDGE_WAIT_MS ?? 570_000) // stay under the 600s hook timeout
const MAX_MSGS = 40
const MARK = /^## (claude|codex|user|bridge) @ \d{4}-\d\d-\d\dT[\d:.]+Z$/

type Side = 'claude' | 'codex'
type Block = { from: string; head: string; text: string }
type State = { first: string; session: string; seen: number } // conversation key, bound session, blocks shown

/** Blocks in the file, or null while another writer's block is still landing (every complete block ends with a blank line). */
function parse(): Block[] | null {
  const raw = readFileSync(CHAT, 'utf8')
  if (raw && !raw.endsWith('\n\n')) return null // ponytail: a chunk boundary right after a blank line would still slip through
  const blocks: Block[] = []
  for (const line of raw.split('\n')) {
    const m = MARK.exec(line)
    if (m) blocks.push({ from: m[1], head: line, text: '' })
    else if (blocks.length) blocks.at(-1)!.text += line + '\n'
  }
  for (const b of blocks) b.text = b.text.trim()
  return blocks
}

function append(from: string, text: string) {
  // A quoted header line inside a message must not start a new block: indent it so it no longer matches MARK.
  const body = text.trim().replace(/^(?=## (?:claude|codex|user|bridge) @ )/gm, ' ')
  appendFileSync(CHAT, `## ${from} @ ${new Date().toISOString()}\n${body}\n\n`)
}

// Markers count only at the start or end of a message, so "I'll say [DONE] later" does not end it.
const tagged = (text: string, tag: string) => text.startsWith(tag) || text.endsWith(tag)
const done = (all: Block[]) => all.some(b => tagged(b.text, '[DONE]'))
const fmt = (b: Block) => `[${b.from}] ${b.text}`

const stateFile = (me: Side) => join(DIR, `${me}.json`)
function loadState(me: Side, first: string): State {
  let s: State = { first: '', session: '', seen: 0 }
  try { s = JSON.parse(readFileSync(stateFile(me), 'utf8')) } catch {}
  if (s.first && s.first !== first) s = { first: '', session: '', seen: 0 } // a different conversation: forget the old one
  s.first = first
  return s
}
const saveState = (me: Side, s: State) => writeFileSync(stateFile(me), JSON.stringify(s))

async function changed() {
  // wake on file change; 2s fallback tick in case an event is missed
  const { promise, resolve } = Promise.withResolvers<void>()
  let w: ReturnType<typeof watch> | undefined
  try { w = watch(CHAT, () => resolve()) } catch { resolve() }
  const t = setTimeout(resolve, 2000)
  await promise
  w?.close()
  clearTimeout(t)
}

async function hook(me: Side) {
  if (!existsSync(CHAT)) return // bridge not active: normal turn, do nothing
  const other = me === 'claude' ? 'codex' : 'claude'
  const input = JSON.parse((await Bun.stdin.text()) || '{}') as { last_assistant_message?: string | null; session_id?: string }

  let all = parse() ?? []
  const state = loadState(me, all[0]?.head ?? '')
  // Bind this side to the first session whose hook runs after `start`; other sessions on the machine are ignored.
  const session = input.session_id ?? ''
  if (state.session && session && state.session !== session) return
  state.session ||= session
  const unread = () => all.slice(state.seen).filter(b => b.from !== me)

  if (done(all) && !unread().length) return // conversation over: later chatter is not logged
  const mine = input.last_assistant_message?.trim()
  if (mine && !tagged(mine, '[WAITING]')) append(me, mine)
  saveState(me, state)

  const deadline = Date.now() + WAIT_MS
  while (existsSync(CHAT)) {
    let parsed: Block[] | null
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

const clearState = () => { for (const s of ['claude', 'codex'] as const) rmSync(stateFile(s), { force: true }) }

const [cmd, ...rest] = process.argv.slice(2)
switch (cmd) {
  case 'claude':
  case 'codex':
    await hook(cmd)
    break
  case 'start':
    mkdirSync(DIR, { recursive: true })
    writeFileSync(CHAT, '')
    clearState()
    console.log(`bridge active: ${CHAT}`)
    break
  case 'stop':
    rmSync(CHAT, { force: true })
    clearState()
    console.log('bridge stopped')
    break
  case 'say':
    if (!existsSync(CHAT) || !rest.join(' ').trim()) {
      console.error('usage: bridge.ts say <text>   (run `bridge.ts start` first)')
      process.exit(1)
    }
    append('user', rest.join(' '))
    break
  default:
    console.error('usage: bridge.ts claude|codex (as a Stop hook)  |  bridge.ts start|stop|say <text>')
    process.exit(1)
}
