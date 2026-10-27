/**
 * The edge: the public hosts, the Let's Encrypt issuer and the Envoy Gateway limits every per-IP rule rests on.
 */
import * as pulumi from "@pulumi/pulumi";
import { bool, num } from "../config/readers";

export interface IngressConfig {
  /** Public host for the app (frontend + BFF + WS). Derived: `app.<baseDomain>` unless the `appDomain` key overrides it. */
  appDomain: string;
  /** Public host for the S3 endpoint used to sign browser preview/download URLs. Derived: `s3.<baseDomain>` unless the `s3Domain` key overrides it. */
  s3Domain: string;
  /** Public host for the landing site (frontends/web). Derived: the `baseDomain` apex itself unless the `webDomain` key overrides it. */
  webDomain: string;
  /** Email for the Let's Encrypt ACME account. */
  letsEncryptEmail: string;
  /** Use the LE staging CA (avoids rate limits while wiring DNS/TLS). */
  useStagingIssuer: boolean;
  /**
   * Install metrics-server (needed by the HPAs). Leave FALSE on the managed
   * provider: it already provisions base metrics components that serve
   * `metrics.k8s.io` and cannot be removed, so a second install just fights
   * the built-in one. Only set true on a bare cluster with no metrics API.
   */
  installMetricsServer: boolean;
  /**
   * Optional fixed external IP for the Envoy Gateway LoadBalancer. The provider
   * assigns one automatically on first deploy and then RESERVES a released IP
   * for 14 days, reclaimable via the `k8s.at/managed-loadbalancer-ip` service
   * annotation. Set this to that IP so DNS never has to chase a new address
   * across a Gateway/service re-creation. Empty = let the provider assign one.
   */
  loadBalancerIp?: string;
  /**
   * Trusted hops when deriving the client IP from `X-Forwarded-For` (ADR-0040
   * layer L0). This is the setting every per-IP limit depends on, and getting
   * it wrong is silent in both directions: too low and every client is
   * bucketed as the load balancer (one shared limit for the whole product),
   * too high and a client can forge its own address by sending an XFF header.
   *
   * 0 = trust Envoy's own downstream connection address, correct when the
   * LoadBalancer preserves the source IP (the common case with
   * `externalTrafficPolicy: Local` or a DSR/L2 load balancer). Raise to 1 when
   * a SNATing proxy sits in front and appends exactly one hop.
   *
   * VERIFY THIS ON A LIVE CLUSTER before trusting any per-IP number: compare
   * the edge access-log client address against a known external IP.
   */
  xffNumTrustedHops: number;
  /**
   * Maximum concurrent downstream connections per Envoy proxy replica, or 0
   * to leave it unbounded. A blunt backstop underneath the request-rate
   * limits: it bounds file descriptors and memory when something opens
   * connections without ever completing a request.
   */
  maxConnectionsPerProxy: number;
}

export function loadIngress(
  cfg: pulumi.Config,
  { appDomain, s3Domain, webDomain }: { appDomain: string; s3Domain: string; webDomain: string },
  loadBalancerIp: string | undefined,
): IngressConfig {
      return {
    appDomain,
    s3Domain,
    webDomain,
    letsEncryptEmail: cfg.require("letsEncryptEmail"),
    // Default to the LE STAGING CA: on a first deploy the LoadBalancer IP (and
  // therefore DNS) doesn't exist yet, so HTTP-01 can't be solved and every
  // failed prod attempt burns Let's Encrypt rate limits. Flip to false only
  // after DNS resolves to the gateway and a staging cert has issued.
  useStagingIssuer: bool(cfg, "useStagingIssuer", true),
    // Default FALSE: the managed provider ships an unremovable metrics stack.
    installMetricsServer: bool(cfg, "installMetricsServer", false),
    loadBalancerIp,
    // 0 = trust Envoy's own downstream address. See the interface comment:
    // this is the one setting every per-IP limit rests on, and it must be
    // confirmed against a live cluster rather than assumed.
    xffNumTrustedHops: num(cfg, "xffNumTrustedHops", 0),
    maxConnectionsPerProxy: num(cfg, "maxConnectionsPerProxy", 10000),
  };
}
