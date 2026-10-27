---
status: proposed
date: 2026-10-27
decision-makers: product owner (Matthias)
consulted: the AI-Q rename session (Postgres databases and roles, `aiq-*` services), the code-identifier rename session
informed: everyone who deploys or operates the stack
---

# Infrastructure names carry no brand: namespace `workspace`, Pulumi project `workspace`, moved by expand, switch and contract

## Context and Problem Statement

Every Kubernetes object the Pulumi program creates lives in the namespace
`grid`. Most of them are prefixed `grid-`: the Secret `grid-secrets`, the
CloudNativePG cluster `grid-pg`, the Gateway `grid-gateway`, the certificates
`grid-app-tls`, the Langfuse route, the Qdrant dashboard policy, about seventy
names in all. The Pulumi project is `grid-oib`, so all 97 config keys in
`Pulumi.dev.yaml` and 115 in `Pulumi.prod.yaml` read `grid-oib:<key>`, and so
does every `pulumiConfig.grid-oib:*` key in the ESC environments
`grid-oib/dev` and `grid-oib/prod`. "Grid" is a retired name. Piloti will be
renamed too.

The rule: **no brand in an infrastructure identifier.** A name says what the
thing is. A brand lasts one marketing cycle. A namespace, a Pulumi project or a
database cluster costs an outage to rename, so it has to outlive several.

Most of these names carry state. A namespace cannot be renamed in Kubernetes.
Moving one means building a second namespace and moving the data into it:
Postgres, the SeaweedFS objects, the Qdrant vectors, the Langfuse traces in
ClickHouse, and every PVC. The product owner accepted a short outage, since
the product is in a pilot with no SLA, and asked for the move to be fully
automated and run by the normal deploy pipeline. Rollback has to stay possible
until the old namespace is deleted, and deleting it is its own last step.

## Decision Drivers

* **No manual cluster steps.** Every action is a Pulumi resource or a
  Kubernetes Job that `pulumi up` runs, idempotent and re-runnable. Nobody runs
  kubectl.
* **Rollback is a config change until the very end.** The old namespace stays
  intact and managed until a separate, last PR deletes it.
* **No ciphertext is hand-edited** (`deploy/AGENTS.md`). A `secure:` value is
  encrypted by its stack's key. It moves only by being decrypted by its own
  stack and written again by a CLI.
* **Dev first.** Each step lands on the `dev` stack and is verified there, with
  the deploy run and its checks in the PR, before a separate PR points the
  same step at `prod`.
* **Buy, don't build.** CloudNativePG's replica clusters, `rclone`, the Qdrant
  migration tool and ClickHouse `BACKUP`/`RESTORE` each already move one kind of
  data. We write the orchestration and nothing below it.

## Considered Options

* **A. Rename in place.** Run `pulumi stack rename matthiasbigl/workspace/dev`,
  then change `cfg.namespace` and let Pulumi replace every namespaced object.
* **B. A new project and namespace beside the old ones, then expand, switch
  and contract.** A new Pulumi project `workspace` with stacks `dev` and
  `prod` deploys the unchanged program into the namespace `workspace`. Its data
  tier follows the old one (a CNPG replica cluster, synced object storage,
  copied vectors) while its app tier stays at zero. One switch deploy stops the
  old app tier, promotes the new data tier and starts the new app tier. A later
  deploy, separate and last, deletes the old namespace and the old stack.
* **C. Re-bind the PersistentVolumes.** Set each PV to `Retain`, delete the
  claims in `grid` and create claims in the new namespace that bind the same
  volumes. Nothing is copied.
* **D. Do nothing.** Keep `grid` and `grid-oib` and rename only what costs no
  state.

## Decision Outcome

Chosen option: **B**. It is the only option where the old deployment stays
whole and managed until the final step, so rollback stays a revert of a config
flag. It is also the only option that renames the Pulumi project without
moving a single ciphertext by hand.

### The names

