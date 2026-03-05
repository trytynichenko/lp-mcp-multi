/**
 * Skill trace & skill map — understand skill usage across the account.
 *
 * composite_skill_trace: given a skill, show everything connected to it
 * composite_skill_map:   full skill → assignment/routing matrix
 */

export const tools = [
  {
    name: 'composite_skill_trace',
    description:
      'Show everything connected to a skill: campaigns/engagements routing to it, ' +
      'bot and human agents assigned to it, entry points, and extracted phone numbers/URLs. ' +
      'Read-only — makes no changes.',
    inputSchema: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'Skill name or ID (partial name match supported)' },
      },
      required: ['skill'],
    },
  },
  {
    name: 'composite_skill_map',
    description:
      'Full skill → assignment/routing matrix for the account. Shows which skills have ' +
      'bot/human assignments, campaign routing, and flags orphaned or unassigned skills. ' +
      'Read-only — makes no changes.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          enum: ['all', 'orphaned', 'unassigned', 'bots-only'],
          description: 'Filter results: orphaned (no routing + no assignments), unassigned (no agents), bots-only. Default: all.',
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

  /** Fetch engagement lists for all campaigns in parallel, returns Map<skillId, engagements[]> */
  async function buildSkillEngagementMap(campaigns) {
    const skillMap = new Map(); // skillId → [{ campaign, engagement }]

    const batches = await Promise.all(
      campaigns.map(async (c) => {
        const engs = await call('ac_engagements', { action: 'list', campaignId: String(c.id) });
        return { campaign: c, engagements: Array.isArray(engs) ? engs : [] };
      })
    );

    for (const { campaign, engagements } of batches) {
      for (const eng of engagements) {
        const sid = eng.skillId;
        if (!skillMap.has(sid)) skillMap.set(sid, []);
        skillMap.get(sid).push({
          campaignId: campaign.id,
          campaignName: campaign.name,
          campaignStatus: campaign.status === 1 ? 'enabled' : 'disabled',
          engagementId: eng.id,
          engagementName: eng.name,
          enabled: eng.enabled,
          source: ENG_SOURCES[eng.source] || undefined,
        });
      }
    }
    return skillMap;
  }

  /** Build Map<skillId, { bots: [], humans: count }> from user list */
  function buildSkillUserMap(users) {
    const map = new Map(); // skillId → { bots: [name], humanCount: n }
    for (const u of users) {
      const sids = u.skillIds || [];
      const isBot = u.userTypeId == 2;
      for (const sid of sids) {
        if (!map.has(sid)) map.set(sid, { bots: [], humanCount: 0 });
        const entry = map.get(sid);
        if (isBot) {
          entry.bots.push(u.fullName || u.nickname || u.loginName || `user-${u.id}`);
        } else {
          entry.humanCount++;
        }
      }
    }
    return map;
  }

  return {
    composite_skill_trace: async (args) => {
      if (!state.accountId) return error('No account connected.');

      // Fetch all data in parallel
      const [skillData, campData, userData] = await Promise.all([
        call('ac_skills', { action: 'list' }),
        call('ac_campaigns', { action: 'list_summary' }),
        call('ac_users', { action: 'list' }),
      ]);

      const skills = Array.isArray(skillData) ? skillData : [];
      const campaigns = campData?.campaigns || (Array.isArray(campData) ? campData : []);
      const users = Array.isArray(userData) ? userData : [];

      // Resolve skill
      const needle = String(args.skill).toLowerCase();
      const matched = skills.filter(s =>
        String(s.id) === String(args.skill) ||
        s.name.toLowerCase().includes(needle)
      );
      if (!matched.length) return error(`No skills matching "${args.skill}"`);

      const targetIds = new Set(matched.map(s => s.id));

      // Build engagement and user maps
      const [engMap, userMap] = await Promise.all([
        buildSkillEngagementMap(campaigns),
        Promise.resolve(buildSkillUserMap(users)),
      ]);

      // Build trace for each matched skill
      const traces = matched.map(skill => {
        const engagements = engMap.get(skill.id) || [];
        const userInfo = userMap.get(skill.id) || { bots: [], humanCount: 0 };

        // Group engagements by campaign
        const campaignGroups = {};
        for (const eng of engagements) {
          const key = eng.campaignId;
          if (!campaignGroups[key]) {
            campaignGroups[key] = {
              id: eng.campaignId,
              name: eng.campaignName,
              status: eng.campaignStatus,
              engagements: [],
            };
          }
          campaignGroups[key].engagements.push({
            id: eng.engagementId,
            name: eng.engagementName,
            enabled: eng.enabled,
            source: eng.source,
          });
        }

        return {
          skill: { id: skill.id, name: skill.name, maxWaitTime: skill.maxWaitTime },
          routing: {
            campaigns: Object.keys(campaignGroups).length,
            engagements: engagements.length,
            details: Object.values(campaignGroups),
          },
          assignments: {
            bots: userInfo.bots,
            humanAgents: userInfo.humanCount,
          },
        };
      });

      return text(JSON.stringify({
        account: { id: state.accountId, name: state.accountName },
        matchedSkills: traces.length,
        traces,
      }, null, 2));
    },

    composite_skill_map: async (args) => {
      if (!state.accountId) return error('No account connected.');

      const filter = args.filter || 'all';

      // Fetch all data in parallel
      const [skillData, campData, userData] = await Promise.all([
        call('ac_skills', { action: 'list' }),
        call('ac_campaigns', { action: 'list_summary' }),
        call('ac_users', { action: 'list' }),
      ]);

      const skills = Array.isArray(skillData) ? skillData : [];
      const campaigns = campData?.campaigns || (Array.isArray(campData) ? campData : []);
      const users = Array.isArray(userData) ? userData : [];

      const [engMap, userMap] = await Promise.all([
        buildSkillEngagementMap(campaigns),
        Promise.resolve(buildSkillUserMap(users)),
      ]);

      // Build matrix
      let skillRows = skills.map(s => {
        const engs = engMap.get(s.id) || [];
        const u = userMap.get(s.id) || { bots: [], humanCount: 0 };
        const uniqueCampaigns = new Set(engs.map(e => e.campaignId)).size;

        const flags = [];
        if (!engs.length && !u.bots.length && !u.humanCount) flags.push('orphaned');
        else if (!u.bots.length && !u.humanCount) flags.push('unassigned');
        if (!engs.length && (u.bots.length || u.humanCount)) flags.push('no-routing');
        if (u.bots.length && !u.humanCount) flags.push('bots-only');

        return {
          id: s.id,
          name: s.name,
          routing: { campaigns: uniqueCampaigns, engagements: engs.length },
          assignments: { bots: u.bots, humans: u.humanCount },
          flags,
        };
      });

      // Apply filter
      if (filter === 'orphaned') skillRows = skillRows.filter(s => s.flags.includes('orphaned'));
      else if (filter === 'unassigned') skillRows = skillRows.filter(s => s.flags.includes('unassigned'));
      else if (filter === 'bots-only') skillRows = skillRows.filter(s => s.flags.includes('bots-only'));

      // Summary counts
      const summary = {
        total: skills.length,
        withRouting: skillRows.filter(s => s.routing.engagements > 0).length,
        withBots: skillRows.filter(s => s.assignments.bots.length > 0).length,
        withHumans: skillRows.filter(s => s.assignments.humans > 0).length,
        orphaned: skills.map(s => {
          const engs = engMap.get(s.id) || [];
          const u = userMap.get(s.id) || { bots: [], humanCount: 0 };
          return !engs.length && !u.bots.length && !u.humanCount;
        }).filter(Boolean).length,
      };

      return text(JSON.stringify({
        account: { id: state.accountId, name: state.accountName },
        summary,
        showing: skillRows.length,
        skills: skillRows,
      }, null, 2));
    },
  };
}

const ENG_SOURCES = { 0: 'web', 3: 'connector', 12: 'proactive' };

function text(t) { return { content: [{ type: 'text', text: t }] }; }
function error(t) { return { content: [{ type: 'text', text: t }], isError: true }; }
