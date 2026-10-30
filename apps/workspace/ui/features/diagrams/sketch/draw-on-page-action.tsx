'use client'

/**
 * „Auf Seite zeichnen“ in the PDF viewer's toolbar (S6, ADR-0150): a new Skizze
 * traced over the page in view, opened in the editor at once.
 *
 * Headless first: the click is `document-sketch-from-page`
 * (`POST …/versions/{v}/pages/{n}/sketch`) on the document's current Fassung,
 * then the ordinary read of the new Skizze; the editor is the one every Skizze
 * opens in. The Skizze lies in the project's sketches folder, or beside the
 * page when the page's folder is not open to every member.
 */

import { PencilRuler } from 'lucide-react'
import { useCallback, useState } from 'react'
import { createSketchFromPage, currentVersionOf, getSketch, SketchRequestError, type SketchForEditing } from '@/adapters/api/diagrams-client'
import { ToolbarTextButton } from '@/components/ui/floating-toolbar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslations } from '@/i18n'
import { diagramsCopy } from '@/i18n/namespaces/diagrams'
import type { PreviewPageActionProps } from '@/features/documents/preview-actions'
import { SketchDialog } from './sketch-dialog'

const NO_ELEMENTS: readonly object[] = []
/** The refusals the toolbar names, rather than saying only that it failed. */
const NAMED_REFUSALS = new Set(['underlay_held', 'underlay_other_project', 'underlay_unavailable', 'underlay_wider'])
type NamedRefusal = 'underlay_held' | 'underlay_other_project' | 'underlay_unavailable' | 'underlay_wider'

export function DrawOnPageAction({ documentId, page, contentType }: PreviewPageActionProps) {
  const t = useTranslations(diagramsCopy)
  const [sketch, setSketch] = useState<SketchForEditing | null>(null)
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<'idle' | 'creating' | 'failed'>('idle')
  const [refusal, setRefusal] = useState<NamedRefusal | null>(null)

  const open_ = useCallback(async (sketchId: string) => {
    setSketch(await getSketch(sketchId))
    setOpen(true)
  }, [])
  const create = useCallback(async () => {
    setState('creating')
    setRefusal(null)
    try {
      const versionId = await currentVersionOf(documentId)
      if (!versionId) throw new Error('no current version')
      const created = await createSketchFromPage(documentId, versionId, page)
      await open_(created.documentId)
      setState('idle')
    } catch (error) {
      if (error instanceof SketchRequestError && error.reason && NAMED_REFUSALS.has(error.reason)) setRefusal(error.reason as NamedRefusal)
      setState('failed')
    }
  }, [documentId, page, open_])

  if (contentType !== 'application/pdf') return null
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <ToolbarTextButton
            className="text-foreground gap-1 px-2 [&_svg]:size-3.5"
            data-testid="draw-on-page"
            onClick={() => void create()}
            disabled={state === 'creating'}
          >
            <PencilRuler aria-hidden />
            {t(state === 'creating' ? 'underlay.creating' : 'underlay.drawOnPage')}
          </ToolbarTextButton>
        </TooltipTrigger>
        <TooltipContent side="top" data-testid="draw-on-page-hint">
          {refusal ? t(`underlay.refused.${refusal}`) : t(state === 'failed' ? 'underlay.createFailed' : 'underlay.drawOnPageHint')}
        </TooltipContent>
      </Tooltip>
      {sketch ? (
        <SketchDialog
          key={sketch.versionId ?? sketch.documentId}
          open={open}
          onOpenChange={setOpen}
          source=""
          elements={NO_ELEMENTS}
          title={sketch.title}
          revision={{
            documentId: sketch.documentId,
            baseVersionId: sketch.versionId,
            baseContentHash: sketch.contentHash,
            saveTarget: sketch.saveTarget,
            scene: sketch.scene,
            canWrite: sketch.canWrite,
            links: sketch.links,
            projectId: sketch.projectId,
            underlay: sketch.underlay,
            onUnderlayMoved: () => void open_(sketch.documentId),
          }}
        />
      ) : null}
    </>
  )
}
