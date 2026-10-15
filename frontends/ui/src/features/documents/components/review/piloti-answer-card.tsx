'use client'

import { useState, type JSX } from 'react'
import Link from 'next/link'
import { MessageSquareShare, RotateCcw, Square, StickyNote, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { FieldError } from '@/components/ui/field'
import { PilotiGlyph } from '@/components/ui/piloti-glyph'
import { ShimmerText } from '@/components/ui/shimmer-text'
import { liveLine } from '@/features/chat/lib/turn-events'
import { useTranslations } from '@/i18n'
import { MAX_ANNOTATION_BODY } from '@/lib/annotations/types'
import { stripDirectives } from '@/lib/text/answer-directives'
import { MarkdownRenderer } from '@/shared/components/MarkdownRenderer'
import { CANVAS_ASK_INTENTS, stepsOf, type CanvasAsk, type CanvasAskIntent } from '../../hooks/use-canvas-ask'
import type { DocumentReview } from '../../hooks/use-document-review'
import { Composer, ReviewCard } from './thread-card'

/** A card's place in the answer (`[[card:N]]`): the canvas draws no cards, the chat does. */
const CARD_MARKER = /[ \t]*\[\[card:[0-9]+\]\][ \t]*\n?/g

/** The answer as the card shows it. */
export const answerMarkdown = (text: string): string => text.replace(CARD_MARKER, '').trim()

/**
 * Markdown's inline marks taken off, for a thread, which shows plain text: the
 * words stay, the asterisks, hashes and link targets go. Lists, tables and
 * line breaks stay as written; they read as text.
 */
const unmarked = (markdown: string): string =>
  markdown
    .replace(/^#{1,6}[ \t]+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])/g, '$1')
    .replace(/`([^`]+)`/g, '$1')

/** The answer as an Anmerkung's body: plain, and within the column's bound. */
export function answerAsBody(text: string): string {
  const plain = unmarked(stripDirectives(answerMarkdown(text))).trim()
  return plain.length <= MAX_ANNOTATION_BODY ? plain : `${plain.slice(0, MAX_ANNOTATION_BODY - 1).trimEnd()}…`
}

/** What a quick action makes of an answer taken over: a Rückfrage stays one, the rest is a Hinweis. */
const kindFor = (intent: CanvasAskIntent | null) => (intent === 'question' ? 'question' : 'hint')

/**
 * Piloti's card beside a box on the page: the question being put, Piloti at
 * work on it (its own steps, live), and its answer, with the ways to keep it.
 * While Piloti works, the card takes a note for the running turn („Piloti
 * lenken“): it is read before Piloti's next step, and listed under the
 * question with whether it has been taken up yet.
 * The frame is the thread card's; what Piloti does on the pages meanwhile
 * (its pointer, what it highlights) is drawn by the page layer from the room.
 */
export function PilotiAnswerCard({
  review,
  ask,
  flip,
}: {
  review: DocumentReview
  ask: CanvasAsk
  flip: boolean
}): JSX.Element {
  const t = useTranslations('files')
  const tChat = useTranslations('chat')
  const { piloti } = review
  const [adopting, setAdopting] = useState(false)
  const [adoptFailed, setAdoptFailed] = useState(false)
  const view = ask.view
  const text = view ? answerMarkdown(view.text) : ''
  const working = ask.status === 'thinking'
  const line =
    liveLine(stepsOf(view), tChat) ?? (ask.region ? t('review.piloti.thinking') : t('review.piloti.thinkingDocument'))
  const notes = Object.entries(view?.steers ?? {})

  const send = (question: string, intent: CanvasAskIntent | null = null) =>
    piloti.ask({ id: ask.id, text: question, region: ask.region, annotationId: ask.annotationId, intent })

  const adopt = async () => {
    if (!ask.region || !view) return
    setAdopting(true)
    setAdoptFailed(false)
    try {
      const body = answerAsBody(view.text)
      if (ask.annotationId) {
        await review.reply(ask.annotationId, body)
        piloti.dismiss(ask.id)
        review.select(ask.annotationId)
      } else {
        await review.create({ kind: kindFor(ask.intent), body }, { ...ask.region, shape: 'region' })
        piloti.dismiss(ask.id)
      }
    } catch {
      setAdoptFailed(true)
    } finally {
      setAdopting(false)
    }
  }

  return (
    <ReviewCard flip={flip} testId="piloti-card">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <PilotiGlyph working={working} />
        <span className="text-foreground text-xs font-semibold">Piloti</span>
        {ask.region && (
          <span className="text-muted-foreground text-[11px]">{t('review.piloti.regionLabel', { page: ask.region.page })}</span>
        )}
        <span className="ml-auto flex items-center">
          {working && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 [&_svg]:size-3"
              aria-label={t('review.piloti.stop')}
              title={t('review.piloti.stop')}
              data-testid="piloti-card-stop"
              onClick={() => piloti.dismiss(ask.id)}
            >
              <Square aria-hidden className="fill-current" />
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 [&_svg]:size-3.5"
            aria-label={t('review.piloti.close')}
            data-testid="piloti-card-close"
            onClick={() => (working ? piloti.open(null) : piloti.dismiss(ask.id))}
          >
            <X aria-hidden />
          </Button>
        </span>
      </div>

      {ask.status === 'composing' ? (
        <div className="space-y-2.5 p-3" data-testid="piloti-composer">
          <Composer
            autoFocus
            testId="piloti-question"
            placeholder={t('review.piloti.placeholder')}
            submitLabel={t('review.piloti.send')}
            onEscape={() => piloti.dismiss(ask.id)}
            onSubmit={async (question) => void send(question.trim())}
          />
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('review.piloti.quickLabel')}>
            {CANVAS_ASK_INTENTS.map((intent) => (
              <Chip key={intent} asChild interactive variant="outline" size="md">
                <button
                  type="button"
                  data-testid={`piloti-quick-${intent}`}
                  disabled={piloti.busy}
                  onClick={() => void send(t(`review.piloti.quickPrompts.${intent}`), intent)}
                >
                  {t(`review.piloti.quick.${intent}`)}
                </button>
              </Chip>
            ))}
          </div>
          {piloti.busy && <p className="text-muted-foreground text-[11px] leading-4">{t('review.piloti.busySteer')}</p>}
        </div>
      ) : (
        <>
          <div className="max-h-[min(24rem,55svh)] space-y-2.5 overflow-y-auto px-3 py-3">
            <p className="text-muted-foreground border-l-foreground/20 border-l-2 pl-2 text-xs leading-5 break-words">
              {ask.question}
            </p>
            {notes.length > 0 && (
              <ul className="space-y-1" aria-label={t('review.piloti.steerNotes')} data-testid="piloti-card-notes">
                {notes.map(([steerId, note]) => (
                  <li key={steerId} className="text-muted-foreground text-xs leading-5 break-words">
                    <Chip size="sm" variant="outline" className="mr-1.5 align-middle">
                      {note.round === undefined
                        ? t('review.piloti.steerWaiting')
                        : t('review.piloti.steerApplied', { round: note.round })}
                    </Chip>
                    {note.text}
                  </li>
                ))}
              </ul>
            )}
            {working && (
              <div role="status" aria-live="polite" data-testid="piloti-card-thinking">
                <ShimmerText className="text-xs">{line}</ShimmerText>
              </div>
            )}
            {text && (
              <div data-testid="piloti-card-answer" className="text-[13px]">
                <MarkdownRenderer content={text} isStreaming={Boolean(view?.streaming)} compact />
              </div>
            )}
            {working && (
              <Composer
                testId="piloti-steer"
                placeholder={t('review.piloti.steerPlaceholder')}
                submitLabel={t('review.piloti.steerSend')}
                onSubmit={async (note) => {
                  if (!piloti.steer(note, ask.region)) throw new Error('Piloti takes no note right now')
                }}
              />
            )}
            {view?.interaction && (
              <p className="text-muted-foreground text-xs leading-5">{t('review.piloti.needsInput')}</p>
            )}
            {ask.status === 'failed' && (
              <FieldError>{ask.error === 'busy' ? t('review.piloti.busy') : t('review.piloti.failed')}</FieldError>
            )}
            {view && view.sources.length > 0 && !working && (
              <ol className="text-muted-foreground space-y-0.5 text-[11px] leading-4" aria-label={t('review.piloti.sources')}>
                {view.sources.slice(0, 4).map((source, index) => (
                  <li key={`${source.number ?? index}:${source.file_name ?? ''}`} className="truncate">
                    [{source.number ?? index + 1}] {source.file_name ?? t('review.piloti.source')}
                    {source.page ? ` · ${t('review.page', { page: source.page })}` : ''}
                  </li>
                ))}
              </ol>
            )}
          </div>
          {!working && (
            <div className="flex flex-wrap items-center gap-1.5 border-t px-3 py-2.5">
              {ask.status === 'failed' ? (
                <Button type="button" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => piloti.retry(ask.id)}>
                  <RotateCcw className="size-3" aria-hidden />
                  {t('review.piloti.retry')}
                </Button>
              ) : (
                review.canAnnotate &&
                text && (
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 gap-1.5 text-xs"
                    disabled={adopting}
                    data-testid="piloti-card-adopt"
                    onClick={() => void adopt()}
                  >
                    <StickyNote className="size-3" aria-hidden />
                    {ask.annotationId ? t('review.piloti.adoptReply') : t('review.piloti.adopt')}
                  </Button>
                )
              )}
              {piloti.conversationHref && (
                <Button asChild type="button" variant="ghost" size="sm" className="h-7 gap-1.5 text-xs">
                  <Link href={piloti.conversationHref} data-testid="piloti-card-chat">
                    <MessageSquareShare className="size-3" aria-hidden />
                    {t('review.piloti.continueInChat')}
                  </Link>
                </Button>
              )}
              {adoptFailed && <FieldError className="w-full">{t('review.actionFailed')}</FieldError>}
            </div>
          )}
        </>
      )}
    </ReviewCard>
  )
}
