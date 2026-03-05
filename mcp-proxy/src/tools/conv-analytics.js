/**
 * Conversation analytics — aggregated stats from conversation history.
 *
 * Groups conversations by source/channel, skill, agent group, or time period.
 * Returns counts, avg duration, MCS distribution, and top values.
 */

export const tools = [
  {
    name: 'conv_analytics',
    description:
      'Aggregate conversation statistics by channel, skill, agent group, or time period. ' +
      'Returns counts, average duration, MCS distribution, and breakdowns. ' +
      'Defaults to closed conversations from last 7 days. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        fromDate: { type: 'string', description: 'Start date (default: 7 days ago)' },
        toDate: { type: 'string', description: 'End date (default: today)' },
        groupBy: {
          type: 'string',
          enum: ['source', 'skill', 'agentGroup', 'day', 'hour'],
          description: 'Field to group by (default: source)',
        },
        status: {
          type: 'string',
          enum: ['OPEN', 'CLOSE'],
          description: 'Conversation status (default: CLOSE)',
        },
        skillIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by skill IDs',
        },
      },
    },
  },
];

export function register(ctx) {
  const { lpChild, state } = ctx;

  async function call(name, args) {
    try {
      const r = await lpChild.callTool(name, args);
      const t = r?.content?.[0]?.text;
      if (!t) return null;
      try { return JSON.parse(t); } catch { return t; }
    } catch { return null; }
  }

  return {
    conv_analytics: async (args) => {
      if (!state.accountId) return error('No account connected.');

      const fromDate = args.fromDate || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const toDate = args.toDate || undefined;
      const status = args.status || 'CLOSE';
      const groupBy = args.groupBy || 'source';

      // Fetch conversations
      const searchArgs = { action: 'search', status, fromDate, limit: 200 };
      if (toDate) searchArgs.toDate = toDate;
      if (args.skillIds) searchArgs.skillIds = args.skillIds;

      const data = await call('conv_manage', searchArgs);
      if (!data) return error('Failed to fetch conversations');

      const records = data.conversationHistoryRecords || [];
      const totalCount = data._metadata?.count || records.length;

      // Extract conversation info
      const convs = records.map(r => {
        const i = r.info || {};
        return {
          source: i.source || 'unknown',
          skill: i.latestSkillName || 'unknown',
          skillId: i.latestSkillId,
          agentGroup: i.latestAgentGroupName || 'unassigned',
          duration: i.duration || 0,
          mcs: i.mcs,
          startTime: i.startTime || '',
          closeReason: i.closeReasonDescription,
          firstConversation: i.firstConversation,
        };
      });

      // Group by selected field
      const groups = {};
      for (const c of convs) {
        let key;
        switch (groupBy) {
          case 'source': key = c.source; break;
          case 'skill': key = c.skill; break;
          case 'agentGroup': key = c.agentGroup; break;
          case 'day': key = c.startTime.split(' ')[0] || 'unknown'; break;
          case 'hour': {
            const match = c.startTime.match(/\d{4}-\d{2}-\d{2} (\d{2}):/);
            key = match ? `${match[1]}:00` : 'unknown';
            break;
          }
          default: key = c.source;
        }
        if (!groups[key]) groups[key] = [];
        groups[key].push(c);
      }

      // Compute stats per group
      const groupStats = Object.entries(groups)
        .map(([key, items]) => {
          const durations = items.map(c => c.duration).filter(d => d > 0);
          const mcsValues = items.map(c => c.mcs).filter(m => m != null);
          const newConsumers = items.filter(c => c.firstConversation).length;

          // Top secondary dimension
          const secondary = {};
          for (const c of items) {
            const sKey = groupBy === 'skill' ? c.source : c.skill;
            secondary[sKey] = (secondary[sKey] || 0) + 1;
          }
          const topSecondary = Object.entries(secondary)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([k, v]) => `${k} (${v})`);

          return {
            key,
            count: items.length,
            pct: `${((items.length / convs.length) * 100).toFixed(1)}%`,
            avgDuration: durations.length ? formatDuration(avg(durations)) : null,
            avgMcs: mcsValues.length ? Math.round(avg(mcsValues)) : null,
            newConsumers,
            ...(groupBy !== 'skill' && { topSkills: topSecondary }),
            ...(groupBy === 'skill' && { topSources: topSecondary }),
          };
        })
        .sort((a, b) => b.count - a.count);

      // Totals
      const allDurations = convs.map(c => c.duration).filter(d => d > 0);
      const allMcs = convs.map(c => c.mcs).filter(m => m != null);

      const result = {
        account: { id: state.accountId, name: state.accountName },
        period: { from: fromDate, ...(toDate && { to: toDate }), status },
        sample: {
          analyzed: convs.length,
          total: totalCount,
          ...(totalCount > convs.length && { note: `Showing first ${convs.length} of ${totalCount}. Narrow the date range for complete data.` }),
        },
        totals: {
          conversations: convs.length,
          avgDuration: allDurations.length ? formatDuration(avg(allDurations)) : null,
          avgMcs: allMcs.length ? Math.round(avg(allMcs)) : null,
          newConsumers: convs.filter(c => c.firstConversation).length,
        },
        groupBy,
        groups: groupStats,
      };

      return text(JSON.stringify(result, null, 2));
    },
  };
}

function avg(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function text(t) { return { content: [{ type: 'text', text: t }] }; }
function error(t) { return { content: [{ type: 'text', text: t }], isError: true }; }
