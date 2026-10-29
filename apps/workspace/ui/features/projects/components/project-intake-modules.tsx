import { useState } from 'react'

import { useDelayedFlag } from '@/hooks/use-transient-flag'
import { Check, ChevronsUpDown, Loader2, Sparkles } from 'lucide-react'

import { AnimatePresence, motion, useIconSwapTransition } from '@/components/motion'

import { Button } from '@/components/ui/button'

import { SectionLabel } from '@/components/ui/section-label'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'

import { cn } from '@/lib/utils'

import type { ProjectIntakeStage } from '@/lib/project-profile/intake-types'

import { useTranslations } from '@/i18n'
import type { Translator } from '@/i18n'
import { commonCopy } from '@/i18n/namespaces/common'

/**
 * The intake's last press. Busy is not disabled: it keeps its focus while the
 * save runs (`aria-disabled`, and the form's submit handler swallows a second
 * press), and the spinner appears only once the wait has lasted 150 ms. When
 * the save lands, the glyph slot takes a check on the icon-swap spring: the
 * one physical cue of the intake, held for a beat before the project opens.
 */
export function SaveIntakeButton({ working, saved, label }: { working: boolean; saved: boolean; label: string }) {
  const showBusy = useDelayedFlag(working && !saved)
  const glyph = useIconSwapTransition()
  return (
    <Button
      type="submit"
      aria-disabled={working || saved || undefined}
      aria-busy={(working && !saved) || undefined}
      className="aria-disabled:cursor-default min-w-36 max-sm:flex-1"
    >
      <span className="relative inline-flex size-4 items-center justify-center" aria-hidden>
        <AnimatePresence mode="popLayout" initial={false}>
          {saved ? (
            <motion.span
              key="saved"
              className="inline-flex"
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1, transition: glyph.enter }}
            >
              <Check className="size-4" />
            </motion.span>
          ) : showBusy ? (
            <motion.span
              key="busy"
              className="inline-flex"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: glyph.enter }}
              exit={{ opacity: 0, transition: glyph.exit }}
            >
              <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
            </motion.span>
          ) : null}
        </AnimatePresence>
      </span>
      {label}
    </Button>
  )
}

// ---------------------------------------------------------------------------
// Module rail — the wizard's primary orientation surface.
// ---------------------------------------------------------------------------

/**
 * The A–I module list: a persistent rail beside the questions from `lg`, and
 * the same rows in a bottom sheet below it ({@link ModulePicker}).
 *
 * Each row carries the module's real title and its answered/total count, which
 * is the pair that answers "where am I and what is left" at a glance. The
 * horizontal stepper this replaced could show neither: at eight modules across
 * a 3xl column every label truncated to about eight characters, so the nav read
 * "Grundstück …", "Technik & En…", "Zusammenfa…" — three labels that are the
 * same word to a reader scanning for where to click. Its phone form, a strip of
 * 80px tiles, was that problem again: four of nine modules on screen, 11px
 * labels, and a row of chrome above the first question.
 *
 * Rows stay reachable in BOTH directions. Forward navigation to an unvisited
 * module is deliberate: the spec's validation is soft everywhere but A1/A2/A5,
 * so a locked-until-complete rail would enforce a gate the questionnaire does
 * not have, and an architect who wants to fill in the Bauwerk geometry first
 * should be able to.
 */
export function ModuleRail({
  stages,
  currentStep,
  progress,
  onSelect,
  t,
}: {
  stages: ProjectIntakeStage[]
  currentStep: number
  progress: Map<string, { answered: number; total: number }>
  onSelect: (step: number) => void
  t: Translator
}) {
  return (
    <nav aria-label={t('intake.moduleNavAria')} className="hidden lg:sticky lg:top-6 lg:block">
      <SectionLabel className="mb-2">{t('intake.moduleNav')}</SectionLabel>
      <ModuleList
        stages={stages}
        currentStep={currentStep}
        progress={progress}
        onSelect={onSelect}
        t={t}
      />
    </nav>
  )
}

