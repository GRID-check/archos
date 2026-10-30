'use client'

/**
 * The receipt of a Skizze edit Piloti proposed (`document-sketch-edit`, S4):
 * an ordinary `operation` proposal (ADR-0105) in the shared
 * {@link ProposalReceipt} frame, with what a person needs to decide a drawing
 * change instead of a list of JSON fields:
 *
 *   - the change drawn by the server on the Fassung it was made on
 *     (`/sketch/edits/preview`): new in green, removed dashed red, changed in
 *     blue over its dashed grey state before, with the legend in words;
 *   - the operations' intents as numbered steps;
 *   - once applied, „Rückgängig“: the Fassung before becomes current again,
 *     offered only while the edit's Fassung is still the current one.
 *
 * Lives with the receipts, not under `features/diagrams`: it is a proposal
 * card, and the diagrams feature already reaches the cards feature through
 * documents, so a receipt there would close a cycle. It talks to the sketch
 * routes through their typed client (`lib/diagrams/sketch-edit-client`).
 */

import { useEffect, useMemo, useState } from 'react'
import { PenLine } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SectionLabel } from '@/components/ui/section-label'
import { StackedLabel } from '@/components/ui/stacked-label'
import { useTranslations } from '@/i18n'
import { chatCopy } from '@/i18n/namespaces/chat'
import { diagramsCopy } from '@/i18n/namespaces/diagrams'
import { DIFF_COLORS } from '@/lib/diagrams/sketch-edit-diff'
import { fetchSketchEditPreview, fetchSketchProbe, revertSketchVersion } from '@/lib/diagrams/sketch-edit-client'
import { sketchEditSchema, type SketchEditBody } from '@/lib/diagrams/sketch-edit-wire'
import type { ProposedChangeResult } from '@/lib/proposals/types'
import { useServerProposal } from '../hooks/use-server-proposal'
import { DECISION_ROW } from './card-chrome'
import { ProposalReceipt } from './ProposalReceipt'
import { FailureReasons } from './ProposalReceipts'

/** The operation whose proposal is a drawing change, drawn by this card (`AnswerCards`). */
export const SKETCH_EDIT_OPERATION = 'document-sketch-edit'

/** The edit a proposal's stored input holds, or null when it is not one this card reads. */
export function sketchEditOf(input: Record<string, unknown>): { documentId: string; body: SketchEditBody } | null {
  const params = input.params as { id?: unknown } | undefined
  const body = sketchEditSchema.safeParse(input.body)
  return typeof params?.id === 'string' && body.success ? { documentId: params.id, body: body.data } : null
}

type Picture = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; url: string }

