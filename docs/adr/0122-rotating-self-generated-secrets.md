---
status: proposed
date: 2026-10-20
decision-makers: product owner, Grid engineering
consulted: Grid engineering
informed: everyone working in this repo
---

# Self-generated secrets rotate by redeploy, through a second credential where the consumer can hold one

## Context and Problem Statement

About forty secrets per stack are ones we generate ourselves: database role
passwords, the cache and queue passwords, object-storage identities, the
internal HMAC tokens, cookie and session secrets, and three keys that encrypt
stored data (`jobPayloadKek`, `byokLocalKek`, `langfuseEncryptionKey`). They
live in Pulumi ESC (`grid-oib/<stack>`), and a deploy carries them into
Kubernetes Secrets whose checksum is stamped on every pod that reads them, so a
changed value rolls those pods.

The secrets policy ([`../compliance/secrets-and-keys.md`](../compliance/secrets-and-keys.md))
gives them a 12-month interval, and ISO 27001 and SOC 2 ask for evidence that
it is kept. Today nothing rotates them, and rotating one by hand breaks
something for a while, because most are *paired*: the database role, the cache
or the object store changes its side the moment the deploy reaches it, while
pods still holding the old value keep connecting until they are rolled. The
three encryption keys cannot rotate at all without re-encrypting what they
protect.

## Decision Drivers

* A rotation must not take the product down, or nobody will run it.
* Rotation has to be routine enough to happen on schedule, and leave evidence.
* No new service to run: the secrets already live in ESC, and the edition is
  Pulumi's Free one, where ESC's database rotators cannot reach a database on
  a private network (that needs a rotation connector, Pro and up).
* Encrypted data must stay readable across a key change.

## Considered Options

1. Rotate by hand, in a maintenance window.
2. Rotate by redeploy, through a second credential where the consumer can
   hold one.
3. ESC rotators on a schedule, delivered live by External Secrets Operator.
4. A self-hosted Vault (or OpenBao) issuing dynamic credentials.

## Decision Outcome

Proposed: option 2, "rotate by redeploy, through a second credential", because
it needs nothing we do not run, works on the Free edition, and turns each
paired secret into two deploys with no outage.

- **Two credentials where the protocol allows it.** The consumer accepts the
  current and the next value at once; a rotation is: add the next value,
  deploy, switch writers to it, deploy, drop the old one.
  - Qdrant already does this (`qdrantAltApiKey`).
  - Internal HMAC tokens (`gridInternalApiToken`, `gridAdminToken`,
    `gridCorpusExportToken`): verifiers accept `*_NEXT` as well; minters
    switch on the second deploy.
  - Database roles: two login roles per consumer with the same grants
    (`grid_app_rw` and `grid_app_rw_b`), and CloudNativePG's managed roles
    hold both; pods move to the other role on one deploy, and the idle role's
    password is replaced on the next. The cache and queue passwords follow
    the same pattern if the server lets one user hold two passwords (Redis
    ACL users can; whether Dragonfly does is to be checked when this is
    built). If it does not, those two stay a short window.
  - Object-storage identities: SeaweedFS accepts several identities, so the
    same two-step move applies.
- **Secrets that sign sessions** (`workosCookiePassword`,
  `langfuseNextAuthSecret`) rotate in one deploy and sign everyone out; they
  are scheduled for a quiet hour.
- **Encryption keys are versioned, not replaced.** New ciphertext records the
  key id it was written with; old keys stay available for decryption only, and
  a re-encryption job moves old data to the new key before an old key is
  retired. Until that exists they rotate on an event only.
- **The schedule is a calendar, the evidence the record.** Each rotation is a
  pull request that changes the ESC value through the documented commands and
  adds its line to the record in the secrets policy.
- **Generation stays `openssl rand` into ESC.** Moving generation into Pulumi
  (`@pulumi/random` with a rotation epoch as keeper) is a later step once the
  two-credential consumers exist, so a bump of one config value rotates the
  lot.

### Consequences

* Good, because no rotation needs downtime except the session secrets, and
  possibly the cache and queue passwords, and those are named.
* Good, because it needs no new service and no paid edition.
* Bad, because each two-credential consumer is code: the HMAC verifiers, the
  second database role and its grants, the SeaweedFS identity, the key-id
  envelope for encrypted data. Each lands as its own change.
* Bad, because a rotation is two deploys, and a person has to start them.
* Bad, because values reach pods only by deploy; a leaked secret is replaced
  as fast as a deploy runs, not faster.

### Confirmation

Nothing enforces this yet; review is the only gate. Each two-credential
consumer arrives with a test that accepts both values and refuses a third, and
the record in the secrets policy is checked at the quarterly access review.

## Pros and Cons of the Options

### 1. By hand, in a window

* Good, because it needs no code.
* Bad, because every rotation is an outage, so it will be skipped.

### 3. ESC rotators and External Secrets Operator

* Good, because rotation is scheduled and reaches pods without a deploy.
* Bad, because the database rotators need a rotation connector (Pro and up)
  to reach a private database, External Secrets Operator needs its own
  credential to ESC unless the cluster's issuer is public, and env-var
  consumers still need a restart controller. Revisit on Pro.

### 4. Self-hosted Vault

* Good, because dynamic database credentials that expire on their own are
  its strength.
* Bad, because it becomes the most critical service we run (unsealing,
  availability, backups, upgrades) for coverage ESC already gives.

## More Information

- The vendor half (OpenRouter, WorkOS, PostHog, Tavily, Cloudflare, CI) is
  the secrets policy and [`../deployment/keyless-ci.md`](../deployment/keyless-ci.md).
- Pulumi ESC rotators: https://www.pulumi.com/docs/esc/providers/rotators/
