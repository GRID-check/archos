'use client'

/**
 * What ingestion read a document to be (its dossier), what it points at and
 * who points at it, and how much of it was read — the lower half of the
 * „Piloti reading“ rail (`agent-reading.tsx`). Contract:
 * `docs/architecture/document-dossier.md`.
 *
 * The dossier and the raw references arrive on the file itself; resolving a
 * reference to a document of the project needs the project's documents, so
 * that half comes from the findings route (`useDocumentFindings`), or from the
 * caller where it already holds it (a dev preview). Until it lands, every
 * reference is shown by its label, neither linked nor marked missing.
 */

import type { JSX, ReactNode } from 'react'
import Link from 'next/link'
import { Chip } from '@/components/ui/chip'
import { FactBlockTitle, FactList, FactRow } from '@/components/ui/fact-list'
import { useLocale, useTranslations } from '@/i18n'
import { dossierCopy } from '@/i18n/namespaces/dossier'
import {
  COVERAGE_REASONS,
  DOCUMENT_REFERENCE_KINDS,
  type DocumentReference,
  type Dossier,
  type ReadingCoverage,
} from '@/lib/documents/dossier'
import type { DocumentPointer, IncomingReference, ResolvedReference } from '@/lib/documents/findings'
import type { DocumentLinks } from '@/lib/documents/findings-wire'
import { documentFilesHref } from '../lib/document-question'
import type { FileItem } from '../file-types'
import { useDocumentFindings } from '../hooks/use-document-findings'

type Translate = ReturnType<typeof useTranslations>

/** „S. 2“ or „S. 2, 4, 7“, or nothing. */
export function pagesLabel(t: Translate, pages: readonly number[]): string | null {
  if (pages.length === 0) return null
  return pages.length === 1 ? t('rail.page', { page: pages[0] }) : t('rail.pages', { pages: pages.join(', ') })
}

const INLINE_LINK =
  'text-foreground decoration-border hover:decoration-foreground font-medium underline underline-offset-2'

/** A link to the project's profile, the Steckbrief, where the intake wizard shows and edits it. */
export function ProjectProfileLink({ projectId, children }: { projectId: string; children: ReactNode }): JSX.Element {
  return (
    <Link
      href={`/app/projects/${encodeURIComponent(projectId)}/intake`}
      className={INLINE_LINK}
      data-testid="project-profile-link"
    >
      {children}
    </Link>
  )
}

/** A link that opens a document of the project in its Dateien preview (`?doc=`). */
export function DocumentLink({
  projectId,
  document,
  children,
}: {
  projectId: string
  document: DocumentPointer
  children?: ReactNode
}): JSX.Element {
  return (
    <Link
      href={documentFilesHref(projectId, document.documentId)}
      title={document.name}
      className={INLINE_LINK}
      data-testid="document-link"
    >
      {children ?? document.name}
    </Link>
  )
}

/** „38 von 40 Seiten vollständig gelesen · 2 Zeichnungsseiten nicht ausgewertet (Seitenlimit)“. */
export function CoverageLine({ coverage }: { coverage: ReadingCoverage }): JSX.Element {
  const t = useTranslations(dossierCopy)
  if (coverage.notRead === 0) {
    return (
      <p className="text-muted-foreground text-xs" data-testid="dossier-coverage">
        {t('rail.coverageFull', { pages: coverage.pages })}
      </p>
    )
  }
  const reasons = COVERAGE_REASONS.filter((reason) => (coverage.reasons[reason] ?? 0) > 0).map((reason) =>
    t(`coverageReasons.${reason}`)
  )
  return (
    <p className="text-muted-foreground text-xs" data-testid="dossier-coverage">
      {t('rail.coveragePartial', { read: coverage.pages - coverage.notRead, pages: coverage.pages })}
      <span aria-hidden> · </span>
      <span className="text-foreground">
        {t('rail.notRead', { count: coverage.notRead })}
        {reasons.length > 0 && ` (${reasons.join(', ')})`}
      </span>
    </p>
  )
}

