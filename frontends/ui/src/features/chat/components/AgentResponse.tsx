/**
 * AgentResponse Component
 *
 * Displays a completed agent response in the chat area: the prose, the cards it
 * placed, the sources it stands on and the footer beneath them. Left-aligned
 * with distinct styling from user messages.
 *
 * It is the WHOLE rendering of an answer. A run's report is this same card,
 * drawn under the run's block in the thread that commissioned it (ADR-0062), so
 * there is no other surface an answer can send the reader to and no control here
 * that offers one.
 */

'use client'

import { type FC } from 'react'

import { HeightExpand } from '@/components/motion/height-arrival'
import { cn } from '@/lib/utils'
import { MessageCircle } from 'lucide-react'
import { SectionLabel } from '@/components/ui/section-label'
import { MarkdownRenderer } from '@/shared/components/MarkdownRenderer'
import { MarkdownSlotProvider } from '@/shared/components/MarkdownRenderer/slot-context'
import { handleNearestCitationTap } from '../hooks/use-nearest-citation-tap'
import { AnswerCitations } from './AnswerCitations'
import { DiagramFilingProvider } from '@/features/diagrams/diagram-filing-context'
import { NestedMarkdownPluginsProvider } from '@/shared/components/MarkdownRenderer/nested-plugins-context'
import { AnswerSourcesRow } from './AnswerSourcesRow'
import { AnswerOutline } from './AnswerOutline'
import { FindingsMatrix } from './FindingsMatrix'
import { CardSlotLiveProvider } from './CardSlotArrival'
import { AnswerDataProvider } from '@/shared/components/MarkdownRenderer/answer-block-context'
import { AnswerProjectStrip } from '@/shared/components/MarkdownRenderer/project-binding'
import { LookupFoundNothingNote } from './agent-response/answer-notes'
import { AnswerDetails } from './agent-response/answer-details'
import { RoleTabMark, StreamingCaret } from './agent-response/answer-role'
import { proseClass } from './agent-response/answer-prose'
import { AgentResponseProps } from './agent-response/agent-response-props'
import { useAgentResponseController } from './agent-response/use-agent-response-controller'
import { memo } from 'react'
import { AnswerFeedback } from './AnswerFeedback'

/**
 * Agent response bubble component for completed responses
 */
