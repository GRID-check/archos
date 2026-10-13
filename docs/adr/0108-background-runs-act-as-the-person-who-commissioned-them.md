---
status: accepted
date: 2026-10-13
decision-makers: Grid engineering, on the product owner's decision (2026-10-13)
consulted: product owner
informed: everyone working in this repo
---

# Background runs act as the person who commissioned them

## Context and Problem Statement

A chat turn acts as the person typing. The BFF signs a request-context envelope
at the start of the turn (ADR-0054 §4), the agent's tools echo it to the BFF's
internal routes, and those routes resolve the person it names into a pinned,
role-bearing session (`resolvePinnedRequesterSession`). A turn woken by an event
does the same. Python never signs: it only echoes what the BFF minted.

Scheduled and delegated work did not. The job worker injected three unsigned
identity headers into a run (organization, user, project) and never the signed
envelope, and the envelope `submitAgentRun` sent with the submission carried no
`issuedAt`, which the BFF's verifier refuses as an acting identity. So every tool
that acts as a person (`file_draft`, the canvas tools, `propose_file_change`)
refused in a background run. ADR-0051's addendum of 2026-09-10 accepted this
and moved the filing of a `document` or `revision` task's result to completion,
where the BFF holds the requester's pinned session. That works for the one
document a task produces. It does not let a run file a working draft along the
way, act on a mark, or propose a change to a file, and it made a background run
a weaker colleague than the same question asked in chat.

A run also outlives the envelope it could carry. The envelope is accepted for
six hours (`GRID_REQUEST_CONTEXT_MAX_AGE_MS`), and a research run queued behind
an office's own questions (ADR-0079) can spend much of that waiting.

## Decision Drivers

* The person who commissioned the work is the one accountable for it. Every
  permission check, `created_by` and audit actor downstream should name them,
  as it does for a chat turn.
* Python never signs. The BFF is the only tier that knows who belongs to what.
* A requester's rights can change while a run is in flight. Someone who left the
  office, or lost the right to work in the project, must not keep acting through
  a run they started.
* No new principal. An identity of Piloti's own would need its own permissions,
  its own audit semantics and its own answer to "who authorized this".

## Considered Options

* Keep refusing: background runs act as nobody, and the BFF files at completion.
* Give Piloti its own identity, a service principal with its own grants (the
  Linear or Notion integration model).
* The worker echoes the envelope minted at submit, and asks the BFF for a fresh
  one past 60 minutes; the BFF re-checks the requester's current rights at
  renewal and on every write.

## Decision Outcome

Chosen option: the worker echoes the envelope minted at submit and renews it
through the BFF, because it makes a background run act exactly as a chat turn
does, with the same verifier, the same pinned session and the same audit actor,
and adds no principal.

* `submitAgentRun` signs the envelope with what a tool on a chat turn needs: the
  organization, the requester, the project, the project's collection scope, the
  run's conversation, and `issuedAt`.
* The worker keeps that envelope with the job and injects it into the run's tool
  context. Once it is older than `RUN_ENVELOPE_RENEW_AFTER_MS` (60 minutes) the
  worker calls `POST /api/internal/runs/[runId]/envelope`
  (`lib/runs/run-envelope-types.ts` is the wire, exported as JSON Schema for the
  worker's client).
* The BFF renews only for a run that is still `queued` or `running`, and only
  while the requester, re-resolved from WorkOS now, is a member with a role,
  holds `CHAT_PERMISSIONS` on the project as a member, may still view the run's
  conversation, and their organization still has the capability the run was
  admitted under. Otherwise it answers `run-not-active`, `unknown-run` or
  `requester-may-not-act`, and the worker runs on without an envelope: the
  person-acting tools refuse, as they did before this decision.
* The renewed envelope signs what the submission's envelope signs, re-derived
  now from the `task_runs` row through one function both use
  (`lib/jobs/run-context.ts`): identity and scope, and the run's context (model
  selection, budget, prompt blocks). The context cannot be left out: the agent
  reads a signed envelope wholesale, so a renewal with identity alone would run
  the rest of the job on the YAML models and with no budget. Each renewal is
  audited as `task.envelope_renewed`, with the requester as actor and the run as
  target.
