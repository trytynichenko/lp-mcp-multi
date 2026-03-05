/**
 * LP Child — manages the @lpextend/mcp-server child process.
 * Spawns it with the right env vars, proxies tool calls, handles reconnect.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const LP_MCP_VERSION = '0.10.4';

export class LPChild {
  constructor() {
    this.client = null;
    this.transport = null;
    this.tools = [];
  }

  /** Spawn the LP MCP server with credentials for the given account */
  async spawn(account) {
    await this.kill();

    const env = {
      ...process.env,
      LP_ACCOUNT_ID: account.accountId,
      LP_LOGIN_NAME: account.login,
      LP_APP_KEY: account.appKey,
      LP_SECRET: account.secret,
      LP_ACCESS_TOKEN: account.accessToken,
      LP_ACCESS_TOKEN_SECRET: account.accessTokenSecret,
    };

    // Pass LP_TOOLS filter if configured on the account
    if (account.tools) env.LP_TOOLS = account.tools;

    this.transport = new StdioClientTransport({
      command: 'npx',
      args: [`@lpextend/mcp-server@${LP_MCP_VERSION}`],
      env,
    });

    this.client = new Client({ name: 'lp-mcp-proxy', version: '1.0.0' });
    await this.client.connect(this.transport);

    const result = await this.client.listTools();
    this.tools = result.tools || [];
  }

  /** Kill the child process */
  async kill() {
    if (this.client) {
      try { await this.client.close(); } catch { /* ignore */ }
      this.client = null;
    }
    if (this.transport) {
      try { await this.transport.close(); } catch { /* ignore */ }
      this.transport = null;
    }
    this.tools = [];
  }

  /** Call a tool on the child, returns MCP result */
  async callTool(name, args) {
    if (!this.client) throw new Error('LP child not connected');
    return this.client.callTool({ name, arguments: args });
  }

  get isConnected() {
    return this.client !== null;
  }
}