The namespace scopes every object inside it, so objects in it drop the prefix
and get the name of what they are. Cluster-scoped objects, and objects outside
the namespace, get a name that says whose they are.

| Today | Target | Kind |
|---|---|---|
| namespace `grid` | `workspace` | the deployment of the workspace: app and data tiers |
| Pulumi project `grid-oib` | `workspace` (stacks `matthiasbigl/workspace/dev`, `…/prod`) | |
| config keys `grid-oib:*` | `workspace:*` | |
| ESC environments `grid-oib/dev`, `grid-oib/prod` | `workspace/dev`, `workspace/prod` | |
| `grid-secrets` | `app-secrets` | the app tier's env Secret |
| CNPG `Cluster` `grid-pg` (Services `-rw`, `-pooler-rw`) | `postgres` (`postgres-rw`, `postgres-pooler-rw`) | |
| `grid-pg-backup-s3`, `grid-pg-keda-scaler-credentials` | `postgres-backup-s3`, `postgres-keda-scaler-credentials` | |
| `grid-gateway`, `grid-gatewayclass`, `grid-envoy-proxy` | `edge`, GatewayClass `workspace-edge`, `edge-proxy` | |
| `grid-app`, `grid-s3`, `grid-web`, `grid-langfuse` routes and their `-tls`, `-timeouts`, `-auth` siblings | `app`, `s3`, `web`, `langfuse` plus the same suffixes | |
| ClusterIssuer `letsencrypt-prod` (its HTTP-01 solver names the Gateway in `grid`) | a namespaced `Issuer` `letsencrypt` in `workspace` | |
| `grid-registry-pull`, `grid-ratelimit-redis-auth`, `grid-qdrant-*`, `grid-bff-jobs`, `grid-app-migrate`, … | the same without `grid-` | |
| label `app.kubernetes.io/part-of: grid-oib` | `workspace` | |
| annotation `grid.bigls.net/secret-checksum` | `checksum/secrets`, the Helm convention | |

The code PR carries the full map as a test: no object the program creates,
and no config key, contains `grid` or `piloti` (see Confirmation).

`workspace` rather than the `app` or `platform` the brief suggested: the
program already has layers called `src/app/` (the app tier) and
`src/platform/` (cert-manager, the Gateway, KEDA), and the product has an
admin area called Platform. A namespace `app` would hold the data tier too,
and a project `platform` would read as that one layer. `workspace` is what the
deployment serves, the noun [`VISION.md`](../../VISION.md) leads with, and it
is not a brand.

**Out of scope here, each with an owner:**

* Postgres database and role names (`grid_app`, `grid_app_rw`,
  `grid_keda_scaler`) and the `aiq-agent`/`aiq-api` services belong to the
  AI-Q rename session. A physical replica copies whatever names exist, so this
  move carries theirs unchanged.
* Env vars and code identifiers (`GRID_QDRANT_URL`, `gridInternalApiToken`)
  belong to the code-identifier session. The config **namespace**
  `grid-oib:` is ours. The key **names** after the colon are theirs.
* **Bucket names** (`grid-documents`, `grid-pg-backups`, the per-organization
  `grid-org-<id>`) and the SeaweedFS access key `grid`. Each document row
  records the bucket it was written to, and the per-org prefix is in UI code,
  so renaming a bucket is a row rewrite plus an object copy, coupled to the
  app. That is a follow-up ADR, written after this move. The move copies
  buckets under their current names.

### How each kind of state crosses

The new stack's data tier comes up in `expand` and follows the old one. Only
the last delta moves during the outage.

