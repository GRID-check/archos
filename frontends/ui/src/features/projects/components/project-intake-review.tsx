

import { AlertTriangle, Loader2, PencilLine, Sparkles } from 'lucide-react'


import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

import { cn } from '@/lib/utils'

import { answerKeyFor, modeKeyFor } from '@/lib/project-profile/intake-building-keys'
import { evaluateIntakeCondition, isIntakeAnswerProvided } from '@/lib/project-profile/intake-conditions'

import { formatIntakeAnswer } from '@/lib/project-profile/intake-vocabulary'
import type { BuildingInstance } from '@/lib/project-profile/intake-building-keys'
import type { IntakeAnswerMode, ProjectIntakeDefinition, ProjectIntakeQuestion } from '@/lib/project-profile/intake-types'

import type { ConsistencyFinding } from '@/lib/project-profile/intake-consistency'

import { useTranslations } from '@/i18n'
import type { Translator } from '@/i18n'

import { projectsCopy } from '@/i18n/namespaces/projects'
import { Answers } from './project-intake-helpers'

export interface ReviewItem {
  label: string
  value: string
  mode?: 'estimated' | 'open'
}

export function reviewItemsFor(
  questions: ProjectIntakeQuestion[],
  answers: Answers,
  keyOf: (q: ProjectIntakeQuestion) => string,
  instanceId?: string
): ReviewItem[] {
  const items: ReviewItem[] = []
  for (const q of questions) {
    if (q.type === 'info_placeholder' || q.type === 'upload' || q.type === 'document_role') continue
    if (!q.writesTo) continue
    if (!evaluateIntakeCondition(q, answers, instanceId)) continue
    const key = keyOf(q)
    const raw = answers[key]
    if (q.type === 'number_tri') {
      const mode = answers[modeKeyFor(key)] as IntakeAnswerMode | undefined
      if (mode === 'open') {
        items.push({ label: q.label, value: '—', mode: 'open' })
      } else if (isIntakeAnswerProvided(raw)) {
        items.push({
          label: q.label,
          value: formatIntakeAnswer(q, raw),
          mode: mode === 'estimated' ? 'estimated' : undefined,
        })
      }
      continue
    }
    if (q.type === 'yes_no_open') {
      if (raw === 'open') items.push({ label: q.label, value: '—', mode: 'open' })
      else if (raw === 'yes' || raw === 'no')
        items.push({ label: q.label, value: raw === 'yes' ? 'Ja' : 'Nein' })
      continue
    }
    // A plain question can be explicitly open too: "Rest überspringen" records
    // an unanswered one as mode 'open'. Reading the sibling only for
    // `number_tri` made every skipped text/select question vanish from this
    // checklist — the one place the feature promises they reappear.
    if (answers[modeKeyFor(key)] === 'open') {
      items.push({ label: q.label, value: '—', mode: 'open' })
      continue
    }
    if (isIntakeAnswerProvided(raw))
      items.push({ label: q.label, value: formatIntakeAnswer(q, raw) })
  }
  return items
}

