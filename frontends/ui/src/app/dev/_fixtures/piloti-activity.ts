/**
 * Fixtures for „Was Piloti tut": the dev preview and the specs read the same
 * responses, and `piloti-activity.spec.ts` parses each through
 * `pilotiActivityResponseSchema`, so a fixture that drifts from the contract
 * fails the build instead of rendering a shape the server never sends.
 *
 * Times are relative to `now`, so the preview reads „vor 2 Minuten" whenever
 * it is opened and a spec pins `now` and gets the same rows every run.
 */

import type {
  PilotiActivityResponse,
  RecentItem,
  RunningItem,
  WaitingItem,
} from '@/lib/piloti-activity/types'

export const PILOTI_FIXTURE_PROJECT_ID = 'proj-mariahilf'

/** The reader: rows for them say „für Sie". */
export const VIEWER = { userId: 'user-anna', name: 'Anna Berger' } as const
const MARKUS = { userId: 'user-markus', name: 'Markus Klein' } as const
/** A person the directory no longer knows (a leaver). */
const LEAVER = { userId: 'user-gone', name: null } as const

const EINREICHPLAN = { id: 'doc-einreichplan', name: 'Einreichplan_GR_EG.pdf' } as const
const BEBAUUNGSPLAN = { id: 'doc-bebauungsplan', name: 'Bebauungsplan_7B.pdf' } as const
const BRANDSCHUTZ = { id: 'doc-brandschutz', name: 'Brandschutzkonzept_Haus_A.pdf' } as const
const STATIK = { id: 'doc-statik', name: 'Statik_Vorbemessung.xlsx' } as const

const mark = (id: string, number: number, kind: 'hint' | 'question' | 'defect', excerpt: string) =>
  ({ id, number, kind, excerpt }) as const

const review = (documentId: string, annotationId: string | null) =>
  ({ kind: 'review', documentId, annotationId }) as const
const turn = (conversationId: string, messageId: string | null) =>
  ({ kind: 'turn', conversationId, messageId }) as const

export const PILOTI_ACTIVITY_VARIANTS = [
  'full',
  'empty',
  'waiting-only',
  'actions',
  'error',
] as const
export type PilotiActivityVariant = (typeof PILOTI_ACTIVITY_VARIANTS)[number]

/** A response with nothing in it; the other variants spread it. */
function nothing(now: Date): PilotiActivityResponse {
  return {
    projectId: PILOTI_FIXTURE_PROJECT_ID,
    viewerUserId: VIEWER.userId,
    generatedAt: now.toISOString(),
    capabilities: { wakes: true, automation: true },
    running: { items: [], truncated: false },
    waiting: { items: [], truncated: false },
    recent: {
      items: [],
      truncated: false,
      since: new Date(now.getTime() - 14 * 86_400_000).toISOString(),
    },
  }
}

