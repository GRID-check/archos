/**
 * SeaweedFS (ADR-0043): topology, filer store, volume sizing, per-organization buckets, backup and encryption.
 */
import * as pulumi from "@pulumi/pulumi";
import { LANGFUSE, QDRANT } from "../constants";
import { bool, num, requireSecretsTogether } from "./readers";

/**
 * Postgres database AND role name for the SeaweedFS filer namespace.
 *
 * Not a knob. It is referenced from four places that must agree exactly — the
 * CNPG `managed.roles` entry, the CNPG `Database` CR, the `filer.toml` the
 * filer mounts, and the `REVOKE CONNECT` in the init Job — and a name is not
 * something an operator gains anything by choosing. It is deliberately NOT one
 * of the three application databases: the filer store holds a decryption key
 * for every chunk in the object store, so it gets its own database, owned by
 * its own login, with `CONNECT` revoked from `PUBLIC`.
 */
export const SEAWEED_FILER_DB = "seaweedfs_filer";

export interface SeaweedfsConfig {
  /**
   * SeaweedFS server image. Defaults to `latest` (project preference for
   * fresh components); for prod consider pinning (the compose stack pins
   * 3.80) — this is the storage engine, and the provider's automatic node
   * replacement re-pulls the tag at unpredictable times.
   */
  image: string;
  storageSize: string;
  bucket: string;
  accessKey: string;
  secretKey: pulumi.Output<string>;
  /**
   * How SeaweedFS is laid out (ADR-0043).
   *
   * `single` — one `weed server -s3` process running master + volume + filer
   * + gateway against one PVC. What every deployment ran before ADR-0043.
   *
   * `split` — three workloads: a master StatefulSet, a horizontally scalable
   * volume StatefulSet, and a filer StatefulSet carrying the S3 gateway. This
   * is what makes volume capacity a replica count instead of a PVC resize,
   * and what lets the filer store (which holds every chunk's AES key) live
   * somewhere other than the disk holding the ciphertext.
   *
   * **Switching is a data migration, not a config change.** The two
   * topologies use different PVCs, so flipping this on a stack that already
   * holds objects starts an EMPTY cluster while the old volumes sit
   * untouched on a PVC nothing mounts. `docs/deployment/kubernetes.md`
   * § "Migrating SeaweedFS to the split topology" is the runbook; existing
   * stacks pin `single` in their own `Pulumi.<stack>.yaml` until they have
   * run it.
   */
  topology: "single" | "split";
  /** Master replicas (split only). Raft — must be odd. 1 = no HA. */
  masterReplicas: number;
  /** Volume-server replicas (split only). This is the capacity knob. */
  volumeReplicas: number;
  /** Filer+gateway replicas (split only). See `filerStore` before raising. */
  filerReplicas: number;
  /** PVC size for the master's `-mdir` (raft log + volume-id sequence). */
  masterStorageSize: string;
  /**
   * PVC size for the filer's `-defaultStoreDir` (split only).
   *
   * Its own knob rather than the master's, which it used to borrow. The two
   * disks hold nothing alike: the master's is a raft log and a volume-id
   * sequence and is genuinely tiny, while under `filerStore: "leveldb"` the
   * filer's holds the metadata entry AND the per-chunk AES key for every
   * object in the deployment. Sharing the knob meant an operator whose filer
   * store was filling had nothing to raise but the master's claim, and a full
   * filer store stops every write.
   *
   * The default is deliberately larger than the master's for that reason. Under
   * `filerStore: "postgres"` the namespace lives in Postgres and this claim
   * holds almost nothing — but it is still mounted, so it still needs a size.
   */
  filerStorageSize: string;
  /**
   * Size cap for a single volume file, in MB (master `-volumeSizeLimitMB`).
   *
   * SeaweedFS's own default is 30000 (≈30 GB), which is sized for bare-metal
   * disks and is a trap on a PVC: the volume server derives its writable-slot
   * count from `free / volumeSizeLimit`, so a 20 Gi PVC with a 30 GB limit
   * computes ONE slot, and a 10 Gi PVC computed zero — which surfaced live as
   * "No writable volumes and no free volumes left" on every upload. 1 GiB
   * volumes keep that arithmetic sane at PVC sizes and cost nothing:
   * SeaweedFS grows volumes lazily, so slots are not preallocated.
   */
  volumeSizeLimitMB: number;
  /** Writable volume slots per volume server (`-max`). */
  volumeMaxCount: number;
  /**
   * Free space below which a volume server marks ALL its volumes read-only
   * (`-minFreeSpace`). Must exceed one `volumeSizeLimitMB`, or the disk can
   * hit ENOSPC in the middle of growing a volume before the brake engages.
   */
  volumeMinFreeSpace: string;
  /**
   * SeaweedFS replica placement, `<diffDC><diffRack><sameRack>` (master
   * `-defaultReplication`). `000` = one copy. `010` = two copies in
   * different racks — and each volume pod reports its Kubernetes NODE as its
   * rack, so `010` is what actually puts the two copies on two machines.
   * `loadConfig` refuses a placement that needs more volume servers than the
   * deployment runs.
   */
  defaultReplication: string;
  /**
   * Where the filer keeps the namespace (split only).
   *
   * `postgres` — a dedicated database and role on the existing CNPG cluster,
   * via SeaweedFS's `[postgres2]` store. The filer's PVC goes unused, the
   * metadata inherits Postgres' backups and replication, and — the reason
   * this exists — the per-chunk encryption keys stop living on the same disk
   * as the chunks they open.
   *
   * `leveldb` — an embedded store on the filer's own PVC. No extra moving
   * parts, but single-replica only, and it puts the keys back beside the
   * ciphertext (one disk, both halves).
   */
  filerStore: "postgres" | "leveldb";
  /** Postgres role/database name for the `postgres` filer store. */
  filerDatabase: string;
  filerDatabaseUser: string;
  filerDatabasePassword: pulumi.Output<string>;
  /**
   * Dedicated READ-ONLY, bucket-scoped S3 identity for the aiq-agent tier
   * (ADR-0039 `look`): its SeaweedFS s3.json entry grants
   * `Read` on the documents bucket only — no Write/Admin — and the backend
   * never receives the root `grid` access key. The secret key MUST be
   * distinct from `seaweedfsSecretKey`: shared key material would let the
   * backend pod authenticate as the root Admin identity.
   */
  backendReadAccessKey: string;
  backendReadSecretKey: pulumi.Output<string>;
  /**
   * Give every organization its own S3 bucket instead of a key prefix inside
   * one shared bucket (ADR-0043).
   *
   * What it buys, concretely: tenant erasure becomes `DeleteBucket` instead
   * of a paginated list-and-delete that can half-finish; a prefix bug can no
   * longer read across tenants because the bucket, not the key, is the
   * boundary; and usage becomes measurable per tenant at the storage layer
   * rather than only in the application's own ledger.
   *
   * Objects written before this was switched on stay exactly where they are.
   * The bucket is persisted on each document row (`documents.storage_bucket`,
   * NULL meaning "the shared bucket"), so old and new coexist indefinitely
   * and there is no cutover moment.
   */
  perOrgBuckets: boolean;
  /**
   * Bucket-name prefix for per-organization buckets. Load-bearing for
   * authorization: the S3 identities are scoped with `<Action>:<prefix>*`,
   * so this prefix is what separates "every tenant bucket" from "also the
   * Postgres backup archive". `loadConfig` refuses a prefix that overlaps
   * any platform bucket name.
   */
  tenantBucketPrefix: string;
  /**
   * Credential for the ONLY identity allowed to create and drop tenant
   * buckets. Held by the provisioning and purge paths, never by the ordinary
   * object-CRUD path — SeaweedFS's `Admin:<bucket>` authorises DeleteBucket
   * as well as CreateBucket, so separating the credential is the only way to
   * keep bucket lifecycle off the request path.
   */
  tenantAdminAccessKey: string;
  tenantAdminSecretKey: pulumi.Output<string>;
  /**
   * Offsite backup for the documents bucket (ADR-0042).
   *
   * Disabled by default because it needs an EXTERNAL S3 target to mean
   * anything: pointing it back at this cluster's own SeaweedFS reproduces the
   * exact hole it exists to close. Enabling it without `endpoint`/keys is
   * refused at load time rather than silently running a backup to nowhere.
   */
  backup: {
    enabled: boolean;
    /** External S3 endpoint. MUST NOT be the in-cluster SeaweedFS. */
    endpoint: string;
    bucket: string;
    region: string;
    accessKey: pulumi.Output<string>;
    secretKey: pulumi.Output<string>;
    /** 5-field cron for the `fs.meta.save` snapshot. Default: nightly 03:00. */
    metadataSchedule: string;
  };
  /**
   * Encrypt chunk data written to volume servers. ON by default.
   *
   * A FILER flag (`-filer.encryptVolumeData`) — the volume server has no
   * concept of encryption and stores the ciphertext as opaque bytes. Each
   * chunk gets its own AES-256-GCM key, generated at write time from
   * crypto/rand.
   *
   * TWO THINGS TO KNOW, both consequences rather than reasons not to:
   *
   * 1. **New writes only.** Objects already in the bucket stay plaintext and
   *    keep working (each chunk carries its own key, or none). There is no
   *    bulk-encrypt tool; encrypting the existing corpus means rewriting every
   *    object. Turning the flag back OFF is safe for reads — already-encrypted
   *    chunks keep their keys.
   *
   * 2. **The filer store becomes the key store for every object.** Lose or
   *    corrupt it and the volume data is unrecoverable ciphertext — no master
   *    key, no escrow, no recovery. That makes the metadata snapshot
   *    (`seaweedfsBackupEnabled`, ADR-0042 Layer B) load-bearing rather than
   *    nice to have, and it is why `loadConfig` warns below when encryption is
   *    on without a backup.
   *
   * Scope of protection: someone who obtains volume disks WITHOUT the filer
   * store. In the current single-node topology the filer's leveldb store sits
   * on the SAME PVC as the volume data, so that separation does not exist yet
   * and the real gain is the GDPR-erasure property (drop the metadata and the
   * bytes become undecryptable). Moving the filer store to Postgres — the
   * topology split ADR-0042 defers — is what turns this into disk-theft
   * protection.
   */
  encryptVolumeData: boolean;
}

