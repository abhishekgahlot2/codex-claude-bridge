#!/usr/bin/env bun
/**
 * Codex Bridge — MCP server for the Codex CLI side.
 *
 * This runs as an MCP server that Codex CLI connects to.
 * It exposes tools that let Codex talk to Claude through the bridge.
 *
 * Add to Codex's config.toml:
 *   [mcp_servers.codex-bridge]
 *   command = "bun"
 *   args = ["/path/to/codex-bridge/codex-mcp.ts"]
 *
 * Tools:
 *   send_to_claude(message) — Send a message to Claude. Blocks until Claude replies (up to about 2 min).
 *   check_claude_messages() — Check if Claude has sent any messages proactively.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const BRIDGE_URL = process.env.CODEX_BRIDGE_URL ?? 'http://localhost:8788'
const TOTAL_WAIT_MS = 110000
const POLL_SLICE_MS = 15000
const POLL_ABORT_GRACE_MS = 3000
type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

const inFlightMessages = new Map<string, Promise<ToolResult>>()

function normalizeMessage(message: string) {
  return message.trim().replace(/\s+/g, ' ')
}

function formatElapsedMs(startMs: number) {
  const seconds = Math.round((Date.now() - startMs) / 1000)
  return `${seconds}s`
}

const mcp = new Server(
  { name: 'codex-bridge-client', version: '0.2.0' },
  {
    capabilities: { tools: {} },
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'send_to_claude',
      description: [
        'Send a message to Claude Code through the Codex Bridge and wait for a reply.',
        'This tool blocks until Claude responds (up to about 2 minutes).',
        'Use this to collaborate with Claude: ask questions, propose approaches,',
        'debate architecture decisions, or reach consensus on implementation details.',
        'Claude has access to its own codebase tools (file reading, editing, search, terminal).',
        '',
        'IMPORTANT: This is a conversation tool. If Claude replies with a question,',
        'a counter-proposal, or if consensus has not been reached, call this tool AGAIN',
        'to continue the discussion. Keep calling it until you and Claude have reached',
        'agreement or fully resolved the topic. Do not stop after a single exchange.',
        'Do not call this tool concurrently with the same message.',
        'If it times out or errors, do not immediately resend the exact same prompt.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'The message to send to Claude',
          },
        },
        required: ['message'],
      },
    },
    {
      name: 'check_claude_messages',
      description: [
        'Check if Claude has sent any proactive messages.',
        'Returns any pending messages from Claude that you haven\'t seen yet.',
        'Call this periodically if you want to see if Claude has initiated a conversation.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>

  try {
    switch (req.params.name) {
      case 'send_to_claude': {
        const message = args.message as string
        if (!message?.trim()) {
          return { content: [{ type: 'text', text: 'error: empty message' }], isError: true }
        }

        const normalizedMessage = normalizeMessage(message)
        const existing = inFlightMessages.get(normalizedMessage)
        if (existing) {
          return await existing
        }

        const requestPromise: Promise<ToolResult> = (async () => {
          const startedAt = Date.now()

          // Step 1: Send message to bridge
          const sendRes = await fetch(`${BRIDGE_URL}/api/from-codex`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ message: message.trim() }),
          })

          if (!sendRes.ok) {
            const err = await sendRes.text()
            return {
              content: [{ type: 'text', text: `error sending to bridge: ${sendRes.status} ${err}` }],
              isError: true,
            }
          }

          const { id } = await sendRes.json() as { id: string }

          // Step 2: Poll in short slices so hidden 20-60s transport limits
          // do not kill the overall wait budget.
          while (Date.now() - startedAt < TOTAL_WAIT_MS) {
            const remainingMs = TOTAL_WAIT_MS - (Date.now() - startedAt)
            const pollTimeoutMs = Math.min(POLL_SLICE_MS, remainingMs)
            const controller = new AbortController()
            const clientTimeout = setTimeout(() => controller.abort(), pollTimeoutMs + POLL_ABORT_GRACE_MS)
            let pollRes: Response

            try {
              pollRes = await fetch(`${BRIDGE_URL}/api/poll-reply/${id}?timeout=${pollTimeoutMs}`, {
                signal: controller.signal,
              })
            } catch (e: unknown) {
              clearTimeout(clientTimeout)
              const msg = e instanceof Error ? e.message : String(e)
              if (msg.includes('abort') || msg.includes('socket')) {
                continue
              }
              throw e
            }
            clearTimeout(clientTimeout)

            if (!pollRes.ok) {
              const errText = await pollRes.text()
              return {
                content: [{ type: 'text', text: `error polling reply: ${pollRes.status} ${errText}` }],
                isError: true,
              }
            }

            const result = await pollRes.json() as { timeout: boolean; reply: string | null }

            if (result.reply) {
              return {
                content: [{ type: 'text', text: result.reply }],
              }
            }

            if (!result.timeout) {
              return {
                content: [{
                  type: 'text',
                  text: `Claude returned no reply after ${formatElapsedMs(startedAt)}. The same request may still be in flight. Do not immediately resend the exact same prompt.`,
                }],
              }
            }
          }

          return {
            content: [{
              type: 'text',
              text: `Claude did not reply within ${formatElapsedMs(startedAt)}. The same request may still be in flight. Do not immediately resend the exact same prompt.`,
            }],
          }
        })()

        inFlightMessages.set(normalizedMessage, requestPromise)
        try {
          return await requestPromise
        } finally {
          if (inFlightMessages.get(normalizedMessage) === requestPromise) {
            inFlightMessages.delete(normalizedMessage)
          }
        }
      }

      case 'check_claude_messages': {
        const res = await fetch(`${BRIDGE_URL}/api/pending-for-codex`)

        if (!res.ok) {
          return {
            content: [{ type: 'text', text: `error checking messages: ${res.status}` }],
            isError: true,
          }
        }

        const { messages } = await res.json() as { messages: { id: string; text: string }[] }

        if (messages.length === 0) {
          return {
            content: [{ type: 'text', text: 'No pending messages from Claude.' }],
          }
        }

        const formatted = messages
          .map(m => `[${m.id}] ${m.text}`)
          .join('\n\n---\n\n')

        return {
          content: [{ type: 'text', text: `${messages.length} message(s) from Claude:\n\n${formatted}` }],
        }
      }

      default:
        return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      return {
        content: [{
          type: 'text',
          text: `Cannot reach Codex Bridge at ${BRIDGE_URL}. Make sure Claude Code is running with the codex-bridge channel enabled.`,
        }],
        isError: true,
      }
    }
    return {
      content: [{ type: 'text', text: `error: ${msg}` }],
      isError: true,
    }
  }
})

await mcp.connect(new StdioServerTransport())
process.stderr.write('codex-bridge-client: ready (connects to ' + BRIDGE_URL + ')\n')
