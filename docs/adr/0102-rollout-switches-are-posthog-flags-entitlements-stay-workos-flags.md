---
status: accepted
date: 2026-10-11
decision-makers: Platform (product owner)
consulted: Product
informed: everyone who ships to this repo
---

# Rollout switches are PostHog flags; entitlements stay WorkOS flags

## Context and Problem Statement

Every feature switch was a WorkOS feature flag, delivered in the AuthKit JWT's
`feature_flags` claim and read synchronously from the session
(`frontends/ui/src/lib/authz/feature-flags.ts`). The registry already split the
switches into two kinds, `entitlement` and `rollout` (`FLAG_KINDS`), but the
kind only decided the fixed answer in a deployment that signs nobody in.

The two kinds are different things. An entitlement is authorization: deep
research, tasks, BYOK, model configuration, collaboration, skills and the mail
import cost money or change who can read what, and are granted per organization.
A rollout is a kill switch over a feature shipped to everybody: web search, the
project knowledge page, image upload, the wizard's conflict check, IFC models,
filing agent-written documents and the follow-up stage. ADR-0100 made PostHog
the product platform and said PostHog flags are rollout switches, never
authorization. It left open which flags move (`posthog-migration.md`, open
decision 4).

Keeping rollouts in WorkOS costs three things. A change reaches a reader only at
their next sign-in, because it rides the token. Withdrawing a rollout for one
office is a WorkOS targeting edit, while the analysis that would justify it
(errors, replays, the self-driving inbox) lives in PostHog. And the
`memory-reflection` flag guarded a stage that is part of the product, not an
experiment: it was ON for every organization in both environments.

## Decision Drivers

* PostHog flags are never authorization (ADR-0100). An entitlement stays on the
  signed token.
* A rollout is shipped to everybody. An outage of the analytics vendor must not
  withdraw it, which is the opposite of the entitlement rule.
* An office sees one product: two colleagues must not get two answers.
* Free tier: group analytics is a paid add-on, and the free tier has 1M flag
  requests a month.
* Call sites stay synchronous. About sixty gates read `isFeatureEnabled(session,
  flag)`; none of them should become async.

## Considered Options

* Rollouts in PostHog, evaluated per organization in the BFF and merged into the
  session's flag set; entitlements unchanged in WorkOS.
* Everything in PostHog.
* Everything stays in WorkOS (status quo).
* Rollouts in PostHog, evaluated in the browser with `posthog-js`.

## Decision Outcome

Chosen option: rollouts in PostHog, evaluated per organization in the BFF,
because it puts the kill switch beside the data that triggers it and keeps
authorization on the signed token.

* **Where.** `FLAG_KINDS` decides. An `entitlement` is read from the WorkOS claim
  (live sessions) or `listOrganizationFeatureFlags` (session-less reads), as
  before. A `rollout` is evaluated by PostHog in one module,
  `frontends/ui/src/lib/analytics/rollout-flags.ts`, on the shared server client
  (`posthog-server.ts`). A rollout slug WorkOS still lists is ignored.
* **Synchronous gates.** `session.featureFlags` is assembled where sessions are
  built: the claim filtered to entitlements plus the rollouts PostHog has not
  switched off (`sessionFeatureFlags` for `lib/auth/session.ts`,
  `enabledFlagsForOrganization` for `lib/auth/pinned-session.ts`).
  `isOrgFeatureEnabled` routes by kind for session-less callers, and the per-turn
  `GET /api/internal/stages` reads through it. The browser keeps receiving flags
  as server-computed props; nothing evaluates flags client-side.
* **Per organization.** The distinct id is `org:<organizationId>` and
  `organization_id` is passed as a person property, so a release condition can
  target an office without groups. `getAllFlags` is used rather than
  `evaluateFlags(...).isEnabled`, so no `$feature_flag_called` event is sent.
* **Semantics.** A rollout is ON unless PostHog explicitly answers `false`: ON
  when PostHog is not configured, when the flag does not exist there, for a
  caller with no organization, and when evaluation fails (logged). An
  entitlement keeps its fail-closed semantics, including a stale token's.
* **Cost.** Answers are cached per organization for 30 s in the shared cache.
  With the optional secret `POSTHOG_FEATURE_FLAGS_SECURE_API_KEY` (Pulumi:
  `grid-oib:posthogFeatureFlagsKey`) the client polls definitions and evaluates
  locally; without it each cache miss is one `/flags` request.