export function loadSeaweedfs(cfg: pulumi.Config): SeaweedfsConfig {
  // ── SeaweedFS topology (ADR-0043) ─────────────────────────────────────────
  // Every check here is about one thing: the two topologies do not share PVCs,
  // and the two filer stores do not share a namespace. Getting either wrong
  // produces a cluster that starts cleanly, reports healthy, and cannot see a
  // single existing object — the worst possible failure shape, because nothing
  // is broken enough to page anyone.
  const seaweedTopologyRaw = (cfg.get("seaweedfsTopology") ?? "split").trim();
  if (seaweedTopologyRaw !== "single" && seaweedTopologyRaw !== "split") {
    throw new Error(
      `grid-oib:seaweedfsTopology must be "single" or "split" (got "${seaweedTopologyRaw}").`,
    );
  }
  const seaweedTopology: "single" | "split" = seaweedTopologyRaw;
  const seaweedFilerStoreRaw = (cfg.get("seaweedfsFilerStore") ?? "postgres").trim();
  if (seaweedFilerStoreRaw !== "postgres" && seaweedFilerStoreRaw !== "leveldb") {
    throw new Error(
      `grid-oib:seaweedfsFilerStore must be "postgres" or "leveldb" (got "${seaweedFilerStoreRaw}").`,
    );
  }
  const seaweedFilerStore: "postgres" | "leveldb" = seaweedFilerStoreRaw;
  const seaweedMasterReplicas = num(cfg, "seaweedfsMasterReplicas", 1);
  const seaweedFilerReplicas = num(cfg, "seaweedfsFilerReplicas", 1);
  if (seaweedTopology === "split") {
    // Raft cannot form a majority from an even number of voters: 2 masters
    // tolerate zero failures and deadlock on a split, which is strictly worse
    // than 1. Refuse rather than let someone "add HA" and reduce availability.
    if (seaweedMasterReplicas < 1 || seaweedMasterReplicas % 2 === 0) {
      throw new Error(
        `grid-oib:seaweedfsMasterReplicas must be an odd number >= 1 (got ${seaweedMasterReplicas}). ` +
          "The masters form a Raft quorum, and an even count tolerates no more failures than " +
          "the odd number below it while adding a way to deadlock.",
      );
    }
    if (num(cfg, "seaweedfsVolumeReplicas", 1) < 1) {
      throw new Error("grid-oib:seaweedfsVolumeReplicas must be >= 1.");
    }
    // An embedded leveldb lives on the pod's own PVC, so a second replica gets
    // a second, DIFFERENT namespace. Both would answer S3 requests and each
    // would see roughly half the objects, depending on which pod the Service
    // picked. Nothing would error.
    if (seaweedFilerStore === "leveldb" && seaweedFilerReplicas > 1) {
      throw new Error(
        `grid-oib:seaweedfsFilerReplicas is ${seaweedFilerReplicas} with the embedded leveldb ` +
          "filer store. Each replica would keep its own private namespace on its own PVC, so " +
          "the same object would exist or not depending on which pod answered. Use " +
          'seaweedfsFilerStore="postgres" to run more than one filer.',
      );
    }
    if (seaweedFilerReplicas < 1) {
      throw new Error("grid-oib:seaweedfsFilerReplicas must be >= 1.");
    }
    if (seaweedFilerStore === "postgres" && cfg.getSecret("seaweedfsFilerDbPassword") === undefined) {
      throw new Error(
        "grid-oib:seaweedfsFilerDbPassword is required when seaweedfsFilerStore is \"postgres\". " +
          "It is the login for the dedicated Postgres role that owns the filer namespace — " +
          'set it with `pulumi config set --secret grid-oib:seaweedfsFilerDbPassword "$(openssl rand -base64 24)"`.',
      );
    }
  } else {
    // Non-default replica counts on the single-node topology are a silent
    // no-op: there is exactly one process and one PVC. Say so at plan time
    // rather than let someone believe they scaled something.
    if (seaweedMasterReplicas !== 1 || num(cfg, "seaweedfsVolumeReplicas", 1) !== 1 || seaweedFilerReplicas !== 1) {
      pulumi.log.warn(
        'grid-oib:seaweedfsTopology is "single", so seaweedfsMasterReplicas / ' +
          "seaweedfsVolumeReplicas / seaweedfsFilerReplicas are ignored — the single-node " +
          'topology is one process on one PVC. Set seaweedfsTopology="split" to scale it.',
      );
    }
  }
  // Volume sizing. Both numbers are only meaningful relative to each other and
  // to the PVC, which is why they are checked together rather than clamped
  // individually.
  const seaweedVolumeSizeLimitMB = num(cfg, "seaweedfsVolumeSizeLimitMB", 1024);
  if (seaweedVolumeSizeLimitMB < 1 || seaweedVolumeSizeLimitMB > 30000) {
    // 30000 is SeaweedFS's own hard ceiling — `weed master` fatals above it.
    throw new Error(
      `grid-oib:seaweedfsVolumeSizeLimitMB must be between 1 and 30000 (got ${seaweedVolumeSizeLimitMB}).`,
    );
  }
  {
    // A volume server marks every volume read-only once free space drops below
    // `-minFreeSpace`. If that threshold is smaller than one volume, the disk
    // can run out WHILE a volume is growing into it — the brake engages after
    // the crash it exists to prevent.
    const minFree = cfg.get("seaweedfsVolumeMinFreeSpace") ?? "2GiB";
    const match = /^(\d+(?:\.\d+)?)\s*(GiB|GB|MiB|MB)$/i.exec(minFree.trim());
    if (match) {
      const value = Number(match[1]);
      const unit = match[2].toUpperCase();
      const mib = unit.startsWith("G") ? value * 1024 : value;
      if (mib < seaweedVolumeSizeLimitMB) {
        throw new Error(
          `grid-oib:seaweedfsVolumeMinFreeSpace (${minFree}) is smaller than one volume ` +
            `(seaweedfsVolumeSizeLimitMB=${seaweedVolumeSizeLimitMB}MB). The read-only brake would ` +
            "engage only after a volume had already run the disk out mid-write.",
        );
      }
    }
    // A bare number means "percent" to SeaweedFS, which we cannot check against
    // a PVC size here — leave it to the operator.
  }
  const seaweedReplication = (cfg.get("seaweedfsDefaultReplication") ?? "000").trim();
  if (!/^[0-9]{3}$/.test(seaweedReplication)) {
    throw new Error(
      `grid-oib:seaweedfsDefaultReplication must be three digits, ` +
        `<diffDataCenter><diffRack><sameRack> (got "${seaweedReplication}").`,
    );
  }
  {
    // Copies = the three digits plus the original. SeaweedFS does not fail the
    // deployment when it cannot place them; it fails each volume-grow attempt
    // with "Only has N racks, not enough for M", which surfaces as uploads that
    // stop working once the first volume fills. Catch it at plan time.
    const copies =
      Number(seaweedReplication[0]) + Number(seaweedReplication[1]) + Number(seaweedReplication[2]) + 1;
    const volumeReplicas = num(cfg, "seaweedfsVolumeReplicas", 1);
    if (seaweedTopology === "split" && copies > volumeReplicas) {
      throw new Error(
        `grid-oib:seaweedfsDefaultReplication "${seaweedReplication}" asks for ${copies} copies but ` +
          `seaweedfsVolumeReplicas is ${volumeReplicas}. Volume growth would fail once the first ` +
          "volume fills, which looks like uploads spontaneously breaking rather than a config error.",
      );
    }
    if (seaweedTopology === "single" && copies > 1) {
      throw new Error(
        `grid-oib:seaweedfsDefaultReplication "${seaweedReplication}" asks for ${copies} copies, but ` +
          'seaweedfsTopology="single" runs exactly one volume server. Use "000".',
      );
    }
  }
  // ── Per-organization buckets (ADR-0043) ───────────────────────────────────
  const seaweedPerOrgBuckets = bool(cfg, "seaweedfsPerOrgBuckets", false);
  const seaweedTenantPrefix = (cfg.get("seaweedfsTenantBucketPrefix") ?? "grid-org-").trim();
  // Validated UNCONDITIONALLY, not only when the feature is on, because the
  // grants are issued unconditionally. `Read:<prefix>*` is emitted whether or
  // not per-organization buckets are enabled — that is what keeps a rollback
  // from revoking access to everything written while they were — so the prefix
  // is load-bearing even in a deployment that has never created a tenant
  // bucket. Gating these checks on the flag would let
  // `seaweedfsTenantBucketPrefix: grid-` sail through with the feature off and
  // hand `grid-documents` AND `grid-pg-backups` to every identity holding a
  // tenant scope, including the read-only agent credential. That is the exact
  // bug ADR-0043 exists to fix, re-entered through a side door.
  //
  // S3 bucket names: 3–63 chars, lowercase alphanumeric and hyphens, must start
  // with a letter or digit. The prefix is only part of a name, so the length
  // floor does not apply to it — but every other rule does, and the trailing
  // hyphen is what keeps `grid-org-*` from also matching a hypothetical
  // `grid-organizations` bucket.
  if (!/^[a-z0-9][a-z0-9-]*-$/.test(seaweedTenantPrefix)) {
    throw new Error(
      `grid-oib:seaweedfsTenantBucketPrefix must be lowercase alphanumeric/hyphen, start with a ` +
        `letter or digit, and end with "-" (got "${seaweedTenantPrefix}").`,
    );
  }
  if (seaweedTenantPrefix.length > 32) {
    throw new Error(
      `grid-oib:seaweedfsTenantBucketPrefix is ${seaweedTenantPrefix.length} chars. S3 caps a ` +
        "bucket name at 63, and the organization id plus a collision-proof hash needs the rest.",
    );
  }
  // Reserved by S3 and rejected by SeaweedFS's own `VerifyS3BucketName`, so a
  // prefix starting with it produces names that fail at CreateBucket time for
  // every tenant.
  if (seaweedTenantPrefix.startsWith("xn--")) {
    throw new Error(
      `grid-oib:seaweedfsTenantBucketPrefix must not start with "xn--" (got "${seaweedTenantPrefix}") — ` +
        "S3 reserves that prefix and SeaweedFS rejects such a bucket name outright.",
    );
  }
  // THE load-bearing check. The S3 identities are scoped with
  // `<Action>:<prefix>*`, matched by string prefix — so a prefix that is itself
  // a prefix of a platform bucket name silently re-grants that bucket to every
  // identity holding a tenant scope, including the read-only agent credential.
  // `grid-` as a prefix would hand out `grid-documents` AND `grid-pg-backups`,
  // i.e. the entire Postgres PITR archive.
  {
    const platformBuckets = [
      cfg.get("seaweedfsBucket") ?? "grid-documents",
      cfg.get("pgBackupBucket") ?? "grid-pg-backups",
      cfg.get("seaweedfsBackupBucket") ?? "grid-documents-backup",
      LANGFUSE.bucket,
      QDRANT.snapshotBucket,
    ];
    for (const bucket of platformBuckets) {
      if (bucket.startsWith(seaweedTenantPrefix)) {
        throw new Error(
          `grid-oib:seaweedfsTenantBucketPrefix "${seaweedTenantPrefix}" is a prefix of the platform ` +
            `bucket "${bucket}". Tenant grants are wildcard-scoped (\`Read:${seaweedTenantPrefix}*\`) and ` +
            "match by string prefix, so this would hand that bucket to every identity holding a " +
            "tenant scope — including the read-only agent credential.",
        );
      }
    }
  }
  // Only the CREDENTIAL is gated, because creating buckets is the one thing
  // that genuinely stops when the feature is off.
  if (seaweedPerOrgBuckets && cfg.getSecret("seaweedfsTenantAdminSecretKey") === undefined) {
    throw new Error(
      "grid-oib:seaweedfsTenantAdminSecretKey is required when seaweedfsPerOrgBuckets is true. " +
        "It is the credential for the only identity allowed to create and drop tenant buckets — " +
        'set it with `pulumi config set --secret grid-oib:seaweedfsTenantAdminSecretKey "$(openssl rand -base64 24)"`.',
    );
  }
  // Fail fast: a documents backup that writes back into this cluster's own
  // SeaweedFS is not a backup — it is a second copy on the disk you are trying
  // to survive losing. Refuse the two ways that happens: no endpoint at all, and
  // an endpoint pointing at the in-cluster service.
  const seaweedBackupEnabled = cfg.getBoolean("seaweedfsBackupEnabled") ?? false;
  if (seaweedBackupEnabled) {
    const backupEndpoint = cfg.get("seaweedfsBackupEndpoint") ?? "";
    if (!backupEndpoint) {
      throw new Error(
        "grid-oib:seaweedfsBackupEndpoint is required when seaweedfsBackupEnabled is true. " +
          "Point it at an EXTERNAL S3 endpoint — an in-cluster target does not survive the " +
          "cluster loss the backup exists to cover.",
      );
    }
    // Plaintext offsite is worse than no offsite: every document, and the
    // long-lived S3 secret key that signs for them, would cross the open
    // internet in the clear. The previous check only refused an in-CLUSTER
    // endpoint, so `http://backup.example.com` sailed through.
    if (!backupEndpoint.startsWith("https://")) {
      throw new Error(
        `grid-oib:seaweedfsBackupEndpoint must be https:// (got ${backupEndpoint}). ` +
          "The mirror ships every document plus a long-lived S3 credential; over plaintext " +
          "HTTP both are readable by anyone on the path.",
      );
    }
    if (backupEndpoint.includes("seaweedfs:8333") || backupEndpoint.includes("//seaweedfs")) {
      throw new Error(
        `grid-oib:seaweedfsBackupEndpoint points at the in-cluster SeaweedFS (${backupEndpoint}). ` +
          "That stores the backup on the same volumes as the data. Use an external S3 endpoint.",
      );
    }
    // BOTH keys. Half a credential is worse than none: the plan succeeds, the
    // sidecar starts, and every request fails `SignatureDoesNotMatch` against a
    // mirror the operator believes is running.
    requireSecretsTogether(
      cfg,
      ["seaweedfsBackupAccessKey", "seaweedfsBackupSecretKey"],
      "when seaweedfsBackupEnabled is true",
    );
  }
  // Encryption on + no metadata backup is the one combination that loses data
  // PERMANENTLY rather than temporarily. Chunk keys live in the filer store, so
  // without a snapshot of that store there is no path back from its corruption —
  // the volume files survive as ciphertext nobody can open. Warn rather than
  // refuse: an operator may be running encryption deliberately in dev, and a
  // hard failure would make the safer default (encryption on) harder to adopt
  // than the unsafe one.
  const seaweedEncrypt = cfg.getBoolean("seaweedfsEncryptVolumeData") ?? true;
  if (seaweedEncrypt && !seaweedBackupEnabled) {
    pulumi.log.warn(
      "SeaweedFS volume encryption is ON but seaweedfsBackupEnabled is false. Chunk keys live in " +
        "the filer metadata store, so losing it makes every encrypted object unrecoverable — " +
        "there is no master key and no escrow. Enable the backup (ADR-0042) before storing " +
        "anything you cannot afford to lose, or set seaweedfsEncryptVolumeData=false.",
    );
  }
  // Chunk encryption only protects against someone who gets the CIPHERTEXT
  // without the KEYS. On the single-node topology, and on the split topology
  // with the embedded store, both halves sit on disks in the same cluster —
  // and under `single` they sit on the SAME PVC. The feature is still worth
  // having there (dropping the metadata makes the bytes undecryptable, which is
  // the GDPR-erasure property), but calling it at-rest protection would be a
  // lie, so say what it is.
  if (
    seaweedEncrypt &&
    (seaweedTopology === "single" || seaweedFilerStore === "leveldb")
  ) {
    pulumi.log.warn(
      "SeaweedFS volume encryption is ON, but the filer store shares a cluster (and under " +
        'seaweedfsTopology="single", the same PVC) with the volume data it encrypts. Anyone who ' +
        "can read the volume files can read the keys beside them, so this is not disk-theft " +
        'protection yet — it buys crypto-erasure only. seaweedfsTopology="split" with ' +
        'seaweedfsFilerStore="postgres" is what separates the two (ADR-0043).',
    );
  }
      return {
    image: cfg.get("seaweedfsImage") ?? "chrislusf/seaweedfs:latest",
    storageSize: cfg.get("seaweedfsStorageSize") ?? "20Gi",
    bucket: cfg.get("seaweedfsBucket") ?? "grid-documents",
    accessKey: cfg.get("seaweedfsAccessKey") ?? "grid",
    secretKey: cfg.requireSecret("seaweedfsSecretKey"),
    // Read-only, bucket-scoped identity for the aiq-agent tier (see the type
    // doc above). The secret key must be its own value, set like the root:
    // `pulumi config set --secret grid-oib:seaweedfsBackendReadSecretKey "…"`.
    backendReadAccessKey: cfg.get("seaweedfsBackendReadAccessKey") ?? "grid-backend-read",
    backendReadSecretKey: cfg.requireSecret("seaweedfsBackendReadSecretKey"),
    perOrgBuckets: seaweedPerOrgBuckets,
    tenantBucketPrefix: seaweedTenantPrefix,
    tenantAdminAccessKey: cfg.get("seaweedfsTenantAdminAccessKey") ?? "grid-tenant-admin",
    tenantAdminSecretKey: cfg.getSecret("seaweedfsTenantAdminSecretKey") ?? pulumi.secret(""),
    topology: seaweedTopology,
    masterReplicas: seaweedMasterReplicas,
    volumeReplicas: num(cfg, "seaweedfsVolumeReplicas", 1),
    filerReplicas: seaweedFilerReplicas,
    masterStorageSize: cfg.get("seaweedfsMasterStorageSize") ?? "1Gi",
    // 10Gi, not the master's 1Gi: under the leveldb store this claim is the
    // key store for every object in the deployment, and it is the one PVC
    // whose exhaustion stops all writes.
    filerStorageSize: cfg.get("seaweedfsFilerStorageSize") ?? "10Gi",
    volumeSizeLimitMB: seaweedVolumeSizeLimitMB,
    volumeMaxCount: num(cfg, "seaweedfsVolumeMaxCount", 64),
    volumeMinFreeSpace: cfg.get("seaweedfsVolumeMinFreeSpace") ?? "2GiB",
    defaultReplication: seaweedReplication,
    filerStore: seaweedFilerStore,
    filerDatabase: SEAWEED_FILER_DB,
    filerDatabaseUser: SEAWEED_FILER_DB,
    // Only read when the split topology uses the Postgres store — see the
    // validation above, which is what turns a missing value into a clear
    // error instead of a filer that boots and cannot reach its store.
    filerDatabasePassword:
      cfg.getSecret("seaweedfsFilerDbPassword") ?? pulumi.secret(""),
    backup: {
      enabled: cfg.getBoolean("seaweedfsBackupEnabled") ?? false,
      endpoint: cfg.get("seaweedfsBackupEndpoint") ?? "",
      bucket: cfg.get("seaweedfsBackupBucket") ?? "grid-documents-backup",
      region: cfg.get("seaweedfsBackupRegion") ?? "us-east-1",
      accessKey: cfg.getSecret("seaweedfsBackupAccessKey") ?? pulumi.secret(""),
      secretKey: cfg.getSecret("seaweedfsBackupSecretKey") ?? pulumi.secret(""),
      metadataSchedule: cfg.get("seaweedfsMetaSnapshotSchedule") ?? "0 3 * * *",
    },
    encryptVolumeData: cfg.getBoolean("seaweedfsEncryptVolumeData") ?? true,
  };
}
