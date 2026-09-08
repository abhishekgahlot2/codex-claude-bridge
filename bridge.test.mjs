import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'codex-bridge-'))
const CHAT = join(DIR, '.codex-bridge', 'chat.md')
const BRIDGE = new URL('./bridge.mjs', import.meta.url).pathname
const env = { ...process.env, CODEX_BRIDGE_WAIT_MS: '3000' }
delete env.PLUGIN_DATA
const sleep = ms => new Promise(r => setTimeout(r, ms))

function run(args, stdin = '') {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [BRIDGE, ...args], { cwd: DIR, env, stdio: ['pipe', 'pipe', 'inherit'] })
    let out = ''
    p.stdout.on('data', d => { out += d })
    p.on('close', () => resolve(out.trim()))
    p.stdin.end(stdin)
  })
}
const cli = (...args) => run(args)

/** Run the hook for one side with a fake hook payload; resolves with its JSON output (or null). */
async function hook(side, msg, session = `${side}-1`, extra = {}) {
  const out = await run(['hook', side], JSON.stringify({ hook_event_name: 'Stop', cwd: DIR, session_id: session, last_assistant_message: msg, ...extra }))
  return out ? JSON.parse(out) : null
}

test('no bridge in this folder: hook is a no-op', async () => {
  assert.equal(await hook('claude', 'hello'), null)
})

test('listener [WAITING] first, then initiator: full round trip, nothing stray', async () => {
  await cli('start')
  assert.equal(readFileSync(join(DIR, '.codex-bridge', '.gitignore'), 'utf8'), '*\n')
  const codexWaiting = hook('codex', '[WAITING]')
  await sleep(300)
  const claudeWaiting = hook('claude', 'Redis or Memcached for caching?')

  const codexGot = await codexWaiting
  assert.equal(codexGot?.decision, 'block')
  assert.match(codexGot.reason, /New message via codex-bridge:\n\n\[claude\] Redis or Memcached for caching\?/)

  assert.equal(await hook('codex', 'Redis, it has persistence. [DONE]'), null) // conversation over, codex stops

  const claudeGot = await claudeWaiting
  assert.equal(claudeGot?.decision, 'block')
  assert.match(claudeGot.reason, /\[codex\] Redis, it has persistence\. \[DONE\]/)

  assert.equal(await hook('claude', 'Agreed, Redis.'), null) // over: reply is not logged, hook stops
  const chat = readFileSync(CHAT, 'utf8')
  assert.match(chat, /^## claude @ \d{4}-\d\d-\d\dT[\d:.]+Z\nRedis or Memcached for caching\?\n\n## codex @ /)
  assert.ok(!chat.includes('[WAITING]'))
  assert.ok(!chat.includes('Agreed, Redis.'))
})

test('initiator first, then listener [WAITING]: gets the question at once', async () => {
  await cli('start')
  const claudeWaiting = hook('claude', 'Should we shard by tenant?')
  await sleep(300)
  const codexGot = await hook('codex', '[WAITING]')
  assert.match(codexGot.reason, /\[claude\] Should we shard by tenant\?/)
  await cli('stop')
  assert.equal(await claudeWaiting, null)
})

test('a wordy greeting instead of [WAITING] costs the initiator one extra message, loses nothing', async () => {
  await cli('start')
  const codexWaiting = hook('codex', 'Ok, waiting for Claude.')
  await sleep(300)
  const claudeGot = await hook('claude', 'Redis or Memcached?')
  assert.match(claudeGot.reason, /\[codex\] Ok, waiting for Claude\./) // the extra message
  assert.match((await codexWaiting).reason, /\[claude\] Redis or Memcached\?/)
  const claudeWaiting = hook('claude', 'Go on.')
  const codexGot = await hook('codex', 'Redis.') // sees "Go on." right away, then claude sees "Redis."
  assert.match(codexGot.reason, /\[claude\] Go on\./)
  assert.match((await claudeWaiting).reason, /\[codex\] Redis\./)
})

test('a message that lands while I am mid-turn is delivered on my next stop, not dropped', async () => {
  await cli('start')
  const codexWaiting = hook('codex', '[WAITING]')
  await sleep(300)
  const claudeWaiting = hook('claude', 'A1')
  await codexWaiting                                   // codex has A1 and is "thinking"
  await cli('say', 'U1')                               // human interjects
  assert.match((await claudeWaiting).reason, /\[user\] U1/) // claude is now "thinking" about U1
  assert.match((await hook('codex', 'C1')).reason, /\[user\] U1/) // codex replies to A1 and also sees U1
  const claudeGot = await hook('claude', 'A2')         // claude finishes its U1 turn
  assert.match(claudeGot.reason, /\[codex\] C1/)       // C1 was not skipped
  assert.ok(!claudeGot.reason.includes('[user] U1'))   // and U1 is not shown twice
  assert.match((await hook('codex', 'Noted.')).reason, /\[claude\] A2/)
})

test('[WAITING] on a later turn waits; it does not re-deliver the last message', async () => {
  await cli('start')
  const claudeWaiting = hook('claude', 'Q')
  await sleep(300)
  assert.match((await hook('codex', '[WAITING]')).reason, /\[claude\] Q/)
  const again = await hook('codex', '[WAITING] I need a moment.')
  assert.equal(again?.decision, undefined)
  assert.match(again.systemMessage, /no reply from claude/)
  await cli('stop')
  await claudeWaiting
})

test('only the first session per side is bound; other sessions in the folder are ignored', async () => {
  await cli('start')
  const codexWaiting = hook('codex', '[WAITING]', 'codex-A')
  await sleep(300)
  const claudeWaiting = hook('claude', 'Bridge question', 'claude-A')
  await sleep(300)
  assert.equal(await hook('claude', 'Fixed the null check in auth.ts', 'claude-B'), null)
  assert.ok(!readFileSync(CHAT, 'utf8').includes('auth.ts'))
  assert.match((await codexWaiting).reason, /\[claude\] Bridge question/)
  await cli('stop')
  await claudeWaiting
})

test('side is detected from the Codex payload when no side is given', async () => {
  await cli('start')
  const claudeWaiting = hook('claude', 'Who are you?')
  await sleep(300)
  const out = JSON.parse(await run(['hook'], JSON.stringify({ hook_event_name: 'Stop', cwd: DIR, session_id: 'x', turn_id: 't1', last_assistant_message: 'Codex here.' })))
  assert.match(out.reason, /\[claude\] Who are you\?/) // treated as codex: claude's question is delivered to it
  assert.match((await claudeWaiting).reason, /\[codex\] Codex here\./)
  assert.match(readFileSync(CHAT, 'utf8'), /## codex @ [^\n]+\nCodex here\./)
  await cli('stop')
})

test('UserPromptSubmit adds bridge context only while the bridge is open', async () => {
  await cli('stop')
  assert.equal(await run(['hook', 'claude'], JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: DIR, session_id: 'c' })), '')
  await cli('start')
  const out = JSON.parse(await run(['hook', 'claude'], JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: DIR, session_id: 'c' })))
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
  assert.match(out.hookSpecificOutput.additionalContext, /conversation with codex/)
  assert.match(out.hookSpecificOutput.additionalContext, /Do not call any tool/)
  assert.ok(!readFileSync(CHAT, 'utf8').length) // context does not write to the chat
})

