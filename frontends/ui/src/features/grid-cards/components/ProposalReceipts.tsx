'use client'

/**
 * The three receipts: one per kind of proposed change (ADR-0105), each a small
 * body inside the shared {@link ProposalReceipt} frame. A card with a
 * `proposal_id` is drawn by one of these; the card components
 * (`FileOperationProposalCard`, `MemoryProposalCard`, `ProjectProfilePatchCard`)
 * pick it, and keep their older path only for answers without one.
 *
 * Every receipt draws the card's own copy of the proposal until the server's
 * object has been read, then the object, so the first paint is never empty and
 * what a reader decides is what is stored.
 */

import { useMemo, type ReactNode } from 'react'
import { FolderTree } from 'lucide-react'
import { Chip } from '@/components/ui/chip'
import { SectionLabel } from '@/components/ui/section-label'
import { useTranslations } from '@/i18n'
import { invalidateProjectFacts } from '@/features/chat/hooks/use-project-facts'
import { buildPatchPreviewRows } from '@/lib/project-profile/patch-preview'
import type { ProjectProfilePatchOperation } from '@/lib/project-profile/types'
import type { MemoryPayload, ProposedChangeResult } from '@/lib/proposals/types'
import { useCurrentProfile } from '../hooks/use-current-profile'
import { useServerProposal } from '../hooks/use-server-proposal'
import { notifyIfAnyApplied, type FileOperationItem, type FileOperationKind } from '../lib/file-operations'
import { OperationList } from './FileOperationRows'
import { ProfilePatchTable } from './ProfilePatchTable'
import { ProposalReceipt } from './ProposalReceipt'

/** Why a decided proposal changed nothing, in the service's own words, one line per failed item. */
function FailureReasons({ results }: { results: readonly ProposedChangeResult[] | null }) {
  const reasons = (results ?? []).filter((result) => !result.ok && result.reason)
  if (reasons.length === 0) return null
  return (
    <ul className="flex flex-col gap-1" data-testid="proposal-failures">
      {reasons.map((result, index) => (
        <li key={`${result.label}-${index}`} className="card-caption text-muted-foreground">
          {result.reason}
        </li>
      ))}
    </ul>
  )
}

// ── Files ────────────────────────────────────────────────────────────────

export function FileOperationReceipt({
  proposalId,
  title,
  operation,
  operations,
  note,
}: {
  proposalId: string
  title: string
  operation: FileOperationKind
  operations: readonly FileOperationItem[]
  note?: string | null
}) {
  const t = useTranslations('chat')
  // A colleague's apply changed files too: the Files list is told either way.
  const server = useServerProposal(proposalId, 'file_operation', (next) => notifyIfAnyApplied(next.results))
  const { proposal } = server
  const verb = proposal?.payload.operation ?? operation
  const items: readonly FileOperationItem[] = proposal?.payload.operations ?? operations
  const shownNote = proposal ? proposal.payload.note : note
  const newFolder = proposal?.payload.new_folder

  return (
    <ProposalReceipt
      server={server}
      eyebrow={<SectionLabel icon={FolderTree}>{t(`cards.fileOperationProposal.eyebrow.${verb}`)}</SectionLabel>}
      title={title}
      open={
        <>
          <OperationList operation={verb} items={items} newFolder={newFolder} />
          {shownNote && <p className="card-caption text-muted-foreground">{shownNote}</p>}
        </>
      }
      headline={(decided) => {
        const count = decided.payload.operations.length
        switch (decided.status) {
          case 'applied':
            return t(`cards.fileOperationProposal.applied.${decided.payload.operation}`, { count })
          case 'partially_applied':
            return t('cards.fileOperationProposal.partialCount', {
              applied: decided.results?.filter((result) => result.ok).length ?? 0,
              total: count,
            })
          case 'failed':
            return t('cards.proposalReceipt.failed')
          default:
            return t('cards.fileOperationProposal.dismissed')
        }
      }}
      decidedBody={(decided) =>
        decided.status === 'dismissed' ? null : (
          <OperationList
            operation={decided.payload.operation}
            items={decided.payload.operations}
            results={decided.results}
            newFolder={decided.payload.new_folder}
          />
        )
      }
    />
  )
}

// ── Memory ───────────────────────────────────────────────────────────────

