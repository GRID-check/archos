/**
 * A photo from the phone, on its way into a shelf.
 *
 * WHETHER PHOTOS ARE OFFERED AT ALL is not decided here. Images are accepted
 * when the `image-upload` flag is on AND a vision model is configured
 * (`shared/config/file-upload.ts`): Piloti reads a standalone image only through
 * that model, and without one the knowledge layer fails the file with
 * `vlm_not_configured`. This module reads the result of that rule and turns it
 * into what a phone needs: which `accept` list opens the camera and the photo
 * library, and, when photos are off, which of the two reasons to say out loud.
 *
 * WHAT IT DOES TO A PHOTO, and why each step exists:
 *
 * - **A name of its own.** The filename is the document's identity on every
 *   shelf: an upload under a name the shelf already holds REPLACES that
 *   document as its next Fassung (`lib/documents/shelf-upload.ts`). iOS Safari
 *   names every camera capture `image.jpg`, and a pasted screenshot is always
 *   `image.png`, so the second site photo of the afternoon silently replaced the
 *   first. A capture, and any photo whose name says nothing, is renamed after
 *   the moment it was taken: `Foto 2026-10-15 14-32-05.jpg`.
 * - **JPEG, not HEIC.** Nothing past the browser reads HEIC: the accept-list
 *   and the server allow-list do not name it, the knowledge layer's Pillow has
 *   no decoder for it, and only Safari can draw one. The pickers below name
 *   explicit JPEG/PNG/WebP types rather than `image/*`, which is what makes iOS
 *   hand a library photo over as JPEG. A HEIC that still arrives (a drag from
 *   macOS, the Files app) is re-encoded through the browser's own decoder where
 *   it has one, and reported where it does not.
 */

import type { FileUploadConfig } from '@/shared/context'
import { IMAGE_EXTENSIONS, buildAcceptedMimeTypes } from '@/shared/config/file-upload'

/** Why photos cannot be added on this surface; each has its own sentence. */
export type PhotoUnavailableReason = 'vlm-unavailable' | 'not-enabled'

export type PhotoIntake =
  | {
      available: true
      /** The `accept` for the camera and the photo library: explicit types, never `image/*`. */
      accept: string
    }
  | { available: false; reason: PhotoUnavailableReason }

const isImageExtension = (extension: string): boolean =>
  (IMAGE_EXTENSIONS as readonly string[]).includes(extension.trim().toLowerCase())

/** Whether photos may be added under this upload configuration, and with which `accept`. */
export function photoIntake(
  config: Pick<FileUploadConfig, 'acceptedTypes' | 'imageUploadBlockedReason'>
): PhotoIntake {
  const images = config.acceptedTypes.split(',').filter(isImageExtension).join(',')
  if (images) return { available: true, accept: buildAcceptedMimeTypes(images).join(',') }
  return {
    available: false,
    reason:
      config.imageUploadBlockedReason === 'vlm-unavailable' ? 'vlm-unavailable' : 'not-enabled',
  }
}

/**
 * The accept-list without its image types, for a „Datei auswählen" that sits
 * beside the two photo entries. Offered with images in it, iOS answers the tap
 * with its own Mediathek / Kamera / Dateien sheet, so the reader would choose
 * the same thing twice.
 */
export function documentsOnlyAccept(acceptedTypes: string): string {
  return acceptedTypes
    .split(',')
    .map((extension) => extension.trim())
    .filter((extension) => extension && !isImageExtension(extension))
    .join(',')
}

const HEIC_NAME = /\.(heic|heif)$/i
const HEIC_TYPES: ReadonlySet<string> = new Set([
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
])

/** Whether a file is a HEIC/HEIF photo, by its name or its reported type. */
export function isHeic(file: Pick<File, 'name' | 'type'>): boolean {
  return HEIC_NAME.test(file.name) || HEIC_TYPES.has(file.type.toLowerCase())
}

const PHOTO_NAME = /\.(jpe?g|png|webp|heic|heif)$/i

/**
 * A photo whose name says nothing about it: what iOS calls a capture
 * (`image.jpg`), what a pasted screenshot is called (`image.png`), and their
 * numbered copies. `IMG_4021.jpg` is NOT generic: the camera roll's counter
 * already makes it unique, and the reader may know it by that name.
 */
const GENERIC_PHOTO_NAME =
  /^(image|photo|picture|foto|bild)(?:[\s_-]*\(?\d{0,3}\)?)?\.(jpe?g|png|webp|heic|heif)$/i

