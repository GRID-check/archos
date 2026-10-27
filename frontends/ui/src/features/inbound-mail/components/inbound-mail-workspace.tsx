'use client'

/**
 * Dateien › E-Mail-Eingang (ADR-0134, DECISION §9): the list of held mail read
 * against the open mail, a split with no overlay (the „second pane“ case of
 * the design language's overlay table).
 *
 * LAYOUT BY CONTAINER, NOT BY VIEWPORT. The list is 22rem and the detail the
 * rest while this component's own box is wider than 48rem (`@3xl`); below
 * that it is list → detail, the detail a page of its own with the way back at
 * its top. The URL carries the open mail (`/files/mail/<id>`, pushed, so Back
 * closes it) and the filter (`?status=handled&outcome=…`, replaced: a filter
 * is not a place).
 *
 * THE KEYBOARD (group `inboundMail` in `components/shell/shortcuts.ts`):
 * J/K walk the rows, Enter opens the row, X selects it, Space previews the
 * open mail's first attachment, E files the open mail as the bar shows it,
 * ⌫ dismisses (the selection, or else the open mail). Each key goes through
 * the same control a pointer would press, so busy and confirm states hold.
 * None of them fires while a field has the focus or a dialog is open.
 *
 * „WIE VORGESCHLAGEN ABLEGEN“ comes in four sizes, all through one rule
 * (`fileableReason`, `asSuggested` in `../lib/completeness.ts`): a ready row's
 * own button (one mail, one press, no confirmation: the row already says
 * where its text goes, and the toast says where everything went), the „Bereit“
 * heading's „Alle … ablegen“, a thread group's press, and a selection's bulk
 * bar. Each knows from the list whether its mails are complete
 * (`incompleteReason`, the server's, on each row), reads them (at most twenty,
 * the most one request may decide) and checks them once more as they are now
 * before anything is sent. The request carries no acknowledgement (RT-S5); the
 * several-mail sizes confirm first, listing where everything goes.
 */

import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ArrowLeft, AtSign, FolderOpen, Lock, MailSearch, X } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { ProjectSectionActions } from '@/components/shell/project-section-frame'
import { useTranslations } from '@/i18n'
import {
  INBOUND_MAIL_DECISION_MAX_MAILS,
  INBOUND_MAIL_LIST_LIMIT,
  type InboundMailListStatus,
  type InboundMailListView,
  type InboundMailOutcome,
  type InboundMailTextView,
  type InboundMailView,
  type IncompleteReason,
} from '@/lib/inbound-mail/inbound-mail-wire'
import { capturePosthog } from '@/lib/analytics/posthog'
import type { InboundMailDecision } from '@/lib/inbound-mail/inbound-mail-wire'
import { cn } from '@/lib/utils'
import { bulkSelectable } from '../lib/impersonation'
import { inboundMailAddressClient, inboundMailClient, type InboundMailAddressClient, type InboundMailClient } from '../lib/client'
import { asSuggested, fileableReason, type BulkDestination, type BulkPlan } from '../lib/completeness'
import type { DraftCopy, FolderOption } from '../lib/draft'
import { listSections, visibleMails } from '../lib/list-sections'
import { inboundMailPaths, type InboundMailPaths } from '../lib/paths'
import { refusalOf } from '../lib/refusal'
import { primeInboundMailWaiting, refreshInboundMailWaiting, useInboundMailWaiting } from '../hooks/use-inbound-mail-waiting'
import { InboundMailAddressBlock, InboundMailAddressDialog } from './inbound-mail-address'
import { InboundMailDetail, type DetailActions } from './inbound-mail-detail'
import { InboundMailList, type ListState } from './inbound-mail-list'
import { SelectionBar, type BulkBlock } from './selection-bar'

