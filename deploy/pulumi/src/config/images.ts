/**
 * The application images: where they come from, how they are pulled, and the registry credentials.
 */
import * as pulumi from "@pulumi/pulumi";

/** Resolve the concrete backend image reference. */
export function backendImage(c: { images: ImagesConfig }): string {
  return c.images.backend ?? `${c.images.registry}/grid-oib-backend:${c.images.tag}`;
}

/** Resolve the concrete geometry-service image reference (`apps/geometry/Dockerfile`, ADR-0149). */
export function geometryImage(c: { images: ImagesConfig }): string {
  return c.images.geometry ?? `${c.images.registry}/grid-oib-geometry:${c.images.tag}`;
}

/** Resolve the concrete frontend image reference. */
export function frontendImage(c: { images: ImagesConfig }): string {
  return c.images.frontend ?? `${c.images.registry}/grid-oib-frontend:${c.images.tag}`;
}

/** Resolve the concrete landing-site (web) image reference. */
export function webImage(c: { images: ImagesConfig }): string {
  return c.images.web ?? `${c.images.registry}/grid-oib-web:${c.images.tag}`;
}

/**
 * Pull policy for an app-tier image: the explicit `imagePullPolicy` override
 * when set, otherwise derived from the resolved reference (`pullPolicyFor`).
 * Every app workload must use this rather than a single stack-wide value:
 * CI deploys routinely mix reference kinds (a SHA `imageTag` for rebuilt
 * services, `:latest` fallbacks for the rest), and only the per-image rule
 * keeps a moving tag on `Always` — which the `moving-tag-must-repull`
 * policy-pack rule enforces.
 */
export function appPullPolicy(c: { images: ImagesConfig }, image: string): string {
  return c.images.pullPolicyOverride ?? pullPolicyFor(image);
}

/**
 * The only correct `imagePullPolicy` for a given image reference.
 *
 * Same rule the app images follow (see `appPullPolicy`), applied to
 * the upstream data-tier images too: a MOVING tag (`latest`, or no tag at all)
 * must re-pull on every pod start or a rescheduled pod silently keeps a stale
 * cached layer; a digest-pinned or version-pinned reference is immutable, so
 * re-pulling is pure latency. Kubernetes already infers this, but stating it
 * makes the intent reviewable — and lets the policy pack enforce it.
 */
export function pullPolicyFor(image: string): string {
  if (image.includes("@sha256:")) return "IfNotPresent"; // digest-pinned = immutable
  const tag = image.split("/").pop()?.split(":")[1];
  return tag === undefined || tag === "latest" ? "Always" : "IfNotPresent";
}

export interface ImagesConfig {
  /** e.g. ghcr.io/archos-at */
  registry: string;
  /** Immutable tag both images share (a git SHA in CI, or "latest"). */
  tag: string;
  /** Full override for the backend image ref (registry+tag ignored if set). */
  backend?: string;
  /** Full override for the geometry-service image ref. */
  geometry?: string;
  /** Full override for the frontend image ref. */
  frontend?: string;
  /** Full override for the landing-site (web) image ref. */
  web?: string;
  /**
   * Explicit imagePullPolicy override for the app images. When unset the
   * policy is derived PER IMAGE REF (`appPullPolicy`): a moving tag must
   * re-pull, an immutable one must not — deriving one value from `tag`
   * alone is wrong whenever a per-service override points at a different
   * kind of reference (e.g. imageTag is a SHA while `frontendImage` is a
   * `:latest` fallback).
   */
  pullPolicyOverride?: string;
  /**
   * Registry credentials for pulling the app images when they are PRIVATE
   * (e.g. a private GHCR package — the kubelet pulls anonymously, so a
   * private image is an instant ImagePullBackOff without this). When set,
   * the program creates a dockerconfigjson Secret ("grid-registry-pull") in
   * the app namespace and wires it as imagePullSecrets on every app
   * workload. Omit both values when the images are publicly pullable.
   * Any long-lived token with read access works as the password (a GitHub
   * PAT/OAuth token with read:packages for GHCR).
   */
  pullCredentials?: { username: string; password: pulumi.Output<string> };
}

export function loadImages(cfg: pulumi.Config): ImagesConfig {
  const imageTag = cfg.get("imageTag") ?? "latest";
  const registryUsername = cfg.get("registryUsername");
  const registryPassword = cfg.getSecret("registryPassword");
  if ((registryUsername === undefined) !== (registryPassword === undefined)) {
    throw new Error(
      "grid-oib:registryUsername and grid-oib:registryPassword must be set together (or neither).",
    );
  }
      return {
    registry: cfg.get("imageRegistry") ?? "ghcr.io/archos-at",
    tag: imageTag,
    backend: cfg.get("backendImage"),
    geometry: cfg.get("geometryImage"),
    frontend: cfg.get("frontendImage"),
    web: cfg.get("webImage"),
    // Explicit escape hatch only; the default is derived per image ref —
    // see `appPullPolicy` and the field's doc comment.
    pullPolicyOverride: cfg.get("imagePullPolicy"),
    pullCredentials:
      registryUsername && registryPassword
        ? { username: registryUsername, password: registryPassword }
        : undefined,
  };
}
