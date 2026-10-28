/**
 * InputArea Component
 *
 * Chat input area at the bottom of the chat view.
 * Includes text input, tool buttons, and send action.
 * Uses WebSocket (useWebSocketChat) for full HITL support.
 *
 * When there's a pending interaction (HITL prompt), the input switches
 * to response mode and uses respondToInteraction instead of sendMessage.
 *
 * Disabled state when user is not authenticated.
 */

'use client'

import { type FC, memo } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'

import { cn } from '@/lib/utils'
import { FileSourcesTab } from './FileSourcesTab'
import { trackedFileToFileItem } from '@/features/documents/types'
import { FilePreviewDialog } from '@/features/documents/components/file-preview-dialog'
import { MentionPicker } from '@/features/collaboration/components/MentionPicker'
import { SlashCommandPicker } from '@/features/skills/components/SlashCommandPicker'
import { ComposerSearchPicker } from '@/features/search'
import { useInputAreaController } from './input-area/use-input-area-controller'
import type { InputAreaProps } from './input-area/use-input-area-controller'
import { ComposerAboveField } from './input-area/composer-above-field'
import { ComposerField } from './input-area/composer-field'
import { ComposerControls } from './input-area/composer-controls'

export type { ConnectionMode } from './input-area/use-input-area-controller'

/**
 * Chat input component with text area and action buttons.
 * Positioned at the bottom of the chat area.
 *
 * Uses WebSocket connection for full HITL (human-in-the-loop) support.
 * Set connectionMode='sse' to disable auto-connect (useful for testing).
 *
 * When pendingInteraction exists, input switches to response mode:
 * - Different placeholder text
 * - Uses respondToInteraction instead of sendMessage
 * - Shows visual indicator
 */
