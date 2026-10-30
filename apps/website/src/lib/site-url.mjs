/**
 * The address the website is served from, for canonical URLs, the sitemap, hreflang, feeds and
 * JSON-LD (`Astro.site`). One value, in this order:
 *
 *   1. `PUBLIC_SITE_URL`, set at image build: CI passes `https://<prod baseDomain>`
 *      (`ci/image_inputs.py build-args web`), so the deploy's domain is the one source;
 *   2. otherwise `https://<baseDomain>` of the prod Pulumi stack, read from the repository
 *      (a local `bun run build`);
 *   3. otherwise the brand's domain (`identity.json`), e.g. a build context with no repository.
 *
 * The brand's domain is the brand's address in copy and e-mail. The site's URLs follow where it
 * is actually served, so before the domain move they name the live host
 * (docs/deployment/domain-cutover.md).
 */
import { existsSync, readFileSync } from 'node:fs'

/** `baseDomain` of a Pulumi stack file's text, or null. The key carries the project's namespace. */
export function stackBaseDomain(stackYaml) {
  const match = stackYaml.match(/^\s*[\w-]+:baseDomain:\s*["']?([^\s"'#]+)/m)
  return match ? match[1] : null
}

/**
 * @param {{ env?: Record<string, string | undefined>, stackFile?: string, brandDomain: string }} options
 * @returns {string} an origin with no trailing slash
 */
export function siteUrl({ env = process.env, stackFile, brandDomain }) {
  const configured = env.PUBLIC_SITE_URL?.trim()
  if (configured) return configured.replace(/\/+$/, '')
  if (stackFile && existsSync(stackFile)) {
    const base = stackBaseDomain(readFileSync(stackFile, 'utf8'))
    if (base) return `https://${base}`
  }
  return `https://${brandDomain}`
}
