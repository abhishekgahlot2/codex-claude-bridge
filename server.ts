#!/usr/bin/env bun
/**
 * Codex Bridge — two-way bridge between Claude Code and OpenAI Codex.
 *
 * This is the Claude Code side: runs as a channel plugin (stdio MCP server).
 * Also runs an HTTP server for the web UI and API endpoints that codex-mcp.ts
 * uses to relay messages from Codex.
 *
 * Flow:
 *   Codex → codex-mcp.ts → POST /api/from-codex → channel notification → Claude
 *   Claude → reply tool → stores reply → codex-mcp.ts polls /api/poll-reply → Codex
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { readFileSync, writeFileSync, mkdirSync, statSync, copyFileSync } from 'fs'
import { homedir } from 'os'
import { join, extname, basename } from 'path'
import type { ServerWebSocket } from 'bun'

const PORT = Number(process.env.CODEX_BRIDGE_PORT ?? 8788)
const STATE_DIR = join(homedir(), '.claude', 'channels', 'codex-bridge')
const INBOX_DIR = join(STATE_DIR, 'inbox')
const OUTBOX_DIR = join(STATE_DIR, 'outbox')

// ── Message types ──

type Msg = {
  id: string
  from: 'claude' | 'codex' | 'user'
  text: string
  ts: number
  replyTo?: string
  file?: { url: string; name: string }
}

type Wire =
  | ({ type: 'msg' } & Msg)
  | { type: 'edit'; id: string; text: string }

// ── Pending reply queue: codex sends a message, waits for claude's reply ──

type ReplyWaiter = {
  resolve: (response: Response) => void
  timer: ReturnType<typeof setTimeout>
  cleanup: () => void
}

type PendingReply = {
  createdAt: number
  normalizedMessage?: string
  reply?: string
  waiters: Set<ReplyWaiter>
}

const pendingReplies = new Map<string, PendingReply>()
const inFlightCodexMessages = new Map<string, string>()
const MAX_PENDING_REPLY_MS = 10 * 60 * 1000

function normalizeCodexMessage(message: string) {
  return message.trim().replace(/\s+/g, ' ')
}

function clearInFlightMapping(pending: PendingReply, msgId: string) {
  if (!pending.normalizedMessage) return
  if (inFlightCodexMessages.get(pending.normalizedMessage) === msgId) {
    inFlightCodexMessages.delete(pending.normalizedMessage)
  }
}

function dropPendingReply(msgId: string) {
  const pending = pendingReplies.get(msgId)
  if (!pending) return

  pendingReplies.delete(msgId)
  clearInFlightMapping(pending, msgId)

  for (const waiter of pending.waiters) {
    waiter.cleanup()
  }
  pending.waiters.clear()
}

function removeWaiter(msgId: string, waiter: ReplyWaiter) {
  const pending = pendingReplies.get(msgId)
  if (!pending) {
    waiter.cleanup()
    return
  }
  if (!pending.waiters.delete(waiter)) return
  waiter.cleanup()
}

function pruneExpiredPendingReplies() {
  const now = Date.now()
  for (const [msgId, pending] of pendingReplies) {
    if (now - pending.createdAt <= MAX_PENDING_REPLY_MS) continue
    dropPendingReply(msgId)
  }
}

function drainLateRepliesForCodex() {
  const lateReplies: { id: string; text: string }[] = []
  for (const [msgId, pending] of pendingReplies) {
    if (pending.reply === undefined) continue
    lateReplies.push({ id: msgId, text: pending.reply })
    dropPendingReply(msgId)
  }
  return lateReplies
}

// When Claude replies, route it only to the exact pending Codex request.
// If Claude replies before Codex starts polling, buffer the text and return it
// as soon as the poll request arrives.
function resolveCodexReply(replyToId: string | undefined, text: string) {
  if (!replyToId) return

  const pending = pendingReplies.get(replyToId)
  if (!pending) return

  if (pending.reply !== undefined) return

  pending.reply = text

  if (pending.waiters.size > 0) {
    const waiters = Array.from(pending.waiters)
    dropPendingReply(replyToId)
    for (const waiter of waiters) {
      waiter.resolve(Response.json({ timeout: false, reply: text }))
    }
    return
  }
}

// Pending messages from Claude that Codex hasn't picked up yet
const pendingForCodex: { id: string; text: string }[] = []

// ── WebSocket clients (browser UI) ──

const clients = new Set<ServerWebSocket<unknown>>()
let seq = 0

function nextId(prefix = 'm') {
  return `${prefix}${Date.now()}-${++seq}`
}

function broadcast(m: Wire) {
  const data = JSON.stringify(m)
  for (const ws of clients) if (ws.readyState === 1) ws.send(data)
}

function mime(ext: string) {
  const m: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf', '.txt': 'text/plain',
  }
  return m[ext] ?? 'application/octet-stream'
}

// ── Claude Code MCP channel server ──

const mcp = new Server(
  { name: 'codex-bridge', version: '0.2.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: [
      'You are connected to the Codex Bridge, which relays messages between you (Claude) and OpenAI Codex CLI.',
      'Messages arrive as <channel source="codex-bridge" sender="codex|user" ...>.',
      'When sender="codex", this is Codex talking to you. Respond thoughtfully — you are collaborating with another AI.',
      'When sender="user", this is a human typing in the web UI.',
      'Reply with the reply tool. ALWAYS pass reply_to with the message_id from the incoming channel tag. This is CRITICAL for routing your reply back to Codex.',
      `Web UI: http://localhost:${PORT}`,
    ].join('\n'),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Send a reply through Codex Bridge. If replying to Codex, pass reply_to with the message_id so the response routes back.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          reply_to: { type: 'string', description: 'message_id of the message being replied to' },
          files: { type: 'array', items: { type: 'string' } },
        },
        required: ['text'],
      },
    },
    {
      name: 'edit_message',
      description: 'Edit a previously sent message.',
      inputSchema: {
        type: 'object',
        properties: { message_id: { type: 'string' }, text: { type: 'string' } },
        required: ['message_id', 'text'],
      },
    },
    {
      name: 'send_to_codex',
      description: 'Proactively send a message to Codex without waiting for Codex to ask first. Use this when you want to initiate a conversation or ask Codex something.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Message to send to Codex' },
        },
        required: ['text'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  try {
    switch (req.params.name) {
      case 'reply': {
        const text = args.text as string
        const replyTo = args.reply_to as string | undefined
        const files = (args.files as string[] | undefined) ?? []

        mkdirSync(OUTBOX_DIR, { recursive: true })
        let file: { url: string; name: string } | undefined
        if (files[0]) {
          const f = files[0]
          const st = statSync(f)
          if (st.size > 50 * 1024 * 1024) throw new Error(`file too large: ${f}`)
          const ext = extname(f).toLowerCase()
          const out = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`
          copyFileSync(f, join(OUTBOX_DIR, out))
          file = { url: `/files/${out}`, name: basename(f) }
        }

        const id = nextId('claude-')
        broadcast({ type: 'msg', id, from: 'claude', text, ts: Date.now(), replyTo, file })

        // Resolve pending codex request — tries replyTo first, falls back to oldest pending
        resolveCodexReply(replyTo, text)

        return { content: [{ type: 'text', text: `sent (${id})` }] }
      }

      case 'edit_message': {
        broadcast({ type: 'edit', id: args.message_id as string, text: args.text as string })
        return { content: [{ type: 'text', text: 'ok' }] }
      }

      case 'send_to_codex': {
        const text = args.text as string
        const id = nextId('claude-init-')
        broadcast({ type: 'msg', id, from: 'claude', text, ts: Date.now() })
        pendingForCodex.push({ id, text })
        return { content: [{ type: 'text', text: `sent to codex (${id}) — codex will see it on next poll` }] }
      }

      default:
        return { content: [{ type: 'text', text: `unknown: ${req.params.name}` }], isError: true }
    }
  } catch (err) {
    return { content: [{ type: 'text', text: `${req.params.name}: ${err instanceof Error ? err.message : err}` }], isError: true }
  }
})

await mcp.connect(new StdioServerTransport())

// Push a message into Claude's session via channel notification
async function deliverToClaude(id: string, text: string, sender: string, file?: { path: string; name: string }): Promise<void> {
  await mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: text || `(${file?.name ?? 'attachment'})`,
      meta: {
        chat_id: 'bridge',
        message_id: id,
        sender,
        ts: new Date().toISOString(),
        ...(file ? { file_path: file.path } : {}),
      },
    },
  })
}

// ── HTTP server: web UI + API for codex-mcp.ts ──

Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  fetch(req, server) {
    const url = new URL(req.url)

    // ── WebSocket upgrade ──
    if (url.pathname === '/ws') {
      if (server.upgrade(req)) return
      return new Response('upgrade failed', { status: 400 })
    }

    // ── File serving ──
    if (url.pathname.startsWith('/files/')) {
      const f = url.pathname.slice(7)
      if (f.includes('..') || f.includes('/')) return new Response('bad', { status: 400 })
      try {
        return new Response(readFileSync(join(OUTBOX_DIR, f)), {
          headers: { 'content-type': mime(extname(f).toLowerCase()) },
        })
      } catch {
        return new Response('404', { status: 404 })
      }
    }

    // ── File upload from web UI ──
    if (url.pathname === '/upload' && req.method === 'POST') {
      return (async () => {
        const form = await req.formData()
        const id = String(form.get('id') ?? '')
        const text = String(form.get('text') ?? '')
        const f = form.get('file')
        if (!id) return new Response('missing id', { status: 400 })
        let file: { path: string; name: string } | undefined
        if (f instanceof File && f.size > 0) {
          mkdirSync(INBOX_DIR, { recursive: true })
          const ext = extname(f.name).toLowerCase() || '.bin'
          const path = join(INBOX_DIR, `${Date.now()}${ext}`)
          writeFileSync(path, Buffer.from(await f.arrayBuffer()))
          file = { path, name: f.name }
        }
        await deliverToClaude(id, text, 'user', file)
        return new Response(null, { status: 204 })
      })()
    }

    // ── API: Codex sends a message to Claude ──
    // POST /api/from-codex { message: string }
    // Returns: { id: string } — the message ID to poll for reply
    if (url.pathname === '/api/from-codex' && req.method === 'POST') {
      return (async () => {
        pruneExpiredPendingReplies()
        const body = await req.json() as { message: string }
        const message = body.message?.trim()
        if (!message) return new Response('missing message', { status: 400 })
        const normalizedMessage = normalizeCodexMessage(message)
        const existingId = inFlightCodexMessages.get(normalizedMessage)

        if (existingId && pendingReplies.has(existingId)) {
          return Response.json({ id: existingId })
        }

        if (existingId) {
          inFlightCodexMessages.delete(normalizedMessage)
        }

        const id = nextId('codex-')
        pendingReplies.set(id, {
          createdAt: Date.now(),
          normalizedMessage,
          waiters: new Set(),
        })
        inFlightCodexMessages.set(normalizedMessage, id)

        try {
          // Push to Claude via channel
          await deliverToClaude(id, message, 'codex')
        } catch (err) {
          dropPendingReply(id)
          return new Response(`delivery failed: ${err instanceof Error ? err.message : err}`, { status: 502 })
        }

        // Show in web UI only after delivery succeeds
        broadcast({ type: 'msg', id, from: 'codex', text: message, ts: Date.now() })
        return Response.json({ id })
      })()
    }

    // ── API: Codex polls for Claude's reply (long-poll, up to 120s) ──
    // GET /api/poll-reply/:id
    if (url.pathname.startsWith('/api/poll-reply/') && req.method === 'GET') {
      pruneExpiredPendingReplies()
      const msgId = url.pathname.slice('/api/poll-reply/'.length)
      const timeout = Number(url.searchParams.get('timeout') ?? 120000)
      const pending = pendingReplies.get(msgId)

      if (!pending) {
        return Response.json({ timeout: true, reply: null })
      }

      if (pending.reply !== undefined) {
        const reply = pending.reply
        dropPendingReply(msgId)
        return Response.json({ timeout: false, reply })
      }

      return new Promise<Response>(resolve => {
        let waiter: ReplyWaiter
        const onAbort = () => {
          removeWaiter(msgId, waiter)
          resolve(Response.json({ timeout: true, reply: null }))
        }
        waiter = {
          resolve,
          timer: setTimeout(() => {
            removeWaiter(msgId, waiter)
            resolve(Response.json({ timeout: true, reply: null }))
          }, Math.min(timeout, 300000)),
          cleanup: () => {
            clearTimeout(waiter.timer)
            req.signal.removeEventListener('abort', onAbort)
          },
        }

        req.signal.addEventListener('abort', onAbort, { once: true })
        pending.waiters.add(waiter)
      })
    }

    // ── API: Codex checks for Claude-initiated messages ──
    // GET /api/pending-for-codex
    if (url.pathname === '/api/pending-for-codex' && req.method === 'GET') {
      pruneExpiredPendingReplies()
      const messages = [
        ...pendingForCodex.splice(0),
        ...drainLateRepliesForCodex(),
      ]
      return Response.json({ messages })
    }

    // ── API: health check ──
    if (url.pathname === '/api/health') {
      return Response.json({ status: 'ok', claude: 'connected', port: PORT })
    }

    // ── Web UI ──
    if (url.pathname === '/') {
      return new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }

    return new Response('404', { status: 404 })
  },
  websocket: {
    open: ws => { clients.add(ws) },
    close: ws => { clients.delete(ws) },
    message: (_, raw) => {
      try {
        const { id, text } = JSON.parse(String(raw)) as { id: string; text: string }
        if (id && text?.trim()) {
          void deliverToClaude(id, text.trim(), 'user').catch(err => {
            process.stderr.write(`codex-bridge: websocket delivery failed: ${err instanceof Error ? err.message : err}\n`)
          })
        }
      } catch {}
    },
  },
})

process.stderr.write(`codex-bridge: http://localhost:${PORT}\n`)

// ── Web UI HTML ──

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Codex Bridge</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0a0a0a;
    color: #e0e0e0;
    height: 100vh;
    display: flex;
    flex-direction: column;
  }

  header {
    padding: 14px 20px;
    background: #111;
    border-bottom: 1px solid #222;
    display: flex;
    align-items: center;
    gap: 10px;
  }

  header .logo {
    width: 28px; height: 28px;
    background: linear-gradient(135deg, #00d4aa, #7b61ff);
    border-radius: 6px;
    display: flex; align-items: center; justify-content: center;
    font-weight: 700; font-size: 13px; color: #fff;
  }

  header h1 { font-size: 15px; font-weight: 600; color: #fff; }
  header .subtitle { font-size: 11px; color: #666; margin-left: 4px; }

  header .status {
    margin-left: auto; font-size: 12px; color: #555;
    display: flex; align-items: center; gap: 6px;
  }

  header .status .dot {
    width: 8px; height: 8px; border-radius: 50%; background: #333;
  }
  header .status .dot.connected { background: #00d4aa; }

  #log {
    flex: 1; overflow-y: auto; padding: 20px;
    display: flex; flex-direction: column; gap: 14px;
  }

  .message {
    max-width: 78%; padding: 10px 14px;
    border-radius: 12px; font-size: 14px;
    line-height: 1.5; white-space: pre-wrap; word-break: break-word;
    position: relative;
  }

  .message .label {
    font-size: 10px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.5px; margin-bottom: 4px; opacity: 0.8;
  }

  /* Claude messages — left, purple tint */
  .message.claude {
    align-self: flex-start;
    background: #1a1528;
    border: 1px solid #2d2245;
    border-bottom-left-radius: 4px;
  }
  .message.claude .label { color: #b490ff; }

  /* Codex messages — right, green tint */
  .message.codex {
    align-self: flex-end;
    background: #0d1f1a;
    border: 1px solid #1a3d30;
    border-bottom-right-radius: 4px;
  }
  .message.codex .label { color: #00d4aa; }

  /* User messages — center-left, neutral */
  .message.user {
    align-self: flex-start;
    background: #1a1a1a;
    border: 1px solid #2a2a2a;
    border-bottom-left-radius: 4px;
    margin-left: 40px;
  }
  .message.user .label { color: #888; }

  .message .meta {
    font-size: 11px; opacity: 0.5; margin-top: 4px;
  }

  .message .reply-ref {
    font-size: 12px; opacity: 0.6;
    border-left: 2px solid currentColor;
    padding-left: 8px; margin-bottom: 6px;
  }

  .message a { color: inherit; text-decoration: underline; }
  .message .edited { font-size: 11px; opacity: 0.5; font-style: italic; }

  #input-area {
    padding: 14px 20px;
    background: #111;
    border-top: 1px solid #222;
  }

  #form {
    display: flex; gap: 10px; align-items: flex-end;
  }

  #text {
    flex: 1;
    background: #1a1a1a; border: 1px solid #333; border-radius: 10px;
    color: #e0e0e0; font-family: inherit; font-size: 14px;
    padding: 10px 14px; resize: none; outline: none;
    min-height: 42px; max-height: 120px;
  }

  #text:focus { border-color: #7b61ff; }
  #text::placeholder { color: #555; }

  button {
    background: none; border: none; cursor: pointer;
    color: #888; font-size: 14px; padding: 8px;
    border-radius: 8px; transition: all 0.15s;
  }
  button:hover { background: #222; color: #e0e0e0; }

  button.send {
    background: linear-gradient(135deg, #00d4aa, #7b61ff);
    color: #fff; font-weight: 600;
    padding: 8px 16px; border-radius: 10px;
  }
  button.send:hover { opacity: 0.9; }
  button.send:disabled { opacity: 0.3; cursor: default; }

  #file { display: none; }
  #chip { font-size: 12px; color: #00d4aa; }

  .divider {
    text-align: center; font-size: 11px; color: #333;
    padding: 4px 0; letter-spacing: 1px;
  }

  #log::-webkit-scrollbar { width: 6px; }
  #log::-webkit-scrollbar-track { background: transparent; }
  #log::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }
</style>
</head>
<body>

<header>
  <div class="logo">CB</div>
  <h1>Codex Bridge</h1>
  <span class="subtitle">Claude + Codex</span>
  <div class="status">
    <div class="dot" id="statusDot"></div>
    <span id="statusText">connecting</span>
  </div>
</header>

<div id="log">
  <div class="divider">messages between Claude and Codex appear here</div>
</div>

<div id="input-area">
  <form id="form">
    <button type="button" onclick="file.click()" title="Attach file">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
    </button>
    <input type="file" id="file">
    <span id="chip"></span>
    <textarea id="text" rows="1" placeholder="Inject a message (as human observer)..." autocomplete="off" autofocus></textarea>
    <button type="submit" class="send" id="sendBtn" disabled>Send</button>
  </form>
</div>

<script>
const log = document.getElementById('log')
const form = document.getElementById('form')
const input = document.getElementById('text')
const fileIn = document.getElementById('file')
const chip = document.getElementById('chip')
const sendBtn = document.getElementById('sendBtn')
const statusDot = document.getElementById('statusDot')
const statusText = document.getElementById('statusText')
const msgs = {}

input.addEventListener('input', () => {
  input.style.height = 'auto'
  input.style.height = Math.min(input.scrollHeight, 120) + 'px'
  sendBtn.disabled = !input.value.trim() && !fileIn.files[0]
})

fileIn.onchange = e => {
  const f = e.target.files[0]
  chip.textContent = f ? f.name : ''
  sendBtn.disabled = !input.value.trim() && !f
}

let ws
function connect() {
  ws = new WebSocket('ws://' + location.host + '/ws')
  ws.onopen = () => {
    statusDot.classList.add('connected')
    statusText.textContent = 'bridge active'
  }
  ws.onclose = () => {
    statusDot.classList.remove('connected')
    statusText.textContent = 'reconnecting...'
    setTimeout(connect, 2000)
  }
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.type === 'msg') addMsg(m)
    if (m.type === 'edit') {
      const x = msgs[m.id]
      if (x) {
        x.body.textContent = m.text
        if (!x.edited) {
          const ed = document.createElement('span')
          ed.className = 'edited'
          ed.textContent = ' (edited)'
          x.body.appendChild(ed)
          x.edited = true
        }
      }
    }
  }
}
connect()

