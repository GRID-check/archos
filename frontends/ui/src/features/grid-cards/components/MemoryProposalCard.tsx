'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { useTranslations } from '@/i18n'
import { useChatStore } from '@/features/chat/store'
import { useCardDecision } from '../hooks/use-card-decision'
import { MemoryReceipt } from './ProposalReceipts'
import { ProposalShell } from './ProposalShell'
import { StackedLabel } from '@/components/ui/stacked-label'

type MemoryKind = 'decision' | 'constraint' | 'open_question' | 'derived_fact' | 'preference'
type MemoryConfidence = 'low' | 'medium' | 'high'

interface MemoryProposalCardProps {
  title: string
  content: string
  kind: MemoryKind
  confidence?: MemoryConfidence
  /** Message this card belongs to — keys its persisted decision. */
  messageId?: string
  /** Stable identity of this card within that message (`cardKey`). */
  cardKey: string
  /**
   * Whether this surface requires the answer to be persisted. With no owning
   * message the card then shows WHAT is proposed and offers nothing — see
   * `GridCards.decisionsMustPersist`.
   */
  decisionsMustPersist?: boolean
  /** The earlier note this one corrects, quoted; accepting the proposal retires it. */
  supersedes?: string | null
  /** The stored proposal this card is a receipt of (ADR-0105). Absent: the fallback below. */
  proposalId?: string | null
}

/**
 * Confirmation card emitted by the `remember` tool when an org-scoped memory
 * write can't be completed by the agent's service token (default-deny). The
 * agent never writes org-wide memory silently; instead the user completes the
 * write through their OWN authenticated session — org-wide (allowed for any org
 * member) or scoped to just this project. Mirrors ProjectProfilePatchCard:
 * propose, never auto-apply.
 *
 * A card with a `proposal_id` is the receipt of a stored `memory` proposal
 * (ADR-0105) and is drawn by {@link MemoryReceipt}: the server files the note in
 * the deciding person's session and records who decided and when. Without one
 * it is the fallback below.
 */
export function MemoryProposalCard({ proposalId, ...props }: MemoryProposalCardProps) {
  return proposalId ? (
    <MemoryReceipt
      proposalId={proposalId}
      title={props.title}
      content={props.content}
      kind={props.kind}
      confidence={props.confidence ?? 'medium'}
      supersedes={props.supersedes}
    />
  ) : (
    <BrowserWrittenMemoryCard {...props} />
  )
}

/**
 * FALLBACK for answers older than server proposals (and for a proposal the
 * agent could not store): the browser writes the note through the reader's own
 * session, and the answer is recorded on the owning message
 * (`useCardDecision`), not in local state. A card that forgot it had been saved
 * would ask again after a reload. Kept as it was for those answers; a new
 * proposal never reaches it when the server could store it.
 */
function BrowserWrittenMemoryCard({
  title,
  content,
  kind,
  confidence = 'medium',
  messageId,
  cardKey,
  decisionsMustPersist,
}: Omit<MemoryProposalCardProps, 'proposalId' | 'supersedes'>) {
  const t = useTranslations('chat')
  // Same source as ProjectProfilePatchCard's projectId: the active chat store.
  const projectId = useChatStore((s) => s.projectId)
  const { decision, decide, canDecide } = useCardDecision(messageId, cardKey, {
    mustPersist: decisionsMustPersist,
  })
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  // Which button is working: the project save used to say nothing while the
  // org-wide Yes beside it was the one that announced „Speichern …".
  const [savingTo, setSavingTo] = useState<'org' | 'project'>('org')

  const save = async (url: string, savedDecision: 'savedOrg' | 'savedProject') => {
    // Ignored while a save is in flight, rather than refused by `disabled`:
    // see the buttons below.
    if (isSubmitting) return
    setError(null)
    setSavingTo(savedDecision === 'savedProject' ? 'project' : 'org')
    setIsSubmitting(true)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, content, confidence }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `${t('memoryProposal.error')} (${res.status})`)
      }
      setIsSubmitting(false)
      decide(savedDecision)
    } catch (e) {
      setIsSubmitting(false)
      setError(e instanceof Error ? e.message : t('memoryProposal.error'))
    }
  }

  const handleSaveOrg = () => save('/api/organization/memory', 'savedOrg')
  const handleSaveProject = () => {
    if (!projectId) return
    void save(`/api/projects/${projectId}/memory`, 'savedProject')
  }
  const handleDismiss = () => {
    if (isSubmitting) return
    decide('dismissed')
    setError(null)
  }

  if (decision === 'savedOrg' || decision === 'savedProject') {
    return (
      <ProposalShell tone="accepted">
        <p className="text-sm text-foreground">
          {decision === 'savedOrg' ? t('memoryProposal.savedOrg') : t('memoryProposal.savedProject')}
        </p>
      </ProposalShell>
    )
  }

  if (decision === 'dismissed') {
    return (
      <ProposalShell tone="dismissed">
        <p className="text-sm text-muted-foreground">{t('memoryProposal.dismissed')}</p>
      </ProposalShell>
    )
  }

  return (
    <ProposalShell tone="pending">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <Chip variant="muted" size="sm">
          {t(`memoryProposal.kind.${kind}`)}
        </Chip>
      </div>

      <p className="text-sm leading-relaxed text-foreground">{content}</p>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* NOTHING TO PRESS when the answer could not be kept (`canDecide`): the
          proposal still reads — this is what the run wants remembered — but a
          Yes here would write the note and then forget it had. The write
          de-duplicates (`createProjectMemoryItem` refreshes an existing note
          instead of adding a second), so a repeat is not a second row, but the
          card would still ask again after a reload. It is asked again where
          the answer has a home, which is the thread. */}
      {canDecide && (
        <>
          {/* Project action is its own row so its target scope reads distinctly
              from the org-wide Yes/No group. Hidden when there is no project in
              scope. */}
          {/* BUSY, NOT DISABLED, while a save is in flight. `disabled` on the
              button the reader just pressed dropped their focus to <body> and
              dimmed the whole row; `aria-disabled` keeps the focus where it
              is, the handlers ignore a second press, and the pressed button
              says what it is doing in a label slot as wide as either label
              (`StackedLabel`), so nothing beside it moves. */}
          {projectId && (
            <div className="flex items-center">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleSaveProject}
                aria-disabled={isSubmitting || undefined}
                aria-busy={(isSubmitting && savingTo === 'project') || undefined}
                className="aria-disabled:cursor-default"
              >
                <StackedLabel
                  busy={isSubmitting && savingTo === 'project'}
                  idle={t('memoryProposal.saveToProject')}
                  working={t('memoryProposal.saving')}
                />
              </Button>
            </div>
          )}

          {/* Org-wide prompt with Yes/No grouped together to the right. */}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <p className="mr-auto text-sm text-muted-foreground">{t('memoryProposal.prompt')}</p>
            <Button
              type="button"
              size="sm"
              onClick={handleSaveOrg}
              aria-disabled={isSubmitting || undefined}
              aria-busy={(isSubmitting && savingTo === 'org') || undefined}
              className="aria-disabled:cursor-default"
            >
              <StackedLabel
                busy={isSubmitting && savingTo === 'org'}
                idle={t('memoryProposal.yes')}
                working={t('memoryProposal.saving')}
              />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleDismiss}
              aria-disabled={isSubmitting || undefined}
              className="aria-disabled:cursor-default aria-disabled:opacity-50"
            >
              {t('memoryProposal.no')}
            </Button>
          </div>
        </>
      )}
    </ProposalShell>
  )
}
