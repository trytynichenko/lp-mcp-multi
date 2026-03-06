/**
 * conv_simulate — Consumer-side conversation tool via LP Messaging REST API.
 *
 * Creates conversations, sends messages, and retrieves history as a consumer.
 * Uses AppJWT + ConsumerJWS auth (Sentinel + IDP + asyncMessagingEnt).
 * Complements the existing agent-side conv_manage / conv_send_message tools.
 */

import { randomUUID } from 'crypto';

export const tools = [
  {
    name: 'conv_simulate',
    description:
      'Simulate consumer-side messaging: create conversations, send messages, and retrieve ' +
      'history as a consumer. Uses the Messaging REST API with AppJWT + ConsumerJWS auth. ' +
      'Auto-discovers a suitable app installation (msg.consumer scope) or uses connectorAppId/connectorSecret from accounts.json.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'send', 'close', 'list', 'history'],
          description:
            'create: open a new conversation as consumer (optionally send initial message). ' +
            'send: send a consumer message into an open conversation. ' +
            'close: close a conversation from consumer side. ' +
            'list: show all conversations created by the simulator in this session. ' +
            'history: retrieve messages from a conversation.',
        },
        consumerId: {
          type: 'string',
          description: 'External consumer ID. If omitted, a random UUID is generated (new visitor each time). ' +
            'For send/close/history, auto-resolved from conversationId if previously created by this tool.',
        },
        consumerName: {
          type: 'string',
          description: 'Consumer display name (default: "Test Consumer"). Format: "FirstName LastName".',
        },
        skillId: {
          type: 'string',
          description: 'create: target skill ID for routing.',
        },
        campaignId: {
          type: 'string',
          description: 'create: campaign ID for attribution.',
        },
        engagementId: {
          type: 'string',
          description: 'create: engagement ID for attribution.',
        },
        conversationId: {
          type: 'string',
          description: 'send/close/history: the conversation ID to interact with.',
        },
        message: {
          type: 'string',
          description: 'create/send: the message text to send as consumer. On create, sends as the first consumer message.',
        },
        richContent: {
          type: 'object',
          description: 'send: structured content object (LP rich content JSON) instead of plain text. ' +
            'Follows LP structured content schema (type, tag, elements array with buttons, images, text, maps, etc.).',
        },
        appId: {
          type: 'string',
          description: 'App installation client_id to use. If omitted and multiple suitable apps exist, returns a list to choose from. ' +
            'Remembered per account after first selection.',
        },
        wait: {
          type: 'boolean',
          description: 'send/create: after sending, wait for a bot/agent response and include it in the result (polls up to 15s).',
        },
      },
      required: ['action'],
    },
  },
];

// ─── Caches & state ───────────────────────────────────────────────────────────

const appJwtCache = {};     // { [accountId]: { token, expiresAt } }
const consumerCache = {};   // { [accountId:consumerId]: { jws } }
const appCredsCache = {};   // { [accountId]: { clientId, clientSecret } }
const domainsCache = {};    // { [accountId]: { domains, expiresAt } }

// Track conversations created by this tool: conversationId → { consumerId, appId, consumerName, skillId, createdAt }
const convTracker = {};

const BUFFER_MS = 5 * 60 * 1000;
const DOMAINS_TTL_MS = 30 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_MS = 15000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function text(t) { return { content: [{ type: 'text', text: t }] }; }
function error(t) { return { content: [{ type: 'text', text: t }], isError: true }; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function resolveDomains(accountId) {
  const cached = domainsCache[accountId];
  if (cached && Date.now() < cached.expiresAt) return cached.domains;

  const resp = await fetch(
    `https://api.liveperson.net/api/account/${accountId}/service/baseURI.json?version=1.0`,
  );
  if (!resp.ok) throw new Error(`CSDS lookup failed: ${resp.status}`);
  const data = await resp.json();
  const domains = {};
  for (const entry of data.baseURIs) {
    domains[entry.service] = entry.baseURI;
  }
  domainsCache[accountId] = { domains, expiresAt: Date.now() + DOMAINS_TTL_MS };
  return domains;
}

/**
 * Find all suitable app installations from the raw auth_apps list.
 * Uses regex extraction because the full JSON can be 50KB+ with invalid chars.
 */
function findConsumerApps(raw) {
  const apps = [];
  const seen = new Set();

  function tryPattern(pattern, idIdx, secretIdx) {
    let m;
    while ((m = pattern.exec(raw)) !== null) {
      const clientId = m[idIdx];
      if (seen.has(clientId)) continue;
      const clientSecret = m[secretIdx];
      const start = Math.max(0, m.index - 300);
      const ctx = raw.slice(start, m.index + m[0].length + 300);
      if (ctx.includes('"enabled":true') &&
          !ctx.includes('"deleted":true') &&
          ctx.includes('client_credentials')) {
        const nameMatch = ctx.match(/"client_name"\s*:\s*"([^"]+)"/);
        const name = nameMatch ? nameMatch[1] : 'unknown';
        seen.add(clientId);
        apps.push({ clientId, clientSecret, name });
      }
    }
  }

  tryPattern(
    /"client_id"\s*:\s*"([^"]+)"[^}]*?"client_secret"\s*:\s*"([^"]+)"[^}]*?"scope"\s*:\s*"([^"]*msg\.consumer[^"]*)"/g,
    1, 2,
  );
  tryPattern(
    /"scope"\s*:\s*"([^"]*msg\.consumer[^"]*)"[^}]*?"client_id"\s*:\s*"([^"]+)"[^}]*?"client_secret"\s*:\s*"([^"]+)"/g,
    2, 3,
  );

  return apps;
}

