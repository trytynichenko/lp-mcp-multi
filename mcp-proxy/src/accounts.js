/**
 * Account management — loads accounts.json, resolves names, manages artifacts dirs.
 */

import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

export class AccountManager {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.accountsFile = join(projectRoot, 'accounts.json');
    this.accountsDir = join(projectRoot, 'accounts');
  }

  /** Load all accounts from accounts.json */
  loadAll() {
    if (!existsSync(this.accountsFile)) return {};
    return JSON.parse(readFileSync(this.accountsFile, 'utf-8'));
  }

  /** Get accounts as a flat list */
  list() {
    const accounts = this.loadAll();
    return Object.entries(accounts).map(([id, cfg]) => ({
      accountId: id,
      name: cfg.name || '',
      login: cfg.login || '',
    }));
  }

  /** Resolve an input string (ID or name) to a full account config */
  resolve(input) {
    const accounts = this.loadAll();

    // Exact ID match
    if (accounts[input]) {
      return { accountId: input, ...accounts[input] };
    }

    // Case-insensitive match: all words in input must appear in the name
    const words = input.toLowerCase().split(/\s+/);
    const matches = Object.entries(accounts)
      .filter(([, cfg]) => {
        const name = cfg.name?.toLowerCase() || '';
        return words.every(w => name.includes(w));
      })
      .map(([id, cfg]) => ({ accountId: id, ...cfg }));

    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(
        `Multiple accounts match '${input}': ${matches.map(a => `${a.accountId} (${a.name})`).join(', ')}`
      );
    }

    const available = Object.entries(accounts)
      .map(([id, cfg]) => `${id} (${cfg.name})`)
      .join(', ');
    throw new Error(`No account found matching '${input}'. Available: ${available}`);
  }

  /** Ensure an artifacts subdirectory exists, returns the path */
  ensureArtifactsDir(accountId, sub) {
    const dir = sub
      ? join(this.accountsDir, accountId, 'artifacts', sub)
      : join(this.accountsDir, accountId, 'artifacts');
    mkdirSync(dir, { recursive: true });
    return dir;
  }
}
