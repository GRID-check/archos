# Secrets and keys: policy and inventory

- **Status:** in force from 2026-10-20. Review it every quarter, together with
  the access review below.
- **Scope:** every credential the platform, its deployments and its CI hold:
  vendor API keys, keys we mint for tenants, and secrets we generate ourselves.
- **Companions:** [`external-dependencies.md`](external-dependencies.md) lists
  the vendors and what data reaches them; this document lists how we prove to
  each of them who we are, and how that proof is kept, rotated and revoked.
  The cut-over to keyless CI is [`../deployment/keyless-ci.md`](../deployment/keyless-ci.md).

## Policy

1. **Keyless where the vendor allows it.** A job or a pod that can prove its
   identity with a short-lived OIDC token (GitHub Actions, a Kubernetes service
   account) exchanges it for a short-lived vendor token. No long-lived key is
   stored for it.
2. **One credential per consumer.** Production, staging and CI never share a
   key, so one can be revoked without touching the others. A credential belongs
   to a service, a bot user or an app, never to a person's own account.
3. **Least privilege.** A key carries the narrowest scope, project, repository
   or workspace the vendor offers, and a spending or credit cap where the vendor
   has one.
4. **Where secrets live.** Deployment secrets live in Pulumi ESC
   (`matthiasbigl/grid-oib/<stack>`), CI secrets in GitHub Actions secrets
   (environment-scoped where a deploy uses them), tenant keys in the secret
   store behind the BFF (WorkOS Vault, ADR-0022). Never in git, a `.env` that is
   committed, an image, a log line or a ticket.
5. **Rotation.** Every credential has an interval in the inventory. It is also
   rotated at once when it may have been exposed, when someone who could read
   it leaves or changes role, or when its vendor reports an incident.
6. **Expiry at issue.** Where the vendor lets a key expire (OpenRouter
   management keys, Cloudflare tokens, Anthropic keys, GitHub fine-grained
   PATs), it is issued with an expiry no later than its rotation interval.
