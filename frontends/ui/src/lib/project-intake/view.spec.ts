/**
 * The review's shape (ADR-0111), from the real intake definition: every value
 * under a key a question writes, in that question's module and with its
 * label and display; a value with alternatives listed again as a
 * contradiction; the derived class shown as „GK n" under the module that
 * derives it; the questions are the decisive needs nothing filled; and a key
 * no question writes is not shown.
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
    bundesland: {
      value: 'wien',
      confidence: 'confirmed',
      source: 'onboarding',
      updatedAt: NOW,
      alternatives: [{ value: 'niederoesterreich', evidence: [DOCUMENT], recordedAt: NOW }],
    },
    nicht_im_assistenten: { value: 'x', confidence: 'confirmed', source: 'admin_edit', updatedAt: NOW },
  },
  goals: {},
  unknowns: [],
  assumptions: {
    'bauwerkstyp@bw1': { value: 'gebaeude', status: 'unconfirmed', reason: 'r', source: 'agent_suggested', updatedAt: NOW, evidence: [DOCUMENT] },
    'gebaeudeklasse@bw1': { value: 3, status: 'unconfirmed', reason: 'r', source: 'agent_suggested', updatedAt: NOW },
  },
}

const need = (key: string, decisive: boolean, state: Need['state'] = 'open'): Need => ({
  key,
  baseKey: key.split('@')[0],
  bauwerkId: 'bw1',
  label: key,
  type: 'number_tri',
  foundIn: [],
  decisive,
  state,
})

const view = () =>
  buildIntakeView({
    row,
    profile,
    definition: projectIntakeDefinitionV1,
    needs: [need('fluchtniveau_m@bw1', true), need('bgf_oberirdisch@bw1', false), need('bauwerkstyp@bw1', true, 'suggested')],
    unreadDocuments: 3,
    canDecide: true,
    canComplete: false,
  })

describe('buildIntakeView', () => {
  it('groups every value by its module, labelled and displayed as the wizard does', () => {
    const { groups } = view()
    const projektbasis = groups.find((group) => group.title === 'Projektbasis')
    const bauwerke = groups.find((group) => group.title === 'Bauwerke')

    expect(projektbasis?.items).toEqual([
      expect.objectContaining({ key: 'bundesland', value: 'wien', display: 'Wien', state: 'contested', bauwerkId: null }),
    ])
    expect(bauwerke?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'bauwerkstyp@bw1',
          baseKey: 'bauwerkstyp',
          bauwerkId: 'bw1',
          label: 'Bauwerkstyp',
          display: 'Gebäude',
          state: 'suggested',
          evidence: [DOCUMENT],
          decisive: true,
        }),
        expect.objectContaining({ key: 'gebaeudeklasse@bw1', label: 'Gebäudeklasse', display: 'GK 3' }),
      ])
    )
    expect(JSON.stringify(groups)).not.toContain('nicht_im_assistenten')
  })

  it('lists contradictions first, the decisive open needs as questions, and counts', () => {
    const result = view()
    expect(result.contradictions.map((item) => item.key)).toEqual(['bundesland'])
    expect(result.questions.map((question) => question.key)).toEqual(['fluchtniveau_m@bw1'])
    expect(result.counts).toEqual({ documentsRead: 1, unreadDocuments: 3, suggested: 2, contradictions: 1, decisiveOpen: 1 })
    expect(result).toMatchObject({ status: 'ready', summary: 'Gelesen.', readingFinishedAt: NOW, canDecide: true, canComplete: false })
  })

  it('shows each Bauwerk’s class with what it read and what it lacks', () => {
    const [derivation] = view().derivations
    expect(derivation).toMatchObject({ bauwerkId: 'bw1', rule: 'gebaeudeklasse', value: null })
    expect(derivation.inputs).toEqual([{ key: 'bauwerkstyp@bw1', value: 'gebaeude', suggested: true }])
    expect(derivation.missing.length).toBeGreaterThan(0)
  })
})
