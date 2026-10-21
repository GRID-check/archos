---
status: proposed
date: 2026-10-21
decision-makers: Platform
consulted:
informed: everyone who ships to this repo
---

# Object storage grows as a shared pool of volume servers, never as a disk per organization

## Context and Problem Statement

On 2026-10-20 a new organization could not upload anything: every first upload
failed with „Object storage is unavailable". Prod runs SeaweedFS 3.80 as one
`weed server` process on one 20 Gi PVC (`single`, ADR-0043), with a bucket per
organization (`seaweedfsPerOrgBuckets`). Each bucket is a SeaweedFS
*collection*, and a new collection takes up to 7 volume slots on its first
write: `Copy1Count: 7` in `weed/topology/volume_growth.go` at tag 3.80. Prod
allowed 64 slots, so the store filled up after roughly nine buckets, platform
buckets included. The disk itself was nearly empty: 3.7 GB stored across 7
organizations. #1117 raised the slot count to 512, which is about 70
organizations. Nothing warned anyone: #1117 also added the log line and the
PostHog alert that would have caught it.

512 moves the wall without removing it. Three more limits sit behind it:

* **Disk.** The volume is 20 Gi and holds every organization's documents. It
  also holds the Postgres PITR archive, Qdrant snapshots and Langfuse blobs.
  Growing it means hand-patching a PVC, because a StatefulSet's claim template
  is immutable (`kubernetes.md`, "Storage").
* **One process.** Master, volume server, filer and S3 gateway restart
  together, and the filer's chunk keys share the disk with the ciphertext
  (ADR-0043).
* **Dev.** Dev runs per-org buckets on the default 64 slots, the same
  configuration that failed in prod.

The owner asked for storage that scales dynamically: "claim more PVCs when
needed, named after the organization they belong to". This record decides
where capacity lives, and how it grows without a person in the hot path.

## Decision Drivers

* **A new organization never fails its first upload because of a storage
  limit.** Running out is detected days ahead, not by a customer.
* **Capacity grows without a code change**, within a ceiling someone chose.
  Block storage cannot shrink, so every automatic expansion is a permanent
  cost.
* **One organization's storage is legible and erasable as a unit.** It can be
  measured, named and deleted, including for GDPR erasure (ADR-0011,
  ADR-0043).
* **A team of one to three runs it.** Buy before build, and add no stateful
  service that needs its own on-call.
* **The cluster as it is:**
  * IPAX managed k0s.
  * Lightbits NVMe/TCP block storage, read-write-once only, with online
    expansion.
  * A `data` node group fixed at four nodes.
  * KEDA already installed, and already scaling a StatefulSet
    (`backend-scaling.ts`).
  * Since ADR-0119, every SeaweedFS process and every kubelet's volume stats
    are scraped into PostHog, where alerting lives.

## Considered Options

* **A. Do nothing more:** 512 slots and a hand-resized 20 Gi PVC.
* **B. A disk per organization:** a PVC per organization, named after it, with
  a volume server to mount it, created when the organization first uploads.
* **C. A shared pool that grows itself.** Organizations stay buckets. Capacity
  is a pool of volume servers whose disks grow and whose number grows, each
  automatically and within a cap.
* **D. Managed S3 from an EU provider**, with capacity left to the provider.
* **E. One bucket, a prefix per organization:** the bucket-count cost
  disappears.

## Decision Outcome

Chosen option: **C, a shared pool that grows itself**, because it is the only
option that removes both walls (slots and disk) without a person in the loop.
It keeps tenancy where it already works, in the bucket. It also uses
machinery the stack already runs: the split topology (ADR-0043), KEDA, and the
ADR-0119 metrics.

Tenancy and capacity are separate layers, and every product surveyed keeps
them separate:

* **Tenancy:** who owns these bytes, how they are named and measured, and how
  they are erased. This stays the bucket `grid-org-<slug>-<hash>`, one SeaweedFS
  collection per organization.
* **Capacity:** how many bytes the cluster can hold. This becomes a pool of
  volume servers, each with its own PVC.

The pool grows two ways, each automatic and capped:

* **Up:** a volume server's PVC grows when it is nearly full.
* **Out:** when the pool as a whole runs short, KEDA adds a volume server. Its
  StatefulSet claims the next PVC by itself. This is the "claim more PVCs when
  needed" part, and it happens per pool, not per organization.

Option B is rejected as the default (see its section below). A dedicated
volume server for one large customer stays possible later through SeaweedFS
path placement, the AWS "bridge" model, without making every organization pay
for it.

Option D is the revisit trigger, not the plan. See More Information.

### The plan, in phases

Each phase stands on its own and leaves prod safer than before.

