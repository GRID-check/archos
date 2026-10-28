/**
 * Public DNS (Cloudflare), validated eagerly: every mistake here produces records Cloudflare accepts.
 */
import * as pulumi from "@pulumi/pulumi";
import { hostsOutsideZone, managedHosts } from "../platform/dns";
import { bool, num } from "./readers";

export interface DnsConfig {
  /** Manage records for this stack's hosts. When false nothing here is read. */
  enabled: boolean;
  /** Cloudflare zone id (dashboard → the zone → Overview → API section). */
  zoneId: string;
  /**
   * The zone's apex name (`piloti.at`), which is NOT `baseDomain` — a stack
   * can live on a subdomain of its zone. Used to name the zone-level records
   * and to check that every managed host actually falls inside this zone.
   */
  zoneName: string;
  /** Token with Zone:DNS:Edit, plus Zone:Dynamic URL Redirects:Edit on the baseline stack (it writes the apex or www redirect). */
  apiToken: pulumi.Output<string>;
  /** Address every host record points at — the Envoy LoadBalancer's external IP. */
  targetIp: string;
  /**
   * The hosts that get an A record: exactly the Gateway's HTTPS listeners
   * (`platform/gateway.ts`), derived once here so the two cannot drift.
   */
  hosts: string[];
  /** TTL in seconds for unproxied records. */
  ttl: number;
  /**
   * Whether THIS stack owns the zone-level records (`www`, `_dmarc`, and the
   * apex or www redirect) rather than just its own hosts. Required on the
   * stack that serves the apex.
   *
   * At most one stack may set it. Two stacks that both claim the zone do not
   * conflict in any way Cloudflare reports — the later `pulumi up` overwrites
   * the earlier one's records and prints success — so `loadConfig` refuses
   * the combinations it can detect and this flag carries the rest.
   */
  zoneBaseline: boolean;
  /**
   * Value of the `_dmarc` TXT record. Optional, and carried in config rather
   * than hardcoded because a DMARC policy is a property of the domain's mail
   * posture, not of this deployment.
   */
  dmarc?: string;
  /**
   * Absolute URL the apex and `www` redirect to, for the window in which no
   * stack serves the apex yet.
   *
   * Scaffolding with an explicit end: as soon as a stack's `baseDomain` IS
   * the zone apex, that stack serves it for real and this must be unset.
   * `loadConfig` refuses to have both at once.
   */
  apexRedirectTo?: string;
}

