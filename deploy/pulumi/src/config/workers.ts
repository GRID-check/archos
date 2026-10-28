/**
 * The background workers and their limits: ingest, BFF jobs, KEDA, the provider ceilings, Gotenberg and the geocoder.
 */
import * as pulumi from "@pulumi/pulumi";
import { GEOCODER } from "../constants";
import { GOTENBERG_SLOTS_PER_REPLICA, bffJobsMode } from "../rendition-sizing";
import { bool, num, positiveInt } from "./readers";
import type { ResourceSpec } from "./resources";

export interface GotenbergConfig {
  /**
   * Run the office → PDF converter (ADR-0070). Required for indexing Word,
   * presentation, .xls and .ods files, which the backend reads only from the
   * PDF (ADR-0071). When false the frontend gets no `GOTENBERG_URL`: those
   * files are marked failed with a retryable reason, and .xlsx/.xlsm index
   * without preview or thumbnail.
   */
  enabled: boolean;
  image: string;
  /**
   * Converter replicas. One LibreOffice converts one document at a time per
   * replica, so this is the fleet's conversion capacity, and the thing the
   * `bff-jobs` pool's rendition ceiling is held to (`renditionCeiling`):
   * every replica added is {@link GOTENBERG_SLOTS_PER_REPLICA} more
   * conversions the pool may have in flight.
   */
  replicas: number;
}

export interface GeocoderConfig {
  /**
   * OFF by default: prepared, switched on per stack (`geocoderEnabled`).
   * The first start downloads about 1 GB from download1.graphhopper.com and
   * the jar from GitHub, so the cluster needs egress to both.
   */
  enabled: boolean;
  /** The Java runtime Photon runs on (Java 21+, Photon 1.x). Digest-pinned. */
  image: string;
  /** The init container that fetches and verifies the jar and the index (busybox wget, tar, bunzip2). Digest-pinned. */
  fetchImage: string;
  /** The Photon 1.x index tarball; its checksum is read from `<url>.md5`. */
  indexUrl: string;
  /** The index volume. The index takes about 2 GB; a refresh holds the old and the new one side by side, plus the tarball. */
  storageSize: string;
  /**
   * At pod start, an index older than this is fetched again (old one kept
   * when the fetch fails). Nothing restarts the pod on a clock: a refresh
   * happens at the next restart past this age.
   */
  indexMaxAgeDays: number;
}

export interface IngestWorkerConfig {
  resources: ResourceSpec;
  /** Floor; 0 lets the tier scale to nothing while no job waits. */
  minReplicas: number;
  /**
   * Ceiling. The real ceiling is the model provider's rate limit on the
   * shared key: replicas × concurrency × `VLM_BATCH_WORKERS` is the
   * peak number of VLM calls in flight, and `assertVlmPeakFitsCeiling` fails
   * the deploy when that is more than twice `vlmFleetConcurrency`, which is
   * itself held to the provider ceilings.
   */
  maxReplicas: number;
  /** Jobs one replica runs at once (`INGEST_MAX_WORKERS`); also KEDA's jobs-per-replica target. */
  concurrency: number;
  /** SIGTERM budget to finish claimed jobs; an unfinished one is claimed again elsewhere. */
  drainSeconds: number;
  /** Most jobs one organisation may run fleet-wide at once; 0 = no cap (the claim is fair regardless). */
  maxPerOrg: number;
  /**
   * `MAX_IMAGE_PIXELS`: an embedded raster larger than this many pixels is
   * refused before it is decoded. pypdfium2 cannot downscale an embedded image
   * on decode, so this is the only bound on one bitmap's allocation; the
   * PDFium lock serialises decodes within a process, so the tier's raster peak
   * is near this number (times ~4 bytes a pixel), not this times `concurrency`.
   * The default admits an A0 sheet at 400 dpi (~248 MP) and refuses the
   * 20000x20000 px raster (~400 MP) from the OOM report. 0 refuses every
   * embedded raster.
   */
  maxImagePixels: number;
}

