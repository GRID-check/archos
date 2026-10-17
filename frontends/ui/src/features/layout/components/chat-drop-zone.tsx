'use client'

/**
 * The chat panel as one drop target: a file let go anywhere over the
 * conversation, the transcript and the toolbar included, is attached to it.
 *
 * Only the composer card took a drop. The card is a strip at the bottom of a
 * tall panel, so the natural gesture (drag the file onto the conversation) missed
 * it, and the miss reached the window guard and was refused without a word.
 *
 * The panel owns the zone and its overlay; the composer owns what a drop does.
 * It registers its attach path and, when attaching is not possible right now,
 * the reason (`useChatDropTarget`), so the overlay can say „Piloti is answering"
 * instead of showing a copy cursor over a drop that would be thrown away.
 * Without a composer (a chat the reader may no longer read, a signed-out
 * reader) the panel is no target at all, and the window guard answers.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { useFileDragDrop } from '@/features/documents'
import { FileDropOverlay } from '@/features/documents/components/file-drop-overlay'
import { useTranslations } from '@/i18n'
import { useAppConfig } from '@/shared/context'
import { cn } from '@/lib/utils'
import { UploadDestinationNote } from './UploadDestination'

/** What the composer offers the panel's drop zone. */
export interface ChatDropTarget {
  /** Attach the dropped files, as the paperclip would. */
  attach: (files: File[]) => void
  /** Why attaching is not possible right now, in the reader's words, or null. */
  refusal: string | null
}

type Register = (target: ChatDropTarget | null) => void

const ChatDropContext = createContext<Register | null>(null)

/**
 * Offer the composer to the chat panel's drop zone, or withdraw it (`null`).
 * Outside a {@link ChatDropZone} (a `/dev` preview) this does nothing.
 */
export function useChatDropTarget(target: ChatDropTarget | null): void {
  const register = useContext(ChatDropContext)
  // The attach path changes identity with every attached file; the panel needs
  // only the latest, not a re-registration each time.
  const attachRef = useRef(target?.attach)
  attachRef.current = target?.attach
  const present = target !== null
  const refusal = target?.refusal ?? null
  useEffect(() => {
    if (!register) return
    if (!present) {
      register(null)
      return
    }
    register({ attach: (files) => attachRef.current?.(files), refusal })
    return () => register(null)
  }, [register, present, refusal])
}

export function ChatDropZone({
  className,
  style,
  children,
}: {
  className?: string
  style?: CSSProperties
  children: ReactNode
}) {
  const t = useTranslations('research')
  const { fileUpload } = useAppConfig()
  const [target, setTarget] = useState<ChatDropTarget | null>(null)
  const attach = useCallback((files: File[]) => target?.attach(files), [target])
  const { isDragging, isUnsupportedDrag, refusal, dragHandlers } = useFileDragDrop({
    onDrop: attach,
    disabled: target === null,
    refusal: target?.refusal ?? null,
  })

  return (
    <ChatDropContext.Provider value={setTarget}>
      <div className={cn('relative', className)} style={style} {...dragHandlers} data-testid="chat-drop-zone">
        {children}
        {isDragging && (
          <FileDropOverlay
            isUnsupported={isUnsupportedDrag}
            uploadLabel={t('inputArea.dropToUpload')}
            unsupportedLabel={t('inputArea.unsupportedFileType')}
            refusal={refusal}
            hint={
              isUnsupportedDrag ? (
                <span className="text-muted-foreground text-xs">
                  {t('inputArea.accepts', { types: fileUpload.acceptedTypes })}
                </span>
              ) : (
                // WHERE the drop lands, in the sources panel's own words: the
                // moment of the drop is the one where the reader decides.
                <UploadDestinationNote target="session" />
              )
            }
            testId="chat-drop-overlay"
          />
        )}
      </div>
    </ChatDropContext.Provider>
  )
}