| State | How it crosses | During the outage |
|---|---|---|
| **CloudNativePG Postgres** | The new `Cluster` `postgres` bootstraps with `pg_basebackup` from `grid-pg-rw.grid.svc` and runs as a **replica cluster** (`replica.enabled: true`, `externalClusters`), streaming WAL. The streaming client certificate and CA are read from `grid` with `k8s.core.v1.Secret.get` and written into `workspace` by Pulumi, so no Job copies a key. Same image and Postgres major version as the source. | A gate Job runs `pg_switch_wal()` on the old primary and waits until the new cluster's replay LSN has reached it. Then `replica.enabled: false` promotes the new cluster. |
| **Postgres backups** | The new cluster archives under its own `serverName` (`postgres`), so its WAL never lands in the old cluster's path in the same bucket. The old cluster's base backups and WAL are copied with the objects (next row) and stay readable as history. | `ScheduledBackup` takes its first base backup right after promotion (`immediate: true`, as today). On `prod` the verify Job waits for it. |
| **SeaweedFS** (every bucket: documents, per-org, `grid-pg-backups`, Qdrant snapshots, Langfuse events) | A fresh SeaweedFS in `workspace`, same topology and identities. A Job runs `rclone sync` from the old S3 endpoint to the new one, per bucket, on every `expand` deploy. This works at the S3 layer, so it needs no knowledge of the topology or the filer store, and chunk encryption is re-keyed by the new filer for free. | A last `rclone sync` moves the delta, then `rclone check --one-way` must find no difference. |
| **Qdrant** | A Job runs the official `qdrant/migration` tool (scroll and upsert, resumable) per collection and copies the aliases, which no snapshot holds. On `expand` this is a timed rehearsal into collections that are then dropped. | Full copy into fresh collections. The `expand` rehearsal is what tells us how long this takes. The verify Job compares point counts and aliases. `QDRANT.snapshotJob` stays the backup, not the move: one collection snapshot covers only the shards on one peer, and `prod` runs three. |
| **ClickHouse** (Langfuse, when `langfuseEnabled`) | Nothing before the switch. | `BACKUP DATABASE … TO S3` on the old ClickHouse into its own SeaweedFS, carried by the last `rclone sync`, then `RESTORE … FROM S3` on the new one. Both are ClickHouse built-ins and keep Langfuse's migration table. Langfuse's Postgres database travels with the CNPG replica. |
| **Dragonfly** (cache, edge counters, conversation bus) | Recreated empty. | In-flight turns are lost, which the outage loses anyway. |
| **Other PVCs** | Geocoder data is re-downloaded by its own init. The retired Chroma volume `data-chroma-0`, kept as the way back from ADR-0115's migration, is **not** moved and dies with `grid` in the contract step. The contract PR says so to the product owner. | |

### The Pulumi project and its config keys

`pulumi stack rename matthiasbigl/workspace/dev` can move a stack into another
project (`pulumi stack rename` reference, read 2026-10-27), but it moves one
deployment. It cannot leave the old one running beside the new one, which
option B needs. And the reference says nothing about whether the Pulumi Cloud
secrets key survives the project change. So we do not rename. We create:

1. **Program layout.** `deploy/pulumi/` becomes the `workspace` project, with
   `Pulumi.yaml` `name: workspace` and stack files keyed `workspace:*`.
   The old project moves to `deploy/pulumi/legacy/`: a `Pulumi.yaml` with
   `name: grid-oib` and `main: ..`, plus the current stack files, unchanged
   except for the move-phase key. Both projects run **the same program**.
   `new pulumi.Config()` reads the running project's namespace, so neither
   needs a code branch for its prefix. The old stack keeps its history.
   The new stack's history starts at its first deploy.
2. **ESC.** The deploy workflow runs `pulumi env clone grid-oib/<stack>
   workspace/<stack>`, which re-encrypts every secret under the new
   environment. It then exports the definition (ciphertext only), rewrites
   `pulumiConfig.grid-oib:` to `pulumiConfig.workspace:` and saves it back with
   `pulumi env edit --file -`. Ciphertext stays bound to the environment that
   holds it, so a key rename inside one environment leaves every value
   decryptable. No plaintext leaves ESC. The step runs only when
   `workspace/<stack>` does not exist yet.