const AgentResponseComponent: FC<AgentResponseProps> = (props) => {
  const controller = useAgentResponseController(props)

  if (controller.hidden) return null

  if (controller.variant === 'inline') {
    return (
      <AnswerDataProvider value={controller.answerData}>
        <DiagramFilingProvider target={controller.diagramFilingTarget}>
          <NestedMarkdownPluginsProvider plugins={controller.nestedPlugins}>
            <AnswerCitations
              documents={controller.documents}
              anchorPrefix={controller.anchorPrefix}
              resolveFileReference={controller.fileReferences.resolve}
            >
              <div
                ref={controller.frameRef}
                onClick={handleNearestCitationTap}
                className={cn(
                  'flex w-full flex-col gap-2 overflow-hidden break-words',
                  controller.dimmed
                )}
                aria-busy={controller.live || undefined}
                data-testid={controller.failed ? 'answer-failed' : undefined}
                lang="de"
              >
                {/* The answer's masthead — verdict/topic and/or summary, flat above the prose. */}
                {controller.masthead}
                {controller.stripAbove && <AnswerProjectStrip keys={controller.stripKeys} />}
                {controller.findings && (
                  <FindingsMatrix
                    findings={controller.findings}
                    anchorPrefix={controller.anchorPrefix}
                    previous={controller.previousFindings}
                    onCommission={controller.onCommissionFinding}
                  />
                )}
                {/* Response Content rendered as markdown, the streaming caret after
            its last word. Cards the answer placed with a marker are spliced
            into this body. */}
                {controller.retractionLine}
                {controller.viewerActionRow}
                <CardSlotLiveProvider value={controller.live}>
                  <MarkdownSlotProvider render={controller.renderCardSlot}>
                    <div ref={controller.proseRef} className={proseClass(controller.ledeClass)}>
                      <MarkdownRenderer
                        content={controller.body}
                        isStreaming={controller.live}
                        remarkPlugins={controller.markerPlugins}
                        caret={
                          controller.live &&
                          !controller.retracted &&
                          !controller.writingSummary && (
                            <StreamingCaret
                              fading={controller.finishing}
                              idle={controller.paced.idle}
                            />
                          )
                        }
                      />
                    </div>
                  </MarkdownSlotProvider>
                </CardSlotLiveProvider>

                {controller.stoppedMarker}
                {/* What arrives below the prose: never before it, since an answer
            that opens with three diagrams has pushed itself below the fold. */}
                {controller.lateBlocks}

                {/* "Belegt durch": provenance chips for sources this answer carries */}
                <LookupFoundNothingNote show={controller.lookupFoundNothing === true} />
                <AnswerSourcesRow
                  documents={controller.documents}
                  anchorPrefix={controller.anchorPrefix}
                  routingDecision={controller.routingDecision}
                  isStreaming={controller.live || controller.cutShort}
                />

                {/* No copy actions here, deliberately. This variant is the box-less
            rendering used INSIDE another container (the thinking process, the
            dev turn surfaces) — it has no consolidated meta row, so the buttons
            would land as one more loose element in a stack that already ends in
            chips, thumbs and a timestamp. And it never renders a delivered
            answer in the thread: ChatArea always uses the default variant, so
            every answer a reader would paste has its buttons on its own card.
            If that changes, <AnswerActions /> drops into the row below. */}
                {controller.reserveMetaRow && (
                  <div
                    className={controller.hasMetaRow ? 'flex min-h-6 flex-col gap-1.5' : 'min-h-6'}
                    aria-hidden={controller.hasMetaRow ? undefined : true}
                  >
                    {controller.memoryChip}
                    {controller.hasDetailsContent && (
                      <AnswerDetails
                        conversationId={controller.conversationId}
                        messageId={controller.messageId}
                        hasConfidence={controller.hasConfidence}
                        answerConfidence={controller.answerConfidence}
                        answerConfidenceCappedReason={controller.answerConfidenceCappedReason}
                        answerConfidenceReason={controller.answerConfidenceReason}
                        confidenceCheck={controller.confidenceCheck}
                        answerConfidenceVersion={controller.answerConfidenceVersion}
                        skillsActivated={controller.skillsActivated}
                        skillsHidden={controller.skillsHidden}
                        showReasoning={controller.showReasoning}
                        researchTruncated={controller.researchTruncated}
                        truncationReason={controller.truncationReason}
                        degradedReasons={controller.degradedReasons}
                        citationsRemoved={controller.citationsRemoved}
                        readSources={controller.readSources}
                        hasAnswerSources={controller.hasAnswerSources}
                        timestamp={controller.timestamp}
                        answerDurationMs={controller.answerDurationMs}
                      />
                    )}
                    {controller.hasFeedback && controller.messageId && (
                      <AnswerFeedback
                        pending={controller.inert}
                        messageId={controller.messageId}
                        conversationId={controller.conversationId}
                      />
                    )}
                  </div>
                )}
              </div>
            </AnswerCitations>
          </NestedMarkdownPluginsProvider>
        </DiagramFilingProvider>
      </AnswerDataProvider>
    )
  }

  return (
    <AnswerDataProvider value={controller.answerData}>
      <DiagramFilingProvider target={controller.diagramFilingTarget}>
        <NestedMarkdownPluginsProvider plugins={controller.nestedPlugins}>
          <AnswerCitations
            documents={controller.documents}
            anchorPrefix={controller.anchorPrefix}
            resolveFileReference={controller.fileReferences.resolve}
          >
            {/* Full column width, not a fixed 680px: the answer is the thread's main
        content and reads as a centered column (the width itself is set by the
        list's max-w container), rather than a card hugging the left edge with
        dead space beside it. */}
            {/* No entrance of its own: the thread row owns it, gated on whether
            the answer is arriving or being restored (a CSS entrance here
            replayed on every thread open, switch and reload). */}
            {/* An article named by its role tab, busy while it arrives, in the
            answer's language (German) whatever the UI locale: hyphenation
            and a screen reader's voice follow `lang`. */}
            <article
              className="flex w-full flex-col"
              aria-labelledby={controller.roleTabId}
              aria-busy={controller.live || undefined}
              data-testid={controller.failed ? 'answer-failed' : undefined}
              lang="de"
            >
              {/* Role tab — uppercase 10.5/600. Substantive answer: near-black action
          fill + check. Meta / direct reply: quiet secondary fill + conversation icon. */}
              {controller.isNote ? (
                <SectionLabel
                  as="div"
                  id={controller.roleTabId}
                  className="bg-secondary text-secondary-foreground ml-[14px] inline-flex w-fit items-center gap-1.5 rounded-t-md px-2.5 py-1"
                >
                  <MessageCircle className="size-2.5" strokeWidth={2.6} aria-hidden="true" />
                  {controller.tabLabel}
                </SectionLabel>
              ) : (
                <SectionLabel
                  as="div"
                  id={controller.roleTabId}
                  className="bg-primary text-primary-foreground ml-[14px] inline-flex w-fit items-center gap-1.5 rounded-t-md px-2.5 py-1"
                >
                  <RoleTabMark
                    complete={!controller.live && !controller.stopped && !controller.failed}
                    arrived={controller.mountedLive}
                  />
                  {controller.tabLabel}
                </SectionLabel>
              )}

              {/* Shell: subtle surface + hairline + soft shadow, corners clipped. A meta
          reply sits on a quieter muted surface, so the whole card — not just the
          tab — reads as the calmer, non-result kind. Both kinds use shadow-sm,
          matching the composer's elevation so the answer never outranks it. */}
              <div
                className={
                  controller.isNote
                    ? 'border-input bg-muted relative overflow-hidden rounded-lg border shadow-sm'
                    : 'border-input bg-input-background relative overflow-hidden rounded-lg border shadow-sm'
                }
              >
                {/* Answer body — the hero white surface. It fills the top of the card
            flush (corners clipped by the shell) and is separated from the
            provenance footer by a single hairline, so the whole thing reads as
            one considered object with sections — not a card floating in a tray. */}
                <div
                  ref={controller.frameRef}
                  onClick={handleNearestCitationTap}
                  className={cn(
                    'bg-card flex flex-col gap-2 px-4 pt-[18px] pb-[17px] break-words sm:px-[22px]',
                    controller.dimmed
                  )}
                >
                  {/* The answer's masthead — verdict/topic and/or summary, flat above the prose. */}
                  {controller.masthead}
                  {controller.stripAbove && <AnswerProjectStrip keys={controller.stripKeys} />}
                  {controller.findings && (
                    <FindingsMatrix
                      findings={controller.findings}
                      anchorPrefix={controller.anchorPrefix}
                      previous={controller.previousFindings}
                      onCommission={controller.onCommissionFinding}
                    />
                  )}
                  {/* Response Content rendered as markdown, the streaming caret after
              its last word. Cards the answer placed with a marker are spliced
              into this body. */}
                  {controller.retractionLine}
                  {controller.viewerActionRow}
                  <AnswerOutline
                    markdown={controller.body}
                    scopeRef={controller.proseRef}
                    enabled={!controller.live && !controller.failed && !controller.retracted}
                  >
                    <CardSlotLiveProvider value={controller.live}>
                      <MarkdownSlotProvider render={controller.renderCardSlot}>
                        <div ref={controller.proseRef} className={proseClass(controller.ledeClass)}>
                          <MarkdownRenderer
                            content={controller.body}
                            isStreaming={controller.live}
                            remarkPlugins={controller.markerPlugins}
                            caret={
                              controller.live &&
                              !controller.retracted &&
                              !controller.writingSummary && (
                                <StreamingCaret
                                  fading={controller.finishing}
                                  idle={controller.paced.idle}
                                  veil
                                />
                              )
                            }
                          />
                        </div>
                      </MarkdownSlotProvider>
                    </CardSlotLiveProvider>
                  </AnswerOutline>

                  {controller.stoppedMarker}
                  {/* What arrives below the prose: never before it, since an answer
              that opens with three diagrams has pushed itself below the fold. */}
                  {controller.lateBlocks}
                </div>

                {/* Provenance footer — ONE tinted zone under the body's hairline that
            holds the sources block, the copy actions, the memory chip, and a
            single disclosure for everything else (confidence, skills used,
            verification notes, feedback, timestamp). The sources row must not
            draw its own divider here (the body hairline already separates), so
            it takes withDivider={false}. */}
                {/* Hidden while the answer arrives and faded in at the settle.
                Shown, it moved down a line with every line the prose grew
                while it was in view: most of the turn's layout shift (0.18 of
                the 0.20 on the desktop harness). Hidden content does not
                shift, and nothing in it was operable before the settle anyway
                (the actions and feedback are `pending`). Its room is kept
                only below the viewport (`footerReserved`); otherwise it opens
                at the settle. The body's hairline is the footer's top border,
                so a closed footer leaves no second line along the shell's
                own bottom edge. */}
                <HeightExpand
                  open={!controller.live || controller.footerReserved}
                  instant={controller.live}
                >
                  <div
                    className={cn(
                      'duration-base flex flex-col gap-2.5 border-t px-4 pt-3 pb-[14px] transition-opacity ease-out motion-reduce:transition-none sm:px-[22px]',
                      controller.live && controller.mountedLive && 'invisible opacity-0'
                    )}
                    data-testid="answer-footer"
                  >
                    <LookupFoundNothingNote show={controller.lookupFoundNothing === true} />
                    <AnswerSourcesRow
                      documents={controller.documents}
                      anchorPrefix={controller.anchorPrefix}
                      routingDecision={controller.routingDecision}
                      isStreaming={controller.live || controller.cutShort}
                      withDivider={false}
                    />
                    {controller.reserveMetaRow && (
                      <div
                        className={
                          controller.hasMetaRow
                            ? 'flex min-h-6 flex-wrap items-center gap-2'
                            : 'min-h-6'
                        }
                        aria-hidden={controller.hasMetaRow ? undefined : true}
                      >
                        {/* Copy the answer out — markdown, with or without its sources
                    written out. Before the disclosure: "take this with you" is
                    what the reader wants first; the details are the afterthought.
                    `compact` feedback: the thumbs stay on this line and their
                    disclosure takes the next one full-width. */}
                        {controller.hasDetailsContent ? (
                          <AnswerDetails
                            conversationId={controller.conversationId}
                            messageId={controller.messageId}
                            hasConfidence={controller.hasConfidence}
                            answerConfidence={controller.answerConfidence}
                            answerConfidenceCappedReason={controller.answerConfidenceCappedReason}
                            answerConfidenceReason={controller.answerConfidenceReason}
                            confidenceCheck={controller.confidenceCheck}
                            answerConfidenceVersion={controller.answerConfidenceVersion}
                            skillsActivated={controller.skillsActivated}
                            skillsHidden={controller.skillsHidden}
                            showReasoning={controller.showReasoning}
                            researchTruncated={controller.researchTruncated}
                            truncationReason={controller.truncationReason}
                            degradedReasons={controller.degradedReasons}
                            citationsRemoved={controller.citationsRemoved}
                            readSources={controller.readSources}
                            hasAnswerSources={controller.hasAnswerSources}
                            timestamp={controller.timestamp}
                            answerDurationMs={controller.answerDurationMs}
                            before={controller.answerActions}
                            beside={controller.memoryChip}
                            after={controller.feedback}
                          />
                        ) : (
                          <>
                            {controller.answerActions}
                            {controller.memoryChip}
                            {controller.hasMetaRow && (
                              <span className="flex-1" aria-hidden="true" />
                            )}
                            {controller.feedback}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </HeightExpand>
                {/* The elevation again, OVER the content: in dark mode it carries
                an inset top highlight, and the full-bleed body painted over the
                shell's own. Its outer shadow is clipped here; the shell's stands. */}
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 rounded-[inherit] shadow-sm"
                />
              </div>
            </article>
          </AnswerCitations>
        </NestedMarkdownPluginsProvider>
      </DiagramFilingProvider>
    </AnswerDataProvider>
  )
}

/**
 * Memoized so only the streaming answer bubble re-renders as tokens arrive
 * (its `content`/`isStreaming` change); every completed answer above it stays
 * put. React.memo's default shallow prop compare is sufficient here — the
 * props are primitives plus stable store-derived arrays/objects.
 */
export const AgentResponse = memo(AgentResponseComponent)

AgentResponse.displayName = 'AgentResponse'
