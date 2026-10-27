/**
 * The two Dragonfly instances, the cache and the rate-limit store, and the password each must have.
 */
import * as pulumi from "@pulumi/pulumi";
import type { GridConfig } from "../config";
import { bool, num } from "./readers";

export interface RateLimitConfig {
  /**
   * Install the rate limit service + counter store and attach the per-route
   * rules. When false, nothing edge-side is created and the app-layer limiters
   * remain the only ones — which is the pre-ADR-0040 behaviour.
   */
  enabled: boolean;
  /**
   * Evaluate every rule and emit its telemetry, but never actually refuse a
   * request (`shadowMode` on each rule).
   *
   * This is how the feature is meant to be introduced: run it here, read the
   * would-have-blocked counts off the ADR-0029 pane, and only then pick real
   * numbers. Enforcing limits chosen from intuition is how a rate limiter
   * becomes an outage. Defaults to TRUE for exactly that reason.
   */
  shadowMode: boolean;
  /**
   * Refuse traffic when the rate limit service cannot be reached.
   *
   * FALSE (the default, and Envoy Gateway's) is the right answer for abuse
   * bounds: a counter-store blip must not read as an outage. Set true only if
   * an unlimited flood is genuinely worse than a refused one.
   */
  failClosed: boolean;
  /** Per-client-IP request budgets, per minute. See `EDGE_RATE_LIMIT`. */
  limits: {
    /** Everything on the app host that no more specific rule claims. */
    app: number;
    /** `/api/auth/*` — the credential-stuffing surface. */
    appAuth: number;
    /** `/websocket` upgrades. Mirrors `GRID_WS_UPGRADE_RATE_LIMIT`. */
    appWsUpgrade: number;
    /** Presigned S3 preview/download URLs. */
    s3: number;
    /** The public landing site + blog. */
    web: number;
  };
  /** Counter-store dataset cap. Counters are tiny and expire on their own. */
  /**
   * Counter-store `--maxmemory`. Floor: 256mb — Dragonfly refuses to boot
   * below 256MiB per proactor thread, and we pin `--proactor_threads=1`
   * (enforced in `data/dragonfly.ts`).
   */
  storeMaxmemory: string;
  /** Counter-store pod memory limit; must sit above `storeMaxmemory`. */
  storeMemoryLimit: string;
  /**
   * `requirepass` for the counter store. Required (with the same
   * `allowUnauthenticatedRedis` opt-out) whenever rate limiting is enabled,
   * and deliberately a SEPARATE key from `dragonflyPassword`.
   *
   * The distinctness is the point, for the same reason `pgRuntimePassword`
   * stopped defaulting to `pgAppPassword`: every app pod holds the cache
   * credential in its own `REDIS_URL`. Share one password and any app pod —
   * or anything that reads one app pod's env — can also authenticate to the
   * counter store and `FLUSHALL` the edge rate limits, which is precisely the
   * control the app tier is not supposed to be able to lift.
   *
   * Consumed by Envoy Gateway's rate limit service (`REDIS_AUTH`), which runs
   * in `envoy-gateway-system`, so it is materialised into a Secret there
   * rather than in the app namespace.
   */
  storePassword?: pulumi.Output<string>;
}

export interface DragonflyConfig {
  maxmemory: string;
  /**
   * Pod memory LIMIT. Must sit ABOVE `maxmemory`: that flag caps the dataset,
   * but RSS (fragmentation, dashtable overhead, serialization buffers) runs
   * higher, so limit == maxmemory guarantees OOMKills under load.
   */
  memoryLimit: string;
  /**
   * `requirepass` for the ADR-0020 shared cache. REQUIRED unless
   * `allowUnauthenticatedRedis` is set — see the check in `loadConfig`.
   *
   * Undefined ONLY in the explicit opt-out case, where the instance keeps its
   * historical behaviour: no password, no TLS, reachable at
   * `redis://dragonfly:6379/0` by any pod in the namespace (the
   * intra-namespace NetworkPolicy allows it).
   *
   * That default was not a small hole. This instance carries the ADR-0028
   * conversation bus — every WebSocket frame of every chat, with a replayable
   * 500-event backlog per conversation — plus the cached WorkOS directory
   * (`directory:<orgId>`: email, display name, avatar), authorization
   * decisions and budget state. A password does not make it confidential on
   * the wire (Dragonfly here still speaks plaintext RESP; see
   * docs/deployment/kubernetes.md § Encryption posture), but it does stop any
   * pod that can open a TCP connection from reading and rewriting all of it.
   */
  password?: pulumi.Output<string>;
}