7. **Evidence.** Every rotation, revocation and access review gets a line in
   the [record](#record) below, in the same pull request that changes anything
   else it needs.

## Inventory

Owner is a role; the person holding it is named in the access review.
"Interval" is the longest a credential may live; "event" means rotated only on
the triggers in policy 5.

### Vendor credentials

| Credential | Where | Consumer | Keyless? | Scope today | Interval | How to rotate |
|---|---|---|---|---|---|---|
| `openrouterApiKey` (`OPENROUTER_API_KEY`) | ESC | Backend pods, for work with no organization (shared corpus, CLI) | Possible with OpenRouter's workload identity (Business plan) once the cluster's issuer is public | All inference | 90 days | Create a key in OpenRouter, `esc env set`, deploy, delete the old key |
| `openrouterManagementKey` | ESC | BFF only: creates each organization's key (ADR-0121) | Possible the same way | Full key management | 90 days, issued with that expiry | Create a management key with an expiry, `esc env set`, deploy, delete the old one. Organization keys keep working across it |
| Per-organization OpenRouter keys | Secret store behind the BFF (`org_openrouter_keys`) | Every model call made for that organization | n/a, minted by us | Inference only; monthly backstop `openrouterOrgKeyMonthlyLimitUsd` | Event (scheduled rotation is an ADR-0121 follow-up) | Disable the key at OpenRouter and delete its row; the next call creates a new one |
| `OPENROUTER_API_KEY` (GitHub) | Repository secret | Release-note translation, live turn-shape eval | Release notes: yes, once `OPENROUTER_FEDERATION_POLICY_ID` is set. Turn shapes: no, the job outlives the 15-minute token | All inference | 90 days | Dedicated key with a monthly limit; replace the secret |
| `workosApiKey` | ESC | BFF (AuthKit, organizations, Vault, flags, audit logs, authorization) | No: WorkOS takes only `sk_` keys | Full environment, WorkOS has no scoped server keys | 90 days | Create a key in the WorkOS dashboard, `esc env set`, deploy, delete the old key |
| `WORKOS_API_KEY_STAGING` | Repository secret | WorkOS drift check | No | Full staging environment | 90 days | Its own staging key, never the BFF's |
| `otelOidcClientSecret` | ESC | Login gate of Langfuse and the Qdrant dashboard (WorkOS Connect app) | No | One OAuth app | 12 months | Up to 5 secrets can be active: add one, `esc env set`, deploy, delete the old |
| `tavilyApiKey` | ESC | Web search | No | All search; set a monthly credit cap per key | 90 days | Create a key while the old stays active, `esc env set`, deploy, delete the old |
| `cloudflareApiToken` | ESC | Pulumi (DNS, redirects) | No | One zone: DNS edit, redirects | 90 days, issued with `expires_on`; IP filter where CI egress is known | Roll it (`PUT /accounts/{id}/tokens/{id}/value`) or create a new one, `esc env set` |
| `POSTHOG_CLI_API_KEY` | Repository secret | Sourcemap upload, release annotations | No | Should be: one project, error tracking write and organization read, owned by a bot user | 90 days | Roll it in PostHog (no overlap: the old value dies at once) and replace the secret in the same minute |
| `PULUMI_ACCESS_TOKEN` | `staging` and `production` environment secrets | Deploys | **Yes, ready:** `PULUMI_OIDC_ORGANIZATION` | Personal token of one user | Delete after the cut-over | [`keyless-ci.md`](../deployment/keyless-ci.md) |
| `CLAUDE_CODE_OAUTH_TOKEN` | Repository secret | `@claude` and Claude code review | **Yes, ready:** `ANTHROPIC_FEDERATION_RULE_ID` | A person's subscription | Delete after the cut-over | [`keyless-ci.md`](../deployment/keyless-ci.md). Moves billing from the subscription to the API |
| `ANTHROPIC_API_KEY` | Repository secret, if still present | Nothing reads it | n/a | | Delete | Delete the secret |
| `RELEASE_PAT` | Repository secret | Pushes the changelog to `develop` | **Yes, ready:** the release GitHub App | A person's fine-grained PAT | Delete after the cut-over | [`keyless-ci.md`](../deployment/keyless-ci.md) |
| `RELEASE_APP_PRIVATE_KEY` | Repository secret | Mints the release app's one-hour tokens | The key itself does not expire | `contents: write` on this repository | 12 months | Generate a new private key on the app, replace the secret, delete the old key |
| `registryPassword` | ESC | Image pulls from ghcr.io | No: GitHub Apps cannot pull packages | A classic PAT with `read:packages`, today on a person's account | 90 days, issued with that expiry | Move it to a machine user; or make the images public and delete it |
| `kubeconfig` | ESC | Pulumi, deploys | No | Cluster service account | 12 months | New service-account token (`docs/deployment/kubernetes.md` §2b), `esc env set` |
| `err2issueGithubToken`, `otelPrimaryApiKey` | ESC, if still present | Nothing: both features are retired | n/a | | Delete | `esc env rm` in both environments, and revoke the GitHub token |

### Secrets we generate ourselves

All in ESC, generated with `openssl rand`, never typed or reused across
stacks. Rotating one means `esc env set` and a deploy; the ones marked *paired*
change on two sides and need the order in the note.

| Credentials | What they protect | Interval | Note |
|---|---|---|---|
| `pgAppPassword`, `pgRuntimePassword`, `pgScalerPassword`, `seaweedfsFilerDbPassword`, `langfuseDbPassword`, `langfuseClickhousePassword` | Database roles | 12 months | *Paired*: the role's password and every pod that connects. Schedule a short window until dual-role rotation exists (ADR-0122) |
| `dragonflyPassword`, `rateLimitStorePassword`, `langfuseQueuePassword` | Cache, rate-limit store, Langfuse queue | 12 months | *Paired*, as above |
| `seaweedfsSecretKey`, `seaweedfsTenantAdminSecretKey`, `seaweedfsBackendReadSecretKey`, `seaweedfsBackupAccessKey`, `seaweedfsBackupSecretKey`, `pgBackupSecretKey`, `qdrantS3SecretKey`, `langfuseS3SecretKey` | Object storage identities | 12 months | *Paired*, as above |
| `qdrantApiKey`, `qdrantReadOnlyApiKey`, `qdrantAltApiKey` | Vector store | 12 months | Qdrant takes an alternate key, so rotate through `qdrantAltApiKey` without downtime |
| `gridInternalApiToken`, `gridAdminToken`, `gridCorpusExportToken` | Service-to-service HMAC and admin endpoints | 12 months | *Paired* between BFF and backend; a rolling deploy rejects internal calls for its duration |
| `workosCookiePassword`, `langfuseNextAuthSecret`, `langfuseSalt` | Session cookies, Langfuse sessions | 12 months | Signs everyone out |
| `jobPayloadKek`, `byokLocalKek`, `langfuseEncryptionKey` | Keys that encrypt stored data | Event only | Rotating needs re-encryption of what they protect. Procedure: ADR-0122 |
| `webPushVapidPrivateKey` | Web Push sender identity | Event only | A new key invalidates every browser's subscription |
| `langfuseInitUserPassword`, `langfusePublicKey`, `langfuseSecretKey` | Langfuse bootstrap user and API pair | 12 months | |

## Access review

Every quarter, list who can read or change secrets in each of these, remove
anyone who no longer needs it, and add a line to the record:

- Pulumi Cloud organization (ESC environments `grid-oib/dev`, `grid-oib/prod`)
- GitHub: repository admins, and who can edit Actions secrets and environments
- OpenRouter organization admins, WorkOS dashboard members, Cloudflare account
  members, PostHog organization members, Tavily, Anthropic Console
- The cluster: holders of a kubeconfig

Pulumi's Free edition has one member and no audit log, so nobody but its
owner can see or review its secrets. Before an audit, move to an edition with
audit logs (Pro), or record the compensating control you rely on instead.

## How this maps to the standards

| Requirement | Covered by |
|---|---|
| ISO/IEC 27001:2022 A.5.17 Authentication information | Policy 1–6, the inventory |
| A.5.18 Access rights | Access review |
| A.8.5 Secure authentication | Keyless CI, short-lived tokens |
| A.8.24 Use of cryptography (key management) | Inventory intervals, the KEK procedure (ADR-0122) |
| A.8.15 Logging | The record; Pulumi and vendor audit logs where the edition has them |
| SOC 2 CC6.1 Logical access | Policy 2–4 |
| SOC 2 CC6.2, CC6.3 Granting and removing access | Access review, policy 5 |
| SOC 2 CC6.6 External access | Keyless CI, scoped vendor keys |

## Record

Newest first. One line per rotation, revocation, cut-over or access review.

| Date | What | Who | Evidence |
|---|---|---|---|
| 2026-10-20 | Policy and inventory written; keyless CI and per-organization OpenRouter keys merged, cut-over pending | | GRID-check/grid-oib-agent#1111 |
