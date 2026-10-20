'use client'

import type { JSX } from 'react'
import { createContext, useContext, useMemo } from 'react'
import { Calculator, MapPin, UserRound } from 'lucide-react'
import { Chip, ChipLabel } from '@/components/ui/chip'
import { SourcePreviewChip } from '@/features/chat/components/SourcePreview'
import type { CitationRef } from '@/features/chat/lib/citations'
import { useTranslations } from '@/i18n'
import type { ProfileEvidence } from '@/lib/project-intake/types'
import { cn } from '@/lib/utils'

/**
 * The project whose documents the chips open. The page provides it once
 * (`IntakeSetupView`), so no section passes it down to the chip.
 */
export const EvidenceProjectContext = createContext<string | undefined>(undefined)

type DocumentEvidence = Extract<ProfileEvidence, { kind: 'document' }>

/**
 * A document's evidence as the citation the chat's source chips are made of:
 * a project file, narrowed to the page and the quote. Nothing here is a
 * second kind of chip; it is the same reference, so the same hover peek, the
 * same viewer and the same provenance signal follow from it.
 */
export function citationOfEvidence(evidence: DocumentEvidence): CitationRef {
  const locus = {
    key: `${evidence.fileName}#${evidence.page ?? 'quote'}`,
    ...(evidence.page === null ? {} : { page: evidence.page }),
    snippet: evidence.quote,
    isCited: true,
  }
  return {
    document: {
      id: `intake:${evidence.fileName}`,
      title: evidence.fileName,
      fileName: evidence.fileName,
      shelf: 'project',
      kind: 'project',
      tint: 'project',
      loci: [locus],
    },
    locus,
  }
}

/**
 * Where a value was found, as chips: „Baubeschreibung.pdf, S. 3", which shows
 * the quote on hover or focus and opens the document at that page in the
 * viewer the chat's citations open, the address search, a derivation, or the
 * person's own answer. A value with no evidence shows no chip, never an empty
 * one. Only a document is a source, so only its chip wears the project
 * provenance signal; the others are neutral.
 */
export function EvidenceChips({
  evidence,
  className,
}: {
  evidence: readonly ProfileEvidence[]
  className?: string
}): JSX.Element | null {
  if (evidence.length === 0) return null
  return (
    <ul className={cn('flex min-w-0 flex-wrap gap-1.5', className)} data-testid="evidence-chips">
      {evidence.map((entry, index) => (
        <li key={`${entry.kind}-${index}`} className="min-w-0 max-w-full">
          <EvidenceChip evidence={entry} />
        </li>
      ))}
    </ul>
  )
}

function EvidenceChip({ evidence }: { evidence: ProfileEvidence }): JSX.Element {
  const t = useTranslations('projectIntake')
  if (evidence.kind === 'document') return <DocumentChip evidence={evidence} />
  if (evidence.kind === 'geocoder') {
    return (
      <Chip variant="muted" title={evidence.label}>
        <MapPin aria-hidden />
        <ChipLabel>{t('evidence.geocoder')}</ChipLabel>
      </Chip>
    )
  }
  if (evidence.kind === 'derivation') {
    return (
      <Chip variant="muted" title={evidence.citation}>
        <Calculator aria-hidden />
        <ChipLabel>{t('evidence.derivation')}</ChipLabel>
      </Chip>
    )
  }
  return (
    <Chip variant="muted">
      <UserRound aria-hidden />
      <ChipLabel>{t('evidence.person')}</ChipLabel>
    </Chip>
  )
}

function DocumentChip({ evidence }: { evidence: DocumentEvidence }): JSX.Element {
  const t = useTranslations('projectIntake')
  const projectId = useContext(EvidenceProjectContext)
  const citation = useMemo(() => citationOfEvidence(evidence), [evidence])
  const label =
    evidence.page === null
      ? t('evidence.documentNoPage', { name: evidence.fileName })
      : t('evidence.document', { name: evidence.fileName, page: evidence.page })
  return <SourcePreviewChip citation={citation} label={label} projectId={projectId} className="sm:max-w-72" />
}