export function isGenericPhotoName(name: string): boolean {
  return GENERIC_PHOTO_NAME.test(name.trim())
}

const pad = (value: number): string => String(value).padStart(2, '0')

/** `Foto 2026-10-15 14-32-05`: sortable, readable, and free of the characters a file system refuses. */
export function photoBaseName(takenAt: Date, prefix: string): string {
  const date = `${takenAt.getFullYear()}-${pad(takenAt.getMonth() + 1)}-${pad(takenAt.getDate())}`
  const time = `${pad(takenAt.getHours())}-${pad(takenAt.getMinutes())}-${pad(takenAt.getSeconds())}`
  return `${prefix} ${date} ${time}`
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

/** `base.ext`, or `base (2).ext` and onward while the name is taken. */
function uniqueName(base: string, extension: string, taken: Set<string>): string {
  let candidate = `${base}${extension}`
  for (let n = 2; taken.has(candidate.toLowerCase()); n += 1)
    candidate = `${base} (${n})${extension}`
  taken.add(candidate.toLowerCase())
  return candidate
}

/** The longest edge a re-encoded HEIC keeps: inside iOS's canvas limit, far above what the vision model reads. */
const MAX_REENCODED_EDGE_PX = 4096

/**
 * Re-encode a HEIC as JPEG through the browser's own decoder. `null` where the
 * browser cannot decode HEIC (everything but Safari) or the photo will not fit
 * a canvas. The re-encode drops EXIF, so the capture date is lost; the file's
 * name, taken from `lastModified`, keeps the day.
 */
export async function heicToJpeg(file: File, name: string): Promise<File | null> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, MAX_REENCODED_EDGE_PX / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.9)
    )
    if (!blob) return null
    return new File([blob], name, { type: 'image/jpeg', lastModified: file.lastModified })
  } catch {
    return null
  }
}

export interface PreparePhotosOptions {
  /** `camera` renames every file; anything else renames only a photo with a generic name. */
  source: 'camera' | 'picker'
  /** The word the name starts with, in the reader's language („Foto"). */
  prefix: string
  /** Names already on the shelf, so a rename never lands on one of them. */
  taken?: Iterable<string>
  /** Whether images are accepted here at all: no HEIC is converted for a shelf that will refuse it. */
  imagesAccepted: boolean
  /** Fallback for a file with no `lastModified`; injectable for tests. */
  now?: () => Date
  /** The HEIC re-encoder; injectable because jsdom has no image decoder. */
  convertHeic?: (file: File, name: string) => Promise<File | null>
}

export interface PreparedPhotos {
  files: File[]
  /** HEIC photos this browser could not re-encode, by their original names. */
  unconvertibleHeic: string[]
}

/**
 * Every file of one selection, with photos named and HEIC re-encoded. Files
 * that are not photos pass through untouched, so the composer can run a paste
 * or a drop through here without asking what it holds.
 */
export async function prepareSitePhotos(
  files: File[],
  options: PreparePhotosOptions
): Promise<PreparedPhotos> {
  const {
    source,
    prefix,
    imagesAccepted,
    now = () => new Date(),
    convertHeic = heicToJpeg,
  } = options
  const taken = new Set(Array.from(options.taken ?? [], (name) => name.toLowerCase()))
  const prepared: File[] = []
  const unconvertibleHeic: string[] = []
  const keep = (file: File): void => {
    taken.add(file.name.toLowerCase())
    prepared.push(file)
  }

  for (const file of files) {
    const photo = PHOTO_NAME.test(file.name) || file.type.startsWith('image/')
    const heic = photo && isHeic(file)
    const nameless = source === 'camera' || isGenericPhotoName(file.name)
    if (!photo || (!heic && !nameless) || (heic && !imagesAccepted)) {
      // Not a photo, a photo that already has a name, or a HEIC for a shelf
      // that refuses images (the validator says so, under the real name).
      keep(file)
      continue
    }
    const ownExtension = extensionOf(file.name)
    const takenAt = file.lastModified > 0 ? new Date(file.lastModified) : now()
    const base = nameless
      ? photoBaseName(takenAt, prefix)
      : file.name.slice(0, file.name.length - ownExtension.length)
    const name = uniqueName(base, heic ? '.jpg' : ownExtension || '.jpg', taken)
    if (!heic) {
      prepared.push(new File([file], name, { type: file.type, lastModified: file.lastModified }))
      continue
    }
    const converted = await convertHeic(file, name)
    if (converted) prepared.push(converted)
    else unconvertibleHeic.push(file.name)
  }

  return { files: prepared, unconvertibleHeic }
}