async function getConnectorCreds(accountId, creds, lpChild, appId) {
  if (creds.connectorAppId && creds.connectorSecret) {
    return { clientId: creds.connectorAppId, clientSecret: creds.connectorSecret };
  }

  // Use cached (includes appId remembered from previous selection)
  if (!appId && appCredsCache[accountId]) return appCredsCache[accountId];

  const r = await lpChild.callTool('auth_apps', { action: 'list' });
  const raw = r?.content?.[0]?.text || '';
  const apps = findConsumerApps(raw);

  if (apps.length === 0) {
    throw new Error(
      'No suitable app installation found. Need an enabled app with client_credentials grant and msg.consumer scope. ' +
      'Or add connectorAppId/connectorSecret to accounts.json.',
    );
  }

  if (appId) {
    const match = apps.find(a => a.clientId === appId);
    if (!match) {
      const list = apps.map(a => `  • ${a.name} (${a.clientId})`).join('\n');
      throw new Error(`App "${appId}" not found among suitable apps. Available:\n${list}`);
    }
    const result = { clientId: match.clientId, clientSecret: match.clientSecret };
    appCredsCache[accountId] = result;
    return result;
  }

  if (apps.length === 1) {
    const result = { clientId: apps[0].clientId, clientSecret: apps[0].clientSecret };
    appCredsCache[accountId] = result;
    return result;
  }

  const list = apps.map(a => `  • ${a.name} — appId: "${a.clientId}"`).join('\n');
  throw new Error(
    `Multiple suitable app installations found. Please specify appId:\n${list}`,
  );
}

async function getAppJwt(accountId, creds, domains, lpChild, appId) {
  const cached = appJwtCache[accountId];
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const sentinel = domains.sentinel;
  if (!sentinel) throw new Error('CSDS domain "sentinel" not available');

  const { clientId, clientSecret } = await getConnectorCreds(accountId, creds, lpChild, appId);

  const resp = await fetch(
    `https://${sentinel}/sentinel/api/account/${accountId}/app/token?v=1.0`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`,
    },
  );
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`AppJWT request failed (${resp.status}): ${body}`);
  }
  const data = await resp.json();
  const token = data.access_token;

  let expiresAt = Date.now() + 3600 * 1000 - BUFFER_MS;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    if (payload.exp) expiresAt = payload.exp * 1000 - BUFFER_MS;
  } catch { /* use default */ }

  appJwtCache[accountId] = { token, expiresAt };
  return token;
}

async function getConsumerJws(accountId, consumerId, appJwt, domains) {
  const cacheKey = `${accountId}:${consumerId}`;
  const cached = consumerCache[cacheKey];
  if (cached) return cached.jws;

  const idp = domains.idp;
  if (!idp) throw new Error('CSDS domain "idp" not available');

  const resp = await fetch(
    `https://${idp}/api/account/${accountId}/consumer?v=1.0`,
    {
      method: 'POST',
      headers: {
        Authorization: appJwt,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ext_consumer_id: consumerId }),
    },
  );
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`ConsumerJWS request failed (${resp.status}): ${body}`);
  }
  const data = await resp.json();
  const jws = data.token;

  consumerCache[cacheKey] = { jws };
  return jws;
}

// ─── Message helpers ──────────────────────────────────────────────────────────

