/**
 * The service headers lost the product's name: `x-grid-internal-token` is
 * `x-internal-token`, `X-Grid-Request-Context` is `X-Request-Context`, and so
 * on for every `x-grid-*` header (docs/contributing/code-conventions.md#no-brand-names).
 *
 * They move by expand, switch and contract, because the BFF and the backend
 * roll out side by side: every receiver reads the new name and the old one
 * (expand, #1333), then the senders send the new name (switch), and the
 * release after that this file goes. `aiq_api.legacy_headers` is the
 * backend's half.
 *
 * The contract step, once the switch has deployed everywhere and no job
 * queued before it is left:
 * - readers read the new names only: `readHeader`/`hasHeader` become
 *   `headers.get`/`headers.has`, and this file goes;
 * - the backend's readers (`aiq_agent.project_context`, `cost_tracking`,
 *   `data_sources`, `model_overrides`, `knowledge.scoping`, `aiq_api`'s
 *   `context_envelope`, `internal_auth`, `config_info`, `chat_socket`) read the
 *   new names, the in-process job headers (`aiq_api.jobs.agent_job_setup`)
 *   take them too, and `aiq_api.legacy_headers` goes with its middleware;
 * - `SERVICE_HEADERS` in `lib/proxy/ws-upgrade-headers.js` keeps stripping the
 *   `x-grid-` prefix for one more release, then drops it;
 * - the ratchet exclusions for these files leave `scripts/check_brand_names.py`.
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
