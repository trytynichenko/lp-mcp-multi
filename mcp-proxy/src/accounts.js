/**
 * Account management — loads accounts.json, resolves names, manages artifacts dirs.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

export class AccountManager {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.accountsFile = join(projectRoot, 'accounts.json');
    this.accountsDir = join(projectRoot, 'accounts');
    this.lastAccountFile = join(projectRoot, '.last-account');
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

  /** Resolve an input string (ID, name, or alias) to a full account config */
  resolve(input) {
    const accounts = this.loadAll();
    const needle = input.toLowerCase().trim();

    // Exact ID match
    if (accounts[input]) {
      return { accountId: input, ...accounts[input] };
    }

    // Alias match (exact, case-insensitive)
    for (const [id, cfg] of Object.entries(accounts)) {
      const aliases = (cfg.aliases || []).map(a => a.toLowerCase());
      if (aliases.includes(needle)) {
        return { accountId: id, ...cfg };
      }
    }

    // Fuzzy name match: all words in input must appear in the name
    const words = needle.split(/\s+/);
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

  /** Save the last-used account ID */
  saveLastAccount(accountId) {
    writeFileSync(this.lastAccountFile, accountId, 'utf-8');
  }

  /** Get the last-used account ID (or null) */
  getLastAccount() {
    if (!existsSync(this.lastAccountFile)) return null;
    const id = readFileSync(this.lastAccountFile, 'utf-8').trim();
    const accounts = this.loadAll();
    return accounts[id] ? id : null;
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
