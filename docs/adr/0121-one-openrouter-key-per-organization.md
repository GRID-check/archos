---
status: accepted
date: 2026-10-20
decision-makers: product owner, Grid engineering
consulted: Grid engineering
informed: everyone working in this repo
---

# One OpenRouter key per organization, with no fallback to a shared key

## Context and Problem Statement

Every model call an organization causes goes out on one platform OpenRouter key,
unless the organization brought its own (BYOK, ADR-0022). To OpenRouter we are
one account, so everything that happens to that key happens to every tenant at
once:

- A runaway loop, a missed cost record or a leaked key spends from one pool.
- A provider policy block caused by one end user can block the account.
- Zero data retention (ADR-0074) holds only because our code adds the routing
  to each request body. OpenRouter itself enforces nothing for us.
- A tenant's spend and calls cannot be seen or revoked on their own.

Every call now names its organization, person and project in `user` and
`metadata` (`common/openrouter.py`, `attribution_fields`), so OpenRouter's
activity can be filtered by tenant. That fixes visibility only. The tenants
still share one key, and so one blast radius.

The BYOK lookup also falls back to the platform key when it fails (ADR-0022,
§3), so a hiccup in that lookup quietly bills the platform for a tenant that
asked to be billed on its own account.

## Decision Drivers

* A tenant's failure, leak or runaway stays that tenant's.
* The data policy an organization chose is enforced by the gateway too, not
  only by our request bodies.
* Each tenant's spend can be read, capped and revoked at OpenRouter on its own.
* One record of what a tenant may spend. The ledger, credits and EUR limits
  (ADR-0015, ADR-0053) know users, projects and margin; a key knows one USD
  number.
* No fallback (product owner, 2026-10-20). Work for an organization runs on
  that organization's key or does not run.

## Considered Options

1. Keep the shared key, with per-call attribution.
2. A key per organization, whose OpenRouter limit *is* the budget.
3. A key per organization for isolation, with a backstop limit; the ledger
   stays the budget.
4. A gateway of our own (LiteLLM, Portkey) issuing virtual keys in front of
   OpenRouter.

## Decision Outcome

Chosen option: 3, "a key per organization for isolation, with a backstop
limit", because it is the only option that isolates tenants at the gateway
without creating a second record of the budget.

This is the virtual-key-per-tenant pattern AI gateways use (LiteLLM, Portkey).
OpenRouter is our gateway, so its keys are the virtual keys.

What it means:

- **Every organization has one platform-provisioned OpenRouter key.** The BFF
  creates it through OpenRouter's management API the first time the
  organization needs one (`frontends/ui/src/lib/llm-credentials/org-keys.ts`),
  so existing organizations need no backfill and a lost row heals itself. It
  is stored like a BYOK key (WorkOS Vault or the local envelope, ADR-0022) in
  its own table, `org_openrouter_keys` (migration 0173), whose partial unique
  index allows one active key per organization: two replicas provisioning at
  once cannot both win, and the loser deletes the key it created. A table of
  its own rather than a kind on `org_llm_credentials`, because that table
  allows one active credential per organization and an organization can hold
  both.
- **One endpoint serves both keys.** `/api/internal/llm-credential` answers
  the organization's BYOK credential in use, its platform key, and whether the
  deployment has per-organization keys at all. Any failure is a 503, never a
  null key.
- **Which key a call uses** is decided at the two seams every OpenRouter call
  passes (`common/openrouter.py`'s transports and `llm_factory.prepare_request`,
  `openrouter_key_for_call`): a call made for an organization keeps the
  organization's BYOK key if it is already on it, and otherwise carries the
  organization's platform key, whatever key the call site was built with.
  The organization is the ambient cost tracker's, else the signed request
  context's, the same identity the ledger books the call to. A route that
  names the organization as an argument instead (titles, summaries, the
  document helpers, dictation) gets the key from
  `credential_resolution.resolve_llm_credential`, which answers the
  organization's key and never the env chain's for an OpenRouter call.
- **No fallback.** When an organization's keys cannot be resolved, the call is
  refused (`OrgCredentialUnavailable`; on the transports a final 403 carrying
  `organization_keys_unavailable`, which the OpenAI SDK does not retry). The shared key never serves an
  organization's work again, and the same rule replaces BYOK's fail-open
  (ADR-0022, §3): a BYOK secret that cannot be revealed, or a credential that
  cannot be applied, refuses the call instead of moving it to the platform.
- **The shared key remains only for work with no organization:** the shared
  legal corpus, CLI runs, evals.
- **A deployment without a management key has no per-organization keys.**
  `OPENROUTER_MANAGEMENT_KEY` unset (local development, CI) makes the endpoint
  answer `perOrgKeys: false`, and every call runs on the shared key. That is a
  property of the deployment, not a runtime fallback: the Pulumi program
  requires the secret (`requireSecret`), so no stack can run without it.
- **The key limit is a backstop, not the budget.** It sits well above the
  organization's own limit, so it trips on runaways and leaks, never on normal
  use. The ledger keeps refusing a turn at its start (ADR-0015), which is the
  limit a user sees. OpenRouter answers 402 or 403 at the next call once a key
  limit is spent, which reaches the user as an answer cut off mid-turn.
- **Revoking an organization's key** is done at OpenRouter: disabling it
  there makes the organization's calls fail until it is enabled again. The BFF
  has no organization-deletion flow yet; when one is built it disables the key.
- **The `user` and `metadata` attribution stays.** A key never says which
  person or project inside the organization made a call.