export const InputArea: FC<InputAreaProps> = memo(function InputArea(props) {
  const controller = useInputAreaController(props)

  return (
    <div
      ref={controller.composerRootRef}
      className="mx-auto flex w-full max-w-4xl flex-col pt-3 pr-[max(1rem,env(safe-area-inset-right))] pb-[max(0.75rem,var(--shell-inset-bottom,env(safe-area-inset-bottom)))] pl-[max(1rem,env(safe-area-inset-left))] sm:pt-4 sm:pr-[max(1.5rem,env(safe-area-inset-right))] sm:pb-4 sm:pl-[max(1.5rem,env(safe-area-inset-left))]"
    >
      {/* The mention picker is anchored to the composer CARD and opens above it,
          spanning its full width — the Slack/Linear placement. Caret-pixel tracking
          inside a textarea is fragile and buys nothing here. */}
      <Popover
        open={controller.mentionPickerOpen || controller.slash.open || controller.reference.open}
        onOpenChange={(open) => {
          if (open) return
          // Dismiss whichever panel was showing. All can be told to close: only
          // one of them is open, and the others' flags are already false.
          controller.setMentionDismissed(true)
          controller.slash.dismiss()
          controller.reference.dismiss()
        }}
      >
        <PopoverAnchor asChild>
          <div
            ref={controller.composerRef}
            className={cn(
              // Composer card: a glass surface, not an opaque card — `bg-card/90`
              // + `backdrop-blur-md` so it reads as floating OVER the transcript
              // (the same language the toolbar pills and the bottom fade scrim
              // use) rather than as one more opaque block stacked under the last
              // message. The `supports-` step is the no-blur fallback. A single
              // hairline `border-input` — the same alpha-ink grey every text
              // field in the kit carries, one step up from the generic
              // `border` — draws the edge of the card so it reads as a field to
              // type into rather than as a floating patch of glass. Focus is
              // still signalled by the ring on top of it, never by thickening
              // the outline. Textarea on top, control row below with no rule
              // between them: a hairline there read as a stray line across the
              // card, and the card's own edge already groups the two.
              // The ring is the neutral `ring-ring`, the same focus state every
              // other field in the app uses. It was `accent-pop` — a green glow
              // meant to read as "live" — and the accent was withdrawn: on the
              // one surface where a colour is on screen for the whole time
              // somebody is composing, green did not read as liveness so much as
              // as a status, competing with the provenance greens the answer
              // below it uses to mean something. See the design doc §"Accent
              // pop" for what the accent was for and why it is gone.
              // NOT `active:scale-95`: the press response belongs on the controls a
              // reader actually presses (the chips and buttons in the row below), and
              // this div is the card that HOLDS them. With it here, putting the caret
              // in the textarea shrank the whole composer — text, chips and all — on
              // every mousedown, which reads as the surface flinching away from the
              // click rather than as a control acknowledging a press.
              'bg-card/90 supports-[backdrop-filter]:bg-card/85 focus-within:ring-ring/40 duration-quick border-input relative flex flex-col rounded-xl border px-3 py-2.5 shadow-md backdrop-blur-md transition-[box-shadow,border-color] ease-out focus-within:ring-2 sm:px-4',
              controller.isDisabledByAuth && 'opacity-60'
            )}
          >
            <ComposerAboveField controller={controller} />
            <ComposerField controller={controller} />
            <ComposerControls controller={controller} />

            {/* Single hint slot: the first applicable helper line, announced
                politely. The Deep-Research intent echo was deleted — the pill's
                title carries it — so an armed pill shows no line at all. */}
            <div aria-live="polite">{controller.composerHint}</div>
          </div>
        </PopoverAnchor>

        {/* The panel itself supplies the surface, so the popover contributes
            nothing but placement and width. Focus must NOT move here: the user is
            typing, and the textarea forwards the navigation keys. */}
        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          className="w-[var(--radix-popover-trigger-width)] border-0 bg-transparent p-0 shadow-none"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onFocusOutside={(event) => event.preventDefault()}
          // A tap on a row must not take the focus from the textarea. Focus
          // moves on the press, before the row's click; once the field has
          // blurred, iOS drops the keyboard, and the caret restored after the
          // insertion (an effect, not a gesture) cannot raise it again. The
          // reader picked a name and lost the keyboard they were typing on.
          // Cancelling the press keeps the focus where it is; the click still
          // arrives, and scrolling the list is a touch-action, not a press.
          onPointerDown={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()}
          onInteractOutside={(event) => {
            // Clicking inside the composer (e.g. moving the caret) is not
            // "clicking away" — only a click outside it dismisses the picker.
            const target = event.target as Node | null
            if (target && controller.composerRef.current?.contains(target)) event.preventDefault()
          }}
        >
          {controller.reference.open ? (
            <ComposerSearchPicker
              ref={controller.reference.pickerRef}
              query={controller.reference.query}
              search={controller.reference.search}
              onPick={controller.reference.select}
              onAriaChange={controller.reference.onAriaChange}
            />
          ) : controller.slash.open ? (
            <SlashCommandPicker
              ref={controller.slash.pickerRef}
              query={controller.slash.query}
              skills={controller.slash.skills}
              loading={controller.slash.loading}
              onSelect={controller.slash.select}
              onAriaChange={controller.slash.onAriaChange}
            />
          ) : (
            <MentionPicker
              ref={controller.mentionPickerRef}
              query={controller.mentionQuery?.query ?? ''}
              candidates={controller.mentionData?.candidates ?? []}
              canInvite={controller.mentionData?.canInvite ?? false}
              loading={controller.mentionsLoading}
              onSelect={controller.handleMentionSelect}
              onAriaChange={controller.setMentionAria}
            />
          )}
        </PopoverContent>
      </Popover>

      {/* AI-transparency disclosure (EU AI Act Art. 50): users must know they
          interact with an AI system and that answers can be wrong. Kept to a
          single compact line so it costs minimal vertical space on both mobile
          and desktop, while staying persistently visible, legible and not
          hidden behind a click, per the Art. 50(5) "clear and distinguishable"
          standard. That standard is carried by the SENTENCE, which is
          unabridged, always rendered and never collapsed; it used to be led by
          a spark glyph as well, and the glyph was reinforcement rather than the
          disclosure. The composer floats over the scrolling chat, so a light
          blurred pill keeps it readable over messages behind it. */}
      <div className="mt-1.5 flex justify-center">
        {/* Frosted, not hand-derived: this hint sits ON the transcript, and the
            alpha pair is what `backdrop-blur-sm` has to blur (the `supports-`
            step is the no-blur fallback). */}
        <p className="text-muted-foreground bg-muted/70 supports-[backdrop-filter]:bg-muted/45 inline-flex max-w-[calc(100%-1rem)] items-center rounded-lg px-2.5 py-1 text-center text-xs leading-snug backdrop-blur-sm">
          {controller.t('inputArea.aiDisclosure')}
        </p>
      </div>

      {/* Manage-files dialog — one controlled instance shared by the desktop
          button and the mobile text entry. Mobile: a bottom sheet that slides up
          (85dvh, rounded top, safe-area padding). Desktop (sm+): the standard
          centered dialog. The FileSourcesTab inside is the full browse / upload /
          per-file open+delete surface. */}
      <Dialog open={controller.manageFilesOpen} onOpenChange={controller.setManageFilesOpen}>
        <DialogContent
          className={cn(
            'flex max-w-full flex-col gap-0 rounded-t-2xl rounded-b-none p-0',
            'top-auto bottom-0 left-0 translate-x-0 translate-y-0',
            'h-[85dvh] max-h-[85dvh]',
            'sm:top-[50%] sm:bottom-auto sm:left-[50%] sm:h-auto sm:max-h-[calc(100dvh-2rem)] sm:max-w-lg sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-3xl sm:p-6'
          )}
        >
          <DialogHeader className="border-b px-4 py-3 text-left sm:border-0 sm:p-0">
            <DialogTitle>{controller.t('inputArea.manageFiles')}</DialogTitle>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-0 sm:pt-2 sm:pb-0">
            <FileSourcesTab />
          </div>
        </DialogContent>
      </Dialog>

      {/* Read-only preview of an attached file, opened from a successful chip.
          Read-only (canManage=false): the composer is not a management surface —
          that is what the manage-files dialog above is for. */}
      <FilePreviewDialog
        file={controller.previewFile ? trackedFileToFileItem(controller.previewFile) : null}
        canManage={false}
        onClose={() => controller.setPreviewFile(null)}
      />
    </div>
  )
})
