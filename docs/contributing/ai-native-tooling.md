# AI-native tooling: agents can act in every tool we choose

The rule in [`AGENTS.md`](../../AGENTS.md#working-style) is the short form. This
page says what the rule means, how to check a tool against it, and how to write
the check down.

## Why

Our own product works on this principle: everything a person can do in the
workspace, an agent can do through one MCP server (ADR-0122). We hold the tools
we buy to the same standard. The team works through agents: Claude Code in the
repo, Claude in Slack, and our own agent in the product. A tool those agents
cannot act in turns every task in it back into a person in a browser, and that
cost repeats on every task for as long as we use the tool.

## Definition

A tool is **AI-native** when an agent acting for a named person, or for a named
robot identity, can do everything the job needs (read, query, create, edit, and
publish or the tool's equivalent of "make it live") through a surface the vendor
builds and maintains for programs, with permissions no wider than the job, and
with every change attributable and reversible.

"The vendor builds and maintains" matters. A community MCP server around an
undocumented API is a dependency we would own. It may bridge a gap, and the ADR
then says so.

## Checklist

Score each line **yes**, **partly** (say what is missing) or **no**. Lines 1 to 4
are required: a tool that fails one of them needs an ADR that names the
exception and when it expires. Lines 5 to 7 are expected.

| # | Criterion | What "yes" looks like | Required |
|---|---|---|---|
| 1 | **Official agent surface** | A vendor-maintained MCP server, preferably remote with OAuth, listed in the MCP Registry. Failing that, a documented, versioned HTTP API (OpenAPI or equivalent) that covers every action the UI offers for our use case. | yes |
| 2 | **Scoped credentials** | Tokens or OAuth scopes narrower than admin: per role, per project or space, read-only or draft-only. A robot identity separate from people. Tokens can be revoked. | yes |
| 3 | **Schema and configuration as code** | The model, schema, fields, workflows and settings live in files in our repo and are applied by CLI or API from CI. An agent changes them with a PR. Configuration only a UI can change counts as **no**. | yes |
| 4 | **Audit and rollback of agent edits** | Agent edits land as drafts, or wait behind a review or approval step. Every change is in a revision history with an author, and any revision can be restored. Write down the retention window on the plan we buy. | yes |
| 5 | **Events** | Webhooks or an event stream on change, signed, with retries, so other systems react without polling. | expected |
| 6 | **CLI** | An official CLI for setup, schema and import/export that runs headless in CI. | expected |
| 7 | **Exit** | A full export in an open or documented format, and a written sentence on how we would leave. | expected |

Also note, without scoring:

- Whether an agent's action is attributed to the person it acts for. OAuth on
  behalf of a person is better than a shared token.
- Whether the plan we would buy includes lines 2 and 4. Retention and roles are
  often paid features.
- Any dangerous tool on the MCP server, such as delete or bulk publish, and how
  we turn it off.

## How to check

1. Read the vendor's own docs for the MCP server and the API, dated within the
   last three months. A third-party listing does not count as evidence.
2. **Do the round trip.** Connect the MCP server or the API from Claude Code
   with the narrowest token, then create a draft, query it, edit it and roll it
   back. A tool that fails this is not AI-native, whatever its docs say.
3. Try a schema change as a PR: change one field in code and apply it from CI
   or the CLI.

## How to record it in an ADR

Every ADR that adopts or replaces an external tool has the decision driver
"AI-native (`docs/contributing/ai-native-tooling.md`)", and this section under
**More Information**:

```markdown
### AI-native check (YYYY-MM-DD)

| # | Criterion | Result | Evidence (source, date) |
|---|---|---|---|
| 1 | Official agent surface | yes: remote MCP `https://…`, OAuth | vendor docs, YYYY-MM-DD |
| 2 | Scoped credentials | partly: draft-only role on the paid plan only | pricing page, YYYY-MM-DD |
| 3 | Schema and configuration as code | yes: `path/in/repo`, applied by `<cli> deploy` in CI | |
| 4 | Audit and rollback of agent edits | yes: drafts and history, 90 days on our plan | |
| 5 | Events | yes: signed webhooks, retries | |
| 6 | CLI | yes | |
| 7 | Exit | yes: NDJSON export | |

Round trip done by: <who>, <date>, <what was created, edited and rolled back>.
Agent surfaces in use: <MCP server or API> for <Claude Code, Slack, the product's agent>.
Exceptions: <none | line N, why, until when>.
```

In **Considered Options**, every rejected tool states which line it failed and
the fact behind it ("its MCP endpoint needs an admin token", not "weak AI
support"). A later reader can then re-check that fact when the vendor ships an
update.

## Applied to

- **Attio, for the website's contact and demo forms.** The forms hand off by
  `mailto:` for now; Attio is the target (owner decision, 2026-10-29). The ADR
  that moves the forms records this check for Attio's API and MCP server, with
  the round trip, before anything is wired.
- **The blog's CMS.** A consultant compared hosted and self-hosted CMSs against
  this checklist; the decision is parked (owner decision, 2026-10-29) and has
  no ADR yet. When it resumes, its ADR carries the check above.

## Existing tools

Tools adopted before this rule (WorkOS, PostHog, Langfuse, Notion, Linear and
others) get the check the next time an ADR touches them. Nobody has to audit
everything at once. A tool that fails gets a line in its ADR's More Information,
saying what is missing and what would make us revisit it.
