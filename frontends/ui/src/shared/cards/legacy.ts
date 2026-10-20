// Card payloads written before the English field names.
//
// A card lives in `messages.metadata` and in browser storage long after the
// build that wrote it, so a stored card still says `aufstellflaeche`,
// `context: 'balkon'` or `kind: 'fluchtniveau'`. The generated schema accepts
// only the English names, and a card that fails it is a hole in the thread.
// The migration rewrote the table once; this keeps the cards in flight (an older
// pod, a tab's localStorage) readable. Read-only: nothing writes these.

/** Where a draft lived before the working directory had an English root. */
export const LEGACY_DRAFT_ROOT = '/entwuerfe/'
export const DRAFT_ROOT = '/drafts/'

/** `guardrail_check.context`. */
export const LEGACY_GUARDRAIL_CONTEXT: Readonly<Record<string, string>> = {
  balkon: 'balcony',
  stiege: 'staircase',
  fenster: 'window',
  dachterrasse: 'roof_terrace',
}

/** `building_section.markers[].kind`. */
export const LEGACY_SECTION_MARKER_KIND: Readonly<Record<string, string>> = {
  fluchtniveau: 'escape_level',
}

/** `fire_access_plan` field names. */
export const LEGACY_FIRE_ACCESS_FIELDS: Readonly<Record<string, string>> = {
  aufstellflaeche: 'staging_area',
  gebaeudeklasse: 'building_class',
}

/** `document_grid.documents[].source` and `file_operation_proposal.operations[].source`. */
export const LEGACY_DOCUMENT_SOURCE: Readonly<Record<string, string>> = {
  projekt: 'project',
  buero: 'office',
}

const modernizeSource = (item: unknown): unknown =>
  isRecord(item) && typeof item.source === 'string' && Object.hasOwn(LEGACY_DOCUMENT_SOURCE, item.source)
    ? { ...item, source: LEGACY_DOCUMENT_SOURCE[item.source] }
    : item

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A draft path with its root spelled the English way. */
export const modernizeDraftPath = (path: string): string => {
  const trimmed = path.trimStart()
  if (trimmed.startsWith(LEGACY_DRAFT_ROOT)) return DRAFT_ROOT + trimmed.slice(LEGACY_DRAFT_ROOT.length)
  if (trimmed.startsWith(LEGACY_DRAFT_ROOT.slice(1))) {
    return DRAFT_ROOT.slice(1) + trimmed.slice(LEGACY_DRAFT_ROOT.length - 1)
  }
  return path
}

/** A card with the English field names and values, whichever spelling it came in. */
export function modernizeGridCard(card: unknown): unknown {
  if (!isRecord(card)) return card
  switch (card.type) {
    case 'fire_access_plan': {
      const out: Record<string, unknown> = { ...card }
      for (const [old, next] of Object.entries(LEGACY_FIRE_ACCESS_FIELDS)) {
        if (!(old in out)) continue
        if (!(next in out)) out[next] = out[old]
        delete out[old]
      }
      return out
    }
    case 'guardrail_check': {
      const context = card.context
      return typeof context === 'string' && Object.hasOwn(LEGACY_GUARDRAIL_CONTEXT, context)
        ? { ...card, context: LEGACY_GUARDRAIL_CONTEXT[context] }
        : card
    }
    case 'building_section': {
      if (!Array.isArray(card.markers)) return card
      return {
        ...card,
        markers: card.markers.map((marker: unknown) =>
          isRecord(marker) && typeof marker.kind === 'string' && Object.hasOwn(LEGACY_SECTION_MARKER_KIND, marker.kind)
            ? { ...marker, kind: LEGACY_SECTION_MARKER_KIND[marker.kind] }
            : marker
        ),
      }
    }
    case 'document_grid':
      return Array.isArray(card.documents) ? { ...card, documents: card.documents.map(modernizeSource) } : card
    case 'file_operation_proposal':
      return Array.isArray(card.operations) ? { ...card, operations: card.operations.map(modernizeSource) } : card
    case 'document_draft':
      return typeof card.path === 'string' ? { ...card, path: modernizeDraftPath(card.path) } : card
    default:
      return card
  }
}
