/**
 * Campaign trace — trace the full routing chain for a channel, skill, or campaign.
 *
 * Resolves: connector → campaign → engagement → entry point → skill,
 * with phone numbers and URLs extracted from engagement HTML.
 */

export const tools = [
  {
    name: 'composite_campaign_trace',
    description:
      'Trace the full routing chain for a messaging channel, skill, or campaign. ' +
      'Returns: connector → campaign → engagement (with extracted phone numbers/URLs) → ' +
      'entry point (with URL patterns) → skill. Read-only — makes no changes.',
    inputSchema: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'Filter by skill name or ID' },
        channel: {
          type: 'string',
          description: 'Filter by channel: whatsapp, sms, facebook, instagram, apple, email, google',
        },
        campaignId: { type: ['string', 'number'], description: 'Filter by campaign ID' },
      },
    },
  },
];

const CHANNEL_KEYWORDS = {
  whatsapp: ['whatsapp'],
  sms: ['sms', 'twilio'],
  facebook: ['facebook'],
  instagram: ['instagram'],
  apple: ['apple'],
  email: ['email'],
  google: ['google', 'gbm'],
};

const ENG_TYPES = {
  1: 'overlay', 2: 'toast', 3: 'slide-out', 4: 'embedded', 5: 'sticky', 13: 'offsite',
};

const ENG_SOURCES = { 0: 'web', 3: 'connector', 12: 'proactive' };

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
    composite_campaign_trace: async (args) => {
      if (!state.accountId) return error('No account connected.');
      if (!args.skill && !args.channel && !args.campaignId) {
        return error('Provide at least one of: skill, channel, or campaignId');
      }

      // Phase 1: fetch base data in parallel
      const [instData, campData, skillData] = await Promise.all([
        call('ac_lookup', { resource: 'installations' }),
        call('ac_campaigns', { action: 'list_summary' }),
        call('ac_skills', { action: 'list' }),
      ]);

      const installations = Array.isArray(instData) ? instData : [];
      const campaigns = campData?.campaigns || (Array.isArray(campData) ? campData : []);
      const skills = Array.isArray(skillData) ? skillData : [];

      // Identify messaging connectors
      const connectors = installations.filter(a =>
        a.scope?.includes('msg.consumer') && a.capabilities?.webhooks && !a.deleted
      );

      // Resolve target connector for channel filter
      let targetConnector = null;
      let channelKws = null;
      if (args.channel) {
        channelKws = CHANNEL_KEYWORDS[args.channel.toLowerCase()] || [args.channel.toLowerCase()];
        targetConnector = connectors.find(c =>
          channelKws.some(k => c.client_name.toLowerCase().includes(k))
        );
      }

      // Resolve target skill IDs
      let targetSkillIds = null;
      if (args.skill) {
        const matches = skills.filter(s =>
          String(s.id) === String(args.skill) ||
          s.name.toLowerCase().includes(String(args.skill).toLowerCase())
        );
        if (matches.length) targetSkillIds = new Set(matches.map(s => s.id));
      }

      // Filter campaigns by ID if given
      let targetCampaigns = campaigns;
      if (args.campaignId) {
        targetCampaigns = campaigns.filter(c => String(c.id) === String(args.campaignId));
      }

      // Phase 2: fetch engagement lists for all target campaigns in parallel
      const campaignEngagements = await Promise.all(
        targetCampaigns.map(async (c) => {
          const engs = await call('ac_engagements', { action: 'list', campaignId: String(c.id) });
          return { campaign: c, engagements: Array.isArray(engs) ? engs : [] };
        })
      );

      // Phase 3: filter engagements by skill/channel
      const matching = [];
      for (const { campaign, engagements } of campaignEngagements) {
        for (const eng of engagements) {
          if (targetSkillIds && !targetSkillIds.has(eng.skillId)) continue;
          if (channelKws && !targetSkillIds && !args.campaignId) {
            const hay = `${eng.skillName || ''} ${campaign.name || ''}`.toLowerCase();
            if (!channelKws.some(k => hay.includes(k))) continue;
          }
          matching.push({ campaign, eng });
        }
      }

      // Phase 4: fetch full details for matches (engagement HTML + entry points)
      const epCache = {};
      const routes = await Promise.all(
        matching.map(async ({ campaign, eng }) => {
          const fullEng = await call('ac_engagements', {
            action: 'get',
            campaignId: String(campaign.id),
            engagementId: String(eng.id),
          });

          const extracted = extractFromHtml(fullEng);

          // Fetch entry points (with cache)
          const epIds = fullEng?.onsiteLocations || eng.onsiteLocations || [];
          const entryPoints = [];
          for (const epId of epIds) {
            if (!epCache[epId]) {
              epCache[epId] = call('ac_entry_points', { action: 'get', entryPointId: String(epId) });
            }
            const ep = await epCache[epId];
            if (ep) {
              const urls = [];
              for (const box of (ep.conditionBoxes || [])) {
                for (const inc of (box.data?.include || [])) {
                  if (inc.page?.url) urls.push(inc.page.url);
                }
              }
              entryPoints.push({ id: ep.id, name: ep.name, ...(urls.length && { urls }) });
            }
          }

          return {
            campaign: {
              id: campaign.id,
              name: campaign.name,
              status: campaign.status === 1 ? 'enabled' : 'disabled',
            },
            engagement: {
              id: eng.id,
              name: eng.name,
              type: ENG_TYPES[fullEng?.type || eng.type] || `type-${fullEng?.type || eng.type}`,
              enabled: eng.enabled,
              ...(eng.source != null && { source: ENG_SOURCES[eng.source] || `source-${eng.source}` }),
              skill: { id: eng.skillId || fullEng?.skillId, name: eng.skillName || fullEng?.skillName },
              ...(extracted.phones.length && { phones: extracted.phones }),
              ...(extracted.urls.length && { externalUrls: extracted.urls }),
            },
            ...(entryPoints.length && { entryPoints }),
          };
        })
      );

      const trace = {
        account: { id: state.accountId, name: state.accountName },
        ...(targetConnector && {
          connector: {
            name: targetConnector.client_name,
            clientId: targetConnector.client_id,
            enabled: targetConnector.enabled,
          },
        }),
        matches: routes.length,
        routes,
      };

      return text(JSON.stringify(trace, null, 2));
    },
  };
}

/** Extract phone numbers and external URLs from engagement display HTML */
function extractFromHtml(eng) {
  const phones = new Set();
  const urls = new Set();
  if (!eng?.displayInstances) return { phones: [], urls: [] };

  for (const di of eng.displayInstances) {
    const html = di.presentation?.html || '';
    for (const m of html.matchAll(/whatsapp\.com\/send\/?\?phone=(\d+)/gi)) phones.add(`+${m[1]}`);
    for (const m of html.matchAll(/tel:([+\d-]+)/gi)) phones.add(m[1]);
    for (const m of html.matchAll(/href="(https?:\/\/[^"]+)"/gi)) {
      const u = m[1].replace(/&amp;/g, '&');
      if (!/liveperson|lpsnmedia|lpcdn/.test(u)) urls.add(u);
    }
  }

  return { phones: [...phones], urls: [...urls] };
}

function text(t) { return { content: [{ type: 'text', text: t }] }; }
function error(t) { return { content: [{ type: 'text', text: t }], isError: true }; }
