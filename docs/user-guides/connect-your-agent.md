# Connect your agent

Your own AI assistant (Claude, ChatGPT, Cursor or any other client that speaks
MCP) can work in Piloti for you: everything you can do in Piloti, with your
rights. It asks you before it changes or deletes anything, and Piloti never gives
it more than you have. How the server works underneath:
[the agent surface](../architecture/agent-surface.md) and
[ADR-0121](../adr/0121-everything-a-person-can-do-an-agent-can-do.md).

You find the short version, with the address to copy, in **Profil → Agent
verbinden**.

## Before you start

Two things must be true, and the profile section tells you which is missing:

1. **Your organization has switched agent access on.** It is off by default and
   is set per organization (the `agent-mcp` feature flag in WorkOS). Without it
   the section shows a notice instead of the address, and a connected client is
   refused with „not enabled for your organization“.
2. **This Piloti installation has the external sign-in set up.** That is a
   one-time step by whoever operates the installation
   ([WorkOS dashboard setup](../architecture/agent-surface.md#workos-dashboard-setup)).
   If it is missing, no assistant can connect, whatever your organization chose.

## The address

Every client needs the same address of Piloti's MCP server:
`https://<your Piloti address>/api/mcp`, for example
`https://app.piloti.at/api/mcp`. The profile section shows yours with a copy
button.

## Connect a client

Menus move around between releases. If a name below does not match what you see,
look for „connectors“, „MCP servers“ or „tools“ in the client's settings.

### Claude (claude.ai and Claude Desktop)

1. Open **Settings → Connectors**.
2. Choose **Add custom connector**.
3. Paste the address and name it Piloti.
4. Sign in with your Piloti account when the browser opens.

### Claude Code

```bash
claude mcp add --transport http piloti https://<your Piloti address>/api/mcp
```

Start Claude Code, type `/mcp`, pick `piloti` and sign in in the browser.

### Cursor

Add the server to `~/.cursor/mcp.json`, or to `.cursor/mcp.json` in a project:

```json
{ "mcpServers": { "piloti": { "url": "https://<your Piloti address>/api/mcp" } } }
```

Cursor starts the sign-in the first time it uses the server.

### ChatGPT and other MCP-capable clients

Where a plan offers connectors for MCP servers (in ChatGPT, often behind
developer mode), add a new one, paste the address and choose OAuth as the
sign-in. The same goes for any other client: add a **remote** MCP server over
HTTP with OAuth sign-in. A client that cannot sign in with OAuth cannot connect
yet.

## What happens at sign-in

1. The client calls the address and learns that it must sign in. It opens your
   browser.
2. You see the usual Piloti sign-in (WorkOS). If you belong to more than one
   organization, **choose the organization** the assistant should work in. The
   connection is bound to that one organization.
3. You allow the client. It receives a token that works only for Piloti's server.
4. From then on the client acts as you. Piloti looks up your role and permissions
   again on every call, so a change in your role applies at once, not when the
   token expires.

## What your agent can do

Whatever you can do in Piloti, within your rights: open and search your projects,
read, upload and file documents, share documents and handle Freigaben, read and
write Anmerkungen, create and update Aufgaben, and work through your inbox. It
sees only what you can see: a project you are not a member of, or a folder
restricted to other people, does not exist for it.

## What stays with you

- **Changes and deletions need your yes.** The client asks you before it makes a
  call marked as a change or a deletion. Piloti marks every operation as a read,
  a change or a deletion, and a deletion that cannot be undone is marked as
  such. Read what the client shows before you confirm.
- **Access rights and API keys are not available to agents yet.** Operations that
  widen who may do what, or touch the organization's secrets, are hidden from
  external agents.
- **No more than you have.** An agent never gets rights you lack.

## Revoke access

- **Yourself:** remove or disconnect the Piloti connector in the client (in
  Claude: Settings → Connectors; in Claude Code: `claude mcp remove piloti`; in
  Cursor: delete the entry from `mcp.json`), or sign out of the server in the
  client's MCP settings.
- **Everyone in the organization:** an administrator has agent access switched
  off for the organization. Connected clients are refused on their next call.
- **Leaving the organization:** a person who is removed from the organization
  loses the agent's access with it, on the next call.

## Troubleshooting

| What you see | What it means | What to do |
|---|---|---|
| **401** or „sign in again“ | The client has no valid sign-in, or it expired | Sign in again in the client (Claude Code: `/mcp`, pick `piloti`) |
| **403** „Agent access (MCP) is not enabled for this organization“ | Your organization has not switched agent access on | Ask an administrator. The profile section says the same |
| **403** „You are not a member of this organization“ | You are no longer a member of the organization the connection was made for | Check your membership. If you belong to another organization now, remove the connector and connect again, choosing that one |
| **403** „The token is not bound to an organization“ | You signed in without choosing an organization | Connect again and choose the organization when asked |
| **503** | The external sign-in is not set up on this installation | Tell whoever operates Piloti |
| The profile shows no address | Agent access is off for your organization, or the installation is not set up | Read the notice in the section |
