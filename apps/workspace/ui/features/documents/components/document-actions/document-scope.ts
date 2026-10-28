import type { Namespace } from '@/i18n'
import { filesCopy } from '@/i18n/namespaces/files'
import { officeShelfCopy } from '@/i18n/namespaces/office-shelf'

/** Which corpus the document belongs to — and so which words and which route. */
export type DocumentScope = 'files' | 'officeShelf'

/** The copy each corpus speaks in. */
export const DOCUMENT_SCOPE_COPY: Record<DocumentScope, Namespace> = { files: filesCopy, officeShelf: officeShelfCopy }