let uid = 0
form.onsubmit = e => {
  e.preventDefault()
  const text = input.value.trim()
  const file = fileIn.files[0]
  if (!text && !file) return
  input.value = ''; input.style.height = 'auto'
  fileIn.value = ''; chip.textContent = ''
  sendBtn.disabled = true
  const id = 'u' + Date.now() + '-' + (++uid)
  addMsg({ id, from: 'user', text, file: file ? { url: URL.createObjectURL(file), name: file.name } : undefined })
  if (file) {
    const fd = new FormData(); fd.set('id', id); fd.set('text', text); fd.set('file', file)
    fetch('/upload', { method: 'POST', body: fd })
  } else {
    ws.send(JSON.stringify({ id, text }))
  }
}

function addMsg(m) {
  const div = document.createElement('div')
  div.className = 'message ' + m.from

  if (m.replyTo && msgs[m.replyTo]) {
    const ref = document.createElement('div')
    ref.className = 'reply-ref'
    ref.textContent = (msgs[m.replyTo].body.textContent || '(file)').slice(0, 60)
    div.appendChild(ref)
  }

  const label = document.createElement('div')
  label.className = 'label'
  label.textContent = m.from === 'claude' ? 'Claude' : m.from === 'codex' ? 'Codex' : 'You'
  div.appendChild(label)

  const body = document.createElement('div')
  body.className = 'body'
  body.textContent = m.text || ''
  div.appendChild(body)

  if (m.file) {
    const a = document.createElement('a')
    a.href = m.file.url; a.download = m.file.name; a.textContent = m.file.name
    if (m.text) body.appendChild(document.createTextNode('\\n'))
    body.appendChild(a)
  }

  const meta = document.createElement('div')
  meta.className = 'meta'
  meta.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  div.appendChild(meta)

  log.appendChild(div)
  log.scrollTop = log.scrollHeight
  msgs[m.id] = { body, edited: false }
}

input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit() }
})
</script>
</body>
</html>
`