3. **The three stack-encrypted values.** `Pulumi.dev.yaml` still holds three
   `secure:` values (`pgRuntimePassword`, `seaweedfsBackendReadSecretKey`,
   `cloudflareApiToken`; `Pulumi.prod.yaml` holds none). They are encrypted by the **old** stack's key and
   cannot be copied as text. A workflow step reads each one with
   `pulumi config get --show-secrets` on the old stack and writes it with
   `pulumi env set workspace/<stack> pulumiConfig.workspace:<key> --secret`,
   only when that key is unset. The new stack file has no `secure:` block at
   all, which is what the stack file header already says it should have.
4. **The proof.** Before its first `up`, the new stack runs
   `pulumi config --show-secrets --json`, piped into a check that every key
   the program requires resolves to a non-empty value. A missing or
   undecryptable key fails `preview`. That is today's guard, unchanged.

Prerequisite: the CI Pulumi token needs write access to ESC. The first
`expand` run on `dev` shows whether it has it. If it does not, the product
owner grants it once in the Pulumi Cloud console. That is a permission, not
a cluster step.

### Edge: Gateway, TLS, DNS

Both stacks pin the same LoadBalancer IP (`loadBalancerIp`, annotation
`k8s.at/managed-loadbalancer-ip`). Only one Service can hold it, and the
provider keeps a released IP reserved for re-claiming. So:

* The new stack creates **no** Gateway until `switch`.
* In `switch`, the old stack's deploy runs first and deletes its Gateway,
  which releases the IP. The new stack's deploy then creates `edge` with the
  same annotation and the IP moves over. **DNS records do not change.** They
  stay owned by the old stack until the contract step (below), with the same
  content.
* TLS: the new Gateway's certificates are issued through the namespaced
  `Issuer` by HTTP-01 once the IP has moved, which takes about a minute inside
  the window. If issuance fails, the verify Job fails on its HTTPS probe, and
  rollback applies.

### NetworkPolicies, KEDA, CronJobs

* **NetworkPolicies.** Each namespace keeps its default deny. While a move
  phase is active, the old stack adds one policy that admits pods labelled
  `workspace-move/role: copier` from namespace `workspace` to Postgres 5432,
  SeaweedFS S3 and Qdrant only. The new stack adds the matching egress. Both
  go away in `contract`.
* **KEDA.** ScaledObjects and TriggerAuthentications are namespaced and are
  created in `workspace`, pointing at `workspace` Secrets. During `expand` and
  `standby`, the new stack's ScaledObjects carry KEDA's
  `autoscaling.keda.sh/paused-replicas: "0"`, so KEDA cannot wake a tier
  early. The KEDA operator is shared (below).
* **CronJobs** (purger, skill scheduler, Qdrant snapshot, SeaweedFS metadata
  snapshot, the CNPG `ScheduledBackup`). They are `suspend: true` in the
  standby stack and live in the active stack. The switch flips both sides in
  one run.

### Cluster-wide pieces

The CNPG operator, cert-manager, Envoy Gateway, KEDA and metrics-server Helm
releases, their namespaces, the OTel agent's ClusterRole, and the Cloudflare
DNS records exist once per cluster. The old stack owns them until contract.
The new stack runs with `sharedPlatform: external` and only references them.
It creates its own GatewayClass `workspace-edge` and its own namespaced
`Issuer`, so nothing it owns collides with them. They change hands in the
contract steps:

1. The old stack sets `retainOnDelete` on each shared resource. Pulumi keeps
   that flag in state.
2. The old stack's program declares nothing (`move: retired`), so its `up`
   deletes the namespace `grid` and everything in it, and drops the retained
   resources from its state without touching them. In the same run, the new
   stack switches to `sharedPlatform: owned` and adopts each one with the
   `import` resource option. Import ids come from a `StackReference` to the
   old stack's outputs, which step 1 adds.

### Order, phases, outage

