/**
 * A Skizze findable by what is drawn on it (ADR-0149): its search row written
 * from its scene (`sketchSearchFacets`, `lib/search/facets.ts`), when it is filed
 * and when a save publishes a Fassung. A save into a Freigabe draft writes
 * nothing: the search shows the current Fassung.
 */

import 'server-only'
import { sketchSearchFacets } from '@/lib/search/facets'
import { upsertSearchFacets } from '@/lib/search/facets-repository'
import { outlineSketch } from './sketch-outline'
import type { SketchScene } from './sketch-scene'

/** Title, texts and frame names of a scene, as its search row reads them. Pure. */
export function sketchReadingOf(title: string, scene: SketchScene) {
  const outline = outlineSketch(scene)
  return {
    title,
    texts: outline.texts.map((text) => text.text),
    frameNames: outline.frames.flatMap((frame) => (frame.name ? [frame.name] : [])),
  }
}

/** Write the sketch's search row. Never throws: the Fassung has landed, and search is a view of it. */
export async function indexSketchForSearch(input: {
  organizationId: string
  documentId: string
  title: string
  scene: SketchScene
}): Promise<void> {
  try {
    const row = sketchSearchFacets(
      { documentId: input.documentId, organizationId: input.organizationId },
      sketchReadingOf(input.title, input.scene)
    )
    await upsertSearchFacets(input.organizationId, [row])
  } catch (error) {
    console.warn(`[search] the sketch ${input.documentId} could not be indexed (non-fatal):`, error)
  }
}