export function loadDragonfly(cfg: pulumi.Config): Pick<GridConfig, "dragonfly" | "rateLimit"> {
  // ── Dragonfly authentication ──────────────────────────────────────────────
  // Both instances shipped with NO password and NO TLS while the intra-namespace
  // NetworkPolicy lets any pod open 6379. The cache is the serious one: it
  // carries the ADR-0028 conversation bus (every chat frame, replayable), the
  // cached WorkOS directory (email/name/avatar), authz decisions and budget
  // state. Fail closed like `jobPayloadKek` does — a password must be a
  // decision, in one direction or the other, never a default nobody noticed.
  const rateLimitEnabled = bool(cfg, "rateLimitEnabled", true);
  const allowUnauthenticatedRedis = bool(cfg, "allowUnauthenticatedRedis", false);
  const dragonflyPassword = cfg.getSecret("dragonflyPassword");
  const rateLimitStorePassword = cfg.getSecret("rateLimitStorePassword");
  const missingRedisPasswords = [
    dragonflyPassword === undefined ? "dragonflyPassword" : undefined,
    rateLimitEnabled && rateLimitStorePassword === undefined ? "rateLimitStorePassword" : undefined,
  ].filter((k): k is string => k !== undefined);
  if (missingRedisPasswords.length > 0 && !allowUnauthenticatedRedis) {
    throw new Error(
      `Dragonfly would run with no authentication: ${missingRedisPasswords
        .map((k) => `grid-oib:${k}`)
        .join(", ")} unset. Any pod in the namespace could then read the conversation bus (every ` +
        "chat frame), the cached user directory, authorization decisions and budget state — or reset " +
        "the edge rate-limit counters. Set them:\n" +
        "  pulumi config set --secret grid-oib:dragonflyPassword $(openssl rand -base64 32)\n" +
        "  pulumi config set --secret grid-oib:rateLimitStorePassword $(openssl rand -base64 32)\n" +
        "To deliberately run WITHOUT authentication (dev/single-node only), set:\n" +
        "  pulumi config set grid-oib:allowUnauthenticatedRedis true",
    );
  }
  // Distinctness, for the same reason pgRuntimePassword stopped falling back to
  // pgAppPassword: every app pod holds the cache credential in its own
  // REDIS_URL, so reusing it for the counter store hands the app tier the
  // ability to flush the edge rate limits. Compared, never printed.
  if (
    dragonflyPassword !== undefined &&
    rateLimitStorePassword !== undefined &&
    cfg.get("dragonflyPassword") === cfg.get("rateLimitStorePassword")
  ) {
    throw new Error(
      "grid-oib:rateLimitStorePassword must differ from grid-oib:dragonflyPassword. Every app pod " +
        "carries the cache password in REDIS_URL; sharing it would let the app tier authenticate to " +
        "the edge counter store and lift its own rate limits.",
    );
  }
  if (allowUnauthenticatedRedis && missingRedisPasswords.length > 0) {
    pulumi.log.warn(
      "Dragonfly is running WITHOUT authentication (allowUnauthenticatedRedis=true): " +
        missingRedisPasswords.map((k) => `grid-oib:${k}`).join(", ") +
        " unset. Any pod in the namespace can read and rewrite the conversation bus, the cached " +
        "user directory, authorization decisions and budget state.",
    );
  }
  return {
    dragonfly: {
      maxmemory: cfg.get("dragonflyMaxmemory") ?? "512mb",
      memoryLimit: cfg.get("dragonflyMemoryLimit") ?? "768Mi",
      password: dragonflyPassword,
    },
    rateLimit: {
      enabled: rateLimitEnabled,
      // Ships observing, not enforcing. Flip this to false only with the
      // would-have-blocked counts in front of you.
      shadowMode: bool(cfg, "rateLimitShadowMode", true),
      failClosed: bool(cfg, "rateLimitFailClosed", false),
      limits: {
        // Starting points, not measurements. A chat session is chatty (polling
        // the inbox, presence, conversation reads), so the catch-all is
        // deliberately loose — it is there to stop a runaway loop, not to shape
        // traffic. The two narrow rules are the ones with a real threat behind
        // them.
        app: num(cfg, "rateLimitApp", 600),
        appAuth: num(cfg, "rateLimitAppAuth", 20),
        appWsUpgrade: num(cfg, "rateLimitAppWsUpgrade", 30),
        s3: num(cfg, "rateLimitS3", 300),
        web: num(cfg, "rateLimitWeb", 120),
      },
      storeMaxmemory: cfg.get("rateLimitStoreMaxmemory") ?? "256mb",
      storeMemoryLimit: cfg.get("rateLimitStoreMemoryLimit") ?? "384Mi",
      storePassword: rateLimitStorePassword,
    },
  };
}