test('quoted markers: mid-sentence [DONE] does not end, a quoted header line does not split a block', async () => {
  await cli('start')
  const codexWaiting = hook('codex', '[WAITING]')
  await sleep(300)
  const claudeWaiting = hook('claude', 'I will say [DONE] when we agree. Your last block was:\n## codex @ 2026-01-01T00:00:00.000Z\nhello')
  const codexGot = await codexWaiting
  assert.ok(codexGot.reason.includes('[claude] I will say [DONE] when we agree. Your last block was:\n ## codex @ 2026-01-01T00:00:00.000Z\nhello'))
  assert.ok(!codexGot.reason.includes('[codex] hello'))
  const codexAgain = hook('codex', 'Fine.')
  assert.match((await claudeWaiting).reason, /\[codex\] Fine\./) // still open
  await cli('stop')
  await codexAgain
})

test('a half-written block is not delivered until it is complete', async () => {
  await cli('start')
  const codexWaiting = hook('codex', '[WAITING]')
  await sleep(300)
  appendFileSync(CHAT, '## claude @ 2026-01-01T00:00:00.000Z\nHalf')
  await sleep(400)
  appendFileSync(CHAT, ' and whole.\n\n')
  assert.match((await codexWaiting).reason, /\[claude\] Half and whole\./)
})

test('message cap closes the conversation', async () => {
  await cli('start')
  for (let i = 0; i < 40; i++) await cli('say', `m${i}`)
  assert.match((await hook('claude', 'hi')).reason, /\[user\] m39/) // backlog is delivered first
  assert.equal(await hook('claude', 'again'), null)
  assert.match(readFileSync(CHAT, 'utf8'), /## bridge @ [^\n]+\nMessage cap \(40\) reached\. \[DONE\]/)
})

test('no reply within the wait budget: stops with a systemMessage', async () => {
  await cli('start')
  const out = await hook('claude', 'Anyone there?')
  assert.equal(out?.decision, undefined)
  assert.match(out.systemMessage, /no reply from codex/)
})

test('stop removes the folder and unblocks a waiting hook', async () => {
  await cli('start')
  const claudeWaiting = hook('claude', 'Waiting…')
  await sleep(300)
  await cli('stop')
  assert.equal(await claudeWaiting, null)
  assert.ok(!existsSync(join(DIR, '.codex-bridge')))
})
