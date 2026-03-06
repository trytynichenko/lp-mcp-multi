# Prompt Cookbook

Quick-reference prompt examples for the LP MCP tools. Copy-paste or adapt for your workflow.

## Account Management

```
Show me the current account
List all configured accounts
Switch to the dev account
Switch to 12345678
```

## Account Summary & Audit

```
Give me a full summary of this account
Show me a summary of skills, bots, and flows only
Run a full account audit and save the report
How many open conversations are there right now?
List all installed apps on this account
Show me all agent groups and their members
```

## Campaign & Skill Tracing

```
Trace the WhatsApp routing chain
Trace the SMS routing chain end to end
Which campaigns route to the sales skill?
Show me everything connected to the support skill
Show me the full skill map for this account
Which skills are orphaned (no agents, no routing)?
Which skills have only bot agents assigned?
Trace campaign 12345 — show the full stack from entry point to skill
```

## Conversation Analytics

```
Show conversation analytics for the last 7 days grouped by skill
Show analytics grouped by source for the past month
What's the MCS distribution by agent group this week?
Show me hourly conversation volume for yesterday
How many conversations came through WhatsApp vs SMS last week?
Compare conversation volume by skill for the last 30 days
```

## Conversation Simulator

```
Create a test conversation on the support skill
Create a conversation on skill 12345 with the message "Hi, I need help"
Send "yes, please proceed" to conversation abc-123 and wait for the bot response
Show me all conversations I created in this session
Get the full message history for conversation abc-123
Close conversation abc-123
```

### Bot Testing Flow

```
List the bots on this account — which ones have a Gen AI flow?
Create a test conversation on the support skill and say "Hi, I need help with my order"
[continue the conversation with the bot until it completes the intake]
Close the conversation and show me the full transcript
```

## FaaS Functions

```
List all FaaS functions on this account
Show me the source code for the routing function
Pull all FaaS functions to local storage
What changed in FaaS since the last pull?
Show me the diff for the escalation handler function
```

## Bot Investigation

```
Run a health check on the Main Router bot
Give me a summary of all production bots
Audit all bots — find misconfigurations
Show me the debug logs for conversation abc-123
What integrations does the FAQ bot use?
```

## AI Studio Flows

```
List all AI Studio flows
Summarize the intake flow — show nodes, LLM config, and routes
Audit the triage flow for structural issues
Test the routing flow with the message "I want to cancel my order"
```

## Knowledge Bases

```
List all knowledge bases
How many articles are in the FAQ knowledge base?
Search the support KB for "refund policy"
Run an optimization check on the main KB
```

## Campaigns & Engagements

```
List all campaigns with a summary
Show me engagement details for engagement 12345
Which engagements have WhatsApp phone numbers?
Find stale campaigns that can be cleaned up (dry run)
```

## Changelog

```
Show me the recent changelog for this account
What changes were made today?
```

## Multi-Account Workflows

```
Switch to prod, pull all FaaS functions, then switch to dev and compare
Show me the skill map on the prod account, then switch to staging and compare
Run a summary on each account and tell me which ones have orphaned skills
```

## Full Audit Workflow

```
Run a complete account audit:
1. Account summary (all sections)
2. Bot health checks for all production bots
3. Flow audits for all AI Studio flows
4. KB optimization checks
5. Campaign trace for all channels
6. Skill map with orphaned skill detection
7. FaaS diff against last pull
Save everything to artifacts.
```
