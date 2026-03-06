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
import * as campaignTraceTools from './tools/campaign-trace.js';
import * as skillTraceTools from './tools/skill-trace.js';
import * as convAnalyticsTools from './tools/conv-analytics.js';
import * as convSimulateTools from './tools/conv-simulate.js';

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

const toolModules = [accountTools, faasTools, summaryTools, changelogTools, campaignTraceTools, skillTraceTools, convAnalyticsTools, convSimulateTools];

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

// tools/list — our custom tools + proxied LP tools (with schema patches)
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const lpTools = lpChild.tools.map(t => {
    // R3: Add compact param to conv_manage
    if (t.name === 'conv_manage' && t.inputSchema?.properties) {
      return {
        ...t,
        inputSchema: {
          ...t.inputSchema,
          properties: {
            ...t.inputSchema.properties,
            compact: {
              type: 'boolean',
              description: 'search: return compact results (strip message records, keep conversation info only)',
            },
            source: {
              type: 'string',
              description: 'search: filter by channel source (e.g. "WhatsApp Business", "SMS", "WEB", "FACEBOOK"). Case-insensitive partial match.',
            },
          },
        },
      };
    }
    return t;
  });
  return { tools: [...customToolDefs, ...lpTools] };
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

  // Strip proxy-only params before forwarding to LP child
  const lpArgs = { ...args };
  const compact = lpArgs.compact;
  const source = lpArgs.source;
  delete lpArgs.compact;
  delete lpArgs.source;

  try {
    const result = await lpChild.callTool(toolName, lpArgs);
    return postProcess(toolName, lpArgs, result, { compact, source });
  } catch (err) {
    // Auto-reconnect on child death
    if (state.accountId && (err.message?.includes('closed') || err.message?.includes('not connected'))) {
      try {
        log(`Reconnecting to ${state.accountId}...`);
        const account = accountManager.resolve(state.accountId);
        await lpChild.spawn(account);
        const result = await lpChild.callTool(toolName, lpArgs);
        return postProcess(toolName, lpArgs, result, { compact, source });
      } catch (retryErr) {
        return { content: [{ type: 'text', text: `Failed after reconnect: ${retryErr.message}` }], isError: true };
      }
    }
    return { content: [{ type: 'text', text: `Tool call failed: ${err.message}` }], isError: true };
  }
});

// ─── Response post-processing (R3: compact conv, R4: engagement enrichment) ──

function postProcess(toolName, args, result, opts) {
  try {
    const txt = result?.content?.[0]?.text;
    if (!txt) return result;

    // R3 + R6: Compact mode and/or source filter for conv_manage search
    if (toolName === 'conv_manage' && args.action === 'search' && (opts.compact || opts.source)) {
      const data = JSON.parse(txt);
      let records = data.conversationHistoryRecords || [];

      // R6: Apply source filter
      if (opts.source) {
        const needle = opts.source.toLowerCase();
        records = records.filter(r => (r.info?.source || '').toLowerCase().includes(needle));
      }

      // R3: Compact transformation
      if (opts.compact) {
        const conversations = records.map(r => {
          const i = r.info || {};
          const cp = r.consumerParticipants?.[0] || {};
          return {
            conversationId: i.conversationId,
            source: i.source,
            startTime: i.startTime,
            endTime: i.endTime,
            duration: i.duration,
            status: i.status,
            latestSkillId: i.latestSkillId,
            latestSkillName: i.latestSkillName,
            latestAgentFullName: i.latestAgentFullName,
            latestAgentGroupName: i.latestAgentGroupName,
            closeReason: i.closeReasonDescription,
            mcs: i.mcs,
            firstConversation: i.firstConversation,
            consumerName: cp.firstName ? `${cp.firstName} ${cp.lastName || ''}`.trim() : undefined,
            campaign: r.campaign,
          };
        });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              count: conversations.length,
              ...(opts.source && { totalBeforeFilter: data._metadata?.count }),
              conversations,
            }, null, 2),
          }],
        };
      }

      // Source filter only (no compact) — return filtered full records
      data.conversationHistoryRecords = records;
      if (opts.source) data._filtered = { source: opts.source, matched: records.length, total: data._metadata?.count };
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }

    // R4: Enrich ac_engagements get with extracted phones/URLs from HTML
    if (toolName === 'ac_engagements' && args.action === 'get') {
      const eng = JSON.parse(txt);
      if (eng?.displayInstances) {
        const phones = new Set();
        const urls = new Set();
        for (const di of eng.displayInstances) {
          const html = di.presentation?.html || '';
          for (const m of html.matchAll(/whatsapp\.com\/send\/?\?phone=(\d+)/gi)) phones.add(`+${m[1]}`);
          for (const m of html.matchAll(/tel:([+\d-]+)/gi)) phones.add(m[1]);
          for (const m of html.matchAll(/href="(https?:\/\/[^"]+)"/gi)) {
            const u = m[1].replace(/&amp;/g, '&');
            if (!/liveperson|lpsnmedia|lpcdn/.test(u)) urls.add(u);
          }
        }
        if (phones.size) eng._extractedPhones = [...phones];
        if (urls.size) eng._extractedUrls = [...urls];
        return { content: [{ type: 'text', text: JSON.stringify(eng, null, 2) }] };
      }
    }

    return result;
  } catch {
    return result;
  }
}

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
