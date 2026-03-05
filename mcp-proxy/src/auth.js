/**
 * LP Auth — handles login, bearer token caching, CSDS domain resolution.
 * Used by custom tools (FaaS, etc.) that call LP APIs directly.
 */

const CSDS_URL = 'https://api.liveperson.net/api/account';
const TOKEN_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry

export class LPAuth {
  constructor(accountManager) {
    this.accountManager = accountManager;
    this.cache = {};  // keyed by accountId
  }

  /** Get auth for the given account (login if needed, cache the result) */
  async getAuth(accountId) {
    const cached = this.cache[accountId];
    if (cached && Date.now() < cached.expiresAt) {
      return cached;
    }

    const accounts = this.accountManager.loadAll();
    const creds = accounts[accountId];
    if (!creds) throw new Error(`Account ${accountId} not found in accounts.json`);

    // Resolve all CSDS domains
    const csdsResp = await fetch(`${CSDS_URL}/${accountId}/service/baseURI.json?version=1.0`);
    if (!csdsResp.ok) throw new Error(`CSDS lookup failed: ${csdsResp.status}`);
    const csdsData = await csdsResp.json();
    const domains = {};
    for (const entry of csdsData.baseURIs) {
      domains[entry.service] = entry.baseURI;
    }

    // Login via agentVep
    const agentVep = domains['agentVep'];
    if (!agentVep) throw new Error('Could not resolve agentVep domain');

    const loginResp = await fetch(`https://${agentVep}/api/account/${accountId}/login?v=1.3`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: creds.login,
        appKey: creds.appKey,
        secret: creds.secret,
        accessToken: creds.accessToken,
        accessTokenSecret: creds.accessTokenSecret,
      }),
    });
    if (!loginResp.ok) {
      const body = await loginResp.text().catch(() => '');
      throw new Error(`Login failed (${loginResp.status}): ${body}`);
    }
    const loginData = await loginResp.json();

    const auth = {
      accountId,
      bearer: loginData.bearer,
      userId: loginData.config?.userId || '',
      expiresAt: Date.now() + ((loginData.sessionTTl || 3600) * 1000) - TOKEN_BUFFER_MS,
      domains,
    };

    this.cache[accountId] = auth;
    return auth;
  }

  /** Invalidate cached auth for an account */
  invalidate(accountId) {
    delete this.cache[accountId];
  }

  /** Helper: make an authenticated GET/POST to an LP API */
  async fetch(accountId, csdsDomain, path, { method = 'GET', body, additionalParams = '' } = {}) {
    const auth = await this.getAuth(accountId);
    const domain = auth.domains[csdsDomain];
    if (!domain) throw new Error(`CSDS domain '${csdsDomain}' not available`);

    const url = `https://${domain}/api/account/${accountId}${path}?userId=${auth.userId}&v=1${additionalParams}`;
    const opts = {
      method,
      headers: {
        'Authorization': `Bearer ${auth.bearer}`,
        'Content-Type': 'application/json',
        'user-agent': 'lp-mcp-proxy',
      },
    };
    if (body) opts.body = JSON.stringify(body);

    const resp = await fetch(url, opts);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`API ${method} ${path} → ${resp.status}: ${text || resp.statusText}`);
    }
    return resp.json();
  }
}