export function ModuleList({
  stages,
  currentStep,
  progress,
  onSelect,
  t,
  touch = false,
}: {
  stages: ProjectIntakeStage[]
  currentStep: number
  progress: Map<string, { answered: number; total: number }>
  onSelect: (step: number) => void
  t: Translator
  /** Finger-sized rows (the sheet) instead of the rail's dense ones. */
  touch?: boolean
}) {
  return (
    <ol className="flex flex-col gap-0.5">
      {stages.map((stage, index) => {
        const state = index < currentStep ? 'visited' : index === currentStep ? 'current' : 'upcoming'
        const counts = progress.get(stage.id)
        const complete = counts !== undefined && counts.total > 0 && counts.answered === counts.total
        return (
          <li key={stage.id}>
            <button
              type="button"
              onClick={() => onSelect(index)}
              aria-current={state === 'current' ? 'step' : undefined}
              className={cn(
                'duration-quick focus-visible:ring-ring/40 group flex w-full items-center gap-2.5 rounded-control px-2 py-2 text-left outline-none transition-colors ease-out focus-visible:ring-2 motion-reduce:transition-none',
                touch && 'min-h-12 px-3',
                state === 'current' ? 'bg-muted' : 'hover:bg-muted/50'
              )}
            >
              <span
                className={cn(
                  'duration-quick flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-medium transition-colors ease-out motion-reduce:transition-none',
                  complete && state !== 'current' && 'border-primary bg-primary text-primary-foreground',
                  state === 'current' && 'border-primary text-primary ring-ring/30 ring-2',
                  !complete && state !== 'current' && 'border-border text-muted-foreground'
                )}
              >
                {/* The step NUMBER, not `stage.id`. Modul I (Projektgrundlagen)
                    deliberately runs before Modul H (Zusammenfassung) — the
                    documents are inputs to the B and C answers, and the
                    summary is the save gate, so it has to be last — which
                    makes a letter column read "… G, I, H" and look like a
                    bug. The letter still anchors the content header, where it
                    ties back to the spec. */}
                {complete && state !== 'current' ? <Check className="size-3.5" aria-hidden /> : index + 1}
              </span>
              <span className="flex min-w-0 flex-col">
                <span
                  className={cn(
                    'block truncate text-sm',
                    state === 'current' ? 'text-foreground font-medium' : 'text-muted-foreground'
                  )}
                >
                  {stage.title}
                </span>
                {counts !== undefined && counts.total > 0 && (
                  <span className="text-muted-foreground text-xs">
                    {complete
                      ? t('intake.moduleDone')
                      : t('intake.moduleProgress', { answered: counts.answered, total: counts.total })}
                  </span>
                )}
              </span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}

/**
 * The module list below `lg`: one 44px bar — „Modul C · 3/9" — that opens the
 * list in a bottom sheet. A selection among nine named places is a choice you
 * make and leave, which is what a sheet is for; the questions stay where they
 * were behind it. Choosing a module closes the sheet.
 */
export function ModulePicker({
  stages,
  currentStep,
  progress,
  onSelect,
  t,
}: {
  stages: ProjectIntakeStage[]
  currentStep: number
  progress: Map<string, { answered: number; total: number }>
  onSelect: (step: number) => void
  t: Translator
}) {
  const tCommon = useTranslations(commonCopy)
  const [open, setOpen] = useState(false)
  const stage = stages[currentStep]
  if (!stage) return null
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          data-testid="intake-module-picker"
          aria-label={t('intake.modulePickerAria', { module: stage.id, title: stage.title })}
          className="border-border bg-card focus-visible:ring-ring/40 mb-3 flex min-h-11 w-full items-center gap-3 rounded-control border px-3.5 text-left outline-none focus-visible:ring-2 lg:hidden"
        >
          {/* Two spans: the content header below `lg` carries the same „Modul B“
              as one text node, and a screen that has the bar and the header at
              once (a tablet in portrait, a test) should find it once. */}
          <span className="text-primary font-mono text-xs">
            <span>Modul</span> <span>{stage.id}</span>
          </span>
          <span className="text-muted-foreground flex-1 text-xs tabular-nums">
            {currentStep + 1}/{stages.length}
          </span>
          <ChevronsUpDown className="text-muted-foreground size-4" aria-hidden />
        </button>
      </SheetTrigger>
      <SheetContent side="bottom" closeLabel={tCommon('actions.close')} className="gap-3 pb-[max(1.5rem,env(safe-area-inset-bottom))] lg:hidden">
        <SheetHeader>
          <SheetTitle>{t('intake.moduleNav')}</SheetTitle>
          <SheetDescription className="sr-only">{t('intake.moduleNavAria')}</SheetDescription>
        </SheetHeader>
        <ModuleList
          stages={stages}
          currentStep={currentStep}
          progress={progress}
          onSelect={(step) => {
            setOpen(false)
            onSelect(step)
          }}
          t={t}
          touch
        />
      </SheetContent>
    </Sheet>
  )
}

/**
 * Schnellstart switch (spec `core_flag`).
 *
 * A view, not a second answer state: it narrows each module to its Kernfragen,
 * and everything it hides is already what an unanswered question becomes — an
 * unknown. That is why turning it off cannot lose an answer, and why the copy
 * can promise the skipped questions come back in the summary's checklist.
 */
export function QuickStartToggle({
  enabled,
  onToggle,
  t,
}: {
  enabled: boolean
  onToggle: () => void
  t: Translator
}) {
  return (
    <div className="flex items-start gap-3">
      <Button
        type="button"
        variant={enabled ? 'default' : 'outline'}
        size="sm"
        onClick={onToggle}
        aria-pressed={enabled}
        // The explanation is beside the switch from `sm`; on a phone it is the
        // switch's description, and the module itself says what it hides
        // („n weitere Fragen im Schnellstart ausgeblendet").
        aria-describedby="intake-schnellstart-hint"
        className="shrink-0"
      >
        <Sparkles className="size-4" aria-hidden />
        {t('intake.quickStart')}
      </Button>
      <p id="intake-schnellstart-hint" className="text-muted-foreground max-w-[24rem] text-xs leading-snug sr-only sm:[@media(min-height:32rem)]:not-sr-only">
        {enabled ? t('intake.quickStartOn') : t('intake.quickStartOff')}
      </p>
    </div>
  )
}