- **Billing does not change.** A platform key is billed to the platform's
  account and booked in USD and credits. Only a `byok` credential moves the
  organization to token budgets (`isOrgOnOwnKey`).

### Consequences

* Good, because a leaked key, a runaway job or an abuse block costs one tenant,
  and can be revoked for that tenant alone.
* Good, because OpenRouter's own dashboards and analytics show spend per tenant
  by key.
* Good, because the lookup already exists: BYOK resolves an organization's key
  just in time with a 60 s cache (`common/llm_credentials.py`,
  `common/credential_resolution.py`), and most call sites already pass the
  organization.
* Bad, because availability now depends on the credential lookup. If the BFF's
  internal endpoint or WorkOS Vault is down past the cache, an organization's
  calls fail instead of degrading to the shared key. That is the trade the
  no-fallback rule chooses.
* Bad, because the BFF holds an OpenRouter management key. It can create keys
  and change their limits, which makes it more dangerous to leak than any
  inference key, so it gets its own secret and is never sent to Python.
* Bad, because the backfill runs once against production, and an organization
  it misses cannot call a model at all.
* Bad, because a call made with no organization in reach (no cost tracker, no
  request context, no organization argument) keeps the key it was built with.
  That is right for the shared corpus and CLI runs, and it is why every route
  that serves an organization must name it.
* Bad, because a turn that outlives a BYOK key rotation finishes on the
  organization's platform key: the old key is no longer the one the cache
  holds. The platform pays for at most the rest of that turn.
* Neutral: OpenRouter governs rate limits for the whole account ("making
  additional accounts or API keys will not affect your rate limits"), so
  per-org keys add no capacity, and the fleet limiter (ADR-0081) is unchanged.
* Neutral: embeddings still resolve with `organization_id=None` (the embedding
  endpoint and BYOK's base URL do not match), and need not change: the seam
  swaps the organization's platform key onto a tenant's ingest and query
  embeddings like any other call.

### Confirmation

- `tests/aiq_agent/common/test_openrouter.py`
  (`TestEveryCallForAnOrganizationCarriesItsKey`) and
  `test_a_chat_call_for_an_organization_goes_out_on_its_key` in
  `test_llm_factory.py` assert on the outgoing request that a call for an
  organization carries its key and never the shared one, on the transports
  and on the LangChain path (chat completions and Responses), and that keys
  that cannot be resolved refuse the call.
  `test_provider_limiter_call_sites.py` and `test_openrouter_call_sites.py`
  keep every OpenRouter call on those two seams.
- `test_llm_credentials.py`, `test_request_llm_context.py`,
  `test_register_skills.py` and `stages/test_runner.py` assert that a key
  lookup that fails refuses the turn, the job or the stage.
- `uniq_org_openrouter_keys_active` allows one active key per organization;
  CHECKs hold the secret column to its backend and the status vocabulary.
  `org-keys.spec.ts` covers lazy provisioning, the race, and failing closed;
  `route.spec.ts` the endpoint's contract.
- `requireSecret("openrouterManagementKey")` fails `pulumi preview` on a stack
  without the key; `deploy/pulumi/src/app/config.spec.ts` holds the env names
  to what the BFF reads and keeps the management key off every backend pod.
- Nothing checks that every live organization has a key: one is created on
  first use, so a missing key costs that organization one round-trip, not an
  outage.

## Pros and Cons of the Options

### 1. Shared key with attribution

* Good, because it is already done and costs nothing more.
* Bad, because it isolates nothing: one leak, runaway or abuse block reaches
  every tenant.

### 2. Per-org key as the budget

* Good, because the cap is enforced by the gateway.
* Bad, because a key holds one USD limit with a fixed reset. Our budgets have
  organization, user and project scopes, in EUR, priced as credits with a
  margin, or in tokens for BYOK. The key can only copy the organization scope,
  and every policy change has to be mirrored, which gives two records of the
  same money.
* Bad, because it cuts answers and uploads off mid-way. ADR-0015 chose to
  refuse at the start of a turn, and ingestion deliberately runs to the end.

### 4. Our own gateway with virtual keys

* Good, because budgets and keys would live in one tool we control.
* Bad, because OpenRouter is already the gateway, and a second one adds a hop,
  a service to run, and a second place keys are minted. Buy, don't build.

## More Information

- **Before the first deploy**, set the management key on each stack
  (`esc env set … pulumiConfig.grid-oib:openrouterManagementKey … --secret`,
  see `Pulumi.<stack>.yaml`), and choose the backstop
  (`openrouterOrgKeyMonthlyLimitUsd`; unset creates keys without a limit).
- Follow-ups: an OpenRouter guardrail with `enforce_zdr` on the keys of
  organizations under zero data retention, kept in step with the
  Organization → Models setting, so OpenRouter refuses a non-retaining
  provider too; key rotation; whether each environment gets its own OpenRouter
  workspace.
- Supersedes, once accepted, the fail-open in ADR-0022 §3, and answers the
  "OpenRouter provisioned-key limits" alternative ADR-0015 rejected: that
  rejection was of one key's limit as the budget, which this ADR also rejects.
- OpenRouter: [user tracking](https://openrouter.ai/docs/cookbook/administration/user-tracking.md),
  [rate limits](https://openrouter.ai/docs/api/reference/limits),
  the key and guardrail endpoints in [the OpenAPI spec](https://openrouter.ai/openapi.json).
- The pattern: [LiteLLM multi-tenant architecture](https://docs.litellm.ai/docs/proxy/multi_tenant_architecture),
  [Portkey multi-tenant guide](https://portkey.ai/docs/guides/use-cases/multi-tenant-ai-feature).