export function loadDns(
  cfg: pulumi.Config,
  loadBalancerIp: string | undefined,
  hosts: Parameters<typeof managedHosts>[0],
): DnsConfig {
  const dnsEnabled = bool(cfg, "dnsEnabled", false);
  const dnsZoneId = cfg.get("dnsZoneId") ?? "";
  const dnsZoneName = (cfg.get("dnsZoneName") ?? "").replace(/\.$/, "");
  const cloudflareApiToken = cfg.getSecret("cloudflareApiToken");
  const dnsApexRedirectTo = cfg.get("dnsApexRedirectTo");
  const dnsZoneBaseline = bool(cfg, "dnsZoneBaseline", false);
  const dnsHosts = managedHosts(hosts);
  const { webDomain } = hosts;
  if (dnsEnabled) {
    const missingDnsDeps = [
      dnsZoneId === "" ? "dnsZoneId" : undefined,
      dnsZoneName === "" ? "dnsZoneName" : undefined,
      cloudflareApiToken === undefined ? "cloudflareApiToken" : undefined,
    ].filter((k): k is string => k !== undefined);
    if (missingDnsDeps.length > 0) {
      throw new Error(
        `grid-oib:dnsEnabled is set but ${missingDnsDeps
          .map((k) => `grid-oib:${k}`)
          .join(", ")} ${missingDnsDeps.length === 1 ? "is" : "are"} missing. DNS is all-or-nothing ` +
          "on purpose: a half-configured zone leaves some hosts managed and the rest silently stale.",
      );
    }
    // The whole point of managing DNS here is that the address is known and
    // stable. Without `loadBalancerIp` the provider assigns one on first deploy
    // and can assign a different one after a Gateway re-creation — records
    // written from an unpinned address are wrong the moment that happens, and
    // nothing in this program would notice.
    if (loadBalancerIp === undefined || loadBalancerIp === "") {
      throw new Error(
        "grid-oib:dnsEnabled requires grid-oib:loadBalancerIp. The A records need an address to " +
          "point at, and an unpinned LoadBalancer IP can change under a Gateway re-creation — " +
          "which would leave the records pointing at an address the provider has since reassigned. " +
          "Deploy once without DNS, read the IP (`kubectl -n envoy-gateway-system get svc`), pin " +
          "it, then enable this.",
      );
    }
    const strays = hostsOutsideZone(dnsHosts, dnsZoneName);
    if (strays.length > 0) {
      throw new Error(
        `grid-oib:dnsZoneName is "${dnsZoneName}" but ${strays.join(", ")} ` +
          `${strays.length === 1 ? "is" : "are"} not inside it. Cloudflare treats a name outside ` +
          `the zone as RELATIVE and appends the zone to it, so this would create ` +
          `"${strays[0]}.${dnsZoneName}" and report success. Fix baseDomain, or point dnsZoneName ` +
          "at the zone that actually contains these hosts.",
      );
    }
    // The redirect is scaffolding for a zone apex no stack serves yet. Once a
    // stack's own baseDomain IS the apex, that stack publishes a real A record
    // for it — and both would be the same Cloudflare record, so whichever
    // resource is created second wins and the outcome depends on graph order.
    if (dnsApexRedirectTo !== undefined && webDomain === dnsZoneName) {
      throw new Error(
        `grid-oib:dnsApexRedirectTo is set while this stack already serves the apex ` +
          `("${webDomain}"). Both would write the same record. Unset dnsApexRedirectTo — the ` +
          "redirect exists only for the window before a stack owns the apex.",
      );
    }
    if (dnsApexRedirectTo !== undefined && !dnsZoneBaseline) {
      throw new Error(
        "grid-oib:dnsApexRedirectTo requires grid-oib:dnsZoneBaseline. The apex, www and _dmarc " +
          "are zone-level records with at most one owning stack; the baseline flag is what " +
          "declares this stack to be it.",
      );
    }
    if (dnsApexRedirectTo !== undefined && !/^https?:\/\//.test(dnsApexRedirectTo)) {
      throw new Error(
        `grid-oib:dnsApexRedirectTo must be an absolute URL (got "${dnsApexRedirectTo}"). ` +
          "Cloudflare sends it to the browser as a Location header verbatim.",
      );
    }
    // The apex is a zone-level record, so the stack that serves it owns the
    // baseline. Anything else splits the zone: this stack writes the apex while
    // another writes www — and that other stack's www either still redirects
    // away from the site (how piloti.at kept bouncing to dev after prod shipped)
    // or points unproxied at a Gateway with no listener for it.
    if (webDomain === dnsZoneName && !dnsZoneBaseline) {
      throw new Error(
        `grid-oib:dnsZoneBaseline must be true on the stack that serves the apex ` +
          `("${webDomain}"). The apex, www and _dmarc have one owner, and the apex's server is it — ` +
          "set it here and remove dnsZoneBaseline and dnsApexRedirectTo from the stack that held them.",
      );
    }
  }
      return {
    enabled: dnsEnabled,
    zoneId: dnsZoneId,
    zoneName: dnsZoneName,
    // `??` only reached when disabled — the guard above requires the token
    // whenever `dnsEnabled`, so `installDns` never sees this empty.
    apiToken: cloudflareApiToken ?? pulumi.secret(""),
    targetIp: loadBalancerIp ?? "",
    hosts: dnsHosts,
    // 600s, matching what these records already carried at the previous
    // operator. Low enough that a LoadBalancer IP change is a ten-minute
    // event rather than an hour-long one, high enough not to matter.
    ttl: num(cfg, "dnsTtl", 600),
    zoneBaseline: dnsZoneBaseline,
    dmarc: cfg.get("dnsDmarc"),
    apexRedirectTo: dnsApexRedirectTo,
  };
}
