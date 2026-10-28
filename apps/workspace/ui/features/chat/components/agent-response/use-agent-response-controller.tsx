import type { AgentResponseProps } from './agent-response-props'
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { animate } from 'motion/react'
import {
  AnimatePresence,
  motion,
  motionBase,
  motionInstant,
  motionQuick,
  motionQuickExit,
  useMotionToken,
} from '@/components/motion'
import { HeightArrival } from '@/components/motion/height-arrival'
import { cn } from '@/lib/utils'
import type { PluggableList } from 'unified'
import { useTranslations } from '@/i18n'
import { chatCopy } from '@/i18n/namespaces/chat'

import { remarkCitationMarkers } from '@/features/layout/lib/citation-markers'
import { remarkFileReferences } from '@/features/layout/lib/file-reference-markers'
import { AnswerCardItem } from '@/features/grid-cards/components/AnswerCards'
import { useDecidedProposals } from '@/features/grid-cards/decided-proposals'
import {
  CALLOUT_SLOT_INDEX,
  hasPlacedCalloutMarker,
  remarkCardMarkers,
  unplacedCardIndices,
} from '@/features/grid-cards/card-markers'

import { useChatStore } from '../../store'
import { registerShownText, useAnswerRevealStore } from '../../stores/answer-reveal-store'
import { useAnswerFileReferences } from '../../hooks/use-answer-file-references'

import { usePacedText } from '../../hooks/use-paced-text'
import {
  answerDocuments,
  answerSourceAnchorPrefix,
  buildCitationModel,
  proseLength,
  splitAnswerBody,
} from '../../lib/citations'

import { MemoryNotedChip } from '../MemoryNotedChip'
import { ViewerActionRow } from '../ViewerActionRow'
import { turnMemoryItems } from '../../lib/turn-memory'
import { answerMetaToAnatomy, summaryDuplicatesBody } from '../../lib/answer-meta-cards'
import { AnatomyBlock, AnatomyMasthead, mastheadShows } from '../AnswerAnatomy'

import { AnswerFeedback } from '../AnswerFeedback'
import { RetryThoroughButton } from '../RetryThoroughButton'
import { AnswerActions } from '../AnswerActions'
import { CardSlot, forgetArrivals } from '../CardSlotArrival'
import { projectKeysIn } from '@/lib/text/answer-directives'
import { type AnswerData } from '@/shared/components/MarkdownRenderer/answer-block-context'
import { AnswerProjectStrip } from '@/shared/components/MarkdownRenderer/project-binding'
import { useProjectFacts } from '../../hooks/use-project-facts'
import { isNotRegulated, searchedSources } from '../../lib/answer-data'

import { wireCitationNumbers, readSourceLabel } from './read-sources'

import { answerRoleTab, StreamingCaret } from './answer-role'
import { LEDE_CLASS, SUMMARY_GAP, NO_DOCUMENTS, opensWithProse } from './answer-prose'

