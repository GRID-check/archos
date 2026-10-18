/**
 * The codes a folder's answers carry, kept free of server imports so the
 * browser reads the same constants the server writes.
 *
 * What the database answers when something is filed into a deleted folder
 * (migration 0115, `grid_refuse_write_into_deleted_folder`): its own SQLSTATE
 * (class `GF`, unassigned by the standard), which `lib/api/handler.ts` answers
 * as the folder being gone. Kept apart, like `legal-hold-codes.ts`, so the
 * handler imports a constant and not the bin's services.
 */

export const FOLDER_DELETED_SQLSTATE = 'GFD01'

/** `details.reason` on that answer. */
export const FOLDER_DELETED_REASON = 'folder_deleted'

/**
 * `details.reason` when a living sibling already holds a folder's name: a
 * restore that would land next to it, a create, a rename, or a folder moved
 * next to it. Here, not with the bin's services, so the browser reads the same
 * constant the server writes.
 */
export const FOLDER_NAME_TAKEN_REASON = 'folder-name-taken'

/**
 * `details.code` when an IFC model would land in a folder that restricts
 * reading (ADR-0087): its building data is not partitioned yet.
 */
export const IFC_IN_RESTRICTED_FOLDER = 'IFC_IN_RESTRICTED_FOLDER'
