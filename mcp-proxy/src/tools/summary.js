/**
 * Account summary tool — single-call snapshot of everything on the account.
 *
 * Calls multiple LP tools in parallel via the child proxy and compiles
 * a structured overview: skills, LOBs, users, bots, flows, KBs, campaigns,
 * installed apps, FaaS functions, and active conversations.
 */

export const tools = [
  {
    name: 'account_summary',
    description:
      'Get a comprehensive snapshot of the current LP account in one call. ' +
      'Returns counts and details for: skills, LOBs, users, bots, AI Studio flows, ' +
      'knowledge bases, campaigns, engagements, installed apps, FaaS functions, and open conversations. ' +
      'Read-only — makes no changes.',
    inputSchema: {
      type: 'object',
      properties: {
        sections: {
          type: 'string',
          description:
            'Optional comma-separated list of sections to include. ' +
            'Available: skills, lobs, users, bots, flows, kb, campaigns, apps, faas, conversations. ' +
            'Default: all sections.',
        },
      },
    },
  },
];

export function register(ctx) {
  const { lpChild, auth, state } = ctx;

  /** Call an LP tool via the child proxy, return parsed text or null on error */
  async function call(toolName, args) {
    try {
      const result = await lpChild.callTool(toolName, args);
      const text = result?.content?.[0]?.text;
      if (!text) return null;
      try { return JSON.parse(text); } catch { return text; }
    } catch {
      return null;
    }
  }

  /** Call FaaS API directly for function list */
  async function faasListSafe() {
    try {
      return await auth.fetch(state.accountId, 'faasUI', '/lambdas');
    } catch {
      return null;
    }
  }

  const sectionFetchers = {
    skills: async () => {
      const data = await call('ac_skills', { action: 'list' });
      if (!Array.isArray(data)) return { count: 0, error: 'unavailable' };
      return {
        count: data.length,
        items: data.map(s => ({ id: s.id, name: s.name, maxWaitTime: s.maxWaitTime })),
      };
    },

    lobs: async () => {
      const data = await call('ac_lobs', { action: 'list' });
      if (!Array.isArray(data)) return { count: 0, error: 'unavailable' };
      return {
        count: data.length,
        items: data.map(l => ({ id: l.id, name: l.name })),
      };
    },

    users: async () => {
      const data = await call('ac_users', { action: 'list_summary' });
      if (!Array.isArray(data)) return { count: 0, error: 'unavailable' };
      const byType = {};
      for (const u of data) {
        const type = u.userTypeId == 2 ? 'bot' : 'human';
        byType[type] = (byType[type] || 0) + 1;
      }
      return { count: data.length, byType };
    },

    bots: async () => {
      const data = await call('cb_bots', { action: 'list' });
      if (!Array.isArray(data)) return { count: 0, error: 'unavailable' };
      const byStatus = {};
      for (const b of data) {
        const status = b.deploymentStatus || b.status || 'unknown';
        byStatus[status] = (byStatus[status] || 0) + 1;
      }
      return {
        count: data.length,
        byStatus,
        items: data.map(b => ({
          id: b.id,
          name: b.name,
          status: b.deploymentStatus || b.status || '',
          type: b.chatBotType || '',
        })),
      };
    },

    flows: async () => {
      const data = await call('ai_flows', { action: 'list' });
      if (!Array.isArray(data)) return { count: 0, note: 'AI Studio may not be enabled' };
      return {
        count: data.length,
        items: data.map(f => ({
          id: f.id,
          name: f.name,
          status: f.status || '',
        })),
      };
    },

    kb: async () => {
      const data = await call('kai_knowledgebases', { action: 'list' });
      if (!Array.isArray(data)) return { count: 0, note: 'KAI may not be enabled' };
      return {
        count: data.length,
        items: data.map(k => ({
          id: k.id,
          name: k.name,
          type: k.type || '',
          articleCount: k.articleCount ?? '',
        })),
      };
    },

    campaigns: async () => {
      const data = await call('ac_campaigns', { action: 'list_summary' });
      // Campaigns response can be an object with a campaigns array
      const list = Array.isArray(data) ? data : data?.campaigns || [];
      // Also get engagements count
      const engData = await call('ac_engagements', { action: 'list' });
      const engList = Array.isArray(engData) ? engData : engData?.engagements || [];
      return {
        campaigns: list.length,
        engagements: engList.length,
      };
    },

    apps: async () => {
      const data = await call('auth_apps', { action: 'list' });
      if (!Array.isArray(data)) return { count: 0, error: 'unavailable' };
      return {
        count: data.length,
        items: data.map(a => ({
          name: a.name || a.client_name || '',
          id: a.client_id || a.id || '',
        })),
      };
    },

    faas: async () => {
      const data = await faasListSafe();
      if (!Array.isArray(data)) return { count: 0, note: 'FaaS may not be enabled' };
      const byState = {};
      for (const fn of data) {
        byState[fn.state] = (byState[fn.state] || 0) + 1;
      }
      return {
        count: data.length,
        byState,
        items: data.map(fn => ({
          name: fn.name,
          state: fn.state,
          event: fn.eventId || 'none',
        })),
      };
    },

    conversations: async () => {
      const data = await call('conv_manage', { action: 'search' });
      // Response varies — could be array or object with conversationHistoryRecords
      const convs = Array.isArray(data)
        ? data
        : data?.conversationHistoryRecords || data?.conversations || [];
      return { openCount: Array.isArray(convs) ? convs.length : 0 };
    },
  };

  return {
    account_summary: async (args) => {
      if (!state.accountId) return error('No account connected. Use account_switch first.');
      if (!lpChild.isConnected) return error('LP child not connected. Use account_switch first.');

      // Determine which sections to fetch
      const allSections = Object.keys(sectionFetchers);
      let selected = allSections;
      if (args.sections) {
        selected = args.sections.split(',').map(s => s.trim().toLowerCase());
        const invalid = selected.filter(s => !sectionFetchers[s]);
        if (invalid.length) return error(`Unknown sections: ${invalid.join(', ')}. Available: ${allSections.join(', ')}`);
      }

      // Fetch all sections in parallel
      const entries = await Promise.all(
        selected.map(async (section) => {
          const data = await sectionFetchers[section]();
          return [section, data];
        })
      );

      const summary = {
        account: { id: state.accountId, name: state.accountName },
        ...Object.fromEntries(entries),
      };

      return text(JSON.stringify(summary, null, 2));
    },
  };
}

function text(t) { return { content: [{ type: 'text', text: t }] }; }
function error(t) { return { content: [{ type: 'text', text: t }], isError: true }; }
