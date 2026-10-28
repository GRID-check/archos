import { describe, expect, test, vi } from 'vitest'
import { getFileUploadConfigFromEnv } from '@/shared/config/file-upload'
import {
  documentsOnlyAccept,
  isGenericPhotoName,
  isHeic,
  photoBaseName,
  photoIntake,
  prepareSitePhotos,
} from './site-photo'

/** 2026-10-15 14:32:05 local time, as a phone stamps a fresh capture. */
const TAKEN = new Date(2026, 9, 15, 14, 32, 5)

const photo = (name: string, type = 'image/jpeg', lastModified = TAKEN.getTime()) =>
  new File(['jpeg-bytes'], name, { type, lastModified })

describe('photoIntake', () => {
  test('photos are offered with explicit types, never image/*, so iOS hands a library HEIC over as JPEG', () => {
    const config = getFileUploadConfigFromEnv({}, { imageUploadEnabled: true, vlmAvailable: true })

    const intake = photoIntake(config)

    expect(intake).toEqual({ available: true, accept: 'image/png,image/jpeg,image/webp' })
  })

  test('without a vision model, photos are off and the reason is the missing model', () => {
    const config = getFileUploadConfigFromEnv({}, { imageUploadEnabled: true, vlmAvailable: false })

    expect(photoIntake(config)).toEqual({ available: false, reason: 'vlm-unavailable' })
  })

  test('with the product flag off, photos are off and the reason is the flag', () => {
    const config = getFileUploadConfigFromEnv({}, { imageUploadEnabled: false, vlmAvailable: true })

    expect(photoIntake(config)).toEqual({ available: false, reason: 'not-enabled' })
  })
})

describe('documentsOnlyAccept', () => {
  test('drops the image types and keeps every other entry', () => {
    expect(documentsOnlyAccept('.pdf,.docx,.png,.jpg,.jpeg,.webp,.ifc')).toBe('.pdf,.docx,.ifc')
  })
})

describe('photo names', () => {
  test.each(['image.jpg', 'image.jpeg', 'image.png', 'IMAGE.JPG', 'image (1).jpg', 'image-2.png', 'photo.heic'])(
    '%s says nothing about the photo',
    (name) => expect(isGenericPhotoName(name)).toBe(true)
  )

  test.each(['IMG_4021.jpg', 'Riss Stiege 2.jpg', 'Bestand_Nordfassade.png', 'image.pdf'])(
    '%s is a name worth keeping',
    (name) => expect(isGenericPhotoName(name)).toBe(false)
  )

  test('the base name is the moment it was taken, in characters every file system takes', () => {
    expect(photoBaseName(TAKEN, 'Foto')).toBe('Foto 2026-10-15 14-32-05')
  })

  test('HEIC is recognised by its name or by its type', () => {
    expect(isHeic({ name: 'IMG_1.HEIC', type: '' })).toBe(true)
    expect(isHeic({ name: 'upload', type: 'image/heif' })).toBe(true)
    expect(isHeic({ name: 'IMG_1.jpg', type: 'image/jpeg' })).toBe(false)
  })
})

describe('prepareSitePhotos', () => {
  const base = { prefix: 'Foto', imagesAccepted: true }

  test('two camera captures, both called image.jpg by iOS, become two documents rather than one replacing the other', async () => {
    const { files } = await prepareSitePhotos([photo('image.jpg'), photo('image.jpg')], { ...base, source: 'camera' })

    expect(files.map((file) => file.name)).toEqual(['Foto 2026-10-15 14-32-05.jpg', 'Foto 2026-10-15 14-32-05 (2).jpg'])
    expect(files[0]!.type).toBe('image/jpeg')
  })

  test('a rename never lands on a name the shelf already holds', async () => {
    const { files } = await prepareSitePhotos([photo('image.jpg')], {
      ...base,
      source: 'camera',
      taken: ['foto 2026-10-15 14-32-05.jpg'],
    })

    expect(files[0]!.name).toBe('Foto 2026-10-15 14-32-05 (2).jpg')
  })

  test('from a picker, a named photo keeps its name and a pasted image.png gets one', async () => {
    const named = photo('IMG_4021.jpg')
    const { files } = await prepareSitePhotos([named, photo('image.png', 'image/png')], { ...base, source: 'picker' })

    expect(files[0]).toBe(named)
    expect(files[1]!.name).toBe('Foto 2026-10-15 14-32-05.png')
  })

  test('a document passes through untouched', async () => {
    const pdf = new File(['%PDF'], 'Einreichplan.pdf', { type: 'application/pdf' })

    const { files } = await prepareSitePhotos([pdf], { ...base, source: 'picker' })

    expect(files).toEqual([pdf])
  })

  test('a HEIC is re-encoded as JPEG under its own name', async () => {
    const convertHeic = vi.fn(async (_file: File, name: string) => new File(['jpeg'], name, { type: 'image/jpeg' }))

    const { files, unconvertibleHeic } = await prepareSitePhotos([photo('IMG_7.HEIC', 'image/heic')], {
      ...base,
      source: 'picker',
      convertHeic,
    })

    expect(files.map((file) => [file.name, file.type])).toEqual([['IMG_7.jpg', 'image/jpeg']])
    expect(unconvertibleHeic).toEqual([])
  })

  test('a HEIC this browser cannot decode is reported, not uploaded', async () => {
    const { files, unconvertibleHeic } = await prepareSitePhotos([photo('IMG_7.HEIC', 'image/heic')], {
      ...base,
      source: 'picker',
      convertHeic: async () => null,
    })

    expect(files).toEqual([])
    expect(unconvertibleHeic).toEqual(['IMG_7.HEIC'])
  })

  test('nothing is converted for a shelf that refuses images: the validator names the file', async () => {
    const convertHeic = vi.fn()
    const heic = photo('IMG_7.HEIC', 'image/heic')

    const { files } = await prepareSitePhotos([heic], { ...base, imagesAccepted: false, source: 'picker', convertHeic })

    expect(files).toEqual([heic])
    expect(convertHeic).not.toHaveBeenCalled()
  })
})
