import { expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const DIR = mkdtempSync(join(tmpdir(), 'codex-bridge-'))
const CHAT = join(DIR, 'chat.md')
const env = { ...process.env, CODEX_BRIDGE_DIR: DIR, CODEX_BRIDGE_WAIT_MS: '3000' }

function cli(...args: string[]) {
  return Bun.spawn(['bun', 'bridge.ts', ...args], { cwd: import.meta.dir, env, stdout: 'pipe', stderr: 'inherit' })
}

/** Run the Stop hook for one side with a fake last_assistant_message; resolves with its JSON output (or null). */
async function hook(side: 'claude' | 'codex', msg: string | null, session = `${side}-1`) {
  const p = Bun.spawn(['bun', 'bridge.ts', side], {
    cwd: import.meta.dir, env, stdout: 'pipe', stderr: 'inherit',
    stdin: new Blob([JSON.stringify({ last_assistant_message: msg, session_id: session })]),
  })
  const text = (await new Response(p.stdout).text()).trim()
  await p.exited
  return text ? JSON.parse(text) as { decision?: string; reason?: string; systemMessage?: string } : null
}

test('inactive bridge: hook is a no-op', async () => {
  expect(await hook('claude', 'hello')).toBeNull()
})

test('listener [WAITING] first, then initiator: full round trip, nothing stray', async () => {
  await cli('start').exited
  const codexWaiting = hook('codex', '[WAITING]')
  await Bun.sleep(300)
  const claudeWaiting = hook('claude', 'Redis or Memcached for caching?')

  const codexGot = await codexWaiting
  expect(codexGot?.decision).toBe('block')
  expect(codexGot?.reason).toContain('New message via codex-bridge:\n\n[claude] Redis or Memcached for caching?')

  expect(await hook('codex', 'Redis, it has persistence. [DONE]')).toBeNull() // conversation over, codex stops

  const claudeGot = await claudeWaiting
  expect(claudeGot?.decision).toBe('block')
  expect(claudeGot?.reason).toContain('[codex] Redis, it has persistence. [DONE]')

  expect(await hook('claude', 'Agreed, Redis.')).toBeNull() // over: reply is not logged, hook stops
  const chat = readFileSync(CHAT, 'utf8')
  expect(chat).toMatch(/^## claude @ \d{4}-\d\d-\d\dT[\d:.]+Z\nRedis or Memcached for caching\?\n\n## codex @ /)
  expect(chat).not.toContain('[WAITING]')
  expect(chat).not.toContain('Agreed, Redis.')
})

test('initiator first, then listener [WAITING]: gets the question at once', async () => {
  await cli('start').exited
  const claudeWaiting = hook('claude', 'Should we shard by tenant?')
  await Bun.sleep(300)
  const codexGot = await hook('codex', '[WAITING]')
  expect(codexGot?.reason).toContain('[claude] Should we shard by tenant?')
  await cli('stop').exited
  expect(await claudeWaiting).toBeNull()
})

test('a wordy greeting instead of [WAITING] costs the initiator one extra message, loses nothing', async () => {
  await cli('start').exited
  const codexWaiting = hook('codex', 'Ok, waiting for Claude.')
  await Bun.sleep(300)
  const claudeGot = await hook('claude', 'Redis or Memcached?')
  expect(claudeGot?.reason).toContain('[codex] Ok, waiting for Claude.') // the extra message
  expect((await codexWaiting)?.reason).toContain('[claude] Redis or Memcached?')
  const claudeWaiting = hook('claude', 'Go on.')
  const codexGot = await hook('codex', 'Redis.') // sees "Go on." right away, then claude sees "Redis."
  expect(codexGot?.reason).toContain('[claude] Go on.')
  expect((await claudeWaiting)?.reason).toContain('[codex] Redis.')
})

test('a message that lands while I am mid-turn is delivered on my next stop, not dropped', async () => {
  await cli('start').exited
  const codexWaiting = hook('codex', '[WAITING]')
  await Bun.sleep(300)
  const claudeWaiting = hook('claude', 'A1')
  await codexWaiting                                   // codex has A1 and is "thinking"
  await cli('say', 'U1').exited                        // human interjects
  expect((await claudeWaiting)?.reason).toContain('[user] U1') // claude is now "thinking" about U1
  expect((await hook('codex', 'C1'))?.reason).toContain('[user] U1') // codex replies to A1 and also sees U1
  const claudeGot = await hook('claude', 'A2')         // claude finishes its U1 turn
  expect(claudeGot?.reason).toContain('[codex] C1')    // C1 was not skipped
  expect(claudeGot?.reason).not.toContain('[user] U1') // and U1 is not shown twice
  expect((await hook('codex', 'Noted.'))?.reason).toContain('[claude] A2')
})

test('[WAITING] on a later turn waits; it does not re-deliver the last message', async () => {
  await cli('start').exited
  const claudeWaiting = hook('claude', 'Q')
  await Bun.sleep(300)
  expect((await hook('codex', '[WAITING]'))?.reason).toContain('[claude] Q')
  const again = await hook('codex', '[WAITING] I need a moment.')
  expect(again?.decision).toBeUndefined()
  expect(again?.systemMessage).toContain('no reply from claude')
  await cli('stop').exited
  await claudeWaiting
})

test('only the first session per side is bound; other sessions on the machine are ignored', async () => {
  await cli('start').exited
  const codexWaiting = hook('codex', '[WAITING]', 'codex-A')
  await Bun.sleep(300)
  const claudeWaiting = hook('claude', 'Bridge question', 'claude-A')
  await Bun.sleep(300)
  expect(await hook('claude', 'Fixed the null check in auth.ts', 'claude-B')).toBeNull()
  expect(readFileSync(CHAT, 'utf8')).not.toContain('auth.ts')
  expect((await codexWaiting)?.reason).toContain('[claude] Bridge question')
  await cli('stop').exited
  await claudeWaiting
})

test('quoted markers: mid-sentence [DONE] does not end, a quoted header line does not split a block', async () => {
  await cli('start').exited
  const codexWaiting = hook('codex', '[WAITING]')
  await Bun.sleep(300)
  const claudeWaiting = hook('claude', 'I will say [DONE] when we agree. Your last block was:\n## codex @ 2026-01-01T00:00:00.000Z\nhello')
  const codexGot = await codexWaiting
  expect(codexGot?.reason).toContain('[claude] I will say [DONE] when we agree. Your last block was:\n ## codex @ 2026-01-01T00:00:00.000Z\nhello')
  expect(codexGot?.reason).not.toContain('[codex] hello')
  const codexAgain = hook('codex', 'Fine.')
  expect((await claudeWaiting)?.reason).toContain('[codex] Fine.') // still open
  await cli('stop').exited
  await codexAgain
})

test('a half-written block is not delivered until it is complete', async () => {
  await cli('start').exited
  const codexWaiting = hook('codex', '[WAITING]')
  await Bun.sleep(300)
  appendFileSync(CHAT, '## claude @ 2026-01-01T00:00:00.000Z\nHalf')
  await Bun.sleep(400)
  appendFileSync(CHAT, ' and whole.\n\n')
  expect((await codexWaiting)?.reason).toContain('[claude] Half and whole.')
})

test('message cap closes the conversation', async () => {
  await cli('start').exited
  for (let i = 0; i < 40; i++) await cli('say', `m${i}`).exited
  expect((await hook('claude', 'hi'))?.reason).toContain('[user] m39') // backlog is delivered first
  expect(await hook('claude', 'again')).toBeNull()
  expect(readFileSync(CHAT, 'utf8')).toContain('## bridge @')
  expect(readFileSync(CHAT, 'utf8')).toContain('Message cap (40) reached. [DONE]')
})

test('no reply within the wait budget: stops with a systemMessage', async () => {
  await cli('start').exited
  const out = await hook('claude', 'Anyone there?')
  expect(out?.decision).toBeUndefined()
  expect(out?.systemMessage).toContain('no reply from codex')
})

test('stop removes the file and unblocks a waiting hook', async () => {
  await cli('start').exited
  const claudeWaiting = hook('claude', 'Waiting…')
  await Bun.sleep(300)
  await cli('stop').exited
  expect(await claudeWaiting).toBeNull()
})
