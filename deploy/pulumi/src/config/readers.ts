/**
 * Typed readers over `pulumi.Config`: each one names the key in the error it throws.
 */
import * as pulumi from "@pulumi/pulumi";

export function num(cfg: pulumi.Config, key: string, fallback: number): number {
  const v = cfg.getNumber(key);
  return v === undefined ? fallback : v;
}

/** A count that must be a whole number of at least one: a replica count or a pool size, never 0 or 2.5. */
export function positiveInt(cfg: pulumi.Config, key: string, fallback: number): number {
  const v = num(cfg, key, fallback);
  if (!Number.isInteger(v) || v < 1) {
    throw new Error(`grid-oib:${key} must be a whole number of at least 1 (got ${v}).`);
  }
  return v;
}

export function bool(cfg: pulumi.Config, key: string, fallback: boolean): boolean {
  const v = cfg.getBoolean(key);
  return v === undefined ? fallback : v;
}

/** A whole percentage in (0, 100). */
export function percent(cfg: pulumi.Config, key: string, fallback: number): number {
  const v = num(cfg, key, fallback);
  if (!Number.isInteger(v) || v <= 0 || v >= 100) {
    throw new Error(`grid-oib:${key} must be a whole percentage between 1 and 99 (got ${v}).`);
  }
  return v;
}

/**
 * A `nodeGroup*` knob: the worker group's name, or undefined when unset or
 * blank (no placement). Refused at load time when it cannot be a label value,
 * because a nodeSelector no node matches plans clean and leaves the tier
 * Pending forever.
 */
export function nodeGroup(cfg: pulumi.Config, key: string): string | undefined {
  const value = cfg.get(key)?.trim();
  if (!value) return undefined;
  if (value.length > 63 || !/^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/.test(value)) {
    throw new Error(`grid-oib:${key} must be a Kubernetes label value, the worker group's name (got "${value}").`);
  }
  return value;
}

/**
 * Require a SET of secrets together, naming the ones that are missing.
 *
 * Credentials arrive in pairs — an access key and a secret key — and a guard
 * written from the error message rather than from the requirement tests one of
 * them. That is not a hypothetical: the documents-backup guard named both keys
 * and checked only the access key, so a stack that set one and omitted the other
 * planned clean, substituted `pulumi.secret("")`, and `weed filer.backup` signed
 * every request with an empty secret — `SignatureDoesNotMatch`, i.e. exactly the
 * silent backup-to-nowhere the guard existed to refuse.
 *
 * Reporting ALL the missing keys rather than the first also matters: a plan that
 * fails once per missing key is three plans.
 *
 * Read with `cfg.get`, and an EMPTY value counts as missing. `getSecret("")`
 * returns a defined output, so an unset-vs-set check would pass for
 * `pulumi config set --secret grid-oib:… ""` — which is not a hypothetical
 * either, it is what the failure this guard was written for actually looked
 * like: a signing key that exists, is empty, and turns every request into
 * `SignatureDoesNotMatch`. A credential that cannot sign is not a credential,
 * so the guard measures usability rather than presence. `cfg.get` is safe here
 * because nothing is returned — only the KEY NAMES reach the message.
 */
export function requireSecretsTogether(
  cfg: pulumi.Config,
  keys: string[],
  because: string,
): void {
  const missing = keys.filter((key) => (cfg.get(key) ?? "").trim() === "");
  if (missing.length === 0) return;
  throw new Error(
    `${missing.map((k) => `grid-oib:${k}`).join(", ")} ${missing.length === 1 ? "is" : "are"} ` +
      `required ${because}. Set ${missing.length === 1 ? "it" : "them"} with ` +
      `\`pulumi config set --secret\`.`,
  );
}
