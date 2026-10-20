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
import { buildIntakeView, readingDocumentProgress, readingSite } from './view'

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
  readingFiles: [],
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

const input = () => ({
  row,
  profile,
  definition: projectIntakeDefinitionV1,
  needs: [need('fluchtniveau_m@bw1', true), need('bgf_oberirdisch@bw1', false), need('bauwerkstyp@bw1', true, 'suggested')],
  unreadDocuments: 3,
  canDecide: true,
  canComplete: false,
})

const view = () => buildIntakeView(input())

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
      ])
    )
    expect(JSON.stringify(groups)).not.toContain('nicht_im_assistenten')
  })

  it('shows the derived class only in the derivations, never again in its module', () => {
    const result = view()
    expect(result.groups.flatMap((group) => group.items).map((item) => item.key)).not.toContain('gebaeudeklasse@bw1')
    expect(result.derivations.map((derivation) => derivation.bauwerkId)).toEqual(['bw1'])
    // …and carried there, so the review has a row to confirm it through.
    expect(result.derivations[0]?.suggestion).toMatchObject({ key: 'gebaeudeklasse@bw1', state: 'suggested' })
  })

  it('still lists a contested derived class among the contradictions', () => {
    const contested: ProjectProfile = {
      ...profile,
      facts: {
        ...profile.facts,
        'gebaeudeklasse@bw1': {
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
      expect.arrayContaining([expect.objectContaining({ key: 'gebaeudeklasse@bw1', display: 'GK 2', state: 'contested' })])
    )
    expect(result.counts.contradictions).toBe(2)
    expect(result.groups.flatMap((group) => group.items).map((item) => item.key)).not.toContain('gebaeudeklasse@bw1')
  })

  it('asks only the decisive OPEN needs: a suggested or confirmed one is no question', () => {
    const result = buildIntakeView({
      ...input(),
      needs: [need('fluchtniveau_m@bw1', true), need('bauwerkstyp@bw1', true, 'suggested'), need('geschosse_oberirdisch@bw1', false, 'confirmed')],
    })
    expect(result.questions.map((question) => question.key)).toEqual(['fluchtniveau_m@bw1'])
    expect(result.counts.decisiveOpen).toBe(1)
  })

  it('lists contradictions first, the decisive open needs as questions, and counts', () => {
    const result = view()
    expect(result.contradictions.map((item) => item.key)).toEqual(['bundesland'])
    expect(result.questions.map((question) => question.key)).toEqual(['fluchtniveau_m@bw1'])
    expect(result.counts).toEqual({ documentsRead: 1, unreadDocuments: 3, suggested: 2, contradictions: 1, decisiveOpen: 1 })
    expect(result).toMatchObject({ status: 'ready', summary: 'Gelesen.', readingFinishedAt: NOW, canDecide: true, canComplete: false })
  })

  it('carries the location register for step 4: the Bundesland it read and the documents it asks for', () => {
    const result = buildIntakeView({
      ...input(),
      needs: [{ ...need('grundstueck_ez', false), bauwerkId: null }],
    })
    expect(result.locationRegister).toMatchObject({ bundesland: 'wien', gemeinde: 'Wien', questions: [] })
    expect(result.locationRegister?.documentRequests[0]).toMatchObject({
      determinant: 'grundstueck',
      document: 'Grundbuchauszug',
      satisfied: false,
      needs: [expect.objectContaining({ key: 'grundstueck_ez' })],
    })
  })

  it('shows each Bauwerk’s class with what it read and what it lacks', () => {
    const [derivation] = view().derivations
    expect(derivation).toMatchObject({ bauwerkId: 'bw1', rule: 'gebaeudeklasse', value: null })
    expect(derivation.inputs).toEqual([{ key: 'bauwerkstyp@bw1', value: 'gebaeude', suggested: true }])
    expect(derivation.missing.length).toBeGreaterThan(0)
  })

  // Step 5, Steckbrief: the rule set's Ampel reads what a person confirmed, never a suggestion.
  it('computes the applicable Richtlinien from the confirmed values only', () => {
    const highRise = { value: 25, status: 'unconfirmed' as const, reason: 'r', source: 'agent_suggested' as const, updatedAt: NOW }
    const suggested = buildIntakeView({
      ...input(),
      profile: { ...profile, assumptions: { ...profile.assumptions, 'fluchtniveau_m@bw1': highRise } },
    })
    expect(suggested.applicableStandards?.map((standard) => standard.code)).not.toContain('OIB 2.3')

    const confirmed = buildIntakeView({
      ...input(),
      profile: {
        ...profile,
        facts: {
          ...profile.facts,
          'fluchtniveau_m@bw1': { value: 25, confidence: 'confirmed', source: 'onboarding', updatedAt: NOW },
        },
      },
    })
    expect(confirmed.applicableStandards).toContainEqual(
      expect.objectContaining({ code: 'OIB 2.3', status: 'required' })
    )
  })
})

