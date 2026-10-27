# Connect your agent

Your own AI assistant (Claude, ChatGPT, Cursor or any other client that speaks
MCP) can work in Piloti for you, with your rights: in your office's projects,
documents, reviews, tasks and conversations, with Piloti's building-law
knowledge and BIM analysis, and by asking Piloti itself. It asks you before it changes or deletes anything, and Piloti never gives
it more than you have. How the server works underneath:
[the agent surface](../architecture/agent-surface.md) and
[ADR-0122](../adr/0122-everything-a-person-can-do-an-agent-can-do.md).

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
read, upload, file and share documents, handle Freigaben, read and
write Anmerkungen, create and update Aufgaben, and work through your inbox. It
sees only what you can see: a project you are not a member of, or a folder
restricted to other people, does not exist for it.

## Piloti's proposals, as cards in your assistant

When Piloti has proposed a change (a file move, a note to remember, an action
in a project), your assistant can show it to you as **Piloti's own card**,
right in your conversation: what the change would do, what it touches, every
value in full, and **Apply** and **Discard**. Ask it, for example, „Show me
what Piloti proposes for the Lindengasse project“.

- **You press the button, not the assistant.** In an assistant that shows the
  card, its buttons are yours: the assistant keeps them from its model, as MCP
  Apps requires. Applying runs the change as you, with your rights, exactly as
  the button in Piloti does: if you may not decide it, the card says so and
  nothing changes.
- **When the assistant wants to decide it itself.** If your assistant tries to
  apply or discard a proposal on its own, Piloti asks you first in the
  assistant's chat, where the assistant supports such questions (MCP's
  elicitation, in clients on the 2026 protocol). Older clients cannot carry the
  question; there the assistant applies a proposal only through its own
  confirmation of a change, so read what it shows you before you agree.
- **The card looks like your assistant.** It takes your assistant's colours,
  font, light or dark mode and language, and keeps Piloti's layout and words.
- **Which assistants show it.** Claude (claude.ai and Claude Desktop), ChatGPT,
  VS Code and other clients that support MCP Apps. Cursor shows it from
  version 2.6, with occasional display problems in some versions. Everywhere
  else the proposal arrives as text, and your assistant can still apply it for
  you when you say so. An assistant that says it shows MCP Apps gets the card;
  one on the 2026 protocol that does not say so gets only the text.
- **An old conversation.** When you reopen a conversation, the card reads the
  proposal again, so one decided in the meantime shows as decided.
- **One kind is decided in Piloti.** A change to the project context (its
  facts) is compared with the current values, which only Piloti can show. The
  card says so; open the project in Piloti to decide it.
- **A colleague was faster.** If someone decided the proposal in the meantime,
  the card shows who decided and when instead of an error.

## Ask Piloti

Your agent can also ask Piloti itself, the way you would ask a colleague who
knows the office's documents, the project's files and building law. Piloti
answers as you, with your rights, and may file a document while it answers
([ADR-0124](../adr/0124-agents-consult-piloti-over-mcp-and-a2a.md)).

- **Your organization switches it on.** Asking Piloti is a second switch,
  `piloti-ask`, beside agent access. Each question is a Piloti answer like one
  you type, paid from your and your organization's AI budget. Without the
  switch the agent is told „Asking Piloti from another agent is not enabled for
  this organization“.
- **How the agent asks.** Over MCP it calls `piloti-ask-create` with the
  question and, if it is about one project, the project's id. Without the
  project Piloti answers for the office as a whole and does not read any
  project's files, so name it whenever the question is about one. Piloti answers within
  about 40 seconds; a longer answer comes back as „working“ and the agent reads
  it a little later with `piloti-ask-get`. To follow up, the agent passes the
  conversation of the first question.
- **You can read along.** Every question your agent asks lands in a private
  conversation of yours in Piloti, with Piloti's answer, like one you typed.
  Nobody else sees it unless you share it.
- **Piloti does not ask itself.** Piloti, inside the product, cannot use this to
  ask Piloti, and an answer Piloti is giving to your agent cannot start another
  one.

### Agents that speak A2A

Agents built on the Agent2Agent protocol (A2A) reach the same thing without MCP.
Piloti's agent card is at `https://<your Piloti address>/.well-known/agent-card.json`
and the endpoint is `https://<your Piloti address>/api/a2a` (A2A 1.0, and 0.3 for
older clients). Sign-in is the same as for MCP: the agent signs in with your
Piloti account and asks for the token for `https://<your Piloti address>/api/a2a`
(a token for `…/api/mcp` works too).
A task is one question to Piloti; its `contextId` is the conversation, so a
follow-up sends it back; the answer is an artifact, and so is each document
Piloti filed. Agent access (`agent-mcp`) and `piloti-ask` must both be on.

## What stays with you

- **Changes and deletions need your yes.** The client asks you before it makes a
  call marked as a change or a deletion. Piloti marks every operation as a read,
  a change or a deletion, and a deletion that cannot be undone is marked as
  such. Read what the client shows before you confirm.
- **Access changes work only once your organization switches them on, and your
  agent always asks you first.** Sharing a document or a chat, setting who may
  open a folder, defining a role, letting a held file through and lifting a
  legal hold are hidden from agents until an administrator switches them on for
  the organization. Your client must also have been granted the extra permission
  for them when you signed in. Each such call is marked as one to confirm, so the
  client asks you every time. Piloti itself, inside the product, never does any
  of this for you.
- **How Piloti itself works stays in Piloti.** An agent does not change your
  organization's settings, standing instructions, models, API keys, budgets,
  upload screening or retention policies, does not switch web search, and does
  not touch your own notification settings or read marks. You set those in
  Piloti. Things your assistant already does itself (searching the web, looking
  up an address, formatting a citation) it does with its own tools.
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
| **403** „Asking Piloti from another agent is not enabled for this organization“ | Agent access is on, asking Piloti is not | Ask an administrator to switch on `piloti-ask` |
| An ask ends „rejected“ with „budget“ | Your, the project's or the organization's AI budget is spent | An administrator raises it under Organization → Usage & budgets |
| An ask ends „rejected“: „Piloti is still answering in this conversation“ | The agent asked again in a conversation where Piloti had not finished | Wait for the first answer (`piloti-ask-get`), then ask again, or ask in a new conversation by leaving out `conversationId`. An ask never interrupts a running answer |
| A proposal arrives as text, not as a card | Your assistant does not render MCP Apps, or it showed the text first | Ask it to show the proposal with `proposal-get`, or decide it in Piloti |
| The profile shows no address | Agent access is off for your organization, or the installation is not set up | Read the notice in the section |
