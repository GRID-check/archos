/** The bim operations (ADR-0122). See `projects.ts` for the shape and `docs/architecture/agent-surface.md` for the rules. */

import { z } from 'zod'
import { bimQuerySchema } from '@/lib/bim/query'
import { confirmCheckSchema, withdrawCheckSchema } from '@/lib/bim/checks-wire'
import { fileDiagramSchema } from '@/lib/diagrams/diagram-wire'
import type { AgentOperation } from '../operation'

const projectParams = z.object({ id: z.string().describe('The project id, from project-list.') })
const modelParams = z.object({
  modelId: z.string().describe('The BIM model (revision) id, from bim-model-list.'),
})

export const bimOperations = [
  {
    name: 'bim-model-list',
    domain: 'bim',
    summary: 'List the BIM models in scope for a project',
    description:
      'The IFC models a project can use, each with id, name, revision and `shelf`: `project` (its own upload) or ' +
      '`office` (the office shelf’s, never the project’s building). Needs the ifc-models feature. Model ids feed bim-model-get, bim-model-query and ' +
      'bim-check-confirm.',
    method: 'GET',
    path: '/api/projects/[id]/bim/models',
    params: projectParams,
    load: () => import('@/app/api/projects/[id]/bim/models/route'),
  },
  {
    name: 'bim-model-get',
    domain: 'bim',
    summary: 'Read one BIM model’s summary',
    description:
      'One model’s header and summary: spatial tree, storeys, element type counts and totals. Start here to learn ' +
      'what is in a model, then ask exact questions with bim-model-query.',
    method: 'GET',
    path: '/api/bim/models/[modelId]',
    params: modelParams,
    load: () => import('@/app/api/bim/models/[modelId]/route'),
  },
  {
    name: 'bim-model-query',
    domain: 'bim',
    summary: 'Ask a structured question of a BIM model',
    description:
      'Run one deterministic query against one model, as numbers and rows rather than prose: the body is a ' +
      'closed vocabulary selected by `op` (overview, health, schedule, compliance, compliance-diff, profile, takeoff, compare, types, elements, element, properties, aggregate). Use it for ' +
      'every count, sum and filter ("how many external walls on the ground floor"); never estimate such answers. ' +
      'Changes nothing. Get the model id from bim-model-list.',
    method: 'POST',
    path: '/api/bim/models/[modelId]/query',
    params: modelParams,
    // The route's own `bimQuerySchema`, imported; it is the gate.
    body: bimQuerySchema,
    readOnly: true,
    load: () => import('@/app/api/bim/models/[modelId]/query/route'),
  },
  {
    name: 'bim-check-list',
    domain: 'bim',
    summary: 'List the human verdicts on the OIB rules',
    description:
      'The confirmations people recorded for a project’s OIB rule catalogue: which rule, which model revision, ' +
      'who confirmed it and the note. These settle what the model’s published values cannot. Needs project:view.',
    method: 'GET',
    path: '/api/projects/[id]/bim/checks',
    params: projectParams,
    load: () => import('@/app/api/projects/[id]/bim/checks/route'),
  },
  {
    name: 'bim-check-confirm',
    domain: 'bim',
    summary: 'Confirm an OIB rule for a model revision',
    description:
      'Record that the person has judged `ruleId` satisfied for the model revision `modelId` (bim-model-list), ' +
      'with an optional `note`. The confirming identity is the signed-in person, never the body. Needs ' +
      'project:edit. Only call it on the person’s explicit judgement.',
    method: 'POST',
    path: '/api/projects/[id]/bim/checks',
    params: projectParams,
    body: confirmCheckSchema,
    load: () => import('@/app/api/projects/[id]/bim/checks/route'),
  },
  {
    name: 'bim-check-withdraw',
    domain: 'bim',
    summary: 'Withdraw a confirmed OIB rule',
    description:
      'Take back the confirmation of `ruleId` for one model revision `modelId`; confirmations are keyed per ' +
      'revision, so both are required. Needs project:edit. Re-confirm with bim-check-confirm.',
    method: 'DELETE',
    path: '/api/projects/[id]/bim/checks',
    params: projectParams,
    body: withdrawCheckSchema,
    load: () => import('@/app/api/projects/[id]/bim/checks/route'),
  },
  {
    name: 'diagram-file',
    domain: 'bim',
    summary: 'File a drawn diagram into a project',
    description:
      'File a diagram as documents of the project: the `svg` and its `source` (mermaid or excalidraw), a `title`, ' +
      'and `runId`, the id of the answer it was drawn in (filing the same diagram twice files nothing twice). ' +
      'Optionally `conversationId` so restricted-folder rules apply. Returns `{ svg, pdf }`, `pdf` null when only ' +
      'the SVG landed. Needs project:documents:write and project:documents:generate.',
    method: 'POST',
    path: '/api/projects/[id]/diagrams',
    params: projectParams,
    body: fileDiagramSchema,
    load: () => import('@/app/api/projects/[id]/diagrams/route'),
  },
  {
    name: 'bim-model-source-get',
    domain: 'bim',
    summary: 'Get a time-limited link to a model’s IFC file',
    description:
      'A presigned URL of the raw .ifc, valid for ten minutes and minted for this person only: treat it as a credential, do not store ' +
      'or share it, and call again for a fresh one. The file itself is not sent (models run to hundreds of MB); open the link, or ' +
      'ask exact questions with bim-model-query. Needs the ifc-models feature. Get the model id from bim-model-list.',
    method: 'GET',
    path: '/api/bim/models/[modelId]/source',
    params: modelParams,
    load: () => import('@/app/api/bim/models/[modelId]/source/route'),
  },
  {
    name: 'bim-checks-export',
    domain: 'bim',
    summary: 'Export the check register as a BCF archive',
    description:
      'The project’s OIB rule check ledger for one model as a BCF 2.1 zip, one topic per finding. Name the model with `modelId` (a uuid) ' +
      'or `model` (its file name), and state `buildingClass` (1 to 5) and `mainUse` so rules that need them do not stand down. ' +
      'Returned as an attached resource up to 5 MiB; a larger archive is not sent (ask for the findings with bim-check-list). ' +
      'The most expensive read in the product: it runs the whole catalogue and is rate limited. Needs the ifc-models feature.',
    method: 'GET',
    path: '/api/projects/[id]/bim/checks/export',
    params: projectParams,
    // The route's schema is a preprocess + refine (legacy names, a lenient `.catch`), which a query object cannot be; the route is the gate.
    query: z.object({
      modelId: z.string().uuid().optional().describe('The model (revision) id, from bim-model-list. Give this or `model`.'),
      model: z.string().max(255).optional().describe('The model’s file name. Give this or `modelId`.'),
      buildingClass: z.number().int().min(1).max(5).optional().describe('The building class (OIB), 1 to 5.'),
      mainUse: z.string().max(100).optional().describe('The main use as in bim-model-query; an unknown value is treated as not stated.'),
    }),
    binaryResponse: ['application/octet-stream'],
    load: () => import('@/app/api/projects/[id]/bim/checks/export/route'),
  },

] as const satisfies readonly AgentOperation[]
