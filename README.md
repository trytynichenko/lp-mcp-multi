# LP Multi-Account MCP Server

A multi-account MCP server for LivePerson Solution Architects. Wraps [`@lpextend/mcp-server`](https://www.npmjs.com/package/@lpextend/mcp-server) and adds instant account switching, FaaS function management, and per-account artifact storage.

Works with **Claude Code, Cursor, VS Code Copilot, OpenAI Codex, Gemini CLI, Windsurf**, and any MCP-compatible client.

## Why this proxy?

The official [`@lpextend/mcp-server`](https://www.npmjs.com/package/@lpextend/mcp-server) supports one account at a time, configured via environment variables. Switching accounts means changing env vars and restarting the server.

This proxy wraps it and adds:

- **Instant account switching** — all credentials in one file, switch mid-conversation with no restart
- **FaaS management** — list functions, read source code, bulk export — not available in the original
- **Account summary** — single-call snapshot of the entire account (skills, bots, flows, KBs, campaigns, apps, FaaS, conversations)
- **Per-account artifacts** — organized storage for audits, exports, and deliverables

Everything else (111 LP tools) is proxied through unchanged.

## What it does

- **120 tools** — 111 from the LP MCP server + 9 custom (account management, FaaS, summary, changelog, analytics, conversation simulator)
- **Instant account switching** — switch between accounts in seconds, no restart needed
- **Multi-account** — all credentials in one `accounts.json`, switch between them on the fly
- **FaaS management** — list, read source code, diff, and export all LivePerson Functions
- **Conversation simulator** — create conversations as a consumer, interact with bots, test routing
- **Per-account artifacts** — audits, backups, exports stored in `accounts/<id>/artifacts/`

## Quick start

### 1. Prerequisites

- Node.js 18+
- An MCP-compatible AI coding tool
- One or more LivePerson accounts with bot API keys

### 2. Clone and install

```bash
git clone <repo-url>
cd lp-mcp-multi
cd mcp-proxy && npm install && cd ..
```

### 3. Add your accounts

Create `accounts.json` in the project root:

```json
{
  "12345678": {
    "name": "Acme Corp",
    "login": "bot_user",
    "appKey": "your-app-key",
    "secret": "your-secret",
    "accessToken": "your-access-token",
    "accessTokenSecret": "your-access-token-secret"
  },
  "87654321": {
    "name": "Beta Inc",
    "login": "bot_user",
    "appKey": "...",
    "secret": "...",
    "accessToken": "...",
    "accessTokenSecret": "..."
  }
}
```

**Optional fields:**
- `aliases` — array of short names for quick switching (e.g. `["prod", "dev"]`)
- `tools` — comma-separated LP tool groups to load (e.g. `"core,cb,ai"`)
- `connectorAppId` / `connectorSecret` — app installation credentials for `conv_simulate` (if omitted, auto-discovered from installed apps with `msg.consumer` scope)

To get the base credentials:
1. Log in to Conversational Cloud
2. Go to **Users** > **Add user** > set type to **Bot** > assign **Administrator** profile
3. Generate API keys on the bot user's profile page

### 4. Register with your AI tool

#### Claude Code

```bash
claude mcp add liveperson -- node /path/to/lp-mcp-multi/mcp-proxy/src/index.js
```

Or drop a `.mcp.json` in the project root (already included):

```json
{
  "mcpServers": {
    "liveperson": {
      "command": "node",
      "args": ["mcp-proxy/src/index.js"]
    }
  }
}
```

#### Cursor

Settings > MCP Servers > Add Server:
- **Name:** liveperson
- **Command:** `node /path/to/lp-mcp-multi/mcp-proxy/src/index.js`

#### VS Code + GitHub Copilot

Create `.vscode/mcp.json` in your project:

```json
{
  "servers": {
    "liveperson": {
      "command": "node",
      "args": ["/path/to/lp-mcp-multi/mcp-proxy/src/index.js"]
    }
  }
}
```

#### OpenAI Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.liveperson]
command = "node"
args = ["/path/to/lp-mcp-multi/mcp-proxy/src/index.js"]
```

#### Gemini CLI

Add to your Gemini settings.json:

```json
{
  "mcpServers": {
    "liveperson": {
      "command": "node",
      "args": ["/path/to/lp-mcp-multi/mcp-proxy/src/index.js"]
    }
  }
}
```

#### Windsurf

Settings > MCP > Add Server, same command and args as above.

### 5. Start using

Open your AI tool in the project directory and start talking:

```
"Show me all skills on the Acme Corp account"
"Switch to Beta Inc and list their bots"
"Pull all FaaS functions from this account"
"Run a full audit of the campaign stack"
```

## Custom tools

### Account management

| Tool | Description |
|---|---|
| `account_switch` | Switch accounts by ID or name (e.g. "acme", "87654321") |
| `account_list` | List all configured accounts |
| `account_current` | Show the active account |

### FaaS functions

| Tool | Action | Description |
|---|---|---|
| `faas_functions` | `list` | Summary of all functions (name, state, event, uuid) |
| `faas_functions` | `get` | Full function details + source code (by name or uuid) |
| `faas_functions` | `pull_all` | Export all functions to `accounts/<id>/artifacts/faas/` |

### Account summary

| Tool | Description |
|---|---|
| `account_summary` | Single-call snapshot of the entire account: skills, LOBs, users, bots, AI Studio flows, knowledge bases, campaigns, installed apps, FaaS functions, and open conversations. Pass `sections` to limit (e.g. `"skills,bots,flows"`). |

### Changelog

| Tool | Description |
|---|---|
| `changelog_log` | Append an entry after any write operation (action + details) |
| `changelog_view` | View recent changelog entries (default last 20) |

### Conversation analytics

| Tool | Description |
|---|---|
| `conv_analytics` | Aggregated conversation statistics — group by `source`, `skill`, `agentGroup`, `day`, or `hour`. Returns counts, avg duration, MCS distribution. |

### Conversation simulator

| Tool | Action | Description |
|---|---|---|
| `conv_simulate` | `create` | Open a new conversation as consumer, optionally send initial message |
| `conv_simulate` | `send` | Send a consumer message (supports `wait` for bot response) |
| `conv_simulate` | `close` | Close a conversation from consumer side |
| `conv_simulate` | `list` | Show all conversations created in this session |
| `conv_simulate` | `history` | Retrieve messages from a conversation |

Uses the Messaging REST API with AppJWT + ConsumerJWS auth. Auto-discovers a suitable app installation (`msg.consumer` scope). Supports custom consumer identity, rich content, campaign attribution, and bot response polling.

### Proxied LP tools (111)

All tools from `@lpextend/mcp-server` are proxied through:
Conversation Builder, AI Studio, Knowledge AI, Campaigns, Account Config, Conversations, Auth, Composites, Demo Wizard, and Web Crawl.

See the [LP MCP Server docs](https://storage.googleapis.com/lp-shared-content/lp-extend-mcp/lp-extend-mcp.html) for the full tool catalog.

## Project structure

```
lp-mcp-multi/
  accounts.json              # All account credentials (git-ignored)
  .mcp.json                  # MCP server config (for tools that read it)
  mcp-proxy/                 # Multi-account MCP proxy server
    src/
      index.js               # Entry point — loads tools, starts server
      accounts.js             # Account loading and name resolution
      auth.js                 # LP login, bearer tokens, CSDS domains
      lp-child.js             # LP MCP child process lifecycle
      tools/
        account.js            # account_switch, account_list, account_current
        faas.js               # faas_functions (list, get, pull_all, diff, diff_all)
        summary.js            # account_summary (full account snapshot)
        changelog.js          # changelog_log, changelog_view
        campaign-trace.js     # composite_campaign_trace (via proxy enrichment)
        skill-trace.js        # composite_skill_trace (via proxy enrichment)
        conv-analytics.js     # conv_analytics (aggregated stats)
        conv-simulate.js      # conv_simulate (consumer-side messaging)
    package.json
  accounts/
    <account_id>/
      artifacts/              # Generated outputs (git-ignored)
        audits/               # Account/bot/flow audits
        bots/                 # Bot exports
        faas/                 # FaaS function exports
        flows/                # AI Studio flow exports
        kb/                   # Knowledge base exports
        campaigns/            # Campaign stack exports
        backups/              # Full account backups
        docs/                 # Excel deliverables
  INSTRUCTIONS.md              # Agent instructions (tool-agnostic)
  CLAUDE.md                   # Claude Code pointer to INSTRUCTIONS.md
```

## Environment variables

| Variable | Description |
|---|---|
| `LP_PROJECT_ROOT` | Override the project root path (default: auto-detected from `src/index.js` location) |

## Adding new tools

Create a new file in `mcp-proxy/src/tools/`:

```js
// tools/my-tool.js
export const tools = [
  {
    name: 'my_tool',
    description: 'What it does',
    inputSchema: { type: 'object', properties: { ... }, required: [...] },
  },
];

export function register(ctx) {
  const { auth, accountManager, state } = ctx;
  return {
    my_tool: async (args) => {
      // your implementation
      return { content: [{ type: 'text', text: 'result' }] };
    },
  };
}
```

Then import and add it to `toolModules` in `src/index.js`:

```js
import * as myTool from './tools/my-tool.js';
const toolModules = [accountTools, faasTools, myTool];
```

## Security

- `accounts.json` is git-ignored — never commit credentials
- `accounts/*/artifacts/` are git-ignored — user-specific outputs
- Each user maintains their own `accounts.json`
- The proxy runs locally — no credentials leave your machine
