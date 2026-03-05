# LP Multi-Account MCP Server

A multi-account MCP server for LivePerson Solution Architects. Wraps `@lpextend/mcp-server` and adds instant account switching, FaaS function management, and per-account artifact storage. Helps with daily routine tasks across multiple LP accounts: auditing, scoping, debugging, configuration changes, and document generation.

## Safety First — Production Account Access

This agent may be connected to **production accounts**. Treat every account as production unless explicitly told otherwise.

1. **READ operations are free** — query any data without asking permission
2. **WRITE/UPDATE/DELETE operations ALWAYS require explicit user confirmation** — before ANY mutating action, describe exactly what will change and ask "Should I proceed?"
3. **Never guess or assume** — if unsure which account, skill, bot, or flow the user means, ask
4. **One account at a time** — always be clear which account you're connected to
5. **Verify before destructive actions** — double-check account ID and target resource before deletes or overwrites

### Confirmation Format
Before any write operation, present:
```
WRITE OPERATION on account <id> (<name>):
Action: <tool>.<action>
Details: <what exactly will be created/changed/deleted>
Proceed? (yes/no)
```

## Account Management

### Project Structure
```
lp-mcp-multi/
  accounts.json         # All account credentials (git-ignored)
  .mcp.json             # MCP server config (multi-client)
  INSTRUCTIONS.md       # Agent instructions (tool-agnostic)
  CLAUDE.md             # Claude Code pointer to INSTRUCTIONS.md
  README.md             # Setup guide + documentation
  mcp-proxy/            # Multi-account MCP proxy server
    src/
      index.js          # Entry point — loads tools, starts server
      accounts.js       # Account loading, name/alias resolution, last-account persistence
      auth.js           # LP login, bearer tokens, CSDS domains (auto-retry on 401)
      lp-child.js       # LP MCP child process lifecycle (LP_TOOLS filtering)
      tools/
        account.js      # account_switch, account_list, account_current
        faas.js         # faas_functions (list, get, pull_all, diff)
        summary.js      # account_summary (full account snapshot)
        changelog.js    # changelog_log, changelog_view (local audit log)
    package.json
  accounts/
    <account_id>/
      artifacts/        # All generated outputs (git-ignored)
        audits/         # Account/bot/flow audits, health checks
        bots/           # Bot exports and copies
        faas/           # FaaS function exports
        flows/          # AI Studio flow exports
        kb/             # Knowledge base exports
        campaigns/      # Campaign stack exports
        backups/        # Full account backups
        docs/           # Excel deliverables, test plans
```

### Switching Accounts
The user can refer to accounts by **ID**, **name** (case-insensitive, multi-word matching), or **alias**.
When the user asks to work on a specific account:
1. Call `account_switch` with the account ID, name, or alias — switching is instant, no restart needed
2. The proxy kills the old LP MCP child and spawns a new one with the new credentials
3. The last-used account is remembered across sessions (stored in `.last-account`)
4. Always announce: "Connected to account <id> (<name>)"

Examples: "acme prod", "dev", "test", "90862799" all work as input (IDs, names, and aliases).

To see the current account: call `account_current`
To list all accounts: call `account_list`

### accounts.json Format
```json
{
  "<account_id>": {
    "name": "Brand Name",
    "login": "bot_login_name",
    "appKey": "...",
    "secret": "...",
    "accessToken": "...",
    "accessTokenSecret": "...",
    "aliases": ["short", "alias"],
    "tools": "core,cb,ai,kai"
  }
}
```

**OAuth 1.0 accounts** — fill in all four key fields (`appKey`, `secret`, `accessToken`, `accessTokenSecret`).

**OAuth 2.0 accounts** — set `appKey` to the client ID, `secret` to the client secret, and use `"hint"` for both `accessToken` and `accessTokenSecret`:
```json
{
  "24831960": {
    "name": "My Account",
    "login": "bot_login_name",
    "appKey": "<client_id>",
    "secret": "<client_secret>",
    "accessToken": "hint",
    "accessTokenSecret": "hint"
  }
}
```

**Optional fields:**
- `aliases` — array of short names for quick switching (e.g. `["prod", "dev"]`). Matched case-insensitively.
- `tools` — comma-separated LP tool groups to load for this account (e.g. `"core,cb,ai"`). Default: all groups. Groups: `core`, `extra`, `conv`, `kai`, `cb`, `ai`, `auth`, `demo`, `composite`, `web`.

### Adding a New Account
The user must:
1. Create a bot user in LP Conversational Cloud (Users → Add → Bot type → Administrator profile)
2. Generate API keys on the bot user profile
3. Add an entry to `accounts.json` with the credentials
4. The proxy picks up new accounts automatically — no restart needed

## Write Protection Rules

**NEVER execute these MCP actions without explicit user confirmation:**

### Account Config (writes)
- `ac_skills`: create, create_batch, delete
- `ac_users`: create, update
- `ac_lobs`: create, create_batch, delete
- `ac_entry_points`: create
- `ac_windows`: create, update
- `ac_workdays`: create, update, delete
- `ac_special_occasions`: create, update, delete
- `ac_auto_messages`: update
- `ac_predefined_content`: create, delete
- `ac_predefined_categories`: create, delete
- `ac_agent_status`: create, delete

### Campaigns (writes)
- `ac_campaigns`: create, delete
- `ac_engagements`: create, update, delete