One config key per stack, `move`, drives the whole migration. The deploy
workflow deploys the old stack and then the new stack, in one job, so no
two updates overlap.

| # | PR (dev, then a separate prod PR) | Old stack `grid-oib` | New stack `workspace` | Outage |
|---|---|---|---|---|
| 0 | this ADR | | | |
| 1 | program layout, ESC clone, renamed objects behind the names map | `move: off` (unchanged, no-op preview) | does not exist yet | none |
| 2 | **expand** | `move: source`: copier NetworkPolicy, retainOnDelete on shared | `move: expand`: replica cluster, SeaweedFS + `rclone sync`, Qdrant rehearsal, apps at 0, no Gateway | none |
| 3 | **switch** | `move: standby`: app tiers at 0, CronJobs suspended, Gateway deleted, Postgres left running | `move: active`: catch-up gate, promote, final sync, Qdrant copy, ClickHouse restore, migrations Job, apps up, Gateway, verify Job | **yes** |
| 4 | **contract**, after the product owner confirms | `move: retired`: `grid` deleted | `move: off`, `sharedPlatform: owned`: imports shared pieces | none |
| 5 | cleanup: delete `legacy/`, the move code and the workflow steps | gone | | none |

Expected outage on `dev`: stopping the old tiers about 1 minute; catch-up
gate and promotion about 2; the last `rclone` delta and the ClickHouse restore
a few minutes; the Qdrant copy as long as the `expand` rehearsal measured;
migrations Job, app start, IP move and certificates about 5. That is **15 to
30 minutes**. The `dev` switch run measures the real number, and the `prod`
switch PR quotes it, with a release note for operators announcing the window.

**Sequencing with the AI-Q rename.** The database and role rename and this
move never run in the same deploy. The AI-Q session finishes its
expand/switch/contract on a stack before step 2 merges there, so the replica
copies final names and the new cluster spec carries only those. Step 1 touches
no Postgres name and can merge alongside it. A stack whose AI-Q rename is
mid-flight blocks step 2 for that stack.

### Verification

The `active` deploy ends with a verify Job, and its failure fails the deploy
run:

* Postgres: per-table row counts in every database, old (stopped, so frozen)
  against new. The new cluster is primary and writable, and, on `prod`, its
  first base backup has completed.
* SeaweedFS: `rclone check --one-way` per bucket finds no difference.
* Qdrant: point counts per collection and the full alias list match.
* ClickHouse: row counts per Langfuse table match.
* Edge: `https://app.<baseDomain>/api/health` and the `s3.` and `web.` hosts
  answer over a certificate that validates, from inside the cluster through
  the public IP.

The PR for each stack's switch carries the deploy run link, the verify Job's
log and a signed-in smoke test: open a project, open a document, ask Piloti
one question.

### Rollback

Until step 4 merges, the old namespace is whole: its Postgres was stopped
only by having no clients, its PVCs are untouched, its objects are all still
in it. Rollback is a PR that sets `move: source` on the old stack (tiers up,
CronJobs live, Gateway back) and `move: rolled-back` on the new one (tiers 0,
Gateway deleted, data left for diagnosis). The workflow deploys the new stack
first in that direction, so the IP is free when the old Gateway asks for it.
Writes made in `workspace` after the switch are lost by a rollback. That is
the cost of keeping the old copy untouched, and it is acceptable at pilot
scale. To try again, `move: expand` with a bumped `moveAttempt` replaces the
new data tier from scratch.

After step 4 there is no rollback by config. Recovery from then on is the
normal disaster path: restore the new cluster from its own backups.

### Consequences

* Good, because every step is a Pulumi deploy that the pipeline runs and
  records, and every step before the last reverts by config.
* Good, because the old stack never changes shape, so its preview stays a
  no-op through steps 1 and 2. That makes "nothing moved early" checkable.
* Good, because no ciphertext is copied as text. Secrets move through ESC
  clone or through the old stack's own decryption.
