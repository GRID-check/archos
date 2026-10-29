/**
 * The Rechercheplan card: the plan as controls, not as a list to say yes to.
 *
 * The backend's plan preview carries the plan as data beside its text
 * (`clarify.format_plan_for_user`, the `plan_json` fence). This renders the
 * sections as a checklist the reader can strike and extend, and the genre
 * and depth as choices, and hands the edited plan back to the approval
 * button: an approval without edits sends the bare keyword the backend has
 * always understood; an approval with edits sends the keyword and the edits
 * as JSON (`clarify.parse_plan_reply`).
 */

import type { JSX } from 'react'
import { useState, type FC } from 'react'
import { BookOpen, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { Input } from '@/components/ui/input'
import { DocumentsDialog } from '@/features/runs/components/DocumentsDialog'
import { useTranslations } from '@/i18n'
import { chatCopy } from '@/i18n/namespaces/chat'
import { planDocumentLabel, sanitizePlanDocuments, type PlanDocument } from '@/lib/runs/plan-documents'
import { modernizePlan } from '@/lib/runs/plan-vocabulary'
import { cn } from '@/lib/utils'

export const PLAN_GENRES = [
  'inspection_report',
  'file_note',
  'comparison',
  'checklist',
  'report',
] as const
export type PlanGenre = (typeof PLAN_GENRES)[number]
export const PLAN_DEPTHS = ['quick_check', 'expert_report'] as const
export type PlanDepth = (typeof PLAN_DEPTHS)[number]

export interface PlanShape {
  title: string
  sections: string[]
  genre: PlanGenre
  depth: PlanDepth
  /** File names the run must read in full, from the inventory below. */
  basis: string[]
  /** File names the run may not use. */
  excluded: string[]
  /** What the run can read: the turn's inventory, as the backend listed it. */
  documents: PlanDocument[]
}

/** The source ids the composer shows: the Rahmen the run is approved under. */
export interface PlanFrame {
  ids: string[]
  labels: string[]
}

const PLAN_FENCE_RE = /```plan_json\s*\n([\s\S]*?)\n```/

/** The plan the fence carries, or null when there is none or it is unreadable. */
export function parsePlanFence(content: string): PlanShape | null {
  const match = PLAN_FENCE_RE.exec(content)
  if (!match?.[1]) return null
  try {
    const raw = modernizePlan(JSON.parse(match[1])) as Record<string, unknown>
    const sections = Array.isArray(raw.sections)
      ? raw.sections.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      : []
    if (typeof raw.title !== 'string' || sections.length === 0) return null
    const genre = (PLAN_GENRES as readonly string[]).includes(String(raw.genre))
      ? (raw.genre as PlanGenre)
      : 'report'
    const depth = (PLAN_DEPTHS as readonly string[]).includes(String(raw.depth))
      ? (raw.depth as PlanDepth)
      : 'expert_report'
    const names = (value: unknown): string[] =>
      Array.isArray(value)
        ? value.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        : []
    const documents = sanitizePlanDocuments({ basis: raw.documents })?.basis ?? []
    return {
      title: raw.title,
      sections,
      genre,
      depth,
      basis: names(raw.basis),
      excluded: names(raw.excluded),
      documents: documents,
    }
  } catch {
    return null
  }
}

/** The content without the fence, for the bubble's text. */
export const stripPlanFence = (content: string): string => content.replace(PLAN_FENCE_RE, '').trim()

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((item, index) => item === b[index])

/**
 * The reply for an approval: bare when nothing changed and no Rahmen is
 * known, with the edits otherwise. The Rahmen — the composer's sources at the
 * moment of approval — always travels when there is one, because the run
 * has to know what the composer showed; an empty selection sends nothing and
 * leaves the turn's own sources in force.
 */
export function approvalReply(
  original: PlanShape,
  edited: PlanShape,
  dataSources: readonly string[] = []
): string {
  const same =
    original.genre === edited.genre &&
    original.depth === edited.depth &&
    sameList(original.sections, edited.sections) &&
    sameList(original.basis, edited.basis) &&
    sameList(original.excluded, edited.excluded)
  if (same && dataSources.length === 0) return 'approve'
  return `approve ${JSON.stringify({
    sections: edited.sections,
    genre: edited.genre,
    depth: edited.depth,
    basis: edited.basis,
    excluded: edited.excluded,
    ...(dataSources.length > 0 ? { data_sources: [...dataSources] } : {}),
  })}`
}

/**
 * The plan an approval reply carries: `original` with the edits
 * {@link approvalReply} put beside the keyword, each field taken only when it
 * has the shape it was sent in. A bare keyword, or a reply that is not an
 * approval, is the original. What lets an answered prompt show the plan that
 * was approved after a reload, when the reader's edits are no longer in state.
 */
export function planFromReply(original: PlanShape, reply: string | undefined): PlanShape {
  const match = /^\s*approve\s+(\{[\s\S]*\})\s*$/i.exec(reply ?? '')
  if (!match?.[1]) return original
  let edits: Record<string, unknown>
  try {
    edits = modernizePlan(JSON.parse(match[1])) as Record<string, unknown>
  } catch {
    return original
  }
  const strings = (value: unknown): string[] | undefined =>
    Array.isArray(value) && value.every((item) => typeof item === 'string') ? (value as string[]) : undefined
  const sections = strings(edits.sections)
  return {
    ...original,
    ...(sections && sections.length > 0 ? { sections } : {}),
    ...((PLAN_GENRES as readonly unknown[]).includes(edits.genre) ? { genre: edits.genre as PlanGenre } : {}),
    ...((PLAN_DEPTHS as readonly unknown[]).includes(edits.depth) ? { depth: edits.depth as PlanDepth } : {}),
    ...(strings(edits.basis) ? { basis: strings(edits.basis)! } : {}),
    ...(strings(edits.excluded) ? { excluded: strings(edits.excluded)! } : {}),
  }
}

export const PlanChecklist: FC<{
  plan: PlanShape
  disabled?: boolean
  /** The composer's sources, shown as the Rahmen the run is approved under. */
  frame?: PlanFrame
  onChange: (plan: PlanShape) => void
}> = ({ plan, disabled = false, frame, onChange }) => {
  const t = useTranslations(chatCopy)
  const [draft, setDraft] = useState('')
  const [picking, setPicking] = useState(false)
  const labelOf = (name: string): string => {
    const key = name.trim().toLocaleLowerCase()
    const doc = plan.documents.find((row) => row.name.trim().toLocaleLowerCase() === key)
    return doc ? planDocumentLabel(doc) : name
  }
  const dropName = (list: 'basis' | 'excluded', name: string): void =>
    onChange({ ...plan, [list]: plan[list].filter((item) => item !== name) })

  const remove = (index: number) =>
    onChange({ ...plan, sections: plan.sections.filter((_, i) => i !== index) })
  const add = () => {
    const text = draft.trim()
    if (!text) return
    onChange({ ...plan, sections: [...plan.sections, text] })
    setDraft('')
  }

  return (
    <div className="flex flex-col gap-3" data-testid="plan-checklist">
      <div className="flex flex-col gap-1.5">
        <span className="text-muted-foreground text-xs font-medium">
          {t('agentPrompt.plan.points')}
        </span>
        <ul className="flex flex-col gap-1" aria-label={t('agentPrompt.plan.points')}>
          {plan.sections.map((section, index) => (
            <li
              key={`${index}-${section}`}
              className="flex items-center gap-2 text-sm"
              data-testid="plan-point"
            >
              <span className="flex-1">{section}</span>
              {!disabled && plan.sections.length > 1 && (
                <button
                  type="button"
                  onClick={() => remove(index)}
                  aria-label={t('agentPrompt.plan.removePoint', { point: section })}
                  // A 14px glyph is the drawn control; under a finger the button
                  // is the 44px square the list row gives it room for. The rows
                  // sit a line apart, so it GROWS (the Touch rule) rather than
                  // overhanging into the row below.
                  className="rounded-control text-muted-foreground hover:text-foreground focus-visible:ring-ring/60 inline-flex shrink-0 items-center justify-center focus-visible:outline-none focus-visible:ring-2 pointer-coarse:size-11"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ul>
        {!disabled && (
          <div className="flex items-center gap-2">
            {/* The Input atom, not a bare field: it carries the 16px type a soft
                keyboard needs (iOS zooms into anything smaller and stays there)
                and the 44px touch height, both on coarse pointers only. */}
            <Input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  add()
                }
              }}
              placeholder={t('agentPrompt.plan.addPlaceholder')}
              aria-label={t('agentPrompt.plan.addPoint')}
              className="h-8 flex-1 px-2 pointer-coarse:h-11"
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="pointer-coarse:size-11 h-8 px-2"
              onClick={add}
              aria-label={t('agentPrompt.plan.addPoint')}
            >
              <Plus className="size-3.5" aria-hidden />
            </Button>
          </div>
        )}
      </div>
      <ChoiceRow
        label={t('agentPrompt.plan.genre')}
        options={PLAN_GENRES}
        value={plan.genre}
        disabled={disabled}
        labelFor={(genre) => t(`agentPrompt.plan.genres.${genre}`)}
        onPick={(genre) => onChange({ ...plan, genre })}
      />
      <ChoiceRow
        label={t('agentPrompt.plan.depth')}
        options={PLAN_DEPTHS}
        value={plan.depth}
        disabled={disabled}
        labelFor={(depth) => t(`agentPrompt.plan.depths.${depth}`)}
        onPick={(depth) => onChange({ ...plan, depth })}
      />
      {/* The Unterlagen: what the run must read, and what it may not use. A
          picker over the thread names them; the chips here are the receipt of
          that choice, each one strikable. Shown whenever the turn has something
          to name, so the section is where the reader learns it can be done. */}
      {(plan.documents.length > 0 || plan.basis.length > 0 || plan.excluded.length > 0) && (
        <div className="flex flex-col gap-1.5" data-testid="plan-documents">
          <span className="text-muted-foreground text-xs font-medium">
            {t('agentPrompt.plan.documents.label')}
          </span>
          <NamedRow
            label={t('agentPrompt.plan.documents.basis')}
            names={plan.basis}
            labelOf={labelOf}
            disabled={disabled}
            variant="default"
            removeLabel={(name) => t('agentPrompt.plan.documents.removeRead', { name })}
            onRemove={(name) => dropName('basis', name)}
            testId="plan-basis"
          />
          <NamedRow
            label={t('agentPrompt.plan.documents.excluded')}
            names={plan.excluded}
            labelOf={labelOf}
            disabled={disabled}
            variant="destructive"
            removeLabel={(name) => t('agentPrompt.plan.documents.removeExcluded', { name })}
            onRemove={(name) => dropName('excluded', name)}
            testId="plan-excluded"
          />
          {plan.basis.length === 0 && plan.excluded.length === 0 && (
            <span className="text-muted-foreground text-xs">
              {t('agentPrompt.plan.documents.none')}
            </span>
          )}
          {!disabled && plan.documents.length > 0 && (
            <div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 gap-1 px-2 text-xs pointer-coarse:h-11 pointer-coarse:px-3"
                onClick={() => setPicking(true)}
                data-testid="plan-documents-pick"
              >
                <BookOpen className="size-3.5" aria-hidden />
                {t('agentPrompt.plan.documents.choose')}
              </Button>
              <DocumentsDialog
                mode="pick"
                open={picking}
                onOpenChange={setPicking}
                documents={plan.documents}
                basis={plan.basis}
                excluded={plan.excluded}
                onChange={(next) => onChange({ ...plan, ...next })}
              />
            </div>
          )}
        </div>
      )}
      {/* The Rahmen: read-only here, because it IS the composer's Datengrundlage
          — the same chips one row below the thread. Changing it there changes
          what the run gets; this only says so. */}
      {frame && frame.labels.length > 0 && (
        <div className="flex flex-col gap-1.5" data-testid="plan-frame">
          <span className="text-muted-foreground text-xs font-medium">
            {t('agentPrompt.plan.frame')}
          </span>
          <div className="flex flex-wrap gap-1.5">
            {frame.labels.map((label) => (
              <Chip key={label} size="sm" variant="secondary">
                {label}
              </Chip>
            ))}
          </div>
          {!disabled && (
            <span className="text-muted-foreground text-xs">
              {t('agentPrompt.plan.frameNote')}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

const NamedRow: FC<{
  label: string
  names: readonly string[]
  labelOf: (name: string) => string
  disabled: boolean
  variant: 'default' | 'destructive'
  removeLabel: (name: string) => string
  onRemove: (name: string) => void
  testId: string
}> = ({ label, names, labelOf, disabled, variant, removeLabel, onRemove, testId }) => {
  if (names.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5 pointer-coarse:gap-2" data-testid={testId}>
      <span className="text-muted-foreground text-xs">{label}</span>
      {names.map((name) => (
        // Under a finger the chip is as tall as the remove button inside it
        // (44px), and the button is the chip's own right-hand end: chips wrap a
        // few pixels apart, so the control grows rather than overhanging.
        <Chip
          key={name}
          size="sm"
          variant={variant}
          title={name}
          className={cn(!disabled && 'pointer-coarse:h-11 pointer-coarse:pr-0 pointer-coarse:pl-3')}
        >
          {labelOf(name)}
          {!disabled && (
            <button
              type="button"
              onClick={() => onRemove(name)}
              aria-label={removeLabel(labelOf(name))}
              className="rounded-control duration-quick ml-0.5 inline-flex items-center justify-center opacity-70 transition-opacity ease-out hover:opacity-100 focus-visible:outline-none pointer-coarse:ml-0 pointer-coarse:size-11"
            >
              <X className="size-3" aria-hidden />
            </button>
          )}
        </Chip>
      ))}
    </div>
  )
}

function ChoiceRow<T extends string>({
  label,
  options,
  value,
  disabled,
  labelFor,
  onPick,
}: {
  label: string
  options: readonly T[]
  value: T
  disabled: boolean
  labelFor: (option: T) => string
  onPick: (option: T) => void
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-muted-foreground text-xs font-medium">{label}</span>
      <div className="flex flex-wrap gap-1.5 pointer-coarse:gap-2" role="radiogroup" aria-label={label}>
        {options.map((option) => {
          const selected = option === value
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onPick(option)}
              className={cn(
                // The chip inside is the drawn control (24px); the button is its
                // 44px box under a finger, the chips a row apart in a wrapping row.
                'focus-visible:ring-ring/60 inline-flex items-center rounded-control focus-visible:outline-none focus-visible:ring-2 pointer-coarse:min-h-11',
                disabled && 'cursor-default'
              )}
            >
              <Chip size="md" variant={selected ? 'default' : 'outline'}>
                {labelFor(option)}
              </Chip>
            </button>
          )
        })}
      </div>
    </div>
  )
}
