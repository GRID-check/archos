/**
 * What the application tiers are handed: the model gateway, WorkOS, the internal job-payload key, Web Push and skills.
 */
import * as pulumi from "@pulumi/pulumi";
import { bool, num } from "../config/readers";

export interface LlmConfig {
  openrouterApiKey: pulumi.Output<string>;
  tavilyApiKey: pulumi.Output<string>;
  embedModel: string;
  embedBaseUrl: string;
  vlmModel: string;
  vlmBaseUrl: string;
}

export interface AuthConfig {
  requireAuth: boolean;
  workosClientId: string;
  /**
   * The environment's AuthKit domain, no scheme (`<slug>.authkit.app` or a
   * custom auth domain): the authorization server of the agent doors
   * (ADR-0122). Empty keeps `/api/mcp`, `/api/a2a` and `/api/platform/mcp`
   * answering 503; Piloti's own calls still work.
   */
  workosAuthkitDomain: string;
  workosApiKey: pulumi.Output<string>;
  workosCookiePassword: pulumi.Output<string>;
  platformOwnerEmails: string;
  platformOrgExternalId: string;
  disableSelfServeOrgs: boolean;
  auditLogsEnabled: boolean;
  byokSecretBackend: string;
  byokLocalKek: pulumi.Output<string>;
  allowAgentOrgMemory: boolean;
}

export interface InternalConfig {
  apiToken: pulumi.Output<string>;
  adminToken: pulumi.Output<string>;
  /**
   * Token for `/api/internal/oib-corpus`, the corpus tarball. Its only
   * consumer was the answer-suite CI workflow, which has been removed; the
   * export stays until someone decides to delete it. Its own secret, because
   * it lived outside the cluster (a repository secret). Empty = the export is
   * disabled (503).
   */
  corpusExportToken: pulumi.Output<string>;
  /**
   * 32-byte base64 KEK encrypting DB-claimed job payloads at rest (they carry
   * the user auth token). Empty = plaintext (dev only). Strongly recommended
   * Generate: `openssl rand -base64 32`.
   */
  jobPayloadKek: pulumi.Output<string>;
}

export interface WebPushConfig {
  publicKey: string;
  privateKey: pulumi.Output<string>;
  subject: string;
}

export interface SkillsConfig {
  /**
   * Floor on how often a job may be scheduled to fire, in minutes. Reaches
   * the frontend as `GRID_SKILL_MIN_INTERVAL_MINUTES` and is enforced at
   * save time.
   */
  minIntervalMinutes: number;
}

export function loadAppServices(
  cfg: pulumi.Config,
): { llm: LlmConfig; auth: AuthConfig; internal: InternalConfig; webPush: WebPushConfig; skills: SkillsConfig } {
  // Fail closed: db-claimed job payloads carry the user's auth token and persist
  // in Postgres (table + WAL + backups + replicas). Refuse to deploy db mode
  // without a KEK to encrypt them at rest, unless plaintext is explicitly opted
  // into for dev. Guards against the silent plaintext-token-at-rest default.
  const jobPayloadKek = cfg.getSecret("jobPayloadKek");
  const allowPlaintextJobPayloads = bool(cfg, "allowPlaintextJobPayloads", false);
  if (jobPayloadKek === undefined && !allowPlaintextJobPayloads) {
    throw new Error(
      "The DB-claimed research queue persists job payloads (which carry the user auth token) in Postgres, " +
        "so they must be encrypted at rest. Set a 32-byte base64 KEK:\n" +
        "  pulumi config set --secret grid-oib:jobPayloadKek $(openssl rand -base64 32)\n" +
        "To deliberately run with PLAINTEXT payloads (dev/single-node only), set:\n" +
        "  pulumi config set grid-oib:allowPlaintextJobPayloads true",
    );
  }
  const workosClientId = cfg.get("workosClientId") ?? "";
  const workosApiKey = cfg.getSecret("workosApiKey");
  return {
    llm: {
      openrouterApiKey: cfg.requireSecret("openrouterApiKey"),
      tavilyApiKey: cfg.requireSecret("tavilyApiKey"),
      embedModel: cfg.get("embedModel") ?? "openai/text-embedding-3-large",
      embedBaseUrl: cfg.get("embedBaseUrl") ?? "https://openrouter.ai/api/v1",
      vlmModel: cfg.get("vlmModel") ?? "openai/gpt-6-luna",
      vlmBaseUrl: cfg.get("vlmBaseUrl") ?? "https://openrouter.ai/api/v1",
    },
    auth: {
      requireAuth: bool(cfg, "requireAuth", true),
      workosClientId,
      workosAuthkitDomain: cfg.get("workosAuthkitDomain") ?? "",
      workosApiKey: workosApiKey ?? pulumi.output(""),
      workosCookiePassword: cfg.getSecret("workosCookiePassword") ?? pulumi.output(""),
      platformOwnerEmails: cfg.get("platformOwnerEmails") ?? "",
      platformOrgExternalId: cfg.get("platformOrgExternalId") ?? "grid-platform",
      disableSelfServeOrgs: bool(cfg, "disableSelfServeOrgs", false),
      auditLogsEnabled: bool(cfg, "auditLogsEnabled", false),
      byokSecretBackend: cfg.get("byokSecretBackend") ?? "",
      byokLocalKek: cfg.getSecret("byokLocalKek") ?? pulumi.output(""),
      allowAgentOrgMemory: bool(cfg, "allowAgentOrgMemory", false),
    },
    internal: {
      apiToken: cfg.requireSecret("gridInternalApiToken"),
      adminToken: cfg.requireSecret("gridAdminToken"),
      corpusExportToken: cfg.getSecret("gridCorpusExportToken") ?? pulumi.output(""),
      jobPayloadKek: jobPayloadKek ?? pulumi.output(""),
    },
    webPush: {
      publicKey: cfg.get("webPushVapidPublicKey") ?? "",
      privateKey: cfg.getSecret("webPushVapidPrivateKey") ?? pulumi.output(""),
      subject: cfg.get("webPushSubject") ?? "",
    },
    skills: {
      minIntervalMinutes: num(cfg, "skillMinIntervalMinutes", 15),
    },
  };
}