export function MemoryReceipt({
  proposalId,
  title,
  content,
  kind,
  confidence,
  supersedes,
}: {
  proposalId: string
  title: string
  content: string
  kind: MemoryPayload['kind']
  confidence: MemoryPayload['confidence']
  supersedes?: string | null
}) {
  const t = useTranslations('chat')
  const server = useServerProposal(proposalId, 'memory')
  const { proposal } = server
  const note = proposal?.payload ?? { scope: null, kind, content, confidence, supersedes }

  return (
    <ProposalReceipt
      server={server}
      eyebrow={
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip variant="muted" size="sm">
            {t(`memoryProposal.kind.${note.kind}`)}
          </Chip>
          <Chip variant="outline" size="sm">
            {t(`cards.proposalReceipt.memory.confidence.${note.confidence}`)}
          </Chip>
        </div>
      }
      title={title}
      open={
        <>
          <p className="text-foreground text-sm leading-relaxed">{note.content}</p>
          {note.supersedes && (
            <p className="card-caption text-muted-foreground" data-testid="memory-supersedes">
              {t('cards.proposalReceipt.memory.supersedes', { note: note.supersedes })}
            </p>
          )}
          {note.scope && (
            <p className="card-caption text-muted-foreground" data-testid="memory-destination">
              {t(`cards.proposalReceipt.memory.goesInto.${note.scope}`)}
            </p>
          )}
        </>
      }
      headline={(decided) => {
        switch (decided.status) {
          case 'applied':
          case 'partially_applied': {
            // A row decided before the scope was recorded has none.
            const scope = decided.results?.find((result) => result.ok)?.scope
            return scope ? t(`cards.proposalReceipt.memory.savedIn.${scope}`) : t('cards.proposalReceipt.memory.saved')
          }
          case 'failed':
            return t('cards.proposalReceipt.failed')
          default:
            return t('cards.proposalReceipt.memory.dismissed')
        }
      }}
      decidedBody={(decided) => <FailureReasons results={decided.results} />}
      // Only an office note has a narrower place to go. The other way round is
      // refused by the server: a project note does not become the office's by a
      // click on a proposal that did not ask for it.
      alternative={
        note.scope === 'organization'
          ? {
              label: t('cards.proposalReceipt.memory.onlyInProject'),
              working: t('cards.proposalReceipt.memory.saving'),
              body: { memoryScope: 'project' },
            }
          : undefined
      }
    />
  )
}

// ── Project profile ──────────────────────────────────────────────────────

export function ProfilePatchReceipt({
  proposalId,
  title,
  rationale,
  patch,
  projectId,
}: {
  proposalId: string
  title: string
  rationale: string
  patch: readonly ProjectProfilePatchOperation[]
  /** The chat's project, until the object says which project it is for. */
  projectId?: string | null
}) {
  const t = useTranslations('chat')
  // Every answer in the thread binds the profile (`:project[key]`): the value
  // it asked for appears in each of them now, not on a reload. A colleague's
  // apply counts too.
  const server = useServerProposal(proposalId, 'project_profile', (next) => {
    if (next.status === 'applied' || next.status === 'partially_applied') invalidateProjectFacts(next.projectId)
  })
  const { proposal } = server
  const shownPatch = proposal?.payload.patch ?? patch
  const shownTitle = proposal?.payload.title ?? title
  const shownRationale = proposal ? proposal.payload.rationale : rationale

  // „Before“ is the profile as it is while the proposal is open. Once decided
  // the profile holds the change, so the receipt shows the „after“ alone.
  const open = !proposal || proposal.status === 'proposed'
  const profile = useCurrentProfile(open ? (proposal?.projectId ?? projectId) : null)
  const openRows = useMemo(
    () => buildPatchPreviewRows(shownPatch as ProjectProfilePatchOperation[], profile),
    [shownPatch, profile]
  )
  const decidedRows = useMemo(
    () => buildPatchPreviewRows(shownPatch as ProjectProfilePatchOperation[], null),
    [shownPatch]
  )

  const rationaleLine = (text: string | null | undefined): ReactNode =>
    text ? <p className="text-muted-foreground text-sm leading-relaxed">{text}</p> : null

  return (
    <ProposalReceipt
      server={server}
      title={shownTitle}
      open={
        <>
          {rationaleLine(shownRationale)}
          <ProfilePatchTable rows={openRows} showBefore={profile !== null} />
        </>
      }
      headline={(decided) => {
        switch (decided.status) {
          case 'applied':
          case 'partially_applied':
            return t('cards.proposalReceipt.profile.applied')
          case 'failed':
            return t('cards.proposalReceipt.failed')
          default:
            return t('cards.proposalReceipt.profile.dismissed')
        }
      }}
      decidedBody={(decided) =>
        decided.status === 'applied' || decided.status === 'partially_applied' ? (
          <ProfilePatchTable rows={decidedRows} showBefore={false} />
        ) : (
          <FailureReasons results={decided.results} />
        )
      }
    />
  )
}