export interface InboundMailWorkspaceProps {
  projectId: string
  projectName: string
  projectClosed: boolean
  folders: readonly FolderOption[]
  status: InboundMailListStatus
  outcome: InboundMailOutcome | null
  /** The first page as the server read it; null reads it here (or says it failed). */
  initialList: InboundMailListView | null
  /** The open mail, or null for the list alone. */
  mailId: string | null
  initialMail: InboundMailView | null
  initialText?: InboundMailTextView | null
  client?: InboundMailClient
  addressClient?: InboundMailAddressClient
  paths?: InboundMailPaths
  /** The list failed on the server: show its error instead of reading again. */
  initialListFailed?: boolean
  /** Previews pin these. */
  now?: number
  decidedByOther?: boolean
  /** Keep the list empty-and-loading (a preview of the skeleton). */
  listLoading?: boolean
  /** Mails checked on arrival (a preview of the selection). */
  initialChecked?: readonly string[]
}

/** Where a filing as suggested was pressed, for PostHog. */
type AsSuggestedSurface = 'row' | 'ready_section' | 'thread_group' | 'selection'

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

export function InboundMailWorkspace({
  projectId,
  projectName,
  projectClosed,
  folders,
  status,
  outcome,
  initialList,
  mailId,
  initialMail,
  initialText,
  client = inboundMailClient,
  addressClient = inboundMailAddressClient,
  paths: pathsProp,
  initialListFailed = false,
  now,
  decidedByOther,
  listLoading = false,
  initialChecked,
}: InboundMailWorkspaceProps): JSX.Element {
  const t = useTranslations('inboundMail')
  const router = useRouter()
  const paths = useMemo(() => pathsProp ?? inboundMailPaths(projectId), [pathsProp, projectId])
  const filter = useMemo(() => ({ status, outcome }), [status, outcome])
  const [list, setList] = useState<ListState>(
    listLoading ? { kind: 'loading' } : initialList ? { kind: 'ready', ...initialList } : initialListFailed ? { kind: 'error' } : { kind: 'loading' }
  )
  const [loadingMore, setLoadingMore] = useState(false)
  const [checked, setChecked] = useState<Set<string>>(() => new Set(initialChecked))
  const [focusedId, setFocusedId] = useState<string | null>(mailId)
  const [quietOpen, setQuietOpen] = useState(false)
  const [closedNoticeHidden, setClosedNoticeHidden] = useState(false)
  const [addressOpen, setAddressOpen] = useState(false)
  const [everReceived, setEverReceived] = useState<boolean | null>(null)
  const [address, setAddress] = useState<Awaited<ReturnType<InboundMailAddressClient['get']>> | null>(null)
  const detailActions = useRef<DetailActions | null>(null)
  const waiting = useInboundMailWaiting(projectId, true, client)

  const copy: DraftCopy = useMemo(
    () => ({ unnamedAttachment: (position) => t('attachments.unnamed', { position }), untitledThread: t('row.noSubject') }),
    [t]
  )

  // The page's first page of the waiting list is also the count every surface shows.
  useEffect(() => {
    if (initialList && status === 'waiting') {
      primeInboundMailWaiting(projectId, { count: initialList.items.filter((mail) => mail.status === 'waiting').length, more: initialList.nextCursor !== null })
    }
  }, [initialList, projectId, status])

  const reload = useCallback(async () => {
    try {
      const page = await client.list(projectId, { status, outcome: outcome ?? undefined, limit: INBOUND_MAIL_LIST_LIMIT })
      setList({ kind: 'ready', ...page })
    } catch {
      setList((current) => (current.kind === 'ready' ? current : { kind: 'error' }))
    }
  }, [client, projectId, status, outcome])

  // A filter change (or no first page from the server) reads the list here.
  const firstFilter = useRef(`${status}:${outcome ?? ''}`)
  useEffect(() => {
    if (listLoading) return
    const key = `${status}:${outcome ?? ''}`
    if (key === firstFilter.current && (initialList || initialListFailed)) return
    firstFilter.current = ''
    setList({ kind: 'loading' })
    void reload()
  }, [status, outcome, reload, initialList, initialListFailed, listLoading])

  const changed = useCallback(() => {
    void reload()
    void refreshInboundMailWaiting(projectId, client)
  }, [reload, projectId, client])

  const items = useMemo(() => (list.kind === 'ready' ? list.items : []), [list])
  const groups = useMemo(() => (list.kind === 'ready' ? list.threadGroups : []), [list])
  const sections = useMemo(() => listSections(items, { grouped: status === 'waiting', groups }), [items, status, groups])
  const rows = useMemo(() => visibleMails(sections, quietOpen), [sections, quietOpen])

  // An empty waiting list is „never used“ or „all done“: the address says which, and is shown in the first.
  const empty = list.kind === 'ready' && list.items.length === 0 && status === 'waiting'
  useEffect(() => {
    if (!empty || everReceived !== null) return
    addressClient
      .get(projectId)
      .then((view) => {
        setAddress(view)
        setEverReceived(view.lastReceivedAt !== null)
      })
      .catch(() => setEverReceived(true))
  }, [empty, everReceived, addressClient, projectId])

  // ------------------------------------------------------------ selection and bulk

  const selectedIds = useMemo(() => items.filter((mail) => checked.has(mail.id)).map((mail) => mail.id), [items, checked])
  const [views, setViews] = useState<Map<string, InboundMailView>>(new Map())
  const [bulkFiling, setBulkFiling] = useState<string | null>(null)
  const [bulkDismissing, setBulkDismissing] = useState(false)
  const [confirmFile, setConfirmFile] = useState<{ decisions: InboundMailDecision[]; plan: BulkPlan; surface: AsSuggestedSurface } | null>(null)
  const [rowFiling, setRowFiling] = useState<string | null>(null)
  const [confirmDismiss, setConfirmDismiss] = useState(false)

  /** Read the mails a bulk filing sends (at most twenty), keeping what is already read and current. */
  const readViews = useCallback(
    async (ids: string[]): Promise<Map<string, InboundMailView>> => {
      const updatedAt = new Map(items.map((mail) => [mail.id, mail.updatedAt]))
      const stale = ids.filter((id) => views.get(id)?.updatedAt !== updatedAt.get(id))
      if (stale.length === 0) return views
      const read = await Promise.all(stale.map((id) => client.get(projectId, id).catch(() => null)))
      const next = new Map(views)
      for (const view of read) if (view) next.set(view.id, view)
      setViews(next)
      return next
    },
    [items, views, client, projectId]
  )

  /** Why these mails cannot be filed as suggested in one request, the first reason with its count; null when they can. */
  const blockFor = useCallback((ids: string[], reasonOf: (id: string) => IncompleteReason | null): BulkBlock => {
    if (ids.length > INBOUND_MAIL_DECISION_MAX_MAILS) return { reason: 'too_many', count: ids.length }
    const reasons = new Map<IncompleteReason, number>()
    for (const id of ids) {
      const reason = reasonOf(id)
      if (reason) reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
    }
    const first = [...reasons.entries()][0]
    return first ? { reason: first[0], count: first[1] } : null
  }, [])

  // The list says it per mail (`incompleteReason`), so the bar knows without reading a single mail.
  const summaryReason = useCallback(
    (id: string): IncompleteReason | null => {
      const mail = items.find((candidate) => candidate.id === id)
      return mail ? fileableReason(mail) : 'not_waiting'
    },
    [items]
  )
  const selectionBlock = blockFor(selectedIds, summaryReason)

  /** The destinations of a filing, in the confirmation's words: „In „Behörde/Bescheide“: 1“. */
  const destinationLine = (destination: BulkDestination): string =>
    destination.kind === 'folder' && destination.label === ''
      ? t('bulk.destination.root', { count: destination.count })
      : t(`bulk.destination.${destination.kind}`, { label: destination.label, count: destination.count })

  /**
   * Read these mails as they are now and build their filing as suggested; on a
   * refusal, say why (or open a group's first mail) and answer null.
   */
  const prepare = async (ids: string[], groupId: string | null): Promise<Extract<ReturnType<typeof asSuggested>, { ok: true }> | null> => {
    const refuse = (block: BulkBlock): boolean => {
      if (!block) return false
      // A group that cannot go in one press is opened at its first mail.
      if (groupId) router.push(paths.mail(ids[0], filter))
      else toast.error(t(`bulk.blocked.${block.reason}`, { count: block.count, max: INBOUND_MAIL_DECISION_MAX_MAILS }))
      return true
    }
    if (refuse(blockFor(ids, summaryReason))) return null
    const read = await readViews(ids)
    // The mails as they are now: one may have changed since the list was read.
    const current = ids.map((id) => read.get(id)).filter((view): view is InboundMailView => !!view)
    if (current.length < ids.length) {
      refuse({ reason: 'not_waiting', count: ids.length - current.length })
      changed()
      return null
    }
    const built = asSuggested(current, folders, copy)
    if (!built.ok) {
      refuse({ reason: built.reason, count: built.count })
      changed()
      return null
    }
    return built
  }

  const askFile = async (ids: string[], groupId: string | null, surface: AsSuggestedSurface): Promise<void> => {
    if (groupId) setBulkFiling(groupId)
    const built = await prepare(ids, groupId).finally(() => groupId && setBulkFiling(null))
    if (built) setConfirmFile({ decisions: built.decisions, plan: built.plan, surface })
  }

  /** Send a filing as suggested and say where everything goes. */
  const send = async (decisions: InboundMailDecision[], plan: BulkPlan, surface: AsSuggestedSurface): Promise<void> => {
    await client.file(projectId, { mails: decisions })
    toast.success(t('toast.filedAsSuggested', { count: decisions.length }), {
      description: plan.destinations.map(destinationLine).join(' · '),
    })
    // Whether „Bereit“ is the way people file: by surface, how many mails per press.
    capturePosthog('inbound_mail_filed_as_suggested', { surface, mails: decisions.length, files: plan.files, texts: plan.texts })
    changed()
  }

  /** A ready row's own press: one mail, read again and checked, then filed with no confirmation. */
  const fileOne = async (mailId: string): Promise<void> => {
    if (rowFiling) return
    setRowFiling(mailId)
    try {
      const built = await prepare([mailId], null)
      if (built) await send(built.decisions, built.plan, 'row')
    } catch (error) {
      toast.error(t(`refusals.${refusalOf(error)}`))
      changed()
    } finally {
      setRowFiling(null)
    }
  }

  const fileConfirmed = async (): Promise<void> => {
    if (!confirmFile) return
    setBulkFiling('selection')
    try {
      await send(confirmFile.decisions, confirmFile.plan, confirmFile.surface)
      setChecked(new Set())
    } catch (error) {
      toast.error(t(`refusals.${refusalOf(error)}`))
      changed()
      throw error
    } finally {
      setBulkFiling(null)
    }
  }

  const dismissConfirmed = async (): Promise<void> => {
    setBulkDismissing(true)
    try {
      await client.dismiss(projectId, { mailIds: selectedIds })
      toast.success(t('toast.dismissedMany', { count: selectedIds.length }))
      setChecked(new Set())
      changed()
    } catch (error) {
      toast.error(t(`refusals.${refusalOf(error)}`))
      throw error
    } finally {
      setBulkDismissing(false)
    }
  }

  const toggle = (id: string, value: boolean): void =>
    setChecked((current) => {
      const next = new Set(current)
      if (value) next.add(id)
      else next.delete(id)
      return next
    })

  // ------------------------------------------------------------ keyboard

  const keyState = useRef({ rows, focusedId, mailId, selectedIds })
  keyState.current = { rows, focusedId, mailId, selectedIds }
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return
      const { rows: visible, focusedId: focus, mailId: open, selectedIds: selected } = keyState.current
      const index = visible.findIndex((mail) => mail.id === (focus ?? open))
      const key = event.key
      if (key === 'j' || key === 'k') {
        event.preventDefault()
        if (visible.length === 0) return
        const next = index < 0 ? (key === 'j' ? 0 : visible.length - 1) : Math.min(visible.length - 1, Math.max(0, index + (key === 'j' ? 1 : -1)))
        setFocusedId(visible[next].id)
        document.querySelector(`[data-mail-id="${CSS.escape(visible[next].id)}"]`)?.scrollIntoView({ block: 'nearest' })
        return
      }
      if (key === 'Enter') {
        if (event.target instanceof HTMLElement && event.target.closest('button, a, [role="radio"], [role="checkbox"]')) return
        const target = index >= 0 ? visible[index] : null
        if (!target) return
        event.preventDefault()
        router.push(paths.mail(target.id, filter))
        return
      }
      if (key === 'x') {
        const target = index >= 0 ? visible[index] : null
        // An impersonation is never part of a bulk decision (`bulkSelectable`): its row has no box, and X selects nothing.
        if (!target || !bulkSelectable(target)) return
        event.preventDefault()
        toggle(target.id, !checked.has(target.id))
        return
      }
      if (key === ' ' && open) {
        if (event.target instanceof HTMLElement && event.target.closest('button, a, [role="radio"], [role="checkbox"]')) return
        event.preventDefault()
        detailActions.current?.preview()
        return
      }
      if (key === 'e' && open) {
        event.preventDefault()
        detailActions.current?.file()
        return
      }
      if (key === 'Backspace' || key === 'Delete') {
        event.preventDefault()
        if (selected.length > 0) setConfirmDismiss(true)
        else if (open) detailActions.current?.dismiss()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [router, paths, filter, checked])

  // ------------------------------------------------------------ render

  const notice =
    projectClosed && !closedNoticeHidden ? (
      <Alert className="rounded-none border-x-0 border-t-0" data-testid="inbound-mail-closed">
        <Lock aria-hidden className="text-warning" />
        <AlertTitle className="line-clamp-none">{t('closed.title')}</AlertTitle>
        <AlertDescription className="flex items-center justify-between gap-2">
          <span>{t('closed.text')}</span>
          <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={t('closed.dismiss')} onClick={() => setClosedNoticeHidden(true)}>
            <X className="size-4" aria-hidden />
          </Button>
        </AlertDescription>
      </Alert>
    ) : null

  const selectionBar =
    selectedIds.length > 0 ? (
      <SelectionBar
        count={selectedIds.length}
        block={selectedIds.length > INBOUND_MAIL_DECISION_MAX_MAILS ? { reason: 'too_many', count: selectedIds.length } : selectionBlock}
        max={INBOUND_MAIL_DECISION_MAX_MAILS}
        filing={bulkFiling === 'selection'}
        dismissing={bulkDismissing}
        onFile={() => void askFile(selectedIds, null, 'selection')}
        onDismiss={() => setConfirmDismiss(true)}
        onClear={() => setChecked(new Set())}
      />
    ) : null

  const back = (
    <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit @3xl:hidden">
      <Link href={paths.list(filter)} data-testid="inbound-mail-back">
        <ArrowLeft className="size-4" aria-hidden />
        {t('title')}
      </Link>
    </Button>
  )

  return (
    <div className="@container flex h-full min-h-0 flex-col" data-testid="inbound-mail-workspace">
      <ProjectSectionActions>
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link href={paths.files} data-testid="inbound-mail-files">
              <FolderOpen className="size-4" aria-hidden />
              {t('back')}
            </Link>
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setAddressOpen(true)} data-testid="inbound-mail-address-open">
            <AtSign className="size-4" aria-hidden />
            {t('addressButton')}
          </Button>
        </div>
      </ProjectSectionActions>
      <div className="flex min-h-0 flex-1 flex-col @3xl:grid @3xl:grid-cols-[22rem_minmax(0,1fr)]">
        <div className={cn('min-h-0 flex-1 flex-col @3xl:flex @3xl:border-r', mailId ? 'hidden' : 'flex')}>
          <div className="flex items-baseline justify-between gap-2 px-3 pt-3 sm:px-4">
            <h2 className="text-sm font-semibold">{t('title')}</h2>
          </div>
          <InboundMailList
            state={list}
            sections={sections}
            status={status}
            onFilterChange={(nextStatus, nextOutcome) => {
              setChecked(new Set())
              router.replace(paths.list({ status: nextStatus, outcome: nextOutcome }))
            }}
            waitingCount={waiting.count}
            openId={mailId}
            focusedId={focusedId}
            checked={checked}
            onCheckedChange={toggle}
            onFocusRow={setFocusedId}
            hrefFor={(id) => paths.mail(id, filter)}
            quietOpen={quietOpen}
            onQuietOpenChange={setQuietOpen}
            onFileGroup={(threadId, ids) => void askFile(ids, threadId, 'thread_group')}
            fileGroupBusy={bulkFiling}
            onFileOne={(id) => void fileOne(id)}
            fileOneBusy={rowFiling}
            onFileReady={(ids) => void askFile(ids, null, 'ready_section')}
            onRetry={() => reload()}
            onLoadMore={async () => {
              if (list.kind !== 'ready' || !list.nextCursor) return
              setLoadingMore(true)
              try {
                const page = await client.list(projectId, { status, outcome: outcome ?? undefined, cursor: list.nextCursor })
                // A thread grouped on an earlier page keeps that group; a later page adds only threads it starts.
                const known = new Set(list.threadGroups.map((group) => group.threadId))
                setList({
                  kind: 'ready',
                  items: [...list.items, ...page.items],
                  threadGroups: [...list.threadGroups, ...page.threadGroups.filter((group) => !known.has(group.threadId))],
                  nextCursor: page.nextCursor,
                })
              } catch {
                toast.error(t('loadError'))
              } finally {
                setLoadingMore(false)
              }
            }}
            loadingMore={loadingMore}
            everReceived={everReceived}
            addressBlock={address ? <InboundMailAddressBlock address={address} projectName={projectName} showRules={false} /> : null}
            selectionBar={selectionBar}
            notice={notice}
          />
        </div>
        <div className={cn('min-h-0 flex-1 @3xl:block', mailId ? 'block overflow-y-auto overscroll-contain' : 'hidden')} data-testid="inbound-mail-detail-pane">
          {mailId ? (
            <InboundMailDetail
              key={mailId}
              projectId={projectId}
              mailId={mailId}
              initial={initialMail}
              initialText={initialText}
              folders={folders}
              client={client}
              onChanged={changed}
              back={back}
              actionsRef={detailActions}
              now={now}
              decidedByOther={decidedByOther}
            />
          ) : (
            <div className="p-6">
              <EmptyState icon={MailSearch} title={t('noSelection')} />
            </div>
          )}
        </div>
      </div>

      <InboundMailAddressDialog projectId={projectId} projectName={projectName} open={addressOpen} onOpenChange={setAddressOpen} client={addressClient} />
      <ConfirmDialog
        open={confirmFile !== null}
        onOpenChange={(open) => !open && setConfirmFile(null)}
        title={confirmFile ? t('bulk.confirmTitle', { count: confirmFile.plan.mails }) : ''}
        description={
          confirmFile ? (
            <div className="flex flex-col gap-2">
              <p>{t('bulk.confirmSummary', { files: confirmFile.plan.files, texts: confirmFile.plan.texts })}</p>
              <ul className="flex flex-col gap-1" data-testid="bulk-destinations">
                {confirmFile.plan.destinations.map((destination) => (
                  <li key={`${destination.kind}:${destination.label}`} className="[overflow-wrap:anywhere]">
                    {destinationLine(destination)}
                  </li>
                ))}
              </ul>
            </div>
          ) : undefined
        }
        confirmLabel={t('bulk.confirm')}
        cancelLabel={t('bulk.cancel')}
        onConfirm={fileConfirmed}
        confirmTestId="bulk-file-confirm"
      />
      <ConfirmDialog
        open={confirmDismiss}
        onOpenChange={setConfirmDismiss}
        title={t('bulk.dismissTitle', { count: selectedIds.length })}
        description={t('bulk.dismissText')}
        confirmLabel={t('bulk.dismissConfirm')}
        cancelLabel={t('bulk.cancel')}
        tone="warning"
        onConfirm={dismissConfirmed}
        confirmTestId="bulk-dismiss-confirm"
      />
    </div>
  )
}
