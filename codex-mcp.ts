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
const POLL_TIMEOUT_MS = 110000
const CLIENT_ABORT_MS = 115000

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

        // Step 2: Long-poll for Claude's reply
        // Use AbortController to prevent Bun from closing the socket prematurely
        const controller = new AbortController()
        const clientTimeout = setTimeout(() => controller.abort(), CLIENT_ABORT_MS)
        let pollRes: Response
        try {
          pollRes = await fetch(`${BRIDGE_URL}/api/poll-reply/${id}?timeout=${POLL_TIMEOUT_MS}`, {
            signal: controller.signal,
          })
        } catch (e: unknown) {
          clearTimeout(clientTimeout)
          const msg = e instanceof Error ? e.message : String(e)
          if (msg.includes('abort') || msg.includes('socket')) {
            return {
              content: [{ type: 'text', text: 'Claude is still thinking. The bridge timed out waiting for a reply after about 2 minutes. Try again later.' }],
            }
          }
          throw e
        }
        clearTimeout(clientTimeout)

        if (!pollRes.ok) {
          return {
            content: [{ type: 'text', text: `error polling reply: ${pollRes.status}` }],
            isError: true,
          }
        }

        const result = await pollRes.json() as { timeout: boolean; reply: string | null }

        if (result.timeout || !result.reply) {
          return {
            content: [{
              type: 'text',
              text: 'Claude did not reply within about 2 minutes. Claude may be busy or waiting for user approval. Try again later.',
            }],
          }
        }

        return {
          content: [{ type: 'text', text: result.reply }],
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
