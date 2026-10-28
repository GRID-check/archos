/**
 * File operations for a document — rename, delete, download.
 *
 * Three parts, one per layer: the hook does the work, the rename dialog is the
 * form, the menu composes both behind whatever trigger the surface hands it.
 * A surface that needs the standard control imports the menu; a surface with
 * its own chrome (the model viewport) imports the hook and renders its own.
 */

export {
  DocumentActionsMenu,
  useMoveInSheet,
  type DocumentActionKind,
  type DocumentActionsMenuProps,
} from './document-actions-menu'
export { DocumentObjectMenu, DocumentActionsTrigger } from './document-object-menu'
export { DEFAULT_DOCUMENT_ACTIONS } from './action-entries'
export { RenameDocumentDialog, type RenameDocumentDialogProps } from './rename-document-dialog'
export { DeleteDocumentDialog, type DeleteDocumentDialogProps } from './delete-document-dialog'
export {
  useDocumentActions,
  type ActionableDocument,
  type DocumentActions,
  type UseDocumentActionsOptions,
} from './use-document-actions'
export type { DocumentScope } from './document-scope'
