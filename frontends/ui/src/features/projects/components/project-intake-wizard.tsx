'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { toast } from 'sonner'

import { AlertTriangle, Loader2 } from 'lucide-react'
import { projectTourUrl } from '@/lib/onboarding/product-tour'
import { AnimatePresence, motion, motionDeliberate, motionEntrance, motionInstant, useMotionToken } from '@/components/motion'
import { LoadError } from '@/components/ui/load-error'
import { Alert, AlertDescription } from '@/components/ui/alert'

import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { SectionLabel } from '@/components/ui/section-label'

import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

import { ProjectBasisStep } from './project-basis-step'
import { createUploadTracker, pendingBindsFromDraft, persistedBuildingIds, sendPendingBinds, withPendingBind, withoutBuilding, withoutPendingBind, type PendingRoleBind } from '../lib/pending-role-binds'
import { BUILDING_ID_PREFIX, answerKeyFor, defaultBuildings, modeKeyFor } from '@/lib/project-profile/intake-building-keys'
import { buildingsFromAnswers, evaluateIntakeCondition, isIntakeAnswerProvided, pruneStaleConditionalAnswers } from '@/lib/project-profile/intake-conditions'
import { answersFromProfile, buildIntakeProfile, mergeIntakeProfile } from '@/lib/project-profile/intake-profile'

import type { BuildingInstance } from '@/lib/project-profile/intake-building-keys'
import type { IntakeAnswerMode, ProjectIntakeDefinition, ProjectIntakeQuestion, ProjectIntakeStage } from '@/lib/project-profile/intake-types'
import { checkIntakeConsistencyFromAnswers, collectFreeTextFields, collectStructuredContextFields } from '@/lib/project-profile/intake-consistency'
import type { ConsistencyFinding } from '@/lib/project-profile/intake-consistency'
import type { ProjectPrimitiveValue, ProjectProfile } from '@/lib/project-profile/types'
import { useLocale, useTranslations } from '@/i18n'

import { projectsCopy } from '@/i18n/namespaces/projects'
import { Answers, IntakeDraft, draftShouldWinInEditMode, isQuestionSatisfied, validationMessage } from './project-intake-helpers'
import { SaveIntakeButton, ModuleRail, ModulePicker, QuickStartToggle } from './project-intake-modules'
import { zoneQuestionsFor, maxBuildingNumber, BuildingStage } from './project-intake-buildings'
import { ReviewStep, ConflictFindings } from './project-intake-review'
import { QuestionField } from './project-intake-fields'

interface ProjectIntakeWizardProps {
  projectId: string
  projectName?: string
  mode?: 'create' | 'edit'
  initialProfile?: ProjectProfile | null
  initialProfileVersion?: number | null
  conflictCheckEnabled?: boolean
  salvageNotice?: 'partial' | 'full' | null
  /**
   * Render offline with a supplied definition instead of fetching it — used by
   * the /dev/intake gallery and component tests so the whole wizard can render
   * without the API. Undefined in production (the definition is fetched).
   */
  definitionOverride?: ProjectIntakeDefinition
  /** Preview/deep-link entry module (index). A restored draft still wins. */
  initialStep?: number
}

