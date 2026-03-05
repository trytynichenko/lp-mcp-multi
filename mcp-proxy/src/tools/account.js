/**
 * Account management tools — switch, list, current.
 */

export const tools = [
  {
    name: 'account_switch',
    description: 'Switch to a different LP account by ID or name (case-insensitive, multi-word match). Reconnects instantly — no MCP restart needed.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account ID or name (e.g. "delta prod", "90862799", "morgan")' },
      },
      required: ['account'],
    },
  },
  {
    name: 'account_list',
    description: 'List all configured LP accounts.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'account_current',
    description: 'Show which LP account is currently active.',
    inputSchema: { type: 'object', properties: {} },
  },
];

export function register(ctx) {
  const { accountManager, lpChild, auth, state } = ctx;

  return {
    account_switch: async (args) => {
      const account = accountManager.resolve(args.account);
      await lpChild.spawn(account);
      auth.invalidate(state.accountId);
      state.accountId = account.accountId;
      state.accountName = account.name;
      state.accountLogin = account.login;
      accountManager.saveLastAccount(account.accountId);
      return text(
        `Switched to account ${account.accountId} — ${account.name} (login: ${account.login})\n\n` +
        `Ready. ${lpChild.tools.length} LP tools available.`
      );
    },

    account_list: async () => {
      const accounts = accountManager.list();
      const lines = accounts.map(a => {
        const marker = state.accountId === a.accountId ? ' ← active' : '';
        return `${a.accountId} — ${a.name} (login: ${a.login})${marker}`;
      });
      return text(lines.length > 0 ? lines.join('\n') : 'No accounts configured. Add entries to accounts.json.');
    },

    account_current: async () => {
      if (!state.accountId) return text('No account active. Use account_switch to connect.');
      return text(`Active: ${state.accountId} — ${state.accountName} (login: ${state.accountLogin})`);
    },
  };
}

function text(t) { return { content: [{ type: 'text', text: t }] }; }
