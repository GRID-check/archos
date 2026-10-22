/** The skills operations (ADR-0122). See `projects.ts` for the shape and `docs/architecture/agent-surface.md` for the rules. */

import { z } from 'zod'
import {
  createCategorySchema,
  createSkillSchema,
  curatedSkillActivationSchema,
  patchCategorySchema,
  patchSkillSchema,
  reviewSkillSchema,
  skillSearchQuerySchema,
} from '@/lib/skills/types'
import type { AgentOperation } from '../operation'

const skillParams = z.object({ skillId: z.string().describe('The org skill id, from skill-list.') })
const categoryParams = z.object({
  categoryId: z.string().describe('The org skill category id, from skill-category-list.'),
})

export const skillsOperations = [
  {
    name: 'skill-list',
    domain: 'skills',
    summary: 'List the skills of the toolbox',
    description:
      'The organization’s skill toolbox: platform-curated skills and the organization’s own, each with its name, ' +
      'description, category and whether it is enabled. Needs the skills feature on. Org skill ids from here feed ' +
      'skill-update and skill-delete; names feed task-create.',
    method: 'GET',
    path: '/api/skills',
    load: () => import('@/app/api/skills/route'),
  },
  {
    name: 'skill-search',
    domain: 'skills',
    summary: 'Find the office’s procedures for a task',
    description:
      'The office’s skills are its written procedures: search them before acting on office work. Ranks the enabled ' +
      'skills by your words (name, description, then body) and answers each hit’s name, description and up to ' +
      'three matching body lines with their line numbers. Empty `query` lists them all. Read one with skill-get.',
    method: 'GET',
    path: '/api/skills/search',
    query: skillSearchQuerySchema,
    load: () => import('@/app/api/skills/search/route'),
  },
  {
    name: 'skill-get',
    domain: 'skills',
    summary: 'Read one of the office’s procedures',
    description:
      'One enabled skill by name (from skill-search): its description and its full Markdown body, the steps to ' +
      'follow. Load it before doing the work it describes.',
    method: 'GET',
    path: '/api/skills/by-name/[name]',
    params: z.object({ name: z.string().describe('The skill name, from skill-search.') }),
    load: () => import('@/app/api/skills/by-name/[name]/route'),
  },
  {
    name: 'skill-invocable-list',
    domain: 'skills',
    summary: 'List the skills a conversation turn may invoke',
    description:
      'The skills this member may invoke in a conversation turn, name and description only (no bodies): the catalogue ' +
      'behind the composer’s "/" menu and the one the agent is given at turn start.',
    method: 'GET',
    path: '/api/skills/invocable',
    load: () => import('@/app/api/skills/invocable/route'),
  },
  {
    name: 'skill-create',
    domain: 'skills',
    summary: 'Author an organization skill',
    description:
      'Create a skill for the organization: lowercase hyphenated `name`, `description`, markdown `body`, and ' +
      'optionally `metadata`, `enabled`, `categoryId` (skill-category-list) or `clonedFrom` (a platform skill ' +
      'name). Needs org:skills:manage.',
    method: 'POST',
    path: '/api/skills',
    body: createSkillSchema,
    load: () => import('@/app/api/skills/route'),
  },
  {
    name: 'skill-update',
    domain: 'skills',
    summary: 'Change an organization skill',
    description:
      'Patch any of an org skill’s name, description, body, metadata, enabled flag or category (`categoryId: null` ' +
      'removes it from its category). Platform skills have no id here; a person switches those on or off. ' +
      'Needs org:skills:manage.',
    method: 'PATCH',
    path: '/api/skills/[skillId]',
    params: skillParams,
    body: patchSkillSchema,
    idempotent: true,
    load: () => import('@/app/api/skills/[skillId]/route'),
  },
  {
    name: 'skill-delete',
    domain: 'skills',
    summary: 'Delete an organization skill',
    description:
      'Delete one of the organization’s own skills. Tasks that name it lose their attachment. Needs ' +
      'org:skills:manage. To switch a skill off while keeping it, use skill-update with `enabled: false`.',
    method: 'DELETE',
    path: '/api/skills/[skillId]',
    params: skillParams,
    load: () => import('@/app/api/skills/[skillId]/route'),
  },
  {
    name: 'skill-curated-set-enabled',
    domain: 'skills',
    summary: 'Switch a platform skill on or off',
    description:
      'Turn a platform-curated skill on or off for this organization. Addressed by NAME (from skill-list), because ' +
      'a platform skill has no id; only curated skills can be switched, never the pipeline’s own machinery. ' +
      'Needs org:skills:manage.',
    method: 'PATCH',
    path: '/api/skills/curated/[name]',
    params: z.object({ name: z.string().describe('The platform skill name, from skill-list.') }),
    body: curatedSkillActivationSchema,
    idempotent: true,
    load: () => import('@/app/api/skills/curated/[name]/route'),
  },
  {
    name: 'skill-review',
    domain: 'skills',
    summary: 'Have the reviewer critique a skill draft',
    description:
      'Ask the backend reviewer what is wrong with a skill draft. Send whatever of `name`, `description` and `body` ' +
      'exists; an incomplete draft is fine. Answers 200 with `{ findings, error? }`; null findings means no review ' +
      'this time, not a pass. Changes nothing.',
    method: 'POST',
    path: '/api/skills/review',
    body: reviewSkillSchema,
    readOnly: true,
    load: () => import('@/app/api/skills/review/route'),
  },
  {
    name: 'skill-category-list',
    domain: 'skills',
    summary: 'List the skill categories',
    description:
      'The categories that arrange the toolbox: platform categories first (read-only), then the organization’s own. ' +
      'Category ids feed skill-create, skill-update and the category operations.',
    method: 'GET',
    path: '/api/skill-categories',
    load: () => import('@/app/api/skill-categories/route'),
  },
  {
    name: 'skill-category-create',
    domain: 'skills',
    summary: 'Create a skill category',
    description:
      'Add an organization category with a `name`, optional `description` and `sortOrder`. Needs org:skills:manage. ' +
      'Returns the new category with its id.',
    method: 'POST',
    path: '/api/skill-categories',
    body: createCategorySchema,
    load: () => import('@/app/api/skill-categories/route'),
  },
  {
    name: 'skill-category-update',
    domain: 'skills',
    summary: 'Edit a skill category',
    description:
      'Rename, re-describe or re-order one of the organization’s categories. Platform categories answer 404 here. ' +
      'Needs org:skills:manage.',
    method: 'PATCH',
    path: '/api/skill-categories/[categoryId]',
    params: categoryParams,
    body: patchCategorySchema,
    idempotent: true,
    load: () => import('@/app/api/skill-categories/[categoryId]/route'),
  },
  {
    name: 'skill-category-delete',
    domain: 'skills',
    summary: 'Delete a skill category',
    description:
      'Remove one of the organization’s categories. Platform categories answer 404 here. Needs org:skills:manage.',
    method: 'DELETE',
    path: '/api/skill-categories/[categoryId]',
    params: categoryParams,
    load: () => import('@/app/api/skill-categories/[categoryId]/route'),
  },
] as const satisfies readonly AgentOperation[]