### Conversation Builder (writes)
- `cb_bots`: create, delete
- `cb_dialogs`: create, update, delete, duplicate
- `cb_interactions`: create, update, delete, reorder
- `cb_integrations`: create, update, delete
- `cb_global_functions`: save
- `cb_deploy`: assign_agent, delete_agent, start, stop, deploy

### AI Studio (writes)
- `ai_flows`: create, clone, update, delete
- `ai_prompts`: create, update
- `ai_conversations`: create, delete
- `ai_categories`: create, delete

### Knowledge AI (writes)
- `kai_knowledgebases`: create, refresh
- `kai_articles`: create, update, create_batch, enable

### Conversations (writes)
- `conv_manage`: close, close_all, transfer, send_message

### Auth (writes)
- `auth_apps`: install, update, delete

### Composites (ALL require confirmation — they create/modify resources)
- `composite_campaign_stack`
- `composite_kai_kb`
- `composite_deploy_bot`
- `composite_wire_cb_bot`
- `composite_teardown_demo`
- `composite_cleanup_campaigns`
- `workflow_create_demo`
- `composite_web_crawl_to_kb`

## Capabilities

### Account Summary (Read-Only)
- `account_summary`: Single-call snapshot — skills, LOBs, users, bots, flows, KBs, campaigns, channels (messaging connectors: WhatsApp, SMS, Facebook, etc.), apps, FaaS, conversations. Use `sections` param to limit scope.

### Account Audit (Read-Only)
Gather comprehensive account data:
- Bots (CB): `cb_bots: list` → filter PROD → `cb_bot_health_check` per bot → `cb_integrations: list` → `cb_global_functions: get`
- AI Studio: `ai_flows: list` → `composite_flow_summary` per flow
- Knowledge: `kai_knowledgebases: list` → `kai_articles: list`
- Campaign stack: `ac_campaigns: list_summary`, `ac_engagements: list`, `ac_entry_points: list`, `ac_windows: list`
- Account config: `ac_skills: list`, `ac_lobs: list`, `ac_users: list_summary`, `ac_lookup: agent_groups, profiles, installations, connectors`
- Schedules: `ac_workdays: list`, `ac_special_occasions: list`
- Auth apps: `auth_apps: list`
- Conversations: `conv_manage: search`

### Bot Investigation & Debugging
- `cb_bot_health_check`: Full bot health in one call
- `composite_bot_summary`: Compact bot digest
- `composite_bot_audit`: Find misconfigurations
- `composite_describe_bot`: Auto-generate descriptions
- `cb_logs`: Debug logs for specific conversations

### Flow Analysis
- `composite_flow_summary`: Node topology, LLM config, routes
- `composite_flow_audit`: Structural issues
- `composite_describe_flow`: Auto-generate descriptions
- `composite_route_test_suite`: Automated routing QA
- `ai_flows: invoke`: Test a flow with a message

### Knowledge Base Management
- `composite_optimise_kb`: Health score and recommendations
- `kai_knowledgebases: search`: Test KB retrieval
- `composite_web_crawl_to_kb`: Build KB from website (WRITE — needs confirmation)

### Campaign & Engagement Management
- `ac_campaigns: list_summary` / `get`: Campaign details
- `ac_engagements: list` / `get`: Engagement config (get auto-extracts phone numbers and URLs from HTML as `_extractedPhones` / `_extractedUrls`)
- `composite_campaign_trace`: Trace the full routing chain for a channel, skill, or campaign — returns connector → campaign → engagement (with phones/URLs) → entry point (with URL patterns) → skill. Use `channel` (whatsapp, sms, facebook, etc.), `skill`, or `campaignId` as filter.
- `composite_cleanup_campaigns`: Find stale campaigns (dry-run is read-only, delete needs confirmation)

### Conversation Management
- `conv_manage: search`: Find conversations (default: OPEN, last 24h). Add `compact: true` for lightweight results (strips message records, keeps conversation info only — source, skill, status, duration, MCS, campaign).
- `conv_manage: get_transcript`: Read conversation history
- Close/transfer/message: WRITE — needs confirmation

### Account Backup
- `composite_backup_account`: Full config snapshot (read-only)
- Save to `accounts/<account_id>/artifacts/backups/backup_<date>.json`

### FaaS Management
- `faas_functions: list`: Summary of all functions
- `faas_functions: get`: Full function with source code
- `faas_functions: pull_all`: Export all functions to `artifacts/faas/`
- `faas_functions: diff`: Compare a local export against the live version (requires prior `pull_all`)

### Changelog
- `changelog_log`: Append an entry after any write operation (action + details)
- `changelog_view`: View recent changelog entries (default last 20)
- Changelog is saved to `accounts/<account_id>/artifacts/changelog.md`
- After any confirmed write operation, call `changelog_log` to record it

### Demo Building (all WRITE — need confirmation)
- `workflow_create_demo`: End-to-end demo
- `composite_campaign_stack`: Campaign + engagement stack
- `composite_deploy_bot`: Deploy a bot
- `composite_wire_cb_bot`: Connect CB bot to AI Studio flow

## Output & Artifacts

Save all outputs to `accounts/<account_id>/artifacts/` using the subfolder structure defined above.

- Create subfolders automatically as needed — don't dump everything in the root
- Use descriptive filenames: `audit_<date>.md`, `Custom_Solutions_<acct>.xlsx`, `Test_Plan_<acct>.xlsx`
- For quick reports, output markdown directly; for formal deliverables, generate Excel

## Session Start

When a conversation begins:
1. Call `account_current` to show which account is active
2. If the user mentions a specific account, call `account_switch`
3. Briefly state what you can help with
