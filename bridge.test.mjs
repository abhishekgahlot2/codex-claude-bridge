import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'codex-bridge-'))
const BDIR = join(DIR, '.codex-bridge')
const CHAT = join(BDIR, 'chat.md')
const BRIDGE = new URL('./bridge.mjs', import.meta.url).pathname
const env = { ...process.env, CODEX_BRIDGE_WAIT_MS: '3000' }
delete env.PLUGIN_DATA
delete env.CODEX_BRIDGE_CHANNEL
const sleep = ms => new Promise(r => setTimeout(r, ms))
const chat = () => readFileSync(CHAT, 'utf8')
const reset = () => rmSync(BDIR, { recursive: true, force: true })

function run(args, stdin = '', extraEnv = {}) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [BRIDGE, ...args], { cwd: DIR, env: { ...env, ...extraEnv }, stdio: ['pipe', 'pipe', 'inherit'] })
    let out = ''
    p.stdout.on('data', d => { out += d })
    p.on('close', () => resolve(out.trim()))
    p.stdin.end(stdin)
  })
}

/** Stop hook for one side; resolves with its JSON output (or null). */
async function stop(side, msg, session = `${side}-1`, extra = {}) {
  const out = await run(['hook', side], JSON.stringify({ hook_event_name: 'Stop', cwd: DIR, session_id: session, last_assistant_message: msg, ...extra }))
  return out ? JSON.parse(out) : null
}
/** UserPromptSubmit hook for one side; resolves with additionalContext (or null). */
async function prompt(side, text, session = `${side}-1`) {
  const out = await run(['hook', side], JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: DIR, session_id: session, prompt: text }))
  return out ? JSON.parse(out).hookSpecificOutput.additionalContext : null
}
/** A codex reply that opens the bridge and waits for claude. */
const openWith = (side, msg) => stop(side, `@${side === 'codex' ? 'claude' : 'codex'} ${msg}`)

test('no bridge and no @-address: hooks are no-ops', async () => {
  reset()
  assert.equal(await stop('claude', 'hello'), null)
  assert.equal(await prompt('claude', 'fix the tests'), null)
  assert.ok(!existsSync(BDIR))
})

