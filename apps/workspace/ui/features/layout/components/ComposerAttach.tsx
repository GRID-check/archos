'use client'

/**
 * The composer's paperclip, and what it opens.
 *
 * WITH A MOUSE it is one action: the file picker, with every accepted type,
 * photos included where photos are accepted. A menu in front of it would be a
 * second click for nothing.
 *
 * ON A TOUCH SCREEN it opens three entries, the site photo first:
 *
 * - **Foto aufnehmen** opens the camera directly (`capture="environment"`):
 *   the architect on site holds the phone up and shoots, with no sheet in
 *   between.
 * - **Aus Mediathek** offers the photos already on the phone.
 * - **Datei auswählen** offers the documents, and only those: with image types
 *   in its `accept`, iOS answers the tap with its own Mediathek / Kamera /
 *   Dateien sheet, and the reader would make the same choice twice.
 *
 * The menu says where all of it lands (this chat, never the project's files),
 * and when photos are off it says why under the two photo entries rather than
 * leaving them out: an entry that silently is not there reads as "the app
 * cannot take photos", when the truth is a setting the office can change.
 *
 * Photos are named and HEIC is re-encoded on the way through
 * (`features/documents/lib/site-photo.ts`); this component only says which
 * input a selection came from.
 */

import { useRef, type ChangeEvent, type FC } from 'react'
import { Camera, FileText, Images, Paperclip } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuItemText,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useCoarsePointer } from '@/features/documents/hooks/use-coarse-pointer'
import { useTranslations } from '@/i18n'
import { captureCopy } from '@/i18n/namespaces/capture'
import { researchCopy } from '@/i18n/namespaces/research'
import { documentsOnlyAccept, type PhotoIntake } from '@/features/documents/lib/site-photo'

/** Which input a selection came from: a camera capture is always renamed. */
export type AttachSource = 'camera' | 'picker'

export interface ComposerAttachProps {
  /** The full accept-list (`FileUploadConfig.acceptedTypes`). */
  acceptedTypes: string
  /** Whether photos are accepted here, and with which `accept`. */
  photos: PhotoIntake
  disabled: boolean
  /** Why the paperclip is disabled, or what it does; its tooltip. */
  title: string
  onFiles: (files: File[], source: AttachSource) => void
}

export const ComposerAttach: FC<ComposerAttachProps> = ({
  acceptedTypes,
  photos,
  disabled,
  title,
  onFiles,
}) => {
  const t = useTranslations(researchCopy)
  const tCapture = useTranslations(captureCopy)
  const touch = useCoarsePointer()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const libraryInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)

  const handleChange = (source: AttachSource) => (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    // Reset first, so the same photo or file can be picked again.
    event.target.value = ''
    if (files.length > 0) onFiles(files, source)
  }

  const documentsAccept = touch ? documentsOnlyAccept(acceptedTypes) : acceptedTypes
  const paperclip = (
    <Button
      variant="ghost"
      size="icon"
      className="text-subtle size-[34px] rounded-lg"
      disabled={disabled}
      aria-label={t('inputArea.attachFiles')}
      title={title}
      onClick={touch ? undefined : () => fileInputRef.current?.click()}
      data-testid="composer-attach"
    >
      <Paperclip className="size-4" aria-hidden="true" />
    </Button>
  )

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={documentsAccept}
        className="hidden"
        tabIndex={-1}
        onChange={handleChange('picker')}
        data-testid="composer-file-input"
      />
      {photos.available && (
        <>
          <input
            ref={libraryInputRef}
            type="file"
            multiple
            accept={photos.accept}
            className="hidden"
            tabIndex={-1}
            onChange={handleChange('picker')}
            data-testid="composer-library-input"
          />
          {/* Explicit image types, never `image/*`, so iOS hands over JPEG
              (see `site-photo.ts`); `capture` opens the rear camera directly. */}
          <input
            ref={cameraInputRef}
            type="file"
            accept={photos.accept}
            capture="environment"
            className="hidden"
            tabIndex={-1}
            onChange={handleChange('camera')}
            data-testid="composer-camera-input"
          />
        </>
      )}

      {touch ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={disabled}>
            {paperclip}
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            align="end"
            sideOffset={8}
            aria-label={tCapture('attach.menuLabel')}
            className="w-72 max-w-[calc(100vw-2rem)]"
            data-testid="composer-attach-menu"
          >
            <DropdownMenuItem
              disabled={!photos.available}
              onSelect={() => cameraInputRef.current?.click()}
              data-testid="composer-attach-camera"
            >
              <Camera aria-hidden="true" />
              <DropdownMenuItemText
                title={tCapture('attach.takePhoto')}
                hint={tCapture('attach.takePhotoHint')}
              />
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!photos.available}
              onSelect={() => libraryInputRef.current?.click()}
              data-testid="composer-attach-library"
            >
              <Images aria-hidden="true" />
              <DropdownMenuItemText
                title={tCapture('attach.photoLibrary')}
                hint={tCapture('attach.photoLibraryHint')}
              />
            </DropdownMenuItem>
            {!photos.available && (
              <p
                className="text-muted-foreground px-2.5 pb-1.5 pt-0.5 text-xs leading-snug"
                role="note"
              >
                {tCapture(
                  photos.reason === 'vlm-unavailable'
                    ? 'photos.unavailableVision'
                    : 'photos.unavailableNotEnabled'
                )}
              </p>
            )}
            <DropdownMenuItem
              onSelect={() => fileInputRef.current?.click()}
              data-testid="composer-attach-file"
            >
              <FileText aria-hidden="true" />
              <DropdownMenuItemText
                title={tCapture('attach.chooseFile')}
                hint={tCapture('attach.chooseFileHint')}
              />
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <p className="text-muted-foreground px-2.5 py-1.5 text-xs leading-snug">
              {tCapture('attach.destinationChat')}
            </p>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        paperclip
      )}
    </>
  )
}