export function ReviewSection({
  title,
  items,
  onEdit,
  editLabel,
}: {
  title: string
  items: ReviewItem[]
  onEdit?: () => void
  editLabel: string
}) {
  if (items.length === 0) return null
  return (
    <section className="p-5 md:p-6">
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-sm font-semibold">{title}</h3>
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors duration-quick ease-out motion-reduce:transition-none"
          >
            <PencilLine className="size-3" aria-hidden />
            {editLabel}
          </button>
        )}
      </div>
      <dl className="mt-3 grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
        {items.map((item, i) => (
          <div key={i} className="flex flex-col">
            <dt className="text-muted-foreground text-xs">{item.label}</dt>
            <dd
              className={cn(
                'mt-0.5 text-sm',
                item.mode === 'open' ? 'text-muted-foreground' : 'font-medium'
              )}
            >
              {item.value}
              {item.mode === 'estimated' && (
                <Badge variant="warning" className="ml-2 align-middle">
                  geschätzt
                </Badge>
              )}
              {item.mode === 'open' && (
                <Badge variant="outline" className="ml-2 align-middle">
                  noch offen
                </Badge>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

export function ReviewStep({
  definition,
  answers,
  buildings,
  onEditStage,
}: {
  definition: ProjectIntakeDefinition
  answers: Answers
  buildings: BuildingInstance[]
  onEditStage: (stageIndex: number) => void
}) {
  const t = useTranslations(projectsCopy)

  const projectStages = definition.stages
    .map((stage, index) => ({ stage, index }))
    // `H` is the summary itself. `I` holds document slots rather than answers,
    // so it would render as an empty section here — the bindings live in
    // `document_roles`, not in the answer map this summarises.
    .filter(({ stage }) => stage.scope !== 'building' && stage.id !== 'H' && stage.id !== 'I')
  const buildingStages = definition.stages
    .map((stage, index) => ({ stage, index }))
    .filter(({ stage }) => stage.scope === 'building')

  return (
    <div className="space-y-4">
      <div className="divide-border bg-card shadow-xs divide-y overflow-hidden rounded-2xl border">
        {projectStages.map(({ stage, index }) => (
          <ReviewSection
            key={stage.id}
            title={stage.title}
            editLabel={t('intake.edit')}
            onEdit={() => onEditStage(index)}
            items={reviewItemsFor(stage.questions, answers, (q) => q.id)}
          />
        ))}
      </div>

      {buildings.map((bw) => {
        const items: ReviewItem[] = []
        for (const { stage } of buildingStages) {
          items.push(
            ...reviewItemsFor(stage.questions, answers, (q) => answerKeyFor(q.id, bw.id), bw.id)
          )
          const uses = answers[answerKeyFor('D0', bw.id)]
          if (Array.isArray(uses)) {
            for (const use of uses) {
              const zoneQs = [
                ...(stage.zoneCommon ?? []),
                ...(stage.zoneDefinitions?.[use]?.questions ?? []),
              ]
              items.push(
                ...reviewItemsFor(zoneQs, answers, (q) => answerKeyFor(q.id, bw.id, use), bw.id)
              )
            }
          }
        }
        if (items.length === 0) return null
        return (
          <div key={bw.id} className="bg-card shadow-xs overflow-hidden rounded-2xl border">
            <ReviewSection
              title={bw.name}
              editLabel={t('intake.edit')}
              onEdit={() => onEditStage(buildingStages[0]?.index ?? 0)}
              items={items}
            />
          </div>
        )
      })}

      <div className="bg-muted/30 rounded-2xl border border-dashed p-5">
        <div className="flex items-start gap-2">
          <Sparkles className="text-primary size-4 shrink-0 translate-y-0.5" aria-hidden />
          <div>
            <p className="text-sm font-medium">{t('intake.classification.title')}</p>
            <p className="text-muted-foreground mt-1 text-sm">
              {t('intake.classification.description')}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Findings panel (unchanged behaviour, adapted to modules).
// ---------------------------------------------------------------------------

export function resolveReviseStage(
  definition: ProjectIntakeDefinition,
  finding: ConsistencyFinding
): number {
  for (const label of finding.fields) {
    const idx = definition.stages.findIndex((stage) =>
      stage.questions.some((q) => q.label === label)
    )
    if (idx >= 0) return idx
  }
  if (finding.kind === 'ai') {
    const freeTextStage = definition.stages.findIndex((stage) =>
      stage.questions.some((q) => q.type === 'text' || q.type === 'textarea')
    )
    if (freeTextStage >= 0) return freeTextStage
  }
  return 0
}

export function findingMessage(finding: ConsistencyFinding, t: Translator): string {
  if (finding.kind === 'ai') return finding.message
  return t(`intake.consistency.rules.${finding.messageKey}`, finding.params)
}

export function ConflictFindings({
  definition,
  findings,
  saving,
  onRevise,
  onProceed,
}: {
  definition: ProjectIntakeDefinition
  findings: ConsistencyFinding[]
  saving: boolean
  onRevise: (stageIndex: number) => void
  onProceed: () => void
}) {
  const t = useTranslations(projectsCopy)
  return (
    <section
      aria-label={t('intake.consistency.title')}
      className="bg-card shadow-xs rounded-2xl border p-5"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="text-warning size-4 shrink-0 translate-y-0.5" aria-hidden />
        <div>
          <h3 className="text-sm font-semibold">{t('intake.consistency.title')}</h3>
          <p className="text-muted-foreground mt-0.5 text-sm">{t('intake.consistency.subtitle')}</p>
        </div>
      </div>

      <ul className="mt-4 space-y-3">
        {findings.map((finding, index) => {
          const isHard = finding.severity === 'inconsistency'
          const targetStage = resolveReviseStage(definition, finding)
          return (
            <li
              key={index}
              className={cn(
                'rounded-xl border px-4 py-3 text-sm',
                // `border-destructive` is a real theme colour (`--color-destructive`
                // in the `@theme inline` block), so its slash form compiles.
                // `border-warning` is a static `@utility` with no `--modifier()`,
                // so `border-warning/40` compiled to nothing and the soft-warning
                // row was outlined in the neutral default. The warning border token
                // is already ~55% alpha; the solid class is the intended edge.
                isHard
                  ? 'border-destructive/30 bg-danger-subtle text-destructive'
                  : 'border-warning bg-warning-subtle text-warning'
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-medium uppercase tracking-wide">
                  {isHard
                    ? t('intake.consistency.severity.inconsistency')
                    : t('intake.consistency.severity.warning')}
                </span>
                <button
                  type="button"
                  onClick={() => onRevise(targetStage)}
                  className="inline-flex items-center gap-1 text-xs font-medium underline-offset-2 hover:underline"
                >
                  <PencilLine className="size-3" aria-hidden />
                  {t('intake.consistency.revise')}
                </button>
              </div>
              <p className="text-foreground mt-1">{findingMessage(finding, t)}</p>
              {finding.fields.length > 0 && (
                <p className="text-muted-foreground mt-1.5 text-xs">{finding.fields.join(' · ')}</p>
              )}
            </li>
          )
        })}
      </ul>

      <div className="mt-4 flex items-center justify-end">
        <Button type="button" onClick={onProceed} disabled={saving} className="min-w-36">
          <Loader2
            className={
              saving ? 'size-4 animate-spin motion-reduce:animate-none' : 'size-4 opacity-0'
            }
            aria-hidden
          />
          {t('intake.consistency.proceed')}
        </Button>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Atomic field renderer — one per question type.
// ---------------------------------------------------------------------------