export function pilotiActivityFixture(
  variant: Exclude<PilotiActivityVariant, 'error'>,
  now: Date = new Date()
): PilotiActivityResponse {
  const ago = (minutes: number): string => new Date(now.getTime() - minutes * 60_000).toISOString()
  const base = nothing(now)
  if (variant === 'empty') return base

  const running: RunningItem[] = [
    {
      kind: 'wake',
      id: 'wake-1',
      at: ago(2),
      status: 'started',
      startedAt: ago(1),
      trigger: 'assigned',
      forPerson: VIEWER,
      document: EINREICHPLAN,
      mark: mark(
        'mark-4',
        4,
        'defect',
        'Fluchtweglänge im Atrium fehlt, bitte gegen OIB 2.3 prüfen.'
      ),
      canTakeBack: true,
      target: review(EINREICHPLAN.id, 'mark-4'),
      turn: turn('conv-einreichplan', 'msg-wake-1'),
    },
    {
      kind: 'run',
      id: 'run-1',
      at: ago(11),
      status: 'running',
      startedAt: ago(10),
      taskKind: 'einreichcheck',
      title: 'Einreichcheck vor Abgabe',
      forPerson: MARKUS,
      canStop: true,
      target: {
        kind: 'run',
        conversationId: 'conv-einreich',
        messageId: 'msg-run-1',
        runId: 'run-1',
      },
    },
    {
      kind: 'wake',
      id: 'wake-2',
      at: ago(25),
      status: 'queued',
      startedAt: null,
      trigger: 'thread_mention',
      forPerson: MARKUS,
      document: BEBAUUNGSPLAN,
      mark: mark('mark-9', 9, 'question', 'Gilt hier die Abweichung der Wiener Bauordnung?'),
      canTakeBack: false,
      target: review(BEBAUUNGSPLAN.id, 'mark-9'),
      turn: null,
    },
    {
      kind: 'run',
      id: 'run-2',
      at: ago(40),
      status: 'queued',
      startedAt: null,
      taskKind: 'compliance_check',
      title: 'Normprüfung Stiegenhaus Haus B',
      forPerson: VIEWER,
      canStop: false,
      target: { kind: 'task', taskId: 'task-stiegenhaus' },
    },
    {
      kind: 'run',
      id: 'run-3',
      at: ago(55),
      status: 'running',
      startedAt: ago(50),
      taskKind: 'deep-research',
      title: 'Stellplatznachweis Wohnbau Mariahilf',
      forPerson: LEAVER,
      canStop: false,
      target: null,
    },
  ]

  const waiting: WaitingItem[] = [
    {
      kind: 'proposal',
      id: 'prop-1',
      at: ago(8),
      proposalKind: 'memory',
      summary: 'Bauherr bevorzugt Sichtbeton an der Nordfassade.',
      forPerson: VIEWER,
      canDecide: true,
      target: turn('conv-einreichplan', 'msg-memory'),
    },
    {
      kind: 'proposed_marks',
      id: BEBAUUNGSPLAN.id,
      at: ago(35),
      document: BEBAUUNGSPLAN,
      count: 5,
      marks: [
        {
          ...mark('pm-1', 11, 'defect', 'Bauplatzgrenze weicht vom Lageplan ab.'),
          page: 2,
          forPerson: VIEWER,
          createdAt: ago(35),
        },
        {
          ...mark('pm-2', 12, 'hint', 'Gebäudehöhe nach Bebauungsplan 7B: 16 m.'),
          page: 2,
          forPerson: MARKUS,
          createdAt: ago(50),
        },
        {
          ...mark('pm-3', 13, 'question', 'Ist die Dachneigung hier bindend?'),
          page: 3,
          forPerson: VIEWER,
          createdAt: ago(61),
        },
      ],
      target: review(BEBAUUNGSPLAN.id, 'pm-1'),
    },
    {
      kind: 'proposal',
      id: 'prop-2',
      at: ago(90),
      proposalKind: 'file_operation',
      summary: 'Statik_Vorbemessung.xlsx in den Ordner Statik verschieben',
      forPerson: MARKUS,
      canDecide: false,
      target: { kind: 'project_chat' },
    },
    {
      kind: 'proposal',
      id: 'prop-3',
      at: ago(180),
      proposalKind: 'project_profile',
      summary: 'Gebäudeklasse GK3 statt GK4',
      forPerson: LEAVER,
      canDecide: true,
      target: turn('conv-einreichplan', null),
    },
    {
      kind: 'proposed_marks',
      id: STATIK.id,
      at: ago(300),
      document: STATIK,
      count: 1,
      marks: [
        {
          ...mark('pm-4', 2, 'hint', 'Deckenstärke 25 cm laut Vorbemessung.'),
          page: 1,
          forPerson: VIEWER,
          createdAt: ago(300),
        },
      ],
      target: review(STATIK.id, 'pm-4'),
    },
  ]

  const recent: RecentItem[] = [
    {
      kind: 'wake_ended',
      id: 'wake-e1',
      at: ago(20),
      status: 'answered',
      reason: null,
      reasonKind: null,
      trigger: 'thread_reply',
      forPerson: VIEWER,
      document: EINREICHPLAN,
      mark: mark('mark-3', 3, 'question', 'Welche Brandwiderstandsklasse hat die Decke?'),
      target: review(EINREICHPLAN.id, 'mark-3'),
      turn: turn('conv-einreichplan', 'msg-e1'),
    },
    {
      kind: 'proposal_decided',
      id: 'prop-d1',
      at: ago(45),
      proposalKind: 'memory',
      status: 'applied',
      summary: 'Brandschutzkonzept liegt beim Ziviltechniker.',
      forPerson: VIEWER,
      decidedBy: MARKUS,
      target: turn('conv-brandschutz', 'msg-d1'),
    },
    {
      kind: 'changes',
      id: 'conv-einreichplan:msg-c1',
      at: ago(70),
      count: 4,
      undoneCount: 1,
      documents: [EINREICHPLAN, BEBAUUNGSPLAN, STATIK],
      documentCount: 5,
      forPerson: MARKUS,
      target: turn('conv-einreichplan', 'msg-c1'),
    },
    {
      kind: 'run_finished',
      id: 'run-f1',
      at: ago(120),
      status: 'succeeded',
      error: null,
      taskKind: 'deep-research',
      title: 'Brandschutz Haus A: Fluchtwege',
      forPerson: VIEWER,
      filedDocument: BRANDSCHUTZ,
      target: {
        kind: 'run',
        conversationId: 'conv-brandschutz',
        messageId: 'msg-f1',
        runId: 'run-f1',
      },
    },
    {
      kind: 'wake_ended',
      id: 'wake-e2',
      at: ago(150),
      status: 'failed',
      reason: 'gave up waiting: job not claimed after 120s',
      reasonKind: 'busy',
      trigger: 'assigned',
      forPerson: MARKUS,
      document: BEBAUUNGSPLAN,
      mark: mark('mark-7', 7, 'defect', 'Abstandsfläche zur Nachbargrenze unterschritten.'),
      target: review(BEBAUUNGSPLAN.id, 'mark-7'),
      turn: null,
    },
    {
      kind: 'proposal_decided',
      id: 'prop-d2',
      at: ago(200),
      proposalKind: 'file_operation',
      status: 'partially_applied',
      summary: 'Drei Dateien umbenennen',
      forPerson: VIEWER,
      decidedBy: VIEWER,
      target: turn('conv-einreichplan', 'msg-d2'),
    },
    {
      kind: 'wake_ended',
      id: 'wake-e3',
      at: ago(240),
      status: 'refused',
      reason: 'budget: project limit exhausted',
      reasonKind: 'budget',
      trigger: 'assigned',
      forPerson: VIEWER,
      document: EINREICHPLAN,
      mark: mark('mark-2', 2, 'hint', 'Raumhöhe im Erdgeschoss prüfen.'),
      target: review(EINREICHPLAN.id, 'mark-2'),
      turn: null,
    },
    {
      kind: 'run_finished',
      id: 'run-f2',
      at: ago(300),
      status: 'failed',
      error: 'Der Bericht konnte nicht geschrieben werden.',
      taskKind: 'einreichcheck',
      title: 'Einreichcheck Haus A',
      forPerson: MARKUS,
      filedDocument: null,
      target: { kind: 'task', taskId: 'task-haus-a' },
    },
    {
      kind: 'wake_ended',
      id: 'wake-e4',
      at: ago(360),
      status: 'refused',
      reason: 'rejected: auth_expired',
      reasonKind: 'access',
      trigger: 'thread_mention',
      forPerson: LEAVER,
      document: STATIK,
      mark: mark('mark-1', 1, 'question', 'Stimmt die Lastannahme?'),
      target: review(STATIK.id, 'mark-1'),
      turn: turn('conv-statik', 'msg-e4'),
    },
    {
      kind: 'proposal_decided',
      id: 'prop-d3',
      at: ago(420),
      proposalKind: 'project_profile',
      status: 'failed',
      summary: 'Geschosse oberirdisch: 5',
      forPerson: MARKUS,
      decidedBy: VIEWER,
      target: { kind: 'project_chat' },
    },
    {
      kind: 'wake_ended',
      id: 'wake-e5',
      at: ago(500),
      status: 'failed',
      reason: 'turn ended without an answer',
      reasonKind: 'error',
      trigger: 'assigned',
      forPerson: VIEWER,
      document: BRANDSCHUTZ,
      mark: mark('mark-5', 5, 'defect', 'Rauchabzug fehlt im Stiegenhaus.'),
      target: review(BRANDSCHUTZ.id, 'mark-5'),
      turn: turn('conv-brandschutz', 'msg-e5'),
    },
    {
      kind: 'changes',
      id: 'conv-brandschutz:msg-c2',
      at: ago(600),
      count: 2,
      undoneCount: 2,
      documents: [BRANDSCHUTZ],
      documentCount: 1,
      forPerson: VIEWER,
      target: turn('conv-brandschutz', 'msg-c2'),
    },
    {
      kind: 'wake_ended',
      id: 'wake-e6',
      at: ago(700),
      status: 'stopped',
      reason: null,
      reasonKind: null,
      trigger: 'assigned',
      forPerson: MARKUS,
      document: EINREICHPLAN,
      mark: mark('mark-6', 6, 'hint', 'Barrierefreier Zugang im Westen.'),
      target: review(EINREICHPLAN.id, 'mark-6'),
      turn: null,
    },
    {
      kind: 'proposal_decided',
      id: 'prop-d4',
      at: ago(800),
      proposalKind: 'memory',
      status: 'dismissed',
      summary: 'Bauherr möchte keine Holzfenster.',
      forPerson: VIEWER,
      decidedBy: MARKUS,
      target: turn('conv-einreichplan', 'msg-d4'),
    },
    {
      kind: 'run_finished',
      id: 'run-f3',
      at: ago(900),
      status: 'interrupted',
      error: null,
      taskKind: 'deep-research',
      title: 'Variantenvergleich Fassade',
      forPerson: VIEWER,
      filedDocument: null,
      target: null,
    },
    {
      kind: 'run_finished',
      id: 'run-f4',
      at: ago(1000),
      status: 'skipped',
      error: 'Das Monatslimit ist erreicht.',
      taskKind: 'compliance_check',
      title: 'Wöchentliche Normprüfung',
      forPerson: MARKUS,
      filedDocument: null,
      target: { kind: 'task', taskId: 'task-weekly' },
    },
  ]

  if (variant === 'waiting-only') {
    return { ...base, waiting: { items: waiting, truncated: false } }
  }
  return {
    ...base,
    running: { items: running, truncated: false },
    waiting: { items: waiting, truncated: false },
    recent: { ...base.recent, items: recent, truncated: true },
  }
}
