/**
 * How an agent sends bytes (ADR-0122). Pure: no `server-only`, no I/O, so the
 * catalog, the OpenAPI export and the specs share it.
 *
 * An MCP tool call carries JSON, so a file travels as base64 inside it. The
 * dispatcher (`dispatch.ts`) turns that into what the UI's uploader sends: a
 * multipart `FormData` with a `file` part and the route's text fields, or, for
 * the mail import's parts, the raw bytes. The route's own parsing stays the
 * gate; this schema only shapes and bounds what the agent hands over.
 */

import { z } from 'zod'

/**
 * Most bytes one file or raw part may carry through the agent door, decoded.
 * It is the Outlook import's part size (32 MiB), the largest single request the
 * UI itself sends; documents are bound lower by their own route.
 */
export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024

/** Every upload route reads one `file` part, so the agent sends one file. */
export const MAX_UPLOAD_FILES = 1

/** Longest base64 text that decodes to at most {@link MAX_UPLOAD_BYTES}. */
export const MAX_UPLOAD_BASE64_CHARS = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

const contentBase64 = z
  .string()
  .min(1)
  .max(MAX_UPLOAD_BASE64_CHARS)
  .regex(BASE64, 'contentBase64 must be standard base64')
  .describe(`The file's bytes as standard base64 (RFC 4648, with padding), at most ${MAX_UPLOAD_BYTES} bytes decoded.`)

export const uploadFileSchema = z.object({
  name: z.string().trim().min(1).max(255).describe('The file name, with its extension, e.g. "Grundriss EG.pdf".'),
  mimeType: z
    .string()
    .trim()
    .max(255)
    .optional()
    .describe('The media type, e.g. "application/pdf". Defaults to application/octet-stream.'),
  contentBase64,
})
export type UploadFile = z.infer<typeof uploadFileSchema>

const fieldValue = z.string().max(2_000)

/**
 * The body of a multipart operation: the file and the route's own text
 * fields. `fields` lists the text parts a route reads (`projectId`, `folderId`,
 * `uploadBatchId`, ...), each described, so the agent sees the real names. It
 * may be left out when every field is optional.
 */
export function uploadBodySchemaWith<Shape extends Record<string, z.ZodTypeAny>>(fields: Shape) {
  const object = z.object(fields).strict().describe('The route’s text fields, sent beside the file as form parts.')
  const allOptional = Object.values(fields).every((field) => field.isOptional())
  return z.object({
    files: z.array(uploadFileSchema).min(1).max(MAX_UPLOAD_FILES).describe('The file to upload. Exactly one file.'),
    fields: allOptional ? object.optional() : object,
  })
}

/**
 * The optional text fields every document upload route reads beside `file`
 * (`uploadDocument`, `uploadOfficeShelfDocument`, `uploadSessionDocument`).
 */
export const documentUploadFields = {
  originPath: z
    .string()
    .max(2_000)
    .optional()
    .describe('Where the file sat before upload, e.g. "Drawings/GF/floor-plan.pdf". Only for a folder upload; it is screened by name.'),
  screeningRelease: z
    .literal('name')
    .optional()
    .describe('Send "name" only when a reviewer released this file’s name from the upload screening.'),
  uploadBatchId: z
    .string()
    .uuid()
    .optional()
    .describe('The batch uuid given to upload-batch-open, to file this upload under that batch.'),
} satisfies Record<string, z.ZodTypeAny>

/** A multipart body with free-form text fields, for a route whose fields are not fixed. */
export const uploadBodySchema = z.object({
  files: z.array(uploadFileSchema).min(1).max(MAX_UPLOAD_FILES).describe('The file to upload. Exactly one file.'),
  fields: z.record(fieldValue).optional().describe('Text fields sent beside the file as form parts.'),
})

/** The body of a `raw` operation: the request body's bytes, sent as application/octet-stream. */
export const rawBodySchema = z.object({ contentBase64 })

export interface UploadBody {
  readonly files: readonly UploadFile[]
  readonly fields?: Record<string, string | undefined>
}

/** Decode `contentBase64`; `null` when it is not base64 or exceeds the cap. */
export function decodeBase64(value: string): Uint8Array<ArrayBuffer> | null {
  if (!BASE64.test(value) || value.length > MAX_UPLOAD_BASE64_CHARS) return null
  const buffer = Buffer.from(value, 'base64')
  if (buffer.byteLength > MAX_UPLOAD_BYTES) return null
  const bytes = new Uint8Array(buffer.byteLength)
  bytes.set(buffer)
  return bytes
}
