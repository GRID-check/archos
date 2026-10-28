import { X } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { AnimatePresence, motion, motionEntrance, motionQuickExit } from '@/components/motion'
import { ChatScreeningNotice } from '@/features/chat/components/ChatScreeningNotice'
import { OtherProjectsNotice } from '@/features/chat/components/OtherProjectsNotice'
import { LiveDictationStrip } from '@/features/dictation'
import { InvokedSkillChip } from '@/features/skills/components/InvokedSkillChip'
import type { InputAreaController } from './use-input-area-controller'

export function ComposerField({ controller }: { controller: InputAreaController }) {
  return (
    <>
      <Textarea
        ref={controller.textareaRef}
        // 16px on a coarse pointer keeps iOS Safari from zooming the page
        // when the composer gains focus; a mouse gets the body ramp step. The
        // pointer axis, not `md:` — see the note in `ui/input.tsx`.
        // The composer CARD signals focus with its focus-within ring (see the
        // card class above), so the textarea shows no ring/border/outline of
        // its own. `outline-hidden!` beats the app's global :focus-visible
        // outline (globals.css, unlayered) with an important utility — otherwise
        // focus is drawn twice: a nested box inside the card's ring.
        className="max-h-52 min-h-10 resize-none border-0 bg-transparent px-1.5 py-1 text-sm leading-[1.5] shadow-none outline-none! focus-visible:ring-0 pointer-coarse:min-h-11 pointer-coarse:text-base"
        value={controller.message}
        onChange={(e) => controller.handleValueChange(e.target.value, e.target.selectionStart)}
        onKeyDown={controller.handleKeyDown}
        // Intent to send. In a shared thread this is what opens the agent socket
        // (see the note next to `noteSendIntent` above); everywhere else the
        // socket is already up and this is a no-op.
        onFocus={controller.noteSendIntent}
        // The caret can move without the text changing (arrows, a click); the
        // trigger has to follow it, or the picker outlives its own fragment.
        onKeyUp={(e) => controller.syncMentionQueryFromElement(e.currentTarget)}
        onClick={(e) => controller.syncMentionQueryFromElement(e.currentTarget)}
        onPaste={controller.handlePaste}
        // Remembered for dictation, which reads it after the textarea has
        // lost focus to the microphone button. Blur too, not only select:
        // a caret set by script or assistive tech fires no select event,
        // and pressing the microphone always blurs the field.
        onSelect={controller.rememberDictationCaret}
        onBlur={controller.rememberDictationCaret}
        placeholder={controller.getPlaceholder()}
        // `draftLocked`, not `disabled`: during the reader's own turn the
        // field stays live (and keeps its focus) so the follow-up can be
        // written while the answer arrives; only the send waits.
        disabled={controller.draftLocked}
        // While typing ahead the placeholder says why Enter waits, but only
        // while the field is empty. A screen reader is told for as long as
        // the turn runs.
        aria-describedby={controller.typingAhead ? controller.typeAheadHintId : undefined}
        rows={1}
        // The action key on a phone keyboard, told what it actually does.
        // `handleKeyDown` above sends on a plain Enter and only inserts a
        // newline on Shift+Enter — but a `<textarea>` defaults its soft-key
        // to the return glyph, so the most consequential key in the product
        // was drawn as "start a new line" and wired to "send this to the
        // agent". `enterKeyHint="send"` makes the label agree with the
        // handler. It changes no behaviour on any device; it stops the
        // phone from misdescribing the behaviour there already is.
        //
        // Deliberately NOT paired with autocorrect/autocapitalize off the
        // way the search fields are: this field takes German prose, and
        // there the phone's help is help.
        enterKeyHint="send"
        aria-label={
          controller.isResponseMode
            ? controller.t('inputArea.responseInput')
            : controller.t('inputArea.chatMessageInput')
        }
        // Combobox semantics only while the picker is live: the listbox
        // `aria-controls` points at exists only then, and a chat composer that
        // announces itself as a combobox at all times is worse for a screen
        // reader than one that announces the popup when it appears.
        role={
          controller.mentionPickerOpen || controller.slash.open || controller.reference.open
            ? 'combobox'
            : undefined
        }
        aria-expanded={
          controller.mentionPickerOpen || controller.slash.open || controller.reference.open
            ? true
            : undefined
        }
        aria-haspopup={
          controller.mentionPickerOpen || controller.slash.open || controller.reference.open
            ? 'listbox'
            : undefined
        }
        aria-autocomplete={
          controller.mentionPickerOpen || controller.slash.open || controller.reference.open
            ? 'list'
            : undefined
        }
        aria-controls={
          controller.reference.open
            ? (controller.reference.aria.listboxId ?? undefined)
            : controller.slash.open
              ? (controller.slash.aria.listboxId ?? undefined)
              : controller.mentionPickerOpen
                ? (controller.mentionAria.listboxId ?? undefined)
                : undefined
        }
        aria-activedescendant={
          controller.reference.open
            ? (controller.reference.aria.activeOptionId ?? undefined)
            : controller.slash.open
              ? (controller.slash.aria.activeOptionId ?? undefined)
              : controller.mentionPickerOpen
                ? (controller.mentionAria.activeOptionId ?? undefined)
                : undefined
        }
      />

      {/* „Sensible Daten" (ADR-0086): what the screen found in the message
                that was not sent, and the only two ways on. Under the textarea, which
                still holds the text as typed. */}
      {/* A chat that drew on another project (ADR-0094): which, and what that
                closes, where the reader is about to share or ask for more. */}
      {controller.otherProjects.length > 0 && !controller.screeningHold && (
        <OtherProjectsNotice projects={controller.otherProjects} />
      )}

      {controller.screeningHold && (
        <ChatScreeningNotice
          findings={controller.screeningHold.masked.findings}
          maskedText={controller.screeningHold.masked.text}
          onSendMasked={controller.sendScreenedMasked}
          onEdit={controller.editScreened}
        />
      )}

      {/* The skill this message invokes, if any. Under the textarea and above
                the control row, where the file chips sit: both answer "what is
                attached to what I am about to send?". */}
      <AnimatePresence initial={false}>
        {controller.slash.invokedSkill && (
          <motion.div
            key={`invoked-skill-${controller.slash.invokedSkill.name}`}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 2, transition: motionQuickExit }}
            transition={motionEntrance}
          >
            <InvokedSkillChip
              name={controller.slash.invokedSkill.name}
              description={controller.slash.invokedSkill.description}
              onRemove={controller.cannotContribute ? undefined : controller.slash.clearInvocation}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Upload failures: the composer's one alert. */}
      <AnimatePresence initial={false}>
        {controller.uploadError && (
          <motion.div
            key="upload-error"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4, transition: motionQuickExit }}
            transition={motionEntrance}
          >
            <Alert variant="destructive" className="mt-2">
              <AlertDescription className="flex w-full items-start justify-between gap-2">
                <span>{controller.uploadError}</span>
                <button
                  type="button"
                  onClick={controller.clearError}
                  aria-label={controller.t('dismissError')}
                  className="focus-visible:ring-ring/60 duration-quick inline-flex shrink-0 items-center justify-center rounded-md p-1 opacity-70 transition-opacity ease-out hover:opacity-100 focus-visible:ring-2 focus-visible:outline-none pointer-coarse:-m-2.5 pointer-coarse:size-11"
                >
                  <X className="size-4" aria-hidden="true" />
                </button>
              </AlertDescription>
            </Alert>
          </motion.div>
        )}
      </AnimatePresence>

      {/* A recording at the width of the card, on a touch screen: the
                level, the time against the limit, and the whole bar as Stop. */}
      <LiveDictationStrip channel={controller.dictationChannel} locale={controller.locale} />

      {/* What capture has to say: one line above the controls, never a
                block that pushes them down. A failed dictation is an alert; the
                reason a microphone cannot be used is a status, said on a press. */}
      <AnimatePresence initial={false}>
        {controller.composerNote && (
          <motion.p
            key="composer-note"
            role={controller.composerNote.tone === 'error' ? 'alert' : 'status'}
            data-testid="composer-note"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 2, transition: motionQuickExit }}
            transition={motionEntrance}
            className={cn(
              'mt-2 flex items-center gap-1 text-xs leading-snug',
              controller.composerNote.tone === 'error'
                ? 'text-destructive'
                : 'text-muted-foreground'
            )}
          >
            <span className="min-w-0 flex-1">{controller.composerNote.text}</span>
            <button
              type="button"
              onClick={() => controller.setComposerNote(null)}
              aria-label={controller.tCapture('dictation.dismiss')}
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex size-6 shrink-0 items-center justify-center rounded-md focus-visible:ring-2 focus-visible:outline-none pointer-coarse:size-11"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </motion.p>
        )}
      </AnimatePresence>

      {/* Bottom control row, spaced from the textarea, no rule between.
                Order per the click dummy: scope · Datengrundlage · Deep-Research,
                then attach + send pushed right. */}
      {/* On a phone: the hold (when there is one), then ONE row of controls
                that never wraps (the scope chip gives way, truncating the project
                name, so Send cannot be orphaned on a line of its own), then the
                addressee line. From `sm` the two wrappers dissolve (`contents`) and
                the pieces sit in one wrapping row as they always have: scope, the
                statements, the buttons pushed right. */}
    </>
  )
}
