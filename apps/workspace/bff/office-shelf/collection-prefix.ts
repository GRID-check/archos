/**
 * The collection-name prefix of an office's shelf: one constant per runtime.
 *
 * The prefix is a STORED name, not a spelling. Every vector point of the shelf
 * carries `scope = <prefix><organization id>` in Qdrant (ADR-0116: the logical
 * collection is a payload field, not a Qdrant collection, so an alias cannot
 * rename it) and every document row `collection_name` the same. Renaming it
 * means re-tagging both, which an operator does once
 * (`docs/deployment/office-shelf-rename-runbook.md`). Until then:
 *
 * - writers use {@link OFFICE_SHELF_COLLECTION_PREFIX}, the prefix the existing
 *   data has;
 * - readers and authorizers accept every prefix in
 *   {@link OFFICE_SHELF_COLLECTION_PREFIXES}, so a re-tagged organization
 *   works before the writer moves.
 *
 * After the runbook has run everywhere: set the writer prefix to
 * {@link OFFICE_SHELF_TARGET_COLLECTION_PREFIX} and delete the legacy entry.
 *
 * Python twin: `OFFICE_SHELF_COLLECTION_PREFIX` and friends in
 * `packages/agent/src/agent/common/source_kinds.py`; `collection-prefix.spec.ts` holds the
 * two equal. No `server-only`: the browser may ask whether a name is a shelf's.
 */

/** The prefix the existing office-shelf collections have, and the one writers still use. */
export const OFFICE_SHELF_COLLECTION_PREFIX = 'archiv_'

/** The prefix a re-tagged shelf has, and the writer's value in the release after the re-tag. */
export const OFFICE_SHELF_TARGET_COLLECTION_PREFIX = 'office_shelf_'

/** Every prefix a reader recognises as an office shelf. Drop the legacy one after the re-tag. */
export const OFFICE_SHELF_COLLECTION_PREFIXES: readonly string[] = [
  OFFICE_SHELF_TARGET_COLLECTION_PREFIX,
  OFFICE_SHELF_COLLECTION_PREFIX,
]

/** Whether `collectionName` names an office's shelf, under either prefix. */
export const isOfficeShelfCollectionName = (collectionName: string): boolean =>
  OFFICE_SHELF_COLLECTION_PREFIXES.some((prefix) => collectionName.startsWith(prefix))

/** The organization id a shelf collection name carries, or null for any other name. */
export function officeShelfOrganizationId(collectionName: string): string | null {
  const prefix = OFFICE_SHELF_COLLECTION_PREFIXES.find((candidate) => collectionName.startsWith(candidate))
  return prefix ? collectionName.slice(prefix.length) || null : null
}