* **`memory-reflection` is deleted.** The memory-reflection stage is core:
  `StageSpec.flag_slug=None` means a stage with no runtime switch, which the
  runner runs whenever its gate passes and a model is configured. Its gate now
  also skips a turn without an organization, which the flag path used to do
  implicitly. The `memoryReflectionEnabled` wire field stays, always `true`, for
  an older agent and for the worker's reflection parameter; retiring it is a
  wire change of its own.

### Consequences

* Good, because an operator withdraws a rollout in PostHog, per office or for
  everybody, and it reaches open tabs within about a minute (30 s cache plus the
  30 s definition poll), with no sign-in and no deploy.
* Good, because the WorkOS drift check (`task fe:provision:flags`) now checks
  exactly what WorkOS must hold: the entitlements.
* Good, because a PostHog outage, an exhausted flag quota or a missing flag
  leaves every shipped feature on.
* Bad, because fail-open makes a missing flag mean ON. A rollout that is dark
  somewhere today (`project-knowledge-page` is OFF in Production) turns on there
  unless its PostHog flag exists and answers off before this ships.
* Bad, because remote evaluation omits a flag that is disabled as a whole, and an
  omitted flag reads as ON. The kill switch is the release condition (0 %, or a
  condition on `organization_id`), never the flag's Enabled toggle. Local
  evaluation resolves a disabled flag to `false`, so the toggle works there only.
* Bad, because one PostHog project serves both stacks. A rollout that must differ
  between Staging and Production is expressed by conditions on the
  organizations' ids, which differ between the two WorkOS environments.
* Bad, because a session now costs one shared-cache read more per request, and a
  cache miss one PostHog call.
* Neutral, because the boot line keeps printing `flags=workos` for live
  evaluation; the name is grepped and `server.js` prints a byte-for-byte twin.

### Confirmation

* `frontends/ui/src/lib/analytics/rollout-flags.spec.ts`: the organization's
  distinct id and person property, the cache, fail-open on no configuration, a
  missing flag and a thrown error, and an explicit off honoured.
* `frontends/ui/src/lib/workos/feature-flags.spec.ts`: `isOrgFeatureEnabled`
  routes an entitlement to WorkOS and a rollout to PostHog,
  `sessionFeatureFlags` drops a rollout from the WorkOS claim, and
  `enabledPostAnswerStages` follows PostHog.
* `frontends/ui/src/lib/auth/session.spec.ts`: a live session carries the
  claim's entitlements and PostHog's rollouts.
* `frontends/ui/src/lib/authz/feature-flags.spec.ts`: every slug has exactly one
  kind, and the rollout list is the one this record names.
* `tests/test_posthog_boundaries.py`: only `posthog-server.ts` imports
  `posthog-node`, so the rollout module cannot grow a second client.
* `tests/aiq_agent/stages/test_stage_flag_parity.py`: the BFF's stage registry
  and the backend's flagged stages agree, and a core stage has no switch on
  either side.
* `deploy/pulumi/src/app/posthog-flags-key.spec.ts`: the secure key is absent by
  default and reaches the frontend only through the shared Secret.

## Pros and Cons of the Options

### Everything in PostHog

* Good, because one control plane.
* Bad, because an entitlement would no longer ride the signed token, and a
  PostHog outage would have to fail open (withdrawing paid features otherwise),
  handing out what an organization did not buy. ADR-0100 rules it out.

### Status quo

* Good, because nothing changes.
* Bad, because a kill switch reaches a reader at their next sign-in, and the
  switch lives away from the data that says when to pull it.

### Browser evaluation with `posthog-js`

* Good, because PostHog's own toolbar and overrides work.
* Bad, because gates are enforced in the BFF; a browser answer cannot gate a
  route, so every flag would be evaluated twice and could disagree. It also
  identifies by person, which gives two colleagues two answers.

## More Information

* Amends [ADR-0100](0100-posthog-is-the-product-platform-and-langfuse-feeds-it.md)
  (its table row "Identity, authorization, feature entitlements" stays true; this
  record decides its open decision 4).
* Runbook: [`docs/deployment/workos-provisioning.md`](../deployment/workos-provisioning.md)
  §6 for the entitlements, [`docs/observability/posthog-migration.md`](../observability/posthog-migration.md)
  for the PostHog flags.
* Revisit if group analytics becomes free (an organization group would replace
  the synthetic distinct id), or if a rollout has to become an entitlement
  because it starts to cost money per organization.
