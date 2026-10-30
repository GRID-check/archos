import type { IGatewaySpec } from "@kubernetes-models/gateway-api/gateway.networking.k8s.io/v1/GatewaySpec";
import type { IHTTPRouteSpec } from "@kubernetes-models/gateway-api/gateway.networking.k8s.io/v1/HTTPRouteSpec";
import { objectName, type NameKey } from "../names";

/**
 * The domain move's redirect (docs/deployment/domain-cutover.md): while the
 * stack serves a new `baseDomain`, the hosts of the former one answer with a
 * permanent redirect to their new twin, path and query kept.
 *
 * OFF unless `formerBaseDomain` is set. Only the two hosts people and search
 * engines hold links to move this way: the website's apex and the app. The
 * S3 host signs short-lived URLs, and the operator hosts (otel., langfuse.,
 * qdrant.) are re-registered rather than redirected.
 *
 * The Gateway needs a listener and a certificate per former host
 * (cert-manager issues it over HTTP-01 like any other), so the former hosts'
 * DNS records must keep pointing at the gateway: see the runbook's
 * "DNS of the former domain" before the zone moves.
 */
export interface FormerDomainRedirect {
  /** The former host, e.g. `old.example.org`. */
  from: string;
  /** The host it now lives at, e.g. `new.example.org`. */
  to: string;
  /** The Gateway listener (section) that terminates TLS for `from`. */
  listener: string;
  /** The Secret cert-manager writes the certificate for `from` into. */
  tlsSecret: string;
  /** The HTTPRoute's object name. */
  route: string;
}

const HOSTS: Array<{ part: "web" | "app"; tls: NameKey; route: NameKey }> = [
  { part: "web", tls: "formerWebTls", route: "formerWebRedirectRoute" },
  { part: "app", tls: "formerAppTls", route: "formerAppRedirectRoute" },
];

/**
 * The redirects for `formerBaseDomain`, or none when it is unset. Throws when it
 * names a host the stack still serves, which would make the stack redirect to itself.
 */
export function formerDomainRedirects(ingress: {
  formerBaseDomain?: string;
  webDomain: string;
  appDomain: string;
}): FormerDomainRedirect[] {
  const former = ingress.formerBaseDomain?.trim();
  if (!former) return [];
  if (former === ingress.webDomain || `app.${former}` === ingress.appDomain) {
    throw new Error(`formerBaseDomain (${former}) is the domain this stack serves; set it to the domain being left`);
  }
  return HOSTS.map(({ part, tls, route }) => ({
    from: part === "web" ? former : `app.${former}`,
    to: part === "web" ? ingress.webDomain : ingress.appDomain,
    listener: `https-former-${part}`,
    tlsSecret: objectName(tls),
    route: objectName(route),
  }));
}

/** The HTTPS listener that terminates TLS for one former host. */
export function formerDomainListener(redirect: FormerDomainRedirect): IGatewaySpec["listeners"][number] {
  return {
    name: redirect.listener,
    port: 443,
    protocol: "HTTPS",
    hostname: redirect.from,
    tls: { mode: "Terminate", certificateRefs: [{ name: redirect.tlsSecret }] },
    allowedRoutes: { namespaces: { from: "Same" } },
  };
}

/**
 * Every request to the former host: 301 to the same path on the new host. A
 * RequestRedirect with only `hostname` keeps scheme, path and query (Gateway
 * API, HTTPRequestRedirectFilter). 301 because the move is permanent and the
 * search engines' Change of Address expects it; a POST to the app's former
 * host (an agent still connected there) is not carried across, which the
 * runbook covers.
 */
export function formerDomainRouteSpec(redirect: FormerDomainRedirect, gatewayName: string): IHTTPRouteSpec {
  return {
    parentRefs: [{ name: gatewayName, sectionName: redirect.listener }],
    hostnames: [redirect.from],
    rules: [{ filters: [{ type: "RequestRedirect", requestRedirect: { hostname: redirect.to, statusCode: 301 } }] }],
  };
}
