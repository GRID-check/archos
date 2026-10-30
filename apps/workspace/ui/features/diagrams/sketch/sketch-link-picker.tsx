'use client'

/**
 * „Verknüpfen“: what a selected sketch element points at (S5,
 * `lib/diagrams/sketch-links.ts`). Three kinds, each found where the workspace
 * already finds it, so the picker is no second index:
 *
 *   - a document and a page: the workspace search (`POST /api/search`), its
 *     passage's page offered as the page;
 *   - a model element: the project's models (`listProjectModels`) and the
 *     model's own element query by name (`POST /api/bim/models/{id}/query`),
 *     so a GlobalId is always one the model has, never typed;
 *   - an Anmerkung on this or another document: the same search, its
 *     annotation section.
 *
 * What is picked comes back as the link to store and as the reading the mark
 * shows until the next open resolves it on the server.
 */

import { useEffect, useMemo, useState } from 'react'
import type { SketchLink, SketchLinkKind } from '@/lib/diagrams/sketch-links'
import type { AnnotationHit, DocumentHit } from '@/lib/search/search-wire'
import { postSearch } from '@/adapters/api/search-client'
import { findModelElements, listProjectModels, type ModelElementHit, type ProjectModel } from '@/adapters/api/bim-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Listbox, ListboxOption } from '@/components/ui/listbox'
import { SearchField } from '@/components/ui/search-field'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useTranslations } from '@/i18n'
import { diagramsCopy } from '@/i18n/namespaces/diagrams'
import type { AvailableSketchLink } from '@/features/documents/sketch-link-target'

/** What a pick stores, and what the mark shows of it meanwhile. */
export interface PickedSketchLink {
  link: SketchLink
  reading: Omit<AvailableSketchLink, 'elementId' | 'kind' | 'ref'>
}

export interface SketchLinkPickerProps {
  projectId: string
  /** The element has a link already: offer to take it off. */
  linked: boolean
  onPick: (picked: PickedSketchLink | null) => void
  onCancel: () => void
}

type ElementHit = ModelElementHit

const SEARCH_DELAY_MS = 250
const HITS = 8

/** `value`, once it stopped changing for a moment. */
function useSettled<T>(value: T, ms = SEARCH_DELAY_MS): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}

/** Ask while the text is set; `null` while asking, `[]` for nothing found. */
function useAsked<T>(ask: ((signal: AbortSignal) => Promise<T[]>) | null): T[] | null {
  const [hits, setHits] = useState<T[] | null>(ask ? null : [])
  useEffect(() => {
    if (!ask) return setHits([])
    const controller = new AbortController()
    setHits(null)
    ask(controller.signal)
      .then((found) => setHits(found))
      .catch(() => {
        if (!controller.signal.aborted) setHits([])
      })
    return () => controller.abort()
  }, [ask])
  return hits
}


const placeOf = (hit: { shelf: 'project' | 'office_shelf'; projectId: string | null }, documentId: string) => ({
  shelf: hit.shelf,
  projectId: hit.projectId,
  documentId,
})

function HitList<T>({ hits, label, onChoose, render }: { hits: T[] | null; label: string; onChoose: (hit: T) => void; render: (hit: T) => React.ReactNode }) {
  const t = useTranslations(diagramsCopy)
  if (hits === null) return <p className="text-muted-foreground px-1 text-xs">{t('sketch.link.searching')}</p>
  if (hits.length === 0) return <p className="text-muted-foreground px-1 text-xs">{t('sketch.link.noResults')}</p>
  return (
    <Listbox aria-label={label} className="max-h-48">
      {hits.map((hit, index) => (
        <ListboxOption key={index} onChoose={() => onChoose(hit)}>
          {render(hit)}
        </ListboxOption>
      ))}
    </Listbox>
  )
}