function formatDate(iso: string, locale: string): string {
  const [year, month, day] = iso.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

/** Type, parties, dates, place and the facts the document states. */
export function DossierFacts({ dossier }: { dossier: Dossier }): JSX.Element | null {
  const t = useTranslations(dossierCopy)
  const { locale } = useLocale()
  const place = dossier.place ? [dossier.place.address, dossier.place.municipality].filter(Boolean).join(', ') : ''
  const hasHeader = dossier.documentType || dossier.parties.length > 0 || dossier.dates.length > 0 || place
  if (!hasHeader && dossier.facts.length === 0) return null
  return (
    <div className="flex flex-col gap-2" data-testid="dossier-facts">
      {hasHeader && (
        <FactList>
          {dossier.documentType && (
            <FactRow label={t('rail.documentType')}>
              <span data-testid="dossier-type">{t(`documentTypes.${dossier.documentType}`)}</span>
            </FactRow>
          )}
          {dossier.parties.map((party) => (
            <FactRow key={`${party.role}-${party.name}`} label={t(`partyRoles.${party.role}`)}>
              {party.name}
            </FactRow>
          ))}
          {dossier.dates.map((date) => (
            <FactRow key={`${date.kind}-${date.date}`} label={t(`dateKinds.${date.kind}`)}>
              {formatDate(date.date, locale)}
            </FactRow>
          ))}
          {place && <FactRow label={t('rail.place')}>{place}</FactRow>}
        </FactList>
      )}
      {dossier.facts.length > 0 && (
        <div className="flex flex-col gap-1">
          <FactBlockTitle>{t('rail.facts')}</FactBlockTitle>
          <FactList>
            {dossier.facts.map((fact, index) => (
              <FactRow
                key={`${fact.key}-${index}`}
                label={t(`factKeys.${fact.key}`)}
                meta={fact.page !== null ? t('rail.page', { page: fact.page }) : undefined}
                title={fact.quote ?? undefined}
                data-testid="dossier-fact"
              >
                {fact.unit ? `${fact.value} ${fact.unit}` : fact.value}
              </FactRow>
            ))}
          </FactList>
        </div>
      )}
    </div>
  )
}

/** One reference: a link per document it resolves to, muted when the project lacks it. */
function ReferenceItem({ resolved, projectId }: { resolved: ResolvedReference; projectId?: string }): JSX.Element | null {
  const t = useTranslations(dossierCopy)
  const { reference, resolution, targets } = resolved
  if (resolution === 'self') return null
  if (resolution === 'resolved' && targets.length > 0 && projectId) {
    return (
      <li className="flex flex-wrap items-baseline gap-x-1.5" data-testid="dossier-reference-resolved">
        {targets.map((target) => (
          <DocumentLink key={target.documentId} projectId={projectId} document={target}>
            {targets.length > 1 ? `${reference.label} (${target.name})` : reference.label}
          </DocumentLink>
        ))}
        <ReferencePages reference={reference} />
      </li>
    )
  }
  if (resolution === 'missing') {
    return (
      <li className="text-muted-foreground flex flex-wrap items-baseline gap-x-1.5" data-testid="dossier-reference-missing">
        <span>{reference.label}</span>
        <span className="italic">{t('rail.notInProject')}</span>
        <ReferencePages reference={reference} />
      </li>
    )
  }
  return (
    <li className="flex flex-wrap items-baseline gap-x-1.5" data-testid="dossier-reference">
      <span>{reference.label}</span>
      <ReferencePages reference={reference} />
    </li>
  )
}

function ReferencePages({ reference }: { reference: DocumentReference }): JSX.Element | null {
  const t = useTranslations(dossierCopy)
  const label = pagesLabel(t, reference.pages)
  return label ? <span className="text-muted-foreground tabular-nums">{label}</span> : null
}

/** The references, grouped by kind; norms and laws as chips, documents and drawing numbers as a list. */
export function DossierReferences({
  references,
  projectId,
}: {
  references: readonly ResolvedReference[]
  projectId?: string
}): JSX.Element | null {
  const t = useTranslations(dossierCopy)
  const groups = DOCUMENT_REFERENCE_KINDS.map((kind) => ({
    kind,
    items: references.filter((resolved) => resolved.reference.kind === kind && resolved.resolution !== 'self'),
  })).filter((group) => group.items.length > 0)
  // Documents and drawing numbers lead: they are what a person can open.
  const order: Record<string, number> = { document: 0, plan: 1, norm: 2, law: 3 }
  groups.sort((a, b) => order[a.kind] - order[b.kind])
  if (groups.length === 0) return null
  return (
    <div className="flex flex-col gap-1.5" data-testid="dossier-references">
      <FactBlockTitle>{t('rail.references')}</FactBlockTitle>
      {groups.map((group) => (
        <div key={group.kind} className="flex flex-col gap-1">
          <p className="text-muted-foreground text-[11px]">{t(`referenceKinds.${group.kind}`)}</p>
          {group.kind === 'norm' || group.kind === 'law' ? (
            <div className="flex flex-wrap gap-1">
              {group.items.map(({ reference }) => (
                <Chip key={reference.key} variant="outline" size="sm" className="font-normal" title={pagesLabel(t, reference.pages) ?? undefined}>
                  {reference.label}
                </Chip>
              ))}
            </div>
          ) : (
            <ul className="flex flex-col gap-0.5 text-xs/5">
              {group.items.map((resolved) => (
                <ReferenceItem key={resolved.reference.key} resolved={resolved} projectId={projectId} />
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  )
}

/** „Verwiesen von“: the documents that point at this one. */
export function DossierReferencedBy({
  incoming,
  projectId,
}: {
  incoming: readonly IncomingReference[]
  projectId: string
}): JSX.Element | null {
  const t = useTranslations(dossierCopy)
  if (incoming.length === 0) return null
  return (
    <div className="flex flex-col gap-1" data-testid="dossier-referenced-by">
      <FactBlockTitle>{t('rail.referencedBy')}</FactBlockTitle>
      <ul className="flex flex-col gap-0.5 text-xs/5">
        {incoming.map(({ source, reference }) => (
          <li key={`${source.documentId}-${reference.kind}-${reference.key}`} className="flex flex-wrap items-baseline gap-x-1.5">
            <DocumentLink projectId={projectId} document={source} />
            <span className="text-muted-foreground">
              {reference.label}
              {pagesLabel(t, reference.pages) && `, ${pagesLabel(t, reference.pages)}`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The references as known before the project's documents are: by label only. */
const unresolved = (references: readonly DocumentReference[]): ResolvedReference[] =>
  references.map((reference) => ({
    reference,
    resolution: reference.kind === 'norm' || reference.kind === 'law' ? 'external' : 'resolved',
    targets: [],
  }))

/**
 * The whole block. `links` given (a preview with fixtures) is used as is;
 * otherwise, inside a project, the findings route resolves the references.
 */
export function DocumentDossier({
  file,
  projectId,
  links,
}: {
  file: FileItem
  projectId?: string
  links?: DocumentLinks | null
}): JSX.Element | null {
  const hasReferences = (file.docReferences?.length ?? 0) > 0
  const fetched = useDocumentFindings(projectId, {
    documentId: file.id,
    // Re-read when this document's own reading changes; „Verwiesen von“ needs
    // the read even when the document points at nothing itself.
    refreshKey: `${file.status}:${file.docReferences?.length ?? 0}`,
    enabled: links === undefined,
  })
  const resolvedLinks = links === undefined ? fetched?.document ?? null : links
  const references = resolvedLinks?.references ?? unresolved(file.docReferences ?? [])
  const incoming = resolvedLinks?.referencedBy ?? []

  if (!file.dossier && !file.coverage && !hasReferences && incoming.length === 0) return null
  return (
    <div className="flex flex-col gap-3" data-testid="document-dossier">
      {file.coverage && <CoverageLine coverage={file.coverage} />}
      {file.dossier && <DossierFacts dossier={file.dossier} />}
      <DossierReferences references={references} projectId={projectId} />
      {projectId && <DossierReferencedBy incoming={incoming} projectId={projectId} />}
    </div>
  )
}
