/**
 * Changelog tool — append-only local audit log for write operations.
 *
 * Logs to accounts/<accountId>/artifacts/changelog.md
 * Can be called explicitly or by other tools after confirmed writes.
 */

import { appendFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

export const tools = [
  {
    name: 'changelog_log',
    description:
      'Append an entry to the local changelog for the current account. ' +
      'Use after any write/update/delete operation to record what changed.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'The tool/action that was performed (e.g. "ac_skills.create")' },
        details: { type: 'string', description: 'What was created/changed/deleted' },
      },
      required: ['action', 'details'],
    },
  },
  {
    name: 'changelog_view',
    description: 'View the local changelog for the current account. Returns the last N entries (default 20).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of recent entries to show (default 20)' },
      },
    },
  },
];

export function register(ctx) {
  const { accountManager, state } = ctx;

  function changelogPath() {
    return join(accountManager.ensureArtifactsDir(state.accountId), 'changelog.md');
  }

  return {
    changelog_log: async (args) => {
      if (!state.accountId) return error('No account connected.');
      const path = changelogPath();
      const timestamp = new Date().toISOString();
      const header = existsSync(path) ? '' : '# Changelog\n\n';
      const entry = `${header}### ${timestamp}\n- **Account:** ${state.accountId} (${state.accountName})\n- **Action:** ${args.action}\n- **Details:** ${args.details}\n\n`;
      appendFileSync(path, entry, 'utf-8');
      return text(`Logged: ${args.action} — ${args.details}`);
    },

    changelog_view: async (args) => {
      if (!state.accountId) return error('No account connected.');
      const path = changelogPath();
      if (!existsSync(path)) return text('No changelog entries yet.');
      const content = readFileSync(path, 'utf-8');
      const entries = content.split(/(?=^### )/m).filter(e => e.startsWith('### '));
      const limit = args.limit || 20;
      const recent = entries.slice(-limit);
      return text(recent.length > 0 ? recent.join('') : 'No changelog entries yet.');
    },
  };
}

function text(t) { return { content: [{ type: 'text', text: t }] }; }
function error(t) { return { content: [{ type: 'text', text: t }], isError: true }; }