* Every write the envelope reaches still re-resolves the pinned session
  (`requirePinnedSession`) and checks its own permission. The envelope says who;
  it never says what they may do.

The filing at completion that ADR-0051's addendum introduced stays for the
kinds that use it. A `document` or `revision` task's answer is still filed by
the BFF when the run ends, and its prompt still does not tell the run to call
`file_draft`, because filing twice would leave two drafts.

### Consequences

* Good, because background work can file drafts, act on marks and propose file
  changes as the person who commissioned it, through the same doors a chat turn
  uses.
* Good, because a requester who leaves the office, or loses the right to work in
  the project, stops their runs from acting for them at the next renewal at the
  latest, and at the next write in any case.
* Good, because there is still one signer and one verifier. Python gains no key
  and no decision.
* Bad, because a captured envelope authorizes, for its six-hour window, what the
  requester's own rights allow. That is the window a chat turn's envelope already
  has, and every write re-checks the person, but a run now holds such an
  envelope for hours rather than for one turn.
* Bad, because the internal token that reaches the renewal route is the signing
  secret. The route adds no door a token holder did not already have; what it
  adds is the re-check for the honest caller. Anyone who holds the secret can
  still mint any envelope, as before.
* Bad, because a run's envelope carries the project context, the memory digest
  and the organization's instructions, so it is larger than a chat turn's
  compact capsule (ADR-0077), and the worker's tools now send it to the BFF on
  every call. A large project profile can bring those requests near Node's
  16 KB header limit. Nothing measures that yet; if it bites, the run's envelope
  should move to the compact capsule as the chat turn's did.

### Confirmation

* `frontends/ui/src/app/api/internal/runs/[runId]/envelope/route.spec.ts` drives
  the route with its real service: an unknown or malformed run, every inactive
  status, a requester who left, lost the chat permission, reaches the project
  only because it is closed, lost the conversation, or whose organization lost
  the capability, each refused in the contract's shape; the success case is
  verified with `verifyGridRequestContextEnvelope` and names the requester,
  project and conversation with a fresh `issuedAt`, and carries the run's
  context; the renewal is audited without the envelope.
* `frontends/ui/src/lib/jobs/service.spec.ts` asserts the submit envelope carries
  the conversation and a fresh `issuedAt`. Both envelopes are signed from
  `runRequestContextInput`, so they cannot carry different fields.
* `frontends/ui/src/lib/runs/run-envelope-schema.spec.ts` fails when the wire
  contract and `frontends/ui/tests/fixtures/run-envelope.schema.json` drift; the
  worker's client is tested against that fixture on the Python side.
* `frontends/ui/src/lib/audit/schemas.spec.ts` keeps `task.envelope_renewed`
  registered.
* `frontends/ui/src/app/api/authz-coverage.spec.ts` keeps the route on
  `internalApiRoute`.

## Pros and Cons of the Options

### Keep refusing

* Good, because nothing changes and no envelope lives longer than a turn.
* Bad, because the gap ADR-0051 recorded stays: a background run is a weaker
  colleague than the same question in chat, and every new person-acting tool
  needs a completion-time workaround or does not work in background work at all.

### Give Piloti its own identity

* Good, because the run's authority is independent of any one person and does
  not end when its requester leaves.
* Bad, because it is a second principal with its own grants, wider than any
  human's in practice. Every permission check, `created_by` and audit event would
  have to learn a non-person actor, and the question an audit exists to answer,
  which human authorized this, would no longer resolve to a human (the reason
  `AuditActorType` keeps the actor human for agent-authored events).
* Bad, because it contradicts the agent-authored-documents design, which refused
  a service identity that files as nobody and chose the requester's pinned
  permission instead.

## More Information

* ADR-0051 and its addendum of 2026-09-10 (option 2, "letting the run file its
  own draft") record why a background run could not act before this decision.
  That addendum is history and is not edited.
* ADR-0054 §4: the envelope, its six-hour window and the pinned session.
* ADR-0084: the backend authorizes a job by the scope the BFF signed.
* Revisit if a run must keep acting after its requester leaves (a standing
  office routine whose owner changes): that is the case for a transfer of the
  definition to a new requester, not for a Piloti identity.
