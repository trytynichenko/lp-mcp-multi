#!/usr/bin/env node
/**
 * LP MCP Proxy — Multi-account MCP server for LivePerson
 *
 * Wraps @lpextend/mcp-server as a child process and adds:
 *   - Instant account switching (no MCP restart)
 *   - FaaS function management (list, get code, export)
 *
 * Compatible with Claude Code, Cursor, VS Code Copilot, OpenAI Codex,
 * Gemini CLI, Windsurf, and any MCP-compatible client.
 *
 * Configuration: reads accounts from ../accounts.json
 * (or path set via LP_ACCOUNTS_FILE env var).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { AccountManager } from './accounts.js';
import { LPAuth } from './auth.js';
import { LPChild } from './lp-child.js';
import * as accountTools from './tools/account.js';
import * as faasTools from './tools/faas.js';
import * as summaryTools from './tools/summary.js';
import * as changelogTools from './tools/changelog.js';

// ─── Setup ───────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = process.env.LP_PROJECT_ROOT || resolve(__dirname, '..', '..');

const accountManager = new AccountManager(PROJECT_ROOT);
const auth = new LPAuth(accountManager);
const lpChild = new LPChild();

// Shared mutable state for the active account
const state = { accountId: null, accountName: null, accountLogin: null };

// Context passed to all tool modules
const ctx = { accountManager, auth, lpChild, state };

// ─── Register custom tools ──────────────────────────────────────────────────

const toolModules = [accountTools, faasTools, summaryTools, changelogTools];

// Collect tool definitions
const customToolDefs = toolModules.flatMap(m => m.tools);

// Collect tool handlers
const customHandlers = {};
for (const mod of toolModules) {
  Object.assign(customHandlers, mod.register(ctx));
}
const customToolNames = new Set(Object.keys(customHandlers));

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'lp-mcp-proxy', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

// tools/list — our custom tools + proxied LP tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: [...customToolDefs, ...lpChild.tools] };
});

// tools/call — route to custom handler or LP child
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const args = request.params.arguments || {};

  // Custom tools
  if (customToolNames.has(toolName)) {
    try {
      return await customHandlers[toolName](args);
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }

  // LP child proxy
  if (!lpChild.isConnected) {
    return { content: [{ type: 'text', text: 'No account connected. Use account_switch first.' }], isError: true };
  }

  try {
    return await lpChild.callTool(toolName, args);
  } catch (err) {
    // Auto-reconnect on child death
    if (state.accountId && (err.message?.includes('closed') || err.message?.includes('not connected'))) {
      try {
        log(`Reconnecting to ${state.accountId}...`);
        const account = accountManager.resolve(state.accountId);
        await lpChild.spawn(account);
        return await lpChild.callTool(toolName, args);
      } catch (retryErr) {
        return { content: [{ type: 'text', text: `Failed after reconnect: ${retryErr.message}` }], isError: true };
      }
    }
    return { content: [{ type: 'text', text: `Tool call failed: ${err.message}` }], isError: true };
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────

function log(msg) {
  process.stderr.write(`[lp-mcp-proxy] ${msg}\n`);
}

async function start() {
  // Auto-connect to the last-used account (or first available)
  const accounts = accountManager.loadAll();
  const firstId = accountManager.getLastAccount() || Object.keys(accounts)[0];
  if (firstId) {
    try {
      const account = accountManager.resolve(firstId);
      await lpChild.spawn(account);
      state.accountId = account.accountId;
      state.accountName = account.name;
      state.accountLogin = account.login;
      log(`Connected to ${account.accountId} — ${account.name}`);
    } catch (err) {
      log(`Auto-connect failed: ${err.message}`);
    }
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('Server started');
}

start().catch(err => {
  log(`Fatal: ${err.message}`);
  process.exit(1);
});