describe('step 3, Erfassung: the reading’s live milestones', () => {
  const doc = (documentId: string, fileName: string) => ({ documentId, fileName })
  const A = doc('a', 'Einreichplan.pdf')
  const B = doc('b', 'Baubeschreibung.pdf')
  const C = doc('c', 'Schnitt.pdf')

  it('counts the opened documents against what the reading has before it, while it runs', () => {
    expect(readingDocumentProgress(['Einreichplan.pdf'], [A, B, C], [A, B, C])).toEqual({
      documentsOpened: 1,
      documentsTotal: 3,
    })
  })

  it('keeps the count after the finish, when the opened ones are read and only the rest is unread', () => {
    expect(readingDocumentProgress(['Einreichplan.pdf', 'Baubeschreibung.pdf'], [A, B, C], [C])).toEqual({
      documentsOpened: 2,
      documentsTotal: 3,
    })
  })

  it('counts a document read before on both sides, and a name no readable document has on neither', () => {
    expect(readingDocumentProgress(['Einreichplan.pdf', 'Gelöscht.pdf'], [A, B], [B])).toEqual({
      documentsOpened: 1,
      documentsTotal: 2,
    })
  })

  it('is nothing before any reading', () => {
    expect(readingDocumentProgress([], [], [])).toEqual({ documentsOpened: 0, documentsTotal: 0 })
  })

  const empty: ProjectProfile = { facts: {}, goals: {}, unknowns: [], assumptions: {} }
  const location = {
    label: 'Lacknergasse 12, 1170 Wien',
    lat: 48.2,
    lon: 16.3,
    country: 'at' as const,
    bundesland: 'wien',
    state: 'Wien',
    gemeinde: 'Wien',
    postcode: '1170',
    kind: 'address' as const,
  }

  it('says the site came from the address search when the confirmed Bundesland is the geocoder’s', () => {
    const profile: ProjectProfile = {
      ...empty,
      facts: {
        bundesland: { value: 'wien', confidence: 'confirmed', source: 'onboarding', updatedAt: NOW },
        standort_adresse: { value: location.label, confidence: 'confirmed', source: 'onboarding', updatedAt: NOW },
      },
    }
    expect(readingSite({ ...row, location }, profile, projectIntakeDefinitionV1)).toEqual({
      bundesland: 'Wien',
      gemeinde: 'Wien',
      address: 'Lacknergasse 12, 1170 Wien',
      source: 'geocoder',
      confirmed: true,
    })
  })

  it('says a reading found it, unconfirmed, when only a document suggests the Bundesland', () => {
    const profile: ProjectProfile = {
      ...empty,
      assumptions: {
        bundesland: {
          value: 'niederoesterreich',
          status: 'unconfirmed',
          reason: 'r',
          source: 'agent_suggested',
          updatedAt: NOW,
          evidence: [DOCUMENT],
        },
      },
    }
    expect(readingSite(row, profile, projectIntakeDefinitionV1)).toMatchObject({
      bundesland: 'Niederösterreich',
      gemeinde: null,
      address: null,
      source: 'document',
      confirmed: false,
    })
  })

  it('has no source while no Bundesland is known, and keeps the typed address', () => {
    const profile: ProjectProfile = {
      ...empty,
      facts: {
        standort_adresse: { value: 'Hauptstraße 3', confidence: 'confirmed', source: 'onboarding', updatedAt: NOW },
      },
    }
    expect(readingSite(row, profile, projectIntakeDefinitionV1)).toEqual({
      bundesland: null,
      gemeinde: null,
      address: 'Hauptstraße 3',
      source: null,
      confirmed: false,
    })
  })

  it('is on every view', () => {
    expect(view().readingProgress).toMatchObject({ documentsOpened: 0, documentsTotal: 0, site: { bundesland: 'Wien' } })
  })
})
