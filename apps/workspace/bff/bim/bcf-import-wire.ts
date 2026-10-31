/**
 * The contract of `POST /api/documents/{id}/annotations/bcf`: a BCF file in, a
 * report of what became of each topic out. Shared by the route, the typed
 * client and the agent operation. No `server-only`: the browser and the
 * catalog import it.
 */

import { z } from 'zod'

/** Why a topic was left alone: nothing about it is wrong, it is just not imported now. */
export const BCF_IMPORT_SKIP_REASONS = [
  /** This model already carries a mark from this topic (an earlier import of the file, or of last round's). */
  'already_imported',
  /** The file names the same topic twice; the first one counts. */
  'duplicate_in_file',
  /** The topic has no viewpoint with a camera. A later step frames such topics from the elements' stored boxes. */
  'no_viewpoint',
] as const
export type BcfImportSkipReason = (typeof BCF_IMPORT_SKIP_REASONS)[number]

/** Why a topic could not be imported. */
export const BCF_IMPORT_FAIL_REASONS = [
  /** Its markup is not well-formed XML, or declares a document type. */
  'bad_xml',
  /** Its markup has no Topic. */
  'no_topic',
  /** The model carries as many Anmerkungen as a document may. */
  'limit',
  /** Writing it failed; the rest of the file went on. */
  'error',
] as const
export type BcfImportFailReason = (typeof BCF_IMPORT_FAIL_REASONS)[number]

/** Why the archive itself was refused (`./bcf-archive.ts` says when each applies). */
export const BCF_ARCHIVE_REFUSALS = ['not_a_zip', 'too_many_entries', 'unsafe_path', 'too_large', 'encrypted', 'unsupported', 'corrupt'] as const
export type BcfArchiveRefusal = (typeof BCF_ARCHIVE_REFUSALS)[number]

/** Why the whole file was refused (422 `details.reason`), besides `not_a_model` and `model_not_ready`. */
export const BCF_IMPORT_REFUSALS = [...BCF_ARCHIVE_REFUSALS, 'not_bcf', 'unsupported_version'] as const
export type BcfImportRefusal = (typeof BCF_IMPORT_REFUSALS)[number]

const topicRef = {
  topic: z.string().describe('The topic’s Guid as the file has it, or its folder when its markup could not be read.'),
  title: z.string().nullable().describe('The topic’s title, shortened, when it could be read.'),
}

export const bcfImportResultSchema = z.object({
  batchId: z.string().describe('Shared by every mark this import made: a later triage runs over one batch.'),
  version: z.string().nullable().describe('The file’s BCF version (2.1 or 3.0), or null when it does not say.'),
  topics: z.number().int().describe('Topic folders in the file.'),
  imported: z.array(
    z.object({
      topic: z.string(),
      annotationId: z.string(),
      number: z.number().int().describe('The new Anmerkung’s number on this model.'),
      assigned: z.boolean().describe('Whether its AssignedTo became the Zuständige; otherwise the thread names them.'),
    })
  ),
  skipped: z.array(z.object({ ...topicRef, reason: z.enum(BCF_IMPORT_SKIP_REASONS) })),
  failed: z.array(z.object({ ...topicRef, reason: z.enum(BCF_IMPORT_FAIL_REASONS) })),
})
export type BcfImportResult = z.infer<typeof bcfImportResultSchema>

/** The multipart body as an agent sends it: one `.bcf` or `.bcfzip` file, no other fields. */
export const BCF_IMPORT_EXTENSIONS = ['.bcf', '.bcfzip'] as const

/** Whether a file name is one the import reads. The bytes decide; the name only catches an obvious wrong pick. */
export const isBcfFilename = (name: string): boolean => BCF_IMPORT_EXTENSIONS.some((extension) => name.toLowerCase().endsWith(extension))
