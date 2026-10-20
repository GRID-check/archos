/**
 * The review's shape (ADR-0111), from the real intake definition: every value
 * under a key a question writes, in that question's module and with its
 * label and display; a value with alternatives listed again as a
 * contradiction; the derived class shown once, in the derivations, not again
 * in its module (but among the contradictions when contested); the questions
 * are the decisive needs nothing filled; and a key no question writes is not
 * shown.
 */

import { describe, expect, it } from 'vitest'
import { projectIntakeDefinitionV1 } from '@/lib/project-profile/intake-definition'
import type { ProjectProfile } from '@/lib/project-profile/types'
import type { ProjectIntakeRow } from '@/lib/db/schema/project-intakes'
import type { Need } from './types'
import { buildIntakeView } from './view'

const NOW = '2026-10-14T09:00:00.000Z'
const PROJECT = '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f'
const DOCUMENT = { kind: 'document' as const, fileName: 'Einreichplan.pdf', page: 2, quote: 'Wohngebäude' }

const row = {
  id: 'intake-1',
  organizationId: 'org_1',
  projectId: PROJECT,
  createdBy: 'u',
  mode: 'active',
  description: null,
  location: null,
  closing: null,
  status: 'ready',
  jobId: 'intake-job-1',
  requestedBy: 'u',
  traceId: null,
  rerunRequested: false,
  documentsRead: [{ documentId: '0b7c8f5e-1d1e-4c39-9d2c-3f0f6c1a2b3c', contentHash: 'sha256:a' }],
  dismissed: [],
  counts: null,
  summary: 'Gelesen.',
  startedAt: new Date(NOW),
  finishedAt: new Date(NOW),
  completedAt: null,
  completedBy: null,
  createdAt: new Date(NOW),
  updatedAt: new Date(NOW),
} satisfies ProjectIntakeRow

const profile: ProjectProfile = {
  facts: {
    federal_state: {
      value: 'vienna',
      confidence: 'confirmed',
      source: 'onboarding',
      updatedAt: NOW,
      alternatives: [{ value: 'lower_austria', evidence: [DOCUMENT], recordedAt: NOW }],
    },
    nicht_im_assistenten: { value: 'x', confidence: 'confirmed', source: 'admin_edit', updatedAt: NOW },
  },
  goals: {},
  unknowns: [],
  assumptions: {
    'building_type@bldg1': { value: 'building', status: 'unconfirmed', reason: 'r', source: 'agent_suggested', updatedAt: NOW, evidence: [DOCUMENT] },
    'building_class@bldg1': { value: 3, status: 'unconfirmed', reason: 'r', source: 'agent_suggested', updatedAt: NOW },
  },
}

const need = (key: string, decisive: boolean, state: Need['state'] = 'open'): Need => ({
  key,
  baseKey: key.split('@')[0],
  bauwerkId: 'bldg1',
  label: key,
  type: 'number_tri',
  foundIn: [],
  decisive,
  state,
})

const input = () => ({
  row,
  profile,
  definition: projectIntakeDefinitionV1,
  needs: [need('escape_level_m@bldg1', true), need('gfa_above_ground@bldg1', false), need('building_type@bldg1', true, 'suggested')],
  unreadDocuments: 3,
  canDecide: true,
  canComplete: false,
})

const view = () => buildIntakeView(input())

describe('buildIntakeView', () => {
  it('groups every value by its module, labelled and displayed as the wizard does', () => {
    const { groups } = view()
    const projektbasis = groups.find((group) => group.title === 'Projektbasis')
    const buildings = groups.find((group) => group.title === 'Bauwerke')

    expect(projektbasis?.items).toEqual([
      expect.objectContaining({ key: 'federal_state', value: 'vienna', display: 'Wien', state: 'contested', bauwerkId: null }),
    ])
    expect(buildings?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'building_type@bldg1',
          baseKey: 'building_type',
          bauwerkId: 'bldg1',
          label: 'Bauwerkstyp',
          display: 'Gebäude',
          state: 'suggested',
          evidence: [DOCUMENT],
          decisive: true,
        }),
      ])
    )
    expect(JSON.stringify(groups)).not.toContain('nicht_im_assistenten')
  })

  it('shows the derived class only in the derivations, never again in its module', () => {
    const result = view()
    expect(result.groups.flatMap((group) => group.items).map((item) => item.key)).not.toContain('building_class@bldg1')
    expect(result.derivations.map((derivation) => derivation.bauwerkId)).toEqual(['bldg1'])
    // …and carried there, so the review has a row to confirm it through.
    expect(result.derivations[0]?.suggestion).toMatchObject({ key: 'building_class@bldg1', state: 'suggested' })
  })

  it('still lists a contested derived class among the contradictions', () => {
    const contested: ProjectProfile = {
      ...profile,
      facts: {
        ...profile.facts,
        'building_class@bldg1': {
          value: 2,
          confidence: 'confirmed',
          source: 'user_confirmed',
          updatedAt: NOW,
          alternatives: [{ value: 3, evidence: [DOCUMENT], recordedAt: NOW }],
        },
      },
    }
    const result = buildIntakeView({ ...input(), profile: contested })
    expect(result.contradictions).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'building_class@bldg1', display: 'GK 2', state: 'contested' })])
    )
    expect(result.counts.contradictions).toBe(2)
    expect(result.groups.flatMap((group) => group.items).map((item) => item.key)).not.toContain('building_class@bldg1')
  })

  it('asks only the decisive OPEN needs: a suggested or confirmed one is no question', () => {
    const result = buildIntakeView({
      ...input(),
      needs: [need('escape_level_m@bldg1', true), need('building_type@bldg1', true, 'suggested'), need('storeys_above_ground@bldg1', false, 'confirmed')],
    })
    expect(result.questions.map((question) => question.key)).toEqual(['escape_level_m@bldg1'])
    expect(result.counts.decisiveOpen).toBe(1)
  })

  it('lists contradictions first, the decisive open needs as questions, and counts', () => {
    const result = view()
    expect(result.contradictions.map((item) => item.key)).toEqual(['federal_state'])
    expect(result.questions.map((question) => question.key)).toEqual(['escape_level_m@bldg1'])
    expect(result.counts).toEqual({ documentsRead: 1, unreadDocuments: 3, suggested: 2, contradictions: 1, decisiveOpen: 1 })
    expect(result).toMatchObject({ status: 'ready', summary: 'Gelesen.', readingFinishedAt: NOW, canDecide: true, canComplete: false })
  })

  it('shows each building’s class with what it read and what it lacks', () => {
    const [derivation] = view().derivations
    expect(derivation).toMatchObject({ bauwerkId: 'bldg1', rule: 'building_class', value: null })
    expect(derivation.inputs).toEqual([{ key: 'building_type@bldg1', value: 'building', suggested: true }])
    expect(derivation.missing.length).toBeGreaterThan(0)
  })
})
