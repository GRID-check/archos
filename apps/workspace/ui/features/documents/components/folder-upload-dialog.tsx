'use client'

import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Copy,
  FilePlus2,
  FolderInput,
  FolderPlus,
  History,
  MoveRight,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { CountPill } from '@/components/ui/count-pill'
import { MiddleTruncate } from '@/components/ui/middle-truncate'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { StatCardIcon, type StatCardIconTone } from '@/components/ui/stat-card'
import { useTranslations } from '@/i18n'
import { filesCopy } from '@/i18n/namespaces/files'
import { cn } from '@/lib/utils'
import {
  countNewRevisions,
  groupByFolder,
  groupRevisionProposals,
  masterTarget,
  soleProposal,
  type RevisionChange,
  type RevisionProposals,
  type ProposedFile,
} from '../lib/revision-proposals'
import {
  countPlan,
  type RevisionTarget,
  type FolderUploadCounts,
  type FolderUploadPlan,
  type PlannedAction,
  type PlannedFile,
} from '../lib/folder-upload-plan'
import type { UploadDecisionKind } from '../hooks/use-upload-decision'
import { describeNameMatch } from '@/lib/upload-screening/quarantine'
import {
  DecisionBar,
  DecisionFileName,
  DecisionGroupLabel,
  DecisionNote,
  DecisionRow,
  DecisionRowExtra,
  DecisionSection,
  DecisionSubgroup,
  DecisionTarget,
} from './upload-decision-atoms'

/**
 * „Wollen Sie aktualisieren?" — asked once, with the answer visible.
 *
 * A folder upload is the one gesture in this product that can quietly change
 * work somebody else did. It replaces documents by name, re-files them into the
 * folders the tree implies, and — before this dialog existed — did all of that
 * the moment the picker closed, with no statement of what it was about to
 * touch. A person dropping a fortnight's worth of an Einreichung had no way to
 * find out whether they were adding eight files or overwriting five hundred.
 *
 * So the plan is shown BEFORE anything moves. The decision that changes the
 * outcome is which files come in as a new Fassung of a document already here
 * (CONTEXT.md, „Fassung"): a file of the same name (ADR-0054) or one whose name
 * continues a document under another name (ADR-0099). Both are a new Fassung of
 * one document and the timeline shows both (ADR-0099), so the dialog asks them
 * in ONE block, in one row shape and one wording, each group saying why Piloti
 * thinks so (gleicher Name, Namensreihe). Everything else on this surface is a
 * statement, not a question: which folders were matched, which will be created,
 * what is being skipped because the bytes are identical, which documents move
 * because the tree files them elsewhere, which files the project already holds
 * under another name, and which files it cannot hold two of.
 *
 * Where a document has been renamed here, the row carries BOTH names. The plan
 * speaks in the names the drop uses and the corpus speaks in the names people
 * gave it; asking somebody to approve replacing a document they cannot find in
 * their own file list is not asking.
 *
 * One scroll region: the header and the footer stay put, the body scrolls, and
 * the master box of forty proposals sticks to the top of it while its rows go
 * past. No list scrolls inside another, and the confirm button is on screen at
 * any height.
 *
 * Loose FILES come through here too (`kind: 'files'`), but only when one of
 * them would touch a document that is already on the shelf, or continue one.
 * One such file gets the question in its own words and its own light layout:
 * „Neue Fassung von „X“?", or, when the bytes are identical, „Unverändert –
 * bereits vorhanden".
 */
export interface FolderUploadDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Null while the drop is still being read and hashed. */
  plan: FolderUploadPlan | null
  /** The folder the reader is standing in, named. Null is the project root. */
  currentFolderName: string | null
  /** Confirm. `includeUpdates` is the reader's answer about the files of the same name. */
  onConfirm: (includeUpdates: boolean) => void | Promise<void>
  /** In flight — the plan is being applied (folders created, files queued). */
  pending?: boolean
  /** A dropped or picked folder, or loose files that met existing documents. */
  kind?: UploadDecisionKind
  /**
   * The reader's answer for one file the upload screening held back
   * (ADR-0086). Absent: the exclusions are listed without a way to release.
   */
  onReleaseChange?: (file: File, released: boolean) => void
  /**
   * The reader's answer to „Als neue Fassung von X ablegen" for one file
   * (ADR-0099). Absent: the offers are listed without a way to answer.
   */
  onRevisionChange?: (change: RevisionChange) => void
}