function buildMessageEvent(args) {
  if (args.richContent) {
    return {
      type: 'RichContentEvent',
      content: args.richContent,
    };
  }
  return {
    type: 'ContentEvent',
    contentType: 'text/plain',
    message: args.message,
  };
}

async function sendConsumerMessage(baseUrl, authHeaders, conversationId, args) {
  const body = {
    kind: 'req',
    type: 'ms.PublishEvent',
    id: randomUUID(),
    body: {
      conversationId,
      dialogId: conversationId,
      event: buildMessageEvent(args),
    },
  };

  const resp = await fetch(`${baseUrl}/send?v=3`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    throw new Error(`Send message failed (${resp.status}): ${errBody}`);
  }
  return resp.json();
}

/**
 * Poll conversation history for a new agent/bot response after the consumer's message.
 * Returns the response messages or null if none arrived within the timeout.
 */
async function waitForResponse(lpChild, conversationId, afterSeq) {
  const deadline = Date.now() + POLL_MAX_MS;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    try {
      const r = await lpChild.callTool('conv_manage', {
        action: 'search',
        status: 'OPEN',
        includeTranscript: true,
        limit: 1,
      });
      const raw = r?.content?.[0]?.text;
      if (!raw) continue;

      // Find our conversation in results
      const data = JSON.parse(raw);
      const records = data.conversationHistoryRecords || [];
      const conv = records.find(r => r.info?.conversationId === conversationId);
      if (!conv) continue;

      const messages = (conv.messageRecords || [])
        .filter(m => m.seq > afterSeq && m.sentBy !== 'Consumer')
        .map(m => ({
          seq: m.seq,
          sentBy: m.sentBy,
          source: m.source,
          text: m.messageData?.msg?.text,
          time: m.time,
        }));

      if (messages.length > 0) return messages;
    } catch { /* keep polling */ }
  }

  return null;
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function register(ctx) {
  const { accountManager, lpChild, state } = ctx;

  /**
   * Resolve consumerId for a given conversationId from the tracker.
   * Falls back to the explicit arg or generates a new one.
   */
  function resolveConsumerId(args) {
    if (args.consumerId) return args.consumerId;
    if (args.conversationId && convTracker[args.conversationId]) {
      return convTracker[args.conversationId].consumerId;
    }
    return randomUUID();
  }

  return {
    conv_simulate: async (args) => {
      if (!state.accountId) return error('No account connected.');

      // ─── LIST (no auth needed) ──────────────────────────────────────
      if (args.action === 'list') {
        const entries = Object.entries(convTracker)
          .filter(([, v]) => v.accountId === state.accountId)
          .map(([id, v]) => ({
            conversationId: id,
            consumerId: v.consumerId,
            consumerName: v.consumerName,
            skillId: v.skillId,
            appId: v.appId,
            status: v.status,
            createdAt: v.createdAt,
          }));

        if (entries.length === 0) return text('No conversations created in this session.');
        return text(JSON.stringify(entries, null, 2));
      }

      // ─── Auth setup ─────────────────────────────────────────────────
      const accountId = state.accountId;
      const accounts = accountManager.loadAll();
      const creds = accounts[accountId];
      if (!creds) return error(`Account ${accountId} not in accounts.json`);

      const domains = await resolveDomains(accountId);
      const appJwt = await getAppJwt(accountId, creds, domains, lpChild, args.appId);

      const consumerId = resolveConsumerId(args);
      const jws = await getConsumerJws(accountId, consumerId, appJwt, domains);

      const msgDomain = domains.asyncMessagingEnt;
      if (!msgDomain) return error('CSDS domain "asyncMessagingEnt" not available');

      const baseUrl = `https://${msgDomain}/api/account/${accountId}/messaging/consumer/conversation`;
      const authHeaders = {
        Authorization: appJwt,
        'X-LP-ON-BEHALF': jws,
        'Content-Type': 'application/json',
      };

      switch (args.action) {
        // ─── CREATE ─────────────────────────────────────────────────────
        case 'create': {
          const nameParts = (args.consumerName || 'Test Consumer').split(' ');
          const firstName = nameParts[0];
          const lastName = nameParts.slice(1).join(' ') || '';

          const body = [
            {
              kind: 'req',
              id: randomUUID(),
              type: 'userprofile.SetUserProfile',
              body: {
                firstName,
                lastName,
                authenticatedData: {
                  lp_sdes: [
                    {
                      type: 'ctmrinfo',
                      info: { customerId: consumerId, userName: args.consumerName || 'Test Consumer' },
                    },
                    {
                      type: 'personal',
                      personal: { firstname: firstName, lastname: lastName },
                    },
                  ],
                },
              },
            },
            {
              kind: 'req',
              id: randomUUID(),
              type: 'cm.ConsumerRequestConversation',
              body: {
                channelType: 'MESSAGING',
                brandId: accountId,
                ...(args.skillId && { skillId: args.skillId }),
                ...(args.campaignId && args.engagementId && {
                  campaignInfo: {
                    campaignId: args.campaignId,
                    engagementId: args.engagementId,
                  },
                }),
              },
            },
          ];

          const resp = await fetch(`${baseUrl}?v=3`, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify(body),
          });
          if (!resp.ok) {
            const errBody = await resp.text().catch(() => '');
            return error(`Create conversation failed (${resp.status}): ${errBody}`);
          }
          const result = await resp.json();

          const convResp = result.find(r => r.body?.conversationId);
          const conversationId = convResp?.body?.conversationId;

          // Track conversation
          const appId = appCredsCache[accountId]?.clientId;
          convTracker[conversationId] = {
            accountId,
            consumerId,
            consumerName: args.consumerName || 'Test Consumer',
            skillId: args.skillId || null,
            appId: appId || null,
            status: 'OPEN',
            createdAt: new Date().toISOString(),
          };

          // Send initial message if provided
          let initialMessage = null;
          let lastSeq = -1;
          if (args.message || args.richContent) {
            try {
              const sendResult = await sendConsumerMessage(baseUrl, authHeaders, conversationId, args);
              lastSeq = sendResult.body?.sequence ?? 0;
              initialMessage = { sent: true, sequence: lastSeq };
            } catch (e) {
              initialMessage = { sent: false, error: e.message };
            }
          }

          // Wait for bot/agent response if requested
          let botResponse = null;
          if (args.wait && initialMessage?.sent) {
            botResponse = await waitForResponse(lpChild, conversationId, lastSeq);
          }

          return text(JSON.stringify({
            conversationId,
            consumerId,
            consumerName: args.consumerName || 'Test Consumer',
            ...(args.skillId && { skillId: args.skillId }),
            ...(initialMessage && { initialMessage }),
            ...(botResponse && { botResponse }),
            ...(!botResponse && args.wait && { botResponse: 'No response within 15s' }),
          }, null, 2));
        }

        // ─── SEND ───────────────────────────────────────────────────────
        case 'send': {
          if (!args.conversationId) return error('conversationId is required for send action.');
          if (!args.message && !args.richContent) return error('message or richContent is required for send action.');

          const sendResult = await sendConsumerMessage(baseUrl, authHeaders, args.conversationId, args);
          const seq = sendResult.body?.sequence ?? 0;

          // Wait for bot/agent response if requested
          let botResponse = null;
          if (args.wait) {
            botResponse = await waitForResponse(lpChild, args.conversationId, seq);
          }

          return text(JSON.stringify({
            status: 'sent',
            conversationId: args.conversationId,
            sequence: seq,
            ...(botResponse && { botResponse }),
            ...(!botResponse && args.wait && { botResponse: 'No response within 15s' }),
          }, null, 2));
        }

        // ─── CLOSE ───────────────────────────────────────────────────────
        case 'close': {
          if (!args.conversationId) return error('conversationId is required for close action.');

          const body = {
            kind: 'req',
            type: 'cm.UpdateConversationField',
            id: randomUUID(),
            body: {
              conversationId: args.conversationId,
              conversationField: {
                field: 'ConversationStateField',
                conversationState: 'CLOSE',
              },
            },
          };

          const resp = await fetch(`${baseUrl}/send?v=3`, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify(body),
          });
          if (!resp.ok) {
            const errBody = await resp.text().catch(() => '');
            return error(`Close conversation failed (${resp.status}): ${errBody}`);
          }

          // Update tracker
          if (convTracker[args.conversationId]) {
            convTracker[args.conversationId].status = 'CLOSED';
          }

          return text(JSON.stringify({
            status: 'closed',
            conversationId: args.conversationId,
          }, null, 2));
        }

        // ─── HISTORY ────────────────────────────────────────────────────
        case 'history': {
          if (!args.conversationId) return error('conversationId is required for history action.');

          try {
            const r = await lpChild.callTool('conv_manage', {
              action: 'get_transcript',
              conversationId: args.conversationId,
            });
            return r;
          } catch (err) {
            return error(`Failed to get history: ${err.message}`);
          }
        }

        default:
          return error(`Unknown action: ${args.action}`);
      }
    },
  };
}
