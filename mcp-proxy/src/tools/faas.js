/**
 * FaaS tools — list, get (with code), pull_all (export to artifacts).
 *
 * Calls the LP FaaS API directly via the faasUI CSDS domain:
 *   GET /lambdas           — list all functions
 *   GET /lambdas?name=X    — get function by name (includes code)
 *   GET /lambdas/{uuid}    — get function by UUID (includes code)
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

export const tools = [
  {
    name: 'faas_functions',
    description:
      'Manage LivePerson Functions (FaaS): list, get (with source code), pull_all (export all to artifacts/faas/), ' +
      'or diff (compare local export against live version).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'get', 'pull_all', 'diff'],
          description:
            'list: summary of all functions. get: full function with code. ' +
            'pull_all: export all to artifacts/faas/. diff: compare local vs live (requires prior pull_all).',
        },
        name: { type: 'string', description: 'get/diff: function name (exact match)' },
        uuid: { type: 'string', description: 'get: function UUID (alternative to name)' },
        fields: { type: 'string', description: 'list: comma-separated fields (e.g. "name,state,eventId")' },
      },
      required: ['action'],
    },
  },
];

export function register(ctx) {
  const { auth, accountManager, state } = ctx;

  async function faasGet(path, additionalParams = '') {
    return auth.fetch(state.accountId, 'faasUI', path, { additionalParams });
  }

  return {
    faas_functions: async (args) => {
      if (!state.accountId) return error('No account connected. Use account_switch first.');

      switch (args.action) {
        case 'list': {
          const lambdas = await faasGet('/lambdas');
          const fields = args.fields?.split(',').map(f => f.trim());
          const summary = lambdas.map(fn => {
            if (fields) {
              const obj = {};
              for (const f of fields) obj[f] = fn[f];
              return obj;
            }
            return {
              name: fn.name,
              uuid: fn.uuid,
              state: fn.state,
              eventId: fn.eventId || 'none',
              lastModified: fn.updatedAt ? new Date(fn.updatedAt).toISOString() : '',
              lastModifiedBy: fn.updatedBy || '',
            };
          });
          return text(JSON.stringify(summary, null, 2));
        }

        case 'get': {
          if (!args.name && !args.uuid) return error('Provide name or uuid');
          let lambdas;
          if (args.name) {
            lambdas = await faasGet('/lambdas', `&name=${encodeURIComponent(args.name)}`);
          } else {
            lambdas = await faasGet(`/lambdas/${args.uuid}`);
          }
          if (!lambdas || lambdas.length === 0) return error('Function not found');
          return text(JSON.stringify(formatFunction(lambdas[0]), null, 2));
        }

        case 'pull_all': {
          const lambdas = await faasGet('/lambdas');
          const faasDir = accountManager.ensureArtifactsDir(state.accountId, 'faas');
          const pulled = [];

          for (const fn of lambdas) {
            const full = await faasGet('/lambdas', `&name=${encodeURIComponent(fn.name)}`);
            const detail = full[0];
            if (!detail) continue;

            const fnDir = join(faasDir, detail.name);
            mkdirSync(fnDir, { recursive: true });

            writeFileSync(
              join(fnDir, 'index.js'),
              detail.implementation?.code || '// no code',
              'utf-8',
            );

            writeFileSync(
              join(fnDir, 'config.json'),
              JSON.stringify({
                name: detail.name,
                uuid: detail.uuid,
                description: detail.description || '',
                state: detail.state,
                eventId: detail.eventId || '',
                runtime: detail.runtime?.name || '',
                environmentVariables: detail.implementation?.environmentVariables || [],
                dependencies: detail.implementation?.dependencies || [],
                lastModified: detail.updatedAt ? new Date(detail.updatedAt).toISOString() : '',
                lastModifiedBy: detail.updatedBy || '',
              }, null, 2),
              'utf-8',
            );

            pulled.push(`${detail.name} (${detail.state})`);
          }

          return text(
            `Pulled ${pulled.length} functions to accounts/${state.accountId}/artifacts/faas/\n\n` +
            pulled.join('\n')
          );
        }

        case 'diff': {
          if (!args.name) return error('Provide function name for diff');
          const faasDir = join(accountManager.ensureArtifactsDir(state.accountId, 'faas'), args.name);
          const localCodePath = join(faasDir, 'index.js');
          const localConfigPath = join(faasDir, 'config.json');

          if (!existsSync(localCodePath)) {
            return error(`No local export found for "${args.name}". Run pull_all first.`);
          }

          // Fetch live version
          const lambdas = await faasGet('/lambdas', `&name=${encodeURIComponent(args.name)}`);
          if (!lambdas || lambdas.length === 0) return error('Function not found on account');
          const live = lambdas[0];
          const liveCode = live.implementation?.code || '';
          const localCode = readFileSync(localCodePath, 'utf-8');

          const diffs = [];

          // Compare code
          if (localCode.trim() !== liveCode.trim()) {
            diffs.push('CODE: changed');
          }

          // Compare config fields
          if (existsSync(localConfigPath)) {
            const localConfig = JSON.parse(readFileSync(localConfigPath, 'utf-8'));
            const liveEnvVars = JSON.stringify(live.implementation?.environmentVariables || []);
            const localEnvVars = JSON.stringify(localConfig.environmentVariables || []);
            if (liveEnvVars !== localEnvVars) diffs.push('ENV VARS: changed');
            if ((live.state || '') !== (localConfig.state || '')) diffs.push(`STATE: ${localConfig.state} → ${live.state}`);
            if ((live.description || '') !== (localConfig.description || '')) diffs.push('DESCRIPTION: changed');
            const liveDeps = JSON.stringify(live.implementation?.dependencies || []);
            const localDeps = JSON.stringify(localConfig.dependencies || []);
            if (liveDeps !== localDeps) diffs.push('DEPENDENCIES: changed');

            const liveModified = live.updatedAt ? new Date(live.updatedAt).toISOString() : '';
            if (liveModified !== (localConfig.lastModified || '')) {
              diffs.push(`LAST MODIFIED: ${localConfig.lastModified || 'unknown'} → ${liveModified} (by ${live.updatedBy || 'unknown'})`);
            }
          }

          if (diffs.length === 0) {
            return text(`${args.name}: no changes (local matches live)`);
          }
          return text(`${args.name}: ${diffs.length} difference(s)\n\n${diffs.join('\n')}`);
        }

        default:
          return error(`Unknown action: ${args.action}`);
      }
    },
  };
}

function formatFunction(fn) {
  return {
    name: fn.name,
    uuid: fn.uuid,
    state: fn.state,
    description: fn.description || '',
    eventId: fn.eventId || 'none',
    runtime: fn.runtime?.name || '',
    lastModified: fn.updatedAt ? new Date(fn.updatedAt).toISOString() : '',
    lastModifiedBy: fn.updatedBy || '',
    environmentVariables: fn.implementation?.environmentVariables || [],
    dependencies: fn.implementation?.dependencies || [],
    code: fn.implementation?.code || '',
  };
}

function text(t) { return { content: [{ type: 'text', text: t }] }; }
function error(t) { return { content: [{ type: 'text', text: t }], isError: true }; }