**Phase 0: stop bucket count being the limit (a day, one SeaweedFS restart).**

* Set `WEED_MASTER_VOLUME_GROWTH_COPY_1=1` on the master process (the `single`
  pod today, `seaweedfs-master` after Phase 2). SeaweedFS's viper config reads
  `WEED_`-prefixed environment variables (`weed/util/config.go`); verify it on
  dev with `/dir/status` before relying on it.
* `seaweedfs-bucket-init` also runs
  `fs.configure -locationPrefix=/buckets/ -volumeGrowthCount=1 -apply`. This is
  the per-path rule SeaweedFS's S3 FAQ gives for exactly this error, and it
  covers every bucket, existing and future.
* Budget three slots per bucket, not one. On 3.80 a background loop adds two
  volumes per collection about every 15 minutes while slots are free
  (`master_grpc_server_volume.go`); 4.x no longer does when growth is set by
  configuration only. 512 slots then hold about 165 organizations instead of
  about 70.
* Dev gets the same configuration, and its own `seaweedfsVolumeMaxCount`.

**Phase 1: see it coming (a day).** Add rows to the PostHog **Data stores**
alert (ADR-0119, [`metrics.md`](../observability/metrics.md#alerts)), because
rows, not new alerts, are where rules go on the free plan:

| Row | Fires when | Why |
|---|---|---|
| Free slots | `SeaweedFS_volumeServer_max_volumes` minus the sum of `SeaweedFS_volumeServer_volumes` falls below 30 (about ten new organizations) | The wall we hit, seen a week out |
| Write placement failing | `SeaweedFS_master_pick_for_write_error` increases | The wall itself: an upload is failing now |
| Pool disk | `k8s.volume.available / k8s.volume.capacity` under 20% on any `data-seaweedfs*` claim, from `kubelet_stats` | Disk, the next wall |
| Volumes going read-only | `SeaweedFS_volumeServer_read_only_volumes{type="isDiskSpaceLow"}` above 0 | SeaweedFS's own brake has engaged |

#1117's `bff-upstream-error` alert stays as the last line: a user is already
seeing an error.

**Phase 2: the split topology in prod (a maintenance window).** Follow the
runbook in `kubernetes.md`, "Migrating SeaweedFS to the split topology". Rehearse
it on dev first; it has never been applied to a live stack. On the new volume
servers:

* `-max=0`, so the slot count follows the disk on every heartbeat (no restart
  needed).
* `seaweedfsVolumeSizeLimitMB: 1024`, small volumes, so slots are plentiful.
* `seaweedfsVolumeMinFreeSpace: 2GiB`. Today `single` runs SeaweedFS's
  defaults for both of these.

Two prerequisites the runbook names: the offsite documents mirror must be on
(it is off in both stacks), and the filer's Postgres store must be provisioned.
This phase also delivers what ADR-0043 wanted for its own reasons: roles that
restart separately, and chunk keys off the data disk.

**Phase 3: the pool grows by itself, within caps.**

* **3a, up.** Use [topolvm/pvc-autoresizer](https://github.com/topolvm/pvc-autoresizer)
  (bought, not built) on the `data-seaweedfs-volume-*` claims:
  * threshold 20%, increase 25%;
  * a required `storage_limit` per claim, for example 200 Gi.
  * With `-max=0`, a bigger disk is more slots with no restart.
  * It needs `allowVolumeExpansion` on the IPAX `premium` class, and a
    Prometheus-compatible source for `kubelet_volume_stats_*`. Both are open
    questions below.
* **3b, out.** Add a KEDA `ScaledObject` on the `seaweedfs-volume` StatefulSet,
  built like `backend-scaling.ts`:
  * **Trigger:** a `metrics-api` trigger on an internal endpoint that reports
    the pool's fill (free slots and free bytes from the master's `/dir/status`
    and each volume server's disk status).
  * **Up only:** scale-down is disabled. A volume server holds data, and
    removing one is a drain, not a scale-in.
  * **`fallback`:** keep the current count.
  * **`maxReplicaCount`:** the number of `data` nodes, because volume servers
    spread one per node.
  * **What a scale-up does:** the StatefulSet claims `data-seaweedfs-volume-N`,
    the master places new volumes on the emptiest server, and a weekly
    `volume.balance` in the master's maintenance scripts evens out older
    volumes.

  Up comes first because it is one pod and one annotation, and at today's
  growth it covers years. Out is the step for when one PVC's cap is reached.

**Phase 4 (optional): an unbounded cold tier.** SeaweedFS Cloud Tier
(`volume.tier.upload`) moves sealed, read-mostly volumes to an Austrian S3,
such as STACKIT EU02 or Exoscale AT-VIE. A tiered volume stops using a local
slot. Only if hot data outgrows what the `data` node group can attach.

### What "named after the organization" becomes

The owner's underlying ask (to see and handle one organization's storage as a
thing) is met at the tenancy layer, where it already exists:

* **The name.** The bucket is `grid-org-<slug>-<hash>`, and its collection
  carries the same name.
* **Physical bytes per organization.** `SeaweedFS_volumeServer_total_disk_size{collection}`
  is already in PostHog (ADR-0119). Shown next to the ledger on Platform →
  Storage, it reconciles what we bill against what the disk holds. Drift
  between them is a bug to find.
* **Erasure.** Deleting the bucket drops the collection and frees its volumes
  and slots, so organization offboarding (ADR-0011, phase 4, still to be
  built) frees capacity as one call rather than a prefix sweep.

### Consequences

* Good, because a new organization costs about three slots (one on 4.x) and no
  disk until it stores something. Slots stop being a wall, and disk is watched
  four ways.
* Good, because capacity grows automatically in both directions that exist (a
  bigger disk, another server), each through a tool the stack already has or a
  maintained open-source one. Nothing here is a storage system we write.
* Good, because the per-org view is real: physical bytes per organization next
  to the ledger, named by the organization.
* Bad, because every automatic expansion is permanent spend. PVCs do not
  shrink, and `premium` is replicated three times by the provider. The caps
  (`storage_limit`, `maxReplicaCount`) are the budget, and hitting one has to
  page, not quietly stop.
* Bad, because Phase 2 is a data migration on the store that holds every
  document, along a runbook never run live. It needs a rehearsal, a window, and
  the offsite mirror switched on first.
* Bad, because the horizontal step is capped by the four fixed `data` nodes.
  Past four volume servers, either the node group grows or the
  one-per-node spread relaxes.
* Neutral, because three slots per bucket on 3.80 is a SeaweedFS behaviour, not
  ours. Upgrading to 4.x brings it to one.

### Confirmation

Nothing enforces this yet. Each phase lands with its gate:

* **Phase 0.**
  * A `seaweedfs.spec.ts` case holds that the master carries
    `WEED_MASTER_VOLUME_GROWTH_COPY_1=1` whenever `seaweedfsPerOrgBuckets` is
    on, and that bucket-init runs the `/buckets/` growth rule.
  * `loadConfig` refuses per-org buckets without both. This is the same kind
    of refusal it already makes for an unsafe `minFreeSpace`.
* **Phase 1.** The four rows are recorded in `metrics.md` beside the insight's
  SQL, as ADR-0119 requires.
* **Phase 3.**
  * A spec holds that every `data-seaweedfs-volume` claim carries a
    `storage_limit`, and that the volume `ScaledObject` has scale-down disabled
    and a `fallback`.
  * The CrossGuard policy pack refuses an autoresize annotation without a
    limit.

## Pros and Cons of the Options

### A. Do nothing more

* Good, because it costs nothing today.
* Bad, because about 70 organizations is a date on the calendar, and 20 Gi a
  nearer one. Both arrive with no warning beyond #1117's after-the-fact alert.

### B. A disk per organization

* Good, because an organization's bytes are physically separate, and erasure is
  deleting a claim.
* Bad, because SeaweedFS does not map a bucket to a disk. The master places a
  collection's volumes across all servers. Pinning an organization means one
  volume server per organization plus a placement rule per bucket, which is a
  pod, a PVC and a rule for each organization.
* Bad, because it multiplies the wall it was meant to remove:
  * Each disk is sized for its own headroom. Seventy organizations at even
    5 Gi is 350 Gi of `premium` (about 1 TB raw at the provider's
    three-fold replication), mostly empty.
  * Each disk fills on its own schedule, so there are seventy alerts instead
    of one.
  * Each disk still pays SeaweedFS's per-collection slots.
* Bad, because it runs into node limits. Every read-write-once claim must be
  attached to a node. The `data` group has four nodes, and a CSI driver caps
  the volumes attachable per node.
* Bad, because nobody surveyed ships it for object data:
  * Supabase Storage, Nextcloud, GitLab and Sentry keep tenants as keys or
    buckets on a shared store.
  * AWS's SaaS guidance frames per-tenant silos as a tenancy choice inside a
    service, not as a disk per tenant.
  * The per-tenant-instance pattern seen for databases (a CloudNativePG cluster
    each) is accepted only with "real overhead" for a reason specific to
    databases: separate backups and upgrades.
* Neutral, because the one real benefit, physical separation for a customer who
  demands it, survives in option C as a dedicated volume server for that one
  customer.

### C. A shared pool that grows itself

Chosen. Its trade-offs are the Consequences above.

### D. Managed S3 from an EU provider

* Good, because capacity stops being ours to manage. EU providers price at
  about €6 to €28 per TB-month (Hetzner, Scaleway, OVHcloud, STACKIT), and
  STACKIT EU02 and Exoscale AT-VIE keep data in Austria.
* Bad, because a bucket per organization hits provider bucket quotas:
  * Exoscale allows 20 buckets per account and has no lifecycle rules.
  * Hetzner allows 100, OVHcloud 100 (1,000 on request).

  Moving means changing tenancy to option E as well, with per-organization
  keys for crypto-erasure.
* Bad, because documents would leave the cluster for a second provider. That
  is a new data processor for GDPR, and a change to `lib/legal/content`.
* Unknown: whether IPAX itself offers S3. Its public site lists none. Ask.

### E. One bucket, a prefix per organization

* Good, because it is what Supabase and GitLab do, and it makes bucket count
  irrelevant everywhere, managed providers included.
* Bad, because ADR-0043 moved off exactly this: a key-construction bug becomes
  a cross-tenant bug, and erasure becomes a paginated sweep that can stop
  halfway. Undoing that needs per-organization key wrapping first.
* Neutral, because it becomes the right move together with D, not before it.

## More Information

**Revisit when** either of these happens:

* The store holds more than about 500 GB, or more than 150 organizations on
  3.80.
* A customer requires data outside our cluster or provider.

Either is the point to price option D against the pool's provider spend, with
option E alongside it.

**Open questions, owner first:**

1. Does IPAX's `premium` StorageClass set `allowVolumeExpansion: true`? Check
   with `kubectl get sc premium -o yaml`. `kubernetes.md` says expansion works
   online. Phase 3a depends on it.
2. Where does pvc-autoresizer read `kubelet_volume_stats_*`? We run no
   Prometheus. The provider's VictoriaMetrics in the `victoria` namespace
   answers PromQL, if we may query it. Failing that, a small `vmsingle` beside
   the collector's `:8889` re-export, which also lets the Qdrant rules ADR-0119
   left unevaluated run.
3. Does IPAX offer managed S3? This matters for option D and Phase 4.
4. When do we upgrade from SeaweedFS 3.80 to 4.x? It fixes the background
   growth loop (one slot per bucket instead of three) and is due anyway.

**Sources.**

* SeaweedFS:
  * `Copy1Count: 7` (`weed/topology/volume_growth.go` at 3.80).
  * The S3 FAQ's `fs.configure … -volumeGrowthCount=1`.
  * [Optimization for many small buckets](https://github.com/seaweedfs/seaweedfs/wiki/Optimization-for-Many-Small-Buckets).
  * `-max=0` auto sizing (`weed/storage/store.go`).
  * [Cloud Tier](https://github.com/seaweedfs/seaweedfs/wiki/Cloud-Tier).
* [AWS SaaS storage strategies](https://docs.aws.amazon.com/whitepapers/latest/multi-tenant-saas-storage-strategies/multi-tenant-saas-storage-strategies.html)
  and [S3 partitioning for multi-tenant SaaS](https://aws.amazon.com/blogs/apn/partitioning-and-isolating-multi-tenant-saas-data-with-amazon-s3/).
* How other products lay out tenant storage:
  * [Supabase Storage](https://github.com/supabase/storage/blob/master/src/storage/locator.ts)
  * [Nextcloud primary storage](https://docs.nextcloud.com/server/stable/admin_manual/configuration_files/primary_storage.html)
  * [GitLab object storage](https://docs.gitlab.com/ee/administration/object_storage)
* Kubernetes:
  * [pvc-autoresizer](https://github.com/topolvm/pvc-autoresizer)
  * [Kubernetes volume limits per node](https://kubernetes.io/docs/concepts/storage/storage-limits)
  * [KubePersistentVolumeFillingUp](https://runbooks.prometheus-operator.dev/runbooks/kubernetes/kubepersistentvolumefillingup/)
* Managed S3 quotas:
  * [Exoscale limits](https://community.exoscale.com/product/storage/object-storage/service-boundaries/limits-and-quotas/index.md)
  * [Hetzner object storage](https://docs.hetzner.com/storage/object-storage/overview)
  * [STACKIT object storage](https://stackit.com/en/products/storage/stackit-object-storage)
* MinIO was not considered for new work: its community edition entered
  maintenance mode in late 2025
  ([InfoQ](https://infoq.com/news/2025/12/minio-s3-api-alternatives/)). Ceph
  (Rook) grows the most naturally of all, by adding an OSD, but is the heaviest
  to run for a team this size.