export interface BffJobsConfig {
  enabled: boolean;
  resources: ResourceSpec;
  /** Floor; 0 lets the pool scale to nothing while no job waits. */
  minReplicas: number;
  maxReplicas: number;
  /** Jobs one replica runs at once (`BFF_JOBS_CONCURRENCY`); also KEDA's jobs-per-replica target. */
  concurrency: number;
  /** SIGTERM budget to finish the slice in hand; the claim is then given back without costing an attempt. */
  drainSeconds: number;
  /** Most jobs one organisation may run fleet-wide at once; 0 = no cap (the claim is fair regardless). */
  maxPerOrg: number;
  /**
   * Where a slice runs (`BFF_JOBS_MODE`): `http`, in a `node server.js`
   * the pod spawns, or `inprocess`, in the supervisor from the bundled
   * services (`dist-jobs/slice.mjs`, ADR-0079 amendment 1). `http` until the
   * in-process host has run in every environment.
   */
  mode: "http" | "inprocess";
  /**
   * Office conversions ONE pod runs at Gotenberg at once (`GOTENBERG_MAX_
   * CONCURRENCY` in the pod). The fleet's ceiling is this times `maxReplicas`
   * ({@link renditionCeiling}), and a spec holds that to the converter's
   * capacity: more than Gotenberg can convert queues inside it, and what
   * queues there counts against its own API timeout.
   */
  renditionConcurrency: number;
}

export interface KedaConfig { install: boolean }

export interface ProviderLimitsConfig {
  /** `VLM_FLEET_CONCURRENCY`: vision calls in flight across every ingest process at once. */
  vlmFleetConcurrency: number;
  /** `VLM_BATCH_WORKERS`: vision calls one file runs at once. */
  vlmBatchWorkers: number;
  /** `PROVIDER_LIMIT_CEILING`: model calls in flight fleet-wide, all models together. */
  limitCeiling: number;
  /** `PROVIDER_MODEL_LIMIT_CEILING`: model calls in flight fleet-wide to one model. */
  modelLimitCeiling: number;
}