export function FolderUploadDialog({
  open,
  onOpenChange,
  plan,
  currentFolderName,
  onConfirm,
  pending = false,
  kind = 'folder',
  onReleaseChange,
  onRevisionChange,
}: FolderUploadDialogProps): JSX.Element {
  const t = useTranslations(filesCopy)
  const contentRef = useRef<HTMLDivElement>(null)
  /**
   * Default ON.
   *
   * The gesture is "bring this folder in", and a reader who dragged a corrected
   * set across expects the corrections to land. Defaulting to off would make the
   * common case a silent no-op that looks like a successful upload — the worse
   * of the two ways to be wrong, because nothing on screen afterwards would say
   * the new files are not here.
   */
  const [includeUpdates, setIncludeUpdates] = useState(true)
  /** The one file's answer, given and waiting for the plan to carry it before it is confirmed. */
  const [soleAnswer, setSoleAnswer] = useState<boolean | null>(null)

  /**
   * A new drop starts from the default again.
   *
   * The dialog is mounted for the life of the page, so without this the answer
   * given to one folder would silently decide the next one — a reader who
   * declined the updates in a Statik folder in the morning would find the
   * afternoon's corrected drawings quietly not uploaded. Keyed off `plan`
   * becoming null, which is what every new drop does before it has a plan.
   */
  useEffect(() => {
    if (plan) return
    setIncludeUpdates(true)
    setSoleAnswer(null)
  }, [plan])

  const counts = useMemo(
    () => (plan ? countPlan(plan.files, plan.folders, includeUpdates) : null),
    [plan, includeUpdates],
  )

  const destination = currentFolderName ?? t('folders.allFiles')
  const isFolder = kind === 'folder'
  /**
   * One loose file that is already here, new bytes or the same ones: asked in
   * its own words, without the counts a batch needs.
   */
  const single =
    !isFolder && plan?.files.length === 1 && (plan.files[0].action === 'update' || plan.files[0].action === 'unchanged')
      ? plan.files[0]
      : null
  /** One loose file that continues a document under another name: the same light layout, two named outcomes. */
  const sole = !isFolder && plan ? soleProposal(plan.files) : null

  /*
   * The one file's answer is a choice AND a confirm. The choice goes into the
   * plan first (`onRevisionChange`), and the confirm waits until the plan the
   * dialog is shown carries it: the caller applies the plan it last rendered,
   * and checks it against the settled one, so confirming in the same tick would
   * send the answer the reader just changed.
   */
  useEffect(() => {
    if (soleAnswer === null || !sole || sole.revisionOf.chosen !== soleAnswer) return
    setSoleAnswer(null)
    void onConfirm(true)
  }, [soleAnswer, sole, onConfirm])

  const answerSole = (asRevision: boolean) => {
    if (!sole) return
    if (sole.revisionOf.chosen !== asRevision) onRevisionChange?.({ files: [sole.file], chosen: asRevision })
    setSoleAnswer(asRevision)
  }

  const { title, description, HeaderIcon } = describeHeader({ t, plan, single, sole, isFolder, destination })
  const nothingToDo = !counts || counts.uploading + counts.moving === 0
  const batch = Boolean(plan && counts && !single && !sole)
  const revisions = plan ? countNewRevisions(plan.files, includeUpdates) : 0

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent
        ref={contentRef}
        // One scroll region between a fixed header and a fixed footer. On a
        // phone the batch fills the screen: a floating card there is mostly
        // margin, and the decision is what needs the height.
        // The batch is a little wider: a German confirm label that names both
        // counts, and a file name beside its box, both need the room.
        className={cn(
          // The container holds the focus on open only to keep it off the first box,
          // so it draws no ring; `!` because the global `:focus-visible` rule is unlayered.
          'flex flex-col gap-0 overflow-hidden p-0 outline-none! max-sm:px-0',
          batch || sole ? 'sm:max-w-xl' : 'sm:max-w-lg',
        )}
        fullScreenOnMobile={batch}
        closeLabel={t('folderUpload.close')}
        // The dialog itself takes the focus, not its first box: a master box
        // wearing the focus ring on open looks more decided than the rows it
        // decides, and a keyboard reader's first Tab still lands on it.
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          contentRef.current?.focus()
        }}
        aria-busy={pending || undefined}
        data-testid="folder-upload-dialog"
        data-kind={sole ? 'single-revision' : single ? `single-${single.action}` : kind}
      >
        <DialogHeader className="px-4 pt-6 pb-4 pr-12 text-left sm:px-6 sm:pr-12">
          <div className="flex items-start gap-3.5">
            <StatCardIcon icon={HeaderIcon} tone={single?.action === 'unchanged' ? 'muted' : 'info'} />
            <div className="min-w-0 space-y-1.5">
              <DialogTitle className="leading-snug">{title}</DialogTitle>
              <DialogDescription>{description}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <DialogBody>
          {!plan || !counts ? (
            // Reading the tree and hashing the plausible duplicates. Named rather
            // than left as a bare spinner: on a large folder this is seconds long
            // and "comparing with what is already here" is exactly what it is
            // doing.
            <div className="flex items-center gap-3 py-6 text-sm text-muted-foreground" data-testid="folder-upload-planning">
              <Spinner size="sm" />
              {t('folderUpload.planning')}
            </div>
          ) : sole ? (
            <SoleCandidatePick file={sole} disabled={pending || soleAnswer !== null} onRevisionChange={onRevisionChange} />
          ) : single ? (
            <SingleNotes single={single} destination={destination} />
          ) : (
            <BatchPlan
              plan={plan}
              counts={counts}
              isFolder={isFolder}
              includeUpdates={includeUpdates}
              onIncludeUpdatesChange={setIncludeUpdates}
              pending={pending}
              destination={destination}
              onReleaseChange={onReleaseChange}
              onRevisionChange={onRevisionChange}
            />
          )}
        </DialogBody>

        <DialogFooter className={cn('px-4 pb-6 pt-4 sm:flex-wrap sm:px-6', batch && 'border-t')}>
          {sole ? (
            <SoleFooter
              file={sole}
              busy={pending || soleAnswer !== null}
              canChange={Boolean(onRevisionChange)}
              onAnswer={answerSole}
            />
          ) : single && nothingToDo ? (
            // Identical and already where it belongs: a statement, so one way out.
            <Button onClick={() => onOpenChange(false)} data-testid="folder-upload-close">
              {t('folderUpload.close')}
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
                {t('folderUpload.cancel')}
              </Button>
              <Button
                // The one file's question IS the update question, so its button answers yes.
                onClick={() => void onConfirm(single ? true : includeUpdates)}
                /*
                 * Nothing to send is not a reason to hide the dialog's answer — the
                 * reader still wants to read "everything here is already up to
                 * date" — but it is a reason not to offer a button that would do
                 * nothing.
                 *
                 * "Nothing" includes the moves. A re-sync of a folder somebody has
                 * since reorganised in Piloti uploads not one byte and still has
                 * work to do, and a disabled button there would say the tree is
                 * already reproduced when it is not.
                 */
                disabled={pending || nothingToDo}
                data-testid="folder-upload-confirm"
              >
                {pending && <Spinner size="sm" />}
                {confirmLabel({ t, counts, single, nothingToDo, revisions })}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type Translate = ReturnType<typeof useTranslations>

/** The dialog's title, the sentence under it and its glyph, for whichever case this drop is. */
function describeHeader({
  t,
  plan,
  single,
  sole,
  isFolder,
  destination,
}: {
  t: Translate
  plan: FolderUploadPlan | null
  single: PlannedFile | null
  sole: ProposedFile | null
  isFolder: boolean
  destination: string
}): { title: string; description: string; HeaderIcon: LucideIcon } {
  if (sole) return { ...describeSole(t, sole), HeaderIcon: History }
  if (single) {
    const shownAs = single.existingName ?? single.file.name
    return single.action === 'update'
      ? {
          title: t('folderUpload.single.newRevisionTitle', { name: single.file.name }),
          description: t('folderUpload.single.updateExplain', { name: shownAs }),
          HeaderIcon: History,
        }
      : {
          title: t('folderUpload.single.unchangedTitle'),
          description: t('folderUpload.single.unchangedExplain', { name: shownAs }),
          HeaderIcon: ShieldCheck,
        }
  }
  if (isFolder) {
    return {
      title: plan?.rootName ? t('folderUpload.title', { name: plan.rootName }) : t('folderUpload.titleGeneric'),
      description: plan?.mergedIntoCurrentFolder
        ? t('folderUpload.destinationMerged', { folder: destination })
        : t('folderUpload.destination', { folder: destination }),
      HeaderIcon: FolderInput,
    }
  }
  return {
    title: plan ? t('folderUpload.titleFiles', { count: plan.files.length }) : t('folderUpload.titleFilesGeneric'),
    description: t('folderUpload.destinationFiles', { folder: destination }),
    HeaderIcon: FilePlus2,
  }
}

/** The one file's question: a clear match, a choice between documents, or a file not newer than the one there. */
function describeSole(t: Translate, sole: ProposedFile): { title: string; description: string } {
  const { of, candidates, newer } = sole.revisionOf
  const file = sole.file.name
  if (candidates.length > 1) {
    return { title: t('folderUpload.single.unclearTitle', { file }), description: t('folderUpload.single.unclearExplain') }
  }
  if (!newer) {
    return {
      title: t('folderUpload.single.unclearTitle', { file }),
      description: t('folderUpload.single.notNewerExplain', { file, name: of.name }),
    }
  }
  return {
    title: t('folderUpload.single.newRevisionTitle', { name: of.name }),
    description: t('folderUpload.single.revisionExplain', { file, name: of.name }),
  }
}

/** What the confirm button says: how many files go, and how many of them as a new Fassung. */
function confirmLabel({
  t,
  counts,
  single,
  nothingToDo,
  revisions,
}: {
  t: Translate
  counts: FolderUploadCounts | null
  single: PlannedFile | null
  nothingToDo: boolean
  revisions: number
}): string {
  if (nothingToDo || !counts) return t('folderUpload.nothingToDo')
  if (single?.action === 'update') return t('folderUpload.single.confirmRevision')
  if (counts.uploading === 0) return t('folderUpload.confirmMoveOnly', { count: counts.moving })
  return revisions > 0
    ? t('folderUpload.confirmWithRevisions', { count: counts.uploading, revisions })
    : t('folderUpload.confirm', { count: counts.uploading })
}

/** The scrolling middle of the dialog. Nothing in it scrolls on its own. */
function DialogBody({ children }: { children: JSX.Element }): JSX.Element {
  return <div className="min-h-0 flex-1 overflow-y-auto px-4 sm:px-6">{children}</div>
}

/**
 * The one same-name file, when there is more to say than its title: where the
 * document ends up, when that is not where it is now, and that it is archived,
 * because the new Fassung stays out of sight with it.
 */
function SingleNotes({ single, destination }: { single: PlannedFile; destination: string }): JSX.Element | null {
  const t = useTranslations(filesCopy)
  const moves = single.refiledFromFolderId !== undefined
  if (!moves && !single.existingArchived) return null
  return (
    <div className="space-y-2 pb-1">
      {single.existingArchived && (
        <Alert data-testid="folder-upload-archived">
          <AlertDescription>{t('folderUpload.single.archived')}</AlertDescription>
        </Alert>
      )}
      {moves && (
        <Alert data-testid="folder-upload-refiled">
          <MoveRight aria-hidden />
          <AlertDescription>{t('folderUpload.single.refiled', { folder: destination })}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}

/** The one file that could continue several documents: which one, before it can be filed as a new Fassung. */
function SoleCandidatePick({
  file,
  disabled,
  onRevisionChange,
}: {
  file: ProposedFile
  disabled: boolean
  onRevisionChange?: (change: RevisionChange) => void
}): JSX.Element | null {
  if (file.revisionOf.candidates.length < 2) return null
  return (
    <div className="pb-1">
      <CandidatePick file={file} disabled={disabled || !onRevisionChange} onRevisionChange={onRevisionChange} />
    </div>
  )
}

/**
 * The one file's two outcomes, each named: filed as the next Fassung, or
 * uploaded as a document of its own. A file not newer than the document it
 * would continue leads with the second; one that could continue several cannot
 * be filed until the reader has said which. No third „Abbrechen" beside two
 * long labels: the close button and Escape leave without uploading.
 */
function SoleFooter({
  file,
  busy,
  canChange,
  onAnswer,
}: {
  file: ProposedFile
  busy: boolean
  canChange: boolean
  onAnswer: (asRevision: boolean) => void
}): JSX.Element {
  const t = useTranslations(filesCopy)
  const { chosen, newer, candidates } = file.revisionOf
  const needsPick = candidates.length > 1 && !chosen
  // Without a handler the answer cannot change, so only the outcome already chosen can be confirmed.
  const revisionBlocked = needsPick || (!canChange && !chosen)
  const separateBlocked = !canChange && chosen
  const leadWithRevision = newer
  return (
    <>
      <Button
        variant={leadWithRevision ? 'outline' : 'default'}
        onClick={() => onAnswer(false)}
        disabled={busy || separateBlocked}
        data-testid="folder-upload-sole-separate"
      >
        {t('folderUpload.single.confirmSeparate')}
      </Button>
      <Button
        variant={leadWithRevision ? 'default' : 'outline'}
        onClick={() => onAnswer(true)}
        disabled={busy || revisionBlocked}
        data-testid="folder-upload-sole-revision"
      >
        {t('folderUpload.single.confirmRevision')}
      </Button>
    </>
  )
}

/** Everything a batch says and asks, top to bottom: the numbers, the one decision, then what is only stated. */
function BatchPlan({
  plan,
  counts,
  isFolder,
  includeUpdates,
  onIncludeUpdatesChange,
  pending,
  destination,
  onReleaseChange,
  onRevisionChange,
}: {
  plan: FolderUploadPlan
  counts: FolderUploadCounts
  isFolder: boolean
  includeUpdates: boolean
  onIncludeUpdatesChange: (include: boolean) => void
  pending: boolean
  destination: string
  onReleaseChange?: (file: File, released: boolean) => void
  onRevisionChange?: (change: RevisionChange) => void
}): JSX.Element {
  const t = useTranslations(filesCopy)
  return (
    <div className="space-y-4 pb-4">
      {/* Two by two at every width: stacked one per row on a phone, the four
          numbers pushed the decision off the first screen. */}
      <div className="grid grid-cols-2 gap-2">
        <PlanCount icon={FilePlus2} tone="success" count={counts.new} label={t('folderUpload.counts.new')} testId="folder-upload-count-new" />
        <PlanCount
          icon={RefreshCw}
          tone="warning"
          count={counts.update}
          label={t('folderUpload.counts.update')}
          testId="folder-upload-count-update"
        />
        <PlanCount
          icon={ShieldCheck}
          tone="muted"
          count={counts.unchanged}
          label={t('folderUpload.counts.unchanged')}
          testId="folder-upload-count-unchanged"
        />
        {isFolder && (
          <PlanCount
            icon={FolderPlus}
            tone="info"
            count={counts.foldersCreated}
            label={t('folderUpload.counts.foldersCreated')}
            testId="folder-upload-count-folders"
            // The other half of the folder story, and the half that says the
            // matching worked: a re-sync creates nothing and matches everything.
            secondary={
              counts.foldersMatched > 0 ? t('folderUpload.counts.foldersMatched', { count: counts.foldersMatched }) : undefined
            }
          />
        )}
      </div>

      {/* The decision comes right after the numbers: it is what the reader is here for. */}
      <RevisionSection
        plan={plan}
        updates={counts.update}
        includeUpdates={includeUpdates}
        onIncludeUpdatesChange={onIncludeUpdatesChange}
        pending={pending}
        destination={destination}
        onRevisionChange={onRevisionChange}
      />

      {/* Where documents END UP, which is the part a reader does not see
          coming: the document exists, it is simply filed somewhere else,
          and this drop puts it where its tree says it belongs. */}
      {(counts.refiled > 0 || counts.moving > 0) && (
        <Alert data-testid="folder-upload-refiled">
          <MoveRight aria-hidden />
          <AlertDescription className="space-y-1">
            {counts.refiled > 0 && <span className="block">{t('folderUpload.refiled', { count: counts.refiled })}</span>}
            {/* The unchanged ones send no bytes, so nothing about the
                upload would move them — they are moved on their own, and
                that is a different sentence. */}
            {counts.moving > 0 && <span className="block">{t('folderUpload.moving', { count: counts.moving })}</span>}
          </AlertDescription>
        </Alert>
      )}

      {/* ALREADY HERE UNDER ANOTHER NAME.
          Not an update — the server replaces by filename and these do not
          share one, so uploading would add a second copy of a document
          the project already holds. Named with what it is called here,
          because that is the only way the reader can go and look. */}
      {counts.duplicate > 0 && (
        <Alert variant="warning" data-testid="folder-upload-duplicates">
          <Copy aria-hidden />
          <AlertTitle>{t('folderUpload.duplicates', { count: counts.duplicate })}</AlertTitle>
          <AlertDescription className="space-y-1">
            <span className="block">{t('folderUpload.duplicatesExplain')}</span>
            <FileNameList files={plan.files.filter((file) => file.action === 'duplicate')} />
          </AlertDescription>
        </Alert>
      )}

      {/* THE ONE THING THAT IS NOT MERELY INFORMATION.
          A project holds one document per filename, so two files of the
          same name inside one drop cannot both land — and before this
          they both uploaded, one overwriting the other, with nothing said.
          Neither is sent; the reader is told which, so they can rename or
          pick. */}
      {counts.collision > 0 && (
        <Alert variant="warning" data-testid="folder-upload-collisions">
          <AlertTriangle aria-hidden />
          <AlertTitle>{t('folderUpload.collisions', { count: counts.collision })}</AlertTitle>
          <AlertDescription className="space-y-1">
            <span className="block">{t('folderUpload.collisionsExplain')}</span>
            <FileNameList files={plan.files.filter((file) => file.action === 'collision')} />
          </AlertDescription>
        </Alert>
      )}

      <ScreeningSection plan={plan} pending={pending} onReleaseChange={onReleaseChange} />

      <PlanDetails plan={plan} includeUpdates={includeUpdates} />
    </div>
  )
}

/**
 * One number, its glyph and what it means.
 *
 * `StatCard` is the kit's stat tile and is the wrong size here: `p-5` and a
 * `text-2xl` figure, four of them, inside a dialog that also has to hold a
 * decision and a file list. Its icon slot also wraps whatever it is given in a
 * fixed muted disc, so a toned glyph would be a disc inside a disc. The atom
 * that matters — the tinted well — IS the kit's (`StatCardIcon`); what is local
 * is the cell around it, which is layout. The label wraps rather than cut off:
 * half a phone's width is too narrow for „unverändert, übersprungen" on one line.
 */
function PlanCount({
  icon,
  tone,
  count,
  label,
  secondary,
  testId,
}: {
  icon: LucideIcon
  tone: StatCardIconTone
  count: number
  label: string
  secondary?: string
  testId: string
}): JSX.Element {
  return (
    <div className={cn('flex items-center gap-2.5 rounded-lg border p-2.5', count === 0 && 'opacity-55')} data-testid={testId}>
      <StatCardIcon icon={icon} tone={tone} size="sm" />
      <div className="min-w-0">
        <p className="text-sm font-semibold tabular-nums text-foreground">{count}</p>
        <p className="text-xs leading-snug text-muted-foreground">{label}</p>
        {secondary && <p className="text-[11px] leading-snug text-muted-foreground/80">{secondary}</p>}
      </div>
    </div>
  )
}

/**
 * Which files come in as a new Fassung of a document already here
 * (CONTEXT.md, „Fassung"): ONE block, whichever way Piloti recognised them.
 *
 * - **Gleicher Name** (ADR-0054): one box for all of them, because the same
 *   name replaces the live document whatever the reader says about one file;
 *   unticked, they are skipped.
 * - **Namensreihe** (ADR-0099): a publisher export brings forty at once, so the
 *   clear matches are one decision (`groupRevisionProposals`) under a master box
 *   that sticks to the top while its rows, grouped by folder, go past; each
 *   row can be overridden, and unticked it comes in as a document of its own.
 * - The ones that need the reader (several documents could be meant, or the
 *   file is not newer than the one there) apart, never ticked for them, each
 *   with the documents to choose from.
 *
 * Every row has the same shape: the file name first, cut in the middle so its
 * index and date survive, then where it goes. One sentence says what all of it
 * does.
 */
function RevisionSection({
  plan,
  updates,
  includeUpdates,
  onIncludeUpdatesChange,
  pending,
  destination,
  onRevisionChange,
}: {
  plan: FolderUploadPlan
  updates: number
  includeUpdates: boolean
  onIncludeUpdatesChange: (include: boolean) => void
  pending: boolean
  destination: string
  onRevisionChange?: (change: RevisionChange) => void
}): JSX.Element | null {
  const t = useTranslations(filesCopy)
  const proposals = useMemo(() => groupRevisionProposals(plan.files), [plan.files])
  const { detected, unclear } = proposals
  if (updates === 0 && detected.length === 0 && unclear.length === 0) return null
  const disabled = pending || !onRevisionChange
  return (
    <DecisionSection
      icon={History}
      title={t('folderUpload.revision.title', { count: updates + detected.length || unclear.length })}
      data-testid="folder-upload-revisions"
    >
      {(detected.length > 0 || unclear.length > 0) && <DecisionNote>{t('folderUpload.revision.consequence')}</DecisionNote>}

      {updates > 0 && (
        <DecisionRow
          data-testid="folder-upload-include-updates"
          muted={!includeUpdates}
          control={
            <Checkbox
              checked={includeUpdates}
              onCheckedChange={(checked) => onIncludeUpdatesChange(checked === true)}
              disabled={pending}
              aria-label={t('folderUpload.revision.sameNameTitle', { count: updates })}
            />
          }
          title={<span className="font-medium">{t('folderUpload.revision.sameNameTitle', { count: updates })}</span>}
          detail={t('folderUpload.revision.sameNameReason')}
        />
      )}

      {detected.length > 0 && (
        <DetectedProposals proposals={proposals} disabled={disabled} destination={destination} onRevisionChange={onRevisionChange} />
      )}

      {unclear.length > 0 && (
        <DecisionSubgroup
          title={t('folderUpload.revision.unclearTitle', { count: unclear.length })}
          data-testid="folder-upload-revisions-unclear"
        >
          <DecisionNote>{t('folderUpload.revision.unclearHint')}</DecisionNote>
          {unclear.map((file, index) => (
            <div key={`${index}:${file.originPath}`} data-testid="folder-upload-revision-unclear-row">
              <DecisionRow
                muted={!file.revisionOf.chosen}
                control={<ProposalBox file={file} disabled={disabled} onRevisionChange={onRevisionChange} />}
                title={<DecisionFileName name={file.file.name} />}
                detail={
                  file.revisionOf.newer
                    ? t('folderUpload.revision.reasonSeveral')
                    : t('folderUpload.revision.reasonNotNewer', { name: file.revisionOf.of.name })
                }
              />
              {file.revisionOf.candidates.length > 1 && (
                <DecisionRowExtra>
                  <CandidatePick file={file} disabled={disabled} onRevisionChange={onRevisionChange} />
                </DecisionRowExtra>
              )}
            </div>
          ))}
        </DecisionSubgroup>
      )}
    </DecisionSection>
  )
}

/** The clear matches: a sticky master bar with the count, then the rows, one run per folder. */
function DetectedProposals({
  proposals,
  disabled,
  destination,
  onRevisionChange,
}: {
  proposals: RevisionProposals
  disabled: boolean
  destination: string
  onRevisionChange?: (change: RevisionChange) => void
}): JSX.Element {
  const t = useTranslations(filesCopy)
  const { detected, master, ticked } = proposals
  const runs = groupByFolder(detected)
  const masterLabel =
    master === 'all'
      ? t('folderUpload.revision.masterAll', { count: detected.length })
      : master === 'some'
        ? t('folderUpload.revision.masterSome', { ticked, count: detected.length })
        : t('folderUpload.revision.masterNone', { count: detected.length })
  return (
    <div data-testid="folder-upload-revisions-detected">
      <DecisionBar>
        <DecisionRow
          control={
            <Checkbox
              checked={master === 'all' ? true : master === 'some' ? 'indeterminate' : false}
              onCheckedChange={() => onRevisionChange?.({ files: detected.map((file) => file.file), chosen: masterTarget(master) })}
              disabled={disabled}
              aria-label={masterLabel}
              data-testid="folder-upload-revision-master"
            />
          }
          title={
            <span className="font-medium tabular-nums" data-testid="folder-upload-revision-master-label">
              {masterLabel}
            </span>
          }
          detail={t('folderUpload.revision.seriesReason')}
        />
      </DecisionBar>
      {runs.map((run) => (
        <div key={run.folder} role="group" aria-label={run.folder || destination}>
          {(runs.length > 1 || run.folder !== '') && (
            <DecisionGroupLabel count={run.files.length}>
              <MiddleTruncate text={run.folder || destination} tail={24} />
            </DecisionGroupLabel>
          )}
          {run.files.map((file, index) => (
            <DecisionRow
              key={`${index}:${file.originPath}`}
              data-testid="folder-upload-revision-row"
              muted={!file.revisionOf.chosen}
              control={<ProposalBox file={file} disabled={disabled} onRevisionChange={onRevisionChange} />}
              title={<DecisionFileName name={file.file.name} />}
              detail={
                <DecisionTarget
                  prefix={t('folderUpload.revision.ofPrefix')}
                  name={file.revisionOf.of.name}
                  label={file.revisionOf.of.label}
                />
              }
            />
          ))}
        </div>
      ))}
    </div>
  )
}

/** One file's box: „Als neue Fassung von X ablegen". */
function ProposalBox({
  file,
  disabled,
  onRevisionChange,
}: {
  file: ProposedFile
  disabled: boolean
  onRevisionChange?: (change: RevisionChange) => void
}): JSX.Element {
  const t = useTranslations(filesCopy)
  return (
    <Checkbox
      checked={file.revisionOf.chosen}
      onCheckedChange={(checked) => onRevisionChange?.({ files: [file.file], chosen: checked === true })}
      disabled={disabled}
      aria-label={t('folderUpload.revision.offer', { name: file.revisionOf.of.name })}
      data-testid="folder-upload-revision-choice"
    />
  )
}

/**
 * The documents a file may continue, to choose from. Nothing shows as chosen
 * until the reader chooses: a value in the field over an unticked box looked
 * decided when it was not. Choosing ticks the file (`useUploadDecision`).
 */
function CandidatePick({
  file,
  disabled,
  onRevisionChange,
}: {
  file: ProposedFile
  disabled: boolean
  onRevisionChange?: (change: RevisionChange) => void
}): JSX.Element {
  const t = useTranslations(filesCopy)
  const { candidates, of, chosen } = file.revisionOf
  const describe = (candidate: RevisionTarget) => (candidate.label ? `${candidate.name} · ${candidate.label}` : candidate.name)
  return (
    <Select
      value={chosen ? of.id : ''}
      onValueChange={(targetId) => onRevisionChange?.({ files: [file.file], targetId })}
      disabled={disabled}
    >
      <SelectTrigger size="sm" className="w-full min-w-0" aria-label={t('folderUpload.revision.pick')} data-testid="folder-upload-revision-pick">
        <SelectValue placeholder={t('folderUpload.revision.pick')} />
      </SelectTrigger>
      <SelectContent>
        {candidates.map((candidate) => (
          <SelectItem key={candidate.id} value={candidate.id}>
            {describe(candidate)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/**
 * What the office's upload screening held back, and why (ADR-0086).
 *
 * A statement and a question at once: these files stay on this computer, and
 * each one can be released by the person who knows what it is — the Bauvertrag
 * in a folder called „Verträge". A released file stays in the list, ticked, so
 * the release can be taken back before anything is sent.
 */
function ScreeningSection({
  plan,
  pending,
  onReleaseChange,
}: {
  plan: FolderUploadPlan
  pending: boolean
  onReleaseChange?: (file: File, released: boolean) => void
}): JSX.Element | null {
  const t = useTranslations(filesCopy)
  const screened = plan.files.filter((file) => file.action === 'excluded' || file.screeningReleased)
  if (screened.length === 0) return null
  const excludedCount = screened.filter((file) => file.action === 'excluded').length
  return (
    <Alert variant="warning" data-testid="folder-upload-excluded">
      <ShieldAlert aria-hidden />
      <AlertTitle>{t('folderUpload.excluded', { count: excludedCount })}</AlertTitle>
      <AlertDescription className="space-y-2">
        <span className="block">{t('folderUpload.excludedExplain')}</span>
        <ul className="space-y-1.5 text-xs">
          {screened.slice(0, 20).map((file, index) => (
            <li key={`${index}:${file.originPath}`} className="flex items-start gap-2">
              {onReleaseChange && (
                <Checkbox
                  checked={file.screeningReleased === true}
                  onCheckedChange={(checked) => onReleaseChange(file.file, checked === true)}
                  disabled={pending}
                  aria-label={`${t('folderUpload.releaseFile')}: ${file.originPath}`}
                  data-testid="folder-upload-release"
                />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono">{file.originPath}</span>
                <span className="block opacity-80">
                  {(file.screening ?? []).map((match) => describeNameMatch(match, t)).join(' · ')}
                </span>
              </span>
            </li>
          ))}
          {screened.length > 20 && <li className="opacity-70">+{screened.length - 20}</li>}
        </ul>
      </AlertDescription>
    </Alert>
  )
}

/** Names, because a count nobody can check is a number to be believed. */
function FileNameList({ files }: { files: readonly PlannedFile[] }): JSX.Element {
  const t = useTranslations(filesCopy)
  return (
    <ul className="mt-1 space-y-0.5 text-xs">
      {files.slice(0, 6).map((file, index) => (
        <li key={`${index}:${file.originPath}`} className="truncate opacity-90">
          <span className="font-mono">{file.originPath}</span>
          {file.existingName && (
            <span className="opacity-80"> — {t('folderUpload.alreadyHereAs', { name: file.existingName })}</span>
          )}
          {file.existingArchived && <span className="opacity-80"> ({t('folderUpload.archivedMatch')})</span>}
        </li>
      ))}
      {files.length > 6 && <li className="opacity-70">+{files.length - 6}</li>}
    </ul>
  )
}

/**
 * The whole plan, file by file, behind a disclosure.
 *
 * Collapsed because a summary that is five hundred rows long is not a summary,
 * and open-able because a person about to replace somebody's drawings is
 * entitled to see exactly which ones. `<details>` rather than a Collapsible:
 * nothing here needs to animate, and the native element keeps its keyboard and
 * screen-reader behaviour for free. Opened, it is part of the dialog's one
 * scroll, not a second window inside it.
 */
function PlanDetails({
  plan,
  includeUpdates,
}: {
  plan: FolderUploadPlan
  includeUpdates: boolean
}): JSX.Element | null {
  const t = useTranslations(filesCopy)
  const rows = plan.files
  if (rows.length === 0) return null

  return (
    <details className="rounded-lg border" data-testid="folder-upload-details">
      <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium text-foreground pointer-coarse:py-3">
        {t('folderUpload.showAll', { count: rows.length })}
      </summary>
      <ul className="space-y-0.5 px-3 pb-3">
        {rows.map((file, index) => (
          <li key={`${index}:${file.originPath}`} className="flex min-w-0 items-center gap-2 text-xs">
            <ActionTag file={file} includeUpdates={includeUpdates} />
            <MiddleTruncate text={file.originPath} tail={24} className="min-w-0 flex-1 font-mono text-muted-foreground" />
            {/* The document this row is about to touch, when the project
                calls it something else — a rename here is invisible to the
                drop, and approving a replacement you cannot locate is not
                approval. */}
            {file.existingName && (
              <span className="max-w-[45%] shrink-0 truncate text-muted-foreground/80">
                {t('folderUpload.alreadyHereAs', { name: file.existingName })}
              </span>
            )}
            {file.existingArchived && <span className="shrink-0 text-muted-foreground/80">{t('folderUpload.archivedMatch')}</span>}
          </li>
        ))}
      </ul>
    </details>
  )
}

/** What one row will actually do, given the reader's answers. */
type EffectiveAction = Exclude<PlannedAction, 'update'> | 'revision' | 'skipped'

/**
 * A same-name update the reader keeps, and a new file whose offer is ticked,
 * both come in as a new Fassung and say so; an update switched off is skipped.
 * A list still labelled „Neue Fassung" under an unticked box describes an
 * upload that is not going to happen.
 */
function effectiveAction(file: PlannedFile, includeUpdates: boolean): EffectiveAction {
  if (file.action === 'update') return includeUpdates ? 'revision' : 'skipped'
  if (file.action === 'new' && file.revisionOf?.chosen) return 'revision'
  return file.action
}

/** What this row will do, in one word. */
function ActionTag({ file, includeUpdates }: { file: PlannedFile; includeUpdates: boolean }): JSX.Element {
  const t = useTranslations(filesCopy)
  const effective = effectiveAction(file, includeUpdates)
  return (
    <CountPill
      tone={effective === 'new' || effective === 'revision' ? 'attention' : 'muted'}
      className="min-w-[5.5rem]"
      data-testid={`folder-upload-action-${effective}`}
    >
      {t(`folderUpload.action.${effective}`)}
    </CountPill>
  )
}
