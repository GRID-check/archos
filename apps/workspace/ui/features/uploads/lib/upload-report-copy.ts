/**
 * The Eingangsbericht in words (`lib/upload-batches/upload-report.ts`): what
 * the inbox row says under „Ihr Upload ist gelesen“. Pure over a translator of
 * the `dossier` namespace, so the row, the dev preview and the specs say the
 * same sentences.
 *
 *   12 Dokumente gelesen: 7 Einreichpläne, 1 Bescheid, 1 Brandschutzkonzept, +2 weitere
 *   2 neue Befunde: Bodengutachten fehlt (verwiesen in 3 Dokumenten), Gebäudeklasse weicht vom Steckbrief ab
 *   5 Angaben · 1 Verweis ohne Dokument im Projekt · 3 Seiten nicht vollständig gelesen · 1 Befund erledigt
 */

import type { Translator } from '@/i18n/translate'
import type { UploadReport, UploadReportFinding } from '@/lib/upload-batches/upload-report'

/** Types named on the first line; the rest is „+n weitere“. */
const TYPES_NAMED = 3
/** Findings named on the second line; the panel has the rest. */
const FINDINGS_NAMED = 2

export interface UploadReportCopy {
  read: string
  /** Null when the upload brought no finding. */
  findings: string | null
  /** The smaller counts, each its own phrase; empty when all are zero. */
  details: string[]
}

/** What a finding is about, in the row's words. */
function subjectOf(t: Translator, finding: UploadReportFinding): string {
  switch (finding.kind) {
    case 'profile_contradiction':
      return finding.key === 'federal_state' ? t('findings.federalState') : t(`factKeys.${finding.key}`)
    case 'contradiction':
      return t(`factKeys.${finding.key}`)
    case 'missing_document':
      return t(`documentTypes.${finding.key}`)
    case 'missing_plan':
    case 'incomplete_read':
      return finding.label ?? finding.key
  }
}

/** One finding: „Bodengutachten fehlt (verwiesen in 3 Dokumenten)“. */
export function uploadReportFindingText(t: Translator, finding: UploadReportFinding): string {
  const subject = subjectOf(t, finding)
  const text = t(`uploadReport.finding.${finding.kind}`, { fact: subject, label: subject })
  const pointsAt = finding.kind === 'missing_document' || finding.kind === 'missing_plan'
  return pointsAt && finding.documents > 1 ? `${text} ${t('uploadReport.referredIn', { count: finding.documents })}` : text
}

export function uploadReportCopy(t: Translator, report: UploadReport): UploadReportCopy {
  const types = report.byType.slice(0, TYPES_NAMED).map(({ type, count }) => t(`documentTypeCounts.${type}`, { count }))
  const typedBeyond = report.byType.slice(TYPES_NAMED).reduce((sum, entry) => sum + entry.count, 0)
  if (typedBeyond > 0) types.push(t('uploadReport.more', { count: typedBeyond }))
  const read = t('uploadReport.read', { count: report.read })

  let findings: string | null = null
  if (report.newFindings > 0) {
    const named = report.findings.slice(0, FINDINGS_NAMED).map((finding) => uploadReportFindingText(t, finding))
    const beyond = report.newFindings - named.length
    if (beyond > 0) named.push(t('uploadReport.more', { count: beyond }))
    findings = `${t('uploadReport.newFindings', { count: report.newFindings })}: ${named.join(', ')}`
  }

  const details = [
    report.facts > 0 ? t('uploadReport.facts', { count: report.facts }) : null,
    report.unresolvedReferences > 0 ? t('uploadReport.unresolved', { count: report.unresolvedReferences }) : null,
    report.pagesNotRead > 0 ? t('uploadReport.notRead', { count: report.pagesNotRead }) : null,
    report.resolvedFindings > 0 ? t('uploadReport.resolved', { count: report.resolvedFindings }) : null,
  ].filter((phrase): phrase is string => phrase !== null)

  return { read: types.length > 0 ? `${read}: ${types.join(', ')}` : read, findings, details }
}

/** Where „Zu den Befunden“ leads: the project's Dateien, at the findings panel. */
export function uploadReportFindingsHref(report: Pick<UploadReport, 'projectId'>, anchor: string): string {
  return `/app/projects/${encodeURIComponent(report.projectId)}/files#${anchor}`
}