export function useAgentResponseController({
  content,
  timestamp,
  answerDurationMs,
  variant = 'default',
  cards,
  citations,
  conversationId,
  cardInteractions,
  stages,
  answerMeta,
  findings,
  previousFindings,
  onCommissionFinding,
  answerConfidence,
  answerConfidenceCappedReason,
  answerConfidenceReason,
  confidenceCheck,
  answerConfidenceVersion,
  lookupFoundNothing,
  citationsRemoved,
  readSources,
  researchTruncated,
  truncationReason,
  degradedReasons,
  skillsActivated,
  skillsHidden,
  showReasoning = false,
  messageId,
  isStreaming = false,
  routingDecision,
  readOnly = false,
  retrievalLedger,
  quoteStamps,
  projectProfile,
  stopped = false,
  failed = false,
}: AgentResponseProps) {
  const t = useTranslations(chatCopy)
  const storeProjectId = useChatStore((s) => s.projectId)
  // A read-only answer is not the reader's: nothing in it may act on the
  // project the READER has open (ADR-0039 §5), and no card in it may record a
  // decision on the message (`useCardDecision` can decide whenever it has a
  // message id). Reading stays: a named file still links.
  const projectId = readOnly ? null : storeProjectId
  const cardMessageId = readOnly ? undefined : messageId
  // What the answer's blocks read from the record rather than the prose: the
  // project's values, where the turn searched, the server's quote checks.
  // „ergänzen" and „Als Aufgabe" only fill the composer, and not in somebody
  // else's turn (readOnly).
  const projectFacts = useProjectFacts(storeProjectId, projectProfile)
  const setComposerPrefill = useChatStore((s) => s.setComposerPrefill)
  const answerData = useMemo(
    (): AnswerData => ({
      project: projectFacts ?? undefined,
      prefill: readOnly ? undefined : setComposerPrefill,
      searched: searchedSources(retrievalLedger),
      quoteStamps,
      notRegulated: isNotRegulated(answerMeta),
    }),
    [projectFacts, readOnly, setComposerPrefill, retrievalLedger, quoteStamps, answerMeta]
  )
  // An answer that ends in a written "## Quellen" list used to state its sources
  // TWICE — that list AND the "Belegt durch" chips, each holding half the truth
  // (numbers/titles/pages vs. provenance color, authority and click-through).
  // Lift the list out of the body and hand its entries to AnswerSourcesRow,
  // which renders the one consolidated block; the inline [N] markers left in the
  // prose become links to its rows. Answers without such a section are untouched.
  const fallbackId = useId()
  const roleTabId = `${fallbackId}-role`
  const anchorPrefix = answerSourceAnchorPrefix(messageId ?? fallbackId)
  // The prose streams while the model writes it (ADR-0066), in bursts. It is
  // shown at a steady pace a beat behind what has arrived (`usePacedText`,
  // rules in `../lib/stream-pace.ts`), so it reads as being written rather
  // than lurching forward a sentence at a time. When the turn ends, the text
  // it held back is finished in a few hundred ms, and only then does the
  // answer settle. Everything that belongs to a WHOLE answer (the caret going,
  // the footer, citations turning real) follows `live`, not `isStreaming`, so
  // it all lands in the one frame the text is complete. The unplaced cards
  // may land earlier (`unplacedIsFinal`): a live frame carries cards only once
  // the prose is complete, so they wait only for the reveal to catch up.
  // Only the prose is paced: a written „## Quellen" section is lifted into the
  // source rows, never drawn as text, and pacing it held the settle back by
  // half a second after the last visible word. It joins the text once the
  // prose is all shown.
  const prose = useMemo(() => content.slice(0, proseLength(content)), [content])
  // Whether the reader is watching this answer arrive. Every entrance below is
  // gated on it: an answer restored on thread open, switch or reload is drawn
  // as it stands, with nothing arriving.
  const [mountedLive] = useState(isStreaming)
  // Whether prose has been on screen in this view (set below, once it is).
  const [wroteBefore, setWroteBefore] = useState(false)
  const anatomy = useMemo(() => answerMetaToAnatomy(answerMeta), [answerMeta])
  // A summary that restates the body's opening is the same statement twice,
  // so the masthead drops it (see `summaryDuplicatesBody`); the rules are
  // where `keptSummary` is written, below.
  const summary = anatomy?.summary
  const [keptSummary, setKeptSummary] = useState<string>()
  const summaryDuplicates = useMemo(
    () => Boolean(summary) && summaryDuplicatesBody(summary, prose),
    [summary, prose]
  )
  const effectiveSummary =
    summary && (summary === keptSummary || !summaryDuplicates) ? summary : undefined
  // The summary standfirst is WRITTEN, not faded in, when it leads an answer
  // the reader is watching begin: it arrives whole in the masthead event, and
  // a two-to-five-line paragraph appearing in one frame read as the answer's
  // first words popping in finished while the sentence under it was being
  // written (recording 2026-10). It is paced as the head of the prose, so one
  // reveal writes it and then the body, with one caret, in reading order.
  // Decided once, at the first summary: one that arrives after prose is on
  // screen fades in whole as before, since writing it in above text the
  // reader is on would move that text line by line.
  const [summaryWritten, setSummaryWritten] = useState<boolean | null>(null)
  if (summaryWritten === null && effectiveSummary)
    setSummaryWritten(mountedLive && isStreaming && !wroteBefore)
  const lead = summaryWritten && effectiveSummary ? `${effectiveSummary}${SUMMARY_GAP}` : ''
  // A failed turn freezes like a stopped one: what was shown is what stays.
  const paced = usePacedText(
    lead + prose,
    isStreaming,
    undefined,
    stopped || failed,
    messageId,
    lead.length
  )
  // The reveal split back into its two places: the summary's share for the
  // masthead, the rest for the body.
  const pacedProse = paced.text.slice(lead.length)
  const shownSummary = lead ? paced.text.slice(0, effectiveSummary?.length) : effectiveSummary
  const writingSummary = Boolean(lead) && !paced.settled && paced.text.length < lead.length
  // Ended under the reader before it was finished: by Stop, or by a failure.
  // Nothing the stream had not put on screen by then arrives afterwards (the
  // takeaways, the unplaced cards, the „Ohne Quellenbeleg" row): what the
  // reader saw is what is kept. An answer restored later is drawn whole.
  const cutShort = (stopped || failed) && mountedLive
  const settled = paced.settled
  const shownContent = pacedProse.length >= prose.length ? content : pacedProse
  const live = !settled
  // What is on screen, for Stop to keep (`stopStreaming`): the text that had
  // arrived runs up to two seconds ahead of it.
  const shownContentRef = useRef(shownContent)
  useLayoutEffect(() => {
    if (!messageId || !live) return
    return registerShownText(messageId, () => shownContentRef.current)
  }, [messageId, live])

  // A retraction (`answer_retracted`): a tool round's preamble streamed, was
  // withdrawn, and the real answer follows. The content empties mid-stream,
  // and the card used to return nothing for it: it vanished in one frame, and
  // the next round's first word drew it again with a second entrance. Now the
  // frame stays. The words fade out (`motionQuickExit`), the body holds its
  // height with one quiet line in it („Antwort wird erstellt …"), and the
  // next round's first word, or the settle, releases the height on a glide.
  // Only for an answer the reader watched write something.
  // The answer's structured anatomy, rendered FLAT (`AnswerAnatomy.tsx`) as
  // answer typography: the verdict as the masthead above the prose, the
  // takeaways closing it, the callout beside the paragraph its `[[callout]]`
  // marker anchors it to — or after the prose when unanchored.
  // A streaming answer whose masthead arrived before its first word is not
  // empty: the masthead stands while the prose is still being written.
  const hasMasthead = Boolean(anatomy && (anatomy.verdict || anatomy.summary || anatomy.topic))
  const hasLiveMasthead = live && hasMasthead
  // Nor is one stopped (or failed) while its summary was being written: the
  // masthead is what the reader saw, and Stop keeps what was on screen. Read
  // as blank, the settle that follows the press dropped masthead and summary
  // in one frame, and the stored row (no text, a masthead) drew nothing after
  // a reload.
  const blank =
    (!content || !content.trim() || content === 'null') &&
    (cards?.length ?? 0) === 0 &&
    !(hasMasthead && (live || stopped || failed))
  if (mountedLive && live && !wroteBefore && shownContent.trim()) setWroteBefore(true)
  // Until the next round's first word is on screen, not merely arrived: the
  // pace shows it a frame or more later, and letting go at the arrival
  // dropped the held height for that gap.
  const retracted =
    mountedLive &&
    isStreaming &&
    wroteBefore &&
    (blank || (!shownContent.trim() && !hasLiveMasthead))
  // The words the retraction took, held on screen while they fade. Written
  // after every commit that showed words, read in the commit that lost them.
  const lastWords = useRef('')
  useLayoutEffect(() => {
    shownContentRef.current = shownContent
    if (shownContent.trim()) lastWords.current = shownContent
  })
  const [retractionFaded, setRetractionFaded] = useState(false)
  if (!retracted && retractionFaded) setRetractionFaded(false)
  const drawnContent = retracted ? (retractionFaded ? '' : lastWords.current) : shownContent
  // The finish: the stream is over, the rest of the text is being revealed.
  const finishing = live && !isStreaming
  // Outside the answer, the Herleitung's collapse waits for the same moment.
  const beginReveal = useAnswerRevealStore((s) => s.begin)
  const endReveal = useAnswerRevealStore((s) => s.end)
  useLayoutEffect(() => {
    if (!messageId || !live) return
    beginReveal(messageId)
    return () => endReveal(messageId)
  }, [messageId, live, beginReveal, endReveal])
  const {
    body,
    entries: sourceEntries,
    numbers: splitNumbers,
  } = useMemo(() => splitAnswerBody(drawnContent), [drawnContent])
  // The numbers keep one identity while they stay the same: the split makes a
  // new set for every reveal step, and a new set is a new plugin list, which
  // re-parses every block of the answer instead of the one that grew.
  // The numbers a `[N]` links to are the written „## Quellen" list's AND the
  // numbered wire sources'. The list alone was not enough: a stopped answer
  // keeps its resolved `[N]` and its sources but is cut before the list
  // (`stopped-answer.ts`), so its markers settled to plain „[1][2]…", wider
  // than the pills they had been; on a phone the line re-wrapped 26 px under
  // the reader just after Stop, and a reload showed bare brackets. A number the
  // scope cannot resolve still falls back (`CitationMarker`).
  const citationNumbersKey = [...new Set([...splitNumbers, ...wireCitationNumbers(citations)])]
    .sort((a, b) => a - b)
    .join(',')
  const citationNumbers = useMemo(
    (): ReadonlySet<number> =>
      new Set(citationNumbersKey ? citationNumbersKey.split(',').map(Number) : []),
    [citationNumbersKey]
  )

  // The markers are linked while the body is PARSED, not before: `[2][3]` — two
  // sources behind one claim, the shape the backend is told to write — is
  // indistinguishable from reference-link syntax in raw text, and used to reach
  // the reader as literal "[2][3]" beside neighbours that got their pill.
  //
  // Cards are placed the same way and for the same reason: the agent writes
  // `[[card:2]]` on a line of its own, and the card is spliced in there rather
  // than stacked above the answer it is supposed to illustrate.
  const cardCount = cards?.length ?? 0
  // A summary that restates the body's opening is the same statement twice,
  // so the masthead drops it (see `summaryDuplicatesBody`). Judged against
  // everything that has ARRIVED (`prose`), not the paced body, and never
  // taken back once shown: judged on the paced body it vanished from above
  // the prose the moment the reveal completed the first sentence, pulling
  // everything the reader was on up by its height. A summary that has been
  // on screen in this view stays for it (`keptSummary`); a duplicate that
  // arrives after the prose has opened is caught before it is ever shown.
  // The lede gate reads the result: a hidden summary hands the emphasis back
  // to the first paragraph instead of leaving the answer with none.
  // Derived state, set during render: the next render (before paint) holds it.
  if (!retracted && effectiveSummary && effectiveSummary !== keptSummary)
    setKeptSummary(effectiveSummary)
  // The Projektbezug strip: the project facts the answer binds, drawn from the
  // profile under the masthead, only where the answer binds one. Read off what
  // has arrived, so it is there from the first frame its keys exist. It stands
  // ABOVE the prose only when the answer already bound a fact as it mounted (a
  // stored answer, a reload); one that binds its first fact while the reader
  // is reading gets it BELOW the prose instead, where it moves nothing they
  // have read. The next view puts it back on top.
  const stripKeys = useMemo(
    () => (prose.includes(':project[') ? projectKeysIn(prose) : []),
    [prose]
  )
  const [stripAbove] = useState(() => prose.includes(':project['))
  // The lede, decided ONCE from what is known at the answer's first words:
  // its kind (a note is never a lede), whether it opens with prose, and
  // whether the masthead already carries a summary or a topic (the
  // standfirst holds that emphasis, and a 17px masthead line over a 17px
  // first paragraph would be the same statement twice). It used to be
  // decided on the paced body behind a 600-character gate, so the first
  // paragraph the reader was on restyled from 16 to 17px mid-stream. There is
  // no length gate any more, because length is the one thing not known at the
  // first word; a settled answer runs the same predicate, so a stored answer
  // looks as it did live. Not eased: font size is a layout property, and the
  // motion vocabulary animates none (`grid/motion-vocabulary`).
  const roleTab = answerRoleTab(answerMeta?.kind, routingDecision, Boolean(answerMeta?.verdict))
  const opener = opensWithProse(prose, !isStreaming)
  const ledeNow = opener === true && roleTab !== 'note' && !effectiveSummary && !anatomy?.topic
  const [frozenLede, setFrozenLede] = useState<boolean | null>(null)
  if (mountedLive && !retracted && frozenLede === null && opener !== null) setFrozenLede(ledeNow)
  // Retracted words decided nothing: once they have faded, the answer that
  // follows decides the lede and the kept summary afresh, from its own first
  // words. Not before: the fading words keep the size they were shown at.
  if (
    retracted &&
    retractionFaded &&
    (frozenLede !== null || keptSummary !== undefined || summaryWritten !== null)
  ) {
    setFrozenLede(null)
    setSummaryWritten(null)
    setKeptSummary(undefined)
  }
  const ledeClass = (mountedLive ? frozenLede === true : ledeNow) ? LEDE_CLASS : ''
  // The files this answer NAMES, as opposed to the ones it cites. A sentence
  // like „Beginnen Sie mit pd8280-2.pdf" is pointing at a document the reader
  // owns, and until the index below resolved that name it was dead text. The
  // hook is inert for an answer with no filename in it, which is most of them.
  const fileReferences = useAnswerFileReferences({
    body,
    projectId: storeProjectId,
    // The conversation whose private attachments a named file may live in.
    conversationId: conversationId ?? null,
  })
  // A new list re-parses every block of the answer, so it is rebuilt only when
  // what the plugins read changes: a boolean for the callout, not the anatomy.
  const hasCallout = Boolean(anatomy?.callout)
  //
  // `pending: true` on both passes, live or not, so the list does NOT change
  // when the answer settles: a new list re-parses the whole answer, and the
  // settle frame is already the most expensive one the answer has (it starved
  // every animation that ran in it). Whether a marker with nothing behind it
  // yet is pending or nothing is decided where it renders, from
  // `CardSlotLiveProvider`: `CitationMarker` draws a pending pill while live
  // and the plain „[N]" once settled; `CardSlot` holds the place while live
  // and folds it away once settled.
  const markerPlugins = useMemo(
    (): PluggableList => [
      // While it streams, a marker with no source yet is a pending pill, not
      // a stray "[2]": the settled text names its source within seconds.
      [remarkCitationMarkers, { numbers: citationNumbers, anchorPrefix, pending: true }],
      // A card marker holds its card's place until the card, written after
      // the prose, arrives to fill it. Pending, the count is not read.
      [remarkCardMarkers, { count: 0, callout: hasCallout, pending: true }],
      // AFTER the citation pass, so a filename that happens to sit inside a
      // marker's label is left alone: the pass skips `link` subtrees, and by
      // this point every `[N]` already is one.
      [remarkFileReferences, { fileNames: fileReferences.fileNames }],
    ],
    [citationNumbers, anchorPrefix, hasCallout, fileReferences.fileNames]
  )
  // What a run of Markdown INSIDE a card (a tab's `Text`) parses with: the
  // citations only. Its `[2]` is this answer's source 2; card markers are not
  // slots there.
  const nestedPlugins = useMemo(
    (): PluggableList => [[remarkCitationMarkers, { numbers: citationNumbers, anchorPrefix }]],
    [citationNumbers, anchorPrefix]
  )
  // The cards the prose did NOT claim. Read off the same body the renderer
  // parses, because the block below has to be built before that parse happens.
  const fallbackCardIndices = useMemo(() => unplacedCardIndices(body, cardCount), [body, cardCount])
  // Whether "unplaced" is final, so the cards no marker claimed may be drawn.
  // A live frame carries cards only once the envelope's `answer` string has
  // closed (the backend reads them after it, ADR-0066), so a streaming answer
  // that holds cards has all of its prose; once the pace has shown all of it,
  // no marker is still to come. Waiting for the terminal instead held every
  // unplaced card back until verification and the pipeline were done: 22 s
  // after the card was written on the recorded `oib2` turn.
  const unplacedIsFinal = !live || ((cards?.length ?? 0) > 0 && shownContent === content)
  // Whether the unplaced cards were drawn while the answer was live: an answer
  // cut short keeps them only then (`cutShort`).
  const [unplacedDrawnLive, setUnplacedDrawnLive] = useState(false)
  if (live && unplacedIsFinal && !unplacedDrawnLive) setUnplacedDrawnLive(true)
  const drawUnplaced = unplacedIsFinal && (!cutShort || unplacedDrawnLive)
  // The after-prose anatomy: the callout leaves this block the moment the
  // prose claims it with a marker — same pre-render reading as the card
  // fallback above, and for the same reason.
  const anatomyBelow = useMemo(() => {
    if (!anatomy) return []
    if (anatomy.callout && hasPlacedCalloutMarker(body)) {
      return anatomy.below.filter((card) => card.type !== 'callout')
    }
    return anatomy.below
  }, [anatomy, body])
  // Citation chips ("Belegt durch") always wear their lane tints: lane tint
  // is provenance (where it stands), not decoration — washes/alarms spend the
  // hue budget elsewhere, never by muting the source signal. Grey chips read
  // as broken, so there is no muted variant and no spend counting here.
  // What a `[[card:N]]` marker in the prose draws. A card the answer has not
  // reached yet (N past the end of `cards`) holds a place while the answer
  // streams, since the cards are written after the prose, and nothing once it
  // is done (`CardSlot` reads which from `CardSlotLiveProvider`, so this
  // renderer keeps its identity when the answer settles and no card re-renders
  // for it). A hole INSIDE `cards` (a card the validator refused, or one an
  // observer may not see) is never coming, so it draws nothing at any time:
  // a hole is better than a crash, a raw `[[card:2]]` or a skeleton forever.
  const arrivalPrefix = messageId ?? fallbackId
  const renderCardSlot = useCallback(
    (index: number) => {
      // The callout's slot: the one anatomy block the prose may anchor.
      if (index === CALLOUT_SLOT_INDEX) {
        if (!anatomy?.callout) return null
        return (
          <div className="mb-3">
            <AnatomyBlock card={anatomy.callout} />
          </div>
        )
      }
      const card = cards?.[index]
      const arrivalKey = `${arrivalPrefix}:${index}`
      // Still arriving: the card is written after the prose, so its marker
      // holds the place it will arrive into rather than nothing (ADR-0066).
      // A hole is a card that will never come: a place it held folds away.
      if (!card) return <CardSlot arrivalKey={arrivalKey} refused={index < (cards?.length ?? 0)} />
      return (
        <CardSlot arrivalKey={arrivalKey}>
          <AnswerCardItem
            card={card}
            index={index}
            projectId={projectId}
            messageId={cardMessageId}
            decisionsMustPersist={readOnly}
          />
        </CardSlot>
      )
    },
    [cards, projectId, cardMessageId, anatomy?.callout, arrivalPrefix, readOnly]
  )
  // A retracted round's cards are gone, and the next round writes its own at
  // the same indices: they arrive in front of the reader as new cards.
  useLayoutEffect(() => {
    if (retracted && retractionFaded) forgetArrivals(arrivalPrefix)
  }, [retracted, retractionFaded, arrivalPrefix])
  // ONE derivation for the whole answer: the inline `[N]` markers in the prose
  // and the provenance chips below are the same citations seen twice, and two
  // derivations of one citation is exactly the defect the model removes.
  const documents = useMemo(
    () => buildCitationModel({ citations, entries: sourceEntries }),
    [citations, sourceEntries]
  )
  // The SAME predicate the sources row uses to decide between chips and the
  // "Ohne Quellenbeleg" gap row — so the truncation line never promises
  // "the evidence gathered up to that point" beside a row saying there is none.
  const hasAnswerSources = useMemo(() => answerDocuments(documents).length > 0, [documents])

  // Computed here, not inside MemoryNotedChip: the merged footer's meta row only
  // renders when it has something to hold, and "Piloti noted N" is one of those
  // things — a memory-only turn (both chip flags off, no timestamp) must still
  // show it rather than have the row unmount around it.
  //
  // Read off THIS MESSAGE. It used to be `useConversationMemory(projectId,
  // conversationId)`, a three-shot poll of the project's memory endpoint fired
  // by every rendered answer: thirty GETs in a ten-answer thread, on a fixed
  // `[0, 1500, 4000]` ms schedule that was a guess about how long an LLM takes,
  // and scoped to the CONVERSATION, so every answer in the thread showed every
  // item — turn one's answer read „Piloti hat sich 5 gemerkt" after turn five.
  // The reflection stage now delivers a frame addressed to the turn it belongs
  // to, so the chip can finally be what it always claimed to be.
  // A memory card with a `proposal_id` is decided on the server and writes no
  // `cardInteractions`: its receipt tells the tab how it ended.
  const decidedProposals = useDecidedProposals((state) => state.byId)
  const memoryItems = useMemo(
    () => turnMemoryItems({ stages, cards, cardInteractions, decidedProposals }),
    [stages, cards, cardInteractions, decidedProposals]
  )

  // What the merged footer's meta row would actually hold. The chip renders
  // nothing without a level, and the feedback row needs a `messageId` — gating
  // the row on anything less let it mount as an empty band (bare spacer + its
  // own gap) on a meta turn that has neither.
  const hasConfidence =
    ['low', 'medium', 'high'].includes(answerConfidence ?? '') ||
    confidenceCheck?.status === 'unavailable'
  // Rating somebody else's answer is not the reader's to do (readOnly).
  const hasFeedback = !readOnly && Boolean(messageId)
  // The copy actions. A still-arriving answer cannot be copied — half a
  // Prüfvermerk is worse than none — and a cards-only turn has no markdown to
  // hand over, so it gets no button that copies ''. While the answer arrives
  // the actions are THERE but invisible and inert (`pending`): inserted at the
  // settle, they widened the row, and on a phone wrapped it onto a second
  // line, under a reader who had just finished the last sentence.
  const hasAnswerActions =
    !readOnly && (live || (Boolean(content) && content.trim().length > 0 && content !== 'null'))
  const hasMetaRow =
    hasConfidence || hasFeedback || hasAnswerActions || Boolean(timestamp) || memoryItems.length > 0
  // The row is reserved at chip height while the answer arrives, so the
  // footer does not jump when what it holds becomes operable. An idle answer
  // with nothing to hold still omits the row (no empty band).
  const reserveMetaRow = hasMetaRow || live
  // What the single footer disclosure would actually hold. The copy actions
  // and the feedback stay visible beside its trigger, so a bare answer shows
  // the action and no empty trigger line. Read sources count only when at
  // least one entry is renderable (same `readSourceLabel` filter as the
  // section itself): unrenderable entries alone must not mount a trigger
  // that opens onto an empty section.
  const hasRenderableReadSources = (readSources ?? []).some(
    (source) => readSourceLabel(source) !== undefined
  )
  const hasDetailsContent =
    hasConfidence ||
    Boolean(timestamp) ||
    Boolean(answerDurationMs) ||
    (skillsActivated?.length ?? 0) > 0 ||
    Boolean(researchTruncated) ||
    (degradedReasons?.length ?? 0) > 0 ||
    (citationsRemoved?.count ?? 0) > 0 ||
    hasRenderableReadSources

  /**
   * Where a diagram inside this answer may be filed — or nothing at all.
   *
   * Both halves are required and neither can be invented. Without a `projectId`
   * there is no project to file into (a chat outside a project is a normal
   * state, not a broken one), and without a `messageId` there is no stable
   * identity for the diagram, so filing could not be idempotent and pressing
   * the button twice would file two indistinguishable copies. In either case the
   * diagram renders with no filing affordance rather than a disabled one — the
   * rule the research banner already follows for its `filed` object: a dead
   * action is worse than silence.
   */
  const diagramFilingTarget = useMemo(
    () =>
      projectId && messageId
        ? { projectId, answerId: messageId, ...(conversationId ? { conversationId } : {}) }
        : null,
    [projectId, messageId, conversationId]
  )

  // Memoised elements: the footer's `AnswerDetails` is memoised, and a new
  // element on every reveal tick re-rendered it and the feedback buttons with
  // it, about 3 ms of each 16 ms tick on a 4× throttled phone (React
  // performance audit, 2026-09).
  //
  // While live the actions hold their width with nothing to copy: their shape
  // does not depend on the text (one copy button either way, the export by
  // ids), and feeding them every reveal step re-rendered them per word.
  // A failed answer keeps them so too: a cut-off fragment is not an answer to
  // copy or rate, and the reserved row stays as it was.
  const inert = live || failed
  const actionsContent = inert ? '' : content
  const actionsBody = inert ? '' : body
  const actionsDocuments = inert ? NO_DOCUMENTS : documents
  const answerActions = useMemo(
    () =>
      hasAnswerActions ? (
        <AnswerActions
          content={actionsContent}
          body={actionsBody}
          documents={actionsDocuments}
          conversationId={conversationId}
          messageId={messageId}
          pending={inert}
        />
      ) : null,
    [
      hasAnswerActions,
      actionsContent,
      actionsBody,
      actionsDocuments,
      conversationId,
      messageId,
      inert,
    ]
  )
  // On the meta row itself, never behind „Details": a write to the project's
  // memory changes what every later answer starts from, so the reader is told
  // on the answer, in one glance, and opens what it was in one tap. Always
  // rendered (it draws nothing for a turn that recorded nothing) so it knows
  // whether its items arrived in front of the reader or were there at mount.
  const memoryChip = useMemo(() => <MemoryNotedChip items={memoryItems} />, [memoryItems])
  const feedback = useMemo(
    () =>
      hasFeedback && messageId ? (
        <>
          {!inert && <RetryThoroughButton messageId={messageId} conversationId={conversationId} />}
          <AnswerFeedback
            compact
            pending={inert}
            messageId={messageId}
            conversationId={conversationId}
          />
        </>
      ) : null,
    [hasFeedback, messageId, conversationId, inert]
  )

  // A terminal that does not continue what is shown (a settled snapshot that
  // rewrites or shortens the text) replaces the body in one frame; tables and
  // diagrams the reader was looking at vanished with no transition at all.
  // The new body fades in instead, on the same element: nothing remounts, so
  // the Markdown tree is not rebuilt for it.
  //
  // The body's frame does not drop to the new height in that frame either:
  // the verified text is often much shorter (the recorded `oib2` terminal is
  // 541 characters against 1,724 streamed), and everything under the body,
  // the footer and the next turn, jumped up by the difference. The frame
  // keeps its old height as a minimum and lets go of it on a glide
  // (`glideFrameDown`), as it does after a retraction.
  const proseRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const heightRelease = useMotionToken(motionBase)
  // The frame's height before a change: a `ResizeObserver` reports after
  // layout effects, so in the commit that changes the body it still holds the
  // height the reader saw.
  const frameHeight = useRef<number | null>(null)
  useLayoutEffect(() => {
    const frame = frameRef.current
    if (!mountedLive || !frame || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (!frame.style.minHeight) frameHeight.current = frame.offsetHeight
    })
    observer.observe(frame)
    return () => observer.disconnect()
  }, [mountedLive])
  // The footer's room while the answer arrives. Reserved (invisible) so the
  // settle does not push what lies under the card, but only once the body
  // reaches below the viewport: reserved from the first frame, it drew the
  // card's first words over a 116px empty band of shell (phone recording,
  // 2026-10), the card tall and empty before the prose had filled it. Below
  // the viewport the room is never seen. An answer that ends shorter than
  // the viewport has the footer open at the settle instead, below the last
  // line, where nothing the reader is on moves. One-way: once reserved, kept.
  const [footerReserved, setFooterReserved] = useState(!mountedLive)
  useLayoutEffect(() => {
    const frame = frameRef.current
    if (footerReserved || !live || !frame || typeof ResizeObserver === 'undefined') return
    const check = () => {
      if (frame.getBoundingClientRect().bottom > window.innerHeight) setFooterReserved(true)
    }
    check()
    const observer = new ResizeObserver(check)
    observer.observe(frame)
    return () => observer.disconnect()
  }, [footerReserved, live])
  // The release eases the held MINIMUM down rather than the height: words
  // that keep arriving grow the body while it runs, and a tweened height
  // would clip them and land short of where they had got to.
  const glideFrameDown = useCallback(
    (frame: HTMLElement, from: number): (() => void) | undefined => {
      frame.style.minHeight = ''
      const to = frame.offsetHeight
      const done = () => {
        frame.style.minHeight = ''
        frameHeight.current = frame.offsetHeight
      }
      if (to >= from - 1 || heightRelease === motionInstant) {
        done()
        return undefined
      }
      // Held before the first animation frame, so no frame paints the drop.
      frame.style.minHeight = `${from}px`
      const controls = animate(frame, { minHeight: [`${from}px`, `${to}px`] }, heightRelease)
      void controls.then(done)
      return () => {
        controls.stop()
        frame.style.minHeight = ''
      }
    },
    [heightRelease]
  )
  const previousBody = useRef(body)
  const bodyFade = useMotionToken(motionBase)
  // The fade outlives the commit that started it: the reveal goes on growing
  // the rewritten body, and every word re-runs the effect below. Stopping it
  // there froze the answer greyed out, because a stopped animation keeps the
  // value it reached (WAAPI commits it to the element). It is only ever
  // finished, by the next rewrite or by unmounting, and finishing is full ink.
  const bodyFadeControls = useRef<{ complete: () => void } | null>(null)
  useLayoutEffect(() => () => bodyFadeControls.current?.complete(), [])
  useLayoutEffect(() => {
    const previous = previousBody.current.trimEnd()
    previousBody.current = body
    // Not for a body that went blank: that is a retraction, faded below. Nor
    // for one frozen by Stop or a failure: the frozen text drops a citation
    // still pending at the press, so it is rarely a prefix of the last body,
    // and the whole answer blinked out and back as the button was pressed.
    if (stopped || failed) return
    if (!mountedLive || !previous || !body || body.startsWith(previous) || !proseRef.current) return
    bodyFadeControls.current?.complete()
    bodyFadeControls.current = animate(proseRef.current, { opacity: [0, 1] }, bodyFade)
    const frame = frameRef.current
    return frame && frameHeight.current !== null
      ? glideFrameDown(frame, frameHeight.current)
      : undefined
  }, [body, mountedLive, bodyFade, glideFrameDown, stopped, failed])

  // The retraction, on the elements that are already there (nothing remounts).
  // The words fade out on the exit curve, then give way to the quiet line;
  // the body's frame holds the height it had, so nothing below moves while
  // the answer has nothing to say, and lets go on a glide when it does.
  const retractionFade = useMotionToken(motionQuickExit)
  useLayoutEffect(() => {
    const frame = frameRef.current
    const prose = proseRef.current
    if (!retracted || !frame || !prose) return
    if (frameHeight.current !== null) frame.style.minHeight = `${frameHeight.current}px`
    if (retractionFaded) return
    const controls = animate(prose, { opacity: [1, 0] }, retractionFade)
    // Timed by the token rather than the animation's promise: a page that
    // gets no frames (hidden) must still reach the quiet line.
    const timer = window.setTimeout(
      () => setRetractionFaded(true),
      (retractionFade.duration ?? 0) * 1000
    )
    return () => {
      window.clearTimeout(timer)
      controls.stop()
      prose.style.opacity = ''
    }
  }, [retracted, retractionFaded, retractionFade])
  // The next round's first word, or the settle, lets go of the held height.
  useLayoutEffect(() => {
    const frame = frameRef.current
    if (retracted || !frame || !frame.style.minHeight) return
    return glideFrameDown(frame, frame.offsetHeight)
  }, [retracted, glideFrameDown])

  // The masthead. Part of the answer's own entrance when it mounts with it
  // (no second fade inside one); fading in alone when it arrives later; and,
  // gated out by a snapshot or the terminal, fading out BEFORE its height goes,
  // in one frame once it is invisible, rather than vanishing from above the
  // prose. Its confidence is the verdict's own, from the masthead event: the
  // turn's self-assessment arrives with the terminal and inserted a gauge row
  // and a reason paragraph above the prose the reader was on. That one lives
  // in the answer details.
  const mastheadExitToken = useMotionToken(motionQuickExit)
  const mastheadEnter = useMotionToken(motionQuick)
  const showMasthead =
    anatomy !== null &&
    mastheadShows({
      verdict: anatomy.verdict,
      summary: shownSummary,
      topic: anatomy.topic,
      kind: answerMeta?.kind,
    })
  const masthead = (
    <AnimatePresence initial={false}>
      {showMasthead && anatomy && (
        // eslint-disable-next-line grid/motion-vocabulary -- the fold after the fade: height goes in one frame (duration 0) once the masthead is invisible
        <motion.div
          key="masthead"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{
            opacity: 0,
            height: 0,
            transition: {
              opacity: mastheadExitToken,
              height: { duration: 0, delay: mastheadExitToken.duration ?? 0 },
            },
          }}
          transition={mastheadEnter}
        >
          <AnatomyMasthead
            verdict={anatomy.verdict}
            summary={shownSummary}
            topic={anatomy.topic}
            context={anatomy.context}
            kind={answerMeta?.kind}
            caret={
              writingSummary && <StreamingCaret idle={paced.idle} veil={variant !== 'inline'} />
            }
          />
        </motion.div>
      )}
    </AnimatePresence>
  )

  // What arrives BELOW the prose: a Projektbezug strip that turned up after the
  // answer began, the takeaways and unplaced callout, the cards no marker
  // claimed. Each takes its height smoothly (`HeightArrival`) instead of
  // shoving the footer down by all of it in one frame, and only when the
  // reader watches it arrive: `initial={false}` stands a stored answer's
  // blocks at once.
  //
  // The unplaced cards are withheld until "unplaced" is final
  // (`unplacedIsFinal`): it is read off the body SO FAR, and a card whose
  // `[[card:N]]` has not been shown yet would render here and then jump up the
  // answer. They arrive like a placed card (`CardSlot`: placeholder, then the
  // drawn card fading in over it), so a card looks the same arriving whether
  // or not the prose placed it. `mt-1` because the column's `gap-2` is 8px and
  // the markdown body's paragraph rhythm is 12px, so without it an UNPLACED
  // card hugged the prose 4px tighter than a placed one
  // (/dev/chat-turn?variant=two-cards).
  const lateBlocks = (
    <AnimatePresence initial={false}>
      {!stripAbove && stripKeys.length > 0 && (
        <HeightArrival key="project-strip">
          <AnswerProjectStrip keys={stripKeys} />
        </HeightArrival>
      )}
      {!live && !cutShort && anatomyBelow.length > 0 && (
        <HeightArrival key="anatomy-below" className="mt-1 gap-3">
          {anatomyBelow.map((card) => (
            <AnatomyBlock key={card.type} card={card} />
          ))}
        </HeightArrival>
      )}
      {drawUnplaced && cards && fallbackCardIndices.length > 0 && (
        <HeightArrival key="unplaced-cards" className="mt-1 [&>:last-child]:mb-0">
          {fallbackCardIndices.map((index) => {
            const card = cards[index]
            if (!card) return null
            return (
              <CardSlot key={index} arrivalKey={`${arrivalPrefix}:${index}`} arriving={mountedLive}>
                <AnswerCardItem
                  card={card}
                  index={index}
                  projectId={projectId}
                  messageId={cardMessageId}
                  decisionsMustPersist={readOnly}
                />
              </CardSlot>
            )
          })}
        </HeightArrival>
      )}
    </AnimatePresence>
  )

  // A failed answer dims to what it is, a fragment, on a transition rather
  // than in one frame; the error card under it says why.
  const dimmed = cn(
    'transition-opacity duration-base ease-out motion-reduce:transition-none',
    failed && 'opacity-60'
  )

  // Where the writing ended when the reader pressed Stop: one quiet word under
  // the last one shown, fading in on the press.
  const stoppedMarker =
    stopped && !live ? (
      <p
        className={cn(
          'text-muted-foreground text-xs',
          mountedLive && 'animate-in fade-in-0 duration-quick ease-out motion-reduce:animate-none'
        )}
        data-testid="answer-stopped"
      >
        {t('answerStoppedMarker')}
      </p>
    ) : null

  // Guard against null, undefined, empty, or literal "null" string content
  // when no cards are present. Cards can render even with empty text. A
  // retracted answer keeps its frame (above).

  // What Piloti showed the reader in their viewer during this answer (ADR-0144).
  // The reader's own answers only: a shared answer moved nobody's viewer here.
  const viewerActionRow = !readOnly && messageId ? <ViewerActionRow messageId={messageId} /> : null

  // While a retracted answer has nothing to show, one quiet line says the
  // answer is still coming, in the room the withdrawn words held.
  const retractionLine =
    retracted && retractionFaded ? (
      <motion.p
        className="text-muted-foreground text-sm"
        data-testid="answer-retracting"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={mastheadEnter}
      >
        {t('thinking.working')}
      </motion.p>
    ) : null

  // Inline variant - no box styling (for use inside containers like thinking process)

  // Default variant — the click-dummy "Ergebnis" card: a role tab over a
  // tinted shell whose white inner block carries the composed answer, then a
  // "Belegt durch" provenance row and the feedback row, hairline-separated.
  //
  // Envelope `kind` names the document. `direct` swaps the ink tab for a quiet
  // "Hinweis"; observed `meta` does the same when kind is absent and there is
  // no legacy verdict. `walkthrough` keeps the ink shell but labels the tab
  // "Antwort". `ruling`, a legacy no-kind verdict, and any other routing
  // (shallow/deep/error) keep "Ergebnis" (fail-open).
  const isNote = roleTab === 'note'
  const tabLabel =
    roleTab === 'note'
      ? t('roles.note')
      : roleTab === 'answer'
        ? t('roles.answer')
        : t('roles.result')

  return {
    hidden: blank && !retracted,
    timestamp,
    answerDurationMs,
    conversationId,
    findings,
    previousFindings,
    onCommissionFinding,
    answerConfidence,
    answerConfidenceCappedReason,
    answerConfidenceReason,
    confidenceCheck,
    answerConfidenceVersion,
    lookupFoundNothing,
    citationsRemoved,
    readSources,
    researchTruncated,
    truncationReason,
    degradedReasons,
    skillsActivated,
    skillsHidden,
    showReasoning,
    messageId,
    routingDecision,
    stopped,
    failed,
    answerData,
    roleTabId,
    anchorPrefix,
    mountedLive,
    paced,
    writingSummary,
    cutShort,
    live,
    retracted,
    finishing,
    body,
    stripKeys,
    stripAbove,
    ledeClass,
    fileReferences,
    markerPlugins,
    nestedPlugins,
    renderCardSlot,
    documents,
    hasAnswerSources,
    hasConfidence,
    hasMetaRow,
    reserveMetaRow,
    hasDetailsContent,
    diagramFilingTarget,
    answerActions,
    memoryChip,
    feedback,
    proseRef,
    frameRef,
    footerReserved,
    masthead,
    lateBlocks,
    dimmed,
    stoppedMarker,
    viewerActionRow,
    retractionLine,
    isNote,
    tabLabel,
    hasFeedback,
    inert,
    variant,
  }
}
