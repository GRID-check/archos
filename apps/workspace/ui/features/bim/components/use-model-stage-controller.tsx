import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Boxes } from 'lucide-react'

import { useIsMobile } from '@/hooks/use-is-mobile'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useLocale, useTranslations } from '@/i18n'
import { bimCopy } from '@/i18n/namespaces/bim'

import { documentDisplayName } from '@/lib/documents/display-name'

import { storeyKey, supportsWebGpu, type BimViewerElement } from '../lib/model-index'
import { buildModelQuery, parseModelView, withModelView, type BimModelView } from '../lib/model-link'
import { formatLevelElevation, levelElevation, pickStageModel, stageLevels, stageModelLabel, stageModelMatched } from '../lib/stage-model'

import { screenshotFilename } from '../lib/viewer-performance'
import { useBimElementDetail, useBimElements, useBimModelSource, useDocumentBimModel, useProjectBimModels } from '../hooks/use-bim-model'
import { useModelViewport } from '../hooks/use-model-viewport'
import { useStageLayout } from '../hooks/use-stage-layout'

import { ModelInspector } from './model-inspector'

import { PhoneMoreRows, type PhoneSheet } from './stage-phone-chrome'

import { ViewerRailItem, ViewerRailSection, ViewerSheet, type ViewerSheetSnap } from './viewer'
import { NO_ELEMENTS, STAGE_HISTORY_DEPTH, StageStep, visibilityActions } from './model-stage-helpers'

export interface ModelStageProps {
  /**
   * The project the stage is opened from, or `null` in the org-wide Archiv.
   *
   * Nullable because an `.ifc` has to behave the same wherever it is opened,
   * and the Archiv has no project to name. Almost nothing here needed one: the
   * viewport, the storey rail, the element table, the Raumbuch and the revision
   * timeline are all facts about the MODEL. Two things genuinely are project
   * facts and say so when they are missing — the Prüfbuch, which checks the
   * building against a Gebäudeklasse and a Hauptnutzung the project brief
   * holds, and the ownership row, which is collaboration and is per-project by
   * definition.
   */
  projectId: string | null
  /**
   * The document to resolve the model from when there is no project.
   *
   * With a project the rail lists everything in scope and `?model=` picks one
   * out of it. Without one there is no list to pick from, so the Archiv names
   * the document it opened and the stage resolves exactly that model.
   */
  documentId?: string
  /** Closes the stage — the caller drops `?model=` from the URL. */
  onClose: () => void
  /**
   * The model on screen was renamed from the stage's own file menu. The page
   * underneath lists the same document, so it is told rather than left to find
   * out on the next load.
   */
  onModelRenamed?: (documentId: string, displayName: string | null) => void
  /** The model on screen was deleted; the stage closes itself afterwards. */
  onModelDeleted?: (documentId: string) => void
  /** Responsible people + Ask a colleague. Off when collaboration is off. */
  canCollaborate?: boolean
}

