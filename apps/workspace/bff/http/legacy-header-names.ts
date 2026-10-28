/**
 * The service headers lost the product's name: `x-grid-internal-token` is
 * `x-internal-token`, `X-Grid-Request-Context` is `X-Request-Context`, and so
 * on for every `x-grid-*` header (docs/contributing/code-conventions.md#no-brand-names).
 *
 * They move by expand, switch and contract, because the BFF and the backend
 * roll out side by side: this release every receiver reads the new name and
 * the old one, the next one the senders switch to the new name, and the one
 * after that this file goes. `agent_host.legacy_headers` is the backend's half.
 */

/** The old name of a header: `x-internal-token` → `x-grid-internal-token`. */
export function legacyHeaderName(name: string): string {
  return name.replace(/^x-/i, (prefix) => `${prefix}grid-`)
}

/** A request's or response's header under its current name, else its old one. */
export function readHeader(headers: Headers, name: string): string | null {
  return headers.get(name) ?? headers.get(legacyHeaderName(name))
}

/** Whether the header is present under either name. */
export function hasHeader(headers: Headers, name: string): boolean {
  return headers.has(name) || headers.has(legacyHeaderName(name))
}