* Good, because the data moves through tools that already exist for it: CNPG
  replica clusters, `rclone`, `qdrant/migration`, ClickHouse backups.
* Bad, because for steps 2 to 4 the cluster runs two data tiers. On `dev`
  that is about double the Postgres, SeaweedFS and Qdrant requests. The
  `expand` preview has to fit the node groups, and the `dev` PR quotes it.
* Bad, because the deploy workflow runs two stacks for a while, and its
  `pulumi config set grid-oib:imageTag` lines have to set images on both.
* Bad, because the new stack's Pulumi history starts empty. The old history
  stays readable under `grid-oib` until someone deletes that stack in Pulumi
  Cloud, which this ADR does not do.
* Bad, because a rollback after the switch loses the writes made in between.
* Bad, because bucket names keep `grid` until their own follow-up.

### Confirmation

* `deploy/pulumi/index-move.spec.ts`, added in step 1: for each `move` value
  it checks the resource set. `off` and `source` create nothing in
  `workspace`. `expand` creates no Gateway, keeps every app tier at 0 and every
  CronJob suspended, and sets `replica.enabled: true`. `active` gates the
  promotion on the catch-up Job, and the apps and the Gateway on the
  promotion. `retired` declares nothing but retained shared resources.
* `deploy/pulumi/index-names.spec.ts`: no `metadata.name`, namespace, label
  value or config key the program produces contains `grid` or `piloti`, once
  the `legacy/` stack is gone. During the move it runs against the
  `workspace` stack config only.
* `stack-files.spec.ts` gains a case, in step 1, that fails a `secure:` block
  in any stack file that imports an ESC environment. Nothing checks that
  today, which is how three of them stayed in `Pulumi.dev.yaml`.
* The switch PRs need their deploy run and verify log before merge. Review is
  that gate. Nothing in CI blocks a merge on a deploy that has not run yet.

## Pros and Cons of the Options

### A. Rename in place

* Good, because there is one stack throughout and no handover of shared
  resources.
* Bad, because changing `cfg.namespace` replaces every namespaced object in
  one `up`, and Pulumi deletes each old object after creating its new one.
  The old namespace's data is gone when that run ends, so there is no rollback
  by config, which the brief requires.
* Bad, because the project change rests on the Pulumi Cloud secrets key
  following a stack into a new project. The `pulumi stack rename` reference
  (read 2026-10-27) does not say that it does. If it is documented later,
  only the project half of this option improves. The namespace half stays
  ruled out by the bullet above.

### C. Re-bind the PersistentVolumes

* Good, because nothing is copied, so the window does not grow with data
  size.
* Bad, because CNPG names, labels and annotates its own PVCs and has no
  supported import of a foreign one, so Postgres still needs a copy. The
  premise is CNPG 1.2x behaviour, and an operator that adopts PVCs would
  re-open this.
* Bad, because the volumes leave `grid` at the switch. A rollback means
  binding them back by hand, which is exactly the kubectl work the brief
  excludes.

### D. Do nothing

* Good, because it costs nothing now.
* Bad, because the cost rises with every bucket, backup and object, and with
  the second rename the brand already faces. Pilot phase is the cheapest
  moment this will have.

## More Information

* Open on the AI-Q session: confirm the sequencing above, and that the CNPG
  `Cluster` and its Services (`grid-pg` → `postgres`) are this move's names,
  not theirs.
* Follow-up ADR: bucket names and the SeaweedFS access key, after step 4.
* Revisit if the cluster provider stops reserving a released LoadBalancer IP
  for re-claim. The edge plan above rests on that, and without it the switch
  has to change DNS instead.
* [`deploy/AGENTS.md`](../../deploy/AGENTS.md) for the stack-file rules,
  ADR-0041 (least-privilege Postgres roles), ADR-0043 (SeaweedFS topology),
  ADR-0115 (Qdrant), ADR-0044 (Langfuse).