export function loadWorkers(
  cfg: pulumi.Config,
): { gotenberg: GotenbergConfig; geocoder: GeocoderConfig; ingestWorker: IngestWorkerConfig; bffJobs: BffJobsConfig; keda: KedaConfig; providerLimits: ProviderLimitsConfig } {
  return {
    gotenberg: {
      enabled: bool(cfg, "gotenbergEnabled", true),
      // Pinned, LibreOffice-only variant (no Chromium, so no HTML/URL routes).
      // The container args in constants.ts are 8.x flag names, and a flag
      // this binary does not know (any --chromium-*) stops it at boot. Keep it equal to the
      // Compose pin (deploy/compose/docker-compose.yaml).
      image: cfg.get("gotenbergImage") ?? "gotenberg/gotenberg:8.37.0-libreoffice",
      // Unset, it is what the bff-jobs pool needs at its ceiling, so the defaults hold
      // `renditionCeiling <= gotenbergCapacity` (asserted in gotenberg.spec.ts).
      replicas: Math.max(
        1,
        num(
          cfg,
          "gotenbergReplicas",
          Math.ceil(
            (Math.max(1, num(cfg, "bffJobsMaxReplicas", 4)) * Math.max(1, num(cfg, "bffJobsRenditionConcurrency", 1))) /
              GOTENBERG_SLOTS_PER_REPLICA,
          ),
        ),
      ),
    },
    geocoder: {
      enabled: bool(cfg, "geocoderEnabled", false),
      // Both official images, pinned by digest: there is no upstream Photon
      // image, and this pod sees every address a person types (ADR-0120).
      // Temurin 21.0.12.1+1 on Ubuntu 24.04, the multi-arch index Docker Hub's
      // `21.0.12.1_1-jre-noble` tag resolved to on 2026-10-22. Moved off
      // 21.0.12_8 because its OpenSSL (libssl3t64 3.0.13-0ubuntu3.15) carried
      // CVE-2026-84782; this one carries 0ubuntu3.16, read from its dpkg
      // database by a local trivy scan, with the same entrypoint, JAVA_HOME and
      // PATH, and still no fixed user.
      image:
        cfg.get("geocoderImage") ??
        "eclipse-temurin:21.0.12.1_1-jre-noble@sha256:35501d3f93173b420ac9001658eb68157e813316b865087e345c187fca422c4c",
      fetchImage:
        cfg.get("geocoderFetchImage") ??
        "alpine:3.22.6@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8",
      indexUrl: cfg.get("geocoderIndexUrl") ?? GEOCODER.defaultIndexUrl,
      storageSize: cfg.get("geocoderStorageSize") ?? "10Gi",
      indexMaxAgeDays: positiveInt(cfg, "geocoderIndexMaxAgeDays", 30),
    },
    ingestWorker: {
      // The memory request is what a worker measurably holds while it parses
      // (4 to 6 GB on prod, 2026-10), not its idle floor. At the old 1536Mi the
      // scheduler packed three workers onto one 16 GB node against limits of
      // 6Gi each; they grew past the node's RAM, workers were OOMKilled and the
      // node went NotReady. A default rather than a prod override, because the
      // number is the workload's, whichever stack runs it.
      resources: {
        requestsCpu: cfg.get("ingestWorkerRequestsCpu") ?? "500m",
        requestsMemory: cfg.get("ingestWorkerRequestsMemory") ?? "4Gi",
        limitsCpu: cfg.get("ingestWorkerLimitsCpu") ?? "2",
        limitsMemory: cfg.get("ingestWorkerLimitsMemory") ?? "6Gi",
      },
      minReplicas: Math.max(0, num(cfg, "ingestWorkerMinReplicas", 1)),
      // 5 x 3 x `VLM_BATCH_WORKERS` (4) = 60, within 2 x the vision pool (32): the
      // most the default budget can feed (`assertVlmPeakFitsCeiling`).
      maxReplicas: Math.max(1, num(cfg, "ingestWorkerMaxReplicas", 5)),
      concurrency: Math.max(1, num(cfg, "ingestWorkerConcurrency", 3)),
      drainSeconds: Math.max(30, num(cfg, "ingestWorkerDrainSeconds", 600)),
      maxPerOrg: Math.max(0, num(cfg, "ingestMaxPerOrg", 0)),
      // One decoded raster peaks near this times ~4 bytes (1 GiB at the default
      // 256 MP). 268_435_456 is adapter.py's own default: 256 MP admits an A0
      // sheet at 400 dpi and refuses a 20000x20000 px pavement.
      maxImagePixels: Math.max(0, num(cfg, "ingestWorkerMaxImagePixels", 268_435_456)),
    },
    bffJobs: {
      enabled: cfg.getBoolean("bffJobsEnabled") !== false,
      // A reindex or a rescan only pages and POSTs, but an IFC model is parsed
      // here too (`bim_extract`): several times its own size in memory, up to
      // `maxIfcBytes`, with `bffJobsConcurrency` of them at once. So the limit
      // is double a frontend pod's; the request stays where the walk needs it.
      resources: {
        requestsCpu: cfg.get("bffJobsRequestsCpu") ?? "250m",
        requestsMemory: cfg.get("bffJobsRequestsMemory") ?? "512Mi",
        limitsCpu: cfg.get("bffJobsLimitsCpu") ?? "1",
        limitsMemory: cfg.get("bffJobsLimitsMemory") ?? "2Gi",
      },
      minReplicas: Math.max(0, num(cfg, "bffJobsMinReplicas", 1)),
      maxReplicas: Math.max(1, num(cfg, "bffJobsMaxReplicas", 4)),
      concurrency: Math.max(1, num(cfg, "bffJobsConcurrency", 2)),
      drainSeconds: Math.max(15, num(cfg, "bffJobsDrainSeconds", 60)),
      maxPerOrg: Math.max(0, num(cfg, "bffJobsMaxPerOrg", 0)),
      mode: bffJobsMode(cfg.get("bffJobsMode")),
      // One: LibreOffice converts one document at a time, and the second slot
      // Gotenberg is sized for is the next job waiting behind it. A pod running
      // two jobs at once still converts one file at a time.
      renditionConcurrency: Math.max(1, num(cfg, "bffJobsRenditionConcurrency", 1)),
    },
    keda: { install: cfg.getBoolean("installKeda") ?? true },
    // Defaults are the backend image's own (`adapter.py`, `processing.py`,
    // `provider_limiter.py`), written down here so the stack file, not a Python
    // default, is where the fleet's budget is read and changed.
    providerLimits: {
      vlmFleetConcurrency: Math.max(0, num(cfg, "vlmFleetConcurrency", 32)),
      vlmBatchWorkers: Math.max(1, num(cfg, "vlmBatchWorkers", 4)),
      limitCeiling: Math.max(1, num(cfg, "providerLimitCeiling", 128)),
      modelLimitCeiling: Math.max(1, num(cfg, "providerModelLimitCeiling", 32)),
    },
  };
}
