'use client'

/**
 * „Skizze auf dieser Seite beginnen“ in the review's page menu (S6, ADR-0150;
 * slice 1 of `docs/roadmap/working-on-a-plan.md`): a new Skizze traced over the
 * page in view. A page has one canvas, its review, so the entry is the review's
 * and not a second editor beside it.
 *
 * Headless first: the click is `document-sketch-from-page`
 * (`POST …/versions/{v}/pages/{n}/sketch`) on the document's current Fassung.
 * The Skizze is a document of its own, so the review opens it as one
 * (`onCreated`): in Files with its review, which is its editor with its pins,
 * the way every Skizze opens. The Skizze lies in the project's sketches folder,
 * or beside the page when the page's folder is not open to every member.
 */

import { PencilRuler } from 'lucide-react'
import { useState } from 'react'
import { createSketchFromPage, currentVersionOf, SketchRequestError } from '@/adapters/api/diagrams-client'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useTranslations } from '@/i18n'
import { diagramsCopy } from '@/i18n/namespaces/diagrams'
import type { ReviewPageActionProps } from '@/features/documents/preview-actions'

/** The refusals the review names, rather than saying only that it failed. */
const NAMED_REFUSALS = ['underlay_held', 'underlay_other_project', 'underlay_unavailable', 'underlay_wider'] as const
type NamedRefusal = (typeof NAMED_REFUSALS)[number]
const isNamed = (reason: string | null | undefined): reason is NamedRefusal =>
  (NAMED_REFUSALS as readonly string[]).includes(reason ?? '')

export function SketchOnPageItem({ documentId, page, onCreated, onFailed }: ReviewPageActionProps) {
  const t = useTranslations(diagramsCopy)
  const [creating, setCreating] = useState(false)

  const create = async () => {
    setCreating(true)
    try {
      const versionId = await currentVersionOf(documentId)
      if (!versionId) throw new Error('no current version')
      onCreated((await createSketchFromPage(documentId, versionId, page)).documentId)
    } catch (error) {
      const reason = error instanceof SketchRequestError ? error.reason : null
      onFailed(isNamed(reason) ? t(`underlay.refused.${reason}`) : t('underlay.createFailed'))
    } finally {
      setCreating(false)
    }
  }

  return (
    <DropdownMenuItem
      // The menu stays open while the Skizze is made: it says so, and a refusal is said beside it.
      onSelect={(event) => {
        event.preventDefault()
        void create()
      }}
      disabled={creating}
      data-testid="sketch-on-page"
    >
      <PencilRuler aria-hidden />
      <span className="flex flex-col">
        <span>{t(creating ? 'underlay.creating' : 'underlay.startOnPage')}</span>
        <span className="text-muted-foreground text-xs">{t('underlay.startOnPageHint')}</span>
      </span>
    </DropdownMenuItem>
  )
}
