'use client'

/**
 * The setup's chrome (ticket 26, `docs/design/project-setup-five-steps.md`):
 * one slim bar on top, one footer at the bottom, the step scrolling between.
 *
 * Every step fits a screen and has ONE primary action, and it always sits in
 * the same place: the footer's right edge on a desk, the footer's full width on
 * a phone. A step says what that action is with {@link StepFooter}, which hands
 * it to the frame the way `ProjectSectionActions` hands the section head its
 * button; a step that says nothing gets „Weiter zu <next step>".
 */

import type { JSX, ReactNode } from 'react'
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { ArrowRight, Check, ChevronDown, ChevronLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import { SETUP_STEP_IDS, type SetupStepId, type SetupStepSummary } from './steps/types'

/** How far a step's own round has come, drawn in the footer on a desk and under the bar on a phone. */
export interface StepProgress {
  done: number
  total: number
  /** Said aloud and shown beside the bar on a desk, e.g. „1 von 6 erledigt". */
  label: string
}

/** What a step puts in the frame's footer. */
export interface StepFooterContent {
  /** The one primary action. Absent: the frame's own „Weiter zu …". */
  primary?: ReactNode
  /** A quiet second way on, left on a desk and under the primary on a phone („Ohne Unterlagen weiter"). */
  aside?: ReactNode
  /** One sentence beside the step count, on a desk only. */
  note?: ReactNode
  progress?: StepProgress
}

type SlotName = 'primary' | 'asideDesk' | 'asidePhone' | 'note'

/**
 * How a step reaches the footer. The nodes travel by portal into the footer's
 * slots, so a step re-rendering never re-renders the frame; only plain data
 * (the progress, whether the step brought its own action) is frame state.
 */
interface FooterChannel {
  slots: Partial<Record<SlotName, HTMLElement>>
  setProgress: (progress: StepProgress | null) => void
  setOwnsPrimary: (owns: boolean) => void
}

const FooterContext = createContext<FooterChannel | null>(null)

/** The frame's side of the channel: the slot elements and the two pieces of data. */
export function useStepFooterChannel(): {
  channel: FooterChannel
  progress: StepProgress | null
  ownsPrimary: boolean
  slotRef: (name: SlotName) => (element: HTMLElement | null) => void
} {
  const [slots, setSlots] = useState<Partial<Record<SlotName, HTMLElement>>>({})
  const [progress, setProgress] = useState<StepProgress | null>(null)
  const [ownsPrimary, setOwnsPrimary] = useState(false)
  const channel = useMemo(() => ({ slots, setProgress, setOwnsPrimary }), [slots])
  // One stable ref per slot: a fresh callback each render would detach and
  // re-attach the slot, and each of those is a state change.
  const refs = useMemo(() => {
    const attach = (name: SlotName) => (element: HTMLElement | null) =>
      setSlots((current) =>
        current[name] === (element ?? undefined) ? current : { ...current, [name]: element ?? undefined }
      )
    return { primary: attach('primary'), asideDesk: attach('asideDesk'), asidePhone: attach('asidePhone'), note: attach('note') }
  }, [])
  const slotRef = useCallback((name: SlotName) => refs[name], [refs])
  return { channel, progress, ownsPrimary, slotRef }
}

export const StepFooterProvider = FooterContext.Provider

/** A step's footer, drawn by the frame wherever the step places it. */
export function StepFooter({ primary, aside, note, progress }: StepFooterContent): JSX.Element | null {
  const channel = useContext(FooterContext)
  const setProgress = channel?.setProgress
  const setOwnsPrimary = channel?.setOwnsPrimary
  const hasProgress = progress !== undefined
  const done = progress?.done ?? 0
  const total = progress?.total ?? 0
  const label = progress?.label ?? ''
  const ownsPrimary = primary !== undefined && primary !== null
  useLayoutEffect(() => {
    setProgress?.(hasProgress ? { done, total, label } : null)
    return () => setProgress?.(null)
  }, [setProgress, hasProgress, done, total, label])
  useLayoutEffect(() => {
    setOwnsPrimary?.(ownsPrimary)
    return () => setOwnsPrimary?.(false)
  }, [setOwnsPrimary, ownsPrimary])
  if (!channel) return null
  const { slots } = channel
  return (
    <>
      {ownsPrimary && slots.primary && createPortal(primary, slots.primary)}
      {aside && slots.asideDesk && createPortal(aside, slots.asideDesk)}
      {aside && slots.asidePhone && createPortal(aside, slots.asidePhone)}
      {note && slots.note && createPortal(<> · {note}</>, slots.note)}
    </>
  )
}

interface BarProps {
  projectId: string
  projectName?: string
  step: SetupStepId
  summaries: readonly SetupStepSummary[]
  progress?: StepProgress
  onGoTo: (step: SetupStepId) => void
}

function overviewHref(projectId: string): string {
  return `/app/projects/${encodeURIComponent(projectId)}/settings`
}

/**
 * The bar on top. On a desk: where (Einrichtung, the project), the five steps
 * inline, and the way out. On a phone: back, the step with its count (a menu of
 * all five), and the step's own progress under it.
 */
export function SetupBar({ projectId, projectName, step, summaries, progress, onGoTo }: BarProps): JSX.Element {
  const tShell = useTranslations('intakeShell')
  const index = SETUP_STEP_IDS.indexOf(step)
  const total = SETUP_STEP_IDS.length
  return (
    <header className="bg-background/95 border-border shrink-0 border-b" data-testid="intake-setup-head">
      <div className="hidden h-16 items-center gap-7 px-8 md:flex">
        <div className="w-52 min-w-0 shrink-0">
          <p className="text-muted-foreground text-[11px] uppercase tracking-[0.06em]">{tShell('head.eyebrow')}</p>
          {projectName && <p className="truncate text-[15px] font-semibold">{projectName}</p>}
        </div>
        <StepRail step={step} summaries={summaries} onGoTo={onGoTo} />
        <Link
          href={overviewHref(projectId)}
          aria-label={tShell('head.laterAria')}
          className="text-muted-foreground hover:text-foreground shrink-0 whitespace-nowrap text-[13px] underline-offset-4 hover:underline"
        >
          {tShell('head.later')}
        </Link>
      </div>

      <div className="px-4 pb-3 pt-3 md:hidden">
        <div className="flex items-center justify-between">
          <Link
            href={overviewHref(projectId)}
            aria-label={tShell('head.laterAria')}
            className="-ml-2 flex size-11 items-center justify-center"
          >
            <ChevronLeft className="size-5" aria-hidden />
          </Link>
          <DropdownMenu>
            <DropdownMenuTrigger
              className="flex min-h-11 flex-col items-center justify-center rounded-md px-2"
              aria-label={tShell('head.stepMenu', {
                current: index + 1,
                total,
                step: tShell(`steps.${step}`),
              })}
            >
              <span className="text-muted-foreground text-[11px] uppercase tracking-[0.06em]">
                {tShell('steps.progress', { current: index + 1, total })}
              </span>
              <span className="flex items-center gap-1 text-[15px] font-semibold">
                {tShell(`steps.${step}`)}
                <ChevronDown className="text-muted-foreground size-3.5" aria-hidden />
              </span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center" className="w-56">
              {summaries.map((summary, i) => (
                <DropdownMenuItem
                  key={summary.id}
                  onSelect={() => onGoTo(summary.id)}
                  aria-current={summary.id === step ? 'step' : undefined}
                  className="min-h-11"
                >
                  <span className="text-muted-foreground w-4 tabular-nums">{i + 1}</span>
                  <span className={cn('flex-1', summary.id === step && 'font-semibold')}>
                    {tShell(`steps.${summary.id}`)}
                  </span>
                  {summary.note && <span className="text-muted-foreground text-xs">{summary.note}</span>}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <span className="text-muted-foreground w-11 text-right text-[13px] tabular-nums">
            {progress ? `${progress.done}/${progress.total}` : ''}
          </span>
        </div>
        {progress && <ProgressLine progress={progress} className="mt-2.5" />}
      </div>
    </header>
  )
}

/**
 * The five steps in a row. A step before the shown one that asks nothing more
 * carries a check; one that still asks something keeps its number, so a jump
 * ahead never passes for having finished what was skipped.
 */
function StepRail({
  step,
  summaries,
  onGoTo,
}: {
  step: SetupStepId
  summaries: readonly SetupStepSummary[]
  onGoTo: (step: SetupStepId) => void
}): JSX.Element {
  const tShell = useTranslations('intakeShell')
  const current = SETUP_STEP_IDS.indexOf(step)
  return (
    <nav aria-label={tShell('steps.label')} className="min-w-0 flex-1">
      <ol className="flex items-center gap-2.5">
        {summaries.map((summary, i) => {
          const active = i === current
          const done = i < current && !summary.open
          const label = tShell(`steps.${summary.id}`)
          return (
            <li key={summary.id} className={cn('flex items-center gap-2.5', i < summaries.length - 1 && 'flex-1')}>
              <button
                type="button"
                onClick={() => onGoTo(summary.id)}
                aria-current={active ? 'step' : undefined}
                aria-label={summary.note ? `${i + 1}. ${label} — ${summary.note}` : `${i + 1}. ${label}`}
                title={summary.note}
                className={cn(
                  'focus-visible:ring-ring/60 flex shrink-0 items-center gap-2 rounded-md text-[13px] focus-visible:outline-none focus-visible:ring-2',
                  active ? 'text-foreground font-medium' : done ? 'text-foreground' : 'text-muted-foreground',
                  'hover:text-foreground',
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'flex size-[22px] items-center justify-center rounded-full border text-[11px] font-semibold tabular-nums',
                    active && 'border-primary bg-primary text-primary-foreground',
                    done && 'border-primary text-foreground bg-card',
                    !active && !done && 'border-border bg-card text-muted-foreground',
                  )}
                >
                  {done ? <Check className="size-3" strokeWidth={3} /> : i + 1}
                </span>
                <span className="whitespace-nowrap">{label}</span>
              </button>
              {i < summaries.length - 1 && (
                <span aria-hidden className={cn('h-px min-w-4 flex-1', i < current ? 'bg-primary' : 'bg-border')} />
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

function ProgressLine({ progress, className }: { progress: StepProgress; className?: string }): JSX.Element {
  const share = progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0
  return <Progress value={share} aria-label={progress.label} className={cn('bg-border h-1', className)} />
}

/**
 * The footer: where the person is on the left, the one way on at the right.
 * On a phone the way on takes the full width and the count lives in the bar.
 */
export function SetupFooter({
  step,
  progress,
  ownsPrimary,
  slotRef,
  onNext,
}: {
  step: SetupStepId
  progress: StepProgress | null
  ownsPrimary: boolean
  slotRef: (name: SlotName) => (element: HTMLElement | null) => void
  onNext?: () => void
}): JSX.Element {
  const tShell = useTranslations('intakeShell')
  const index = SETUP_STEP_IDS.indexOf(step)
  const next = SETUP_STEP_IDS[index + 1]
  return (
    <footer
      className="bg-background/95 border-border shrink-0 border-t px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 md:flex md:h-[72px] md:items-center md:justify-between md:gap-6 md:px-8 md:py-0"
      data-testid="intake-setup-footer"
    >
      <div className="hidden min-w-0 items-center gap-4 md:flex">
        <span className="text-muted-foreground min-w-0 text-[13px]">
          {tShell('steps.progress', { current: index + 1, total: SETUP_STEP_IDS.length })}
          <span ref={slotRef('note')} />
        </span>
        {progress && (
          <>
            <ProgressLine progress={progress} className="w-[120px] shrink-0" />
            <span className="text-muted-foreground shrink-0 text-[13px] tabular-nums">{progress.label}</span>
          </>
        )}
        <span ref={slotRef('asideDesk')} className="shrink-0 empty:hidden" />
      </div>
      <div className="flex flex-col gap-1.5 md:shrink-0 md:flex-row md:items-center">
        <div ref={slotRef('primary')} className="contents [&>*]:w-full md:[&>*]:w-auto" />
        {!ownsPrimary && next && onNext && (
          <Button type="button" onClick={onNext} className={PRIMARY_ACTION_CLASS}>
            {tShell('footer.next', { step: tShell(`steps.${next}`) })}
            <ArrowRight aria-hidden />
          </Button>
        )}
        <div ref={slotRef('asidePhone')} className="flex justify-center empty:hidden md:hidden" />
      </div>
    </footer>
  )
}

/** The footer's primary action, styled once: 50px and full width under a thumb, 42px on a desk. */
export const PRIMARY_ACTION_CLASS =
  'h-[50px] w-full rounded-xl text-base md:h-[42px] md:w-auto md:rounded-[9px] md:px-5 md:text-sm'

/** The footer's quiet second way on: a text link. */
export const ASIDE_ACTION_CLASS =
  'text-muted-foreground hover:text-foreground min-h-11 text-[15px] underline-offset-4 hover:underline md:min-h-0 md:text-[13px] md:underline'
