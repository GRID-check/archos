

import { AlertTriangle, Loader2 } from 'lucide-react'

import { AnimatePresence, motion, motionInstant } from '@/components/motion'
import { LoadError } from '@/components/ui/load-error'
import { Alert, AlertDescription } from '@/components/ui/alert'

import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { SectionLabel } from '@/components/ui/section-label'

import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

import { ProjectBasisStep } from './project-basis-step'

import { isQuestionSatisfied, validationMessage } from './project-intake-helpers'
import { SaveIntakeButton, ModuleRail, ModulePicker, QuickStartToggle } from './project-intake-modules'
import { BuildingStage } from './project-intake-buildings'
import { ReviewStep, ConflictFindings } from './project-intake-review'
import { QuestionField } from './project-intake-fields'

import type { ProjectIntakeWizardController } from './use-project-intake-wizard-controller'

export function ProjectIntakeWizardView({ controller }: { controller: ProjectIntakeWizardController }) {
  const { addBuilding, answers, buildings, checking, conflict, currentStep, deferBind, deferredUploads, definition, directionRef, discardPendingBind, draftSaved, error, findings, flatVisibleQuestions, goToStep, handleNext, handleProceedAnyway, handleReviseAt, handleSave, hiddenByQuickStart, isBasis, isEdit, isReview, loading, pendingBinds, progress, projectId, projectName, quickStart, quickStartStage, reloadAfterConflict, removeBuilding, renameBuilding, retryLoad, salvageNotice, saved, savedBuildingIds, saving, setAnswer, setExpandedStages, setMode, setQuickStart, skipRestOfStage, stage, stageProgress, stages, stepEnter, t, totalSteps, touched } = controller
  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6 md:py-12">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="mt-4 h-2 w-full" />
        <Skeleton className="mt-8 h-6 w-56" />
        <div className="mt-6 space-y-6">
          {[0, 1, 2].map((i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-9 w-full" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (error && !definition) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6 md:py-12">
        <LoadError title={error} onRetry={retryLoad} />
      </div>
    )
  }

  if (!definition || !stage) return null
  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:py-10">
      {/* One line on a phone: the project, and the Schnellstart switch beside
          it. The eyebrow stays; the subtitle (what the briefing is for, and how
          long it takes) is read once and cost about 60px above the first
          question on every module. „Roomy“ is wide AND tall: a phone on its
          side is 852px wide and 393px high, and keeps the compact form, because
          its scarce axis is the vertical one (`sm:` alone cannot say that). */}
      <header className="mb-4 flex min-w-0 items-center justify-between gap-x-6 gap-y-3 sm:[@media(min-height:32rem)]:mb-6 sm:[@media(min-height:32rem)]:flex-wrap sm:[@media(min-height:32rem)]:items-end">
        <div className="min-w-0">
          <SectionLabel>
            {isEdit ? t('intake.eyebrowEdit') : t('intake.eyebrowCreate')}
          </SectionLabel>
          <h1 className="mt-1 truncate text-xl font-medium">
            {projectName || t('intake.titleFallback')}
          </h1>
          <p className="text-muted-foreground mt-1 hidden max-w-prose text-sm sm:[@media(min-height:32rem)]:block">
            {t('intake.subtitle')}
          </p>
        </div>
        <QuickStartToggle
          enabled={quickStart}
          onToggle={() => {
            setQuickStart((previous) => !previous)
            setExpandedStages(new Set())
          }}
          t={t}
        />
      </header>

      {salvageNotice && (
        <Alert variant="warning" className="mb-6">
          <AlertTriangle aria-hidden />
          <AlertDescription>
            {salvageNotice === 'full' ? t('intake.salvage.full') : t('intake.salvage.partial')}
          </AlertDescription>
        </Alert>
      )}

      {/* Two columns from `lg`: a persistent module rail beside the questions.
          The horizontal A–H stepper this replaced truncated every label past
          eight characters ("Grundstück …", "Zusammenfa…"), which is the one job
          a module nav has. Vertically there is room for the real title AND a
          per-module count, so the rail answers "where am I / what is left"
          without the user opening a module to find out. Below `lg` it collapses
          to the same scrolling strip, where truncation is at least a real
          space constraint rather than a layout choice. */}
      <div className="lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:items-start lg:gap-10">
        <ModuleRail
          stages={stages}
          currentStep={currentStep}
          progress={stageProgress}
          onSelect={goToStep}
          t={t}
        />

        <div className="min-w-0 lg:max-w-2xl">
          {/* Below `lg` the module list is one bar that opens a sheet: nine
              modules in a strip showed four, labels cut at eleven pixels, and
              put about 150px between the title and the first question. The bar
              says where you are (module, title, n/9) and is the way to any
              other; the counter it carries replaces the three that used to
              repeat it. */}
          <ModulePicker
            stages={stages}
            currentStep={currentStep}
            progress={stageProgress}
            onSelect={goToStep}
            t={t}
          />
          <div className="mb-4 flex items-center justify-between gap-4 lg:mb-6">
            <Progress value={progress} className="h-1 flex-1" />
            <span
              className={cn(
                'shrink-0 text-xs transition-opacity duration-quick ease-out motion-reduce:transition-none',
                draftSaved ? 'text-success opacity-100' : 'text-muted-foreground opacity-0'
              )}
              aria-live="polite"
            >
              {t('intake.draftSaved')}
            </span>
          </div>

          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault()
              if (saving || checking || saved) return
              if (isReview) {
                if (findings && findings.length > 0) return
                void handleSave()
              } else {
                handleNext()
              }
            }}
          >
            {/* The old step leaves in the same frame and the new one arrives
                from the side it lies on (12px, the reading direction of the
                rail). `wait` with a 200ms exit held the reader on a blank form
                for a fifth of a second on every Weiter, about forty times per
                intake; two steps cross-fading in one place read as one garbled
                form, so the outgoing one does not linger at all. */}
            <AnimatePresence mode="wait" initial={false} custom={directionRef.current}>
              <motion.div
                key={currentStep}
                custom={directionRef.current}
                variants={{
                  enter: (direction: number) => ({ opacity: 0, x: direction * 12 }),
                  center: { opacity: 1, x: 0, transition: stepEnter },
                  exit: { opacity: 0, transition: motionInstant },
                }}
                initial="enter"
                animate="center"
                exit="exit"
              >
                <div className="mb-6">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <div className="flex items-baseline gap-2 max-lg:hidden">
                      <span className="text-primary font-mono text-xs">Modul {stage.id}</span>
                      <span className="text-muted-foreground text-xs">
                        {currentStep + 1}/{totalSteps}
                      </span>
                    </div>
                    {/* Per-module "Rest überspringen – als offen übernehmen". Only
                      where there is something to skip, and never on the two
                      modules that carry no questions to skip. */}
                    {!isReview &&
                      !isBasis &&
                      stageProgress.get(stage.id) !== undefined &&
                      stageProgress.get(stage.id)!.answered <
                        stageProgress.get(stage.id)!.total && (
                        <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={skipRestOfStage}>
                          {t('intake.skipRest')}
                        </Button>
                      )}
                  </div>
                  <h2 className="mt-1 text-lg font-medium">{stage.title}</h2>
                  {stage.description && (
                    <p className="text-muted-foreground mt-1 max-w-prose text-sm">
                      {stage.description}
                    </p>
                  )}
                </div>

                {isBasis ? (
                  <ProjectBasisStep
                    projectId={projectId}
                    answers={answers}
                    buildings={buildings}
                    pendingBinds={{
                      persistedBuildingIds: savedBuildingIds,
                      pending: pendingBinds,
                      onDefer: deferBind,
                      onDiscard: discardPendingBind,
                      track: deferredUploads.track,
                    }}
                  />
                ) : isReview ? (
                  <div className="space-y-4">
                    <ReviewStep
                      definition={definition}
                      answers={answers}
                      buildings={buildings}
                      onEditStage={(stageIndex) => goToStep(stageIndex)}
                    />
                    {checking && (
                      <div
                        className="text-muted-foreground flex items-center gap-2 text-sm"
                        aria-live="polite"
                      >
                        <Loader2
                          className="size-4 animate-spin motion-reduce:animate-none"
                          aria-hidden
                        />
                        {t('intake.consistency.checking')}
                      </div>
                    )}
                    {findings && findings.length > 0 && (
                      <ConflictFindings
                        definition={definition}
                        findings={findings}
                        saving={saving}
                        onRevise={handleReviseAt}
                        onProceed={handleProceedAnyway}
                      />
                    )}
                  </div>
                ) : stage.scope === 'building' ? (
                  <BuildingStage
                    // Schnellstart is a view over the QUESTIONS, so it has to be
                    // applied here as well: passing the raw stage left modules
                    // C, D and E showing every question while the toggle claimed
                    // to be showing only Kernfragen.
                    stage={quickStartStage}
                    buildings={buildings}
                    answers={answers}
                    touched={touched}
                    projectId={projectId}
                    onSetAnswer={setAnswer}
                    onSetMode={setMode}
                    onAddBuilding={addBuilding}
                    onRemoveBuilding={removeBuilding}
                    onRenameBuilding={renameBuilding}
                    validationMessageFor={(q) => validationMessage(q, t)}
                  />
                ) : (
                  <div className="space-y-6">
                    {flatVisibleQuestions.map((q) => (
                      <QuestionField
                        key={q.id}
                        question={q}
                        answerKey={q.id}
                        answers={answers}
                        projectId={projectId}
                        error={
                          touched.has(q.id) && !isQuestionSatisfied(q, answers, q.id)
                            ? validationMessage(q, t)
                            : null
                        }
                        onSetAnswer={setAnswer}
                        onSetMode={setMode}
                      />
                    ))}
                    {/* Says what Schnellstart is hiding, and offers it here. A
                      count the user cannot act on would just be a nag. */}
                    {hiddenByQuickStart > 0 && (
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-surface border border-dashed px-4 py-3">
                        <span className="text-muted-foreground text-sm">
                          {t('intake.hiddenByQuickstart', { count: hiddenByQuickStart })}
                        </span>
                        <Button
                          type="button"
                          variant="link"
                          size="sm"
                          className="h-auto p-0"
                          onClick={() =>
                            setExpandedStages((previous) => new Set(previous).add(stage.id))
                          }
                        >
                          {t('intake.showAllHere')}
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </motion.div>
            </AnimatePresence>

            {error && definition && (
              <Alert variant="destructive" className="mt-8">
                <AlertDescription
                  className={conflict ? 'flex flex-col items-start gap-3' : undefined}
                >
                  <span>{error}</span>
                  {conflict && (
                    <Button type="button" variant="outline" size="sm" onClick={reloadAfterConflict}>
                      {t('intake.conflictReload')}
                    </Button>
                  )}
                </AlertDescription>
              </Alert>
            )}

            {/* Sticky to the bottom of the shell's scroll container, which the shell
                already sizes to what the on-screen keyboard leaves
                (`--visual-viewport-height`), so this bar rides above the
                keyboard rather than behind it; the number keypad has no Return,
                and Weiter is the way on. The phone's tab bar stands down on this
                route, so the home indicator's inset is this bar's to clear. */}
            <div className="bg-background/85 sticky bottom-0 z-20 -mx-4 mt-10 flex items-center justify-between gap-3 border-t px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur-md sm:gap-4 sm:pt-4 [@media(max-height:31rem)]:pb-[max(0.5rem,env(safe-area-inset-bottom))] [@media(max-height:31rem)]:pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => goToStep(currentStep - 1)}
                disabled={currentStep === 0 || saving}
              >
                {t('intake.back')}
              </Button>

              {/* The phone has the counter in the module bar above the questions. */}
              <span className="text-muted-foreground hidden text-xs sm:inline">
                {t('intake.stepCounter', { current: currentStep + 1, total: totalSteps })}
              </span>

              {isReview ? (
                findings && findings.length > 0 ? (
                  <span aria-hidden className="inline-flex min-h-9 min-w-36 max-sm:hidden" />
                ) : (
                  <SaveIntakeButton
                    working={saving || checking}
                    saved={saved}
                    label={
                      saved
                        ? t('intake.saved')
                        : checking
                          ? t('intake.consistency.checking')
                          : saving
                            ? t('intake.saving')
                            : isEdit
                              ? t('intake.saveChanges')
                              : t('intake.saveAndSee')
                    }
                  />
                )
              ) : (
                <Button type="submit" disabled={saving} className="max-sm:flex-1">
                  {t('intake.next')}
                </Button>
              )}
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