export function ProjectIntakeWizard({
  projectId,
  projectName,
  mode = 'create',
  initialProfile = null,
  initialProfileVersion = null,
  conflictCheckEnabled = false,
  salvageNotice = null,
  definitionOverride,
  initialStep = 0,
}: ProjectIntakeWizardProps) {
  const t = useTranslations(projectsCopy)
  const { locale } = useLocale()
  const router = useRouter()
  const [definition, setDefinition] = useState<ProjectIntakeDefinition | null>(null)
  const [loading, setLoading] = useState(true)
  const [currentStep, setCurrentStep] = useState(initialStep)
  const [answers, setAnswers] = useState<Answers>({})
  const [buildings, setBuildings] = useState<BuildingInstance[]>(defaultBuildings())
  const [pendingBinds, setPendingBinds] = useState<PendingRoleBind[]>([])
  // The latest list, read by the save after the uploads it waited for have
  // added theirs: the state its closure captured predates them.
  const pendingBindsRef = useRef<PendingRoleBind[]>([])
  const updatePendingBinds = useCallback(
    (next: (previous: PendingRoleBind[]) => PendingRoleBind[]) => {
      pendingBindsRef.current = next(pendingBindsRef.current)
      setPendingBinds(pendingBindsRef.current)
    },
    []
  )
  const deferredUploads = useMemo(() => createUploadTracker(), [])
  const [touched, setTouched] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [draftSaved, setDraftSaved] = useState(false)
  const [findings, setFindings] = useState<ConsistencyFinding[] | null>(null)
  const [checking, setChecking] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  // Schnellstart (spec `core_flag`): show only Kernfragen. Everything skipped is
  // persisted with mode 'open', which is already what an unanswered question
  // becomes — so the mode is a VIEW, not a second answer state to reconcile.
  const [quickStart, setQuickStart] = useState(false)
  // Modules where the user chose "alle anzeigen" despite Schnellstart.
  const [expandedStages, setExpandedStages] = useState<Set<string>>(new Set())

  // `-v3`: the answers a draft holds are keyed by building id and use-token names
  // that changed (migration 0159), and since then the yes/no/open and value/estimated/open
  // tokens were German (`ja`, `geschaetzt`), so a draft from before is not restorable.
  // It is dropped, not read: a draft is one tab's unsent work.
  const STORAGE_KEY = `intake-draft-v3-${projectId}`
  const LEGACY_STORAGE_KEYS = [`intake-draft-${projectId}`, `intake-draft-v2-${projectId}`]
  const isEdit = mode === 'edit'
  const buildingCounter = useRef(1)
  // The active module-stepper button, scrolled into view whenever the step changes
  // so the current pill never hides off the right edge on a narrow screen.

  // Load the definition, then restore a draft or prefill from the stored profile.
  useEffect(() => {
    let cancelled = false
    const load = definitionOverride
      ? Promise.resolve(definitionOverride)
      : fetch(`/api/projects/${projectId}/intake-definition`).then((r) =>
          r.ok
            ? (r.json() as Promise<ProjectIntakeDefinition>)
            : Promise.reject(new Error('Failed to load'))
        )
    load
      .then((data: ProjectIntakeDefinition) => {
        if (cancelled) return
        setDefinition(data)

        let restored = false
        try {
          for (const legacyKey of LEGACY_STORAGE_KEYS) localStorage.removeItem(legacyKey)
        } catch {
          /* storage may be blocked */
        }
        try {
          const raw = localStorage.getItem(STORAGE_KEY)
          if (raw) {
            const parsed = JSON.parse(raw) as IntakeDraft
            if (parsed.answers) {
              const restoreDraft =
                !isEdit ||
                !initialProfile ||
                draftShouldWinInEditMode(parsed, initialProfile, initialProfileVersion)
              if (restoreDraft) {
                const draftBuildings =
                  parsed.buildings && parsed.buildings.length > 0
                    ? parsed.buildings
                    : buildingsFromAnswers(parsed.answers)
                setBuildings(draftBuildings)
                updatePendingBinds(() => pendingBindsFromDraft(parsed.pendingBinds))
                buildingCounter.current = maxBuildingNumber(draftBuildings)
                setAnswers(pruneStaleConditionalAnswers(parsed.answers, data))
                if (typeof parsed.currentStep === 'number') setCurrentStep(parsed.currentStep)
                restored = true
              } else {
                try {
                  localStorage.removeItem(STORAGE_KEY)
                } catch {
                  /* ignore */
                }
              }
            }
          }
        } catch {
          /* invalid draft, ignore */
        }

        if (!restored) {
          if (initialProfile) {
            const seeded = answersFromProfile(initialProfile, data)
            setBuildings(seeded.buildings)
            buildingCounter.current = maxBuildingNumber(seeded.buildings)
            setAnswers(pruneStaleConditionalAnswers(seeded.answers, data))
          } else if (projectName && !isEdit) {
            // Seed the project name captured at creation so A1 opens prefilled.
            setAnswers({ A1: projectName })
          }
        }
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setError(t('intake.errors.loadFailed'))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, loadAttempt])

  const retryLoad = useCallback(() => {
    setError(null)
    setLoading(true)
    setLoadAttempt((attempt) => attempt + 1)
  }, [])

  // Debounced autosave of the working draft.
  useEffect(() => {
    if (loading) return
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            answers,
            buildings,
            pendingBinds,
            currentStep,
            savedAt: Date.now(),
            baseVersion: typeof initialProfileVersion === 'number' ? initialProfileVersion : null,
          } satisfies IntakeDraft)
        )
        setDraftSaved(true)
      } catch {
        /* quota exceeded, ignore */
      }
    }, 500)
    return () => clearTimeout(timer)
  }, [answers, buildings, pendingBinds, currentStep, STORAGE_KEY, loading, initialProfileVersion])

  useEffect(() => {
    if (draftSaved) {
      const timer = setTimeout(() => setDraftSaved(false), 2000)
      return () => clearTimeout(timer)
    }
  }, [draftSaved])

  const stages = useMemo(() => definition?.stages ?? [], [definition])
  const totalSteps = stages.length
  const stage: ProjectIntakeStage | null = stages[currentStep] ?? null
  const isReview = stage?.id === 'H'
  /** Modul I renders document slots from the role registry, not questions. */
  const isBasis = stage?.id === 'I'

  const setAnswer = useCallback(
    (key: string, value: ProjectPrimitiveValue) => {
      setAnswers((prev) => pruneStaleConditionalAnswers({ ...prev, [key]: value }, definition))
      setFindings(null)
      setTouched((prev) => {
        if (!prev.has(key)) return prev
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    },
    [definition]
  )

  const setMode = useCallback(
    (answerKey: string, nextMode: IntakeAnswerMode) => {
      setAnswers((prev) => {
        const next = { ...prev, [modeKeyFor(answerKey)]: nextMode }
        if (nextMode === 'open') delete next[answerKey]
        return pruneStaleConditionalAnswers(next, definition)
      })
      setFindings(null)
    },
    [definition]
  )

  /** Visible questions on a projekt/grundstueck stage (building stages iterate instances). */
  const stageVisibleQuestions = useMemo(() => {
    if (!stage || stage.scope === 'building') return []
    return stage.questions.filter((q) => evaluateIntakeCondition(q, answers))
  }, [stage, answers])

  /** Whether Schnellstart is currently narrowing THIS module. */
  const stageQuickStarted = quickStart && stage != null && !expandedStages.has(stage.id)

  /**
   * What the module actually renders. Validation still runs against the full
   * visible set — a required question hidden by Schnellstart would otherwise
   * let the user past a gate the spec keeps closed (only A1/A2/A5 are required,
   * and all of them are core, so in practice this never bites; it is here so a
   * later `required: true` on a non-core question cannot open a hole).
   */
  const flatVisibleQuestions = useMemo(() => {
    if (!stageQuickStarted) return stageVisibleQuestions
    return stageVisibleQuestions.filter((q) => q.core || q.required)
  }, [stageQuickStarted, stageVisibleQuestions])

  const hiddenByQuickStart = stageVisibleQuestions.length - flatVisibleQuestions.length

  /**
   * The stage a building module renders under Schnellstart.
   *
   * Required questions survive the filter for the same reason they do on a
   * project-scope module: narrowing the view must never narrow the gate.
   */
  const quickStartStage = useMemo(() => {
    if (!stage) return stage
    if (!stageQuickStarted) return stage
    return { ...stage, questions: stage.questions.filter((q) => q.core || q.required) }
  }, [stage, stageQuickStarted])

  const stageValid = useMemo(() => {
    if (!stage) return true
    if (stage.scope === 'building') {
      return buildings.every((bw) =>
        stage.questions
          .filter((q) => evaluateIntakeCondition(q, answers, bw.id))
          .every((q) => isQuestionSatisfied(q, answers, answerKeyFor(q.id, bw.id)))
      )
    }
    return stageVisibleQuestions.every((q) => isQuestionSatisfied(q, answers, q.id))
  }, [stage, buildings, answers, stageVisibleQuestions])

  /**
   * Answered / total per module, for the rail.
   *
   * Counts only questions currently VISIBLE (a conditional question the project
   * never reaches is not an unanswered one) and only those that write an answer
   * — an `info_placeholder` or a `document_role` slot has nothing to satisfy.
   * Bauwerk modules count across every building, which is what makes "3 von 14"
   * on module C honest when there are two buildings.
   */
  const stageProgress = useMemo(() => {
    const counts = new Map<string, { answered: number; total: number }>()
    for (const s of stages) {
      let answered = 0
      let total = 0
      const tally = (q: ProjectIntakeQuestion, key: string) => {
        if (q.type === 'info_placeholder' || q.type === 'document_role' || q.type === 'upload')
          return
        total += 1
        if (isIntakeAnswerProvided(answers[key]) || answers[modeKeyFor(key)] === 'open')
          answered += 1
      }
      if (s.scope === 'building') {
        for (const bw of buildings) {
          for (const q of s.questions) {
            if (evaluateIntakeCondition(q, answers, bw.id)) tally(q, answerKeyFor(q.id, bw.id))
          }
          for (const zone of zoneQuestionsFor(s, bw.id, answers)) {
            tally(zone.question, answerKeyFor(zone.question.id, bw.id, zone.use))
          }
        }
      } else {
        for (const q of s.questions) {
          if (evaluateIntakeCondition(q, answers)) tally(q, q.id)
        }
      }
      counts.set(s.id, { answered, total })
    }
    return counts
  }, [stages, answers, buildings])

  /**
   * Record every unanswered question in this module as explicitly open.
   *
   * The spec's per-module "Rest überspringen – als offen übernehmen". Writing
   * mode 'open' rather than leaving the answer absent is the whole point: both
   * produce an `unknown` in the profile, but only the explicit one can be told
   * apart from "not reached yet" in Modul H's completion checklist.
   */
  const skipRestOfStage = useCallback(() => {
    if (!stage) return
    setAnswers((prev) => {
      const next = { ...prev }
      const markOpen = (q: ProjectIntakeQuestion, key: string) => {
        if (q.type === 'info_placeholder' || q.type === 'document_role' || q.type === 'upload')
          return
        if (q.required) return
        if (isIntakeAnswerProvided(next[key])) return
        if (q.type === 'yes_no_open') {
          // Its own third state, not a mode sibling — so the control renders as
          // "noch offen" rather than merely unselected.
          next[key] = 'open'
          return
        }
        next[modeKeyFor(key)] = 'open'
        delete next[key]
      }
      if (stage.scope === 'building') {
        for (const bw of buildings) {
          for (const q of stage.questions) {
            if (evaluateIntakeCondition(q, next, bw.id)) markOpen(q, answerKeyFor(q.id, bw.id))
          }
          // Modul D renders a question set per selected use. Skipping the
          // module while leaving those on screen unanswered is not skipping it.
          for (const zone of zoneQuestionsFor(stage, bw.id, next)) {
            markOpen(zone.question, answerKeyFor(zone.question.id, bw.id, zone.use))
          }
        }
      } else {
        for (const q of stage.questions) {
          if (evaluateIntakeCondition(q, next)) markOpen(q, q.id)
        }
      }
      return pruneStaleConditionalAnswers(next, definition)
    })
    setFindings(null)
  }, [stage, buildings, definition])

  const directionRef = useRef(1)
  const stepEnter = useMotionToken(motionEntrance)
  const completionBeat = useMotionToken(motionDeliberate)
  const completionBeatMs = (completionBeat.duration ?? 0) * 1000
  const [saved, setSaved] = useState(false)

  const goToStep = useCallback(
    (step: number) => {
      setError(null)
      setConflict(false)
      setFindings(null)
      setCurrentStep((prev) => {
        const next = Math.max(0, Math.min(step, totalSteps - 1))
        directionRef.current = next >= prev ? 1 : -1
        return next
      })
    },
    [totalSteps]
  )

  const markStageTouched = useCallback(() => {
    if (!stage) return
    setTouched((prev) => {
      const next = new Set(prev)
      if (stage.scope === 'building') {
        for (const bw of buildings) {
          for (const q of stage.questions) {
            const key = answerKeyFor(q.id, bw.id)
            if (evaluateIntakeCondition(q, answers, bw.id) && !isQuestionSatisfied(q, answers, key))
              next.add(key)
          }
        }
      } else {
        for (const q of stageVisibleQuestions) {
          if (!isQuestionSatisfied(q, answers, q.id)) next.add(q.id)
        }
      }
      return next
    })
  }, [stage, buildings, answers, stageVisibleQuestions])

  const handleNext = useCallback(() => {
    if (!stageValid) {
      markStageTouched()
      return
    }
    goToStep(currentStep + 1)
  }, [stageValid, markStageTouched, goToStep, currentStep])

  // --- Bauwerk management (module C's C0 affordance) ---
  const addBuilding = useCallback(() => {
    buildingCounter.current += 1
    const id = `${BUILDING_ID_PREFIX}${buildingCounter.current}`
    setBuildings((prev) => [...prev, { id, name: `Bauwerk ${prev.length + 1}` }])
  }, [])

  const removeBuilding = useCallback((id: string) => {
    setBuildings((prev) => (prev.length > 1 ? prev.filter((bw) => bw.id !== id) : prev))
    // A binding held for a building that is gone has nowhere to go.
    updatePendingBinds((prev) => withoutBuilding(prev, id))
    // Drop every answer belonging to the removed building.
    setAnswers((prev) => {
      const next: Answers = {}
      for (const [key, value] of Object.entries(prev)) {
        if (!key.includes(`@${id}`)) next[key] = value
      }
      return next
    })
  }, [updatePendingBinds])

  // The buildings the server already knows; a binding to any other waits for the save.
  const savedBuildingIds = useMemo(
    () => persistedBuildingIds(initialProfile, definition),
    [initialProfile, definition]
  )
  const deferBind = useCallback(
    (bind: PendingRoleBind) => updatePendingBinds((prev) => withPendingBind(prev, bind)),
    [updatePendingBinds]
  )
  const discardPendingBind = useCallback(
    (bind: PendingRoleBind) => updatePendingBinds((prev) => withoutPendingBind(prev, bind)),
    [updatePendingBinds]
  )

  const renameBuilding = useCallback((id: string, name: string) => {
    setBuildings((prev) => prev.map((bw) => (bw.id === id ? { ...bw, name } : bw)))
  }, [])

  const runSave = useCallback(async () => {
    if (!definition) return
    setFindings(null)
    setSaving(true)
    setError(null)
    setConflict(false)
    try {
      // An upload still running for a new building has not recorded its
      // binding yet; saving now would send the list without it.
      await deferredUploads.settled()
      const built = buildIntakeProfile(answers, definition, { projectName, buildings })
      const profile: ProjectProfile = mergeIntakeProfile(built, initialProfile, definition)
      const res = await fetch(`/api/projects/${projectId}/profile`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(typeof initialProfileVersion === 'number'
            ? { 'If-Match': String(initialProfileVersion) }
            : {}),
        },
        body: JSON.stringify(profile),
      })
      if (!res.ok) {
        if (res.status === 409) throw new Error(t('intake.errors.saveConflict'))
        throw new Error('Failed to save')
      }

      // The save made the wizard's new buildings real; only now can their
      // documents be bound to them.
      const refused = await sendPendingBinds(projectId, pendingBindsRef.current)
      if (refused.length > 0) {
        toast.error(t('intake.bindRefused', { files: refused.map((bind) => bind.filename).join(', ') }))
      }

      try {
        localStorage.removeItem(STORAGE_KEY)
      } catch {
        /* ignore */
      }

      const capturedCount = Object.keys(built.facts).length + Object.keys(built.goals).length
      // The moment the intake is done: the button's spinner turns into a
      // check that lands on `springSnap`, and the page holds one
      // `motionDeliberate` beat so the reader sees it land before the
      // project replaces the form. Without it, forty answers ended in a
      // redirect that looked the same as a crash back to the project.
      // Reduced motion drops the beat, not the check.
      setSaved(true)
      await new Promise((resolve) => window.setTimeout(resolve, completionBeatMs))
      toast.success(t('intake.saveSuccess', { count: capturedCount }))
      // A first setup hands over to the project tour; an edit goes back to
      // the project without one.
      router.push(mode === 'create' ? projectTourUrl(projectId) : `/app/projects/${projectId}`)
      router.refresh()
    } catch (e) {
      const isConflict = e instanceof Error && e.message === t('intake.errors.saveConflict')
      setConflict(isConflict)
      setError(isConflict ? (e as Error).message : t('intake.errors.saveFailed'))
      setSaving(false)
    }
  }, [
    definition,
    answers,
    buildings,
    initialProfile,
    initialProfileVersion,
    mode,
    deferredUploads,
    projectId,
    projectName,
    router,
    STORAGE_KEY,
    completionBeatMs,
    t,
  ])

  const reloadAfterConflict = useCallback(() => {
    setError(null)
    setConflict(false)
    router.refresh()
  }, [router])

  /**
   * The first unanswered required question anywhere in the definition.
   *
   * Per-stage validation only guards the Next button, which was enough while
   * the only way forward was linear. It is not enough now: Modul H declares no
   * required questions of its own, so ANY route that lands on it — the module
   * rail, a restored draft's `currentStep`, a condition that turned a required
   * question visible after it was passed — reaches a Save that would persist a
   * profile without A1/A2/A5.
   *
   * Guarding the save rather than re-locking the rail is deliberate. Locking
   * navigation would close one route to a gate that is missing, and take the
   * rail's whole point with it; this closes the gate.
   */
  const firstMissingRequired = useCallback((): { stageIndex: number; key: string } | null => {
    if (!definition) return null
    for (const [stageIndex, s] of definition.stages.entries()) {
      if (s.scope === 'building') {
        for (const bw of buildings) {
          for (const q of s.questions) {
            if (!q.required) continue
            const key = answerKeyFor(q.id, bw.id)
            if (!evaluateIntakeCondition(q, answers, bw.id)) continue
            if (!isQuestionSatisfied(q, answers, key)) return { stageIndex, key }
          }
        }
        continue
      }
      for (const q of s.questions) {
        if (!q.required) continue
        if (!evaluateIntakeCondition(q, answers)) continue
        if (!isQuestionSatisfied(q, answers, q.id)) return { stageIndex, key: q.id }
      }
    }
    return null
  }, [definition, buildings, answers])

  const handleSave = useCallback(async () => {
    if (!definition) return

    const missing = firstMissingRequired()
    if (missing) {
      // Land the user ON the unanswered question with its error showing, rather
      // than refusing from the summary with nothing to act on.
      setTouched((previous) => new Set(previous).add(missing.key))
      goToStep(missing.stageIndex)
      return
    }

    if (!conflictCheckEnabled) {
      await runSave()
      return
    }
    setError(null)

    let deterministic: ConsistencyFinding[]
    let freeText: ReturnType<typeof collectFreeTextFields>
    try {
      deterministic = checkIntakeConsistencyFromAnswers(answers, definition)
      freeText = collectFreeTextFields(answers, definition)
    } catch (e) {
      console.error(
        '[ProjectIntakeWizard] Pre-save consistency gate threw; saving anyway (fail-open):',
        e
      )
      await runSave()
      return
    }

    let aiFindings: ConsistencyFinding[] = []
    if (freeText.length > 0) {
      setChecking(true)
      try {
        const res = await fetch(`/api/projects/${projectId}/consistency-check`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            freeText,
            structured: collectStructuredContextFields(answers, definition),
            locale,
          }),
        })
        if (res.ok) {
          const data = (await res.json().catch(() => null)) as {
            findings?: ConsistencyFinding[] | null
          } | null
          if (data?.findings) aiFindings = data.findings
        } else {
          console.warn(
            '[ProjectIntakeWizard] Consistency check returned a non-ok status (non-fatal):',
            res.status
          )
        }
      } catch (e) {
        console.warn('[ProjectIntakeWizard] Consistency check request failed (non-fatal):', e)
      } finally {
        setChecking(false)
      }
    }

    const all: ConsistencyFinding[] = [...deterministic, ...aiFindings]
    if (all.length > 0) {
      setFindings(all)
      return
    }
    await runSave()
  }, [
    definition,
    conflictCheckEnabled,
    answers,
    projectId,
    locale,
    runSave,
    firstMissingRequired,
    goToStep,
  ])

  const handleProceedAnyway = useCallback(() => {
    void runSave()
  }, [runSave])

  const handleReviseAt = useCallback(
    (stageIndex: number) => {
      setFindings(null)
      goToStep(stageIndex)
    },
    [goToStep]
  )

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

  const progress = ((currentStep + 1) / totalSteps) * 100

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
          <h1 className="mt-1 truncate text-xl font-semibold tracking-tight">
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
                  <h2 className="mt-1 text-lg font-semibold tracking-tight">{stage.title}</h2>
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
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-dashed px-4 py-3">
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
