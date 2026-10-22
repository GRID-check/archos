# Platform agent door runbook

For GRID platform operators who want their own agent (Claude, Cursor) to work
the operator console. The decision is ADR-0126; the mechanics are in
[`../architecture/agent-surface.md`](../architecture/agent-surface.md#the-platform-door-a-second-server).

## Switch it on, once per environment

1. In the WorkOS dashboard, register `https://<app-host>/api/platform/mcp` as a
   Resource Indicator, beside the office doors' two.
2. Create the feature flag `platform-agent-mcp`, off for all organizations.
3. Turn it on for the **GRID Platform organization** only. Targeting an office
   does nothing: the door refuses every other organization's token before it
   reads the flag.

No environment variable is needed. The door's URL is the origin of
`GRID_MCP_RESOURCE_URL` (or of `WORKOS_REDIRECT_URI`) plus `/api/platform/mcp`;
check it at `https://<app-host>/.well-known/oauth-protected-resource/api/platform/mcp`,
which answers 200 with that `resource`, or 503 while `WORKOS_AUTHKIT_DOMAIN` is unset.

## Connect a client

The URL is `https://<app-host>/api/platform/mcp`. When the browser opens to sign
in, pick the **GRID Platform** organization; a token issued in an office is
refused with 403.

```bash
claude mcp add --transport http piloti-platform https://<app-host>/api/platform/mcp
```

Cursor and Claude Desktop take the same URL as the office door does
([`../user-guides/connect-your-agent.md`](../user-guides/connect-your-agent.md)).
To work an office and the console from one client, add both servers; each signs
in on its own.

## What it can do

The console's operations only (`platform-*`), as the person who signed in. Each
runs its console route, so the permission decides as in the browser: Platform
Support's agent reads and its writes come back 403. Fleet-wide writes (models,
reasoning, retrieval, prices, the norm registry, re-ingest, the kill switch,
deletes) are marked destructive, so the client asks before each one.

## When it refuses

| Answer | Cause |
|---|---|
| 401 `invalid_token` | No token, an expired one, or a token for an office door (`/api/mcp`, `/api/a2a`). Sign in again to this URL |
| 403 "takes tokens of the GRID Platform organization only" | The sign-in picked an office. Sign in again in GRID Platform |
| 403 "not enabled" | `platform-agent-mcp` is off for the GRID Platform organization |
| 403 "no platform permission" | The person holds no platform role |
| 503 | WorkOS did not answer, or the platform organization is not provisioned. Retry; then check `GRID_PLATFORM_ORG_EXTERNAL_ID` |
| 429 | The person's agent budget (`mcp-request`), shared with their office door |

Every call is in PostHog (`agent_operation_called`, `door: platform`) and in
Langfuse (`agent-tool-call`, tag `door:platform`).
