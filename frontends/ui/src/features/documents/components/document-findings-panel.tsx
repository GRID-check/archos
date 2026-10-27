'use client'

/**
 * „Befunde aus den Dokumenten“: what a project's documents say about each
 * other, above the project's file list — a contradiction between two of them,
 * a document or drawing number one points at that the project does not hold,
 * a document Piloti could not read in full (`lib/documents/findings.ts`).
 *
 * Collapsible and compact, one line per finding with the documents it rests on
 * as links, and absent when there is nothing to say: an empty panel would be a
 * claim that the documents were checked against each other and found clean,
 * which nobody made.
 */

import { useEffect, useRef, useState, type JSX } from 'react'
import { ChevronDown, FileSearch } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { CountPill } from '@/components/ui/count-pill'
import { InspectorGroup } from '@/components/ui/inspector-group'
import { SectionLabel } from '@/components/ui/section-label'
import { useTranslations } from '@/i18n'
import { COVERAGE_REASONS } from '@/lib/documents/dossier'
import type { DocumentFinding, FindingSource } from '@/lib/documents/findings'
import type { DocumentFindingsResponse } from '@/lib/documents/findings-wire'
import type { ProfileComparedKey } from '@/lib/documents/profile-contradictions'
import { cn } from '@/lib/utils'
import { useDocumentFindings } from '../hooks/use-document-findings'
import { DocumentLink, pagesLabel, ProjectProfileLink } from './document-dossier'

type Translate = ReturnType<typeof useTranslations>

/** The id the panel carries, so the inbox's upload report can link straight to it. */
export const DOCUMENT_FINDINGS_ANCHOR = 'document-findings'

/** What a profile contradiction is about: a fact key's label, or the Land. */
export function profileSubjectLabel(t: Translate, subject: ProfileComparedKey): string {
  return subject === 'federal_state' ? t('findings.federalState') : t(`factKeys.${subject}`)
}

/** The Steckbrief's value as the line shows it: the Gebäudeklasse with its „GK“. */
function profileValueText(t: Translate, finding: Extract<DocumentFinding, { kind: 'profile_contradiction' }>): string {
  return finding.subject === 'building_class'
    ? t('findings.buildingClassValue', { value: finding.profileValue })
    : finding.profileValue
}

function findingText(t: Translate, finding: DocumentFinding): string {
  switch (finding.kind) {
    case 'profile_contradiction':
      return t('findings.profileContradiction', { fact: profileSubjectLabel(t, finding.subject) })
    case 'contradiction':
      return t('findings.contradiction', { fact: t(`factKeys.${finding.factKey}`) })
    case 'missing_document':
      return t('findings.missingDocument', { label: t(`documentTypes.${finding.documentType}`) })
    case 'missing_plan':
      return t('findings.missingPlan', { label: finding.label })
    case 'incomplete_read': {
      const reasons = COVERAGE_REASONS.filter((reason) => (finding.reasons[reason] ?? 0) > 0)
        .map((reason) => t(`coverageReasons.${reason}`))
        .join(', ')
      const text = t('findings.incompleteRead', { notRead: finding.notRead, pages: finding.pages })
      return reasons ? `${text} (${reasons})` : text
    }
  }
}

/** One document a finding rests on: its link, the value it states, the pages. */
function SourceItem({ source, projectId }: { source: FindingSource; projectId: string }): JSX.Element {
  const t = useTranslations('dossier')
  const pages = pagesLabel(t, source.pages)
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="text-foreground">
        <DocumentLink projectId={projectId} document={source} />
        {source.value !== undefined && `: ${source.unit ? `${source.value} ${source.unit}` : source.value}`}
      </span>
      {pages && <span className="text-muted-foreground tabular-nums">({pages})</span>}
    </span>
  )
}

function FindingLine({ finding, projectId }: { finding: DocumentFinding; projectId: string }): JSX.Element {
  const t = useTranslations('dossier')
  return (
    <li className="flex flex-col gap-0.5 px-3 py-2 text-xs/5" data-testid={`finding-${finding.kind}`}>
      <span className="text-foreground">{findingText(t, finding)}</span>
      <span className="text-muted-foreground flex flex-wrap items-baseline gap-x-2">
        {(finding.kind === 'missing_document' || finding.kind === 'missing_plan') && <span>{t('findings.referredIn')}</span>}
        {finding.kind === 'profile_contradiction' && (
          <span className="text-foreground" data-testid="finding-profile-value">
            <ProjectProfileLink projectId={projectId}>{t('findings.profile')}</ProjectProfileLink>
            {`: ${profileValueText(t, finding)}`}
            <span className="text-muted-foreground" aria-hidden>
              {' ·'}
            </span>
          </span>
        )}
        {finding.sources.map((source, index) => (
          <SourceItem key={`${source.documentId}-${index}`} source={source} projectId={projectId} />
        ))}
      </span>
    </li>
  )
}

/** The panel over findings already in hand (the dev preview), or nothing when there are none. */
export function DocumentFindingsList({
  projectId,
  response,
  defaultOpen = true,
}: {
  projectId: string
  response: DocumentFindingsResponse | null
  defaultOpen?: boolean
}): JSX.Element | null {
  const t = useTranslations('dossier')
  const [open, setOpen] = useState(defaultOpen)
  const section = useRef<HTMLElement>(null)
  const shown = Boolean(response && response.findings.length > 0)
  // The inbox's upload report links here (`#document-findings`); the panel
  // arrives after the page, so the browser's own jump to the anchor misses it.
  useEffect(() => {
    if (shown && window.location.hash === `#${DOCUMENT_FINDINGS_ANCHOR}`) section.current?.scrollIntoView({ block: 'start' })
  }, [shown])
  if (!response || response.findings.length === 0) return null
  const { findings } = response
  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <section ref={section} id={DOCUMENT_FINDINGS_ANCHOR} aria-label={t('findings.title')} data-testid="document-findings-panel">
        <InspectorGroup>
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              className="h-auto w-full justify-between rounded-none px-3 py-2"
              aria-label={open ? t('findings.hide') : t('findings.show')}
            >
              <span className="flex items-center gap-2">
                <SectionLabel icon={FileSearch} className="font-semibold tracking-[0.05em]">
                  {t('findings.title')}
                </SectionLabel>
                <CountPill count={findings.length} aria-label={t('findings.count', { count: findings.length })} />
              </span>
              <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} aria-hidden />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <p className="text-muted-foreground border-border/60 border-t px-3 py-1.5 text-[11px]">{t('findings.hint')}</p>
            <ul className="divide-border/60 border-border/60 divide-y border-t">
              {findings.map((finding, index) => (
                <FindingLine key={`${finding.kind}-${index}`} finding={finding} projectId={projectId} />
              ))}
            </ul>
            {response.truncated && (
              <p className="text-muted-foreground border-border/60 border-t px-3 py-1.5 text-[11px]">
                {t('findings.truncated', { count: response.documentCount })}
              </p>
            )}
          </CollapsibleContent>
        </InspectorGroup>
      </section>
    </Collapsible>
  )
}

/** The project's panel: reads its findings, and re-reads when the listing settles (`refreshKey`). */
export function DocumentFindingsPanel({
  projectId,
  refreshKey,
  className,
}: {
  projectId: string
  refreshKey?: string
  className?: string
}): JSX.Element | null {
  const response = useDocumentFindings(projectId, { refreshKey })
  if (!response || response.findings.length === 0) return null
  return (
    <div className={className}>
      <DocumentFindingsList projectId={projectId} response={response} />
    </div>
  )
}
