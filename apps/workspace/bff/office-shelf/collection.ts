import 'server-only'
import {
  OFFICE_SHELF_COLLECTION_PREFIX,
  OFFICE_SHELF_COLLECTION_PREFIXES,
} from './collection-prefix'

/**
 * Deterministic RAG collection name for an organization's office shelf.
 *
 * Every project in the org retrieves against this collection in addition to its
 * own (see `lib/retrieval-scope/collection-scope.ts`), so the name MUST be a pure function of the
 * org id — no per-project or per-document component. WorkOS org ids look like
 * `org_<base32>` (already collection-safe); we defensively sanitize to the same
 * `[A-Za-z0-9_-]` charset the backend accepts for `proj_<uuid>` collections.
 */
export function officeShelfCollectionName(organizationId: string): string {
  const safe = organizationId.replace(/[^A-Za-z0-9_-]/g, '_')
  return `${OFFICE_SHELF_COLLECTION_PREFIX}${safe}`
}

/**
 * Every name the organization's shelf may go by (one per accepted prefix): the
 * collection authorizer admits any of them as THIS organization's shelf.
 */
export function officeShelfCollectionNames(organizationId: string): string[] {
  const safe = organizationId.replace(/[^A-Za-z0-9_-]/g, '_')
  return OFFICE_SHELF_COLLECTION_PREFIXES.map((prefix) => `${prefix}${safe}`)
}
