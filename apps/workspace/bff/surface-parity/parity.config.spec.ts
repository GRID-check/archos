// @disk-inputs: tests/fixtures/surface-parity.json, ui/features/cards/components/CanvasActivityCard.tsx, ui/features/cards/components/RevisionCompareCard.tsx, ui/features/chat/components/ViewerActionRow.tsx, ui/features/chat/components/reasoning/LookStepRow.tsx, ui/features/chat/lib/canvas-bridge.ts, ui/features/diagrams/sketch/sketch-pins.tsx, ui/features/documents/components/document-revisions.tsx, ui/features/documents/components/file-preview-pane.tsx, ui/features/documents/components/review/composer.tsx, ui/features/documents/components/review/cursor-chat.tsx, ui/features/documents/components/review/document-review.tsx, ui/features/documents/components/review/mark-row.tsx, ui/features/documents/components/review/review-export-menu.tsx, ui/features/documents/components/review/review-page-layer.tsx, ui/features/documents/components/review/review-panel.tsx, ui/features/documents/components/review/thread-card.tsx, ui/features/documents/hooks/use-canvas-ask.ts, ui/features/documents/lib/review-focus.ts, ui/features/knowledge/components/page-place-button.tsx, ui/features/search/components/composer-search-picker.tsx
/**
 * @vitest-environment node
 */
/**
 * `parity.config.ts` lists every capability of the review canvas with its form
 * on the canvas and in the chat (ADR-0128). These cases hold it against the
 * code: an entry for every annotation op and every canvas operation of the
 * catalog, a mirror or a reason on each side, components that exist, cards the
 * generated schema holds, and no gap that has since been closed.
 *
 * Python reads `tests/fixtures/surface-parity.json`
 * (`packages/agent/tests/tools/test_surface_parity.py`: every tool of the canvas
 * group and `look` has an entry). A changed entry fails here until it is
 * regenerated:
 *
 *   UPDATE_FIXTURES=1 bunx vitest run bff/surface-parity/parity.config.spec.ts
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { BACKEND_OPERATIONS } from '@/lib/agent-api/backend-operations'
import { AGENT_OPERATIONS } from '@/lib/agent-api/catalog'
import { internalAnnotationRequestSchema } from '@/lib/annotations/types'
import { answerCardSchema } from '@/shared/cards/schemas'
import {
  isCanvasOperation,
  SURFACE_CAPABILITIES,
  type SurfaceCapability,
  type SurfaceForm,
} from './parity.config'

const FIXTURE = join(process.cwd(), 'tests/fixtures/surface-parity.json')
const SRC = join(process.cwd(), 'ui')

const entries = Object.entries(SURFACE_CAPABILITIES as Readonly<Record<string, SurfaceCapability>>)
const sides = entries.flatMap(([name, entry]) => [
  { name, side: 'canvas', form: entry.canvas },
  { name, side: 'chat', form: entry.chat },
])

const kindOf = (form: SurfaceForm): 'exempt' | 'gap' | 'rendering' =>
  'exempt' in form ? 'exempt' : 'gap' in form ? 'gap' : 'rendering'

/** The `type` literal of each member of the generated card union. */
function cardTypes(): Set<string> {
  const types = new Set<string>()
  for (const option of answerCardSchema.options) {
    const field = (option as unknown as { shape: { type: { parse: (value: unknown) => unknown } } }).shape.type
    for (const probe of [undefined, '']) {
      try {
        const value = field.parse(probe)
        if (typeof value === 'string') types.add(value)
      } catch {
        /* a literal without a default throws on undefined: its own message names it below */
      }
    }
  }
  return types
}

const annotationOps = (): string[] =>
  internalAnnotationRequestSchema.options.map((option) => option.shape.op.value as string)