export function SketchLinkPicker({ projectId, linked, onPick, onCancel }: SketchLinkPickerProps) {
  const t = useTranslations(diagramsCopy)
  const [kind, setKind] = useState<SketchLinkKind>('document')
  const [text, setText] = useState('')
  const asked = useSettled(text.trim())
  const [document, setDocument] = useState<DocumentHit | null>(null)
  const [page, setPage] = useState('')
  const askModels = useMemo(
    () => (kind === 'ifcElement' ? async (signal: AbortSignal) => (await listProjectModels(projectId, signal)).filter((entry) => entry.status === 'ready') : null),
    [kind, projectId]
  )
  const listed = useAsked<ProjectModel>(askModels)
  const ready = useMemo(() => listed ?? [], [listed])
  const [modelId, setModelId] = useState<string | null>(null)
  const model = ready.find((entry) => entry.id === modelId) ?? ready[0] ?? null

  const askDocuments = useMemo(
    () =>
      kind === 'document' && asked
        ? async (signal: AbortSignal) =>
            (await postSearch({ scope: 'project', projectId }, { text: asked, kinds: ['document'], limit: HITS, facets: false }, signal)).sections.document?.hits ?? []
        : null,
    [kind, asked, projectId]
  )
  const askAnnotations = useMemo(
    () =>
      kind === 'annotation' && asked
        ? async (signal: AbortSignal) =>
            (await postSearch({ scope: 'project', projectId }, { text: asked, kinds: ['annotation'], limit: HITS, facets: false }, signal)).sections.annotation?.hits ?? []
        : null,
    [kind, asked, projectId]
  )
  const askElements = useMemo(
    () => (kind === 'ifcElement' && asked && model ? (signal: AbortSignal) => findModelElements(model.id, asked, HITS, signal) : null),
    [kind, asked, model]
  )
  const documents = useAsked<DocumentHit>(askDocuments)
  const annotations = useAsked<AnnotationHit>(askAnnotations)
  const elements = useAsked<ElementHit>(askElements)

  const pickDocument = () => {
    if (!document) return
    const number = Number(page)
    const at = Number.isInteger(number) && number >= 1 && number <= 9999 ? number : undefined
    onPick({
      link: { documentId: document.id, ...(at ? { page: at } : {}) },
      reading: { state: 'available', title: document.name, place: placeOf(document, document.id), ...(at ? { page: at } : {}) },
    })
  }
  const pickElement = (hit: ElementHit) => {
    if (!model) return
    const place = { shelf: model.projectId ? ('project' as const) : ('office_shelf' as const), projectId: model.projectId, documentId: model.documentId }
    onPick({
      link: { documentId: model.documentId, ifcGlobalId: hit.globalId },
      reading: { state: 'available', title: hit.name ? `${hit.name} (${hit.ifcType})` : hit.ifcType, place, modelFile: model.filename },
    })
  }
  const pickAnnotation = (hit: AnnotationHit) =>
    onPick({
      link: { documentId: hit.documentId, annotationId: hit.id },
      reading: {
        state: 'available',
        title: hit.excerpt,
        place: placeOf(hit, hit.documentId),
        status: hit.status as AvailableSketchLink['status'],
        annotationKind: hit.annotationKind as AvailableSketchLink['annotationKind'],
      },
    })

  return (
    <div className="flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2" data-testid="sketch-link-picker">
      <p className="text-sm font-medium">{t('sketch.link.title')}</p>
      <Tabs
        value={kind}
        onValueChange={(next) => {
          setKind(next as SketchLinkKind)
          setDocument(null)
        }}
      >
        <TabsList className="w-full">
          <TabsTrigger value="document">{t('sketch.link.tabDocument')}</TabsTrigger>
          <TabsTrigger value="ifcElement">{t('sketch.link.tabElement')}</TabsTrigger>
          <TabsTrigger value="annotation">{t('sketch.link.tabAnnotation')}</TabsTrigger>
        </TabsList>
      </Tabs>
      {kind === 'ifcElement' && ready.length > 1 ? (
        <Select value={model?.id ?? ''} onValueChange={setModelId}>
          <SelectTrigger aria-label={t('sketch.link.model')} className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ready.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {entry.displayName ?? entry.filename}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      {kind === 'ifcElement' && listed !== null && ready.length === 0 ? (
        <p className="text-muted-foreground text-xs">{t('sketch.link.noModels')}</p>
      ) : document ? (
        <div className="flex items-center gap-2 text-sm">
          <span className="min-w-0 flex-1 truncate">{document.name}</span>
          <label className="flex items-center gap-1 text-xs">
            <span className="text-muted-foreground">{t('sketch.link.page')}</span>
            <Input className="h-8 w-16" inputMode="numeric" value={page} onChange={(event) => setPage(event.target.value.replace(/\D/g, ''))} data-testid="sketch-link-page" />
          </label>
        </div>
      ) : (
        <>
          <SearchField value={text} onChange={setText} placeholder={t('sketch.link.search')} label={t('sketch.link.search')} />
          {kind === 'document' && asked ? (
            <HitList
              hits={documents}
              label={t('sketch.link.tabDocument')}
              onChoose={(hit) => {
                setDocument(hit)
                setPage(hit.passage?.page ? String(hit.passage.page) : '')
              }}
              render={(hit) => <span className="truncate">{hit.name}</span>}
            />
          ) : null}
          {kind === 'ifcElement' && asked ? (
            <HitList
              hits={elements}
              label={t('sketch.link.tabElement')}
              onChoose={pickElement}
              render={(hit) => (
                <span className="truncate">
                  {hit.name ?? '–'} <span className="text-muted-foreground text-xs">{hit.ifcType}</span>
                </span>
              )}
            />
          ) : null}
          {kind === 'annotation' && asked ? (
            <HitList
              hits={annotations}
              label={t('sketch.link.tabAnnotation')}
              onChoose={pickAnnotation}
              render={(hit) => (
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{hit.excerpt}</span>
                  <span className="text-muted-foreground truncate text-xs">{hit.documentName}</span>
                </span>
              )}
            />
          ) : null}
        </>
      )}
      <p className="text-muted-foreground text-xs">{t('sketch.link.hint')}</p>
      <div className="flex items-center justify-end gap-2">
        {linked ? (
          <Button type="button" variant="ghost" size="sm" className="mr-auto" onClick={() => onPick(null)} data-testid="sketch-unlink">
            {t('sketch.link.unlink')}
          </Button>
        ) : null}
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t('sketch.link.cancel')}
        </Button>
        {document ? (
          <Button type="button" size="sm" onClick={pickDocument} data-testid="sketch-link-apply">
            {t('sketch.link.apply')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