/** The preview's SVG as an image: no script of it runs, and it is drawn at the card's width. */
function usePreview(edit: ReturnType<typeof sketchEditOf>, enabled: boolean): Picture {
  const [picture, setPicture] = useState<Picture>({ state: 'loading' })
  // The edit by value: its object is new on every render.
  const key = edit && enabled ? JSON.stringify(edit) : null
  useEffect(() => {
    if (!key) return
    const { documentId, body } = JSON.parse(key) as NonNullable<ReturnType<typeof sketchEditOf>>
    let url: string | null = null
    let current = true
    fetchSketchEditPreview(documentId, body).then(
      (preview) => {
        if (!current) return
        url = URL.createObjectURL(new Blob([preview.svg], { type: 'image/svg+xml' }))
        setPicture({ state: 'ready', url })
      },
      () => current && setPicture({ state: 'failed' })
    )
    return () => {
      current = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [key])
  return edit ? picture : { state: 'failed' }
}

function Legend() {
  const d = useTranslations(diagramsCopy)
  const entries = [
    { color: DIFF_COLORS.added, label: d('sketchEdit.legendAdded'), dashed: false },
    { color: DIFF_COLORS.removed, label: d('sketchEdit.legendRemoved'), dashed: true },
    { color: DIFF_COLORS.changed, label: d('sketchEdit.legendChanged'), dashed: false },
  ]
  return (
    <ul className="card-caption text-muted-foreground flex flex-wrap gap-x-3 gap-y-1" data-testid="sketch-edit-legend">
      {entries.map((entry) => (
        <li key={entry.label} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-0 w-4 border-t-2"
            style={{ borderColor: entry.color, borderStyle: entry.dashed ? 'dashed' : 'solid' }}
          />
          {entry.label}
        </li>
      ))}
    </ul>
  )
}

function PreviewPicture({ picture }: { picture: Picture }) {
  const d = useTranslations(diagramsCopy)
  if (picture.state === 'loading') return <p className="card-caption text-muted-foreground">{d('sketchEdit.previewLoading')}</p>
  if (picture.state === 'failed') return <p className="card-caption text-muted-foreground">{d('sketchEdit.previewFailed')}</p>
  return (
    <figure className="flex flex-col gap-1.5">
      {/* The server's picture (ADR-0149), validated before it left; an <img> runs nothing of it. */}
      {/* oxlint-disable-next-line nextjs/no-img-element -- a blob: URL of the preview in this tab; the optimizer cannot fetch it */}
      <img src={picture.url} alt={d('sketchEdit.previewAlt')} className="border-border max-h-80 w-full rounded-md border bg-white object-contain" data-testid="sketch-edit-preview" />
      <Legend />
    </figure>
  )
}

function Steps({ body }: { body: SketchEditBody }) {
  const d = useTranslations(diagramsCopy)
  return (
    <div className="flex flex-col gap-1">
      <p className="card-caption text-muted-foreground font-medium">{d('sketchEdit.steps')}</p>
      <ol className="text-foreground ml-5 list-decimal text-sm" data-testid="sketch-edit-steps">
        {body.ops.map((op, index) => (
          <li key={index}>{op.intent}</li>
        ))}
      </ol>
    </div>
  )
}

type Undo = { state: 'checking' } | { state: 'ready' } | { state: 'blocked' } | { state: 'busy' } | { state: 'done' } | { state: 'failed' }

/** „Rückgängig“: offered while the Fassung the edit made is still the current one. */
function UndoRow({ documentId, versionId }: { documentId: string; versionId: string }) {
  const d = useTranslations(diagramsCopy)
  const [undo, setUndo] = useState<Undo>({ state: 'checking' })
  useEffect(() => {
    let current = true
    fetchSketchProbe(documentId).then(
      (probe) => current && setUndo({ state: probe.versionId === versionId && probe.canWrite ? 'ready' : 'blocked' }),
      () => current && setUndo({ state: 'blocked' })
    )
    return () => {
      current = false
    }
  }, [documentId, versionId])
  const press = () => {
    if (undo.state !== 'ready') return
    setUndo({ state: 'busy' })
    revertSketchVersion(documentId, versionId).then(
      () => setUndo({ state: 'done' }),
      (error: unknown) => setUndo({ state: (error as { reason?: unknown }).reason === 'moved_on' ? 'blocked' : 'failed' })
    )
  }
  if (undo.state === 'done') {
    return (
      <p className="card-caption text-muted-foreground" data-testid="sketch-edit-undone">
        {d('sketchEdit.undone')}
      </p>
    )
  }
  const waits = undo.state !== 'ready'
  return (
    <div className={DECISION_ROW}>
      <p className="card-caption text-muted-foreground sm:mr-auto" data-testid="sketch-edit-undo-note">
        {undo.state === 'blocked' ? d('sketchEdit.undoBlocked') : undo.state === 'failed' ? d('sketchEdit.undoFailed') : null}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={press}
        aria-disabled={waits || undefined}
        aria-busy={undo.state === 'busy' || undefined}
        className="aria-disabled:cursor-default aria-disabled:opacity-50"
        data-testid="sketch-edit-undo"
      >
        <StackedLabel busy={undo.state === 'busy'} idle={d('sketchEdit.undo')} working={d('sketchEdit.undoing')} />
      </Button>
    </div>
  )
}

/** The Fassung an applied edit made (`ProposedChangeResult.itemId`), when the apply recorded it. */
const madeVersion = (results: readonly ProposedChangeResult[] | null) => results?.find((result) => result.ok && result.itemId)?.itemId ?? null

export function SketchEditReceipt({
  proposalId,
  title,
  input,
}: {
  proposalId: string
  title: string
  /** Always {@link SKETCH_EDIT_OPERATION}; taken so the card is drawn where `OperationReceipt` would be. */
  operation?: string
  input: Record<string, unknown>
}) {
  const t = useTranslations(chatCopy)
  const d = useTranslations(diagramsCopy)
  const server = useServerProposal(proposalId, 'operation')
  const { proposal } = server
  const shownInput = (proposal?.payload.input ?? input) as Record<string, unknown>
  const edit = useMemo(() => sketchEditOf(shownInput), [shownInput])
  // Drawn once the object says it is open: a decided card shows no preview of a change already made or refused.
  const picture = usePreview(edit, proposal?.status === 'proposed')

  return (
    <ProposalReceipt
      server={server}
      eyebrow={<SectionLabel icon={PenLine}>{d('sketchEdit.eyebrow')}</SectionLabel>}
      title={proposal?.payload.summary ?? title}
      open={
        <>
          <PreviewPicture picture={picture} />
          {edit && <Steps body={edit.body} />}
        </>
      }
      headline={(decided) => {
        if (decided.status === 'applied' || decided.status === 'partially_applied') return d('sketchEdit.applied')
        if (decided.status === 'failed') return t('cards.proposalReceipt.failed')
        return d('sketchEdit.dismissed')
      }}
      decidedBody={(decided) => {
        const version = decided.status === 'applied' ? madeVersion(decided.results) : null
        return (
          <>
            <FailureReasons results={decided.results} />
            {edit && <Steps body={edit.body} />}
            {edit && version && <UndoRow documentId={edit.documentId} versionId={version} />}
          </>
        )
      }}
    />
  )
}