describe('the surface parity registry', () => {
  it('reads the generated card union (the check below means something)', () => {
    expect(cardTypes().has('canvas_activity')).toBe(true)
  })

  it('has an entry for every op of the annotation request schema', () => {
    const covered = new Set(entries.map(([, entry]) => entry.annotationOp))
    expect(annotationOps().filter((op) => !covered.has(op as never)), 'give each an entry in parity.config.ts').toEqual([])
    for (const [name, entry] of entries) {
      if (entry.annotationOp) expect(annotationOps(), name).toContain(entry.annotationOp)
    }
  })

  it('has an entry for every canvas operation of the catalog and the backend tools', () => {
    const operations = [...AGENT_OPERATIONS, ...BACKEND_OPERATIONS].map((op) => op.name)
    const canvas = operations.filter(isCanvasOperation)
    const covered = new Set(entries.flatMap(([, entry]) => entry.operations ?? []))
    expect(canvas.filter((name) => !covered.has(name)), 'give each an entry in parity.config.ts').toEqual([])
    expect([...covered].filter((name) => !operations.includes(name)), 'no operation has this name').toEqual([])
  })

  it('gives each side a mirror, an exemption with a reason, or a gap with a slice and a reason', () => {
    for (const { name, side, form } of sides) {
      const label = `${name}.${side}`
      if ('exempt' in form) expect(form.exempt.length, label).toBeGreaterThan(30)
      else if ('gap' in form) {
        expect(form.gap.slice, label).toMatch(/^V\d+/)
        expect(form.gap.reason.length, label).toBeGreaterThan(30)
      } else expect(Object.values(form).filter(Boolean).length, `${label} names no component, card or step`).toBeGreaterThan(0)
    }
  })

  it('does not exempt both sides: a capability that neither surface shows is no capability of the pair', () => {
    for (const [name, entry] of entries) {
      expect([kindOf(entry.canvas), kindOf(entry.chat)], name).not.toEqual(['exempt', 'exempt'])
    }
  })

  it('names components that exist', () => {
    for (const { name, side, form } of sides) {
      if ('component' in form && form.component) expect(existsSync(join(SRC, form.component)), `${name}.${side}: ${form.component}`).toBe(true)
    }
  })

  it('names cards the generated schema holds, and keeps no gap whose card now exists', () => {
    const types = cardTypes()
    for (const { name, side, form } of sides) {
      if ('card' in form && form.card) expect(types.has(form.card), `${name}.${side}: card ${form.card}`).toBe(true)
      if ('gap' in form && form.gap.card) {
        expect(types.has(form.gap.card), `${name}.${side} is closed: write its rendering instead of the gap`).toBe(false)
      }
    }
  })

  it('is what tests/fixtures/surface-parity.json says (UPDATE_FIXTURES=1 rewrites it)', () => {
    const rendered = render()
    if (process.env.UPDATE_FIXTURES === '1') writeFileSync(FIXTURE, rendered)
    expect(readFileSync(FIXTURE, 'utf8')).toBe(rendered)
  })
})

/** The registry as JSON for Python: tool, op, operations and what each side is. */
function render(): string {
  const side = (form: SurfaceForm) => {
    if ('exempt' in form) return { kind: 'exempt', reason: form.exempt }
    if ('gap' in form) return { kind: 'gap', slice: form.gap.slice, reason: form.gap.reason, card: form.gap.card ?? null, step: form.gap.step ?? null }
    return { kind: 'rendering', component: form.component ?? null, card: form.card ?? null, step: form.step ?? null }
  }
  const capabilities = Object.fromEntries(
    entries.map(([name, entry]) => [
      name,
      {
        summary: entry.summary,
        tool: entry.tool ?? null,
        annotationOp: entry.annotationOp ?? null,
        operations: entry.operations ?? [],
        canvas: side(entry.canvas),
        chat: side(entry.chat),
      },
    ]),
  )
  const fixture = {
    comment:
      'Where each canvas capability is shown: apps/workspace/bff/surface-parity/parity.config.ts, written by ' +
      'parity.config.spec.ts (UPDATE_FIXTURES=1). `tool` is the name the model binds (`canvas__mark`, `look`).',
    capabilities,
  }
  return `${JSON.stringify(fixture, null, 1)}\n`
}