test('@claude at the start of a Codex reply opens the bridge, strips the prefix, waits for Claude', async () => {
  reset()
  const codexWaiting = openWith('codex', 'Redis or Memcached for caching?')
  await sleep(400)
  assert.equal(chat(), chat().match(/^## codex @ [^\n]+\nRedis or Memcached for caching\?\n\n$/)?.[0])
  assert.equal(readFileSync(join(BDIR, '.gitignore'), 'utf8'), '*\n')
  assert.match(await prompt('claude', 'hi'), /Unread from the bridge:\n\n\[codex\] Redis or Memcached for caching\?/) // idle Claude, no channel: a prompt catches it up
  const claudeWaiting = stop('claude', 'Redis, it has persistence. [DONE]')
  assert.match((await codexWaiting).reason, /New message via codex-bridge:\n\n\[claude\] Redis, it has persistence\. \[DONE\]/)
  assert.equal(await claudeWaiting, null) // conversation over
  assert.equal(await stop('codex', 'Thanks.'), null) // over: not logged
  assert.ok(!chat().includes('Thanks.'))
})

test('a new @-addressed reply after [DONE] starts a fresh conversation', async () => {
  const codexWaiting = openWith('codex', 'Next topic: sharding?')
  await sleep(400)
  assert.match(chat(), /^## codex @ [^\n]+\nNext topic: sharding\?\n\n$/) // old conversation gone
  const claudeWaiting = stop('claude', 'By tenant. [DONE]')
  assert.match((await codexWaiting).reason, /\[claude\] By tenant\./)
  await claudeWaiting
})

test('prompt context: only when the other agent is mentioned or the bridge is open', async () => {
  reset()
  assert.equal(await prompt('codex', 'refactor the parser with claude'), null) // bare name is not a trigger
  const ctx = await prompt('codex', 'Discuss caching with claude bridge')
  assert.match(ctx, /Claude Bridge: .*start your reply with @claude/)
  assert.match(ctx, /Do not use the `claude` CLI or any MCP tool/)
  assert.ok(!existsSync(BDIR)) // context alone does not open anything
  const codexWaiting = openWith('codex', 'Q')
  await sleep(300)
  assert.match(await prompt('claude', 'anything'), /start your reply with @codex/) // open: context regardless of wording
  reset()
  await codexWaiting
})

test('prompt hook hands over unread messages, so a plain prompt to an idle Codex catches it up', async () => {
  reset()
  const claudeWaiting = openWith('claude', 'Should we shard by tenant?')
  await sleep(300)
  const ctx = await prompt('codex', 'go')
  assert.match(ctx, /Unread from the bridge:\n\n\[claude\] Should we shard by tenant\?/)
  const codexWaiting = stop('codex', 'Yes, by tenant.') // seen already advanced: no re-delivery, it waits
  assert.match((await claudeWaiting).reason, /\[codex\] Yes, by tenant\./)
  reset()
  await codexWaiting
})

test('[WAITING] listens without sending; the listener gets the question at once', async () => {
  reset()
  const claudeWaiting = openWith('claude', 'Should we shard by tenant?')
  await sleep(300)
  const codexGot = await stop('codex', '[WAITING]')
  assert.match(codexGot.reason, /\[claude\] Should we shard by tenant\?/)
  assert.ok(!chat().includes('[WAITING]'))
  reset()
  assert.equal(await claudeWaiting, null)
})

test('a message that lands while I am mid-turn is delivered on my next stop, not dropped', async () => {
  reset()
  const claudeWaiting = openWith('claude', 'A1')
  await sleep(300)
  await stop('codex', '[WAITING]')                        // codex has A1 and is "thinking"
  await run(['say', 'U1'])                                // human interjects
  assert.match((await claudeWaiting).reason, /\[user\] U1/) // claude is now "thinking" about U1
  assert.match((await stop('codex', 'C1')).reason, /\[user\] U1/) // codex replies to A1 and also sees U1
  const claudeGot = await stop('claude', 'A2')            // claude finishes its U1 turn
  assert.match(claudeGot.reason, /\[codex\] C1/)          // C1 was not skipped
  assert.ok(!claudeGot.reason.includes('[user] U1'))      // and U1 is not shown twice
  assert.match((await stop('codex', 'Noted.')).reason, /\[claude\] A2/)
})

test('[WAITING] on a later turn waits; it does not re-deliver the last message', async () => {
  reset()
  const claudeWaiting = openWith('claude', 'Q')
  await sleep(300)
  assert.match((await stop('codex', '[WAITING]')).reason, /\[claude\] Q/)
  const again = await stop('codex', '[WAITING] I need a moment.')
  assert.equal(again?.decision, undefined)
  assert.match(again.systemMessage, /no reply from claude/)
  reset()
  await claudeWaiting
})

test('side is detected from the Codex payload when no side is given', async () => {
  reset()
  const claudeWaiting = openWith('claude', 'Who are you?')
  await sleep(300)
  const out = JSON.parse(await run(['hook'], JSON.stringify({ hook_event_name: 'Stop', cwd: DIR, session_id: 'x', turn_id: 't1', last_assistant_message: 'Codex here.' })))
  assert.match(out.reason, /\[claude\] Who are you\?/)
  assert.match((await claudeWaiting).reason, /\[codex\] Codex here\./)
  assert.match(chat(), /## codex @ [^\n]+\nCodex here\./)
})

test('quoted markers: mid-sentence [DONE] does not end, a quoted header line does not split a block', async () => {
  reset()
  const codexWaiting = openWith('codex', 'I will say [DONE] when we agree. Your last block was:\n## codex @ 2026-01-01T00:00:00.000Z\nhello')
  await sleep(300)
  const claudeGot = await stop('claude', '[WAITING]')
  assert.ok(claudeGot.reason.includes('[codex] I will say [DONE] when we agree. Your last block was:\n ## codex @ 2026-01-01T00:00:00.000Z\nhello'))
  assert.ok(!claudeGot.reason.includes('[codex] hello'))
  const claudeWaiting = stop('claude', 'Fine.')
  assert.match((await codexWaiting).reason, /\[claude\] Fine\./) // still open
  reset()
  await claudeWaiting
})

test('a half-written block is not delivered until it is complete', async () => {
  reset()
  const codexWaiting = openWith('codex', 'Q')
  await sleep(300)
  appendFileSync(CHAT, '## claude @ 2026-01-01T00:00:00.000Z\nHalf')
  await sleep(400)
  appendFileSync(CHAT, ' and whole.\n\n')
  assert.match((await codexWaiting).reason, /\[claude\] Half and whole\./)
})

test('message cap closes the conversation', async () => {
  reset()
  mkdirSync(BDIR, { recursive: true }); writeFileSync(CHAT, '')
  for (let i = 0; i < 40; i++) await run(['say', `m${i}`])
  assert.match((await stop('claude', 'hi')).reason, /\[user\] m39/) // backlog is delivered first
  assert.equal(await stop('claude', 'again'), null)
  assert.match(chat(), /## bridge @ [^\n]+\nMessage cap \(40\) reached\. \[DONE\]/)
})

test('no reply within the wait budget: stops with a systemMessage', async () => {
  reset()
  const out = await openWith('claude', 'Anyone there?')
  assert.equal(out?.decision, undefined)
  assert.match(out.systemMessage, /no reply from codex/)
})

test('removing the folder unblocks a waiting hook', async () => {
  reset()
  const claudeWaiting = openWith('claude', 'Waiting…')
  await sleep(300)
  reset()
  assert.equal(await claudeWaiting, null)
})

test('Claude Stop hook does not wait while a live channel owns delivery', async () => {
  reset()
  const codexWaiting = openWith('codex', 'Q')
  await sleep(300)
  writeFileSync(join(BDIR, 'claude.channel'), String(process.pid)) // a live channel
  const t = Date.now()
  assert.equal(await stop('claude', 'A'), null)
  assert.ok(Date.now() - t < 1500, 'returned without waiting')
  assert.match((await codexWaiting).reason, /\[claude\] A/)
  reset()
})

test('Claude Stop hook that opens the bridge returns once the channel claims the folder a moment later', async () => {
  reset()
  const t0 = Date.now()
  const claudeStop = stop('claude', '@codex Redis or Memcached?')
  await sleep(700)
  writeFileSync(join(BDIR, 'claude.channel'), String(process.pid)) // channel claims the new bridge
  assert.equal(await claudeStop, null)
  assert.ok(Date.now() - t0 < 2500, 'returned as soon as the channel appeared')
  assert.match(chat(), /## claude @ [^\n]+\nRedis or Memcached\?/)
  reset()
})

test('channel: MCP handshake, then pushes new Codex blocks as notifications and advances seen', async () => {
  reset()
  mkdirSync(BDIR, { recursive: true }); writeFileSync(CHAT, '')
  const p = spawn(process.execPath, [BRIDGE, 'channel'], { cwd: DIR, env: { ...env, CODEX_BRIDGE_CHANNEL: '1' }, stdio: ['pipe', 'pipe', 'inherit'] })
  const lines = []
  let buf = ''
  p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1) } })
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } }) + '\n')
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  await sleep(400)
  const init = lines.find(l => l.id === 1)
  assert.deepEqual(init.result.capabilities, { experimental: { 'claude/channel': {} } })
  assert.match(init.result.instructions, /Never call a tool/)
  await sleep(700)
  assert.equal(readFileSync(join(BDIR, 'claude.channel'), 'utf8'), String(p.pid)) // claimed delivery
  await run(['say', 'ping from user'])
  await stop('codex', 'ping from codex', 'codex-1', {}) // appends and waits; we do not await it here
  await sleep(1200)
  const pushed = lines.filter(l => l.method === 'notifications/claude/channel')
  assert.deepEqual(pushed.map(n => [n.params.meta.sender, n.params.content]), [['user', 'ping from user'], ['codex', 'ping from codex']])
  assert.equal(JSON.parse(readFileSync(join(BDIR, 'claude.json'), 'utf8')).seen, 2)
  p.stdin.end()
  await new Promise(r => p.on('exit', r))
  assert.ok(!existsSync(join(BDIR, 'claude.channel'))) // marker released on exit
  reset()
})

test('channel: stays silent when Claude Code was not started with the channel enabled', async () => {
  reset()
  mkdirSync(BDIR, { recursive: true }); writeFileSync(CHAT, '')
  const p = spawn(process.execPath, [BRIDGE, 'channel'], { cwd: DIR, env, stdio: ['pipe', 'pipe', 'inherit'] })
  let out = ''
  p.stdout.on('data', d => { out += d })
  await run(['say', 'hello'])
  await sleep(1200)
  p.stdin.end()
  await new Promise(r => p.on('exit', r))
  assert.equal(out, '')
  assert.ok(!existsSync(join(BDIR, 'claude.channel')))
  reset()
})