export function useModelStageController(props: ModelStageProps) {
  const {
  projectId,
  documentId,
  onClose,
  onModelRenamed,
  onModelDeleted,
  canCollaborate = false,
  } = props
  const t = useTranslations(bimCopy)
  const { locale } = useLocale()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  /**
   * The whole view lives in the URL: which model, which level, which element,
   * which highlights, x-ray on or off, where the cut is. That is what makes a
   * model view a thing you can send someone — an agent answer, a card, a
   * health finding and a colleague's message all arrive as the same kind of
   * link, and they arrive at Dateien now rather than at a page of tables.
   */
  const view = useMemo<BimModelView>(
    () => parseModelView(searchParams?.toString() ?? ''),
    [searchParams]
  )

  const navigate = useCallback(
    (next: BimModelView) => {
      // `replace`, not `push`: clicking through twenty elements should not make
      // the BROWSER's back button walk back through twenty of them, and it must
      // not be able to strand the reader outside the stage either. The stage
      // keeps its own history instead — see below.
      router.replace(`${pathname}${buildModelQuery(next)}`, { scroll: false })
    },
    [pathname, router]
  )

  /**
   * Where the reader has been in this model.
   *
   * One click can change the view in more than one way — selecting an element
   * on another level also moves the level filter — and every control that
   * undoes something undoes only its own thing: the card's ✕ drops the
   * selection, "Alle Geschoße" drops the filter, the x-ray toggle drops the
   * ghosting. Three different affordances in three different places, and on a
   * phone two of them are behind a collapsed rail. The reader's actual
   * question is simply "put it back the way it was", and nothing answered it.
   *
   * Not the browser's history, deliberately. `navigate` replaces rather than
   * pushes, because a stack that also holds every page before the model means
   * Back eventually leaves the building entirely — and the whole view is one
   * URL, so twenty selections would be twenty entries in the browser's own
   * list. This stack holds only views of this model, and only what the reader
   * changed on purpose: free orbit and zoom never reach the URL at all (only a
   * view snap, a cut or the projection toggle do), so nothing here fills up
   * while somebody turns the building around.
   *
   * Hiding and isolating are in here too, and were the hole in it. They are
   * the two controls that change the building most drastically — isolate
   * takes away everything except one wall — and they were the only ones with
   * no way back except "Alle Bauteile wieder einblenden", which is a reset,
   * not an undo: a reader who had hidden four things and then isolated a
   * fifth could only get the fifth back by discarding the other four. Worse,
   * the Undo button was RIGHT THERE and silently ignored them, so pressing it
   * after isolating either did nothing or took back some unrelated earlier
   * change. See `StageStep`.
   */
  const [history, setHistory] = useState<StageStep[]>([])

  /**
   * Open while a gesture that changes two things is running — see `asOneStep`.
   *
   * A ref rather than state: the two writes happen in one event handler, and
   * a state flag would not be readable by the second of them.
   */
  const collecting = useRef<StageStep | null>(null)

  const pushStep = useCallback((step: StageStep) => {
    if (collecting.current) {
      // The EARLIEST value of each half wins. A step has to restore what was
      // true before the gesture started, not what was true halfway through it.
      collecting.current = {
        view: collecting.current.view ?? step.view,
        visibility: collecting.current.visibility ?? step.visibility,
      }
      return
    }
    setHistory((stack) => [...stack, step].slice(-STAGE_HISTORY_DEPTH))
  }, [])

  /**
   * Run a gesture that writes twice, and record it as ONE step.
   *
   * Hiding is the case: it takes the element out of the way AND drops the
   * selection, because a card describing a component that is no longer on
   * screen is worse than no card. Two writes, one press — and recorded as two
   * steps, the reader had to press Undo twice, the first press re-selecting a
   * wall that was still invisible. A control whose undo needs two presses,
   * one of which produces a state the reader was never in, reads as broken.
   *
   * A gesture that turns out to change nothing records nothing, same as a
   * lone write that changes nothing.
   */
  const asOneStep = useCallback((gesture: () => void) => {
    collecting.current = { view: null, visibility: null }
    try {
      gesture()
    } finally {
      const step = collecting.current
      collecting.current = null
      if (step && (step.view || step.visibility)) {
        setHistory((stack) => [...stack, step].slice(-STAGE_HISTORY_DEPTH))
      }
    }
  }, [])

  const setView = useCallback(
    (patch: Partial<BimModelView>) => {
      const next = withModelView(view, patch)
      // A patch that changes nothing is not a step — and it is not a
      // navigation either. `setCamera` re-emits an identical camera on every
      // gesture that ends where it started, which would otherwise stack empty
      // entries the reader has to press through.
      if (buildModelQuery(next) === buildModelQuery(view)) return
      pushStep({ view, visibility: null })
      navigate(next)
    },
    [navigate, pushStep, view]
  )

  /**
   * Exactly one of these does any work; the other is passed null and stays
   * idle. Both are called unconditionally because hooks are — the same shape
   * `IfcFilePreview` uses for the same reason.
   */
  const projectModels = useProjectBimModels(projectId)
  const officeShelfModel = useDocumentBimModel(projectId ? null : (documentId ?? null))
  const {
    data: models,
    isLoading,
    error,
    reload: reloadModels,
  } = useMemo(() => {
    if (projectId) return projectModels
    return {
      // One model is still a list, so every reader below — the rail, the
      // picker, `pickStageModel` — works unchanged rather than growing a
      // second code path for the Archiv.
      data: officeShelfModel.data === null ? (officeShelfModel.isLoading ? null : []) : [officeShelfModel.data],
      isLoading: officeShelfModel.isLoading,
      error: officeShelfModel.error,
      reload: officeShelfModel.reload,
    }
  }, [projectId, projectModels, officeShelfModel])
  const model = useMemo(() => pickStageModel(models ?? [], view.model), [models, view.model])
  /**
   * The link named a model this project does not have.
   *
   * `pickStageModel` falls back to the newest ready one, which is the right
   * thing to DO and the wrong thing to do silently: the answer said "3 Wände
   * im Erdgeschoss von Haus-A", the viewer opened Haus-B, the storey filter
   * matched nothing, the legend read "(0)", and the model's name appears
   * nowhere on screen when the project has only one model.
   */
  const openedAnother = models !== null && !stageModelMatched(model, view.model)
  const modelId = model?.status === 'ready' ? model.id : null

  /*
    Visibility steps do not survive a change of model.

    Express ids are per-FILE, and the viewport starts every new model from a
    clean building for exactly that reason. A step recorded against Haus-A
    holds a set of numbers that address completely different components in
    Nebengebäude — restoring it would hide elements the reader never touched,
    in a building they have only just opened.

    Only the visibility HALF goes. A view carries `model=`, so walking back
    over a model switch is still a thing Undo can do; a step left holding
    nothing but a dropped visibility set is no longer a step at all.
  */
  useEffect(() => {
    setHistory((stack) =>
      stack.some((step) => step.visibility)
        ? stack.map((step) => ({ view: step.view, visibility: null })).filter((step) => step.view)
        : stack
    )
  }, [modelId])

  const storey = view.storey ?? null
  const selectedGlobalId = view.element ?? null

  const {
    data: elements,
    isLoading: elementsLoading,
    error: elementsError,
    reload: reloadElements,
  } = useBimElements(modelId)
  // `elements ?? []` inline would mint a new array on every render, changing
  // the canvas's props identity for a value that did not change.
  const elementList = elements ?? NO_ELEMENTS
  const detail = useBimElementDetail(modelId, selectedGlobalId)
  // Only mint the presigned source URL when a viewport can actually use it.
  // `supportsWebGpu()`, not `true`: the comment above has always said the URL
  // is only minted when a viewport can use it, and a browser without WebGPU
  // was still signing an object-storage credential nothing would ever read.
  const source = useBimModelSource(modelId, supportsWebGpu())

  const levels = useMemo(() => stageLevels(model?.summary), [model?.summary])

  // Read inside the download handler, which is deliberately identity-stable so
  // that renaming nothing re-mounts the viewport's capture effect.
  const modelFilenameRef = useRef(model?.filename ?? null)
  modelFilenameRef.current = model?.filename ?? null

  /**
   * A captured view lands in the reader's downloads.
   *
   * Not in the clipboard: a PNG on the clipboard is a thing you can paste into
   * exactly one kind of application, and the reason someone captures a model
   * view is to put it in a Befund, an email or a BCF topic — all of which want
   * a file. A failed capture says so rather than silently doing nothing; the
   * usual cause is a GPU that refused the readback, which is not something the
   * reader can be expected to infer from an inert button.
   */
  const [captureFailed, setCaptureFailed] = useState(false)
  const handleCapture = useCallback(
    (dataUrl: string | null) => {
      if (!dataUrl) {
        setCaptureFailed(true)
        return
      }
      setCaptureFailed(false)
      const link = document.createElement('a')
      link.href = dataUrl
      link.download = screenshotFilename(modelFilenameRef.current, new Date())
      link.click()
    },
    []
  )

  useEffect(() => {
    if (!captureFailed) return
    const timer = setTimeout(() => setCaptureFailed(false), 4000)
    return () => clearTimeout(timer)
  }, [captureFailed])

  /**
   * Where focus goes when a viewer control removes itself.
   *
   * Four controls in this dialog delete themselves on activation — Hide (the
   * card unmounts), the card's close button, "Alles anzeigen" (nothing is
   * hidden any more) and the measurement "Löschen" (the pill goes with the
   * list). Radix's focus scope catches the removal and re-focuses the dialog
   * CONTAINER, which is not a crash but is a lost place: the reader is put at
   * the top of a full-screen surface with fifteen controls and no indication
   * of where they were.
   *
   * The canvas is the answer for all four. It is `tabIndex={0}`, it is what
   * every one of those controls acts ON, and Tab from it reaches the dock —
   * so "back to the building" is both the semantic and the practical landing
   * spot. When the canvas is not mounted (loading, or a failure notice in its
   * place) the dialog panel itself is focusable and is the nearest thing left.
   */
  const stageRef = useRef<HTMLDivElement>(null)
  /** The dock button that owns the drawer — where focus returns when it shuts. */
  const advancedToggleRef = useRef<HTMLButtonElement>(null)
  const focusViewport = useCallback(() => {
    const root = stageRef.current
    if (!root) return
    const canvas = root.querySelector('canvas')
    if (canvas) canvas.focus()
    else root.focus()
  }, [])

  const highlights = useMemo(
    () =>
      (view.highlights ?? []).map((group) => ({
        globalIds: group.globalIds,
        // The answer's own words when the link carried them. The severity
        // word is the fallback, and it used to be the only option — so
        // "Fluchtweg > 40 m (12)" and "Türbreite < 80 cm (4)" both became
        // "Fehler", two identical legend rows with the meaning stripped out.
        label:
          group.label ??
          t(
            `health.severity.${group.status === 'fail' ? 'error' : group.status === 'warning' ? 'warning' : 'info'}`
          ),
        status: group.status,
      })),
    [view.highlights, t]
  )

  /**
   * Select an element, and make sure the view can actually show it.
   *
   * A level filter isolates one floor; selecting a wall on another one left
   * the URL saying `element=…` while nothing on screen showed it — not in the
   * viewport, which was isolated to the filtered level, and not in any list.
   * The selection existed and was invisible, which reads as a broken link
   * rather than as a filter.
   *
   * So the selection wins: picking an element moves the level filter to the
   * level that element is on. Both travel in the URL together, so the link a
   * reader shares reproduces what the sender was looking at.
   */
  const handleSelect = useCallback(
    (element: BimViewerElement | null) => {
      if (!element) {
        setView({ element: undefined })
        return
      }
      const elementStorey = element.storeyName ?? null
      setView({
        element: element.globalId,
        ...(elementStorey !== null && elementStorey !== storey ? { storey: elementStorey } : {}),
      })
    },
    [setView, storey]
  )

  const viewport = useModelViewport({
    sourceUrl: source.data,
    elements: elementList,
    highlights,
    isolatedStorey: storey,
    selectedGlobalId,
    onSelect: handleSelect,
    xray: view.xray ?? false,
    camera: view.camera,
    onCameraChange: (camera) => setView({ camera }),
    compact: false,
    onCapture: handleCapture,
    // The viewport decides what counts as an edit — isolating the same wall
    // twice is a press with nothing behind it — and hands back the state it
    // is about to replace. That is the step.
    onVisibilityEdit: (previous) => pushStep({ view: null, visibility: previous }),
  })

  /**
   * One step back, without recording the step back as a step.
   *
   * The stack is read OUTSIDE the updater: navigating and restoring are side
   * effects, and React is free to call an updater twice.
   */
  const goBack = useCallback(() => {
    const previous = history.at(-1)
    if (!previous) return
    setHistory((stack) => stack.slice(0, -1))
    if (previous.visibility) viewport.visibility.restore(previous.visibility)
    if (previous.view) navigate(previous.view)
  }, [history, navigate, viewport.visibility])

  /**
  * Open on a desktop, shut on a phone, and whatever the reader last chose
  * after that.
  *
  * `null` means "not decided yet", which is what lets the default follow the
  * device without overriding a deliberate toggle on the next resize. A rail
  * that is 14 rem wide covers most of a phone, and the first thing someone
  * opening a model on one wants is the model.
  */
  const isMobile = useIsMobile()
  const [railChoice, setRailChoice] = useState<boolean | null>(null)
  /**
   * The arrangement of chrome this glass gets — see `useStageLayout`.
   *
   * On a phone the rail does not exist: a 208 px card in the top-left corner
   * ran straight into the 190 px file/close pill in the top-right (393 px of
   * screen between them), and the selection card then covered the rest. Its two
   * lists, models and levels, are a sheet behind the "Geschoße" tool instead.
   */
  const layout = useStageLayout()
  const compact = layout !== 'desktop'
  /** A finger rather than a mouse: the measuring hint says "tap", and there is no Esc key. */
  const coarsePointer = useMediaQuery('(pointer: coarse)')
  const railOpen = !compact && (railChoice ?? !isMobile)
  /** Which tool sheet is up on a phone; the selection yields to it, not the reverse. */
  const [phoneSheet, setPhoneSheet] = useState<PhoneSheet | null>(null)
  /** The selection sheet opens as a peek — the building stays the subject. */
  const [selectionSnap, setSelectionSnap] = useState<ViewerSheetSnap>('peek')
  const togglePhoneSheet = useCallback(
    (sheet: PhoneSheet) => setPhoneSheet((current) => (current === sheet ? null : sheet)),
    []
  )
  /**
   * The drawer is open exactly when the link says which tab.
   *
   * It used to be local state seeded from the URL once, at mount, and never
   * written back — so three things disagreed. Closing the drawer left `tab=`
   * behind, and "Ansicht verlinken" then handed the recipient a drawer the
   * sender had shut. Selecting Überblick DELETED the parameter (it was encoded
   * as "the default"), so the link lost the drawer entirely. And arriving at
   * `?tab=compliance` while the stage was already mounted left it closed.
   *
   * Deriving it makes the drawer behave like every other control in this file:
   * its state is the link, and the link is the state.
   *
   * Gated on `modelId`, because the drawer only renders when there is a model.
   * A compliance card linking into a model that is still being read otherwise
   * produced a pressed AND disabled toolbar button with no panel anywhere —
   * and an Escape that appeared to do nothing, because it took the
   * close-the-drawer branch for a drawer that was not there.
   */
  const linkedOpen = view.tab !== undefined && modelId !== null
  /**
   * An echo, so the drawer opens on the click rather than on the round trip.
   *
   * The URL is the durable record — that is what makes the state shareable and
   * what lets an incoming link, or the back button, open the drawer on the
   * right tab. But `router.replace` re-runs the server tree, so deriving the
   * drawer purely from the URL would leave a couple of hundred milliseconds
   * between pressing the button and anything happening. That is the same
   * mistake the cut slider was making, one event instead of sixty a second,
   * and it is exactly the lag that makes an interface feel cheap.
   *
   * So: local state answers immediately, the URL is written alongside, and
   * the effect re-syncs whenever the link changes under it.
   */
  const [advancedOpen, setAdvancedOpenEcho] = useState(linkedOpen)
  useEffect(() => setAdvancedOpenEcho(linkedOpen), [linkedOpen])
  const setAdvancedOpen = useCallback(
    (open: boolean) => {
      setAdvancedOpenEcho(open)
      setView({ tab: open ? (view.tab ?? 'overview') : undefined })
    },
    [setView, view.tab]
  )
  /**
   * Close the drawer and put focus back on the button that opened it.
   *
   * Deferred to an effect rather than called straight after `setAdvancedOpen`,
   * because on a phone the drawer covers the dock and the dock is therefore
   * `max-sm:hidden` while it is open: React has not re-rendered yet inside the
   * handler, so a synchronous `focus()` was called on a `display:none` button
   * and silently did nothing, dropping the reader at the top of a
   * fifteen-control dialog. After the commit the dock is back and the same
   * call lands.
   */
  const restoreAdvancedFocus = useRef(false)
  const closeAdvanced = useCallback(() => {
    restoreAdvancedFocus.current = true
    setAdvancedOpen(false)
  }, [setAdvancedOpen])
  useEffect(() => {
    if (advancedOpen || !restoreAdvancedFocus.current) return
    restoreAdvancedFocus.current = false
    // On a phone the drawer was opened from "Mehr", whose row is gone by now;
    // the building is the next best place for the reader to land.
    if (advancedToggleRef.current) advancedToggleRef.current.focus()
    else focusViewport()
  }, [advancedOpen, focusViewport])

  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  /**
   * Copying can fail, and the button next to it already knows that.
   *
   * `navigator.clipboard` is absent in any non-secure context and
   * `writeText` rejects on a denied permission or, in Safari, outside a user
   * gesture chain. The optional chain swallowed the first and the missing
   * `catch` turned the second into an unhandled rejection — the button simply
   * never changed. Its neighbour, the capture button, has an explicit failure
   * state for precisely this reason, so the two disagreed about whether
   * failure is worth mentioning.
   */
  const [copyFailed, setCopyFailed] = useState(false)
  const copyLink = useCallback(() => {
    if (typeof window === 'undefined') return
    const clipboard = navigator.clipboard
    if (!clipboard) {
      setCopyFailed(true)
      return
    }
    clipboard
      .writeText(window.location.href)
      .then(() => {
        setCopyFailed(false)
        setCopied(true)
      })
      .catch(() => setCopyFailed(true))
  }, [])

  useEffect(() => {
    if (!copyFailed) return
    const timer = setTimeout(() => setCopyFailed(false), 4000)
    return () => clearTimeout(timer)
  }, [copyFailed])

  /** Injected into the overlay's readout so it stays a pure function. */
  const measureLabels = useMemo(
    () => ({
      horizontal: t('viewer.measure.horizontal'),
      vertical: t('viewer.measure.vertical'),
      // The numbers are as translated as the words beside them.
      locale,
    }),
    [t, locale]
  )

  /** Whether the rail has anything in it — see the toggle in the dock. */
  const railHasContent = (models ?? []).length > 1 || levels.length > 0

  /**
   * Highlighted ids the loaded model does not contain.
   *
   * Zero while the element rows are still in flight, which is not a detail:
   * geometry and the row list arrive on separate requests, and an id can only
   * be resolved against the rows. Counting them before they land made EVERY
   * highlight link flash "12 elements from this link are not in this model"
   * for as long as the walk took, and then withdraw it — the reader is told
   * the answer they were sent is wrong, about a model that has every one of
   * those elements. Same mistake `expressIdsForStorey` already fixed for
   * isolation: an empty list is "not yet", not "not there".
   *
   * And zero when the walk FAILED, for the stronger version of the same
   * reason: an empty list there is "we could not look", and reporting it as
   * "the elements are not in this model" states a data problem in someone
   * else's answer on the strength of our own request failing. The failure is
   * reported on its own, below.
   */
  const unresolvedHighlights =
    elementsLoading || elementsError !== null
      ? 0
      : viewport.highlights.reduce((sum, group) => sum + group.unresolved.length, 0)

  /**
   * Highlighted elements the LINK could not carry.
   *
   * A card resolves a filter-matched group against the whole model — that is
   * the point of the `match` grammar, so "all 420 external walls light up" —
   * and a URL is capped at 60 ids. The card's legend said 420 and the stage's
   * said 60, with nothing between them to explain the difference.
   */
  const cappedHighlights = (view.highlights ?? []).reduce(
    (sum, group) => sum + Math.max(0, (group.total ?? 0) - group.globalIds.length),
    0
  )

  /**
   * The one sentence that says the view is not quite the view that was sent.
   *
   * Computed here rather than inline in the notice below because it has to be
   * said twice: once on screen, and once into the live region. A reader who
   * follows an agent's link into the WRONG BUILDING is the single thing this
   * block exists to prevent, and until now it was prevented only for people
   * who can see a small pill at the top of a full-screen 3D view.
   */
  const stageWarning = useMemo((): { text: string; retry: boolean } | null => {
    /*
      The two failures that had no visible words at all.

      A failed capture and a failed copy were carried ONLY by a swapped icon
      and a swapped accessible name — and the name reaches a tooltip a touch
      device never opens and a `title` a phone never shows. So on the surface
      this feature is most likely to be read on, pressing Capture and having
      nothing happen looked exactly like pressing Capture and having nothing
      happen. They outrank the standing warnings for the two seconds they
      last, which is the order the live region already speaks them in: a thing
      that just happened outranks a condition that was already true.
    */
    if (captureFailed) return { text: t('viewer.capture.failed'), retry: false }
    if (copyFailed) return { text: t('link.failed'), retry: false }
    // First of the standing warnings, because it is the only one that means
    // the reader cannot USE the building. Without the rows a pick resolves to
    // nothing, so every click on a wall silently clears the selection: the
    // model is on screen and completely inert, and until now nothing said why.
    if (elementsError !== null) return { text: t('stage.elementsFailed'), retry: true }
    if (openedAnother) {
      return {
        text: t('stage.otherModel', { wanted: view.model ?? '', opened: model?.filename ?? '' }),
        retry: false,
      }
    }
    if (unresolvedHighlights > 0) {
      // The translator does no plural selection — it is `{token}` substitution
      // — so "1 der hervorgehobenen Bauteile SIND nicht enthalten" is what a
      // single missing element produced. One sibling key per counted string,
      // which is the precedent `viewer.measure.countOne` already set.
      return {
        text:
          unresolvedHighlights === 1
            ? t('card.unresolvedOne')
            : t('card.unresolved', { count: unresolvedHighlights }),
        retry: false,
      }
    }
    if (cappedHighlights > 0) {
      const groups = view.highlights ?? []
      return {
        text: t('stage.highlightCapped', {
          shown: groups.reduce((sum, group) => sum + group.globalIds.length, 0),
          total: groups.reduce((sum, group) => sum + (group.total ?? group.globalIds.length), 0),
        }),
        retry: false,
      }
    }
    return null
  }, [
    captureFailed,
    copyFailed,
    elementsError,
    openedAnother,
    unresolvedHighlights,
    cappedHighlights,
    view.model,
    view.highlights,
    model?.filename,
    t,
  ])

  /**
   * The dimension just taken, and only that one.
   *
   * The readout used to be a `role="status"` that was CREATED already holding
   * its text, which no screen reader announces — so the first measurement was
   * always silent — and that then held every measurement joined together, so
   * the fourth one re-read all four. This node is always mounted and always
   * holds exactly the newest, which is the one thing that just happened.
   */
  const newestMeasurement = viewport.measure.measurements.at(-1)

  /**
   * What the viewport would tell someone who cannot see it.
   *
   * Ordered by urgency, most urgent first: a failure outranks a confirmation,
   * a confirmation outranks progress. Empty while nothing has happened, so
   * the region does not announce on mount.
   */
  const stageAnnouncement = useMemo(() => {
    if (error) return t('loadFailed.title')
    if (source.error) return t('viewer.unavailable.title')
    if (viewport.status.phase === 'error') return t('viewer.unavailable.title')
    if (captureFailed) return t('viewer.capture.failed')
    if (copyFailed) return t('link.failed')
    if (copied) return t('link.copied')
    if (viewport.status.phase === 'parsing') return t('stage.building')
    if (viewport.status.phase === 'downloading') return t('stage.loading')
    // Above "the building is here", because "the building is here, but it is
    // not the one the link named" is the more important half of that sentence.
    if (stageWarning) return stageWarning.text
    if (viewport.status.phase === 'ready') return t('stage.ready')
    return ''
  }, [
    error,
    source.error,
    viewport.status.phase,
    captureFailed,
    copyFailed,
    copied,
    stageWarning,
    t,
  ])

  /**
   * Nothing to keep solid, so nothing to see through.
   *
   * X-ray ghosts everything that is NOT highlighted or selected; with neither
   * present it would fade the whole building to ten percent and the reader
   * would have turned the model off.
   */
  const xrayNeedsTarget =
    viewport.highlights.length === 0 && viewport.selectedExpressId === null

  const section = viewport.section
  const cutDefault = viewport.defaultCut(levelElevation(model?.summary, storey))

  /**
   * How many pills the dock is currently stacking above itself — the measuring
   * strip and the section slider, each rendered under its own condition below.
   * The legend has to clear them; see `DOCK_ABOVE_OFFSET`.
   */
  const dockAboveRows = ((viewport.measure.active || viewport.measure.measurements.length > 0
    ? 1
    : 0) + (section && viewport.bounds ? 1 : 0)) as 0 | 1 | 2

  /**
   * The two lists the rail holds — which model, which level.
   *
   * One element, two homes: the desktop rail floats them on the canvas, and
   * a phone shows the same rows in a sheet. Choosing a row on a phone also
   * lowers the sheet, because the point of choosing a floor is to look at it.
   */
  const railSections = (
    <>
      {/*
        A list of one is not a list. Most projects carry a single
        model, and a "Modelle" heading over one row is a section that
        exists to be looked past — the rail is half as tall without
        it, and the reader loses nothing, because the model's name is
        already the dialog's title.
      */}
      {(models ?? []).length > 1 && (
      <ViewerRailSection label={t('stage.models')}>
        {(models ?? []).map((candidate) => (
          <ViewerRailItem
            key={candidate.id}
            // The name the document goes by, minus the extension.
            // `?model=` still carries the FILE name, so a rename
            // never breaks a link anyone has already sent.
            label={stageModelLabel(documentDisplayName(candidate))}
            icon={<Boxes aria-hidden="true" />}
            meta={candidate.status === 'ready' ? undefined : t(`status.${candidate.status}`)}
            selected={candidate.id === model?.id}
            // A model that is still being read has no geometry to
            // show. Selecting it would replace the building with a
            // progress bar and no way back to the one on screen.
            disabled={candidate.status !== 'ready'}
            onClick={() => {
              setPhoneSheet(null)
              setView({
                model: candidate.filename,
                storey: undefined,
                element: undefined,
                highlights: undefined,
                // See-through goes with them. It ghosts everything
                // that is not highlighted or selected, so with both
                // dropped the button becomes `active` (the URL still
                // says `xray=1`) AND `disabled` — a mode the reader
                // can be left in and cannot leave, which then ghosts
                // the whole building the moment they click a wall.
                xray: undefined,
              })
            }}
          />
        ))}
      </ViewerRailSection>
      )}

      {levels.length > 0 && (
        <ViewerRailSection label={t('stage.levels')}>
          <ViewerRailItem
            label={t('stage.allLevels')}
            selected={storey === null}
            onClick={() => {
              setPhoneSheet(null)
              setView({ storey: undefined })
            }}
          />
          {levels.map((level) => (
            <ViewerRailItem
              key={level.name}
              label={level.name}
              meta={
                level.elevation === null
                  ? undefined
                  : t('stage.elevation', { value: formatLevelElevation(level.elevation, locale) })
              }
              // The elevation is context, not identity: it must not
              // become part of the row's spoken name.
              ariaLabel={level.name}
              selected={storeyKey(storey) === storeyKey(level.name)}
              // The selection stays. `handleSelect` already keeps
              // the filter and the selected element on the same
              // level, so nothing here can become invisible — and
              // "All levels" one row above did not drop it either,
              // so the list behaved differently row by row.
              onClick={() => {
                setPhoneSheet(null)
                setView({
                  storey:
                    storeyKey(storey) === storeyKey(level.name) ? undefined : level.name,
                })
              }}
            />
          ))}
        </ViewerRailSection>
      )}
    </>
  )

  /**
   * Nothing until the rows land, for the same reason the warning waits: a count
   * is resolved against the element list, so rendering one early states
   * "Aussenwände (0)" beside an answer that said 420. A legend that arrives a
   * moment late is a legend; one that arrives wrong is a contradiction the
   * reader has to resolve themselves.
   */
  const legendEntries =
    elementsLoading || elementsError !== null
      ? []
      : viewport.highlights.map((highlight) => ({
          status: highlight.status,
          label: highlight.label,
          count: highlight.expressIds.length,
        }))

  /**
   * The selection card, in whichever container this glass has.
   *
   * One element built in one place: the desktop card, the phone's bottom sheet
   * and the landscape panel show IDENTICAL content and differ only in the
   * container, so a change to what the card says is made once.
   */
  const renderInspector = (placement?: 'bottom' | 'side'): JSX.Element => (
    <ModelInspector
      element={detail.data}
      isLoading={detail.isLoading}
      error={detail.error}
      projectId={projectId}
      modelFilename={model?.filename ?? null}
      sheet={
        placement
          ? {
              placement,
              collapse: {
                snap: selectionSnap,
                onSnapChange: setSelectionSnap,
                expandLabel: t('stage.sheet.expand'),
                collapseLabel: t('stage.sheet.collapse'),
              },
            }
          : undefined
      }
      onClose={() => {
        setView({ element: undefined })
        // Closing the card unmounts the button that closed it.
        // Back to the building, which is where the selection came
        // from — see `focusViewport`.
        focusViewport()
      }}
      {...visibilityActions(viewport, () => setView({ element: undefined }), focusViewport, asOneStep)}
    />
  )

  /**
   * What is up from the bottom edge (or, sideways, at the right) on a phone.
   *
   * A tool sheet wins over the selection without clearing it: opening "Mehr"
   * to take a picture must not forget which wall the reader had picked, and the
   * selection sheet is back the moment the tool sheet is put down. The drawer
   * wins over both — it is a full-screen place on a phone.
   */
  const sheetPlacement = layout === 'phone-landscape' ? 'side' : 'bottom'
  const compactSheet: JSX.Element | null = !compact || advancedOpen
    ? null
    : phoneSheet === 'levels'
      ? (
          <ViewerSheet
            placement={sheetPlacement}
            title={levels.length > 0 ? t('stage.levels') : t('stage.models')}
            closeLabel={t('stage.selection.close')}
            onClose={() => setPhoneSheet(null)}
            bodyClassName="p-0"
          >
            {railSections}
          </ViewerSheet>
        )
      : phoneSheet === 'more'
        ? (
            <ViewerSheet
              placement={sheetPlacement}
              title={t('stage.more')}
              closeLabel={t('stage.selection.close')}
              onClose={() => setPhoneSheet(null)}
              bodyClassName="p-0"
            >
              <PhoneMoreRows
                ready={viewport.status.phase === 'ready'}
                canUndo={history.length > 0}
                onUndo={() => {
                  goBack()
                  setPhoneSheet(null)
                }}
                onCapture={() => {
                  viewport.capture()
                  setPhoneSheet(null)
                }}
                captureFailed={captureFailed}
                xray={view.xray ?? false}
                xrayHint={t('viewer.xrayHint')}
                xrayDisabled={xrayNeedsTarget}
                onToggleXray={() => setView({ xray: !(view.xray ?? false) })}
                edited={viewport.visibility.edited}
                onShowEverything={() => {
                  viewport.visibility.showEverything()
                  setPhoneSheet(null)
                  focusViewport()
                }}
                advancedDisabled={!modelId}
                onOpenAdvanced={() => {
                  setPhoneSheet(null)
                  setAdvancedOpen(true)
                }}
              />
            </ViewerSheet>
          )
        : selectedGlobalId
          ? renderInspector(sheetPlacement)
          : null

  return {
    advancedOpen,
    advancedToggleRef,
    asOneStep,
    canCollaborate,
    cappedHighlights,
    captureFailed,
    closeAdvanced,
    coarsePointer,
    collecting,
    compact,
    compactSheet,
    copied,
    copyFailed,
    copyLink,
    cutDefault,
    detail,
    dockAboveRows,
    documentId,
    elementList,
    elements,
    elementsError,
    elementsLoading,
    error,
    focusViewport,
    goBack,
    handleCapture,
    handleSelect,
    highlights,
    history,
    isLoading,
    isMobile,
    layout,
    legendEntries,
    levels,
    linkedOpen,
    locale,
    measureLabels,
    model,
    modelFilenameRef,
    modelId,
    models,
    navigate,
    newestMeasurement,
    officeShelfModel,
    onClose,
    onModelDeleted,
    onModelRenamed,
    openedAnother,
    pathname,
    phoneSheet,
    projectId,
    projectModels,
    pushStep,
    railChoice,
    railHasContent,
    railOpen,
    railSections,
    reloadElements,
    reloadModels,
    renderInspector,
    restoreAdvancedFocus,
    router,
    searchParams,
    section,
    selectedGlobalId,
    selectionSnap,
    setAdvancedOpen,
    setAdvancedOpenEcho,
    setCaptureFailed,
    setCopied,
    setCopyFailed,
    setHistory,
    setPhoneSheet,
    setRailChoice,
    setSelectionSnap,
    setView,
    sheetPlacement,
    source,
    stageAnnouncement,
    stageRef,
    stageWarning,
    storey,
    t,
    togglePhoneSheet,
    unresolvedHighlights,
    view,
    viewport,
    xrayNeedsTarget,
  }
}

export type ModelStageController = ReturnType<typeof useModelStageController>
